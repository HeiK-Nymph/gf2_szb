/**
 * AiPlan —— 敌方人机的**决策内核**（纯数据 + 纯函数）
 * ===========================================================================
 * 不 import 'cc'、不访问场景、不改游戏状态：只吃一份「战场 / 手牌快照」(`AiState`) 与规则参数
 * (`AiOptions`)，吐一份「本回合计划」(`AiPlan`)。
 *
 *     `EnemyBattleAI`（持有真实节点）→ 建快照 → `planTurn()` → 逐步用真实 API 执行
 *
 * 决策口径（按策划需求）：
 *   ① **能斩杀对方主战者 → 最优**（`AI_WEIGHTS.lethal` 巨额项；搜索会直接去找斩杀线）；
 *   ② 否则：**解干净对方场 + 最大铺自己场**（`clearBonus` / 双方面板价值 / 铺场宽度）；
 *   ③ 解不掉 / 解不完 → **以保留我方场为主**（我方单卡权重 × `lossWeight` > 对方收益），
 *      尽量压低「对方场面总攻击」与「双方主战者血量差距」；
 *   ④ 多种打法时**贪心做优秀资源交换**：手牌带「保留价值」，出牌净收益为正才出；
 *      交换只在「打掉对方 ≥ 自己损失」时进行（除非能解干净或斩杀）。
 *
 * 🔴 战斗判定照抄 `BattleRuleSystem.resolveCombat` / `canTarget` 的**真实口径**：
 *      守护（守护在场只能打守护）/ 威慑 / 潜行（不可被随从攻击）/ 屏障（本次伤害归零并消耗）/
 *      毁灭（按次破坏，与血量无关）/ 超进化守护（**自己回合内**我方超进化随从受到的伤害为 0、
 *      且不会被能力破坏）/ 超进化破坏（超进化随从破坏对方随从 → 对方主战者连锁掉血）。
 *    出牌效果按 CardData 的 `CARD_ABILITY_MAP` + `params` 解释（**估算**：与真实结算同口径的常用效果
 *    逐一实现，未登记的效果退化为「通用价值」，绝不抛异常）。
 * ===========================================================================
 */
import {
  CARD_ABILITY_MAP, CardAbilityInvocation, getCardAbilities, getCardInfo, maxAttacksOf,
} from './CardData';

// ====================== 快照数据结构 ======================

/** 一只战场单位（我方 = 敌方 AI 的随从；foe = 玩家一侧）。 */
/** 能力的归属方（'me' = 敌方 AI 自己，'foe' = 玩家一侧）——
 * 效果解释器全程按它取「己方 / 对方」，这样同一份代码也能算**对手的**谢幕曲 / 回合结束能力。 */
export type AiOwner = 'me' | 'foe';

export interface AiUnit {
  /** 唯一键（执行阶段用它回查真实节点；模拟出来的「新单位」用 `NEW:` 前缀，不会被执行） */
  key: string;
  cardId: string;
  name: string;
  atk: number;
  hp: number;
  maxHp: number;
  /** 英文关键字键（Guard / Rush / Charge / Bane / Barrier / Deter / Ambush / Aura / AbilityDestroyImmune / MultiAttack …） */
  keywords: string[];
  isFollower: boolean;
  /** 入场顺序（同侧 0 = 最早入场；「分配伤害」按这个顺序吃伤害） */
  order: number;
  /** 现在能不能攻击随从 / 主战者（已含召唤失调：新入场需要 Rush/Charge） */
  canAttackUnit: boolean;
  canAttackHero: boolean;
  /** 本回合剩余攻击次数 */
  attacksLeft: number;
  /** 是否超进化过（我方在**自己回合内**受伤害为 0、且不可被能力破坏） */
  superEvolved: boolean;
  /** 是否已经进化过（普通 / 超进化都算；进化过的不能再进化） */
  evolved: boolean;
  /** 吟唱剩余回合（0 = 没有吟唱）—— 临时卡牌在评估里要打折 */
  chantTurns: number;
}

/** 手牌（AI 自己的手牌；index 与真实手牌数组下标一致） */
export interface AiHandCard {
  index: number;
  cardId: string;
  name: string;
  type: 'Follower' | 'Amulet' | 'Spell';
  cost: number;
  /** 最大爆能强化值（0 = 没有）；能量够时会自动改用强化值结算 */
  enhanceValue: number;
}

/** 一次规划用到的完整快照（纯数据，可随意克隆） */
export interface AiState {
  me: AiUnit[];
  foe: AiUnit[];
  myHero: number;
  myHeroMax: number;
  foeHero: number;
  foeHeroMax: number;
  pp: number;
  ppMax: number;
  hand: AiHandCard[];
  /** 战场容量（双方一致） */
  maxCards: number;
  /** 本回合还能打几张手牌（AI 自己的节奏限制） */
  playsLeft: number;
  /** 本回合已经额外抽到的牌数（资源收益，评估用） */
  draws: number;
  /** 本回合获得的纹章数（评估用） */
  crests: number;
  /** 我方协作数（协作类卡牌的判定） */
  coop: number;
  /** 对手在本回合额外抽到的牌数（对手的资源收益 → 我方评分里算负收益） */
  foeDraws: number;
  /** 对手获得的纹章数 */
  foeCrests: number;
  /** 「模式」类能力本次选中的选项下标（-1 = 没选 / 走默认）—— 执行层要按它下发 */
  modePick: number;
  /** 本次出牌**强制**使用的模式选项（-1 = 由内核逐选项试算后自选；>=0 = 计划分支指定） */
  modeForce: number;
}

/** 一次攻击动作：`target === null` = 打对方主战者 */
export interface AiAttack { attacker: string; target: string | null; }

/** 本回合计划（执行阶段按 plays → activate → evolve → attacks 顺序落地） */
export interface AiPlan {
  /** ★ 斩杀优先：**现有场面**就能击杀对方主战者 ⇒ 不出牌 / 不启动 / 不进化，直接按 attacks 打脸 */
  lethalNow?: boolean;
  /** 要打出的手牌下标（按顺序） */
  plays: number[];
  /** 「模式」类卡牌每张牌选中的选项下标（手牌下标 → 选项下标；缺省 = 走默认） */
  modePicks: Record<number, number>;
  /** 要启动的护符 key（null = 不启动） */
  activate: string | null;
  /** 要进化的随从 key（null = 不进化） */
  evolve: { key: string; superEvolve: boolean } | null;
  /** 攻击序列（按顺序执行） */
  attacks: AiAttack[];
  /** 计划评分（越大越好；仅用于日志 / 回归对比） */
  score: number;
  /** 决策理由（日志用） */
  reason: string;
}

/** 规则参数（由 EnemyBattleAI 从真实组件读出后传入；本内核不自己找组件） */
export interface AiOptions {
  maxCards: number;
  maxPlays: number;
  /** 进化加成（普通 / 超进化）与授予的词条 */
  evolveAttack: number;
  evolveHp: number;
  superAttack: number;
  superHp: number;
  evolveKeyword: string;
  /** 超进化随从破坏对方随从时，对对方主战者的连锁伤害 */
  superEvolveBreakHeroDamage: number;
  /** 进化点可用性（false = 该档不可用） */
  canEvolve: boolean;
  canSuperEvolve: boolean;
  /** 搜索时间上限（毫秒），超时就用当前最优解 */
  timeBudgetMs?: number;
}

// ====================== 评估权重 ======================

export const AI_WEIGHTS = {
  /** 斩杀：对方主战者被打死 */
  lethal: 1e6,
  /** 我方主战者被打死（评估里不该出现，出现就否决） */
  suicide: 1e6,
  /** 主战者血量差（我 - 敌），每点 */
  heroLead: 4,
  /** 我方场面价值（每点） */
  myBoard: 10,
  /** 对方场面价值（每点）—— 略高于我方 ⇒ 倾向解场 */
  foeBoard: 12,
  /** 我方随从损失惩罚系数（>1 ⇒ 「以保留我方场为主」：交换必须打掉更大的价值才划算） */
  lossPenalty: 1.4,
  /** 进化点的机会成本（有限资源，不值得就不进化） */
  evoCost: 6,
  /** 对方场面清空 + 我方还有场面 */
  clearBonus: 30,
  /** 铺场宽度（每多一只随从） */
  wide: 4,
  /** 手牌保留价值（每点）—— 「保留重要卡牌在手」 */
  handKeep: 6,
  /** 每张额外抽到的牌 */
  drawValue: 14,
  /** 每枚纹章（**永久**收益：本项目的纹章每回合都做事，接近「一次免费解场」⇒ 给高值；
   *  对手通过谢幕曲拿到纹章时按同一数值记成我方负收益 —— 这样「杀掉会送纹章的随从」会被正确否决） */
  crestValue: 60,
};

