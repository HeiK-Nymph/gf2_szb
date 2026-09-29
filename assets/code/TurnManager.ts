import { _decorator, CCString, Component, Node } from 'cc';
import { peekPending } from './BattleSetup';
import { isHandRevealBusy, runCardTurnEndAbilities } from './CardAbilitySystem';

const { ccclass, property, menu } = _decorator;

/** 阵营：我方 / 敌方 */
export type TurnSide = 'player' | 'enemy';

/**
 * TurnManager —— 回合流程总控（独立组件，挂在 Canvas 下自己的节点上）
 * ===========================================================================
 * 术语（与需求严格对齐，别混）
 *   · **操作回合**：某一方「开始行动 → 结束行动」这一段。一次只有一个归属方。
 *   · **大回合**（round）：**先手操作回合 + 后手操作回合**，两个都结束才算走完 1 个大回合。
 *     所以一个大回合 = 2 个操作回合；`_round` 只在**后手**结束的那一刻 +1。
 *   · **先手 / 后手**：开战（或控制台指定）时定下来的**固定**属性，一轮内不变。
 *
 * 流程
 *   begin()                     开战：随机（或按 defaultFirstSide）定先后手 → 进入第 1 大回合
 *     └ _enterTurn(先手)        先手操作回合开始
 *   endCurrentTurn()            结束当前操作回合（按归属自动分派）
 *     ├ 先手结束 → _enterTurn(后手)
 *     └ 后手结束 → _round++ → _enterTurn(先手)   ← 这才算走完 1 个完整大回合
 *
 * 进入操作回合时做四件事（顺序固定）
 *   ① 能量点：**最大 = 当前大回合数**，**可用 = 最大**。
 *      🔴 **只在「进入」时刷新，回合结束时一律不动**（需求明确要求）。
 *      🔴 只刷新**正在进入的这一方**（不是双方一起刷）——敌方 PP 要等敌方自己进入回合才跳到新值。
 *   ② 回合钮显示：我方 → RoundButton(结束回合)；敌方 → EnemyRoundButton(对手回合)
 *   ③ 手牌可用性：**只有我方回合**才能用我方手牌（门控 HandDrag.enableDrag + CardPlay.enablePlay）
 *   ④ 随机抽 1 张牌（卡池见 cardPool / CardDraw.testCardIds）
 *
 * 结束回合的两个入口
 *   · 我方：点右侧**回合钮**（TurnControlPanel.roundClickHandler 把点击转给本组件）
 *   · 敌方：**测试控制台**的「结束敌方回合」按钮（需求指定；敌方回合点回合钮不生效）
 *
 * ---------------------------------------------------------------------------
 * 🔴 实现注意
 *   1. 全部组件引用按**类名字符串** BFS 查找（不静态 import）—— 避免与 CardDraw /
 *      TurnControlPanel 形成循环依赖，与 TestConsole 同一套做法。
 *   2. 手牌门控在 `update()` 里**每帧比对后重申**：`HandMinimize.expand()` 会把
 *      `HandDrag.enableDrag` 无条件写回 true（缩略恢复态），若不重申，敌方回合里
 *      缩略一次手牌就能重新拖牌。比对通过才写，开销极小且自愈。
 *      🔴 重申时必须叠加「缩略态 / 过渡中」守门（isMinimized || isTransitioning）：
 *         否则我方回合里 minimize() 写下的 enableDrag=false 下一帧就被翻回 true，
 *         缩略态按卡牌会同时触发 expand + beginDrag（拖拽放大 tween 与展开过渡
 *         叠加 = 某张卡不正确放大）。
 *   3. 本组件**不落盘 PP 值**：`setPP` 只改运行时数值，场景里的序列化值不受影响。
 * ===========================================================================
 */
@ccclass('TurnManager')
@menu('gf2szb/TurnManager')
export class TurnManager extends Component {

    // ====================== 可调参数 ======================

    @property({
        tooltip: '场景启动时**自动开战**（定先后手 + 进入第 1 大回合）。\n'
            + '关掉 = 只在控制台点「随机开战 / 重开对决」才启动。',
    })
    autoBeginOnStart = true;

    @property({
        tooltip: '开战时先发双方初始手牌，并显示「更换初始手牌」界面；关闭则沿用直接进入回合的旧流程。',
    })
    initialHandMulliganEnabled = true;
    @property({
        tooltip: '开战时**随机**决定先后手（需求：对决开始时抽取谁为先后手）。\n'
            + '关掉 = 固定用下面 defaultFirstSide 配的那一方当先手。',
    })
    randomFirstSideAtStart = true;

    @property({
        tooltip: '【randomFirstSideAtStart = false 时生效】固定先手方。\n'
            + '控制台的「先手」切换按钮会覆盖这个值。',
    })
    defaultFirstSide: TurnSide = 'player';

    @property({
        tooltip: '进入操作回合时按「大回合数」刷新能量点：\n'
            + '  最大能量点 = 当前大回合数 ；可用能量点 = 最大能量点。\n'
            + '🔴 只在**进入**时刷新，回合结束时不动。',
    })
    refreshPPOnTurnStart = true;

