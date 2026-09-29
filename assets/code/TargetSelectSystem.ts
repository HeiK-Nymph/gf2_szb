import {
    _decorator, Camera, Canvas, Color, Component, EventTouch, Node, Tween, tween, UITransform,
    Vec2, Vec3,
} from 'cc';
import { BattleFieldLayout, BattleSide } from './BattleFieldLayout';
import { CardGlow, cardIdFromNodeName } from './CardGlow';
import { getCardInfo } from './CardData';

const { ccclass, property, menu } = _decorator;

const _local = new Vec3();
const _uiScratch = new Vec3();
const _worldScratch = new Vec3();

/** 选择模式期间的全屏接事件节点名 / 尺寸（略大于画布，兼容缩放下的小数误差） */
const CATCHER_NAME = 'TargetSelectCatcher';
const CATCHER_W = 2000;
const CATCHER_H = 1400;

/** 发起选择的一方（与 CardAbilitySide / CrestOwner 同字面量，避免循环 import） */
export type SelectOwner = 'player' | 'enemy';

/** 一次「选择目标随从」的请求参数。 */
export interface TargetSelectOptions {
    /** 发起选择的一方：'player' 的选择 → 候选通常是**对方**（敌方）战场随从 */
    owner: SelectOwner;
    /** 选择条件（与 CardAbilitySystem 的 params.select 同一套字面量）：
     *  · 'enemyFollower'    = 对方战场随从
     *  · 'friendlyFollower' = 己方战场随从
     */
    select: string;
    /**
     * 附加筛选条件（与 CardAbilitySystem 的 params.filter 同一套字面量）：
     *  · 留空 / 'any' = 不筛
     *  · 'damaged'    = 只保留**受伤**的随从（当前血量 < 战场动态上限，或上限被削 ——
     *                   与血量红字同一口径，见 `BattleRuleSystem.isDamaged`）
     *  · 'guard'      = 只保留持有**守护**的随从（见 `CardKeywordSystem.hasGuard`）
     */
    filter?: string;
    /** 成功选中一个合法目标 */
    onPicked: (card: Node) => void;
    /** 玩家点了其它地方 / 程序化取消（**没选中任何目标**） */
    onCancelled: (reason: string) => void;
    /** 选择光圈颜色（留空用本组件 Inspector 上的 glowColor） */
    glowColor?: Color;
    /** 打印日志（留空用本组件 Inspector 上的 verbose） */
    verbose?: boolean;
}

/**
 * TargetSelectSystem —— 通用「点击选择对方 / 己方随从」交互（选择模式）
 * ===========================================================================
 * 挂在 `Canvas` 上。由玩法侧（`CardPlay` 的入场曲、`EvoDragController` 的进化时能力）
 * 调用 `begin(...)` 进入选择模式，本组件负责：
 *
 *   ① 给**全部合法候选随从**加上选择光圈（`CardGlow`，并与词条光圈互斥 —— 见
 *      `CardKeywordSystem.setGlowOverride`，否则 0.1s 的词条刷新会把光圈刷回突进黄）；
 *   ② 监听 Canvas 上的 `TOUCH_START`：命中某个候选卡 → `onPicked(card)`；
 *      点在其它地方 → `onCancelled('点击了其它地方')`；
 *   ③ 选择期间**接管**（临时关闭）其它按压类交互（`BattleFieldPressGlow.enablePress` /
 *      `HandDrag.enableDrag`），避免同一次按压被两套系统同时消费；结束后原样还原。
 *
 * 🔴 交互口径（本项目铁律 59）：监听挂在 **Canvas 自己** 上（与 BattleFieldPressGlow
 *    同层），回调里**自己 hitTest**；命中即 `propagationStopped = true`，不让事件继续
 *    传给子节点（手牌拖拽 / 吞事件层）。
 * 🔴 「选择光圈」= **直接展示**，不进演出队列、也不被演出队列阻塞（与战场按压一致）。
 * ===========================================================================
 */
@ccclass('TargetSelectSystem')
@menu('gf2szb/TargetSelectSystem')
export class TargetSelectSystem extends Component {

    @property({ type: Color, tooltip: '候选随从的选择光圈颜色（默认橙金，与战场按压的敌方目标光圈同色系）' })
    glowColor = new Color(255, 150, 46, 255);

