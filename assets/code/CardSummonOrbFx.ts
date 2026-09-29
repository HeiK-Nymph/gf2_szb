import {
    _decorator, Color, Component, EffectAsset, Material, Node, resources, Sprite, SpriteFrame,
    Tween, tween, UITransform,
} from 'cc';
import { killNode } from './CardComposer';

const { ccclass, property, menu } = _decorator;

/** 光球特效子节点名（运行时挂在卡牌根节点下，siblingIndex = 最后 = 画在卡牌最上层） */
export const SUMMON_ORB_FX_NAME = 'SummonOrbFx';

/** 效果名（= 资源文件名去扩展名，EffectAsset 按它注册） */
export const SUMMON_ORB_EFFECT_NAME = 'SummonOrbAdd';

/** 加色效果在 resources 下的路径（打包后即使没有任何场景引用也不会被裁掉） */
export const SUMMON_ORB_EFFECT_RES_PATH = 'effects/SummonOrbAdd';

/**
 * 三张光球贴图在 resources 下的路径（**子资源**要带 `/spriteFrame` 后缀）。
 * 顺序 = [核心, 冲击环, 弥散]，与贴图的实际形态一致（见文件头「素材形态」说明）。
 */
export const SUMMON_ORB_TEX_RES_PATHS: readonly string[] = [
    'effects/LightOrb/light_01/spriteFrame',   // 核心亮斑（中心最亮）
    'effects/LightOrb/light_02/spriteFrame',   // 空心冲击环（中心暗、亮环在中径）
    'effects/LightOrb/light_03/spriteFrame',   // 弥散大光晕（峰值半径最大）
];

// ============================================================================
// 模块级资源缓存（所有卡牌共用：效果 1 份 + 贴图 3 张，绝不为每张卡各加载一份）
// ============================================================================
let _effect: EffectAsset | null = null;
let _loadingEffect = false;
const _sfs: (SpriteFrame | null)[] = [null, null, null];
let _loadingSfs = false;
let _warnedOnce = false;

/** 资源是否已就绪（效果 + 三张贴图都在） */
export function summonOrbAssetsReady(): boolean {
    return !!_effect && _sfs[0] !== null && _sfs[1] !== null && _sfs[2] !== null;
}

/** 共享的三张光球贴图（顺序 = [核心, 冲击环, 弥散]）；未就绪的槽位为 null。\n *  卡牌进战场光球 与 随从进化光球 共用这一份模块级缓存 —— 全场只加载一次。 */
export function getSummonOrbSpriteFrames(): readonly (SpriteFrame | null)[] {
    return _sfs;
}

/** 共享的加色 effect 资产（SummonOrbAdd）；未就绪时为 null。 */
export function getSummonOrbEffect(): EffectAsset | null {
    resolveEffect();
    return _effect && _effect.isValid ? _effect : null;
}

/** 预加载召唤光球用到的全部资源（幂等；场景启动时调一次即可，避免第一次出牌时资源还没到） */
export function preloadSummonOrbAssets(): void {
    resolveEffect();
    if (_sfs.every((s) => s !== null) || _loadingSfs) return;
    _loadingSfs = true;
    let remaining = SUMMON_ORB_TEX_RES_PATHS.length;
    SUMMON_ORB_TEX_RES_PATHS.forEach((path, i) => {
        resources.load(path, SpriteFrame, (err, sf) => {
            remaining--;
            if (err || !sf) {
                if (!_warnedOnce) {
                    _warnedOnce = true;
                    console.warn(`[CardSummonOrbFx] 加载光球贴图失败："${path}" →`, err);
                }
            } else {
                _sfs[i] = sf;
            }
            if (remaining <= 0) _loadingSfs = false;
        });
    });
}

