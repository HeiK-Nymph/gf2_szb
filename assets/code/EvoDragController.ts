import {
    _decorator, Camera, Canvas, Color, Component, EventTouch, Layers, Node, Tween, tween, UITransform,
    Vec2, Vec3,
} from 'cc';
import { BattleFieldLayout, BattleSide } from './BattleFieldLayout';
import { BattleRuleSystem } from './BattleRuleSystem';
import { CardGlow, cardIdFromNodeName } from './CardGlow';
import { CardKeywordSystem, KEYWORD_RUSH } from './CardKeywordSystem';
import { cardTargetRequest } from './CardAbilitySystem';
import { EvoGuideLine } from './EvoGuideLine';
import { EvoPointBadge, EvoPointKind } from './EvoPointBadge';
import { evolveFollower, runEvolveAbilities } from './FollowerEvolve';
import { EvoPointSystem, EvoSide } from './EvoPointSystem';
import { HandDrag } from './HandDrag';
import { TargetSelectSystem } from './TargetSelectSystem';

const { ccclass, property, menu } = _decorator;

const _local = new Vec3();
const _uiScratch = new Vec3();
const _worldScratch = new Vec3();

/**
 * EvoDragController —— 进化点「从图标按住拖到随从上松手」的交互控制器
 * ===========================================================================
 * 挂在 `Canvas` 上（建议）。
 *
 * 交互（与实机一致）：
 *   ① 按住**我方**的进化点图标（`EvoEP_player` / `EvoSEP_player`）→ 图标跟着手指走；
 *   ② 拖动期间给「场上**可进化**的己方随从」全部加上选择光圈（`CardGlow`）；
 *   ③ 拖到某个随从上松手 → 该随从进化：
 *        · **攻击 +2 / 血量 +2**（走 `BattleRuleSystem.addStats`，卡面数字自动刷新）
 *        · 获得**突进**（`CardKeywordSystem.addKeyword(card, 'Rush')`）
 *        · 扣掉 1 点对应的进化点（`EvoPointSystem.consume`）
 *        · 标记为已进化（**进化过的随从不能再进化**，见 `BattleRuleSystem.canEvolve`）
 *   ④ 松手处没有可进化的随从 → 图标复位、光圈熄灭，不消耗任何东西。
 *
 * 🔴🔴 **监听挂在 Canvas（本组件所在节点）上，而不是挂在徽记节点上**：
 *    本项目的 `BattleFieldPressGlow` 也监听 Canvas，而引擎的事件派发是
 *    「先父后子」—— 挂在 Canvas 上的监听会**先**被调用并可能把事件吃下去，
 *    于是徽记节点上的 TOUCH_START 永远收不到（实测：敌方回合能收到、我方回合收不到）。
 *    所以这里改成同层监听 + 在回调里**自己 hitTest** 判断指针是否落在某枚徽记上。
 *
 * 🔴 门控（三者缺一不可，`canStartDrag`）：
 *   · 该方必须是**我方**（敌方的两枚徽记只做显示，玩家不能操作）；
 *   · 该进化点**可用**（已解禁 + 还有次数，`EvoPointSystem.isUsable`）；
 *   · 当前是**我方回合**（`TurnManager.isPlayerTurn`；未开战时不拦截，与战场按压同口径）。
 *
 * 🔴 「本回合已经攻击过的随从进化后仍不能攻击」不需要在这里写任何代码：
 *    `BattleRuleSystem.canAttack` 只看它自己的 `_attacked` 集合，进化不动那个集合。
 * ===========================================================================
 */
@ccclass('EvoDragController')
@menu('gf2szb/EvoDragController')
export class EvoDragController extends Component {

    @property({ tooltip: '允许玩家拖动我方进化点图标（关闭 = 只显示、不可操作）' })
    enableDrag = true;

    @property({ type: Color, tooltip: '拖动时给「可进化随从」加的选择光圈颜色' })
    glowColor = new Color(255, 214, 120, 255);

    @property({ range: [0.2, 4, 0.05], slide: true, tooltip: '选择光圈的最低强度（保证「可进化」提示足够醒目）' })
    glowMinIntensity = 1.6;

    @property({
        tooltip: '拖动时显示**金色发光引导曲线**（从进化点图标弯向指针；需要场景里有 `EvoGuideLine` 节点）。\n'
            + '🔴 图标本身**固定不动**，只有曲线跟随指针。',
    })
    showGuideLine = true;

