import { _decorator, Component, Label, Node } from 'cc';
import { BattleFieldLayout, BattleSide } from './BattleFieldLayout';
import { breakBarrierFx } from './BarrierFx';
import { currentNumberPhase, flushNumbers, recordNumber, setNumberPhase, setNumberSuppressed } from './DamageNumberQueue';

/**
 * ★ **被挡下的 0 伤害**（超进化守护 / 屏障）要**当场跟着同批伤害一起飘**，不能等看门狗。
 * 它们由「回合结束」「能力直伤」这类**没有演出 cue** 的路径登记 ⇒ 没人来 flush，
 * 只能等 `DamageNumberQueue` 的 3.5s 看门狗 ⇒ 玩家看到「0 很延后才出现」（用户报的 bug）。
 * 这里在登记后 ~260ms 按**同一阶段**投递一次：与同批的其它伤害数字同时出现。
 */
function scheduleZeroFlush(): void {
    try {
        const phase = currentNumberPhase();
        setTimeout(() => { try { flushNumbers(phase); } catch (e) { /* 忽略 */ } }, 260);
    } catch (e) { /* 忽略 */ }
}
import { killNode } from './CardComposer';
import { cardIdFromNodeName } from './CardGlow';
import {getCardInfo, maxAttacksOf } from './CardData';
import type { CardInfo } from './CardData';
import { HeroArea, HeroSide } from './HeroArea';
import { addToGrave } from './CardDeckManager';
import { BattleCueType } from './BattleCommand';
import { runCardBattleAbilities, runCardLastWords, runCardStatUpAbilities } from './CardAbilitySystem';
import {
    applyBattleValueOutline, battleHpColor, battleHpIsDamaged, battleValueColor,
    formatBattleAttack, formatBattleValue,
} from './BattleValueStyle';

const { ccclass, property, menu } = _decorator;

/** 一次随从对撞的结算结果，供调用方与测试脚本查询。 */
export interface BattleDamageResult {
    attacker: Node;
    defender: Node;
    /** 攻击者攻击力（结算前）。 */
    attackerDamage: number;
    /** 目标攻击力（结算前）。 */
    defenderDamage: number;
    /** 攻击者结算后的血量。 */
    attackerHpAfter: number;
    /** 目标结算后的血量。 */
    defenderHpAfter: number;
    attackerDestroyed: boolean;
    defenderDestroyed: boolean;
    /** 【交战时】能力已让任意一方在伤害交换前离场，本次不造成战斗伤害。 */
    contactCancelled?: boolean;
    /**
     * 【超进化破坏】本次是否为「超进化随从攻击**破坏**了对方随从」。
     * true 时下面两项有效：对方主战者已被连锁扣血（纯逻辑），显示延迟到特效结尾推进。
     */
    superEvolveBreak?: boolean;
    /** 【超进化破坏】被连锁扣血的对方主战者。 */
    superBreakHero?: HeroArea | null;
    /** 【超进化破坏】对方主战者扣血后的**逻辑**血量（显示快照）。 */
    superBreakHeroHpAfter?: number;
}

/**
 * 一次指令结算产生的**数字显示快照**。
 * 🔴 存的是「本条指令结算后的值」，**不是**后续指令累加后的最终逻辑值 ——
 *    这样多条指令连续攻击同一目标时，血量会随每段攻击动画逐段变化。
 */
export interface BattleDisplayBatch {
    cards: Map<Node, { hp?: number; attack?: number }>;
    heroes: Map<HeroArea, number>;
}

/** 一次随从攻击主战者的结算结果。攻击主战者不会触发反击。 */
export interface BattleHeroDamageResult {
    attacker: Node;
    heroNode: Node;
    damage: number;
    heroHpAfter: number;
}

/**
 * BattleRuleSystem —— 基础对战规则入口。
 *
 * 当前实现：
 *   · 我方随从攻击敌方随从；
 *   · 随从对撞时双方同时按各自攻击力对对方造成伤害；
 *   · 我方随从攻击敌方主战者时只扣主战者血量，不触发反击；
 *   · 血量 <= 0 的随从从战场移除。
 *
 * 血量状态按战场卡牌节点保存在 WeakMap 中，因此同一张卡连续受击会累计；
 * 战场节点被重建时状态随旧节点一起失效，重新回到 CardData 的初始数值。
 */
@ccclass('BattleRuleSystem')
@menu('gf2szb/BattleRuleSystem')
export class BattleRuleSystem extends Component {

    @property({ tooltip: '总开关：关闭后 BattleFieldPressGlow 松手不会结算伤害。' })
    combatEnabled = true;

    @property({
        tooltip: '【超进化破坏】超进化随从攻击破坏对方随从时，对对方主战者造成的额外伤害。\n'
            + '🔴 纯逻辑：主战者**逻辑血量**当场扣、显示冻结；显示由超进化破坏特效在'
            + '「主战者处光团迸发」那一刻才推进到该值。',
    })
    superEvolveBreakHeroDamage = 1;

    @property({
        type: BattleFieldLayout,
        tooltip: '我方战场（side = Player）。留空 = 按卡牌父链自动解析。',
    })
    playerField: BattleFieldLayout | null = null;

    @property({
        type: BattleFieldLayout,
        tooltip: '敌方战场（side = Enemy）。留空 = 按卡牌父链自动解析。',
    })
    enemyField: BattleFieldLayout | null = null;

    /** 每张战场卡牌节点的当前血量。 */
    private readonly _hp = new WeakMap<Node, number>();
    /**
     * 每张战场卡牌节点的**战场动态血量上限**（默认 = CardData 基础血量上限）。
     * 🔴 血量数字配色只看它，不看「是否小于基础血量上限」（需求）。
     */
    private readonly _maxHp = new WeakMap<Node, number>();
    /** 每张战场卡牌节点的当前攻击力。 */
    private readonly _attack = new WeakMap<Node, number>();
    /** 本回合已经攻击过的随从。 */
    private _attacked = new WeakSet<Node>();
    /** ★ 本回合每张卡**已攻击次数**（支持 MultiAttack 多次攻击）。 */
    private _attackCount = new WeakMap<Node, number>();
    /**
     * **已经进化过**的随从（普通进化 / 超进化都算）。
     * 🔴 一场对局内**永久**有效、不随回合清空 —— 「进化后的随从不能再次进化」。
     *    用 WeakSet，节点销毁后自动回收。
     */
    private readonly _evolved = new WeakSet<Node>();
    /**
     * **超进化**过的随从（普通进化的强化版）。
     * 己方回合内受到的伤害全部转为 0、且不可被破坏（`isSuperGuarded`）；对方回合无此能力。
     */
    private readonly _superEvolved = new WeakSet<Node>();
    /** 当前回合标识：变化时清空 _attacked。 */
    private _turnKey = '';
    /** TurnManager 引用缓存。 */
    private _tmCache: any = null;
    /** CardKeywordSystem 引用缓存。 */
    /** ★ 协作：本次对战中**进入战场的自己的随从张数**（整场累计，不随回合清空）。 */
    private _cooperation: { player: number; enemy: number } = { player: 0, enemy: 0 };

    /**
     * ★ **造成伤害的唯一入口**（屏障就在这里生效）：
     *   · 目标带【屏障】⇒ 本次伤害变 0、屏障失效、播屏障破碎演出，返回 0；
     *   · 否则照常 setHp(hp - amount)，返回实际扣掉的血量。
     * 🔴 所有伤害路径（随机伤害 / 分配伤害 / 对选中目标伤害）都必须走这里，否则屏障会被绕过。
     */
    public applyDamage(target: Node | null, amount: number): number {
        if (!target || !target.isValid) return 0;
        const dmg = Math.max(0, Math.floor(Number(amount) || 0));
        if (dmg <= 0) return 0;
        const before = this.getHp(target);
        // ★ 能力造成的伤害：飘字打 'ability' 阶段 ⇒ 由毒弹/导弹/横扫 cue 播完（命中那一刻）投递
        try { setNumberPhase('ability'); } catch (e) { /* 忽略 */ }
        this.setHp(target, before - dmg);            // 屏障在 setHp 里统一拦
        try { setNumberPhase(''); } catch (e) { /* 忽略 */ }
        return Math.max(0, before - this.getHp(target));
    }

