import { Color,
    _decorator, Component, Node, Tween, tween, UIOpacity, Vec3,
} from 'cc';
import { BattleCommandType, BattleCueQueue, BattleCueType } from './BattleCommand';
import type { BattleCommand, BattleCue, BattleCuePlayer } from './BattleCommand';
import { BattleFieldLayout, BattleSide } from './BattleFieldLayout';
import { addToGrave } from './CardDeckManager';
import { cardIdFromNodeName } from './CardGlow';
import { attackFxColorOf, attackFxCurveOf, attackFxOf, getCardInfo } from './CardData';
import { BattleDamageResult, BattleRuleSystem } from './BattleRuleSystem';
import { FollowerAttackAnim } from './FollowerAttackAnim';
import { HeroArea } from './HeroArea';
import { killNode } from './CardComposer';
import { CardDestroyFx } from './CardDestroyFx';
import { CrestBulletFx } from './CrestBulletFx';
import { PoisonBulletFx } from './PoisonBulletFx';
import { MissileStrikeFx } from './MissileStrikeFx';
import { PlasmaBoltFx } from './PlasmaBoltFx';
import { FlameSweepFx } from './FlameSweepFx';
import { revealCardToHand } from './CardAbilitySystem';
import { breakBarrierFx } from './BarrierFx';
import { DamageNumberFx } from './DamageNumberFx';
import { flushNumbers } from './DamageNumberQueue';
import { SuperEvolveDestroyFx } from './SuperEvolveDestroyFx';

const { ccclass, property, menu } = _decorator;

/** `enqueue` 的返回：是否被接受 + 原因 + 该指令产生的演出片段数。 */
export interface CommandEnqueueResult {
    accepted: boolean;
    reason?: string;
    /** 本指令产生的 cue 数量（不含批次结束标记）。 */
    cues: number;
}

/**
 * BattleCommandSystem —— 战场操作指令队列 + 演出队列（基层设施）
 * ===========================================================================
 * 详见 `BattleCommand.ts` 顶部「基层准则」。本组件负责把准则落地：
 *
 *   ┌─ 操作指令队列（逻辑真源，瞬时）──────────────────────────────┐
 *   │  enqueue(cmd) → 校验 → 执行（改数值 / 破坏 / 登记） → 产出 cue │
 *   └───────────────────────────────────────────────────────────┘
 *                    │ 顺序压入（同一帧内可能压很多条）
 *                    ▼
 *   ┌─ 演出队列（单通道 FIFO，有时间，严格同序）──────────────────┐
 *   │  Attack → Counter → RefreshNumbers → Destroy → Reflow → …  │
 *   └───────────────────────────────────────────────────────────┘
 *
 * 关键点：
 *   · 指令**在进入队列那一刻**就把该改的都改了（血量、破坏、攻击次数）；
 *     被破坏的随从**立刻**从战场逻辑集合里摘除 —— 所以它正播破坏动画时已经
 *     不可被选中、不亮选择光圈、不参与守护计数。
 *   · 演出只是「按指令执行结果排好队」的展示，绝不反过来驱动结算。
 *   · 选择卡牌上升 / 选择光圈等**纯 UI 反馈**不进队列（直接展示），
 *     由 `BattleFieldPressGlow` 自己即时处理。
 *
 * 挂载：`Canvas/PlayerBattleFieldArea`（与 BattleRuleSystem / FollowerAttackAnim 同节点）。
 * 依赖都用「本节点 → 全场景 BFS」解析，留空即可，避免和具体节点名绑死。
 */
@ccclass('BattleCommandSystem')
@menu('gf2szb/BattleCommandSystem')
export class BattleCommandSystem extends Component {

    // ====================== 演出参数（Inspector 暴露）======================
    @property({
        range: [0, 2, 0.01], slide: true,
        tooltip: '【破坏演出时长（秒）】随从被判定「破坏」后，节点在演出队列里淡出/缩小所需时间。\n'
            + '注意：「破坏」的**判定**发生在指令进入队列的瞬间，这里只决定可见的破坏动画播多久。\n'
            + '术语：破坏 Destroy（此前的「死亡」）有破坏动画；消失 Disappear 无动画，是另一种离场方式。',
    })
    destroyDuration = 0.34;

    @property({
        range: [0, 1, 0.01], slide: true,
        tooltip: '破坏演出结束时缩小到的比例（1 = 不缩小，仅淡出）。',
    })
    destroyEndScale = 0.24;

    @property({
        range: [-360, 360, 1], slide: true,
        tooltip: '破坏演出中卡牌绕 Z 轴旋转的角度（0 = 不旋转）。',
    })
    destroySpinDegrees = -18;

    @property({
        tooltip: '破坏演出是否做透明度淡出（关闭 = 只缩小/旋转）。',
    })
    destroyFade = true;

    @property({
        range: [0, 2, 0.01], slide: true,
        tooltip: '【战场重排动画时长（秒）】破坏 / 消失动画**播完之后**，其余战场卡牌连续移动到位所需时间。\n'
            + '0 = 瞬时重排（瞬移）。',
    })
    reflowDuration = 0.28;

    @property({
        range: [0, 2, 0.01], slide: true,
        tooltip: '【Wait 演出默认时长（秒）】用于给连续动作之间留节奏。',
    })
    waitDuration = 0.12;

    @property({
        range: [0, 64, 1], slide: true,
        tooltip: '调试用：保留最近多少条指令 / cue 的历史（0 = 不保留）。',
    })
    historyLimit = 24;

    // ====================== 依赖（留空自动解析）======================
    @property({
        type: BattleRuleSystem,
        tooltip: '对战规则入口。留空 = 本节点/全场景 BFS 解析。',
    })
    rules: BattleRuleSystem | null = null;

    @property({
        type: FollowerAttackAnim,
        tooltip: '攻击演出组件。留空 = 本节点/全场景 BFS 解析。',
    })
    attackAnim: FollowerAttackAnim | null = null;

    // ====================== 内部状态 ======================
    /** 演出队列（单通道 FIFO）。 */
    private _cues: BattleCueQueue | null = null;
    /** 待执行的操作指令（正常情况下同步清空；保留结构以便未来做「排队一帧」）。 */
    private readonly _cmdQ: BattleCommand[] = [];
    /** 正在执行指令（重入保护：执行中再 enqueue 的指令会追加到队尾，按序继续）。 */
    private _draining = false;
    /** 指令历史（真源记录，调试/测试用）。 */
    private readonly _cmdHistory: BattleCommand[] = [];
    /** cue 历史（调试/测试用）。 */
    private readonly _cueHistory: BattleCue[] = [];
    /** cue **实际播放**顺序（调试/测试用；push 顺序与播放顺序都留档）。 */
    private readonly _playHistory: BattleCue[] = [];
    /** 「本指令触发的**破坏**」收集器：BattleRuleSystem 通过 destroySink 回调写入。 */
    private readonly _pendingDestroys: Array<{ card: Node; field: BattleFieldLayout | null }> = [];
    /** 本指令涉及、需要**在破坏/消失动画播完后**做连续重排的战场（去重）。 */
    private readonly _pendingReflow: BattleFieldLayout[] = [];
    /**
     * 「**同时破坏**」批次（可选，见 `beginDestroyBatch` / `endDestroyBatch`）。
     *
     * 把**同一批同时发生**的多张卡破坏攒成**一条** Destroy cue（`entries` = 多张卡）⇒
     * 演出队列把这一组当作**一段**演出：组内每张卡的破坏动画**同时开播**，
     * **全部播完**才走 Reflow。于是「同一批死亡」不再是
     * 「破坏→重排→破坏→重排」一张一张排队（旧行为），而是齐刷刷一起爆。
     *
     * 触发场景：多卡牌伤害 / 全场伤害 / 分配伤害 / 同一句效果里的同时破坏。
     * null = 当前没有打开的批次（= 老行为：每条 Destroy 各占一段演出）。
     */
    private _destroyBatch: {
        entries: Array<{ card: Node; field: BattleFieldLayout | null }>;
        reflows: BattleFieldLayout[];
        dones: Array<() => void>;
    } | null = null;
    /** 「同时破坏」批次嵌套层数（成对调用；最外层 end 时才真正入队）。 */
    private _destroyBatchDepth = 0;
    /** 演出队列本次批次产生的 cue 数（供 enqueue 返回）。 */
    private _lastCueCount = 0;
    /** 「延迟排队」嵌套层数（> 0 = 新 cue 只攒不入队，见 beginDeferCues） */
    private _deferDepth = 0;
    /** 延迟排队攒下的演出（按调用顺序；flush 时原样入队） */
    private readonly _deferred: Array<{ cues: BattleCue[]; count: boolean }> = [];
    /** 正在播破坏演出的节点（防重复；也用于收尾清理）。 */
    private readonly _destroying = new Set<Node>();
    /** 缓存：规则 / 动画组件。 */
    private _ruleCache: BattleRuleSystem | null = null;
    private _animCache: FollowerAttackAnim | null = null;

