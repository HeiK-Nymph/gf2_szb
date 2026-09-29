import {
    Color, EffectAsset, Material, Node, resources, Sprite, SpriteFrame, Tween, tween, UITransform, Vec3,
} from 'cc';
import { killNode } from './CardComposer';

/** 法术特效子节点名（运行时挂在打出专图层下，siblingIndex 最后 = 画在最上层） */
export const SPELL_CAST_FX_NAME = 'SpellCastOrbFx';

/** 复用召唤光球的加色 effect（同一份 shader：染色的贴图 × 加法混合） */
const SPELL_EFFECT_NAME = 'SummonOrbAdd';
const SPELL_EFFECT_RES_PATH = 'effects/SummonOrbAdd';

/**
 * 五张贴图**按播放顺序**排列 —— 不是文件名顺序，是按「环半径由内到外」排的：
 *   0 circle_05 实心核心盘（峰值半径 0）
 *   1 circle_02 细锐内环（r≈0.58，最亮最锐）
 *   2 circle_04 柔和中环（r≈0.63）
 *   3 circle_01 厚实中环（r≈0.67）
 *   4 circle_03 最外大环（r≈0.72）
 * 顺序即「法术圈从中心一圈圈炸出去」的观感。
 */
const TEX_PATHS: readonly string[] = [
    'effects/SpellCastOrb/circle_05/spriteFrame',
    'effects/SpellCastOrb/circle_02/spriteFrame',
    'effects/SpellCastOrb/circle_04/spriteFrame',
    'effects/SpellCastOrb/circle_01/spriteFrame',
    'effects/SpellCastOrb/circle_03/spriteFrame',
];

/** 每个环的出场窗口（p ∈ [0,1] 归一化时间轴）：起步越晚 = 越靠外的环 */
const RING_WINDOWS: readonly { t0: number; dur: number; peak: number }[] = [
    { t0: 0.00, dur: 0.30, peak: 0.95 },
    { t0: 0.10, dur: 0.36, peak: 0.85 },
    { t0: 0.22, dur: 0.40, peak: 0.80 },
    { t0: 0.34, dur: 0.44, peak: 0.75 },
    { t0: 0.44, dur: 0.56, peak: 0.70 },
];

/**
 * 可调参数（集中在这里，方便一处调参；改完 refresh 即生效）。
 * ⚠️ 这是**模块常量**而非组件 @property —— 本特效不挂场景组件（法术卡会被销毁，
 *    特效必须脱离卡牌、挂在持久的打出专图层上），所以没有 Inspector 可调。
 */
export const SpellCastOrbConfig = {
    /** 整段时长（秒） */
    duration: 0.55,
    /** 起手延迟（秒） */
    delay: 0.0,
    /** 染色（环是白色贴图，靠节点色染成法术色） */
    color: new Color(120, 176, 255, 255),
    /**
     * 是否用**加色（ADD）**混合。
     * 🔴 法术展示在**屏幕正中、战场之上**，背景通常是亮的 —— 加色在亮底上会把三通道
     *    一起顶到 255，观感变成「纯白冲击波」而不是「法术圈」。所以法术默认走
     *    **普通 alpha 混合**（染色能保住），想要发光感再打开它。
     */
    additive: false,
    /** 加色亮度倍数（仅 additive=true 时生效） */
    intensity: 1.0,
    /** 整体尺寸 = 卡牌显示长边 × sizeK（环的半径由贴图自身决定，这里只定整体尺度） */
    sizeK: 0.614,
    /** 整个法术圈的缩放起止（配合各环自己的窗口 = 向外扩张感） */
    scaleFrom: 0.78,
    scaleTo: 1.16,
    /** 整段总旋转角（度，负 = 顺时针） */
    rotateDeg: -70,
    /** 每个环自身在窗口内的微缩放起止（让环有「往外推」的呼吸感） */
    ringScaleFrom: 0.90,
    ringScaleTo: 1.06,
};

