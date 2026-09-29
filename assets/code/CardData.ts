/**
 * 卡牌数据映射表（纯 TS 数据定义，无引擎依赖）
 * ============================================================================
 * 用途：为卡牌拼接脚本 CardComposer 提供静态卡牌数据查询。
 * 适配：Cocos Creator 3.8.x（TypeScript，ES Module 导出）。
 * 依赖：无任何第三方/引擎依赖，不 import 'cc'，可在编辑器与运行时直接使用。
 *
 * 用法（在 CardComposer.ts 等脚本中）：
 *     import { CardMap, getCardInfo, resolveCardFrame } from './CardData';
 *     const info = getCardInfo('1.png');   // 以卡图资源名作为唯一 id 查询
 *     const frameName = resolveCardFrame(info);   // 该卡应使用的卡框资源名
 *
 * 设计要点：
 *   - quality / cardType 用「字面量联合类型」做编译期约束，拼错值会直接报 TS 错误；
 *   - hp / attack 用 `number | null`，随从(Follower)为数字（可为 0 / 负数），
 *     非随从(Amulet/Spell)必须为 null（不允许填 0 或其它数字）；
 *   - 🔑 **卡框不单独存字段**：由 `quality + cardType` 唯一决定（见 deriveCardFrame）。
 *     想换某张卡的卡框，就改它的 quality —— 只有这一处可写，不存在第二份可以写歪的数据；
 *   - **手牌区与战场区共用本表的同一套推导，不许各自另立逻辑**：
 *       手牌框 = resolveCardFrame(info)        → 'HandLegendaryFollower.png'
 *       战场框 = resolveBattleFieldFrame(info) → 'BF_LegendaryFollower.png'
 *     战场框只是把手牌框再「手牌版转原版 → 加 BF_ 前缀」，所以改一处 quality，两边**同时**换框；
 *   - 提供运行期自检 validateCardData()，在编辑器/启动期尽早暴露数据填写错误。
 * ============================================================================
 */

// ====================== 枚举类型（字面量联合，编译期强约束） ======================

/** 卡牌品质：限定四种合法取值，杜绝拼写/类型错乱 */
export type CardQuality = 'Bronze' | 'Gold' | 'Silver' | 'Legendary';

/** 卡牌类型：限定三种合法取值 */
export type CardType = 'Amulet' | 'Follower' | 'Spell';

/**
 * 卡牌能力触发时机。
 *   · `use`        —— 使用结算时（法术的「确定使用」那一刻 / 随从进入战场之后）
 *   · `passive`    —— 入场后授予的静态效果（突进 / 疾驰 / 守护 / 威慑 / 吟唱…）
 *   · `effect`     —— 只作为「内嵌效果」被别的能力调用（如吟唱的 DestroySelf / 入场曲的摧毁目标）
 *   · `fanfare`    —— **入场曲**：从手牌使用到战场上时触发
 *   · `evolve`     —— **进化**：普通进化或超进化该随从时触发（进化动画播完之后）
 *   · `superEvolve`—— **超进化**：只有超进化该随从时触发
 *   · `battle`     —— **交战时**：攻击随从 / 被随从攻击时，在互相造成伤害前触发
 *   · `turnEnd`    —— **回合结束时**：自己这一方的操作回合结束时触发
 *                     （与纹章的 `turnEnd` 同一时点、同一「先结算逻辑、演出攒着」口径，
 *                      由 `TurnManager._beginTurnEnd` 逐张遍历该方战场触发）
 *   · `lastWords`  —— **谢幕曲**：**被破坏时**发动（消失 / 变身不发动）
 *   · `activate`   —— **启动**：护符的主动能力，由玩家在**自己的回合**里按说明卡片上的
 *                     「启动」按钮发动（见 CardAbilitySystem.activateAmulet）
 */
export type CardAbilityTrigger = 'use' | 'passive' | 'effect' | 'fanfare' | 'evolve' | 'superEvolve' | 'battle' | 'turnEnd' | 'activate' | 'lastWords' | 'statUp';

/** 全部合法触发时机（运行期可枚举版本，供卡表自检）。 */
export const CARD_ABILITY_TRIGGERS: readonly CardAbilityTrigger[] =
  ['use', 'passive', 'effect', 'fanfare', 'evolve', 'superEvolve', 'battle', 'turnEnd', 'activate', 'lastWords', 'statUp'];

/** 能力参数值：允许基础类型、嵌套能力与简单集合，便于“吟唱 → 触发另一个能力”。 */
export type CardAbilityParamValue =
  | string
  | number
  | boolean
  | null
  | CardAbilityInvocation
  | CardAbilityParamValue[]
  | { [key: string]: CardAbilityParamValue };
export type CardAbilityParams = Record<string, CardAbilityParamValue>;

/**
 * 卡牌能力名字表。
 *
 * 这里登记「名字 → 展示信息 / 触发时机 / 默认授予的词条」；真正的逻辑实现由
 * `CardAbilitySystem.ts` 中同名的 `CARD_ABILITY_HANDLERS` 提供。两边键名一一对应，
 * 新增能力时 TS 会因缺少 handler 直接编译失败，避免卡表填了一个没有实现的空名字。
 */
