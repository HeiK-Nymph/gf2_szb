import {
    _decorator, Camera, Canvas, Component, Node, Tween, tween, UITransform, Vec3,
} from 'cc';
import { HandLayout } from './HandLayout';
import { HandDrag } from './HandDrag';
import { BattleFieldLayout, BattleSide } from './BattleFieldLayout';
import { CardComposer, killNode } from './CardComposer';
import { CardInfo, getCardInfo, markEnhancedThisPlay, maxEnhanceOf } from './CardData';
import {
    cardTargetRequest, injectPPApi, modeOptionTexts, preTakeSummons, runCardFanfareAbilities,
    runCardPassiveAbilities, runCardUseAbilities,
} from './CardAbilitySystem';
import { playSpellCastOrb, preloadSpellCastOrbAssets } from './SpellCastOrbFx';
import { addToGrave } from './CardDeckManager';
import { TargetSelectSystem } from './TargetSelectSystem';
import { ModeSelectPanel } from './ModeSelectPanel';

const { ccclass, property, requireComponent, menu } = _decorator;

interface QueuedPlay {
    card: Node;
    id: string;
    info: CardInfo;
    baseScale: number;
    /** 入队时在手牌中的有效项下标；失败回手时按这个位置插回。 */
    index: number;
    /**
     * 「确定使用」的逻辑结算是否已在**入队那一刻**完成（法术）。
     * true → 再轮到它播时不可重复结算；起手失败也**不能退回手牌**（见 returnQueuedToHand）。
     */
    useResolved: boolean;
}

/**
 * CardPlay —— 打出卡牌（拖过判定高度 → 正中展示 → 绕 Y 翻转 + 贝塞尔入战场）
 * ===========================================================================
 * 挂在**手牌区节点**（与 HandLayout / HandDrag / CardDraw 同一个节点，如 Canvas/PlayerHandArea）上。
 * 它通过 `HandDrag.releaseHandler` 接管「松手」事件，整条流程分两步：
 *
 * 第一步：判定为「使用卡牌」+ 正中展示
 *   拖拽中把卡牌抬到超过 `useThresholdY`（**Canvas 局部坐标系的 Y**，0 = 屏幕垂直中心，
 *   越往上越大；本工程实测：手牌静置约 -283，战场一排约 -85）即判定为「使用这张卡」。松手时：
 *     · 法术(Spell) 可使用：照常进入中央展示，但展示完成后直接消失、不进入战场；
 *     · 非法术卡：战场已满 / 未登记 / 总开关关闭 → 回位；
 *     · 其余情况 → 卡牌用 tween 移到**屏幕正中央**、放大到 `centerScale` 倍并摆正（euler 归零），
 *       然后原地停留 `holdDuration` 秒。
 *
 * 第二步：绕 Y 轴翻转 + 二次贝塞尔飞入战场（法术改为销毁消失）
 *   停留结束后，卡牌**一边绕 Y 轴翻转、一边沿二次贝塞尔曲线**飞向战场最右一格：
 *     · 贝塞尔：P0 = 卡牌当前所在（屏幕正中），P2 = 战场「最右一格」的目标位，
 *       **控制点 P1 = P0P2 的中点 + 垂直于 P0→P2 的方向 × arcHeight**
 *       （垂直方向统一取「朝上」的那一侧 → 拱起向上；arcHeight 给负值即向下拱）。
 *     · 旋转（视觉上是一次连续的 180° 翻面，实现上分两段）：
 *         0° ──→ +90°（此时卡牌完全侧对镜头、**宽度为零、看不见**）
 *         → **在这一瞬销毁手牌卡牌、换成对应的战场样式卡牌**（`BF_<品质><类型>` 卡框）→
 *         -90° ──→ 0°
 *       ±90° 都恰好是「零宽」的，所以这一换脸肉眼不可见；
 *       终点回到 **0°**（而不是 180°），战场卡牌不会停在镜像姿态。
 *     · 与此同时、**同一个总时长 `travelDuration`** 并行跑三件事，三者同时收尾：
 *         ① 卡牌自身沿贝塞尔飞入战场最右格；
 *         ② **战场其余卡牌** tween 到「多出最右一张」后的新排布（整排让位、一起左移）；
 *         ③ **手牌其余卡牌** tween 到「少掉一张」后的新扇形排布（重新居中收紧）。
 *       收尾瞬间即：战场最右多一张牌、手牌原拖拽位少一张牌，两边层序与后续 refresh 完全一致。
 *
 * 暴露给 Cocos 面板的可调参数
 *   useThresholdY   判定为「使用卡牌」的高度（Canvas 局部坐标 Y；0 = 屏幕垂直中心）
 *   centerScale     卡牌停在屏幕正中时的缩放倍数（相对手牌基础缩放）
 *   moveDuration    「移到正中 + 放大 + 摆正」的 tween 时长（秒）
 *   holdDuration    卡牌在屏幕正中停留展示的时长（秒）
 *   arcHeight       贝塞尔拱起高度（px，垂直于 P0→P2 方向抬起的距离）
 *   travelDuration  「翻转飞行 + 战场重排 + 手牌重排」的 tween 总时长（秒）
 *
 * 实现要点（都踩过坑）
 *   · 打出的卡牌会被**搬到一个专图层**（Canvas 下动态建的 `CardPlayLayer`，始终置顶），
 *     而不是留在 PlayerHandArea 里：① 手牌层在松手后会还原层级，留在手牌区里的卡会被战场压住；
 *     ② 留在手牌区里的话，任何一次 HandLayout.refresh() 的清理都会把它当多余卡牌销毁。
 *   · 打出开始时就把该卡从 HandLayout 的集合里摘掉（`releaseCard`），但**不 refresh** ——
 *     排布由本脚本自己用 tween 补间过去，避免「瞬间跳位」。
 *   · 战场「最右一格」的目标位是**把新卡宽度算进去**预演出来的（`computeTargets(extraWidth)`），
 *     所以整排的让位动画与飞入动画共用同一套坐标，收尾不会突然平移一下。
 *   · 三处 scratch Vec3 都是同步使用，安全。
 *   · **tween 回调里的异常会被引擎吞掉**（只在浏览器弹一个红框，控制台看不到）。
 *     收尾用的 land() 与飞行用的 onUpdate 都做了异常兜底，否则一次报错就会让
 *     `_busy`/`enableDrag` 永久卡死、整副手牌再也拖不动（实测踩过）。
 * ===========================================================================
 */
@ccclass('CardPlay')
@requireComponent(UITransform)
@menu('gf2szb/CardPlay')
export class CardPlay extends Component {

    // ====================== 第一步：判定高度 + 正中展示 ======================
    @property({
        tooltip: '判定为「使用卡牌」的高度（**Canvas 局部坐标系的 Y**，0 = 屏幕垂直中心，越往上越大）。\n'
            + '拖拽中卡牌中心越过这条线、松手即判定为使用该卡。\n'
            + '本工程实测参照：手牌静置约 -283、战场一排约 -85 → 默认 -150 约等于「抬起半个手牌区」。\n'
            + '⚠️ 法术(Spell)可使用：展示完成后直接消失，不进入战场。',
    })
    useThresholdY = -150;

    @property({
        range: [0.1, 4, 0.01], slide: true,
        tooltip: '卡牌停在屏幕正中时的缩放倍数（**相对手牌基础缩放**，与 HandDrag.dragScale 同一口径）。\n'
            + '1.35 与拖拽时一样大；默认 1.6 = 展示时再放大一圈。',
    })
    centerScale = 1.6;

    @property({
        range: [0, 3, 0.01], slide: true,
        tooltip: '「移到屏幕正中 + 放大到 centerScale + 摆正」的 tween 时长（秒）。\n0 = 不做过渡，瞬间到位。',
    })
    moveDuration = 0.35;

    @property({
        range: [0, 5, 0.01], slide: true,
        tooltip: '卡牌停在屏幕正中**展示**的时长（秒），到点后开始翻转飞行入战场。',
    })
    holdDuration = 1.0;

    @property({
        tooltip: '打印打出流程 / 目标选择（入场曲与法术共用）的日志。\n'
            + '🔴 本字段此前只被代码引用、**没有声明**（`this.verbose` 恒为 undefined ⇒ 这些日志从来不打印），'
            + '本次补上声明，方便排查「先选目标」流程。',
    })
    verbose = true;

    // ====================== 第二步：翻转飞行 + 入战场 ======================
    @property({
        range: [-800, 800, 1], slide: true,
        tooltip: '二次贝塞尔的**拱起高度**（px）：控制点 = P0P2 中点 + 垂直于 P0→P2 的方向 × 本值。\n'
            + '垂直方向统一取「朝上」的那一侧 → 正值向上拱起、负值向下。',
    })
    arcHeight = 180;

    @property({
        range: [0, 3, 0.01], slide: true,
        tooltip: '「卡牌翻转飞行入战场 + 战场重新排布 + 手牌重新排布」的 tween **总**时长（秒）。\n'
            + '三者共用这一个时长，因此同时收尾。\n'
            + '注意：绕 Y 轴的 0°→+90°→-90°→0° 也在这同一个总时长内完成。',
    })
    travelDuration = 0.55;