/** 关键字 → 价值权（评估用） */
const KW_VALUE: Record<string, number> = {
  Guard: 1.6, Rush: 1.3, Charge: 2.2, Bane: 2.4, Barrier: 1.8,
  Deter: 1.2, Ambush: 1.0, Aura: 0.9, AbilityDestroyImmune: 3.0, MultiAttack: 2.6,
  Chant: -0.6,
};

/** 手牌「保留价值」：越贵 / 特效越强的牌越舍不得丢（决定了「贪心资源交换」的取舍） */
export function handKeepValueOf(card: AiHandCard): number {
  const abilities = getCardAbilities(card.cardId);
  let v = 1 + Math.max(0, card.cost) * 0.6;
  for (const a of abilities) {
    const name = String(a.name || '');
    const meta = (CARD_ABILITY_MAP as unknown as Record<string, { trigger?: string }>)[name];
    const trigger = meta ? String(meta.trigger || '') : '';
    if (trigger === 'fanfare' || trigger === 'use') v += 1.2;          // 有即时效果
    if (name === 'Summon' || name === 'VanishAll' || name === 'DestroyHighestAttack'
      || name === 'DistributeDamage' || name === 'BuffFriendlyFollowers') v += 1.5;  // 强力效果
    if (card.enhanceValue > 0) v += 0.8;                               // 爆能强化潜力
  }
  return v;
}

// ====================== 小工具 ======================

const num = (v: unknown, fb = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fb;
};
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

function hasKw(u: AiUnit | null | undefined, k: string): boolean {
  return !!u && u.keywords.indexOf(k) >= 0;
}
function addKw(u: AiUnit, k: string): void {
  if (k && u.keywords.indexOf(k) < 0) u.keywords.push(k);
}
function delKw(u: AiUnit, k: string): void {
  const i = u.keywords.indexOf(k);
  if (i >= 0) u.keywords.splice(i, 1);
}
function findUnit(list: AiUnit[], key: string): AiUnit | null {
  for (const u of list) if (u.key === key) return u;
  return null;
}
function dropUnit(list: AiUnit[], key: string): void {
  const i = list.findIndex((u) => u.key === key);
  if (i >= 0) list.splice(i, 1);
}
function findCard(s: AiState, index: number): AiHandCard | null {
  for (const c of s.hand) if (c.index === index) return c;
  return null;
}

export function cloneState(s: AiState): AiState {
  return {
    me: s.me.map((u) => ({ ...u, keywords: u.keywords.slice() })),
    foe: s.foe.map((u) => ({ ...u, keywords: u.keywords.slice() })),
    myHero: s.myHero, myHeroMax: s.myHeroMax,
    foeHero: s.foeHero, foeHeroMax: s.foeHeroMax,
    pp: s.pp, ppMax: s.ppMax,
    hand: s.hand.map((c) => ({ ...c })),
    maxCards: s.maxCards, playsLeft: s.playsLeft,
    draws: s.draws, crests: s.crests, coop: s.coop,
    foeDraws: s.foeDraws, foeCrests: s.foeCrests, modePick: s.modePick, modeForce: s.modeForce,
  };
}

/** 单只随从的「战力价值」 */
export function unitValue(u: AiUnit, mine: boolean): number {
  if (!u.isFollower) return 1 + (Math.max(0, u.atk) + Math.max(0, u.hp)) * 0.2;
  let v = Math.max(0, u.atk) * 1.0 + Math.max(0, u.hp) * 0.6;
  for (const k of u.keywords) v += KW_VALUE[k] || 0;
  if (u.superEvolved) v += 2;
  // 「本回合还能动」只给一点点tempo 权（0.1×atk）：
  //   🔴 曾经给到 0.35×atk ⇒ 打脸收益（4 分/点血）反而不如「留着不打的威胁分」，
  //      导致 AI 明明能打脸也不打（实测踩过）。攻击本身的价值交给搜索（打/不打都算一遍）比出来。
  if (mine && u.attacksLeft > 0 && u.canAttackUnit) v += Math.max(0, u.atk) * 0.1;
  // ★【吟唱】是**临时**卡牌（倒数到 0 自己走）⇒ 剩余回合越少越不值钱
  if (u.chantTurns > 0) v *= (u.chantTurns >= 2 ? 0.75 : 0.5);
  return v;
}

export function boardValue(list: AiUnit[], mine: boolean): number {
  let v = 0;
  for (const u of list) v += unitValue(u, mine);
  return v;
}

/** 手牌总保留价值 */
export function handKeepValue(s: AiState): number {
  let v = 0;
  for (const c of s.hand) v += handKeepValueOf(c);
  return v;
}

/** 按「入场顺序」排序的目标列表（同侧 0 = 最早） */
function byEntryOrder(list: AiUnit[]): AiUnit[] {
  return list.slice().sort((a, b) => a.order - b.order);
}

/** 单张卡的表层「效果调用」（按触发时机筛）。 */
function invocationsOfTrigger(cardId: string, triggers: string[]): CardAbilityInvocation[] {
  const out: CardAbilityInvocation[] = [];
  for (const a of getCardAbilities(cardId)) {
    const meta = (CARD_ABILITY_MAP as unknown as Record<string, { trigger?: string }>)[String(a.name)];
    if (!meta) continue;
    if (triggers.indexOf(String(meta.trigger)) < 0) continue;
    out.push(a);
  }
  return out;
}

/** 该卡入场时自带的关键字（passive 能力声明的 keywords + 卡表 keywords 字段） */
export function passiveKeywordsOf(cardId: string): string[] {
  const out: string[] = [];
  const push = (k: string): void => { if (k && out.indexOf(k) < 0) out.push(k); };
  const info = getCardInfo(cardId);
  for (const k of arr<string>(info?.keywords)) push(str(k));
  for (const a of getCardAbilities(cardId)) {
    const meta = (CARD_ABILITY_MAP as unknown as Record<string, { trigger?: string; keywords?: string[] }>)[String(a.name)];
    if (!meta || String(meta.trigger) !== 'passive') continue;
    for (const k of arr<string>(meta.keywords)) push(str(k));
    for (const k of arr<string>(a.params?.keywords)) push(str(k));
  }
  return out;
}

/** 该卡是否是「需要选目标」的启动类护符 / 有没有 activate 能力 */
export function activateInvocationOf(cardId: string): CardAbilityInvocation | null {
  for (const a of getCardAbilities(cardId)) {
    const meta = (CARD_ABILITY_MAP as unknown as Record<string, { trigger?: string }>)[String(a.name)];
    if (meta && String(meta.trigger) === 'activate') return a;
  }
  return null;
}

// ====================== 目标选择（照抄 TargetSelectSystem.autoPick 口径）======================

/** 某方战场「左 → 右」顺序（= autoPick 同攻击力取最左的口径） */
function fieldOrdered(s: AiState, owner: 'player' | 'enemy'): AiUnit[] {
  const list = owner === 'enemy' ? s.me : s.foe;
  // 敌方新卡插到最左 ⇒ cards 左→右 = order 从大到小；我方（玩家）新卡追加到最右 ⇒ order 从小到大
  return list.slice().sort((a, b) => (owner === 'enemy' ? b.order - a.order : a.order - b.order));
}