export const CARD_ABILITY_MAP = {
  DrawCards: {
    displayName: '抽取卡牌',
    trigger: 'use',
    description: '使用时从本方牌堆抽取 params.count 张卡。',
  },
  Rush: {
    displayName: '突进',
    trigger: 'passive',
    description: '召唤当回合可以攻击敌方随从，但不能攻击敌方主战者。',
    keywords: ['Rush'],
  },
  Charge: {
    displayName: '疾驰',
    trigger: 'passive',
    description: '召唤当回合可以攻击敌方随从和主战者。',
    keywords: ['Charge'],
  },
  Deter: {
    displayName: '威慑',
    trigger: 'passive',
    description: '此牌在战场上时，无法被对方随从进行普通攻击。',
    keywords: ['Deter'],
  },
  Guard: {
    displayName: '守护',
    trigger: 'passive',
    description: '此牌在战场上时，对方必须先攻击拥有「守护」的随从，无法攻击其它随从与主战者。',
    keywords: ['Guard'],
  },
  Ambush: {
    displayName: '潜行',
    trigger: 'passive',
    description: '此牌在战场上时，**不会被对方的能力选中，也不会被对方随从攻击**。\n'
      + '自己「进行攻击」或「通过能力造成伤害」时失去潜行。\n'
      + '🔴「破坏」不算造成伤害 —— 用破坏类能力（入场曲破坏随从、纹章随机破坏等）不会让它现形。',
    keywords: ['Ambush'],
  },
  /**
   * ★ **灵气**（关键字）：不会被对手的能力选中。
   * 只过滤“选目标”类能力；随机 / 全场效果仍可命中，与关键字文案一致。
   */
  Aura: {
    displayName: '灵气',
    trigger: 'passive',
    description: '不会被对手的能力选中。随机 / 全场等不经过目标选择的效果不受影响。',
    keywords: ['Aura'],
  },
  Ougi: {
    displayName: '奥义',
    trigger: 'fanfare',
    description: '**奥义槽为 10 或以上时发动** params.effect / params.effects（内嵌写法与入场曲完全一致）。\n'
      + '奥义槽 = 「现在的回合数」（= 大回合数） + 「这张卡在**手牌中时**我方随从的进化次数」。\n'
      + '🔴 条件不满足时只打日志、什么都不结算（卡照常入场）。\n'
      + '🔴 结算时点 = 入场时（`trigger: fanfare`）；想在其它时点判定，用内嵌调用，'
      + '例：`{ name: \'Evolve\', params: { effects: [{ name: \'Ougi\' }] } }`。',
  },
  OugiRelease: {
    displayName: '解放奥义',
    trigger: 'fanfare',
    description: '**奥义槽为 15 或以上时发动** params.effect / params.effects（口径与「奥义」完全相同，门槛更高）。\n'
      + '奥义槽 = 「现在的回合数」（= 大回合数） + 「这张卡在**手牌中时**我方随从的进化次数」。\n'
      + '🔴 奥义槽 ≥ 15 时，「奥义」（≥10）与「解放奥义」（≥15）**两条都会各自发动** —— '
      + '卡表按需要写各自的效果即可（想互斥就只写一条）。',
  },
  Chant: {
    displayName: '吟唱',
    trigger: 'passive',
    description: '己方回合开始时吟唱值 -1（不显示 0）；减少到 1 时**破坏自身**（内建，卡表无需再配 DestroySelf），'
      + 'params.effect 若有则作为额外效果在离场前结算。',
  },
  DestroySelf: {
    displayName: '破坏自身',
    trigger: 'effect',
    description: '把来源卡牌从战场移除。',
  },
  FriendlyFollowerEnterBuff: {
    displayName: '友方随从入场增益',
    trigger: 'passive',
    description: '己方随从进入战场时获得 params.keywords / attack / hp；params.selfAttack 会让本能力来源卡获得攻击力，params.includeSelf=true 时来源卡自己的入场也触发。',
  },
  // ====================== 【关键词】进化 / 超进化 / 获得纹章 / 入场曲 ======================
  Fanfare: {
    displayName: '入场曲',
    trigger: 'fanfare',
    description: '**入场曲**（类似「战吼」）：从手牌使用到战场上时触发 params.effect，并执行 params.action。\n'
      + '· params.select —— 需要玩家**先选一个随从目标**（当前支持 \'enemyFollower\' = 对方战场随从 / '
      + '\'friendlyFollower\' = 己方战场随从）。\n'
      + '  场上存在合法目标时：卡牌先停在「摄像头左上角」等待选择 —— 选中有目标的随从才算**使用成功**'
      + '（随后卡牌进入战场并结算 params.action）；点其它地方则该卡**回到手牌**、费用返还、不算使用。\n'
      + '  场上没有合法目标时：**直接正常进入战场**（目标选择与 params.action 一并跳过）。\n'
      + '· params.action —— 选中目标后对该随从做的事，当前支持 \'destroy\' = 破坏。',
  },
  Evolve: {
    displayName: '进化',
    trigger: 'evolve',
    description: '**进化**：普通进化**或**超进化此随从时触发 params.effect，在**进化动画播完之后**结算。\n'
      + '若带 params.select，则拖拽进化点松手后先让对方可被选择的随从亮起选择光圈：\n'
      + '选中即先触发进化、动画结束再结算本能力；点其它地方则退出选择模式且**不消耗进化点**。',
  },
  SuperEvolve: {
    displayName: '超进化',
    trigger: 'superEvolve',
    description: '**超进化**：只有**超进化**此随从时触发（普通进化不触发）。\n'
      + 'params.effects 是要依次触发的内嵌能力数组（如 [{name:\'Fanfare\'}, {name:\'GainCrest\'}]）。',
  },
  GainCrest: {
    displayName: '获得纹章',
    trigger: 'effect',
    description: '**获得纹章**：为该方主战者获得一枚纹章（params.crest 指定纹章资源名，留空 = 卡牌自己的 id）。\n'
      + '纹章按**获得顺序**依次落在该方纹章区（CrestArea）的 5 个圆圈里：第 1 枚进 Crest_0、第 2 枚进 Crest_1…',
  },
  // ====================== 【关键词】分配伤害（按入场顺序分配 X 点）======================
  DistributeDamage: {
    displayName: '分配伤害',
    trigger: 'effect',
    description: '**分配 X 伤害**（关键字）：按战场卡牌**从早到晚的入场顺序**依次分配 X 点伤害\n'
      + '—— 先打**最早入场**的那张，把它打到血量归零（破坏）后，**剩余的伤害溢出给下一张**，\n'
      + '直到伤害分配完或没有可用目标。\n'
      + '· 方位口径（策划定义）：**我方**早入场的卡牌在**左**、**敌方**早入场的卡牌在**右**\n'
      + '  （战场节点集合恒为「左 → 右」；我方新卡追加到尾部、敌方新卡插到头部 ⇒ 我方正序、敌方逆序）。\n'
      + '· params.amount     —— 固定伤害点数 X（正整数）。\n'
      + '· params.amountFrom —— 写 \'attack\' 时改用**来源随从当前的攻击力**：进化时能力读到的\n'
      + '  就是**进化后**的攻击力（进化先加数值、动画播完才结算进化时能力，见 FollowerEvolve）。\n'
      + '· params.side       —— \'opponent\'（默认，对方战场）/ \'self\'（己方战场）/ \'both\'（双方，先己方后对方）。\n'
      + '· 超进化守护（己方回合受到的伤害转为 0）期间该随从**不受伤**，伤害直接越过它打下一张。\n'
      + '· 护符等**没有血量**的卡牌不参与分配（跳过它、伤害给下一张）。',
  },
  /**
   * **回合结束时**（触发时机 = 自己这一方操作回合结束）——顶层触发，内嵌效果写法与入场曲一致。
   * 用途：卡 6「异相浅眠·米什缇」的「我方回合结束时，随机对敌方战场上的一个随从造成 3 点伤害，并获得【潜行】」。
   */
  TurnEnd: {
    displayName: '回合结束时',
    trigger: 'turnEnd',
    description: '**自己这一方的操作回合结束时**，依次结算 params.effect / params.effects'
      + '（内嵌写法与入场曲完全一致：如 `{ name:\'RandomDamage\', params:{ amount:3 } }`、`{ name:\'Ambush\' }`）。\n'
      + '🔴 与纹章的 `turnEnd` **同一时点、同一口径**：逻辑当场结算，演出被「结束回合」的攒 cue 窗口收在后面。',
  },
  /** **随机伤害**（内嵌效果）：与 `TurnEndRandomDamage` 同一套实现，供别的能力内嵌调用。 */
  RandomDamage: {
    displayName: '随机伤害',
    trigger: 'effect',
    description: '在 params.select（默认对方战场）里**随机**选 1 个随从，对其造成伤害。\n'
      + '· params.amount     —— 固定点数；\n'
      + '· params.amountFrom —— `\'selectedHp\'` = **本次选择选中的那个随从的当前血量**；'
      + '`\'attack\'` = 来源随从当前攻击力。\n'
      + '· 血量归零 → 走正常的破坏流程（记墓场 / 播破坏动画 / 之后重排）。',
  },
  /** **使我方场上所有随从 +X/+Y**（内嵌效果）。 */
  BuffFriendlyFollowers: {
    displayName: '我方全体增益',
    trigger: 'effect',
    description: '使我方战场上的**全部随从**（含来源自己）获得 +params.attack / +params.hp，卡面数字随即刷新。\n'
      + '· params.keywords —— 可选：同时授予这些关键词（如 `[\'Guard\']` / `[\'Rush\']`）。\n'
      + '· params.excludeSelf —— `true` = 排除来源卡自己（文案写「**其他**所有随从」时必须开）。\n'
      + '🔴 与 `Summon` 搭配时顺序有意义：先召唤、后增益 ⇒ 新召唤出来的随从也会吃到增益。',
  },
  /** **使选中的那个随从 +X/+Y**（内嵌效果，配合 `SelectTarget` 使用）。 */
  BuffSelected: {
    displayName: '选中目标增益',
    trigger: 'effect',
    description: '使**本次选择选中的那个随从**（ctx.target）获得 +params.attack / +params.hp。\n'
      + '· params.keywords —— 可选：同时授予这些关键词（如 `[\'Bane\']`）。\n'
      + '🔴 ctx.target 也可以是**本次入场曲召唤出来的那张卡**（见 `Summon` 的 params.grantTo）'
      + '—— 卡 32「烈日魔犬」的爆能强化就是靠这条给复制体上【毁灭】。',
  },
  /**
   * **选择目标 → 依次结算内嵌效果**（触发时机 = 使用时）。
   *
   * 给**法术**这类「需要先选一个随从才能结算」的卡用：交互层没有为法术做目标选择流程，
   * 所以由能力自己发起选择（我方 = 进选择模式等玩家点；敌方 AI = 按统一策略自动选），
   * 选中的随从会作为 `ctx.target` 传给 params.effect / params.effects 里的内嵌能力。
   */
  SelectTarget: {
    displayName: '选择目标',
    trigger: 'use',
    description: '按 params.select（`friendlyFollower` / `enemyFollower`）与 params.filter（如 `guard`）'
      + '取出候选，选 1 个随从后**依次结算** params.effect / params.effects（内嵌写法与入场曲一致）。\n'
      + '· 我方：进入选择模式等玩家点选（点其它地方 = 取消，什么都不结算）；\n'
      + '· 敌方 AI：按 `TargetSelectSystem.autoPick` 的统一策略自动选；\n'
      + '· 没有合法候选 → 只打日志、不结算（卡照常使用）。',
  },
  /**
   * **启动**（护符的主动能力）：在**自己的回合**里，由玩家按下说明卡片上的「启动」按钮发动。
   *
   * 🔴 1 回合仅限 1 次；`params.cost` 指定启动所需能量点（不足则按钮变暗、不可启动）。
   * 🔴 「只有在自己的回合里才能启动自己的护符」—— 回合 / 阵营判定见 `CardAbilitySystem.canActivateAmulet`。
   * 🔴 能启动时，该护符在战场上会**常亮选择光圈**（不抬卡，见 CardKeywordSystem）。
   */
  Activate: {
    displayName: '启动',
    trigger: 'activate',
    description: '**自己的回合**里，按说明卡片上的「启动」按钮发动（1 回合仅限 1 次）。\n'
      + '· params.cost     —— 启动所需能量点（不足 / 本回合已启动 / 不是自己回合 → 不可启动）；\n'
      + '· params.select   —— 发动时先选 1 个随从目标（写法与入场曲一致，可配 params.filter）；\n'
      + '· params.optional —— `true` = **没有合法候选也照常发动**（跳过选择，仍结算内嵌效果）；\n'
      + '· params.effect / params.effects —— 依次结算的内嵌效果。',
    keywords: ['启动'],
  },
  /**
   * ★ **模式**（关键字，说明见 `TIP_KEYWORD_DESC['模式']`）：从若干能力里选 `count` 个发动。
   *
   * params：
   *   · `select: 'mode'` —— 🔴 **必须有**：`cardTargetRequest` 靠它把这张卡认成「要选目标的入场曲」，
   *      于是打出时走与卡牌 4 同一条流程（**卡牌先飞到左上角**），只是选择界面换成
   *      `ModeSelectPanel`（**屏幕中央列选项**，点其它地方 = 与卡牌 4 不选择一样回手）；
   *   · `count`   —— 选几个（默认 1）；
   *   · `options` —— `[{ text: '选项文字', effect / effects: 该选项的能力 }]`（顺序 = 界面顺序）。
   *
   * 🔴 与关键字文案一致：**条件没满足的选项也能被选中**，只是它的能力不会产生效果。
   * 🔴 选项文字的字号 / 框内边距 / 框宽在常驻节点 `Canvas/ModeSelectPanel` 的 Inspector 上
   *    （**选项框高度由文字撑起**）。
   */
  Mode: {
    displayName: '模式',
    trigger: 'effect',
    description: '从 params.options 里选 params.count（默认 1）个发动。\n'
      + '· 🔴 `select:\'mode\'` 必须有：让打出流程把这张卡当「要选目标」处理（**先飞到左上角**，与卡牌 4 同流程），'
      + '选择界面换成屏幕中央的选项列表（`ModeSelectPanel`）；\n'
      + '· `options: [{ text, effect / effects }]` —— 顺序 = 界面顺序；\n'
      + '· 点选项之外的地方 = 与卡牌 4「不选择」一样（卡回手、不消耗费用）；\n'
      + '· 条件没满足的选项也能被选中，只是它的能力不会产生效果。',
    keywords: ['模式'],
  },
  /** **回复主战者**：为自己这一方的主战者回复 params.amount 点生命值（上限 = 主战者最大血量）。 */
  HealHero: {
    displayName: '回复主战者',
    trigger: 'effect',
    description: '为自己这一方的主战者回复 params.amount 点生命值（超过最大血量的部分无效）。',
  },
  /**
   * ★ **对敌方主战者造成伤害**（卡 26「重炮圣盾」的协作奖励）。
   * 目标 = **对手**那一方的主战者（与 `ctx.side` 相反），走 `HeroArea.takeDamage`
   * （与随从攻击主战者是同一条伤害入口：飘字 / 延迟显示窗口都照常）。
   */
  DamageHero: {
    displayName: '对敌方主战者造成伤害',
    trigger: 'effect',
    description: '对**对手**的主战者造成 params.amount 点伤害（走 `HeroArea.takeDamage`，数值显示遵守延迟窗口）。',
  },
  /**
   * ★ **消失**（关键字，需求）：把卡牌从战场 / 手牌 / 牌组**除去**。
   *   · 🔴 **不进墓场**（与「破坏」最大的区别）；
   *   · 🔴 **不触发谢幕曲**等「被破坏时」发动的能力；
   *   · 演出 = 破坏特效的**反过来**（光向内收，`CardDestroyFx` 的 `reverse` 选项）。
   * 写法：与 `SelectTarget` 一样先用 `params.select`（+ `params.filter`）选目标，本能力只负责「让它消失」。
   */
  Vanish: {
    displayName: '消失',
    trigger: 'effect',
    description: '把 `ctx.target` 指定的卡**除去**：**不进墓场**、**不触发谢幕曲**，'
      + '演出是破坏特效的反方向（光向内收）。',
    keywords: ['消失'],
  },
  /**
   * ★ **谢幕曲**（关键字，说明见 `TIP_KEYWORD_DESC['谢幕曲']`）：**卡牌被破坏时**发动 `params.effect` / `params.effects`。
   * 🔴 **消失 / 变身时不会发动** —— 只有「破坏」路径会调用它（`runCardLastWords`）。
   */
  /**
   * ★ **属性提升时**（卡 11「温情攻势·安朵丝」）：本随从**在战场上获得攻击力 / 生命值增加**时发动。
   * 🔴 「自己的每回合中可触发 1 次」由 `runCardStatUpAbilities` 把关。
   * 🔴 **进化 / 超进化加数值也算**（都走 `BattleRuleSystem.addStats`，用户明确要求）。
   */
  StatUp: {
    displayName: '属性提升时',
    trigger: 'statUp',
    description: '本随从**在战场上**获得攻击力 / 生命值增加时发动 `params.effect` / `params.effects`。\n'
      + '· **自己的每回合中可触发 1 次**（跨回合自动重置）。\n'
      + '· **进化 / 超进化加数值同样触发**。',
  },
  /**
   * ★ **法术效果容器**（trigger = `use`）：法术使用时的效果都写在这里。
   * 为什么要它：法术结算走 `runCardUseAbilities` ⇒ **只跑 map trigger === 'use' 的能力**，
   * 而 `Summon` / `BuffFriendlyFollowers` 这类是 `'effect'`（只能被**嵌套**调用）。
   * 用法：`{ name:'SpellEffects', params:{ effects:[ … ] } }`（写法与入场曲一致，依次结算）。
   */
  SpellEffects: {
    displayName: '法术效果',
    trigger: 'use',
    description: '法术使用时的效果容器：依次执行 `params.effect` / `params.effects`（内嵌写法与入场曲一致）。',
  },
  /**
   * ★ **毁灭**（关键字，说明见 TIP_KEYWORD_DESC）：因**攻击 / 被攻击**对对手随从造成伤害时，
   * **直接破坏**该随从 —— 即使攻击力为 0、或伤害被减为 0 也照样发动。
   * 实现在 `BattleRuleSystem.resolveCombat`（结算完伤害后判定）。
   */
  Bane: {
    displayName: '毁灭',
    trigger: 'passive',
    description: '因攻击 / 被攻击对对手随从造成伤害时破坏该随从（0 伤害也算）。',
    // 🔴 词条标识用英文（与 Rush / Charge / Barrier 同口径）
    keywords: ['Bane'],
  },
  /** ★ **一回合可攻击 N 次**（卡 17）。 */
  MultiAttack: {
    displayName: '多次攻击',
    trigger: 'passive',
    description: 'params.times = 一回合可以攻击的次数（默认 1）。',
  },
  /** ★ **消失对手战场上的所有卡牌**（卡 17 的协作奖励）。 */
  VanishAll: {
    displayName: '消失全体',
    trigger: 'effect',
    description: 'params.side = opponent（默认）消失对手战场；own 消失己方战场；both 消失双方战场。params.excludeSelf=true 时保留来源卡。',
  },
  /**
   * ★ **屏障**（关键字）：拥有者**受到伤害时把该次伤害变为 0**，发动 1 次后失效。
   * 实现在 BattleRuleSystem.applyDamage（所有伤害都走那里）。这里只是「有这个词条」的登记。
   */
  Barrier: {
    displayName: '屏障',
    trigger: 'passive',
    description: '受到伤害时将该次伤害变为 0；发动 1 次后失效。',
    // 🔴 词条标识一律用英文（与 Rush / Charge 同口径），中文只在 displayName / 说明表里
    keywords: ['Barrier'],
  },
  /**
   * ★ **交战时**（关键字）：攻击随从 / 被随从攻击时，在互相造成伤害前发动
   * `params.effect` / `params.effects` / `params.action`。攻击主战者不触发。
   */
  Clash: {
    displayName: '交战时',
    trigger: 'battle',
    description: '与随从交战时，在互相造成伤害前发动 params.effect / params.effects / params.action；攻击主战者不触发。',
    keywords: ['Clash'],
  },
  /**
   * ★ **不会被能力破坏**（关键字）：只要当前血量 > 0，就拒绝毁灭、能力破坏、纹章破坏等
   * 直接破坏；有数字的直接伤害照常结算，伤害致死仍会正常破坏。
   */
  AbilityDestroyImmune: {
    displayName: '不会被能力破坏',
    trigger: 'passive',
    description: '本次游戏内不会被能力或毁灭直接破坏；有数字的伤害照常结算，伤害致死仍会破坏。',
    keywords: ['AbilityDestroyImmune'],
  },
  /**
   * ★ **爆能强化 N**（关键字）：打出时若**剩余能量点 ≥ N**，则**改为消耗 N 点**（不是卡牌费用），
   * 并发动 `params.effects`。复数个爆能强化 ⇒ 按最大的那个结算，并发动「该数值及以下」的全部。
   * 费用侧由 CardPlay 处理（见 enhanceValuesOf / maxEnhanceOf），这里负责发动效果。
   */
  Enhance: {
    displayName: '爆能强化',
    trigger: 'use',
    description: '打出时若剩余能量点 ≥ params.value ⇒ 改为消耗该数值并发动 params.effects。',
    keywords: ['爆能强化'],
  },
  /**
   * ★ **本随从超进化**（卡 27「御导圣盾」的爆能强化_8）：**不消耗进化点**，
   * 直接让**本随从自己**进入超进化状态。
   *
   * 结算内容与「拖超进化点进化」完全同源（见 `FollowerEvolve` 的编制）：
   *   · 数值按 `EvoDragController` 的超进化编制加（默认 **+3/+3**）；
   *   · 打上**超进化**标记（获得【超进化守护】：己方回合受到的伤害转为 0），并视为「已进化」；
   *   · 授予进化词条（默认【突进】）；
   *   · 随后依次结算本卡自己的 `evolve` / `superEvolve` 能力。
   *
   * 🔴 与真·超进化的区别：**不播进化动画**（本能力在「使用结算」时点同步结算），
   *    所以数值立刻可见、也没有「进化时」的目标选择流程。需要动画的场合仍应走拖进化点。
   */
  SelfSuperEvolve: {
    displayName: '本随从超进化',
    trigger: 'effect',
    description: '让**本随从**直接变成**超进化**状态（不消耗进化点、不播进化动画）：\n'
      + '按超进化编制加数值（默认 +3/+3）、打超进化标记（获得超进化守护）、授予进化词条（默认突进），\n'
      + '随后依次结算本卡自己的 `evolve` / `superEvolve` 能力。\n'
      + '🔴 已经进化过的随从**不会**重复结算（与 `canEvolve` 同口径）。',
  },
  /** ★ **回复能量点**（爆能强化的常见配套）。 */
  RestorePP: {
    displayName: '回复能量点',
    trigger: 'effect',
    description: '回复 params.amount 点能量点（走 refundPP，与跳费同一条路）。',
  },
  /**
   * ★ **协作数 +N**（卡 1「冷静备战」）：直接把**协作值**加 N（本次对战中进入战场的随从张数）。
   * 与「随从进场自动 +1」是同一份计数（`BattleRuleSystem._cooperation`），这里是**手动**加成。
   */
  CooperationUp: {
    displayName: '协作数增加',
    trigger: 'effect',
    description: 'params.amount（默认 1）点协作值加成到自己这一方。',
    keywords: ['协作'],
  },
  /**
   * ★ **协作 N**（关键字，说明见 TIP_KEYWORD_DESC）：`params.threshold` = 需要的协作值；
   * 协作值 = **本次对战中进入战场的自己的随从张数**（整场累计）。
   * · 满足 ⇒ 执行 `params.effects`；
   * · 不满足 ⇒ 执行 `params.otherwise`（「【协作_N】改为…」的「否则」分支，可省略）。
   */
  Cooperation: {
    displayName: '协作',
    trigger: 'effect',
    description: '协作值（本次对战中进入战场的自己的随从张数）≥ params.threshold 时执行 params.effects，'
      + '否则执行 params.otherwise（可省略）。',
    keywords: ['协作'],
  },
  /** ★ **对选中目标造成伤害**：对 `ctx.target` 造成 `params.amount` 点（可选 `params.fx` 演出）。 */
  DamageSelected: {
    displayName: '对选中目标造成伤害',
    trigger: 'effect',
    description: '对 `ctx.target`（交互层选中的目标）造成 `params.amount` 点伤害；`params.fx` 可选演出。',
  },
  /**
   * ★ **破坏攻击力最高的敌方随从**（卡 28「骇人的轰炸」）：
   * 从**对手战场**的合法随从中挑**当前攻击力最高**的一只直接**破坏**
   * （攻击力相同取**最左**那一只，口径 = `TargetSelectSystem.autoPick`）。
   *
   * 🔴 不经过玩家选择（自动挑），只挑**随从**；被「潜行 / 灵气」保护的随从按既有规则**排除**。
   * 🔴 破坏走通用入口 `destroyFieldCard`（谢幕曲照常发动、破坏动画 + 之后连续重排）。
   */
  DestroyHighestAttack: {
    displayName: '破坏攻击力最高的敌方随从',
    trigger: 'effect',
    description: '自动挑出**对手战场上攻击力最高**的随从（并列取最左）并**破坏**它；'
      + '候选口径 = `TargetSelectSystem.candidatesFor(owner,\'enemyFollower\')`（潜行 / 灵气照常排除）。',
  },
  /** ★ **加入手牌**：把 `params.id` 指定的卡加入自己这一方的手牌（手牌满 → 按规则破坏并播动画）。
   *  `params.keywords` 可选：给加入手牌的卡授予运行时词条，打出后会继续生效（如卡 23 的【突进】）。
   *  `params.waitForSourceGone` 默认 true：谢幕曲等来源离场后的入手牌动画；入场曲可显式设 false。 */
  AddToHand: {
    displayName: '加入手牌',
    trigger: 'effect',
    description: '把 `params.id` 指定的卡加入自己这一方的手牌；手牌已满则按规则破坏并播放破坏动画。'
      + 'params.keywords 可选：给加入手牌的卡授予运行时词条，打出后仍生效。'
      + 'params.waitForSourceGone 默认 true；来源不会离场的入场曲应设 false。',
  },
  LastWords: {
    displayName: '谢幕曲',
    trigger: 'lastWords',
    description: '**卡牌被破坏时**发动 `params.effect` / `params.effects`（内嵌写法与入场曲一致）。\n'
      + '🔴 **消失 / 变身时不会发动**。',
    keywords: ['谢幕曲'],
  },
  /**
   * ★ **召唤**（关键字，说明见 `TIP_KEYWORD_DESC['召唤']`）：
   * 把卡从**牌组**（或生成）直接放上战场 —— **不触发入场曲、不做屏幕中央展示**，
   * 但有**落地光球**特效；从牌组召唤会**真的把那张卡从牌组移除**。
   *
   * params：
   *   · `from`     —— `'deck'`（默认，从牌组随机取）/ `'generate'`（凭 `id` 凭空生成）；
   *   · `count`    —— 召唤几张（默认 1）；
   *   · `cardType` —— 期望类型（默认 `'Follower'`）；
   *   · `maxCost` / `minCost` —— 费用范围（牌组筛选用）；
   *   · `id`       —— `from:'generate'` 时生成哪张卡；
   *   · `grantTo`  —— 写 `'source'` 时，把**第一只成功入场的召唤物**设为本次能力的
   *                   「选中目标」（`ctx.target`），于是同一条入场曲里随后的 `BuffSelected`
   *                   就作用在召唤出来的那只身上（卡 32 的爆能强化_6 给复制体上【毁灭】）。
   *
   * 🔴 牌组里没有符合条件的卡 ⇒ **召唤为空**（仍算「使用了召唤」，只是没召唤出东西）。
   * 🔴 **能否发动与战场剩余宽度无关**；只有「召唤出来的卡能不能进场」才看战场是否已满 ——
   *    满了就摆在战场最外侧、**0.5s 后播破坏动画但不算破坏、不进墓场**。
   */
  Summon: {
    displayName: '召唤',
    trigger: 'effect',
    description: '把卡从**牌组**（或凭空生成）直接放上战场：**不触发入场曲**、不做屏幕中央展示，'
      + '但有落地光球；从牌组召唤会真的把那张卡从牌组移除。\n'
      + '· params.from = `deck` / `generate`；params.count = 张数；params.cardType / maxCost / minCost = 牌组筛选；\n'
      + '· 牌组里没有符合条件的卡 ⇒ **召唤为空**（照常算「使用过召唤」）；\n'
      + '· **能否发动与战场剩余宽度无关**，只有能不能进场看战场是否已满；满了就摆在战场最外侧，'
      + '0.5s 后播破坏动画（**不算破坏、不进墓场**）。',
    keywords: ['召唤'],
  },
} as const;

