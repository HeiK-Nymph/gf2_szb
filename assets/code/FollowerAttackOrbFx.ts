import {
    Color, EffectAsset, Material, Node, resources, Sprite, SpriteFrame, UITransform, Vec3,
} from 'cc';
import { killNode } from './CardComposer';

/**
 * FollowerAttackOrbFx —— 随从普通攻击的「能量球飞射」特效（**模块级**，不是场景组件）
 * ===========================================================================
 * 需求：随从攻击时，用 `assets/resources/effects/FollowerAttackOrb` 里的素材，
 *      把一颗特效球从**发起攻击方随从卡牌中心**射向**被攻击方卡牌中心**，
 *      球到达目标中心的**同一时刻**动画结束。
 *
 * 关键设计
 *   · 与 `SpellCastOrbFx` 一样由**外部驱动进度 p∈[0,1]**（返回 handle 而不是自己跑补间）——
 *     这样「卡牌绕 Y 轴转 -360°」和「特效球飞行」可以在 FollowerAttackAnim 里用
 *     **同一条数值补间**驱动，时间严格一致（用户明确要求二者同起同止）。
 *   · 五张贴图是「同一颗能量球由小到大的五层」：以同心多层叠加 + 各自反向自转，
 *     得到「白热芯 + 缠绕能量弧 + 外圈光晕」的观感。
 *   · 加色（ADD）混合默认开启 —— 战场底色偏暗，加法混合更像发光；材质是共享的
 *     `SummonOrbAdd`（blendSrc: src_alpha / blendDst: one）。
 *
 * 资源缓存是**模块级**的：所有卡牌共用同一份 effect + 5 张 spriteFrame，绝不每张卡各加载一份。
 */

/** 特效球宿主节点名（运行时挂在专图层下） */
export const FOLLOWER_ATTACK_FX_NODE = 'FollowerAttackOrbFx';

/** 复用召唤光球的加色 effect（同一份 shader：染色贴图 × 加法混合） */
const EFFECT_NAME = 'SummonOrbAdd';
const EFFECT_RES_PATH = 'effects/SummonOrbAdd';

/** 五张贴图（**子资源**要带 `/spriteFrame` 后缀），按「由内到外」排列。 */
export const FOLLOWER_ATTACK_TEX_RES_PATHS: readonly string[] = [
    'effects/FollowerAttackOrb/LightEffect_01/spriteFrame',   // 最小、最弱：白热芯
    'effects/FollowerAttackOrb/LightEffect_02/spriteFrame',
    'effects/FollowerAttackOrb/LightEffect_03/spriteFrame',
    'effects/FollowerAttackOrb/LightEffect_04/spriteFrame',
    'effects/FollowerAttackOrb/LightEffect_05/spriteFrame',   // 最大、最亮：外圈光晕
];

// ============================================================================
// 模块级资源缓存
// ============================================================================
let _effect: EffectAsset | null = null;
let _loadingEffect = false;
const _sfs: (SpriteFrame | null)[] = [null, null, null, null, null];
let _loadingSfs = false;
let _warnedOnce = false;

/** 资源是否已就绪（效果 + 5 张贴图都在） */
export function followerAttackOrbAssetsReady(): boolean {
    return !!_effect && _sfs.every((s) => s !== null);
}

/** 预加载攻击特效球资源（幂等；场景启动时调一次即可，避免第一次攻击时资源还没到） */
export function preloadFollowerAttackOrbAssets(): void {
    if (!_effect) {
        const byName = EffectAsset.get(EFFECT_NAME);
        if (byName) _effect = byName;
        else if (!_loadingEffect) {
            _loadingEffect = true;
            resources.load(EFFECT_RES_PATH, EffectAsset, (err, asset) => {
                _loadingEffect = false;
                if (err || !asset) { warnOnce(`加载效果失败："${EFFECT_RES_PATH}"`, err); return; }
                _effect = asset;
            });
        }
    }
    if (_sfs.every((s) => s !== null) || _loadingSfs) return;
    _loadingSfs = true;
    let remain = FOLLOWER_ATTACK_TEX_RES_PATHS.length;
    FOLLOWER_ATTACK_TEX_RES_PATHS.forEach((path, i) => {
        resources.load(path, SpriteFrame, (err, sf) => {
            remain--;
            if (err || !sf) warnOnce(`加载特效球贴图失败："${path}"`, err);
            else _sfs[i] = sf;
            if (remain <= 0) _loadingSfs = false;
        });
    });
}

