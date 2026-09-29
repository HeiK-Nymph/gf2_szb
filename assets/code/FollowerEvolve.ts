import { Component, Node } from 'cc';
import { BattleSide } from './BattleFieldLayout';
import { BattleRuleSystem } from './BattleRuleSystem';
import { CardAbilitySide, findComponent, runCardEvolveAbilities } from './CardAbilitySystem';
import { CardKeywordSystem } from './CardKeywordSystem';
import { cardIdFromNodeName } from './CardGlow';
import { EvoPointKind } from './EvoPointBadge';
import { EvoPointSystem, EvoSide } from './EvoPointSystem';

/**
 * FollowerEvolve —— 「随从进化」的**底层操作**（我方交互与敌方 AI 共用同一份实现）
 * ===========================================================================
 * 为什么单独抽出来：进化不再只是「玩家拖进化点」这一个入口 —— 敌方人机也要能进化，
 * 而「扣点 → 加数值 → 打标记 → 授关键词 → 播动画 → **动画播完**再结算进化时能力」
 * 这条链路对两方**必须完全一致**。这里就是这条链路的唯一实现：
 *
 *   · 我方：`EvoDragController.doEvolve` → `evolveFollower(this, card, 'player', {…})`
 *   · 敌方：`EnemyBattleAI`（或任何脚本）→ `evolveFollower(this, card, 'enemy', {…})`
 *
 * 🔴 顺序铁律（与策划口径一致）：
 *   ① `canEvolve` 通过 → ② **先 consume 成功**才改数值（避免「点没扣但随从变强」）
 *   → ③ 数值走 `beginDeferredDisplay / addStats / endDeferredDisplay`（数字**延迟显示**，
 *      等动画转到 630° 才由特效组件 applyDisplayBatch 写卡面）→ ④ `markEvolved`
 *   → ⑤ 授予进化词条（如突进）→ ⑥ 播进化动画 → ⑦ **动画播完**才结算进化时能力。
 * ===========================================================================
 */

/** 进化的数值 / 词条编制（默认值 = 我方 `EvoDragController` 的 Inspector 默认值） */
export interface EvolveTuning {
    /** 普通进化：攻击 +N */
    attackGain: number;
    /** 普通进化：血量 +N */
    hpGain: number;
    /** 超进化：攻击 +N */
    superAttackGain: number;
    /** 超进化：血量 +N */
    superHpGain: number;
    /** 进化授予的词条（普通进化与超进化都授；空字符串 = 不授） */
    keyword: string;
}

/** 默认编制：普通 +2/+2、超进化 +3/+3、授予「突进」 */
export const DEFAULT_EVOLVE_TUNING: EvolveTuning = {
    attackGain: 2, hpGain: 2, superAttackGain: 3, superHpGain: 3, keyword: 'Rush',
};

/**
 * 取当前对局生效的进化编制：**优先读 `EvoDragController` 的 Inspector 值**
 * （敌我共用同一套数字；找不到该组件才退回默认值）。
 */
export function evolveTuningOf(host: Component): EvolveTuning {
    const drag = findComponent(host, 'EvoDragController') as {
        evolveAttackGain?: number; evolveHpGain?: number;
        superAttackGain?: number; superHpGain?: number; evolveKeyword?: string;
    } | null;
    if (!drag) return { ...DEFAULT_EVOLVE_TUNING };
    const num = (v: unknown, fb: number): number => (typeof v === 'number' && isFinite(v) ? v : fb);
    return {
        attackGain: num(drag.evolveAttackGain, DEFAULT_EVOLVE_TUNING.attackGain),
        hpGain: num(drag.evolveHpGain, DEFAULT_EVOLVE_TUNING.hpGain),
        superAttackGain: num(drag.superAttackGain, DEFAULT_EVOLVE_TUNING.superAttackGain),
        superHpGain: num(drag.superHpGain, DEFAULT_EVOLVE_TUNING.superHpGain),
        keyword: typeof drag.evolveKeyword === 'string' ? drag.evolveKeyword : DEFAULT_EVOLVE_TUNING.keyword,
    };
}

/** 一次进化请求 */
export interface EvolveRequest {
    /** 用哪种进化点：`EvoPointKind.EP` = 普通进化、`SEP` = 超进化 */
    kind: EvoPointKind;
    /** 进化时能力要用的目标随从（我方 = 玩家选的 / 敌方 = AI 自动选的）；没有传 null */
    target?: Node | null;
    /** 覆盖编制（不传 = 用 `evolveTuningOf(host)` 读到的对局编制） */
    tuning?: Partial<EvolveTuning>;
    /** 打印日志 */
    verbose?: boolean;
    /** ★ 自动进化用：**原地**播进化动画（不飞到屏幕中央）；不传 = 手动拖拽的默认演出 */
    inPlace?: boolean;
    /** 动画播完 + 进化时能力结算完之后（AI 串流程用；异常路径也会回调） */
    onDone?: (ok: boolean, isSuper: boolean) => void;
}

/**
 * 让某个随从进化（**敌我通用**，见文件头）。
 *
 * @param host 调用方组件（用于全场景查找规则 / 进化点 / 特效等依赖）
 * @param card 要进化的**战场随从**节点
 * @param side 归属方（`'player'` / `'enemy'`）—— 会校验该随从确实在该方战场上
 * @returns 是否成功触发（false = 依赖缺失 / 阵营不符 / 不可进化 / 进化点不可用）
 */