    /**
     * ★ 【屏障】判定与消耗：目标带屏障 ⇒ 移除词条 + 播破碎演出，返回 true（调用方把伤害当 0）。
     */
    private tryConsumeBarrier(target: Node, dmg: number): boolean {
        try {
            const kw = this.keywordSystemOf();
            if (kw && typeof kw.hasKeyword === 'function' && kw.hasKeyword(target, 'Barrier')) {
                if (typeof kw.removeKeyword === 'function') kw.removeKeyword(target, 'Barrier');
                console.log(`[BattleRuleSystem] ${target.name} 的【屏障】发动：本次 ${dmg} 点伤害变为 0`);
                // ★ 需求：**等攻击特效播完再取消屏障特效** ⇒ 这里只登记，不立刻播破碎。
                //   战斗路径由 BattleCommandSystem.execAttack 在 RefreshNumbers 之后补一条 BarrierBreak cue；
                //   能力 / 法术等非战斗路径由下面的兜底定时器补播。
                this._pendingBarrierBreaks.push(target);
                setTimeout(() => {
                    try {
                        const i = this._pendingBarrierBreaks.indexOf(target);
                        if (i >= 0) {
                            this._pendingBarrierBreaks.splice(i, 1);
                            breakBarrierFx(target);
                        }
                    } catch (e) { /* 忽略 */ }
                }, Math.max(200, this.barrierBreakDelay));
                return true;
            }
        } catch (e) { console.error('[BattleRuleSystem] 屏障判定失败：', e); }
        return false;
    }

    /** 找场上的 CardKeywordSystem（词条状态的唯一真源）。 */
    private keywordSystemOf(): { hasKeyword?: (n: Node, k: string) => boolean; removeKeyword?: (n: Node, k: string) => boolean } | null {
        try {
            const scene = this.node.scene as unknown as Node | null;
            if (!scene) return null;
            const stack: Node[] = [...scene.children];
            while (stack.length > 0) {
                const cur = stack.shift() as Node;
                const c = cur.getComponent('CardKeywordSystem') as
                    { hasKeyword?: (n: Node, k: string) => boolean; removeKeyword?: (n: Node, k: string) => boolean } | null;
                if (c && typeof c.hasKeyword === 'function') return c;
                for (const ch of cur.children) stack.push(ch);
            }
        } catch (e) { /* 忽略 */ }
        return null;
    }

    /** ★ 屏障破碎**待播队列**（等攻击特效播完由演出队列取走）。 */
    private _pendingBarrierBreaks: Node[] = [];

    /** 兜底延迟（毫秒）：非战斗路径（能力 / 法术）没人来取时，自己等这么久再播破碎。 */
    public barrierBreakDelay = 700;

    /** ★ 取走待播的屏障破碎（由演出队列在攻击/反击动画之后调用）。 */
    public takePendingBarrierBreaks(): Node[] {
        const list = this._pendingBarrierBreaks.slice();
        this._pendingBarrierBreaks.length = 0;
        return list;
    }

    /** ★ 该随从是否带【毁灭】（读词条，与显示同一份真源）。 */
    private hasBane(card: Node | null): boolean {
        if (!card || !card.isValid) return false;
        try {
            const kw = this.keywordSystemOf();
            if (kw && typeof kw.hasKeyword === 'function') return kw.hasKeyword(card, 'Bane');
        } catch (e) { /* 忽略 */ }
        return false;
    }

    /** 该卡是否持有「不会被能力破坏」（与显示同一份词条真源）。 */
    public isAbilityDestroyImmune(card: Node | null): boolean {
        if (!card || !card.isValid) return false;
        try {
            const kw = this.keywordSystem();
            if (kw && typeof kw.hasAbilityDestroyImmune === 'function') {
                return kw.hasAbilityDestroyImmune(card) === true;
            }
            if (kw && typeof kw.hasKeyword === 'function') {
                return kw.hasKeyword(card, 'AbilityDestroyImmune') === true;
            }
        } catch (e) { /* 忽略 */ }
        return (this.infoOf(card)?.keywords || []).indexOf('AbilityDestroyImmune') >= 0;
    }

    /**
     * 「能力破坏」统一放行判据：
     *   · 血量 <= 0 = 数字伤害致死，永远允许正常破坏；
     *   · 血量 > 0 且处于己方回合的超进化守护 ⇒ 拒绝毁灭 / 能力 / 纹章等直接破坏；
     *   · 血量 > 0 且带 AbilityDestroyImmune ⇒ 同样拒绝直接破坏。
     */
    public canDestroyByAbility(card: Node | null): boolean {
        if (!card || !card.isValid) return false;
        const hp = this.getHp(card);
        if (typeof hp === 'number' && hp <= 0) return true;
        if (this.isSuperGuarded(card)) {
            console.log(`[BattleRuleSystem] ${card.name} 超进化守护：拒绝能力破坏（自己回合内，血量 ${hp}）`);
            return false;
        }
        if (this.isAbilityDestroyImmune(card)) {
            console.log(`[BattleRuleSystem] ${card.name}【不会被能力破坏】：拒绝直接破坏（血量 ${hp}）`);
            return false;
        }
        return true;
    }

    /** ★ 这张卡一回合还能攻击几次（默认 1 次；MultiAttack 可加到 3 次）。 */
    public attacksLeft(card: Node | null): number {
        if (!card || !card.isValid) return 0;
        // 🔴 必须**先** syncTurn：回合键变化时清空「已攻击次数」——
        //    漏了这句 ⇒ 随从攻击过一次后**整局**都算「已用完」（用户报的严重 bug）。
        this.syncTurn();
        const id = cardIdFromNodeName(card.name);
        const kw = this.keywordSystem();
        const runtime = kw && typeof kw.attacksPerTurn === 'function'
            ? Math.max(0, Math.floor(Number(kw.attacksPerTurn(card)) || 0)) : 0;
        const max = runtime > 0 ? runtime : maxAttacksOf(id);
        const used = this._attackCount.get(card) || 0;
        return Math.max(0, max - used);
    }

    /** ★ 协作计数 +1（随从进入战场时调用：打出 / 召唤 / 收编）。 */
    public markFollowerEntered(side: 'player' | 'enemy'): void {
        if (!this._cooperation) this._cooperation = { player: 0, enemy: 0 };
        this._cooperation[side] = (this._cooperation[side] || 0) + 1;
    }

    /** ★ **手动**给协作值加 n（卡 1「协作数 +1」）。 */
    public addCooperation(side: 'player' | 'enemy', n: number): void {
        if (!this._cooperation) this._cooperation = { player: 0, enemy: 0 };
        const d = Math.floor(Number(n) || 0);
        if (d === 0) return;
        this._cooperation[side] = Math.max(0, (this._cooperation[side] || 0) + d);
        console.log(`[BattleRuleSystem] ${side} 协作数 ${d > 0 ? '+' : ''}${d} → ${this._cooperation[side]}`);
    }

    /** ★ 当前协作值（该方本次对战中进入战场的随从张数）。 */
    public cooperationOf(side: 'player' | 'enemy'): number {
        return this._cooperation ? (this._cooperation[side] || 0) : 0;
    }

    private _keywordCache: any = null;
    /** BattleCommandSystem 引用缓存（消失要排 cue）。 */
    private _cmdsCache: { isValid?: boolean; pushCue?: (cue: unknown) => void } | null = null;
    /** 按阵营解析出的战场缓存（fieldBySide 用，避免每次全场景 BFS）。 */
    private _pSideField: BattleFieldLayout | null = null;
    private _eSideField: BattleFieldLayout | null = null;
    /** 双方主战者缓存（超进化破坏连锁扣血 / 敌方 AI 取用；失效自动重查）。 */
    private _pSideHeroCache: HeroArea | null = null;
    private _eSideHeroCache: HeroArea | null = null;
    /**
     * **破坏**接收器（可选）：随从血量 <= 0 时，规则系统**先把它的节点从战场逻辑集合摘除**
     * （不可选中 / 不亮光圈 / 不计守护），再回调这里。
     * 术语：【破坏 Destroy】= 此前一直说的「死亡」（有破坏动画）；与它并列的还有
     * 【消失 Disappear】（另一种离场方式，不播破坏动画）。
     * 接入 BattleCommandSystem 后由它把**破坏**演出压进演出队列 —— 于是「逻辑破坏」
     * 永远早于「破坏动画」，且规则系统不认识演出队列。null = 退回旧的「立即销毁」。
     */
    private _destroySink: ((card: Node, field: BattleFieldLayout) => void) | null = null;
    /**
     * 是否把**破坏**延迟到演出处理（只在指令系统结算的窗口内为 true）。
     * false（默认）= 旧语义：血量归零立即销毁节点（外部直接调 resolveCombat 时保持原样）。
     * true = 摘除战场逻辑（立即不可选）但保留节点，交给演出队列播完再销毁。
     */
    private _deferDestroy = false;
    /**
     * 数字显示（血量 / 攻击）是否**延迟到演出结束后**再刷新。
     * 🔴 数值属于逻辑、**显示属于演出**：指令进入队列时数值当场变，但卡面数字必须等
     *    「攻击动画播完」才改 —— 否则玩家会先看到掉血、再看到攻击，因果颠倒。
     */
    private _deferDisplay = false;
    /** 当前指令正在采集的「卡牌 → 结算后数字快照」。 */
    private _displayBatchCards: Map<Node, { hp?: number; attack?: number }> = new Map();
    /** 当前指令正在采集的「主战者 → 结算后血量快照」。 */
    private _displayBatchHeroes: Map<HeroArea, number> = new Map();