    // ------------------------------ 生命周期 ------------------------------
    onLoad(): void {
        this._cues = new BattleCueQueue(
            (cue) => this.resolveCuePlayer(cue),
            (e, cue) => console.error('[BattleCommandSystem] 演出播放出错：', cue && cue.type, e),
        );
        this.bindDestroySink(true);
    }

    onEnable(): void {
        this.bindDestroySink(true);
    }

    onDisable(): void {
        this.bindDestroySink(false);
        this.clearDying();
    }

    // ------------------------------ 对外查询 ------------------------------
    /** 演出队列是否完全空闲。 */
    public get isIdle(): boolean {
        return !this._cues || this._cues.isIdle;
    }

    /** 演出队列是否正在播一个 cue。 */
    public get isPlaying(): boolean {
        return !!this._cues && this._cues.isPlaying;
    }

    /** 当前正在播的 cue 类型。 */
    public get playingCue(): string | null {
        return this._cues ? this._cues.playingType : null;
    }

    /** 等待播放的 cue 数量（不含正在播的）。 */
    public get pendingCues(): number {
        return this._cues ? this._cues.pending : 0;
    }

    /** 最近一条操作指令（null = 无）。 */
    public get lastCommand(): BattleCommand | null {
        return this._cmdHistory.length > 0 ? this._cmdHistory[this._cmdHistory.length - 1] : null;
    }

    /** 最近一条 cue（null = 无）。 */
    public get lastCue(): BattleCue | null {
        return this._cueHistory.length > 0 ? this._cueHistory[this._cueHistory.length - 1] : null;
    }

    /** 指令历史副本。 */
    public commandHistory(): BattleCommand[] {
        return this._cmdHistory.slice();
    }

    /** cue 历史副本。 */
    public cueHistory(): BattleCue[] {
        return this._cueHistory.slice();
    }

    /** cue 的**实际播放顺序**副本（严格 FIFO 的证据）。 */
    public playHistory(): BattleCue[] {
        return this._playHistory.slice();
    }

    /** cue 实际播放顺序的类型串（便于断言）。 */
    public playOrder(): string[] {
        return this._playHistory.map((c) => String(c.type));
    }

    /** 清空历史（测试用）。 */
    public clearHistory(): void {
        this._cmdHistory.length = 0;
        this._cueHistory.length = 0;
        this._playHistory.length = 0;
    }

    // ------------------------------ 操作指令入口 ------------------------------
    /**
     * 压入一条操作指令。
     * 🔴 校验通过后**立即同步执行**（改数值 / 破坏 / 登记），产出演出片段压入演出队列。
     * 返回 accepted=false 表示这条指令根本不合法，连队列都没进（不会产生任何演出）。
     */
    public enqueue(cmd: BattleCommand): CommandEnqueueResult {
        const reason = this.validate(cmd);
        if (reason) return { accepted: false, reason, cues: 0 };

        this._lastCueCount = 0;
        const onDone = (cmd as { onDone?: () => void }).onDone;
        this._cmdQ.push(cmd);
        this.drain();
        // 批次结束标记：无论哪种指令，都把回调排在该指令产生的全部 cue 之后 ——
        // 「演出全部播完才收尾」是全局保证，不依赖某一种指令自己记得加。
        if (typeof onDone === 'function') this.pushCues([{ type: BattleCueType.Done, cb: onDone } as BattleCue], false);
        return { accepted: true, cues: this._lastCueCount };
    }

    /**
     * 便捷入口：随从攻击随从 / 主战者。校验走 BattleRuleSystem.canTarget。
     * @param onDone 本次指令的**演出全部播完**后回调（严格排在演出队列之后）。
     */
    public enqueueAttack(attacker: Node, defender: Node, onDone?: () => void): CommandEnqueueResult {
        return this.enqueue({
            type: BattleCommandType.Attack,
            attacker,
            defender,
            onDone,
        } as BattleCommand & { attacker: Node; defender: Node; onDone?: () => void });
    }

    /**
     * 供其它系统把一段演出排入**演出队列**（顺序 = 调用顺序）。
     * 用它可以做到「演出不错序」而无需把逻辑也搬进指令队列 ——
     * 例：抽卡 / 召唤动画想和一次攻击的破坏动画排队，就 push 一个 cue。
     * ⚠️ 纯 UI 反馈（选择上升 / 选择光圈）**不要**走这里，直接展示即可。
     */
    public pushCue(cue: BattleCue): void {
        if (!cue) return;
        this.pushCues([cue], false);
    }

    /** 手动压入一段「批次结束」回调（调试 / 测试用）。 */
    public whenIdle(cb: () => void): void {
        if (!this._cues) { cb(); return; }
        if (this._cues.isIdle) { cb(); return; }
        this.pushCues([{ type: BattleCueType.Done, cb } as BattleCue], true);
    }

    /**
     * 把**战场上的一张卡**按「破坏」离场，并排入演出队列
     * —— 供舞台之外的系统调用（当前用于护符的 `DestroySelf`）。
     *
     * 与「随从在战斗结算里被破坏」走**完全同一条链路**，因此观感完全一致：
     *   ① 立刻 `detachCardNode(card, false, false)`：摘除战场**逻辑**（不可选 / 不亮光圈 /
     *      不计守护 / 不占位），**保留节点**，且 **relayout=false（绝不立刻重排）**；
     *   ② 压入 `Destroy` cue：播破坏动画 + 特效（`CardDestroyFx` 自己负责在迸发瞬间销毁节点）；
     *   ③ 再压入 `Reflow` cue：破坏动画**播完之后**用 `layoutAnimated` 连续动画重排战场。
     *
     * 🔴 这就是「护符被破坏时战场排布必须有动画、不能一下更新」的实现基础：
     *    逻辑移除的那一瞬间绝不 snap，排布更新只发生在 Reflow cue。
     * @param field  卡牌所属战场；留空 = 沿父链自动解析
     * @param onDone 本次 `Destroy + Reflow` **播完之后**的回调（可选）
     * @returns 是否成功接手（false = 卡牌无效 / 不在任何战场上的记录里 → 调用方自行兜底）
     */
    public destroyCardOnField(card: Node, field?: BattleFieldLayout | null,
        onDone?: () => void): boolean {
        if (!card || !card.isValid) return false;
        const rules = this.rulesOf();
        if (rules && typeof rules.canDestroyByAbility === 'function'
            && rules.canDestroyByAbility(card) !== true) {
            // 「已被处理」= 拒绝这次直接破坏，且绝不能落到调用方的强制移除兜底。
            return true;
        }
        const f = (field && field.isValid) ? field : this.fieldOfCard(card);
        if (!f || !f.isValid) return false;
        // 摘逻辑、留节点、**不重排**（排布交给 Reflow cue）
        if (!f.detachCardNode(card, false, false)) return false;
        // 墓场记账：与 BattleRuleSystem.destroyCard 同一口径 —— **逻辑破坏这一刻** +1，不等破坏动画。
        try {
            addToGrave(this.node, f.side === BattleSide.Player ? 'player' : 'enemy', cardIdFromNodeName(card.name));
        } catch (e) {
            console.error('[BattleCommandSystem] 墓场记账失败：', e);
        }
        // 🔴 批次内（同时破坏）：先只攒着 —— 多张卡最终会共用**一条** Destroy cue，
        //    这样演出队列会把这组破坏放在同一段里**同时**播（见 endDestroyBatch）。
        if (this._destroyBatch) {
            this._destroyBatch.entries.push({ card, field: f });
            if (this._destroyBatch.reflows.indexOf(f) < 0) this._destroyBatch.reflows.push(f);
            if (typeof onDone === 'function') this._destroyBatch.dones.push(onDone);
            return true;
        }
        this.pushCues([
            { type: BattleCueType.Destroy, card, field: f } as BattleCue,
            { type: BattleCueType.Reflow, field: f } as BattleCue,
        ], true);
        if (typeof onDone === 'function') {
            this.pushCues([{ type: BattleCueType.Done, cb: onDone } as BattleCue], false);
        }
        return true;
    }

    /**
     * 打开「**同时破坏**」批次：此窗口内所有破坏（`destroyCardOnField`）先攒着，
     * `endDestroyBatch()` 时按 **[一条 Destroy(entries = N 张卡), 各战场各一条 Reflow, 各 onDone]**
     * 一次性入队 ⇒ 演出队列把这一组当**一段**：N 张卡的破坏动画**同时**播放，
     * 全部播完才重排。
     *
     * 用法（务必 try/finally 成对）：
     *     cmds.beginDestroyBatch();
     *     try { for (const card of doomed) destroyFieldCard(host, card); }
     *     finally { cmds.endDestroyBatch(); }
     *
     * 🔴 只包「同一批**同时**发生」的破坏；有先后的破坏（如攻击 → 反击的连锁）不要包在一起。
     * 支持嵌套（成对调用，最外层的 end 才真正入队）；没打开批次时 `endDestroyBatch` 是空操作。
     */
    public beginDestroyBatch(): void {
        if (this._destroyBatchDepth === 0) {
            this._destroyBatch = { entries: [], reflows: [], dones: [] };
        }
        this._destroyBatchDepth++;
    }