// ============================================================================
// 模块级资源缓存（效果 1 份 + 贴图 5 张；所有法术共用）
// ============================================================================
let _effect: EffectAsset | null = null;
let _loadingEffect = false;
const _sfs: (SpriteFrame | null)[] = [null, null, null, null, null];
let _loadingSfs = false;
let _warned = false;
/** 资源未就绪时挂起的播放请求（打出专图层是常驻节点，稍后补播是安全的） */
const _pending: { parent: Node; pos: Vec3; size: number; color: Color | null }[] = [];

export function spellCastOrbAssetsReady(): boolean {
    return !!_effect && _sfs.every((s) => s !== null);
}

/** 预加载法术特效资源（幂等；建议在 CardPlay / EnemyCardPlay 的 onLoad 调一次） */
export function preloadSpellCastOrbAssets(): void {
    if (!_effect) {
        const byName = EffectAsset.get(SPELL_EFFECT_NAME);
        if (byName) _effect = byName;
        else if (!_loadingEffect) {
            _loadingEffect = true;
            resources.load(SPELL_EFFECT_RES_PATH, EffectAsset, (err, asset) => {
                _loadingEffect = false;
                if (err || !asset) { warnOnce(`加载效果 "${SPELL_EFFECT_RES_PATH}" 失败`, err); return; }
                _effect = asset;
                flushPending();
            });
        }
    }
    if (_sfs.every((s) => s !== null) || _loadingSfs) return;
    _loadingSfs = true;
    let remain = TEX_PATHS.length;
    TEX_PATHS.forEach((path, i) => {
        resources.load(path, SpriteFrame, (err, sf) => {
            remain--;
            if (err || !sf) warnOnce(`加载法术贴图 "${path}" 失败`, err);
            else _sfs[i] = sf;
            if (remain <= 0) { _loadingSfs = false; flushPending(); }
        });
    });
}

function warnOnce(msg: string, err: unknown): void {
    if (_warned) return;
    _warned = true;
    console.warn(`[SpellCastOrbFx] ${msg} →`, err);
}

function flushPending(): void {
    if (!spellCastOrbAssetsReady()) return;
    while (_pending.length > 0) {
        const req = _pending.shift() as { parent: Node; pos: Vec3; size: number; color: Color | null };
        if (req.parent && req.parent.isValid) spawn(req.parent, req.pos, req.size, req.color);
    }
}

/**
 * 在 `parent` 的 `localPos` 处炸一个法术圈。
 * ⚠️ 典型用法是在**法术展示卡被销毁的那一刻**调用（此时卡已不在树上，所以用它的
 *    父节点 + 局部坐标把特效挂到持久的打出专图层上，特效与能力时机无关）。
 * @param parent   特效的宿主（一般传卡牌销毁前的 parent，即 CardPlayLayer）
 * @param localPos 卡牌消失时在其 parent 本地坐标下的位置
 * @param size     卡牌**显示**尺寸（已含 scale，取长边即可）
 * @param color    可选染色；不传用 SpellCastOrbConfig.color
 */
export function playSpellCastOrb(parent: Node, localPos: Vec3, size: number, color?: Color | null): void {
    if (!parent || !parent.isValid) return;
    preloadSpellCastOrbAssets();
    if (!spellCastOrbAssetsReady()) {
        _pending.push({ parent, pos: localPos.clone(), size, color: color ? new Color(color) : null });
        return;
    }
    spawn(parent, localPos, size, color ?? null);
}

