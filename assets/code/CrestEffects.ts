import { Component, Node, Vec3 } from 'cc';
import { BattleFieldLayout, BattleSide } from './BattleFieldLayout';
import { destroyFieldCard, findComponent, runCardAbilityEffect } from './CardAbilitySystem';
import { cardIdFromNodeName } from './CardGlow';
import { getCardInfo } from './CardData';
import { BattleCueType } from './BattleCommand';
import { HeroArea, HeroSide } from './HeroArea';

/**
 * CrestEffects —— 纹章的「**效果映射表 + 效果实现**」
 * ===========================================================================
 * 一个纹章 = 一枚卡牌 id（卡 `4.png` → 纹章 `4.png`），它除了显示之外还有**功能**。
 * 本文件是纹章功能的**唯一登记处**：新增纹章只在 `CREST_EFFECT_MAP` 里加一条，
 * 不需要改 `CrestSystem` / `TurnManager`。
 *
 * ── 一条纹章效果由四部分组成 ──────────────────────────────────────────────
 *   · id      纹章 id（写卡牌 id 即可，`'4.png'` / `'4'` 都行；查表统一按**去扩展名 + 小写**匹配）
 *   · name    中文名（如「缜密之思」）—— 显示 / 日志用
 *   · timing  触发时机（`turnEnd` 己方回合结束时 / `turnStart` 己方回合开始时 /
 *             `onGain` 获得时 / `onOppFollowerDestroyed` 己方回合内对方随从被破坏时【触发型】）
 *   · canActivate  纯查询「此刻结算能否发动」—— 🔴 它就是**圆环波纹**的开关（见 `CrestRipple`）
 *   · run     真正结算效果
 * 一枚纹章可以登记**多条**效果（`CrestEffectDef | CrestEffectDef[]`），
 * 各条按自己的 timing 触发；`runCrestTiming` 只结算时机匹配的那条。
 *
 * ── 触发链路 ─────────────────────────────────────────────────────────────
 *   `TurnManager`（回合结束时）→ `CrestSystem.runTiming('turnEnd', side)`
 *     → 遍历该方纹章列表 → `runCrestTiming()` → 命中时机的 `run(ctx)`
 *   `TurnManager`（回合开始时）→ `CrestSystem.runTiming('turnStart', side)`（同时清空触发型登记）
 *   `BattleCommandSystem`（对方随从破坏演出开播时）→ `CrestSystem.notifyOppFollowerDestroyed`
 *     → `runTiming('onOppFollowerDestroyed', side)` → 命中时机的 `run(ctx)`
 *   `CrestSystem.update()`（节流轮询）→ `canCrestActivate()` → 亮 / 灭波纹
 *
 * 🔴 效果里**不要**自己写破坏 / 抽卡等逻辑：一律走公共入口
 *    （破坏随从 = `destroyFieldCard`，抽卡 = CardDeckManager…），保证与能力、
 *    指令演出队列是同一条链路（动画 / 场地重排 / 墓场记账都一致）。
 * ===========================================================================
 */

/** 纹章归属方（与 CrestSystem.CrestOwner 同字面量） */
export type CrestSide = 'player' | 'enemy';

/** 纹章效果的触发时机 */
export type CrestTiming =
    /** 己方操作回合**结束**时（点结束回合 / 敌方 AI 结束回合都会走到） */
    | 'turnEnd'
    /** 己方操作回合**开始**时 */
    | 'turnStart'
    /** 获得这枚纹章的那一瞬间 */
    | 'onGain'
    /**
     * 【触发型】己方操作回合**内**、**对方随从被破坏**的那一刻。
     * 🔴 与上面的「回合时点」不同：它不在固定的回合开始 / 结束时结算，而是由
     * `BattleCommandSystem` 在「对方随从被破坏」的破坏演出开播时 → 通知
     * `CrestSystem.notifyOppFollowerDestroyed` → 走到这里。
     * 「每回合触发一次」的登记由 `CrestSystem` 管理（己方回合开始 `turnStart` 时清空）。
     */
    | 'onOppFollowerDestroyed';

/** 效果结算上下文 */
export interface CrestEffectCtx {
    /** 调用方组件（用于按类名找依赖） */
    host: Component;
    /** 纹章归属方（= 效果受益方） */
    side: CrestSide;
    /** 纹章 id（原样，如 '4.png'） */
    crestId: string;
    /** 当前操作回合归属（未开战 = null） */
    turnSide: CrestSide | null;
    /** 本条纹章的效果定义 */
    effect: CrestEffectDef;
}

