import {
    _decorator, Color, Component, EffectAsset, Material, Node, resources, Sprite, SpriteFrame, UITransform, Vec3,
} from 'cc';
import { killNode, releaseChildren } from './CardComposer';

const { ccclass, property, menu } = _decorator;

/**
 * ShieldAuraFx —— 「守护」随从的护盾特效
 * ===========================================================================
 * 参考示例图：卡牌外圈一枚**发光的盾形轮廓**（青绿主色 + 暖金描边），边缘带光晕、缓慢呼吸。
 *
 * 实现（全部运行时构建，不依赖场景序列化）：
 *   · 素材 `assets/resources/effects/Shield/AngelShieldEffect_01.png`（白色盾形轮廓 + alpha）
 *     → 必须先在 resources 下且是 spriteFrame（子资源路径带 `/spriteFrame`）。
 *   · 加色（ADD）混合：复用共享 effect `SummonOrbAdd`（blendSrc src_alpha / blendDst one）。
 *   · 三层同心叠加做「光晕」：外层暖金柔光 + 中层青绿光 + 内层亮芯（贴图本身是细轮廓，
 *     多层不同尺寸/透明度即可得到发光的厚度感）。
 *   · 呼吸动画用 `update(dt)` 里的正弦（不用补间：常驻特效不必承担补间生命周期风险）。
 *
 * 🔑 外观参数（大小 / 位置 / 配色 / 光强 / 呼吸）由 **CardKeywordSystem 上的 @property** 提供，
 *    经 `ensureShieldAura(card, config)` 下发 —— 这样在 Cocos Inspector 里就能直接调，
 *    不必往场景里挂一个每张卡各一份的组件。
 */

/** 护盾子节点名（运行时挂在卡牌下） */
export const SHIELD_AURA_NODE = 'ShieldAura';

/** 护盾贴图在 resources 下的路径（**子资源要带 `/spriteFrame`**） */
export const SHIELD_TEX_RES_PATH = 'effects/Shield/AngelShieldEffect_01/spriteFrame';

/** 复用召唤光球的加色 effect */
const EFFECT_NAME = 'SummonOrbAdd';
const EFFECT_RES_PATH = 'effects/SummonOrbAdd';

/** 护盾外观配置（由 CardKeywordSystem 的 Inspector 属性组装） */
export interface ShieldAuraConfig {
    /** 护盾基础高度 = 卡牌显示高度 × 本值 */
    shieldScale?: number;
    /** X 偏移（按卡宽比例；正 = 右移） */
    offsetX?: number;
    /** Y 偏移（按卡高比例；正 = 上移） */
    offsetY?: number;
    /** 护盾主色（青绿） */
    color?: Color;
    /** 外圈柔光色（暖金） */
    glowColor?: Color;
    /** 加色亮度倍数 */
    intensity?: number;
    /** 呼吸周期（秒） */
    pulsePeriod?: number;
    /** 呼吸幅度（相对比例） */
    pulseAmount?: number;
    /** 呼吸最暗时的透明度比例 */
    minPulse?: number;
    /** 外层柔光的相对尺寸 */
    outerScale?: number;
    /** 中层光环的相对尺寸 */
    midScale?: number;
}

// ============================================================================
// 模块级资源缓存（所有守护随从共用 1 份 effect + 1 张贴图）
// ============================================================================
let _sf: SpriteFrame | null = null;
let _effect: EffectAsset | null = null;
let _loadingSf = false;
let _loadingEffect = false;
let _warned = false;

export function shieldAssetsReady(): boolean {
    return !!_sf && _sf.isValid && !!_effect && _effect.isValid;
}

/** 预加载护盾素材（幂等；建议在 CardKeywordSystem.onLoad 调一次） */
export function preloadShieldAssets(): void {
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
    if (_sf && _sf.isValid) return;
    if (_loadingSf) return;
    _loadingSf = true;
    resources.load(SHIELD_TEX_RES_PATH, SpriteFrame, (err, sf) => {
        _loadingSf = false;
        if (err || !sf) warn(`加载护盾贴图失败："${SHIELD_TEX_RES_PATH}"`, err);
        else _sf = sf;
    });
}