// ============================================================================
// 内部：建节点 + 一条数值补间驱动整条时间轴
// ============================================================================
function spawn(parent: Node, localPos: Vec3, size: number, color: Color | null): void {
    const eff = _effect;
    if (!eff || !eff.isValid) return;

    const cfg = SpellCastOrbConfig;
    const base = Math.max(40, size) * cfg.sizeK;
    const tint = color ? new Color(color) : new Color(cfg.color);

    // 每次播放新建材质（tint/intensity 可独立），结束 destroy
    const mat = cfg.additive ? new Material() : null;
    if (mat) {
        mat.initialize({ effectAsset: eff });
        mat.setProperty('intensity', cfg.intensity);
    }

    const fx = new Node(SPELL_CAST_FX_NAME);
    fx.setParent(parent);
    fx.setSiblingIndex(parent.children.length - 1);   // 画在最上层
    if (!fx.getComponent(UITransform)) fx.addComponent(UITransform);
    fx.setPosition(localPos.x, localPos.y, 0);
    fx.setScale(cfg.scaleFrom, cfg.scaleFrom, 1);

    const sprites: Sprite[] = [];
    const colors: Color[] = [];
    for (let i = 0; i < RING_WINDOWS.length; i++) {
        const n = new Node('Ring_' + i);
        n.setParent(fx);
        const tn = n.addComponent(UITransform);
        const sp = n.addComponent(Sprite);
        sp.sizeMode = Sprite.SizeMode.CUSTOM;    // 🔴 默认 TRIMMED 会改写 contentSize
        sp.spriteFrame = _sfs[i];
        if (mat) sp.customMaterial = mat;
        const c = new Color(tint);
        c.a = 0;
        sp.color = c;
        tn.setContentSize(base, base);
        sprites.push(sp);
        colors.push(c);
    }

    const state = { p: 0 };
    let done = false;
    const cleanup = () => {
        if (done) return;
        done = true;
        Tween.stopAllByTarget(state);
        if (fx.isValid) killNode(fx);
        if (mat && mat.isValid) mat.destroy();
    };
    const fail = (e: unknown) => {
        console.error('[SpellCastOrbFx] 播放法术特效出错：', e);
        cleanup();
    };

    tween(state)
        .delay(Math.max(0, cfg.delay))
        .to(Math.max(0.01, cfg.duration), { p: 1 }, {
            easing: 'linear',
            onUpdate: (t) => {
                if (done) return;
                try {
                    const p = (t as { p: number }).p;
                    // 整体：向外放大 + 旋转
                    const e = 1 - (1 - p) * (1 - p);                 // easeOutQuad
                    const s = cfg.scaleFrom + (cfg.scaleTo - cfg.scaleFrom) * e;
                    if (fx.isValid) {
                        fx.setScale(s, s, 1);
                        fx.setRotationFromEuler(0, 0, cfg.rotateDeg * p);
                    }
                    // 各环：按窗口淡入 + 微缩放
                    for (let i = 0; i < sprites.length; i++) {
                        const sp = sprites[i];
                        if (!sp || !sp.isValid) continue;
                        const w = RING_WINDOWS[i];
                        const a = windowAlpha(p, w.t0, w.dur, w.peak);
                        const c = colors[i];
                        c.a = Math.round(255 * Math.max(0, Math.min(1, a)));
                        sp.color = c;
                        const rs = cfg.ringScaleFrom + (cfg.ringScaleTo - cfg.ringScaleFrom) * e;
                        const tn = sp.node.getComponent(UITransform);
                        if (tn) tn.setContentSize(base * rs, base * rs);
                    }
                } catch (err) { fail(err); }
            },
        })
        .call(() => cleanup())   // 🔴 不要在这里先置 done：cleanup() 自己就有 done 守卫，先置位会把清理短路掉
        .start();
}

/** 窗口内透明度：前 28% 淡入，其后 √ 曲线淡出（外缘浓密、慢衰减） */
function windowAlpha(p: number, t0: number, dur: number, peak: number): number {
    const u = (p - t0) / dur;
    if (u <= 0 || u >= 1) return 0;
    if (u < 0.28) return peak * (u / 0.28);
    return peak * Math.sqrt(Math.max(0, 1 - (u - 0.28) / 0.72));
}
