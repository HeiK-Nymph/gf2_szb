import { Color, Component, director, Node, Tween, tween, Vec3 } from 'cc';
import { BattleFieldLayout, BattleSide } from './BattleFieldLayout';
import { BattleCueType } from './BattleCommand';
import { recordNumber } from './DamageNumberQueue';
import { cardIdFromNodeName } from './CardGlow';
import { killNode } from './CardComposer';
import { CardDestroyFx } from './CardDestroyFx';
import { HeroArea, HeroSide } from './HeroArea';
import {
  CARD_ABILITY_MAP,
  CardAbilityInvocation,
  CardAbilityName,
  CardAbilityTrigger,
  consumeEnhancedThisPlay,
  cooperationRequirementOf,
  getCardAbilities,
  getCardAbilityKeywords,
  getCardInfo,
  hasAbilityName,
  normalizeCardAbility,
} from './CardData';

/** 卡牌能力执行时所在的阵营。 */
export type CardAbilitySide = 'player' | 'enemy';

/** 能力执行上下文：只传运行时对象，卡表本身仍保持纯数据。 */
export interface CardAbilityContext {
  /** 触发本次能力的组件（CardPlay / EnemyCardPlay），用于重试和调度。 */
  host: Component;
  /** 卡牌 id（CardMap 的 key）。 */
  cardId: string;
  /** 打出 / 入场归属。 */
  side: CardAbilitySide;
  /** 已进入战场的卡牌节点；法术等未入场的卡为 null。 */
  sourceCard: Node | null;
  /**
   * **玩家在选择流程里已经选好的目标随从**（入场曲 / 进化时的目标选择）。
   * 🔴 目标选择属于交互，由 `TargetSelectSystem` 负责收集 —— 能力本身只消费结果，
   *    因此走到这里时 target 要么是合法节点、要么为 null（没选 = 不结算该分支）。
   */
  target?: Node | null;
}

type CardAbilityHandler = (ctx: CardAbilityContext, ability: CardAbilityInvocation) => void;

/**
 * 卡牌能力逻辑表。
 *
 * 键必须与 CardData.CARD_ABILITY_MAP 完全一致；Record<CardAbilityName, ...> 会在
 * 新增 / 删除名字时触发编译错误，保证「卡表名字」和「实际逻辑脚本功能」不会脱节。
 */