    @property({ tooltip: '**普通进化**攻击力加成（实机 = +2）' })
    evolveAttackGain = 2;

    @property({ tooltip: '**普通进化**血量加成（实机 = +2）' })
    evolveHpGain = 2;

    @property({ tooltip: '**超进化**攻击力加成（实机 = +3）' })
    superAttackGain = 3;

    @property({ tooltip: '**超进化**血量加成（实机 = +3）' })
    superHpGain = 3;

    @property({ tooltip: '进化后授予的关键词（默认 Rush = 突进；留空 = 不授予）' })
    evolveKeyword = KEYWORD_RUSH;

    @property({ tooltip: '打印拖动 / 进化日志' })
    verbose = true;

    // ====================== 内部状态 ======================
    private _badge: EvoPointBadge | null = null;
    private _node: Node | null = null;
    private _kind: EvoPointKind = EvoPointKind.EP;
    private _dragging = false;
    /** 引导曲线组件（懒查找 + 缓存） */
    private _guide: EvoGuideLine | null = null;
    /** 本次拖动点亮过的随从（松手只熄这一批） */
    private readonly _lit: Node[] = [];
    /** 🔴 图标区域的「吞事件」层 —— 按在图标上时**无论可用与否**都不透传给底下的手牌/战场 */
    private readonly _swallows: Node[] = [];
    private _bound = false;
    private _cam: Camera | null = null;
    private _pField: BattleFieldLayout | null = null;
    private _acc = 0;
    /** 手牌拖拽组件缓存（交互跟随视觉：被手牌盖住的区域让位给手牌） */
    private _handDragCache: HandDrag | null = null;
    /** 选择模式组件缓存（进化时能力需要先选目标时用） */
    private _selectCache: TargetSelectSystem | null = null;

    // ------------------------------ 生命周期 ------------------------------
    onEnable(): void {
        this.attach();          // 🔴 主路径：Canvas 级监听（回调里自己 hitTest 徽记）
        this.syncSwallows();    // 辅路径：吞事件矩形（只负责「阻止透传到手牌」）
    }

    onDisable(): void {
        this.finishDrag();
        // 🔴 组件被关掉（重开对局 / 场景重置）时不能把「抬起」留在场上 —— 瞬时归位，幂等
        this.dropEvolvingLift(false);
        this.detach();
        this.clearSwallows();
    }

    /** 🔴 主监听：挂在本节点（= Canvas）上。吞事件层只是辅助拦截，**不能**作为唯一路径——
     *  一旦吞节点没收到事件（命中测试的环境差异），图标就彻底无响应。 */
    private attach(): void {
        if (this._bound) return;
        this._bound = true;
        const n = this.node;
        n.on(Node.EventType.TOUCH_START, this._onDown, this);
        n.on(Node.EventType.TOUCH_MOVE, this._onMove, this);
        n.on(Node.EventType.TOUCH_END, this._onUp, this);
        n.on(Node.EventType.TOUCH_CANCEL, this._onUp, this);
    }

    private detach(): void {
        if (!this._bound) return;
        this._bound = false;
        const n = this.node;
        n.off(Node.EventType.TOUCH_START, this._onDown, this);
        n.off(Node.EventType.TOUCH_MOVE, this._onMove, this);
        n.off(Node.EventType.TOUCH_END, this._onUp, this);
        n.off(Node.EventType.TOUCH_CANCEL, this._onUp, this);
    }

    update(dt: number): void {
        // 吞事件层跟随徽记（徽记可能被 HeroArea 重建/移动），低频校正
        this._acc += dt;
        if (this._acc < 0.5) return;
        this._acc = 0;
        if (!this._dragging) this.syncSwallows();
    }