    /** 关闭「同时破坏」批次并把它作为**一段**演出入队（最外层调用时生效）。 */
    public endDestroyBatch(): void {
        if (this._destroyBatchDepth === 0) return;
        this._destroyBatchDepth--;
        if (this._destroyBatchDepth > 0) return;          // 还有外层没结束
        const b = this._destroyBatch;
        this._destroyBatch = null;
        if (!b) return;
        const cues: BattleCue[] = [];
        if (b.entries.length > 0) {
            // 🔴 一条 cue 承载 N 张卡 = 「同时破坏组」（playDestroyCue 会并发开播）
            cues.push({ type: BattleCueType.Destroy, entries: b.entries.slice() } as BattleCue);
        }
        for (const f of b.reflows) {
            if (f && f.isValid) cues.push({ type: BattleCueType.Reflow, field: f } as BattleCue);
        }
        for (const cb of b.dones) cues.push({ type: BattleCueType.Done, cb } as BattleCue);
        if (cues.length > 0) this.pushCues(cues, true);
    }

    /** 当前是否在「同时破坏」批次里（调试 / 探针用） */
    public get isDestroyBatchOpen(): boolean {
        return this._destroyBatchDepth > 0;
    }

    // ------------------------------ 校验（只认逻辑状态）----------------------
    /**
     * 指令准入门槛。
     * @returns null = 允许进入；非空字符串 = 拒绝原因（不进入队列）。
     */
    private validate(cmd: BattleCommand): string | null {
        if (!cmd || typeof cmd.type !== 'string') return '指令为空 / 缺少 type';
        switch (cmd.type) {
            case BattleCommandType.Attack:
                return this.validateAttack(cmd);
            case BattleCommandType.Disappear:
                return this.validateDisappear(cmd);
            case BattleCommandType.Wait:
                return null;
            default:
                // 其余指令类型暂未实现校验，先放行（后续按需补），避免「悄悄吞指令」。
                return null;
        }
    }

    private validateAttack(cmd: BattleCommand): string | null {
        const attacker = cmd.attacker as Node | null;
        const defender = cmd.defender as Node | null;
        if (!attacker || !attacker.isValid) return '攻击者无效';
        if (!defender || !defender.isValid) return '目标无效';
        if (attacker === defender) return '不能攻击自己';
        const rules = this.rulesOf();
        if (!rules) return '找不到 BattleRuleSystem';
        // 🔴 目标合法性统一问 BattleRuleSystem（含 守护 / 威慑 / 已攻击 / 阵营 / 是否已被破坏）。
        if (typeof rules.canTarget === 'function' && rules.canTarget(attacker, defender) !== true) {
            return '目标不合法（守护 / 威慑 / 已攻击 / 阵营不符等）';
        }
        return null;
    }

    // ------------------------------ 指令执行（瞬时）----------------------
    /** 顺序抽干指令队列（执行中新增的指令会追加到队尾继续执行，保证顺序）。 */
    private drain(): void {
        if (this._draining) return;      // 重入 → 让外层循环继续处理
        this._draining = true;
        try {
            while (this._cmdQ.length > 0) {
                const cmd = this._cmdQ.shift() as BattleCommand;
                this.record(this._cmdHistory, cmd);
                try {
                    this.execute(cmd);
                } catch (e) {
                    console.error('[BattleCommandSystem] 指令执行出错：', cmd && cmd.type, e);
                }
            }
        } finally {
            this._draining = false;
        }
    }

    private execute(cmd: BattleCommand): void {
        switch (cmd.type) {
            case BattleCommandType.Attack:
                this.execAttack(cmd);
                break;
            case BattleCommandType.Disappear:
                this.execDisappear(cmd);
                break;
            case BattleCommandType.Wait:
                this.pushCues([{ type: BattleCueType.Wait, duration: cmd.duration } as BattleCue], false);
                break;
            default:
                console.warn(`[BattleCommandSystem] 未实现的指令类型：${cmd.type}`);
                break;
        }
    }

    /**
     * 执行一次攻击指令：
     *   ① 立即调用 BattleRuleSystem.resolveCombat —— 同步结算血量 + 判定破坏（被破坏的随从
     *      被 BattleRuleSystem 通过 destroySink 立即摘出战场逻辑集合，节点保留待演出）；
     *   ② 把「攻击 → 反击 → 刷新数字 → 破坏 × N → 连续重排 → 批次结束」按顺序压入演出队列。
     * 注意：这里**不**播放任何动画，只排队。
     */
    private validateDisappear(cmd: BattleCommand): string | null {
        const card = cmd.card as Node | null;
        if (!card || !card.isValid) return '消失目标无效';
        if (!this.fieldOfCard(card)) return '消失目标不在战场上';
        return null;
    }

    /**
     * 执行一次**消失**指令（与破坏并列的另一种离场方式）：
     * 立即从战场逻辑集合摘除（不可选 / 不计守护），**不立即重排**；
     * 压入 `Disappear`（瞬时移除节点）→ `Reflow`（连续重排）两条 cue。
     */
    private execDisappear(cmd: BattleCommand): void {
        const card = cmd.card as Node;
        if (!card || !card.isValid) return;
        const field = (cmd.field as BattleFieldLayout | undefined) || this.fieldOfCard(card);
        if (!field || !field.isValid) return;
        if (!field.detachCardNode(card, false, false)) return;   // 摘逻辑、留节点、**不重排**
        if (this._pendingReflow.indexOf(field) < 0) this._pendingReflow.push(field);
        this.pushCues([
            { type: BattleCueType.Disappear, card } as BattleCue,
            { type: BattleCueType.Reflow, field } as BattleCue,
        ], true);
    }

    /** 沿父链找卡牌所属战场。 */
    private fieldOfCard(card: Node): BattleFieldLayout | null {
        let n: Node | null = card ? card.parent : null;
        while (n) {
            const f = n.getComponent(BattleFieldLayout);
            if (f && f.isValid) return f;
            n = n.parent;
        }
        return null;
    }