const CARD_ABILITY_HANDLERS: Record<CardAbilityName, CardAbilityHandler> = {
  DrawCards: (ctx, ability) => {
    const count = positiveInt(ability.params?.count, 1);
    // ★ `params.cardType`：只抽**指定类型**的卡（如卡 1「抽取 1 张随从」）。
    //   做法：先在牌堆里挑一张符合条件的（takeWhere 取出即移除），再让抽牌管线把它抽到手上。
    const wantType = asString(ability.params?.cardType);
    const deck = findComponent(ctx.host, 'CardDeckManager') as {
      drawManyFor?: (side: CardAbilitySide, n: number) => string[];
      remaining?: (side: CardAbilitySide) => number;
    } | null;
    if (!deck || !deck.drawManyFor) {
      console.warn(`[CardAbilitySystem] DrawCards 找不到 CardDeckManager，无法为 ${ctx.cardId} 抽 ${count} 张`);
      return;
    }

    let ids: string[] = [];
    if (wantType) {
      const picker = findComponent(ctx.host, 'CardDeckManager') as {
        takeWhere?: (side: CardAbilitySide, test: (id: string) => boolean) => string;
      } | null;
      for (let i = 0; i < count; i++) {
        let picked = '';
        try {
          picked = (picker && typeof picker.takeWhere === 'function')
            ? picker.takeWhere(ctx.side, (cid) => {
              const info = getCardInfo(cid);
              return !!info && info.cardType === wantType;
            }) : '';
        } catch (e) { picked = ''; }
        if (!picked) break;
        ids.push(picked);
      }
      if (ids.length > 0) {
        const drawer = findComponent(ctx.host, 'CardDraw') as { draw?: (id?: string) => boolean } | null;
        for (const one of ids) {
          try { if (drawer && typeof drawer.draw === 'function') drawer.draw(one); } catch (e) { /* 忽略 */ }
        }
        console.log(`[CardAbilitySystem] ${ctx.cardId} 抽取 ${ids.length} 张「${wantType}」：${ids.join('、')}`);
        return;
      }
      console.log(`[CardAbilitySystem] ${ctx.cardId} 牌堆里没有「${wantType}」可抽，退回普通抽牌`);
    }
    ids = deck.drawManyFor(ctx.side, count) || [];
    if (ids.length === 0) {
      console.warn(`[CardAbilitySystem] DrawCards 从 ${ctx.side} 牌堆未抽到牌（可能已空）`);
      return;
    }
    if (ids.length < count) {
      console.warn(`[CardAbilitySystem] DrawCards 请求 ${count} 张，牌堆只剩 ${ids.length} 张`);
    }

    if (ctx.side === 'player') {
      queuePlayerDraw(ctx.host, ids);
    } else {
      const drawer = findComponent(ctx.host, 'EnemyCardDraw') as {
        drawMany?: (ids: string[]) => boolean;
      } | null;
      if (!drawer || !drawer.drawMany) {
        console.warn('[CardAbilitySystem] DrawCards 找不到 EnemyCardDraw，抽到的牌未展示');
        return;
      }
      drawer.drawMany(ids);
    }
  },

  Rush: (ctx) => {
    applyKeywordAbilities(ctx, 'Rush');
  },

  Charge: (ctx) => {
    applyKeywordAbilities(ctx, 'Charge');
  },

  // 🔴 Deter / Guard 原本只靠 CardKeywordSystem 扫描卡表拿词条、没有处理函数，
  //    但处理表是按 CARD_ABILITY_MAP 的键**穷举**的 ⇒ 缺键会让 tsc 报「missing properties」。
  //    补上（与 Rush/Charge 同样只是把词条写进 CardKeywordSystem，行为不变）。
  Deter: (ctx) => {
    applyKeywordAbilities(ctx, 'Deter');
  },

  Guard: (ctx) => {
    applyKeywordAbilities(ctx, 'Guard');
  },

  /**
   * 潜行：把词条写进 CardKeywordSystem（不会被对方能力选中 / 不会被对方随从攻击）。
   * 失去时机由规则层负责：攻击 → `CardKeywordSystem.markAttacked`；
   * 能力造成伤害 → `notifyAbilityDamage`（🔴 破坏不算造成伤害，不在这里处理）。
   */
  Ambush: (ctx) => {
    applyKeywordAbilities(ctx, 'Ambush');
  },

  /** 灵气：不会被对手的能力选中（目标选择层统一过滤）。 */
  Aura: (ctx) => {
    applyKeywordAbilities(ctx, 'Aura');
  },

  /**
   * **奥义**：奥义槽 ≥ 10 时发动 `params.effect` / `params.effects`（与入场曲同一套内嵌写法）。
   * 奥义槽 = `现在的回合数`（= 大回合数）+ `这张卡在手牌中时我方随从的进化次数`（见 CardKeywordSystem.ougiGauge）。
   * 不满足条件时**只打一条日志**，不结算任何东西（卡照常入场）。
   */
  Ougi: (ctx, ability) => {
    runOugiEffect(ctx, ability, OUGI_THRESHOLD);
  },

  /** **解放奥义**：奥义槽 ≥ 15 时发动 `params.effect` / `params.effects`（口径同奥义，门槛更高）。 */
  OugiRelease: (ctx, ability) => {
    runOugiEffect(ctx, ability, OUGI_RELEASE_THRESHOLD);
  },

  Chant: () => {
    // 吟唱本身只登记倒计时；实际递减 / 触发器由 CardKeywordSystem 在己方回合开始推进。
  },

  // ====================== 【关键词】入场曲 / 进化 / 超进化 / 获得纹章 ======================

  /**
   * 入场曲（类似「战吼」）：
   *   · params.effect ——（可选）内嵌效果，直接结算；
   *   · params.action ——（可选）对**已选中的目标**做的事，当前支持 'destroy'（破坏）。
   * 🔴 目标选择（params.select）由交互层（CardPlay / EvoDragController + TargetSelectSystem）
   *    在**进入战场之前 / 进化之前**完成，结果通过 `ctx.target` 传进来；这里不再发起选择。
   *    因此「没选到目标」= 该分支不结算（场上本来就没有合法目标时不会走到这条分支）。
   */
  Fanfare: (ctx, ability) => {
    // 🔴 用 `runNestedEffects`（同时支持 params.effect 与 params.effects）——
    //    卡 10「守护之道·春田」的入场曲要**依次**做两件事（使目标消失 + 回复主战者 3 点）。
    runNestedEffects(ctx, ability);
    runTargetAction(ctx, ability, '入场曲');
  },

  /** 进化：普通进化**或**超进化都会触发（params.effect / params.effects，另外支持 params.action 对已选目标出手） */
  Evolve: (ctx, ability) => {
    runNestedEffects(ctx, ability);
    // 🔴 卡 5「高油温防护·塞布丽娜」：进化时 `select:'enemyFollower', filter:'damaged', action:'destroy'`
    //    ⇒ 目标由交互层在**进化之前**选好（EvoDragController.requestEvolve），这里只消费结果。
    runTargetAction(ctx, ability, '进化时');
  },

  /** 超进化：只有超进化触发（params.effects 依次触发；可嵌套 Fanfare / GainCrest） */
  SuperEvolve: (ctx, ability) => {
    runNestedEffects(ctx, ability);
    runTargetAction(ctx, ability, '超进化');
  },

  /**
   * **分配 X 伤害**（关键字）：按战场卡牌**从早到晚的入场顺序**依次分配 X 点伤害。
   *   · 先打**最早入场**的那张 → 打到血量归零就破坏 → **剩余的伤害溢出给下一张**
   *     → 直到伤害用完 / 没有可用目标（沿用「伤害溢出不浪费到已死随从」的口径）；
   *   · 方位口径：**我方**早入场的在**左**、**敌方**早入场的在**右**
   *     （顺序由 `BattleFieldLayout.cardsByEntryOrder()` 唯一提供，这里不自己算方向）；
   *   · params.amount = 固定点数 X；params.amountFrom='attack' 时改用**来源随从当前攻击力**
   *     （进化时能力读到的自然就是**进化后**的攻击力）；
   *   · params.side = 'opponent'（默认，对方战场）/ 'self'（己方战场）/ 'both'（双方，先己方后对方）；
   *   · 超进化守护（己方回合受到的伤害转为 0）期间该随从**不受伤**，伤害越过它打下一张；
 *   · 护符等**没有血量**的卡牌不参与分配（`getHp` 返回 null → 跳过它、伤害给下一张）。
   * 破坏走通用入口 `destroyFieldCard`（BattleCommandSystem 存在时排队播破坏 + 重排演出）。
   */
  DistributeDamage: (ctx, ability) => {
    const total = distributeAmountOf(ctx, ability);
    if (total <= 0) {
      console.log(`[CardAbilitySystem] 分配伤害：${ctx.cardId} 的伤害点数为 0，跳过`);
      return;
    }
    const rules = findComponent(ctx.host, 'BattleRuleSystem') as {
      fieldOfSide?: (side: BattleSide) => BattleFieldLayout | null;
      getHp?: (card: Node | null) => number | null;
      setHp?: (card: Node, hp: number) => void;
      isSuperGuarded?: (card: Node | null) => boolean;
      beginDeferredDisplay?: () => void;
      endDeferredDisplay?: () => unknown;
    } | null;
    if (!rules || typeof rules.fieldOfSide !== 'function'
        || typeof rules.getHp !== 'function' || typeof rules.setHp !== 'function') {
      console.warn('[CardAbilitySystem] 分配伤害 找不到可用的 BattleRuleSystem，无法结算');
      return;
    }

    // 先把目标按「入场顺序」排好（跨双方时先己方后对方），再一次性分配。
    const targets: Node[] = [];
    for (const side of damageSidesOf(ctx.side, asString(ability.params?.side))) {
      const field = rules.fieldOfSide(side);
      if (!field || !field.isValid) continue;
      for (const card of field.cardsByEntryOrder()) {
        if (card && card.isValid) targets.push(card);
      }
    }
    if (targets.length === 0) {
      console.log(`[CardAbilitySystem] 分配伤害：目标战场没有可分配的卡牌，${total} 点伤害作废`);
      return;
    }

    // 🔴 这一批「因同一次分配伤害而同时死亡」的卡，破坏动画要**同时**播（需求）：
    //    用「同时破坏」批次把本循环里的所有破坏攒成**一条** Destroy cue（entries = 多张卡），
    //    否则会退化成「破坏 → 重排 → 破坏 → 重排」一张一张排队。
    const cmds = findComponent(ctx.host, 'BattleCommandSystem') as {
      beginDestroyBatch?: () => void;
      endDestroyBatch?: () => void;
    } | null;
    const batched = !!(cmds && typeof cmds.beginDestroyBatch === 'function'
      && typeof cmds.endDestroyBatch === 'function');
    if (batched) cmds!.beginDestroyBatch!();
    // 🔴 `remaining` 必须在 try **之外**声明：下面的收尾日志（伤害是否打空）在 finally 之后读它，
    //    声明在 try 里会变成块作用域外访问（TS 报错 + 运行时 ReferenceError）。
    let remaining = total;
    /** 本次真的受到伤害的目标（演出 / 潜行判定用；顺序 = 入场顺序） */
    const hurt: Node[] = [];
    // 🔴 需求：**先打中、再更新卡面数字** —— 结算时冻结数字显示（逻辑值照改），
    //    把快照交给 RefreshNumbers cue，队列在毒弹飞完那一刻才写回（与普通攻击同一套机制）。
    const defer = typeof rules.beginDeferredDisplay === 'function'
      && typeof rules.endDeferredDisplay === 'function';
    let displayEnded = false;
    let batch: unknown = null;
    if (defer) rules.beginDeferredDisplay!();
    try {
      for (const card of targets) {
        if (remaining <= 0) break;
        // 🔴 需求：**能力造成的伤害不「越过」任何随从** —— 超进化守护（己方回合受到的伤害转为 0）
        //    只对**普通攻击**生效（见 BattleRuleSystem.resolveAttack），能力伤害照常打在它身上。
        const hp = rules.getHp(card);
        if (typeof hp !== 'number' || hp <= 0) continue;
        // ★ `perTarget:true` = **每个目标各吃满 amount**（如卡 9 模式②「对所有随从造成 8 点」），
        //   不溢出、不递减，**也不走下面的「剩余伤害承接」**；否则按「分配伤害」语义
        //   （总量固定、打死后的溢出给下一张）。
        const perTarget = ability.params?.perTarget === true;
        const dealt = perTarget ? remaining : Math.min(remaining, hp);
        const hpAfter = hp - dealt;
        if (!perTarget) remaining -= dealt;
        dealDamageTo(rules, card, hpAfter);
        hurt.push(card);
        console.log(`[CardAbilitySystem] 分配伤害：${card.name} ${hp} → ${hpAfter}`
          + `（本次 ${dealt} 点，剩余 ${remaining} 点）`);
        if (hpAfter <= 0) destroyCardNow(ctx, card);
      }
      // 🔴 **剩余伤害落在最后一个受伤的目标身上**（需求）：不能凭空丢掉 ——
      //    例：对 4 血随从分配 7 点 ⇒ 前 4 点打完它已破坏，剩下 3 点仍算在它头上，
      //    逻辑血量 = **-3**、卡面也显示 **-3**（负血只在「没有下一个目标可承接」时出现）。
      if (remaining > 0 && hurt.length > 0 && ability.params?.perTarget !== true) {
        const last = hurt[hurt.length - 1];
        if (last && last.isValid) {
          const hp = rules.getHp(last);
          if (typeof hp === 'number') {
            const hpAfter = hp - remaining;
            console.log(`[CardAbilitySystem] 分配伤害：${last.name} 承接剩余 ${remaining} 点 → ${hpAfter}`);
            dealDamageTo(rules, last, hpAfter);
            remaining = 0;
          }
        }
      }
      // 🔴 潜行：「通过能力造成伤害」→ 失去潜行。**只在真的造成了伤害时**触发；
      //    纯破坏（destroy）不走这条路径 ⇒ 不会让潜行现形。
      if (hurt.length > 0) notifyAbilityDamage(ctx);
      // ★ 演出顺序（都在破坏 cue 之前）：毒弹（**多目标同时飞**）→ 刷新数字
      if (defer) { batch = rules.endDeferredDisplay!(); displayEnded = true; }
      pushPoisonBulletCue(ctx, ability, hurt);
      pushRefreshNumbersCue(ctx, batch);
    } finally {
      // 🔴 无论中途出什么事都要收口：延迟显示窗口 + 破坏批次状态（否则后续破坏都会攒着不入队）。
      if (defer && !displayEnded) { try { rules.endDeferredDisplay!(); } catch (e) { /* 忽略 */ } }
      if (batched) cmds!.endDestroyBatch!();
    }
    if (remaining > 0 && ability.params?.perTarget !== true) {
      console.log(`[CardAbilitySystem] 分配伤害：目标已打空，剩余 ${remaining} 点伤害作废`);
    }
  },

  /**
   * 获得纹章：为该方主战者 +1 枚纹章（按获得顺序落到该方纹章区的 5 个圆里）。
   * params.crest 指定纹章资源名；留空 = 卡牌自己的 id（卡 4.png → 纹章 4.png）。
   */
  GainCrest: (ctx, ability) => {
    const crest = asString(ability.params?.crest) || ctx.cardId;
    const sys = findComponent(ctx.host, 'CrestSystem') as {
      gainCrest?: (side: CardAbilitySide, crestId: string) => boolean;
      canGainCrest?: (side: CardAbilitySide, crestId: string) => boolean;
    } | null;
    if (!sys || typeof sys.gainCrest !== 'function') {
      console.warn(`[CardAbilitySystem] 获得纹章 找不到 CrestSystem，无法为 ${ctx.side} 发放纹章 ${crest}`);
      return;
    }
    // 先无副作用预判：已有同名纹章 / 已达上限 → 这次获得不生效（CrestSystem 里也会再拦一道）
    if (typeof sys.canGainCrest === 'function' && sys.canGainCrest(ctx.side, crest) !== true) {
      console.log(`[CardAbilitySystem] 获得纹章被拒（${ctx.side} 已有同名纹章或已达上限）：${crest}`);
      return;
    }
    sys.gainCrest(ctx.side, crest);
  },

  DestroySelf: (ctx) => {
    const card = ctx.sourceCard;
    if (!card || !card.isValid) return;
    destroyCardNow(ctx, card);
  },

  FriendlyFollowerEnterBuff: () => {
    // 入场增益由 CardKeywordSystem 在随从第一次登记时统一结算，以支持多张来源叠加。
  },

  /**
   * **回合结束时**（卡 6）：自己这一方的操作回合结束时，依次结算内嵌效果
   * （写法与入场曲一致：先随机打 3 点、再获得潜行）。
   */
  TurnEnd: (ctx, ability) => {
    runNestedEffects(ctx, ability);
  },

  /** **随机伤害**（内嵌效果）：随机打 params.select 里 1 个随从。 */
  RandomDamage: (ctx, ability) => {
    applyRandomDamage(ctx, ability, 'enemyFollower');
  },

  /** **我方全体 +X/+Y**（卡 6 的进化时）：含来源自己。 */
  BuffFriendlyFollowers: (ctx, ability) => {
    const atk = asInt(ability.params?.attack);
    const hp = asInt(ability.params?.hp);
    // ★ `params.keywords`：同一时点顺带授予关键词（卡 29 的全体【守护】/ 卡 30 的全体【突进】）
    const kws = asStringArray(ability.params?.keywords);
    if (atk === 0 && hp === 0 && kws.length === 0) return;
    const rules = rulesOf(ctx.host);
    const field = rules && typeof rules.fieldOfSide === 'function'
      ? rules.fieldOfSide(sideOfSelect(ctx.side, 'friendlyFollower')) : null;
    if (!rules || typeof rules.addStats !== 'function' || !field || !field.isValid) {
      console.warn('[CardAbilitySystem] 我方全体增益：找不到 BattleRuleSystem / 己方战场，跳过');
      return;
    }
    // ★ `excludeSelf`：文案是「自己的战场上的**其他**所有随从」时排除发动者自己
    const excludeSelf = ability.params?.excludeSelf === true;
    const self = ctx.sourceCard;
    const kw = kws.length > 0
      ? findComponent(ctx.host, 'CardKeywordSystem') as {
        addKeyword?: (card: Node | null, keyword: string) => boolean;
      } | null
      : null;
    let n = 0;
    for (const card of field.cards) {
      if (!card || !card.isValid) continue;
      if (excludeSelf && self && card === self) continue;
      if (atk !== 0 || hp !== 0) rules.addStats(card, atk, hp);
      if (kw && typeof kw.addKeyword === 'function') {
        for (const keyword of kws) {
          try { kw.addKeyword(card, keyword); } catch (e) { /* 单个词条失败不影响其它卡 */ }
        }
      }
      n++;
    }
    console.log(`[CardAbilitySystem] ${ctx.cardId} 我方全体获得 +${atk}/+${hp}`
      + `${kws.length > 0 ? ' + [' + kws.join('、') + ']' : ''}（${n} 只随从）`);
  },

  /** **选中目标 +X/+Y**（配合 SelectTarget）：只对本次选择选中的那只生效。 */
  BuffSelected: (ctx, ability) => {
    const target = ctx.target;
    if (!target || !target.isValid) {
      console.warn(`[CardAbilitySystem] ${ctx.cardId} 选中目标增益：本次没有选中随从，跳过`);
      return;
    }
    const atk = asInt(ability.params?.attack);
    const hp = asInt(ability.params?.hp);
    // ★ `params.keywords`：同时授予关键词（卡 32 的爆能强化给召唤出来的复制体上【毁灭】）
    const kws = asStringArray(ability.params?.keywords);
    if (atk === 0 && hp === 0 && kws.length === 0) return;
    const rules = rulesOf(ctx.host);
    if ((atk !== 0 || hp !== 0) && (!rules || typeof rules.addStats !== 'function')) {
      console.warn('[CardAbilitySystem] 选中目标增益：找不到 BattleRuleSystem，跳过');
      return;
    }
    if (atk !== 0 || hp !== 0) rules!.addStats(target, atk, hp);
    if (kws.length > 0) {
      const kw = findComponent(ctx.host, 'CardKeywordSystem') as {
        addKeyword?: (card: Node | null, keyword: string) => boolean;
      } | null;
      if (kw && typeof kw.addKeyword === 'function') {
        for (const keyword of kws) {
          try { kw.addKeyword(target, keyword); } catch (e) { /* 忽略 */ }
        }
      } else {
        console.warn(`[CardAbilitySystem] ${ctx.cardId} 选中目标增益：找不到 CardKeywordSystem，关键词未授予`);
      }
    }
    console.log(`[CardAbilitySystem] ${ctx.cardId} 选中目标 ${target.name} 获得 +${atk}/+${hp}`
      + `${kws.length > 0 ? ' + [' + kws.join('、') + ']' : ''}`);
  },

  /**
   * **选择目标 → 依次结算内嵌效果**（法术用，见 CARD_ABILITY_MAP.SelectTarget 的说明）。
   *
   * 🔴 目标由**交互层**选好后通过 `ctx.target` 传进来 —— 与随从的入场曲完全同一套逻辑：
   *    我方 = `CardPlay` 的「先选目标」流程（停到摄像头左上角 → 选择模式 → 选中才结算，
   *    点其它地方则回手牌 + 退费）；敌方 AI = `EnemyCardPlay` 用 `autoPick` 自动选。
   *    所以这里**只消费结果**，不再自己发起选择。
   */
  /**
   * **选择目标 → 依次结算内嵌效果**（法术用，见 CARD_ABILITY_MAP.SelectTarget 的说明）。
   * 🔴 目标由**交互层**选好后通过 `ctx.target` 传进来 —— 与随从的入场曲完全同一套逻辑。
   */
  SelectTarget: (ctx, ability) => {
    const target = ctx.target;
    if (!target || !target.isValid) {
      console.warn(`[CardAbilitySystem] ${ctx.cardId} 选择目标：本次没有选中随从，跳过`);
      return;
    }
    runNestedEffects(ctx, ability);
  },

  /**
   * **启动**（护符的主动能力）：效果本体的结算。
   * 🔴 目标 / 费用 / 「1 回合 1 次」的门槛都在 `activateAmulet()` 里判完并把目标选好，
   *    走到这里只需依次结算内嵌效果（与 `SelectTarget` 同款：只消费结果）。
   */
  Activate: (ctx, ability) => {
    runNestedEffects(ctx, ability);
  },

  /** **回复主战者**：为自己这一方的主战者回复 params.amount 点（上限 = 主战者最大血量）。 */
  HealHero: (ctx, ability) => {
    const amount = asInt(ability.params?.amount);
    if (amount <= 0) return;
    const hero = heroAreaOf(ctx.host, ctx.side);
    if (!hero) {
      console.warn(`[CardAbilitySystem] ${ctx.cardId} 回复主战者：找不到 ${ctx.side} 的主战者，跳过`);
      return;
    }
    const before = typeof hero.hp === 'number' ? hero.hp : 0;
    hero.setHp(before + amount);
    // ★ 飘字显示**实际**获得的治疗值（用户口径）：18 血被治 3 ⇒ +2；满血被治 3 ⇒ 绿色 +0。
    //   setHp 只在血量真的变化时登记，所以「满血治疗」这条要在这里补登记（allowZero）。
    try {
      const gain = (typeof hero.hp === 'number' ? hero.hp : before) - before;
      if (gain === 0) recordNumber((hero as unknown as { node?: unknown }).node, 0, true, false, '', true, true);
    } catch (e) { /* 忽略 */ }
    console.log(`[CardAbilitySystem] ${ctx.cardId} 回复主战者 ${amount} 点（${before} → ${hero.hp}）`);
  },

  /** ★ **召唤**（关键字）：见 `summonCards` 的注释（不触发入场曲 / 无中央展示 / 牌组真移除 / 溢出不算破坏）。 */
  Summon: (ctx, ability) => {
    summonCards(ctx, ability);
  },

  /**
   * ★ **消失**（关键字，需求）：把卡牌从战场 / 手牌 / 牌组**除去** ——
   *   · 🔴 **不进墓场**；🔴 **不触发谢幕曲**等「被破坏时」的能力（走的是 `vanishFieldCard`，不是 destroy）；
   *   · 演出 = 破坏特效的**反过来**（光向内收）。
   * 目标由交互层选好后经 `ctx.target` 传入（写法与 `SelectTarget` 完全一致）。
   */
  Vanish: (ctx) => {
    vanishSelected(ctx);
  },

  /**
   * ★ **谢幕曲**（关键字）：**卡牌被破坏时**发动的能力（`params.effect` / `params.effects`）。
   * 🔴 消失 / 变身时**不会**发动 —— 本 handler 只被「破坏」路径调用（见 `runCardLastWords`）。
   */
  /** ★ 毁灭：逻辑全在 BattleRuleSystem.resolveCombat（这里只登记词条）。 */
  Bane: () => { /* no-op：见 BattleRuleSystem.resolveCombat */ },
  /** ★ 多次攻击：把运行时次数写进 CardKeywordSystem，由 BattleRuleSystem.attacksLeft 读取。 */
  MultiAttack: (ctx, ability) => {
    applyMultiAttack(ctx, ability);
  },
  /** ★ 不会被能力破坏：逻辑全在 BattleRuleSystem / BattleCommandSystem 的统一破坏入口。 */
  AbilityDestroyImmune: () => { /* no-op：见 BattleRuleSystem.canDestroyByAbility */ },
  /**
   * ★ 交战时：只在与随从交战时触发，结算点由 BattleRuleSystem.resolveCombat
   * 在互相造成伤害之前调用。攻击主战者不会走这里。
   */
  Clash: (ctx, ability) => {
    runNestedEffects(ctx, ability);
    runTargetAction(ctx, ability, '交战时', false);
  },
  /** 批量消失指定战场：默认仍只针对对手，both 用于乔扎的双方全场入场曲。 */
  VanishAll: (ctx, ability) => {
    const rules = rulesOf(ctx.host) as (RuleApi & {
      vanishFieldCard?: (c: Node, f: BattleFieldLayout | null) => boolean;
      vanishFieldCards?: (cards: Node[], f: BattleFieldLayout | null) => number;
    }) | null;
    if (!rules || (typeof rules.vanishFieldCards !== 'function' && typeof rules.vanishFieldCard !== 'function')) {
      console.warn(`[CardAbilitySystem] ${ctx.cardId} 消失全体：找不到 BattleRuleSystem`);
      return;
    }

    const wantSide = asString(ability.params?.side) || 'opponent';
    const fields = allFields().filter((field) => !!field && field.isValid);
    let targets: BattleFieldLayout[];
    if (wantSide === 'both') {
      targets = fields.filter((field) => {
        const side = (field as unknown as { side?: number }).side;
        return side === 0 || side === 1;
      });
    } else {
      const targetSide = wantSide === 'own' ? ctx.side : (ctx.side === 'player' ? 'enemy' : 'player');
      const wantEnum = targetSide === 'player' ? 0 : 1;
      const field = fields.find((candidate) => (candidate as unknown as { side?: number }).side === wantEnum)
        || fields[wantEnum];
      targets = field ? [field] : [];
    }
    if (targets.length === 0) {
      console.warn(`[CardAbilitySystem] ${ctx.cardId} 消失全体：找不到目标战场（side=${wantSide}）`);
      return;
    }

    const excludeSelf = ability.params?.excludeSelf === true;
    let vanished = 0;
    for (const field of targets) {
      const list = (field.cards || []).filter((card) => !!card && card.isValid
        && (!excludeSelf || card !== ctx.sourceCard));
      if (list.length === 0) continue;
      vanished += list.length;
      if (typeof rules.vanishFieldCards === 'function') {
        // 同一战场的卡仍共用批量消失 cue；双方分别排 cue + Reflow。
        rules.vanishFieldCards(list, field);
      } else {
        for (const card of list) {
          try { rules.vanishFieldCard!(card, field); }
          catch (e) { console.error('[CardAbilitySystem] 消失失败：', e); }
        }
      }
    }
    console.log(`[CardAbilitySystem] ${ctx.cardId} 消失全体：${vanished} 张（side=${wantSide}）`);
  },
  LastWords: (ctx, ability) => {
    runNestedEffects(ctx, ability);
  },

  /**
   * ★ **属性提升时**（卡 11「温情攻势·安朵丝」）：本随从**在战场上**获得攻击力 / 生命值增加时发动。
   * 🔴 「自己的每回合中可触发 1 次」由 `runCardStatUpAbilities` 统一把关（走 `canTriggerStatUp`）。
   * 🔴 **进化 / 超进化加数值也算**（`FollowerEvolve` 同样走 `BattleRuleSystem.addStats`）。
   */
  StatUp: (ctx, ability) => {
    runNestedEffects(ctx, ability);
  },

  /**
   * ★ **法术效果容器**：法术使用时的效果入口（依次跑 params.effect / params.effects）。
   * 与入场曲同款实现，只是 trigger 是 `use` —— 法术结算只跑这个 trigger 的能力。
   */
  SpellEffects: (ctx, ability) => {
    runNestedEffects(ctx, ability);
  },

  /**
   * ★ **协作 N**：协作值（本次对战中进入战场的自己的随从张数）≥ threshold ⇒ 跑 effects；
   * 否则跑 otherwise（「【协作_N】改为…」的否则分支）。
   */
  /** ★ **协作数 +N**（卡 1）。 */
  CooperationUp: (ctx, ability) => {
    const n = Math.max(0, Math.floor(Number(ability.params?.amount) || 1));
    try {
      const rules = rulesOf(ctx.host) as (RuleApi & { addCooperation?: (s: string, n: number) => void }) | null;
      if (rules && typeof rules.addCooperation === 'function') rules.addCooperation(ctx.side, n);
      else console.warn(`[CardAbilitySystem] ${ctx.cardId} 协作数 +${n}：找不到 BattleRuleSystem`);
    } catch (e) { console.error('[CardAbilitySystem] 协作数加成失败：', e); }
  },
  /** ★ 屏障：逻辑全在 BattleRuleSystem.applyDamage（这里只登记词条，什么都不做）。 */
  Barrier: () => { /* no-op：见 BattleRuleSystem.applyDamage */ },
  /**
   * ★ **爆能强化**：只有「本次打出确实按爆能强化付了费」才发动（标记由 CardPlay 打）。
   */
  Enhance: (ctx, ability) => {
    if (!consumeEnhancedThisPlay(ctx.side, ctx.cardId)) {
      console.log(`[CardAbilitySystem] ${ctx.cardId} 爆能强化未满足（本次按普通费用打出），跳过`);
      return;
    }
    console.log(`[CardAbilitySystem] ${ctx.cardId} 爆能强化发动（value=${JSON.stringify((ability.params || {}).value)}）`);
    runNestedEffects(ctx, ability);
  },
  /** ★ 回复能量点（爆能强化配套）。 */
  RestorePP: (ctx, ability) => {
    const amount = Math.max(0, Math.floor(Number(ability.params?.amount) || 0));
    if (amount <= 0) return;
    try {
      restorePPLocal(ctx.host, ctx.side, amount);
      console.log(`[CardAbilitySystem] ${ctx.cardId} 回复 ${amount} 点能量点`);
    } catch (e) { console.error('[CardAbilitySystem] 回复能量点失败：', e); }
  },

  /**
   * ★ **本随从超进化**（卡 27 的爆能强化_8）：不消耗进化点，直接把**来源随从自己**
   * 变成超进化状态，并依次结算本卡自己的 `evolve` / `superEvolve` 能力。
   * 🔴 与真·超进化共用同一套编制与标记（见 `FollowerEvolve`）：数值 / 标记 / 关键词 / 后续能力一个不少，
   *    只是**不播进化动画**（本能力在「使用结算」时点同步结算）。
   */
  SelfSuperEvolve: (ctx) => {
    selfSuperEvolveNow(ctx);
  },

  /**
   * ★ **对敌方主战者造成伤害**（卡 26 的【协作_20】奖励）：目标是**对手**那一方的主战者。
   */
  DamageHero: (ctx, ability) => {
    const amount = Math.max(0, asInt(ability.params?.amount) || 0);
    if (amount <= 0) return;
    const foeSide: CardAbilitySide = ctx.side === 'player' ? 'enemy' : 'player';
    const hero = heroAreaOf(ctx.host, foeSide) as {
      hp?: number;
      takeDamage?: (d: number, deferDisplay?: boolean) => number;
      setHp?: (v: number, deferDisplay?: boolean) => void;
    } | null;
    if (!hero) {
      console.warn(`[CardAbilitySystem] ${ctx.cardId} 对敌方主战者造成伤害：找不到 ${foeSide} 的主战者，跳过`);
      return;
    }
    const before = typeof hero.hp === 'number' ? hero.hp : 0;
    try {
      if (typeof hero.takeDamage === 'function') hero.takeDamage(amount, false);
      else if (typeof hero.setHp === 'function') hero.setHp(Math.max(0, before - amount), false);
      else { console.warn(`[CardAbilitySystem] ${ctx.cardId} 对敌方主战者造成伤害：主战者不支持扣血`); return; }
    } catch (e) {
      console.error('[CardAbilitySystem] 对敌方主战者造成伤害失败：', e);
      return;
    }
    console.log(`[CardAbilitySystem] ${ctx.cardId} 对 ${foeSide} 主战者造成 ${amount} 点伤害`
      + `（${before} → ${typeof hero.hp === 'number' ? hero.hp : '?'}）`);
  },

  /**
   * ★ **破坏攻击力最高的敌方随从**（卡 28「骇人的轰炸」）：自动挑，不经玩家选择。
   * 候选口径 = `TargetSelectSystem.candidatesFor(owner,'enemyFollower')`（潜行 / 灵气照常排除），
   * 攻击力相同取**最左**那一只（与 `autoPick` 同一策略）。
   */
  DestroyHighestAttack: (ctx) => {
    destroyHighestAttackNow(ctx);
  },

  Cooperation: (ctx, ability) => {
    const need = Math.max(0, asInt(ability.params?.threshold) || 0);
    const cur = cooperationOf(ctx);
    const met = need > 0 && cur >= need;
    console.log(`[CardAbilitySystem] ${ctx.cardId} 协作：${cur}/${need} ⇒ ${met ? '满足' : '不满足'}`);    if (met) {
      runNestedEffects(ctx, { name: ability.name, params: Object.assign({}, ability.params || {}, { otherwise: undefined }) } as CardAbilityInvocation);
      return;
    }
    const other = ability.params?.otherwise;
    const list = Array.isArray(other) ? other : (other ? [other] : []);
    if (list.length === 0) return;
    runNestedEffects(ctx, { name: ability.name, params: Object.assign({}, ability.params || {}, { effects: list }) } as CardAbilityInvocation);
  },
  /** ★ **对选中目标造成伤害**（协作不满足时的单体分支用）。 */
  DamageSelected: (ctx, ability) => {
    applyRandomDamage(ctx, ability, 'selected');
  },
  /**
   * ★ **加入手牌**（卡 11 的谢幕曲：将 1 张自巡炮加入手牌）。
   * `params.id` = 要加入的卡 id；手牌已满则**加不进去**（拒绝，不产生任何副作用）。
   */
  AddToHand: (ctx, ability) => {
    addCardToHand(ctx, ability);
  },
  Mode: (ctx, ability) => {
    const options = Array.isArray(ability.params?.options) ? ability.params.options : [];
    if (options.length === 0) {
      console.warn(`[CardAbilitySystem] ${ctx.cardId} 模式：没有登记任何选项，跳过`);
      return;
    }
    const want = Math.max(1, asInt(ability.params?.count) || 1);
    const raw = (ctx.host as unknown as { _fanfareMode?: number })._fanfareMode;
    const picked: number[] = [];
    if (typeof raw === 'number' && raw >= 0 && raw < options.length) {
      picked.push(raw);
    } else {
      picked.push(0);                       // 兜底：没有选择记录（AI / 探针）→ 第一个
    }
    while (picked.length < want) {          // count > 1 时补齐（去重优先）
      let next = -1;
      for (let i = 0; i < options.length; i++) if (picked.indexOf(i) < 0) { next = i; break; }
      if (next < 0) break;
      picked.push(next);
    }
    for (const i of picked) {
      const opt = options[i];
      if (!opt || typeof opt !== 'object') continue;
      console.log(`[CardAbilitySystem] ${ctx.cardId} 模式：发动选项 ${i + 1}`
        + `（${asString((opt as { text?: unknown }).text).slice(0, 30)}）`);
      const one = (opt as { effect?: CardAbilityInvocation }).effect;
      const many = (opt as { effects?: CardAbilityInvocation[] }).effects;
      const fake = {
        name: ability.name,
        params: Object.assign({}, ability.params || {}, { effect: one, effects: many }),
      } as unknown as CardAbilityInvocation;
      runNestedEffects(ctx, fake);
    }
  },
};

