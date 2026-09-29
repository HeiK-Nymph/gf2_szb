import { _decorator, Component, Node } from 'cc';
import { EDITOR } from 'cc/env';
import { EvoPointBadge, EvoPointKind } from './EvoPointBadge';
import { HeroArea, HeroSide } from './HeroArea';

const { ccclass, property, executeInEditMode, menu } = _decorator;

/** 对局方（与 TurnManager.TurnSide 同构，这里单独声明避免循环 import） */
export type EvoSide = 'player' | 'enemy';

/** 某一方持有的进化点数据 */
export interface EvoSideState {
    /** 普通进化点：解禁倒计时（> 0 = 未解禁；<= 0 = 已解禁） */
    epCountdown: number;
    /** 超进化点：解禁倒计时 */
    sepCountdown: number;
    /** 普通进化点：剩余可用次数 */
    epLeft: number;
    /** 超进化点：剩余可用次数 */
    sepLeft: number;
}

/** 对外返回的一次「进化点快照」（UI / 判定共用） */
export interface EvoPointSnapshot {
    countdown: number;
    remaining: number;
    unlocked: boolean;
    usable: boolean;
}

/**
 * EvoPointSystem —— 进化点（普通 / 超进化）的**权威数据源 + 回合联动**
 * ===========================================================================
 * 挂在 `TurnManager` 节点上（`TurnManager._enterTurn` 调用 `onTurnStart`）。
 *
 * 规则（实机行为）：
 *   · **普通进化点 EP** 与 **超进化点 SEP** 各只有 **2 次**；
 *   · 两者都有**解禁倒计时**：自己的每个回合开始都各 −1（**先手第一回合也会 −1**），
 *     倒计时降到 0 即**解禁**（UI 上数字消失、图标点亮）；
 *   · 先手方初始 **5 / 7**（EP / SEP），后手方初始 **4 / 6** —— 于是
 *     先手第 5 回合解禁普通进化、第 7 回合解禁超进化；后手第 4 / 第 6 回合；
 *   · 倒计时**只减不增**；(side, kind) 各自独立。
 *
 * UI 侧：4 枚 EvoPointBadge（我方 / 敌方 × EP / SEP），本系统负责写入状态。
 * ===========================================================================
 */
@ccclass('EvoPointSystem')
@executeInEditMode(true)
@menu('gf2szb/EvoPointSystem')
export class EvoPointSystem extends Component {

    // ====================== 初始倒计时（先手 / 后手）======================

    @property({ range: [0, 20, 1], slide: true, tooltip: '**先手方**普通进化点解禁倒计时（默认 5 → 先手第 5 回合解禁）' })
    epFirstCountdown = 5;

    @property({ range: [0, 20, 1], slide: true, tooltip: '**先手方**超进化点解禁倒计时（默认 7 → 先手第 7 回合解禁）' })
    sepFirstCountdown = 7;

    @property({ range: [0, 20, 1], slide: true, tooltip: '**后手方**普通进化点解禁倒计时（默认 4）' })
    epSecondCountdown = 4;

    @property({ range: [0, 20, 1], slide: true, tooltip: '**后手方**超进化点解禁倒计时（默认 6）' })
    sepSecondCountdown = 6;

    // ====================== 次数 ======================

    @property({ range: [0, 6, 1], slide: true, tooltip: '普通进化点可用次数（默认 2）' })
    epMaxUses = 2;

    @property({ range: [0, 6, 1], slide: true, tooltip: '超进化点可用次数（默认 2）' })
    sepMaxUses = 2;

    // ====================== 统一数字样式（四枚徽记共用）======================

    @property({
        range: [0.1, 1, 0.005], slide: true,
        tooltip: '🔴 **四枚徽记统一**：倒计时数字字号 ÷ badgeSize。\n'
            + '改这一个值 → 我方 / 敌方 × 普通进化 / 超进化 四枚的数字一起变。\n'
            + '（编辑器里也能实时看到效果）',
    })
    numFontRatio = 0.54;

    @property({
        range: [-0.4, 0.4, 0.005], slide: true,
        tooltip: '🔴 **四枚徽记统一**：倒计时数字**横向**偏移 ÷ badgeSize（正 = 向右）',
    })
    numOffsetX = 0;