/** 全部合法能力名（由名字表唯一决定）。 */
export type CardAbilityName = keyof typeof CARD_ABILITY_MAP;

/** 单条能力配置：无参数能力可直接写名字；有参数能力写成对象。 */
export interface CardAbilityInvocation {
  name: CardAbilityName;
  params?: CardAbilityParams;
}

export type CardAbilityGrant = CardAbilityName | CardAbilityInvocation;

/**
 * 全部合法品质（运行期可枚举版本，须与 CardQuality 联合类型保持同步）。
 * 用途：卡表自检；以及识别「手牌版随从框 Hand<品质>Follower.png」→「原版 <品质>Follower.png」。
 */
export const CARD_QUALITIES: readonly CardQuality[] = ['Bronze', 'Silver', 'Gold', 'Legendary'];

// ====================== 卡牌信息接口 ======================

/**
 * 单张卡牌的数据描述。
 *
 * 字段约束说明：
 * - cardImage / cardName：字符串（资源名 / 展示名）；
 * - quality / cardType：受上面联合类型约束，只能取规定值；**卡框即由这两项推导，不另设字段**；
 * - cost：费用，非负数字；
 * - hp / attack：
 *      · 仅随从(Follower)拥有，类型为 number，取值允许 0 或负数；
 *      · 非随从(Amulet / Spell)没有这两项，固定为 null（不能是 0，也不能是任何数字）。
 */
export interface CardInfo {
  /** 卡图资源名字（同时作为本映射表的唯一 id，即 CardMap 的 key） */
  cardImage: string;

  /** 卡牌品质（受 CardQuality 约束）—— 与 cardType 一起决定使用哪个卡框 */
  quality: CardQuality;

  /** 卡牌类型（受 CardType 约束） */
  cardType: CardType;

  /** 卡牌名称（展示用） */
  cardName: string;

  /** 费用（非负数字） */
  cost: number;

  /**
   * 血量：
   *  - 随从(Follower) → number（可为 0 或负数）；
   *  - 非随从 → 必须为 null。
   */
  hp: number | null;

  /**
   * 攻击力：
   *  - 随从(Follower) → number（可为 0 或负数）；
  *  - 非随从 → 必须为 null。
   */
  attack: number | null;

  /** 卡牌词条关键字（可选）。当前支持 'Rush'（突进）/ 'Charge'（疾驰）。 */
  keywords?: string[];

  /**
   * 卡牌能力集合（可选）。
   * - 无参数：'Rush'
   * - 有参数：{ name: 'DrawCards', params: { count: 1 } }
   *
   * 填在 abilities 里的名字必须来自 CARD_ABILITY_MAP；对应逻辑由 CardAbilitySystem
   * 执行，卡表本身不保存函数，避免纯数据层依赖 Cocos 引擎对象。
   */
  abilities?: CardAbilityGrant[];
}