    private execAttack(cmd: BattleCommand): void {
        const attacker = cmd.attacker as Node;
        const defender = cmd.defender as Node;
        const rules = this.rulesOf();
        if (!rules || typeof rules.resolveCombat !== 'function') return;

        this._pendingDestroys.length = 0;
        let result: unknown = null;
        // 本条指令的**数字显示快照**（本指令结算后的血量/攻击；不是后续指令累加后的最终值）。
        let displayBatch: unknown = null;
        const began = typeof rules.beginDeferredResolve === 'function';
        const beganDisplay = typeof rules.beginDeferredDisplay === 'function';
        try {
            // 打开「延迟破坏」窗口：本次结算中被破坏的随从**立即**摘除战场逻辑（不可选 /
            // 不计守护），节点保留并记入 _pendingDestroys，交给破坏演出播完再销毁。
            if (began) rules.beginDeferredResolve();
            // 打开「延迟数字显示」窗口：血量/攻击的**逻辑值**当场变，但卡面数字冻结 ——
            // 等演出队列播到 RefreshNumbers（攻击/反击动画播完）才刷新，避免「先掉血再攻击」。
            if (beganDisplay) rules.beginDeferredDisplay();
            result = rules.resolveCombat(attacker, defender);
        } finally {
            // 🔴 取走**本条指令**的快照再关窗口：多条指令连续攻击同一目标时，
            //    各自持有一份快照 ⇒ 数字随每段攻击动画逐段推进，而不是一起跳到最终逻辑值。
            if (beganDisplay && typeof rules.endDeferredDisplay === 'function') {
                try { displayBatch = rules.endDeferredDisplay(); } catch (e) { console.error('[BattleCommandSystem] 取显示快照出错：', e); }
            }
            if (began && typeof rules.endDeferredResolve === 'function') rules.endDeferredResolve();
            // 失败路径下清干净，避免把上一次的破坏带到下一次结算。
            if (result == null) this._pendingDestroys.length = 0;
        }
        if (result == null) {
            this._pendingDestroys.length = 0;
            return;
        }

        const cues: BattleCue[] = [];
        const isHero = !!defender.getComponent(HeroArea);
        // 【超进化破坏】超进化随从攻击**破坏**了对方随从（逻辑上对方依旧反击，
        // 但伤害被超进化守护转为 0 —— resolveCombat 已结算；这里只决定**不播反击动画**）。
        const res = result as BattleDamageResult;
        const superEvolveBreak = !!(res && res.superEvolveBreak
            && res.superBreakHero && res.superBreakHero.isValid);

        // ① 攻击方的一次普通攻击
        cues.push({ type: BattleCueType.Attack, attacker, defender } as BattleCue);
        // ② 随从对随从 → 被攻击方反击（与现有规则一致：同时结算，故即使被破坏也播反击）。
        //    【超进化破坏】例外：逻辑上照样反击（伤害转 0），但**不播反击动画**。
        if (!isHero && !superEvolveBreak && !(res && res.contactCancelled)) {
            cues.push({ type: BattleCueType.Counter, attacker: defender, defender: attacker } as BattleCue);
        }
        // ③ 数字显示刷新：**攻击/反击动画播完之后**才允许改变卡面血量/攻击（显示属于演出）。
        //    携带**本条指令**的快照 → 多段攻击时每次只推进一段。
        if (displayBatch) {
            cues.push({ type: BattleCueType.RefreshNumbers, batch: displayBatch } as BattleCue);
        } else if (typeof rules.flushDeferredDisplay === 'function' && rules.hasDeferredDisplay) {
            cues.push({ type: BattleCueType.RefreshNumbers } as BattleCue);
        }
        // ★★ 【屏障破碎】排在攻击 / 反击 / 跳血**之后**（需求：攻击特效播完才取消屏障特效）。
        //    屏障在 resolveCombat 里就被消耗了（逻辑），破碎演出在这里才入队 ⇒ 罩会一直挂到这一段结束。
        try {
            const pend = (rules as unknown as { takePendingBarrierBreaks?: () => Node[] }).takePendingBarrierBreaks;
            const brk = typeof pend === 'function' ? pend.call(rules) : [];
            if (brk && brk.length > 0) cues.push({ type: BattleCueType.BarrierBreak, cards: brk } as BattleCue);
        } catch (e) { console.error('[BattleCommandSystem] 排入屏障破碎演出失败：', e); }

        // ④ 破坏演出（顺序 = 规则里判定破坏的顺序：先目标，后攻击者）。
        //    【超进化破坏】目标卡换成专属演出：光团收缩+持续变白 → 倾斜飞向对方主战者
        //    → 主战者处光团迸发 + 血量显示推进（见 SuperEvolveDestroyFx）。
        //    🔴 Reflow 排在本演出之后 ⇒ 战场排布在整段动画里保持不变。
        const destroyGroup: Array<{ card: Node; field: BattleFieldLayout | null }> = [];
        const flushDestroyGroup = (): void => {
            if (destroyGroup.length === 0) return;
            // 🔴 一次攻击里被判破坏的多张卡（目标 + 攻击者）= **同一批同时死亡** ⇒
            //    合成**一条** Destroy cue（entries），由 playDestroyCue 并发开播，不再一张一张排队。
            cues.push({ type: BattleCueType.Destroy, entries: destroyGroup.slice() } as BattleCue);
            destroyGroup.length = 0;
        };
        for (let i = 0; i < this._pendingDestroys.length; i++) {
            const d = this._pendingDestroys[i];
            if (superEvolveBreak && d.card === res.defender) {
                // 专属演出是**单独一段**（长动画：飞向主战者）→ 先把它前面的普通破坏收口
                flushDestroyGroup();
                cues.push({
                    type: BattleCueType.SuperEvolveDestroy,
                    card: d.card,
                    field: d.field,
                    heroNode: res.superBreakHero!.node,
                    heroHp: res.superBreakHeroHpAfter,
                } as BattleCue);
                continue;
            }
            destroyGroup.push({ card: d.card, field: d.field });
        }
        flushDestroyGroup();
        this._pendingDestroys.length = 0;

        // ⑤ 战场重排：**所有破坏/消失动画播完之后**再用连续动画更新排布。
        //    🔴 逻辑移除时已经 relayout=false（卡牌瞬间从集合摘除但不移动其它卡），
        //       所以这里才第一次真正重排 —— 绝不会"动画还没播就先 snap 到最新排布"。
        for (let i = 0; i < this._pendingReflow.length; i++) {
            cues.push({ type: BattleCueType.Reflow, field: this._pendingReflow[i] } as BattleCue);
        }
        this._pendingReflow.length = 0;

        // ⑤ 批次结束标记由 enqueue() 统一追加（保证回调严格排在全部 cue 之后）
        this.pushCues(cues, true);
    }

    /** 把 cue 压入演出队列（记录历史 + 计数）。 */
    private pushCues(cues: BattleCue[], count: boolean): void {
        if (!this._cues) return;
        if (this._deferDepth > 0) {
            // 🔴 延迟排队中：先按原顺序攒着（此刻**不入队**，所以不会插进正在播的动画里）
            this._deferred.push({ cues: cues.slice(), count });
            return;
        }
        for (const c of cues) if (c) this.record(this._cueHistory, c);
        if (count) this._lastCueCount += cues.length;
        this._cues.push(...cues);
    }

    // ------------------------------ 演出「延迟排队」：逻辑先结算、动画后播 --------------
    /**
     * 开始**延迟排队**：此后压入演出队列的 cue 都先攒在缓冲区，直到 `flushDeferredCues()`
     * 才按原顺序真正入队。
     *
     * 🔴 用途 = 把「**逻辑结算**」和「**演出顺序**」解耦：
     *    回合结束时触发的纹章效果，其破坏的**数据**必须当场结算（摘战场 / 记墓场 / 触发后续连锁），
     *    但它的动画**不该插到正在播的动画（如进化特效）中间** ⇒
     *    先 `beginDeferCues()` → 结算逻辑 → 等当前演出播完 → 再 `flushDeferredCues()`
     *    把这段演出编在**所有已有动画的最后**。
     * 支持嵌套（成对调用；最外层 flush 才真正入队）。
     */
    public beginDeferCues(): void {
        this._deferDepth++;
    }

    /** 结束延迟并把攒下的 cue 按原顺序入队（最外层调用时生效）。 */
    public flushDeferredCues(): void {
        if (this._deferDepth > 0) this._deferDepth--;
        if (this._deferDepth > 0) return;
        if (this._deferred.length === 0) return;
        const list = this._deferred.slice();
        this._deferred.length = 0;
        for (const item of list) this.pushCues(item.cues, item.count);
    }

    /** 缓冲区里还攒着多少段未入队的演出（调试 / 探针用） */
    public get deferredCueCount(): number {
        let n = 0;
        for (const item of this._deferred) n += item.cues.length;
        return n;
    }

    // ------------------------------ 演出播放器注册 ------------------------------
    /** cue → 播放器。未注册的 cue 视为「瞬时完成」（不卡队列）。 */
    private resolveCuePlayer(cue: BattleCue): BattleCuePlayer | null {
        // 记录「实际播放顺序」：只有被演出队列取出、真正要播的 cue 才进这里，
        // 因此 playOrder() 就是 FIFO 严格同序的直接证据。
        this.record(this._playHistory, cue);
        switch (cue.type) {
            case BattleCueType.Attack:
            case BattleCueType.Counter:
                return this.playAttackCue;
            case BattleCueType.Destroy:
                return this.playDestroyCue;
            case BattleCueType.Vanish:
                return this.playVanishCue;
            case BattleCueType.HandReveal:
                return this.playHandRevealCue;
            case BattleCueType.BarrierBreak:
                return this.playBarrierBreakCue;
            case BattleCueType.CrestBullet:
                return this.playCrestBulletCue;
            case BattleCueType.AttackOrb:
                return this.playAttackOrbCue;
            case BattleCueType.PoisonBullet:
                return this.playPoisonBulletCue;
            case BattleCueType.SuperEvolveDestroy:
                return this.playSuperEvolveDestroyCue;
            case BattleCueType.Disappear:
                return this.playDisappearCue;
            case BattleCueType.Reflow:
                return this.playReflowCue;
            case BattleCueType.RefreshNumbers:
                return this.playRefreshNumbersCue;
            case BattleCueType.Wait:
                return this.playWaitCue;
            case BattleCueType.Done:
                return this.playDoneCue;
            default:
                return null;
        }
    }