    @property({
        range: [-0.4, 0.4, 0.005], slide: true,
        tooltip: '🔴 **四枚徽记统一**：倒计时数字**纵向**偏移 ÷ badgeSize（正 = 向上）',
    })
    numOffsetY = 0.03;

    // ====================== 徽记位置对称微调（Inspector 暴露 · 绝对 px）======================
    // 🔴 徽记的**位置计算**在 HeroArea.buildBadges（框架尺寸 / 镜像方向都在那边），
    //    这两个变量只是「对称微调量」，由本组件统一下发 —— 同一个位置只有这一处可以写，
    //    避免 HeroArea 上再放一份可以写歪的同名参数。
    //    默认全 0 ⇒ 位置与加这两个变量之前**完全一致**。

    @property({
        range: [-400, 400, 1], slide: true,
        tooltip: '★【我方徽记位置 · 水平】在默认间距之外，把**我方**两枚徽记**左右对称外扩**的像素（px）。\n'
            + '正值 = 两枚一起往外分开：普通进化点 EvoEP_player 左移 X、超进化点 EvoSEP_player 右移 X；\n'
            + '负值 = 两枚一起往中间靠。\n'
            + '🔴 绝对值 px（不是 frameSize 比例）：敌我两个 HeroArea 的 frameSize 不同（280 / 223），\n'
            + '比例口径会让同一次调整在两边移动不同距离，绝对值才能保证「手感」两侧一致。',
    })
    playerBadgeOffsetX = 0;

    @property({
        range: [-400, 400, 1], slide: true,
        tooltip: '★【我方徽记位置 · 垂直】把**我方**两枚徽记一起沿「朝屏幕中心」方向挪的像素（px）。\n'
            + '正值 = 往上（朝战场 / 屏幕中心）；负值 = 往下（朝英雄框外沿 / 屏幕下缘）。\n'
            + '🔴 两枚徽记的 y 始终相同（上下永远一起走），横向对称由上面的 X 保证。',
    })
    playerBadgeOffsetY = 0;

    @property({
        range: [-400, 400, 1], slide: true,
        tooltip: '★【敌方徽记位置 · 水平】在默认间距之外，把**敌方**两枚徽记**左右对称外扩**的像素（px）。\n'
            + '正值 = 两枚一起往外分开：普通进化点 EvoEP_enemy 左移 X、超进化点 EvoSEP_enemy 右移 X；\n'
            + '负值 = 两枚一起往中间靠。\n'
            + '🔴 与「我方 · 水平」是**各自独立**的两个值（敌人是 223 框、我方是 280 框，常常需要不同的量）。',
    })
    enemyBadgeOffsetX = 0;

    @property({
        range: [-400, 400, 1], slide: true,
        tooltip: '★【敌方徽记位置 · 垂直】把**敌方**两枚徽记一起沿「朝屏幕中心」方向挪的像素（px）。\n'
            + '正值 = 往下（朝战场 / 屏幕中心）；负值 = 往上（朝英雄框外沿 / 屏幕上缘）。\n'
            + '🔴 与「我方 · 垂直」各自独立；两枚徽记 y 始终相同。',
    })
    enemyBadgeOffsetY = 0;

    @property({ tooltip: '打印每次倒计时 / 消耗的日志' })
    verbose = true;

    // ====================== 内部状态 ======================
    private _state: Record<EvoSide, EvoSideState> = {
        player: { epCountdown: 5, sepCountdown: 7, epLeft: 2, sepLeft: 2 },
        enemy: { epCountdown: 4, sepCountdown: 6, epLeft: 2, sepLeft: 2 },
    };
    /** 先手方（决定初始倒计时差异） */
    private _first: EvoSide = 'player';
    private _ready = false;
    /**
     * 本回合是否**已经使用过进化**（按方记录）。
     * 🔴 规则：一个自己的回合内最多使用 **一次**进化（普通或超进化任选其一）——
     *    用过之后本回合内连另一枚图标也不能拖（由 `EvoDragController` 门控）。
     *    自己的回合开始（`onTurnStart`）时清零。
     */
    private _usedThisTurn: Record<EvoSide, boolean> = { player: false, enemy: false };
    /** 徽记组件缓存（key = `side|kind`） */
    private _badgeCache = new Map<string, EvoPointBadge>();
    /** HeroArea 缓存（key = side）—— 徽记位置的落地方，用于下发「位置对称微调」 */
    private readonly _heroCache = new Map<EvoSide, HeroArea>();
    /** 上一次下发的统一数字样式签名（变了才重新下发，避免每帧重建 UI） */
    private _numKey = '\u0000';