// ====================== 卡牌字典映射表 ======================

/**
 * 卡牌字典映射表。
 * key   = 卡牌唯一 id（即卡图资源名字 cardImage，要求全局唯一）；
 * value = 对应的 CardInfo。
 *
 * 下方为【示例数据】，请按需替换为真实卡牌内容。填写规则：
 *  - Follower（随从）：hp / attack 必须填数字（允许 0 或负数）；
 *  - Amulet / Spell：hp / attack 必须填 null。
 *
 * 注：**卡框不在本表里填写** —— 一律由 quality + cardType 推导（见 deriveCardFrame）：
 *     手牌区 = `Hand<品质>Follower.png` / `<品质><类型>.png`，战场区再换成 `BF_` 族。
 *     想换某张卡的卡框，改它的 quality 即可（手牌与战场会同时换）。
 */
export const CardMap: Record<string, CardInfo> = {
  // 「冷静备战」（铜框法术，费用 1，无 hp/attack → 卡框 BronzeSpell.png）
  '1.png': {
    cardImage: '1.png',
    quality: 'Bronze',
    cardType: 'Spell',
    cardName: '冷静备战',
    cost: 1,
    hp: null,
    attack: null,
    abilities: [
      // 🔴 法术结算只跑 trigger==='use' 的能力 ⇒ 两条效果包在 SpellEffects 里（见卡 14 的教训）
      {
        name: 'SpellEffects',
        params: {
          effects: [
            // 对对手场上随机一个随从造成 2 点伤害 —— 特效参照威玛西娜的**导弹**
            { name: 'RandomDamage', params: { amount: 2, fx: 'missileStrike' } },
            // 抽取 1 张**随从**
            { name: 'DrawCards', params: { count: 1, cardType: 'Follower' } },
            // ★ 说明表更新：**协作数 +1**（本次对战中进入战场的随从张数 +1）
            { name: 'CooperationUp', params: { amount: 1 } },
          ],
        },
      },
    ],
  },
  // 「全力突围·可露凯」（传说随从，费用 5）
  // · 进化时（普通进化 / 超进化都触发）：按入场顺序对**对手战场**上的随从分配伤害，
  //   伤害总量 = **该随从进化后的攻击力**（关键字「分配 X 伤害」，handler = DistributeDamage）
  // → 手牌框 HandLegendaryFollower.png ／ 战场框 BF_LegendaryFollower.png
  // 手牌版随从框把攻击徽记放在左侧竖栏**上格**、血量红盾放在**下格**（见 CardLayout.ts）
  '2.png': {
    cardImage: '2.png',
    quality: 'Legendary',
    cardType: 'Follower',
    cardName: '全力突围·可露凯',
    cost: 5,
    hp: 4,
    attack: 6,
    abilities: [
      {
        // 突进：召唤当回合可以攻击敌方随从，但不能攻击敌方主战者（规则见 BattleRuleSystem.canAttackHero）
        name: 'Rush',
      },
      {
        // ★ 入场曲（新）：**召唤随机 1 个自己牌组中费用为 3 或以下的随从**。
        //   · 不触发被召唤卡的入场曲（召唤 ≠ 从手牌使用）；
        //   · 从牌组真移除；牌组里没有符合条件的 → 召唤为空（照常算结算过）；
        //   · 发动与战场剩余宽度无关；战场已满则该卡摆在战场外侧 0.5s 后收掉（不算破坏、不进墓场）；
        //   · 动画顺序：本随从**完全进入战场**之后才播召唤（入场曲在 CardPlay.land() 收编之后才跑）。
        name: 'Fanfare',
        params: {
          effect: {
            name: 'Summon',
            params: { from: 'deck', count: 1, cardType: 'Follower', maxCost: 3 },
          },
        },
      },
      {
        // 进化时（普通进化 / 超进化都触发）：按入场顺序把伤害分配给对手战场上的随从，
        // 伤害总量 = **该随从进化后的攻击力**（amountFrom:'attack' 读的就是加完数值后的值）。
        name: 'Evolve',
        params: {
          effect: {
            name: 'DistributeDamage',
            params: {
              amountFrom: 'attack',
              side: 'opponent',
              // ★ 能力特效：每个受到伤害的目标各排一颗**紫色毒弹**（从目标卡牌右上方直线射入）。
              //   参数在常驻节点 `Canvas/PoisonBulletFx` 的 Inspector 上
              //   （颜色 / 子弹长短 / 子弹粗细 / 最远出现距离 / 倾斜角度）。
              fx: 'poisonBullet',
            },
          },
        },
      },
    ],
  },
  // 「精心的维护」（白银护符，费用 2，无 hp/attack）
  // → 手牌框 SilverAmulet.png ／ 战场框 BF_SilverAmulet.png
  '3.png': {
    cardImage: '3.png',
    quality: 'Silver',
    cardType: 'Amulet',
    cardName: '精心的维护',
    cost: 2,
    hp: null,
    attack: null,
    abilities: [
      {
        name: 'Chant',
        params: {
          turns: 4,
          // 🔴 咏唱倒数结束**一定破坏自身**（内建，见 CardKeywordSystem.tickChantsForCurrentTurn）
          //    → 这里不用再写 effect: { name: 'DestroySelf' }；effect 只用来挂「额外的」效果。
        },
      },
      {
        name: 'FriendlyFollowerEnterBuff',
        params: {
          keywords: ['Rush'],
          attack: 2,
          hp: 0,
        },
      },
    ],
  },
  // 「奔走的狙击手·夏安」（传说随从，费用 7）
  // · 入场曲：选择对方场上一个随从，破坏该随从（先播一颗子弹飞到目标中心，再播破坏动画）
  // · 超进化：**先获得纹章**，再触发一次入场曲（顺序不可颠倒：纹章要先落地，
  //   入场曲破坏才能触发纹章里「对方随从被破坏时打主战者 2 点」那条）
  // · 潜行：不会被对方能力选中 / 不会被对方随从攻击；攻击或能力造成伤害后现形
  //   （🔴 入场曲是「破坏」而非伤害 ⇒ 不会让它失去潜行）
  '4.png': {
    cardImage: '4.png',
    quality: 'Legendary',
    cardType: 'Follower',
    cardName: '奔走的狙击手·夏安',
    cost: 7,
    hp: 4,
    attack: 4,
    abilities: [
      {
        name: 'Ambush',
      },
      {
        name: 'Fanfare',
        params: {
          select: 'enemyFollower',
          action: 'destroy',
        },
      },
      {
        name: 'SuperEvolve',
        params: {
          // 🔴 书写顺序 = 结算顺序，且「获得纹章」**必须在前**（需求）：
          //    先拿到纹章，随后的入场曲破坏才能触发纹章里那条
          //    「我方回合时，当对方随从被破坏时对对方主战者造成 2 点伤害」。
          //    （即使这里写反了，`runNestedEffects` 也会把 GainCrest 稳定排到最前 —— 见 CardAbilitySystem。）
          effects: [
            { name: 'GainCrest' },
            { name: 'Fanfare' },
          ],
        },
      },
    ],
  },
  // 「高油温防护·塞布丽娜」（白银随从，费用 4，攻 4 / 血 5）
  // · 守护：此牌在场时，对方只能攻击拥有守护的随从（不能打其它随从与主战者）
  // · 进化时：选择对方战场上的 **1 个受伤的随从**，破坏该随从
  //   （目标由交互层在**进化之前**选好 —— 见 EvoDragController.requestEvolve；
  //    `filter: 'damaged'` 的筛选在选择层完成，口径 = 血量红字，见 BattleRuleSystem.isDamaged）
  '5.png': {
    cardImage: '5.png',
    quality: 'Silver',
    cardType: 'Follower',
    cardName: '高油温防护·塞布丽娜',
    cost: 4,
    hp: 5,
    attack: 4,
    abilities: [
      {
        name: 'Guard',
      },
      {
        name: 'Evolve',
        params: {
          select: 'enemyFollower',
          filter: 'damaged',
          action: 'destroy',
        },
      },
    ],
  },
  // 「异相浅眠·米什缇」（**虹卡**随从，费用 3，攻 0 / 血 3）
  // · 潜行：不会被对方能力选中、不会被对方随从攻击（自己攻击 / 通过能力造成伤害时现形）
  // · 回合结束时（纯描述那一条）：**我方回合结束时**随机对敌方战场上的 1 个随从造成 3 点伤害
  // · 进化时：使我方场上所有随从获得 +1/+1
  // 🔴 本轮**不配置攻击特效 / 能力特效**（用户要求，特效留到后续任务）
  '6.png': {
    cardImage: '6.png',
    quality: 'Legendary',
    cardType: 'Follower',
    cardName: '异相浅眠·米什缇',
    cost: 3,
    hp: 3,
    attack: 0,
    abilities: [
      {
        name: 'Ambush',
      },
      {
        // 「我方回合结束时」——触发时机 = 自己这一方的操作回合结束（见 TurnManager._beginTurnEnd）
        // 书写顺序 = 结算顺序：先随机打 3 点，再让自己**获得潜行**
        name: 'TurnEnd',
        params: {
          effects: [
            {
              name: 'RandomDamage',
              params: {
                select: 'enemyFollower',
                amount: 3,
                // ★ 能力特效：命中的目标排一颗**紫色毒弹**（与卡 2 同一套，参数见 Canvas/PoisonBulletFx）
                fx: 'poisonBullet',
              },
            },
            {
              // 获得潜行（与入场时的被动潜行同一个 handler，重复授予幂等）
              name: 'Ambush',
            },
          ],
        },
      },
      {
        name: 'Evolve',
        params: {
          effects: [
            {
              name: 'BuffFriendlyFollowers',
              params: { attack: 2, hp: 2 },
            },
          ],
        },
      },
    ],
  },
  // 「钢铁穹顶」（白银**法术**，费用 1）
  // · 选择我方战场上 1 个拥有【守护】的随从 → 使其 +0/+1
  //   → 对对方战场上的**随机 1 个**随从造成 X 点伤害（X = 所选随从的**当前血量**）
  // · 法术没有入场曲，交互层也不为法术做目标选择 ⇒ 选择由能力自己发起（`SelectTarget`）
  // 🔴 本轮**不配置攻击特效 / 能力特效**（用户要求，特效留到后续任务）
  '7.png': {
    cardImage: '7.png',
    quality: 'Silver',
    cardType: 'Spell',
    cardName: '钢铁穹顶',
    cost: 1,
    hp: null,
    attack: null,
    abilities: [
      {
        name: 'SelectTarget',
        params: {
          select: 'friendlyFollower',
          filter: 'guard',
          effects: [
            {
              name: 'BuffSelected',
              params: { attack: 0, hp: 1 },
            },
            {
              name: 'RandomDamage',
              params: { select: 'enemyFollower', amountFrom: 'selectedHp' },
            },
          ],
        },
      },
    ],
  },
  // 「高效的护理」（白银**护符**，费用 2）
  // · 启动（1 回合仅限 1 次、费用 1）：选择我方战场上的 1 个随从，使其 +1/+1；随后**回复我方主战者 1 点**。
  //   🔴 `optional: true` —— **没有可选随从时照常发动**（跳过选择那一段，仍然回血 1 点）。
  //   🔴 只有**自己的回合**能启动；能启动时该护符在战场上**常亮选择光圈**（不抬卡）。
  //   🔴 启动入口 = 说明卡片上的「启动」按钮（见 CardTooltip 的启动按钮 + CardAbilitySystem.activateAmulet）。
  // 🔴 本轮**不配置攻击特效 / 能力特效**（用户要求，特效留到后续任务）
  '8.png': {
    cardImage: '8.png',
    quality: 'Silver',
    cardType: 'Amulet',
    cardName: '高效的护理',
    cost: 2,
    hp: null,
    attack: null,
    abilities: [
      {
        name: 'Activate',
        params: {
          cost: 1,
          select: 'friendlyFollower',
          optional: true,
          effects: [
            {
              name: 'BuffSelected',
              params: { attack: 1, hp: 1 },
            },
            {
              name: 'HealHero',
              params: { amount: 1 },
            },
          ],
        },
      },
    ],
  },
  // 「史上最强·威玛西娜」（**虹卡**随从，费用 8，8/8）
  // · 入场曲 = 【模式】选择 1 个能力发动：
  //   （1）本随从获得【疾驰】；（2）本随从获得【守护】+ 对对手战场上的**所有**随从造成 8 点伤害。
  // · 🔴 `select:'mode'` 让打出流程先进入选择模式（卡牌飞到左上角 → 屏幕中央列选项）。
  // 🔴 本轮**不配置攻击特效 / 能力特效**（特效等后续单独任务）
  '9.png': {
    cardImage: '9.png',
    quality: 'Legendary',
    cardType: 'Follower',
    cardName: '史上最强·威玛西娜',
    cost: 8,
    hp: 8,
    attack: 8,
    abilities: [
      {
        name: 'Fanfare',
        params: {
          effect: {
            name: 'Mode',
            params: {
              select: 'mode',
              count: 1,
              options: [
                {
                  text: '本随从获得【疾驰】。',
                  effects: [{ name: 'Charge' }],
                },
                {
                  text: '本随从获得【守护】。对对手的战场上的所有随从造成8点伤害。',
                  effects: [
                    { name: 'Guard' },
                    {
                      name: 'DistributeDamage',
                      // 🔴 perTarget：每个敌方随从各吃满 8 点（不是把 8 点分配出去）
                      // ★ 能力特效：**黄色导弹**（模仿可露凯毒弹，风格改成导弹）——每个目标一发，同时飞
                      params: { amount: 8, side: 'opponent', perTarget: true, fx: 'missileStrike' },
                    },
                  ],
                },
              ],
            },
          },
        },
      },
    ],
  },

  // 「守护之道·春田」（**虹卡**随从，费用 7，4/7）
  // · 入场曲：选择对手战场上的 1 个随从，使其**消失**（不进墓场、不触发谢幕曲）+ **回复我方主战者 3 点**
  // · 守护（Guard，静态词条）
  // · 超进化时：**发动与入场曲相同的能力**
  // 🔴 本轮**不配置攻击特效 / 能力特效**（特效等后续单独任务）
  '10.png': {
    cardImage: '10.png',
    quality: 'Legendary',
    cardType: 'Follower',
    cardName: '守护之道·春田',
    cost: 7,
    hp: 7,
    attack: 4,
    abilities: [
      { name: 'Guard' },
      {
        name: 'Fanfare',
        params: {
          select: 'enemyFollower',
          effects: [
            { name: 'Vanish' },
            { name: 'HealHero', params: { amount: 3 } },
          ],
        },
      },
      {
        name: 'SuperEvolve',
        params: {
          effects: [{ name: 'Fanfare' }],
        },
      },
    ],
  },

  // 「温情攻势·安朵丝」（**银卡**随从，费用 2，2/2）
  // · 本随从在战场上获得攻击力或生命值增加时，**自己的每回合中可触发 1 次**，召唤 1 个自巡炮
  //   （🔴 进化 / 超进化加数值也算「增加」—— 都走 BattleRuleSystem.addStats）
  // · 谢幕曲：将 1 张自巡炮加入手牌
  // 🔴 本轮**不配置攻击特效 / 能力特效**（特效等后续单独任务）
  '11.png': {
    cardImage: '11.png',
    quality: 'Silver',
    cardType: 'Follower',
    cardName: '温情攻势·安朵丝',
    cost: 2,
    hp: 2,
    attack: 2,
    abilities: [
      {
        name: 'StatUp',
        params: {
          effects: [
            { name: 'Summon', params: { from: 'generate', id: '12.png', count: 1 } },
          ],
        },
      },
      {
        name: 'LastWords',
        params: {
          effects: [
            { name: 'AddToHand', params: { id: '12.png' } },
          ],
        },
      },
    ],
  },
  // 「自巡炮」（随从，费用 1，1/1，突进）
  '12.png': {
    cardImage: '12.png',
    quality: 'Bronze',
    cardType: 'Follower',
    cardName: '自巡炮',
    cost: 1,
    hp: 1,
    attack: 1,
    abilities: [
      { name: 'Rush' },
    ],
  },
  // 「跃动弧光·比悠卡」（**虹卡**随从，费用 7，4/6）
  // · 入场曲：选择对手战场上的 1 个随从 → **破坏**它；并使**自己战场上的其他所有随从** +1/+1
  // · 守护 / 疾驰
  // 🔴 本轮**不配置攻击特效 / 能力特效**（特效等后续单独任务）
  '13.png': {
    cardImage: '13.png',
    quality: 'Legendary',
    cardType: 'Follower',
    cardName: '跃动弧光·比悠卡',
    cost: 7,
    hp: 6,
    attack: 4,
    abilities: [
      { name: 'Guard' },
      // 🔴 文案是「**疾驰**」（Charge：当回合可攻击随从**和主战者**），不是「突进」（Rush：只能打随从）
      { name: 'Charge' },
      {
        name: 'Fanfare',
        params: {
          select: 'enemyFollower',
          action: 'destroy',
          effects: [
            // 「其他」= 排除自己（本卡落地后才结算入场曲，此刻它已在战场上）
            { name: 'BuffFriendlyFollowers', params: { attack: 1, hp: 1, excludeSelf: true } },
          ],
        },
      },
    ],
  },

  // 「全面压制·OTs-14」（**金卡**随从，费用 10，2/12）
  // · 疾驰 / 毁灭 / 守护
  // · 入场曲【协作_20】：消失对手战场上的所有卡牌
  // · 1 回合可以攻击 3 次
  // 🔴 本轮**不配置攻击特效 / 能力特效**（毁灭的破坏走既有破坏管线）
  '17.png': {
    cardImage: '17.png',
    quality: 'Gold',
    cardType: 'Follower',
    cardName: '全面压制·OTs-14',
    cost: 10,
    hp: 12,
    attack: 2,
    abilities: [
      { name: 'Charge' },
      { name: 'Bane' },
      { name: 'Guard' },
      { name: 'MultiAttack', params: { times: 3 } },
      {
        name: 'Fanfare',
        params: {
          effect: {
            name: 'Cooperation',
            params: {
              threshold: 20,
              effects: [{ name: 'VanishAll', params: { side: 'opponent' } }],
              otherwise: [],
            },
          },
        },
      },
    ],
  },
  // 「现代最强·针」（**虹卡**随从，费用 9，10/10）
  // · 不会被能力破坏：毁灭 / 入场曲 / 进化时 / 纹章等直接破坏无效，数字伤害照常结算
  // · 交战时：在互相造成伤害前破坏交战对手
  // · 超进化时：获得「1回合可以攻击3次」
  '18.png': {
    cardImage: '18.png',
    quality: 'Legendary',
    cardType: 'Follower',
    cardName: '现代最强·针',
    cost: 9,
    hp: 10,
    attack: 10,
    abilities: [
      { name: 'Aura' },
      { name: 'AbilityDestroyImmune' },
      {
        name: 'Clash',
        params: { action: 'destroy' },
      },
      {
        name: 'SuperEvolve',
        params: {
          effects: [
            { name: 'MultiAttack', params: { times: 3 } },
          ],
        },
      },
    ],
  },
  // 「命运的少女·海伦娜」（**金卡**随从，费用 2，1/1）
  // · 屏障：受到伤害时把该次伤害变 0，发动 1 次后失效
  // · 爆能强化_8：打出时若剩余能量点 ≥ 8 ⇒ 改为消耗 8 点，抽 1 张**费用 7 或以上**的随从
  //   （**完全随机**，不按费用优先级），并回复 7 点能量点
  // 🔴 本轮**不配置攻击特效 / 能力特效**（屏障特效是另一条任务）
  '16.png': {
    cardImage: '16.png',
    quality: 'Gold',
    cardType: 'Follower',
    cardName: '命运的少女·海伦娜',
    cost: 2,
    hp: 1,
    attack: 1,
    abilities: [
      { name: 'Barrier' },
      {
        name: 'Enhance',
        params: {
          value: 8,
          effects: [
            { name: 'DrawCards', params: { count: 1, cardType: 'Follower', minCost: 7 } },
            { name: 'RestorePP', params: { amount: 7 } },
          ],
        },
      },
    ],
  },
  // 「恶兆成谶·维克托」（**虹卡**随从，费用 3，2/2）
  // · 入场曲：对对手的战场上的**所有**随从造成 4 点伤害
  // · 超进化时：本随从获得【疾驰】
  // · 谢幕曲：使自己获得『纹章：恶兆成谶·维克托』（= 纹章 15.png「缜密之思」）
  // 🔴 本轮**不配置攻击特效 / 能力特效**
  '15.png': {
    cardImage: '15.png',
    quality: 'Legendary',
    cardType: 'Follower',
    cardName: '恶兆成谶·维克托',
    cost: 3,
    hp: 2,
    attack: 2,
    abilities: [
      {
        name: 'Fanfare',
        params: {
          select: 'enemyFollower',
          effect: {
            name: 'Cooperation',
            params: {
              threshold: 10,
              // 【协作_10】满足 ⇒ 对对手战场上的**所有**随从造成 4 点（火焰刀光横扫）
              effects: [
                { name: 'DistributeDamage', params: { amount: 4, side: 'opponent', perTarget: true, fx: 'flameSweep' } },
              ],
              // 不满足 ⇒ 只对**选中的那一个**造成 4 点
              otherwise: [
                // ★ 需求：协作**没满足**时的单体 4 点 = **威玛西娜的导弹特效**（参数完全照搬、无尾焰），
                //    颜色换成红色（火焰子弹风格）。
                { name: 'DamageSelected', params: { amount: 4, fx: 'missileStrike', color: [255, 82, 30] } },
              ],
            },
          },
        },
      },
      {
        name: 'SuperEvolve',
        params: { effects: [{ name: 'Charge' }] },
      },
      {
        name: 'LastWords',
        params: { effects: [{ name: 'GainCrest', params: { id: '15.png' } }] },
      },
    ],
  },
  // 「队伍的召集」（**金卡**法术，费用 5）
  // · 召唤随机 1 个自己牌组中费用 ≤3 的随从
  // · 召唤随机 1 个自己牌组中费用 ≤2 的随从
  // · 使自己的战场上的所有随从 +1/+1
  // 🔴 能力按数组顺序依次结算 ⇒ 两次召唤先落地，再统一 +1/+1（文案口径就是「所有随从」）
  '14.png': {
    cardImage: '14.png',
    quality: 'Gold',
    cardType: 'Spell',
    cardName: '队伍的召集',
    cost: 5,
    hp: null,
    attack: null,
    abilities: [
      // 🔴 法术结算只跑 trigger==='use' 的能力 ⇒ 三条效果必须包在 SpellEffects 里
      {
        name: 'SpellEffects',
        params: {
          effects: [
            { name: 'Summon', params: { from: 'deck', count: 1, cardType: 'Follower', maxCost: 3 } },
            { name: 'Summon', params: { from: 'deck', count: 1, cardType: 'Follower', maxCost: 2 } },
            { name: 'BuffFriendlyFollowers', params: { attack: 1, hp: 1 } },
          ],
        },
      },
    ],
  },
  // 「狂猎」（虹卡随从，费用 8，1/5）
  // · 入场曲召唤 3 个游猎前锋；疾驰 / 毁灭
  // · 其他己方随从入场时，该随从 +2/+0 并获得突进；来源卡本身 +1/+0
  // · 超进化时再召唤 1 个游猎前锋；召唤使用既有共用演出，不另配特效
  '19.png': {
    cardImage: '19.png',
    quality: 'Legendary',
    cardType: 'Follower',
    cardName: '狂猎',
    cost: 8,
    hp: 5,
    attack: 1,
    abilities: [
      { name: 'Fanfare', params: { effect: { name: 'Summon', params: { from: 'generate', id: '20.png', count: 3 } } } },
      { name: 'Charge' },
      { name: 'Bane' },
      {
        name: 'FriendlyFollowerEnterBuff',
        params: { keywords: ['Rush'], attack: 2, hp: 0, selfAttack: 1 },
      },
      { name: 'SuperEvolve', params: { effects: [{ name: 'Summon', params: { from: 'generate', id: '20.png', count: 1 } }] } },
    ],
  },
  // 「游猎前锋」（铜卡随从，费用 0，1/1；无额外能力）
  '20.png': {
    cardImage: '20.png',
    quality: 'Bronze',
    cardType: 'Follower',
    cardName: '游猎前锋',
    cost: 0,
    hp: 1,
    attack: 1,
  },
  // 「乔扎」（虹卡随从，费用 9，13/13）
  // 入场曲使双方战场上的其他所有随从与护符消失，乔扎自身保留。
  '21.png': {
    cardImage: '21.png',
    quality: 'Legendary',
    cardType: 'Follower',
    cardName: '乔扎',
    cost: 9,
    hp: 13,
    attack: 13,
    abilities: [
      {
        name: 'Fanfare',
        params: {
          effect: { name: 'VanishAll', params: { side: 'both', excludeSelf: true } },
        },
      },
    ],
  },
  // 「曼尼安保」（铜卡随从，费用 1，2/2；无额外能力）
  '22.png': {
    cardImage: '22.png',
    quality: 'Bronze',
    cardType: 'Follower',
    cardName: '曼尼安保',
    cost: 1,
    hp: 2,
    attack: 2,
  },
  // 「无音的包围」（银卡法术，费用 1）
  // · 将 1 张曼尼安保加入手牌并使其获得突进；协作 10 时改为加入 2 张。
  '23.png': {
    cardImage: '23.png',
    quality: 'Silver',
    cardType: 'Spell',
    cardName: '无音的包围',
    cost: 1,
    hp: null,
    attack: null,
    abilities: [
      {
        name: 'SpellEffects',
        params: {
          effects: [
            {
              name: 'Cooperation',
              params: {
                threshold: 10,
                effects: [
                  { name: 'AddToHand', params: { id: '22.png', keywords: ['Rush'] } },
                  { name: 'AddToHand', params: { id: '22.png', keywords: ['Rush'] } },
                ],
                otherwise: [
                  { name: 'AddToHand', params: { id: '22.png', keywords: ['Rush'] } },
                ],
              },
            },
          ],
        },
      },
    ],
  },
  // 「战场通讯员」（铜卡随从，费用 3，2/3）
  // · 入场曲：召唤 1 张游猎前锋，并将 1 张曼尼安保加入手牌。
  '24.png': {
    cardImage: '24.png',
    quality: 'Bronze',
    cardType: 'Follower',
    cardName: '战场通讯员',
    cost: 3,
    hp: 3,
    attack: 2,
    abilities: [
      {
        name: 'Fanfare',
        params: {
          effects: [
            { name: 'Summon', params: { from: 'generate', id: '20.png', count: 1 } },
            { name: 'AddToHand', params: { id: '22.png', waitForSourceGone: false } },
          ],
        },
      },
    ],
  },

  // 「激进的榴弹兵」（银卡随从，费用 2，2/1）
  // · 谢幕曲：召唤 1 个游猎前锋（凭空生成 → 不扣牌组，走既有召唤共用演出）
  // · 进化时（普通进化 / 超进化都触发）：选择对手战场上的 1 个随从，对其造成 3 点伤害
  // 🔴 本轮**不配置攻击特效 / 能力特效**（fx 不填 ⇒ 只有既有破坏/召唤管线自带的演出）
  '25.png': {
    cardImage: '25.png',
    quality: 'Silver',
    cardType: 'Follower',
    cardName: '激进的榴弹兵',
    cost: 2,
    hp: 1,
    attack: 2,
    abilities: [
      {
        name: 'LastWords',
        params: {
          effects: [
            { name: 'Summon', params: { from: 'generate', id: '20.png', count: 1 } },
          ],
        },
      },
      {
        name: 'Evolve',
        params: {
          select: 'enemyFollower',
          effects: [
            { name: 'DistributeDamage', params: { amount: 3, side: 'opponent', select: 'selected' } },
          ],
        },
      },
    ],
  },

  // 「重炮圣盾」（虹卡随从，费用 5，4/4）
  // · 入场曲：召唤 1 个『重炮圣盾』（同名复制，凭空生成、不触发入场曲）
  //           【协作_20】对对手的主战者造成 4 点伤害
  // · 突进
  // · 进化时：发动 2 次「对对手的战场上的随机 1 个随从造成 4 点伤害」
  // 🔴 本轮**不配置攻击特效 / 能力特效**（fx 不填）
  '26.png': {
    cardImage: '26.png',
    quality: 'Legendary',
    cardType: 'Follower',
    cardName: '重炮圣盾',
    cost: 5,
    hp: 4,
    attack: 4,
    abilities: [
      {
        name: 'Fanfare',
        params: {
          effects: [
            { name: 'Summon', params: { from: 'generate', id: '26.png', count: 1 } },
            {
              name: 'Cooperation',
              params: {
                threshold: 20,
                effects: [
                  { name: 'DamageHero', params: { amount: 4 } },
                ],
                otherwise: [],
              },
            },
          ],
        },
      },
      { name: 'Rush' },
      {
        name: 'Evolve',
        params: {
          effects: [
            { name: 'RandomDamage', params: { amount: 4 } },
            { name: 'RandomDamage', params: { amount: 4 } },
          ],
        },
      },
    ],
  },

  // 「御导圣盾」（金卡随从，费用 6，6/6）
  // · 入场曲：对对手的战场上的所有随从造成 4 点伤害
  // · 爆能强化_8：本随从超进化（数值 +3/+3 + 超进化守护 + 突进，不消耗进化点、不播进化动画）
  // 🔴 本轮**不配置攻击特效 / 能力特效**
  '27.png': {
    cardImage: '27.png',
    quality: 'Gold',
    cardType: 'Follower',
    cardName: '御导圣盾',
    cost: 6,
    hp: 6,
    attack: 6,
    abilities: [
      {
        name: 'Fanfare',
        params: {
          effects: [
            { name: 'DistributeDamage', params: { amount: 4, side: 'opponent', perTarget: true } },
          ],
        },
      },
      {
        name: 'Enhance',
        params: {
          value: 8,
          effects: [
            { name: 'SelfSuperEvolve' },
          ],
        },
      },
    ],
  },

  // 「骇人的轰炸」（金卡法术，费用 5）
  // · 破坏敌方战场上攻击力最高的随从（并列取最左）；抽 2 张牌
  // · 爆能强化_10：对对手的战场上的所有随从造成 4 点伤害
  // 🔴 本轮**不配置攻击特效 / 能力特效**（能力「破坏」的破坏动画是既有共用管线）
  '28.png': {
    cardImage: '28.png',
    quality: 'Gold',
    cardType: 'Spell',
    cardName: '骇人的轰炸',
    cost: 5,
    hp: null,
    attack: null,
    abilities: [
      {
        name: 'SpellEffects',
        params: {
          effects: [
            { name: 'DestroyHighestAttack' },
            { name: 'DrawCards', params: { count: 2 } },
          ],
        },
      },
      {
        name: 'Enhance',
        params: {
          value: 10,
          effects: [
            // ★ 爆能强化_10：对敌方**全场**各 4 点 —— 演出 = 与卡 15「维克托」同款的**火焰刀光横扫**，
            //   但换成**黄色**（金色雷光风格）。fx/color 由 `pushPoisonBulletCue` → `FlameSweepFx.play` 传递。
            {
              name: 'DistributeDamage',
              params: { amount: 4, side: 'opponent', perTarget: true, fx: 'flameSweep', color: [255, 200, 60] },
            },
          ],
        },
      },
    ],
  },

  // 「第二战场·猛犸」（虹卡随从，费用 7，5/7）
  // · 入场曲：召唤 2 个『曼尼安保』；使自己的战场上的**其他**所有随从 +1/+3 且获得【守护】
  //           （先召唤后增益 ⇒ 新召唤出来的 2 个曼尼安保也会吃到 +1/+3 与守护）
  // · 守护
  // · 超进化时：选择对手战场上的 1 个随从，破坏该随从
  // 🔴 本轮**不配置攻击特效 / 能力特效**
  '29.png': {
    cardImage: '29.png',
    quality: 'Legendary',
    cardType: 'Follower',
    cardName: '第二战场·猛犸',
    cost: 7,
    hp: 7,
    attack: 5,
    abilities: [
      {
        name: 'Fanfare',
        params: {
          effects: [
            { name: 'Summon', params: { from: 'generate', id: '22.png', count: 2 } },
            { name: 'BuffFriendlyFollowers', params: { attack: 1, hp: 3, keywords: ['Guard'], excludeSelf: true } },
          ],
        },
      },
      { name: 'Guard' },
      {
        name: 'SuperEvolve',
        params: {
          select: 'enemyFollower',
          action: 'destroy',
        },
      },
    ],
  },

  // 「分队长」（金卡随从，费用 5，3/2）
  // · 入场曲：召唤 3 个『游猎前锋』；使自己的战场上的**其他**所有随从 +1/+0 且获得【突进】
  // 🔴 本轮**不配置攻击特效 / 能力特效**
  '30.png': {
    cardImage: '30.png',
    quality: 'Gold',
    cardType: 'Follower',
    cardName: '分队长',
    cost: 5,
    hp: 2,
    attack: 3,
    abilities: [
      {
        name: 'Fanfare',
        params: {
          effects: [
            { name: 'Summon', params: { from: 'generate', id: '20.png', count: 3 } },
            { name: 'BuffFriendlyFollowers', params: { attack: 1, hp: 0, keywords: ['Rush'], excludeSelf: true } },
          ],
        },
      },
    ],
  },

  // 「复合哨兵」（银卡随从，费用 5，2/3）
  // · 入场曲：抽取 2 张卡牌；召唤 2 个『游猎前锋』
  // · 进化时：选择对手战场上的 1 个随从，对其造成 3 点伤害
  // 🔴 本轮**不配置攻击特效 / 能力特效**（fx 不填）
  '31.png': {
    cardImage: '31.png',
    quality: 'Silver',
    cardType: 'Follower',
    cardName: '复合哨兵',
    cost: 5,
    hp: 3,
    attack: 2,
    abilities: [
      {
        name: 'Fanfare',
        params: {
          effects: [
            { name: 'DrawCards', params: { count: 2 } },
            { name: 'Summon', params: { from: 'generate', id: '20.png', count: 2 } },
          ],
        },
      },
      {
        name: 'Evolve',
        params: {
          select: 'enemyFollower',
          effects: [
            { name: 'DistributeDamage', params: { amount: 3, side: 'opponent', select: 'selected' } },
          ],
        },
      },
    ],
  },

  // 「烈日魔犬」（虹卡随从，费用 4，3/2）
  // · 入场曲：召唤 1 个『烈日魔犬』（同名复制）
  // · 爆能强化_6：使**被这个入场曲召唤出来的那只**烈日魔犬获得【毁灭】；本随从获得【疾驰】
  // · 突进
  // 🔴 本轮**不配置攻击特效 / 能力特效**
  '32.png': {
    cardImage: '32.png',
    quality: 'Legendary',
    cardType: 'Follower',
    cardName: '烈日魔犬',
    cost: 4,
    hp: 2,
    attack: 3,
    abilities: [
      {
        name: 'Fanfare',
        params: {
          effects: [
            // grantTo:'source' ⇒ 把召唤出来的这只设为 ctx.target，供下面爆能强化的 BuffSelected 使用
            { name: 'Summon', params: { from: 'generate', id: '32.png', count: 1, grantTo: 'source' } },
          ],
        },
      },
      { name: 'Rush' },
      {
        name: 'Enhance',
        params: {
          value: 6,
          effects: [
            // 🔴 并列同一时点结算 ⇒ 先给「入场曲召唤出来的那只」上毁灭，别让它先被自己抢走目标
            { name: 'BuffSelected', params: { keywords: ['Bane'] } },
            { name: 'Charge' },
          ],
        },
      },
    ],
  },

  // 「侦查者」（银卡随从，费用 2，2/2）
  // · 入场曲：将 1 张『游猎前锋』加入手牌，使其获得【突进】
  // 🔴 本轮**不配置攻击特效 / 能力特效**
  '33.png': {
    cardImage: '33.png',
    quality: 'Silver',
    cardType: 'Follower',
    cardName: '侦查者',
    cost: 2,
    hp: 2,
    attack: 2,
    abilities: [
      {
        name: 'Fanfare',
        params: {
          effects: [
            { name: 'AddToHand', params: { id: '20.png', keywords: ['Rush'], waitForSourceGone: false } },
          ],
        },
      },
    ],
  },

  // 「巨大兵蚁」（铜卡随从，费用 8，7/5）
  // · 疾驰
  // 🔴 本轮**不配置攻击特效 / 能力特效**
  '34.png': {
    cardImage: '34.png',
    quality: 'Bronze',
    cardType: 'Follower',
    cardName: '巨大兵蚁',
    cost: 8,
    hp: 5,
    attack: 7,
    abilities: [
      { name: 'Charge' },
    ],
  },

  // 「乔乔&少女」（金卡随从，费用 2，1/1）
  // · 屏障（受到伤害时把该次伤害变 0，发动 1 次后失效）
  // · 爆能强化_8：抽取 1 张费用 7 或以上的随从；回复自己 7 点能量点
  // 🔴 本轮**不配置攻击特效 / 能力特效**
  '35.png': {
    cardImage: '35.png',
    quality: 'Gold',
    cardType: 'Follower',
    cardName: '乔乔&少女',
    cost: 2,
    hp: 1,
    attack: 1,
    abilities: [
      { name: 'Barrier' },
      {
        name: 'Enhance',
        params: {
          value: 8,
          effects: [
            { name: 'DrawCards', params: { count: 1, cardType: 'Follower', minCost: 7 } },
            { name: 'RestorePP', params: { amount: 7 } },
          ],
        },
      },
    ],
  },

  // 「持续的轰炸」（金卡护符，费用 4，无 hp/attack）
  // · 吟唱_2：自己的回合结束时，对**战场上所有随从**造成 2 点伤害（双方都打）
  // 🔴 按说明表口径：不挑目标、不排除任何一方，`side:'both'` 就是「战场上的所有随从」
  // 🔴 说明表只写了「吟唱_2 的效果」，没写吟唱结束的额外效果 ⇒ 用内建「倒数到 1 时破坏自身」
  // 🔴 本轮**不配置攻击特效 / 能力特效**
  '36.png': {
    cardImage: '36.png',
    quality: 'Gold',
    cardType: 'Amulet',
    cardName: '持续的轰炸',
    cost: 4,
    hp: null,
    attack: null,
    abilities: [
      { name: 'Chant', params: { turns: 2 } },
      {
        name: 'TurnEnd',
        params: {
          effects: [
            { name: 'DistributeDamage', params: { amount: 2, side: 'both', perTarget: true } },
          ],
        },
      },
    ],
  },

  // 「刀锋」（金卡随从，费用 4，4/4）
  // · 进化时（普通进化 / 超进化都触发）：召唤 2 个『游猎前锋』；
  //   使自己的战场上的**其他**所有随从 +1/+1
  // 🔴 顺序有意义：先召唤（新兵会在同一时点吃到 +1/+1）。
  //    ⚠️ 实现注记：`Summon` 的入场演出排在 `Reflow → Done` cue 之后（见 summonCards），
  //    而 `BuffFriendlyFollowers` 是**逻辑当场结算** ⇒ 逻辑上一定吃到；只是若 Reflow 期间它
  //    还不能显示，数字刷新会跟着入场演出一起到位。
  // 🔴 本轮**不配置攻击特效 / 能力特效**
  '37.png': {
    cardImage: '37.png',
    quality: 'Gold',
    cardType: 'Follower',
    cardName: '刀锋',
    cost: 4,
    hp: 4,
    attack: 4,
    abilities: [
      {
        name: 'Evolve',
        params: {
          effects: [
            { name: 'Summon', params: { from: 'generate', id: '20.png', count: 2 } },
            { name: 'BuffFriendlyFollowers', params: { attack: 1, hp: 1, excludeSelf: true } },
          ],
        },
      },
    ],
  },
};