    // ------------------------------ 吞事件层 ------------------------------
    /**
     * 🔴🔴 每枚徽记盖一块**透明的吞事件矩形**（排在 Canvas 最后 ⇒ 事件命中先于手牌）：
     *   · 指针落在图标区域时，事件在这里被 `propagationStopped` 截下 ——
     *     **无论进化有没有解禁、这回合还能不能进化**，都不会透过图标去选中底下的卡牌；
     *   · 截下的事件转交给本组件的 `_onDown/_onMove/_onUp`（能不能拖由 `canStartDrag` 判）。
     * 监听挂在这里而不是徽记节点上（见类注释：Canvas/子树的事件派发顺序问题）。
     */
    private syncSwallows(): void {
        const evo = this.evoSystem();
        if (!evo) return;
        const canvas = this.node;
        const cut = canvas.getComponent(UITransform);
        const sides: EvoSide[] = ['player', 'enemy'];
        const kinds: EvoPointKind[] = [EvoPointKind.EP, EvoPointKind.SEP];
        let i = 0;
        for (const side of sides) {
            for (const kind of kinds) {
                const b = evo.badgeOf(side, kind);
                const slot = i++;
                if (!b || !b.isValid) continue;
                let s = this._swallows[slot];
                if (!s || !s.isValid) {
                    s = new Node('EvoSwallow_' + side + '_' + kind);
                    // 🔴 吞事件节点必须继承 Canvas 的 layer —— 本项目 UI 相机只看 DEFAULT(1<<30)，
                    //    硬编码 UI_2D 会被剔除（事件命中测试也轮不到它）
                    s.layer = this.node.layer;
                    const ut = s.addComponent(UITransform);
                    ut.setAnchorPoint(0.5, 0.5);
                    canvas.addChild(s);
                    const swallow = (e: EventTouch) => {
                        try { e.propagationStopped = true; } catch (err) { /* 忽略 */ }
                    };
                    s.on(Node.EventType.TOUCH_START, (e: EventTouch) => {
                        // 🔴 交互跟随视觉：按压点已被手牌卡盖住 → 图标区域让位（立即退出命中
                        //    测试，不吞事件、不启动进化拖拽）。正常情况下 syncSwallows 已经
                        //    把它 active=false，这里是 0.5s 同步间隙内的兜底。
                        try {
                            if (this._handCardCoveringAt(e.getUILocation())) {
                                s.active = false;
                                return;
                            }
                        } catch (err) { /* 忽略 */ }
                        swallow(e);
                        this._onDown(e);
                    }, this);
                    s.on(Node.EventType.TOUCH_MOVE, (e: EventTouch) => { swallow(e); this._onMove(e); }, this);
                    s.on(Node.EventType.TOUCH_END, (e: EventTouch) => { swallow(e); this._onUp(e); }, this);
                    s.on(Node.EventType.TOUCH_CANCEL, (e: EventTouch) => { swallow(e); this._onUp(e); }, this);
                    this._swallows[slot] = s;
                }
                // 同步几何（盖住徽记、略大一圈），并排到 Canvas 最后 ⇒ 事件命中先于手牌
                const size = Math.max(40, b.badgeSize * 1.25);
                s.getComponent(UITransform)!.setContentSize(size, size);
                if (cut) {
                    const local = cut.convertToNodeSpaceAR(b.node.worldPosition, new Vec3());
                    s.setPosition(local.x, local.y, 0);
                }
                s.setSiblingIndex(canvas.children.length - 1);
                // 🔴 交互跟随视觉：手牌卡渲染在我方进化点图标**之上**（placeBadgeLayer 保证
                //    EvoPointLayer 排在 PlayerHandArea 之前）。图标区域被手牌盖住时，
                //    吞事件矩形必须**让位**（active=false ⇒ 命中测试轮不到它，
                //    按压自然落进手牌拖拽）—— 用户按的是「看得到的东西」。
                if (side === 'player') {
                    s.active = !this._rectCoveredByHandCard(s);
                }
            }
        }
    }

    private clearSwallows(): void {
        for (const s of this._swallows) {
            if (!s || !s.isValid) continue;
            s.off(Node.EventType.TOUCH_START, this._onDown, this);
            s.off(Node.EventType.TOUCH_MOVE, this._onMove, this);
            s.off(Node.EventType.TOUCH_END, this._onUp, this);
            s.off(Node.EventType.TOUCH_CANCEL, this._onUp, this);
            s.destroy();
        }
        this._swallows.length = 0;
    }

    // ------------------------------ 触摸回调 ------------------------------
    private _onDown = (e: EventTouch): void => {
        if (this._dragging) return;
        try {
            // 🔴 交互跟随视觉：按压点被手牌卡盖住 → 让位给手牌拖拽（HandDrag），
            //    绝不触发被盖住的进化交互（用户按的是「看得到的东西」）。
            if (this._handCardCoveringAt(e.getUILocation())) return;
            // 自己命中判定：指针必须落在某枚我方进化点图标上；否则交给其它系统（战场按压等）
            const badge = this.pickBadgeAt(e.getUILocation());
            if (!badge) return;
            if (!this.canStartDrag(badge)) return;

            // 🔴 图标**固定不动**（用户需求）：不移动、不缩放，只画一条跟随指针的引导曲线
            this._badge = badge;
            this._node = badge.node;
            this._kind = badge.kind;
            this._dragging = true;
            this.lightCandidates();
            this.showGuide(badge, e);
            if (this.verbose) console.log(`[EvoDrag] 开始拖动：${badge.sideLabel} / ${EvoPointKind[badge.kind]}`);
        } catch (err) {
            console.warn('[EvoDrag] 按下异常：', err);
            this.finishDrag();
        }
    };

