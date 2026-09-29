/**
 * ===========================================================================
 * 🔴 术语（离场方式的两种，务必区分）
 * ---------------------------------------------------------------------------
 *   破坏 Destroy   —— 此前一直说的「死亡」。战场上卡的**常规死亡**：
 *                     从战场逻辑移除 → 播**破坏动画**（淡出/缩小/旋转）→ 销毁节点
 *                     → 动画播完后用**连续动画**重排战场。
 *   消失 Disappear —— 与破坏**并列**的另一种离场方式：不播破坏动画，直接从战场移除
 *                     （仍需等这一刻到达后再触发战场重排）。
 *   ⚠️ 本项目截至目前的「死亡 / Death」一律指**破坏 Destroy**；
 *      代码里若见到历史遗留的 death 前缀 / Death 命名，语义等同 Destroy。
 * ===========================================================================
 *
 * BattleCommand —— 战场「操作指令 / 演出」两套队列的类型与实现
 * ===========================================================================
 * 基层准则（本项目此后一切战场逻辑都遵守）：
 *
 *   1. **操作指令是唯一真源**。数值、能力、胜负、可选中性…… 全部由「操作指令」
 *      在**进入队列的那一刻**同步判定并立即结算。判定依据是**逻辑状态**，
 *      不是画面（演出还没播完也不影响判定）。
 *
 *   2. **演出不参与逻辑**。演出只是「操作指令完成后」的顺序展示：一个指令执行完，
 *      把要给人看的效果作为「演出片段(cue)」压进**演出队列**，由演出队列按顺序播放。
 *      演出**不是**伤害/死亡/目标的判断依据；反过来，也不允许靠「动画播完了」来触发结算。
 *
 *   3. **演出队列慢于指令队列，但顺序严格**。指令是瞬时的（同一帧内全部结算完），
 *      演出有物理时长，必然滞后；但二者严格同序 —— 演出队列是单通道 FIFO，
 *      同一时刻只播一个 cue，播完才播下一个，绝不插队。
 *      ⚠️ 唯一的例外是「**同一批同时发生**」的动作：它们会被合成**同一条 cue**
 *      （例如同时破坏 = 一条 Destroy cue 带 `entries` = 多张卡），由播放器**内部并发**
 *      开播、全部播完才让位给下一条 cue。cue 与 cue 之间仍然严格串行，
 *      所以「同时」永远是**一批之内**的同时，不会跨批次提前。
 *
 *   4. **只有满足合理条件的指令才准进入操作指令队列**。`enqueue` 先校验
 *      （例：目标是否还能被选、攻击者本回合是否已攻击、是否有守护/威慑拦截），
 *      不合法直接拒绝，连队列都不进。
 *
 *   5. **什么演出进队列、什么不进**：
 *        · 进队列 = 会改变「这一局已经发生的动作」的时序演出：攻击、反击、死亡、
 *          召唤、施法、抽卡……（必须和其它动作排先后）。
 *        · 不进队列（直接展示）= 纯 UI 反馈、不表达动作推进：选择时卡牌上升、
 *          选择光圈、hover 高亮…… 这些该怎么即时怎么即时，永远不等队列。
 *
 * ⚠️ 本文件不依赖任何具体玩法组件（不认识 BattleRuleSystem / 卡牌），
 *    只提供「队列」这一层通用机制，便于被任意玩法复用与单测。
 */

/** 操作指令类型（= 逻辑真源）。 */
export enum BattleCommandType {
    /** 随从攻击（目标是随从或主战者）。 */
    Attack = 'Attack',
    /** 直接伤害（未来：法术/亡语/效果结算）。 */
    Damage = 'Damage',
    /** 治疗。 */
    Heal = 'Heal',
    /** 增减攻/血（buff / debuff）。 */
    Buff = 'Buff',
    /**
     * **破坏**（= 此前一直说的「死亡」）：从战场逻辑移除，播放破坏动画，
     * 动画结束后再做「连续动画式」的战场重排。
     */
    Destroy = 'Destroy',
    /**\n     * 【消失】把卡牌从战场 / 手牌 / 牌组**除去**：**不进墓场**，也**不触发谢幕曲**等「被破坏时」的能力。\n     * 演出 = **破坏特效的反过来**（CardDestroyFx 的 everse 选项：光向内收，而不是往外扩）。\n     */
    Vanish = 'Vanish',
    /** 【入手牌展示】非抽卡入手牌的「中央展示 → 飞进手牌」演出（作为队列 cue ⇒ 与其它动画串行）。 */
    HandReveal = 'HandReveal',
    /**
     * **消失**（另一种离场方式，与「破坏」并列）：不播破坏动画，直接从战场移除。
     * 仍要等这一刻到达后再触发战场重排。
     */
    Disappear = 'Disappear',
    /** 随从进入战场。 */
    Summon = 'Summon',
    /** 抽卡。 */
    Draw = 'Draw',
    /** 施放法术。 */
    SpellCast = 'SpellCast',
    /** 纯占位等待（调试 / 让演出兜底）。 */
    Wait = 'Wait',
}