    /**
     * 设置 / 清除**破坏**接收器。传 null 恢复旧的「立即销毁节点」行为（兼容旧调用与测试）。
     * 由 BattleCommandSystem 在 onLoad / onEnable 绑定，onDisable 解绑。
     */
    public setDestroySink(sink: ((card: Node, field: BattleFieldLayout) => void) | null): void {
        this._destroySink = sink;
    }

    /** @deprecated 旧名（= 破坏）。请改用 setDestroySink。 */
    public setDeathSink(sink: ((card: Node, field: BattleFieldLayout) => void) | null): void {
        this.setDestroySink(sink);
    }

    /**
     * 【仅指令系统内部使用】打开「延迟数字显示」窗口：窗口内 setHp/setAttack/addStats
     * 等只改**逻辑值**，卡面数字（CardHp/CardAttack/主战者 HpText）一律冻结，
     * 等演出队列在「攻击动画播完」时调用 flushDeferredDisplay() 一次性刷新。
     */
    public beginDeferredDisplay(): void {
        this._deferDisplay = true;
        this._displayBatchCards = new Map();
        this._displayBatchHeroes = new Map();
    }

    /**
     * 结束采集并返回**本条指令的显示快照**（没有采集到内容返回 null）。
     * 快照里存的是本指令结算后的数字；调用方把它交给演出队列的 RefreshNumbers cue。
     */
    public endDeferredDisplay(): BattleDisplayBatch | null {
        this._deferDisplay = false;
        const batch: BattleDisplayBatch = { cards: this._displayBatchCards, heroes: this._displayBatchHeroes };
        this._displayBatchCards = new Map();
        this._displayBatchHeroes = new Map();
        if (batch.cards.size === 0 && batch.heroes.size === 0) return null;
        return batch;
    }

    /** 当前延迟窗口里是否采集到了需要延迟刷新的数字显示。 */
    public get hasDeferredDisplay(): boolean {
        return this._displayBatchCards.size > 0 || this._displayBatchHeroes.size > 0;
    }

    /**
     * 把某条指令的**显示快照**写回卡面 / 主战者数字。
     * 由演出队列在「攻击 / 反击动画播完」的那一刻调用（早于破坏演出，晚于伤害结算）。
     * 🔴 写的是快照值（本条指令结算后的值），**不是**当前逻辑值 —— 多条指令连续攻击同一目标时，
     *    每次动画结束只推进一段，直到最后一条才到达最终逻辑血量。
     */
    public applyDisplayBatch(batch: BattleDisplayBatch | null): void {
        if (!batch) return;
        const was = this._deferDisplay;
        this._deferDisplay = false;      // 写回时不走延迟分支
        try {
            for (const [card, snap] of batch.cards) {
                if (!card || !card.isValid) continue;
                const info = this.infoOf(card);
                if (!info) continue;
                try {
                    if (snap.hp !== undefined) this.writeHpLabel(card, snap.hp, info);
                    if (snap.attack !== undefined) this.writeAttackLabel(card, snap.attack, info);
                } catch (e) { /* 单卡异常不影响其它 */ }
            }
            for (const [hero, hp] of batch.heroes) {
                if (!hero || !hero.isValid) continue;
                try { hero.applyDisplayHp(hp); } catch (e) { /* 同上 */ }
            }
        } finally {
            this._deferDisplay = was;
        }
    }

    /**
     * 兼容旧名：把**最近一次**延迟窗口采集到的快照写回。
     * ⚠️ 新代码请用 endDeferredDisplay() 取快照 + applyDisplayBatch() —— 只有那样才能做到
     *    「多条指令各自推进一段显示」，而不是一起跳到当前逻辑值。
     */
    public flushDeferredDisplay(): void {
        const batch: BattleDisplayBatch | null = (this._displayBatchCards.size > 0 || this._displayBatchHeroes.size > 0)
            ? { cards: this._displayBatchCards, heroes: this._displayBatchHeroes }
            : null;
        this._displayBatchCards = new Map();
        this._displayBatchHeroes = new Map();
        this.applyDisplayBatch(batch);
    }

    /**
     * 【仅指令系统内部使用】打开「延迟破坏」窗口：此窗口内本次结算中血量归零的随从
     * 只摘除战场逻辑（不可选 / 不计守护），节点保留给**破坏**演出。
     */
    public beginDeferredResolve(): void {
        this._deferDestroy = true;
    }

    /** 关闭「延迟破坏」窗口（务必在 finally 里调用）。 */
    public endDeferredResolve(): void {
        this._deferDestroy = false;
    }

    /** 查询某张战场随从当前血量；未初始化时按 CardData 初始值。 */
    public getHp(card: Node | null): number | null {
        if (!card || !card.isValid) return null;
        const info = this.infoOf(card);
        if (!info || info.cardType !== 'Follower') return null;
        return this.hpOf(card, info);
    }

    /** 清除某张卡的运行时血量与战场血量上限，下一次查询重新取 CardData 初始值。 */
    public resetHp(card: Node | null): void {
        if (!card || !card.isValid) return;
        this._hp.delete(card);
        this._maxHp.delete(card);
        const info = this.infoOf(card);
        if (info) this.writeHpLabel(card, this.initialHp(info), info);
    }

    /** 查询某张战场随从的**战场动态血量上限**；未初始化时按 CardData 基础血量上限。 */
    public getMaxHp(card: Node | null): number | null {
        if (!card || !card.isValid) return null;
        const info = this.infoOf(card);
        if (!info || info.cardType !== 'Follower') return null;
        return this.maxHpOf(card, info);
    }

    /** 设置战场血量上限（只改上限，不动当前血量）；卡面数字配色立刻按新上限刷新。 */
    public setMaxHp(card: Node | null, maxHp: number): boolean {
        if (!card || !card.isValid) return false;
        const info = this.infoOf(card);
        if (!info || info.cardType !== 'Follower') return false;
        this._maxHp.set(card, maxHp);
        this.writeHpLabel(card, this.hpOf(card, info), info);
        return true;
    }

    /**
     * 抬高 / 压低战场血量上限；上限被抬高时**当前血量同步抬高**（保持「满血」）。
     * 卡牌效果里的「血量上限 +N」走这里。
     */
    public addMaxHp(card: Node | null, delta: number): boolean {
        if (!card || !card.isValid) return false;
        const info = this.infoOf(card);
        if (!info || info.cardType !== 'Follower') return false;
        if (!delta) return false;
        const hp = this.hpOf(card, info) + (delta > 0 ? delta : 0);
        if (delta > 0) this._hp.set(card, hp);
        const next = this.maxHpOf(card, info) + delta;
        this._maxHp.set(card, next);
        this.writeHpLabel(card, hp, info);
        return true;
    }

    /** 清除某张卡的战场血量上限，回到 CardData 基础值。 */
    public resetMaxHp(card: Node | null): void {
        if (!card || !card.isValid) return;
        this._maxHp.delete(card);
        const info = this.infoOf(card);
        if (info) this.writeHpLabel(card, this.hpOf(card, info), info);
    }

    /** 查询某张战场随从当前攻击力；未初始化时按 CardData 初始值。 */
    public getAttack(card: Node | null): number | null {
        if (!card || !card.isValid) return null;
        const info = this.infoOf(card);
        if (!info || info.cardType !== 'Follower') return null;
        return this.attackOf(card, info);
    }

    /** 设置当前攻击力。逻辑值允许负数，卡面仍只显示 0；颜色按相对初始值判断。 */
    public setAttack(card: Node | null, attack: number): boolean {
        if (!card || !card.isValid) return false;
        const info = this.infoOf(card);
        if (!info || info.cardType !== 'Follower') return false;
        this._attack.set(card, attack);
        this.writeAttackLabel(card, attack, info);
        return true;
    }

    /** 清除某张卡的运行时攻击力，下一次查询重新取 CardData 初始值。 */
    public resetAttack(card: Node | null): void {
        if (!card || !card.isValid) return;
        this._attack.delete(card);
        const info = this.infoOf(card);
        if (info) this.writeAttackLabel(card, this.initialAttack(info), info);
    }