/** 候选随从（口径 = TargetSelectSystem.candidatesFor：对方随从要排除潜行 / 灵气；filter 支持 damaged/guard） */
export function candidatesFor(s: AiState, owner: 'player' | 'enemy', select: string, filter = ''): AiUnit[] {
  const againstOpponent = select !== 'friendlyFollower';
  const want = String(filter || '').trim().toLowerCase();
  const out: AiUnit[] = [];
  for (const u of fieldOrdered(s, owner)) {
    if (!u.isFollower) continue;
    if (againstOpponent && (hasKw(u, 'Ambush') || hasKw(u, 'Aura'))) continue;
    if (want === 'damaged') { if (!(u.hp < u.maxHp)) continue; }
    else if (want === 'guard') { if (!hasKw(u, 'Guard')) continue; }
    out.push(u);
  }
  return out;
}

/** 自动选目标（= autoPick：攻击力最高，同攻击力取最左） */
export function autoPickKey(s: AiState, owner: 'player' | 'enemy', select: string, filter = ''): string | null {
  const list = candidatesFor(s, owner, select, filter);
  if (list.length === 0) return null;
  let best = list[0];
  for (let i = 1; i < list.length; i++) if (list[i].atk > best.atk) best = list[i];
  return best.key;
}

/**
 * 这张卡在某触发时机下**是否需要先选目标**（口径 = CardAbilitySystem.cardTargetRequest，
 * 但**按阵营**读协作值 —— 敌方牌读敌方协作，这是我修掉的一个只写玩家方的问题）。
 */
export function needsTargetOf(cardId: string, triggers: string[], side: 'player' | 'enemy', coop: number): boolean {
  for (const a of invocationsOfTrigger(cardId, triggers)) {
    const sel = str(a.params?.select) || nestedSelect(a);
    if (sel) {
      const need = cooperationRequirementOfCard(cardId);
      if (need > 0 && coop >= need) return false;    // 协作已满足 ⇒ 不再需要选目标
      return true;
    }
  }
  return false;
}

function nestedSelect(inv: CardAbilityInvocation, depth = 0): string {
  const direct = str(inv.params?.select);
  if (direct) return direct;
  if (depth > 3) return '';
  for (const n of nestedOf(inv)) {
    const s2 = nestedSelect(n, depth + 1);
    if (s2) return s2;
  }
  return '';
}

/** 取目标筛选（params.filter，与 select 同层或内嵌） */
export function targetFilterOf(cardId: string, triggers: string[]): string {
  for (const a of invocationsOfTrigger(cardId, triggers)) {
    const f = str(a.params?.filter) || nestedFilter(a);
    if (f) return f;
  }
  return '';
}

function nestedFilter(inv: CardAbilityInvocation, depth = 0): string {
  const direct = str(inv.params?.filter);
  if (direct) return direct;
  if (depth > 3) return '';
  for (const n of nestedOf(inv)) {
    const f = nestedFilter(n, depth + 1);
    if (f) return f;
  }
  return '';
}

/** 卡牌的协作门槛（扫 Cooperation.threshold） */
function cooperationRequirementOfCard(cardId: string): number {
  let need = 0;
  const walk = (inv: CardAbilityInvocation, d = 0): void => {
    if (d > 3) return;
    if (String(inv.name) === 'Cooperation') {
      const t = Math.max(0, Math.round(num(inv.params?.threshold)));
      if (t > need) need = t;
    }
    for (const n of nestedOf(inv)) walk(n, d + 1);
  };
  for (const a of getCardAbilities(cardId)) walk(a);
  return need;
}

/** 取投一个能力调用的内嵌效果（params.effect / params.effects） */
function nestedOf(inv: CardAbilityInvocation): CardAbilityInvocation[] {
  const out: CardAbilityInvocation[] = [];
  const push = (v: unknown): void => {
    if (Array.isArray(v)) { for (const it of v) push(it); return; }
    if (!v || typeof v !== 'object') return;
    const o = v as CardAbilityInvocation;
    if (str(o.name)) out.push(o);
  };
  push(inv.params?.effect);
  push(inv.params?.effects);
  return out;
}

// ====================== 伤害 / 破坏（照抄 BattleRuleSystem）======================

/** 造成伤害（屏障吃掉一次伤害并消耗；返回是否被屏障挡下） */
function dealDamage(u: AiUnit, amount: number): boolean {
  const dmg = Math.max(0, Math.floor(num(amount)));
  if (dmg <= 0) return false;
  if (hasKw(u, 'Barrier')) { delKw(u, 'Barrier'); return true; }
  u.hp -= dmg;
  return false;
}

/** 能力破坏放行判据（血量<=0 恒可；否则超进化守护 / 不会被能力破坏都拒绝） */
function canDestroyUnit(u: AiUnit, ownTurn: boolean): boolean {
  if (u.hp <= 0) return true;
  if (ownTurn && u.superEvolved) return false;          // 自己回合的超进化守护
  if (hasKw(u, 'AbilityDestroyImmune')) return false;
  return true;
}

// ====================== ① 攻击模拟 ======================

/** 某只我方随从当前可打的目标（口径 = canTarget / resolveCombat） */
export function attackerTargets(s: AiState, atkKey: string): { units: string[]; hero: boolean } {
  const a = findUnit(s.me, atkKey);
  if (!a || a.attacksLeft <= 0) return { units: [], hero: false };
  const guardOn = s.foe.some((u) => hasKw(u, 'Guard'));
  const units = s.foe
    .filter((u) => u.isFollower && !hasKw(u, 'Deter') && !hasKw(u, 'Ambush') && (!guardOn || hasKw(u, 'Guard')))
    .map((u) => u.key);
  const hero = !guardOn && a.canAttackHero && a.isFollower;
  return { units, hero };
}

/**
 * 结算一次「我方随从 → 对方随从 / 对方主战者」的攻击（返回新快照；非法返回 null）。
 * 🔴 我方超进化随从在**自己回合**受到的伤害为 0、也不会被毁灭破坏（超进化守护）。
 */
export function simAttack(s: AiState, atkKey: string, targetKey: string | null, opts: AiOptions): AiState | null {
  const legal = attackerTargets(s, atkKey);
  if (targetKey === null) { if (!legal.hero) return null; }
  else if (legal.units.indexOf(targetKey) < 0) return null;

  const st = cloneState(s);
  const a = findUnit(st.me, atkKey);
  if (!a) return null;
  a.attacksLeft = Math.max(0, a.attacksLeft - 1);
  if (a.attacksLeft <= 0) { a.canAttackUnit = false; a.canAttackHero = false; }

  if (targetKey === null) {                              // 打主战者：不吃反击、不触发交战时
    st.foeHero -= Math.max(0, a.atk);
    return st;
  }
  const d = findUnit(st.foe, targetKey);
  if (!d) return null;

  // ★【交战时】先于互相伤害结算；任一方因此离场 → 本次**不再交换伤害**（含反击）。
  //   顺序与真实流程一致：**攻击方先触发**（所以「交战时破坏」的随从能白吃对手）。
  if (hasBattleAbility(a.cardId)) {
    if (clashEffects(st, 'me', a.key, d.key, opts)) {
      // ★ 交战时破坏 + 攻击方已超进化 ⇒ 对方主战者同样吃连锁伤害（与真实规则同步）
      if (a.superEvolved) st.foeHero -= Math.max(0, Math.round(num(opts.superEvolveBreakHeroDamage)));
      return st;                                                    // 对手被破坏 ⇒ 接触取消
    }
  }
  if (hasBattleAbility(d.cardId)) {
    if (clashEffects(st, 'foe', d.key, a.key, opts)) return st;     // 我方被破坏 ⇒ 接触取消
  }
  const attackerNow = findUnit(st.me, a.key);
  const defenderNow = findUnit(st.foe, d.key);
  if (!attackerNow || !defenderNow) return st;

  const shieldedMe = attackerNow.superEvolved;           // 己方回合：我方超进化随从伤害归零
  dealDamage(defenderNow, attackerNow.atk);
  if (!shieldedMe) dealDamage(attackerNow, defenderNow.atk);

  const attackerBane = hasKw(attackerNow, 'Bane') && canDestroyUnit(defenderNow, false);
  const defenderBane = hasKw(defenderNow, 'Bane') && canDestroyUnit(attackerNow, true) && !shieldedMe;
  const defenderDead = defenderNow.hp <= 0 || attackerBane;
  const attackerDead = !shieldedMe && (attackerNow.hp <= 0 || defenderBane);
  // 🔴 破坏走 simDestroy（会结算**谢幕曲**）
  if (defenderDead) simDestroy(st, 'foe', defenderNow.key, opts, 0);
  if (attackerDead) simDestroy(st, 'me', attackerNow.key, opts, 0);
  if (defenderDead && attackerNow.superEvolved) {        // 超进化破坏 → 对方主战者连锁伤害
    st.foeHero -= Math.max(0, Math.round(num(opts.superEvolveBreakHeroDamage)));
  }
  return st;
}