function warn(msg: string, err: unknown): void {
    if (_warned) return;
    _warned = true;
    console.warn('[ShieldAuraFx] ' + msg + ' →', err);
}

// ============================================================================
// 对外 API
// ============================================================================
/**
 * 给卡牌挂上 / 刷新「守护」护盾特效。资源未就绪时静默返回（调用方可按扫描周期重试）。
 * @param config 外观配置（CardKeywordSystem 的 Inspector 属性组装而来）
 * @returns 是否已挂上（false = 资源没到 / 卡牌非法）
 */
export function ensureShieldAura(card: Node | null, config?: ShieldAuraConfig): boolean {
    if (!card || !card.isValid) return false;
    preloadShieldAssets();
    if (!shieldAssetsReady()) return false;

    let node = card.getChildByName(SHIELD_AURA_NODE);
    if (!node || !node.isValid) {
        node = new Node(SHIELD_AURA_NODE);
        node.setParent(card);
        node.addComponent(UITransform);
        node.addComponent(ShieldAuraFx);
    }
    const fx = node.getComponent(ShieldAuraFx);
    if (!fx) return false;
    if (config) fx.applyConfig(config);
    fx.refresh();
    return true;
}

/** 移除卡牌上的护盾特效（没有则无害）。 */
export function removeShieldAura(card: Node | null): void {
    if (!card || !card.isValid) return;
    const node = card.getChildByName(SHIELD_AURA_NODE);
    if (node) killNode(node);
}

/** 该卡当前是否挂着护盾特效。 */
export function hasShieldAura(card: Node | null): boolean {
    return !!card && card.isValid && !!card.getChildByName(SHIELD_AURA_NODE);
}

// ============================================================================
// 组件：构建三层护盾 + 呼吸动画
// ============================================================================
interface ShieldLayer {
    sp: Sprite;
    /** 相对基础尺寸的缩放 */
    k: number;
    /** 峰值透明度 */
    peak: number;
    color: Color;
}

@ccclass('ShieldAuraFx')
@menu('gf2szb/ShieldAuraFx')
export class ShieldAuraFx extends Component {

    // —— 下列字段是「本实例当前生效值」；真正在 Inspector 调的是 CardKeywordSystem 上的同名属性 ——
    shieldScale = 1.26;
    offsetX = 0;
    offsetY = 0;
    shieldColor = new Color(150, 255, 96, 255);
    glowColor = new Color(255, 226, 138, 255);
    intensity = 0.85;
    pulsePeriod = 2.4;
    pulseAmount = 0.06;
    minPulse = 0.55;
    outerScale = 1.16;
    midScale = 1.06;

    private _layers: ShieldLayer[] = [];
    private _mat: Material | null = null;
    private _baseW = 0;
    private _baseH = 0;
    private _t = 0;
    private _built = false;
    /** 需要重建的静态参数签名（配色 / 光强 / 层尺寸） */
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

    /** 下发 Inspector 配置（变化时才触发重建）。 */
    public applyConfig(cfg: ShieldAuraConfig): void {
        if (typeof cfg.shieldScale === 'number') this.shieldScale = cfg.shieldScale;
        if (typeof cfg.offsetX === 'number') this.offsetX = cfg.offsetX;
        if (typeof cfg.offsetY === 'number') this.offsetY = cfg.offsetY;
        if (cfg.color) this.shieldColor = new Color(cfg.color);
        if (cfg.glowColor) this.glowColor = new Color(cfg.glowColor);
        if (typeof cfg.intensity === 'number') this.intensity = cfg.intensity;
        if (typeof cfg.pulsePeriod === 'number') this.pulsePeriod = cfg.pulsePeriod;
        if (typeof cfg.pulseAmount === 'number') this.pulseAmount = cfg.pulseAmount;
        if (typeof cfg.minPulse === 'number') this.minPulse = cfg.minPulse;
        if (typeof cfg.outerScale === 'number') this.outerScale = cfg.outerScale;
        if (typeof cfg.midScale === 'number') this.midScale = cfg.midScale;
    }