    @property({ range: [0.2, 4, 0.05], slide: true, tooltip: '选择光圈的最低强度（保证「可选」提示足够醒目）' })
    glowMinIntensity = 1.6;

    /** 选择期间临时关闭其它按压类交互，避免同一次按压被两套系统消费 */
    @property({ tooltip: '选择期间临时关闭「战场按压」（BattleFieldPressGlow.enablePress）与「手牌拖拽」（HandDrag.enableDrag）' })
    guardOtherInput = true;

    @property({ tooltip: '打印进入 / 退出选择模式的日志' })
    verbose = true;

    // ====================== 内部状态 ======================
    private _active = false;
    private _opts: TargetSelectOptions | null = null;
    private _candidates: Node[] = [];
    /** 本次点亮过光圈的卡（退出时只熄这些） */
    private readonly _lit: Node[] = [];
    private _settled = false;
    /** ★ 选中时是否也播「落下动画」（默认 false = 瞬时落回；见 settle 的注释） */
    private _animateDropOnPick = false;
    private _bound = false;
    private _cam: Camera | null = null;
    /** 被临时关掉的开关（还原时用） */
    private _guard: Array<{ comp: any; key: string; value: boolean }> = [];
    /**
     * 选择模式期间的**全屏接事件节点**（Canvas 最上层）。
     * 🔴 为什么必须有它：本项目的卡牌节点**不挂任何监听**（战场按压是自己在 Canvas 层
     *    `hitTest`），于是「点在空白处」时引擎**根本派发不出事件** —— 实测：点候选卡
     *    能收到、点战场空白收不到 ⇒ 「点其它地方就取消」无从触发。
     *    加一块覆盖整屏的透明节点即可保证**任何**按压都能进到 `_onDown`，
     *    真正「选中 / 取消」仍由本组件按几何 `pickAt()` 判定。
     */
    private _catcher: Node | null = null;

    // ------------------------------ 生命周期 ------------------------------
    onEnable(): void {
        this.attach();
    }

    onDisable(): void {
        this.settle(null, '组件被关闭');
        this.detach();
    }

    update(): void {
        // 防御：万一某次异常让 _active 掉了但开关没还原 → 补还原（幂等）
        if (this._active || this._guard.length === 0) return;
        this.restoreGuards();
    }

    // ------------------------------ 对外 API ------------------------------
    /** 当前是否处于选择模式 */
    public get isSelecting(): boolean {
        return this._active;
    }

    /** 本次的候选随从（副本；未在选择时为空数组） */
    public get candidates(): Node[] {
        return this._candidates.slice();
    }

    /**
     * 按选择条件取出候选随从（不做「是否为空」的判断）。
     *
     * 🔴 潜行：**不会被对方的能力选中** —— 目标落在**对方**战场上时，持有潜行的随从不是合法候选
     *    （`friendlyFollower` 选自己场上的随从不受影响）。
     *    这里是「能力选目标」的唯一口径：交互选择（`begin`）与 AI 自动选择（`autoPick`）都走它，
     *    所以只需在这里过滤一次，两条路径同时生效。
     *
     * 🔴 `filter`：`'damaged'` = 只要**受伤**的随从（口径见 `BattleRuleSystem.isDamaged`）；
     *             `'guard'`   = 只要持有**守护**的随从（口径见 `CardKeywordSystem.hasGuard`）。
     *
     * @param owner  发起方
     * @param select 'enemyFollower' | 'friendlyFollower'
     * @param filter 附加筛选：''/'any' = 不筛；'damaged' = 只留受伤的；'guard' = 只留守护
     */
    public candidatesFor(owner: SelectOwner, select: string, filter = ''): Node[] {
        const field = this.fieldFor(owner, select);
        if (!field || !field.isValid) return [];
        const againstOpponent = select !== 'friendlyFollower';
        const kw = this.keywordSystem() as {
            hasAmbush?: (card: Node | null) => boolean;
            hasAura?: (card: Node | null) => boolean;
            hasGuard?: (card: Node | null) => boolean;
        } | null;
        const want = String(filter || '').trim().toLowerCase();
        const rules = (want === 'damaged') ? this.rulesSystem() as {
            isDamaged?: (card: Node | null) => boolean;
        } | null : null;
        const out: Node[] = [];
        for (const card of field.cards) {
            if (!card || !card.isValid) continue;
            const id = cardIdFromNodeName(card.name);
            const info = id ? getCardInfo(id) : undefined;
            if (!info || info.cardType !== 'Follower') continue;
            if (againstOpponent && kw && typeof kw.hasAmbush === 'function' && kw.hasAmbush(card) === true) {
                if (this.verbose) console.log(`[TargetSelect] 跳过 ${card.name}：持有「潜行」，不会被对方能力选中`);
                continue;
            }
            if (againstOpponent && kw && typeof kw.hasAura === 'function' && kw.hasAura(card) === true) {
                if (this.verbose) console.log(`[TargetSelect] 跳过 ${card.name}：持有「灵气」，不会被对方能力选中`);
                continue;
            }
            if (want === 'damaged') {
                const hurt = !!(rules && typeof rules.isDamaged === 'function' && rules.isDamaged(card) === true);
                if (!hurt) {
                    if (this.verbose) console.log(`[TargetSelect] 跳过 ${card.name}：未受伤（filter=damaged）`);
                    continue;
                }
            } else if (want === 'guard') {
                const guarded = !!(kw && typeof kw.hasGuard === 'function' && kw.hasGuard(card) === true);
                if (!guarded) {
                    if (this.verbose) console.log(`[TargetSelect] 跳过 ${card.name}：没有「守护」（filter=guard）`);
                    continue;
                }
            } else if (want) {
                if (this.verbose) console.log(`[TargetSelect] 未知筛选条件 "${filter}" → 本次不筛（按不筛处理）`);
            }
            out.push(card);
        }
        return out;
    }