    /** 给随从叠加运行时攻击 / 血量。用于卡牌能力的入场增益。 */
    public addStats(card: Node | null, attackDelta: number, hpDelta: number): boolean {
        if (!card || !card.isValid) return false;
        const info = this.infoOf(card);
        if (!info || info.cardType !== 'Follower') return false;
        if (attackDelta) this.setAttack(card, this.attackOf(card, info) + attackDelta);
        // 「血量 +N」= 抬高战场血量上限（并同步抬高当前血量，保持满血）——
        // 这样被增益过的随从满血即绿字、掉血即红字，不会出现「小于基础上限才红」的旧行为。
        if (hpDelta) this.addMaxHp(card, hpDelta);
        // ★ 「属性提升」事件：本随从在战场上**获得攻击力 / 生命值增加**时通知一次
        //   （卡 11「温情攻势·安朵丝」靠它每回合召唤 1 个自巡炮；**进化 / 超进化加数值也走这里**）。
        if (attackDelta > 0 || hpDelta > 0) {
            try {
                runCardStatUpAbilities(this, card, this.sideOfCard(card) === BattleSide.Enemy ? 'enemy' : 'player');
            } catch (e) {
                console.error('[BattleRuleSystem] 属性提升事件处理出错（不影响加数值）：', e);
            }
        }
        return true;
    }

    /**
     * 当前随从是否还能攻击（**敌我通用**，每回合一次）。
     * 🔴 只判「是不是战场上的随从 + 本回合攻击过没有 + 关键词（召唤失调等）」，
     *    **不判阵营、也不判回合归属** —— 回合归属由交互层（我方 `BattleFieldPressGlow.canPressNow`
     *    / 敌方 AI）各自门控；这样敌我两方走的是同一套底层规则。
     */
    public canAttack(card: Node | null): boolean {
        this.syncTurn();
        if (!card || !card.isValid) return false;
        const info = this.infoOf(card);
        if (!info || info.cardType !== 'Follower') return false;
        if (!this.fieldOfEitherSide(card)) return false;
        // ★ 多次攻击：看「已攻击次数 < 上限」，不再是一票否决
        if (this.attacksLeft(card) <= 0) return false;
        const keywords = this.keywordSystem();
        return !keywords || typeof keywords.canAttackFollower !== 'function'
            || keywords.canAttackFollower(card) === true;
    }

    /** 当前随从是否允许攻击**对方主战者**（受突进 / 疾驰限制）。敌我通用。 */
    public canAttackHero(card: Node | null): boolean {
        this.syncTurn();
        if (!card || !card.isValid || this.attacksLeft(card) <= 0) return false;
        const info = this.infoOf(card);
        if (!info || info.cardType !== 'Follower') return false;
        if (!this.fieldOfEitherSide(card)) return false;
        const keywords = this.keywordSystem();
        return !keywords || typeof keywords.canAttackHero !== 'function'
            || keywords.canAttackHero(card) === true;
    }

    /**
     * 卡牌当前所属阵营（不在任何战场逻辑集合里 → null）。**敌我通用**。
     * 供 AI / 双方共用的底层操作判定归属，例如「这张牌能不能被我进化」。
     */
    public sideOfCard(card: Node | null): BattleSide | null {
        if (!card || !card.isValid) return null;
        const f = this.fieldOfEitherSide(card);
        return f ? f.side : null;
    }

    /** 对手阵营：Player ↔ Enemy */
    public static opponentOf(side: BattleSide): BattleSide {
        return side === BattleSide.Player ? BattleSide.Enemy : BattleSide.Player;
    }

    // ====================== 「进化」======================

    /** 该随从是否**已经进化过**（普通 / 超进化都算；进化过的不能再次进化）。 */
    public isEvolved(card: Node | null): boolean {
        return !!card && card.isValid && this._evolved.has(card);
    }

    /**
     * 该随从此刻能否被进化（拖动命中 / 光圈提示 / 敌方 AI 都走这一个入口）：
     *   · 必须是**战场上的随从**（护符 / 法术不可）；
     *   · 没有进化过 —— 进化过的随从不能再进化。
     * 🔴 **敌我通用**：不判阵营（谁用谁去判自己的战场 + 回合 + 进化点）；
     *    我方交互层的阵营门控在 `EvoDragController.canStartDrag`（只认 player 徽记）。
     * 🔴 「本回合已经攻击过」**不影响**能否进化（只是进化后照样不能再攻击，
     *    这一点由 `canAttack` 读同一个 `_attacked` 集合天然保证，无需额外处理）。
     */
    public canEvolve(card: Node | null): boolean {
        if (!card || !card.isValid) return false;
        if (this._evolved.has(card)) return false;
        const info = this.infoOf(card);
        if (!info || info.cardType !== 'Follower') return false;
        return !!this.fieldOfEitherSide(card);
    }

    /** 标记某随从已进化（由进化交互调用，必须在 `canEvolve` 通过之后）。 */
    public markEvolved(card: Node | null, isSuper = false): void {
        if (!card || !card.isValid) return;
        this._evolved.add(card);
        if (isSuper) this._superEvolved.add(card);
    }

    /** 该随从是否被**超进化**过（普通进化 = false）。 */
    public isSuperEvolved(card: Node | null): boolean {
        return !!card && card.isValid && this._superEvolved.has(card);
    }

    /**
     * 【超进化守护】己方回合内，超进化随从**受到的伤害全部转为 0、且不会被破坏**；
     * 对方回合则完全没有这两项能力。
     * 判定 = 该卡被超进化过 && 该卡所属方的回合正在进行。
     */
    public isSuperGuarded(card: Node | null): boolean {
        if (!card || !card.isValid || !this._superEvolved.has(card)) return false;
        const tm = this.turnManager();
        if (!tm || !tm.isRunning) return false;
        const field = this.fieldOf(card, this.playerField);
        if (!field) return false;
        const isPlayerCard = field.side === BattleSide.Player;
        return isPlayerCard ? tm.turnSide === 'player' : tm.turnSide === 'enemy';
    }

    // ====================== 「守护」======================
    /** 该随从当前是否持有「守护」词条（守护状态由 CardKeywordSystem 维护）。 */
    public isGuard(card: Node | null): boolean {
        if (!card || !card.isValid) return false;
        const info = this.infoOf(card);
        if (!info || info.cardType !== 'Follower') return false;
        const kw = this.keywordSystem();
        if (kw && typeof kw.hasGuard === 'function') return kw.hasGuard(card) === true;
        return (info.keywords || []).indexOf('Guard') >= 0;
    }

    /** 该随从当前是否持有「威慑」词条（无法被对方随从普通攻击）。 */
    public isDeter(card: Node | null): boolean {
        if (!card || !card.isValid) return false;
        const info = this.infoOf(card);
        if (!info || info.cardType !== 'Follower') return false;
        const kw = this.keywordSystem();
        if (kw && typeof kw.hasDeter === 'function') return kw.hasDeter(card) === true;
        return (info.keywords || []).indexOf('Deter') >= 0;
    }

    /**
     * 该随从当前是否持有「潜行」词条。
     * 效果 = **不会被对方的能力选中**（选择层过滤，见 TargetSelectSystem.candidatesFor）
     *      + **不会被对方随从攻击**（本类的 canTarget / resolveCombat）。
     */
    public isAmbush(card: Node | null): boolean {
        if (!card || !card.isValid) return false;
        const info = this.infoOf(card);
        if (!info || info.cardType !== 'Follower') return false;
        const kw = this.keywordSystem();
        if (kw && typeof kw.hasAmbush === 'function') return kw.hasAmbush(card) === true;
        return (info.keywords || []).indexOf('Ambush') >= 0;
    }

    /**
     * 该随从当前是否**受伤**（= 能力选目标的 `filter: 'damaged'` 判据）。
     *
     * 🔴 口径与血量数字的**红字**完全一致（`BattleValueStyle.battleHpIsDamaged`）：
     *    `当前血量 < 战场动态血量上限`（掉过血）**或** `上限 < 卡面基础上限`（上限被削）。
     *    也就是说「玩家在卡面上看到的是红字血量」⇔ 受伤，判定与 UI 观感严格对齐。
     */
    public isDamaged(card: Node | null): boolean {
        if (!card || !card.isValid) return false;
        const info = this.infoOf(card);
        if (!info) return false;
        const hp = this.getHp(card);
        if (typeof hp !== 'number') return false;
        const baseMax = this.initialHp(info);
        const maxHp = this.maxHpOf(card, info);
        return battleHpIsDamaged(hp, maxHp, baseMax);
    }

    /** 某方战场上是否存在持有「守护」的随从。 */
    public hasGuard(side: BattleSide): boolean {
        const field = this.fieldBySide(side);
        if (!field || !field.isValid) return false;
        for (const card of field.cards) {
            if (!card || !card.isValid) continue;
            if (this.isGuard(card)) return true;
        }
        return false;
    }