// ====================== 「消失」（Vanish）======================

/** 把 `ctx.target` 指定的卡**消失**掉（战场优先；不在战场上则按手牌 / 牌组处理）。 */
function vanishSelected(ctx: CardAbilityContext): void {
  const target = ctx.target;
  if (!target || !target.isValid) {
    console.warn(`[CardAbilitySystem] ${ctx.cardId} 消失：本次没有选中目标，跳过`);
    return;
  }
  const rules = rulesOf(ctx.host) as (RuleApi & {
    vanishFieldCard?: (card: Node | null, field: BattleFieldLayout | null) => boolean;
  }) | null;
  // 🔴 战场必须按**目标所在的阵营**找：目标通常是**敌方**随从，而 `ctx.side` 是**施法方**（我方）
  //    ⇒ 拿 ctx.side 去找会找错战场、摘除失败（踩过：卡确实消失了，但走的是兜底路径、没有消失特效）。
  let field: BattleFieldLayout | null = null;
  if (rules && typeof rules.fieldOfSide === 'function') {
    for (const side of [BattleSide.Enemy, BattleSide.Player]) {
      const f = rules.fieldOfSide(side);
      if (!f || !f.isValid) continue;
      const holder = f as unknown as { containsCard?: (c: Node | null) => boolean };
      if (typeof holder.containsCard === 'function' && holder.containsCard(target)) { field = f; break; }
      if (!field) field = f;                       // 兜底：至少给一个，vanishFieldCard 自己会判
    }
  }
  if (rules && typeof rules.vanishFieldCard === 'function') {
    if (rules.vanishFieldCard(target, field)) return;
  }
  // 兜底（不在战场上 / 规则系统缺接口）：直接从场景里摘掉节点 —— 同样**不记墓场**。
  console.warn(`[CardAbilitySystem] ${ctx.cardId} 消失：${target.name} 不在战场上，按直接除去处理`);
  try { killNode(target); } catch (e) { /* 忽略 */ }
}

/** 把某个阵营名转成 BattleSide（内部小工具） */
function sideToBattle(side: CardAbilitySide): BattleSide {
  return side === 'enemy' ? BattleSide.Enemy : BattleSide.Player;
}

// ====================== 「属性提升」（StatUp）======================

/**
 * ★ **属性提升时**：本随从在战场上获得攻击力 / 生命值增加时发动它登记的 `StatUp` 能力。
 * 「自己的每回合中可触发 1 次」在这里把关（`canTriggerStatUp` / `markStatUpTriggered`，跨回合自动重置）。
 * 🔴 由 `BattleRuleSystem.addStats` 调用 ⇒ **进化 / 超进化加数值同样会触发**（用户明确要求）。
 */
export function runCardStatUpAbilities(host: Component, card: Node | null, side: CardAbilitySide): void {
  if (!host || !host.isValid || !card || !card.isValid) return;
  const id = cardIdFromNodeName(card.name);
  if (!id) return;
  const abilities = getCardAbilities(id).filter((a) => a.name === 'StatUp');
  if (abilities.length === 0) return;
  const rules = rulesOf(host) as (RuleApi & {
    canTriggerStatUp?: (c: Node | null) => boolean;
    markStatUpTriggered?: (c: Node | null) => void;
  }) | null;
  if (!rules || typeof rules.canTriggerStatUp !== 'function') return;
  if (!rules.canTriggerStatUp(card)) {
    console.log(`[CardAbilitySystem] ${id} 属性提升：本回合已经触发过（每回合 1 次），跳过`);
    return;
  }
  if (typeof rules.markStatUpTriggered === 'function') rules.markStatUpTriggered(card);
  console.log(`[CardAbilitySystem] ${id} 属性提升：发动 ${abilities.length} 条`);

  // ★ **等进化 / 超进化动画完全播完、卡牌落地之后再发动**（需求，针对卡 11「安朵丝」）：
  //   玩家要能看清「进化 → 攻/血增加 → 召唤」这个顺序；进化动画期间卡牌还在天上飞，
  //   此刻就召唤的话不但顺序看不懂，**战场重排还会和进化动画抢同一份位置**（实测排布错乱）。
  //   🔴 结算本身（加数值）**依旧是立即的**，这里只推迟**后续能力的演出时点**。
  //
  // 🔴🔴 **必须先让当前同步调用栈走完再判断**：`FollowerEvolve` 的顺序是
  //     `beginDeferredDisplay → addStats（就是这里被回调）→ endDeferredDisplay → markEvolved
  //      → setFxSuppressed(true) → 授予词条 → EvolveFollowerFx.play(...)`，
  //     全在**同一个同步栈**里 —— 在 addStats 那一刻 `isPlaying` 还是 false、fxSuppressed 也还没置位，
  //     当场判断必然判成「没有在进化」⇒ 立刻就召唤了（实测就是这个原因，上一版改错了）。
  //     所以先 `setTimeout(0)` 让这一栈跑完，之后再看两个信号：
  //       · `EvolveFollowerFx.isPlaying`（进化/超进化动画本体）
  //       · `CardKeywordSystem.isFxSuppressed(card)`（动画期间被抑制的卡面特效，动画结束才恢复）
  const evolveBusy = (): boolean => {
    try {
      const fx = findComponent(host, 'EvolveFollowerFx') as { isPlaying?: boolean } | null;
      if (fx && fx.isPlaying === true) return true;
      const kw = findComponent(host, 'CardKeywordSystem') as
        { isFxSuppressed?: (c: Node | null) => boolean } | null;
      if (kw && typeof kw.isFxSuppressed === 'function' && kw.isFxSuppressed(card)) return true;
      return false;
    } catch (e) { return false; }
  };
  const runAll = (): void => {
    if (!host || !host.isValid) return;
    for (let i = 0; i < abilities.length; i++) {
      try {
        runCardAbilities(host, id, side, 'statUp', card, null);
      } catch (e) {
        console.error(`[CardAbilitySystem] ${id} 属性提升执行失败：`, e);
      }
    }
  };
  const t0 = Date.now();
  const MAX_WAIT = 6000;                       // 熔断：进化特效异常时不至于永远不发动
  let started = false;
  let announced = false;
  const step = (): void => {
    if (started) return;
    if (!host || !host.isValid) { started = true; return; }
    if (!evolveBusy() || Date.now() - t0 >= MAX_WAIT) {
      started = true;
      if (announced) {
        console.log(`[CardAbilitySystem] ${id} 属性提升：进化动画已结束（${Date.now() - t0}ms）→ 现在发动`);
      }
      runAll();
      return;
    }
    if (!announced) {
      announced = true;
      console.log(`[CardAbilitySystem] ${id} 属性提升：进化动画正在播 ⇒ 等它播完并落地再发动`);
    }
    setTimeout(step, 60);
  };
  setTimeout(step, 0);                         // 🔴 关键：先让 addStats 所在的同步栈走完
}

// ====================== 「加入手牌」（AddToHand）======================

/** 把 `params.id` 指定的卡加入**自己这一方**的手牌（手牌满 → 拒绝）。 */
function addCardToHand(ctx: CardAbilityContext, ability: CardAbilityInvocation): void {
  const id = asString(ability.params?.id);
  if (!id) {
    console.warn(`[CardAbilitySystem] ${ctx.cardId} 加入手牌：没有写 params.id，跳过`);
    return;
  }
  const hand = findComponent(ctx.host, ctx.side === 'enemy' ? 'EnemyHandLayout' : 'HandLayout') as
    (Component & { addCard?: (id: string) => boolean; addCardLeft?: (id: string) => boolean; cards?: Node[] }) | null;
  if (!hand || typeof hand.addCard !== 'function') {
    console.warn(`[CardAbilitySystem] ${ctx.cardId} 加入手牌：找不到手牌布局，跳过`);
    return;
  }
  // ★ 需求：**不是从牌组抽**的卡没有「右下角抽牌」动画 —— 而是
  //   ① 等**有谢幕曲的那个随从播完破坏动画**；② 卡牌在**屏幕中央缓缓出现**；③ 展示一会儿后进手牌。
  const src = ctx.sourceCard && ctx.sourceCard.isValid ? ctx.sourceCard : null;
  const start = (): void => {
    let ok = false;
    // ★ 需求（按阵营区分）：
    //   · **我方**：非抽卡入手牌 ⇒ 放**最右边**（末尾）；
    //   · **敌方**：放**最左边**（玩家看到的是卡背，位置对齐敌方手牌习惯）。
    try {
      ok = (ctx.side === 'enemy' && typeof hand.addCardLeft === 'function')
        ? hand.addCardLeft(id) === true
        : hand.addCard(id) === true;
    } catch (e) {
      console.error(`[CardAbilitySystem] ${ctx.cardId} 加入手牌失败：`, e);
      return;
    }
    if (!ok) {
      // ★ 手牌已满 ⇒ 先在手牌**屏幕中央展示区渐渐出现**，随后原位播放破坏动画；
      //    `revealCardToHand` 会持有 _handRevealBusy，因此 TurnManager 的本回合抽卡会等它完全播完。
      console.log(`[CardAbilitySystem] ${ctx.cardId} 手牌已满 ⇒ ${id} 加入失败，改在中央展示后破坏`);
      if (ctx.side === 'player') {
        revealCardToHand(ctx.host, id, null, undefined, { destroyAtCenter: true });
        return;
      }
      console.log(`[CardAbilitySystem] ${ctx.cardId} 敌方手牌已满 ⇒ ${id} 按规则破坏（不展示真卡）`);
      return;
    }
    const list = Array.isArray(hand.cards) ? hand.cards : [];
    const added = ctx.side === 'enemy' ? list[0] : list[list.length - 1];
    const granted = Array.isArray(ability.params?.keywords) ? ability.params.keywords : [];
    if (added && added.isValid && granted.length > 0) {
      const kw = findComponent(ctx.host, 'CardKeywordSystem') as { addKeyword?: (card: Node, keyword: string) => boolean } | null;
      if (kw && typeof kw.addKeyword === 'function') {
        for (const raw of granted) {
          const keyword = asString(raw);
          if (keyword) kw.addKeyword(added, keyword);
        }
      } else {
        console.warn(`[CardAbilitySystem] ${ctx.cardId} 加入手牌并授予词条：找不到 CardKeywordSystem`);
      }
    }
    // ★ 需求：**敌方**通过能力入手牌的卡，玩家视角只能看到**卡背** ⇒
    //   绝不播「中央展示真卡」的动画（那会把卡面信息直接摊给玩家看）。
    if (ctx.side === 'enemy') {
      console.log(`[CardAbilitySystem] ${ctx.cardId} 将 1 张卡加入**敌方**手牌（只显示卡背，不做中央展示）`);
      return;
    }
    console.log(`[CardAbilitySystem] ${ctx.cardId} 将 1 张 ${id} 加入手牌（中央展示 → 进手牌）`);
    // 手牌里刚生成的那张先藏起来，等中央展示结束再显示（避免「瞬间出现 + 又在中央展示」两份）
    // 🔴 **飞向哪一张必须与「插到哪一端」一致**（踩过：加入改成末尾了、这里还取第 0 张
    //    ⇒ 展示动画飞向最左，虽然最后落位是对的，但过程是错的）：
    //    · 我方 → 末尾（最右）；敌方 → 第 0 张（最左）。
    //    · 上面已经 if (ctx.side === 'enemy') return; ⇒ 走到这里只可能是**我方** ⇒ 取**最后一张**（最右）。
    const target = added || null;
    if (target && target.isValid) target.active = false;
    // ★ 需求：展示动画排进**演出队列**（否则会和人机的攻击动画等重叠）。
    //   队列没有 HandReveal 这个 cue 时退回直接播（保证功能不丢）。
    let queued = false;
    try {
      const cmds = findComponent(ctx.host, 'BattleCommandSystem') as
        { pushCue?: (cue: unknown) => void } | null;
      if (cmds && typeof cmds.pushCue === 'function') {
        cmds.pushCue({ type: 'HandReveal', id, target });
        queued = true;
      }
    } catch (e) { console.error('[CardAbilitySystem] 排入入手牌展示演出失败：', e); }
    if (!queued) {
      revealCardToHand(ctx.host, id, target, () => {
        if (target && target.isValid) target.active = true;
      });
    }
  };
  const waitForSourceGone = ability.params?.waitForSourceGone !== false;
  if (src && src.isValid && waitForSourceGone) {
    // ① 等破坏动画播完（节点被销毁）+ 一小段收尾时间
    const t0 = Date.now();
    const MAX_WAIT = 4000;
    const tick = (): void => {
      if (!ctx.host || !ctx.host.isValid) return;
      const gone = !src.isValid;
      if (gone && Date.now() - t0 >= 260) { start(); return; }      // 销毁后再等 260ms 让爆闪散尽
      if (Date.now() - t0 >= MAX_WAIT) { start(); return; }          // 熔断
      setTimeout(tick, 50);
    };
    setTimeout(tick, 0);
    return;
  }
  start();
}

/**
 * ★ **非牌组来源的「中央缓缓出现 → 进手牌」动画**（需求）。
 *   · 在屏幕中央拼一张**临时展示卡**：从「很小 + 全透明」缓缓放大淡入（revealDuration）；
 *   · 停留 holdDuration 展示；
 *   · 再飞向手牌里那张真卡的**世界坐标**并缩小，结束销毁临时卡、显示真卡。
 * 🔴 纯演出：手牌逻辑（hand.addCard）**早已生效**，这里只是视觉过渡；任何异常都会直接收尾。
 */
/** 非抽卡入手牌的「中央展示」动画是否还在播（回合流程要等它播完再抽卡）。 */
let _handRevealBusy = 0;
/**
 * ★ 回复能量点（本地实现，**不 import CardPlay** —— 否则 CardPlay ⇄ CardAbilitySystem 循环依赖，
 *   TS 会把 CardPlay 类解析坏）。就是给 TurnControlPanel 加回 PP。
 */
function restorePPLocal(host: Component, side: CardAbilitySide, amount: number): void {
  const c = Math.max(0, Math.floor(Number(amount) || 0));
  if (c <= 0) return;
  try {
    const scene = host.node.scene as unknown as Node | null;
    if (!scene) return;
    const stack: Node[] = [...scene.children];
    while (stack.length > 0) {
      const cur = stack.shift() as Node;
      const p = cur.getComponent('TurnControlPanel') as unknown as
        ({ setPP?: (s: string, cur: number, max: number) => void } & Record<string, unknown>) | null;
      if (p && typeof p.setPP === 'function') {
        const curPP = Math.max(0, Math.round(Number(p[side + 'CurrentPP']) || 0));
        const maxPP = Math.max(0, Math.round(Number(p[side + 'MaxPP']) || 0));
        const next = maxPP > 0 ? Math.min(maxPP, curPP + c) : curPP + c;
        p.setPP(side, next, maxPP);
        console.log(`[CardAbilitySystem] 回复能量点 +${c} → ${next}/${maxPP}`);
        return;
      }
      for (const ch of cur.children) stack.push(ch);
    }
  } catch (e) { console.error('[CardAbilitySystem] 回复能量点失败：', e); }
}

export function isHandRevealBusy(): boolean { return _handRevealBusy > 0; }

/** ★ 全场景所有 BattleFieldLayout（VanishAll 用）。 */
function allFields(): BattleFieldLayout[] {
  const out: BattleFieldLayout[] = [];
  try {
    const scene = director.getScene();
    if (!scene) return out;
    const stack: Node[] = [...scene.children];
    while (stack.length > 0) {
      const cur = stack.shift() as Node;
      const f = cur.getComponent('BattleFieldLayout') as BattleFieldLayout | null;
      if (f) out.push(f);
      for (const ch of cur.children) stack.push(ch);
    }
  } catch (e) { /* 忽略 */ }
  return out;
}


/** ★ 当前协作值（该方本次对战中进入战场的随从张数）。 */
function cooperationOf(ctx: CardAbilityContext): number {
  try {
    const rules = rulesOf(ctx.host) as (RuleApi & { cooperationOf?: (s: string) => number }) | null;
    if (rules && typeof rules.cooperationOf === 'function') return Math.max(0, rules.cooperationOf(ctx.side) || 0);
  } catch (e) { /* 忽略 */ }
  return 0;
}

