import {
    _decorator, Color, Component, EffectAsset, Material, Node, resources, Sprite, SpriteFrame,
    Tween, tween, UITransform, Vec3,
} from 'cc';
import { killNode } from './CardComposer';
import {
    applyWhiteFlash as applyWhiteFlashShared, preloadWhiteFlashEffect, releaseWhiteFlash as releaseWhiteFlashShared,
    resolveWhiteFlashEffect, setWhiteFlash, WhiteFlashTarget,
} from './CardWhiteFlashFx';

const { ccclass, property, menu } = _decorator;

/** 运行时生成的破坏特效节点名（每次播放一个，播完自行销毁） */
export const CARD_DESTROY_FX_NAME = 'CardDestroyFx';

/** 迸发（flare）素材在 resources 下的路径（必须带 /spriteFrame 后缀） */
const FLARE_RES_PATH = 'effects/CardDestroy/flare_0/spriteFrame';
/** 加色混合可复用的效果（与召唤光球共用：白贴图 × alpha 加到画面 = 发光） */
const ADD_EFFECT_NAME = 'SummonOrbAdd';
const ADD_EFFECT_RES_PATH = 'effects/SummonOrbAdd';

/**
 * CardDestroyFx —— 卡牌「破坏」特效：**卡牌整体发亮白光 → 由里向外迸发 → 卡牌消失**
 * ===========================================================================
 * 触发时机：战场卡牌被破坏、以及「手牌已满仍继续抽出的牌」在展示后被破坏时，
 *           调用 `playOnCard(card)` 在该卡位置播放。
 *
 * 演出时间轴（单条数值补间驱动进度 p，0→1，只有一次完成回调）：
 *   [0, flashPortion)        卡牌**自身**的子 Sprite/Label 逐渐洗白
 *                            （保留各自的 alpha 轮廓 ⇒ 白光贴合卡牌实际显示形状，
 *                             卡框圆角/雕花边都跟得上，**不是**一个平直长方形）。
 *   p 跨过 flashPortion 那一刻 卡牌节点被销毁（消失），迸发（flare）同时触发。
 *   [flashPortion, 1]        流光由里向外四周扩散：内核层 + 外圈层两层 flare，
 *                            缩放 scaleFrom→scaleTo（easeOut）、透明度峰值→0。
 *
 * 挂载：Canvas 下的常驻节点 `CardDestroyFx`（尺寸 1280×720、锚点 0.5/0.5）。
 *   调用方只给卡牌节点，组件自己换算世界坐标 / 显示尺寸。
 *
 * 调参变量（全部 Inspector 暴露）：
 *   flareFrame                迸发素材（留空自动从 resources/effects/CardDestroy/flare_0 加载）
 *   flashEffect               洗白 effect（留空自动从 resources/effects/CardWhiteFlash 加载）
 *   flashColor                「整体发亮白光」的颜色（默认纯白；可换成金/青等品质色）
 *   color                     迸发特效的着色
 *   duration                  整段时长（秒）
 *   flashPortion              「发亮白光」占的时长比例（其余为迸发）
 *   burstAlpha / burstSizeK   迸发峰值不透明度 / 基础尺寸倍数（基准=卡牌显示长边）
 *   burstScaleFrom / burstScaleTo  迸发起止缩放（越大越向外扩散）
 *   burstRotate               迸发起始旋转角（度）
 *   coreScaleK / coreAlphaK   内核层相对外圈的结束缩放 / 亮度倍数
 *   offset                    特效爆发中心相对卡牌中心的偏移（宿主本地像素）
 *   additive / intensity      迸发是否加色发光 / 加色亮度倍数
 *   destroyCard               是否由特效在「迸发」瞬间销毁卡牌节点（默认开）
 * ===========================================================================
 */
@ccclass('CardDestroyFx')
@menu('gf2szb/CardDestroyFx')
export class CardDestroyFx extends Component {