/** 解析加色效果：① 已注册的效果名；② 从 resources 异步加载（只发起一次） */
function resolveEffect(): void {
    if (_effect && _effect.isValid) return;
    const byName = EffectAsset.get(SUMMON_ORB_EFFECT_NAME);
    if (byName) { _effect = byName; return; }
    if (_loadingEffect) return;
    _loadingEffect = true;
    resources.load(SUMMON_ORB_EFFECT_RES_PATH, EffectAsset, (err, asset) => {
        _loadingEffect = false;
        if (err || !asset) {
            if (!_warnedOnce) {
                _warnedOnce = true;
                console.warn(`[CardSummonOrbFx] 加载效果失败："${SUMMON_ORB_EFFECT_RES_PATH}" →`, err);
            }
            return;
        }
        _effect = asset;
    });
}

// ============================================================================
// 单层配置：三层共用一条时间轴 p∈[0,1]，各自有「缩放爬升窗」和「透明度爬升/衰减窗」
// ============================================================================
export interface OrbLayerCfg {
    /** 该层贴图在 _sfs 里的下标 */
    tex: number;
    /** 相对卡牌长边的最终尺寸倍数（1.0 = 正好铺满卡牌长边） */
    size: number;
    /** 缩放的起止：from → 1.0，在 [t0, t0+dur] 内 easeOutQuad 完成 */
    from: number; t0: number; dur: number;
    /** 透明度：在 [aT0, aT0+aRise] 内 0→peak，再在 aFall 内 →0 */
    aT0: number; aRise: number; aFall: number; peak: number;
    /** 旋转方向（+1/-1）与总旋转角（度） */
    dir: number;
}

export const SUMMON_ORB_LAYERS: readonly OrbLayerCfg[] = [
    // 核心：最早亮、最快涨、很快收（爆闪的「芯」）
    { tex: 0, size: 0.95, from: 0.30, t0: 0.00, dur: 0.22, aT0: 0.00, aRise: 0.08, aFall: 0.42, peak: 1.00, dir: 1 },
    // 冲击环：中径的亮环，向外扩散并散去
    { tex: 1, size: 1.70, from: 0.22, t0: 0.14, dur: 0.66, aT0: 0.14, aRise: 0.16, aFall: 0.56, peak: 0.85, dir: -1 },
    // 弥散：最大的柔光，作为整个光球的「体积」
    { tex: 2, size: 1.35, from: 0.40, t0: 0.06, dur: 0.36, aT0: 0.06, aRise: 0.14, aFall: 0.42, peak: 0.72, dir: 1 },
];

/** p→缩放系数：在 [t0, t0+dur] 内 from→1，缓出（前快后慢，符合「炸开」的直觉） */
export function orbScaleAt(p: number, l: OrbLayerCfg): number {
    if (p <= l.t0) return l.from;
    const r = Math.min(1, (p - l.t0) / l.dur);
    const e = 1 - (1 - r) * (1 - r);      // easeOutQuad
    return l.from + (1 - l.from) * e;
}

/** p→透明度：先升后降；窗口之外为 0 */
export function orbAlphaAt(p: number, l: OrbLayerCfg): number {
    if (p <= l.aT0) return 0;
    const rise = p - l.aT0;
    if (rise < l.aRise) return l.peak * (rise / l.aRise);
    const fall = rise - l.aRise;
    if (fall >= l.aFall) return 0;
    // 衰减用 √ 曲线：光带在外缘「浓密」地慢衰减，而不是线性变薄
    return l.peak * Math.sqrt(1 - fall / l.aFall);
}

/**
 * 时间轴的自然可见终点：所有层的缩放爬升与透明度衰减全部结束的最晚时刻（p ∈ (0,1]）。
 * 复用它把整条时间轴拉伸到与「卡牌旋转」等长 —— p=1 时正好完全消失。
 */
export function orbTimelineEnd(): number {
    let end = 0.01;
    for (const l of SUMMON_ORB_LAYERS) {
        end = Math.max(end, l.t0 + l.dur, l.aT0 + l.aRise + l.aFall);
    }
    return Math.min(1, end);
}