function warnOnce(msg: string, err: unknown): void {
    if (_warnedOnce) return;
    _warnedOnce = true;
    console.warn('[FollowerAttackOrbFx] ' + msg + ' →', err);
}

// ============================================================================
// 播放接口
// ============================================================================
export interface FollowerAttackOrbOptions {
    /** 基础尺寸（像素）。每层再按自身比例缩放。 */
    size?: number;
    /** 染色；不传 = 暖金色。 */
    color?: Color | null;
    /** 是否加色混合（默认 true）。 */
    additive?: boolean;
    /** 加色亮度倍数（additive=true 时生效）。 */
    intensity?: number;
    /**
     * 路径弯曲偏移（像素，需求：垂直于直线路径**偏右**的贝塞尔曲线）。
     * 语义 = **路径中点离直线的垂直距离**（即肉眼看到的鼓起量）。
     * 0 = 直线；正值 = 朝行进方向的右手侧鼓起，负值 = 左手侧。
     * （内部二次贝塞尔的控制点偏移 = 2 × 本值，因为控制点偏移在中点只体现一半。）
     */
    curveOffset?: number;
}

/** 由调用方驱动的特效球句柄：每帧 `setProgress`，结束后 `dispose`。 */
export interface FollowerAttackOrbHandle {
    /** 设置归一化进度 p∈[0,1]（0 = 停在发起方中心，1 = 抵达目标中心）。 */
    setProgress(p: number): void;
    /** 释放节点与材质（幂等）。 */
    dispose(): void;
}

/** 每层：贴图下标 / 相对基础尺寸的比例 / 整段自转角度（度）/ 峰值透明度 */
const LAYERS: { tex: number; scale: number; spin: number; peak: number }[] = [
    { tex: 0, scale: 0.50, spin: 240, peak: 1.00 },
    { tex: 1, scale: 0.72, spin: -170, peak: 0.92 },
    { tex: 2, scale: 0.92, spin: 130, peak: 0.82 },
    { tex: 3, scale: 1.10, spin: -100, peak: 0.72 },
    { tex: 4, scale: 1.32, spin: 70, peak: 0.62 },
];

/**
 * 在 `host` 下创建一颗从 `fromWorld` 飞到 `toWorld` 的特效球。
 * 位置 = 两个世界坐标在 `host` 本地空间的**线性插值**（按进度 p）。
 * @returns 句柄；资源未就绪 / host 非法时返回 null（调用方仍可只播卡牌旋转）。
 */
