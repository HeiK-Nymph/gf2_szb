import {
    _decorator, Camera, Canvas, Color, Component, EventTouch, Node, Tween, tween, UITransform,
    Vec2, Vec3,
} from 'cc';
import { BattleFieldLayout, BattleSide } from './BattleFieldLayout';
import { CardGlow, cardIdFromNodeName } from './CardGlow';
import { getCardInfo } from './CardData';
import { EvolveFollowerFx } from './EvolveFollowerFx';
import { HeroArea, HeroSide } from './HeroArea';
import { FollowerAttackAnim } from './FollowerAttackAnim';

const { ccclass, property, requireComponent, menu } = _decorator;

/**
 * BattleFieldPressGlow —— 战场「按住卡牌 → 外发光」交互
 * ===========================================================================
 * 挂在**我方战场节点**（PlayerBattleFieldArea，其上挂 BattleFieldLayout）上。
 *
 * 需求（逐条对应）：
 *   7. 只有**我方战场(PlayerBattleFieldArea)下的随从卡牌**能被按住触发；
 *      敌方战场(EnemyBattleFieldArea)下的所有随从卡牌拥有**同样的特效**（由本脚本驱动）。
 *   8. 在我方某张随从卡牌上按下并按住 → **被我方按住的这一张** + **敌方全部随从卡牌**一起发光。
 *   9. 按住期间把指针移出这张卡（拖走）**不会**取消效果；**只有松开/抬起**才结束。
 *  10. 被按住的那张卡牌 `position.y` 抬高 `liftY` 像素（Inspector 暴露），松手还原。
 *  10b. 按住期间 = **「选择攻击对象」模式**：
 *      · 移动到敌方某个**随从**卡牌上 → 该敌方随从**同样抬起**（高度 liftY 与
 *        抬起动画时长 liftDuration 和我方被按卡**完全一致**）；
 *      · 保持按住并离开它 → 立刻落回原高度；
 *      · 只要还在按住模式中，以上判定可**反复触发**（换目标、离开再回来都行）；
 *      · 松手 → 模式结束，敌方目标一并复位。
 *      （TOUCH_MOVE 只驱动「敌方攻击对象」的判定，**不参与、不影响**需求 9 的高亮——
 *       高亮一旦点亮就与移动完全无关。）
 *  10c. 松手 / 桌面预览的 TOUCH_CANCEL 若已有敌方目标，交给 BattleRuleSystem 结算对撞伤害；
 *      没有目标则只复位。
 *  11. 【回合门控】只有**我方操作回合**才允许按住 / 拖动我方战场上的随从；**敌方回合**里
 *      对我方随从按住完全无反应（不发光、不抬 Y、不进「选择攻击对象」模式）。
 *      按住途中若回合被切走（多指操作、API、结束回合）→ **立刻取消**并完整收尾。
 *      判据取 TurnManager.isPlayerTurn（权威）；找不到 TurnManager 或**尚未开战时放行**
 *      （fail-open —— 否则编辑器预览 / 单测里整个交互会哑掉）。开关：`playerTurnOnly`（默认开）。
 *
 * 为什么不监听「我方战场节点」本身，而是监听 Canvas：
 *   战场节点的 UITransform 尺寸不可控（默认 100×100），挂在它上面时「点在卡牌上」
 *   的事件可能根本不派发到它（Cocos 的 UI 事件需要落点在该节点的矩形内）。
 *   因此监听**整块 Canvas**（1280×720，必然是全覆盖的），再用卡牌自身的 UITransform
 *   做命中判定 —— 与 HandDrag「监听手牌区、再自行 pickCard」同一套路。
 *   想改成别的节点 → 填 `listenNode` 即可。
 *
 * 与其它系统的关系
 *   · 本组件只驱动高亮、抬起与目标选择；松手后把敌我随从交给 BattleRuleSystem 结算。
 *     战场集合的增删由规则系统调用 BattleFieldLayout.removeCardNode 完成，本组件不自行重建战场；
 *   · 命中判定只认「我方战场里的卡牌」，因此不会和手牌拖拽抢事件；
 *   · 抬 Y 用**独立补间对象**驱动（不 Tween.stopAllByTarget(卡牌)），
 *     避免误杀 CardPlay 正在播放的战场让位动画。
 * ===========================================================================
 */
@ccclass('BattleFieldPressGlow')
@requireComponent(UITransform)
@menu('gf2szb/BattleFieldPressGlow')
export class BattleFieldPressGlow extends Component {

    // ====================== 行为开关 ======================
    @property({ tooltip: '总开关：关闭后按住战场卡牌不再有任何反应' })
    enablePress = true;

    @property({ tooltip: '只允许「随从(Follower)」被按住触发（需求要求）。关闭则战场上的护符也能触发。' })
    followerOnly = true;

    @property({ tooltip: '按住时让**敌方战场**的全部随从卡牌一起发光（需求 8）。关闭则只亮被按住的那一张。' })
    glowOnEnemy = true;

    @property({
        tooltip: '只在**我方回合**允许按住 / 拖动我方战场随从（需求 11）。\n'
            + '打开（默认）：敌方回合时对我方随从按住**完全无反应**（不发光、不抬起、不进选择攻击对象模式）；\n'
            + '按住途中回合被切走也会立刻取消。\n'
            + '关闭 = 不按回合限制（调试用）。',
    })
    playerTurnOnly = true;

    // ====================== 被按住卡牌抬升（需求 10）======================
    @property({
        range: [0, 120, 1], slide: true,
        tooltip: '被按住的卡牌 `position.y` **向上抬高的像素**（需求 10 暴露的变量）。\n'
            + '0 = 不抬起。往上为正值（Cocos UI 坐标 y 向上）。',
    })
    liftY = 14;

    @property({ range: [0, 1, 0.01], slide: true, tooltip: '卡牌抬起 / 落回的补间时长（秒）。0 = 瞬间' })
    liftDuration = 0.12;

    /**
     * 🔴 **按下不等于进入选择模式**：按住后指针**移动超过这个距离**（UI 像素）才
     *    抬卡 + 点亮敌我随从（= 进入「选择攻击对象」模式）。
     *    按一下不动 → 什么都不发生（说明卡片接手），不会再出现「点一下随从就被
     *    抬起来 + 全场亮一次」的表现。
     */
    @property({ range: [0, 120, 1], slide: true, tooltip: '★按住后**移动多少像素才进入选择模式**。\n'
        + '按一下不动 = 只是点了一下（说明卡片用），不会抬卡/点亮。0 = 按下立刻进入（旧行为）。' })
    pressStartDistance = 12;