/** 一条纹章效果的完整定义 */
export interface CrestEffectDef {
    /**
     * ★ **吟唱 N**（需求：纹章也有吟唱，跟护符逻辑一样 —— 倒数结束**破坏掉自身**）。
     * 计数在**自己回合结束**时递减（与护符吟唱同口径）；归零时先跑下面的 `lastWords`，再把纹章移除。
     * 不写 = 没有吟唱。
     */
    chantTurns?: number;
    /**
     * ★ **谢幕曲**（纹章被「破坏」（吟唱结束移除）时发动）：一串与卡牌同款的内嵌能力。
     * 例：`[{ name: 'AddToHand', params: { id: '15.png' } }]`
     */
    lastWords?: Array<{ name: string; params?: unknown }>;
    /** 纹章 id（推荐写带扩展名的卡牌 id，如 '4.png'） */
    id: string;
    /** 中文名（需求里的「缜密之思」这一栏） */
    name: string;
    /** 触发时机 */
    timing: CrestTiming;
    /** 一句话描述（日志 / 后续做 tooltip 用） */
    desc: string;
    /**
     * **同回合内的附加条件**（纯查询，**绝不产生副作用**）。
     *
     * 🔴 「能否发动」的**主判据是时机**（见 `canCrestActivate`）：`turnEnd` / `turnStart` 类的效果
     *    只在**自己这一方的小回合里**提示可发动（我方回合亮、敌方回合灭），
     *    这条由 `timing` + 当前回合自动判定，**不需要**在这里再写一遍。
     * 这个方法只用于「同样的时机下还要再加一道门槛」的场合，例如：
     *    · 「己方回合结束时，若己方场上有龙族随从则……」（条件不足时就不该提示可发动）；
     *    · 留空（不写）= 只要轮到自己回合就算已就绪（`4.png` 缜密之思 就是这种：
     *      它「没有可破坏的目标」只是这一次结算跳过，不改变「本回合已就绪」的事实）。
     */
    canActivate?: (ctx: CrestEffectCtx) => boolean;
    /** 结算效果 */
    run: (ctx: CrestEffectCtx) => void;
}

// ============================================================================
// 纹章效果映射表（key = **规范 id**：去扩展名 + 小写）
// 一枚纹章可以登记**多条**效果（`CrestEffectDef | CrestEffectDef[]`）——
// 例如卡 4 的纹章同时有「回合结束破坏」与「对方随从被破坏触发打主战者」两条。
// ============================================================================


/** ★ 纹章吟唱剩余回合数（side:id → 剩余）。归零即「破坏掉自身」。 */
const _crestChantLeft = new Map<string, number>();

/**
 * ★ **纹章吟唱结算**（需求：纹章也有吟唱，跟护符逻辑一样，倒数完就破坏自身）。
 * 在**自己回合结束**时对每一枚带 `chantTurns` 的纹章倒数 1 次；归零时：
 *   ① 跑它的**谢幕曲**（`lastWords`，与卡牌同款内嵌能力）；
 *   ② 把这枚纹章从该方纹章列表里**移除**（= 破坏自身）。
 * @returns 本回合被移除的纹章数
 */
export function tickCrestChants(
    system: { setCrests?: (side: string, ids: string[]) => void;
              setChantBadge?: (side: string, crestId: string, n: number) => void } | null,
    side: string,
    currentIds: string[],
    host: unknown,
): number {
    if (!system || typeof system.setCrests !== 'function') return 0;
    let removed = 0;
    const keep: string[] = [];
    for (const raw of currentIds || []) {
        const defs = crestEffectsOf(raw);
        let chant = 0;
        for (const d of defs) chant = Math.max(chant, Math.max(0, Math.floor(Number(d.chantTurns) || 0)));
        if (chant <= 0) { keep.push(raw); continue; }
        const key = side + ':' + canonCrestId(raw);
        const left = _crestChantLeft.has(key) ? (_crestChantLeft.get(key) as number) : chant;
        const next = left - 1;
        if (next > 0) {
            _crestChantLeft.set(key, next);
            console.log('[CrestSystem] 纹章吟唱：' + (crestNameOf(raw) || raw) + ' 剩余 ' + next + ' 回合');
            try { (system as { setChantBadge?: (s: string, id: string, n: number) => void }).setChantBadge?.(side, raw, next); }
            catch (e) { /* 角标失败不影响逻辑 */ }
            keep.push(raw);
            continue;
        }
        _crestChantLeft.delete(key);
        for (const d of defs) {
            for (const eff of d.lastWords || []) {
                try { runCardAbilityEffect(host as never, raw, side as never, eff as never, null); }
                catch (e) { console.error('[CrestSystem] 纹章谢幕曲结算失败：', e); }
            }
        }
        removed++;
        try { (system as { setChantBadge?: (s: string, id: string, n: number) => void }).setChantBadge?.(side, raw, 0); }
        catch (e) { /* 角标失败不影响逻辑 */ }
        console.log('[CrestSystem] 纹章吟唱结束 → ' + (crestNameOf(raw) || raw) + ' 破坏自身（谢幕曲已发动）');
    }
    if (removed > 0) system.setCrests(side, keep);
    return removed;
}