    /**
     * **AI / 脚本自动选目标**（不进入选择模式、不点指针）。
     * 用于敌方人机（或任何非交互场景）触发「需要选一个随从」的能力：
     * 走的是与我方**完全相同的候选口径**（`candidatesFor`），只是用统一策略挑一只。
     *
     * 策略（确定性、方便复现）：**攻击力最高**优先；攻击力相同则取**最左**那一只。
     * 攻击力读 `BattleRuleSystem.getAttack`（含进化/增益后的当前值）。
     * @returns 选中的随从；没有候选返回 null
     */
    public autoPick(owner: SelectOwner, select: string, filter = ''): Node | null {
        const list = this.candidatesFor(owner, select, filter);
        if (list.length === 0) return null;
        if (list.length === 1) return list[0];
        const rules = this.findComp('BattleRuleSystem') as {
            getAttack?: (n: Node) => number | null;
        } | null;
        const atkOf = (n: Node): number => {
            if (rules && typeof rules.getAttack === 'function') {
                const v = rules.getAttack(n);
                if (typeof v === 'number' && isFinite(v)) return v;
            }
            const id = cardIdFromNodeName(n.name);
            const info = id ? getCardInfo(id) : undefined;
            return info && typeof info.attack === 'number' ? info.attack : 0;
        };
        let best = list[0];
        let bestAtk = atkOf(best);
        for (let i = 1; i < list.length; i++) {
            const a = atkOf(list[i]);
            if (a > bestAtk) { best = list[i]; bestAtk = a; }   // 严格大于 ⇒ 同攻击力保留最左
        }
        return best;
    }

    /**
     * **程序化选中**（AI / 脚本用）：等价于「玩家点中了这个候选随从」。
     * 只能在选择模式进行中使用，且 `node` 必须是本次候选之一。
     * @returns 是否成功选中（false = 不在选择中 / 不是候选）
     */
    public pick(node: Node): boolean {
        if (!this._active || this._settled) return false;
        if (!node || !node.isValid || this._candidates.indexOf(node) < 0) return false;
        this.settle(node, '程序化选中');
        return true;
    }

    /**
     * 进入选择模式。
     * @returns false = 没有合法候选（调用方自行决定兜底，例如「直接正常进入战场」）；
     *          已有选择在进行中也会返回 false。
     */
    public begin(opts: TargetSelectOptions): boolean {
        if (this._active) {
            if (this.verbose) console.warn('[TargetSelect] 已有选择正在进行，忽略新的选择请求');
            return false;
        }
        if (!opts || typeof opts.onPicked !== 'function' || typeof opts.onCancelled !== 'function') return false;
        const list = this.candidatesFor(opts.owner, opts.select, opts.filter);
        if (list.length === 0) return false;

        this._opts = opts;
        this._animateDropOnPick = (opts as { animateDropOnPick?: boolean } | null)?.animateDropOnPick === true;
        this._candidates = list;
        this._settled = false;
        this._active = true;
        this.attach();
        this.ensureCatcher();
        this.applyGuards();
        for (const n of list) this.light(n, opts.glowColor);
        if (this.verbose) {
            console.log(`[TargetSelect] 进入选择模式：${opts.owner} / ${opts.select}`
                + `${opts.filter ? ' / ' + opts.filter : ''} → 候选 ${list.length} 只`);
        }
        return true;
    }

