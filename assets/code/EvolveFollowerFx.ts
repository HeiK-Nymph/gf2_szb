import { BarrierFx } from './BarrierFx';
import {
    _decorator, Canvas, Color, Component, Label, LabelOutline, Material, Node,
    Sprite, SpriteFrame, Tween, tween, UITransform, Vec3,
} from 'cc';
import {
    getSummonOrbEffect, getSummonOrbSpriteFrames, orbAlphaAt, orbScaleAt, orbTimelineEnd,
    preloadSummonOrbAssets, SUMMON_ORB_LAYERS,
} from './CardSummonOrbFx';
import {
    applyWhiteFlash, preloadWhiteFlashEffect, releaseWhiteFlash, resolveWhiteFlashEffect, setWhiteFlash,
    WhiteFlashTarget,
} from './CardWhiteFlashFx';

const { ccclass, property, menu } = _decorator;

/** 进化光球特效子节点名（每次播放运行时创建、旋转结束销毁） */
export const EVOLVE_LIGHT_ORB_FX_NAME = 'EvolveLightOrbFx';

/**
 * EvolveFollowerFx —— 随从进化 / 超进化的卡牌动画 + 亮白色进化光球
 * ===========================================================================
 * 挂在 `Canvas/EvolveFollowerFx`（宿主只当特效容器 + 组件宿主，自身不渲染）。
 *
 * 动画时序（由 `EvoDragController.doEvolve` 在结算完成后调用 `play`）：
 *   ① 卡牌从战场原位飞到**屏幕正中并放大到「我方抽卡展示」的同款大小**（到位后停顿
 *      `holdDuration` 秒展示）—— 移动与旋转**分开**，不在飞行中转圈；
 *   ② 原地 Rotation.Y 转 `spins` 圈，旋转分**前段 / 尾段**两段时长：
 *      · 前段 `spinLeadDuration`：0° → revealAt（默认 630°）——**光团收缩**阶段，
 *        光球从四周（`evolveOrbShrinkRange` 的最大范围）向卡牌收拢，终点尺寸/透明度
 *        与迸发时间轴 p=0 完全一致 ⇒ 衔接无跳变；
 *      · 尾段 `spinTailDuration`：revealAt → 720° —— **光团迸发**开始的窗口；
 *      · **卡牌自身洗白**（参照战场破坏特效 `CardDestroyFx` 的逐层洗白）——旋转开始就
 *        用 `whitenDuration` 秒 原色→全白，转到 `revealAt` 再用 `recoverDuration` 秒
 *        全白→原色 过渡恢复；
 *      · **Z 轴倾斜边转边过渡**：前段开头 `tiltInDuration` 秒 0→`spinTiltZ` 渐歪，
 *        尾段最后 `tiltOutDuration` 秒 `spinTiltZ`→0 渐正（旋转结束那一刻正好回正）；
 *   ③ 转过 `revealAt` 的那一刻：卡面显示进化后的攻击/血量数字 + **卡图左右反转** +
 *      超进化时卡名换成紫色样式；
 *   ④ 转完（720° ≡ 0°）卡牌**回正**，在屏幕正中间停留展示 `centerHoldDuration` 秒，
 *      之后才缩小飞回战场原位并还原兄弟序。**光团迸发延续到展示结束那一刻**才熄灭
 *      （迸发总时长 = `spinTailDuration` + `centerHoldDuration`）。战场排布全程不动。
 *
 * 进化光球 = **完全复用**「卡牌进战场」的 `CardSummonOrbFx` 素材与时间轴：
 *   · 贴图 `effects/LightOrb/light_01~03.png`（核心亮斑 / 空心冲击环 / 弥散柔光）
 *     与 `SummonOrbAdd.effect` 加色混合、图层配置 `SUMMON_ORB_LAYERS` 全部共享模块级缓存；
 *   · 前段（0→revealAt）光团从 `evolveOrbShrinkRange` 收缩，尾段（revealAt→旋转结束）
 *     时间轴按 `orbTimelineEnd()` 压缩进迸发窗口，整体染成**亮白色**（例图风格，核心再提白成纯白亮芯）。
 * 可在 Inspector 调整的进化光球变量：
 *   · `evolveOrbColor`        —— 颜色（默认亮白）；
 *   · `evolveOrbShrinkRange`  —— **收缩开始时的最大范围**（相对卡牌长边的倍数）；
 *   · `evolveOrbMaxRange`     —— 迸发扩大的最大范围（相对卡牌长边的倍数 = 最大弥散层直径）；
 *   · `evolveOrbCoreWhiten`   —— 核心层提白程度（1 = 纯白亮芯）；
 *   · `evolveOrbIntensity`    —— 加色亮度倍数。
 * 卡牌洗白 / 旋转分段 / 中央展示变量：
 *   · `whitenDuration`        —— 旋转开始后 原色→全白 的过渡时长；
 *   · `recoverDuration`       —— 到 revealAt 后 全白→原色 的过渡恢复时长；
 *   · `spinLeadDuration`      —— 旋转前段 0→revealAt 的时长（光团收缩段）；
 *   · `spinTailDuration`      —— 旋转尾段 revealAt→结束 的时长（光团迸发从这开始）；
 *   · `tiltInDuration`        —— 旋转前段开头 倾斜进入 的过渡时长；
 *   · `tiltOutDuration`       —— 旋转尾段末尾 倾斜回正 的过渡时长；
 *   · `centerHoldDuration`    —— 旋转结束回正后，在屏幕正中间展示的时长（光团到此刻才熄灭）。
 *
 * 🔴 数字延迟显示：`doEvolve` 里 `beginDeferredDisplay → addStats → endDeferredDisplay`
 *    拿快照传进来，630° 时 `applyDisplayBatch` 写回。
 * 🔴 转圈 / 位移共用**一条数值补间**（位置/旋转/缩放都在 onUpdate 里写）；
 *    动画中的卡被 `isAnimating` 锁住，`BattleFieldPressGlow.engage` 会拒绝按住它。
 * ===========================================================================
 */