    @property({ tooltip: '每次进入操作回合时，随机抽 1 张牌（卡池见 cardPool）' })
    autoDrawOnTurnStart = true;

    @property({
        range: [1, 20, 1], slide: true,
        tooltip: '最大能量点的**硬上限**：大回合数再大，PP 上限也封在这一值（默认 10）。\n'
            + '能量横幅素材只有 10 个 PP 槽位，超过 10 会无处显示。',
    })
    maxPPCap = 10;

    @property({
        type: [CCString],
        tooltip: '随机抽卡用的卡池（CardData.CardMap 的 key，如 "1.png"）。\n'
            + '留空 = 直接用 CardDraw.testCardIds。',
    })
    cardPool: string[] = [];

    // ====================== 运行时状态（不序列化）======================

    /** 先手方（一轮内固定） */
    private _first: TurnSide = 'player';
    /** 当前操作回合的归属方 */
    private _side: TurnSide = 'player';
    /** 大回合数（1 基）：先手 + 后手 都结束才 +1 */
    private _round = 1;
    /** 本大回合内的第几个操作回合：1 = 先手行动中，2 = 后手行动中 */
    private _turnInRound = 1;
    /** 是否处于「对决进行中」 */
    private _running = false;
    /** 组件缓存（按类名），失效时重新查找 */
    private _cache: Map<string, any> = new Map<string, any>();

    // ---------- 「结束回合」等待窗口（逻辑与演出分离）----------
    /** true = 已提交结束回合、正在等所有演出播完（此间锁死本方交互） */
    private _ending = false;
    /** 提交结束的那一方 */
    private _endSide: TurnSide | null = null;
    /** 等待起点（用于熔断） */
    private _endWaitStart = 0;
    /** 是否已经把「回合结束效果触发的演出」放行入队（两段等待的分界） */
    private _endFlushed = false;
    /** 被掐住的演出队列（延迟排队期间的「攒 cue」宿主；收尾必须放行） */
    private _deferCmds: any = null;
    /** 交互锁之前各开关的原值（解锁时原样还原） */
    private _lockSaved: Array<{ comp: any; key: string; value: boolean }> = [];

    /** 结束回合等待：轮询间隔 / 最长等待（熔断，避免任何动画卡住就把回合流程拖死） */
    private static readonly TURN_END_POLL = 60;
    private static readonly TURN_END_MAX_WAIT = 8000;

    // ====================== 生命周期 ======================

    onLoad(): void {
        this._bindRoundButton();
        // ★ 主界面（2D MainMenu 场景）设置的先后手：进入对战时应用**一次**
        //   （`takePending` 取完即清；直接在编辑器里跑对战场景时返回 null，一切按序列化值走）。
        try {
            const pending = peekPending();
            if (pending) {
                if (pending.first === 'random') {
                    this.randomFirstSideAtStart = true;
                } else {
                    this.randomFirstSideAtStart = false;
                    this.defaultFirstSide = pending.first;
                }
                console.log(`[TurnManager] 应用主界面设置：先后手=${pending.first}`
                    + `（randomFirstSideAtStart=${this.randomFirstSideAtStart}、defaultFirstSide=${this.defaultFirstSide}）`);
            }
        } catch (e) {
            console.error('[TurnManager] 应用主界面设置失败（按场景默认值继续）：', e);
        }
    }

    start(): void {
        if (!this.autoBeginOnStart) return;
        // 延后一帧再开战：保证其它组件的 start()（抽卡/手牌/控制台建面板）都已跑过，
        // 否则第一手「回合开始抽 1 张」会因为引用还没就绪而被吞掉。
        this.scheduleOnce(() => { this.begin(); }, 0);
    }

    update(): void {
        this._syncHandGate();
    }

    onDisable(): void {
        // 组件被关掉时**绝不能把交互锁留在场上**（否则手牌 / 战场按压会永久失灵）
        this._clearTurnEndWait();
    }

    // ====================== 对外：查询 ======================

    /** 先手方 */
    public get firstSide(): TurnSide { return this._first; }
    /** 后手方（先手的另一方） */
    public get secondSide(): TurnSide { return TurnManager.other(this._first); }
    /** 当前操作回合归属方 */
    public get turnSide(): TurnSide { return this._side; }
    /** 大回合数（1 基） */
    public get roundNumber(): number { return this._round; }
    /** 本大回合内第几个操作回合（1 = 先手，2 = 后手） */
    public get turnIndexInRound(): number { return this._turnInRound; }
    /** 对决是否进行中 */
    public get isRunning(): boolean { return this._running; }
    /** 当前是否我方操作回合（= 我方手牌可用） */
    public get isPlayerTurn(): boolean { return this._running && this._side === 'player'; }
    /** 当前是否敌方操作回合 */
    public get isEnemyTurn(): boolean { return this._running && this._side === 'enemy'; }

    /**
     * 是否处于「**已提交结束回合、等演出播完**」的窗口里（见 `_beginTurnEnd`）。
     * 此间：本方交互全部锁死、回合归属尚未切换（`turnSide` 仍是提交方）。
     * 敌方 AI 用这个标志立刻停手，不要在这个窗口里继续决策。
     */
    public get isTurnEnding(): boolean { return this._ending; }