/** 演出片段类型（cue）。 */
export enum BattleCueType {
    /** 一次普通攻击的演出。 */
    Attack = 'Attack',
    /** 反击演出（本质上同样是一次普通攻击，单独命名以便区分/统计）。 */
    Counter = 'Counter',
    /** 受击反馈（非必需，留给后续）。 */
    Hit = 'Hit',
    /**
     * **破坏**演出（= 此前一直说的「死亡」演出）：淡出 / 缩小 / 旋转 → 销毁节点。
     * 播完后由 `Reflow` cue 负责战场的连续重排。
     */
    Destroy = 'Destroy',
    /**\n     * 【消失】把卡牌从战场 / 手牌 / 牌组**除去**：**不进墓场**，也**不触发谢幕曲**等「被破坏时」的能力。\n     * 演出 = **破坏特效的反过来**（CardDestroyFx 的 everse 选项：光向内收，而不是往外扩）。\n     */
    Vanish = 'Vanish',
    /** 【屏障破碎】屏障被伤害打掉时的破碎演出（排在攻击/反击动画之后）。 */
    BarrierBreak = 'BarrierBreak',
    /** 【入手牌展示】非抽卡入手牌的展示演出（队列 cue ⇒ 与其它动画串行）。 */
    HandReveal = 'HandReveal',
    /**
     * 【超进化破坏】演出：超进化随从攻击**破坏**对方随从的专属离场演出 ——
     * 光团收缩 + 卡牌持续变白 → 倾斜飞向对方主战者正中消失 → 主战者处光团迸发 +
     * 主战者血量显示推进到结算快照。播完后同样由 `Reflow` cue 负责战场重排。
     */
    SuperEvolveDestroy = 'SuperEvolveDestroy',
    /**
     * **消失**演出：与「破坏」并列的另一种离场方式 —— 不播破坏动画，直接移除节点。
     * 单独成 cue 是为了让它和别的离场/动作在演出队列里**严格同序**。
     */
    Disappear = 'Disappear',
    /**
     * 【纹章·子弹】纹章效果发动时的专属演出：**从纹章图标的中心发射一颗子弹
     * 飞到目标卡牌的中心**，随后（同一条指令后续的 cue）才是目标卡牌的破坏动画。
     *
     * 🔴 它和别的 cue 一样只是「展示」：纹章效果的**结算**（破坏判定 / 摘场 / 记墓场）
     *    在纹章触发的那一瞬间就同步做完了，**不等**这颗子弹飞完。
     */
    CrestBullet = 'CrestBullet',
    /**
     * 【能力攻击球】**能力**造成的攻击演出：用与普通攻击**完全同一颗特效球**
     * （`FollowerAttackOrbFx`，参数取自 `FollowerAttackAnim` 的 Inspector），从
     * `attacker` 中心飞向 `defender` 中心；**唯一区别 = 卡牌不旋转**。
     *
     * 用途：卡牌能力里的「破坏某个随从」这类动作（如卡 5 的「进化时 破坏受伤随从」）。
     * 🔴 同样只是展示：破坏的判定 / 摘场在能力结算时**同步**做完，不等球飞完。
     */
    AttackOrb = 'AttackOrb',
    /**
     * 【毒弹】卡牌能力**造成伤害**时的专属演出（卡 2「全力突围·可露凯」的分配伤害 /
     * 卡 6「异相浅眠·米什缇」的回合结束随机伤害）：一颗**紫色毒弹**从目标卡牌的
     * **右上方**沿直线射到**目标卡牌**（参数在 `Canvas/PoisonBulletFx` 的 Inspector 上：
     * 颜色 / 长短 / 粗细 / 最远出现距离 / 倾斜角度）。
     *
     * 🔴 只是展示：伤害与破坏在能力结算那一瞬间就同步做完了，不等这颗毒弹飞完。
     */
    PoisonBullet = 'PoisonBullet',
    /**
     * 战场排布重排（**连续动画**）。
     * 🔴 只能在「破坏 / 消失」动画**播完之后**触发 —— 绝不能在逻辑移除的瞬间直接 snap 到最新排布。
     */
    Reflow = 'Reflow',
    /** 进战场演出。 */
    Summon = 'Summon',
    /** 抽卡演出。 */
    Draw = 'Draw',
    /** 施法演出。 */
    SpellCast = 'SpellCast',
    /** 治疗演出。 */
    Heal = 'Heal',
    /** 增减属性演出。 */
    Buff = 'Buff',
    /**
     * 刷新血量 / 攻击等**数字显示**。
     * 🔴 数字属于「演出」：数值在指令进入队列时已当场变，但卡面数字要等攻击/反击动画
     *    播完才允许改变（否则会先掉血再攻击，因果颠倒）。该 cue 就是那个刷新时点。
     */
    RefreshNumbers = 'RefreshNumbers',
    /** 纯等待（保持节奏）。 */
    Wait = 'Wait',
    /** 批次结束标记：不做表演，只回调（保证 endPress 的收尾严格排在演出之后）。 */
    Done = 'Done',
}