    /**
     * attacker 能否把 target 选为攻击目标（**含「守护」限制**）。
     * target 允许是敌方随从节点或敌方主战者节点。
     *
     * 「守护」规则：目标方战场上只要存在持有守护的随从，attacker 就只能攻击这些守护随从，
     * **不能**攻击其它随从，也**不能**攻击主战者。
     * 「威慑」规则：目标随从持有威慑时，**任何**对方随从的普通攻击都不能选它（连守护也不行）。
     */
    public canTarget(attacker: Node | null, target: Node | null): boolean {
        if (!this.combatEnabled) return false;
        if (!attacker || !attacker.isValid || !target || !target.isValid || attacker === target) return false;
        const info = this.infoOf(attacker);
        if (!info || info.cardType !== 'Follower') return false;
        const af = this.fieldOfEitherSide(attacker);
        if (!af) return false;
        const enemySide = BattleRuleSystem.opponentOf(af.side);
        const guardOn = this.hasGuard(enemySide);

        // 目标是主战者
        const hero = target.getComponent(HeroArea);
        if (hero) {
            if (hero.side !== (af.side === BattleSide.Player ? HeroSide.Enemy : HeroSide.Player)) return false;
            if (guardOn) return false;                       // 守护在场 → 主战者不可选
            return this.canAttackHero(attacker) === true;
        }

        // 目标是随从
        const ti = this.infoOf(target);
        if (!ti || ti.cardType !== 'Follower') return false;
        const tf = this.fieldOf(target, enemySide === BattleSide.Player ? this.playerField : this.enemyField);
        if (!tf || tf.side !== enemySide) return false;
        if (this.isDeter(target)) return false;              // 威慑：无法被对方随从普通攻击
        if (this.isAmbush(target)) return false;             // 潜行：同上（不会被对方随从攻击）
        if (this.canAttack(attacker) !== true) return false;
        if (guardOn) return this.isGuard(target);            // 守护在场 → 只能打守护随从
        return true;
    }

    /** 供测试 / 回合系统显式清空本回合攻击记录（顺带清「启动」记录：两者都是「1 回合 1 次」）。 */
    public resetAttacksThisTurn(): void {
        this._attacked = new WeakSet<Node>();
        this._attackCount = new WeakMap<Node, number>();
        this._activatedAmulets = new WeakSet<Node>();
        this._turnKey = this.turnKey();
    }

    // ====================== 「启动」（护符的主动能力）======================
    /**
     * 本回合**已经启动过**的护符（「启动」= 1 回合仅限 1 次）。
     * 与 `_attacked` 同款：由 `syncTurn()`（回合键变化时）清空 —— 见 `canActivateAmulet`。
     */
    private _activatedAmulets = new WeakSet<Node>();

    /** 本回合**已经触发过「属性提升」**的随从（卡 11：自己的每回合中可触发 1 次）。 */
    private _statUpThisTurn = new WeakSet<Node>();

    /**
     * 该护符本回合是否**还没启动过**（「启动」1 回合仅限 1 次）。
     * 🔴 必须先 `syncTurn()`：回合键一变就清空记录 —— 否则「一整局只能启动一次」。
     */
    public canActivateAmulet(card: Node | null): boolean {
        this.syncTurn();
        return !!card && card.isValid && !this._activatedAmulets.has(card);
    }

    /** 标记该护符本回合已启动过。 */
    public markAmuletActivated(card: Node | null): void {
        if (!card || !card.isValid) return;
        this.syncTurn();          // 先对齐回合（防止「跨回合的第一次写入」被随后的 sync 清掉）
        this._activatedAmulets.add(card);
    }

    /**
     * ★ 该随从本回合是否**还没触发过「属性提升」**（卡 11：自己的每回合中可触发 1 次）。
     * 与「启动」同款：先 `syncTurn()` 保证跨回合自动重置。
     */
    public canTriggerStatUp(card: Node | null): boolean {
        this.syncTurn();
        return !!card && card.isValid && !this._statUpThisTurn.has(card);
    }

    /** ★ 标记该随从本回合已触发过「属性提升」。 */
    public markStatUpTriggered(card: Node | null): void {
        if (!card || !card.isValid) return;
        this.syncTurn();
        this._statUpThisTurn.add(card);
    }

