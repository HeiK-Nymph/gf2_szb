import { _decorator, Component, Node } from 'cc';
import { BattleCommandSystem } from './BattleCommandSystem';
import { BattleFieldLayout, BattleSide } from './BattleFieldLayout';
import { BattleRuleSystem } from './BattleRuleSystem';
import { activateAmulet, cardTargetRequest, findComponent } from './CardAbilitySystem';
import { cardIdFromNodeName } from './CardGlow';
import { canAffordPP, ppRemaining } from './CardPlay';
import { getCardInfo, maxEnhanceOf } from './CardData';
import { EnemyCardPlay } from './EnemyCardPlay';
import { EnemyHandLayout } from './EnemyHandLayout';
import { EvoPointKind } from './EvoPointBadge';
import { EvoPointSystem } from './EvoPointSystem';
import { evolveFollower, evolveTuningOf } from './FollowerEvolve';
import { HeroArea, HeroSide } from './HeroArea';
import { AiHandCard, AiOptions, AiPlan, AiState, AiUnit, planTurn, scoreState } from './AiPlan';

const { ccclass, property, menu } = _decorator;

/** AI 在一个敌方回合内的行动阶段（严格顺序：出牌 → 启动 → 进化 → 攻击 → 结束回合） */
type AiPhase = 'play' | 'activate' | 'evolve' | 'attack' | 'end' | 'done';

/** 需要从真实节点上读出来的关键字（英文键，与 CardKeywordSystem / BattleRuleSystem 同一份真源） */
const AI_KEYWORDS = [
    'Guard', 'Rush', 'Charge', 'Bane', 'Barrier', 'Deter', 'Ambush', 'Aura', 'AbilityDestroyImmune',
];

/**
 * EnemyBattleAI —— 敌方人机的**回合驱动器**
 * ===========================================================================
 * 挂在敌方手牌区节点（`Canvas/EnemyHandArea`，与 `EnemyCardPlay` 同节点）上。
 *
 * 🔴 **决策与执行分离**：
 *   · 决策 = `AiPlan.planTurn(快照, 规则参数)`（纯函数：能斩杀 → 解场 + 铺场 → 保场 + 资源交换）；
 *   · 执行 = 本组件按计划逐步调用「双方共用的底层 API」：
 *       - 出牌 `EnemyCardPlay.playCardAt(index)`（含费用 / 爆能强化 / 入场曲 / 法术，目标自动选）；
 *       - 启动 `CardAbilitySystem.activateAmulet(host, card, 'enemy')`（1 回合 1 次 + 花能量点）；
 *       - 进化 `FollowerEvolve.evolveFollower(this, card, 'enemy', …)`；
 *       - 攻击 `BattleCommandSystem.enqueueAttack(attacker, defender)`；
 *       - 结束回合 `TurnManager.endEnemyTurn()`。
 *
 * 🔴 **每一步都重新规划**：真实结算可能偏离预估（入场曲召唤 / 抽牌 / 交战时能力 / 谢幕曲…），
 *    所以每个动作执行前都用**当前真实局面**重算一次计划，只执行计划的第一步 —— 这样 AI 永远
 *    跟着真实战况走，不会拿着过期计划硬打。
 *
 * 🔴 **所有动作都会在执行前用真实规则复核**（`canAffordPP` / `canTarget` / 战场容量），
 *    被拒绝就记一次失败、下一步重规划；连续失败直接收尾，绝不死循环。
 *
 * `autoDrive` **默认打开**（敌方回合自动行动），运行时可随时切换：
 *    Inspector 勾选、测试控制台的「AI: 开/关」按钮、或脚本里 `ai.autoDrive = false`。
 * ===========================================================================
 */
@ccclass('EnemyBattleAI')
@menu('gf2szb/EnemyBattleAI')
export class EnemyBattleAI extends Component {

    // ====================== 开关 ======================
    @property({
        tooltip: '总开关：**默认打开** —— 敌方操作回合由本组件自动驱动（出牌 → 启动 → 进化 → 攻击 → 结束回合）。\n'
            + '关闭 = 完全不插手（敌方回合靠测试台「结束敌方回合」或外部脚本手动推进）。',
    })
    autoDrive = true;

    @property({ tooltip: '是否自动出牌（由决策内核按「斩杀 / 解场 / 铺场 / 资源」挑牌，不再是「从最左逐张尝试」）' })
    autoPlay = true;