@ccclass('EvolveFollowerFx')
@menu('gf2szb/EvolveFollowerFx')
export class EvolveFollowerFx extends Component {

    // ====================== 阶段一：飞到中央放大展示 ======================

    @property({ range: [0.1, 2, 0.05], slide: true, tooltip: '阶段①：飞到屏幕正中并放大的时长（秒）' })
    moveDuration = 0.45;

    @property({ range: [0, 3, 0.05], slide: true, tooltip: '阶段①结束后在中央**停留展示**的时长（秒）' })
    holdDuration = 0.2;

    @property({
        range: [0.5, 2, 0.01], slide: true,
        tooltip: '展示大小的额外系数（1 = 与**我方抽卡展示**完全同款大小：手牌完整态缩放 × 拖拽放大）',
    })
    showScaleMultiplier = 1;

    // ====================== 阶段二：原地转圈 ======================

    @property({ range: [0.2, 6, 0.05], slide: true, tooltip: '阶段②**前段**：从 0° 转到 revealAt（默认 630°）的时长（秒）——此期间光团从四周向卡牌收缩' })
    spinLeadDuration = 1.15;

    @property({ range: [0.05, 2, 0.05], slide: true, tooltip: '阶段②**尾段**：从 revealAt（默认 630°）转到结束（720°）的时长（秒）——同时就是**光团迸发**的时长' })
    spinTailDuration = 0.25;

    @property({ range: [1, 4, 0.5], slide: true, tooltip: '转圈圈数' })
    spins = 2;

    @property({ range: [0, 720, 5], slide: true, tooltip: '转到多少度时显示新数字 + 反转卡图 +（超进化）换名字样式' })
    revealAt = 630;

    @property({ range: [-30, 30, 1], slide: true, tooltip: '【转圈】卡牌的 **Z 轴倾斜角**（度；0 = 不倾斜）——进入/恢复都有过渡（见下两个时长）' })
    spinTiltZ = 8;

    @property({ range: [0, 2, 0.05], slide: true, tooltip: '【转圈·倾斜】前段开头从 0 渐歪到 spinTiltZ 的过渡时长（秒）；0 = 立即歪到位' })
    tiltInDuration = 0.4;

    @property({ range: [0, 2, 0.05], slide: true, tooltip: '【转圈·倾斜】尾段最后从 spinTiltZ 渐正回 0 的过渡时长（秒），旋转结束那一刻正好回正；0 = 保持倾斜到结束瞬间回正' })
    tiltOutDuration = 0.35;

    // ====================== 阶段三：飞回 ======================

    @property({ range: [0.1, 2, 0.05], slide: true, tooltip: '阶段③：缩小并飞回战场原位的时长（秒）' })
    backDuration = 0.45;

    // ====================== 进化光球（亮白色；完全复用「进战场光球」素材与时间轴） ======================

    @property({ type: Color, tooltip: '【进化光球】颜色（默认亮白，例图风格）——核心层会再按下方「提白」往纯白靠' })
    evolveOrbColor = new Color(236, 246, 255, 255);

    @property({ range: [0, 1, 0.05], slide: true, tooltip: '【进化光球】核心层提白程度：0=与颜色一致，1=纯白亮芯' })
    evolveOrbCoreWhiten = 0.9;

    @property({ range: [0.3, 4, 0.05], slide: true, tooltip: '【进化光球】扩大的最大范围：相对卡牌长边的倍数（= 最大弥散层直径）；调大更炸裂' })
    evolveOrbMaxRange = 1.9;

    @property({ range: [0.3, 6, 0.05], slide: true, tooltip: '【进化光球·收缩】收缩开始时的最大范围：相对卡牌长边的倍数（= 最大弥散层直径）；旋转前段光团从它收缩到迸发起点' })
    evolveOrbShrinkRange = 2.6;

    @property({ range: [0.1, 4, 0.05], slide: true, tooltip: '【进化光球】加色亮度倍数（>1 更亮更「过曝」）' })
    evolveOrbIntensity = 1.0;

    // ====================== 卡牌自身洗白（旋转期间；参照战场破坏特效） ======================

    @property({ range: [0.05, 2, 0.05], slide: true, tooltip: '【卡牌变白】旋转开始时 原色→全白 的过渡时长（秒）；不要一下子变白' })
    whitenDuration = 0.25;

    @property({ range: [0.05, 2, 0.05], slide: true, tooltip: '【卡牌变白】转到 revealAt（默认 630°）后 全白→原色 的过渡恢复时长（秒）' })
    recoverDuration = 0.3;

    // ====================== 旋转结束后的中央回正展示 ======================

    @property({ range: [0, 3, 0.05], slide: true, tooltip: '【中央展示】旋转结束、卡牌回正后在屏幕正中间停留展示的时长（秒），之后才飞回战场' })
    centerHoldDuration = 0.5;

    // ====================== 超进化名字样式 ======================

    @property({ type: Color, tooltip: '超进化随从**卡名字色**（亮紫白 —— 保证在名字框上清晰）' })
    superNameColor = new Color(238, 216, 255, 255);

    @property({ type: Color, tooltip: '超进化随从**卡名描边色**（深紫）' })
    superNameOutline = new Color(62, 22, 108, 240);

    @property({ tooltip: '打印动画日志' })
    verbose = true;

    // ====================== 内部 ======================
    private static readonly _animating = new WeakSet<Node>();
    /** 某张卡是否正在播进化动画（供战场按压门控，避免攻击抬起与进化位移互相踩踏） */
    public static isAnimating(card: Node | null): boolean {
        return !!card && card.isValid && EvolveFollowerFx._animating.has(card);
    }

    private _playing = false;
    /** 是否正在播动画 */
    public get isPlaying() { return this._playing; }