    private _onMove = (e: EventTouch): void => {
        if (!this._dragging) return;
        try {
            this.updateGuide(e);
        } catch (err) {
            // 拖动中出错就整场收尾，避免卡在「曲线永远跟着手」的状态
            console.warn('[EvoDrag] 拖动异常：', err);
            this.finishDrag();
        }
    };

    private _onUp = (e: EventTouch): void => {
        if (!this._dragging) return;
        try {
            const target = this.pickEvolvable(e.getUILocation());
            if (target) this.requestEvolve(target);
            else if (this.verbose) console.log('[EvoDrag] 松手处没有可进化的随从 → 取消');
        } catch (err) {
            console.warn('[EvoDrag] 松手异常：', err);
        } finally {
            this.finishDrag();
        }
    };

    /**
     * 松手请求进化。
     *
     * 🔴 **进化时能力需要选目标**（如卡 4 的超进化 = 触发一次入场曲）时，先进入「选择模式」：
     *    · 先让对方**可被选择的随从**亮起选择光圈；
     *    · 玩家点了其它地方 → 退出选择模式，**不消耗进化点**、不进化；
     *    · 玩家成功选中 → 才真正触发进化（扣点 + 加数值 + 播放进化动画），
     *      等**进化动画播完之后**再结算进化时能力（`runCardEvolveAbilities`）。
     * 不需要选目标 / 没有合法候选 → 老行为：立刻进化（能力在动画结束后结算，无目标）。
     */
    private requestEvolve(card: Node): void {
        const rules = this.rules();
        if (!rules || rules.canEvolve(card) !== true) return;
        const isSuper = this._kind === EvoPointKind.SEP;
        const id = cardIdFromNodeName(card.name);
        const req = id ? cardTargetRequest(id, isSuper ? ['evolve', 'superEvolve'] : ['evolve']) : null;
        if (req) {
            const sys = this.selectSystem();
            if (sys) {
                const started = sys.begin({
                    owner: 'player',
                    select: req.select,
                    filter: req.filter,
                    onPicked: (chosen: Node) => {
                        // 🔴 选中目标 → **瞬时**落回（见 dropEvolvingLift 的注释：进化动画会把
                        //    当前 position 记成 home，带着抬起高度进去会停在高处）
                        this.dropEvolvingLift(false);
                        this.doEvolve(card, chosen);
                    },
                    onCancelled: (reason: string) => {
                        this.dropEvolvingLift(true);      // 没做出选择 → 落回原位（需求：恢复）
                        if (this.verbose) console.log(`[EvoDrag] 进化时能力的目标选择已取消（${reason}）→ 不消耗进化点`);
                    },
                });
                if (started) {
                    // 需求：进入「进化时能力的目标选择阶段」时，准备进化的这张随从**保持抬起**
                    //（与拖拽选择 / 战场按压同一套高度与时长）
                    this.liftEvolving(card);
                    if (this.verbose) console.log(`[EvoDrag] ${isSuper ? '超进化' : '进化'}需要先选目标 → 进入选择模式`);
                    return;
                }
            }
        }
        this.doEvolve(card, null);
    }

    // ------------------------------ 进化选择阶段的「抬起」（需求） ------------------------------
    /**
     * 进入「进化时能力的目标选择阶段」时把**准备进化的这张随从**抬起来，
     * 退出选择阶段（取消）时落回原位。
     *
     * 🔑 「跟拖拽选择一样」= 高度与时长**直接读 `BattleFieldPressGlow` 的 Inspector 值**
     *    （`liftY` / `liftDuration`，缺组件时才退回同一套默认值 14 / 0.12），
     *    并且用**同一套写法**：补间跑在独立数值对象上、只改 `position.y`（X/Z 不动）、
     *    `Tween.stopAllByTarget(补间对象)` 而不是 stop 卡牌节点（免得误杀战场让位动画）。
     *
     * 🔴 两种落回方式的区别（重要）：
     *    · 取消选择 → `animate = true`，播下落动画（「恢复」是可看到的）；
     *    · 选中目标 → `animate = false`，**瞬时**落回。因为 `EvolveFollowerFx` 在开播时
     *      记 `home = card.position.clone()`，带着抬起高度进去 ⇒ 动画结束会把卡牌留在高处。
     */
    private _liftCard: Node | null = null;
    /** 抬起前记录的**基准 Y**（首次抬起时采样，落回用它，避免中途位置漂移当原位） */
    private _liftHomeY = 0;
    /** 本组件专属的抬升补间对象（与战场按压的 _lift 完全独立，互不打断） */
    private readonly _evoLiftObj = { y: 0 };