    @property({ tooltip: '是否自动启动护符的「启动」能力（1 回合 1 次 + 要花能量点，由内核按收益决定）' })
    autoActivate = true;

    @property({ tooltip: '是否自动进化（普通 / 超进化都由内核按收益挑目标；需要选目标的能力自动选）' })
    autoEvolve = true;

    @property({ tooltip: '是否自动攻击（每只随从每回合一次，规则与人类完全一致）' })
    autoAttack = true;

    @property({ tooltip: '行动结束后是否自动结束敌方回合（关闭 = 留在敌方回合等外部结束）' })
    autoEndTurn = true;

    // ====================== 参数 ======================
    @property({
        range: [0.1, 3, 0.05], slide: true,
        tooltip: '每步之间的间隔（秒）—— AI 的「思考 / 演出等待」时间，越大越慢越好观察。',
    })
    stepInterval = 0.7;

    @property({
        range: [1, 10, 1], slide: true,
        tooltip: '每个敌方回合最多打出几张手牌（内核会在这个上限内按收益挑牌）。',
    })
    maxPlaysPerTurn = 5;

    @property({
        range: [10, 500, 10], slide: true,
        tooltip: '每步决策的搜索时间上限（毫秒）—— 越大算得越深（攻击序列搜索）。',
    })
    thinkBudgetMs = 90;

    @property({ tooltip: '打印 AI 决策日志' })
    verbose = true;

    // ====================== 内部状态 ======================
    private _phase: AiPhase = 'play';
    private _engaged = false;
    private _wait = 0;
    private _played = 0;
    private _activations = 0;
    private _evolveTried = false;
    private _evolveRequested = false;
    /** 本回合出牌失败过的下标（不让内核反复推荐同一张打不出去的牌） */
    private _blockedPlays: number[] = [];
    /** 连续失败计数（出牌 / 攻击）→ 兜底收尾，防死循环 */
    private _failStreak = 0;
    /** 最近一次计划（日志 / 探针用） */
    private _lastPlan: AiPlan | null = null;
    /** 本组件是否已经提交过结束回合（自愈用；不再依赖 tm.isTurnEnding） */
    private _endSubmitted = false;
    private _endSubmittedAt = 0;
    /** 本回合判定「打不了 / 打不划算」而放弃的随从（避免连续失败把整个回合收尾） */
    private _blockedAttackers: string[] = [];
    /** 本回合决策异常计数（连续 5 次才收尾，避免一次异常就整回合不动） */
    private _decideErrors = 0;

    // ====================== 生命周期 ======================
    protected update(dt: number): void {
        try {
            if (!this.autoDrive) return;
            const tm = this.comp('TurnManager') as
                { isRunning?: boolean; isEnemyTurn?: boolean; isTurnEnding?: boolean } | null;
            if (!tm || tm.isRunning !== true || tm.isEnemyTurn !== true) {
                this._engaged = false;
                return;
            }
            // 🔴 只有「**本组件自己**提交了结束回合」才停手。
            //    以前这里无条件看 tm.isTurnEnding —— 只要这个标记因任何原因残留，AI 就会整回合
            //    一步都不走（用户实测：进化点没用、能解的没解、能打脸的不打，直接结束回合）。
            if (this._endSubmitted) {
                // 自愈：提交了结束回合但 6s 都没真正切换回合 → 重新提交一次（结束流程可能被掐断过）
                if (Date.now() - this._endSubmittedAt > 6000) {
                    this._endSubmitted = false;
                    if (this.verbose) console.warn('[EnemyAI] 结束回合 6s 未生效 → 重新提交');
                } else {
                    this._engaged = false;
                    return;
                }
            }
            if (!this._engaged) {
                this._engaged = true;
                this._phase = 'play';
                this._wait = 0;
                this._played = 0;
                this._activations = 0;
                this._evolveTried = false;
                this._evolveRequested = false;
                this._blockedPlays = [];
                this._blockedAttackers = [];
                this._failStreak = 0;
                this._decideErrors = 0;
                this._endSubmitted = false;
                if (this.verbose) {
                    console.log('[EnemyAI] ▶ 接管敌方回合');
                    console.log('[EnemyAI] 局面评估：' + this.previewLine());
                }
            }
            if (this._phase === 'done') return;
            this._wait += dt;
            if (this._wait < Math.max(0.05, this.stepInterval)) return;
            this._wait = 0;
            this.step();
        } catch (e) {
            console.error('[EnemyAI] update 异常（本步跳过）：', e);
        }
    }