    /** 本次播放的洗白材质对（结束必须成对还原）与当前洗白程度 */
    private _flashTargets: WhiteFlashTarget[] | null = null;
    private _flashTween: { v: number } | null = null;
    private _flashValue = 0;
    /** 中央回正展示的等待补间（纯数值对象，需单独停） */
    private _holdState: { t: number } | null = null;
    /** 本次播放的「动画结束」回调（宿主销毁时兜底调用一次；见 play() 的 finish） */
    private _pendingComplete: (() => void) | null = null;

    /** 本次播放的进化光球节点 / 材质 / 三层 Sprite 与配色 */
    private _orbFx: Node | null = null;
    private _orbMat: Material | null = null;
    private _orbSprites: Sprite[] = [];
    private _orbColors: Color[] = [];

    // ------------------------------ 生命周期 ------------------------------
    onLoad(): void {
        // 与「卡牌进战场光球」共用同一份模块级缓存：这里只发起一次预加载，正式播放时直接取。
        preloadSummonOrbAssets();
        // 卡牌自身洗白（参照战场破坏特效）用的共享 effect。
        preloadWhiteFlashEffect();
    }

    protected onDestroy(): void {
        this.stopOrbFx();
        this.endCardWhitening();
        if (this._holdState) {
            Tween.stopAllByTarget(this._holdState);
            this._holdState = null;
        }
        // 宿主被销毁 → 兜底回调一次（否则「等动画结束再结算」的能力会永久挂住）
        const cb = this._pendingComplete;
        this._pendingComplete = null;
        if (cb) { try { cb(); } catch (e) { /* 忽略 */ } }
    }

    protected update(): void {
        // 🔴 手牌展开/抽卡等系统会动态把手牌区提到最上 ⇒ 播放期间**每帧**把宿主按回 Canvas 最后，
        //    保证光效永远压在所有卡牌之上（每帧一次 setSiblingIndex，开销可忽略）。
        if (!this._playing || !this.node.parent) return;
        const last = this.node.parent.children.length - 1;
        if (this.node.getSiblingIndex() !== last) this.node.setSiblingIndex(last);
    }

    // ------------------------------ 对外 API ------------------------------
    /**
     * 播放进化动画。
     * @param card      战场随从节点
     * @param isSuper   是否超进化（卡名换紫色样式；光球统一亮白色）
     * @param display   `BattleRuleSystem.endDeferredDisplay()` 的显示快照（630° 时写回卡面数字）
     * @param onComplete 动画**完全结束**（卡牌已回位）后的回调 —— 供「进化时能力」在演出之后结算。
     *                   所有提前返回 / 异常路径都会回调一次，保证调用方不会永久等待（幂等，只调一次）。
     */
    public play(card: Node, isSuper: boolean, display: unknown, onComplete?: () => void): void {
        // ★ 需求：**进化动画期间不要有屏障特效** —— 动画开始先把罩藏起来，完全结束再恢复。
        try { BarrierFx.setSuppressed(card, true); } catch (e) { /* 忽略 */ }
        let completed = false;
        const finish = (): void => {
            if (completed) return;
            completed = true;
            this._pendingComplete = null;
            // ★ 动画完全结束 ⇒ 恢复屏障罩
            try { BarrierFx.setSuppressed(card, false); } catch (e) { /* 忽略 */ }
            if (!onComplete) return;
            try { onComplete(); } catch (e) { console.error('[EvolveFx] 动画结束回调异常：', e); }
        };
        // 🔴 宿主被销毁（组件被移除 / 场景重载）时也要回调一次，否则「等动画结束再结算」的能力会永久挂住
        this._pendingComplete = finish;

        if (!card || !card.isValid) { finish(); return; }
        if (this._playing) {
            console.warn('[EvolveFx] 上一段进化动画还没播完，忽略本次');
            finish();                               // 本次进化已改数值 → 能力仍要结算，不能吞掉回调
            return;
        }
        const parent = card.parent;
        if (!parent) { finish(); return; }

        this._playing = true;
        EvolveFollowerFx._animating.add(card);

        const home = card.position.clone();              // 原父节点本地坐标（结束后恢复用）
        const homeScale = card.scale.clone();
        const homeSibling = card.getSiblingIndex();

        // 🔴🔴 展示期间把卡牌**临时挂到本宿主**（Canvas 最上层）——
        //    战场区域整体层级低，卡牌留在原父节点会被敌方战场/手牌/状态栏的卡牌挡住（实测）。
        //    keepWorldTransform ⇒ 世界坐标不变；动画坐标全部改用宿主本地坐标；
        //    动画结束后再 setParent 回原父节点并恢复原位 / 原缩放 / 原兄弟序。
        const fxHost = this.node;
        const fxUT = fxHost.getComponent(UITransform) || fxHost.addComponent(UITransform);
        const world0 = card.worldPosition.clone();
        if (this.verbose) console.log('[EvolveFx] step1 换父前');
        card.setParent(fxHost, true);
        if (this.verbose) console.log('[EvolveFx] step2 换父后 pos=' + card.position.x.toFixed(0) + ',' + card.position.y.toFixed(0));
        card.setSiblingIndex(fxHost.children.length - 1);
        const startLocal = fxUT.convertToNodeSpaceAR(world0, new Vec3());
        if (this.verbose) console.log('[EvolveFx] step3 startLocal=' + startLocal.x.toFixed(0) + ',' + startLocal.y.toFixed(0));

        // 屏幕正中（Canvas 中心）→ 宿主本地坐标
        const canvasNode = this.findCanvas();
        const centerWorld = canvasNode ? canvasNode.worldPosition.clone() : new Vec3(640, 360, 0);
        const centerLocal = fxUT.convertToNodeSpaceAR(centerWorld, new Vec3());
        const showScale = this.computeShowScale();

        const rules = this.findRules() as any;
        let revealed = false;
        /** 转过 revealAt 的那一刻：数字 + 卡图反转 +（超进化）名字样式 */
        const reveal = () => {
            if (revealed) return;
            revealed = true;
            try {
                if (rules && display && typeof rules.applyDisplayBatch === 'function') {
                    rules.applyDisplayBatch(display);
                }
                const img = card.getChildByName('CardImage');
                if (img) img.setScale(-1, 1, 1);
                if (isSuper) this.applySuperNameStyle(card);
            } catch (e) {
                console.warn('[EvolveFx] reveal 异常：', e);
            }
        };

        // 🔴 洗白 + 光团收缩都在旋转开始时启动；光团到 revealAt 起迸发（都在 phaseSpin 里按段对齐）。
        // ---------- 阶段①：飞到中央 + 放大 ----------
        // 🔴 缩放从**卡牌自身的常态**（homeScale，战场布局给的 ≈0.70）插值到 showScale ——
        //    硬编码从 1 起步会在起跳瞬间跳变，且「放大」倍数不对。
        const s0 = homeScale.x;
        const a = { p: 0 };
        tween(a)
            .to(Math.max(0.05, this.moveDuration), { p: 1 }, {
                easing: 'quadInOut',
                onUpdate: () => {
                    try {
                        card.setPosition(
                            startLocal.x + (centerLocal.x - startLocal.x) * a.p,
                            startLocal.y + (centerLocal.y - startLocal.y) * a.p, 0);
                        const s = s0 + (showScale - s0) * a.p;
                        card.setScale(s, s, 1);
                    } catch (e) { /* 节点可能已被销毁 */ }
                },
            })
            .call(() => {
                try { card.setPosition(centerLocal); card.setScale(showScale, showScale, 1); } catch (e) { /* 同上 */ }
                this.scheduleOnce(() => {
                    try {
                        this.phaseSpin(card, startLocal, centerLocal, showScale, s0, isSuper, reveal, () => {
                            // 🔴 归还：回原父节点（keepWorldTransform 后再精确落位）
                            try {
                                card.setParent(parent, true);
                                card.setPosition(home);
                                card.setScale(homeScale);
                                card.setRotationFromEuler(0, 0, 0);
                                card.setSiblingIndex(homeSibling);
                            } catch (e) { /* 同上 */ }
                            EvolveFollowerFx._animating.delete(card);
                            this._playing = false;
                            if (this.verbose) console.log('[EvolveFx] 动画完成 → ' + card.name);
                            finish();
                        });
                    } catch (e) {
                        console.warn('[EvolveFx] 转圈启动异常：', e);
                        this.stopOrbFx();
                        EvolveFollowerFx._animating.delete(card);
                        this._playing = false;
                        finish();
                    }
                }, Math.max(0, this.holdDuration));
            })
            .start();
    }