/**
 * CardSummonOrbFx —— 卡牌「进战场召唤光球」特效（方案①多层 Sprite + 方案②ADD 混合材质）
 * ===========================================================================
 * 🔗 共享：贴图（effects/LightOrb/light_01~03.png）、加色 effect（SummonOrbAdd）、图层时间轴
 *    （SUMMON_ORB_LAYERS / orbScaleAt / orbAlphaAt / orbTimelineEnd）与模块级缓存，也被
 *    EvolveFollowerFx 的**进化光球**复用（那边只是把时间轴拉伸到与卡牌旋转等长 + 染成亮白色）。
 * ===========================================================================
 * 一、这是什么
 *   卡牌落到战场的那一刻，在卡牌上炸开一颗暖金色的光球：
 *     · 三层 Sprite 叠在一起（核心亮斑 / 冲击环 / 弥散柔光），各自独立缩放 + 反向旋转；
 *     · 三层全部用 `SummonOrbAdd.effect` 的**加色混合**渲染 → 是「发光」而不是「糊白」，
 *       多层叠加越叠越亮，且暗部（贴图 alpha=0）对画面零贡献，不会把卡面压灰；
 *     · 整段动画由**一条数值补间**驱动（补的是 0→1 的进度 p，每帧按时间轴写三层的
 *       尺寸/透明度/旋转）—— 而不是三条独立补间。这样：
 *         - 只有一次完成回调，不存在「三条补间谁先结束」的竞态；
 *         - 严格符合本工程铁律「位置/旋转/缩放用数值补间在 onUpdate 里写」。
 *   动画结束后临时节点整体销毁（特效不常驻，零常态开销）。
 *
 * 二、素材形态（决定三层怎么排）
 *   light_01：中心最亮（峰值半径 0）        → 当「核心」
 *   light_02：中心暗、亮环在中径（r≈0.59）  → 当「冲击环」
 *   light_03：峰值半径最大（r≈0.72）        → 当「弥散」
 *   三张素材已预处理成「RGB=白 + A=原亮度」的黑底镂空 RGBA，所以既能被节点颜色染色，
 *   也能直接被加色混合当成「纯亮度」使用。
 *
 * 三、怎么用
 *   通常不需要手工挂：BattleFieldLayout 在卡牌进战场时自动 `addComponent` 并调用 `play()`。
 *   也可以手动挂到任意节点，然后 `const fx = node.getComponent(CardSummonOrbFx); fx.play();`
 *
 * 四、性能
 *   · 贴图与效果都是模块级单份（所有卡牌共用），每张卡只有 3 个临时 Sprite 节点；
 *   · 动画结束即销毁；不播放时组件只有一个 update 提前 return（`_waiting` 为 false）；
 *   · 加色材质每次播放新建 1 个（为了能独立调 intensity），结束时 destroy。
 *
 * 五、踩坑提醒
 *   · 抛在 tween 回调里的异常会被 TweenSystem **吞掉** → 全流程 try/catch/finally；
 *   · 🔴 补间没跑完就把节点 `active=false` / 复用，补间会被「暂停并留存」，
 *     下次复用时先把结束姿态写进本轮起始帧（**严格隔次**怪 bug）→ 本组件每次播放
 *     **新建**节点，播放前先 `Tween.stopAllByTarget` + 销毁旧节点，绝不复用半途的节点；
 *   · `Node` 没有 `setName()`，`name` 是普通属性；
 *   · Sprite 默认 `sizeMode = TRIMMED` 会按裁剪后尺寸改写节点大小 → 必须显式
 *     `sizeMode = CUSTOM` 再把 contentSize 设成我们要的尺寸。
 * ===========================================================================
 */
@ccclass('CardSummonOrbFx')
@menu('gf2/效果/CardSummonOrbFx')
export class CardSummonOrbFx extends Component {
    @property({ tooltip: '总开关：关掉后 play() 直接返回，不产生任何节点' })
    enableSummonFx = true;

    @property({ range: [0.1, 2, 0.05], slide: true, tooltip: '整段动画时长（秒）' })
    duration = 0.55;

    @property({ range: [0, 0.5, 0.01], slide: true, tooltip: '起手延迟（秒）：卡牌落定后再炸开' })
    delay = 0.04;