/** ★ 该方当前协作值是否已达到某张卡的需求（需求为 0 ⇒ 恒 false，表示这张卡没有协作机制）。 */
export function cooperationMet(host: Component, cardId: string | null | undefined, side: CardAbilitySide): boolean {
  const need = cooperationRequirementOf(cardId);
  if (need <= 0) return false;
  try {
    const rules = rulesOf(host) as (RuleApi & { cooperationOf?: (s: string) => number }) | null;
    if (rules && typeof rules.cooperationOf === 'function') return (rules.cooperationOf(side) || 0) >= need;
  } catch (e) { /* 忽略 */ }
  return false;
}

export function revealCardToHand(
  host: Component,
  id: string,
  target: Node | null,
  onDone?: () => void,
  opts?: { destroyAtCenter?: boolean },
): void {
  const finish = (): void => { try { if (onDone) onDone(); } catch (e) { /* 忽略 */ } };
  let temp: Node | null = null;
  try {
    const composer = findComponent(host, 'CardComposer') as
      (Component & { composeCard?: (id: string, name?: string) => Node | null }) | null;
    const canvas = findComponent(host, 'cc.Canvas') as Component | null;
    const layer = (canvas && canvas.node && canvas.node.isValid) ? canvas.node : (host.node.scene as unknown as Node);
    if (!composer || typeof composer.composeCard !== 'function' || !layer) { finish(); return; }
    temp = composer.composeCard(id, 'Reveal_' + id.replace(/[^\w]/g, '_') + '_' + Date.now());
    if (!temp || !temp.isValid) { finish(); return; }
    temp.setParent(layer, true);
    temp.setSiblingIndex(layer.children.length - 1);
    temp.setPosition(0, 0, 0);                       // Canvas 局部 (0,0) = 屏幕正中
    temp.active = true;
    const op = (temp.getComponent('cc.UIOpacity') || temp.addComponent('cc.UIOpacity')) as unknown as
      { opacity: number } | null;
    const home = temp.position.clone();
    const startScale = 0.55;
    const endScale = Math.max(0.6, temp.scale.x || 1);
    temp.setScale(startScale, startScale, 1);
    if (op) op.opacity = 0;

    const destroyAtCenter = !!(opts && opts.destroyAtCenter);
    const reveal = 0.55, hold = 0.55, fly = 0.4;
    const st = { p: 0 };
    let settled = false;
    _handRevealBusy++;
    let released = false;
    const releaseBusy = (): void => { if (released) return; released = true; _handRevealBusy = Math.max(0, _handRevealBusy - 1); };
    const cleanup = (): void => {
      if (settled) return;
      settled = true;
      releaseBusy();
      try { Tween.stopAllByTarget(st); } catch (e) { /* 忽略 */ }
      if (temp && temp.isValid) { try { killNode(temp); } catch (e) { /* 忽略 */ } }
      finish();
    };
    // 目标世界坐标 → 本层局部坐标
    let to = home.clone();
    let toScale = endScale * 0.85;
    try {
      if (target && target.isValid) {
        const ut = layer.getComponent('cc.UITransform') as
          { convertToNodeSpaceAR?: (w: Vec3, out: Vec3) => Vec3 } | null;
        to = ut && ut.convertToNodeSpaceAR ? ut.convertToNodeSpaceAR(target.worldPosition, new Vec3()) : target.position.clone();
        const tut = target.getComponent('cc.UITransform') as unknown as { contentSize: { width: number } } | null;
        const cur = temp.getComponent('cc.UITransform') as unknown as { contentSize: { width: number } } | null;
        if (tut && cur && cur.contentSize.width > 0) {
          toScale = endScale * (tut.contentSize.width * Math.abs(target.worldScale.x))
            / (cur.contentSize.width * endScale);
        }
      }
    } catch (e) { /* 用默认目标 */ }

    // ① 缓缓出现（放大 + 淡入）
    const chain = tween(st)
      .to(reveal, { p: 1 }, {
        easing: 'quadOut',
        onUpdate: () => {
          if (settled || !temp || !temp.isValid) return;
          try {
            const p = Math.max(0, Math.min(1, st.p));
            const s = startScale + (endScale - startScale) * p;
            temp.setScale(s, s, 1);
            if (op) op.opacity = Math.round(255 * p);
          } catch (e) { /* 忽略 */ }
        },
      });
    if (destroyAtCenter) {
      chain.call(() => {
        // 明确驻留 hold 秒：中央先清晰地露出来，再播破坏。
        setTimeout(() => {
          if (settled) return;
          const fx = CardDestroyFx.instance;
          if (fx && fx.destroyCard && temp && temp.isValid) {
            try { fx.playOnCard(temp, cleanup); return; } catch (e) { /* 回退 cleanup */ }
          }
          cleanup();
        }, Math.max(0, hold) * 1000);
      }).start();
    } else {
      chain
        .delay(hold)
        .to(fly, { p: 0 }, {
          easing: 'quadIn',
          onUpdate: () => {
            if (settled || !temp || !temp.isValid) return;
            try {
              const q = 1 - Math.max(0, Math.min(1, st.p));      // 1 → 0
              const x = home.x + (to.x - home.x) * q;
              const y = home.y + (to.y - home.y) * q;
              temp.setPosition(x, y, 0);
              const s = endScale + (toScale - endScale) * q;
              temp.setScale(s, s, 1);
              if (op) op.opacity = Math.round(255 * Math.max(0, Math.min(1, q + 0.15)));
            } catch (e) { /* 忽略 */ }
          },
        })
        .call(() => cleanup())
        .start();
    }
    // 熔断：万一补间被吞，也要保证临时卡被清掉
    setTimeout(() => { if (!settled) cleanup(); }, (reveal + hold + (destroyAtCenter ? 1.2 : fly) + 1.5) * 1000);
  } catch (e) {
    console.error('[CardAbilitySystem] 中央展示入场动画出错：', e);
    if (temp && temp.isValid) { try { killNode(temp); } catch (e2) { /* 忽略 */ } }
    finish();
  }
}

// ====================== 「谢幕曲」（LastWords）======================

/**
 * ★ **谢幕曲**：卡牌**被破坏**时发动它自己登记的 `LastWords` 能力。
 * 🔴 只在**破坏**路径调用（`destroyCardNow` / `BattleRuleSystem.destroyCard`）；
 *    **消失 / 变身**不走这里 ⇒ 谢幕曲不会发动（关键字文案口径）。
 */
export function runCardLastWords(host: Component, card: Node | null, side: CardAbilitySide): void {
  if (!host || !host.isValid || !card || !card.isValid) return;
  const id = cardIdFromNodeName(card.name);
  if (!id) return;
  // ★ **阵营以「被破坏那张卡所在的战场」为准**（不是发动能力的来源方）：
  //   我方卡破坏敌方随从时 ctx.side 是 'player'，若照抄就会把敌方的谢幕曲按我方结算 ——
  //   实测后果：敌方安朵丝的自巡炮进了**玩家手牌**；玩家手牌满时则干脆加不进去（「没有生成」）。
  let realSide: CardAbilitySide = side;
  try {
    const rules = rulesOf(host) as (RuleApi & { sideOfCard?: (c: Node | null) => number | null }) | null;
    if (rules && typeof rules.sideOfCard === 'function') {
      const s = rules.sideOfCard(card);
      if (s === BattleSide.Enemy) realSide = 'enemy';
      else if (s === BattleSide.Player) realSide = 'player';
    }
  } catch (e) { /* 取不到就沿用传入的 side */ }
  const abilities = getCardAbilities(id).filter((a) => a.name === 'LastWords');
  if (abilities.length === 0) return;
  console.log(`[CardAbilitySystem] ${id} 谢幕曲：发动 ${abilities.length} 条`);
  for (const a of abilities) {
    try {
      runCardAbilities(host, id, realSide, 'lastWords', card, null);
    } catch (e) {
      console.error(`[CardAbilitySystem] ${id} 谢幕曲执行失败：`, e);
    }
  }
}

  /**
   * ★ **模式**（关键字）：从 `params.options` 里选 `params.count`（默认 1）个发动。
   *
   * 🔴 选项的**选择界面**不在这里 —— 由 `CardPlay` 的入场曲流程弹出（`select:'mode'`，
   *    见 `ModeSelectPanel`）：卡牌先飞到左上角（与卡牌 4 一样），屏幕中央列选项，
   *    玩家点选后把索引写进 `host._fanfareMode`，本 handler 再据此结算对应的 effects。
   * 🔴 敌方 AI / 没记录到选择（例如探针直接触发）→ 退化为**第 0 个选项**。
   * 🔴 与关键字文案一致：**条件没满足的模式也能被选中**，只是它的能力不会产生效果
   *    （内嵌效果自己会判空并打日志）。
   */

/**
 * 执行某张卡指定触发时机的能力。
 * @param trigger 'use' = 使用结算时；'passive' = 入场后授予的静态效果
 * @param target  交互层已经选好的目标随从（入场曲 / 进化时的选择结果；null = 没选到）
 */
export function runCardAbilities(
  host: Component,
  cardId: string,
  side: CardAbilitySide,
  trigger: CardAbilityTrigger,
  sourceCard: Node | null = null,
  target: Node | null = null,
): void {
  if (!host || !host.isValid || !cardId) return;
  const ctx: CardAbilityContext = {
    host, cardId, side, sourceCard,
    // 🔴 先补「本卡入场曲召唤出来的那只」（见 bindSummonTarget）：入场曲与使用结算**不是同一次
    //    ctx**（CardPlay.land 先跑 fanfare、finally 再跑 use），召唤写进 ctx 的目标会在换 ctx 时丢掉 ——
    //    卡 32 的爆能强化_6 正是「入场曲召唤 → 爆能强化给复制体上毁灭」这条链，必须跨 ctx 传递。
    target: target ?? summonTargetOf(sourceCard ?? null),
  };
  for (const ability of getCardAbilities(cardId)) {
    const meta = CARD_ABILITY_MAP[ability.name];
    if (meta.trigger !== trigger) continue;
    try {
      CARD_ABILITY_HANDLERS[ability.name](ctx, ability);
    } catch (e) {
      console.error(`[CardAbilitySystem] 执行能力 ${ability.name} 失败（card=${cardId}）：`, e);
    }
  }
}

/**
 * 使用结算时触发（如战吼式抽牌）。
 * @param target 交互层已经选好的目标随从（**需要选目标的法术**由 CardPlay / EnemyCardPlay
 *               在「先选目标」流程里选好后传进来；普通法术为 null）
 */
export function runCardUseAbilities(
  host: Component,
  cardId: string,
  side: CardAbilitySide,
  sourceCard: Node | null = null,
  target: Node | null = null,
): void {
  runCardAbilities(host, cardId, side, 'use', sourceCard, target);
}

/** 随从 / 护符入场后触发被动能力（Rush / Charge 由 CardKeywordSystem 接管）。 */
export function runCardPassiveAbilities(
  host: Component,
  cardId: string,
  side: CardAbilitySide,
  sourceCard: Node | null = null,
): void {
  runCardAbilities(host, cardId, side, 'passive', sourceCard);
}

/** **交战时**触发：攻击随从 / 被随从攻击时，在互相造成伤害前结算。 */
export function runCardBattleAbilities(
  host: Component,
  cardId: string,
  side: CardAbilitySide,
  sourceCard: Node | null = null,
  target: Node | null = null,
): void {
  runCardAbilities(host, cardId, side, 'battle', sourceCard, target);
}

/**
 * **入场曲**触发：随从进入战场时调用（选择流程已把选好的目标通过 target 传进来）。
 */
export function runCardFanfareAbilities(
  host: Component,
  cardId: string,
  side: CardAbilitySide,
  sourceCard: Node | null = null,
  target: Node | null = null,
): void {
  runCardAbilities(host, cardId, side, 'fanfare', sourceCard, target);
}

/**
 * **进化时能力**触发：进化动画**播完之后**调用。
 * 顺序与规则一致：先 `evolve`（普通进化与超进化都触发），超进化再补一次 `superEvolve`。
 */
export function runCardEvolveAbilities(
  host: Component,
  cardId: string,
  side: CardAbilitySide,
  isSuper: boolean,
  sourceCard: Node | null = null,
  target: Node | null = null,
): void {
  runCardAbilities(host, cardId, side, 'evolve', sourceCard, target);
  if (isSuper) runCardAbilities(host, cardId, side, 'superEvolve', sourceCard, target);
}

/**
 * 执行某个具体能力（供吟唱 / 入场曲 / 超进化等复合能力触发内嵌效果）。
 */
export function runCardAbilityEffect(
  host: Component,
  cardId: string,
  side: CardAbilitySide,
  ability: CardAbilityInvocation,
  sourceCard: Node | null = null,
  target: Node | null = null,
): void {
  if (!host || !host.isValid || !ability || !ability.name) return;
  const ctx: CardAbilityContext = { host, cardId, side, sourceCard, target };
  try {
    const handler = CARD_ABILITY_HANDLERS[ability.name];
    if (handler) handler(ctx, ability);
  } catch (e) {
    console.error(`[CardAbilitySystem] 执行内嵌能力 ${ability.name} 失败（card=${cardId}）：`, e);
  }
}

// ====================== 目标选择（供交互层查询「这张卡要不要先选目标」）======================

/** 某张卡在指定触发时机下、需要玩家**先选一个随从目标**的能力。 */
export interface CardTargetRequest {
  /** 命中能力的触发时机（用于日志 / 区分入场曲还是进化）。 */
  trigger: CardAbilityTrigger;
  /** 能力本体（params.select / params.action 都从这里读）。 */
  ability: CardAbilityInvocation;
  /** 选择过滤条件：'enemyFollower' = 对方战场随从 / 'friendlyFollower' = 己方战场随从。 */
  select: string;
  /** 附加筛选（params.filter）：''/'any' = 不筛；'damaged' = 只要**受伤**的随从。 */
  filter: string;
}

/**
 * 查询某张卡在给定触发时机下**是否需要先让玩家选一个随从目标**。
 *
 * 🔴 会**穿透内嵌效果**：超级化这类能力的 params 里可能只写
 *    `{ name: 'Fanfare' }`（= 触发本卡自己的入场曲），此时选择条件要到
 *    「卡牌自己的 Fanfare」里去找（见 `withOwnParams` / `selectOf`）。
 *
 * @param triggers 要检查的触发时机（入场曲传 ['fanfare']；进化传 ['evolve'] 或 ['evolve','superEvolve']）
 * @returns 需要选择 → 返回第一个命中的能力；否则 null
 */
export function cardTargetRequest(
  cardId: string,
  triggers: CardAbilityTrigger[],
  side: CardAbilitySide = 'player',
): CardTargetRequest | null {
  if (!cardId) return null;
  // ★★ 需求（卡 15）：【协作_N】满足时入场曲「改为对**所有**随从造成伤害」⇒ **不需要选目标**，
  //    直接结算即可，不能把玩家丢进选择模式（实测：协作做完了还是弹选择）。
  try {
    const need = cooperationRequirementOf(cardId);
    if (need > 0 && cooperationNowGlobal(side) >= need) {
      console.log(`[CardAbilitySystem] ${cardId} 协作 ${cooperationNowGlobal(side)}/${need} 已满足 ⇒ 无需选目标`);
      return null;
    }
  } catch (e) { /* 判定失败就按原来的流程要目标 */ }
  const want = triggers || [];
  const all = getCardAbilities(cardId);
  for (const ability of all) {
    const meta = CARD_ABILITY_MAP[ability.name];
    if (want.indexOf(meta.trigger) < 0) continue;
    const select = selectOf(cardId, ability, all);
    if (select) return { trigger: meta.trigger, ability, select, filter: filterOf(cardId, ability, all) };
  }
  return null;
}

/** 在能力树里找 params.select（本层 → 内嵌效果 → 本卡同名能力），找不到返回 '' */
function selectOf(
  cardId: string,
  ability: CardAbilityInvocation,
  all: CardAbilityInvocation[],
  depth = 0,
): string {
  const direct = asString(ability.params?.select);
  if (direct) return direct;
  if (depth > 3) return '';
  for (const nested of nestedInvocations(ability)) {
    const s = selectOf(cardId, withOwnParams(cardId, nested, all), all, depth + 1);
    if (s) return s;
  }
  return '';
}

/**
 * 在能力树里找 params.filter（附加筛选；与 select 同一层，跟着 select 一起穿透内嵌效果）。
 * 当前支持：`'damaged'` = 只要受伤的随从（见 BattleRuleSystem.isDamaged）。
 */
function filterOf(
  cardId: string,
  ability: CardAbilityInvocation,
  all: CardAbilityInvocation[],
  depth = 0,
): string {
  const direct = asString(ability.params?.filter);
  if (direct) return direct;
  if (depth > 3) return '';
  for (const nested of nestedInvocations(ability)) {
    const f = filterOf(cardId, withOwnParams(cardId, nested, all), all, depth + 1);
    if (f) return f;
  }
  return '';
}

/** 取能力里内嵌的子能力调用（params.effect 单个 + params.effects 数组） */
function nestedInvocations(ability: CardAbilityInvocation): CardAbilityInvocation[] {
  const out: CardAbilityInvocation[] = [];
  const single = asInvocation(ability.params?.effect);
  if (single) out.push(single);
  const list = ability.params?.effects;
  if (Array.isArray(list)) {
    for (const item of list) {
      const inv = asInvocation(item);
      if (inv) out.push(inv);
    }
  }
  return out;
}

/**
 * 内嵌调用没写 params 时，用**本卡同名能力**的 params 补全。
 * 例：超进化的 `{ name: 'Fanfare' }`（只写名字）= 「触发本卡自己的入场曲」，
 *     于是它复用本卡 Fanfare 的 `{ select: 'enemyFollower', action: 'destroy' }`。
 */
function withOwnParams(
  cardId: string,
  inv: CardAbilityInvocation,
  all: CardAbilityInvocation[],
): CardAbilityInvocation {
  if (inv.params && Object.keys(inv.params).length > 0) return inv;
  const own = all.find((a) => a.name === inv.name);
  if (own && own.params) return { name: inv.name, params: { ...own.params } };
  return inv;
}

/** 选择过滤条件是否合法（交互层用它校验）。 */
export function isSelectFilter(select: string): boolean {
  return select === 'enemyFollower' || select === 'friendlyFollower';
}

// ====================== 内部工具 ======================

