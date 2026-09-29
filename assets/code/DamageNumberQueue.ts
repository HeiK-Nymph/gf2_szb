/**
 * DamageNumberQueue —— 伤害 / 治疗飘字的**待播队列**（模块级，不 import 任何项目模块，避免循环依赖）
 * ===========================================================================
 * 设计（用户口径：**显示伤害/治疗数字也算是动画的一部分**）：
 *   ① 谁**改了血量**谁就在这里登记一条（`recordNumber`）—— 卡牌走 `BattleRuleSystem.setHp`、
 *      主战者走 `HeroArea.setHp`；差值当场算好，**不依赖任何「上次显示过的血量」基准**
 *      （踩过：靠基准 diff ⇒ 第一次伤害永远被跳过、召唤入场的卡没基准 ⇒ 时有时无）；
 *   ② 演出队列播到 `RefreshNumbers`（= 攻击/反击/破坏动画播完那一刻）时 `takeNumbers()` 取走，
 *      统一飘字 ⇒ 数字天然排在动画之后，顺序与动画一致。
 * ===========================================================================
 */

export interface PendingNumber {
    /** ★ 是否为「被挡下的伤害」：这种 0 也要显示（屏障破碎 / 超进化守护都有对应动画） */
    blocked?: boolean;
    /** ★ 治疗实际获得 0 也要显示（满血被治疗 ⇒ 绿色 +0，用户口径：显示**实际**治疗值） */
    allowZero?: boolean;
    /** 数字挂在谁身上（卡牌节点 / 主战者节点） */
    anchor: unknown;
    /** 正数 = 掉血（红）；负数 = 回血（绿） */
    delta: number;
    /** 是否主战者（决定用哪个位置偏移） */
    isHero: boolean;
    /** ★ 演出阶段：'attack'（攻击命中目标）/ 'counter'（反击命中攻击者）/ 'superBreak'（超进化连锁）/ ''（其它） */
    phase: string;
    /** ★ 登记时间（看门狗只兜「够旧」的，避免抢在动画之前播） */
    ts: number;
    /** ★ 登记时的世界坐标（锚点后来被销毁也能照常飘） */
    wx?: number;
    wy?: number;
    wz?: number;
}

const _pending: PendingNumber[] = [];
/** ★ 压制开关：某些演出（超进化随从攻击且**不播反击动画**）期间不登记飘字。 */
let _suppressed = false;
/** ★ 当前演出阶段（由战斗结算设置，登记时自动带上）。 */
let _phase = '';

/** ★ 设置当前演出阶段（成对使用，用完恢复 ''）。 */
export function setNumberPhase(p: string): void {
    _phase = p || '';
}

/** ★ 压制 / 解除飘字登记（成对使用）。 */
export function setNumberSuppressed(on: boolean): void {
    _suppressed = !!on;
}
/** 兜底定时器句柄 */
let _watchdog: number | null = null;
/** 消费者（DamageNumberFx 注册） */
let _sink: ((list: PendingNumber[]) => void) | null = null;

/** ★ 登记一条飘字（delta 正 = 受伤、负 = 治疗）。anchor 传 Node。 */
export function recordNumber(anchor: unknown, delta: number, isHero: boolean, blocked = false, phase?: string, allowZero = false, immediate = false): void {
    try {
        if (_suppressed) return;                       // 压制期间不登记（如「不播反击动画」的那一段）
        const d = Math.round(Number(delta) || 0);
        if (!anchor || (d === 0 && !blocked && !allowZero)) return;
        const wp = (anchor as { worldPosition?: { x: number; y: number; z: number } }).worldPosition;
        const item: PendingNumber = {
            anchor, delta: d, isHero: !!isHero, blocked: !!blocked, allowZero: !!allowZero,
            phase: phase === undefined ? _phase : phase, ts: Date.now(),
            wx: wp ? wp.x : undefined, wy: wp ? wp.y : undefined, wz: wp ? wp.z : undefined,
        };
        // ★ 治疗没有动画 ⇒ 结算当场就播（用户口径：治疗数字不要被演出队列延迟）
        if (immediate && _sink) { _sink([item]); return; }
        _pending.push(item);
        scheduleFallback();
    } catch (e) { /* 忽略 */ }
}