    @property({ range: [0, 1, 0.01], slide: true, tooltip: '队列中的卡因费用 / 条件变化而退回手牌时的动画时长（秒）。' })
    tweenHandReturnDuration = 0.25;

    // ====================== 入场曲：先选目标（卡 4 等）======================
    @property({
        range: [0.2, 3, 0.01], slide: true,
        tooltip: '【入场曲等待选择】卡牌停在**摄像头左上角**时的缩放倍数（相对手牌基础缩放）。',
    })
    fanfareCornerScale = 1.0;

    @property({
        range: [0, 240, 1], slide: true,
        tooltip: '【入场曲等待选择】卡牌停在左上角时与屏幕边缘的留白（px）。',
    })
    fanfareCornerMargin = 24;

    @property({
        range: [0, 2, 0.01], slide: true,
        tooltip: '【入场曲】玩家**选中目标之后**等多久开始飞入战场（秒）。',
    })
    fanfareEnterDelay = 0.15;

    // ====================== 行为开关 & 依赖 ======================
    @property({ tooltip: '总开关：关闭后拖拽超过判定高度也不会打出卡牌（一切照常回位）' })
    enablePlay = true;

    @property({ tooltip: '使用法术时是否播放「法术圈」特效（在**法术展示卡消失那一刻**触发，与能力结算时机无关）' })
    spellCastFxOnUse = true;

    @property({ tooltip: '打出过程中禁用其它手牌的拖拽（避免与手牌重排动画抢同一张卡）。\n'
        + '动画结束后自动恢复原开关状态。' })
    lockDragWhilePlaying = false;

    @property({ tooltip: '允许在上一张牌的入场动画期间继续拖拽 / 排队使用其它手牌。' })
    allowQueuedPlay = true;

    @property({ type: HandLayout, tooltip: '（可选）手牌区布局组件；留空自动在本节点上查找。' })
    handLayout: HandLayout | null = null;

    @property({ type: HandDrag, tooltip: '（可选）手牌拖拽组件；留空自动在本节点上查找。\n'
        + '本脚本会把自己的判定钩子挂到它的 releaseHandler 上。' })
    handDrag: HandDrag | null = null;

    @property({ type: BattleFieldLayout, tooltip: '（可选）战场布局组件；留空自动在场景里查找**我方**战场（side = Player，即 PlayerBattleFieldArea）。\n'
        + '敌方战场（EnemyBattleFieldArea）不会被选中。' })
    battlefield: BattleFieldLayout | null = null;

    // ------------------------------ 内部状态 ------------------------------
    /** 正在播放打出动画（期间不接受第二次打出） */
    private _busy = false;
    /** 正在飞行的手牌卡牌 */
    private _handCard: Node | null = null;
    /** 对应的战场样式卡牌（起手时就先建好，仅用于量宽度/预热资源，翻面那一瞬才显示） */
    private _fieldCard: Node | null = null;
    /** 正在打出的卡牌 id */
    private _id = '';
    /** 本次打出的牌是否是法术（法术只做中央展示，结束后直接消失）。 */
    private _isSpell = false;
    /**
     * ★ 打出时**已从牌组预扣**的召唤卡 id（入场曲的 `Summon{from:'deck'}`）。
     * 目的：状态栏的牌组数字在打出那一刻就跳到最终值（需求 Task 2）；
     * 召唤能力结算时优先消费这里（`CardAbilitySystem.summonCards` 读 `host._preSummon`）。
     */
    private _preSummon: string[] = [];
    /**
     * ★ 「模式」卡牌在本次入场曲里**选中的选项索引**（-1 = 没选 / 走兜底第一个）。
     * 由 `ModeSelectPanel` 的选择回调写回，`CardAbilitySystem` 的 `Mode` handler 读它结算。
     */
    private _fanfareMode = -1;
    /** 打出专图层（Canvas 下动态创建，始终置顶） */
    private _playLayer: Node | null = null;
    /** 缓存的 UI 相机 */
    private _cam: Camera | null = null;
    /** 唯一临时节点名自增序号 */
    private _seq = 0;
    /** 打出前 HandDrag.enableDrag 的状态（收尾时还原） */
    private _prevEnableDrag = true;
    /** 中央展示计时器（用定时器而非 scheduleOnce，避免预览环境重复触发 launch）。 */
    private _holdTimer: ReturnType<typeof setTimeout> | null = null;
    /** 队列推进的延迟重试计时器。 */
    private _queueTimer: ReturnType<typeof setTimeout> | null = null;
    /** 等待依次打出的卡牌（已经离开手牌，冻结在松手位置）。 */
    private readonly _queue: QueuedPlay[] = [];
    /** 已为队列预留、尚未真正扣除的 PP。 */
    private _reservedCost = 0;
    /** 已预留的战场槽位（正在播放 + 队列中的非法术卡）。 */
    private _reservedFieldSlots = 0;

    // —— 「先选目标」的等待状态（随从的入场曲 / **需要选目标的法术**共用同一套流程）——
    /**
     * 本次打出的**目标选择**（非 null = 这张牌带有需要先选目标的能力）。
     * 🔴 只在「场上存在合法候选」时才设置 —— 没有候选时按需求**直接正常结算/进入战场**。
     * 🔴 `trigger` 区分这是**入场曲**（随从，落地后结算）还是**使用时**（法术，选中后当场结算）。
     */
    private _fanfare: { select: string; filter: string; trigger: 'fanfare' | 'use' } | null = null;
    /** 玩家在等待期间**已经选中**的目标（随从：进入战场后交给入场曲；法术：选中后立刻结算 use 能力）。 */
    private _fanfareTarget: Node | null = null;
    /** 正在「摄像头左上角」等待玩家选择目标。 */
    private _awaitingTarget = false;
    /** 打出前该卡在手牌中的下标（取消时插回原位）。 */
    private _handIndex = 0;
    /** 选择模式组件缓存（挂在 Canvas 上） */
    private _selectCache: TargetSelectSystem | null = null;

    // ------------------------------ 生命周期 ------------------------------
    onLoad(): void {
        this.attachHook();
        preloadSpellCastOrbAssets();   // 预加载法术特效资源，避免第一次用法术时还没就绪
    }

    onEnable(): void {
        this.attachHook();
    }

    onDisable(): void {
        const drag = this.resolveDrag();
        if (drag && drag.releaseHandler === this._onRelease) drag.releaseHandler = null;
        // 组件被关掉时把临时节点收掉，不留悬空状态
        if (this._handCard) killNode(this._handCard);
        if (this._fieldCard) killNode(this._fieldCard);
        for (const q of this._queue) if (q.card && q.card.isValid) killNode(q.card);
        this._queue.length = 0;
        this._handCard = null;
        this._fieldCard = null;
        this._reservedCost = 0;
        this._reservedFieldSlots = 0;
        this._busy = false;
        this.clearHoldTimer();
        this.clearQueueTimer();
        this.lockDrag(false);
        // 入场曲等待状态一并复位（`_busy` 已为 false ⇒ 取消回调会安全地早退）
        this._fanfare = null;
        this._fanfareTarget = null;
        this.cancelFanfareSelect();
    }

    // ------------------------------ 对外查询 / API ------------------------------
    /** 是否正在播放打出动画 */
    public get isPlaying(): boolean {
        return this._busy;
    }

    /** 正在飞行的手牌卡牌（null = 没有在飞） */
    public get playingCard(): Node | null {
        return this._handCard;
    }

    /** 打出专图层（首次用到时动态创建；供测试/排查） */
    public get playLayer(): Node | null {
        return this._playLayer;
    }

    /** 重开对决 / 清场时调用：终止当前动画与整个等待队列，清空所有预留。 */
    public resetForBattle(): void {
        this.clearHoldTimer();
        this.clearQueueTimer();
        if (this._handCard && this._handCard.isValid) killNode(this._handCard);
        if (this._fieldCard && this._fieldCard.isValid) killNode(this._fieldCard);
        for (const q of this._queue) {
            if (q.card && q.card.isValid) killNode(q.card);
        }
        this._queue.length = 0;
        this._handCard = null;
        this._fieldCard = null;
        this._busy = false;
        this._id = '';
        this._isSpell = false;
        this._reservedCost = 0;
        this._reservedFieldSlots = 0;
        this.lockDrag(false);
        // 入场曲等待状态一并复位（`_busy` 已为 false ⇒ 取消回调会安全地早退）
        this._fanfare = null;
        this._fanfareTarget = null;
        this.cancelFanfareSelect();
    }

    /**
     * 是否正占着「打出 / 法术演出」舞台（含排队待播的下一张）。
     * 供 CardDraw 之类的演出组件判断「现在能不能起手自己的动画」——
     * 注意它只影响**演出**，逻辑入账（定判）不受它影响。
     */
    public get isBusy(): boolean {
        return this._busy || this._queue.length > 0;
    }