    /** 程序化取消（没选中任何目标） */
    public cancel(reason = '程序化取消'): void {
        this.settle(null, reason);
    }

    // ------------------------------ 触摸入口 ------------------------------
    private readonly _onDown = (e: EventTouch): void => {
        if (!this._active || this._settled) return;
        try {
            const uiPos = e.getUILocation();
            const hit = this.pickAt(uiPos);
            try { e.propagationStopped = true; } catch (err) { /* 忽略 */ }
            if (hit) this.settle(hit, '选中目标');
            else this.settle(null, '点击了其它地方');
        } catch (err) {
            console.warn('[TargetSelect] 选择判定异常：', err);
            this.settle(null, '判定异常');
        }
    };

    /** 命中判定：层级高的优先 */
    private pickAt(uiPos: Vec2 | Vec3): Node | null {
        const list = this._candidates.slice();
        list.sort((a, b) => b.getSiblingIndex() - a.getSiblingIndex());
        for (const n of list) {
            if (!n || !n.isValid) continue;
            if (this.hitTest(n, uiPos)) return n;
        }
        return null;
    }

    // ------------------------------ 收尾 ------------------------------
    /** 唯一收尾入口（幂等）：熄灭光圈 → 还原开关 → 回调 */
    private settle(picked: Node | null, reason: string): void {
        if (this._settled) return;      // 幂等：一次选择只允许收尾一次
        this._settled = true;
        const opts = this._opts;
        this._active = false;
        this._opts = null;
        this._candidates = [];
        this.clearHighlights();
        // 🔴 需求：候选抬起要在**回调之前**落回 —— 选中后的下游逻辑（破坏动画 / 进化动画）
        //    会拿「当前 position」当原位（如 `EvolveFollowerFx` 的 `home`），带着抬起高度进去会停在高处。
        //    选中 → **瞬时**落回（下游马上要动它）；取消 → 播下落动画（看得见的「恢复」）。
        // ★ 例外：**下游不会搬动这张卡**的流程（如护符「启动」给随从 +1/+1）可以在 opts 里
        //    声明 `animateDropOnPick` ⇒ 选中也播**落下动画**（否则看起来像「直接落下、没有动画」）。
        const animateDrop = !(picked && picked.isValid) || this._animateDropOnPick;
        this.dropLifts(animateDrop);
        this.removeCatcher();
        this.restoreGuards();

        if (this.verbose) {
            console.log(`[TargetSelect] 退出选择模式：${picked && picked.isValid ? '已选中 ' + picked.name : '未选中'}（${reason}）`);
        }
        if (!opts) return;
        try {
            if (picked && picked.isValid) opts.onPicked(picked);
            else opts.onCancelled(reason);
        } catch (e) {
            console.error('[TargetSelect] 选择回调异常：', e);
        }
    }

    // ------------------------------ 选择光圈 ------------------------------
    /** 给一张候选卡上选择光圈（并**接管**它，避免被词条刷新覆盖） */
    private light(card: Node, color?: Color): void {
        if (!card || !card.isValid) return;
        let g = card.getComponent(CardGlow);
        if (!g) {
            try { g = card.addComponent(CardGlow); } catch (e) { return; }
        }
        const kw = this.keywordSystem();
        if (kw && typeof kw.setGlowOverride === 'function') kw.setGlowOverride(card, true);
        g.useQualityColor = false;
        g.glowColor.set(color || this.glowColor);
        g.maxIntensity = Math.max(g.maxIntensity, this.glowMinIntensity);
        g.fadeIn();
        if (this._lit.indexOf(card) < 0) this._lit.push(card);
        this.liftCandidate(card);          // 需求：能被选中的卡**要抬起来**
    }