    /** 抬升参数：优先沿用战场按压（拖拽选择）的那一套，读不到才用同一套默认值。 */
    private liftConfig(): { y: number; dur: number } {
        const press = this.findComp('BattleFieldPressGlow') as unknown as
            { liftY?: number; liftDuration?: number } | null;
        const y = Number(press?.liftY);
        const dur = Number(press?.liftDuration);
        return {
            y: Number.isFinite(y) ? y : 14,
            dur: Number.isFinite(dur) ? Math.max(0, dur) : 0.12,
        };
    }

    /** 抬起准备进化的随从（幂等：重复调用不会越抬越高） */
    private liftEvolving(card: Node | null): void {
        if (!card || !card.isValid) return;
        if (this._liftCard !== card) this._liftHomeY = card.position.y;   // 换了一张卡 → 重新采样基准
        this._liftCard = card;
        this.runLift(card, this._liftHomeY + this.liftConfig().y);
    }

    /** 落回原位；`animate = true` 播下落动画，false 瞬时归位 */
    private dropEvolvingLift(animate: boolean): void {
        const card = this._liftCard;
        this._liftCard = null;
        if (!card || !card.isValid) { this._liftCard = null; return; }
        Tween.stopAllByTarget(this._evoLiftObj);
        if (animate) {
            this.runLift(card, this._liftHomeY);
        } else {
            this.applyEvolvingLift(card, this._liftHomeY);
        }
    }

    /** 把 `card` 的 Y 从**当前值**补间到 `to`（补间跑在独立对象上，只改 Y） */
    private runLift(card: Node, to: number): void {
        const dur = this.liftConfig().dur;
        const obj = this._evoLiftObj;
        Tween.stopAllByTarget(obj);
        obj.y = card.position.y;          // 🔴 起始值取当前值（属性补间第一次 step 才采样）
        if (dur <= 0) { this.applyEvolvingLift(card, to); return; }
        tween(obj)
            .to(dur, { y: to }, {
                easing: 'quadOut',
                // 🔴 tween 回调里的异常会被 TweenSystem 吞掉 → 一律包 try/catch
                onUpdate: () => {
                    try { this.applyEvolvingLift(card, obj.y); } catch (e) { /* 节点可能已被销毁 */ }
                },
            })
            .call(() => {
                try { this.applyEvolvingLift(card, to); } catch (e) { /* 同上 */ }
            })
            .start();
    }

    /** 只改 Y，X/Z 保持不动 */
    private applyEvolvingLift(card: Node, y: number): void {
        if (!card || !card.isValid) return;
        const p = card.position;
        card.setPosition(p.x, y, p.z);
    }

    // ------------------------------ 门控 ------------------------------
    /** 指针落点下的进化点徽记（不区分敌我；「能不能用」交给 canStartDrag 判） */
    private pickBadgeAt(uiPos: Vec2 | Vec3): EvoPointBadge | null {
        const evo = this.evoSystem();
        if (!evo) return null;
        const sides: EvoSide[] = ['player', 'enemy'];
        const kinds: EvoPointKind[] = [EvoPointKind.EP, EvoPointKind.SEP];
        for (const side of sides) {
            for (const kind of kinds) {
                const b = evo.badgeOf(side, kind);
                if (!b || !b.isValid || !b.node.activeInHierarchy) continue;
                if (this.hitTest(b.node, uiPos)) return b;
            }
        }
        return null;
    }