    /**
     * 尝试把某张手牌「打出」。
     * 若上一张仍在动画中，本张会被移出手牌并冻结在松手位置，等前一张收尾后依次处理。
     */
    public tryPlayCard(card: Node, ignoreThreshold = false): boolean {
        if (!this.enablePlay) return false;
        if (!card || !card.isValid) return false;
        // 🔴 入场曲正在等玩家选目标：此时舞台被这张牌占着，不接受新的打出（新牌照常回手）
        if (this._awaitingTarget || this._fanfare) return false;

        const hand = this.resolveHand();
        if (!hand) return false;
        const id = this.idOf(card, hand);
        if (!id) return false;

        const info = getCardInfo(id);
        if (!info) return false;

        const bf = this.resolveField();
        if (!bf) return false;
        if (!ignoreThreshold && this.canvasY(card) < this.useThresholdY) return false;

        if (!this.canUseCard(id)) {
            console.log(`[CardPlay] 暂不可使用：${info.cardName}（费用 ${info.cost}、`
                + `可用预算 ${this.availablePP()}）`);
            return false;
        }
        const baseScale = hand.appliedScale;
        if (!this.reserveForPlay(info, bf)) return false;

        if (this._busy || this._queue.length > 0 || this.isHandAnimationBusy()) {
            if (!this.allowQueuedPlay) {
                this.releaseReservation(info, bf);
                return false;
            }
            return this.enqueueCard(card, id, info, baseScale, hand);
        }
        return this.play(card, id, hand, bf, baseScale);
    }

    /** 手牌可用性提示的统一判据：费用（含额外能量点与队列预留）+ 战场条件。 */
    public canUseCard(id: string): boolean {
        if (!this.enablePlay) return false;
        const info = getCardInfo(id);
        if (!info) return false;
        if (!this.canAffordWithReserved(info.cost)) return false;
        const bf = this.resolveField();
        if (!bf) return false;
        if (info.cardType === 'Spell') {
            // 🔴 需求：**需要选目标的法术没有合法候选时不可使用**（如卡 7「钢铁穹顶」要求我方有【守护】随从）。
            //    与「随从的入场曲没有候选也照常入场」不同 —— 法术用掉就进墓场，没目标等于白扔一张牌。
            const req = cardTargetRequest(id, ['use']);
            if (req) {
                const sys = this.selectSystem();
                if (!sys || sys.candidatesFor('player', req.select, req.filter).length === 0) return false;
            }
            return true;
        }
        return bf.cardCount + this._reservedFieldSlots < bf.maxCards;
    }

    /** 当前可用于后续卡牌的预算（已有队列预留只影响可用判断，不提前改能量显示）。 */
    public availablePP(): number {
        return Math.max(0, ppRemaining(this.node, 'player') + ppExtraCharge(this.node, 'player') - this._reservedCost);
    }

    // ------------------------------ 松手钩子 ------------------------------
    /** 挂在 HandDrag.releaseHandler 上的判定函数：返回 true = 本组件接管这张卡 */
    private readonly _onRelease = (card: Node): boolean => {
        return this.tryPlayCard(card, false);
    };

    private attachHook(): void {
        const drag = this.resolveDrag();
        if (drag) drag.releaseHandler = this._onRelease;
    }

    // ------------------------------ 主流程 ------------------------------
    private reserveForPlay(info: CardInfo, bf: BattleFieldLayout): boolean {
        if (!this.canAffordWithReserved(info.cost)) return false;
        if (info.cardType !== 'Spell' && bf.cardCount + this._reservedFieldSlots >= bf.maxCards) return false;
        // 🔴 预约**只按卡牌本身费用**：强化值是否付得起要在「释放预约之后」再判，
        //    否则 canAffordWithReserved(强化值) 会把刚预约的这笔算进去 ⇒ 永远判成付不起（实测 bug）。
        this._reservedCost += Math.max(0, Math.round(info.cost));
        if (info.cardType !== 'Spell') this._reservedFieldSlots += 1;
        return true;
    }

    private releaseReservation(info: CardInfo, bf?: BattleFieldLayout | null): void {
        this._reservedCost = Math.max(0, this._reservedCost - Math.max(0, Math.round(info.cost)));
        if (info.cardType !== 'Spell') this._reservedFieldSlots = Math.max(0, this._reservedFieldSlots - 1);
    }

    private canAffordWithReserved(cost: number): boolean {
        return this.availablePP() >= Math.max(0, cost);
    }

    /**
     * 启动队首时不能再用 canAffordWithReserved(cost)：
     * 它会队首自己已经预留的费用再减一次，导致 5 费卡在足够预算下被误判为付不起。
     * 这里只要求实际 PP + 额外能量 ≥ 全部尚未正式扣除的预留。
     */
    private canStartReservedQueued(): boolean {
        return ppRemaining(this.node, 'player') + ppExtraCharge(this.node, 'player') >= this._reservedCost;
    }

    /** 队列中的卡：摘出手牌、冻结在松手位置，等前一张收尾。 */
    private enqueueCard(card: Node, id: string, info: CardInfo, baseScale: number, hand: HandLayout): boolean {
        const layer = this.playLayerNode();
        if (!layer) {
            this.releaseReservation(info);
            return false;
        }
        const index = hand.cards.indexOf(card);
        if (!hand.releaseCard(card)) {
            this.releaseReservation(info);
            return false;
        }
        card.setParent(layer, true);
        toFront(card);
        const entry: QueuedPlay = { card, id, info, baseScale, index: Math.max(0, index), useResolved: false };
        this._queue.push(entry);
        // 🔴 排队打出同样属于**「确定使用」**（玩家已经把它交出去、去向与能力都不再变）：
        //    法术的墓场记账 + use 能力（抽牌）**当场结算** —— 最终定判立刻生效，
        //    演出仍按它自己的顺位播。多张连打时，计数器就是「最后一张触发定判那一刻」的结果。
        if (info.cardType === 'Spell') {
            // 🔴 需要选目标的法术**不能**在这里结算（目标还没选）—— 留给 play() 的
            //    「先选目标」流程：选中后由 onFanfarePicked → resolveSpellUseNow(id, target) 结算。
            if (!this.spellTargetRequest(id)) {
                entry.useResolved = true;
                this.resolveSpellUseNow(id);
            }
        }
        // 如果前一张已经播完、只是抽牌动画还在重排手牌，需要主动启动队列接力。
        if (!this._busy) this.scheduleQueueNext(0);
        return true;
    }

    private consumeReservation(info: CardInfo): void {
        this._reservedCost = Math.max(0, this._reservedCost - Math.max(0, Math.round(info.cost)));
        // ★ 爆能强化：剩余能量点 ≥ 强化值时，**改为消耗强化值**（不是卡牌费用）并打标记
        const enhVal = maxEnhanceOf(info.cardImage);
        const useEnh = enhVal > 0 && this.canAffordWithReserved(enhVal);
        const pay = useEnh ? enhVal : Math.max(0, Math.round(info.cost));
        if (pay > 0) spendPP(this.node, 'player', pay, 'CardPlay');
        if (useEnh) {
            markEnhancedThisPlay('player', info.cardImage);
            console.log(`[CardPlay] ${info.cardName} 以【爆能强化_${enhVal}】打出（消耗 ${enhVal} 点）`);
        }
    }

    private tryStartNextQueued(): void {
        if (this._queue.length === 0) return;
        if (this._busy) {
            this.scheduleQueueNext(80);
            return;
        }
        if (this.isHandAnimationBusy()) {
            this.scheduleQueueNext(100);
            return;
        }
        const q = this._queue.shift()!;
        const hand = this.resolveHand();
        const bf = this.resolveField();
        if (!q.card || !q.card.isValid || !hand || !bf || !this.canStartReservedQueued()) {
            this.returnQueuedToHand(q, hand);
            return;
        }
        if (q.info.cardType !== 'Spell' && bf.cardCount + this._reservedFieldSlots > bf.maxCards) {
            this.returnQueuedToHand(q, hand);
            return;
        }
        if (!this.play(q.card, q.id, hand, bf, q.baseScale, true, q.useResolved)) {
            this.returnQueuedToHand(q, hand, false);
        }
    }

    private returnQueuedToHand(q: QueuedPlay, hand: HandLayout | null, release = true): void {
        if (release) this.releaseReservation(q.info);
        // 🔴 这张牌的使用**已经在入队那一刻结算过**（法术已入墓场、能力已结算）⇒ 不能再退回手牌，
        //    否则计数/墓场会和「已使用」这个事实自相矛盾。唯一合法收尾 = 当已使用消耗掉。
        if (q.useResolved) {
            if (q.card && q.card.isValid) killNode(q.card);
            console.warn(`[CardPlay] 已结算使用的 ${q.id} 无法起手（组件/费用异常），按已使用处理（不回手牌）。`);
            this.scheduleQueueNext(0);
            return;
        }
        if (!hand || !q.card || !q.card.isValid) {
            if (q.card && q.card.isValid) killNode(q.card);
            this.scheduleQueueNext(0);
            return;
        }
        q.card.setParent(hand.node, true);
        hand.adoptCardAt(q.card, q.id, q.index);
        const idx = hand.cards.indexOf(q.card);
        const target = idx >= 0 ? hand.currentTargets()[idx] : null;
        const dur = Math.max(0, this.tweenHandReturnDuration);
        if (target && dur > 0) {
            tween(q.card)
                .to(dur, {
                    position: target.pos.clone(),
                    eulerAngles: target.euler.clone(),
                    scale: target.scale.clone(),
                }, { easing: 'sineInOut' })
                .call(() => this.scheduleQueueNext(0))
                .start();
        } else {
            if (target) {
                q.card.setPosition(target.pos);
                q.card.setRotationFromEuler(target.euler);
                q.card.setScale(target.scale);
            }
            this.scheduleQueueNext(0);
        }
    }