    /** 攻击 / 反击：一次普通攻击（卡牌旋转 + 特效球）。 */
    private readonly playAttackCue = (cue: BattleCue, done: () => void): void => {
        // ★ 这一段播完（特效球已打到目标）⇒ 把属于本段的飘字放出来：
        //   攻击 cue ⇒ 'attack'（目标挨的那一下）、反击 cue ⇒ 'counter'（攻击者挨的那一下）。
        //   🔴 分阶段投递就是为了「数字不同时出现」（用户口径：数字是动画的一部分）。
        const cuePhase = cue.type === BattleCueType.Counter ? 'counter' : 'attack';
        const doneWithNumbers = (): void => {
            try { flushNumbers(cuePhase); } catch (e) { console.error('[BattleCommandSystem] 战斗飘字失败：', e); }
            done();
        };
        const attacker = cue.attacker as Node;
        const defender = cue.defender as Node;
        // ★ **卡牌专属攻击特性**（CardData.CARD_ATTACK_FX）：卡 12「自巡炮」= 电浆闪电。
        //   配了就**改用电浆弹**（从攻击者射向目标，命中爆裂），否则走原来的随从攻击演出。
        if (attacker && attacker.isValid && defender && defender.isValid
            && attackFxOf(cardIdFromNodeName(attacker.name)) === 'plasmaBolt') {
            const plasma = PlasmaBoltFx.instance;
            const anim2 = this.animOf();
            if (plasma && anim2 && typeof anim2.playSingleAttack === 'function') {
                // 🔴 需求：普通攻击**依旧要旋转卡牌自身** ⇒ 借 playSingleAttack 的旋转，
                //    但 skipOrb=true 跳过它内置的特效球，改由电浆弹负责弹道。
                //    两者**同时**开播，**都结束**才算这一段演出结束。
                let left = 2;
                let settled = false;
                const one = (): void => {
                    if (settled) return;
                    left--;
                    if (left > 0) return;
                    settled = true;
                    doneWithNumbers();
                };
                try {
                    anim2.playSingleAttack(attacker, defender, one, true);
                } catch (e) {
                    console.error('[BattleCommandSystem] 电浆攻击的卡牌旋转启动失败：', e);
                    one();
                }
                try {
                    const c17Color = attackFxColorOf(cardIdFromNodeName(attacker.name));
            const colObj = c17Color ? new Color(c17Color[0], c17Color[1], c17Color[2], c17Color.length > 3 ? c17Color[3] : 255) : null;
            plasma.play(attacker.worldPosition, defender.worldPosition, one, colObj);
                } catch (e) {
                    console.error('[BattleCommandSystem] 电浆攻击演出启动失败：', e);
                    one();
                }
                return;
            }
        }
        const anim = this.animOf();
        if (!anim || typeof anim.playSingleAttack !== 'function'
            || !attacker || !attacker.isValid || !defender || !defender.isValid) {
            doneWithNumbers();
            return;
        }
        // ★ 每卡攻击特效的「颜色 / 轨迹」覆盖（普通攻击的特效球本体不变，只是换色 + 换弹道）
        const orbId = cardIdFromNodeName(attacker.name);
        const orbRgb = attackFxColorOf(orbId);
        const orbCurve = attackFxCurveOf(orbId);
        const orbColor = orbRgb ? new Color(orbRgb[0], orbRgb[1], orbRgb[2], orbRgb.length > 3 ? orbRgb[3] : 255) : null;
        anim.playSingleAttack(attacker, defender, doneWithNumbers, false, { color: orbColor, curveOffset: orbCurve });
    };

    /**
     * **破坏**演出：节点此时**已经从战场逻辑集合里摘除**（不可选 / 不亮光圈 / 不计守护），
     * 但仍留在场景里把破坏动画播完，然后销毁；之后由 Reflow cue 连续重排战场。
     */
    /**
     * 【消失】演出：**破坏特效的反过来**（光向内收）——`CardDestroyFx.playOnCard(card, done, { reverse: true })`。
     *
     * 🔴 与破坏的**唯一区别**只有「光的方向」与**不进墓场 / 不触发谢幕曲**（后两者是逻辑层的事，
     *    见 `BattleRuleSystem.vanishFieldCard`）；本 cue 只负责演出。
     */
    /** 该节点是否是**我方**战场节点（用来决定横扫方向：敌我相反）。 */
    private isPlayerFieldNode(node: Node): boolean {
        // 全场景 BFS 找同名节点上的 BattleFieldLayout（没有 bfsComponents 这种批量接口）
        try {
            const scene = this.node.scene as unknown as Node | null;
            if (!scene) return false;
            const stack: Node[] = [...scene.children];
            while (stack.length > 0) {
                const cur = stack.shift() as Node;
                if (cur === node) {
                    const f = cur.getComponent('BattleFieldLayout') as { side?: number } | null;
                    return !!f && f.side === 0;
                }
                for (const ch of cur.children) stack.push(ch);
            }
        } catch (e) { /* 忽略 */ }
        return false;
    }

    /** 【屏障破碎】把待播的屏障罩破碎演出放出来（排在攻击/反击动画之后）。 */
    private readonly playBarrierBreakCue = (cue: BattleCue, done: () => void): void => {
        const cards = (cue as unknown as { cards?: Node[] }).cards || [];
        for (const c of cards) {
            if (!c || !c.isValid) continue;
            try { breakBarrierFx(c); } catch (e) { /* 忽略 */ }
        }
        done();
    };

    /** 【入手牌展示】把「中央展示 → 飞进手牌」放进演出队列里播，播完才放行。 */
    private readonly playHandRevealCue = (cue: BattleCue, done: () => void): void => {
        const id = String((cue as unknown as { id?: string }).id || '');
        const target = (cue as unknown as { target?: Node }).target as Node | undefined;
        if (!id) { done(); return; }
        try {
            revealCardToHand(this, id, target && target.isValid ? target : null, () => {
                // 🔴 展示结束后必须把那张手牌**重新显示**出来（`addCardToHand` 是先藏起来等展示的）。
                //    踩过：这里只传队列的 done、漏了重新激活 ⇒ 卡永远隐藏（占着手牌位、点不动、用不出）。
                if (target && target.isValid) target.active = true;
                done();
            });
        } catch (e) {
            console.error('[BattleCommandSystem] 入手牌展示演出失败：', e);
            done();
        }
    };

    private readonly playVanishCue = (cue: BattleCue, done: () => void): void => {
        // ★ 支持**批量**（`cue.cards`）：卡 17 的「消失全场」要所有消失动画**同时播**（需求）。
        const batch = Array.isArray((cue as unknown as { cards?: Node[] }).cards)
            ? ((cue as unknown as { cards: Node[] }).cards).filter((n) => !!n && n.isValid)
            : [];
        if (batch.length > 1) {
            const fieldB = cue.field as BattleFieldLayout | null;
            let left = batch.length;
            let settledB = false;
            const oneB = (): void => {
                if (settledB) return;
                left--;
                if (left > 0) return;
                settledB = true;
                done();
            };
            for (const c of batch) {
                try { this.playVanishOne(c, fieldB, oneB); }
                catch (e) { console.error('[BattleCommandSystem] 批量消失单张失败：', e); oneB(); }
            }
            return;
        }
        const card = (batch[0] || cue.card) as Node;
        const field = cue.field as BattleFieldLayout | null;
        if (!card || !card.isValid) { done(); return; }
        let settled = false;
        const finish = (): void => {
            if (settled) return;
            settled = true;
            try { killNode(card); } catch (e) { /* 特效可能已销毁，忽略 */ }
            try { if (field && field.isValid) field.releaseOrphan(card); } catch (e) { /* 忽略 */ }
            done();
        };
        this.playVanishOne(card, field, finish);
    };

    /** 单张消失演出（原 playVanishCue 的主体，抽出来供批量复用）。 */
    private readonly playVanishOne = (card: Node, field: BattleFieldLayout | null, finish: () => void): void => {
        const fx = CardDestroyFx.instance;
        if (fx && fx.destroyCard) {
            try {
                fx.playOnCard(card, finish, { reverse: true });
                return;
            } catch (e) {
                console.error('[BattleCommandSystem] 消失特效启动失败，回退直接销毁：', e);
            }
        }
        finish();
    };

    private readonly playDestroyCue = (cue: BattleCue, done: () => void): void => {
        // 🔴 「同时破坏组」：一条 cue 里可能带多张卡（entries）—— 它们**同时**开播，
        //    全部播完才算这一段演出结束（done 只会被调用一次）。
        const list = this.destroyEntriesOf(cue);
        if (list.length === 0) { done(); return; }
        // 【触发型纹章】「对方随从被破坏」→ 通知 CrestSystem（多张同时破坏只通知一次）
        this.notifyCrestFollowerDestroyed(list);
        if (list.length === 1) { this.playOneDestroy(list[0].card, list[0].field, done); return; }

        let left = list.length;
        let settled = false;
        const one = (): void => {
            if (settled) return;
            left--;
            if (left > 0) return;
            settled = true;
            done();
        };
        for (const e of list) this.playOneDestroy(e.card, e.field, one);
    };