    /** 能不能开始拖这一枚徽记 */
    private canStartDrag(badge: EvoPointBadge): boolean {
        if (!this.enableDrag) return false;
        // 只有我方那两枚能被玩家拖动；敌方的两枚纯显示
        if (badge.sideLabel !== 'player') return false;
        const evo = this.evoSystem();
        // 🔴 一回合一次：本回合已经用过进化（普通或超进化任一）→ 两枚图标都不再响应
        if (evo && typeof evo.hasUsedEvolveThisTurn === 'function' && evo.hasUsedEvolveThisTurn('player')) {
            if (this.verbose) console.log('[EvoDrag] 本回合已经使用过进化（一回合一次）→ 不响应拖动');
            return false;
        }
        const usable = evo && typeof evo.isUsable === 'function'
            ? evo.isUsable('player', badge.kind)
            : badge.isUsable;
        if (!usable) {
            if (this.verbose) console.log('[EvoDrag] 该进化点当前不可用（未解禁 / 次数用尽）→ 不响应拖动');
            return false;
        }
        if (!this.isPlayerTurn()) {
            if (this.verbose) console.log('[EvoDrag] 不是我方回合 → 不响应拖动');
            return false;
        }
        return true;
    }

    /** 是否我方回合（找不到 TurnManager / 未开战 → 放行，与战场按压门控同口径） */
    private isPlayerTurn(): boolean {
        const tm = this.findComp('TurnManager') as any;
        if (!tm) return true;
        if (tm.isRunning === false) return true;
        return tm.isPlayerTurn === true;
    }

    // ------------------------------ 拖动表现：金色引导曲线 ------------------------------
    /** 找场景里的引导曲线组件（懒查找 + 缓存） */
    private guide(): EvoGuideLine | null {
        if (this._guide && this._guide.isValid) return this._guide;
        this._guide = this.findComp('EvoGuideLine') as EvoGuideLine | null;
        return this._guide;
    }

    /** 按下：曲线起点 = 图标世界坐标（固定），终点 = 指针；弯向按进化类型：EP 左 / SEP 右 */
    private showGuide(badge: EvoPointBadge, e: EventTouch): void {
        if (!this.showGuideLine) return;
        const g = this.guide();
        if (!g) return;
        // 🔴 普通进化（EP）向左弯、超进化（SEP）向右弯 —— 用户指定，仅超进化偏右
        g.curveDir = badge.kind === EvoPointKind.SEP ? 1 : -1;
        const from = this.uiToWorld(e.getUILocation());
        g.show(badge.node.worldPosition, from);
    }

    /** 拖动中：只更新终点（曲线实时扭曲） */
    private updateGuide(e: EventTouch): void {
        if (!this.showGuideLine) return;
        const g = this.guide();
        if (!g) return;
        g.setEndPoint(this.uiToWorld(e.getUILocation()));
    }

    private hideGuide(): void {
        const g = this._guide;
        if (g && g.isValid) g.hide();
    }

    /** 给「场上可进化的己方随从」全部加选择光圈 */
    private lightCandidates(): void {
        this.clearHighlights();
        const field = this.playerField();
        const rules = this.rules();
        if (!field || !rules) return;
        for (const n of field.cards) {
            if (!n || !n.isValid) continue;
            if (rules.canEvolve(n) !== true) continue;
            if (this.light(n) === false) continue;
            this._lit.push(n);
        }
        if (this.verbose) console.log(`[EvoDrag] 可进化随从 ${this._lit.length} 只（已加选择光圈）`);
    }

    /**
     * 点亮单张卡的选择光圈（与 `BattleFieldPressGlow.light` 同一套 CardGlow）。
     * 🔴🔴 **选择光圈优先级最高**：先把这张卡的光晕从 `CardKeywordSystem` **接管**过来，
     *    否则它每 0.1s 的 `refreshVisuals` 会把颜色刷回「突进黄 / 疾驰绿」。
     *    接管期间它完全不碰这张卡的 CardGlow ⇒ 引导用户选择的高亮保持稳定。
     */
    private light(card: Node): boolean {
        const g = this.glowOf(card);
        if (!g) return false;
        const kw = this.keywordSystem();
        if (kw && typeof kw.setGlowOverride === 'function') kw.setGlowOverride(card, true);
        g.useQualityColor = false;
        g.glowColor.set(this.glowColor);
        g.maxIntensity = Math.max(g.maxIntensity, this.glowMinIntensity);
        g.fadeIn();
        return true;
    }

    /** 熄灭本次点亮的光圈，并把光晕控制权**交还**给关键词系统（它会重新点亮该亮的） */
    private clearHighlights(): void {
        const kw = this.keywordSystem();
        const canHandBack = !!(kw && typeof kw.setGlowOverride === 'function');
        for (const n of this._lit) {
            if (!n || !n.isValid) continue;
            const g = n.getComponent(CardGlow);
            if (g && g.isValid) g.fadeOut();
            if (canHandBack) kw.setGlowOverride(n, false, false);   // 先只解除标记（不逐张刷新）
        }
        this._lit.length = 0;
        // 统一刷新一次：本回合还能攻击的卡会重新亮起它自己的词条光晕
        if (canHandBack && typeof kw.refreshVisuals === 'function') kw.refreshVisuals();
    }