export const CREST_EFFECT_MAP: Record<string, CrestEffectDef | CrestEffectDef[]> = {
    // ── 卡 15「恶兆成谶·维克托」的纹章「缜密之思」──────────────────────────
    // 吟唱_2：自己回合结束各倒数 1 次；归零 → 谢幕曲（将 1 张『恶兆成谶·维克托』加入手牌）→ 移除自身
    // 🔴 key 必须是 canonCrestId 之后的形态（去扩展名）：'15'（不是 '15.png'，否则查不到）
    '15': {
        id: '15.png',
        name: '缜密之思',
        timing: 'turnEnd',
        desc: '吟唱_2。谢幕曲：将 1 张『恶兆成谶·维克托』加入手牌。',
        chantTurns: 2,
        lastWords: [{ name: 'AddToHand', params: { id: '15.png' } }],
        run: () => { /* 吟唱类纹章没有「每回合触发」的效果，结算全在 chantTurns 归零那一刻 */ },
    },

    /** 卡 4「奔走的狙击手·夏安」的纹章（两条效果） */
    '4': [
        {
            id: '4.png',
            name: '缜密之思',
            timing: 'turnEnd',
            desc: '己方回合结束时，随机破坏敌方一个随从。',
            // 🔴 这里**不写** canActivate：本纹章的「能否发动」只看时机（己方回合结束），
            //    所以只要轮到**我方的小回合**就算已就绪、圆框就开始循环外扩提示。
            //    「对方场上没有随从」只是**这一次结算没有目标可破坏**（run 里判并打日志），
            //    不代表这枚纹章「没就绪」—— 不该因此把提示也灭掉。
            run: (ctx) => {
                const list = opponentFollowers(ctx);
                if (list.length === 0) {
                    console.log(`[CrestEffects] 「${ctx.effect.name}」发动但对方场上没有随从 → 本次跳过`);
                    return;
                }
                const pick = list[Math.floor(Math.random() * list.length)];
                console.log(`[CrestEffects] ${ctx.side} 的纹章「${ctx.effect.name}」发动：`
                    + `随机破坏对方随从 ${pick.name}（候选 ${list.length} 只）`);
                // ★ 攻击特效（**纯演出**）：从这枚纹章图标的中心发射一颗子弹飞到目标卡牌中心，
                //   飞完之后才轮到目标卡牌的破坏动画 —— 两者是演出队列里先后两段 cue，严格同序。
                //   🔴 下一行的破坏**结算**是同步发生的（判定 / 摘场 / 记墓场），**不等**子弹飞完：
                //      「数据顷刻算完、演出按顺序串行」（铁律 71）。
                pushCrestBulletCue(ctx, pick);
                destroyFieldCard(ctx.host, pick);
            },
        },
        {
            id: '4.png',
            name: '缜密之思',
            timing: 'onOppFollowerDestroyed',
            desc: '我方回合时触发一次，当对方随从被破坏时对对方主战者造成2点伤害。',
            // 🔴 触发型效果：**不在固定回合时点结算**。触发链 =
            //   `BattleCommandSystem` 在「对方随从被破坏」的破坏演出开播时
            //   → `CrestSystem.notifyOppFollowerDestroyed`（守「己方回合 / 对方随从」）
            //   → `runCrestTiming('onOppFollowerDestroyed', side)` → 本 run。
            //   「每回合触发一次」由 `CrestSystem` 的登记（hasTriggerFiredOnce /
            //   markTriggerFiredOnce）管理，己方回合开始（turnStart）时自动清空。
            //   🔴 破坏走 `destroyFieldCard` —— 这里的触发**不**再调用破坏，
            //      只负责「对方主战者吃 2 点伤害」这一半。
            run: (ctx) => {
                const cs = ctx.host as unknown as {
                    hasTriggerFiredOnce?: (side: CrestSide, crestId: string) => boolean;
                    markTriggerFiredOnce?: (side: CrestSide, crestId: string) => void;
                };
                // 「每回合触发一次」登记（己方回合开始时被 CrestSystem 清空）
                if (cs && typeof cs.hasTriggerFiredOnce === 'function'
                    && cs.hasTriggerFiredOnce(ctx.side, ctx.crestId)) {
                    console.log(`[CrestEffects] 「${ctx.effect.name}」本回合已触发过一次 → 本次跳过`);
                    return;
                }
                // 先占住本次触发：无论后续结算是否顺利，本回合都不再重复触发
                if (cs && typeof cs.markTriggerFiredOnce === 'function') {
                    cs.markTriggerFiredOnce(ctx.side, ctx.crestId);
                }
                const hero = opponentHeroOf(ctx);
                if (!hero || !hero.isValid) {
                    console.log(`[CrestEffects] 「${ctx.effect.name}」触发但找不到对方主战者 → 本次跳过`);
                    return;
                }
                const dmg = 2;
                // 逻辑立刻扣血（显示冻结，等演出在子弹落点推进 —— 与超进化破坏同一口径）
                const prev = hero.hp;
                const hpAfter = hero.takeDamage(dmg, true);
                console.log(`[CrestEffects] ${ctx.side} 的纹章「${ctx.effect.name}」触发：`
                    + `对方随从被破坏 → 对对方主战者造成 ${dmg} 点伤害（${prev} → ${hpAfter}）`);
                // 演出：纹章图标中心 → 对方主战者中心的子弹，随后主战者血量数字推进到结算值。
                const pushed = pushCrestHeroDamageCue(ctx, hero, hpAfter);
                if (!pushed) hero.flushDisplay();     // 没有演出队列 → 立刻解除显示冻结
            },
        },
    ],

};