    /**
     * ★ **原地**进化 / 超进化动画（**自动进化专用**：敌方 AI 自动进化、能力的「本随从超进化」）。
     * 与手动拖拽的 `play()` 区别：卡牌**不移动、不换父**，就在战场原位上完成整套演出：
     *   ① 洗白 → ② 原地翻转（数值补间驱动 `eulerAngles.y`，光团先收缩）→
     *   ③ 转过 `revealAt`：写回新数字 + 卡图左右镜像 +（超进化）**紫色名牌** → ④ 恢复原色并回正。
     * 所有提前返回 / 异常路径都会回调一次（与 `play()` 同一约定）。
     */
    public playInPlace(card: Node, isSuper: boolean, display: unknown, onComplete?: () => void): void {
        try { BarrierFx.setSuppressed(card, true); } catch (e) { /* 忽略 */ }
        let completed = false;
        const finish = (): void => {
            if (completed) return;
            completed = true;
            this._pendingComplete = null;
            try { BarrierFx.setSuppressed(card, false); } catch (e) { /* 忽略 */ }
            if (onComplete) { try { onComplete(); } catch (e) { console.error('[EvolveFx] 动画结束回调异常：', e); } }
        };
        this._pendingComplete = finish;
        if (!card || !card.isValid) { finish(); return; }
        if (this._playing) {
            console.warn('[EvolveFx] 上一段进化动画还没播完，忽略本次（原地）');
            finish();
            return;
        }

        const rules = this.findRules() as any;
        const homeEuler = card.eulerAngles.clone();
        const totalDeg = 360 * Math.max(1, Math.round(this.spins));
        const leadDeg = Math.max(0, Math.min(this.revealAt, totalDeg));
        const tailDeg = totalDeg - leadDeg;
        let revealed = false;
        const reveal = (): void => {
            if (revealed) return;
            revealed = true;
            try {
                if (rules && display && typeof rules.applyDisplayBatch === 'function') rules.applyDisplayBatch(display);
                const img = card.getChildByName('CardImage');
                if (img) img.setScale(-1, 1, 1);
                if (isSuper) this.applySuperNameStyle(card);
            } catch (e) { console.warn('[EvolveFx] 原地 reveal 异常：', e); }
        };

        this._playing = true;
        EvolveFollowerFx._animating.add(card);
        this.ensureOrbFx(card, isSuper);
        this.beginCardWhitening(card);

        const s1 = { p: 0 };
        tween(s1)
            .to(Math.max(0.05, this.spinLeadDuration), { p: 1 }, {
                easing: 'quadInOut',
                onUpdate: () => {
                    try {
                        const deg = s1.p * leadDeg;
                        card.setRotationFromEuler(homeEuler.x, homeEuler.y + deg,
                            homeEuler.z + this.spinTiltZ * this.tiltInFactorAt(s1.p) * 0.35);
                        this.ensureOrbFx(card, isSuper);
                        this.updateOrbShrink(card, s1.p);
                    } catch (e) { /* 节点可能已销毁 */ }
                },
            })
            .call(() => {
                try {
                    reveal();
                    this.beginCardRecover();
                } catch (e) { /* 忽略 */ }
                const s2 = { p: 0 };
                tween(s2)
                    .to(Math.max(0.05, this.spinTailDuration), { p: 1 }, {
                        easing: 'quadOut',
                        onUpdate: () => {
                            try {
                                card.setRotationFromEuler(homeEuler.x, homeEuler.y + leadDeg + tailDeg * s2.p,
                                    homeEuler.z + this.spinTiltZ * (1 - s2.p) * 0.35);
                                this.ensureOrbFx(card, isSuper);
                                this.updateOrbFx(card, isSuper, s2.p);
                            } catch (e) { /* 忽略 */ }
                        },
                    })
                    .call(() => {
                        try {
                            card.setRotationFromEuler(homeEuler.x, homeEuler.y, homeEuler.z);   // 回正
                        } catch (e) { /* 忽略 */ }
                        this.updateOrbFx(card, isSuper, 1);
                        this.stopOrbFx();
                        this.endCardWhitening();
                        EvolveFollowerFx._animating.delete(card);
                        this._playing = false;
                        if (this.verbose) console.log('[EvolveFx] 原地进化动画完成 → ' + card.name);
                        finish();
                    })
                    .start();
            })
            .start();
    }