// ====================== 卡牌专属攻击特性 ======================

/**
 * **卡牌专属攻击特性**：卡 id → 演出名。
 *   · `'plasmaBolt'` = **电浆闪电**（卡 12「自巡炮」，参照纹章4 的子弹特效、风格改闪电/电浆）。
 * 没登记的卡走原来的「随从攻击演出」。
 */
export const CARD_ATTACK_FX: Record<string, string> = {
  '12.png': 'plasmaBolt',
  // 卡 13「跃动弧光·比悠卡」：普通攻击同样用**电浆闪电**（需求：参考卡 12 的攻击特效）
  '13.png': 'plasmaBolt',
  // 🔴 卡 17「全面压制·OTs-14」**不配专属攻击特性** —— 需求：攻击特效要**完全用普通攻击的那个特效球**，
  //    只改「颜色」和「轨迹」（见 CARD_ATTACK_FX_COLOR / CARD_ATTACK_FX_CURVE）。
  //    （曾经误配成 plasmaBolt —— 那是带拖尾的电浆弹，违反需求，已去掉。）

};

/** ★ 攻击特效的**每张卡颜色覆盖**（缺省 = 用特效组件自身的颜色）。 */
export const CARD_ATTACK_FX_COLOR: Record<string, number[]> = {
    // 卡 17：暗红
    '17.png': [150, 22, 26],
};