    /**
     * 结算一次「随从攻击随从」（**敌我通用**：只要求攻守双方在**不同阵营**的两个战场上）。
     * 攻击目标是随从时双方互相反伤；目标是对方主战者时只扣主战者血量，不触发反击。
     * @returns 成功结算返回结果；卡牌非法 / 类型不对 / 阵营不对时返回 null。
     */
    public resolveCombat(
        attacker: Node | null,
        defender: Node | null,
    ): BattleDamageResult | BattleHeroDamageResult | null {
        if (!this.combatEnabled) return null;
        if (!attacker || !defender || !attacker.isValid || !defender.isValid || attacker === defender) return null;

        const attackerInfo = this.infoOf(attacker);
        if (!attackerInfo || attackerInfo.cardType !== 'Follower') return null;

        // 🔴 阵营推导（不再是「写死我方打敌方」）：攻击方在哪边，防守方就必须在另一边。
        const attackerField = this.fieldOfEitherSide(attacker);
        if (!attackerField) return null;
        const defenderSide = BattleRuleSystem.opponentOf(attackerField.side);
        if (!this.canAttack(attacker)) return null;

        const hero = defender.getComponent(HeroArea);
        if (hero) return this.resolveHeroAttack(attacker, defender);

        const defenderInfo = this.infoOf(defender);
        if (!defenderInfo || defenderInfo.cardType !== 'Follower') return null;
        const defenderField = this.fieldBySide(defenderSide);
        if (!defenderField || !defenderField.containsCard(defender)) return null;
        // 威慑：持有威慑的随从无法被对方随从普通攻击（优先级高于守护）
        if (this.isDeter(defender)) return null;
        // 潜行：持有潜行的随从**不会被对方随从攻击**（与威慑同理，优先级高于守护）
        if (this.isAmbush(defender)) return null;
        // 守护：**防守方**有守护随从时，不能攻击非守护随从
        if (this.hasGuard(defenderSide) && !this.isGuard(defender)) return null;

        // ★【交战时】：在互相造成伤害前触发。双方各自以对方为 target；
        //   攻击主战者走 resolveHeroAttack，因此不会进入这里。
        const attackerSideName = attackerField.side === BattleSide.Player ? 'player' : 'enemy';
        const defenderSideName = defenderSide === BattleSide.Player ? 'player' : 'enemy';
        const attackerId = cardIdFromNodeName(attacker.name);
        const defenderId = cardIdFromNodeName(defender.name);
        if (attackerId) {
            runCardBattleAbilities(this, attackerId, attackerSideName, attacker, defender);
        }
        if (defenderId && defender.isValid) {
            runCardBattleAbilities(this, defenderId, defenderSideName, defender, attacker);
        }
        // 只要任一方的交战时能力已使它离场，就跳过这段伤害交换；
        // 「离场」已经由 destroyCard 摘出战场逻辑，节点会留给后续破坏演出。
        const attackerStillFighting = attackerField.containsCard(attacker);
        const defenderStillFighting = defenderField.containsCard(defender);
        if (!attackerStillFighting || !defenderStillFighting) {
            this.markAttacked(attacker);
            // ★【超进化破坏】在**交战时破坏**（Clash，如卡 18「现代最强·针」）把对方随从带走时**同样成立**：
            //    攻击方若已超进化，就要对对方主战者造成连锁伤害。
            //    🔴 复用与「打死后连锁」完全相同的返回字段 ⇒ BattleCommandSystem 会自动排
            //       `SuperEvolveDestroy` 那条专属演出（光团收缩→飞向主战者→迸发+跳血），动画/特效一致。
            let superEvolveBreak = false;
            let superBreakHero: HeroArea | null = null;
            let superBreakHeroHpAfter = 0;
            if (!defenderStillFighting && this.isSuperEvolved(attacker)) {
                const hero = this.heroOfSide(defenderSide);
                if (hero) {
                    const extraDamage = Math.max(0, Math.round(this.superEvolveBreakHeroDamage));
                    try { setNumberPhase('superBreak'); } catch (e) { /* 忽略 */ }
                    superBreakHeroHpAfter = hero.takeDamage(extraDamage, this._deferDisplay);
                    try { setNumberPhase(''); } catch (e) { /* 忽略 */ }
                    if (this._deferDisplay) this._displayBatchHeroes.set(hero, superBreakHeroHpAfter);
                    else hero.flushDisplay();
                    superEvolveBreak = true;
                    superBreakHero = hero;
                    console.log(`[BattleRuleSystem] 超进化破坏（交战时）：${attacker.name} 破坏 ${defender.name}`
                        + ` → 对方主战者连锁 ${extraDamage} 点（${superBreakHeroHpAfter}）`);
                }
            }
            return {
                attacker,
                defender,
                attackerDamage: 0,
                defenderDamage: 0,
                attackerHpAfter: this.getHp(attacker),
                defenderHpAfter: this.getHp(defender),
                attackerDestroyed: !attackerStillFighting,
                defenderDestroyed: !defenderStillFighting,
                contactCancelled: true,
                superEvolveBreak,
                superBreakHero,
                superBreakHeroHpAfter,
            };
        }

        const attackerDamage = this.damageOf(attacker, attackerInfo);
        const defenderDamage = this.damageOf(defender, defenderInfo);

        // 【超进化守护】己方回合内受到的伤害全部转为 0 ⇒ 血量不动、自然也不会被破坏。
        const attackerShielded = this.isSuperGuarded(attacker);
        const defenderShielded = this.isSuperGuarded(defender);

        // 同步结算：先算完双方结果，再写血量和处理死亡，避免先后顺序影响反击。
        const attackerHpAfter = this.hpOf(attacker, attackerInfo) - (attackerShielded ? 0 : defenderDamage);
        const defenderHpAfter = this.hpOf(defender, defenderInfo) - (defenderShielded ? 0 : attackerDamage);

        // ★ 【超进化破坏】时**不播反击动画** ⇒ 攻击方那一下 0 伤害不该飘红 0（玩家看不到它受伤）。
        //    预判必须在 setHp **之前**（超进化守护会在 setHp 里登记 0）⇒ 这里先压制飘字登记。
        const attackerBanePre = this.hasBane(attacker) && this.canDestroyByAbility(defender);
        const noCounterAnimPre = this.isSuperEvolved(attacker) && (defenderHpAfter <= 0 || attackerBanePre);
        if (noCounterAnimPre) { try { setNumberSuppressed(true); } catch (e) { /* 忽略 */ } }
        // ★ 飘字阶段：防御方挨的那一下属于「攻击命中」，攻击方挨的属于「反击命中」——
        //   各自在自己的动画播到目标时再飘（用户口径：数字是动画的一部分，不能同时出现）。
        try { setNumberPhase('attack'); } catch (e) { /* 忽略 */ }
        this.setHp(defender, defenderHpAfter);
        try { setNumberPhase('counter'); } catch (e) { /* 忽略 */ }
        this.setHp(attacker, attackerHpAfter);
        try { setNumberPhase(''); } catch (e) { /* 忽略 */ }
        if (noCounterAnimPre) { try { setNumberSuppressed(false); } catch (e) { /* 忽略 */ } }

        // ★★ 【毁灭】：因攻击 / 被攻击**对对手随从造成伤害**时直接破坏该随从 ——
        //    即使攻击力为 0、或伤害被减为 0 也照样发动 ⇒ 与血量无关，用 `||` 并进去。
        const attackerBane = this.hasBane(attacker) && this.canDestroyByAbility(defender);
        const defenderBane = this.hasBane(defender) && this.canDestroyByAbility(attacker);
        // 预判「这一下会不会破坏对方随从」（超进化破坏的判定用它）
        const defenderDestroyedPreview = (defenderHpAfter <= 0) || attackerBane;
        if (attackerBane || defenderBane) {
            console.log(`[BattleRuleSystem] 毁灭：${attacker.name}(攻击方 ${attackerBane ? '有' : '无'})`
                + ` / ${defender.name}(防守方 ${defenderBane ? '有' : '无'})`);
        }
        // 🔴 破坏判定必须看**实际写入后的血量**，不能看上面算出来的理论值：setHp 里会拦【屏障】
        //    （伤害变 0、血量不动）⇒ 用理论值会把「被屏障挡下」的随从照样破坏（实测踩过：
        //    海伦娜有屏障攻击敌方随从，反击伤害被挡了、卡却没了）。
        // ★ 【超进化破坏】时**不播反击动画** ⇒ 攻击方那一下 0 伤害不该飘红 0（玩家看不到它受伤）
        const attackerDestroyed = this.getHp(attacker) <= 0 || defenderBane;
        const defenderDestroyed = this.getHp(defender) <= 0 || attackerBane;
        if (defenderDestroyed) this.destroyCard(defender, defenderField);
        if (attackerDestroyed) this.destroyCard(attacker, attackerField);

        // 【超进化破坏】超进化随从攻击**破坏**对方随从 ⇒ 对对方主战者连锁造成额外伤害。
        // 🔴 纯逻辑：主战者**逻辑血量**当场扣（takeDamage deferDisplay=true，显示冻结在
        //    原数值），显示由 BattleCommandSystem 的 SuperEvolveDestroy 演出在
        //    「主战者处光团迸发」那一刻才推进到这里的快照值 —— 绝不立马更新给玩家。
        let superEvolveBreak = false;
        let superBreakHero: HeroArea | null = null;
        let superBreakHeroHpAfter = 0;
        if (defenderDestroyed && this.isSuperEvolved(attacker)) {
            // 连锁伤害打**攻击方的对方主战者**（敌我通用；原来是写死 enemyHero）
            const hero = this.heroOfSide(defenderSide);
            if (hero) {
                const extraDamage = Math.max(0, Math.round(this.superEvolveBreakHeroDamage));
                // ★ 连锁伤害的飘字打 'superBreak' 阶段 ⇒ 由超进化破坏 cue 播完（撞到主战者图标之后）再放
                try { setNumberPhase('superBreak'); } catch (e) { /* 忽略 */ }
                superBreakHeroHpAfter = hero.takeDamage(extraDamage, true);
                try { setNumberPhase(''); } catch (e) { /* 忽略 */ }
                // 指令窗口之外（无演出队列的旧路径）没有特效来推进显示 → 立刻解除冻结，
                // 否则显示会永久卡在旧值。
                if (!this._deferDisplay) hero.flushDisplay();
                superEvolveBreak = true;
                superBreakHero = hero;
            }
        }

        this.markAttacked(attacker);
        return {
            attacker,
            defender,
            attackerDamage,
            defenderDamage,
            attackerHpAfter,
            defenderHpAfter,
            attackerDestroyed,
            defenderDestroyed,
            superEvolveBreak,
            superBreakHero,
            superBreakHeroHpAfter,
        };
    }

    /** 全场景 BFS 找**指定阵营**的主战者（带缓存，失效自动重查）。敌我通用。 */
    private heroOfSide(side: BattleSide): HeroArea | null {
        const want = side === BattleSide.Player ? HeroSide.Player : HeroSide.Enemy;
        const cache = side === BattleSide.Player ? this._pSideHeroCache : this._eSideHeroCache;
        if (cache && cache.isValid) return cache;
        const scene = this.node.scene as unknown as Node | null;
        if (!scene) return null;
        const stack: Node[] = [...scene.children];
        while (stack.length > 0) {
            const cur = stack.shift() as Node;
            const h = cur.getComponent(HeroArea);
            if (h && h.isValid && h.side === want) {
                if (side === BattleSide.Player) this._pSideHeroCache = h; else this._eSideHeroCache = h;
                return h;
            }
            for (const ch of cur.children) stack.push(ch);
        }
        return null;
    }

    /** 对方主战者节点 / 组件（供演出与 AI 取用；找不到返回 null）。 */
    public opponentHeroOf(card: Node | null): HeroArea | null {
        const side = this.sideOfCard(card);
        return side === null ? null : this.heroOfSide(BattleRuleSystem.opponentOf(side));
    }

    /**
     * 随从攻击**对方**主战者：只造成伤害，不触发反击。**敌我通用**：
     * 只要求主战者阵营 = 攻击者阵营的对面。
     */
    public resolveHeroAttack(attacker: Node | null, heroNode: Node | null): BattleHeroDamageResult | null {
        if (!this.combatEnabled) return null;
        if (!attacker || !heroNode || !attacker.isValid || !heroNode.isValid) return null;
        const info = this.infoOf(attacker);
        if (!info || info.cardType !== 'Follower') return null;
        const attackerField = this.fieldOfEitherSide(attacker);
        const hero = heroNode.getComponent(HeroArea);
        if (!attackerField || !hero) return null;
        const defenderSide = BattleRuleSystem.opponentOf(attackerField.side);
        const wantHero = defenderSide === BattleSide.Player ? HeroSide.Player : HeroSide.Enemy;
        if (hero.side !== wantHero) return null;
        if (!this.canAttackHero(attacker)) return null;
        // 守护：**防守方**有守护随从时，不能攻击主战者
        if (this.hasGuard(defenderSide)) return null;
        return this.resolveHeroAttackInner(attacker, heroNode, info, hero);
    }

    private resolveHeroAttackInner(
        attacker: Node,
        heroNode: Node,
        attackerInfo: CardInfo,
        hero: HeroArea,
    ): BattleHeroDamageResult {
        const damage = this.damageOf(attacker, attackerInfo);
        // 主战者血量同理：逻辑立刻扣，显示等演出播完（deferDisplay=true 时 takeDamage 只改数值不重建卡面）。
        const heroHpAfter = hero.takeDamage(damage, this._deferDisplay);
        // 记录「本指令结算后」的血量快照（不是最终逻辑值）→ 显示逐段推进
        if (this._deferDisplay) this._displayBatchHeroes.set(hero, heroHpAfter);
        this.markAttacked(attacker);
        return { attacker, heroNode, damage, heroHpAfter };
    }