    /** 场景里唯一的实例（调用方通过它播放；未挂载时为 null → 调用方自行兜底） */
    private static _inst: CardDestroyFx | null = null;
    public static get instance(): CardDestroyFx | null {
        return (CardDestroyFx._inst && CardDestroyFx._inst.isValid) ? CardDestroyFx._inst : null;
    }

    // ====================== 素材 ======================
    @property({
        type: SpriteFrame,
        tooltip: '迸发（flare）贴图。留空 → 自动从 resources/effects/CardDestroy/flare_0 加载。',
    })
    flareFrame: SpriteFrame | null = null;

    @property({
        type: EffectAsset,
        tooltip: '「整体发亮白光」的洗白 effect。留空 → 自动从 resources/effects/CardWhiteFlash 加载。',
    })
    flashEffect: EffectAsset | null = null;

    // ====================== 颜色 ======================
    @property({
        type: Color,
        tooltip: '「整体发亮白光」的颜色（默认纯白；可换成金/青/紫等做品质色）。',
    })
    flashColor = new Color(255, 255, 255, 255);

    @property({
        type: Color,
        tooltip: '迸发特效的着色。',
    })
    color = new Color(255, 246, 224, 255);

    // ====================== 时间 ======================
    @property({ range: [0.05, 3, 0.01], slide: true, tooltip: '整段时长（秒）：发亮白光 → 迸发 → 消失。' })
    duration = 0.5;

    @property({
        range: [0.05, 0.95, 0.01], slide: true,
        tooltip: '「卡牌整体发亮白光」占的时长比例（0~1）。\n到这一刻卡牌消失、迸发同时触发；其余时间用于迸发扩散。',
    })
    flashPortion = 0.32;

    // ====================== 迸发 ======================
    @property({ range: [0, 255, 1], slide: true, tooltip: '迸发特效峰值不透明度。' })
    burstAlpha = 255;

    @property({ range: [0, 8, 0.01], slide: true, tooltip: '迸发基础尺寸 = 卡牌显示长边 × 该值。\n'
        + '🔴 不要开大：flare 贴图的**亮核**只占贴图宽度约 35%，开太大（>1.8）亮核会盖满整张卡 → 看起来是一团实心白光而不是「光芒」。' })
    burstSizeK = 1.45;

    @property({ range: [0, 4, 0.01], slide: true, tooltip: '迸发起始缩放（相对基础尺寸）。' })
    burstScaleFrom = 0.35;

    @property({ range: [0, 8, 0.01], slide: true, tooltip: '迸发结束缩放（相对基础尺寸，越大向外扩散越远）。' })
    burstScaleTo = 1.55;

    @property({ range: [-720, 720, 1], slide: true, tooltip: '迸发起始旋转角（度）。' })
    burstRotate = 0;

    @property({ range: [0, 2, 0.01], slide: true, tooltip: '内核层相对外圈的结束缩放（<1 = 内核更小、与外圈形成「由里向外」层次）。\n'
        + '🔴 内核与外圈是**同一张贴图**，两层都开大只是把同一份柔光叠两遍 → 糊成一团。内核准得明显更小（≤0.45）才有「由里向外」的层次。' })
    coreScaleK = 0.40;

    @property({ range: [0, 3, 0.01], slide: true, tooltip: '内核层相对外圈的亮度倍数。' })
    coreAlphaK = 0.50;

    // ====================== 位置 ======================
    @property({ type: Vec3, tooltip: '特效爆发中心相对卡牌中心的偏移（宿主节点本地像素，如 (0, 20, 0) 向上偏）。' })
    offset = new Vec3(0, 0, 0);

    // ====================== 混合 ======================
    @property({ tooltip: '迸发是否用**加色（ADD）**混合（发光感）。关闭 = 普通 alpha 混合。' })
    additive = true;

    @property({ range: [0, 4, 0.01], slide: true, tooltip: '加色亮度倍数（仅 additive=true 生效）。\n'
        + 'flare 贴图除亮核外都是低 alpha 的射线/柔光，适度 >1（1.1~1.3）能把射线提起来；再高就会让亮核过曝成一片白。' })
    intensity = 1.2;