    /** 收尾：引导曲线淡出 + 光圈熄灭（幂等，异常路径也会走到）。图标本身没动过，无需复位。 */
    private finishDrag(): void {
        this.hideGuide();
        this.clearHighlights();
        this._badge = null;
        this._node = null;
        this._dragging = false;
    }

    // ------------------------------ 命中与进化 ------------------------------
    /** 指针落点下的**可进化**随从（层级高的优先） */
    private pickEvolvable(uiPos: Vec2 | Vec3): Node | null {
        const field = this.playerField();
        const rules = this.rules();
        if (!field || rules === null) return null;
        const list = field.cards.filter((n) => !!n && n.isValid && rules.canEvolve(n) === true);
        list.sort((a, b) => b.getSiblingIndex() - a.getSiblingIndex());
        for (const n of list) {
            if (this.hitTest(n, uiPos)) return n;
        }
        return null;
    }

    /**
     * 执行进化：扣点 → 加数值 → 打标记 → 授予突进 → 播动画 → 动画播完结算进化时能力。
     * 🔴 普通进化 = +2/+2；超进化 = **+3/+3** 并获得「己方回合伤害无效 + 不可破坏」守护。
     * 🔴 真实现已抽到 `FollowerEvolve.evolveFollower`（**敌我共用同一份底层逻辑**）——
     *    这里只负责把「我方交互侧的编制值」传进去，行为与抽出前逐位一致。
     */
    public doEvolve(card: Node, target: Node | null = null): boolean {
        const ok = evolveFollower(this, card, 'player', {
            kind: this._kind,
            target,
            verbose: this.verbose,
            tuning: {
                attackGain: this.evolveAttackGain,
                hpGain: this.evolveHpGain,
                superAttackGain: this.superAttackGain,
                superHpGain: this.superHpGain,
                keyword: this.evolveKeyword,
            },
        });
        if (!ok && this.verbose) console.log('[EvoDrag] 进化未执行（不可进化 / 进化点不可用）');
        return ok;
    }

    /** 进化时能力（普通进化 → 'evolve'；超进化 → 'evolve' + 'superEvolve'）—— 现在走共用实现 */
    private runEvolveAbilities(card: Node, isSuper: boolean, target: Node | null): void {
        runEvolveAbilities(this, card, 'player', isSuper, target);
    }

    /** 选择模式组件（挂在 Canvas 上；懒查找 + 缓存） */
    private selectSystem(): TargetSelectSystem | null {
        if (this._selectCache && this._selectCache.isValid) return this._selectCache;
        this._selectCache = this.findComp('TargetSelectSystem') as TargetSelectSystem | null;
        return this._selectCache;
    }

    // ------------------------------ 交互跟随视觉（手牌覆盖判定） ------------------------------
    /** 手牌拖拽组件（懒查找 + 缓存）；手牌区节点 = 它挂的节点（PlayerHandArea）。 */
    private handDrag(): HandDrag | null {
        if (this._handDragCache && this._handDragCache.isValid) return this._handDragCache;
        const hd = this.findComp('HandDrag') as HandDrag | null;
        this._handDragCache = hd;
        return hd;
    }

    /**
     * 按压点（UI 坐标）落在**我方手牌卡**上的那张卡（null = 没被盖住）。
     * 🔴 `placeBadgeLayer` 保证 EvoPointLayer 排在 PlayerHandArea **之前** ⇒ 手牌卡永远
     *    渲染在进化点图标之上，所以「点在卡牌矩形内」= 卡牌盖住了该区域。
     *    命中几何与 `HandDrag.pickCard` 同一套（UITransform 矩形，含缩放 / 旋转）。
     */
    private _handCardCoveringAt(uiPos: Vec2 | Vec3): Node | null {
        const hd = this.handDrag();
        const hand = hd ? hd.node : null;
        if (!hand || !hand.isValid || !hand.activeInHierarchy) return null;
        const kids = hand.children;
        for (let i = kids.length - 1; i >= 0; i--) {          // 从最上层往下找
            const n = kids[i];
            if (!n || !n.isValid || !n.activeInHierarchy) continue;
            if (n.name === 'CardFactory') continue;           // 卡模模板不参与命中
            if (!n.getComponent(UITransform)) continue;
            if (this.hitTest(n, uiPos)) return n;
        }
        return null;
    }