    // ------------------------------ 生命周期 ------------------------------
    onLoad(): void {
        // 🔴 运行时**不要**在这里 reset：`TurnManager.begin/restart` 会显式 reset，
        //    这里抢先写一遍会把「先手第一回合已 −1」的正确状态覆盖回初始值。
        //    仅编辑器预览时写一份默认值，让 Inspector / 场景视图有意义。
        if (EDITOR) this.reset(this._first);
        this.applyNumStyleToAll();
        this.applyBadgeOffsetsToAll();
    }

    update(): void {
        // 统一数字样式（字号 / 偏移）变了就重新下发 —— 3 个数字比较，开销可忽略
        const key = this.numStyleKey();
        if (key === this._numKey) return;
        this._numKey = key;
        this.applyNumStyleToAll();
        this.applyBadgeOffsetsToAll();
    }

    /** 统一签名：数字样式 + 4 个徽记位置微调（任一变化才重新下发） */
    private numStyleKey(): string {
        return `${this.numFontRatio}|${this.numOffsetX}|${this.numOffsetY}`
            + `|${this.playerBadgeOffsetX}|${this.playerBadgeOffsetY}`
            + `|${this.enemyBadgeOffsetX}|${this.enemyBadgeOffsetY}`;
    }

    /**
     * 把「徽记位置对称微调」下发给我方 / 敌方两个 HeroArea（幂等：值没变时 HeroArea 自己也短路）。
     * 🔴 位置的真实计算只有一处（`HeroArea.buildBadges`），这里只负责把 4 个可调值送过去。
     */
    public applyBadgeOffsetsToAll(): void {
        this.applyBadgeOffsetTo('player', this.playerBadgeOffsetX, this.playerBadgeOffsetY);
        this.applyBadgeOffsetTo('enemy', this.enemyBadgeOffsetX, this.enemyBadgeOffsetY);
    }

    private applyBadgeOffsetTo(side: EvoSide, x: number, y: number): void {
        const hero = this.heroAreaOf(side);
        if (hero) hero.setBadgeOffset(x, y);
    }

    /** 取某方的 HeroArea（带缓存，节点失效自动重查）。 */
    private heroAreaOf(side: EvoSide): HeroArea | null {
        const cached = this._heroCache.get(side);
        if (cached && cached.isValid) return cached;
        const scene = this.node.scene;
        if (!scene) return null;
        const want = side === 'player' ? HeroSide.Player : HeroSide.Enemy;
        const stack: Node[] = [scene];
        while (stack.length > 0) {
            const cur = stack.shift() as Node;
            const h = cur.getComponent(HeroArea);
            if (h && h.isValid && h.side === want) { this._heroCache.set(side, h); return h; }
            for (const ch of cur.children) stack.push(ch);
        }
        return null;
    }

    /** 把「统一数字样式」下发给四枚徽记（我方 / 敌方 × EP / SEP） */
    public applyNumStyleToAll(): void {
        const sides: EvoSide[] = ['player', 'enemy'];
        const kinds: EvoPointKind[] = [EvoPointKind.EP, EvoPointKind.SEP];
        for (const side of sides) {
            for (const kind of kinds) {
                const b = this.badgeOf(side, kind);
                if (b) b.applyNumStyle(this.numFontRatio, this.numOffsetX, this.numOffsetY);
            }
        }
    }

    // ------------------------------ 对外 API ------------------------------