    /** 把一条 Destroy cue 解析成「卡 + 所属战场」列表（兼容老的单卡形式）。 */
    private destroyEntriesOf(cue: BattleCue): Array<{ card: Node; field: BattleFieldLayout | null }> {
        const raw = cue.entries as Array<{ card?: Node; field?: BattleFieldLayout | null }> | undefined;
        if (Array.isArray(raw) && raw.length > 0) {
            const out: Array<{ card: Node; field: BattleFieldLayout | null }> = [];
            for (const e of raw) {
                if (!e || !e.card || !e.card.isValid) continue;
                out.push({ card: e.card, field: (e.field && e.field.isValid) ? e.field : null });
            }
            return out;
        }
        const card = cue.card as Node;
        if (!card || !card.isValid) return [];
        const field = cue.field as BattleFieldLayout | null;
        return [{ card, field: (field && field.isValid) ? field : null }];
    }

    /** 播**单张**卡的破坏动画（同时破坏组里每个成员各调一次）。 */
    private playOneDestroy(card: Node, field: BattleFieldLayout | null, done: () => void): void {
        if (!card || !card.isValid) { done(); return; }

        this._destroying.add(card);
        const finish = (): void => {
            try { killNode(card); } catch (e) { /* 节点可能已被特效销毁，忽略 */ }
            try { if (field && field.isValid) field.releaseOrphan(card); } catch (e) { /* 忽略 */ }
            this._destroying.delete(card);
            done();
        };

        // 首选：新的「整体高亮白 → 由里向外迸发 → 卡牌消失」特效。
        // 特效自己负责在「迸发」瞬间销毁卡牌（destroyCard），结束再回调 finish。
        const fx = CardDestroyFx.instance;
        if (fx && fx.destroyCard) {
            try {
                fx.playOnCard(card, finish);   // finish 内的 killNode 幂等，卡牌已销毁也无害
                return;
            } catch (e) {
                console.error("[BattleCommandSystem] 破坏特效启动失败，回退旧演出：", e);
            }
        }

        // 兜底：没有特效宿主（或它不负责销毁）时的旧「缩小淡出」演出。
        // 复用节点上可能已经跑着的位置/缩放补间 → 先停掉（避免结束姿态写进起始帧）。
        try { Tween.stopAllByTarget(card); } catch (e) { /* 节点可能已被销毁，忽略 */ }

        const op = this.ensureOpacity(card);
        const startScaleX = card.scale.x;
        const startScaleY = card.scale.y;
        const startAngle = card.eulerAngles.z;
        const dur = Math.max(0, this.destroyDuration);
        const endScale = Math.max(0, Math.min(1, this.destroyEndScale));
        const spin = this.destroySpinDegrees;
        const fade = this.destroyFade;

        const state = { p: 0 };
        let settled = false;
        const settle = (): void => {
            if (settled) return;
            settled = true;
            finish();
        };

        if (dur <= 0) { settle(); return; }

        try {
            tween(state)
                .to(dur, { p: 1 }, {
                    easing: "quadIn",
                    // 🔴 tween 回调异常会被引擎吞 → 一律 try/catch
                    onUpdate: () => {
                        if (settled) return;
                        try {
                            const p = state.p;
                            const k = 1 - (1 - endScale) * p;
                            if (card.isValid) {
                                card.setScale(startScaleX * k, startScaleY * k, 1);
                                if (spin) card.setRotationFromEuler(card.eulerAngles.x, card.eulerAngles.y, startAngle + spin * p);
                            }
                            if (fade && op && op.isValid) op.opacity = Math.round(255 * (1 - p));
                        } catch (e) { /* 单帧异常忽略，让演出继续 */ }
                    },
                })
                .call(() => settle())   // 🔴 不要在 .call 里提前置位：settle 自带守卫
                .start();
        } catch (e) {
            console.error("[BattleCommandSystem] 破坏演出出错：", e);
            settle();
        }
    }

    /**
     * 【纹章·子弹】演出：从**纹章图标的中心**发射一颗子弹飞到**目标卡牌的中心**。
     *
     * 🔴 目标卡牌此刻**已经从战场逻辑集合里摘除**（纹章效果触发那一瞬间就结算完了），
     *    但节点还在原地等着播破坏动画 —— 所以这里还能读到它的位置与显示尺寸。
     *    本 cue 只负责「飞」；紧随其后的 `Destroy` cue 才是卡牌的破坏动画。
     * 演出宿主 = 常驻节点 `Canvas/CrestBulletFx`（参数在它的 Inspector 上：大小/总时长/颜色）。
     * 缺宿主 / 缺起点 → 直接放行（不能卡住演出队列）。
     */
    private readonly playCrestBulletCue = (cue: BattleCue, done: () => void): void => {
        const fx = CrestBulletFx.instance;
        const card = cue.card as Node;
        const from = cue.fromWorld as Vec3 | null;
        if (!fx || !card || !card.isValid || !from) { done(); return; }
        try {
            // 终点 = 卡牌当前世界坐标（与 CardDestroyFx.playOnCard 的「卡牌中心」同一口径）
            fx.play(from, card.worldPosition, done);
        } catch (e) {
            console.error('[BattleCommandSystem] 纹章子弹演出启动失败：', e);
            done();
        }
    };

    /**
     * 【能力攻击球】演出：**能力造成的攻击**用与普通攻击同一颗特效球 ——
     * 从 `cue.attacker`（来源随从）中心飞向 `cue.defender`（目标）中心，**卡牌不旋转**。
     *
     * 🔴 目标卡牌此刻**已经从战场逻辑集合里摘除**（能力结算那一瞬间就做完了），
     *    但节点还在原地等着播破坏动画 —— 所以这里还能读到它的位置与显示尺寸。
     *    本 cue 只负责「飞」；紧随其后的 `Destroy` cue 才是卡牌的破坏动画。
     * 演出宿主 / 参数 = `FollowerAttackAnim`（`attacker` 所在战场上的那个组件）。
     * 缺组件 / 缺引用 → 直接放行（不能卡住演出队列）。
     */
    private readonly playAttackOrbCue = (cue: BattleCue, done: () => void): void => {
        const attacker = cue.attacker as Node;
        const defender = cue.defender as Node;
        // ★ **能力造成的攻击**（如卡 13 入场曲的「破坏」）也认卡牌专属攻击特性：
        //   配了电浆就放电浆闪电（从施法者飞向目标），否则沿用原来的能力攻击球。
        if (attacker && attacker.isValid && defender && defender.isValid
            && attackFxOf(cardIdFromNodeName(attacker.name)) === 'plasmaBolt') {
            const plasma = PlasmaBoltFx.instance;
            if (plasma) {
                try {
                    plasma.play(attacker.worldPosition, defender.worldPosition, done);
                    return;
                } catch (e) {
                    console.error('[BattleCommandSystem] 能力电浆演出启动失败，回退攻击球：', e);
                }
            }
        }
        const anim = this.animOf();
        if (!anim || typeof anim.playOrbAttack !== 'function'
            || !attacker || !attacker.isValid || !defender || !defender.isValid) {
            done();
            return;
        }
        try {
            anim.playOrbAttack(attacker, defender, done);
        } catch (e) {
            console.error('[BattleCommandSystem] 能力攻击球演出启动失败：', e);
            done();
        }
    };