    // ====================== 依赖（都可留空自动查找）======================
    @property({
        type: Node,
        tooltip: '接收触摸事件的节点。留空 = 自动沿父链找 Canvas（推荐，战场节点自身矩形太小接不到事件）。',
    })
    listenNode: Node | null = null;

    @property({
        type: BattleFieldLayout,
        tooltip: '我方战场布局（side = Player）。留空 = 取本节点上的 BattleFieldLayout，再否则全场景找 side = Player 的那个。',
    })
    playerField: BattleFieldLayout | null = null;

    @property({
        type: BattleFieldLayout,
        tooltip: '敌方战场布局（side = Enemy）。留空 = 全场景找 side = Enemy 的那个（EnemyBattleFieldArea）。',
    })
    enemyField: BattleFieldLayout | null = null;

    // ====================== 可选的「统一覆盖」光晕样式 ======================
    // 光晕的外观参数真源在每张卡的 CardGlow 上（含品质配色）。下面这组只在
    // overrideStyle 打开时统一覆盖所有被本脚本驱动的卡 —— 想不改代码就全局调外观时用它。
    @property({
        tooltip: '用下面这组参数**统一覆盖**每张卡 CardGlow 的外观。\n'
            + '关闭（默认）= 直接用各卡 CardGlow 自己的 Inspector 值（含品质自动配色）。',
    })
    overrideStyle = false;

    @property({ range: [0, 64, 0.5], slide: true, tooltip: '（覆盖用）光晕厚度（卡框纹理像素）' })
    glowThickness = 40;

    @property({ range: [0, 1, 0.01], slide: true, tooltip: '（覆盖用）光晕柔和度 0..1' })
    glowSoftness = 0.7;

    @property({ range: [0, 4, 0.01], slide: true, tooltip: '（覆盖用）按住时达到的发光强度' })
    maxIntensity = 2.4;

    @property({ tooltip: '（覆盖用）是否按品质自动取色；关闭则用下面的 glowColor' })
    useQualityColor = true;

    @property({ type: Color, tooltip: '（覆盖用）光晕颜色（useQualityColor 关闭时使用）' })
    glowColor = new Color(255, 150, 46, 255);

    // ====================== 内部状态 ======================
    /** 正在被按住（= 效果生效中） */
    private _active = false;
    /** 本次按下的指针 id（-1 = 由 API 触发，不校验指针） */
    private _touchId = -1;
    /** 被按住的那张卡牌 */
    private _target: Node | null = null;
    /** 被按住卡牌的原始 Y（抬手时还原到它） */
    private _targetHomeY = 0;
    /** 本次点亮的卡牌（松手时只熄这些） */
    private readonly _lit: Node[] = [];
    /** 抬 Y 专用补间对象（独立于卡牌节点，避免误杀别人的补间） */
    private readonly _lift = { y: 0 };
    /**
     * 🔴 已按下、但还没拖够 `pressStartDistance` 的候选随从（null = 没有）。
     * 按下只登记候选，真正 `engage`（抬卡 + 点亮）要等 `onTouchMove` 里位移超阈值 ——
     * 「单击随从」只弹说明卡片，不再顺带进入选择模式。
     */
    private _pendingCard: Node | null = null;
    /** 候选卡的按下点（UI 坐标），用于位移判定 */
    private readonly _pendingUI = new Vec2();

    // ——「选择攻击对象」模式（按住移动，需求 10b）——
    /** 当前被抬起的敌方随从目标（null = 没有） */
    private _enemyTarget: Node | null = null;
    /** 本次按住期间每个被抬起过的敌方随从的原 Y（重复进出同一张时以首次记录为准，
     *  避免在落回补间中途再进入时把「半途的 Y」当成原位） */
    private readonly _enemyHomes: Map<Node, number> = new Map();
    /** 每张敌方目标**各自独立**的抬 Y 补间对象。
     *  🔴 不能共用一个：A→B 切换时 A 的「落下补间」会被 B 的「升起补间」
     *     stopAllByTarget 杀掉 → A 永远停在抬起高度（实测踩过）。 */
    private readonly _enemyLifts: Map<Node, { y: number }> = new Map();
    /** 缓存的 UI 相机 */
    private _cam: Camera | null = null;
    /** 缓存的两个战场 */
    private _pField: BattleFieldLayout | null = null;
    private _eField: BattleFieldLayout | null = null;
    private _eHero: Node | null = null;
    /** 已挂监听的事件节点 */
    private _listen: Node | null = null;
    /** TurnManager 引用缓存（BFS 是 O(n)，别每次触摸都重扫） */
    private _tmCache: any = null;
    /** 对战规则组件缓存（挂在本节点或场景中的 BattleRuleSystem）。 */
    private _ruleCache: any = null;
    /** 卡牌词条系统缓存。 */
    private _keywordCache: any = null;
    /** 攻击动画组件缓存（挂在本节点或场景中的 FollowerAttackAnim）。 */
    private _animCache: any = null;
    /** 操作指令队列组件缓存（BattleCommandSystem）。 */
    private _cmdCache: any = null;
    /**
     * 「冻结保持」的卡原 Y：一次攻击**确定**后（已进指令队列）攻击方与被攻击方要保持抬起，
     * 直到该指令的演出全部播完才落回。这里记的是它们的原位（key = 卡牌节点）。
     * 🔴 与「当前这次选择」的 _enemyHomes/_enemyLifts **分开** —— 攻击演出播放中玩家仍可
     *    立刻开始**下一次选择**（选择是直接展示、不排队），两套状态不能互相踩踏。
     */
    private readonly _frozenHomes: Map<Node, number> = new Map();

    // ------------------------------ 生命周期 ------------------------------
    onEnable(): void {
        this.attach();
    }

    onDisable(): void {
        this.detach();
        this._pendingCard = null;  // 候选随从一并作废
        this.release(false);       // 组件被关掉时立刻收尾，不留悬空的高亮/抬升
    }

    update(): void {
        // 唯一职责（需求 11）：回合在**按住期间**被切走（多指操作 / API / 结束回合）时立刻收手，
        // 不留悬空的高亮 + 抬升。幂等，且只在 _active 时才有实际开销 —— 常态就是一次布尔判断。
        if (this._active && !this.canPressNow) this.release(true);
        // 🔴 候选（还没拖够距离）也要兜：回合被切走后，候选卡不该再被起手
        else if (!this._active && this._pendingCard && !this.canPressNow) this._pendingCard = null;
    }