    /** 走一步（一次只做一个动作；异常一律熔断到「结束回合」阶段） */
    private step(): void {
        try {
            switch (this._phase) {
                case 'play':    return this.stepPlay();
                case 'activate': return this.stepActivate();
                case 'evolve':  return this.stepEvolve();
                case 'attack':  return this.stepAttack();
                case 'end':
                    this.stepEndTurn();
                    this._phase = 'done';
                    return;
                default: return;
            }
        } catch (e) {
            // 🔴 决策异常必须自己消化掉再重试（否则表现就是「AI 什么都不做、直接结束回合」，极难查）
            console.error('[EnemyAI] 决策异常（本步跳过，下一步重试）：', e);
            this._decideErrors++;
            if (this._decideErrors >= 5) {
                console.error('[EnemyAI] 决策连续异常 ' + this._decideErrors + ' 次 → 收尾本回合');
                this._phase = 'end';
            }
        }
    }

    // ------------------------------ ① 出牌 ------------------------------
    private stepPlay(): void {
        const play = this.enemyPlay();
        if (!this.autoPlay || !play) { this._phase = 'activate'; return; }
        if (play.isPlaying) return;                                  // 上一张还在演出 → 等
        const plan = this.plan();
        if (!plan) { this._phase = 'activate'; return; }
        // ★ 斩杀优先：现有场面就能打死对方主战者 ⇒ 不出牌、不启动、不进化，直接进攻击阶段
        if (plan.lethalNow) {
            if (this.verbose) console.log('[EnemyAI] 斩杀优先 → 跳过出牌，直接攻击');
            this._phase = 'attack';
            return;
        }
        const idx = this.pickPlayableIndex(plan);
        if (idx === null) { this._phase = 'activate'; return; }
        // ★「模式」类卡牌：把决策内核试算出的最优选项下发给真实出牌流程（缺省 = 默认第 1 个）
        const modePick = plan.modePicks ? plan.modePicks[idx] : undefined;
        play.setFanfareMode(typeof modePick === 'number' ? modePick : -1);
        // 先记下这张牌（打出去之后手牌集合里就没有它了，下标会失效）
        const handForLog = this.enemyHand();
        const cardNode = handForLog ? handForLog.cards[idx] : null;
        const logId = cardNode && handForLog ? handForLog.cardIdOf(cardNode) : '';
        const logInfo = logId ? getCardInfo(logId) : undefined;
        if (!play.playCardAt(idx)) {
            this._blockedPlays.push(idx);
            if (this.verbose) console.warn('[EnemyAI] 出牌被拒（下标 ' + idx + '）→ 本回合不再考虑这张牌');
            // 只封这一张牌继续尝试别的（不要因为一张牌打不出去就收掉整个回合）
            if (this.pickPlayableIndex(plan) === null) this._phase = 'activate';
            return;
        }
        this._played++;
        this._failStreak = 0;
        if (this.verbose) {
            console.log(`[EnemyAI] 出牌：${logInfo ? logInfo.cardName : logId}（费用 ${logInfo ? logInfo.cost : '?'}，`
                + `剩余 PP ${ppRemaining(this.node, 'enemy')}）`);
        }
    }

    /** 计划里的出牌序列里挑第一步（跳过失败过的下标） */
    private pickPlayableIndex(plan: AiPlan): number | null {
        for (const i of plan.plays) if (this._blockedPlays.indexOf(i) < 0) return i;
        return null;
    }

    // ------------------------------ ② 启动护符 ------------------------------
    private stepActivate(): void {
        if (!this.autoActivate || this._activations >= 3) { this._phase = 'evolve'; return; }
        const plan = this.plan();
        if (plan && plan.lethalNow) { this._phase = 'attack'; return; }
        if (!plan || !plan.activate) { this._phase = 'evolve'; return; }
        const card = this.nodeByKey(plan.activate);
        if (!card) { this._phase = 'evolve'; return; }
        const ok = this.tryActivateAmulet(card);
        if (this.verbose) console.log(`[EnemyAI] 启动护符 ${card.name} → ${ok ? '已发动' : '被拒/无合法目标'}`);
        this._activations++;
        if (!ok) this._phase = 'evolve';                    // 拒绝就别再试同类护符
    }