    /**
     * 起手一次「打出」：建好战场样式卡牌 → 把两张卡都搬进专图层 → 摘除手牌登记 → 开始第一步动画。
     * 所有可能失败的步骤都在**动手改节点之前**完成，返回 false 时场景状态原封不动（HandDrag 会照常回位）。
     */
    private play(
        card: Node,
        id: string,
        hand: HandLayout,
        bf: BattleFieldLayout,
        baseScale: number,
        alreadyReleased = false,
        useResolved = false,
    ): boolean {
        const info = getCardInfo(id);
        if (!info) {
            return false;
        }
        const isSpell = info.cardType === 'Spell';
        const composer = bf.composerRef;
        const frame = isSpell ? null : bf.frameFor(id);
        if (!composer || (!isSpell && !frame)) {
            console.log(`[CardPlay] 起手失败：战场卡框/工厂不可用（id=${id}、frame=${frame}）。`);
            this.releaseReservation(info, bf);
            return false;
        }
        const layer = this.playLayerNode();
        if (!layer) {
            this.releaseReservation(info, bf);
            return false;
        }

        // ① 先建好「战场样式」卡牌（先隐藏）：只为量宽度 + 预热资源，翻面那一瞬才显示。
        //    法术不进入战场，直接复用当前手牌卡完成中央展示，因此不需要 fieldCard。
        let fieldCard: Node | null = null;
        if (!isSpell) {
            const tempName = 'Play_' + id.replace(/[^\w]/g, '_') + '_' + (this._seq++);
            fieldCard = composer.composeCard(id, tempName, undefined,
                { frameOverride: frame!, suppressCost: !bf.showCost }) as Node | null;
            if (!fieldCard || !fieldCard.isValid) {
                console.log(`[CardPlay] 起手失败：战场样式卡牌生成不出来（id=${id}、frame=${frame}）。`);
                this.releaseReservation(info, bf);
                return false;
            }
            fieldCard.setParent(layer, true);      // 保世界变换搬进专图层
            fieldCard.active = false;              // 翻面之前不显示
        }

        // ② 提交：手牌卡牌搬进专图层（保世界变换），并从手牌集合里摘除
        const handIndex = Math.max(0, hand.cards.indexOf(card));
        card.setParent(layer, true);
        if (!alreadyReleased && !hand.releaseCard(card)) {
            // 理论上不会发生（前面已经确认它在手牌里）；兜底把两张卡清掉，让 HandDrag 走回位
            if (fieldCard) killNode(fieldCard);
            this.releaseReservation(info, bf);
            return false;
        }

        this._busy = true;
        this._handCard = card;
        this._fieldCard = fieldCard;
        this._id = id;
        this._isSpell = isSpell;
        this.lockDrag(true);

        this.consumeReservation(info);

        // ★ 需求（Task 2）：**打出这一刻**就把「入场曲要召唤的牌」从牌组预扣掉 ——
        //    这样战场状态栏的牌组数字在**打出瞬间**就跳到最终值，而不是等召唤演出时才变。
        //    召唤能力结算时优先消费这里预扣的卡（见 CardAbilitySystem.summonCards）。
        try { this._preSummon = preTakeSummons(this, id, 'player'); } catch (e) {
            console.error('[CardPlay] 预扣召唤卡失败：', e);
            this._preSummon = [];
        }

        // 🔴🔴 「确定使用」这一刻 = 这张牌的去向 + 它的能力都已经定死（玩家与系统都不能再改）⇒
        //     **逻辑当场结算**，一切演出照旧按动画时序播：
        //       · 法术：卡本身此刻就进墓场（不等它在屏幕上消失）；
        //       · 法术的 use 触发能力（当前只有 DrawCards）：当场抽牌 —— 牌堆立即 -N、
        //         手牌逻辑立即 +N（抽卡动画由 CardDraw 延后到本次打出演出收尾再播，
        //         所以计数器不会再出现「先掉一张再补回来」的中间过程）。
        // 排队打出（useResolved=true）的已在**入队那一刻**结算过，这里绝不能重复结算。
        //
        // 🔴 **例外：需要选目标的法术**（`use` 触发的能力带 params.select，如卡 7「钢铁穹顶」）——
        //    目标还没选，不能在这里结算；它要和随从的入场曲一样**先停到摄像头左上角等玩家点选**，
        //    选中后才 `resolveSpellUseNow(id, target)`（见 onFanfarePicked）。
        const spellTarget = isSpell ? this.spellTargetRequest(id) : null;
        if (isSpell && !useResolved && !spellTarget) this.resolveSpellUseNow(id);

        // ②.5 「先选目标」（需求）：场上存在合法候选 → 卡牌先停到**摄像头左上角**
        //      等玩家点选，选中才结算（随从：进战场后结算入场曲；法术：当场结算 use 能力），
        //      点其它地方则**回到手牌**（不消耗费用）。
        //      场上没有合法候选 → 按需求**直接正常结算 / 进入战场**（下图走到第 ③ 步）。
        if (!isSpell) {
            const req = cardTargetRequest(id, ['fanfare']);
            const sys = req ? this.selectSystem() : null;
            const candidates = (req && sys) ? sys!.candidatesFor('player', req.select, req.filter) : [];
            // ★ 「模式」（select:'mode'）：**选择对象是选项而不是卡牌** ⇒ 不能用「有没有随从候选」来判断，
            //   只要有选项就进入选择模式（卡牌照旧先飞到左上角，与卡牌 4 同一条流程）。
            const isMode = !!req && req.select === 'mode' && modeOptionTexts(id).length > 0;
            if (req && (isMode || (sys && candidates.length > 0))) {
                this._fanfare = { select: req.select, filter: req.filter, trigger: 'fanfare' };
                this._fanfareTarget = null;
                this._handIndex = handIndex;
                this.moveToFanfareCorner(layer, card, baseScale, () => this.beginFanfareSelect());
                return true;
            }
        } else if (spellTarget && !useResolved) {
            this._fanfare = { select: spellTarget.select, filter: spellTarget.filter, trigger: 'use' };
            this._fanfareTarget = null;
            this._handIndex = handIndex;
            this.moveToFanfareCorner(layer, card, baseScale, () => this.beginFanfareSelect());
            return true;
        }

        // ③ 第一步：移到屏幕正中 + 放大 + 摆正
        const center = this.centerLocal(layer).clone();
        const targetScale = Math.max(0.01, baseScale * Math.max(0.01, this.centerScale));
        const z = card.position.z;
        const toPos = new Vec3(center.x, center.y, z);
        const toScale = new Vec3(targetScale, targetScale, card.scale.z);
        const dur = Math.max(0, this.moveDuration);

        const afterMove = () => this.hold();
        if (dur <= 0) {
            card.setPosition(toPos);
            card.setScale(toScale);
            card.setRotationFromEuler(0, 0, 0);
            afterMove();
        } else {
            tween(card)
                .to(dur, { position: toPos, scale: toScale, eulerAngles: new Vec3(0, 0, 0) },
                    { easing: 'quadOut' })
                .call(afterMove)
                .start();
        }
        return true;
    }

    /** 第一步收尾：在屏幕正中停留 holdDuration 秒，然后开始第二步 */
    private hold(): void {
        this.clearHoldTimer();
        this._holdTimer = setTimeout(() => {
            this._holdTimer = null;
            if (this._busy) this.launch();
        }, Math.max(0, this.holdDuration) * 1000);
    }

    // ====================== 入场曲：停在左上角 → 等玩家选目标 ======================

    /** 把卡牌移到**摄像头左上角**（保世界变换已在专图层里），到位后进入选择模式 */
    private moveToFanfareCorner(layer: Node, card: Node, baseScale: number, onArrive: () => void): void {
        const targetScale = Math.max(0.01, baseScale * Math.max(0.05, this.fanfareCornerScale));
        const pos = this.fanfareCornerLocal(layer, card, targetScale);
        const dur = Math.max(0, this.moveDuration);
        if (dur <= 0) {
            card.setPosition(pos);
            card.setScale(targetScale, targetScale, card.scale.z);
            card.setRotationFromEuler(0, 0, 0);
            onArrive();
            return;
        }
        tween(card)
            .to(dur, {
                position: pos,
                scale: new Vec3(targetScale, targetScale, card.scale.z),
                eulerAngles: new Vec3(0, 0, 0),
            }, { easing: 'quadOut' })
            .call(() => onArrive())
            .start();
    }

    /**
     * 「摄像头左上角」在专图层本地坐标下的位置（卡牌中心贴住左上角 + `fanfareCornerMargin` 留白）。
     * 专图层是 1280×720、锚点中心，与 UI 相机的可视区（半宽 640 / 半高 360）一致，
     * 因此左上角 = (-halfW, +halfH)。
     */
    private fanfareCornerLocal(layer: Node, card: Node, scale: number): Vec3 {
        const ut = card.getComponent(UITransform);
        const w = (ut ? ut.contentSize.width : 200) * scale;
        const h = (ut ? ut.contentSize.height : 260) * scale;
        const lut = layer.getComponent(UITransform);
        const halfW = lut ? lut.contentSize.width / 2 : 640;
        const halfH = lut ? lut.contentSize.height / 2 : 360;
        const m = Math.max(0, this.fanfareCornerMargin);
        return new Vec3(-halfW + w / 2 + m, halfH - h / 2 - m, card.position.z);
    }