// ============================================================================
// 查询 API
// ============================================================================

/** 规范 id：去扩展名 + 转小写（`'4.png'` / `'4'` / `'4.PNG'` 视为同一枚） */
export function canonCrestId(id: string): string {
    const s = typeof id === 'string' ? id.trim() : '';
    if (!s) return '';
    return s.replace(/\.[a-z0-9]+$/i, '').toLowerCase();
}

/** 取某枚纹章的**全部**效果定义（未登记 → 空数组）。一枚纹章可以登记多条效果。 */
export function crestEffectsOf(id: string): CrestEffectDef[] {
    const key = canonCrestId(id);
    if (!key) return [];
    const e = CREST_EFFECT_MAP[key];
    if (!e) return [];
    return Array.isArray(e) ? e : [e];
}

/** 某枚纹章是否有功能（纯显示型纹章返回 false） */
export function hasCrestEffect(id: string): boolean {
    return crestEffectsOf(id).length > 0;
}

/** 某枚纹章的中文名（未登记 → 返回原 id，方便日志排查） */
export function crestNameOf(id: string): string {
    const all = crestEffectsOf(id);
    return all.length > 0 ? all[0].name : String(id || '');
}

/** 登记库里所有纹章（调试 / 列表用） */
export function allCrestEffects(): CrestEffectDef[] {
    const out: CrestEffectDef[] = [];
    for (const k of Object.keys(CREST_EFFECT_MAP)) {
        const e = CREST_EFFECT_MAP[k];
        if (Array.isArray(e)) out.push(...e);
        else if (e) out.push(e);
    }
    return out;
}

/**
 * 这枚纹章**此刻能不能发动**（驱动圆环波纹的那个判据）。
 *
 * 🔴 **主判据 = 时机落在当前这个小回合里**：
 *   · `turnEnd` / `turnStart` 类效果 —— 只在**自己这一方的小回合**亮（我方回合亮、敌方回合灭），
 *     这正是「回合结束时发动」的纹章该有的提示时机（本回合结束时它一定会结算）；
 *   · `onGain` 类效果 —— 获得瞬间就结算完了，没有「等待发动」的窗口 → 永远不亮；
 *   · 未登记功能的纯显示纹章 —— 不亮。
 * 附加条件（可选）：效果自定义的 `canActivate`（同回合内的额外门槛），留空 = 就绪即亮。
 */