    /**
     * 尝试启动一个己方护符（走共用入口 `activateAmulet`：门槛 / 费用 / 1 回合 1 次都在那里判）。
     * 供 AI 步骤与自动化测试调用。
     */
    public tryActivateAmulet(card: Node | null): boolean {
        if (!card || !card.isValid) return false;
        return activateAmulet(this, card, 'enemy') === true;
    }

    // ------------------------------ ③ 进化 ------------------------------
    private stepEvolve(): void {
        if (!this.autoEvolve) { this._phase = 'attack'; return; }
        // ★ 斩杀优先：不为进化浪费时间 / 进化点
        { const p = this.plan(); if (p && p.lethalNow) { this._phase = 'attack'; return; } }
        if (this._evolveRequested) {
            // 已发起 → 等进化演出（+ 进化时能力）播完再进攻击阶段
            if (this.presentationBusy()) return;
            this._phase = 'attack';
            return;
        }
        const evo = this.evoSystem();
        if (!evo || evo.hasUsedEvolveThisTurn('enemy')) { this._phase = 'attack'; return; }
        const plan = this.plan();
        if (!plan || !plan.evolve) { this._phase = 'attack'; return; }
        const card = this.nodeByKey(plan.evolve.key);
        if (!card) { this._phase = 'attack'; return; }
        const isSuper = plan.evolve.superEvolve;
        const kind = isSuper ? EvoPointKind.SEP : EvoPointKind.EP;
        if (!evo.isUsable('enemy', kind)) { this._phase = 'attack'; return; }

        this._evolveRequested = true;
        this._evolveTried = true;
        const id = cardIdFromNodeName(card.name);
        const req = id ? cardTargetRequest(id, isSuper ? ['evolve', 'superEvolve'] : ['evolve'], 'enemy') : null;
        const target = req ? this.autoPick('enemy', req.select, req.filter) : null;
        const ok = evolveFollower(this, card, 'enemy', {
            kind, target, verbose: this.verbose, inPlace: true,
            onDone: () => { if (this.verbose) console.log('[EnemyAI] 进化演出 + 进化时能力结算完毕'); },
        });
        if (this.verbose) {
            console.log(`[EnemyAI] 进化：${card.name}（${isSuper ? '超进化' : '普通进化'}）`
                + ` → ${ok ? '已触发' : '被拒绝'}；进化时能力目标=${target ? target.name : '（无）'}`);
        }
        if (!ok) this._phase = 'attack';
    }

    // ------------------------------ ④ 攻击 ------------------------------
    private stepAttack(): void {
        if (!this.autoAttack) { this._phase = 'end'; return; }
        if (this.presentationBusy()) return;                 // 演出中 → 等它播完再下指令
        const rules = this.rules();
        const cmd = this.commandSystem();
        if (!rules) { this._phase = 'end'; return; }
        const plan = this.plan();
        if (!plan || plan.attacks.length === 0) { this._phase = 'end'; return; }
        const usable = plan.attacks.filter((a) => this._blockedAttackers.indexOf(a.attacker) < 0);
        if (usable.length === 0) { this._phase = 'end'; return; }
        const act = usable[0];
        const attacker = this.nodeByKey(act.attacker);
        const defender = act.target ? this.nodeByKey(act.target) : this.playerHeroNode();
        if (!attacker || !defender || rules.canTarget(attacker, defender) !== true) {
            if (this._blockedAttackers.indexOf(act.attacker) < 0) this._blockedAttackers.push(act.attacker);
            if (this.verbose) console.warn('[EnemyAI] 攻击计划失效（目标非法）→ 本回合先不派这只随从攻击');
            return;
        }
        if (this.verbose) {
            const a = rules.getAttack(attacker);
            console.log(`[EnemyAI] 攻击：${attacker.name}（攻 ${a ?? '?'}）→ ${defender.name || '主战者'}`);
        }
        if (cmd && typeof cmd.enqueueAttack === 'function') {
            const res = cmd.enqueueAttack(attacker, defender);
            if (res && res.accepted === false) {
                if (this._blockedAttackers.indexOf(act.attacker) < 0) this._blockedAttackers.push(act.attacker);
                if (this.verbose) console.warn('[EnemyAI] 指令被拒：' + res.reason);
                return;
            }
        } else {
            rules.resolveCombat(attacker, defender);          // 兜底：直接结算
        }
        this._failStreak = 0;
    }