    // ------------------------------ 阶段②③ ------------------------------
    private phaseSpin(
        card: Node, startLocal: Vec3, centerLocal: Vec3, showScale: number, homeScaleX: number,
        isSuper: boolean, reveal: () => void, onDone: () => void,
    ): void {
        if (this.verbose) console.log('[EvolveFx] step4 启动转圈（前段=洗白+光团收缩，尾段=光团迸发）');
        const totalDeg = 360 * this.spins;
        // 🔴 旋转按 revealAt 拆成**前段 / 尾段**两段独立时长：
        //    前段 0→revealAt = 光团收缩段；尾段 revealAt→totalDeg = 光团迸发段。
        const leadDeg = Math.max(0, Math.min(this.revealAt, totalDeg));
        const tailDeg = totalDeg - leadDeg;
        // 🔴 迸发窗口 = 尾段旋转 + 中央展示：迸发在展示结束那一刻才熄灭。
        const tailDur = Math.max(0.05, this.spinTailDuration);
        const holdDur = Math.max(0, this.centerHoldDuration);
        const burstK = (tailDur + holdDur) > 0 ? tailDur / (tailDur + holdDur) : 1;

        // 🔴 卡牌自身洗白：旋转**一开始** 原色→全白（过渡变白，参照战场破坏特效的逐层洗白）。
        this.beginCardWhitening(card);
        // 🔴 光团收缩：旋转一开始光球就出现并从四周收拢（素材未就绪时 onUpdate 里会重试）。
        this.ensureOrbFx(card, isSuper);

        let recoverStarted = false;
        /** 转过 revealAt 的收尾（幂等）：新数字 + 反转卡图 + 全白→原色过渡恢复 */
        const onReveal = (): void => {
            if (recoverStarted) return;
            recoverStarted = true;
            reveal();
            this.beginCardRecover();
        };

        /** 旋转结束（尾段完成）：卡牌回正 → 中央回正展示，光团迸发延续到展示结束。 */
        const finishSpin = (): void => {
            try {
                reveal();
                card.setRotationFromEuler(0, 0, 0);      // N 圈 ≡ 0°，回正，无跳变
            } catch (e) { /* 节点可能已被销毁 */ }
            onReveal();
            if (this.verbose) console.log('[EvolveFx] step5 转圈结束 → 中央展示（光团迸发延续到展示结束）');

            // 🔴 回正后在屏幕正中间展示 centerHoldDuration 秒，然后才飞回战场；
            //    迸发进度跨「尾段 + 展示」整段窗口，展示结束那一刻恰好熄灭并销毁。
            this.startCenterHold(card, startLocal, centerLocal, showScale, homeScaleX, onDone,
                (holdP) => { this.updateOrbFx(card, isSuper, burstK + holdP * (1 - burstK)); },
                () => { this.updateOrbFx(card, isSuper, 1); this.stopOrbFx(); });
        };

        /** 尾段：revealAt → totalDeg（光团迸发 + 倾斜回正过渡）。 */
        const startTailPhase = (): void => {
            if (tailDeg <= 0) { finishSpin(); return; }
            onReveal();                                  // 🔴 转过 revealAt：新数字 + 恢复 + 迸发开始
            const s2 = { p: 0 };
            tween(s2)
                .to(tailDur, { p: 1 }, {
                    easing: 'quadIn',                    // 收尾加速，配合「迸发」的爆发感
                    onUpdate: () => {
                        try {
                            const deg = leadDeg + s2.p * tailDeg;
                            // 🔴 边旋转边回正：尾段最后 tiltOutDuration 秒 渐正，结束那一刻正好回正
                            card.setRotationFromEuler(0, deg, this.spinTiltZ * this.tiltOutFactorAt(s2.p, tailDur));
                            // 迸发进度：占整段迸发窗口的前 burstK 部分
                            this.updateOrbFx(card, isSuper, s2.p * burstK);
                        } catch (e) {
                            console.warn('[EvolveFx] 转圈（尾段）异常：', e);
                        }
                    },
                })
                .call(() => { finishSpin(); })
                .start();
        };

        // ---------- 前段：0° → revealAt（光团收缩） ----------
        if (leadDeg <= 0) { startTailPhase(); return; }
        const s1 = { p: 0 };
        tween(s1)
            .to(Math.max(0.05, this.spinLeadDuration), { p: 1 }, {
                easing: 'quadInOut',
                onUpdate: () => {
                    try {
                        const deg = s1.p * leadDeg;
                        // 🔴 边旋转边倾斜：前段开头 tiltInDuration 秒 0→spinTiltZ 渐歪
                        card.setRotationFromEuler(0, deg, this.spinTiltZ * this.tiltInFactorAt(s1.p));
                        this.ensureOrbFx(card, isSuper);
                        // 光团收缩进度：前段 0→1（从 evolveOrbShrinkRange 收到迸发起点）
                        this.updateOrbShrink(card, s1.p);
                    } catch (e) {
                        console.warn('[EvolveFx] 转圈（前段）异常：', e);
                    }
                },
            })
            .call(() => {
                try { card.setRotationFromEuler(0, leadDeg, this.spinTiltZ * this.tiltInFactorAt(1)); } catch (e) { /* 同上 */ }
                startTailPhase();
            })
            .start();
    }