    @property({ range: [0.2, 4, 0.05], slide: true, tooltip: '加色亮度倍数（>1 更亮更「过曝」）' })
    intensity = 0.95;

    @property({ tooltip: '光球颜色（会被 ADD 混合当作染色）' })
    color = new Color(255, 198, 104, 255);

    @property({ range: [0, 1, 0.05], slide: true, tooltip: '核心层「提白」程度：0=跟设定色一致，1=纯白（白热芯 + 暖金环的经典搭配）' })
    coreWhiten = 0.6;

    @property({ range: [0.3, 2, 0.05], slide: true, tooltip: '核心层尺寸（相对卡牌长边）' })
    coreScale = 0.85;

    @property({ range: [0.3, 3, 0.05], slide: true, tooltip: '弥散层尺寸（相对卡牌长边）' })
    midScale = 1.35;

    @property({ range: [0.3, 4, 0.05], slide: true, tooltip: '冲击环尺寸（相对卡牌长边）' })
    ringScale = 1.70;

    @property({ range: [0, 180, 1], slide: true, tooltip: '动画期间各层旋转的总角度（度）' })
    rotateDeg = 40;

    /** 正在播放中 */
    private _playing = false;
    /** 资源还没就绪时挂起，等 update 里资源到位再播（首张卡不会丢特效） */
    private _waiting = false;
    /** 本次播放的临时节点 / 材质 */
    private _fx: Node | null = null;
    private _mat: Material | null = null;
    /** 时间轴补间补的是这个纯数值对象（不是节点）→ stop() 必须显式停它 */
    private _state: { p: number } | null = null;

    protected onDisable(): void {
        this.stop();
    }

    protected onDestroy(): void {
        this.stop();
    }

    public get isPlaying(): boolean {
        return this._playing;
    }

    public get fxNode(): Node | null {
        return this._fx && this._fx.isValid ? this._fx : null;
    }

    public get fxMaterial(): Material | null {
        return this._mat;
    }

    /**
     * 播一次入场光球（卡牌刚落定 / 任意时机手动调用均可）。
     * @returns 是否立刻开始了播放（资源未就绪时返回 false，但会在 update 里补播）
     */
    public play(): boolean {
        if (!this.enableSummonFx) return false;
        if (!this.node || !this.node.isValid) return false;
        preloadSummonOrbAssets();
        if (!summonOrbAssetsReady()) {
            // 资源还在异步加载：挂起，等 update() 里就绪后补播（首张卡不会漏特效）
            this._waiting = true;
            return false;
        }
        this._waiting = false;
        this.startFx();
        return true;
    }

    /** 立刻中止并清理（切场景 / 卡牌被销毁 / 重复播放前都会走） */
    public stop(): void {
        this._waiting = false;
        this._playing = false;
        if (this._state) {
            Tween.stopAllByTarget(this._state);   // 🔴 时间轴补间的 target 是数值对象，必须单独停
            this._state = null;
        }
        if (this._fx && this._fx.isValid) {
            Tween.stopAllByTarget(this._fx);
            killNode(this._fx);
        }
        this._fx = null;
        if (this._mat) {
            this._mat.destroy();
            this._mat = null;
        }
    }

    protected update(): void {
        if (!this._waiting) return;
        if (!summonOrbAssetsReady()) return;
        this._waiting = false;
        if (this.node && this.node.isValid) this.startFx();
    }