    // ------------------------------ 候选抬起（非拖拽选择模式） ------------------------------
    /**
     * 需求：**非拖拽**的选择模式（使用法术 / 进化时能力 / 入场曲的选择 —— 玩家不按住鼠标）里，
     * 能被选中的候选随从**要抬起来**；做出选择（或取消）后落回。
     *
     * 🔑 「跟拖拽选择一样」= 高度 / 时长直接读 `BattleFieldPressGlow` 的 Inspector 值
     *    （`liftY` / `liftDuration`，读不到才退回同一套默认值 14 / 0.12），写法也与它逐条对齐：
     *    补间跑在**独立数值对象**上（不 stop 卡牌节点，免得误杀战场让位动画）、只改 `position.y`。
     * 🔑 拖拽类选择（战场按压选攻击目标、进化点拖拽）由 `BattleFieldPressGlow` 自己抬卡，
     *    本组件只负责「不按住鼠标」的选择模式 ⇒ 两边不会对同一张卡各抬一次。
     */
    private readonly _liftObjs = new Map<Node, { y: number; home: number }>();

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

    /** 抬起一张候选（幂等：同一张卡在选择模式里只抬一次，不越抬越高） */
    private liftCandidate(card: Node): void {
        if (!card || !card.isValid) return;
        if (this._liftObjs.has(card)) return;
        const home = card.position.y;
        const obj = { y: home, home };
        this._liftObjs.set(card, obj);
        this.runLift(card, home + this.liftConfig().y, obj);
    }

    /** 让本次抬起过的全部候选落回原位；`animate = false` 瞬时归位 */
    private dropLifts(animate: boolean): void {
        for (const [card, obj] of this._liftObjs) {
            Tween.stopAllByTarget(obj);
            if (!card || !card.isValid) continue;
            if (animate) this.runLift(card, obj.home, obj);
            else this.applyLift(card, obj.home);
        }
        this._liftObjs.clear();
    }

    /** 把 `card` 的 Y 从**当前值**补间到 `to`（补间跑在独立对象上，只改 Y） */
    private runLift(card: Node, to: number, obj: { y: number; home: number }): void {
        const dur = this.liftConfig().dur;
        Tween.stopAllByTarget(obj);
        obj.y = card.position.y;          // 🔴 起始值取当前值（属性补间第一次 step 才采样）
        if (dur <= 0) { this.applyLift(card, to); return; }
        tween(obj)
            .to(dur, { y: to }, {
                easing: 'quadOut',
                // 🔴 tween 回调里的异常会被 TweenSystem 吞掉 → 一律包 try/catch
                onUpdate: () => {
                    try { this.applyLift(card, obj.y); } catch (e) { /* 节点可能已被销毁 */ }
                },
            })
            .call(() => {
                try { this.applyLift(card, to); } catch (e) { /* 同上 */ }
            })
            .start();
    }

    /** 只改 Y，X/Z 保持不动 */
    private applyLift(card: Node, y: number): void {
        if (!card || !card.isValid) return;
        const p = card.position;
        card.setPosition(p.x, y, p.z);
    }

    /** 熄灭本次点亮的全部光圈，并把光晕控制权**交还**给词条系统 */
    private clearHighlights(): void {
        const kw = this.keywordSystem();
        const canHandBack = !!(kw && typeof kw.setGlowOverride === 'function');
        for (const n of this._lit) {
            if (!n || !n.isValid) continue;
            const g = n.getComponent(CardGlow);
            if (g && g.isValid) g.fadeOut();
            if (canHandBack) kw.setGlowOverride(n, false, false);
        }
        this._lit.length = 0;
        if (canHandBack && typeof kw.refreshVisuals === 'function') kw.refreshVisuals();
    }

    // ------------------------------ 其它交互的临时让位 ------------------------------
    private applyGuards(): void {
        if (!this.guardOtherInput) return;
        const press = this.findComp('BattleFieldPressGlow') as any;
        const hand = this.findComp('HandDrag') as any;
        const evo = this.findComp('EvoDragController') as any;
        this._guard = [];
        this.pushGuard(press, 'enablePress');      // 战场按压（按住抬卡 / 选攻击目标）
        this.pushGuard(hand, 'enableDrag');        // 手牌拖拽
        this.pushGuard(evo, 'enableDrag');         // 进化点拖拽（选择模式里不能再起一次进化拖拽）
    }

    private pushGuard(comp: any, key: string): void {
        if (!comp || !comp.isValid || typeof comp[key] !== 'boolean') return;
        this._guard.push({ comp, key, value: comp[key] });
        comp[key] = false;
    }