    /**
     * Z 轴倾斜的**进入系数** ∈ [0,1]：前段开头 tiltInDuration 秒 0→1（smoothstep 渐歪）。
     * 🔴 以「前段进度」为基准（时长占比换算），与旋转共用同一条补间 ⇒ 边旋转边倾斜。
     */
    private tiltInFactorAt(pLead: number): number {
        const leadDur = Math.max(0.05, this.spinLeadDuration);
        if (this.tiltInDuration <= 0) return 1;
        const span = Math.min(1, this.tiltInDuration / leadDur);
        const r = Math.min(1, pLead / span);
        return r * r * (3 - 2 * r);
    }

    /**
     * Z 轴倾斜的**保留系数** ∈ [0,1]：尾段最后 tiltOutDuration 秒 1→0（smoothstep 渐正），
     * 旋转结束那一刻正好回正。0 时长 = 全程保持倾斜、结束瞬间回正。
     */
    private tiltOutFactorAt(pTail: number, tailDur: number): number {
        if (this.tiltOutDuration <= 0) return 1;
        const span = Math.min(1, this.tiltOutDuration / tailDur);
        const r = Math.min(1, (1 - pTail) / span);
        return r * r * (3 - 2 * r);
    }

    /**
     * 旋转结束后的「中央回正展示」（centerHoldDuration 秒）→ 再缩小飞回战场原位。
     * @param onHoldUpdate 展示期间每帧回调（参数 = 展示进度 ∈ [0,1]，驱动光团迸发）
     * @param onHoldEnd    展示结束那一刻回调（光团推到终点并销毁）
     */
    private startCenterHold(
        card: Node, startLocal: Vec3, centerLocal: Vec3, showScale: number, homeScaleX: number,
        onDone: () => void,
        onHoldUpdate: ((p: number) => void) | null = null,
        onHoldEnd: (() => void) | null = null,
    ): void {
        const goBack = (): void => {
            if (!card || !card.isValid) { onDone(); return; }
            const b = { p: 0 };
            tween(b)
                .to(Math.max(0.05, this.backDuration), { p: 1 }, {
                    easing: 'quadInOut',
                    onUpdate: () => {
                        try {
                            card.setPosition(
                                centerLocal.x + (startLocal.x - centerLocal.x) * b.p,
                                centerLocal.y + (startLocal.y - centerLocal.y) * b.p, 0);
                            const sc = showScale + (homeScaleX - showScale) * b.p;
                            card.setScale(sc, sc, 1);
                        } catch (e) { /* 节点可能已被销毁 */ }
                    },
                })
                .call(() => {
                    try { card.setRotationFromEuler(0, 0, 0); } catch (e) { /* 同上 */ }
                    onDone();
                })
                .start();
        };
        const hold = Math.max(0, this.centerHoldDuration);
        if (hold <= 0) {
            if (onHoldEnd) onHoldEnd();
            goBack();
            return;
        }
        const wait = { t: 0 };
        this._holdState = wait;
        tween(wait)
            .to(hold, { t: 1 }, {
                onUpdate: () => { if (onHoldUpdate) onHoldUpdate(wait.t); },
            })
            .call(() => {
                this._holdState = null;
                if (onHoldEnd) onHoldEnd();
                goBack();
            })
            .start();
    }

    // ------------------------------ 卡牌自身洗白（参照战场破坏特效） ------------------------------
    /**
     * 旋转开始时给卡牌**自身**逐层套上洗白材质，并 0→1 过渡变白。
     * 🔴 复用 `CardWhiteFlashFx`（与 `CardDestroyFx` 同一套实现 / 同一个 effect）：
     *    只改 RGB、保留各层贴图 alpha ⇒ 白光严格贴合卡牌实际显示轮廓，不是平直白方块。
     */
    private beginCardWhitening(card: Node): void {
        this.endCardWhitening();                       // 清掉上一轮（幂等）
        if (!card || !card.isValid) return;
        const eff = resolveWhiteFlashEffect();
        if (!eff) return;
        this._flashTargets = applyWhiteFlash(card, eff);
        this._flashValue = 0;
        setWhiteFlash(this._flashTargets, 0);
        const state = { v: 0 };
        this._flashTween = state;
        tween(state)
            .to(Math.max(0.01, this.whitenDuration), { v: 1 }, {
                easing: 'linear',
                onUpdate: () => {
                    this._flashValue = state.v;
                    setWhiteFlash(this._flashTargets, state.v);
                },
            })
            .start();
    }

    /** 转到 revealAt 后：全白 → 原色 的过渡恢复（恢复完自动把材质成对还原）。 */
    private beginCardRecover(): void {
        if (!this._flashTargets) return;
        this.stopFlashTween();
        const state = { v: this._flashValue };
        this._flashTween = state;
        tween(state)
            .to(Math.max(0.01, this.recoverDuration), { v: 0 }, {
                easing: 'linear',
                onUpdate: () => {
                    this._flashValue = state.v;
                    setWhiteFlash(this._flashTargets, state.v);
                },
            })
            .call(() => {
                this._flashTween = null;      // 本补间已自然结束，先解引用（避免 stop 正在跑的补间）
                this.endCardWhitening();
            })
            .start();
    }

    private stopFlashTween(): void {
        if (this._flashTween) {
            Tween.stopAllByTarget(this._flashTween);
            this._flashTween = null;
        }
    }