// ====================== ② 出牌 / 进化 / 启动 模拟 ======================

interface EffCtx {
  sourceKey: string; cardId: string; targetKey: string | null; enhanced: boolean;
  /** 这次能力的归属方（决定「己方 / 对方」） */
  owner: AiOwner;
}

function nextOrder(list: AiUnit[]): number {
  let m = -1;
  for (const u of list) if (u.order > m) m = u.order;
  return m + 1;
}

/** 把一张「凭空召唤」的随从放进我方战场（战场满则忽略） */
/** 己方 / 对方列表（按 owner 归一，`applyInvocation` 全程用它，避免写死「我方」） */
function ownList(s: AiState, o: AiOwner): AiUnit[] { return o === 'me' ? s.me : s.foe; }
function oppList(s: AiState, o: AiOwner): AiUnit[] { return o === 'me' ? s.foe : s.me; }
function otherOwner(o: AiOwner): AiOwner { return o === 'me' ? 'foe' : 'me'; }
function ownHeroGet(s: AiState, o: AiOwner): number { return o === 'me' ? s.myHero : s.foeHero; }
function ownHeroSet(s: AiState, o: AiOwner, v: number): void { if (o === 'me') s.myHero = v; else s.foeHero = v; }
function oppHeroSet(s: AiState, o: AiOwner, v: number): void { if (o === 'me') s.foeHero = v; else s.myHero = v; }

/** 把一张「凭空召唤 / 生成」的随从放进**指定方**的战场（战场满则忽略） */
function addToken(s: AiState, cardId: string, owner: AiOwner): AiUnit | null {
  const list = ownList(s, owner);
  if (list.length >= s.maxCards) return null;
  const info = getCardInfo(cardId);
  const kws = passiveKeywordsOf(cardId);
  const hp = Math.max(1, Math.round(num(info?.hp, 1)));
  const u: AiUnit = {
    key: 'NEW:' + owner + ':' + cardId + ':' + list.length + ':' + Math.random().toString(36).slice(2, 7),
    cardId,
    name: String(info?.cardName || cardId),
    atk: Math.max(0, Math.round(num(info?.attack, 1))),
    hp, maxHp: hp,
    keywords: kws,
    isFollower: true,
    order: nextOrder(list),
    canAttackUnit: kws.indexOf('Rush') >= 0 || kws.indexOf('Charge') >= 0,
    canAttackHero: kws.indexOf('Charge') >= 0,
    attacksLeft: 1,
    superEvolved: false,
    evolved: false,
    chantTurns: 0,
  };
  list.push(u);
  return u;
}

/**
 * 按「入场顺序」把 total 点伤害摊到某方战场上（打死后溢出给下一张，屏障照常吃掉一次）。
 * 🔴 致死 = **破坏** ⇒ 走 simDestroy（结算谢幕曲），不是简单摘除。
 */
function damageListInOrder(s: AiState, owner: AiOwner, total: number, opts: AiOptions): void {
  const list = ownList(s, owner);
  let left = Math.max(0, Math.floor(total));
  for (const u of byEntryOrder(list)) {
    if (left <= 0) break;
    if (u.hp <= 0) continue;
    const take = Math.min(left, Math.max(0, u.hp));
    dealDamage(u, take);
    left -= take;
  }
  for (const u of list.slice()) if (u.hp <= 0) simDestroy(s, owner, u.key, opts, 1);
}

/**
 * **破坏**一个随从（owner 侧）：摘出战场 → 结算它的**谢幕曲**（`LastWords`）。
 * 🔴 只有「破坏」才发动谢幕曲；**消失（Vanish）不发动**（与真实规则一致，消失走 dropUnit）。
 */
function simDestroy(s: AiState, owner: AiOwner, key: string, opts: AiOptions, depth = 0): void {
  if (depth > 2) return;
  const list = ownList(s, owner);
  const u = findUnit(list, key);
  if (!u) return;
  dropUnit(list, key);
  for (const inv of invocationsOfTrigger(u.cardId, ['lastWords'])) {
    applyInvocation(s, inv, {
      sourceKey: key, cardId: u.cardId, targetKey: null, enhanced: false, owner,
    }, opts, depth);
  }
}