/**
 * 把战场上的一张卡按「破坏」处理（**通用入口**，能力 / 纹章效果都用它）。
 * 首选：走 BattleCommandSystem 的演出队列 —— 与「随从被破坏」**完全同一条链路**：
 *   立刻摘除战场逻辑（不可选 / 不计守护 / 不占位，且**不立刻重排**）
 *   → 排 Destroy cue（破坏动画 + 特效，特效负责销毁节点）
 *   → 再排 Reflow cue（破坏动画**播完之后**用连续动画重排战场）。
 *   这就是「护符被破坏时战场排布也要有动画、不能一下更新」的实现路径。
 *
 * @param host 调用方组件（用于按类名找 BattleCommandSystem）
 * @param card 要破坏的战场卡牌（不在任何战场里时退回「直接移除」）
 * @returns 是否已排入 / 执行了破坏（false = 卡牌无效）
 */
export function destroyFieldCard(host: Component, card: Node): boolean {
  if (!card || !card.isValid) return false;
  if (!canDestroyFieldCardByAbility(host, card)) return false;
  let field: any = null;
  let n: Node | null = card.parent;
  while (n) {
    const f = n.getComponent('BattleFieldLayout');
    if (f && f.isValid) { field = f; break; }
    n = n.parent;
  }

  const cmds = findComponent(host, 'BattleCommandSystem') as {
    destroyCardOnField?: (card: Node, field?: any, onDone?: () => void) => boolean;
  } | null;
  if (field && cmds && typeof cmds.destroyCardOnField === 'function') {
    try {
      if (cmds.destroyCardOnField(card, field)) return true;
    } catch (e) {
      console.error('[CardAbilitySystem] 排入破坏演出队列失败，回退为立即移除：', e);
    }
  }

  // 兜底：没有演出队列（或该卡不在战场记录里）→ 旧行为（立即移除 + 立即重排）。
  if (field && typeof field.removeCardNode === 'function') {
    field.removeCardNode(card);
  } else if (card.parent) {
    card.parent.removeChild(card);
    card.destroy();
  }
  return true;
}

/**
 * 统一判据：这次「能力破坏」能否生效。
 * 🔴 目标血量 <= 0 时属于“数字伤害致死”，永远放行；血量 > 0 时才检查
 * `AbilityDestroyImmune`，从而保证毁灭 / 入场曲 / 进化时 / 纹章等直接破坏全部被挡住。
 */
export function canDestroyFieldCardByAbility(host: Component, card: Node | null): boolean {
  if (!card || !card.isValid) return false;
  try {
    const rules = findComponent(host, 'BattleRuleSystem') as {
      canDestroyByAbility?: (n: Node) => boolean;
    } | null;
    if (rules && typeof rules.canDestroyByAbility === 'function') {
      return rules.canDestroyByAbility(card) === true;
    }
  } catch (e) { /* 找不到规则系统时保持旧行为 */ }
  return true;
}

/** 能力上下文版本的破坏（保持旧签名，内部走 `destroyFieldCard`） */
function destroyCardNow(ctx: CardAbilityContext, card: Node): boolean {
  if (!canDestroyFieldCardByAbility(ctx.host, card)) return false;
  // ★ 谢幕曲：**被破坏时**发动（在摘场 / 破坏演出之前结算；消失走的是另一条路，不会到这里）
  try { runCardLastWords(ctx.host, card, ctx.side); } catch (e) {
    console.error('[CardAbilitySystem] 谢幕曲结算出错（不影响破坏）：', e);
  }
  return destroyFieldCard(ctx.host, card);
}

/**
 * **目标选择型动作**（`params.action`）的统一入口 —— 入场曲 / 进化时 / 超进化共用。
 * 现在支持 `'destroy'`（破坏 ctx.target，先排一次**普通攻击特效球**的演出）；未实现的 action 会告警。
 *
 * ★ 攻击演出：与普通攻击**同一颗特效球**（`BattleCueType.AttackOrb` cue），
 *   从来源随从中心飞向目标中心，**卡牌不旋转**；cue 顺序 = 「先球、再破坏动画」。
 *   🔴 纯演出：破坏的判定 / 摘场在 `destroyCardNow` 里**同步**结算完，不等球飞完。
 * 🔴 目标由交互层在**相应时机之前**选好（入场曲 = 进入战场前；进化 = 进化前），
 *    没选到就只告警、不结算（`params.filter` 的筛选在选择层完成，见 TargetSelectSystem）。
 */
function runTargetAction(
  ctx: CardAbilityContext,
  ability: CardAbilityInvocation,
  label: string,
  withStrikeFx = true,
): void {
  const action = asString(ability.params?.action);
  if (!action) return;
  if (action === 'destroy') {
    const target = ctx.target;
    if (!target || !target.isValid) {
      console.warn(`[CardAbilitySystem] ${label} ${ctx.cardId} 需要选择目标但未选到，跳过 action=destroy`);
      return;
    }
    if (!canDestroyFieldCardByAbility(ctx.host, target)) return;
    if (withStrikeFx) pushAbilityStrikeCue(ctx, target);
    destroyCardNow(ctx, target);
    return;
  }
  console.warn(`[CardAbilitySystem] ${label} ${ctx.cardId} 的 action="${action}" 未实现`);
}

/**
 * ★ **能力「破坏」的攻击演出**：用**普通攻击那颗特效球**（`BattleCueType.AttackOrb` cue）——
 * 从**来源卡牌**（打出 / 进化后的这张卡）的中心飞向**目标卡牌**的中心，飞完才轮到破坏动画。
 *
 * 🔴 需求：这里的攻击特效要与**普通攻击完全一致**，但**卡牌本身不旋转** ——
 *    旋转由 `FollowerAttackAnim.playSingleAttack` 负责，本 cue 走的是
 *    `playOrbAttack`（只发球、一次都不写 eulerAngles）。素材 / 尺寸 / 染色 / 加色 /
 *    曲线偏移 / 时长全部沿用 `FollowerAttackAnim` 的 Inspector 参数（与普通攻击同一套）。
 *
 * 🔴 只是演出，不参与结算：破坏的判定 / 数值 / 摘场 / 记墓场在 `destroyFieldCard` 里**同步**完成。
 *    全程 fail-open：缺演出队列 / 缺来源卡 → 跳过这段演出，绝不影响结算。
 */
function pushAbilityStrikeCue(ctx: CardAbilityContext, target: Node): void {
  try {
    const src = ctx.sourceCard;
    if (!src || !src.isValid || !target || !target.isValid) return;
    const cmds = findComponent(ctx.host, 'BattleCommandSystem') as {
      pushCue?: (cue: { type: string;[key: string]: unknown }) => void;
    } | null;
    if (!cmds || typeof cmds.pushCue !== 'function') return;
    cmds.pushCue({
      type: BattleCueType.AttackOrb,
      attacker: src,
      defender: target,
      card: target,
      crestId: ctx.cardId,
      side: ctx.side,
    });
  } catch (e) {
    console.error('[CardAbilitySystem] 排入「能力攻击球」演出失败（不影响结算）：', e);
  }
}

/**
 * 依次触发 params.effect（单个）与 params.effects（数组）里登记的内嵌能力。
 * 🔴 内嵌调用没写 params 时，用**本卡同名能力**的 params 补全（见 withOwnParams）：
 *    超进化的 `{ name: 'Fanfare' }` 于是就是「再触发一次本卡的入场曲」。
 *
 * 🔴🔴 **「获得纹章」优先结算**（需求）：同一个时点里必须先落地纹章，**再**触发同批的其它效果。
 *    典型 = 卡 4 超进化：`effects:[GainCrest, Fanfare]` —— 先拿到纹章，随后的入场曲破坏
 *    才能被这枚纹章的**触发型效果**（「我方回合时，当对方随从被破坏时对对方主战者造成 2 点伤害」）
 *    感知到；否则破坏先发生、纹章还没到手，触发条件永远不成立。
 *    排序用**稳定排序**（`Array.prototype.sort` 在 ES2019+ 稳定）⇒ 非纹章效果仍保持书写顺序。
 */
function runNestedEffects(ctx: CardAbilityContext, ability: CardAbilityInvocation): void {
  const all = getCardAbilities(ctx.cardId);
  const invs = nestedInvocations(ability).map((raw) => withOwnParams(ctx.cardId, raw, all));
  invs.sort((a, b) => nestedEffectPriority(a) - nestedEffectPriority(b));
  for (const inv of invs) {
    runCardAbilityEffect(ctx.host, ctx.cardId, ctx.side, inv, ctx.sourceCard, ctx.target ?? null);
  }
}

/** 内嵌效果的结算优先级（数值小的先跑）：获得纹章最先，其余保持原有书写顺序。 */
function nestedEffectPriority(inv: CardAbilityInvocation): number {
  return inv.name === 'GainCrest' ? 0 : 1;
}

/**
 * 取「分配伤害」的伤害点数 X：
 *   · params.amountFrom === 'attack' → **来源随从当前的攻击力**（进化时能力 = 进化后的值）；
 *   · 否则读 params.amount（正整数）。取不到 / 非正数 → 0（调用方直接跳过）。
 */
function distributeAmountOf(ctx: CardAbilityContext, ability: CardAbilityInvocation): number {
  if (asString(ability.params?.amountFrom) === 'attack') {
    const rules = findComponent(ctx.host, 'BattleRuleSystem') as {
      getAttack?: (card: Node | null) => number | null;
    } | null;
    const atk = rules && typeof rules.getAttack === 'function' && ctx.sourceCard
      ? rules.getAttack(ctx.sourceCard) : null;
    const v = typeof atk === 'number' && isFinite(atk) ? atk : 0;
    return Math.max(0, Math.round(v));
  }
  const n = Number(ability.params?.amount);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * 能力归属方 + params.side → 要分配伤害的战场阵营（**默认 opponent = 对方战场**）。
 *   · 'self' → 己方；'both' → 己方 + 对方（顺序：先己方后对方）；其余 → 对方。
 */
function damageSidesOf(owner: CardAbilitySide, mode: string): BattleSide[] {
  const own = owner === 'enemy' ? BattleSide.Enemy : BattleSide.Player;
  const foe = owner === 'enemy' ? BattleSide.Player : BattleSide.Enemy;
  if (mode === 'self') return [own];
  if (mode === 'both') return [own, foe];
  return [foe];
}

/** 把能力参数里的「像能力调用」的值取出来（对象且带合法 name），否则 null。 */
function asInvocation(value: unknown): CardAbilityInvocation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return normalizeCardAbility(value as CardAbilityInvocation);
}

/** 把能力参数里的值读成**去重后的字符串数组**（`['Guard']` / `'Guard'` / 混写都能吃）。 */
function asStringArray(value: unknown): string[] {
  if (typeof value === 'string') { const s = value.trim(); return s ? [s] : []; }
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const s = asString(item);
    if (s && out.indexOf(s) < 0) out.push(s);
  }
  return out;
}

/**
 * ★ **跨 ctx 的「召唤物目标」登记**（见 `CARD_ABILITY_MAP.Summon` 的 `params.grantTo`）。
 *
 * 为什么需要它（卡 32「烈日魔犬」实测踩到）：
 *   入场曲与使用结算**不是同一次 `runCardAbilities` 调用**（`CardPlay.land` 先跑 fanfare、
 *   finally 里再跑 `runCardUseAbilities`）⇒ `ctx` 是**两个不同的对象**。
 *   `Summon` 把召唤物写进 fanfare 的 ctx，等爆能强化（trigger=`use`）开跑时那个 ctx 已经没了，
 *   `BuffSelected` 读到 `target = null` ⇒ 复制体拿不到【毁灭】。
 * 做法：以**来源卡节点**为键把召唤物记下来，新的 ctx 建好时自动补上（没有则保持 null）。
 */
const _summonTargets = new WeakMap<Node, Node>();

/** 记下「这张来源卡在本次打出里召唤出来的那只」 */
function bindSummonTarget(source: Node | null, summoned: Node | null): void {
  if (!source || !source.isValid || !summoned || !summoned.isValid) return;
  try { _summonTargets.set(source, summoned); } catch (e) { /* 忽略 */ }
}

/** 取「这张来源卡在本次打出里召唤出来的那只」（已失效 → null） */
function summonTargetOf(source: Node | null): Node | null {
  if (!source || !source.isValid) return null;
  try {
    const hit = _summonTargets.get(source);
    return hit && hit.isValid ? hit : null;
  } catch (e) { return null; }
}

// ====================== 「本随从超进化」（SelfSuperEvolve）======================

/**
 * 取当前对局的**超进化编制**（数值 / 关键词）—— 与 `FollowerEvolve.evolveTuningOf`
 * 同一口径：优先读 `EvoDragController` 的 Inspector 值，读不到用默认（+3/+3、突进）。
 * 🔴 这里**故意不 import FollowerEvolve**：`FollowerEvolve` 已经 import 本文件
 *    （`runCardEvolveAbilities` / `findComponent`），反向 import 会形成环。
 */
function superEvolveTuningOf(host: Component): { attackGain: number; hpGain: number; keyword: string } {
  const fallback = { attackGain: 3, hpGain: 3, keyword: 'Rush' };
  const drag = findComponent(host, 'EvoDragController') as {
    superAttackGain?: number; superHpGain?: number; evolveKeyword?: string;
  } | null;
  if (!drag) return fallback;
  const num = (v: unknown, fb: number): number => (typeof v === 'number' && isFinite(v) ? v : fb);
  return {
    attackGain: num(drag.superAttackGain, fallback.attackGain),
    hpGain: num(drag.superHpGain, fallback.hpGain),
    keyword: typeof drag.evolveKeyword === 'string' ? drag.evolveKeyword : fallback.keyword,
  };
}

/**
 * ★ **让来源随从自己超进化**（卡 27 的爆能强化_8，见 `CARD_ABILITY_MAP.SelfSuperEvolve`）。
 *
 * 结算内容与「拖超进化点进化」**完全同源**（口径见 `FollowerEvolve.evolveFollower`）：
 *   ① `canEvolve` 校验（已进化过 / 非随从 / 不在战场 → 直接跳过，只打日志）；
 *   ② 数值走 `beginDeferredDisplay → addStats → endDeferredDisplay`（逻辑当场变，数字按统一口径刷新）；
 *   ③ `markEvolved(card, true)` → 打上**超进化**标记（获得超进化守护）+ 视为已进化；
 *   ④ 授予进化词条（默认【突进】）；
 *   ⑤ 依次结算本卡自己的 `evolve` / `superEvolve` 能力。
 *
 * 🔴 **不消耗进化点、不播进化动画**（本能力在「使用结算」时点同步结算）—— 这一点与拖拽进化不同，
 *    写文案时不要承诺动画。
 * 🔴 不调用 `runCardEvolveAbilities`（那会连 `evolve` + `superEvolve` 一起跑，正是我们要的），
 *    只是这里显式传 `isSuper = true`。
 */
function selfSuperEvolveNow(ctx: CardAbilityContext): void {
  const card = ctx.sourceCard;
  if (!card || !card.isValid) {
    console.warn(`[CardAbilitySystem] ${ctx.cardId} 本随从超进化：来源卡无效，跳过`);
    return;
  }
  const rules = rulesOf(ctx.host) as (RuleApi & {
    canEvolve?: (c: Node | null) => boolean;
    markEvolved?: (c: Node | null, isSuper?: boolean) => void;
    addStats?: (c: Node | null, a: number, h: number) => boolean;
    beginDeferredDisplay?: () => void;
    endDeferredDisplay?: () => unknown;
  }) | null;
  if (!rules || typeof rules.markEvolved !== 'function' || typeof rules.addStats !== 'function') {
    console.warn(`[CardAbilitySystem] ${ctx.cardId} 本随从超进化：找不到可用的 BattleRuleSystem，跳过`);
    return;
  }
  if (typeof rules.canEvolve === 'function' && rules.canEvolve(card) !== true) {
    console.log(`[CardAbilitySystem] ${ctx.cardId} 本随从超进化：该随从不可进化（已进化过 / 不在战场），跳过`);
    return;
  }
  const tuning = superEvolveTuningOf(ctx.host);
  const defer = typeof rules.beginDeferredDisplay === 'function'
    && typeof rules.endDeferredDisplay === 'function';
  let batch: unknown = null;
  try {
    if (defer) rules.beginDeferredDisplay!();
    rules.addStats(card, tuning.attackGain, tuning.hpGain);
    rules.markEvolved(card, true);
    if (tuning.keyword) grantKeyword(ctx.host, card, tuning.keyword);
    if (defer) { batch = rules.endDeferredDisplay!(); }
  } catch (e) {
    console.error('[CardAbilitySystem] 本随从超进化结算出错（不影响后续）：', e);
    if (defer && batch === null) { try { rules.endDeferredDisplay!(); } catch (e2) { /* 忽略 */ } }
  }
  // ★ 自动超进化也播**原地**进化动画（含超进化紫色名牌）：动画播完再结算进化时能力（与手动拖拽同口径）。
  //   🔴 有动画时**不要**再 push 数字 cue —— 数字由动画 reveal 用同一份 batch 写回（否则会提前跳出旧数字）。
  const fxInPlace = findComponent(ctx.host, 'EvolveFollowerFx') as
    { playInPlace?: (c: Node, s: boolean, d: unknown, cb?: () => void) => void } | null;
  const runEvolveAbilities = (): void => {
    try {
      runCardEvolveAbilities(ctx.host, ctx.cardId, ctx.side, true, card, ctx.target ?? null);
    } catch (e) {
      console.error('[CardAbilitySystem] 本随从超进化的进化时能力结算失败：', e);
    }
  };
  if (fxInPlace && typeof fxInPlace.playInPlace === 'function') {
    fxInPlace.playInPlace(card, true, batch, runEvolveAbilities);
  } else {
    pushRefreshNumbersCue(ctx, batch);
  }
  console.log(`[CardAbilitySystem] ${ctx.cardId} 本随从超进化：${card.name}`
    + ` +${tuning.attackGain}/+${tuning.hpGain}${tuning.keyword ? ' + ' + tuning.keyword : ''}`);
  // ③ 本卡自己的进化时 / 超进化时能力：有原地动画时由动画播完回调触发（见上），
  //    没有动画组件时才在这里同步结算（保证能力一定结算）。
  if (!(fxInPlace && typeof fxInPlace.playInPlace === 'function')) runEvolveAbilities();
}

/** 给某张战场卡授予一个运行时关键词（拿不到 CardKeywordSystem 时只告警）。 */
function grantKeyword(host: Component, card: Node, keyword: string): void {
  if (!keyword) return;
  const kw = findComponent(host, 'CardKeywordSystem') as {
    addKeyword?: (c: Node | null, k: string) => boolean;
  } | null;
  if (!kw || typeof kw.addKeyword !== 'function') {
    console.warn(`[CardAbilitySystem] 找不到 CardKeywordSystem，关键词 ${keyword} 未授予`);
    return;
  }
  try { kw.addKeyword(card, keyword); } catch (e) { /* 忽略 */ }
}