    /** 一行状态文本（控制台/调试用） */
    public get statusText(): string {
        if (!this._running) return '未开战';
        const side = this._side === 'player' ? '我方' : '敌方';
        const role = this._turnInRound === 1 ? '先手' : '后手';
        return `第 ${this._round} 大回合 · ${role}(${side}) 行动中 · ${this._turnInRound}/2`;
    }

    // ====================== 对外：流程控制 ======================

    /**
     * 开战：决定先后手 → 重置到第 1 大回合 → 先手开始行动。
     * 🔴 手牌 / 战场不清空（这是**回合流程**的重开，不是重新发牌），方便反复测流程。
     */
    public begin(): void {
        this._first = this.randomFirstSideAtStart
            ? (Math.random() < 0.5 ? 'player' : 'enemy')
            : TurnManager.normSide(this.defaultFirstSide);
        this._round = 1;
        this._turnInRound = 1;
        this._clearTurnEndWait();            // 清掉可能残留的「结束回合等待」锁
        console.log(`[TurnManager] 开战 → 先手：${this._first === 'player' ? '我方' : '敌方'}`);
        this._resetDecks();
        this._setupExtraPP();
        this._initPPBoth();
        this._initEvoPoints();
        this._resetCrests();
        if (this._startInitialHandPhase()) return;
        this._enterTurn(this._first);
    }

    /** 重新掷一次先后手（不改动其它状态），返回结果 */
    public coinFlip(): TurnSide {
        this._first = Math.random() < 0.5 ? 'player' : 'enemy';
        return this._first;
    }

    /**
     * 指定先后手。
     * @param side      'player' = 我方先手；'enemy' = 敌方先手
     * @param applyNow  true（默认）= 立刻从**第 1 大回合**重新开始，效果马上可见；
     *                  false = 只记下来，等下一个大回合开始时生效。
     */
    public setFirstSide(side: TurnSide, applyNow = true): void {
        this._first = TurnManager.normSide(side);
        console.log(`[TurnManager] 先手设为：${this._first === 'player' ? '我方' : '敌方'}`
            + (applyNow ? '（立即重开第 1 大回合）' : '（下一个大回合生效）'));
        if (applyNow) this.restart();
    }

    /** 保留当前先后手，从第 1 大回合重新开始 */
    public restart(): void {
        this._round = 1;
        this._turnInRound = 1;
        this._clearTurnEndWait();
        this._resetDecks();
        this._setupExtraPP();
        this._initPPBoth();
        this._initEvoPoints();
        this._resetCrests();
        if (this._startInitialHandPhase()) return;
        this._enterTurn(this._first);
    }

    /**
     * 重置双方卡组背包（开战 / 重开时调用）：
     * 按 CardDeckManager 上暴露的 playerDeck / enemyDeck 集合重新组牌堆，
     * 保证每一局都是从「完整的 40 张上限卡组」开始抽。
     * 组件不存在时静默跳过（回退到旧 cardPool 随机池）。
     */
    /**
     * 开局初始手牌阶段：由独立 UI 组件接管，结束后再回到第一回合。
     * 不通过 begin() 递归，避免换回牌堆后又被重建成新的牌堆。
     */
    private _startInitialHandPhase(): boolean {
        if (!this.initialHandMulliganEnabled) return false;
        const phase = this._comp('BattleInitialHand');
        if (!phase || !phase.startInitialHand) return false;
        this._running = false;
        return !!phase.startInitialHand(this._first, () => {
            if (!this.isValid) return;
            this._enterTurn(this._first);
        });
    }
    private _resetDecks(): void {
        const dm = this._comp('CardDeckManager');
        if (dm && dm.resetDecks) dm.resetDecks();
    }

    /**
     * 额外能量点（只给**后手**）的归属与初始化（开战 / 重开时调用）：
     *   · 后手是我方 → 横幅排在**我方能量点下方**；
     *   · 后手是敌方 → 横幅排在**敌方能量点上方**（两者与各自能量点的距离共用同一变量）；
     *   · label 回到「extraStartRounds 回合后可再次使用」、状态回到 ExtraPP。
     */
    private _setupExtraPP(): void {
        const panel = this._comp('TurnControlPanel');
        if (!panel) return;
        if (panel.setExtraSide) panel.setExtraSide(this.secondSide);
        if (panel.resetExtra) panel.resetExtra();
    }

    /** 结束当前操作回合（按归属自动分派到我方/敌方入口） */
    public endCurrentTurn(): boolean {
        if (!this._running) {
            console.warn('[TurnManager] 还没开战，无法结束回合');
            return false;
        }
        return this._side === 'player' ? this.endPlayerTurn() : this.endEnemyTurn();
    }

    /** 结束**我方**操作回合（只在轮到我方时有效）→ 进入敌方操作回合 */
    public endPlayerTurn(): boolean {
        if (!this._running || this._side !== 'player') return false;
        return this._beginTurnEnd('player');
    }