    // ------------------------------ 对外查询 / API ------------------------------
    /** 当前是否处于「按住高亮」状态 */
    public get isPressed(): boolean {
        return this._active;
    }

    /** 当前被按住的卡牌（null = 没在按住）；供测试/排查 */
    public get pressedCard(): Node | null {
        return this._target;
    }

    /** 已按下但还没拖够距离的候选随从（null = 没有）；供测试/排查 */
    public get pendingCard(): Node | null {
        return this._pendingCard;
    }

    /** 本次被点亮的卡牌（顺序 = 点亮顺序）；供测试/排查 */
    public get litCards(): Node[] {
        return this._lit.slice();
    }

    /**
     * 当前**是否允许开始按住**（需求 11：敌方回合禁止拖拽我方战场随从）。
     * 🔴 这是「能不能开始」的判据，**不含 `_active`** —— 是否忽略「按住中的再次按下」由调用方决定。
     * 放行判定顺序：
     *   · `enablePress` 关 → 一律不放行；
     *   · `playerTurnOnly` 关 → 一律放行（调试用）；
     *   · 找不到 TurnManager、或**尚未开战**（`!isRunning`）→ 放行（fail-open：编辑器预览 /
     *     单测里没跑回合流程时交互仍可用。`_running` 一旦开战就只增不减，故对局中不会误开窗口）；
     *   · 其余 → 只认 `TurnManager.isPlayerTurn`（权威 = 我方操作回合）。
     */
    public get canPressNow(): boolean {
        if (!this.enablePress) return false;
        // 🔴 这里**不**看「攻击演出是否在播」：选择（按住/抬起/光圈）属于**直接展示**，
        //    不进入演出队列，也不该被队列挡住 —— 否则攻击动画期间玩家连下一个随从都选不了，
        //    根本走不到「进入指令队列」那一步。是否可攻击由 rules.canAttack/canTarget 决定。
        if (!this.playerTurnOnly) return true;
        const tm = this.turnManager();
        if (!tm) return true;
        if (!tm.isRunning) return true;
        return tm.isPlayerTurn === true;
    }

    /** 按类名字符串 BFS 找 TurnManager（结果缓存；不静态 import 防循环依赖，与 CardPlay / TestConsole 同一约定） */
    private turnManager(): any {
        const cached = this._tmCache;
        if (cached && cached.isValid) return cached;
        const scene = this.node.scene as unknown as Node | null;
        if (!scene) return null;
        const stack: Node[] = [...scene.children];
        while (stack.length > 0) {
            const cur = stack.shift() as Node;
            const c = cur.getComponent('TurnManager');
            if (c) { this._tmCache = c; return c; }
            for (const ch of cur.children) stack.push(ch);
        }
        this._tmCache = null;
        return null;
    }

    /**
     * 用「UI 坐标」（= event.getUILocation() 的坐标系）按下 —— 供代码/测试脚本直接触发。
     * @returns 是否命中了我方战场上的随从卡牌（命中即已点亮 + 抬 Y）
     */
    public pressAt(uiPos: Vec2 | Vec3): boolean {
        if (this._active || !this.canPressNow) return false;
        const card = this.pickCard(uiPos);
        if (!card) return false;
        this._touchId = -1;
        this.engage(card);
        return true;
    }

    /** 直接对某张卡牌触发（跳过命中判定）；供代码/测试使用 */
    public pressCard(card: Node): boolean {
        if (this._active || !this.canPressNow) return false;
        if (!card || !card.isValid || !this.isTarget(card) || !this.canAttackCard(card)) return false;
        this._touchId = -1;
        this.engage(card);
        return true;
    }

    /** 结束本次高亮（= 松手）。@param animate false = 立刻熄灭并还原（不播补间） */
    public releaseNow(animate = true): void {
        this.release(animate);
    }

    // ------------------------------ 触摸入口 ------------------------------
    // 需求 9：高亮一旦点亮就与移动无关 —— 按住期间移出卡牌不取消，只有
    //         TOUCH_END / TOUCH_CANCEL（松开、抬起）才结束。
    // 需求 10b：TOUCH_MOVE 只用于「选择攻击对象」——按住模式中把指针移到敌方
    //          随从上时抬起它，移开时落回，可反复判定；不影响高亮本身。
    private readonly _onTouchStart = (event: EventTouch): void => {
        if (this._active) return;                           // 已在按住中 → 忽略后续按下
        if (!this.canPressNow) return;                      // 需求 11：非我方回合（敌方回合）→ 完全无反应
        if (!isPrimaryButton(event)) return;                // 鼠标右键/中键不参与
        const ui = event.getUILocation();
        const card = this.pickCard(ui);
        if (!card) return;                                  // 点在战场空白/其它区域
        this._touchId = event.getID();
        // 🔴 **按下 ≠ 进入选择模式**：只登记候选，拖动超过 pressStartDistance 才 engage。
        //    这样「单击随从」只弹说明卡片，不会再抬卡 / 点亮全场。
        if (this.pressStartDistance <= 0) {                 // 0 = 保留旧行为（按下立刻进入）
            this._pendingCard = null;
            this.engage(card);
            return;
        }
        this._pendingCard = card;
        this._pendingUI.set(ui.x, ui.y);
    };

    /** 按住后拖动超过阈值 → 真正进入「选择攻击对象」模式 */
    private tryEngageFromMove(ui: Vec2): void {
        const card = this._pendingCard;
        if (!card || !card.isValid) return;
        const dx = ui.x - this._pendingUI.x;
        const dy = ui.y - this._pendingUI.y;
        if (dx * dx + dy * dy <= this.pressStartDistance * this.pressStartDistance) return;
        this._pendingCard = null;
        if (!this.canPressNow) return;                      // 拖动途中回合被切走 → 不起手
        this.engage(card);
    }