    // ====================== 行为 ======================
    @property({ tooltip: '是否由特效在「迸发」瞬间销毁卡牌节点。\n关闭则卡牌保留（由调用方自己销毁）。' })
    destroyCard = true;

    // ------------------------------ 内部状态 ------------------------------
    private _flare: SpriteFrame | null = null;
    private _loading = false;
    private _warned = false;
    private _addEffect: EffectAsset | null = null;
    private _loadingEffect = false;

    onLoad(): void {
        CardDestroyFx._inst = this;
        this.preload();
    }

    onDestroy(): void {
        if (CardDestroyFx._inst === this) CardDestroyFx._inst = null;
    }

    /** 预加载素材（幂等） */
    public preload(): void {
        if (!this._loading && !this.flareFrame && !this._flare) {
            this._loading = true;
            resources.load(FLARE_RES_PATH, SpriteFrame, (err, sf) => {
                this._loading = false;
                if (err || !sf) { this.warnOnce(`加载迸发贴图失败："${FLARE_RES_PATH}"`, err); return; }
                this._flare = sf;
            });
        }
        this.ensureAddEffect();
        preloadWhiteFlashEffect();
    }

    private warnOnce(msg: string, err: unknown): void {
        if (this._warned) return;
        this._warned = true;
        console.warn(`[CardDestroyFx] ${msg} →`, err);
    }

    private ensureAddEffect(): EffectAsset | null {
        if (this._addEffect && this._addEffect.isValid) return this._addEffect;
        const byName = EffectAsset.get(ADD_EFFECT_NAME);
        if (byName) { this._addEffect = byName; return byName; }
        if (!this._loadingEffect) {
            this._loadingEffect = true;
            resources.load(ADD_EFFECT_RES_PATH, EffectAsset, (err, asset) => {
                this._loadingEffect = false;
                if (err || !asset) { this.warnOnce(`加载加色效果失败："${ADD_EFFECT_RES_PATH}"`, err); return; }
                this._addEffect = asset;
            });
        }
        return null;
    }

    private activeFlare(): SpriteFrame | null {
        if (this.flareFrame && this.flareFrame.isValid) return this.flareFrame;
        return (this._flare && this._flare.isValid) ? this._flare : null;
    }

    /**
     * **在卡牌处播放一次破坏特效**（推荐入口）：卡牌自身发亮白光 → 迸发 → 消失。
     * @param card       被破坏的卡牌节点
     * @param onComplete 演出全部结束后的回调（卡牌已销毁）；可省略
     */
    public playOnCard(card: Node, onComplete?: () => void, opts?: { reverse?: boolean }): void {
        if (!card || !card.isValid) { if (onComplete) safeCall(onComplete); return; }
        let w = 0, h = 0;
        try {
            const ut = card.getComponent(UITransform);
            if (ut) {
                const ws = card.worldScale;
                w = Math.abs(ut.contentSize.width * ws.x);
                h = Math.abs(ut.contentSize.height * ws.y);
            }
        } catch (e) { /* 读取失败按 0 处理 */ }
        const longEdge = Math.max(w, h, 1);
        // 停掉卡牌上可能跑着的位置/缩放补间，避免发光期间卡牌被别的动画带走
        try { Tween.stopAllByTarget(card); } catch (e) { /* 忽略 */ }
        const flashEffect = resolveWhiteFlashEffect(this.flashEffect);
        const flashTargets = flashEffect ? applyWhiteFlashShared(card, flashEffect, this.flashColor) : [];
        this.playInternal(card.worldPosition, longEdge, card, flashTargets, onComplete, opts && opts.reverse === true);
    }