    /** 结束**敌方**操作回合（只在轮到敌方时有效）→ 进入下一个大回合的先手 */
    public endEnemyTurn(): boolean {
        if (!this._running || this._side !== 'enemy') return false;
        return this._beginTurnEnd('enemy');
    }

    /**
     * 提交「结束本方的操作回合」。
     *
     * 🔴 **结束逻辑与演出分开**（需求）：
     *   ① 立刻在「本回合语境」里结算收尾（纹章 `turnEnd` 效果）；
     *   ② 立刻**锁死本方的全部对战交互**（手牌拖拽 / 打出、战场按压选择、进化拖拽）
     *      —— 从现在到回合真正切走之间，谁都别想再动牌；
     *   ③ 把「真正推进回合」排到**所有演出 / 动画的最后**：
     *      先挂进 `BattleCommandSystem.whenIdle`（= 排在该队列所有 cue 之后），
     *      再轮询等**非 cue 的动画**（进化特效 / 抽卡 / 打出流程）也收尾（见 `_presentationBusy`）；
     *   ④ 全部播完之后才 `_advance()` —— **右边回合钮就是在这一刻变的**，
     *      同一刻对方回合才开始、交互锁解开。
     *
     * @returns 是否接受（已经在结束窗口里 / 不是本方的回合 → false）
     */
    private _beginTurnEnd(side: TurnSide): boolean {
        if (this._ending) {
            console.log('[TurnManager] 已经在「结束回合」的等待窗口里，忽略重复提交');
            return false;
        }
        this._ending = true;
        this._endSide = side;
        this._endFlushed = false;
        this._endWaitStart = Date.now();
        // 🔴 顺序总纲（需求）：
        //   ① **先掐住演出队列**（beginDeferCues）：接下来所有 cue 只攒不入队；
        //   ② **立刻**结算「回合结束时」的纹章效果 —— 数据是顷刻间算完的（摘战场 / 记墓场 / 后续连锁），
        //      **不等任何动画**；这些效果产生的破坏 / 重排演出被 ① 攒住，不会插到正在播的动画里；
        //   ③ 锁死本方交互；
        //   ④ 等「此刻正在播的动画」（进化特效 / 打出流程 / 抽卡 / cue 队列）播完 →
        //      再 `flushDeferredCues()` 把纹章的演出放出来（= 排在**结束回合之前**的最后一段动画）；
        //   ⑤ 这批演出也播完 → 才真正 `_advance()` 切回合（回合钮与对方回合同刻变化）。
        const cmds = this._comp('BattleCommandSystem');
        this._deferCmds = cmds && typeof cmds.beginDeferCues === 'function' ? cmds : null;
        if (this._deferCmds) {
            try { this._deferCmds.beginDeferCues(); }
            catch (e) { this._deferCmds = null; console.error('[TurnManager] 掐住演出队列失败：', e); }
        }
        try {
            this._crestTiming('turnEnd', side);            // ② 逻辑立刻结算（动画攒着）
        } catch (e) {
            console.error('[TurnManager] 回合结束效果结算失败：', e);
        }
        try {
            // ②b **卡牌自己**的「回合结束时」能力（如卡 6「异相浅眠·米什缇」）——
            //     与纹章 turnEnd 同一时点、同一口径（逻辑当场结算，演出被上面的攒 cue 窗口收在后面）。
            runCardTurnEndAbilities(this, side);
        } catch (e) {
            console.error('[TurnManager] 卡牌「回合结束时」能力结算失败：', e);
        }
        this._syncHandGate();                              // ③ 锁交互
        this._lockBattleInput(true);
        console.log(`[TurnManager] ${side === 'player' ? '我方' : '敌方'}提交结束回合 →`
            + ` 先等正在播的演出，再把回合结束效果演出排到最后，全部播完才切换`);
        this._pollTurnEnd();
        return true;
    }

    /**
     * 轮询推进「结束回合」的两段式等待：
     *   · 第 1 段：等**已经开播**的动画全部播完 → 放手把攒着的纹章演出放出来；
     *   · 第 2 段：等这批演出也播完 → 才切回合。
     * 超时熔断（绝不让回合流程卡死）。
     */
    private _pollTurnEnd(): void {
        if (!this._ending) return;
        if (Date.now() - this._endWaitStart > TurnManager.TURN_END_MAX_WAIT) {
            console.warn('[TurnManager] 结束回合等待演出超时 → 强制推进回合');
            this._finishTurnEnd();
            return;
        }
        if (this._presentationBusy()) {
            // 🔴 不用 scheduleOnce：预览环境里该调度器在 target 生命周期上有已知坑，
            //    普通定时器足够且稳定（与 CardAbilitySystem 的抽卡重试同一口径）。
            setTimeout(() => this._pollTurnEnd(), TurnManager.TURN_END_POLL);
            return;
        }
        if (!this._endFlushed) {
            // 第 1 段结束：现在才让「回合结束触发的那批演出」入队（排在所有已有动画之后）
            this._endFlushed = true;
            this._releaseDefer();
            setTimeout(() => this._pollTurnEnd(), TurnManager.TURN_END_POLL);
            return;
        }
        this._finishTurnEnd();
    }