    private readonly _onTouchMove = (event: EventTouch): void => {
        // 只认「按下时那根指针」的移动（API 触发 _touchId = -1 时不校验）
        if (this._touchId >= 0 && event.getID() !== this._touchId) return;
        if (!this._active) {                                // 还没起手 → 先看够不够拖动距离
            this.tryEngageFromMove(event.getUILocation());
            if (!this._active) return;
        }
        // 需求 11：按住途中回合被切走（多指 / API / 结束回合）→ 立刻取消，不再续判攻击对象
        if (!this.canPressNow) { this.release(true); return; }
        const uiPos = event.getUILocation();
        const hero = this.pickEnemyHero(uiPos);
        if (hero) {
            if (hero === this._enemyTarget) return;
            this.restoreEnemy(true);
            this._enemyTarget = hero;
            return;
        }
        const card = this.pickEnemyCard(uiPos);
        if (card === this._enemyTarget) return;             // 还停在同一个敌方目标上
        this.restoreEnemy(true);                            // 离开旧目标 → 用它自己的补间落回原高度
        if (!card) return;                                  // 移到空白/非随从 → 只恢复，无新目标
        this._enemyTarget = card;
        this.liftNode(card, this.enemyHomeOf(card), true, this.enemyLiftObj(card));  // 抬起：高度/时长与我方完全一致
    };

    private readonly _onTouchEnd = (event: EventTouch): void => {
        // 只认「按下时那根指针」的抬起；API 触发（_touchId = -1）时不校验
        if (this._touchId >= 0 && event.getID() !== this._touchId) return;
        this._pendingCard = null;                           // 没拖起来 = 只是点了一下（说明卡片接手）
        if (this._active) this.endPress();
        this._touchId = -1;
    };

    private readonly _onTouchCancel = (event: EventTouch): void => {
        if (this._touchId >= 0 && event.getID() !== this._touchId) return;
        this._pendingCard = null;
        // 桌面预览的鼠标拖拽在松开时实测走 TOUCH_CANCEL；已有选中目标时按一并松手结算，
        // 否则只做复位，保证“拖到敌随从上再松开”不会因事件类型不同而静默失效。
        if (this._active) this.endPress();
        this._touchId = -1;
    };

    private attach(): void {
        const n = this.resolveListenNode();
        if (!n) return;
        if (this._listen === n) return;
        this.detach();
        this._listen = n;
        n.on(Node.EventType.TOUCH_START, this._onTouchStart);
        n.on(Node.EventType.TOUCH_MOVE, this._onTouchMove);
        n.on(Node.EventType.TOUCH_END, this._onTouchEnd);
        n.on(Node.EventType.TOUCH_CANCEL, this._onTouchCancel);
    }

    private detach(): void {
        const n = this._listen;
        if (!n) return;
        if (n.isValid) {
            n.off(Node.EventType.TOUCH_START, this._onTouchStart);
            n.off(Node.EventType.TOUCH_MOVE, this._onTouchMove);
            n.off(Node.EventType.TOUCH_END, this._onTouchEnd);
            n.off(Node.EventType.TOUCH_CANCEL, this._onTouchCancel);
        }
        this._listen = null;
    }

    // ------------------------------ 核心流程 ------------------------------
    /** 按下命中：点亮「被按住的这一张 + 敌方全部随从」，并抬起被按住的卡牌 */
    /**
     * 🔴🔴 每张卡的**稳定原位 Y**：快速连点时，engage 若直接采样 `card.position.y`，
     * 会把「落下补间途中」的高度当成原位 ⇒ 每点一次抬高一点（漂移 bug）。
     * 首次按下时记录；「落回补间完成」时作废（此刻 y 已归位，下次重新采样）。
     * 攻击「冻结保持」的原位仍以 `_frozenHomes` 优先。
     */
    private readonly _homes = new WeakMap<Node, number>();

    private homeYOf(card: Node): number {
        const frozen = this._frozenHomes.get(card);
        if (frozen !== undefined) return frozen;
        let h = this._homes.get(card);
        if (h === undefined) {
            h = card.position.y;
            this._homes.set(card, h);
        }
        return h;
    }

    private engage(card: Node): void {
        if (EvolveFollowerFx.isAnimating(card)) return;   // 🔴 进化动画中：位移/旋转归特效管，禁止按住
        this._active = true;
        this._target = card;
        // 🔴🔴 原位必须用**稳定规范值**：快速连点时上一轮的「落下补间」还在途中，
        //    直接采样 card.position.y 会把半途高度当原位 ⇒ 每点一次抬高一点（漂移 bug）。
        //    homeYOf() 首次按下记录、落回完成后作废；「冻结保持」的攻击卡仍优先用 frozenHomes。
        this._targetHomeY = this._frozenHomes.get(card) ?? this.homeYOf(card);
        this._lit.length = 0;
        this._enemyHomes.clear();       // 新的一次按住 = 新一轮攻击对象判定（表的生命周期 = 一次按住）
        this._enemyLifts.clear();
        this._enemyTarget = null;

        // ① 被按住的我方卡牌：抬 Y（需求 10）+ 亮起
        this.liftTarget(true);
        this.light(card, true);

        // ② 敌方**可被选中的**随从一起亮起（需求 8 + 守护）：
        //    守护在场时只亮守护随从 —— 选择光圈 = 玩家「确实能选」的提示，不能选的不出现。
        if (this.glowOnEnemy) {
            for (const n of this.attackableEnemies(card)) this.light(n, false);
        }
    }

    /** 松手：熄灭本次点亮的全部卡牌 + 被按住的卡牌落回原位 */
    private release(animate: boolean): void {
        this._active = false;
        this._touchId = -1;
        this.clearGlow(animate);
        this.dropLift(animate);
    }

    /** 熄灭本次点亮的全部卡牌（**不碰**抬升状态，攻击动画期间单独复用）。 */
    private clearGlow(animate: boolean): void {
        const kw = this.keywordSystem();
        for (const n of this._lit) {
            if (!n || !n.isValid) continue;
            const g = n.getComponent(CardGlow);
            if (!g) continue;
            // 未完成攻击的己方随从保留其词条/可攻击态光圈；只有真正失去攻击能力时才熄灭。
            const keep = kw && typeof kw.activeGlowColor === 'function'
                ? kw.activeGlowColor(n)
                : null;
            if (keep) {
                g.useQualityColor = false;
                g.glowColor.set(keep);
                if (!g.isGlowing) g.fadeIn();
                continue;
            }
            if (animate) g.fadeOut();
            else g.glowOffImmediate();
        }
        this._lit.length = 0;
    }