// ====================== 「破坏攻击力最高的敌方随从」======================

/**
 * ★ **破坏对手战场上攻击力最高的随从**（卡 28「骇人的轰炸」）。
 *
 * 候选 = `TargetSelectSystem.candidatesFor(owner, 'enemyFollower')` —— 与「选目标」类能力
 * **同一份口径**（只挑随从；潜行 / 灵气照常排除），所以不会绕过既有保护规则。
 * 攻击力相同 → 取**最左**那一只（与 `TargetSelectSystem.autoPick` 的策略一致）。
 * 破坏走 `destroyCardNow`（= 谢幕曲照发 + 通用破坏管线：破坏动画 → 之后连续重排）。
 */
function destroyHighestAttackNow(ctx: CardAbilityContext): void {
  const sel = findComponent(ctx.host, 'TargetSelectSystem') as {
    candidatesFor?: (owner: CardAbilitySide, select: string, filter?: string) => Node[];
  } | null;
  if (!sel || typeof sel.candidatesFor !== 'function') {
    console.warn(`[CardAbilitySystem] ${ctx.cardId} 破坏最高攻击随从：找不到 TargetSelectSystem，跳过`);
    return;
  }
  let pool: Node[] = [];
  try {
    pool = (sel.candidatesFor(ctx.side, 'enemyFollower', '') || []).filter((n) => !!n && n.isValid);
  } catch (e) {
    console.error('[CardAbilitySystem] 破坏最高攻击随从：取候选出错，跳过', e);
    return;
  }
  if (pool.length === 0) {
    console.log(`[CardAbilitySystem] ${ctx.cardId} 破坏最高攻击随从：对手战场没有合法候选，跳过`);
    return;
  }
  const rules = rulesOf(ctx.host);
  const atkOf = (n: Node): number => {
    const v = rules && typeof rules.getAttack === 'function' ? rules.getAttack(n) : null;
    if (typeof v === 'number' && isFinite(v)) return v;
    const info = getCardInfo(cardIdFromNodeName(n.name));
    return info && typeof info.attack === 'number' ? info.attack : 0;
  };
  let best = pool[0];
  let bestAtk = atkOf(best);
  for (let i = 1; i < pool.length; i++) {
    const v = atkOf(pool[i]);
    if (v > bestAtk) { best = pool[i]; bestAtk = v; }      // 严格大于 ⇒ 并列保留最左
  }
  console.log(`[CardAbilitySystem] ${ctx.cardId} 破坏最高攻击随从：${best.name}`
    + `（攻击力 ${bestAtk}，候选 ${pool.length} 只）`);
  destroyCardNow(ctx, best);
}

// ====================== 「召唤」（Summon）======================


/**
 * ★ **从牌组挑一张「召唤用」的卡**（用户口径，卡 2「从牌组召唤费用 ≤N 的随从」）：
 *   · **先按费用从大到小**：只考虑「符合条件的最高费用」那一档；
 *   · 同费用里**随机**取一张；
 *   · ⇒ 牌组里有 3 费 + 2 费时**只会召唤 3 费那张**；有两张 3 费则在两张里随机，**不会退到 2 费**。
 * 只挑不算取出（取出由调用方 `takeWhere` 精确移除）。
 */
function pickDeckSummonId(
  deck: { remainingCards?: (side: string) => string[] },
  side: string,
  matches: (id: string) => boolean,
): string {
  try {
    const list = typeof deck.remainingCards === 'function' ? deck.remainingCards(side) : [];
    const ok = list.filter((cid) => { try { return matches(cid); } catch (e) { return false; } });
    if (ok.length === 0) return '';
    let best = -1;
    for (const cid of ok) {
      const info = getCardInfo(cid);
      const cost = info ? info.cost : 0;
      if (cost > best) best = cost;
    }
    const top = ok.filter((cid) => { const info = getCardInfo(cid); return (info ? info.cost : 0) === best; });
    if (top.length === 0) return '';
    const picked = top[Math.floor(Math.random() * top.length)];
    console.log(`[CardAbilitySystem] 牌组召唤选牌：符合条件 ${ok.length} 张，最高费用 ${best}`
      + `（该档 ${top.length} 张）⇒ 随机选中 ${picked}`);
    return picked;
  } catch (e) {
    console.error('[CardAbilitySystem] 牌组召唤选牌出错：', e);
    return '';
  }
}

/**
 * ★ **召唤**（关键字，见 `TIP_KEYWORD_DESC['召唤']`）。
 *
 * 与「从手牌使用」的区别（需求逐条）：
 *   · 🔴 **不触发入场曲** —— 召唤只把卡「放上战场」，不跑 fanfare（见 `BattleFieldLayout.summonCard`）；
 *   · 🔴 **不做屏幕中央展示** —— 直接出现在战场对应位置；
 *   · ✅ 仍然有**卡牌落地时的特效**（`summonCard` 落位后炸的召唤光球）；
 *   · 🔴 **从牌组召唤会真的从牌组里移除**那张卡（`CardDeckManager.takeWhere` 取出即移除）；
 *     牌组里没有符合条件的卡 → **召唤为空**（仍然算「使用了召唤」，只是什么都没召唤出来）；
 *   · 🔴 **能不能发动召唤与战场剩余宽度无关**；只有「召唤出来的卡能不能进场」才看战场是否已满；
 *   · 🔴 战场已满时：卡先出现在**战场最右（我方）/ 最左（敌方）**再往外一格，**等 0.5s**
 *     播破坏动画 —— 但**不算破坏、不进墓场**（它从没进过战场逻辑集合）。
 *
 * 逻辑**立即结算**（不等动画）；召唤多个时各卡的入场动画在同一帧一起开播。
 */
function summonCards(ctx: CardAbilityContext, ability: CardAbilityInvocation): void {
  const params = ability.params || {};
  const count = Math.max(1, asInt(params.count) || 1);
  const from = asString(params.from) || 'deck';
  const wantType = asString(params.cardType) || 'Follower';
  const maxCost = typeof params.maxCost === 'number' ? Math.round(params.maxCost) : -1;
  const minCost = typeof params.minCost === 'number' ? Math.round(params.minCost) : -1;
  const fixedId = asString(params.id);

  const rules = rulesOf(ctx.host);
  const field = rules && typeof rules.fieldOfSide === 'function'
    ? rules.fieldOfSide(ctx.side === 'enemy' ? BattleSide.Enemy : BattleSide.Player)
    : null;
  if (!field || !field.isValid) {
    console.warn(`[CardAbilitySystem] ${ctx.cardId} 召唤：找不到 ${ctx.side} 的战场，跳过`);
    return;
  }
  const summon = (field as unknown as {
    summonCard?: (node: Node, id: string, opts?: { silent?: boolean; deferLayout?: boolean }) => { ok: boolean; reason?: string };
    overflowSlot?: (side: BattleSide) => { x: number; y: number; z: number };
  });

  const deck = findComponent(ctx.host, 'CardDeckManager') as {
    takeWhere?: (side: string, test: (id: string) => boolean) => string;
    remainingCards?: (side: string) => string[];
  } | null;
  const composers = findComponents(ctx.host, 'CardComposer') as Array<{
    composeCard?: (id: string, name?: string, index?: number,
                  opts?: { frameOverride?: string; suppressCost?: boolean }) => Node | null;
  }>;

  const matches = (cid: string): boolean => {
    const info = getCardInfo(cid);
    if (!info) return false;
    if (info.cardType !== wantType) return false;
    if (maxCost >= 0 && info.cost > maxCost) return false;
    if (minCost >= 0 && info.cost < minCost) return false;
    return true;
  };

  let summoned = 0;
  /** `grantTo:'source'` 只认**第一只**成功入场的召唤物（避免多张时目标漂到最后一张）。 */
  let grantToSet = false;
  /** 本次召唤出来、**要等本体落地特效播完再显示**的卡（见文件末尾 deferSummonReveal） */
  const pendingReveal: Node[] = [];
  /** 🔴 打出时就已经从牌组预扣好的卡（Task 2：状态栏在**打出那一刻**就要跳到最终牌组数） */
  const pre = (ctx.host as unknown as { _preSummon?: string[] })._preSummon;
  for (let i = 0; i < count; i++) {
    // ① 取卡：优先用**打出时预扣**的；否则牌组按条件随机取（取出即移除）；生成 → 用 params.id
    let id = '';
    if (pre && pre.length > 0) {
      id = pre.shift() as string;
    } else if (from === 'deck') {
      if (!deck || typeof deck.takeWhere !== 'function') {
        console.warn(`[CardAbilitySystem] ${ctx.cardId} 召唤：找不到 CardDeckManager，按空处理`);
      } else {
        // ★ 先按费用从大到小、同费用随机（见 pickDeckSummonId）
        const pick = pickDeckSummonId(deck, ctx.side, matches);
        id = pick ? deck.takeWhere(ctx.side, (cid) => cid === pick) : '';
      }
    } else {
      id = fixedId;
    }
    if (!id) {
      // 🔴 牌组里没有符合条件的卡 ⇒ **召唤为空**（这次召唤照常算「结算过」，只是没召唤出东西）
      console.log(`[CardAbilitySystem] ${ctx.cardId} 召唤（第 ${i + 1}/${count} 次）：`
        + `来源=${from} 没有符合条件的卡 → 召唤为空`);
      continue;
    }

    // ② 生成「战场样式」卡牌节点（与手牌打出同一套：frameOverride = BF_<frame>）
    const frame = (field as unknown as { frameFor?: (id: string) => string | null }).frameFor
      ? (field as unknown as { frameFor: (id: string) => string | null }).frameFor(id) : null;
    let node: Node | null = null;
    for (const c of composers) {
      if (!c || typeof c.composeCard !== 'function') continue;
      try {
        node = c.composeCard(id, 'Summon_' + id.replace(/[^\w]/g, '_') + '_' + (summoned + 1),
          undefined, { frameOverride: frame || undefined, suppressCost: !(field as unknown as { showCost?: boolean }).showCost });
      } catch (e) { node = null; }
      if (node && node.isValid) break;
    }
    if (!node || !node.isValid) {
      console.warn(`[CardAbilitySystem] ${ctx.cardId} 召唤：${id} 的战场卡节点生成失败，跳过`);
      continue;
    }

    // ③ 直接放上战场（逻辑立即生效；成功 = 落位 + 落地光球，不跑入场曲）
    //    🔴 `silent`：**先不炸光球、先隐藏**，等本体（如可露凯）的落地光圈特效完全播完再显示 + 炸球。
    // ★ `deferLayout`：新卡只摆到自己的槽位，其余卡先不动 —— 随后补一条 Reflow cue 做连续动画重排
    //   （需求：召唤时战场排布不能瞬间更新）。电浆/召唤的**入场演出**照旧。
    const res = (summon && typeof summon.summonCard === 'function')
      ? summon.summonCard(node, id, { silent: true, deferLayout: true })
      : { ok: false, reason: 'BattleFieldLayout 不支持 summonCard' };
    if (res.ok) {
      summoned++;
      node.active = false;                       // 隐藏：等本体落地特效播完（deferSummonReveal 里打开）
      pendingReveal.push(node);
      // ★ `params.grantTo === 'source'`：把**这一只刚召唤出来的随从**设为本次能力的「选中目标」，
      //   让同一条入场曲里随后的 `BuffSelected` 作用在**召唤出来的那只**身上
      //   （卡 32「烈日魔犬」的爆能强化_6：给复制体上【毁灭】）。
      if (asString(params.grantTo) === 'source') {
        ctx.target = node;
        bindSummonTarget(ctx.sourceCard, node);
        if (!grantToSet) {
          grantToSet = true;
          console.log(`[CardAbilitySystem] ${ctx.cardId} 召唤：已把「${id}」设为本次能力的选中目标（grantTo=source）`);
        }
      }
      console.log(`[CardAbilitySystem] ${ctx.cardId} 召唤：${id} 进入战场（${ctx.side}）`
        + `（等落地特效播完再显示）`);
      // 🔴 召唤**不跑入场曲**，但**静态词条照常生效**（突进 / 守护 / 潜行…与从手牌打出同款）。
      try { runCardPassiveAbilities(ctx.host, id, ctx.side, node); } catch (e) {
        console.error('[CardAbilitySystem] 召唤后授予静态词条出错：', e);
      }
      continue;
    }

    // ④ 溢出：战场已满 → 摆在战场最外侧，0.5s 后播破坏动画（**不算破坏、不进墓场**）
    console.log(`[CardAbilitySystem] ${ctx.cardId} 召唤：${id} 无法进场（${res.reason || '战场已满'}）`
      + ` → 战场外侧展示 0.5s 后收掉（不算破坏、不进墓场）`);
    const slot = (summon && typeof summon.overflowSlot === 'function')
      ? summon.overflowSlot(ctx.side === 'enemy' ? BattleSide.Enemy : BattleSide.Player)
      : { x: 0, y: 0, z: 0 };
    node.setParent(field.node, true);
    node.setPosition(slot.x, slot.y, slot.z);
    node.name = 'Overflow_' + id;      // 🔴 不进 _entries（不是战场卡），名字也要能一眼认出来
    summonOverflowFx(ctx.host, node);
  }
  console.log(`[CardAbilitySystem] ${ctx.cardId} 召唤结算完毕：成功 ${summoned}/${count}`);
  // ★ 召唤后补一条 Reflow：让**连续动画**把整排卡重排到位（而不是瞬间 snap）
  // ★★ 需求：**先等排布动画播到位，再播召唤入场动画** ⇒ Reflow 之后再压一条 Done cue，
  //     由它去启动 `deferSummonReveal`（等落地光球 / 进化动画 → 显示 + 炸入场光球）。
  //     演出队列是 FIFO，Reflow cue 的 done 在动画结束那一刻触发 ⇒ 顺序天然正确。
  if (summoned > 0 && field && field.isValid) {
    const nodes = pendingReveal.slice();
    try {
      const cmds = findComponent(ctx.host, 'BattleCommandSystem') as
        { pushCue?: (cue: unknown) => void; pushCues?: (cues: unknown[], front?: boolean) => void } | null;
      if (cmds && typeof cmds.pushCue === 'function') {
        cmds.pushCue({ type: 'Reflow', field });
        cmds.pushCue({
          type: 'Done',
          cb: () => {
            const alive = nodes.filter((n) => !!n && n.isValid);
            if (alive.length > 0) deferSummonReveal(field, ctx, alive);
          },
        });
      } else {
        deferSummonReveal(field, ctx, nodes);          // 没有演出队列 → 退回原来的直接等待
      }
    } catch (e) {
      console.error('[CardAbilitySystem] 召唤后排入重排/入场演出失败（不影响结算）：', e);
      deferSummonReveal(field, ctx, nodes);
    }
  }
  // （入场动画的启动已挪到上面 Reflow cue 之后的 Done cue 里 —— 要先等排布动画播到位）
}

/**
 * ★ **等本体落地特效播完再显示被召唤的卡**（需求）。
 *
 * 判据 = 本体（`ctx.sourceCard`）身上那颗**召唤光球**（`CardSummonOrbFx.isPlaying`）是否还在播 ——
 * 也就是玩家看到的「落地光圈」；它消失（或本体没了 / 超时）才：
 *   ① 打开被召唤卡的显示；② 在它自己的位置上炸落地光球（入场动画特效）。
 * 🔴 逻辑**早已结算完**（牌组已扣、战场集合已登记），这里只是**演出时点**；召唤多张时**一起播**。
 * 🔴 轮询用原生 `setInterval`（不能依赖宿主组件的调度器，宿主可能已 inactive）。
 */
function deferSummonReveal(
  field: BattleFieldLayout,
  ctx: CardAbilityContext,
  nodes: Node[],
): void {
  const src = ctx.sourceCard && ctx.sourceCard.isValid ? ctx.sourceCard : null;
  const t0 = Date.now();
  const MAX_WAIT = 6000;                 // 熔断：本体特效异常时不至于永远不显示
  const tick = (): void => {
    const alive = nodes.filter((n) => !!n && n.isValid);
    if (alive.length === 0) { clearInterval(timer); return; }
    let busy = false;
    if (src && src.isValid) {
      const orb = (field as unknown as { summonOrbOf?: (n: Node) => { isPlaying?: boolean } | null })
        .summonOrbOf ? (field as unknown as { summonOrbOf: (n: Node) => { isPlaying?: boolean } | null }).summonOrbOf(src) : null;
      busy = !!(orb && orb.isPlaying === true);
    }
    // ★ 需求：**进化动画播完**才开始召唤入场动画（结算逻辑依旧是立即的，这里只管演出时点）。
    if (!busy) {
      const evo = findComponent(field, 'EvolveFollowerFx') as { isPlaying?: boolean } | null;
      if (evo && evo.isPlaying === true) busy = true;
    }
    // ★ 需求：排布动画（Reflow）没播完也继续等（正常路径下已经由 Done cue 保证，
    //   这里是兜底：万一 Reflow 是别处压进来的，也不会抢在排布动画之前播入场）。
    if (!busy) {
      const animating = (field as unknown as { isLayoutAnimating?: boolean }).isLayoutAnimating;
      if (animating === true) busy = true;
    }
    if (busy && Date.now() - t0 < MAX_WAIT) return;      // 还在播 → 继续等
    clearInterval(timer);
    const play = (field as unknown as { playEnterOrb?: (n: Node) => void }).playEnterOrb;
    for (const n of alive) {
      try {
        n.active = true;
        if (typeof play === 'function') play.call(field, n);   // 入场动画特效（落地光球）
      } catch (e) {
        console.error('[CardAbilitySystem] 召唤入场演出失败：', e);
      }
    }
    // ★ 先让光晕**彻底熄掉**：召唤期间它是在「隐藏 + 尺寸尚未定型」的节点上生成的，
    //   几何方块可能按旧矩形算过 ⇒ 直接淡入就会画出一大块方板（实测：召唤出的自巡炮光圈错乱）。
    //   glowOffImmediate() 会把方块丢掉，随后 refreshVisuals → fadeIn 会按**当前**矩形重建。
    for (const n of alive) {
      try {
        const g = n.getComponent('CardGlow') as { glowOffImmediate?: () => void } | null;
        if (g && typeof g.glowOffImmediate === 'function') g.glowOffImmediate();
      } catch (e) { /* 忽略 */ }
    }
    // ★ 显示之后**补刷一次词条特效**：上面 refreshVisuals 会跳过隐藏中的卡，
    //   所以此刻必须刷一次，突进/疾驰光晕才会是正确颜色（而不是初始白色）。
    try {
      const kw = findComponent(field, 'CardKeywordSystem') as { refreshVisuals?: () => void } | null;
      if (kw && typeof kw.refreshVisuals === 'function') kw.refreshVisuals();
    } catch (e) {
      console.error('[CardAbilitySystem] 召唤入场后刷新词条特效失败：', e);
    }
    console.log(`[CardAbilitySystem] ${ctx.cardId} 召唤入场演出：${alive.length} 张同时显示`
      + `（等待本体落地特效 ${Date.now() - t0}ms）`);
  };
  const timer = setInterval(tick, 60);
  tick();
}