    /**
     * 放手演出队列：把攒着的 cue 按原顺序入队（它们会接在当前演出之后播），
     * 并解除「延迟排队」状态。**任何收尾路径都必须走到这里**，否则队列会一直被掐住、动画全停。
     */
    private _releaseDefer(): void {
        const cmds = this._deferCmds;
        this._deferCmds = null;
        if (!cmds || !cmds.isValid) return;
        try { cmds.flushDeferredCues(); } catch (e) { console.error('[TurnManager] 放行演出队列失败：', e); }
    }

    /** 是否还有动画 / 演出在播（cue 队列 + 各个动画组件）—— 回合切换必须等它清空 */
    private _presentationBusy(): boolean {
        const cmds = this._comp('BattleCommandSystem');
        if (cmds && cmds.isIdle !== true) return true;
        const cp = this._comp('CardPlay');
        if (cp && cp.isPlaying) return true;
        const ecp = this._comp('EnemyCardPlay');
        if (ecp && ecp.isPlaying) return true;
        const cd = this._comp('CardDraw');
        if (cd && cd.isDrawing) return true;
        const ecd = this._comp('EnemyCardDraw');
        if (ecd && (ecd.isBusy || ecd.isDrawing)) return true;
        const fx = this._comp('EvolveFollowerFx');
        if (fx && fx.isPlaying) return true;
        return false;
    }

    /** 收尾：解锁 → 真正推进回合（回合钮在同一刻变化） */
    private _finishTurnEnd(): void {
        if (!this._ending) return;
        const side = this._endSide;
        this._ending = false;
        this._endSide = null;
        this._releaseDefer();            // 兜底：绝不把演出队列留在「延迟」状态
        this._lockBattleInput(false);
        console.log(`[TurnManager] ${side === 'player' ? '我方' : '敌方'}结束回合演出完毕 → 切换回合`);
        this._advance();
    }

    /** 清掉「结束回合等待」状态（重开对局 / 重开流程时用，避免残留锁与残留的演出延迟） */
    private _clearTurnEndWait(): void {
        this._ending = false;
        this._endSide = null;
        this._endFlushed = false;
        this._releaseDefer();
        this._lockBattleInput(false);
    }

    /**
     * 结束回合等待窗口里的**对战交互锁**：
     *   · 锁：战场按压（`BattleFieldPressGlow.enablePress`）、进化拖拽（`EvoDragController.enableDrag`）
     *     —— 手牌 / 打出由 `_syncHandGate()` 里的 `!_ending` 条件一起锁；
     *   · 解锁时**原样还原**锁之前的取值（别把别处有意关掉的开关强行打开，参考 TargetSelectSystem 的守卫做法）。
     */
    private _lockBattleInput(lock: boolean): void {
        if (lock) {
            this._lockSaved = [];
            const targets: Array<[any, string]> = [
                [this._comp('BattleFieldPressGlow'), 'enablePress'],
                [this._comp('EvoDragController'), 'enableDrag'],
            ];
            for (const [comp, key] of targets) {
                if (!comp) continue;
                this._lockSaved.push({ comp, key, value: comp[key] === true });
                comp[key] = false;
            }
            return;
        }
        for (const s of this._lockSaved) {
            if (s.comp && s.comp.isValid) s.comp[s.key] = s.value;
        }
        this._lockSaved = [];
    }

    /**
     * 结算纹章的**时机效果**（实现见 `CrestEffects.ts` 的映射表）。
     *   · `turnEnd`   —— 某一方操作回合**结束**时（上面两个 endXxxTurn 里调用）；
     *   · `turnStart` —— 某一方操作回合**开始**时（`_enterTurn` 末尾）。
     * 找不到 CrestSystem / 它没有该 API 时静默跳过（不影响回合流程）。
     */
    private _crestTiming(timing: 'turnStart' | 'turnEnd', side: TurnSide): void {
        const crest = this._comp('CrestSystem');
        if (!crest || typeof crest.runTiming !== 'function') return;
        try {
            crest.runTiming(timing, side);
        } catch (e) {
            // 铁律5：回调里的异常会被引擎吞掉 → 自己兜一层，至少留下日志
            console.error(`[TurnManager] 纹章时机 ${timing}（${side}）结算失败：`, e);
        }
    }

    // ====================== 内部：状态机 ======================

    /**
     * 推进一个操作回合。
     * 先手结束 → 进入后手；后手结束 → 大回合 +1 并回到先手（**这才是一个完整回合**）。
     */
    private _advance(): void {
        if (this._turnInRound === 1) {
            this._turnInRound = 2;
            this._enterTurn(TurnManager.other(this._first));
        } else {
            this._round += 1;
            this._turnInRound = 1;
            console.log(`[TurnManager] 先手+后手均已结束 → 完整第 ${this._round - 1} 大回合结束`);
            this._enterTurn(this._first);
        }
    }