    /**
     * 兼容入口：只在**世界坐标 worldPos** 处播一次迸发，不涉及卡牌节点。
     * @param worldPos 锚点世界坐标
     * @param size     卡牌显示长边（已含缩放）；<=0 时回退 220
     */
    public play(worldPos: Vec3, size: number, onComplete?: () => void, opts?: { reverse?: boolean }): void {
        const edge = Math.max(40, size > 0 ? size : 220);
        this.playInternal(worldPos, edge, null, [], onComplete, opts && opts.reverse === true);
    }

    private playInternal(
        worldPos: Vec3, longEdge: number, card: Node | null, flashTargets: WhiteFlashTarget[],
        onComplete?: () => void, reverse = false,
    ): void {
        const flare = this.activeFlare();
        if (!flare) {
            // 资源未就绪：补一次预加载；但**不能让演出卡住** —— 该销毁卡牌就销毁，该回调就回调。
            this.preload();
            if (card && this.destroyCard) { try { if (card.isValid) killNode(card); } catch (e) { /* 忽略 */ } }
            releaseWhiteFlashShared(flashTargets);
            if (onComplete) safeCall(onComplete);
            return;
        }

        const hostUT = this.node.getComponent(UITransform);
        const local = hostUT ? hostUT.convertToNodeSpaceAR(worldPos, _localScratch) : _localScratch.set(worldPos);
        const px = local.x + this.offset.x;
        const py = local.y + this.offset.y;
        const base = Math.max(1, longEdge) * Math.max(0.01, this.burstSizeK);

        // 加色时才建材质（每段特效独立，结束销毁）；两层 sprite 共用同一份材质实例即可
        let mat: Material | null = null;
        if (this.additive) {
            const eff = this.ensureAddEffect();
            if (eff) {
                mat = new Material();
                mat.initialize({ effectAsset: eff });
                mat.setProperty('intensity', Math.max(0, this.intensity));
            }
        }

        const fx = new Node(CARD_DESTROY_FX_NAME);
        fx.setParent(this.node);
        if (fx.parent) fx.setSiblingIndex(fx.parent.children.length - 1);   // 画在最上层
        const ut = fx.addComponent(UITransform);
        ut.setAnchorPoint(0.5, 0.5);
        ut.setContentSize(base, base);
        fx.setPosition(px, py, 0);

        // ---- 外圈层 ----
        const outer = this.makeSprite(fx, flare, base, base, mat);
        outer.node.setRotationFromEuler(0, 0, this.burstRotate);
        const outerCol = new Color(this.color);
        outerCol.a = 0;
        outer.color = outerCol;

        // ---- 内核层（同一张贴图，更小更亮）----
        const core = this.makeSprite(fx, flare, base, base, mat);
        core.node.setRotationFromEuler(0, 0, this.burstRotate);
        const coreCol = new Color(this.color);
        coreCol.a = 0;
        core.color = coreCol;

        const dur = Math.max(0.01, this.duration);
        const fp = Math.max(0.02, Math.min(0.95, this.flashPortion));
        const bAlpha = Math.max(0, Math.min(255, this.burstAlpha));
        const cAlpha = Math.max(0, Math.min(255, this.burstAlpha * Math.max(0, this.coreAlphaK)));
        // ★ `reverse`（「消失」用）：把迸发的起止缩放**对调** —— 破坏是光**往外扩**，
        //   消失是光**向内收**（需求）。内核层的层次关系保持不变。
        const sFrom = Math.max(0, reverse ? this.burstScaleTo : this.burstScaleFrom);
        const sTo = Math.max(0, reverse ? this.burstScaleFrom : this.burstScaleTo);
        const sCoreTo = sTo * Math.max(0, this.coreScaleK);

        const state = { p: 0 };
        let done = false;
        let cardKilled = false;
        const killCardOnce = () => {
            if (cardKilled) return;
            cardKilled = true;
            if (card && this.destroyCard) { try { if (card.isValid) killNode(card); } catch (e) { /* 忽略 */ } }
        };
        const cleanup = () => {
            if (done) return;
            done = true;
            try { Tween.stopAllByTarget(state); } catch (e) { /* 忽略 */ }
            if (fx.isValid) killNode(fx);
            if (mat && mat.isValid) mat.destroy();
            releaseWhiteFlashShared(flashTargets);
        };
        const fail = (e: unknown) => {
            console.error('[CardDestroyFx] 播放破坏特效出错：', e);
            killCardOnce();
            cleanup();
            if (onComplete) safeCall(onComplete);
        };

        try {
            tween(state)
                .to(dur, { p: 1 }, {
                    easing: 'linear',
                    onUpdate: () => {
                        if (done) return;
                        try {
                            const p = state.p;
                            if (p < fp) {
                                // 发亮白光阶段：卡牌自身逐渐洗白（保留各自 alpha 轮廓），卡牌尚未消失
                                setWhiteFlash(flashTargets, fp > 0 ? (p / fp) : 1);
                            } else {
                                // 迸发阶段：卡牌消失，流光由里向外扩散
                                setWhiteFlash(flashTargets, 1);
                                killCardOnce();
                                const t = Math.max(0, Math.min(1, (p - fp) / (1 - fp)));
                                const e = 1 - (1 - t) * (1 - t);          // easeOutQuad：扩散先快后慢
                                // 🔑 亮度用 (1-t)^1.35 而不是线性：flare 贴图外层有一圈很宽的柔光，
                                //    线性淡出会让这圈柔光在中后段还留一大片 → 观感是「一大团实心白光」。
                                //    指数略大于 1 → 前段够亮够脆、后段迅速收干净，只留下清晰的光芒。
                                const fade = Math.pow(1 - t, 1.35);
                                // 外圈：向外扩散 + 淡出
                                const so = sFrom + (sTo - sFrom) * e;
                                outer.node.setScale(so, so, 1);
                                outerCol.a = Math.round(bAlpha * fade);
                                outer.color = outerCol;
                                // 内核：更小更亮
                                const sc = sFrom + (sCoreTo - sFrom) * e;
                                core.node.setScale(sc, sc, 1);
                                coreCol.a = Math.round(cAlpha * fade);
                                core.color = coreCol;
                            }
                        } catch (err) { fail(err); }
                    },
                })
                .call(() => {
                    if (done) return;
                    killCardOnce();
                    cleanup();
                    if (onComplete) safeCall(onComplete);
                })
                .start();
        } catch (e) {
            fail(e);
        }
    }