    // ------------------------------ ⑤ 结束回合 ------------------------------
    /**
     * 提交结束敌方回合。
     * 🔴 这里**不自己判断演出忙不忙**：`TurnManager.endEnemyTurn()` 会把「真正切换回合」
     *    排到所有演出 / 动画之后（并在这段时间锁死本方交互）。
     */
    private stepEndTurn(): void {
        if (!this.autoEndTurn) return;
        const tm = this.comp('TurnManager') as
            { endEnemyTurn?: () => boolean; isTurnEnding?: boolean } | null;
        if (!tm || typeof tm.endEnemyTurn !== 'function') return;
        const ok = tm.endEnemyTurn();
        if (ok !== false) { this._endSubmitted = true; this._endSubmittedAt = Date.now(); }
        if (this.verbose) {
            console.log(`[EnemyAI] 提交结束敌方回合 → ${ok ? '已提交（等演出播完再切换回合）' : '失败（已不是敌方回合）'}`);
        }
    }

    // ====================== 决策：建快照 → 规划 ======================
    /** 用**当前真实局面**算一份计划（null = 局面不完整 / 未开战） */
    public plan(): AiPlan | null {
        const st = this.snapshot();
        if (!st) return null;
        const plan = planTurn(st, this.aiOptions());
        this._lastPlan = plan;
        return plan;
    }

    /** 供测试 / 探针：当前局面的评分（越大越好；用于对比两种打法的收益） */
    public debugScore(): number {
        const st = this.snapshot();
        if (!st) return 0;
        return scoreState(st);
    }

    /** 供测试 / 控制台：打印「当前局面会怎么打」（不执行任何动作） */
    public previewLine(): string {
        const st = this.snapshot();
        if (!st) return '（局面不可用）';
        const plan = planTurn(st, this.aiOptions());
        this._lastPlan = plan;
        const nameOf = (key: string): string => {
            if (key === 'HERO') return '主战者';
            const u = st.me.concat(st.foe).find((x) => x.key === key);
            return u ? u.name : key.slice(0, 12);
        };
        const plays = plan.plays.map((i) => {
            const c = st.hand.find((x) => x.index === i);
            return c ? c.name : ('#' + i);
        });
        const attacks = plan.attacks.map((a) => `${nameOf(a.attacker)}→${a.target ? nameOf(a.target) : '主战者'}`);
        const modes = Object.keys(plan.modePicks || {}).map((k) => `#${k}→选项${(plan.modePicks[Number(k)] || 0) + 1}`).join('、');
        return `我的场面 ${st.me.length} 只 / 对手 ${st.foe.length} 只；`
            + `HP ${st.myHero} vs ${st.foeHero}；PP ${st.pp}/${st.ppMax}；`
            + `出牌[${plays.join('、')}]` + (modes ? ` 模式[${modes}]` : '') + ` 启动[${plan.activate ? nameOf(plan.activate) : '无'}] `
            + `进化[${plan.evolve ? nameOf(plan.evolve.key) + (plan.evolve.superEvolve ? '(超)' : '') : '无'}] `
            + `攻击[${attacks.join('、')}] → ${plan.reason}`;
    }