    /** 把本次按住抬起的敌我双方落回原位，并清理按住期的记录表。 */
    private dropLift(animate: boolean): void {
        // 敌方攻击对象目标一并复位（需求 10b：松手 = 模式结束），随后清空按住期内的记录表
        this.restoreEnemy(animate);
        this._enemyHomes.clear();
        this._enemyLifts.clear();

        const card = this._target;
        Tween.stopAllByTarget(this._lift);
        if (card && card.isValid) {
            if (animate) this.liftTarget(false);
            else this.applyLift(card, this._targetHomeY);
        }
        this._target = null;
        // 🔴 绝不能在这里把 this._lift.y 归零：属性补间的起始值在**第一次 step 才采样**，
        //    提前归零会让「落下补间」采样到 0→0 ⇒ 我方卡牌瞬间贴地（敌方用各自的补间对象，
        //    不受影响，这就是「敌方有下落动画、我方没有」的根因）。liftNode() 已自行把
        //    liftObj.y 设为当前 y，这里什么都不用做。
        const kw = this.keywordSystem();
        if (kw && typeof kw.refreshVisuals === 'function') kw.refreshVisuals();
    }

    /**
     * 松手收尾：已有敌方目标 → 先播**攻击动画**（随从对随从 = 攻击方一次普通攻击 + 被攻击方反击；
     * 攻击主战者 = 只攻击一次），动画期间双方保持选择时抬起的高度**不落下**；动画结束再结算伤害并落回。
     * 没有目标 / 没有动画组件 → 退回原来的「立即结算 + 复位」。
     */
    private endPress(): void {
        const attacker = this._target;
        const defender = this._enemyTarget;
        const cmds = this.commandSystem();
        const rules = this.battleRules();
        const anim = this.attackAnim();

        const hasPair = !!attacker && attacker.isValid && !!defender && defender.isValid;

        // 没有成对目标 = 普通松手：沿用原有「熄灭光圈 + 全部落回」路径（抬升补间仍在跑，交给它收尾）。
        if (!hasPair) {
            const hadAny = !!attacker || !!defender;
            if (hadAny) this.release(true);
            else this.release(false);
            return;
        }

        const holdA = attacker;
        // 🔴 敌方**主战者区域永不移动**：主战者只作为攻击目标（不抬起、不保持、不落回）。
        //    只有「随从」目标才参与选择抬起 + 攻击期间的保持抬起。
        const holdD = defender && !defender.getComponent(HeroArea) ? defender : null;
        const homeA = this._targetHomeY;
        const homeD = holdD ? this.enemyHomeOf(holdD) : 0;

        // ============ 结束这次「选择」============
        // 🔴 选择（按住 / 抬起 / 选择光圈）属于**直接展示**，不进入演出队列、也不被演出队列阻挡。
        //    因此这里只结束「当前这次选择」，**绝不设「战斗中禁止按住」的锁** ——
        //    攻击演出还在播时，玩家照样可以立刻去按住另一个还能行动的随从。
        //    真正需要排队的只有「确定攻击」这一步（下面的 enqueueAttack）。
        this._active = false;
        this._touchId = -1;
        this.clearGlow(true);

        // 冻结「保持抬起」：攻击方与被攻击方保持在选择时抬起的高度，等本次演出播完再落回。
        this.freezeHold(holdA, homeA);
        this.freezeHold(holdD, homeD);

        // 清空「本次选择」的跟踪，让下一次选择从干净状态开始（冻结表不受影响）。
        this._target = null;
        this._enemyTarget = null;
        this._enemyHomes.clear();
        this._enemyLifts.clear();

        const dropAll = (): void => {
            this.dropHold(holdA, homeA);
            this.dropHold(holdD, homeD);
        };

        // ============ 首选：确定攻击 → 进入操作指令队列 ============
        if (cmds && typeof cmds.enqueueAttack === 'function') {
            const res = cmds.enqueueAttack(attacker as Node, defender as Node, dropAll);
            if (res && res.accepted) return;
            // 指令被拒（目标不合法 / 守护拦截 / 本回合已攻击……）→ 不进队列，立刻落回。
            dropAll();
            return;
        }

        // ============ 回退：没有指令系统时沿用旧路径（动画驱动 + 立即结算）============
        if (rules && anim && typeof anim.playFollowerExchange === 'function') {
            const finish = (): void => {
                try {
                    if (rules.isValid) rules.resolveCombat(attacker as Node, defender as Node);
                } catch (e) {
                    console.error('[BattleFieldPressGlow] 攻击结算出错：', e);
                }
                dropAll();
            };
            try {
                const isHero = !!(defender as Node).getComponent(HeroArea);
                if (isHero) anim.playHeroAttack(attacker, defender, finish);
                else anim.playFollowerExchange(attacker, defender, finish);
            } catch (e) {
                console.error('[BattleFieldPressGlow] 播放攻击动画出错：', e);
                finish();
            }
            return;
        }

        if (rules) {
            try {
                rules.resolveCombat(attacker, defender);
            } catch (e) {
                console.error('[BattleFieldPressGlow] 攻击结算出错：', e);
            }
        }
        dropAll();
    }

    /**
     * 冻结一张卡当前的「保持抬起」姿态：停掉它正在跑的抬升补间、写死到 `homeY + liftY`，
     * 并把原位登记进 `_frozenHomes`（供本次演出结束后落回）。
     * 🔑 冻结后该卡与「当前这次选择」完全解耦：`_lift` / `_enemyLifts` 随即被清空，
     *    下一次选择可以放心复用它们，不会打断这里的保持状态。
     */
    private freezeHold(card: Node | null, homeY: number): void {
        if (!card || !card.isValid) return;
        // 🔴 主战者区域**永不移动**：任何情况下都不对它做抬升/保持/落回。
        if (card.getComponent(HeroArea)) return;
        this._frozenHomes.set(card, homeY);
        // 停掉该卡身上的抬升补间（我方用共享 _lift、敌方用各自的 _enemyLifts 对象）
        Tween.stopAllByTarget(this._lift);
        const obj = this._enemyLifts.get(card);
        if (obj) Tween.stopAllByTarget(obj);
        this.applyLift(card, homeY + this.liftY);
    }

    /**
     * 落回一张「冻结保持」的卡。
     * 🔴 若这张卡正被**新的一次选择**占用（正在按住 / 正被悬停），不抢它的落回 ——
     *    否则上一轮攻击的收尾会把玩家当前拖拽中的卡拽下去。
     */
    private dropHold(card: Node | null, homeY: number): void {
        if (!card) return;
        this._frozenHomes.delete(card);
        if (!card.isValid) return;
        if (card.getComponent(HeroArea)) return;   // 主战者永不移动
        if (card === this._target || card === this._enemyTarget) return;
        const dur = Math.max(0, this.liftDuration);
        if (dur <= 0) { this.applyLift(card, homeY); return; }
        const obj = { y: card.position.y };
        tween(obj)
            .to(dur, { y: homeY }, {
                easing: 'quadOut',
                onUpdate: () => {
                    try { this.applyLift(card, obj.y); } catch (e) { /* 节点可能已被销毁，忽略 */ }
                },
            })
            .call(() => {
                try { this.applyLift(card, homeY); } catch (e) { /* 同上 */ }
            })
            .start();
    }