    /** 生成一个 CUSTOM 尺寸的 Sprite 子节点（🔴 默认 TRIMMED 会改写 contentSize） */
    private makeSprite(parent: Node, sf: SpriteFrame, w: number, h: number, mat: Material | null): Sprite {
        const n = new Node('FxLayer');
        n.setParent(parent);
        const ut = n.addComponent(UITransform);
        ut.setAnchorPoint(0.5, 0.5);
        ut.setContentSize(w, h);
        const sp = n.addComponent(Sprite);
        sp.sizeMode = Sprite.SizeMode.CUSTOM;
        sp.type = Sprite.Type.SIMPLE;
        sp.trim = true;
        sp.spriteFrame = sf;
        if (mat) sp.customMaterial = mat;
        return sp;
    }
}

/** 世界坐标缓存（同步使用，安全） */
const _localScratch = new Vec3();

function safeCall(fn: () => void): void {
    try { fn(); } catch (e) { console.error('[CardDestroyFx] 完成回调出错：', e); }
}

/**
 * 取一个节点的**世界坐标**与**显示长边**（contentSize × worldScale 的长边），
 * 在该位置播放破坏特效（会连带销毁该节点）。
 * 未挂载特效宿主时返回 false —— 调用方可自行兜底。
 */
export function playCardDestroyFxForNode(node: Node | null | undefined, onComplete?: () => void): boolean {
    const fx = CardDestroyFx.instance;
    if (!fx) { if (onComplete) safeCall(onComplete); return false; }
    if (!node || !node.isValid) { if (onComplete) safeCall(onComplete); return true; }
    fx.playOnCard(node, onComplete);
    return true;
}