export function evolveFollower(
    host: Component,
    card: Node,
    side: CardAbilitySide,
    req: EvolveRequest,
): boolean {
    const rules = findComponent(host, 'BattleRuleSystem') as BattleRuleSystem | null;
    const evo = findComponent(host, 'EvoPointSystem') as EvoPointSystem | null;
    if (!rules || !evo) {
        console.warn('[FollowerEvolve] 找不到 BattleRuleSystem / EvoPointSystem，无法进化');
        return false;
    }
    if (!card || !card.isValid) return false;

    // 🔴 阵营校验：这张牌必须真的在**该方**战场上（防止把对面随从进化了）
    const want = side === 'player' ? BattleSide.Player : BattleSide.Enemy;
    if (rules.sideOfCard(card) !== want) {
        if (req.verbose) console.log(`[FollowerEvolve] ${card.name} 不在 ${side} 的战场上，拒绝进化`);
        return false;
    }
    if (rules.canEvolve(card) !== true) {
        if (req.verbose) console.log('[FollowerEvolve] 该随从不可进化（已进化过 / 不是随从）');
        return false;
    }

    // ① 先扣点（成功才继续；一回合一次的规则也在 consume 里）
    if (!evo.consume(side as EvoSide, req.kind)) return false;

    const tuning = { ...evolveTuningOf(host), ...(req.tuning || {}) };
    const isSuper = req.kind === EvoPointKind.SEP;
    const atkGain = isSuper ? tuning.superAttackGain : tuning.attackGain;
    const hpGain = isSuper ? tuning.superHpGain : tuning.hpGain;

    // ② 数值：逻辑当场变，卡面数字延迟到动画里写（见文件头 ③）
    rules.beginDeferredDisplay();
    rules.addStats(card, atkGain, hpGain);
    const display = rules.endDeferredDisplay();
    // ③ 打标记（进化过的不能再进化）
    rules.markEvolved(card, isSuper);
    // ③.5 🔴 **进化 / 超进化动画期间只保留最基础的战场卡牌样式**（需求）：
    //     在授予进化词条**之前**就抑制，否则新词条的光晕会先闪一下再被藏起来。
    //     隐藏项 = 潜行烟雾 / 守护护盾 / 威慑光圈 / 吟唱角标 / 词条光晕（见 CardKeywordSystem.setFxSuppressed）。
    const kw = findComponent(host, 'CardKeywordSystem') as CardKeywordSystem | null;
    const suppressFx = (on: boolean): void => {
        if (kw && typeof kw.setFxSuppressed === 'function') kw.setFxSuppressed(card, on);
    };
    suppressFx(true);
    // ④ 授予进化词条（如突进）
    if (kw && tuning.keyword && typeof kw.addKeyword === 'function') {
        kw.addKeyword(card, tuning.keyword);
    }
    if (req.verbose) {
        console.log(`[FollowerEvolve] ${side} ${isSuper ? '超进化' : '进化'}完成 → ${card.name}`
            + `（+${atkGain}/+${hpGain}${tuning.keyword ? ' + ' + tuning.keyword : ''}`
            + `${isSuper ? ' + 己方回合伤害无效' : ''}）`);
    }

    // ⑤ 动画 → ⑥ 动画播完再结算进化时能力
    const done = (): void => {
        runEvolveAbilities(host, card, side, isSuper, req.target ?? null);
        // ⑥.5 演出结束：把词条特效按当前词条重新挂回来（潜行烟雾 / 护盾 / 光圈 / 角标 / 光晕）
        suppressFx(false);
        if (req.onDone) {
            try { req.onDone(true, isSuper); } catch (e) { console.error('[FollowerEvolve] onDone 抛错：', e); }
        }
    };
    const fx = findComponent(host, 'EvolveFollowerFx') as
        {
            play?: (c: Node, s: boolean, d: unknown, cb?: () => void) => void;
            playInPlace?: (c: Node, s: boolean, d: unknown, cb?: () => void) => void;
        } | null;
    // ★ 自动进化（req.inPlace）优先走「原地」演出；没有该方法时退回默认演出
    if (fx && req.inPlace && typeof fx.playInPlace === 'function') fx.playInPlace(card, isSuper, display, done);
    else if (fx && typeof fx.play === 'function') fx.play(card, isSuper, display, done);
    else done();
    return true;
}

/**
 * 结算进化时能力（普通进化 → `evolve`；超进化 → `evolve` + `superEvolve`）。
 * 🔴 **必须等进化动画播完**再调用（需求：先触发进化，等进化结束后再触发进化时效果）。
 */
export function runEvolveAbilities(
    host: Component,
    card: Node,
    side: CardAbilitySide,
    isSuper: boolean,
    target: Node | null,
): void {
    if (!card || !card.isValid) return;
    const id = cardIdFromNodeName(card.name);
    if (!id) return;
    try {
        runCardEvolveAbilities(host, id, side, isSuper, card, target);
    } catch (e) {
        console.error('[FollowerEvolve] 进化时能力结算失败：', e);
    }
}