    /** 真实局面 → 决策内核的快照 */
    private snapshot(): AiState | null {
        const rules = this.rules();
        const kw = this.comp('CardKeywordSystem') as {
            hasKeyword?: (n: Node, k: string) => boolean;
            canAttackFollower?: (n: Node) => boolean;
            canAttackHero?: (n: Node) => boolean;
        } | null;
        const myField = this.enemyField();
        const foeField = this.playerField();
        const myHero = this.enemyHero();
        const foeHero = this.playerHero();
        if (!rules || !myField || !foeField || !myHero || !foeHero) return null;
        const panel = this.comp('TurnControlPanel') as
            { enemyCurrentPP?: number; enemyMaxPP?: number } | null;
        const hand = this.enemyHand();

        const toUnit = (n: Node, order: number): AiUnit => {
            const id = cardIdFromNodeName(n.name) || '';
            const info = id ? getCardInfo(id) : undefined;
            const attacksLeft = rules.attacksLeft(n) ?? 0;
            const keywords: string[] = [];
            if (kw && typeof kw.hasKeyword === 'function') {
                for (const k of AI_KEYWORDS) if (kw.hasKeyword(n, k) === true) keywords.push(k);
            }
            if (attacksLeft >= 2 && keywords.indexOf('MultiAttack') < 0) keywords.push('MultiAttack');
            const isFollower = !!info && info.cardType === 'Follower';
            const canAtkUnit = isFollower && attacksLeft > 0
                && (!kw || typeof kw.canAttackFollower !== 'function' || kw.canAttackFollower(n) === true);
            const canAtkHero = isFollower && attacksLeft > 0
                && (!kw || typeof kw.canAttackHero !== 'function' || kw.canAttackHero(n) === true);
            return {
                key: n.uuid,
                cardId: id,
                name: info ? info.cardName : n.name,
                atk: Math.max(0, Math.round(rules.getAttack(n) ?? 0)),
                hp: Math.max(0, Math.round(rules.getHp(n) ?? 0)),
                maxHp: Math.max(0, Math.round(rules.getMaxHp(n) ?? rules.getHp(n) ?? 0)),
                keywords,
                isFollower,
                order,
                canAttackUnit: canAtkUnit,
                canAttackHero: canAtkHero,
                attacksLeft: Math.max(0, Math.round(attacksLeft)),
                superEvolved: rules.isSuperEvolved(n) === true,
                evolved: rules.isEvolved(n) === true,
                chantTurns: kw && typeof (kw as unknown as { chantTurnsOf?: (x: Node) => number }).chantTurnsOf === 'function'
                    ? Math.max(0, Math.round((kw as unknown as { chantTurnsOf: (x: Node) => number }).chantTurnsOf(n)))
                    : 0,
            };
        };

        const handCards: AiHandCard[] = [];
        if (hand) {
            for (let i = 0; i < hand.cards.length; i++) {
                const id = hand.cardIdOf(hand.cards[i]);
                if (!id) continue;
                const info = getCardInfo(id);
                if (!info) continue;
                handCards.push({
                    index: i, cardId: id, name: info.cardName,
                    type: info.cardType, cost: Math.max(0, Math.round(info.cost)),
                    enhanceValue: maxEnhanceOf(id),
                });
            }
        }

        return {
            me: myField.cardsByEntryOrder().map((n, i) => toUnit(n, i)),
            foe: foeField.cardsByEntryOrder().map((n, i) => toUnit(n, i)),
            myHero: Math.max(0, Math.round(myHero.hp)),
            myHeroMax: Math.max(1, Math.round(myHero.maxHp)),
            foeHero: Math.max(0, Math.round(foeHero.hp)),
            foeHeroMax: Math.max(1, Math.round(foeHero.maxHp)),
            pp: Math.max(0, Math.round(ppRemaining(this.node, 'enemy') ?? 0)),
            ppMax: Math.max(0, Math.round(panel?.enemyMaxPP ?? 0)),
            hand: handCards,
            maxCards: Math.max(1, Math.round(myField.maxCards)),
            playsLeft: Math.max(0, Math.round(this.maxPlaysPerTurn - this._played)),
            draws: 0,
            crests: 0,
            coop: Math.max(0, Math.round(rules.cooperationOf('enemy') ?? 0)),
            foeDraws: 0,
            foeCrests: 0,
            modePick: -1,
        };
    }

    /** 决策内核需要的规则参数 */
    private aiOptions(): AiOptions {
        const rules = this.rules();
        const evo = this.evoSystem();
        const field = this.enemyField();
        const tuning = evolveTuningOf(this);
        const usable = (kind: EvoPointKind): boolean => {
            if (!evo) return false;
            if (evo.hasUsedEvolveThisTurn('enemy')) return false;
            return evo.isUsable('enemy', kind) === true;
        };
        return {
            maxCards: field ? Math.max(1, Math.round(field.maxCards)) : 5,
            maxPlays: Math.max(0, Math.round(this.maxPlaysPerTurn - this._played)),
            evolveAttack: tuning.attackGain,
            evolveHp: tuning.hpGain,
            superAttack: tuning.superAttackGain,
            superHp: tuning.superHpGain,
            evolveKeyword: tuning.keyword,
            superEvolveBreakHeroDamage: Math.max(0, Math.round(
                (rules as unknown as { superEvolveBreakHeroDamage?: number })?.superEvolveBreakHeroDamage ?? 1)),
            // 🔴 规划必须与执行保持一致：开关关掉时，计划里就不能再出现「进化后才成立」的路线
            canEvolve: this.autoEvolve && usable(EvoPointKind.EP),
            canSuperEvolve: this.autoEvolve && usable(EvoPointKind.SEP),
            timeBudgetMs: this.thinkBudgetMs,
        };
    }