    /** 进入某一方的操作回合：① 刷 PP ② 换回合钮 ③ 手牌门控 ④ 抽 1 张 */
    private _enterTurn(side: TurnSide): void {
        this._side = side;
        this._running = true;

        // ① 能量点：只在「进入」这一刻刷新，且只刷正在进入的这一方
        if (this.refreshPPOnTurnStart) this._refreshPP(side);

        // ①b 额外能量点：**后手的操作回合开始时**倒计时 −1（走完则换成「已获取完所有额外能量点」
        //     并回到 ExtraPP，不再更新数字）。先手回合不更新。
        if (side === this.secondSide) {
            const ep = this._comp('TurnControlPanel');
            if (ep && ep.tickExtraCountdown) ep.tickExtraCountdown();
        }

        // ①c 进化点：**每一方的操作回合开始时**，该方的普通 / 超进化点解禁倒计时各 −1
        //     （先手第一回合同样会 −1 ⇒ 先手开局 5/7 显示成 4/6）。
        const evo = this._comp('EvoPointSystem');
        if (evo && evo.onTurnStart) evo.onTurnStart(side);

        // ② 回合钮：我方 → 「结束回合」，敌方 → 「对手回合」
        const panel = this._comp('TurnControlPanel');
        if (panel && panel.setRoundSide) panel.setRoundSide(side === 'enemy');

        // ③ 手牌可用性（update() 里还会每帧重申）
        this._syncHandGate();

        // ④ 纹章的「回合开始时」效果（实现见 CrestEffects.ts）
        //   🔴 **必须排在抽卡之前**（需求）：纹章给的卡要先于本回合抽的那张进入手牌，
        //      这样手牌满时也是「纹章给的卡先占位 / 抽卡那张被破坏」，顺序才符合预期。
        this._crestTiming('turnStart', side);

        // ⑤ 回合开始抽 1 张 —— 必须等纹章给卡的展示动画完全播完再抽（否则两个动画重叠）
        this._drawAfterHandReveal(side);

        console.log(`[TurnManager] ▶ ${this.statusText}`);
    }

    /** 最大能量点 = 当前大回合数；可用能量点 = 最大能量点 */
    private _refreshPP(side: TurnSide): void {
        const panel = this._comp('TurnControlPanel');
        if (!panel || !panel.setPP) return;
        // 🔴 硬上限封顶：能量横幅只有 10 个 PP 槽位，大回合数超过 maxPPCap 后
        //    「最大 = 大回合数」会让最大值超过素材容量 → 一律封在 maxPPCap（默认 10）。
        const n = Math.min(Math.max(1, Math.round(this.maxPPCap)),
            Math.max(0, Math.round(this._round)));
        panel.setPP(side, n, n);
    }

    /**
     * 对局初始（begin / restart）：**双方**的能量点都初始化为「最大=大回合数、可用=最大」。
     * 🔴 不能只靠 `_enterTurn` —— 它只刷新「进入回合的那一方」，后手方会一直挂着场景里
     *    烘焙的旧值（我方 1/10、敌方 1/9），直到他自己进入操作回合才被覆盖，
     *    开局到后手入场之间的整段时间显示都是错的。
     * 注意这只发生在**开战/重开**那一刻，与「只有进入新操作回合才更新显示、回合结束时不更新」
     * 的规则不冲突（回合结束路径依旧不碰 PP）。
     */
    private _initPPBoth(): void {
        if (!this.refreshPPOnTurnStart) return;
        this._refreshPP('player');
        this._refreshPP('enemy');
    }

    /**
     * 对局初始（开战 / 重开）：进化点按**先后手**写入初始倒计时与次数。
     * 先手方 EP/SEP = 5/7，后手方 = 4/6；紧接着 `_enterTurn(先手)` 会让先手再 −1，
     * 于是先手第一回合显示 4/6（与实机一致）。
     */
    private _initEvoPoints(): void {
        const evo = this._comp('EvoPointSystem');
        if (evo && evo.reset) evo.reset(this._first);
    }

    /**
     * 对局初始（开战 / 重开）：清空双方的**纹章**（获得顺序与显示一并复位）。
     * 纹章的发放由卡牌能力 `GainCrest` 走 CrestSystem.gainCrest。
     */
    private _resetCrests(): void {
        const crests = this._comp('CrestSystem');
        if (crests && typeof crests.resetForBattle === 'function') crests.resetForBattle();
    }

    /**
     * 随机抽 1 张（我方走 CardDraw，敌方走 EnemyCardDraw）。
     * 🔴 抽卡来源：**优先从 CardDeckManager（卡组背包）抽** —— 需求规定对局中只能从
     *    各自卡组里随机抽、抽完不能再抽；组件缺失时回退到旧 cardPool 随机池。
     * 🔴 我方抽卡是**单飞**的（CardDraw 内部 `_busy`）—— 动画没结束再调 `draw` 会被**直接拒绝**。
     *    控制台连点「结束回合」时很容易撞上，若就此丢掉这一抽，手感就是「有时候不抽牌」。
     *    因此：判定为「正在抽」时**延迟重试**（最多 `DRAW_RETRY_MAX` 次），而不是放弃。
     */
    private static readonly DRAW_RETRY_MAX = 14;
    private static readonly DRAW_RETRY_DELAY = 0.5;