    /** 操作指令队列组件：优先本节点，其次全场景 BFS；缓存失效后重查。 */
    private commandSystem(): any {
        const cached = this._cmdCache;
        if (cached && cached.isValid) return cached;
        const own = this.node.getComponent('BattleCommandSystem');
        if (own) { this._cmdCache = own; return own; }
        const scene = this.node.scene as unknown as Node | null;
        if (!scene) return null;
        const stack: Node[] = [...scene.children];
        while (stack.length > 0) {
            const cur = stack.shift() as Node;
            const c = cur.getComponent('BattleCommandSystem');
            if (c) { this._cmdCache = c; return c; }
            for (const ch of cur.children) stack.push(ch);
        }
        this._cmdCache = null;
        return null;
    }

    /** 攻击动画组件：优先本节点，其次全场景 BFS；缓存失效后重查。 */
    private attackAnim(): any {
        const cached = this._animCache;
        if (cached && cached.isValid) return cached;
        const own = this.node.getComponent('FollowerAttackAnim');
        if (own) { this._animCache = own; return own; }
        const scene = this.node.scene as unknown as Node | null;
        if (!scene) return null;
        const stack: Node[] = [...scene.children];
        while (stack.length > 0) {
            const cur = stack.shift() as Node;
            const c = cur.getComponent('FollowerAttackAnim');
            if (c) { this._animCache = c; return c; }
            for (const ch of cur.children) stack.push(ch);
        }
        this._animCache = null;
        return null;
    }

    /** 对战规则组件：优先本节点，其次全场景 BFS；缓存失效后重查。 */
    private battleRules(): any {
        const cached = this._ruleCache;
        if (cached && cached.isValid) return cached;

        const own = this.node.getComponent('BattleRuleSystem');
        if (own) { this._ruleCache = own; return own; }

        const scene = this.node.scene as unknown as Node | null;
        if (!scene) return null;
        const stack: Node[] = [...scene.children];
        while (stack.length > 0) {
            const cur = stack.shift() as Node;
            const c = cur.getComponent('BattleRuleSystem');
            if (c) { this._ruleCache = c; return c; }
            for (const ch of cur.children) stack.push(ch);
        }
        this._ruleCache = null;
        return null;
    }

    /** 卡牌词条系统：按类名 BFS，缓存失效后重查。 */
    private keywordSystem(): any {
        const cached = this._keywordCache;
        if (cached && cached.isValid) return cached;
        const scene = this.node.scene as unknown as Node | null;
        if (!scene) return null;
        const stack: Node[] = [...scene.children];
        while (stack.length > 0) {
            const cur = stack.shift() as Node;
            const c = cur.getComponent('CardKeywordSystem');
            if (c) { this._keywordCache = c; return c; }
            for (const ch of cur.children) stack.push(ch);
        }
        this._keywordCache = null;
        return null;
    }

    /** 点亮一张卡（own = 当前被拖拽的己方卡；敌方目标统一橙色选择光） */
    private light(card: Node, own: boolean): void {
        if (!card || !card.isValid) return;
        const g = this.glowOf(card);
        if (!g) return;
        this.applyStyle(g);
        this.applySelectionGlow(g, card, own);
        g.fadeIn();
        if (this._lit.indexOf(card) < 0) this._lit.push(card);
    }

    /** 取卡上的 CardGlow；没有就补一个（战场工厂没挂上时的兜底，保证功能不依赖挂载顺序） */
    private glowOf(card: Node): CardGlow | null {
        let g = card.getComponent(CardGlow);
        if (!g) {
            try {
                g = card.addComponent(CardGlow);
            } catch (e) {
                console.warn('[BattleFieldPressGlow] 无法给卡牌添加 CardGlow：', e);
                return null;
            }
        }
        return g;
    }

    /** 可选的统一样式覆盖（overrideStyle 打开时才生效） */
    private applyStyle(g: CardGlow): void {
        if (!this.overrideStyle) return;
        g.glowThickness = this.glowThickness;
        g.glowSoftness = this.glowSoftness;
        g.maxIntensity = this.maxIntensity;
        g.useQualityColor = this.useQualityColor;
        if (!this.useQualityColor) g.glowColor.set(this.glowColor);
    }

    /** 己方词条卡保持黄/绿；其它被拖拽高亮一律使用原来的橙色选择光。 */
    private applySelectionGlow(g: CardGlow, card: Node, own: boolean): void {
        if (this.overrideStyle) return;
        const kw = own ? this.keywordSystem() : null;
        const keywordColor = kw && typeof kw.activeGlowColor === 'function' ? kw.activeGlowColor(card) : null;
        g.useQualityColor = false;
        g.glowColor.set(keywordColor || this.glowColor);
    }

    // ------------------------------ 抬 Y（需求 10 / 10b）------------------------------
    /** 抬起 / 落回被按住的我方卡牌 */
    private liftTarget(up: boolean): void {
        this.liftNode(this._target, this._targetHomeY, up, this._lift);
    }

    /**
     * 通用抬卡：把 `card` 的 position.y 在 `homeY` ↔ `homeY + liftY` 之间补间。
     * 🔑 我方被按卡与敌方攻击对象目标**共用同一套 liftY / liftDuration**（需求：完全一致），
     *    但各用独立的补间对象（`this._lift` / `this._eLift`），互不打断。
     * 🔑 补间跑在**独立对象**上而不是卡牌节点上 ——
     *    这样不会 `Tween.stopAllByTarget(卡牌)` 误杀 CardPlay 正在播的战场让位动画。
     */
    private liftNode(card: Node | null, homeY: number, up: boolean, liftObj: { y: number }): void {
        if (!card || !card.isValid) return;
        const to = up ? (homeY + this.liftY) : homeY;
        const dur = Math.max(0, this.liftDuration);
        Tween.stopAllByTarget(liftObj);
        liftObj.y = card.position.y;
        if (dur <= 0) {
            this.applyLift(card, to);
            if (!up) this._homes.delete(card);
            return;
        }
        tween(liftObj)
            .to(dur, { y: to }, {
                easing: 'quadOut',
                // 🔴 tween 回调里的异常会被 TweenSystem 吞掉 → 一律包 try/catch
                onUpdate: () => {
                    try { this.applyLift(card, liftObj.y); } catch (e) { /* 节点可能已被销毁，忽略 */ }
                },
            })
            .call(() => {
                try {
                    this.applyLift(card, to);
                    // 🔴 落回完成 ⇒ 稳定原位记录作废（此刻 y 已归位，下次按下重新采样）
                    if (!up) this._homes.delete(card);
                } catch (e) { /* 同上 */ }
            })
            .start();
    }