    /** 到位后进入选择模式（合法候选随从亮起选择光圈） */
    private beginFanfareSelect(): void {
        if (!this._busy || !this._fanfare) return;
        const sys = this.selectSystem();
        const select = this._fanfare.select;
        const filter = this._fanfare.filter;
        const isSpell = this._fanfare.trigger === 'use';
        // ★ 「模式」（关键字）：选择对象**不是卡牌而是选项** —— 屏幕中央列选项（ModeSelectPanel）。
        //   卡牌本身照旧先飞到左上角（与卡牌 4 完全同一条流程，上面已经做完）。
        if (select === 'mode') {
            const panel = ModeSelectPanel.instance;
            const texts = modeOptionTexts(this._id);
            const startedMode = !!panel && texts.length > 0 && panel.begin(
                texts,
                (index: number) => this.onFanfareModePicked(index),
                (reason: string) => this.onFanfareCancelled(reason),
            );
            if (!startedMode) {
                if (this.verbose) console.log(`[CardPlay] 模式选择未能开始（${this._id}）→ 直接结算（取第一个选项）`);
                this._fanfareTarget = null;
                this._fanfareMode = -1;
                this.scheduleFanfareEnter(0);
                return;
            }
            this._awaitingTarget = true;
            console.log(`[CardPlay] ${this._id} 等待选择「模式」选项（${texts.length} 个）—— 点选项发动；点其它地方则回手`);
            return;
        }
        const started = !!sys && sys!.begin({
            owner: 'player',
            select,
            filter,
            onPicked: (card: Node) => this.onFanfarePicked(card),
            onCancelled: (reason: string) => this.onFanfareCancelled(reason),
        });
        if (!started) {
            // 选择系统不可用 / 目标在等待期间消失 → 按正常流程直接结算（法术当场结算，随从进入战场）
            if (this.verbose) console.log(`[CardPlay] ${isSpell ? '法术' : '入场曲'}选择未能开始（${this._id}）→ 直接结算`);
            this._fanfareTarget = null;
            if (isSpell) {
                this.resolveSpellUseNow(this._id);
                this._fanfare = null;
                this.scheduleFanfareEnter(0);
            } else {
                this.scheduleFanfareEnter(0);
            }
            return;
        }
        this._awaitingTarget = true;
        console.log(`[CardPlay] ${this._id} 的${isSpell ? '法术' : '入场曲'}等待选择目标（${select}`
            + `${filter ? ' / ' + filter : ''}）—— 点选合法随从；点其它地方则回手`);
    }

    /** ★ 「模式」选项被选中：记录索引 → 照常翻转飞行入战场（能力在落地后按该索引结算） */
    private onFanfareModePicked(index: number): void {
        if (!this._busy) return;
        this._awaitingTarget = false;
        this._fanfareMode = Math.max(0, Math.round(index));
        this._fanfareTarget = null;
        if (this.verbose) console.log(`[CardPlay] 模式已选中第 ${this._fanfareMode + 1} 个选项 → ${this._id} 进入战场`);
        this.scheduleFanfareEnter(this.fanfareEnterDelay);
    }

    /** 玩家**成功选中**目标 → 随从：记录目标，随即飞入战场（入场曲在落地后结算）；法术：当场结算 use 能力 */
    private onFanfarePicked(card: Node): void {
        if (!this._busy) return;
        this._awaitingTarget = false;
        this._fanfareTarget = (card && card.isValid) ? card : null;
        const isSpell = this._isSpell;
        if (this.verbose) {
            console.log(`[CardPlay] ${isSpell ? '法术' : '入场曲'}已选中 `
                + `${this._fanfareTarget ? this._fanfareTarget.name : '（目标无效）'}`
                + ` → ${isSpell ? this._id + ' 结算 use 能力' : this._id + ' 进入战场'}`);
        }
        if (isSpell) {
            // 🔴 法术：「选中」这一刻才结算 use 能力（墓场记账 + 能力），随后走原有的法术收尾演出
            //    （中央展示 → 消失那一刻炸法术圈 → 手牌收紧）。`_fanfare` 随即清掉，
            //    免得 finish() 之外的路径再走一次选择分支。
            this._fanfare = null;
            this.resolveSpellUseNow(this._id, this._fanfareTarget);
        }
        this.scheduleFanfareEnter(this.fanfareEnterDelay);
    }

    /** 玩家点了其它地方 → **不算使用**：卡牌回到手牌、费用返还、战场预留释放 */
    private onFanfareCancelled(reason: string): void {
        if (!this._busy) return;
        this._awaitingTarget = false;
        console.log(`[CardPlay] ${this._isSpell ? '法术' : '入场曲'}选择取消（${reason}）→ ${this._id} 回到手牌（不消耗费用）`);
        this.returnFanfareCardToHand();
    }

    /** 延迟一小段后开始「翻转飞行入战场」（与 hold() 共用同一个定时器槽位） */
    private scheduleFanfareEnter(delay: number): void {
        this.clearHoldTimer();
        this._holdTimer = setTimeout(() => {
            this._holdTimer = null;
            if (this._busy) this.launch();
        }, Math.max(0, delay) * 1000);
    }

    /**
     * 把「等选择」中被打回的卡**放回手牌原位**，并退还费用。
     * 🔴 这是「不算使用」的唯一合法收尾：手牌计数回到打出前，费用回到打出前，
     *    战场槽位预留由 `finish()` 释放。
     */
    private returnFanfareCardToHand(): void {
        const card = this._handCard;
        const fieldCard = this._fieldCard;
        const id = this._id;
        const index = this._handIndex;
        const info = id ? getCardInfo(id) : undefined;

        this._handCard = null;
        this._fieldCard = null;
        this._id = '';
        this._isSpell = false;
        this._fanfare = null;
        this._fanfareTarget = null;

        try {
            if (fieldCard && fieldCard.isValid) killNode(fieldCard);
            const hand = this.resolveHand();
            if (card && card.isValid && hand) {
                card.setParent(hand.node, true);
                hand.adoptCardAt(card, id, index);
                // 🔴 必须**整片重排**（`tweenHandRest`），不能只补间被打回的这一张：
                //    它插回原位后右侧邻卡都要往右让位，只动它一张 ⇒ 它会停在邻卡当前所在的
                //    槽位上 → 视觉上「盖在右边的卡牌上」（实测就是这个 bug）。
                //    整片补间里 `hand.cards` 的顺序与 `currentTargets()` 一一对应，回手的这张
                //    也一并被送到它自己的槽位；`dur <= 0` 时等同瞬时落位。
                const dur = Math.max(0, this.tweenHandReturnDuration);
                this.tweenHandRest(dur);
            } else if (card && card.isValid) {
                killNode(card);
            }
        } catch (e) {
            console.error('[CardPlay] 入场曲取消回手出错：', e);
        } finally {
            if (info) refundPP(this.node, 'player', info.cost, 'CardPlay');
            this.finish();
        }
    }

    /** 终止「入场曲等待选择」（组件被关掉 / 重开对局时用；幂等） */
    private cancelFanfareSelect(): void {
        this._awaitingTarget = false;
        const sys = this._selectCache;
        if (!sys || !sys.isValid || !sys.isSelecting) return;
        try { sys.cancel('打出流程结束'); } catch (e) { /* 忽略 */ }
    }

    /** 选择模式组件（挂在 Canvas 上；懒查找 + 缓存） */
    private selectSystem(): TargetSelectSystem | null {
        if (this._selectCache && this._selectCache.isValid) return this._selectCache;
        const scene = this.node.scene as unknown as Node | null;
        if (!scene) return null;
        const stack: Node[] = [...scene.children];
        while (stack.length > 0) {
            const cur = stack.shift() as Node;
            const c = cur.getComponent(TargetSelectSystem);
            if (c) { this._selectCache = c; return c; }
            for (const ch of cur.children) stack.push(ch);
        }
        this._selectCache = null;
        return null;
    }