    /**
     * 还有动画 / 演出在播吗（**进化特效** + 指令演出队列）。
     * 🔴 进化这类特效**不在** `BattleCommandSystem` 的 cue 队列里，必须单独看它的 `isPlaying`。
     */
    private presentationBusy(): boolean {
        const fx = this.comp('EvolveFollowerFx') as { isPlaying?: boolean } | null;
        if (fx && fx.isPlaying) return true;
        const cmd = this.commandSystem();
        if (cmd && cmd.isIdle !== true) return true;
        return false;
    }

    // ------------------------------ 依赖解析 ------------------------------
    /** 全场景 BFS 按类名取组件（缓存；失效自动重查） */
    private comp(className: string): any {
        const hit = this._fnCache[className];
        if (hit && hit.isValid) return hit;
        const c = findComponent(this, className);
        this._fnCache[className] = c;
        return c;
    }
    private readonly _fnCache: Record<string, any> = {};

    private rules(): BattleRuleSystem | null {
        return this.comp('BattleRuleSystem') as BattleRuleSystem | null;
    }

    private commandSystem(): BattleCommandSystem | null {
        return this.comp('BattleCommandSystem') as BattleCommandSystem | null;
    }

    private evoSystem(): EvoPointSystem | null {
        return this.comp('EvoPointSystem') as EvoPointSystem | null;
    }

    private enemyPlay(): EnemyCardPlay | null {
        return this.comp('EnemyCardPlay') as EnemyCardPlay | null;
    }

    private enemyHand(): EnemyHandLayout | null {
        return this.comp('EnemyHandLayout') as EnemyHandLayout | null;
    }

    /** 敌方战场（side = Enemy） */
    private enemyField(): BattleFieldLayout | null {
        return this.fieldBySide(BattleSide.Enemy);
    }

    /** 我方（玩家）战场 */
    private playerField(): BattleFieldLayout | null {
        return this.fieldBySide(BattleSide.Player);
    }

    private fieldBySide(side: BattleSide): BattleFieldLayout | null {
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

    private heroOf(side: HeroSide): HeroArea | null {
        const scene = this.node.scene as unknown as Node | null;
        if (!scene) return null;
        const stack: Node[] = [...scene.children];
        while (stack.length > 0) {
            const cur = stack.shift() as Node;
            const h = cur.getComponent(HeroArea);
            if (h && h.isValid && h.side === side) return h;
            for (const ch of cur.children) stack.push(ch);
        }
        return null;
    }

    /** 敌方主战者（= 我的英雄） */
    private enemyHero(): HeroArea | null {
        return this.heroOf(HeroSide.Enemy);
    }

    /** 玩家主战者（= 敌方的攻击目标） */
    private playerHero(): HeroArea | null {
        return this.heroOf(HeroSide.Player);
    }

    private playerHeroNode(): Node | null {
        const h = this.playerHero();
        return h ? h.node : null;
    }

    /** 按快照里的 key（节点 uuid）回查真实节点 */
    private nodeByKey(key: string): Node | null {
        const scene = this.node.scene as unknown as Node | null;
        if (!scene || !key) return null;
        const stack: Node[] = [...scene.children];
        while (stack.length > 0) {
            const cur = stack.shift() as Node;
            if (cur.uuid === key) return cur;
            for (const ch of cur.children) stack.push(ch);
        }
        return null;
    }

    /** 自动选目标（与我方选择模式同一套候选口径） */
    private autoPick(owner: 'player' | 'enemy', select: string, filter = ''): Node | null {
        const sys = this.comp('TargetSelectSystem') as TargetSelectSystem | null;
        if (!sys) return null;
        return sys.autoPick(owner, select, filter);
    }
}