    /** 取（或创建）某张敌方目标卡专属的抬 Y 补间对象 */
    private enemyLiftObj(card: Node): { y: number } {
        let obj = this._enemyLifts.get(card);
        if (!obj) { obj = { y: 0 }; this._enemyLifts.set(card, obj); }
        return obj;
    }

    /** 取敌方目标卡的原始 Y（首次抬起时记录，之后沿用——落回补间中途再进入也不漂移） */
    private enemyHomeOf(card: Node): number {
        let home = this._enemyHomes.get(card);
        if (home === undefined) {
            // 被上一轮攻击「冻结保持」的卡：它的原位在 _frozenHomes 里，别把抬起位当原位。
            home = this._frozenHomes.get(card) ?? card.position.y;
            this._enemyHomes.set(card, home);
        }
        return home;
    }

    /**
     * 复位敌方攻击对象目标。
     * 🔑 只复位「当前目标」不够——防御式遍历本次按住期间**所有**抬起过的敌方卡，
     *    每张用自己的补间对象（animate=true 时各自独立落下，互不打断）。
     * 🔑 这里**不清空** _enemyHomes / _enemyLifts：落回补间中途再进入同一张卡时，
     *    还要靠表里记录的「首次原位」与原补间对象（liftNode 会先停掉落下补间再升起），
     *    清了就会把「半途的 Y」当成原位 → 越抬越高（漂移）。表的生命周期 = 一次按住
     *    （engage / release 时统一清空）。
     */
    private restoreEnemy(animate: boolean): void {
        this._enemyTarget = null;
        for (const [card, obj] of this._enemyLifts) {
            Tween.stopAllByTarget(obj);
            const home = this._enemyHomes.get(card);
            if (!card.isValid || home === undefined) continue;
            if (animate) this.liftNode(card, home, false, obj);
            else this.applyLift(card, home);
        }
    }

    /** 只改 Y，X/Z 保持不动（需求 10 的「Position 中的 Y 稍微增加」） */
    private applyLift(card: Node, y: number): void {
        if (!card || !card.isValid) return;
        const p = card.position;
        card.setPosition(p.x, y, p.z);
    }

    // ------------------------------ 命中判定 ------------------------------
    /** 找出 UI 坐标落在我方战场哪张卡上（从最上层往下找，先命中的就是它） */
    private pickCard(uiPos: Vec2 | Vec3): Node | null {
        return this.pickFrom(this.resolvePlayer(), uiPos, true);
    }

    /** 找出 UI 坐标落在敌方战场哪张**可攻击**随从卡上（选择攻击对象模式用，需求 10b + 守护） */
    private pickEnemyCard(uiPos: Vec2 | Vec3): Node | null {
        return this.pickFrom(this.resolveEnemy(), uiPos, false, this._target);
    }

    /** 敌方主战者是否在 UI 坐标命中；命中时作为攻击目标，不做抬升。 */
    private pickEnemyHero(uiPos: Vec2 | Vec3): Node | null {
        const heroNode = this.resolveEnemyHero();
        if (!heroNode || !heroNode.isValid) return null;
        // 目标合法性统一问 BattleRuleSystem.canTarget（含「守护在场 → 主战者不可选」+ 突进/疾驰限制）
        if (this._target && !this.canTargetCard(this._target, heroNode)) return null;
        if (!this.hitHero(heroNode, uiPos)) return null;
        return heroNode;
    }

    private hitHero(heroNode: Node, uiPos: Vec2 | Vec3): boolean {
        const ut = heroNode.getComponent(UITransform);
        if (!ut) return false;
        const world = this.uiToWorld(uiPos);
        const local = ut.convertToNodeSpaceAR(world, _local);
        const r = Math.max(1, Math.min(ut.contentSize.width, ut.contentSize.height) / 2);
        return local.x * local.x + local.y * local.y <= r * r;
    }

    /**
     * 在指定战场里找出 UI 坐标落点下的卡（`fieldCards` 已按 followerOnly 过滤）。
     * @param targetFor 传入攻击者时，会用 BattleRuleSystem.canTarget 过滤「不可选」的目标
     *                  （守护在场时非守护随从直接跳过 ⇒ 既没有光圈也抬不起来）。
     */
    private pickFrom(
        field: BattleFieldLayout | null,
        uiPos: Vec2 | Vec3,
        attackerOnly = false,
        targetFor: Node | null = null,
    ): Node | null {
        if (!field || !field.isValid) return null;
        const list = this.fieldCards(field);
        // 层级越高越"靠上"：先按 siblingIndex 从大到小排，再逐个命中判定
        list.sort((a, b) => b.getSiblingIndex() - a.getSiblingIndex());
        for (const n of list) {
            if (attackerOnly && !this.canAttackCard(n)) continue;
            if (targetFor && !this.canTargetCard(targetFor, n)) continue;
            if (this.hitTest(n, uiPos)) return n;
        }
        return null;
    }

    /** 目标合法性（含「守护」限制）：交给 BattleRuleSystem.canTarget；无规则组件时放行。 */
    private canTargetCard(attacker: Node, target: Node): boolean {
        const rules = this.battleRules();
        if (!rules || typeof rules.canTarget !== 'function') return true;
        return rules.canTarget(attacker, target) !== false;
    }

    /** 当前 attacker 可以选择的敌方随从（守护在场时只剩守护随从）。 */
    private attackableEnemies(attacker: Node): Node[] {
        const all = this.fieldCards(this.resolveEnemy());
        const rules = this.battleRules();
        if (!rules || typeof rules.canTarget !== 'function') return all;
        return all.filter((n) => rules.canTarget(attacker, n) !== false);
    }

