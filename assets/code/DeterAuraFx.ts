import {
    _decorator, Color, Component, EffectAsset, Material, Node, resources, Sprite, SpriteFrame, UITransform, Vec3,
} from 'cc';
import { killNode, releaseChildren } from './CardComposer';

const { ccclass, property, menu } = _decorator;

/**
 * DeterAuraFx —— 「威慑」随从的光圈特效
 * ===========================================================================
 * 参考示例图：卡牌外圈一枚**绿色能量光圈**，只在原地做循环变化。
 *
 * 🔴 需求红线：**光圈不发生放大 / 缩小**（不做任何 scale 动画），
 *    只在原地循环播放序列帧（+ 轻微亮度呼吸）。位置与尺寸恒定。
 *
 * 素材管线（`assets/resources/effects/Deter/`）：
 *   源图 `shield.png` 是 512×128 的 **4 帧精灵图**（蓝色、低 alpha、尖刺能量环）。
 *   预处理脚本 `.workbuddy/tmp/deter_preprocess.js` 把它切成 4 张 128×128：
 *     · RGB 统一转**纯白**（关键：白色才能被节点色染成绿色；原图是蓝色，蓝×绿=黑）
 *     · A = 原 alpha 归一化(÷182) 后 gamma 0.8 提亮（保留丝状尖刺）
 *   产物 `DeterRing_01..04.png` → `gen_sf_meta_ui.js` 转 sprite-frame。
 *
 * 渲染：两层（外层柔光 + 内层主环），加色（ADD）混合、绿色染色。
 * 帧动画 / 呼吸都走 `update(dt)`，不用补间。
 *
 * 柔和化（v2，避免刺眼）：
 *   · 相邻帧**交叉淡入淡出**（crossFade）：每层两张 sprite，帧 i 淡出 / 帧 i+1 淡入，
 *     两帧权重和恒为 1 ⇒ 加色下总亮度不变，把「10Hz 硬切跳变」变成「缓慢形变」；
 *   · 默认帧率降到 4fps（一轮 1 秒），呼吸更慢更轻；
 *   · 外层柔光默认**静止**（不参与换帧，只做呼吸）⇒ 大面积光晕恒定，只剩细环缓慢形变。
 */

/** 光圈子节点名（运行时挂在卡牌下） */
export const DETER_AURA_NODE = 'DeterAura';

/** 4 帧贴图在 resources 下的路径（**子资源要带 `/spriteFrame`**），按播放顺序 */
export const DETER_TEX_RES_PATHS: readonly string[] = [
    'effects/Deter/DeterRing_01/spriteFrame',
    'effects/Deter/DeterRing_02/spriteFrame',
    'effects/Deter/DeterRing_03/spriteFrame',
    'effects/Deter/DeterRing_04/spriteFrame',
];

/** 复用召唤光球的加色 effect */
const EFFECT_NAME = 'SummonOrbAdd';
const EFFECT_RES_PATH = 'effects/SummonOrbAdd';

/** 威慑光圈配置（由 CardKeywordSystem 的 Inspector 属性组装） */
export interface DeterAuraConfig {
    /** 光圈基础高度 = 卡牌显示高度 × 本值 */
    scale?: number;
    /** X 偏移（按卡宽比例；正 = 右移） */
    offsetX?: number;
    /** Y 偏移（按卡高比例；正 = 上移） */
    offsetY?: number;
    /** 主色（绿） */
    color?: Color;
    /** 外层柔光色 */
    glowColor?: Color;
    /** 加色亮度倍数 */
    intensity?: number;
    /** 序列帧播放帧率（帧/秒） */
    fps?: number;
    /** 外层柔光相对尺寸 */
    outerScale?: number;
    /** 外层柔光透明度 */
    outerAlpha?: number;
    /** 主环透明度 */
    coreAlpha?: number;
    /** 亮度呼吸幅度（0 = 不呼吸；仅改透明度，不改尺寸） */
    shimmer?: number;
    /** 亮度呼吸周期（秒） */
    shimmerPeriod?: number;
    /** 相邻帧是否交叉淡入淡出（关 = 直接切帧，会有跳变） */
    crossFade?: boolean;
    /** 外层柔光是否跟随帧动画（关 = 静止柔光，观感最柔和） */
    outerAnimate?: boolean;
}