    /**
     * 第二步：翻转 + 贝塞尔飞行入战场，并行跑「手牌重排」「战场重排」，三者共用 travelDuration。
     */
    private launch(): void {
        // 防御调度器重复触发：一次使用只能进入一个结算分支。
        if (!this._busy) return;
        const layer = this._playLayer;
        const hand = this.resolveHand();
        const bf = this.resolveField();
        const card = this._handCard;
        const fieldCard = this._fieldCard;

        if (!hand || !card || !card.isValid) {
            console.log('[CardPlay] 飞行起手条件不满足，已中止。');
            this.finish();
            return;
        }

        // 法术：展示完成后不飞入战场，直接从屏幕正中消失；手牌其余卡同时收紧。
        if (this._isSpell) {
            this.launchSpell(hand, card);
            return;
        }

        if (!layer || !layer.isValid || !bf || !fieldCard || !fieldCard.isValid) {
            console.log('[CardPlay] 飞行起手条件不满足，已中止。');
            this.finish();
            return;
        }

        // 战场「最右一格」的目标位：把新卡宽度一并算进去（整排会一起让位）
        const extraW = nodeWidth(fieldCard) * bf.cardScale;
        const targets = bf.computeTargets(extraW);
        const targetFieldLocal = targets.length > 0 ? targets[targets.length - 1] : new Vec3(0, 0, 0);

        // 战场本地坐标 → 专图层本地坐标（两点都在同一父链下，用世界坐标做桥）
        const p0 = card.position.clone();
        const p2 = this.fieldLocalToLayerLocal(layer, bf, targetFieldLocal);
        const p1 = bezierControl(p0, p2, this.arcHeight, new Vec3());

        const dur = Math.max(0.0001, this.travelDuration);
        const cur = new Vec3();

        // 并行：手牌其余卡牌 → 少一张后的新扇形；战场现有卡牌 → 多一张后的新排布
        this.tweenHandRest(dur);
        this.tweenFieldRest(bf, dur, extraW);

        // 换脸标记：翻到 ±90°（宽度为零、看不见）那一瞬，销毁手牌卡牌、换成战场样式卡牌
        let swapped = false;
        const swap = () => {
            if (swapped) return;
            swapped = true;
            if (card.isValid) killNode(card);
            if (fieldCard.isValid) {
                fieldCard.active = true;
                toFront(fieldCard);
            }
        };

        const drive = { t: 0 };
        // 🔴 onUpdate 里出错会被 TweenSystem 吞掉 → 流程永远收不了尾（见 land() 的注释）。
        //    这里做一个一次性熔断：出错就停补间 + 立即换脸落地，保证状态机一定能复位。
        let aborted = false;
        const abort = (e: unknown) => {
            if (aborted) return;
            aborted = true;
            console.error('[CardPlay] 飞行补间出错，本次打出已中止：', e);
            Tween.stopAllByTarget(drive);
            swap();
            this.land(bf);
        };

        tween(drive)
            .to(dur, { t: 1 }, {
                easing: 'sineInOut',
                onUpdate: (tgt?: object) => {
                    try {
                        const t = (tgt as { t: number } | undefined)?.t ?? 0;
                        if (t < 0.5) {
                            // 前半程：手牌卡牌 0° → +90°，同时沿贝塞尔飞到半程点
                            if (!card.isValid) return;
                            bezierAt(p0, p1, p2, t, cur);
                            card.setPosition(cur);
                            card.setRotationFromEuler(0, 90 * (t / 0.5), 0);
                        } else {
                            // 后半程：换脸后 战场卡牌 -90° → 0°，继续飞完全程
                            swap();
                            if (!fieldCard.isValid) return;
                            bezierAt(p0, p1, p2, t, cur);
                            fieldCard.setPosition(cur);
                            fieldCard.setRotationFromEuler(0, -90 + 90 * ((t - 0.5) / 0.5), 0);
                        }
                    } catch (e) {
                        abort(e);
                    }
                },
            })
            .call(() => {
                if (aborted) return;
                swap();          // 兜底：确保换脸一定发生过
                this.land(bf);
            })
            .start();
    }

    /**
     * 法术「确定使用」那一刻的**逻辑结算**（在 play() 里调用，早于一切演出）：
     *   ① 卡本身进墓场（法术用掉即离场）；
     *   ② use 触发的能力（抽牌 / 需要选目标的效果）当场结算 —— 牌堆立即 -N、手牌逻辑立即 +N。
     * 🔴 只做逻辑：法术圈特效、手牌收紧、抽卡动画仍按各自的动画时序播。
     * @param target 需要选目标的法术在「先选目标」流程里选好的随从（普通法术为 null）
     */
    private resolveSpellUseNow(id: string, target: Node | null = null): void {
        addToGrave(this.node, 'player', id);
        try {
            runCardUseAbilities(this, id, 'player', null, target);
        } catch (e) {
            console.error(`[CardPlay] 法术使用能力结算失败（id=${id}）：`, e);
        }
    }

    /**
     * 这张法术是否需要**玩家先选一个随从目标**（`use` 触发的能力带 params.select）。
     * 🔴 与随从的入场曲同一口径：**场上存在合法候选**才算「需要选」；没有候选就按正常流程直接结算。
     * @returns 需要选 → `{ select, filter }`；否则 null
     */
    private spellTargetRequest(id: string): { select: string; filter: string } | null {
        const req = cardTargetRequest(id, ['use']);
        if (!req) return null;
        const sys = this.selectSystem();
        if (!sys) return null;
        const candidates = sys.candidatesFor('player', req.select, req.filter);
        if (candidates.length === 0) {
            if (this.verbose) {
                console.log(`[CardPlay] ${id} 需要选目标但没有合法候选（${req.select}`
                    + `${req.filter ? ' / ' + req.filter : ''}）→ 直接结算`);
            }
            return null;
        }
        return { select: req.select, filter: req.filter };
    }

    /**
     * 法术第二步：不进入战场，只让手牌重排并在 travelDuration 收尾时销毁展示卡。
     * 🔴 法术的墓场记账与 use 能力已在「确定使用」那一刻结算完毕（见 resolveSpellUseNow），
     *    这里只收尾，绝不重复结算。
     */
    private launchSpell(hand: HandLayout, card: Node): void {
        const dur = Math.max(0, this.travelDuration);
        this.tweenHandRest(dur);
        this.spawnSpellFx(card);        // 🔴 卡牌消失那一刻炸法术圈（与能力时机无关）
        if (card.isValid) killNode(card);
        this._handCard = null;
        this.finish();
    }

    /**
     * 法术展示卡「消失那一刻」的法术特效。
     *
     * 🔴 触发点只与**卡牌消失**同步，与能力结算时机无关（`runCardUseAbilities` 是在
     *    setTimeout 里另外跑的，特效不参与、也不等它）。
     * 🔴 卡牌马上要被销毁，所以必须**先捕获**父节点 / 局部坐标 / 显示尺寸，再把特效挂到
     *    **持久的打出专图层**上；如果把特效当卡牌子节点，会随卡一起被销毁。
     */
    private spawnSpellFx(card: Node): void {
        if (!this.spellCastFxOnUse) return;
        if (!card || !card.isValid) return;
        const parent = card.parent;
        if (!parent || !parent.isValid) return;
        const pos = card.position.clone();
        const ut = card.getComponent(UITransform);
        const sx = Math.abs(card.scale.x) || 1;
        const sy = Math.abs(card.scale.y) || 1;
        const w = ut ? ut.contentSize.width * sx : 0;
        const h = ut ? ut.contentSize.height * sy : 0;
        playSpellCastOrb(parent, pos, Math.max(w, h, 120));
    }

    /**
     * 第二步收尾：把战场样式卡牌收编进战场（保世界变换），战场按新集合落定。
     *
     * 🔴 必须用 try/finally 包住：本方法是挂在 tween 的 CallFunc 上跑的，
     *    回调里抛出的异常会被 TweenSystem 吞掉（只在浏览器里弹一个红框、控制台看不到），
     *    结果 `_busy` / `enableDrag` **永久卡在「播放中」**，之后所有手牌都拖不动，
     *    而且必须手动刷新页面才能恢复。实测踩过一次：`adoptCard` 里误写成 `node.setName()`
     *    （Node 没这个方法）就是这样 —— 报错信息只出现在页面红框里，非常隐蔽。
     */
    private land(bf: BattleFieldLayout): void {
        const fieldCard = this._fieldCard;
        const id = this._id;
        try {
            if (fieldCard && fieldCard.isValid) {
                fieldCard.setRotationFromEuler(0, 0, 0);
                if (!bf.adoptCard(fieldCard, id)) {
                    console.log(`[CardPlay] 收编失败：战场已满或卡牌不合法（id=${id}）。`);
                    killNode(fieldCard);
                } else {
                    runCardPassiveAbilities(this, id, 'player', fieldCard);
                    this.notifyCardEntered(fieldCard, this._handCard);
                    // 🔴 入场曲：进入战场那一刻结算（target = 选择流程里已选好的随从，可为 null）。
                    //    没有可选目标（对方场上没有随从）时照常入场，能力自己跳过目标分支。
                    runCardFanfareAbilities(this, id, 'player', fieldCard, this._fanfareTarget);
                }
            }
        } catch (e) {
            console.error(`[CardPlay] 收编进战场时出错（id=${id}）：`, e);
            // 收编中途失败 → 别让这张卡挂在半路上（已经进了战场就留给战场管）
            if (fieldCard && fieldCard.isValid && fieldCard.parent !== bf.node) killNode(fieldCard);
        } finally {
            this.finish();
            runCardUseAbilities(this, id, 'player', fieldCard);
        }
    }

    /** 全流程收尾：清状态、恢复拖拽开关 */
    private finish(): void {
        const wasSpell = this._isSpell;
        this._busy = false;
        this.clearHoldTimer();
        this._handCard = null;
        this._fieldCard = null;
        this._id = '';
        this._isSpell = false;
        // 入场曲的等待状态一并复位（防止「等待中」的标记泄漏到下一次打出）
        this._fanfare = null;
        this._fanfareTarget = null;
        this._awaitingTarget = false;
        if (!wasSpell) this._reservedFieldSlots = Math.max(0, this._reservedFieldSlots - 1);
        this.lockDrag(false);
        if (this._queue.length > 0) this.scheduleQueueNext(0);
    }