/** ★ 攻击特效的**每张卡轨迹弯曲量**（普通攻击特效球的 curveOffset，0/缺省 = 直线）。 */
export const CARD_ATTACK_FX_CURVE: Record<string, number> = {
    // 卡 17：让特效球走一条明显的弧线（需求：只改颜色和轨迹）
    '17.png': 70,
};

/** 取某张卡攻击特效的轨迹弯曲量（没有 → null）。 */
export function attackFxCurveOf(id: string | null | undefined): number | null {
    if (!id) return null;
    const key = String(id).trim().toLowerCase();
    const bare = key.replace(/\.[a-z0-9]+$/, '');
    const hit = CARD_ATTACK_FX_CURVE[key] !== undefined ? CARD_ATTACK_FX_CURVE[key]
        : (CARD_ATTACK_FX_CURVE[bare + '.png'] !== undefined ? CARD_ATTACK_FX_CURVE[bare + '.png'] : CARD_ATTACK_FX_CURVE[bare]);
    return typeof hit === 'number' ? hit : null;
}

/** 取某张卡攻击特效的颜色覆盖（没有 → null）。 */
export function attackFxColorOf(id: string | null | undefined): number[] | null {
    if (!id) return null;
    const key = String(id).trim().toLowerCase();
    const bare = key.replace(/\.[a-z0-9]+$/, '');
    const hit = CARD_ATTACK_FX_COLOR[key] || CARD_ATTACK_FX_COLOR[bare + '.png'] || CARD_ATTACK_FX_COLOR[bare];
    return Array.isArray(hit) && hit.length >= 3 ? hit : null;
}