// ============================================================================
// 模块级资源缓存（所有威慑随从共用 1 份 effect + 4 张贴图）
// ============================================================================
let _effect: EffectAsset | null = null;
let _loadingEffect = false;
const _sfs: (SpriteFrame | null)[] = [null, null, null, null];
let _loadingSfs = false;
let _warned = false;

export function deterAssetsReady(): boolean {
    return !!_effect && _effect.isValid && _sfs.every((s) => !!s && s.isValid);
}

/** 预加载威慑光圈素材（幂等；建议在 CardKeywordSystem.onLoad 调一次） */
export function preloadDeterAssets(): void {
    if (!_effect) {
        const byName = EffectAsset.get(EFFECT_NAME);
        if (byName) _effect = byName;
        else if (!_loadingEffect) {
            _loadingEffect = true;
            resources.load(EFFECT_RES_PATH, EffectAsset, (err, asset) => {
                _loadingEffect = false;
                if (err || !asset) warn(`加载效果失败："${EFFECT_RES_PATH}"`, err);
                else _effect = asset;
            });
        }
    }
    if (_sfs.every((s) => !!s) || _loadingSfs) return;
    _loadingSfs = true;
    let remain = DETER_TEX_RES_PATHS.length;
    DETER_TEX_RES_PATHS.forEach((p, i) => {
        resources.load(p, SpriteFrame, (err, sf) => {
            remain--;
            if (err || !sf) warn(`加载威慑贴图失败："${p}"`, err);
            else _sfs[i] = sf;
            if (remain <= 0) _loadingSfs = false;
        });
    });
}

function warn(msg: string, err: unknown): void {
    if (_warned) return;
    _warned = true;
    console.warn('[DeterAuraFx] ' + msg + ' →', err);
}

// ============================================================================
// 对外 API
// ============================================================================
/**
 * 给卡牌挂上 / 刷新「威慑」光圈。资源未就绪时静默返回（调用方按扫描周期重试）。
 * @returns 是否已挂上
 */
export function ensureDeterAura(card: Node | null, config?: DeterAuraConfig): boolean {
    if (!card || !card.isValid) return false;
    preloadDeterAssets();
    if (!deterAssetsReady()) return false;

    let node = card.getChildByName(DETER_AURA_NODE);
    if (!node || !node.isValid) {
        node = new Node(DETER_AURA_NODE);
        node.setParent(card);
        node.addComponent(UITransform);
        node.addComponent(DeterAuraFx);
    }
    const fx = node.getComponent(DeterAuraFx);
    if (!fx) return false;
    if (config) fx.applyConfig(config);
    fx.refresh();
    return true;
}

/** 移除卡牌上的威慑光圈（没有则无害）。 */
export function removeDeterAura(card: Node | null): void {
    if (!card || !card.isValid) return;
    const node = card.getChildByName(DETER_AURA_NODE);
    if (node) killNode(node);
}

/** 该卡当前是否挂着威慑光圈。 */
export function hasDeterAura(card: Node | null): boolean {
    return !!card && card.isValid && !!card.getChildByName(DETER_AURA_NODE);
}

// ============================================================================
// 组件：两层同帧号播放 + 亮度呼吸（**绝不做缩放动画**）
// ============================================================================
interface DeterLayer {
    /** [0] = 当前帧；crossFade 时 [1] = 下一帧（淡入用） */
    sprites: Sprite[];
    k: number;
    peak: number;
    color: Color;
    /** 是否参与帧动画（false = 静止在 0 号帧，只做呼吸） */
    animate: boolean;
}

@ccclass('DeterAuraFx')
@menu('gf2szb/DeterAuraFx')
export class DeterAuraFx extends Component {

    // —— 本实例当前生效值；真正在 Inspector 调的是 CardKeywordSystem 上的同名属性 ——
    scale = 1.24;
    offsetX = 0;
    offsetY = 0;
    color = new Color(70, 255, 140, 255);
    glowColor = new Color(120, 255, 175, 255);
    intensity = 0.9;
    fps = 4;
    outerScale = 1.1;
    outerAlpha = 0.3;
    coreAlpha = 0.95;
    shimmer = 0.07;
    shimmerPeriod = 3.6;
    crossFade = true;
    outerAnimate = false;