/** 解释一次能力调用（owner = 这次能力的归属方；未登记效果保守忽略） */
function applyInvocation(s: AiState, inv: CardAbilityInvocation, ctx: EffCtx, opts: AiOptions, depth: number): void {
  if (depth > 4) return;
  const name = String(inv.name || '');
  const p = inv.params || {};
  const own = ownList(s, ctx.owner);
  const opp = oppList(s, ctx.owner);
  const self = sourceOfUnit(s, ctx.sourceKey, ctx.owner);
  switch (name) {
    case 'Fanfare':
    case 'SpellEffects':
    case 'SelectTarget':
    case 'Activate':
    case 'Ougi':
    case 'OugiRelease':
    // ★ **容器类**能力：谢幕曲 / 回合结束 / 交战时 / 属性提升时 —— 本身没有效果，只负责展开内嵌效果。
    //   🔴 漏了这几条 ⇒ 对手的谢幕曲（召唤 / 抽牌 / 获得纹章）与双方的回合结束效果在模拟里完全不生效（实测踩过）。
    case 'LastWords':
    case 'TurnEnd':
    case 'Clash':
    case 'StatUp':
      for (const n of nestedOf(inv)) applyInvocation(s, n, ctx, opts, depth + 1);
      return;
    case 'Enhance':
      if (ctx.enhanced) for (const n of nestedOf(inv)) applyInvocation(s, n, ctx, opts, depth + 1);
      return;
    case 'Cooperation': {
      const need = Math.max(0, Math.round(num(p.threshold)));
      if (s.coop >= need) {
        for (const n of nestedOf(inv)) applyInvocation(s, n, ctx, opts, depth + 1);
      } else {
        const elseInv = p.otherwise;
        if (Array.isArray(elseInv)) { for (const n of elseInv) if (n && typeof n === 'object') applyInvocation(s, n as CardAbilityInvocation, ctx, opts, depth + 1); }
        else if (elseInv && typeof elseInv === 'object') applyInvocation(s, elseInv as CardAbilityInvocation, ctx, opts, depth + 1);
      }
      return;
    }
    case 'CooperationUp':
      s.coop += Math.max(0, Math.round(num(p.amount, 1)));
      return;
    case 'Summon': {
      const count = Math.max(1, Math.round(num(p.count, 1)));
      const id = str(p.id) || str(p.cardImage) || '20.png';
      for (let i = 0; i < count; i++) addToken(s, id, ctx.owner);
      return;
    }
    case 'BuffFriendlyFollowers': {
      const atk = num(p.attack), hp = num(p.hp), kws = arr<string>(p.keywords);
      const excludeSelf = p.excludeSelf === true;
      for (const u of own) {
        if (excludeSelf && u.key === ctx.sourceKey) continue;
        if (!u.isFollower) continue;
        u.atk += atk; u.hp += hp; u.maxHp += hp;
        for (const k of kws) addKw(u, str(k));
      }
      return;
    }
    case 'BuffSelected': {
      const u = ctx.targetKey ? findUnit(own, ctx.targetKey) : null;
      if (u) {
        u.atk += num(p.attack); u.hp += num(p.hp); u.maxHp += num(p.hp);
        for (const k of arr<string>(p.keywords)) addKw(u, str(k));
      }
      return;
    }
    case 'DamageSelected': {
      const u = ctx.targetKey ? findUnit(opp, ctx.targetKey) : null;
      if (u) { dealDamage(u, num(p.amount)); if (u.hp <= 0) simDestroy(s, otherOwner(ctx.owner), u.key, opts, depth + 1); }
      return;
    }
    case 'DistributeDamage': {
      const total = str(p.amountFrom) === 'attack' ? (self ? Math.max(0, self.atk) : 0) : Math.max(0, Math.round(num(p.amount)));
      if (total <= 0) return;
      const mode = str(p.side);
      if (mode === 'self') damageListInOrder(s, ctx.owner, total, opts);
      else if (mode === 'both') { damageListInOrder(s, ctx.owner, total, opts); damageListInOrder(s, otherOwner(ctx.owner), total, opts); }
      else damageListInOrder(s, otherOwner(ctx.owner), total, opts);
      return;
    }
    case 'DamageHero': {
      const amount = Math.max(0, Math.round(num(p.amount)));
      if (str(p.side) === 'self') ownHeroSet(s, ctx.owner, Math.max(0, ownHeroGet(s, ctx.owner) - amount));
      else oppHeroSet(s, ctx.owner, ownHeroGet(s, otherOwner(ctx.owner)) - amount);
      return;
    }
    case 'RandomDamage': {
      const amount = Math.max(0, Math.round(num(p.amount)));
      const times = Math.max(1, Math.round(num(p.times, 1)));
      const list = str(p.side) === 'self' ? own : opp;
      const ownerOfList = str(p.side) === 'self' ? ctx.owner : otherOwner(ctx.owner);
      for (let i = 0; i < times; i++) {
        if (list.length === 0) break;
        const sorted = list.slice().sort((a, b) => (a.hp - b.hp) || (b.atk - a.atk));
        const t = sorted[0];
        dealDamage(t, amount);
        if (t.hp <= 0) simDestroy(s, ownerOfList, t.key, opts, depth + 1);
      }
      return;
    }
    case 'DestroyHighestAttack': {
      const alive = opp.filter((u) => u.isFollower);
      if (alive.length === 0) return;
      let best = alive[0];
      for (const u of alive) if (u.atk > best.atk) best = u;              // 并列取最左（order 最小）
      for (const u of alive) if (u.atk === best.atk && u.order < best.order) best = u;
      if (canDestroyUnit(best, false)) simDestroy(s, otherOwner(ctx.owner), best.key, opts, depth + 1);
      return;
    }
    case 'VanishAll': {
      const mode = str(p.side);
      const excludeSelf = p.excludeSelf === true;
      // 🔴 消失不发动谢幕曲 ⇒ 直接 dropUnit
      if (mode === 'self') { for (const u of own.slice()) if (!(excludeSelf && u.key === ctx.sourceKey)) dropUnit(own, u.key); }
      else if (mode === 'both') {
        for (const u of own.slice()) if (!(excludeSelf && u.key === ctx.sourceKey)) dropUnit(own, u.key);
        for (const u of opp.slice()) dropUnit(opp, u.key);
      } else { for (const u of opp.slice()) dropUnit(opp, u.key); }
      return;
    }
    case 'Vanish': {
      const key = ctx.targetKey;
      if (!key) return;
      dropUnit(own, key); dropUnit(opp, key);                             // 消失：不发动谢幕曲
      return;
    }
    case 'DestroySelf':
      if (self) simDestroy(s, ctx.owner, self.key, opts, depth + 1);
      return;
    case 'HealHero':
      ownHeroSet(s, ctx.owner, Math.min(ctx.owner === 'me' ? s.myHeroMax : s.foeHeroMax,
        ownHeroGet(s, ctx.owner) + Math.max(0, Math.round(num(p.amount)))));
      return;
    case 'RestorePP':
      if (ctx.owner === 'me') s.pp = Math.min(s.ppMax, s.pp + Math.max(0, Math.round(num(p.amount))));
      return;
    case 'GainCrest':
      if (ctx.owner === 'me') { s.crests += 1; } else { s.foeCrests += 1; }
      return;
    case 'MultiAttack':
      if (self) { addKw(self, 'MultiAttack'); self.attacksLeft = Math.max(self.attacksLeft, maxAttacksOf(ctx.cardId)); }
      return;
    case 'SelfSuperEvolve':
      if (self) {
        self.atk += opts.superAttack; self.hp += opts.superHp; self.maxHp += opts.superHp;
        self.superEvolved = true; self.evolved = true;
        if (opts.evolveKeyword) addKw(self, opts.evolveKeyword);
      }
      return;
    case 'DrawCards': {
      const n = Math.max(0, Math.round(num(p.count, 1)));
      if (ctx.owner === 'me') s.draws += n; else s.foeDraws += n;
      return;
    }
    case 'AddToHand':
      if (ctx.owner === 'me') s.draws += 1; else s.foeDraws += 1;
      return;
    // ★ 纯关键字授予（Mode 选项 / SuperEvolve / 任意内嵌写法里的 { name:'Charge' } 等）
    case 'Rush':
    case 'Charge':
    case 'Guard':
    case 'Bane':
    case 'Barrier':
    case 'Deter':
    case 'Ambush':
    case 'Aura':
    case 'AbilityDestroyImmune': {
      if (self) {
        addKw(self, name);
        if (name === 'Rush' || name === 'Charge') {
          self.attacksLeft = Math.max(1, self.attacksLeft);
          self.canAttackUnit = true;
          if (name === 'Charge') self.canAttackHero = true;
        }
      }
      return;
    }
    case 'Chant':
      if (self) { addKw(self, 'Chant'); self.chantTurns = Math.max(1, Math.round(num(p.turns, 1))); }
      return;
    case 'Mode': {
      const options = arr<Record<string, unknown>>(p.options);
      if (options.length === 0) return;
      // 逐个选项试算 → 选**最优**（这就是「Mode 选项最优选」，AI 会把它写回真实出牌流程）
      const count = Math.max(1, Math.round(num(p.count, 1)));
      let bestIdx = 0, bestScore = -Infinity;
      // 计划分支指定了选项 ⇒ 直接采用（整体计划评分会替它把关）；否则在本地逐选项试算
      const forced = s.modeForce;
      for (let i = 0; i < options.length && !(forced >= 0 && forced < options.length); i++) {
        const opt = options[i];
        const probe = cloneState(s);
        const fake: CardAbilityInvocation = {
          name: inv.name,
          params: Object.assign({}, p, { effect: opt.effect, effects: opt.effects }),
        };
        for (const n of nestedOf(fake)) applyInvocation(probe, n, ctx, opts, depth + 1);
        const sc = boardValue(ownList(probe, ctx.owner), ctx.owner === 'me')
          - boardValue(oppList(probe, ctx.owner), ctx.owner === 'me')
          + (ctx.owner === 'me' ? (probe.myHero - probe.foeHero) : (probe.foeHero - probe.myHero)) * 0.5
          + (ctx.owner === 'me' ? attackPotential(probe) * 0.35 : 0);
        if (sc > bestScore) { bestScore = sc; bestIdx = i; }
      }
      if (forced >= 0 && forced < options.length) bestIdx = forced;
      const picks: number[] = [bestIdx];
      while (picks.length < count) {
        let next = -1;
        for (let i = 0; i < options.length; i++) if (picks.indexOf(i) < 0) { next = i; break; }
        if (next < 0) break;
        picks.push(next);
      }
      if (ctx.owner === 'me') s.modePick = bestIdx;
      for (const i of picks) {
        const opt = options[i];
        if (!opt) continue;
        const fake: CardAbilityInvocation = {
          name: inv.name,
          params: Object.assign({}, p, { effect: opt.effect, effects: opt.effects }),
        };
        for (const n of nestedOf(fake)) applyInvocation(s, n, ctx, opts, depth + 1);
      }
      return;
    }
    default:
      return;   // 未登记 / 非即时效果：保守忽略
  }
}

/**
 * **交战时**（Clash）：在互相造成伤害前触发的效果。
 * 🔴 与本项目真实流程同序：**攻击方先触发**，任一方因此离场 → 本次**不再交换伤害**。
 * 当前卡表的交战时都是 `action:'destroy'`（破坏交战对象）。
 * @returns 是否「交战对象已被破坏」（= 本次接触取消）
 */