    private markAttacked(card: Node): void {
        this.syncTurn();
        this._attacked.add(card);
        this._attackCount.set(card, (this._attackCount.get(card) || 0) + 1);
        const keywords = this.keywordSystem();
        if (keywords && typeof keywords.markAttacked === 'function') keywords.markAttacked(card);
    }

    private syncTurn(): void {
        const key = this.turnKey();
        if (key === this._turnKey) return;
        this._turnKey = key;
        this._attacked = new WeakSet<Node>();
        // ★★ 多次攻击的**已用次数**也必须跟着回合键清空 ——
        //    之前只加到了 resetAttacksThisTurn（没人调）⇒ 随从打一次后**整局**都不能再动（用户报的严重 bug）。
        this._attackCount = new WeakMap<Node, number>();
        // 🔴 「启动」也是「1 回合 1 次」⇒ 必须跟着回合键一起清空。
        //    （曾经漏了这一行 + canActivateAmulet 没调 syncTurn ⇒ 护符一整局只能启动一次。）
        this._activatedAmulets = new WeakSet<Node>();
        this._statUpThisTurn = new WeakSet<Node>();
    }

    /** 回合键 = 大回合 + 本大回合内第几个操作回合 + 当前阵营。 */
    private turnKey(): string {
        const tm = this.turnManager();
        if (!tm || !tm.isRunning) return 'not-running';
        return `${tm.roundNumber}:${tm.turnIndexInRound}:${tm.turnSide}`;
    }