    private _layers: DeterLayer[] = [];
    private _mat: Material | null = null;
    private _baseW = 0;
    private _baseH = 0;
    private _t = 0;
    private _built = false;
    private _sig = '';

    // ------------------------------ 生命周期 ------------------------------
    onEnable(): void {
        this.refresh();
    }

    onDisable(): void {
        this.teardown();
    }

    onDestroy(): void {
        this.teardown();
    }

    /** 下发 Inspector 配置。 */
    public applyConfig(cfg: DeterAuraConfig): void {
        if (typeof cfg.scale === 'number') this.scale = cfg.scale;
        if (typeof cfg.offsetX === 'number') this.offsetX = cfg.offsetX;
        if (typeof cfg.offsetY === 'number') this.offsetY = cfg.offsetY;
        if (cfg.color) this.color = new Color(cfg.color);
        if (cfg.glowColor) this.glowColor = new Color(cfg.glowColor);
        if (typeof cfg.intensity === 'number') this.intensity = cfg.intensity;
        if (typeof cfg.fps === 'number') this.fps = cfg.fps;
        if (typeof cfg.outerScale === 'number') this.outerScale = cfg.outerScale;
        if (typeof cfg.outerAlpha === 'number') this.outerAlpha = cfg.outerAlpha;
        if (typeof cfg.coreAlpha === 'number') this.coreAlpha = cfg.coreAlpha;
        if (typeof cfg.shimmer === 'number') this.shimmer = cfg.shimmer;
        if (typeof cfg.shimmerPeriod === 'number') this.shimmerPeriod = cfg.shimmerPeriod;
        if (typeof cfg.crossFade === 'boolean') this.crossFade = cfg.crossFade;
        if (typeof cfg.outerAnimate === 'boolean') this.outerAnimate = cfg.outerAnimate;
    }

    /** 依据宿主卡牌尺寸重建/刷新（尺寸或外观参数变化时重建）。 */
    public refresh(): void {
        const host = this.node.parent;
        if (!host || !host.isValid) return;
        if (!deterAssetsReady()) { preloadDeterAssets(); return; }

        const hut = host.getComponent(UITransform);
        const cw = hut ? hut.contentSize.width : 204;
        const ch = hut ? hut.contentSize.height : 252;

        // 🔑 用第一帧的 trim 矩形算宽高比（4 帧同尺寸）
        const sf0 = _sfs[0] as SpriteFrame;
        const r = sf0.rect;
        const aspect = r.height > 0 ? r.width / r.height : 0.86;

        const baseH = Math.max(40, ch * this.scale);
        const baseW = baseH * aspect;

        const sig = [
            this.intensity, this.outerScale, this.outerAlpha, this.coreAlpha,
            this.color.r, this.color.g, this.color.b,
            this.glowColor.r, this.glowColor.g, this.glowColor.b,
            Math.round(baseW), Math.round(baseH),
        ].join(',');

        if (sig === this._sig && this._built) {
            this.applyStatic();
            return;
        }
        this._sig = sig;
        this._baseW = baseW;
        this._baseH = baseH;
        this.build();
    }