    /**
     * 本局中该方随从**进化过的总次数**（普通 + 超进化都算 1 次）。
     *
     * 🔴 用途 = 「**奥义 / 解放奥义**」的奥义槽第二项（`在手牌中时自己的随从的进化次数`）：
     *    手牌卡在**进入手牌那一刻**记下本计数的快照，结算时相减 = 该卡在手牌期间我方的进化次数。
     *    计数点选在 `consume()` —— 进化点消耗成功 ⇔ 这张随从这次真的进化了（唯一入口）。
     */
    private _evolveCount: Record<EvoSide, number> = { player: 0, enemy: 0 };

    /** 该方随从本局累计进化次数（奥义槽用）。 */
    public evolveCountOf(side: EvoSide): number {
        return Math.max(0, Math.round(this._evolveCount[side] || 0));
    }

    /**
     * 开局 / 重开：按先手方写入双方初始倒计时与次数，并刷新 4 枚徽记。
     * 由 `TurnManager.begin()` / `restart()` 调用。
     */
    public reset(firstSide: EvoSide): boolean {
        this._first = firstSide === 'enemy' ? 'enemy' : 'player';
        this._usedThisTurn = { player: false, enemy: false };
        this._evolveCount = { player: 0, enemy: 0 };      // 奥义槽的进化计数随对局重开清零
        const second: EvoSide = this._first === 'player' ? 'enemy' : 'player';
        this._state[this._first] = {
            epCountdown: Math.max(0, Math.round(this.epFirstCountdown)),
            sepCountdown: Math.max(0, Math.round(this.sepFirstCountdown)),
            epLeft: Math.max(0, Math.round(this.epMaxUses)),
            sepLeft: Math.max(0, Math.round(this.sepMaxUses)),
        };
        this._state[second] = {
            epCountdown: Math.max(0, Math.round(this.epSecondCountdown)),
            sepCountdown: Math.max(0, Math.round(this.sepSecondCountdown)),
            epLeft: Math.max(0, Math.round(this.epMaxUses)),
            sepLeft: Math.max(0, Math.round(this.sepMaxUses)),
        };
        this._ready = true;
        if (this.verbose) {
            console.log(`[EvoPoint] reset：先手 ${this._first}`
                + ` / 先手 EP ${this._state[this._first].epCountdown} SEP ${this._state[this._first].sepCountdown}`
                + ` / 后手 EP ${this._state[second].epCountdown} SEP ${this._state[second].sepCountdown}`);
        }
        this.refreshAll();
        return true;
    }

    /**
     * 某一方的**操作回合开始**：该方 EP / SEP 倒计时各 −1（下限 0）。
     * 🔴 先手的第一回合同样会 −1（调用方 `TurnManager._enterTurn` 对双方一视同仁）。
     * @returns 本次「刚解禁」的进化点种类（供上层播放解禁提示）
     */
    public onTurnStart(side: EvoSide): { ep: boolean; sep: boolean } {
        const s = this._state[side];
        if (!s) return { ep: false, sep: false };
        // 🔴 自己的回合开始 → 「本回合已用进化」清零（一回合一次的额度刷新）
        this._usedThisTurn[side] = false;
        const epBefore = s.epCountdown;
        const sepBefore = s.sepCountdown;
        s.epCountdown = Math.max(0, epBefore - 1);
        s.sepCountdown = Math.max(0, sepBefore - 1);
        const justEp = epBefore > 0 && s.epCountdown === 0;
        const justSep = sepBefore > 0 && s.sepCountdown === 0;
        if (this.verbose) {
            console.log(`[EvoPoint] ${side} 回合开始 → EP ${epBefore}→${s.epCountdown}` +
                `${justEp ? '（解禁）' : ''} / SEP ${sepBefore}→${s.sepCountdown}${justSep ? '（解禁）' : ''}`);
        }
        this.refresh(side);
        return { ep: justEp, sep: justSep };
    }

    /** 该方该类进化点是否**此刻可用**（已解禁 + 还有次数） */
    public isUsable(side: EvoSide, kind: EvoPointKind): boolean {
        return this.snapshot(side, kind).usable;
    }