    /** 节点的世界轴对齐包围盒（手牌卡 / 吞事件矩形几乎无旋转，AABB 近似足够）。 */
    private _worldAabb(n: Node): { l: number; r: number; t: number; b: number } | null {
        const ut = n.getComponent(UITransform);
        if (!ut) return null;
        const wp = n.worldPosition;
        const ws = n.worldScale;
        const w = ut.contentSize.width * Math.abs(ws.x);
        const h = ut.contentSize.height * Math.abs(ws.y);
        return {
            l: wp.x - w * ut.anchorX,
            r: wp.x + w * (1 - ut.anchorX),
            b: wp.y - h * ut.anchorY,
            t: wp.y + h * (1 - ut.anchorY),
        };
    }

    /** 我方手牌卡的矩形是否与 `n` 的矩形重叠（= 手牌在视觉上盖住了该区域）。 */
    private _rectCoveredByHandCard(n: Node): boolean {
        const hd = this.handDrag();
        const hand = hd ? hd.node : null;
        if (!hand || !hand.isValid || !hand.activeInHierarchy) return false;
        const sr = this._worldAabb(n);
        if (!sr) return false;
        for (const c of hand.children) {
            if (!c || !c.isValid || !c.activeInHierarchy) continue;
            if (c.name === 'CardFactory') continue;
            const cr = this._worldAabb(c);
            if (!cr) continue;
            if (cr.l < sr.r && cr.r > sr.l && cr.b < sr.t && cr.t > sr.b) return true;
        }
        return false;
    }

    // ------------------------------ 坐标 / 命中 ------------------------------
    /** 某节点的 UITransform 矩形是否包含该 UI 坐标（缩放 / 旋转都算进去） */
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
     * 🔴 事件里的 `getUILocation()` 是**屏幕(UI)坐标**，`convertToNodeSpaceAR` 要的是**世界坐标**，
     *    两者之间隔着 UI 相机的正交投影 —— 必须经 `screenToWorld` 换算（与 HandDrag / 战场按压同一条路径）。
     */
    private uiToWorld(uiPos: Vec2 | Vec3): Vec3 {
        Vec3.set(_uiScratch, uiPos.x, uiPos.y, 0);
        const cam = this.uiCamera();
        if (cam) cam.screenToWorld(_uiScratch, _worldScratch);
        else Vec3.copy(_worldScratch, _uiScratch);
        return _worldScratch;
    }

    /** 取 UI 相机（沿父链找 Canvas） */
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

    // ------------------------------ 场景解析 ------------------------------
    private playerField(): BattleFieldLayout | null {
        if (this._pField && this._pField.isValid) return this._pField;
        const scene = this.node.scene as unknown as Node | null;
        if (!scene) return null;
        const stack: Node[] = [...scene.children];
        while (stack.length > 0) {
            const cur = stack.shift() as Node;
            const f = cur.getComponent(BattleFieldLayout);
            if (f && f.isValid && f.side === BattleSide.Player) {
                this._pField = f;
                return f;
            }
            for (const ch of cur.children) stack.push(ch);
        }
        this._pField = null;
        return null;
    }

    /** 按组件类名 BFS 找（找不到返回 null） */
    private findComp(name: string): Component | null {
        const scene = this.node.scene as unknown as Node | null;
        if (!scene) return null;
        const stack: Node[] = [...scene.children];
        while (stack.length > 0) {
            const cur = stack.shift() as Node;
            const c = cur.getComponent(name);
            if (c) return c;
            for (const ch of cur.children) stack.push(ch);
        }
        return null;
    }

    private rules(): BattleRuleSystem | null {
        return this.findComp('BattleRuleSystem') as BattleRuleSystem | null;
    }

    private evoSystem(): EvoPointSystem | null {
        return this.findComp('EvoPointSystem') as EvoPointSystem | null;
    }

    private keywordSystem(): CardKeywordSystem | null {
        return this.findComp('CardKeywordSystem') as CardKeywordSystem | null;
    }

    /** 取卡上的 CardGlow；没有就补一个（战场工厂没挂时的兜底） */
    private glowOf(card: Node): CardGlow | null {
        let g = card.getComponent(CardGlow);
        if (!g) {
            try {
                g = card.addComponent(CardGlow);
            } catch (e) {
                console.warn('[EvoDrag] 无法给卡牌添加 CardGlow：', e);
                return null;
            }
        }
        return g;
    }
}