    /** BFS 找 TurnManager；不静态 import，避免与回合流程形成循环依赖。 */
    private turnManager(): any {
        if (this._tmCache && this._tmCache.isValid) return this._tmCache;
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
     * 演出队列（`BattleCommandSystem`）——「消失」要往里排 `Vanish` cue。
     * 与 `keywordSystem()` 同款：全场景 BFS + 缓存（找不到返回 null，调用方退化为直接销毁）。
     */
    private commandSystem(): { pushCue?: (cue: unknown) => void } | null {
        if (this._cmdsCache && this._cmdsCache.isValid) return this._cmdsCache;
        const scene = this.node.scene as unknown as Node | null;
        if (!scene) return null;
        const stack: Node[] = [...scene.children];
        while (stack.length > 0) {
            const cur = stack.shift() as Node;
            const c = cur.getComponent('BattleCommandSystem') as { pushCue?: (cue: unknown) => void } | null;
            if (c) { this._cmdsCache = c; return c; }
            for (const ch of cur.children) stack.push(ch);
        }
        return null;
    }

    private keywordSystem(): any {
        if (this._keywordCache && this._keywordCache.isValid) return this._keywordCache;
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

    private infoOf(card: Node): CardInfo | undefined {
        const id = cardIdFromNodeName(card.name);
        return id ? getCardInfo(id) : undefined;
    }

    private initialAttack(info: CardInfo): number {
        return typeof info.attack === 'number' ? info.attack : 0;
    }

    private attackOf(card: Node, info: CardInfo): number {
        const cached = this._attack.get(card);
        if (cached !== undefined) return cached;
        const attack = this.initialAttack(info);
        this._attack.set(card, attack);
        return attack;
    }

    private damageOf(card: Node, info: CardInfo): number {
        return Math.max(0, this.attackOf(card, info));
    }

    private initialHp(info: CardInfo): number {
        return typeof info.hp === 'number' ? info.hp : 0;
    }

    private hpOf(card: Node, info: CardInfo): number {
        const cached = this._hp.get(card);
        if (cached !== undefined) return cached;
        const hp = this.initialHp(info);
        this._hp.set(card, hp);
        return hp;
    }

    private maxHpOf(card: Node, info: CardInfo): number {
        const cached = this._maxHp.get(card);
        if (cached !== undefined) return cached;
        const max = this.initialHp(info);      // 基础血量上限 = CardData.hp
        this._maxHp.set(card, max);
        return max;
    }

    public setHp(card: Node, hp: number): void {
        if (!card || !card.isValid) return;
        // ★★ 【屏障】的**唯一拦截点**：任何让血量**下降**的写入都算「受到伤害」——
        //    战斗反击伤害 / 敌方能力 / 法术 / 主战者的直接伤害……全都最终走 setHp
        //    ⇒ 只在这里拦，就不会再出现「屏障随从被反击打死 / 被敌方能力打死」。
        const curHp = this._hp.get(card);
        if (typeof curHp === 'number' && hp < curHp) {
            // ★★ 【超进化守护】超进化随从在**自己的回合**内受到的所有伤害都变为 0 ——
            //    放在 setHp 这个唯一写血口，战斗反击 / 能力 / 法术 / 敌方 AI 全覆盖。
            if (this.isSuperGuarded(card)) {
                // ★ 对方打过来了（有攻击动画）⇒ 显示红色 0；被压制时（不播反击动画的超进化攻击段）不显示
                try { recordNumber(card, 0, false, true); scheduleZeroFlush(); } catch (e) { /* 忽略 */ }
                console.log(`[BattleRuleSystem] ${card.name} 超进化守护：本次 ${curHp - hp} 点伤害变为 0（自己回合内）`);
                return;
            }
            if (this.tryConsumeBarrier(card, curHp - hp)) {
                // ★ 屏障破碎就是这次伤害的「动画」⇒ 按用户口径显示**红色 0**
                try { recordNumber(card, 0, false, true); scheduleZeroFlush(); console.log('[飘字] 屏障挡伤登记红色 0：' + card.name); } catch (e) { /* 忽略 */ }
                return;                              // 屏障：本次伤害变 0
            }
        }
        // ★ 飘字登记（用户口径：数字也是动画的一部分）—— 必须放在**挡伤判定之后**：
        //   正 = 受伤（红）、负 = 治疗（绿）；被挡下的那种 0 已在上面按 blocked 登记。
        //   🔴 曾经放在判定**之前** ⇒ 被屏障挡下也会飘一个满伤害的红字（错），且与上面的 0 重复登记。
        if (typeof curHp === 'number' && Math.round(hp) !== Math.round(curHp)) {
            const delta = Math.round(curHp) - Math.round(hp);
            // ★ 回血（delta < 0）没有动画 ⇒ immediate 立刻播；掉血按阶段等动画
            try { recordNumber(card, delta, false, false, undefined, false, delta < 0); } catch (e) { /* 忽略 */ }
        }
        this._hp.set(card, hp);
        const info = this.infoOf(card);
        if (info) this.writeHpLabel(card, hp, info);
    }

    private writeHpLabel(card: Node, hp: number, info: CardInfo): void {
        // 延迟显示：只登记「本条指令结算后的值」，等这段演出播完再写。
        if (this._deferDisplay) {
            let snap = this._displayBatchCards.get(card);
            if (!snap) { snap = {}; this._displayBatchCards.set(card, snap); }
            snap.hp = hp;
            return;
        }
        const hpNode = card.getChildByName('CardHp');
        const label = hpNode ? hpNode.getComponent(Label) : null;
        if (!label) return;
        const baseMax = this.initialHp(info);
        const maxHp = this.maxHpOf(card, info);
        label.string = formatBattleValue(hp);
        // 需求：血量配色基于**战场动态上限** —— 满血且上限未变=白、满血且上限被增益=绿、其余=红。
        label.color = battleHpColor(hp, maxHp, baseMax);
        applyBattleValueOutline(label, battleHpIsDamaged(hp, maxHp, baseMax));
    }

    private writeAttackLabel(card: Node, attack: number, info: CardInfo): void {
        // 延迟显示：只登记「本条指令结算后的值」，等这段演出播完再写。
        if (this._deferDisplay) {
            let snap = this._displayBatchCards.get(card);
            if (!snap) { snap = {}; this._displayBatchCards.set(card, snap); }
            snap.attack = attack;
            return;
        }
        const attackNode = card.getChildByName('CardAttack');
        const label = attackNode ? attackNode.getComponent(Label) : null;
        if (!label) return;
        label.string = formatBattleAttack(attack);
        label.color = battleValueColor(attack, this.initialAttack(info));
        applyBattleValueOutline(label, attack < this.initialAttack(info));
    }

    /**
     * ★ **消失**（关键字）：把一张战场卡从战场上**除去** ——
     *   · 🔴 **不进墓场**（与破坏最大的区别）；
     *   · 🔴 **不触发谢幕曲**等「被破坏时」的能力（本方法根本不走 `destroyCard` 那条路）；
     *   · 演出 = 破坏特效的**反方向**（光向内收），由 `Vanish` cue 负责。
     *
     * 手牌 / 牌组的消失由 `CardAbilitySystem` 直接处理（那两处不涉及战场排布）。
     * @returns 是否真的除去了（卡不在战场记录里 → false）
     */
    /**
     * ★ **批量消失**（卡 17 的「消失对手场上所有卡牌」）：逻辑逐张摘除，但**只压一条** `Vanish` cue
     * （带 `cards` 数组）⇒ 消失动画**同时播**，而不是一张一张排队（需求）。
     * @returns 实际消失的张数
     */
    public vanishFieldCards(cards: Node[] | null, field: BattleFieldLayout | null): number {
        const f = field && field.isValid ? field : null;
        if (!f) return 0;
        const list = (cards || []).filter((c) => !!c && c.isValid);
        if (list.length === 0) return 0;
        const cmds = this.commandSystem();
        const detached: Node[] = [];
        for (const card of list) {
            try {
                if (f.detachCardNode(card, false, false)) detached.push(card);
                else console.warn(`[BattleRuleSystem] 批量消失：卡牌不在战场记录中：${card.name}`);
            } catch (e) { console.error('[BattleRuleSystem] 批量消失摘除失败：', e); }
        }
        if (detached.length === 0) return 0;
        if (cmds) {
            // 🔴 一条 cue 带全部卡 ⇒ playVanishCue 并发开播；随后补一条 Reflow（逻辑摘除时没重排）
            cmds.pushCue({ type: BattleCueType.Vanish, cards: detached, field: f });
            cmds.pushCue({ type: BattleCueType.Reflow, field: f });
        } else {
            for (const c of detached) { try { killNode(c); } catch (e) { /* 忽略 */ } }
        }
        console.log(`[BattleRuleSystem] 批量消失：${detached.length} 张（同时播放消失演出）`);
        return detached.length;
    }

    public vanishFieldCard(card: Node | null, field: BattleFieldLayout | null): boolean {
        if (!card || !card.isValid) return false;
        const f = field && field.isValid ? field : this.fieldOf(card, null);
        if (!f) return false;
        // 逻辑先摘除（不可选 / 不计守护 / 不占位），节点留给消失演出播完再销毁
        if (!f.detachCardNode(card, false, false)) {
            console.warn(`[BattleRuleSystem] 消失：卡牌不在战场记录中，无法精确摘除：${card.name}`);
            return false;
        }
        // 🔴 这里**绝不**调 countGrave / addToGrave —— 消失不增加墓场数量
        const cmds = this.commandSystem();
        if (cmds && typeof cmds.pushCue === 'function') {
            try {
                cmds.pushCue({ type: BattleCueType.Vanish, card, field: f });
                // 🔴 消失后**必须补一条 Reflow**：`detachCardNode(card, false, false)` 的 relayout=false
                //    ⇒ 逻辑摘除时**不重排**（与破坏同款），排布要靠演出队列在消失动画之后重排。
                //    漏了这条 ⇒ 被消失的卡留下一个空位、其余卡不归位（实测 bug）。
                cmds.pushCue({ type: BattleCueType.Reflow, field: f });
            } catch (e) {
                console.error('[BattleRuleSystem] 排入「消失」演出失败：', e);
                try { f.removeCardNode(card); } catch (e2) { /* 忽略 */ }
            }
        } else {
            try { f.removeCardNode(card); } catch (e) { /* 忽略 */ }
        }
        console.log(`[BattleRuleSystem] 消失：${card.name}（不进墓场、不触发谢幕曲）`);
        return true;
    }

    private destroyCard(card: Node, field: BattleFieldLayout): void {
        if (!card || !card.isValid) return;
        // ★★ 【不会被能力破坏】血量仍 > 0 时拒绝任何直接破坏；
        //    数字伤害已经把它打到 <= 0 的路径不受影响。
        if (!this.canDestroyByAbility(card)) return;
        // ★★ 【超进化守护】超进化随从在**自己的回合**内**不会被能力破坏**。
        //    判据：血量仍 > 0 ⇒ 这次不是「伤害致死」，而是效果/能力直接破坏 ⇒ 拒绝。
        //    （伤害致死的路径血量已经 ≤ 0，不受影响。）
        try {
            if (this.isSuperGuarded(card) && this.getHp(card) > 0) {
                console.log(`[BattleRuleSystem] ${card.name} 超进化守护：免疫能力破坏（自己回合内，血量 ${this.getHp(card)}）`);
                return;
            }
        } catch (e) { /* 判定失败不阻断破坏 */ }
        // ★ 谢幕曲：**被破坏时**发动（「消失」不走这里 ⇒ 不会发动，符合关键字口径）
        try {
            runCardLastWords(this, card, field.side === BattleSide.Player ? 'player' : 'enemy');
        } catch (e) {
            console.error('[BattleRuleSystem] 谢幕曲结算出错（不影响破坏）：', e);
        }
        if (this._destroySink && this._deferDestroy) {
            // 接入演出队列：先摘除逻辑（不可选/不计守护/不占位），节点留给**破坏**演出播完再销毁。
            // 🔴 第 3 个参数 relayout=false：**绝不在逻辑移除的瞬间重排** ——
            //    排布必须等破坏动画播完，由演出队列的 Reflow cue 用连续动画更新。
            if (!field.detachCardNode(card, false, false)) {
                console.warn(`[BattleRuleSystem] 卡牌不在战场记录中，无法精确摘除：${card.name}`);
                return;
            }
            this.countGrave(card, field);
            try {
                this._destroySink(card, field);
            } catch (e) {
                console.error('[BattleRuleSystem] 破坏接收器出错：', e);
                // 接收器坏了也不能让节点泄漏 —— 直接销毁。
                if (card.isValid) field.removeCardNode(card);
            }
            return;
        }
        if (!field.removeCardNode(card)) {
            console.warn(`[BattleRuleSystem] 卡牌不在战场记录中，无法精确移除：${card.name}`);
            return;
        }
        this.countGrave(card, field);
    }

    /**
     * 墓场 +1 —— 🔴 在**逻辑破坏成功那一刻**调用（摘除战场记录之后、破坏动画开始之前）。
     * 破坏演出播多久都不影响计数：BattleStatusBar 读的就是这份逻辑计数。
     */
    private countGrave(card: Node, field: BattleFieldLayout): void {
        try {
            addToGrave(this.node, field.side === BattleSide.Player ? 'player' : 'enemy',
                cardIdFromNodeName(card.name));
        } catch (e) {
            console.error('[BattleRuleSystem] 墓场记账失败：', e);
        }
    }

    /**
     * **公开**的「按阵营取战场」入口（供卡牌能力等外部逻辑按阵营选目标 / 结算）。
     * 与内部 `fieldBySide` 完全同源，只是把私有实现暴露出来，避免外部再各写一份 BFS。
     */
    public fieldOfSide(side: BattleSide): BattleFieldLayout | null {
        return this.fieldBySide(side);
    }

    /** 按阵营取战场（Inspector 指定 → 全场景 BFS 找 side 匹配的 BattleFieldLayout）。 */
    private fieldBySide(side: BattleSide): BattleFieldLayout | null {
        const preferred = side === BattleSide.Player ? this.playerField : this.enemyField;
        if (preferred && preferred.isValid) return preferred;
        if (side === BattleSide.Player && this._pSideField && this._pSideField.isValid) return this._pSideField;
        if (side === BattleSide.Enemy && this._eSideField && this._eSideField.isValid) return this._eSideField;
        const scene = this.node.scene as unknown as Node | null;
        if (!scene) return null;
        const stack: Node[] = [...scene.children];
        while (stack.length > 0) {
            const cur = stack.shift() as Node;
            const f = cur.getComponent(BattleFieldLayout);
            if (f && f.isValid && f.side === side) {
                if (side === BattleSide.Player) this._pSideField = f; else this._eSideField = f;
                return f;
            }
            for (const ch of cur.children) stack.push(ch);
        }
        return null;
    }

    /**
     * 取卡牌所属战场（**敌我通用**）：先按 Inspector 的两个战场字段试，再退回父链解析。
     * 供「不关心阵营、只关心它是不是战场上的牌」的判定使用（canAttack / canEvolve / sideOfCard…）。
     */
    public fieldOfEitherSide(card: Node | null): BattleFieldLayout | null {
        if (!card || !card.isValid) return null;
        return this.fieldOf(card, this.playerField) || this.fieldOf(card, this.enemyField);
    }

    /** 取卡牌所属战场；优先用 Inspector 指定的字段，但会校验卡牌确实在该战场中。 */
    private fieldOf(card: Node, preferred: BattleFieldLayout | null): BattleFieldLayout | null {
        // 🔴 必须校验「卡仍在该战场的逻辑集合里」：
        //    「逻辑已被破坏、破坏演出未完」的卡节点还挂在战场节点下，只靠父链会误判它还活着 ——
        //    于是它仍会被当成可攻击目标 / 参与守护。containsCard 是唯一判据。
        if (preferred && preferred.isValid && preferred.containsCard(card)) return preferred;
        let n: Node | null = card.parent;
        while (n) {
            const field = n.getComponent(BattleFieldLayout);
            if (field && field.isValid) return field.containsCard(card) ? field : null;
            n = n.parent;
        }
        return null;
    }
}