    /** 攻击者门控：BattleRuleSystem 存在时，本回合已攻击过的随从不能再被选中。 */
    private canAttackCard(card: Node): boolean {
        const rules = this.battleRules();
        if (!rules || typeof rules.canAttack !== 'function') return true;
        return rules.canAttack(card) !== false;
    }

    /** 某节点的 UITransform 矩形是否包含该 UI 坐标（缩放/旋转都已算进去） */
    private hitTest(n: Node, uiPos: Vec2 | Vec3): boolean {
        const ut = n.getComponent(UITransform);
        if (!ut) return false;
        const world = this.uiToWorld(uiPos);
        const local = ut.convertToNodeSpaceAR(world, _local);
        const w = ut.contentSize.width;
        const h = ut.contentSize.height;
        const left = -ut.anchorX * w;
        const right = (1 - ut.anchorX) * w;
        const bottom = -ut.anchorY * h;
        const top = (1 - ut.anchorY) * h;
        return local.x >= left && local.x <= right && local.y >= bottom && local.y <= top;
    }

    /**
     * 🔴 输入事件的 `getUILocation()` 是**屏幕(UI)坐标**，而 `convertToNodeSpaceAR`
     * 要的是**世界坐标**，两者之间隔着 UI 相机的正交投影（设计分辨率 ≠ 实际可视区
     * 高度时二者相差一个缩放系数）。这里用 Canvas 上的 UI 相机做一次 `screenToWorld`
     * —— 与 HandDrag.uiToWorld 同一条路径，保证在任何分辨率适配下都命中得准。
     */
    private uiToWorld(uiPos: Vec2 | Vec3): Vec3 {
        Vec3.set(_uiScratch, uiPos.x, uiPos.y, 0);
        const cam = this.uiCamera();
        if (cam) cam.screenToWorld(_uiScratch, _worldScratch);
        else Vec3.copy(_worldScratch, _uiScratch);
        return _worldScratch;
    }

    /** 取 UI 相机（Canvas 上那台）；本引擎的 Node 没有 getComponentInParent，只能沿父链找 */
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

    // ------------------------------ 战场解析 ------------------------------
    /** 该战场里「可被本脚本点亮」的卡牌（按 factionOnly 过滤随从） */
    private fieldCards(field: BattleFieldLayout | null): Node[] {
        if (!field || !field.isValid) return [];
        const out: Node[] = [];
        for (const n of field.cards) {
            if (!n || !n.isValid) continue;
            if (!this.isTarget(n)) continue;
            out.push(n);
        }
        return out;
    }

    /** 这张卡是否属于「本脚本管的对象」（默认只认随从；需求 7「随从卡牌」） */
    private isTarget(card: Node): boolean {
        if (!this.followerOnly) return true;
        const id = cardIdFromNodeName(card.name);
        const info = id ? getCardInfo(id) : undefined;
        return !!info && info.cardType === 'Follower';
    }

    /** 我方战场：Inspector 指定 → 本节点上的 BattleFieldLayout → 全场景找 side = Player */
    private resolvePlayer(): BattleFieldLayout | null {
        if (this.playerField && this.playerField.isValid) return this.playerField;
        if (this._pField && this._pField.isValid) return this._pField;
        const own = this.node.getComponent(BattleFieldLayout);
        if (own && own.side === BattleSide.Player) { this._pField = own; return own; }
        this._pField = this.findFieldBySide(BattleSide.Player, own);
        return this._pField;
    }

    /** 敌方战场：Inspector 指定 → 全场景找 side = Enemy（EnemyBattleFieldArea） */
    private resolveEnemy(): BattleFieldLayout | null {
        if (this.enemyField && this.enemyField.isValid) return this.enemyField;
        if (this._eField && this._eField.isValid) return this._eField;
        const own = this.node.getComponent(BattleFieldLayout);
        this._eField = this.findFieldBySide(BattleSide.Enemy, own);
        return this._eField;
    }

    /** 敌方主战者：按 HeroArea.side = Enemy 解析，不依赖节点名。 */
    private resolveEnemyHero(): Node | null {
        if (this._eHero && this._eHero.isValid) return this._eHero;
        const scene = this.node.scene as unknown as Node | null;
        if (!scene) return null;
        const stack: Node[] = [...scene.children];
        while (stack.length > 0) {
            const cur = stack.shift() as Node;
            const hero = cur.getComponent(HeroArea);
            if (hero && hero.isValid && hero.side === HeroSide.Enemy) {
                this._eHero = cur;
                return cur;
            }
            for (const ch of cur.children) stack.push(ch);
        }
        this._eHero = null;
        return null;
    }

    /**
     * 全场景 BFS 找指定归属的战场。
     * 走 `side` 而不是节点名 —— 与 CardPlay.resolveField() 同一口径：
     * 给战场节点改名不会影响任何逻辑。
     */
    private findFieldBySide(side: BattleSide, exclude: BattleFieldLayout | null): BattleFieldLayout | null {
        const scene = this.node.scene as unknown as Node | null;
        if (!scene) return null;
        const stack: Node[] = [...scene.children];
        while (stack.length > 0) {
            const cur = stack.shift() as Node;
            const c = cur.getComponent(BattleFieldLayout);
            if (c && c.isValid && c !== exclude && c.side === side) return c;
            for (const ch of cur.children) stack.push(ch);
        }
        return null;
    }

    /** 监听节点：Inspector 指定 → 沿父链找 Canvas（战场节点矩形太小，接不到事件） */
    private resolveListenNode(): Node | null {
        if (this.listenNode && this.listenNode.isValid) return this.listenNode;
        let n: Node | null = this.node;
        while (n) {
            if (n.getComponent(Canvas)) return n;
            n = n.parent;
        }
        return this.node;
    }
}

// ------------------------------ 模块内部工具 ------------------------------
/** 屏幕(UI)坐标暂存（随后被 screenToWorld 覆写为世界坐标） */
const _uiScratch = new Vec3();
/** UI 坐标换算出来的世界坐标 */
const _worldScratch = new Vec3();
/** 命中判定：卡牌自身本地坐标 */
const _local = new Vec3();

/**
 * 是否「主键」事件（鼠标左键 / 触摸）。右键、中键不参与；
 * 触摸事件没有按键概念（默认 0）→ 直接放行。
 */
function isPrimaryButton(event: EventTouch): boolean {
    const e = event as unknown as { getButton?: () => number };
    if (typeof e.getButton !== 'function') return true;
    return e.getButton() === 0;
}