/** 一条操作指令。用宽松索引签名承载各指令自己的字段，避免过早定型。 */
export interface BattleCommand {
    type: BattleCommandType | string;
    [key: string]: unknown;
}

/** 一段演出。 */
export interface BattleCue {
    type: BattleCueType | string;
    [key: string]: unknown;
}

/** 演出播放器：调用方负责在播完后调用 `done()`（必须且只能一次）。 */
export type BattleCuePlayer = (cue: BattleCue, done: () => void) => void;
/** 把 cue 解析成播放器；返回 null 表示「这段演出没实现 / 不需要播」。 */
export type BattleCueResolver = (cue: BattleCue) => BattleCuePlayer | null;

/**
 * 演出队列（单通道 FIFO）。
 *
 * · 同一时刻只播一个 cue：新 push 的 cue 只有在当前 cue 调 `done()` 之后才会开播；
 * · 顺序严格：内部只维护一个数组，永远 shift 头部，绝不重排；
 * · 同步完成的 cue（`done()` 当场调用 / 没有播放器）会立即让位给下一个 —— 因此
 *   「瞬时 cue」不会平白占用一帧；
 * · 播放器抛异常 → 记错误并强制 `done()`，避免整条队列卡死（铁律：tween 回调异常会被吞）。
 */
export class BattleCueQueue {
    private readonly _q: BattleCue[] = [];
    private _active = false;
    private _activeType: string | null = null;
    private readonly _resolve: BattleCueResolver;
    private readonly _onError: (e: unknown, cue: BattleCue) => void;

    constructor(resolve: BattleCueResolver, onError?: (e: unknown, cue: BattleCue) => void) {
        this._resolve = resolve;
        this._onError = onError || ((e, cue) => console.error('[BattleCueQueue] cue 播放出错：', cue && cue.type, e));
    }

    /** 是否正在播一个 cue（有物理时长的那种）。 */
    public get isPlaying(): boolean {
        return this._active;
    }

    /** 当前正在播的 cue 类型（无 = null）。 */
    public get playingType(): string | null {
        return this._activeType;
    }

    /** 排队等待播放的 cue 数量（不含正在播的）。 */
    public get pending(): number {
        return this._q.length;
    }

    /** 队列是否完全空闲（没有正在播、也没有等待）。 */
    public get isIdle(): boolean {
        return !this._active && this._q.length === 0;
    }

    /** 查看队列内容（调试 / 测试用；返回浅拷贝）。 */
    public snapshot(): BattleCue[] {
        return this._q.slice();
    }

    /** 依次压入若干 cue 并尝试开播。顺序 = 传入顺序。 */
    public push(...cues: Array<BattleCue | null | undefined>): void {
        let added = false;
        for (const c of cues) {
            if (!c) continue;
            this._q.push(c);
            added = true;
        }
        if (added) this.pump();
    }

    /** 清空**尚未开播**的 cue（不影响正在播的那个）。 */
    public clearPending(): void {
        this._q.length = 0;
    }

    /** 取队首并开播；播完（done）后自动继续下一个。 */
    private pump(): void {
        if (this._active) return;
        const cue = this._q.shift();
        if (!cue) return;

        this._active = true;
        this._activeType = String(cue.type);

        let settled = false;
        const finish = (): void => {
            if (settled) return;
            settled = true;
            this._active = false;
            this._activeType = null;
            this.pump();
        };

        let player: BattleCuePlayer | null = null;
        try {
            player = this._resolve(cue);
        } catch (e) {
            this._onError(e, cue);
            finish();
            return;
        }

        if (!player) { finish(); return; }

        try {
            player(cue, finish);
        } catch (e) {
            this._onError(e, cue);
            finish();
        }
    }
}