    private _drawOne(side: TurnSide, attempt = 0, cardId = ''): void {
        // 🔴 卡组是真实集合：抽出的这张 id 在重试期间必须**沿用**（不能每次重试重新抽，
        //    否则一次「动画忙」重试会白白多扣一张牌堆）。首次调用时抽一次并缓存。
        const id = cardId || this._nextCardId(side);
        if (!id) return;   // 卡组为空 / 卡池为空的告警已在内部打掉

        if (side === 'player') {
            const cd = this._comp('CardDraw');
            if (!cd) { console.warn('[TurnManager] 找不到 CardDraw，跳过我方抽卡'); return; }
            if (cd.draw(id)) {
                const dm = this._comp('CardDeckManager');
                if (dm && dm.remaining) console.log(`[TurnManager] 我方抽到 ${id}（卡组剩 ${dm.remaining('player')}/${dm.initialSize('player')} 张）`);
                return;
            }
            if (cd.isDrawing && attempt < TurnManager.DRAW_RETRY_MAX) {
                this.scheduleOnce(() => this._drawOne(side, attempt + 1, id), TurnManager.DRAW_RETRY_DELAY);
                return;
            }
            console.warn(`[TurnManager] 我方抽卡失败（动画进行中 / 卡背未就绪 / 手牌已满）→ ${id}`);
            return;
        }

        const ecd = this._comp('EnemyCardDraw');
        if (!ecd) { console.warn('[TurnManager] 找不到 EnemyCardDraw，跳过敌方抽卡'); return; }
        // 敌方的 drawMany 是**队列化**的，动画中调用会入队而不是失败 → 无需重试
        if (!ecd.drawMany([id])) console.warn(`[TurnManager] 敌方抽卡未入队（缺组件 / 手牌已满）→ ${id}`);
    }

    /**
     * 本回合要抽的下一张卡的 id。
     * 有 CardDeckManager → 从该方卡组背包随机抽 1 张（真实集合，抽完返回 '' 并告警）；
     * 没有 → 退回旧逻辑：cardPool / CardDraw.testCardIds 里随机挑一张。
     */
    /**
     * 等「非抽卡入手牌」的展示动画播完再抽卡（判据 = CardAbilitySystem.isHandRevealBusy()）。
     * 没有纹章给卡时它恒为 false，立刻抽；轮询 60ms，4s 熔断。
     */
    private _drawAfterHandReveal(side: TurnSide): void {
        if (!this.autoDrawOnTurnStart) return;
        const t0 = Date.now();
        const MAX_WAIT = 4000;
        const step = (): void => {
            if (!this.isValid) return;
            let busy = false;
            try { busy = isHandRevealBusy(); } catch (e) { busy = false; }
            if (busy && Date.now() - t0 < MAX_WAIT) { setTimeout(step, 60); return; }
            if (busy) console.warn("[TurnManager] 入手牌展示动画超时未结束 → 照常抽卡");
            try { this._drawOne(side); } catch (e) { console.error("[TurnManager] 回合开始抽卡失败：", e); }
        };
        setTimeout(step, 0);
    }

    private _nextCardId(side: TurnSide): string {
        const dm = this._comp('CardDeckManager');
        if (dm && dm.drawFor) return dm.drawFor(side);
        const pool = this._pool();
        if (pool.length === 0) {
            console.warn('[TurnManager] 卡池为空（无 CardDeckManager，且 cardPool 与 CardDraw.testCardIds 都为空），跳过回合开始抽卡');
            return '';
        }
        return pool[Math.floor(Math.random() * pool.length)];
    }

    /** 卡池：优先 cardPool，其次 CardDraw.testCardIds */
    private _pool(): string[] {
        if (this.cardPool && this.cardPool.length > 0) return this.cardPool.slice();
        const cd = this._comp('CardDraw');
        if (cd && cd.testCardIds && cd.testCardIds.length > 0) return cd.testCardIds.slice();
        return [];
    }

    // ====================== 内部：手牌可用性门控 ======================

    /**
     * 把「我方手牌能不能用」同步到 HandDrag / CardPlay。
     * 🔴 每帧比对后重申：`HandMinimize.expand()` 会无条件把 `HandDrag.enableDrag` 写回 true
     *    （缩略→展开的恢复路径），若不重申，敌方回合里点一下手牌缩略再展开就能继续拖牌。
     */
    private _syncHandGate(): void {
        // 🔴 `!_ending`：「已提交结束回合、等演出播完」的窗口里也必须禁手牌 / 禁打出
        //    （回合归属要到演出播完才切，光看 `_side` 会在这段时间留一个可操作的缝）。
        const want = this._running && !this._ending && this._side === 'player';
        const drag = this._comp('HandDrag');
        if (drag) {
            // 🔴 缩略态 / 缩略↔完整过渡期间必须保持禁拖：
            //    HandMinimize.minimize() 写下的 enableDrag=false 若不在此守住，会被
            //    本方法下一帧的「重申」翻转回 true —— 缩略态下按卡牌时 HandMinimize.expand()
            //    与 HandDrag.beginDrag（放大 tween）同帧抢同一张卡，被按的那张卡被
            //    拖拽放大 tween 拉大叠在展开过渡上（「某张卡不正确放大」的根因）。
            //    过渡中（isTransitioning）也禁：expand 的完成回调才恢复拖拽，过渡途中
            //    卡牌姿态还在逐帧重排，此时抓起会拿到错误的原位记录。
            const mini = this._comp('HandMinimize');
            const dragOk = want && !(mini && (mini.isMinimized || mini.isTransitioning));
            if (drag.enableDrag !== dragOk) {
                if (!want && drag.isDragging) drag.cancelDrag();   // 回合结束时把正在拖的牌收回
                drag.enableDrag = dragOk;
            }
        }
        const play = this._comp('CardPlay');
        if (play && play.enablePlay !== want) play.enablePlay = want;
    }