    /** 依据宿主卡牌尺寸重建/刷新护盾（尺寸或配置变化时重建）。 */
    public refresh(): void {
        const host = this.node.parent;
        if (!host || !host.isValid) return;
        if (!shieldAssetsReady()) { preloadShieldAssets(); return; }

        const hut = host.getComponent(UITransform);
        const cw = hut ? hut.contentSize.width : 204;
        const ch = hut ? hut.contentSize.height : 252;

        const sf = _sf as SpriteFrame;
        const rect = sf.rect;
        const aspect = rect.height > 0 ? rect.width / rect.height : 0.89;

        const baseH = Math.max(40, ch * this.shieldScale);
        const baseW = baseH * aspect;

        const sig = [
            this.intensity, this.outerScale, this.midScale,
            this.shieldColor.r, this.shieldColor.g, this.shieldColor.b,
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
        this.build(sf);
    }

    // ------------------------------ 内部 ------------------------------
    private build(sf: SpriteFrame): void {
        this.teardown();
        this._built = true;

        const eff = _effect as EffectAsset;
        const mat = new Material();
        mat.initialize({ effectAsset: eff });
        mat.setProperty('intensity', this.intensity);
        this._mat = mat;

        // 由外到内：暖金柔光 → 青绿光 → 亮芯
        const defs: { k: number; peak: number; color: Color }[] = [
            { k: this.outerScale, peak: 0.30, color: new Color(this.glowColor) },
            { k: this.midScale, peak: 0.55, color: new Color(this.shieldColor) },
            { k: 1.00, peak: 1.00, color: new Color(
                Math.round(this.shieldColor.r + (255 - this.shieldColor.r) * 0.55),
                Math.round(this.shieldColor.g + (255 - this.shieldColor.g) * 0.55),
                Math.round(this.shieldColor.b + (255 - this.shieldColor.b) * 0.55),
                255,
            ) },
        ];

        for (let i = 0; i < defs.length; i++) {
            const d = defs[i];
            const n = new Node('Shield_' + i);
            n.setParent(this.node);
            const tn = n.addComponent(UITransform);
            const sp = n.addComponent(Sprite);
            sp.sizeMode = Sprite.SizeMode.CUSTOM;   // 🔴 默认 TRIMMED 会改写 contentSize
            sp.spriteFrame = sf;
            sp.customMaterial = mat;
            const c = new Color(d.color);
            c.a = 0;
            sp.color = c;
            tn.setContentSize(this._baseW * d.k, this._baseH * d.k);
            this._layers.push({ sp, k: d.k, peak: d.peak, color: new Color(d.color) });
        }
        this.applyStatic();
        this.update(0);
    }

    /** 位置 / 层级：以卡牌可视中心为基准（可带 X/Y 偏移），插在 CardHp 之前 → 属性数字仍压在护盾之上。 */
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
        const period = Math.max(0.1, this.pulsePeriod);
        const s = 0.5 + 0.5 * Math.sin((this._t / period) * Math.PI * 2);   // 0..1
        const a = this.minPulse + (1 - this.minPulse) * s;
        const sc = 1 + this.pulseAmount * (s - 0.5) * 2;
        for (const L of this._layers) {
            if (!L.sp || !L.sp.isValid) continue;
            const c = L.color;
            L.sp.color = new Color(c.r, c.g, c.b, Math.round(255 * L.peak * a));
            const tn = L.sp.node.getComponent(UITransform);
            if (tn) tn.setContentSize(this._baseW * L.k * sc, this._baseH * L.k * sc);
        }
    }
}