    /** 结束洗白：停掉过渡补间并把卡牌各层材质**成对还原**（幂等）。 */
    private endCardWhitening(): void {
        this.stopFlashTween();
        if (this._flashTargets) {
            releaseWhiteFlash(this._flashTargets);
            this._flashTargets = null;
        }
        this._flashValue = 0;
    }
    // ------------------------------ 超进化名字样式 ------------------------------
    /**
     * 超进化随从的**卡名紫色样式**：亮紫白字 + 深紫描边。
     * 🔴 只改颜色 / 描边，不动字号与位置 ⇒ 名字仍完整落在名字框里、清晰可读。
     */
    private applySuperNameStyle(card: Node): void {
        const nameNode = card.getChildByName('CardName');
        if (!nameNode) return;
        const lb = nameNode.getComponent(Label);
        if (lb) lb.color = this.superNameColor;
        let ol = nameNode.getComponent(LabelOutline);
        if (!ol) {
            ol = nameNode.addComponent(LabelOutline);
            ol.width = 2;
        }
        ol.color = this.superNameOutline;
    }

    // ------------------------------ 进化光球（复用进战场光球素材/时间轴） ------------------------------
    /**
     * 旋转开始时创建光球。
     * 🔴 三层 Sprite：核心亮斑(light_01) / 空心冲击环(light_02) / 弥散柔光(light_03)，
     *    共用 `SummonOrbAdd` 加色材质与「进战场光球」的模块级贴图缓存；
     *    时间轴 `SUMMON_ORB_LAYERS` 按 `orbTimelineEnd()` 拉伸到与旋转等长（见 updateOrbFx）。
     */
    private startOrbFx(card: Node, _isSuper: boolean): void {
        this.stopOrbFx();
        if (!card || !card.isValid) return;
        preloadSummonOrbAssets();
        const eff = getSummonOrbEffect();
        const sfs = getSummonOrbSpriteFrames();
        if (!eff || !sfs[0] || !sfs[1] || !sfs[2]) {
            console.warn('[EvolveFx] 进化光球素材尚未就绪，本次进化不出光效', { eff: !!eff, sfs: sfs.map(Boolean) });
            return;
        }
        const made = this.makeFx(EVOLVE_LIGHT_ORB_FX_NAME, card);
        if (!made) return;
        const { fx, mat } = made;
        mat.setProperty('intensity', Math.max(0, this.evolveOrbIntensity));

        // 分层配色：核心提白，其余保持设定色（加色下亮白会自然过曝成白热）。
        const kw = Math.max(0, Math.min(1, this.evolveOrbCoreWhiten));
        const base = this.evolveOrbColor;
        const core = new Color(
            Math.round(base.r + (255 - base.r) * kw),
            Math.round(base.g + (255 - base.g) * kw),
            Math.round(base.b + (255 - base.b) * kw),
            0,
        );
        const tints: Color[] = [core, new Color(base.r, base.g, base.b, 0), new Color(base.r, base.g, base.b, 0)];

        this._orbSprites = [];
        this._orbColors = [];
        for (let i = 0; i < SUMMON_ORB_LAYERS.length; i++) {
            const cfg = SUMMON_ORB_LAYERS[i];
            const sp = this.frameSprite(fx, sfs[cfg.tex]!, 1, tints[i], mat);
            this._orbSprites.push(sp);
            this._orbColors.push(new Color(tints[i]));
        }
        this._orbFx = fx;
        this._orbMat = mat;
    }

    /**
     * 确保进化光球节点存在（收缩段 + 迸发段共用一个节点）。
     * 🔴 素材未就绪时**静默返回**（不报警告），调用方每帧重试即可 —— 就绪的那一刻自动补上。
     */
    private ensureOrbFx(card: Node, isSuper: boolean): void {
        if (this._orbFx) return;
        const eff = getSummonOrbEffect();
        const sfs = getSummonOrbSpriteFrames();
        if (!eff || !sfs[0] || !sfs[1] || !sfs[2]) return;
        this.startOrbFx(card, isSuper);
    }

    /** 三层直径比例照搬 CardSummonOrbFx（核心 : 冲击环 : 弥散 = 0.85 : 1.35 : 1.70）。 */
    private orbSizesOf(rr: number): number[] {
        const r = Math.max(0.01, rr);
        return [r * (0.85 / 1.70), r * (1.35 / 1.70), r];
    }

    /** 光球基准 = 卡牌当前**显示**长边（含放大后的 scale）。 */
    private orbBaseSize(card: Node): number {
        const ut = card.getComponent(UITransform);
        const cs = Math.abs(card.scale.x) || 1;
        const cw = ut ? ut.contentSize.width * cs : 0;
        const ch = ut ? ut.contentSize.height * cs : 0;
        return Math.max(cw, ch, 120);
    }

    /**
     * 收缩段（旋转前段 0→revealAt）：光团从四周向卡牌收拢。
     * 🔴 **衔接无缝**：终点尺寸 = 迸发时间轴 p=0 的尺寸（`sizes[i] × cfg.from`）、
     *    终点 alpha = 迸发 p=0 的 alpha（= 0）——与 `updateOrbFx(card, 0)` 完全一致，
     *    两段交接那一帧没有任何跳变。透明度先淡入、再在末段淡出，收进卡牌的瞬间迸发亮起。
     * @param q 收缩进度 ∈ [0,1]（与旋转前段共用同一进度）
     */
    private updateOrbShrink(card: Node, q: number): void {
        const fx = this._orbFx;
        if (!fx || !fx.isValid || !card || !card.isValid) return;
        this.followCard(fx, card);

        const baseSize = this.orbBaseSize(card);
        const startSizes = this.orbSizesOf(this.evolveOrbShrinkRange);   // 收缩起点（可调最大范围）
        const endSizes = this.orbSizesOf(this.evolveOrbMaxRange);        // 迸发起点（= 迸发最大范围）
        const e = q * q * (3 - 2 * q);                                   // smoothstep：先缓后急再缓

        for (let i = 0; i < this._orbSprites.length; i++) {
            const sp = this._orbSprites[i];
            if (!sp || !sp.isValid) continue;
            const cfg = SUMMON_ORB_LAYERS[i];
            // 尺寸：起点 → 迸发 p=0 尺寸（× cfg.from），与 updateOrbFx(card, 0) 一致
            const startSize = baseSize * startSizes[i];
            const endSize = baseSize * endSizes[i] * cfg.from;
            const size = startSize + (endSize - startSize) * e;
            const tn = sp.node.getComponent(UITransform);
            if (tn) tn.setContentSize(size, size);
            // 透明度：前 12% 淡入 → 保持 → 末 18% 淡出到 0（= 迸发 p=0 的 alpha，无缝）
            const fin = Math.min(1, q / 0.12);
            const fout = Math.min(1, (1 - q) / 0.18);
            const a = cfg.peak * Math.max(0, Math.min(fin, fout));
            const c = this._orbColors[i];
            c.a = Math.round(255 * a);
            sp.color = c;
        }
    }