/** 溢出卡：0.5s 后播「破坏动画」并销毁节点（复用破坏特效；**不记墓场**）。 */
function summonOverflowFx(host: Component, node: Node): void {
  const delay = 0.5;
  const destroyFx = findComponent(host, 'CardDestroyFx') as {
    playOnCard?: (card: Node, onComplete?: () => void) => void;
  } | null;
  // 🔴 这里只能用原生 setTimeout（不能用 host.scheduleOnce：宿主可能已 inactive / 已销毁，
  //    Cocos 的调度器会抛 `Cannot read properties of undefined (reading 'timers')`）。
  //    回调里对节点做 isValid 守卫，场景销毁后自然空转一次就结束。
  setTimeout(() => {
    if (!node || !node.isValid) return;
    try {
      if (destroyFx && typeof destroyFx.playOnCard === 'function') destroyFx.playOnCard(node);
      else killNode(node);
    } catch (e) {
      console.error('[CardAbilitySystem] 召唤溢出卡的破坏演出失败：', e);
      try { killNode(node); } catch (e2) { /* 忽略 */ }
    }
  }, delay * 1000);
}

/**
 * ★ 取这张卡「模式」能力的**选项文字**列表（供 `CardPlay` 弹选择界面）。
 * 找不到模式 / 没登记选项 → 返回空数组（调用方据此走「直接结算」兜底）。
 *
 * 🔴 **必须递归找**：模式通常写在 `Fanfare{ params: { effect: Mode{…} } }` 里（**内嵌**一层），
 *    只扫卡表顶层能力会一个都找不到（踩过：`texts=0` ⇒ 永远不进选择模式）。
 */
export function modeOptionTexts(cardId: string): string[] {
  if (!cardId) return [];
  const found: string[] = [];
  const visit = (list: CardAbilityInvocation[], depth: number): boolean => {
    if (depth > 4) return false;
    for (const a of list) {
      if (!a) continue;
      if (a.name === 'Mode') {
        const opts = Array.isArray(a.params?.options) ? a.params.options : [];
        for (const o of opts) {
          const t = o && typeof o === 'object' ? asString((o as { text?: unknown }).text) : '';
          found.push(t || `选项 ${found.length + 1}`);
        }
        return true;
      }
      if (visit(nestedInvocations(a), depth + 1)) return true;
    }
    return false;
  };
  visit(getCardAbilities(cardId), 0);
  return found;
}

/**
 * ★ **打出时预扣召唤卡**（需求 Task 2）：把这张卡所有触发时机里 `Summon{from:'deck'}` 要召唤的卡
 * **当场从牌组取出来**（取出即移除），返回 id 列表交给 `CardPlay._preSummon`。
 *
 * 为什么：召唤的**逻辑**本来就在「打出那一刻」定死（演出才延后），但能力是在落地/入场曲时点才跑的
 * ⇒ 状态栏的牌组数字会晚一截才变。预扣后，牌组数字在**打出瞬间**就是最终值。
 * 召唤能力结算时优先消费这份预扣（`summonCards` 读 `host._preSummon`），所以不会重复扣。
 */
export function preTakeSummons(host: Component, cardId: string, side: CardAbilitySide): string[] {
  const out: string[] = [];
  const abilities = getCardAbilities(cardId);
  if (abilities.length === 0) return out;
  const deck = findComponent(host, 'CardDeckManager') as {
    takeWhere?: (side: string, test: (id: string) => boolean) => string;
    remainingCards?: (side: string) => string[];
  } | null;
  if (!deck || typeof deck.takeWhere !== 'function') return out;

  const scan = (list: CardAbilityInvocation[]): void => {
    for (const a of list) {
      if (!a) continue;
      if (a.name === 'Summon') {
        const p = a.params || {};
        const from = asString(p.from) || 'deck';
        if (from !== 'deck') continue;                     // 生成类不占牌组
        const count = Math.max(1, asInt(p.count) || 1);
        const wantType = asString(p.cardType) || 'Follower';
        const maxCost = typeof p.maxCost === 'number' ? Math.round(p.maxCost) : -1;
        const minCost = typeof p.minCost === 'number' ? Math.round(p.minCost) : -1;
        for (let i = 0; i < count; i++) {
          // ★ 与 summonCards 同一套口径：**费用从大到小、同费用随机**（见 pickDeckSummonId）
      const matches = (cid: string): boolean => {
        const info = getCardInfo(cid);
        if (!info) return false;
        if (info.cardType !== wantType) return false;
        if (maxCost >= 0 && info.cost > maxCost) return false;
        if (minCost >= 0 && info.cost < minCost) return false;
        return true;
      };
      const pick = pickDeckSummonId(deck, side, matches);
      const id = pick ? deck.takeWhere!(side, (cid) => cid === pick) : '';
          if (id) out.push(id);
        }
        continue;
      }
      // 内嵌：effect / effects（如 Fanfare{effect:Summon{…}}）
      const one = a.params?.effect;
      if (one && typeof one === 'object' && !Array.isArray(one)) scan([one as CardAbilityInvocation]);
      const many = a.params?.effects;
      if (Array.isArray(many)) scan(many as CardAbilityInvocation[]);
    }
  };
  try { scan(abilities); } catch (e) { console.error('[CardAbilitySystem] 预扣召唤卡出错：', e); }
  if (out.length > 0) console.log(`[CardAbilitySystem] ${cardId} 打出时预扣召唤卡：${out.join('、')}`);
  return out;
}

/** 取非空字符串参数。 */
function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 取某方的主战者（`HeroArea`，按 `side` 找；找不到返回 null）。 */
function heroAreaOf(host: Component, side: CardAbilitySide): {
  hp?: number; setHp?: (v: number, deferDisplay?: boolean) => void;
} | null {
  // 🔴 `HeroArea.side` 是 **HeroSide 枚举（数字 0/1）**，不是字符串 ⇒ 别拿 'player' 去比（踩过）。
  const want = side === 'enemy' ? HeroSide.Enemy : HeroSide.Player;
  const scene = host && host.isValid ? (host.node.scene as unknown as Node | null) : null;
  if (!scene) return null;
  const stack: Node[] = [...scene.children];
  while (stack.length > 0) {
    const cur = stack.shift() as Node;
    const c = cur.getComponent(HeroArea) as HeroArea | null;
    if (c && c.side === want) return c as { hp?: number; setHp?: (v: number, d?: boolean) => void };
    for (const ch of cur.children) stack.push(ch);
  }
  return null;
}

// ====================== 「启动」（护符的主动能力）======================

/** 该卡在卡表里登记的 `Activate`（启动）能力；没有 → null。 */
export function activateAbilityOf(cardId: string): CardAbilityInvocation | null {
  if (!cardId) return null;
  for (const a of getCardAbilities(cardId)) {
    if (a.name === 'Activate') return a;
  }
  return null;
}

/**
 * **能否启动**（需求：只有自己的回合才能启动自己的护符）。
 * 判据（全部满足才行）：
 *   ① 这张卡在卡表里登记了 `Activate` 能力；
 *   ② 是**该方自己的回合**（`TurnManager.turnSide === side`，且对决进行中）；
 *   ③ 本回合**还没启动过**它（1 回合仅限 1 次，标记由 BattleRuleSystem 按回合清空）；
 *   ④ 能量点足够 `params.cost`。
 * @returns `{ ok, reason, cost }` —— reason 供日志 / 按钮置灰说明
 */
export function canActivateAmulet(
  host: Component,
  card: Node | null,
  side: CardAbilitySide,
): { ok: boolean; reason: string; cost: number } {
  if (!card || !card.isValid) return { ok: false, reason: '卡牌无效', cost: 0 };
  const id = cardIdFromNodeName(card.name);
  const ability = activateAbilityOf(id);
  if (!ability) return { ok: false, reason: '这张卡没有「启动」能力', cost: 0 };
  const cost = Math.max(0, asInt(ability.params?.cost));

  const tm = findComponent(host, 'TurnManager') as {
    isRunning?: boolean; turnSide?: string;
  } | null;
  if (!tm || tm.isRunning !== true) return { ok: false, reason: '对决未开始', cost };
  if (String(tm.turnSide) !== side) return { ok: false, reason: '不是自己的回合', cost };

  const rules = rulesOf(host);
  if (rules && typeof rules.canActivateAmulet === 'function' && rules.canActivateAmulet(card) !== true) {
    return { ok: false, reason: '本回合已经启动过', cost };
  }
  if (cost > 0) {
    const pp = ppRemainingOf(host, side);
    if (pp !== null && pp < cost) return { ok: false, reason: `能量点不足（${pp}/${cost}）`, cost };
  }
  return { ok: true, reason: '', cost };
}

/** 取某方剩余能量点（PP 接口由 CardPlay 注入；缺失 → null = 不拦）。 */
function ppRemainingOf(host: Component, side: CardAbilitySide): number | null {
  if (!PP_API || typeof PP_API.ppRemaining !== 'function') return null;
  try {
    const v = PP_API.ppRemaining(host.node, side);
    return typeof v === 'number' && isFinite(v) ? Math.max(0, Math.round(v)) : null;
  } catch (e) {
    return null;
  }
}

/**
 * **发动「启动」能力**（说明卡片上的「启动」按钮 → 这里）。
 *
 * 流程（与入场曲 / 法术的「先选目标」同一套）：
 *   ① 门槛判定 `canActivateAmulet`（不是自己回合 / 已启动过 / 费用不足 → 直接拒绝）；
 *   ② 有 `params.select` 且**有合法候选** → 进选择模式（我方等玩家点、敌方 AI 自动选）；
 *      点其它地方 = **取消，不消耗费用、不算启动过**；
 *   ③ 选中（或 `params.optional` 且**没有候选**）→ 扣能量点 → 标记本回合已启动 →
 *      执行 `activate` 触发的能力（效果里用 `ctx.target` 拿选中的随从）。
 *
 * @returns 是否接受了这次启动（true = 已发动或已进入选择模式）
 */
export function activateAmulet(
  host: Component,
  card: Node | null,
  side: CardAbilitySide,
): boolean {
  if (!host || !host.isValid || !card || !card.isValid) return false;
  const gate = canActivateAmulet(host, card, side);
  if (!gate.ok) {
    console.log(`[CardAbilitySystem] 启动被拒：${card.name}（${gate.reason}）`);
    return false;
  }
  const id = cardIdFromNodeName(card.name);
  const ability = activateAbilityOf(id);
  if (!ability) return false;

  const select = asString(ability.params?.select);
  const filter = asString(ability.params?.filter);
  const optional = ability.params?.optional === true;

  /** 真正「启动」：扣费 → 标记 → 结算能力 */
  const commit = (target: Node | null): void => {
    if (gate.cost > 0 && PP_API && typeof PP_API.spendPP === 'function') {
      try { PP_API.spendPP(host.node, side, gate.cost, 'AmuletActivate'); } catch (e) {
        console.error('[CardAbilitySystem] 启动扣费失败：', e);
      }
    }
    const rules = rulesOf(host);
    if (rules && typeof rules.markAmuletActivated === 'function') rules.markAmuletActivated(card);
    console.log(`[CardAbilitySystem] ${side} 启动护符 ${card.name}（费用 ${gate.cost}）`
      + `目标=${target && target.isValid ? target.name : '（无）'}`);
    runCardAbilities(host, id, side, 'activate', card, target);
  };

  // 没有 select → 直接发动
  if (!select) { commit(null); return true; }

  const sys = findComponent(host, 'TargetSelectSystem') as {
    candidatesFor?: (owner: string, select: string, filter?: string) => Node[];
    autoPick?: (owner: string, select: string, filter?: string) => Node | null;
    begin?: (opts: Record<string, unknown>) => boolean;
  } | null;
  const candidates = (sys && typeof sys.candidatesFor === 'function')
    ? (sys.candidatesFor(side, select, filter) || []) : [];

  // 🔴 没有合法候选：`optional` → **照常发动**（跳过选择那一段，效果里 target 为 null，
  //    例如卡 8「高效的护理」就只结算回血 1 点）；否则不发动。
  if (candidates.length === 0) {
    if (!optional) {
      console.log(`[CardAbilitySystem] 启动被拒：${card.name} 没有合法候选（${select}`
        + `${filter ? ' / ' + filter : ''}）`);
      return false;
    }
    commit(null);
    return true;
  }

  if (side === 'enemy') {
    const picked = (sys && typeof sys.autoPick === 'function') ? sys.autoPick(side, select, filter) : null;
    commit(picked && picked.isValid ? picked : null);
    return true;
  }

  if (!sys || typeof sys.begin !== 'function') {
    console.warn('[CardAbilitySystem] 启动：找不到可用的 TargetSelectSystem，无法选目标');
    return false;
  }
  const started = sys.begin({
    owner: side,
    select,
    filter,
    // ★ 启动给随从 +1/+1 后**不会**搬动它 ⇒ 选中时也播「落下动画」（否则像直接落下）
    animateDropOnPick: true,
    onPicked: (picked: Node) => commit(picked && picked.isValid ? picked : null),
    onCancelled: (reason: string) => {
      console.log(`[CardAbilitySystem] 启动的目标选择已取消（${reason}）→ 不消耗费用、不算启动过`);
    },
  });
  if (!started) console.log('[CardAbilitySystem] 启动：进入选择模式失败');
  return started;
}

/**
 * PP 接口（`ppRemaining` / `spendPP`）注入位。
 * 🔴 这两个函数定义在 `CardPlay.ts` 里，而 `CardPlay` 反过来 import 本文件 ⇒
 *    由 CardPlay 在本模块之后注入，**避免循环 import**（见 CardPlay 末尾的 `injectPPApi(...)`）。
 */
let PP_API: {
  ppRemaining?: (from: Node, side: CardAbilitySide) => number;
  spendPP?: (from: Node, side: CardAbilitySide, cost: number, tag: string) => void;
} | null = null;

/** 供 CardPlay 注入 PP 接口（只调用一次） */
export function injectPPApi(api: {
  ppRemaining?: (from: Node, side: CardAbilitySide) => number;
  spendPP?: (from: Node, side: CardAbilitySide, cost: number, tag: string) => void;
}): void {
  PP_API = api;
}