    // ------------------------------ 内部 ------------------------------
    private build(): void {
        this.teardown();
        this._built = true;

        const eff = _effect as EffectAsset;
        const mat = new Material();
        mat.initialize({ effectAsset: eff });
        mat.setProperty('intensity', this.intensity);
        this._mat = mat;

        const defs: { k: number; peak: number; color: Color; animate: boolean }[] = [
            { k: this.outerScale, peak: this.outerAlpha, color: new Color(this.glowColor), animate: this.outerAnimate },
            { k: 1.00, peak: this.coreAlpha, color: new Color(this.color), animate: true },
        ];

        for (let i = 0; i < defs.length; i++) {
            const d = defs[i];
            const holder = new Node('Deter_' + i);
            holder.setParent(this.node);
            holder.addComponent(UITransform);
            const sprites: Sprite[] = [];
            // 每层两张 sprite：A = 当前帧，B = 下一帧（交叉淡入淡出用）
            for (let j = 0; j < 2; j++) {
                const n = new Node('Frame_' + j);
                n.setParent(holder);
                const tn = n.addComponent(UITransform);
                const sp = n.addComponent(Sprite);
                sp.sizeMode = Sprite.SizeMode.CUSTOM;   // 🔴 默认 TRIMMED 会改写 contentSize
                sp.spriteFrame = _sfs[0];
                sp.customMaterial = mat;
                const c = new Color(d.color);
                c.a = 0;
                sp.color = c;
                tn.setContentSize(this._baseW * d.k, this._baseH * d.k);
                sprites.push(sp);
            }
            this._layers.push({ sprites, k: d.k, peak: d.peak, color: new Color(d.color), animate: d.animate });
        }
        this.applyStatic();
        this.update(0);
    }

    /** 位置 / 层级：以卡牌可视中心为基准（可带偏移）；插在 CardHp 之前 → 属性数字压在光圈之上。 */
    private applyStatic(): void {
        const host = this.node.parent;
        if (!host || !host.isValid) return;
        const hut = host.getComponent(UITransform);
        const cw = hut ? hut.contentSize.width : 0;
        const ch = hut ? hut.contentSize.height : 0;
        const ox = hut ? (0.5 - hut.anchorX) * cw : 0;
        const oy = hut ? (0.5 - hut.anchorY) * ch : 0;
        this.node.setPosition(ox + cw * this.offsetX, oy + ch * this.offsetY, 0);

        const hp = host.getChildByName('CardHp');
        const idx = hp ? hp.getSiblingIndex() : host.children.length;
        this.node.setSiblingIndex(Math.max(0, Math.min(idx, host.children.length - 1)));
    }

    private teardown(): void {
        this._layers.length = 0;
        this._built = false;
        if (this._mat && this._mat.isValid) this._mat.destroy();
        this._mat = null;
        releaseChildren(this.node);
    }

    update(dt: number): void {
        if (!this._built) { this.refresh(); return; }
        if (this._layers.length === 0) return;
        this._t += dt;

        // 序列帧推进（**只换贴图，不改尺寸/位置**）
        const n = _sfs.length;
        const fps = Math.max(0.1, this.fps);
        const ft = this._t * fps;
        const i = Math.floor(ft) % n;
        // u = 帧内插值；交叉淡入淡出时用 u 在两帧之间过渡，否则直接硬切（u=0）
        const u = this.crossFade ? (ft - Math.floor(ft)) : 0;
        const iNext = (i + 1) % n;

        // 亮度呼吸：仅动 alpha（需求：光圈不放大缩小）
        const period = Math.max(0.3, this.shimmerPeriod);
        const s = 0.5 + 0.5 * Math.sin((this._t / period) * Math.PI * 2);
        const k = 1 - this.shimmer * (1 - s);

        for (const L of this._layers) {
            const aIdx = L.animate ? i : 0;
            const bIdx = L.animate ? iNext : 0;
            const aA = L.animate ? (1 - u) : 1;     // A/B 权重和恒为 1 ⇒ 加色下总亮度不变
            const aB = L.animate ? u : 0;
            const sfA = _sfs[aIdx];
            const sfB = _sfs[bIdx];
            const parts: { sp: Sprite; sf: SpriteFrame | null; w: number }[] = [
                { sp: L.sprites[0], sf: sfA, w: aA },
                { sp: L.sprites[1], sf: sfB, w: aB },
            ];
            for (const pt of parts) {
                const sp = pt.sp;
                if (!sp || !sp.isValid) continue;
                if (pt.sf && pt.sf.isValid && sp.spriteFrame !== pt.sf) sp.spriteFrame = pt.sf;
                const c = L.color;
                sp.color = new Color(c.r, c.g, c.b, Math.round(255 * L.peak * k * pt.w));
                // 🔴 显式确保尺寸恒定（绝无缩放动画）
                const tn = sp.node.getComponent(UITransform);
                if (tn) tn.setContentSize(this._baseW * L.k, this._baseH * L.k);
            }
        }
    }
}