    /**
     * 【毒弹】演出：卡牌能力造成伤害时，从**目标卡牌的右上方**射一颗**紫色毒弹**到目标卡牌。
     *
     * 🔴 **一次能力打多个目标 ⇒ 多颗毒弹同时飞**（需求）：cue 里带 `cards` 数组时，
     *    全部一起开播，**全部**飞完才算这一段演出结束（done 只调用一次）。
     * 🔴 目标卡牌此刻可能**已经从战场逻辑集合里摘除**（伤害/破坏在能力结算那一瞬间就做完了），
     *    但节点还在原地等着播破坏动画 —— 所以这里还能读到它的位置。
     *    本 cue 只负责「飞」；紧随其后的 `RefreshNumbers` / `Destroy` cue 才是数字刷新与破坏动画。
     * 演出宿主 / 参数 = 常驻节点 `Canvas/PoisonBulletFx`（颜色 / 长短 / 粗细 / 最远出现距离 / 倾斜角度）。
     * 缺宿主 / 缺目标 → 直接放行（不能卡住演出队列）。
     */
    private readonly playPoisonBulletCue = (cue: BattleCue, done: () => void): void => {
        // ★ 能力伤害的飘字打 'ability' 阶段 ⇒ 在这一发毒弹/导弹/横扫**命中那一刻**投递
        const doneWithNumbers = (): void => {
            try { flushNumbers('ability'); } catch (e) { console.error('[BattleCommandSystem] 能力飘字失败：', e); }
            done();
        };
        // `fxKind` 选演出宿主：`'missileStrike'` = 导弹（黄，卡 9）/ 其余 = 毒弹（紫，卡 2/6）
        // ★ 「火焰横扫」（卡 15 的入场曲）：**整场一发**，从敌方战场左端横着贯穿到右端，
        //   位置取战场**上下中间**。它排在 RefreshNumbers / Destroy 之前 ⇒ 先横扫、再跳血/破坏。
        if (cue.fxKind === 'flameSweep') {
            const sweep = FlameSweepFx.instance;
            const first = (Array.isArray(cue.cards) ? (cue.cards as Node[]) : []).filter((n) => !!n && n.isValid)[0];
            const fieldNode = first && first.parent && first.parent.isValid ? first.parent : null;
            // ★ 敌我相反：目标是**我方**战场 ⇒ 说明这一发是**敌方人机**打的 ⇒ 从右往左扫（玩家视角相反）。
            //   目标是**敌方**战场 ⇒ 我方出手 ⇒ 左往右。
            const targetIsPlayerSide = !!(fieldNode && this.isPlayerFieldNode(fieldNode));
            if (sweep && fieldNode) {
                const col = (cue as unknown as { color?: Color | null }).color || null;
                try { sweep.play(fieldNode, !targetIsPlayerSide, doneWithNumbers, col); return; }
                catch (e) { console.error('[BattleCommandSystem] 火焰横扫演出启动失败：', e); }
            }
            doneWithNumbers();
            return;
        }
        const isMissile = cue.fxKind === 'missileStrike';
        const fx = (isMissile ? MissileStrikeFx.instance : PoisonBulletFx.instance) as {
            play: (to: Vec3, cb?: () => void, c?: unknown) => void;
        } | null;
        const single = cue.card as Node | undefined;
        const list = Array.isArray(cue.cards) ? (cue.cards as Node[]) : (single ? [single] : []);
        const live = list.filter((n) => !!n && n.isValid);
        if (!fx || live.length === 0) { doneWithNumbers(); return; }
        let remain = live.length;
        let settled = false;
        const finishOne = (): void => {
            if (settled) return;
            remain--;
            if (remain > 0) return;
            settled = true;
            doneWithNumbers();
        };
        try {
            // 🔴 全部同时开播（两个宿主都支持多发并发）；全飞完才放行队列
            const cueColor = (cue as unknown as { color?: unknown }).color;
        for (const card of live) fx.play(card.worldPosition, finishOne, cueColor as never);
        } catch (e) {
            console.error('[BattleCommandSystem] 伤害演出启动失败：', e);
            if (!settled) { settled = true; doneWithNumbers(); }
        }
    };

    /**
     * 刷新血量 / 攻击的数字显示（瞬时 cue）：把延迟窗口里冻结的卡面数字一次性写成当前逻辑值。
     * 时机 = Attack/Counter 动画播完、破坏演出之前。
     */
    private readonly playRefreshNumbersCue = (cue: BattleCue, done: () => void): void => {
        try {
            const rules = this.rulesOf();
            if (rules && cue.batch && typeof rules.applyDisplayBatch === 'function') {
                // 🔴 用 cue 携带的**快照**刷新（该指令结算后的值），不是当前最终逻辑值。
                rules.applyDisplayBatch(cue.batch as unknown);
                // ★ 需求：**攻击/反击/破坏动画播完那一刻**（就是这里）飘出伤害/治疗数字。
                //   数字来源 = 各处改血时登记的差值（见 DamageNumberQueue）⇒ 与动画同队列、不丢不重。
                // 只取「默认阶段」的；战斗 / 超进化阶段的由各自 cue 播
                try { flushNumbers(''); } catch (e) { console.error('[BattleCommandSystem] 飘字失败：', e); }
                // ★ 没有配置命中弹道的直接能力伤害，在刷新数字这一刻补投 ability 阶段。
                //   有弹道的路径已在命中回调里投递，这里取到空队列即无副作用。
                try { flushNumbers('ability'); } catch (e) { console.error('[BattleCommandSystem] 能力飘字补投失败：', e); }
            } else if (rules && typeof rules.flushDeferredDisplay === 'function') {
                rules.flushDeferredDisplay();
            }
        } catch (e) {
            console.error('[BattleCommandSystem] 刷新数字显示出错：', e);
        }
        done();
    };

    /**
     * 【超进化破坏】演出：光团收缩 + 卡牌持续变白 → 倾斜飞向对方主战者正中消失
     * → 主战者处光团迸发 + 主战者血量显示推进到结算快照（见 SuperEvolveDestroyFx）。
     * 卡牌节点此时**已经从战场逻辑集合里摘除**，仍由本演出销毁；播完再由 Reflow 重排。
     */
    private readonly playSuperEvolveDestroyCue = (cue: BattleCue, done: () => void): void => {
        // ★ 这段动画结束时把登记好的飘字放出来（超进化破坏 ⇒ 敌方主战者的连锁伤害就在此显示）
        const doneWithNumbers = (): void => {
            // 超进化连锁伤害是 'superBreak' 阶段 ⇒ 在「被破坏的随从撞到主战者」之后才飘（用户口径）
            try { flushNumbers('superBreak'); } catch (e) { console.error('[BattleCommandSystem] 超进化破坏飘字失败：', e); }
            done();
        };
        const card = cue.card as Node;
        const heroNode = cue.heroNode as Node | null;
        const heroHp = typeof cue.heroHp === 'number' ? cue.heroHp : null;
        const field = cue.field as BattleFieldLayout | null;
        const fx = SuperEvolveDestroyFx.instance;

        // 【触发型纹章】超进化破坏**同样是被破坏** → 通知 CrestSystem（若目标为随从）
        this.notifyCrestFollowerDestroyed([{ card, field }]);

        if (card && card.isValid && heroNode && heroNode.isValid && heroHp !== null && fx) {
            this._destroying.add(card);
            try {
                fx.play(card, heroNode, heroHp, () => {
                    // 特效已在「卡牌到达主战者」那一刻销毁卡牌；这里兜底 + 收尾（幂等）。
                    try { killNode(card); } catch (e) { /* 节点可能已被特效销毁，忽略 */ }
                    try { if (field && field.isValid) field.releaseOrphan(card); } catch (e) { /* 忽略 */ }
                    this._destroying.delete(card);
                    doneWithNumbers();
                });
                return;
            } catch (e) {
                console.error('[BattleCommandSystem] 超进化破坏演出启动失败，回退普通破坏演出：', e);
                this._destroying.delete(card);
            }
        }

        // 兜底：特效宿主缺失 / 参数不全 → 立刻推进主战者血量显示（避免永久冻结），再走普通破坏演出。
        try {
            if (heroNode && heroNode.isValid && heroHp !== null) {
                const heroComp = heroNode.getComponent(HeroArea);
                if (heroComp) heroComp.applyDisplayHp(heroHp);
            }
        } catch (e) { /* 忽略 */ }
        this.playDestroyCue({ type: BattleCueType.Destroy, card, field } as BattleCue, done);
    };

    /**
     * **消失**演出：与「破坏」并列的另一种离场方式 —— **不播破坏动画**，直接移除节点。
     * 仍然单独占一个 cue，保证它和其它动作在演出队列里严格同序；
     * 移除后由紧随其后的 `Reflow` cue 做连续重排。
     */
    private readonly playDisappearCue = (cue: BattleCue, done: () => void): void => {
        const card = cue.card as Node;
        try { if (card && card.isValid) killNode(card); } catch (e) { /* 节点可能已被销毁，忽略 */ }
        done();
    };

    /**
     * **战场连续重排**：破坏 / 消失动画**全部播完之后**，其余战场卡牌平滑移动到位。
     * 🔴 这是"排布更新"的唯一合法时机 —— 逻辑摘除时用的是 relayout=false，
     *    不会在破坏动画还没播时先 snap 到最新排布。
     * 🔴 同一条战场的**多段离场**（多指令连发时，每条指令各带一段 Reflow）必须合并成一次重排：
     *    只要队列里还有**本战场**未播的 Destroy / Disappear，本次就跳过，
     *    把排布更新留给「该战场最后一段离场演出之后」的那段 Reflow。
     *    否则第一段破坏动画一结束就重排 → 后面还没播破坏动画的卡会**原地不动**，
     *    而其余卡牌已经先动过一次（表现为「隔一次错位」的双重重排）。
     */
    private readonly playReflowCue = (cue: BattleCue, done: () => void): void => {
        const field = cue.field as BattleFieldLayout | null;
        if (!field || !field.isValid) { done(); return; }
        // 本战场还有没播完的离场演出（且其后确实还排着一段本战场的 Reflow）→ 让给它，本次不重排。
        if (this.hasQueuedRemovalFor(field)) { done(); return; }
        const dur = Math.max(0, this.reflowDuration);
        try {
            if (typeof field.layoutAnimated === 'function') {
                field.layoutAnimated(dur, done);   // 连续动画；播完才 done
                return;
            }
            field.layout();                        // 兜底：无动画版
        } catch (e) {
            console.error('[BattleCommandSystem] 战场重排出错：', e);
        }
        done();
    };