    private clearHoldTimer(): void {
        if (this._holdTimer !== null) {
            clearTimeout(this._holdTimer);
            this._holdTimer = null;
        }
    }

    private scheduleQueueNext(delay = 0): void {
        if (this._queueTimer !== null) return;
        this._queueTimer = setTimeout(() => {
            this._queueTimer = null;
            this.tryStartNextQueued();
        }, Math.max(0, delay));
    }

    private clearQueueTimer(): void {
        if (this._queueTimer !== null) {
            clearTimeout(this._queueTimer);
            this._queueTimer = null;
        }
    }

    /** 抽牌动画会重排手牌；它未收尾前不启动下一张队列卡，避免两套排布互踩。 */
    private isHandAnimationBusy(): boolean {
        const cd = this.getComponent('CardDraw') as { isDrawing?: boolean } | null;
        return !!(cd && cd.isDrawing);
    }

    private notifyCardEntered(card: Node, fromHand: Node | null = null): void {
        const scene = this.node.scene as unknown as Node | null;
        if (!scene) return;
        const stack: Node[] = [...scene.children];
        while (stack.length > 0) {
            const cur = stack.shift() as Node;
            const kw = cur.getComponent('CardKeywordSystem') as any;
            if (kw) {
                // ① 「奥义 / 解放奥义」的奥义槽要在**打出后**读到手牌期间的状态：
                //    战场卡是另建的新节点，这里把「进入手牌那一刻」的进化计数快照搬过去。
                if (fromHand && typeof kw.carryHandState === 'function') kw.carryHandState(fromHand, card);
                // ② 入场光环（友方随从入场增益等）
                if (typeof kw.onCardEnteredBattlefield === 'function') kw.onCardEnteredBattlefield(card);
                return;
            }
            for (const ch of cur.children) stack.push(ch);
        }
    }

    // ------------------------------ 并行重排（与飞行同一总时长）-----------------------------
    /** 手牌其余卡牌：从当前位置 tween 到「少一张」之后的新扇形目标位 */
    private tweenHandRest(dur: number): void {
        const hand = this.resolveHand();
        if (!hand) return;
        const targets = hand.currentTargets();
        const cards = hand.cards;
        const dragging = this.resolveDrag()?.draggingCard || null;
        for (let i = 0; i < targets.length && i < cards.length; i++) {
            const node = cards[i];
            if (!node || !node.isValid) continue;
            // 正在被用户拖拽的卡保持当前拖拽姿态；它仍留在 HandLayout.cards 中，
            // 因此 targets 仍为它保留严格的原手牌顺序槽位。
            if (dragging && node === dragging) continue;
            const t = targets[i];
            node.setSiblingIndex(t.sibling);            // 层序先排好，避免穿插错乱
            if (dur <= 0) {
                node.setPosition(t.pos);
                node.setRotationFromEuler(t.euler);
                node.setScale(t.scale);
            } else {
                tween(node)
                    .to(dur, {
                        position: t.pos.clone(),
                        eulerAngles: t.euler.clone(),
                        scale: t.scale.clone(),
                    }, { easing: 'sineInOut' })
                    .start();
            }
        }
    }

    /** 战场现有卡牌：从当前位置 tween 到「最右多一张」之后的新排布 */
    private tweenFieldRest(bf: BattleFieldLayout, dur: number, extraW: number): void {
        const targets = bf.computeTargets(extraW);
        const cards = bf.cards;
        for (let i = 0; i < cards.length && i < targets.length; i++) {
            const node = cards[i];
            if (!node || !node.isValid) continue;
            const t = targets[i];
            if (dur <= 0) node.setPosition(t);
            else tween(node).to(dur, { position: t.clone() }, { easing: 'sineInOut' }).start();
        }
    }

    // ------------------------------ 专图层 & 坐标 ------------------------------
    /** 取/建打出专图层（Canvas 下的动态节点，始终置顶） */
    private playLayerNode(): Node | null {
        if (this._playLayer && this._playLayer.isValid) {
            toFront(this._playLayer);
            return this._playLayer;
        }
        const canvas = this.canvasNode();
        if (!canvas) return null;
        const n = new Node('CardPlayLayer');
        n.setParent(canvas);
        const ut = n.addComponent(UITransform);
        ut.setAnchorPoint(0.5, 0.5);
        ut.setContentSize(1280, 720);
        n.setPosition(0, 0, 0);       // Canvas 局部原点 = 屏幕正中心（相机注视点）
        this._playLayer = n;
        toFront(n);
        return n;
    }

    /** 屏幕正中（= UI 相机注视点的世界坐标）在专图层本地坐标下的位置 */
    private centerLocal(layer: Node): Vec3 {
        const cam = this.uiCamera();
        const ut = layer.getComponent(UITransform);
        if (cam) {
            const wp = cam.node.worldPosition;
            Vec3.set(_worldScratch, wp.x, wp.y, 0);
            return ut ? ut.convertToNodeSpaceAR(_worldScratch, _centerOut) : _centerOut.set(wp.x, wp.y, 0);
        }
        return _centerOut.set(0, 0, 0);
    }

    /** 战场本地坐标 → 专图层本地坐标 */
    private fieldLocalToLayerLocal(layer: Node, bf: BattleFieldLayout, fieldLocal: Vec3): Vec3 {
        const but = bf.node.getComponent(UITransform);
        const lut = layer.getComponent(UITransform);
        if (!but || !lut) return fieldLocal.clone();
        but.convertToWorldSpaceAR(fieldLocal, _worldScratch);
        return lut.convertToNodeSpaceAR(_worldScratch, new Vec3());
    }

    /** 卡牌中心在 **Canvas 局部坐标系** 下的 Y（0 = 屏幕垂直中心，越往上越大） */
    private canvasY(node: Node): number {
        const canvas = this.canvasNode();
        const ut = canvas ? canvas.getComponent(UITransform) : null;
        const wp = node.worldPosition;
        if (!ut) return wp.y;
        Vec3.set(_worldScratch, wp.x, wp.y, 0);
        return ut.convertToNodeSpaceAR(_worldScratch, _canvasLocal).y;
    }

    // ------------------------------ 依赖解析 ------------------------------
    private resolveHand(): HandLayout | null {
        if (this.handLayout && this.handLayout.isValid) return this.handLayout;
        return this.getComponent(HandLayout);
    }

    private resolveDrag(): HandDrag | null {
        if (this.handDrag && this.handDrag.isValid) return this.handDrag;
        return this.getComponent(HandDrag);
    }

    /** 战场布局：优先 Inspector 指定，其次本节点/子节点，最后整场景兜底找 BattleFieldLayout */
    private resolveField(): BattleFieldLayout | null {
        if (this.battlefield && this.battlefield.isValid) return this.battlefield;
        const scene = this.node.scene as unknown as Node | null;
        if (scene) {
            const stack: Node[] = [...scene.children];
            while (stack.length > 0) {
                const cur = stack.shift() as Node;
                const c = cur.getComponent(BattleFieldLayout);
                if (c) { this.battlefield = c; return c; }
                for (const ch of cur.children) stack.push(ch);
            }
        }
        return null;
    }

    /** 取本节点所属的 Canvas（沿 parent 链向上找） */
    private canvasNode(): Node | null {
        let n: Node | null = this.node;
        while (n) {
            if (n.getComponent(Canvas)) return n;
            n = n.parent;
        }
        return null;
    }

    /** 取 UI 相机（Canvas 上那台；本引擎的 Node 没有 getComponentInParent，只能手动沿父链找） */
    private uiCamera(): Camera | null {
        if (this._cam && this._cam.isValid) return this._cam;
        let n: Node | null = this.node;
        while (n) {
            const cv = n.getComponent(Canvas) as unknown as
                { camera?: Camera | null; cameraComponent?: Camera | null } | null;
            if (cv) {
                this._cam = cv.cameraComponent || cv.camera || null;
                if (this._cam) return this._cam;
            }
            n = n.parent;
        }
        return null;
    }

    // ------------------------------ 工具 ------------------------------
    /** 取某张手牌对应的卡牌 id：优先问 HandLayout，退化为从节点名反推（Card_2.png_2 → 2.png） */
    private idOf(card: Node, hand: HandLayout): string {
        const byHand = hand.cardIdOf(card);
        if (byHand) return byHand;
        const m = /^Card_(.+?)(?:_\d+)?$/.exec(card.name);
        return m ? m[1] : '';
    }

    /** 打出过程中禁用/恢复手牌拖拽 */
    private lockDrag(on: boolean): void {
        if (this.allowQueuedPlay) return;
        if (!this.lockDragWhilePlaying) return;
        const drag = this.resolveDrag();
        if (!drag) return;
        if (on) {
            this._prevEnableDrag = drag.enableDrag;
            drag.enableDrag = false;
        } else {
            drag.enableDrag = this._prevEnableDrag;
        }
    }
}

// ------------------------------ 模块内部工具 ------------------------------
const _worldScratch = new Vec3();
const _centerOut = new Vec3();
const _canvasLocal = new Vec3();