export function canCrestActivate(
    host: Component,
    side: CrestSide,
    crestId: string,
    turnSide: CrestSide | null,
): boolean {
    const defs = crestEffectsOf(crestId);
    if (defs.length === 0) return false;
    const latch = host as unknown as {
        hasTriggerFiredOnce?: (s: CrestSide, crestId: string) => boolean;
    };
    // 一枚纹章登记了多条效果时，**任意一条**就绪即可发动（如卡 4：回合结束破坏
    // 与「对方随从被破坏触发打主战者」共用同一枚，时机各有各的判据）。
    for (const def of defs) {
        // ① 主判据：时机必须落在「我现在这个操作回合」里
        if (def.timing === 'onGain') continue;
        if (turnSide !== side) continue;
        // ② 触发型时机：本回合已触发过一次 → 提前消耗掉，不再提示可发动
        if (def.timing === 'onOppFollowerDestroyed') {
            if (latch && typeof latch.hasTriggerFiredOnce === 'function'
                && latch.hasTriggerFiredOnce(side, crestId)) {
                continue;
            }
        }
        // ③ 同回合内的附加条件（可选）
        if (typeof def.canActivate !== 'function') return true;
        try {
            if (def.canActivate({ host, side, crestId, turnSide, effect: def }) === true) return true;
        } catch (e) {
            console.error(`[CrestEffects] ${def.name} 的 canActivate 抛错：`, e);
        }
    }
    return false;
}

/**
 * 结算某一方在某时机下的**全部**纹章效果（由 CrestSystem 在时机点上调用）。
 * @param crestIds 该方当前持有的纹章 id 列表（顺序无关）
 * @returns 实际发动了几次
 */
export function runCrestTiming(
    host: Component,
    timing: CrestTiming,
    side: CrestSide,
    crestIds: string[],
    turnSide: CrestSide | null = side,
): number {
    let fired = 0;
    for (const id of crestIds || []) {
        // 一枚纹章可以登记多条效果（如卡 4 同时有 turnEnd 与 onOppFollowerDestroyed），
        // 只结算「时机匹配」的那条。
        for (const def of crestEffectsOf(id)) {
            if (def.timing !== timing) continue;
            const ctx: CrestEffectCtx = { host, side, crestId: id, turnSide, effect: def };
            try {
                def.run(ctx);
                fired++;
            } catch (e) {
                // 铁律5：tween / 回调里的异常会被吞 → 自己兜一层，至少留下日志
                console.error(`[CrestEffects] 纹章「${def.name}」在 ${timing} 结算失败：`, e);
            }
        }
    }
    return fired;
}

// ============================================================================
// 内部工具
// ============================================================================

function opponentOfSide(side: CrestSide): CrestSide {
    return side === 'player' ? 'enemy' : 'player';
}

/** 全场景按 side 找战场（与其他模块同款 BFS；不依赖任何 Inspector 引用） */
function fieldBySide(host: Component, side: CrestSide): BattleFieldLayout | null {
    const scene = host && host.node ? host.node.scene as unknown as Node | null : null;
    if (!scene) return null;
    const want = side === 'player' ? BattleSide.Player : BattleSide.Enemy;
    const stack: Node[] = [...scene.children];
    while (stack.length > 0) {
        const cur = stack.shift() as Node;
        const f = cur.getComponent(BattleFieldLayout);
        if (f && f.isValid && f.side === want) return f;
        for (const ch of cur.children) stack.push(ch);
    }
    return null;
}

/** 某方战场上的**随从**（按数组顺序 = 从左到右） */
export function followersOnField(host: Component, side: CrestSide): Node[] {
    const field = fieldBySide(host, side);
    if (!field) return [];
    const out: Node[] = [];
    for (const card of field.cards) {
        if (!card || !card.isValid) continue;
        const id = cardIdFromNodeName(card.name);
        const info = id ? getCardInfo(id) : undefined;
        if (!info || info.cardType !== 'Follower') continue;
        out.push(card);
    }
    return out;
}

/** 纹章归属方的**对方**场上的随从（「随机破坏敌方一个随从」的候选池） */
function opponentFollowers(ctx: CrestEffectCtx): Node[] {
    return followersOnField(ctx.host, opponentOfSide(ctx.side));
}

/**
 * 把「**纹章子弹**」这段演出压进演出队列（顺序 = 调用顺序 ⇒ 它会排在紧随其后的破坏动画**之前**）。
 *
 * 起点 = 这枚纹章**图标的中心**（由 `CrestSystem.slotWorldCenter` 给出，取不到就不播这段）；
 * 终点 = 目标卡牌中心，在 cue 播放时才读（那时卡牌节点还在原地等着播破坏动画）。
 * 🔴 全程 fail-open：缺队列 / 缺起点 / 抛异常都只是**没有这段特效**，
 *    绝不改变结算、也绝不把演出队列卡住。
 */