/** 取整数参数（非数字 / 非法 → 0）。 */
function asInt(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/** `BattleRuleSystem` 里本文件用到的那一小撮 API（结构性类型，避免与它的实现互相 import）。 */
interface RuleApi {
  fieldOfSide?: (side: BattleSide) => BattleFieldLayout | null;
  getHp?: (card: Node | null) => number | null;
  setHp?: (card: Node, hp: number) => void;
  getAttack?: (card: Node | null) => number | null;
  addStats?: (card: Node | null, attackDelta: number, hpDelta: number) => boolean;
  isSuperGuarded?: (card: Node | null) => boolean;
  /** 「不会被能力破坏」的统一判据；血量 <= 0 时返回 true（允许伤害致死）。 */
  canDestroyByAbility?: (card: Node | null) => boolean;
  /** 延迟数字显示（与普通攻击同一套）：窗口内只改逻辑值，卡面数字冻结到 RefreshNumbers cue */
  beginDeferredDisplay?: () => void;
  endDeferredDisplay?: () => unknown;
  /** 「启动」：1 回合 1 次（每次自己回合开始由 BattleRuleSystem 清空） */
  canActivateAmulet?: (card: Node | null) => boolean;
  markAmuletActivated?: (card: Node | null) => void;
}

/** 取 `BattleRuleSystem`（BFS，找不到返回 null）。 */
function rulesOf(host: Component): RuleApi | null {
  return findComponent(host, 'BattleRuleSystem') as RuleApi | null;
}

/** ★ 全场景找 BattleRuleSystem 并读**指定阵营**的协作值（给纯函数用，没有 host 可传时）。 */
function cooperationNowGlobal(side: CardAbilitySide = 'player'): number {
  try {
    const scene = director.getScene();
    if (!scene) return 0;
    const stack: Node[] = [...scene.children];
    while (stack.length > 0) {
      const cur = stack.shift() as Node;
      const r = cur.getComponent('BattleRuleSystem') as { cooperationOf?: (s: string) => number } | null;
      if (r && typeof r.cooperationOf === 'function') return Math.max(0, r.cooperationOf(side) || 0);
      for (const ch of cur.children) stack.push(ch);
    }
  } catch (e) { /* 忽略 */ }
  return 0;
}

/** `select` 字面量 → 要从哪个战场取目标（'friendlyFollower' = 自己那边，其余 = 对方）。 */
function sideOfSelect(owner: CardAbilitySide, select: string): BattleSide {
  const own = owner === 'enemy' ? BattleSide.Enemy : BattleSide.Player;
  const foe = owner === 'enemy' ? BattleSide.Player : BattleSide.Enemy;
  return select === 'friendlyFollower' ? own : foe;
}

/** 随机伤害的伤害值：params.amount / amountFrom 'selectedHp'（选中随从当前血量）/ 'attack'（来源攻击力）。 */
function randomDamageAmountOf(ctx: CardAbilityContext, ability: CardAbilityInvocation, rules: RuleApi): number {
  const from = asString(ability.params?.amountFrom);
  if (from === 'selectedHp') {
    const t = ctx.target;
    const hp = t && t.isValid && typeof rules.getHp === 'function' ? rules.getHp(t) : null;
    return typeof hp === 'number' && isFinite(hp) ? Math.max(0, Math.round(hp)) : 0;
  }
  if (from === 'attack') {
    const atk = ctx.sourceCard && typeof rules.getAttack === 'function' ? rules.getAttack(ctx.sourceCard) : null;
    return typeof atk === 'number' && isFinite(atk) ? Math.max(0, Math.round(atk)) : 0;
  }
  return asInt(ability.params?.amount);
}

/**
 * ★ **伤害演出的开关**：`params.fx === 'poisonBullet'` 时，为**本次受到伤害的全部目标**
 * 排**一条** `BattleCueType.PoisonBullet` cue（cue 里带 `cards` 数组）——
 * 从各目标卡牌的右上方直线射入，**多颗同时飞**（需求），排在数字刷新 / 破坏动画之前
 * （单通道 FIFO ⇒ 严格「先飞毒弹、再刷新数字、再播破坏」）。
 *
 * 🔴 只是演出，不参与结算：伤害 / 破坏在调用点**同步**结算完。
 * 🔴 缺演出队列 / 缺目标 → 静默跳过（绝不影响结算）。
 * 🔴 **按卡表开关**（卡 2 / 卡 6 开，卡 7 没写就没有）—— 特效不在共用逻辑里硬编码。
 */
function pushPoisonBulletCue(ctx: CardAbilityContext, ability: CardAbilityInvocation, targets: Node[]): void {
  const kind = asString(ability.params?.fx);
  if (kind !== 'poisonBullet' && kind !== 'missileStrike' && kind !== 'flameSweep') return;
  // ★ `params.color`（[r,g,b] 或 [r,g,b,a]）⇒ 本次演出换色（卡 15 的单体分支要红色火焰子弹）
  const rawColor = ability.params?.color;
  let cueColor: Color | null = null;
  if (Array.isArray(rawColor) && rawColor.length >= 3) {
    cueColor = new Color(Number(rawColor[0]) || 0, Number(rawColor[1]) || 0, Number(rawColor[2]) || 0,
      rawColor.length > 3 ? (Number(rawColor[3]) || 0) : 255);
  }
  const list = (targets || []).filter((n) => !!n && n.isValid);
  if (list.length === 0) return;
  try {
    const cmds = findComponent(ctx.host, 'BattleCommandSystem') as {
      pushCue?: (cue: { type: string;[key: string]: unknown }) => void;
    } | null;
    if (!cmds || typeof cmds.pushCue !== 'function') return;
    // `fxKind` 决定用哪个演出宿主：毒弹（可露凯）/ 导弹（威玛西娜）
    // ★ 颜色必须随 cue 传下去（以前算了 cueColor 却**没放进 cue** ⇒ 卡表写的 color 全被忽略，
    //   火焰横扫永远是宿主默认的红色）。
    cmds.pushCue({ type: BattleCueType.PoisonBullet, cards: list, fxKind: kind, color: cueColor });
  } catch (e) {
    console.error('[CardAbilitySystem] 排入伤害演出失败（不影响结算）：', e);
  }
}

/**
 * ★ **数字刷新时点**：能力伤害同样要「**先打中、再更新卡面数字**」（需求）。
 * 做法与普通攻击完全一致 —— 结算时用 `BattleRuleSystem.beginDeferredDisplay()` 冻结卡面数字
 * （逻辑值照改），把本批快照交给 `RefreshNumbers` cue，队列在毒弹飞完那一刻才写回。
 */
function pushRefreshNumbersCue(ctx: CardAbilityContext, batch: unknown): void {
  // 🔴 即使**没有**数字快照也要压这条 cue：飘字（DamageNumberQueue）是在这条 cue 里取走的，
  //    漏掉它 ⇒ 本次能力伤害登记的飘字要等到下一次 RefreshNumbers 才出现（甚至一直不出现）
  //    —— 这正是用户报的「被能力伤害时有时没有数字」。
  try {
    const cmds = findComponent(ctx.host, 'BattleCommandSystem') as {
      pushCue?: (cue: { type: string;[key: string]: unknown }) => void;
    } | null;
    if (!cmds || typeof cmds.pushCue !== 'function') return;
    cmds.pushCue({ type: BattleCueType.RefreshNumbers, batch });
  } catch (e) {
    console.error('[CardAbilitySystem] 排入「刷新数字」演出失败（不影响结算）：', e);
  }
}

/**
 * **随机对某个战场上的 1 个随从造成伤害**（`RandomDamage` / `TurnEndRandomDamage` 共用实现）。
 *
 * 🔴 需求：**能力造成的伤害不「越过」任何随从** —— 超进化守护（己方回合受到的伤害转为 0）
 *    只对**普通攻击**生效（`BattleRuleSystem.resolveAttack`），能力伤害照常结算 ⇒ 随机池不排除它。
 * 🔴 造成伤害后调 `notifyAbilityDamage`（潜行：「通过能力造成伤害」→ 现形）。
 *    血量归零 → 走正常破坏流程（记墓场 / 播破坏动画 / 之后重排）。
 */
/** ★ 统一的「把目标打到 hpAfter」入口：能走 applyDamage 就走（屏障才会生效）。 */
function dealDamageTo(rules: RuleApi, target: Node, hpAfter: number): void {
  try {
    const hp = rules.getHp(target);
    const dmg = Math.max(0, hp - hpAfter);
    const r = rules as RuleApi & { applyDamage?: (t: Node, n: number) => number };
    if (dmg > 0 && typeof r.applyDamage === 'function') { r.applyDamage(target, dmg); return; }
  } catch (e) { /* 退回直接写血 */ }
  rules.setHp(target, hpAfter);
}

function applyRandomDamage(ctx: CardAbilityContext, ability: CardAbilityInvocation, defaultSelect: string): void {
  const select = asString(ability.params?.select) || defaultSelect;
  // ★ `select === 'selected'`：不随机，直接用**交互层选中的那个目标**（协作不满足时的单体伤害）。
  if (select === 'selected') {
    const t = ctx.target;
    if (!t || !t.isValid) {
      console.warn(`[CardAbilitySystem] ${ctx.cardId} 对选中目标造成伤害：本次没有选中目标，跳过`);
      return;
    }
    const rules0 = rulesOf(ctx.host);
    if (!rules0 || typeof rules0.getHp !== 'function' || typeof rules0.setHp !== 'function') return;
    const amount0 = randomDamageAmountOf(ctx, ability, rules0);
    if (amount0 <= 0) return;
    const hp0 = rules0.getHp(t);
    const after0 = hp0 - amount0;
    const defer0 = typeof rules0.beginDeferredDisplay === 'function' && typeof rules0.endDeferredDisplay === 'function';
    let batch0: unknown = null;
    if (defer0) rules0.beginDeferredDisplay!();
    dealDamageTo(rules0, t, after0);
    console.log(`[CardAbilitySystem] ${ctx.cardId} 对选中目标造成伤害：${t.name} ${hp0} → ${after0}（${amount0} 点）`);
    notifyAbilityDamage(ctx);
    // 🔴 致命时也要**先排特效 cue 再破坏**：原来先 destroyCardNow ⇒ 卡被销毁，
    //    毒弹没有可播的节点、飘字锚点也没了 ⇒ 用户看到的「击杀时没特效也没数字」。
    pushPoisonBulletCue(ctx, ability, [t]);
    if (after0 <= 0) destroyCardNow(ctx, t);
    if (defer0) batch0 = rules0.endDeferredDisplay!();
    pushRefreshNumbersCue(ctx, batch0);
    return;
  }
  const rules = rulesOf(ctx.host);
  if (!rules || typeof rules.fieldOfSide !== 'function'
      || typeof rules.getHp !== 'function' || typeof rules.setHp !== 'function') {
    console.warn('[CardAbilitySystem] 随机伤害：找不到可用的 BattleRuleSystem，无法结算');
    return;
  }
  const field = rules.fieldOfSide(sideOfSelect(ctx.side, select));
  if (!field || !field.isValid) {
    console.log(`[CardAbilitySystem] ${ctx.cardId} 随机伤害：目标战场不存在，跳过`);
    return;
  }
  // 🔴 需求：能力伤害**不越过**任何随从 ⇒ 随机池里**不再排除**超进化守护的随从
  //    （超进化守护只挡普通攻击，见 BattleRuleSystem.resolveAttack）。
  const pool = field.cards.filter((c) => !!c && c.isValid);
  if (pool.length === 0) {
    console.log(`[CardAbilitySystem] ${ctx.cardId} 随机伤害：没有可选目标（${select}），跳过`);
    return;
  }
  const amount = randomDamageAmountOf(ctx, ability, rules);
  if (amount <= 0) {
    console.log(`[CardAbilitySystem] ${ctx.cardId} 随机伤害：伤害值为 0，跳过`);
    return;
  }
  const target = pool[Math.floor(Math.random() * pool.length)];
  const hp = rules.getHp(target);
  if (typeof hp !== 'number' || hp <= 0) {
    console.log(`[CardAbilitySystem] ${ctx.cardId} 随机伤害：目标 ${target.name} 血量异常（${hp}），跳过`);
    return;
  }
  const hpAfter = hp - amount;
  // 🔴 需求：**先打中、再更新卡面数字**（结算逻辑照旧当场算完，只是数字显示冻结到毒弹命中那一刻）
  const defer = typeof rules.beginDeferredDisplay === 'function'
    && typeof rules.endDeferredDisplay === 'function';
  let batch: unknown = null;
  if (defer) rules.beginDeferredDisplay!();
  rules.setHp(target, hpAfter);
  console.log(`[CardAbilitySystem] ${ctx.cardId} 随机伤害：${target.name} ${hp} → ${hpAfter}`
    + `（${amount} 点，${pool.length} 选 1）`);
  notifyAbilityDamage(ctx);
  // 🔴 同上：先排特效 cue（毒弹要在卡还在的时候打出去），再破坏 —— 否则击杀时既没特效也没飘字。
  pushPoisonBulletCue(ctx, ability, [target]);    // ★ 演出（卡表开了 fx 才排）
  if (hpAfter <= 0) destroyCardNow(ctx, target);
  if (defer) batch = rules.endDeferredDisplay!();
  pushRefreshNumbersCue(ctx, batch);
}

/**
 * 某一方**操作回合结束时**：遍历该方战场，逐张执行它自己的 `turnEnd` 能力。
 *
 * 调用点 = `TurnManager._beginTurnEnd`（与纹章 `turnEnd` 同一时点、同在「先攒 cue 后放行」的窗口里）。
 * 🔴 先按入场顺序**快照**一份再逐张执行：能力可能破坏卡牌（战场集合会变），不能在遍历中直接读活集合。
 */
export function runCardTurnEndAbilities(host: Component, side: CardAbilitySide): void {
  if (!host || !host.isValid) return;
  const rules = rulesOf(host);
  const field = rules && typeof rules.fieldOfSide === 'function'
    ? rules.fieldOfSide(side === 'enemy' ? BattleSide.Enemy : BattleSide.Player)
    : null;
  if (!field || !field.isValid) return;
  const list = field.cardsByEntryOrder().filter((c) => !!c && c.isValid);
  for (const card of list) {
    if (!card.isValid) continue;
    const id = cardIdFromNodeName(card.name);
    if (!id) continue;
    runCardAbilities(host, id, side, 'turnEnd', card);
  }
}

/**
 * 🔴 潜行：「拥有潜行的随从**通过能力造成伤害**时，将失去潜行」。
 * 由**伤害结算点**调用（本文件里只有 `DistributeDamage` 真的会造成伤害）；
 * **破坏类效果（destroy）不算造成伤害**，所以不要在 destroyFieldCard 那条路上调用它。
 */
function notifyAbilityDamage(ctx: CardAbilityContext): void {
  if (!ctx.sourceCard || !ctx.sourceCard.isValid) return;
  const kw = findComponent(ctx.host, 'CardKeywordSystem') as {
    loseAmbush?: (card: Node | null, reason?: string) => boolean;
  } | null;
  if (kw && typeof kw.loseAmbush === 'function') kw.loseAmbush(ctx.sourceCard, '通过能力造成伤害');
}

/** 「奥义」门槛：奥义槽 ≥ 10 */
export const OUGI_THRESHOLD = 10;
/** 「解放奥义」门槛：奥义槽 ≥ 15 */
export const OUGI_RELEASE_THRESHOLD = 15;

/**
 * **奥义 / 解放奥义**：奥义槽够门槛才结算内嵌效果。
 *
 * 奥义槽 = `现在的回合数` + `这张卡在手牌中时我方随从的进化次数`
 * （口径由 `CardKeywordSystem.ougiGauge` 唯一提供；手牌快照在卡进入手牌时记录，
 *  打出时由 `CardPlay/EnemyCardPlay.notifyCardEntered` 搬到战场卡上）。
 *
 * 🔴 不满足条件 = **只打日志、什么都不结算**（卡照常入场；不消费 params.effect）。
 *    缺 `CardKeywordSystem`（例如单测环境）时按「不满足」处理，避免误发动。
 */
function runOugiEffect(ctx: CardAbilityContext, ability: CardAbilityInvocation, threshold: number): void {
  const label = threshold >= OUGI_RELEASE_THRESHOLD ? '解放奥义' : '奥义';
  const kw = findComponent(ctx.host, 'CardKeywordSystem') as {
    ougiParts?: (card: Node | null) => { turn: number; evolutions: number; gauge: number };
  } | null;
  if (!kw || typeof kw.ougiParts !== 'function') {
    console.warn(`[CardAbilitySystem] ${label}：找不到 CardKeywordSystem，无法计算奥义槽 → 本次不发动（${ctx.cardId}）`);
    return;
  }
  let parts: { turn: number; evolutions: number; gauge: number };
  try {
    parts = kw.ougiParts(ctx.sourceCard);
  } catch (e) {
    console.error(`[CardAbilitySystem] ${label}：计算奥义槽出错 → 本次不发动（${ctx.cardId}）`, e);
    return;
  }
  const gauge = Math.max(0, Math.round(Number(parts && parts.gauge) || 0));
  if (gauge < threshold) {
    console.log(`[CardAbilitySystem] ${label} 未发动：奥义槽 ${gauge} < ${threshold}`
      + `（回合数 ${parts.turn} + 在手牌中我方进化 ${parts.evolutions} 次）— ${ctx.cardId}`);
    return;
  }
  console.log(`[CardAbilitySystem] ${label} 发动：奥义槽 ${gauge} ≥ ${threshold}`
    + `（回合数 ${parts.turn} + 在手牌中我方进化 ${parts.evolutions} 次）— ${ctx.cardId}`);
  runNestedEffects(ctx, ability);
}

/** 把被动能力对应词条写入 CardKeywordSystem；系统缺失时留待其扫描时从卡表读取。 */
/**
 * 把「词条能力」写进 CardKeywordSystem。
 *
 * 🔴 `extra` = **本次要授予的词条**（能力名，如 `'Guard'` / `'Charge'`）。
 *    必须显式带上：卡表里没写这个词条的卡（例如卡 9 的模式②授予【守护】）
 *    光靠 `getCardInfo(...).keywords` 会得到**空表** ⇒ 等于把词条**清空**（踩过：守护没生效）。
 */
function applyKeywordAbilities(ctx: CardAbilityContext, extra?: string): void {
  if (!ctx.sourceCard || !ctx.sourceCard.isValid) return;
  const system = findComponent(ctx.host, 'CardKeywordSystem') as {
    setCardKeywords?: (card: Node | null, keywords: string[], deployNow?: boolean) => void;
  } | null;
  if (!system || !system.setCardKeywords) return;
  const keywords = uniqueKeywords([
    ...(getCardInfo(ctx.cardId)?.keywords || []),
    ...getCardAbilityKeywords(ctx.cardId),
    ...(extra ? [extra] : []),
  ]);
  system.setCardKeywords(ctx.sourceCard, keywords, true);
}

/** 把运行时「一回合可攻击 N 次」写进 CardKeywordSystem。 */
function applyMultiAttack(ctx: CardAbilityContext, ability: CardAbilityInvocation): void {
  if (!ctx.sourceCard || !ctx.sourceCard.isValid) return;
  const system = findComponent(ctx.host, 'CardKeywordSystem') as {
    grantMultiAttack?: (card: Node | null, times: number) => void;
  } | null;
  if (!system || typeof system.grantMultiAttack !== 'function') {
    console.warn(`[CardAbilitySystem] ${ctx.cardId} 多次攻击：找不到 CardKeywordSystem`);
    return;
  }
  const times = Math.max(1, Math.floor(Number(ability.params?.times) || 1));
  system.grantMultiAttack(ctx.sourceCard, times);
}

/** 我方 CardDraw 是单飞组件：busy 时同一批 id 延迟重试，避免抽牌指令静默丢失。 */
function queuePlayerDraw(host: Component, ids: string[], attempt = 0): void {
  if (!host || !host.isValid) return;
  const drawer = findComponent(host, 'CardDraw') as {
    drawMany?: (ids: string[]) => boolean;
  } | null;
  if (!drawer || !drawer.drawMany) {
    console.warn('[CardAbilitySystem] DrawCards 找不到 CardDraw，抽到的牌未展示');
    return;
  }
  if (drawer.drawMany(ids)) return;
  if (attempt >= 50) {
    console.warn(`[CardAbilitySystem] CardDraw 长时间忙碌，抽牌取消：${ids.join(', ')}`);
    return;
  }
  // 不用 Component.scheduleOnce：预览环境里该调度器在单飞重试路径上会因
  // target 生命周期问题循环抛 `Scheduler.unscheduleForTimer`；普通定时器足够且稳定。
  setTimeout(() => queuePlayerDraw(host, ids, attempt + 1), 100);
}

/** 全场景 BFS 按**类名**找一个组件（供能力 / 进化等底层操作解析依赖，敌我通用） */
export function findComponent(from: Component, className: string): any {
  const scene = from?.node?.scene as unknown as Node | null;
  if (!scene) return null;
  const stack: Node[] = [...scene.children];
  while (stack.length > 0) {
    const cur = stack.shift() as Node;
    const comp = cur.getComponent(className);
    if (comp) return comp;
    for (const child of cur.children) stack.push(child);
  }
  return null;
}

/** 全场景 BFS 按**类名**找**所有**同类组件（召唤要挑「能生成战场卡」的那个 CardComposer）。 */
export function findComponents(from: Component, className: string): any[] {
  const scene = from?.node?.scene as unknown as Node | null;
  if (!scene) return [];
  const out: any[] = [];
  const stack: Node[] = [...scene.children];
  while (stack.length > 0) {
    const cur = stack.shift() as Node;
    const comps = cur.getComponents(className);
    for (const c of comps) if (c) out.push(c);
    for (const child of cur.children) stack.push(child);
  }
  return out;
}

function positiveInt(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  return i > 0 ? i : fallback;
}

function uniqueKeywords(keywords: string[]): string[] {
  return [...new Set((keywords || []).filter((k) => !!k))];
}