    /**
     * 把回合钮的点击接管过来：
     *   · 显示「结束回合」时点击 → 结束我方操作回合
     *   · 显示「对手回合」时点击 → **什么都不做**（敌方回合由控制台的「结束敌方回合」结束）
     */
    private _bindRoundButton(): void {
        const panel = this._comp('TurnControlPanel');
        if (!panel) {
            console.warn('[TurnManager] 找不到 TurnControlPanel —— 回合钮点击未接管');
            return;
        }
        panel.roundClickHandler = (side: TurnSide) => {
            if (side === 'player') this.endPlayerTurn();
        };
    }

    // ====================== 小工具 ======================

    private static normSide(v: any): TurnSide {
        return v === 'enemy' || v === true ? 'enemy' : 'player';
    }

    private static other(side: TurnSide): TurnSide {
        return side === 'player' ? 'enemy' : 'player';
    }

    /** 按类名找组件（BFS，结果缓存；组件被销毁时自动重找） */
    private _comp(className: string): any {
        const cached = this._cache.get(className);
        if (cached && cached.isValid) return cached;
        const scene = this.node.scene as unknown as Node | null;
        if (!scene) return null;
        const stack: Node[] = [...scene.children];
        while (stack.length > 0) {
            const cur = stack.shift() as Node;
            const c = cur.getComponent(className);
            if (c) { this._cache.set(className, c); return c; }
            for (const ch of cur.children) stack.push(ch);
        }
        return null;
    }

    /** 按类名找**全部**同类组件（战场有我方/敌方两个实例，不能用单数版） */
    private _comps(className: string): any[] {
        const out: any[] = [];
        const scene = this.node.scene as unknown as Node | null;
        if (!scene) return out;
        const stack: Node[] = [...scene.children];
        while (stack.length > 0) {
            const cur = stack.shift() as Node;
            const c = cur.getComponent(className);
            if (c) out.push(c);
            for (const ch of cur.children) stack.push(ch);
        }
        return out;
    }

    // ====================== 对外：重开对局（清场） ======================

    private static readonly BOARD_RETRY_MAX = 20;
    private static readonly BOARD_RETRY_DELAY = 0.25;

    /** 是否有抽卡动画在飞（我方单飞 CardDraw / 敌方队列 EnemyCardDraw） */
    private _boardBusy(): boolean {
        const cd = this._comp('CardDraw');
        const ecd = this._comp('EnemyCardDraw');
        return !!(cd && cd.isDrawing) || !!(ecd && ecd.isDrawing);
    }

    /** 立刻清空双方战场 + 双方手牌（**不动**先手设置，也不动 PP） */
    private _clearBoardNow(): void {
        const play = this._comp('CardPlay');
        if (play && play.resetForBattle) play.resetForBattle();
        const hl = this._comp('HandLayout');
        const ehl = this._comp('EnemyHandLayout');
        if (hl && hl.clearHand) hl.clearHand();
        if (ehl && ehl.clearHand) ehl.clearHand();
        for (const bf of this._comps('BattleFieldLayout')) {
            if (bf && bf.clear) bf.clear();
        }
        console.log('[TurnManager] 棋盘已清空（双方战场 + 双方手牌）');
    }

    /**
     * 重开对局：清空双方战场 + 双方手牌 → 回到第 1 大回合（能量点双方一起刷成 1/1）。
     * @param reRollFirst true = 重新随机先手（「随机开战」）；false = **保留**当前先手（「重开对决」）
     *
     * 🔴 抽卡动画在飞时清场会打架：在飞的卡节点可能被 `refresh()` 当垃圾销毁、
     *    敌方队列里排着的卡还会补进来 ⇒ 清完又冒出一张。所以判定「正在抽」时把
     *    「清场 + 重开」**作为一个整体**延迟重试，而不是清一半就重开。
     */
    public resetBattle(reRollFirst: boolean, attempt = 0): void {
        if (this._boardBusy() && attempt < TurnManager.BOARD_RETRY_MAX) {
            this.scheduleOnce(() => this.resetBattle(reRollFirst, attempt + 1), TurnManager.BOARD_RETRY_DELAY);
            return;
        }
        this._clearBoardNow();
        if (reRollFirst) this.begin();
        else this.restart();
    }
}