// ====================== PP（费用）工具：我方 / 敌方打出共用 ======================
// 与 TurnManager 同一约定：按类名字符串 BFS 查 TurnControlPanel，不静态 import 防循环依赖。
// PP 的权威数值存在 TurnControlPanel 的 enemyCurrentPP / playerCurrentPP 上。

/** BFS 找 TurnControlPanel（找不到返回 null） */
export function ppPanel(from: Node): any {
    const scene = from.scene as unknown as Node | null;
    if (!scene) return null;
    const stack: Node[] = [...scene.children];
    while (stack.length > 0) {
        const cur = stack.shift() as Node;
        const c = cur.getComponent('TurnControlPanel');
        if (c) return c;
        for (const ch of cur.children) stack.push(ch);
    }
    return null;
}

/** 某一方当前剩余 PP（面板缺失时返回 Number.POSITIVE_INFINITY → 判定恒放行，不挡测试） */
export function ppRemaining(from: Node, side: 'player' | 'enemy'): number {
    const p = ppPanel(from);
    if (!p) return Number.POSITIVE_INFINITY;
    return Math.max(0, Math.round(p[side + 'CurrentPP']));
}

/** 剩余 PP 是否 ≥ 费用（面板缺失 → 放行） */
export function canAffordPP(from: Node, side: 'player' | 'enemy', cost: number): boolean {
    return ppRemaining(from, side) + ppExtraCharge(from, side) >= Math.max(0, cost);
}
/**
 * 某一方当前可用的**额外费用**（点亮额外能量点 = 1，否则 0）。
 * 🔴 只用于「够不够用」的判断与最后补差额，**不写进 PP 显示**（能量点横幅/圆点始终保持真实剩余）。
 */
export function ppExtraCharge(from: Node, side: 'player' | 'enemy'): number {
    const p = ppPanel(from);
    if (!p || !p.extraCharge) return 0;
    const n = p.extraCharge(side);
    return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
}

/**
 * 扣除某一方 cost 点费用，并经 TurnControlPanel.setPP 更新右侧费用显示（数字 + PP 圆点）。
 * 🔴 额外费用**最后花**：先扣正常剩余 PP，只有当正常剩余不够时，才动用 1 点额外费用补差额
 *    （差额恒为 1，因为 canAffordPP 已保证 剩余 + 额外 ≥ 费用）；一旦动用，立即
 *    `consumeExtra()` → 状态切到 LockedExtraPP 并取消点亮。
 * 面板缺失时静默跳过（无显示也就无从扣起，不阻断打出流程）。
 */
export function spendPP(from: Node, side: 'player' | 'enemy', cost: number, tag: string): void {
    const c = Math.max(0, Math.round(cost));
    if (c <= 0) return;
    const p = ppPanel(from);
    if (!p || !p.setPP) return;
    const cur = Math.max(0, Math.round(p[side + 'CurrentPP']));
    const max = Math.max(0, Math.round(p[side + 'MaxPP']));
    const label = side === 'player' ? '我方' : '敌方';

    if (cur >= c) {
        // 常规路径：正常剩余足够 → 只扣正常费用，额外能量点不动
        p.setPP(side, cur - c, max);
        console.log(`[${tag}] ${label} 使用卡牌扣费 -${c} → 剩余 PP ${cur - c}/${max}`);
        return;
    }

    // 额外费用补差额（最后花）
    const extra = ppExtraCharge(from, side);
    const next = Math.max(0, cur - c);
    p.setPP(side, next, max);
    if (extra > 0) {
        if (p.consumeExtra) p.consumeExtra();
        // ★ 记下「这次真的动用了额外能量点」：万一这次打出被取消（入场曲/模式选择点空白回手），
        //   `refundPP` 要把它**一起还回来**（否则卡没打出去、跳费却没了 —— 实测 bug）。
        _extraSpentBySide[side] = true;
        console.log(`[${tag}] ${label} 使用卡牌扣费：正常剩余 ${cur} 不足（费用 ${c}）→`
            + ` 用掉 1 点**额外能量点**补差额 → 剩余 PP ${next}/${max}，额外能量点已消耗（→ LockedExtraPP）`);
    } else {
        console.warn(`[${tag}] ${label} 剩余 PP 不足且无额外能量点（费用 ${c}、剩余 ${cur}）`);
    }
}

/**
 * 本次打出是否动用了**额外能量点**（按方记录）。
 * 🔴 只有「已经消耗、但这次打出最终**没成立**（被取消回手）」时才需要回滚 —— 见 `refundPP`。
 */
const _extraSpentBySide: Record<'player' | 'enemy', boolean> = { player: false, enemy: false };

/**
 * 把某一方已经扣掉的 cost 点费用**退回来**（卡牌回到手牌 ⇒ 本次「不算使用」）。
 * 🔴 只退**普通 PP**（上限封顶）：此前若动用了额外能量点补差额，那 1 点不返还 ——
 *    额外能量点一旦点亮/消耗就有自己的状态机（LockedExtraPP），不在这里回滚。
 * 面板缺失时静默跳过（与 spendPP 同口径，不阻断主流程）。
 */
export function refundPP(from: Node, side: 'player' | 'enemy', cost: number, tag: string): void {
    const c = Math.max(0, Math.round(cost));
    const p = ppPanel(from);
    if (c > 0 && p && p.setPP) {
        const cur = Math.max(0, Math.round(p[side + 'CurrentPP']));
        const max = Math.max(0, Math.round(p[side + 'MaxPP']));
        const next = max > 0 ? Math.min(max, cur + c) : cur + c;
        p.setPP(side, next, max);
        console.log(`[${tag}] ${side === 'player' ? '我方' : '敌方'} 返还费用 +${c} → 剩余 PP ${next}/${max}（本次未使用）`);
    }
    // ★ 本次打出**动用了额外能量点**、但这张牌最终没打出去（被取消回手）⇒ 额外能量点**也要还回来**。
    //   （曾经只退普通 PP ⇒ 后手 7 费靠跳费打 8 费卡、取消选择后跳费白白没了 —— 实测 bug。）
    if (_extraSpentBySide[side]) {
        _extraSpentBySide[side] = false;
        const panel = p as unknown as { restoreExtra?: () => void } | null;
        if (panel && typeof panel.restoreExtra === 'function') {
            try {
                panel.restoreExtra();
                console.log(`[${tag}] ${side === 'player' ? '我方' : '敌方'} 额外能量点一并返还（本次未使用）`);
            } catch (e) {
                console.error('[CardPlay] 返还额外能量点失败：', e);
            }
        }
    }
}

/** 节点宽度（UITransform.contentSize.width）；EnemyCardPlay 复用 */
export function nodeWidth(n: Node): number {
    const ut = n.getComponent(UITransform);
    return ut ? ut.contentSize.width : 0;
}

/** 把节点提到父节点最上层；EnemyCardPlay 复用 */
export function toFront(n: Node): void {
    if (n.parent) n.setSiblingIndex(n.parent.children.length - 1);
}

/**
 * 二次贝塞尔的控制点：**两点中点 + 垂直于 P0→P2 的方向 × arcHeight**。
 * 垂直方向统一取「朝上」（y 分量 ≥ 0）的那一侧，因此正 arcHeight 恒为向上拱起。
 * （EnemyCardPlay 复用同一份实现，保证我方/敌方飞行轨迹公式完全一致。）
 */
export function bezierControl(p0: Vec3, p2: Vec3, arcHeight: number, out: Vec3): Vec3 {
    const mx = (p0.x + p2.x) / 2;
    const my = (p0.y + p2.y) / 2;
    const dx = p2.x - p0.x;
    const dy = p2.y - p0.y;
    const len = Math.hypot(dx, dy);
    let px: number;
    let py: number;
    if (len < 1e-6) {
        px = 0; py = 1;
    } else {
        px = -dy / len;
        py = dx / len;
    }
    if (py < 0) { px = -px; py = -py; }        // 统一朝上
    return out.set(mx + px * arcHeight, my + py * arcHeight, (p0.z + p2.z) / 2);
}

/** 二次贝塞尔取点 B(t) = (1-t)²P0 + 2(1-t)t·P1 + t²P2（EnemyCardPlay 复用） */
export function bezierAt(p0: Vec3, p1: Vec3, p2: Vec3, t: number, out: Vec3): Vec3 {
    const u = 1 - t;
    const a = u * u;
    const b = 2 * u * t;
    const c = t * t;
    return out.set(
        a * p0.x + b * p1.x + c * p2.x,
        a * p0.y + b * p1.y + c * p2.y,
        a * p0.z + b * p1.z + c * p2.z,
    );
}

// ============================================================================
// 「启动」能力要用的 PP 接口注入
// ============================================================================
/**
 * 🔴 `CardAbilitySystem` 的「启动」要读/扣能量点，而 PP 接口就定义在本文件里 ⇒
 *    直接把两个函数注入过去，**避免 CardPlay ↔ CardAbilitySystem 的循环 import**。
 *    本模块体在 `CardAbilitySystem` 之后执行（它先被本文件 import），所以注入一定早于任何玩法调用。
 */
injectPPApi({ ppRemaining, spendPP });