    /** 取快照 */
    public snapshot(side: EvoSide, kind: EvoPointKind): EvoPointSnapshot {
        const s = this._state[side];
        const countdown = kind === EvoPointKind.EP ? s.epCountdown : s.sepCountdown;
        const remaining = kind === EvoPointKind.EP ? s.epLeft : s.sepLeft;
        const unlocked = countdown <= 0;
        return { countdown, remaining, unlocked, usable: unlocked && remaining > 0 };
    }

    /**
     * **消耗一次**该方该类进化点（真正使用进化时调用）。
     * 🔴 一回合一次：本回合已经用过（普通或超进化任一）→ 直接拒绝。
     * @returns 是否成功（未解禁 / 没次数 / 本回合已用过 → false，不改数据）
     */
    public consume(side: EvoSide, kind: EvoPointKind): boolean {
        if (this._usedThisTurn[side]) {
            if (this.verbose) console.warn(`[EvoPoint] ${side} 本回合已经使用过进化（一回合一次）→ 拒绝`);
            return false;
        }
        const snap = this.snapshot(side, kind);
        if (!snap.usable) {
            if (this.verbose) console.warn(`[EvoPoint] ${side} ${EvoPointKind[kind]} 不可用（倒计时 ${snap.countdown} / 剩余 ${snap.remaining}）→ 拒绝`);
            return false;
        }
        const s = this._state[side];
        if (kind === EvoPointKind.EP) s.epLeft = Math.max(0, s.epLeft - 1);
        else s.sepLeft = Math.max(0, s.sepLeft - 1);
        this._usedThisTurn[side] = true;
        // 奥义槽：这次进化计入该方的「累计进化次数」
        this._evolveCount[side] = Math.max(0, Math.round(this._evolveCount[side] || 0)) + 1;
        if (this.verbose) {
            console.log(`[EvoPoint] ${side} 消耗 ${EvoPointKind[kind]} → 剩余 ${this.snapshot(side, kind).remaining}（本回合进化额度已用）`);
        }
        this.refresh(side);
        return true;
    }

    /** 该方本回合是否已经使用过进化（一回合一次） */
    public hasUsedEvolveThisTurn(side: EvoSide): boolean {
        return !!this._usedThisTurn[side];
    }

    /** 只做一次全量 UI 同步（调试 / 场景重载后） */
    public refreshAll(): void {
        this.refresh('player');
        this.refresh('enemy');
    }

    // ------------------------------ UI 同步 ------------------------------

    private refresh(side: EvoSide): void {
        const s = this._state[side];
        this.apply(side, EvoPointKind.EP, s.epCountdown, s.epLeft);
        this.apply(side, EvoPointKind.SEP, s.sepCountdown, s.sepLeft);
    }

    private apply(side: EvoSide, kind: EvoPointKind, countdown: number, remaining: number): void {
        const badge = this.badgeOf(side, kind);
        if (!badge) return;
        // 顺带把统一数字样式同步过去（徽记可能是刚被 HeroArea 重建出来的）
        badge.applyNumStyle(this.numFontRatio, this.numOffsetX, this.numOffsetY);
        badge.applyState(countdown, remaining);
    }

    /**
     * 取某方某类的徽记组件。
     * 🔴 徽记挂在 `Canvas/EvoPointLayer`（我方）/ `Canvas/EvoPointLayer_Enemy`（敌方）下
     *    （拆分出的独立渲染层，见 HeroArea.buildBadges / placeBadgeLayer），
     *    所以按 `sideLabel + kind` 在**全场景**匹配，不要假设它挂在 HeroArea 里面。
     */
    public badgeOf(side: EvoSide, kind: EvoPointKind): EvoPointBadge | null {
        const key = side + '|' + kind;
        const cached = this._badgeCache.get(key);
        if (cached && cached.isValid) return cached;
        const scene = this.node.scene;
        if (!scene) return null;
        const stack: Node[] = [scene];
        while (stack.length > 0) {
            const cur = stack.shift() as Node;
            const b = cur.getComponent(EvoPointBadge);
            if (b && b.sideLabel === side && b.kind === kind) {
                this._badgeCache.set(key, b);
                return b;
            }
            for (const ch of cur.children) stack.push(ch);
        }
        return null;
    }
}