    /** 取一段 cue 归属的战场（优先 cue 自带 field，其次按卡牌父链解析）。 */
    private cueFieldOf(cue: BattleCue | null | undefined): BattleFieldLayout | null {
        if (!cue) return null;
        const f = cue.field as BattleFieldLayout | undefined;
        if (f && f.isValid) return f;
        // 「同时破坏组」：cue 自身没有 field，从 entries 里取第一个有效战场
        const raw = cue.entries as Array<{ field?: BattleFieldLayout | null }> | undefined;
        if (Array.isArray(raw)) {
            for (const e of raw) {
                const ef = e && e.field;
                if (ef && ef.isValid) return ef;
            }
        }
        return this.fieldOfCard(cue.card as Node);
    }

    /**
     * 该战场「是否还有**没播**的离场演出，且其后确实还排着一段本战场的 Reflow」。
     *
     * 用途：`playReflowCue` 据此把重排让给更靠后的那段 —— 保证**同一战场上所有破坏/消失
     * 演出都播完之后**才更新排布（而不是第一段播完就动）。
     *
     * · 只看**尚未开播**的队列（`snapshot()`），正在播的那段由 FIFO 保证已经结束；
     * · 第二个条件（后面还排着 Reflow）是**防泄漏**：所有内部路径（execAttack /
     *   execDisappear / destroyCardOnField）都是「离场 cue + 紧随其后的 Reflow」成对入队，
     *   所以正常情况下恒为真；万一有人只压了离场 cue 没压 Reflow，这里会返回 false，
     *   退化成本次就重排（宁可早一点，也绝不留下永久不重排的缺口）。
     */
    private hasQueuedRemovalFor(field: BattleFieldLayout): boolean {
        if (!field || !field.isValid || !this._cues) return false;
        const q = this._cues.snapshot();
        let lastRemoval = -1;
        for (let i = 0; i < q.length; i++) {
            const c = q[i];
            if (!c) continue;
            if (c.type === BattleCueType.Destroy || c.type === BattleCueType.Disappear
                || c.type === BattleCueType.SuperEvolveDestroy) {
                if (this.cueFieldOf(c) === field) lastRemoval = i;
            }
        }
        if (lastRemoval < 0) return false;
        for (let i = lastRemoval + 1; i < q.length; i++) {
            const c = q[i];
            if (!c || c.type !== BattleCueType.Reflow) continue;
            if (this.cueFieldOf(c) === field) return true;
        }
        return false;
    }

    private readonly playWaitCue = (cue: BattleCue, done: () => void): void => {
        const raw = cue.duration;
        const dur = Math.max(0, typeof raw === 'number' ? raw : this.waitDuration);
        if (dur <= 0) { done(); return; }
        try {
            tween({ p: 0 }).to(dur, { p: 1 }).call(() => done()).start();
        } catch (e) {
            done();
        }
    };

    private readonly playDoneCue = (cue: BattleCue, done: () => void): void => {
        // ★ 兜底：一条指令演完时，把还留在队列里的飘字放出来（避免某些路径没有 RefreshNumbers 而漏播）
        try { flushNumbers(''); } catch (e) { console.error('[BattleCommandSystem] 收尾飘字失败：', e); }
        try {
            const cb = cue.cb as (() => void) | undefined;
            if (typeof cb === 'function') cb();
        } catch (e) {
            console.error('[BattleCommandSystem] 批次结束回调出错：', e);
        }
        done();
    };

    // ------------------------------ 破坏 sink（接到 BattleRuleSystem）----------------------
    /**
     * 把本组件登记为 BattleRuleSystem 的「**破坏**接收器」（= 此前说的「死亡」）：
     * 规则系统判定某随从被破坏时**先把它从战场逻辑集合摘除**（节点保留），再回调这里，
     * 我们把破坏演出排进 cue 队列。这样「逻辑破坏」永远早于「破坏动画」。
     */
    private bindDestroySink(on: boolean): void {
        const rules = this.rulesOf();
        if (!rules || typeof rules.setDestroySink !== 'function') return;
        rules.setDestroySink(on ? this.onFollowerDestroyed : null);
    }

    private readonly onFollowerDestroyed = (card: Node, _field: BattleFieldLayout | null): void => {
        if (!card || !card.isValid) return;
        this._pendingDestroys.push({ card, field: _field || null });
        // 该战场需要在破坏动画播完后做连续重排（同一战场去重）。
        if (_field && this._pendingReflow.indexOf(_field) < 0) this._pendingReflow.push(_field);
    };

    /**
     * 【触发型纹章】「对方随从被破坏」事件通知 —— 在**破坏演出开播**的那一刻
     * （`playDestroyCue` / `playSuperEvolveDestroyCue` 开头）通知 `CrestSystem`。
     *
     * 🔴 为什么挂在「演出开播」而不是「逻辑破坏」：破坏的**演出顺序**必须与逻辑同序
     *    （例如一次攻击的 cue 序列 = Attack → Counter → RefreshNumbers → Destroy → Reflow），
     *    若在逻辑破坏的瞬间（`resolveCombat` 内部）同步通知，纹章的演出会插到
     *    攻击动画**前面** —— 观众先看到纹章把主战者打掉 2 血、攻击动画才播，因果颠倒。
     *    挂在这里，纹章的新 cue（子弹 → 主战者掉血数字）会被追加到演出队列**末尾**，
     *    严格排在「这段破坏 + 重排」之后。
     *
     * 🔴 只认**随从**（护符 / 法术的破坏不触发「对方随从被破坏」）；
     *    同一条 Destroy cue 里多张卡（同时破坏）只通知**一次** ——
     *    「每回合触发一次」的去重由 `CrestSystem` 的登记负责。
     */
    private readonly notifyCrestFollowerDestroyed = (
        entries: Array<{ card: Node; field: BattleFieldLayout | null }>,
    ): void => {
        try {
            let side: 'player' | 'enemy' | null = null;
            for (const e of entries) {
                if (!e || !e.card || !e.card.isValid) continue;
                const id = cardIdFromNodeName(e.card.name);
                const info = id ? getCardInfo(id) : undefined;
                if (!info || info.cardType !== 'Follower') continue;      // 只认随从
                const f = (e.field && e.field.isValid) ? e.field : this.fieldOfCard(e.card);
                if (!f || !f.isValid) continue;
                side = f.side === BattleSide.Player ? 'player' : 'enemy';
                break;
            }
            if (!side) return;
            const crest = this.bfsComponent<{ notifyOppFollowerDestroyed?: (s: string) => number }>('CrestSystem');
            if (crest && typeof crest.notifyOppFollowerDestroyed === 'function') {
                crest.notifyOppFollowerDestroyed(side);
            }
        } catch (err) {
            console.error('[BattleCommandSystem] 通知纹章「对方随从被破坏」失败（不影响演出）：', err);
        }
    };

    // ------------------------------ 收尾 / 清理 ------------------------------
    /** 销毁所有还在破坏演出中的残留节点（例如场景切换 / 组件关闭）。 */
    public clearDying(): void {
        for (const n of this._destroying) {
            try { killNode(n); } catch (e) { /* 忽略 */ }
        }
        this._destroying.clear();
    }

    private ensureOpacity(node: Node): UIOpacity | null {
        let op = node.getComponent(UIOpacity);
        if (!op) {
            try { op = node.addComponent(UIOpacity); } catch (e) { return null; }
        }
        return op;
    }

    private record<T>(list: T[], item: T): void {
        if (this.historyLimit <= 0) return;
        list.push(item);
        while (list.length > this.historyLimit) list.shift();
    }

    // ------------------------------ 依赖解析 ------------------------------
    private rulesOf(): BattleRuleSystem | null {
        if (this.rules && this.rules.isValid) return this.rules;
        if (this._ruleCache && this._ruleCache.isValid) return this._ruleCache;
        const own = this.node.getComponent(BattleRuleSystem);
        if (own) { this._ruleCache = own; return own; }
        const found = this.bfsComponent<BattleRuleSystem>('BattleRuleSystem');
        this._ruleCache = found;
        return found;
    }

    private animOf(): FollowerAttackAnim | null {
        if (this.attackAnim && this.attackAnim.isValid) return this.attackAnim;
        if (this._animCache && this._animCache.isValid) return this._animCache;
        const own = this.node.getComponent(FollowerAttackAnim);
        if (own) { this._animCache = own; return own; }
        const found = this.bfsComponent<FollowerAttackAnim>('FollowerAttackAnim');
        this._animCache = found;
        return found;
    }

    private bfsComponent<T>(className: string): T | null {
        const scene = this.node.scene as unknown as Node | null;
        if (!scene) return null;
        const stack: Node[] = [...scene.children];
        while (stack.length > 0) {
            const cur = stack.shift() as Node;
            const c = cur.getComponent(className) as unknown as T | null;
            if (c) return c;
            for (const ch of cur.children) stack.push(ch);
        }
        return null;
    }
}