export function createFollowerAttackOrb(
    host: Node,
    fromWorld: Vec3,
    toWorld: Vec3,
    opts?: FollowerAttackOrbOptions,
): FollowerAttackOrbHandle | null {
    if (!host || !host.isValid) return null;
    preloadFollowerAttackOrbAssets();
    const eff = _effect;
    if (!eff || !eff.isValid || !followerAttackOrbAssetsReady()) return null;

    const size = Math.max(8, opts && typeof opts.size === 'number' ? opts.size : 130);
    const additive = !opts || opts.additive !== false;
    const intensity = opts && typeof opts.intensity === 'number' ? opts.intensity : 0.9;
    const tint = opts && opts.color ? new Color(opts.color) : new Color(255, 214, 150, 255);

    // 世界坐标 → host 本地坐标（锚点为 (0.5,0.5) 的层，本地原点 = 屏幕中心）
    const lut = host.getComponent(UITransform);
    const fromLocal = lut ? lut.convertToNodeSpaceAR(fromWorld, new Vec3()) : fromWorld.clone();
    const toLocal = lut ? lut.convertToNodeSpaceAR(toWorld, new Vec3()) : toWorld.clone();

    // 二次贝塞尔：控制点 = 直线中点 + 行进方向的**右法线** × (2 × bulge)
    // （屏幕坐标 y 向上：方向 (dx,dy) 的右法线 = (dy,-dx)，即顺时针转 90°）
    // bulge = 需求里暴露的「偏移距离」= 曲线中点离直线的垂直距离；
    // 二次贝塞尔在 t=0.5 只走到控制点偏移的一半，故控制点要乘 2。
    const bulge = opts && typeof opts.curveOffset === 'number' ? opts.curveOffset : 0;
    const curveOffset = bulge * 2;
    const dx = toLocal.x - fromLocal.x;
    const dy = toLocal.y - fromLocal.y;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const nx = dy / len;
    const ny = -dx / len;
    const ctrlX = (fromLocal.x + toLocal.x) * 0.5 + nx * curveOffset;
    const ctrlY = (fromLocal.y + toLocal.y) * 0.5 + ny * curveOffset;

    // 加色材质：每次播放新建一份（intensity 可独立），结束时 destroy
    const mat = additive ? new Material() : null;
    if (mat) {
        mat.initialize({ effectAsset: eff });
        mat.setProperty('intensity', intensity);
    }

    const fx = new Node(FOLLOWER_ATTACK_FX_NODE);
    fx.setParent(host);
    fx.setSiblingIndex(host.children.length - 1);      // 画在最上层
    if (!fx.getComponent(UITransform)) fx.addComponent(UITransform);

    const sprites: Sprite[] = [];
    const colors: Color[] = [];
    for (let i = 0; i < LAYERS.length; i++) {
        const cfg = LAYERS[i];
        const n = new Node('Orb_' + i);
        n.setParent(fx);
        const tn = n.addComponent(UITransform);
        const sp = n.addComponent(Sprite);
        sp.sizeMode = Sprite.SizeMode.CUSTOM;          // 🔴 默认 TRIMMED 会改写 contentSize
        sp.spriteFrame = _sfs[cfg.tex];
        if (mat) sp.customMaterial = mat;
        const c = new Color(tint);
        c.a = 0;
        sp.color = c;
        tn.setContentSize(size * cfg.scale, size * cfg.scale);
        sprites.push(sp);
        colors.push(c);
    }

    let disposed = false;
    const handle: FollowerAttackOrbHandle = {
        setProgress(p: number): void {
            if (disposed || !fx.isValid) return;
            const t = Math.max(0, Math.min(1, p));
            // 位置：二次贝塞尔 from → ctrl → to（t=1 时**恰好**落在目标中心，与旋转同步收尾）
            const u = 1 - t;
            const w0 = u * u;          // from 权重
            const w1 = 2 * u * t;      // ctrl 权重
            const w2 = t * t;          // to 权重
            fx.setPosition(
                w0 * fromLocal.x + w1 * ctrlX + w2 * toLocal.x,
                w0 * fromLocal.y + w1 * ctrlY + w2 * toLocal.y,
                0,
            );
            const baseScale = 0.42 + 0.58 * smoothstep(0, 0.25, t);   // 起步小、快速涨满
            const alpha = travelAlpha(t);
            for (let i = 0; i < sprites.length; i++) {
                const cfg = LAYERS[i];
                const sp = sprites[i];
                if (!sp || !sp.isValid) continue;
                sp.node.setRotationFromEuler(0, 0, cfg.spin * t);      // 自转 → 能量弧缠绕感
                // 最外层在末段再放大一点 = 抵达时的「冲击」观感
                const pop = i === LAYERS.length - 1 ? 1 + 0.6 * smoothstep(0.82, 1, t) : 1;
                const s = baseScale * pop;
                const tn = sp.node.getComponent(UITransform);
                if (tn) tn.setContentSize(size * cfg.scale * s, size * cfg.scale * s);
                const c = colors[i];
                c.a = Math.round(255 * Math.max(0, Math.min(1, alpha * cfg.peak)));
                sp.color = c;
            }
        },
        dispose(): void {
            if (disposed) return;
            disposed = true;
            if (fx.isValid) killNode(fx);
            if (mat && mat.isValid) mat.destroy();
        },
    };
    handle.setProgress(0);   // 立刻摆到发起方中心（否则第 1 帧停在层原点）
    return handle;
}

// ============================================================================
// 时间轴包络（p ∈ [0,1]）
// ============================================================================
/** 平滑阶跃 smoothstep */
function smoothstep(a: number, b: number, x: number): number {
    const t = Math.max(0, Math.min(1, (b - a) === 0 ? (x >= b ? 1 : 0) : (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
}

/** 整体透明度：前 10% 淡入，最后 10% 淡出（p=1 时归零 = 抵达即结束） */
function travelAlpha(t: number): number {
    return smoothstep(0, 0.10, t) * (1 - smoothstep(0.90, 1.0, t));
}