function clashEffects(s: AiState, owner: AiOwner, sourceKey: string, targetKey: string, opts: AiOptions): boolean {
  const src = findUnit(ownList(s, owner), sourceKey);
  if (!src) return false;
  const invs = invocationsOfTrigger(src.cardId, ['battle']);
  if (invs.length === 0) return false;
  let destroyed = false;
  for (const inv of invs) {
    const target = findUnit(oppList(s, owner), targetKey);
    if (!target) break;
    const action = str(inv.params?.action);
    const ctx: EffCtx = { sourceKey, cardId: src.cardId, targetKey, enhanced: false, owner };
    // 破坏类：走统一破坏判据（对手的「不会被能力破坏」/ 自己回合的超进化守护都要拦）
    // 🔴 第二个参数 =「这个目标是否处于**它自己那一方**的回合」：
    //    交战时破坏发生在**当前回合方的回合**里 ⇒ 目标是「我的随从」时自己回合=true（超进化守护 → 不可被破坏），
    //    目标是「对手随从」时=false。以前这里一律传 false ⇒ AI 误判「我的超进化随从会被对手的交战时破坏带走」，
    //    于是**不敢用超进化随从去打对手的交战时破坏随从**（实测：超进化猛犸不敢打对方的针）。
    if (action === 'destroy' && canDestroyUnit(target, owner === 'foe')) {
      simDestroy(s, otherOwner(owner), targetKey, opts, 0);
      destroyed = true;
    }
    for (const n of nestedOf(inv)) applyInvocation(s, n, ctx, opts, 0);
  }
  return destroyed;
}

/** 是否持有交战时能力（用来快速跳过） */
function hasBattleAbility(cardId: string): boolean {
  return invocationsOfTrigger(cardId, ['battle']).length > 0;
}

/**
 * **回合结束时**（TurnEnd）投影：把某一方战场上所有 `TurnEnd` 能力结算到快照上。
 * 用途 = 评估「场上遗留卡牌」的价值（自己回合结束时自己的 TurnEnd 生效；
 * 对手的 TurnEnd 会在对手回合结束时打到我的残留场面 ⇒ 当作残留风险计入评分）。
 */
export function applyTurnEnd(s: AiState, owner: AiOwner, opts: AiOptions): void {
  const list = ownList(s, owner).slice();
  for (const u of list) {
    if (!u.cardId) continue;
    const invs = invocationsOfTrigger(u.cardId, ['turnEnd']);
    for (const inv of invs) {
      applyInvocation(s, inv, {
        sourceKey: u.key, cardId: u.cardId, targetKey: null, enhanced: false, owner,
      }, opts, 0);
    }
  }
}

/** 投影到「本回合全部结束时」：先结算我方的 TurnEnd，再算对手 TurnEnd 打到我方残留场面的风险 */
export function projectEndOfTurn(s: AiState, opts: AiOptions): AiState {
  const st = cloneState(s);
  applyTurnEnd(st, 'me', opts);
  applyTurnEnd(st, 'foe', opts);
  return st;
}
function sourceOfUnit(s: AiState, key: string, owner: AiOwner = 'me'): AiUnit | null {
  return key ? findUnit(ownList(s, owner), key) : null;
}

/** 入场时点会触发的效果（随从 / 护符：passive 关键字 + fanfare；法术：use） */
function applyCardEffects(s: AiState, cardId: string, ctx: EffCtx, opts: AiOptions): void {
  const self = sourceOfUnit(s, ctx.sourceKey, ctx.owner);
  if (self) {
    for (const k of passiveKeywordsOf(cardId)) addKw(self, k);
    if (hasKw(self, 'Rush') || hasKw(self, 'Charge')) {
      self.canAttackUnit = true;
      self.attacksLeft = Math.max(1, self.attacksLeft);
      if (hasKw(self, 'Charge')) self.canAttackHero = true;
    }
    if (hasKw(self, 'MultiAttack')) self.attacksLeft = Math.max(self.attacksLeft, maxAttacksOf(cardId));
  }
  for (const inv of invocationsOfTrigger(cardId, ['use', 'fanfare'])) applyInvocation(s, inv, ctx, opts, 0);
}

/** 进化时点会触发的效果（evolve / superEvolve），目标按 autoPick 口径选 */
function applyEvolveEffects(s: AiState, key: string, superEvolve: boolean, opts: AiOptions): void {
  const u = findUnit(s.me, key);
  if (!u) return;
  const triggers = superEvolve ? ['evolve', 'superEvolve'] : ['evolve'];
  for (const inv of invocationsOfTrigger(u.cardId, triggers)) {
    const ctx: EffCtx = { sourceKey: key, cardId: u.cardId, targetKey: null, enhanced: false, owner: 'me' };
    const sel = str(inv.params?.select) || nestedSelect(inv);
    if (sel) {
      const filter = str(inv.params?.filter) || nestedFilter(inv);
      ctx.targetKey = autoPickKey(s, 'enemy', sel, filter);
      if (!ctx.targetKey) continue;         // 没有合法候选 ⇒ 本次不结算（与真实口径一致）
    }
    applyInvocation(s, inv, ctx, opts, 0);
  }
}

/** 出牌费用（照抄 CardPlay：能量够走最大爆能强化值） */
export function playCostOf(s: AiState, card: AiHandCard): { cost: number; enhanced: boolean } {
  if (card.enhanceValue > 0 && s.pp >= card.enhanceValue) return { cost: card.enhanceValue, enhanced: true };
  return { cost: card.cost, enhanced: false };
}

/** 模拟打出一张手牌（返回新快照；非法/不可用返回 null） */
export function simPlay(s: AiState, handIndex: number, opts: AiOptions, modeOverride = -1): AiState | null {
  const card = findCard(s, handIndex);
  if (!card) return null;
  if (s.playsLeft <= 0) return null;
  const pay = playCostOf(s, card);
  if (s.pp < pay.cost) return null;
  const needSlot = card.type !== 'Spell';
  if (needSlot && s.me.length >= s.maxCards) return null;

  const st = cloneState(s);
  st.pp -= pay.cost;
  st.playsLeft = Math.max(0, st.playsLeft - 1);
  st.hand = st.hand.filter((c) => c.index !== handIndex);

  st.modePick = -1;                     // 每次出牌前清空「模式」选择，出牌后由效果解释器写入
  st.modeForce = modeOverride;          // 计划分支指定的模式选项（-1 = 内核算）
  let selfKey = '';
  if (needSlot) {
    const kws = passiveKeywordsOf(card.cardId);
    const hp = Math.max(1, Math.round(num(getCardInfo(card.cardId)?.hp, 1)));
    const u: AiUnit = {
      key: 'NEW:' + card.cardId + ':' + st.me.length + ':' + Math.random().toString(36).slice(2, 7),
      cardId: card.cardId, name: card.name,
      atk: Math.max(0, Math.round(num(getCardInfo(card.cardId)?.attack, 1))),
      hp, maxHp: hp, keywords: kws, isFollower: card.type === 'Follower',
      order: nextOrder(st.me),
      canAttackUnit: kws.indexOf('Rush') >= 0 || kws.indexOf('Charge') >= 0,
      canAttackHero: kws.indexOf('Charge') >= 0,
      attacksLeft: 1, superEvolved: false, evolved: false, chantTurns: 0,
    };
    st.me.push(u);
    selfKey = u.key;
  }
  // 需要先选目标的能力：按 autoPick 口径在**模拟后的战场**上选（与执行层同源）
  const triggers = card.type === 'Spell' ? ['use'] : ['fanfare'];
  let targetKey: string | null = null;
  if (needsTargetOf(card.cardId, triggers, 'enemy', st.coop)) {
    const sel = selectOfCard(card.cardId, triggers);
    const filter = targetFilterOf(card.cardId, triggers);
    if (sel) targetKey = autoPickKey(st, 'enemy', sel, filter);
  }
  applyCardEffects(st, card.cardId, { sourceKey: selfKey, cardId: card.cardId, targetKey, enhanced: pay.enhanced, owner: 'me' }, opts);
  return st;
}

function selectOfCard(cardId: string, triggers: string[]): string {
  for (const a of invocationsOfTrigger(cardId, triggers)) {
    const sel = str(a.params?.select) || nestedSelect(a);
    if (sel) return sel;
  }
  return '';
}