    // ------------------------------ 内部实现 ------------------------------
    private startFx(): void {
        const host = this.node;
        if (!host || !host.isValid) return;

        // 先彻底清掉上一轮（含可能在跑的补间）——绝不复用半途节点
        this.stop();

        const eff = _effect;
        const sfs = _sfs;
        if (!eff || !eff.isValid || !sfs[0] || !sfs[1] || !sfs[2]) return;

        // 材质：每次播放一个（为了能独立调 intensity）；shader 程序仍是共用的
        const mat = new Material();
        mat.initialize({ effectAsset: eff });
        mat.setProperty('intensity', this.intensity);
        this._mat = mat;

        // 容器：挂在卡牌根节点下、siblingIndex 放最后 → 画在卡牌最上层
        const fx = new Node(SUMMON_ORB_FX_NAME);
        fx.setParent(host);
        fx.setSiblingIndex(host.children.length - 1);
        if (!fx.getComponent(UITransform)) fx.addComponent(UITransform);
        this._fx = fx;

        // 以卡牌**可视中心**为原点：卡牌锚点不一定是 (0.5,0.5)，所以按锚点反推偏移
        const ut = host.getComponent(UITransform);
        const cw = ut ? ut.contentSize.width : 0;
        const ch = ut ? ut.contentSize.height : 0;
        const base = Math.max(cw, ch, 120);
        const ox = ut ? (0.5 - ut.anchorX) * cw : 0;
        const oy = ut ? (0.5 - ut.anchorY) * ch : 0;
        fx.setPosition(ox, oy, 0);

        // 三层 Sprite
        const sizes = [this.coreScale, this.midScale, this.ringScale];
        // 分层配色：材质（含 intensity）是三层共用的，所以「核心偏白、外环暖金」只能靠
        // **节点色**（= 顶点色）实现 —— 加色下白芯会自然过曝成白热，外环保持琥珀金。
        const kw = Math.max(0, Math.min(1, this.coreWhiten));
        const tints: Color[] = [
            new Color(
                Math.round(this.color.r + (255 - this.color.r) * kw),
                Math.round(this.color.g + (255 - this.color.g) * kw),
                Math.round(this.color.b + (255 - this.color.b) * kw),
                255,
            ),
            new Color(this.color),
            new Color(this.color),
        ];
        const sprites: Sprite[] = [];
        const colors: Color[] = [];
        for (let i = 0; i < SUMMON_ORB_LAYERS.length; i++) {
            const cfg = SUMMON_ORB_LAYERS[i];
            const n = new Node('Orb_' + i);
            n.setParent(fx);
            const tn = n.addComponent(UITransform);
            const sp = n.addComponent(Sprite);
            sp.sizeMode = Sprite.SizeMode.CUSTOM;    // 🔴 默认 TRIMMED 会改写节点尺寸，必须显式 CUSTOM
            sp.spriteFrame = sfs[cfg.tex];
            sp.customMaterial = mat;
            const c = new Color(tints[i]);
            c.a = 0;
            sp.color = c;
            tn.setContentSize(base * sizes[i] * cfg.from, base * sizes[i] * cfg.from);
            sprites.push(sp);
            colors.push(c);
        }

        this._playing = true;

        // 一条数值补间驱动整条时间轴（铁律：数值补间 + onUpdate 里写目标属性）
        const state = { p: 0 };
        this._state = state;
        const self = this;
        let done = false;
        const fail = (e: unknown) => {
            if (done) return;
            done = true;
            console.error('[CardSummonOrbFx] 播放光球时出错：', e);
            self.stop();
        };
        tween(state)
            .delay(Math.max(0, this.delay))
            .to(Math.max(0.01, this.duration), { p: 1 }, {
                easing: 'linear',
                onUpdate: (t) => {
                    if (done) return;
                    try {
                        const p = (t as { p: number }).p;
                        for (let i = 0; i < SUMMON_ORB_LAYERS.length; i++) {
                            const cfg = SUMMON_ORB_LAYERS[i];
                            const sp = sprites[i];
                            if (!sp || !sp.isValid) continue;
                            const sc = orbScaleAt(p, cfg);
                            const size = base * sizes[i] * sc;
                            const tn = sp.node.getComponent(UITransform);
                            if (tn) tn.setContentSize(size, size);
                            sp.node.setRotationFromEuler(0, 0, self.rotateDeg * cfg.dir * p);
                            const a = orbAlphaAt(p, cfg);
                            const c = colors[i];
                            c.a = Math.round(255 * Math.max(0, Math.min(1, a)));
                            sp.color = c;
                        }
                    } catch (e) { fail(e); }
                },
            })
            .call(() => {
                if (done) return;
                done = true;
                try { self.stop(); } catch (e) { fail(e); }
            })
            .start();
    }
}