/** 取某张卡的攻击特性名（没有 → 空串）。id 会先规范化（`'12'` / `'12.png'` 等价）。 */
export function attackFxOf(id: string | null | undefined): string {
  if (!id) return '';
  // 🔴 传进来的可能是**节点名**（BF_12.png / Card_12.png）而不是卡 id ⇒ 只取末尾的数字段。
  const m = /(\d+)(?:\.png)?$/i.exec(String(id));
  const key = m ? (m[1] + '.png') : '';
  return key ? (CARD_ATTACK_FX[key] || '') : '';
}

// ====================== 爆能强化：本次打出是否已付费 ======================

/**
 * ★ 「本次打出按爆能强化付了费」的标记（CardPlay 打标记 → Enhance 能力消费）。
 * 🔴 放在 CardData 而不是 CardAbilitySystem：CardPlay 与 CardAbilitySystem 本来就互相 import，
 *    再让 CardPlay import CardAbilitySystem 会形成**循环依赖**，TS 会把 CardPlay 类解析坏
 *    （报 “Class CardPlay incorrectly extends base class Component”）。CardData 两边都 import，安全。
 */
const _enhancedPlays = new Set<string>();

export function markEnhancedThisPlay(side: string, cardId: string): void {
    try { _enhancedPlays.add(side + ':' + cardId); } catch (e) { /* 忽略 */ }
}

export function consumeEnhancedThisPlay(side: string, cardId: string): boolean {
    const key = side + ':' + cardId;
    if (!_enhancedPlays.has(key)) return false;
    _enhancedPlays.delete(key);
    return true;
}

// ====================== 毁灭 / 多次攻击 查询 ======================

/** ★ 一张卡是否带【毁灭】（关键字）。 */
export function hasBaneKeyword(cardId: string | null | undefined): boolean {
    if (!cardId) return false;
    try {
        return getCardAbilityKeywords(cardId).indexOf('Bane') >= 0
            || getCardAbilities(cardId).some((a) => (a as { name?: string }).name === 'Bane');
    } catch (e) { return false; }
}

/** ★ 一张卡一回合最多能攻击几次（没有 MultiAttack ⇒ 1）。 */
export function maxAttacksOf(cardId: string | null | undefined): number {
    if (!cardId) return 1;
    let best = 1;
    try {
        for (const a of getCardAbilities(cardId)) {
            const inv = a as { name?: string; params?: { times?: unknown } };
            if (inv.name === 'MultiAttack') {
                const n = Math.max(1, Math.floor(Number(inv.params?.times) || 1));
                if (n > best) best = n;
            }
        }
    } catch (e) { /* 忽略 */ }
    return best;
}

// ====================== 爆能强化 / 屏障 查询 ======================

/** ★ 一张卡的全部**爆能强化数值**（升序；没有则空数组）。 */
export function enhanceValuesOf(cardId: string | null | undefined): number[] {
    if (!cardId) return [];
    const out: number[] = [];
    try {
        for (const a of getCardAbilities(cardId)) {
            const inv = a as { name?: string; params?: { value?: unknown } };
            if (inv.name === 'Enhance') {
                const v = Math.max(0, Math.floor(Number(inv.params?.value) || 0));
                if (v > 0 && out.indexOf(v) < 0) out.push(v);
            }
        }
    } catch (e) { /* 忽略 */ }
    return out.sort((x, y) => x - y);
}

/** ★ 一张卡的最大爆能强化值（0 = 没有爆能强化）。 */
export function maxEnhanceOf(cardId: string | null | undefined): number {
    const v = enhanceValuesOf(cardId);
    return v.length > 0 ? v[v.length - 1] : 0;
}

/** ★ 一张卡是否自带【屏障】（关键字）。 */
export function hasBarrierKeyword(cardId: string | null | undefined): boolean {
    if (!cardId) return false;
    try {
        return getCardAbilityKeywords(cardId).indexOf('屏障') >= 0
            || getCardAbilities(cardId).some((a) => (a as { name?: string }).name === 'Barrier');
    } catch (e) { return false; }
}

// ====================== 协作（Cooperation）查询 ======================

/**
 * ★ **某张卡的协作需求值**：递归扫它的能力，取最大的 Cooperation.threshold；没有则 0。
 * 供说明卡片显示「协作(x/n)」与手牌黄色光圈判定用。
 */
export function cooperationRequirementOf(cardId: string | null | undefined): number {
    if (!cardId) return 0;
    let best = 0;
    const visit = (inv: unknown, depth: number): void => {
        if (!inv || depth > 4) return;
        const arr = Array.isArray(inv) ? inv : [inv];
        for (const raw of arr) {
            const a = raw as { name?: string; params?: Record<string, unknown> };
            if (!a || typeof a !== 'object') continue;
            if (a.name === 'Cooperation') {
                const n = Math.max(0, Math.floor(Number(a.params?.threshold) || 0));
                if (n > best) best = n;
            }
            const p = a.params || {};
            visit(p.effect, depth + 1);
            visit(p.effects, depth + 1);
            visit(p.otherwise, depth + 1);
            visit(p.options, depth + 1);
        }
    };
    try { visit(getCardAbilities(cardId), 0); } catch (e) { /* 忽略 */ }
    return best;
}

// ====================== 查询函数 ======================

/**
 * 通过卡牌 id（卡图资源名字）查询卡牌信息。
 * @param id 卡牌唯一 id，对应 CardMap 的 key
 * @returns 找到返回 CardInfo；未找到返回 undefined
 */
export function getCardInfo(id: string): CardInfo | undefined {
  return CardMap[id];
}

/**
 * 返回所有卡牌信息数组（遍历整张映射表）。
 */
export function getAllCards(): CardInfo[] {
  return Object.values(CardMap);
}