/** 模拟进化（返回新快照；不可进化返回 null） */
export function simEvolve(s: AiState, key: string, superEvolve: boolean, opts: AiOptions): AiState | null {
  const u0 = findUnit(s.me, key);
  if (!u0 || !u0.isFollower || u0.evolved) return null;
  if (superEvolve ? !opts.canSuperEvolve : !opts.canEvolve) return null;
  const st = cloneState(s);
  const u = findUnit(st.me, key);
  if (!u) return null;
  const a = superEvolve ? opts.superAttack : opts.evolveAttack;
  const h = superEvolve ? opts.superHp : opts.evolveHp;
  u.atk += a; u.hp += h; u.maxHp += h; u.evolved = true;
  if (superEvolve) u.superEvolved = true;
  if (opts.evolveKeyword) {
    addKw(u, opts.evolveKeyword);
    if (opts.evolveKeyword === 'Rush' || opts.evolveKeyword === 'Charge') {
      u.attacksLeft = Math.max(1, u.attacksLeft);
      u.canAttackUnit = true;
      if (opts.evolveKeyword === 'Charge') u.canAttackHero = true;
    }
  }
  applyEvolveEffects(st, key, superEvolve, opts);
  return st;
}

/** 这张卡（在手牌里）有几个「模式」选项（0 / 1 = 不需要分支） */
export function modeOptionCount(cardId: string): number {
  let n = 0;
  const walk = (inv: CardAbilityInvocation, d = 0): void => {
    if (d > 3) return;
    if (String(inv.name) === 'Mode') n = Math.max(n, arr<Record<string, unknown>>(inv.params?.options).length);
    for (const x of nestedOf(inv)) walk(x, d + 1);
  };
  for (const a of getCardAbilities(cardId)) walk(a);
  return n;
}

/** 模拟启动护符（返回新快照；不可用返回 null） */
export function simActivate(s: AiState, key: string, opts: AiOptions): AiState | null {
  const u0 = findUnit(s.me, key);
  if (!u0 || u0.isFollower) return null;
  const inv = activateInvocationOf(u0.cardId);
  if (!inv) return null;
  const cost = Math.max(0, Math.round(num(inv.params?.cost)));
  if (s.pp < cost) return null;
  const st = cloneState(s);
  st.pp -= cost;
  let target: string | null = null;
  const sel = str(inv.params?.select);
  if (sel) {
    target = autoPickKey(st, 'enemy', sel, str(inv.params?.filter));
    const optional = inv.params?.optional === true;
    if (!target && !optional) return null;
  }
  applyInvocation(st, inv, { sourceKey: key, cardId: u0.cardId, targetKey: target, enhanced: false, owner: 'me' }, opts, 0);
  return st;
}

// ====================== ③ 评估 ======================

export function scoreState(s: AiState): number {
  const W = AI_WEIGHTS;
  if (s.myHero <= 0) return -W.suicide;
  if (s.foeHero <= 0) return W.lethal + s.myHero * 10;
  let v = 0;
  v += W.myBoard * W.lossPenalty * boardValue(s.me, true);      // 我方场面（保留优先）
  v -= W.foeBoard * boardValue(s.foe, false);                   // 对方场面（倾向解掉）
  v += W.heroLead * (s.myHero - s.foeHero);                     // 主战者血量差距
  if (s.foe.length === 0 && s.me.length > 0) v += W.clearBonus;  // 解干净 + 我方还有场面
  v += W.wide * s.me.length;                                     // 铺场宽度
  v += W.handKeep * handKeepValue(s);                            // 保留手牌资源
  v += W.drawValue * s.draws;
  v += W.crestValue * s.crests;
  // 对手白拿的资源 = 我的负收益（谢幕曲给对手抽牌 / 给纹章时要算进去）
  v -= W.drawValue * s.foeDraws;
  v -= W.crestValue * s.foeCrests;
  return v;
}

/**
 * 投影评分：把「本回合全部结束」后的状态拿来评分 ——
 * 自己回合结束会触发我方场的 `TurnEnd`；对手的 `TurnEnd` 会在对手回合结束时打到我的残留场面。
 * 这是「**场上遗留卡牌**也能算进最大分」的那一步。
 */
export function scoreProjected(s: AiState, opts: AiOptions): number {
  return scoreState(projectEndOfTurn(s, opts));
}

/** 便宜的「本回合还能打多少」估计（只用于选出牌，不参与最终评分） */
function attackPotential(s: AiState): number {
  const guardOn = s.foe.some((u) => hasKw(u, 'Guard'));
  let toHero = 0, toUnits = 0, foeHp = 0;
  for (const u of s.me) {
    if (u.attacksLeft <= 0) continue;
    if (u.canAttackUnit) toUnits += Math.max(0, u.atk);
    if (u.canAttackHero && !guardOn) toHero += Math.max(0, u.atk);
  }
  for (const u of s.foe) foeHp += Math.max(0, u.hp);
  const lethal = (!guardOn && toHero >= s.foeHero && s.foeHero > 0) ? 400 : 0;
  return lethal + toHero * 6 + Math.min(toUnits, foeHp) * 3;
}

// ====================== ④ 攻击搜索（有限深度 DFS）======================

export interface AiCombatResult { attacks: AiAttack[]; state: AiState; score: number; capped: boolean; }

export function searchCombat(start: AiState, opts: AiOptions): AiCombatResult {
  const t0 = Date.now();
  const budgetMs = Math.max(8, num(opts.timeBudgetMs, 40));
  const maxSims = 3000;
  let sims = 0;
  let capped = false;
  let best: AiCombatResult = { attacks: [], state: cloneState(start), score: scoreProjected(start, opts), capped: false };
  const order = start.me
    .filter((u) => u.attacksLeft > 0 && (u.canAttackUnit || u.canAttackHero))
    .sort((a, b) => b.atk - a.atk || a.order - b.order)
    .map((u) => u.key);

  const dfs = (st: AiState, i: number, path: AiAttack[]): void => {
    if (sims++ > maxSims || Date.now() - t0 > budgetMs) {
      capped = true;
      const sc = scoreProjected(st, opts);
      if (sc > best.score) best = { attacks: path.slice(), state: cloneState(st), score: sc, capped: true };
      return;
    }
    if (i >= order.length) {
      const sc = scoreProjected(st, opts);
      if (sc > best.score) best = { attacks: path.slice(), state: cloneState(st), score: sc, capped };
      return;
    }
    const key = order[i];
    const cur = findUnit(st.me, key);
    if (!cur || cur.attacksLeft <= 0) { dfs(st, i + 1, path); return; }
    const legal = attackerTargets(st, key);
    // 先试「打主战者」（斩杀优先），再按对方随从攻击力从大到小试
    if (legal.hero) {
      const nx = simAttack(st, key, null, opts);
      if (nx) dfs(nx, i + 1, path.concat([{ attacker: key, target: null }]));
    }
    const targets = legal.units.slice().sort((x, y) => {
      const ux = findUnit(st.foe, x), uy = findUnit(st.foe, y);
      return (uy ? uy.atk : 0) - (ux ? ux.atk : 0);
    });
    for (const tk of targets) {
      const nx = simAttack(st, key, tk, opts);
      if (nx) dfs(nx, i + 1, path.concat([{ attacker: key, target: tk }]));
    }
    dfs(st, i + 1, path);            // 保留这次攻击（不浪费）
  };
  dfs(cloneState(start), 0, []);
  best.capped = capped;
  return best;
}

// ====================== ⑤ 出牌贪心（含护符启动）======================

/** 出牌顺序搜索的一条候选：牌序 + 每张牌选中的模式下标 + 结果快照 */
interface DevSeq { plays: number[]; modes: Record<number, number>; state: AiState; rank: number; }

/** 候选排序用的便宜分 = 投影评分 + 本回合攻击潜力（不含攻击搜索） */
function rankOf(s: AiState, opts: AiOptions): number {
  return scoreProjected(s, opts) + attackPotential(s) * 0.35;
}