    /**
     * 每帧按迸发进度 p ∈ [0,1] 驱动三层光球。
     * 🔴 p 覆盖「旋转尾段 + 中央展示」整段迸发窗口 ⇒ 展示结束那一刻恰好完全熄灭；
     *    `orbTimelineEnd()` 把时间轴拉伸到 p=1 时正好完全消失（不会提前熄灭）。
     */
    private updateOrbFx(card: Node, _isSuper: boolean, p: number): void {
        const fx = this._orbFx;
        if (!fx || !fx.isValid || !card || !card.isValid) return;
        this.followCard(fx, card);

        const baseSize = this.orbBaseSize(card);
        const sizes = this.orbSizesOf(this.evolveOrbMaxRange);

        const pp = Math.min(1, Math.max(0, p) * orbTimelineEnd());
        for (let i = 0; i < this._orbSprites.length; i++) {
            const sp = this._orbSprites[i];
            if (!sp || !sp.isValid) continue;
            const cfg = SUMMON_ORB_LAYERS[i];
            const sc = orbScaleAt(pp, cfg);
            const size = baseSize * sizes[i] * sc;
            const tn = sp.node.getComponent(UITransform);
            if (tn) tn.setContentSize(size, size);
            const c = this._orbColors[i];
            c.a = Math.round(255 * Math.max(0, Math.min(1, orbAlphaAt(pp, cfg))));
            sp.color = c;
        }
    }

    private stopOrbFx(): void {
        if (this._orbFx && this._orbFx.isValid) {
            Tween.stopAllByTarget(this._orbFx);
            this._orbFx.destroy();
        }
        this._orbFx = null;
        this._orbSprites = [];
        this._orbColors = [];
        if (this._orbMat) {
            this._orbMat.destroy();
            this._orbMat = null;
        }
    }

    // ------------------------------ 特效基元 ------------------------------
    /** 特效节点跟随卡牌的世界位置（换算到宿主本地坐标） */
    private followCard(fx: Node, card: Node): void {
        const ut = this.node.getComponent(UITransform);
        if (!ut || !card || !card.isValid) return;
        const local = ut.convertToNodeSpaceAR(card.worldPosition, new Vec3());
        fx.setPosition(local.x, local.y, 0);
    }

    private makeFx(name: string, card: Node): { fx: Node; mat: Material } | null {
        const eff = getSummonOrbEffect();
        if (!eff || !eff.isValid) return null;
        const fx = new Node(name);
        // 🔴🔴 运行时创建的节点**必须继承宿主的 layer**！本项目 UI 相机可见层是 DEFAULT(1<<30)，
        //    **不含 UI_2D(1<<25)** —— 之前硬编码 UI_2D 导致整个特效被相机剔除（不可见但一切正常）。
        fx.layer = this.node.layer;
        fx.setParent(this.node);
        fx.setSiblingIndex(this.node.children.length - 1);
        const fut = fx.addComponent(UITransform);
        fut.setAnchorPoint(0.5, 0.5);
        this.followCard(fx, card);
        const mat = new Material();
        mat.initialize({ effectAsset: eff });
        return { fx, mat };
    }

    private frameSprite(parent: Node, sf: SpriteFrame, size: number, tint: Color, mat: Material): Sprite {
        const n = new Node('f');
        n.layer = parent.layer;   // 🔴 继承宿主 layer（见 makeFx 注释：UI_2D 会被相机剔除）
        n.setParent(parent);
        const sp = n.addComponent(Sprite);
        sp.sizeMode = Sprite.SizeMode.CUSTOM;   // 🔴 默认 TRIMMED 会改写 contentSize
        sp.spriteFrame = sf;
        sp.customMaterial = mat;
        sp.color = new Color(tint);
        n.getComponent(UITransform)!.setContentSize(size, size);
        return sp;
    }

    // ------------------------------ 场景解析 ------------------------------
    private findCompOf(cls: string): Component | null {
        const scene = this.node.scene;
        if (!scene) return null;
        const stack: Node[] = [...scene.children];
        while (stack.length > 0) {
            const n = stack.shift() as Node;
            const c = n.getComponent(cls);
            if (c) return c;
            for (const ch of n.children) stack.push(ch);
        }
        return null;
    }

    /** 「我方抽卡展示」的同款大小：手牌完整态缩放 × 拖拽放大（缺组件时退回 1.35 倍） */
    private computeShowScale(): number {
        const mini = this.findCompOf('HandMinimize') as any;
        const hand = this.findCompOf('HandLayout') as any;
        const drag = this.findCompOf('HandDrag') as any;
        const base = mini && typeof mini.fullAppliedScale === 'number' && mini.fullAppliedScale > 0
            ? mini.fullAppliedScale
            : (hand && typeof hand.appliedScale === 'number' ? hand.appliedScale : 1);
        const ds = drag && typeof drag.dragScale === 'number' ? drag.dragScale : 1.35;
        return Math.max(0.05, base * ds * this.showScaleMultiplier);
    }

    private findCanvas(): Node | null {
        const scene = this.node.scene;
        if (!scene) return null;
        const stack: Node[] = [...scene.children];
        while (stack.length > 0) {
            const n = stack.shift() as Node;
            if (n.getComponent(Canvas)) return n;
            for (const ch of n.children) stack.push(ch);
        }
        return null;
    }

    private findRules(): Component | null {
        return this.findCompOf('BattleRuleSystem');
    }
}