/** 归一化一条能力配置；名字不在名字表里时返回 null。 */
export function normalizeCardAbility(grant: CardAbilityGrant): CardAbilityInvocation | null {
  if (typeof grant === 'string') {
    return hasAbilityName(grant) ? { name: grant } : null;
  }
  if (!grant || typeof grant !== 'object') return null;
  const name = (grant as CardAbilityInvocation).name;
  if (!hasAbilityName(name)) return null;
  const params = (grant as CardAbilityInvocation).params;
  return {
    name,
    params: params && typeof params === 'object' ? { ...params } : undefined,
  };
}

/** 某张卡配置的全部合法能力（未登记卡牌 / 非法名字会被过滤）。 */
export function getCardAbilities(id: string): CardAbilityInvocation[] {
  const info = getCardInfo(id);
  const out: CardAbilityInvocation[] = [];
  for (const grant of info?.abilities || []) {
    const ability = normalizeCardAbility(grant);
    if (ability) out.push(ability);
  }
  return out;
}

/** 某张卡能力集合中，按名字表静态授予的卡牌词条（如 Rush / Charge）。 */
export function getCardAbilityKeywords(id: string): string[] {
  const out = new Set<string>();
  for (const ability of getCardAbilities(id)) {
    const meta = CARD_ABILITY_MAP[ability.name] as {
      keywords?: readonly string[];
    };
    for (const keyword of meta.keywords || []) out.add(keyword);
  }
  return [...out];
}

/** 运行期判断一个字符串是否是能力名字表里的合法名字。 */
export function hasAbilityName(name: unknown): name is CardAbilityName {
  return typeof name === 'string'
    && Object.prototype.hasOwnProperty.call(CARD_ABILITY_MAP, name);
}

/**
 * 判断卡牌是否为随从（Follower）——随从才拥有 hp / attack，其余类型这两项应为 null。
 * @param info 卡牌信息
 */
export function isFollower(info: CardInfo): boolean {
  return info.cardType === 'Follower';
}

// ====================== 卡框资源名推导 ======================

/**
 * 随从专用卡框的**手牌版**资源名前缀。
 * 手牌版把攻击/血量徽记从下边框外移进左侧竖栏（攻击在上、血量在下），
 * 因此手牌排布时不会有「徽记挂在下边框之外」导致的对齐问题。
 */
export const HAND_FOLLOWER_PREFIX = 'Hand';

/**
 * 按「品质 + 类型」推导卡框资源名（与品质一一对应，不谈单张卡的特殊情况）。
 *   · Follower → `Hand<品质>Follower.png`   （手牌版随从框）
 *   · Amulet   → `<品质>Amulet.png`
 *   · Spell    → `<品质>Spell.png`
 * @param quality  卡牌品质
 * @param cardType 卡牌类型
 */
export function deriveCardFrame(quality: CardQuality, cardType: CardType): string {
  if (cardType === 'Follower') return `${HAND_FOLLOWER_PREFIX}${quality}Follower.png`;
  return `${quality}${cardType}.png`;
}

/**
 * 取一张卡在**手牌区**实际应使用的卡框资源名。
 * 完全由 quality + cardType 推导（= deriveCardFrame），保证卡框只有一个数据来源。
 * @param info 卡牌信息（只需 quality / cardType）
 */
export function resolveCardFrame(info: Pick<CardInfo, 'quality' | 'cardType'>): string {
  return deriveCardFrame(info.quality, info.cardType);
}

// ====================== 战场卡框资源名推导 ======================

/**
 * 战场卡框在本工程资源库里的登记前缀。
 *
 * 为什么需要：`BattleField/` 目录里的护符框与手牌区护符框**同名**（都是 SilverAmulet.png 等），
 * 但两者几何不同（战场版去掉了左上绿费用圈，铜/金框因此更窄），布局必须分别登记。
 * 故战场框统一以 `BF_<原名>` 登记（见 CardLayout.ts 与场景 PlayerBattleFieldArea/EnemyBattleFieldArea 上的 CardComposer）。
 */
export const BATTLEFIELD_FRAME_PREFIX = 'BF_';

/**
 * 取卡框资源名里的**纯文件名**（丢掉目录部分）：把「资源路径」归一化成「资源名」。
 * 支持 `'frame/HandLegendaryFollower.png'`、`'BattleField\\GoldAmulet.png'`、
 * `'db://assets/image/cards/frame/HandGoldFollower.png'` 等写法；已是纯文件名则原样返回。
 *
 * 意义：`CardInfo.cardImage` 与 `composeCard` 的 `frameOverride` 都允许写成资源路径，
 * 归一化后才能在贴图库里命中；也保证按名字查 `CardLayouts` 时不会因为带目录而落空。
 */
export function frameBasename(frame: string): string {
  if (!frame) return '';
  let s = String(frame).trim();
  s = s.replace(/^db:\/\//i, '');     // 资源 URL 前缀
  s = s.replace(/[?#].*$/, '');       // 丢掉可能的查询串
  const parts = s.split(/[\\/]+/);    // 兼容 / 与 \
  const last = parts[parts.length - 1];
  return last && last.length > 0 ? last : s;
}

/**
 * 手牌版随从框 → 原版随从框：`'HandLegendaryFollower.png'` → `'LegendaryFollower.png'`。
 *
 * 手牌版把攻击/血量徽记搬进了**左侧竖栏**；战场用的原版框把两枚徽记**悬挂在下边框之外**，
 * 两者不可混用。它们是同一套美术的两种排布，故只差一个 `Hand` 前缀。
 * 已经是原版（无 Hand 前缀）、或前缀后不是合法品质时，原样返回。
 */
export function toPlainFollowerFrame(frame: string): string {
  const base = frameBasename(frame);
  if (!base.startsWith(HAND_FOLLOWER_PREFIX)) return base;
  const rest = base.slice(HAND_FOLLOWER_PREFIX.length);
  // 仅当去掉前缀后确实是「<合法品质>Follower.png」才转换，避免误伤别的以 Hand 开头的名字
  const m = /^([A-Za-z]+)Follower\.png$/i.exec(rest);
  if (m && (CARD_QUALITIES as readonly string[]).indexOf(m[1]) >= 0) return rest;
  return base;
}

/**
 * 按「品质 + 类型」推导**战场**卡框资源名（统一带 BF_ 前缀）。
 *
 * 与手牌同源：先取手牌框（deriveCardFrame），再依次
 *   ① 随从：手牌版 Hand<品质>Follower.png → 原版 <品质>Follower.png（toPlainFollowerFrame）
 *   ② 加 `BF_` 前缀
 *
 * 例：Legendary 随从 'HandLegendaryFollower.png' → 'LegendaryFollower.png' → 'BF_LegendaryFollower.png'
 *     Silver 护符    'SilverAmulet.png'          → 不变             → 'BF_SilverAmulet.png'
 *
 * 注：本函数只管「名字换算」，不管「能不能上战场」。法术的战场框不存在，
 *     是否允许上场由 BattleFieldLayout 判定（Spell 一律拒绝）。
 */
export function deriveBattleFieldFrame(quality: CardQuality, cardType: CardType): string {
  const hand = deriveCardFrame(quality, cardType);
  const plain = cardType === 'Follower' ? toPlainFollowerFrame(hand) : hand;
  return `${BATTLEFIELD_FRAME_PREFIX}${plain}`;
}

/**
 * 取一张卡在**战场**上实际应使用的卡框资源名（带 BF_ 前缀，可直接查 CardLayouts）。
 * @param info 卡牌信息（只需 quality / cardType）
 */
export function resolveBattleFieldFrame(info: Pick<CardInfo, 'quality' | 'cardType'>): string {
  return deriveBattleFieldFrame(info.quality, info.cardType);
}

// ====================== 运行期数据自检 ======================

/**
 * 校验整张卡表的字段类型与业务规则，便于在 Creator 编辑器/启动期尽早发现问题。
 * 检查项：
 *   1. quality / cardType 必须落在合法枚举集合内（类型错乱会被捕获）；
 *   2. cost 必须是非负数字；
 *   3. 随从(Follower)的 hp / attack 必须是数字（不允许为 null，取值允许 0 / 负数）；
 *   4. 非随从(Amulet / Spell)的 hp / attack 必须为 null（不允许填 0 或其它数字）。
 *
 * 说明：**不再校验卡框** —— 卡框已不再存字段，一律由 quality + cardType 推导，
 * 手牌与战场共用同一份枚举，没有第二处可以写错的地方。
 * @returns 全部通过返回 true；存在违规返回 false（同时会在控制台打印告警）。
 */
export function validateCardData(): boolean {
  const qualitySet = CARD_QUALITIES;
  const typeSet: readonly CardType[] = ['Amulet', 'Follower', 'Spell'];
  let ok = true;

  for (const [id, c] of Object.entries(CardMap)) {
    // 2) 品质 / 类型合法性
    if (!qualitySet.includes(c.quality)) {
      console.warn(`[CardData] id=${id} 品质非法: "${c.quality}"（应为 Bronze/Gold/Silver/Legendary）`);
      ok = false;
    }
    if (!typeSet.includes(c.cardType)) {
      console.warn(`[CardData] id=${id} 类型非法: "${c.cardType}"（应为 Amulet/Follower/Spell）`);
      ok = false;
    }

    // 3) 费用非负
    if (typeof c.cost !== 'number' || c.cost < 0) {
      console.warn(`[CardData] id=${id} 费用非法: ${c.cost}（应为非负数字）`);
      ok = false;
    }

    // 4) hp / attack 规则（随从必须数字，非随从必须 null）
    if (c.cardType === 'Follower') {
      if (typeof c.hp !== 'number' || typeof c.attack !== 'number') {
        console.warn(
          `[CardData] id=${id} 随从的 hp/attack 必须是数字（允许 0 或负数），当前 hp=${c.hp} attack=${c.attack}`
        );
        ok = false;
      }
    } else {
      if (c.hp !== null || c.attack !== null) {
        console.warn(
          `[CardData] id=${id} 非随从类型(Amulet/Spell)的 hp/attack 必须为 null，当前 hp=${c.hp} attack=${c.attack}`
        );
        ok = false;
      }
    }

    if (c.keywords !== undefined && !Array.isArray(c.keywords)) {
      console.warn(`[CardData] id=${id} keywords 必须是字符串数组或留空`);
      ok = false;
    }

    if (c.abilities !== undefined && !Array.isArray(c.abilities)) {
      console.warn(`[CardData] id=${id} abilities 必须是能力数组或留空`);
      ok = false;
      continue;
    }
    for (const raw of c.abilities || []) {
      const ability = normalizeCardAbility(raw);
      if (!ability) {
        console.warn(`[CardData] id=${id} abilities 中存在未知能力：${JSON.stringify(raw)}`);
        ok = false;
        continue;
      }
      const meta = CARD_ABILITY_MAP[ability.name] as {
        trigger: CardAbilityTrigger;
      };
      if (ability.params !== undefined
          && (!ability.params || typeof ability.params !== 'object' || Array.isArray(ability.params))) {
        console.warn(`[CardData] id=${id} 能力 ${ability.name} 的 params 必须是对象`);
        ok = false;
      }
      if (ability.name === 'DrawCards') {
        const count = Number(ability.params?.count);
        if (!Number.isFinite(count) || Math.floor(count) !== count || count <= 0) {
          console.warn(`[CardData] id=${id} 能力 DrawCards 需要 params.count 为正整数，当前 ${JSON.stringify(ability.params)}`);
          ok = false;
        }
      }
      if (ability.name === 'DistributeDamage') {
        const amount = Number(ability.params?.amount);
        const fromAttack = ability.params?.amountFrom === 'attack';
        if (!fromAttack && (!Number.isFinite(amount) || Math.floor(amount) !== amount || amount <= 0)) {
          console.warn(`[CardData] id=${id} 能力 DistributeDamage 需要 params.amount 为正整数，`
            + `或 params.amountFrom='attack'，当前 ${JSON.stringify(ability.params)}`);
          ok = false;
        }
      }
      if (CARD_ABILITY_TRIGGERS.indexOf(meta.trigger) < 0) {
        console.warn(`[CardData] id=${id} 能力 ${ability.name} 的 trigger 非法：${meta.trigger}`);
        ok = false;
      }
    }
  }

  if (ok) {
    console.log(`[CardData] 卡表自检通过：共 ${Object.keys(CardMap).length} 张卡牌。`);
  }
  return ok;
}