/**
 * ★ **打出顺序搜索**（beam search）：逐层扩展出牌序列，按「投影评分 + 攻击潜力」排序取前 K 条，
 *  每张牌同时记录它选中的「模式」下标 —— 这样 AI 真的会比较**不同出牌顺序**（先增益后召唤 / 先召唤后增益）
 *  与**不同模式选择**的最终分数，而不是只按单张牌的贪心收益。
 */
function beamDevelopment(start: AiState, opts: AiOptions): { plays: number[]; modes: Record<number, number>; activate: string | null } {
  let st0 = cloneState(start);
  let activate: string | null = null;
  // 护符「启动」：净收益为正才启动（要花能量点）
  for (const u of st0.me) {
    if (u.isFollower) continue;
    const nx = simActivate(st0, u.key, opts);
    if (nx && rankOf(nx, opts) > rankOf(st0, opts)) { st0 = nx; activate = u.key; break; }
  }
  const cap = Math.max(0, Math.round(num(opts.maxPlays, 3)));
  const BEAM = 4;
  let beam: DevSeq[] = [{ plays: [], modes: {}, state: st0, rank: rankOf(st0, opts) }];
  let best: DevSeq = beam[0];
  for (let depth = 0; depth < cap; depth++) {
    const next: DevSeq[] = [];
    for (const seq of beam) {
      if (seq.state.playsLeft <= 0) continue;
      for (const c of seq.state.hand) {
        const nx = simPlay(seq.state, c.index, opts);
        if (!nx) continue;
        const modes: Record<number, number> = Object.assign({}, seq.modes);
        if (nx.modePick >= 0) modes[c.index] = nx.modePick;
        next.push({ plays: seq.plays.concat([c.index]), modes, state: nx, rank: rankOf(nx, opts) });
      }
    }
    if (next.length === 0) break;
    next.sort((x, y) => y.rank - x.rank);
    beam = next.slice(0, BEAM);
    if (beam[0].rank > best.rank) best = beam[0];
  }
  return { plays: best.plays, modes: best.modes, activate };
}

// ====================== ⑥ 回合规划 ======================

/** 把「出牌 + 启动」按顺序应用到快照上（任何一步失败就返回 null） */
function applyDevelopment(start: AiState, plays: number[], activate: string | null, opts: AiOptions,
                         modes: Record<number, number> = {}): AiState | null {
  let st = cloneState(start);
  for (const idx of plays) {
    const nx = simPlay(st, idx, opts, modes[idx] === undefined ? -1 : modes[idx]);
    if (!nx) return null;
    st = nx;
  }
  if (activate) {
    const nx = simActivate(st, activate, opts);
    if (!nx) return null;
    st = nx;
  }
  return st;
}

/**
 * 算一个回合的计划。搜索规模是有界的（prefix × 进化候选 × 攻击 DFS），
 * 保证每步都能在几十毫秒内出结果（AI 每次行动都会重新规划一次，见 EnemyBattleAI）。
 */
export function planTurn(start: AiState, opts: AiOptions): AiPlan {
  const t0 = Date.now();
  const totalBudget = Math.max(30, num(opts.timeBudgetMs, 90));
  let best: AiPlan | null = null;

  const greedy = beamDevelopment(start, opts);
  // 进化候选：只考虑「最值得进化的 2 只」（攻击力最高，未进化）
  const evoCands: Array<{ key: string; superEvolve: boolean }> = [];
  const evolvable = start.me.filter((u) => u.isFollower && !u.evolved).sort((a, b) => b.atk - a.atk);
  for (const u of evolvable.slice(0, 2)) {
    if (opts.canSuperEvolve) evoCands.push({ key: u.key, superEvolve: true });
    if (opts.canEvolve) evoCands.push({ key: u.key, superEvolve: false });
  }
  // 出牌档位：0 / 只打第一张 / 全部（覆盖「省着打」与「全铺」）+ **模式选项分支**
  // ★「模式」最优选：对候选序列里第一张带模式的牌逐选项各生成一个分支，
  //   每个分支都跑完整的「攻击搜索 + 投影评分」，由**整体计划分**决定选哪个选项
  //   （这样「疾驰能打脸」与「守护+清场」是拿真实的攻击线去比的，而不是拍脑袋）。
  interface PlayVariant { plays: number[]; modes: Record<number, number>; }
  const variants: PlayVariant[] = [
    // 🔴 「什么都不打，只用现有场面」也必须是一个候选 —— 少了它，AI 即使在现有场面就能斩杀，
    //    也一定会先把手里能打的牌打完（实测：主战者 10 血、对方 10 攻在场，却先出牌再斩杀）。
    { plays: [], modes: {} },
    { plays: greedy.plays.slice(), modes: Object.assign({}, greedy.modes) },
  ];
  if (greedy.plays.length > 0) variants.push({ plays: greedy.plays.slice(0, 1), modes: Object.assign({}, greedy.modes) });
  const modeIdx = greedy.plays.find((i) => {
    const c = start.hand.find((x) => x.index === i);
    return !!c && modeOptionCount(c.cardId) > 1;
  });
  if (modeIdx !== undefined) {
    const c = start.hand.find((x) => x.index === modeIdx);
    const count = c ? modeOptionCount(c.cardId) : 0;
    for (let k = 0; k < Math.min(count, 4); k++) {
      const modes: Record<number, number> = Object.assign({}, greedy.modes);
      modes[modeIdx] = k;
      variants.push({ plays: greedy.plays.slice(), modes });
    }
  }

  const modePicksOf = (plays: number[], modes: Record<number, number>): Record<number, number> => {
    const out: Record<number, number> = {};
    for (const i of plays) if (modes[i] !== undefined) out[i] = modes[i];
    return out;
  };
  const consider = (v: PlayVariant, activate: string | null, evo: { key: string; superEvolve: boolean } | null, tag: string): void => {
    const mid = applyDevelopment(start, v.plays, activate, opts, v.modes);
    if (!mid) return;
    let st = mid;
    if (evo) {
      const nx = simEvolve(mid, evo.key, evo.superEvolve, opts);
      if (!nx) return;
      st = nx;
    }
    const left = Math.max(10, totalBudget - (Date.now() - t0));
    const res = searchCombat(st, { ...opts, timeBudgetMs: Math.min(45, left) });
    const score = res.score - (evo ? AI_WEIGHTS.evoCost : 0);
    if (!best || score > best.score) {
      best = {
        plays: v.plays.slice(),
        modePicks: modePicksOf(v.plays, v.modes),
        activate,
        evolve: evo,
        attacks: res.attacks,
        score,
        reason: `${tag}${evo ? (evo.superEvolve ? '+超进化' : '+进化') : ''} | 攻击 ${res.attacks.length} 次`
          + `（局面分 ${score.toFixed(0)}${res.capped ? '，搜索截断' : ''}）`,
      };
    }
  };

  // ★★ 斩杀优先（最高优先级）：先用「现有场面、不出牌、不进化」跑一次攻击搜索。
  //    只要这一条就能把对方主战者打死 → **立刻返回**，不再考虑任何出牌 / 启动 / 进化
  //    （省资源 + 不拖时间；执行层看到 lethalNow 会直接跳到攻击阶段）。
  {
    const res = searchCombat(cloneState(start), { ...opts, timeBudgetMs: Math.min(45, totalBudget) });
    if (res.attacks.length > 0 && res.state.foeHero <= 0 && res.state.myHero > 0) {
      return {
        plays: [], modePicks: {}, activate: null, evolve: null,
        attacks: res.attacks, score: res.score, lethalNow: true,
        reason: '斩杀优先：现有场面即可击杀对方主战者 → 直接攻击（不出牌 / 不进化）',
      };
    }
  }

  for (const v of variants) {
    const act = v.plays.length > 0 ? greedy.activate : null;   // 护符启动跟第一次出牌档位绑定（避免重复算）
    consider(v, act, null, `出牌×${v.plays.length}`);
    for (const evo of evoCands) consider(v, act, evo, `出牌×${v.plays.length}`);
    if (Date.now() - t0 > totalBudget) break;
  }
  if (!best) {
    return { plays: [], modePicks: {}, activate: null, evolve: null, attacks: [], score: scoreState(start), reason: '无可行动作' };
  }
  return best;
}