function pushCrestBulletCue(ctx: CrestEffectCtx, card: Node): void {
    try {
        if (!card || !card.isValid) return;
        // 按结构取（`ctx.host` 就是 CrestSystem），避免 CrestSystem ↔ CrestEffects 循环 import
        const sys = ctx.host as unknown as {
            slotWorldCenter?: (side: CrestSide, crestId: string) => Vec3 | null;
        };
        if (!sys || typeof sys.slotWorldCenter !== 'function') return;
        const from = sys.slotWorldCenter(ctx.side, ctx.crestId);
        if (!from) return;                       // 纹章还没落位（找不到图标）→ 不播这段
        const cmds = findComponent(ctx.host, 'BattleCommandSystem') as {
            pushCue?: (cue: { type: string; [key: string]: unknown }) => void;
        } | null;
        if (!cmds || typeof cmds.pushCue !== 'function') return;
        cmds.pushCue({
            type: BattleCueType.CrestBullet,
            card,
            fromWorld: from,
            crestId: ctx.crestId,
            side: ctx.side,
        });
    } catch (e) {
        console.error('[CrestEffects] 排入「纹章子弹」演出失败（不影响结算）：', e);
    }
}

/** 纹章归属方的**对方主战者**（HeroArea；找不到返回 null。全场景 BFS，不依赖节点名） */
function opponentHeroOf(ctx: CrestEffectCtx): HeroArea | null {
    const scene = ctx.host && ctx.host.node ? ctx.host.node.scene as unknown as Node | null : null;
    if (!scene) return null;
    const want = ctx.side === 'player' ? HeroSide.Enemy : HeroSide.Player;
    const stack: Node[] = [...scene.children];
    while (stack.length > 0) {
        const cur = stack.shift() as Node;
        const h = cur.getComponent(HeroArea);
        if (h && h.isValid && h.side === want) return h;
        for (const ch of cur.children) stack.push(ch);
    }
    return null;
}

/**
 * 排入「纹章 → 对方主战者」演出（顺序 = 调用顺序）：
 *   ① `CrestBullet` —— 从这枚纹章**图标中心**发射一颗子弹，飞到对方主战者节点中心；
 *   ② `RefreshNumbers` —— 主战者血量数字推进到**本次结算后的快照值**（子弹播完才变）。
 *
 * 🔴 结算（`hero.takeDamage`）已在本函数之前同步完成，这里只负责展示；
 *    全程 fail-open：缺演出队列 / 缺起点都只是**没有这段特效**，绝不影响伤害本身。
 * @returns 是否成功排入（false = 无演出队列 → 调用方应立即解除显示冻结）
 */
function pushCrestHeroDamageCue(ctx: CrestEffectCtx, hero: HeroArea, hpAfter: number): boolean {
    try {
        if (!hero || !hero.isValid) return false;
        const cmds = findComponent(ctx.host, 'BattleCommandSystem') as {
            pushCue?: (cue: { type: string; [key: string]: unknown }) => void;
        } | null;
        if (!cmds || typeof cmds.pushCue !== 'function') return false;
        // ① 子弹：复用 CrestBullet cue —— `playCrestBulletCue` 只把 `card` 当目标节点用，
        //    这里传主战者节点，子弹终点就是主战者中心的当前位置。
        const sys = ctx.host as unknown as {
            slotWorldCenter?: (side: CrestSide, crestId: string) => Vec3 | null;
        };
        if (sys && typeof sys.slotWorldCenter === 'function') {
            const from = sys.slotWorldCenter(ctx.side, ctx.crestId);
            if (from) {
                cmds.pushCue({
                    type: BattleCueType.CrestBullet,
                    card: hero.node,
                    fromWorld: from,
                    crestId: ctx.crestId,
                    side: ctx.side,
                });
            }
        }
        // ② 主战者血量显示推进到结算快照（子弹到达之后；数字刷新属于演出）。
        cmds.pushCue({
            type: BattleCueType.RefreshNumbers,
            batch: { cards: new Map(), heroes: new Map([[hero, hpAfter]]) },
        });
        return true;
    } catch (e) {
        console.error('[CrestEffects] 排入「纹章→主战者伤害」演出失败（不影响结算）：', e);
        return false;
    }
}