/**
 * ★ **兜底**：登记后若 1.2s 内没人来取（有些能力路径不压 RefreshNumbers / Done cue），
 *   就直接交给 DamageNumberFx 播 —— 保证「数字一定出现」，最多比动画晚一点点。
 *   🔴 用户口径「数字也是动画的一部分」：正常路径仍由演出队列在动画结束时取走，这条只是保险。
 */
function scheduleFallback(): void {
    // ★ 常驻看门狗（800ms 一次）：只要队列里还有没播的数字就交给消费者。
    //   🔴 曾经是一次性 setTimeout ⇒ 若那一次恰好 sink 还没注册（或已被别人取走又放回），
    //      这批数字就**永远**留在队列里 = 用户看到的「时有时无」。看门狗保证一定播出去。
    if (_watchdog !== null) return;
    _watchdog = setInterval(() => {
        try {
            if (_pending.length === 0) return;
            const sink = _sink;
            if (!sink) return;                       // 消费者还没注册 → 等下一轮，不丢
            // 🔴 阈值必须**大于一次攻击/反击动画**（约 1.5~2s）：曾经是 1200ms ⇒ 看门狗抢在
            //    Attack/Counter cue 之前把两段数字一起播了（用户报的「应该先后显示」就是这么坏的）。
            const list = takeStaleNumbers(3500);
            if (list.length > 0) sink(list);
        } catch (e) { /* 忽略 */ }
    }, 800) as unknown as number;
}

/** ★ 停掉看门狗（一般不用调）。 */
export function stopNumberWatchdog(): void {
    if (_watchdog !== null) { clearInterval(_watchdog); _watchdog = null; }
}


/** ★ 注册消费者（DamageNumberFx 在 onLoad 里注册自己）。 */
export function setNumberSink(fn: ((list: PendingNumber[]) => void) | null): void {
    _sink = fn;
}

/**
 * ★ **统一投递口**：取走指定阶段（缺省 = 默认阶段 ''；传 '*' = 全部）的飘字并交给消费者播。
 *   所有演出节点（攻击命中 / 反击命中 / 超进化连锁 / 刷新数字 / 收尾）都调它 ⇒ 只有一条投递路径。
 * @returns 实际投递条数
 */
export function flushNumbers(phase?: string): number {
    try {
        const list = phase === '*' ? takeNumbers() : takeNumbers(phase === undefined ? '' : phase);
        if (list.length === 0) return 0;
        const sink = _sink;
        if (!sink) { for (const it of list) _pending.push(it); return 0; }   // 消费者没注册 → 放回，等看门狗
        sink(list);
        return list.length;
    } catch (e) { return 0; }
}

/** ★ 取走全部待播飘字（演出队列在 RefreshNumbers 时点调用）。 */
export function takeNumbers(phase?: string): PendingNumber[] {
    if (_pending.length === 0) return [];
    if (phase === undefined) { const all = _pending.slice(); _pending.length = 0; return all; }
    const out: PendingNumber[] = [];
    for (let i = _pending.length - 1; i >= 0; i--) {
        if (_pending[i].phase === phase) { out.unshift(_pending[i]); _pending.splice(i, 1); }
    }
    return out;
}

/** ★ 取走「登记超过 ms 毫秒」的所有阶段（看门狗兜底用）。 */
export function takeStaleNumbers(ms: number): PendingNumber[] {
    const now = Date.now();
    const out: PendingNumber[] = [];
    for (let i = _pending.length - 1; i >= 0; i--) {
        if (now - _pending[i].ts >= ms) { out.unshift(_pending[i]); _pending.splice(i, 1); }
    }
    return out;
}

/** 调试用：待播条数。 */
/** ★ 当前飘字阶段（`setNumberPhase` 设置）—— 供「被挡下的 0 伤害」按同阶段即时投递。 */
export function currentNumberPhase(): string {
    return _phase === undefined ? '' : String(_phase);
}

export function pendingNumberCount(): number {
    return _pending.length;
}