    private restoreGuards(): void {
        for (const g of this._guard) {
            try {
                if (g.comp && g.comp.isValid) g.comp[g.key] = g.value;
            } catch (e) { /* 忽略 */ }
        }
        this._guard = [];
    }

    // ------------------------------ 监听 / 坐标 / 命中 ------------------------------
    private attach(): void {
        if (this._bound) return;
        const n = this.listenNode();
        if (!n) return;
        this._bound = true;
        n.on(Node.EventType.TOUCH_START, this._onDown, this);
    }

    private detach(): void {
        this.removeCatcher();
        if (!this._bound) return;
        this._bound = false;
        const n = this.listenNode();
        if (n && n.isValid) n.off(Node.EventType.TOUCH_START, this._onDown, this);
    }

    // ------------------------------ 全屏接事件节点 ------------------------------
    /** 建（或启用）覆盖整屏的透明接事件节点：保证「点空白」也能收进 `_onDown` */
    private ensureCatcher(): void {
        const canvas = this.listenNode();
        if (!canvas) return;
        if (this._catcher && this._catcher.isValid) {
            this._catcher.active = true;
            this._catcher.setSiblingIndex(canvas.children.length - 1);
            return;
        }
        const n = new Node(CATCHER_NAME);
        n.layer = canvas.layer;                  // 🔴 继承宿主 layer（UI_2D 会被相机剔除，见铁律 60）
        const ut = n.addComponent(UITransform);
        ut.setAnchorPoint(0.5, 0.5);
        ut.setContentSize(CATCHER_W, CATCHER_H);
        n.setParent(canvas);
        n.setPosition(0, 0, 0);
        n.setSiblingIndex(canvas.children.length - 1);
        n.on(Node.EventType.TOUCH_START, this._onDown, this);
        this._catcher = n;
    }

    /** 拆掉接事件节点（每次选择结束都拆，绝不留悬空的全屏吞事件层） */
    private removeCatcher(): void {
        const n = this._catcher;
        this._catcher = null;
        if (!n || !n.isValid) return;
        n.off(Node.EventType.TOUCH_START, this._onDown, this);
        n.removeFromParent();
        n.destroy();
    }

    /** 监听节点 = 沿父链找到的 Canvas（本组件本就挂在 Canvas 上） */
    private listenNode(): Node | null {
        let n: Node | null = this.node;
        while (n) {
            if (n.getComponent(Canvas)) return n;
            n = n.parent;
        }
        return this.node;
    }

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

    /** 事件里的 `getUILocation()` 是屏幕(UI)坐标，命中判定要的是世界坐标 */
    private uiToWorld(uiPos: Vec2 | Vec3): Vec3 {
        Vec3.set(_uiScratch, uiPos.x, uiPos.y, 0);
        const cam = this.uiCamera();
        if (cam) cam.screenToWorld(_uiScratch, _worldScratch);
        else Vec3.copy(_worldScratch, _uiScratch);
        return _worldScratch;
    }

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
    /** 选择条件 → 候选所在的战场 */
    private fieldFor(owner: SelectOwner, select: string): BattleFieldLayout | null {
        const want: SelectOwner = select === 'friendlyFollower' ? owner : (owner === 'player' ? 'enemy' : 'player');
        return this.fieldByOwner(want);
    }

    private fieldByOwner(owner: SelectOwner): BattleFieldLayout | null {
        const side = owner === 'player' ? BattleSide.Player : BattleSide.Enemy;
        const scene = this.node.scene as unknown as Node | null;
        if (!scene) return null;
        const stack: Node[] = [...scene.children];
        while (stack.length > 0) {
            const cur = stack.shift() as Node;
            const f = cur.getComponent(BattleFieldLayout);
            if (f && f.isValid && f.side === side) return f;
            for (const ch of cur.children) stack.push(ch);
        }
        return null;
    }

    private keywordSystem(): any {
        return this.findComp('CardKeywordSystem');
    }

    /** 战斗规则系统（`filter: 'damaged'` 之类的判定要问它）。 */
    private rulesSystem(): any {
        return this.findComp('BattleRuleSystem');
    }

    /** 全场景按类名 BFS 找组件（缓存交给调用方；这里只在进出选择模式时各扫一次） */
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
}
