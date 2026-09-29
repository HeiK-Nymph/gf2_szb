/**
 * 卡牌 / 纹章「说明数据表」（对战时点开说明卡片的内容来源）
 * ============================================================================
 * 纯 TS 数据文件，**不 import 'cc'**，可在编辑器与运行时直接使用。
 *
 * ── 设计口径（🔴 重要）────────────────────────────────────────────────────
 *   · 这里**只有手写文案**，运行期**不生成**任何说明文字 —— 一条说明就是一个
 *     「能力 + 能力描述」的**说明对象**（`TipAbilityItem`），描述想怎么写就怎么写；
 *   · **费用 / 攻击 / 血量 / 卡名不在这里写** —— 它们由 `CardData.CardMap` 唯一提供
 *     （说明卡片只负责「能力那一段文字」），避免同一条信息有两处可以写歪；
 *   · **纹章没有独立的表**：纹章 id = 卡牌 id，说明直接复用那张卡条目里的 `crest`
 *     字段（`getCrestTip(id)` = `CARD_TIP_DATA[id].crest`），一份数据两处用。
 *
 * ── 一个「说明项」的四种形态 ──────────────────────────────────────────────
 *   ① 只有能力、没有描述：        { ability: '守护' }
 *      显示为 →  【守护】
 *   ② 有能力 + 能力描述：         { ability: '入场曲', desc: '使自己获得『纹章：…』。' }
 *      显示为 →  【入场曲】使自己获得『纹章：…』。
 *   ③ **只有描述、没有能力**：     { desc: '这只是一段补充说明。' }
 *      显示为 →  这只是一段补充说明。（**不带【】**、正文色；里面的登记关键字仍会高亮）
 *   ④ 主能力 + 副能力（最多两层，副能力不再有 subs）：
 *      { ability: '入场曲', desc: '此随从获得', subs: [{ ability: '守护' }] }
 *      显示为 →  【入场曲】此随从获得【守护】
 *      一个主能力可以有**多个**副能力，它们按数组顺序接在描述之后。
 *      （副能力同样允许只写 `desc` 不写 `ability`。）
 *
 * ── 关键字高亮 ────────────────────────────────────────────────────────────
 *   · 每个说明项的**能力名**（含副能力名）**永远高亮**；
 *   · 描述文字里出现的、登记在 `TIP_KEYWORD_DESC` 里的词也**自动高亮**
 *     （例：描述里写「获得『纹章：缜密之思』」→「纹章」二字会被染色）。
 *     🔴 高亮词与「能力详情」说明**共用这一张表**（key 即高亮词全集）——
 *     想加/减要高亮的词，直接改 `TIP_KEYWORD_DESC` 即可（无需改代码，也不会两处写歪）。
 *
 * ── 改完怎么生效 ──────────────────────────────────────────────────────────
 *   本文件是**运行时**读取的数据表 → 改完 `.ts` 后 `cocos_asset refresh` 重新编译
 *   即可（不需要动场景）。
 * ============================================================================
 */

// ============================================================================
// 结构定义
// ============================================================================

/** 副能力（第二层）：只有名字与可选描述，**不再有 subs**（最多两层）。 */
export interface TipSubAbility {
    /**
     * 副能力名（显示为【名字】，自动高亮）。
     * 🔴 **可省略** —— 省略时这一条只显示 `desc`（不带【】框、不当作能力名）。
     */
    ability?: string;
    /** 副能力的描述（可选） */
    desc?: string;
}

/** 一条说明项 = 一个能力 +（可选）能力描述 +（可选）若干副能力。 */
export interface TipAbilityItem {
    /**
     * 能力名（显示为【名字】，自动高亮）。
     * 🔴 **可省略** —— 省略时这一条就是**纯描述**：只渲染 `desc` 那段话，
     *     不带【】、不染色成关键字色（描述里出现的登记关键字仍会高亮）。
     *     ⚠️ `ability` 和 `desc` **必须至少给一个**，两个都空 = 这一条不显示（自检会告警）。
     */
    ability?: string;
    /** 能力描述（可选：如【守护】就没有描述） */
    desc?: string;
    /** 副能力（可选，最多一层） */
    subs?: TipSubAbility[];
}

/** 一枚纹章的说明数据。 */
export interface CrestTipInfo {
    /**
     * 纹章 id（= 卡牌 id，如 `'4.png'`）。留空则用查表时的 key。
     * 用途：在说明卡片里显示这枚纹章的**图标**（复用纹章区里已经放好的贴图）。
     */
    id?: string;
    /** 纹章的中文名（显示在「纹章」栏；留空则退回 `CrestEffects.crestNameOf`） */
    name?: string;
    /** 说明项列表（顺序 = 显示顺序） */
    items: TipAbilityItem[];
}

/** 单张卡牌的说明数据。 */
export interface CardTipInfo {
    /** 说明项列表（顺序 = 显示顺序）。这张卡没有任何能力 → 写 `[]` */
    items: TipAbilityItem[];
    /**
     * （可选）这张卡**对应的纹章**说明 —— 有它时，说明卡片会在最下方多出一个
     * 「纹章」子框（图标 + 名字 + 它的说明项），形如例图里卡牌下方的纹章框。
     *
     * 🔴 **纹章没有独立的表**：纹章 id = 卡牌 id，所以点纹章时直接复用
     *    `CARD_TIP_DATA[该纹章 id].crest`（见 `getCrestTip`），一份数据两处用。
     */
    crest?: CrestTipInfo;
}

// ============================================================================
// 关键字表（🔴 **一张表两个用途**：描述文字自动高亮 + 「能力详情」说明）
// ============================================================================

/**
 * 关键字 → 一句话说明。
 *
 * ── 用途 ─────────────────────────────────────────────────────────────────
 *   ① **高亮**：描述文字里出现表里的词 → 自动染色加粗（匹配口径「先长后短」，
 *      如同时命中「超进化」与「进化」，优先按「超进化」处理）；
 *   ② **能力详情**：点开某张卡 / 某枚纹章的**说明卡片**后，里面所有**黄字关键字**
 *      （【入场曲】【守护】… 以及描述文字里高亮出来的词）都**可以点**：点其中任意一个，
 *      都会弹出**同一张**居中的「能力详情」卡片 —— 它按**出现顺序**列出
 *      **当前说明卡片里的全部关键字**及各自的说明（不是只列出被点的那个）。
 *
 * 🔴 **只有这一张表**：关键字名不再单独维护第二份清单（原 `TIP_KEYWORDS` 已删除）——
 *    表的 key 就是「要高亮的词」全集，加词 / 删词只改这里，高亮与详情同时生效、不会写歪。
 *
 * ── 写法 ─────────────────────────────────────────────────────────────────
 *   · key = 关键字原文，必须与能力名（`CARD_ABILITY_MAP.displayName`）里的字面量
 *     **完全一致**（详情卡片按这个 key 查表；查不到的条目会被跳过并告警）；
 *   · value = 面向玩家的一句话说明（**纯文本**：会按 `detailFontSize` 自动换行，
 *     不要写 `<color>` 之类的富文本标签）。
 *
 * 想给某个关键字补 / 改说明，只改这一张表即可（无需动界面代码）。
 */
export const TIP_KEYWORD_DESC: Record<string, string> = {
    '纹章': '将被放置于战场以外的特殊区域。\n最多可以放置5个，无法重复放置同名纹章。',
    '吟唱': '自己的回合开始时，倒计数-1。当倒计数变为0时，会被破坏。',
    '入场曲': '从手牌中使用后进入战场时发动的能力。',
    '守护': '对手的随从只能攻击拥有守护能力的随从。',
    '突进': '在进入战场的回合也能攻击随从的能力。',
    '疾驰': '在进入战场的回合也能进行攻击的能力。',
    '威慑': '拥有威慑的随从无法被对手的随从普通攻击。',
    '超进化时': '使用超进化点超进化时发动的能力。',
    '进化时': '使用进化点进化时，或使用超进化点超进化时发动的能力。',
    '分配伤害': '将不大于随从生命值的伤害从更早出场的随从开始分配。\n当最后的随从被分配完之后伤害仍有剩余时，若伤害对象包含主战者，则剩余伤害分配给主战者；若伤害对象不包含主战者，则剩余伤害分配给最后的随从。\n即使随从变身，分配伤害的顺序也不会发生变化。',
    '潜行':'不会被对方的能力选中，且不会被对方随从攻击的能力。\n进行攻击时，或是拥有潜行的随从通过能力造成伤害时，将失去潜行。',
    '奥义':'奥义槽为10或以上时发动的能力。\n奥义槽是指“现在的回合数”和“在手牌中时自己的随从的进化次数”的合计。',
    '解放奥义':'奥义槽为15或以上时发动的能力。\n奥义槽是指“现在的回合数”和“在手牌中时自己的随从的进化次数”的合计。',
    '启动':'1回合仅限1次，拥有启动能力的护符可通过按下卡牌详情中的“启动”按钮，发动能力。\n还有部分启动能力会指定启动所需的费用，若自己剩余的能量点为指定值或以上，则消耗相应的能量点后发动能力。',
    '召唤':'将卡牌从手牌或牌组移动至战场上，或是在战场上生成卡牌。\n从手牌或牌组召唤卡牌时，召唤的卡牌数无法超过战场上的卡牌数量上限。\n生成卡牌并召唤时，超过战场上的卡牌数量上限的卡牌不会进入战场，也不会增加墓场数量。',
    '模式':'从多个能力中选择指定数量的能力并发动。\n可选择能力的发动条件尚未满足的模式，但其能力不会发动。',
    '谢幕曲':'卡牌被破坏时，发动能力。\n消失或变身时不会发动。',
    '协作':'表示本次对战中进入战场的自己的随从张数。\n有的能力需要协作为指定值或以上时才会发动。',
    '爆能强化':'使用拥有爆能强化的卡牌时，若自己剩余的能量点在指定数值或以上，则消耗与爆能强化（而非费用）相同数值的能量点，发动能力。\n若拥有复数个爆能强化，则消耗与最大爆能强化相同数值的能量点，发动该数值和以下的所有爆能强化。',
    '屏障':'拥有屏障的随从或主战者受到伤害时，将伤害变为0的能力。屏障在发动1次之后失效。',
    '毁灭':'因进行攻击或被攻击对对手的随从造成伤害时，破坏对手的随从的能力。\n即使攻击力为0，或因对手的能力导致造成的伤害变为0，毁灭能力依然会发动。',
    '交战时':'在攻击随从或是被随从攻击时，发动能力。\n在攻击主战者时不会发动。\n能力将在互相造成伤害前发动。',
    '灵气':'不会被对手的能力选中。',
};

// ============================================================================
// 卡牌说明数据表（key = 卡牌 id = CardData.CardMap 的 key = 卡图资源名）
// ============================================================================

/**
 * 🔴 每条 `desc` 都是**手写文案**，请按需要直接改；表里没有的卡牌
 *    （或 items 为空）→ 说明卡片只显示顶部（费用 / 卡名 / 攻击 / 血量），没有能力段。
 */
export const CARD_TIP_DATA: Record<string, CardTipInfo> = {

    // ── 「冷静备战」（铜框法术，费用 1）──────────────────────────────────
    // 玩法数据：abilities = [DrawCards{count:1}]
    '1.png': {
        items: [
            { desc: '对对手场上随机一个随从造成2点伤害。抽取 1 张随从。\n协作数 +1' },
        ],
    },

    // ── 「全力突围·可露凯」（传说随从，费用 5）──────────────
    // 玩法数据：abilities = [Evolve{ effect: DistributeDamage{ amountFrom:'attack', side:'opponent' } }]
    // 🔴 伤害总量 = **该随从进化后的攻击力**（进化先加数值、动画播完才结算能力）。
    '2.png': {
        items: [
            {
                ability: '入场曲',
                desc: '召唤随机1个自己的牌组中费用为3或以下的随从。',
            },
            {
                ability: '进化时',
                desc: '按入场顺序从早到晚，对敌方战场上的随从分配本随从攻击力点伤害。',
            },
        ],
    },

    // ── 「精心的维护」（白银护符，费用 2）────────────────────────────────
    // 玩法数据：abilities = [Chant{turns:4}, FriendlyFollowerEnterBuff{keywords:[Rush], attack:2, hp:2}]
    '3.png': {
        items: [
            {
                // 🔴 「吟唱_4」里的 4 必须与卡表里 Chant 的 turns 保持一致。
                //    咏唱倒数结束**一定**会破坏自身（内建逻辑，见 CardKeywordSystem
                //    的 tickChantsForCurrentTurn）→ **不用**再额外写「破坏自身」这条说明。
                ability: '吟唱_4',
                desc: '己方随从进入战场时获得 +2/+0 和',
                subs: [{ ability: '突进' }],
            },
            
        ],
    },

    // ── 「奔走的狙击手·夏安」（传说随从，费用 7，攻 4 / 血 4）────────────
    // 玩法数据：abilities = [Ambush,
    //                       Fanfare{select:'enemyFollower', action:'destroy'},
    //                       SuperEvolve{effects:[Fanfare, GainCrest]}]
    '4.png': {
        items: [
            {
                ability: '潜行',
            },
            {
                ability: '入场曲',
                desc: '选择对方战场上的一个随从，破坏该随从。',
            },
            {
                ability: '超进化时',
                desc: '发动一次【入场曲】。使自己获得『纹章：缜密之思』。',
            },
        ],
        // 卡牌下方的「纹章」子框（形如例图）
        crest: {
            id: '4.png',
            name: '缜密之思',
            items: [
                {desc: '我方回合时触发一次，当对方随从被破坏时对敌方方主战者造成2点伤害。' },
                {desc: '我方回合结束时，随机破坏对方战场上一个随从。' },
            ],
        },
    },

    // ── 「高油温防护·塞布丽娜」（白银随从，费用 4，攻 4 / 血 5）────────────
    // 玩法数据：abilities = [Guard,
    //                       Evolve{select:'enemyFollower', filter:'damaged', action:'destroy'}]
    '5.png': {
        items: [
            {
                ability: '守护',
            },
            {
                ability: '进化时',
                desc: '选择对手的战场上的1个受伤的随从，破坏该随从。',
            },
        ],
    },
    // ── 「异相浅眠·米什缇」（**虹卡**随从，费用 3，攻 0 / 血 3）────────────
    // 玩法数据：abilities = [Ambush,
    //                       TurnEnd{effects:[RandomDamage{select:'enemyFollower', amount:3}, Ambush]},
    //                       Evolve{effects:[BuffFriendlyFollowers{attack:1, hp:1}]}]
    // 🔴 第 2 条是**纯描述**（没写 ability）—— 它的能力名由实现侧定（TurnEnd，触发时机 = 自己这一方的操作回合结束）。
    '6.png': {
        items: [
            {
                ability: '潜行',
            },
            {
                desc: '我方回合结束时，随机对敌方战场上的一个随从造成3点伤害。本随从获得【潜行】',
            },
            {
                ability: '进化时',
                desc: '使我方场上所有随从获得+2/+2',
            },
        ],
    },
    // ── 「钢铁穹顶」（白银**法术**，费用 1）──────────────────────────────
    // 玩法数据：abilities = [SelectTarget{select:'friendlyFollower', filter:'guard',
    //                          effects:[BuffSelected{attack:0, hp:1},
    //                                   RandomDamage{select:'enemyFollower', amountFrom:'selectedHp'}]}]
    // 🔴 纯描述（没写 ability）—— 目标选择走 `CardPlay` 的「先选目标」流程（与随从入场曲同一套逻辑：
    //    卡先停到摄像头左上角 → 选择模式 → 选中才结算，点其它地方则回手牌 + 退费）。
    // 🔴 描述里的 `【守护】` = 描述内联关键字高亮（与 ability 同款：括号一起染色、可点弹详情）。
    // 🔴 X = 所选随从**加完 +1 之后的当前血量**（内嵌效果按书写顺序结算：先 +0/+1，再取 X）。
    '7.png': {
        items: [
            {
                desc: '选择自己的战场上的1个拥有【守护】的随从，使其+0/+1。对对手的战场上的随机1个随从造成X点伤害。X为选择的随从的生命值。',
            }
        ],
    },
    '8.png': {
        items: [
            {
                desc: '费用1【启动】选择自己的战场上的1个随从，使其+1/+1。回复自己的主战者1点生命值。',
            },
        ],
    },
    '9.png': {
        items: [
            {
                ability: '入场曲',
            },
            {
                desc: '【模式】选择1个能力发动。\n（1）本随从获得【疾驰】。\n（2）本随从获得【守护】。对对手的战场上的所有随从造成8点伤害。',
            },
            
        ],
    },
    '10.png': {
        items: [
            {
                ability: '入场曲',
                desc: '选择对手的战场上的1个随从，使其消失。回复自己的主战者3点生命值。',
            },
            {
                ability: '守护',
            },
            {
                ability: '超进化时',
                desc: '发动与【入场曲】相同的能力。',
            },
        ],
    },
    '11.png': {
        items: [
            {
                desc: '本随从在战场上获得攻击力或生命值增加时，自己的每回合中可触发1次，召唤1个自巡炮。',
            },
            {
                ability: '谢幕曲',
                desc: '将1张自巡炮加入手牌。',
            },
        ],
    },
    '12.png': {
        items: [
            {
                ability: '突进',
            },
        ],
    },
    '13.png': {
        items: [
            {
                ability: '入场曲',
                desc: '选择对手的战场上的1个随从，破坏该随从。使自己的战场上的其他所有随从+1/+1。',
            },
            {
                ability: '守护',
            },
            {
                ability: '疾驰',
            },
        ],
    },
    '14.png': {
        items: [
            {
                desc: '召唤随机1个自己的牌组中费用为3或以下的随从。召唤随机1个自己的牌组中费用为2或以下的随从。使自己的战场上的所有随从+1/+1。',
            },

        ],
    },
    '15.png': {
        items: [
            {
                ability: '入场曲',
                desc: '选择对手的战场上的1个随从，对其造成4点伤害。【协作_10】改为对对手的战场上的所有随从造成4点伤害。',
            },
            {
                ability: '超进化时',
                desc: '本随从获得【疾驰】。',
            },
            {
                ability: '谢幕曲',
                desc: '使自己获得『纹章：恶兆成谶·维克托』。',
            },
        ],
        crest: {
            id: '15.png',
            name: '恶兆成谶·维克托',
            items: [
                {
                    ability: '吟唱_2',
                },
                {
                    ability: '谢幕曲',
                    desc: '将1张『恶兆成谶·维克托』加入手牌',
                },
            ],
        },
    },
    '16.png': {
        items: [
            {
                ability: '爆能强化_8',
                desc: '抽取1张费用为7或以上的随从。回复自己7点能量点。',
            },
            {
                ability: '屏障',
            },
        ],
    },
    '17.png': {
        items: [
            {
                ability: '入场曲',
                desc:'【协作_20】消失对手场上所有卡牌'
            },
            {
                ability: '疾驰',
            },
            {
                ability: '毁灭',
            },
            {
                ability: '守护',
            },
            {
                desc: '1回合可以攻击3次',
            },
        ],
    },
    '18.png': {
        items: [
            {
                ability: '灵气',
            },
            {
                desc:'不会被能力破坏。'
            },
            {
                ability: '交战时',
                desc:'破坏交战对手。'
            },
            {
                ability: '超进化时',
                desc:'本随从获得「1回合可以攻击3次」。'
            },
        ],
    },
    '19.png': {
        items: [
            {
                ability: '入场曲',
                desc:'召唤3个游猎前锋'
            },
            {
                ability: '疾驰',
            },
            {
                ability: '毁灭',
            },
            {
                desc:'自己的随从进入战场时，使其+2/+0且获得【突进】。本随从+1/+0。'
            },
            {
                ability: '超进化时',
                desc:'召唤1个游猎前锋'
            },
        ],
    },
    // 游猎前锋，0费1攻1血铜卡随从
    '20.png': {
        items: [

        ],
    },
    '21.png': {
        items: [
            {
                ability: '入场曲',
                desc:'使双方战场上的其他所有随从消失。使双方战场上的所有护符消失。'
            },
        ],
    },
    // 曼尼安保，1费2攻2血铜卡随从
    '22.png': {
        items: [

        ],
    },
    // 无音的包围，1费银卡法术
    '23.png': {
        items: [
            {
                desc:'将1张『曼尼安保』加入手牌，使其获得【突进】。【协作_10】改为2张。'
            },
        ],
    },
    // 战场通讯员,3费2攻3血铜卡随从
    '24.png': {
        items: [
            {
                ability: '入场曲',
                desc:'召唤1个『游猎前锋』。将1张『曼尼安保』加入手牌。'
            },
        ],
    },
    // 激进的榴弹兵，2费2攻1血银卡随从
    '25.png': {
        items: [
            {
                ability: '谢幕曲',
                desc:'召唤1个『游猎前锋』'
            },
            {
                ability: '进化时',
                desc:'选择对手的战场上的1个随从，对其造成3点伤害。'
            },
        ],
    },
    // 重炮圣盾，5费4攻4血虹卡随从
    '26.png': {
        items: [
            {
                ability: '入场曲',
                desc:'召唤1个『重炮圣盾』。【协作_20】对对手的主战者造成4点伤害。'
            },
            {
                ability: '突进',
            },
            {
                ability: '进化时',
                desc:'发动2次「对对手的战场上的随机1个随从造成4点伤害」。'
            },
        ],
    },
    // 御导圣盾，6费6攻6血金卡随从
    '27.png': {
        items: [
            {
                ability: '入场曲',
                desc:'对对手的战场上的所有随从造成4点伤害。'
            },
            {
                ability: '爆能强化_8',
                desc:'本随从超进化。'
            },
        ],
    },
    // 骇人的轰炸，5费金卡法术
    '28.png': {
        items: [
            {
                desc:'破坏敌方场上最大攻击力的随从。抽两张牌。'
            },
            {
                ability: '爆能强化_10',
                desc:'对对手的战场上的所有随从造成4点伤害。'
            },
        ],
    },
    // 第二战场·猛犸，7费5攻7血虹卡随从
    '29.png': {
        items: [
            {
                ability: '入场曲',
                desc:'召唤2个『曼尼安保』。使自己的战场上的其他所有随从+1/+3且获得【守护】。'
            },
            {
                ability: '守护',
            },
            {
                ability: '超进化时',
                desc:'选择对手的战场上的1个随从，破坏该随从。'
            },
        ],
    },
    // 分队长，5费3攻2血金卡随从
    '30.png': {
        items: [
            {
                ability: '入场曲',
                desc:'召唤3个『游猎前锋』。使自己的战场上的其他所有随从+1/+0且获得【突进】。'
            }
        ],
    },
    // 复合哨兵，5费2攻3血银卡随从
    '31.png': {
        items: [
            {
                ability: '入场曲',
                desc:'抽取2张卡牌。召唤2个『游猎前锋』。'
            },
            {
                ability: '进化时',
                desc:'选择对手的战场上的1个随从，对其造成3点伤害。'
            },
        ],
    },
    // 烈日魔犬，4费3攻2血虹卡随从
    '32.png': {
        items: [
            {
                ability: '入场曲',
                desc:'召唤1个『烈日魔犬』。'
            },
            {
                ability: '爆能强化_6',
                desc:'使其获得【毁灭】。本随从获得【疾驰】。'
            },
            {
                ability: '突进',
            },
        ],
    },
    // 侦查者，2费2攻2血银卡随从
    '33.png': {
        items: [
            {
                ability: '入场曲',
                desc:'将1张『游猎前锋』加入手牌，使其获得【突进】。'
            },
        ],
    },
    // 巨大兵蚁，8费7攻5血铜卡随从
    '34.png': {
        items: [
            {
                ability: '疾驰',
            },
        ],
    },
    // 乔乔&少女，2费1攻1血金卡随从
    '35.png': {
        items: [
            {
                ability: '爆能强化_8',
                desc: '抽取1张费用为7或以上的随从。回复自己7点能量点。',
            },
            {
                ability: '屏障',
            },
        ],
    },
    // 持续的轰炸，4费金卡护符
    '36.png': {
        items: [
            {
                ability: '吟唱_2',
                desc: '自己的回合结束时，对战场上的所有随从造成2点伤害。',
            },
        ],
    },
    // 刀锋，4费4攻4血金卡随从
    '37.png': {
        items: [
            {
                ability: '进化时',
                desc: '召唤2个『游猎前锋』。使自己的战场上的其他所有随从+1/+1。',
            },
        ],
    },
};

// ============================================================================
// 查询 / 工具
// ============================================================================

/** 规范化 id：去扩展名 + 转小写（`'4.png'` / `'4'` / `'4.PNG'` 视为同一枚）。 */
export function canonTipId(id: string): string {
    const s = typeof id === 'string' ? id.trim() : '';
    if (!s) return '';
    return s.replace(/\.[a-z0-9]+$/i, '').toLowerCase();
}

/** 按卡牌 id 取说明数据（未登记 → undefined）。 */
export function getCardTip(id: string): CardTipInfo | undefined {
    const key = canonTipId(id);
    if (!key) return undefined;
    for (const k of Object.keys(CARD_TIP_DATA)) {
        if (canonTipId(k) === key) return CARD_TIP_DATA[k];
    }
    return undefined;
}

/**
 * 按纹章 id 取说明数据（未登记 → undefined）。
 *
 * 🔴 **纹章没有独立的表**：纹章 id 与卡牌 id 相同，说明也和那张卡的 `crest` 字段
 *    一模一样 → 直接复用 `CARD_TIP_DATA[该纹章 id].crest`，一份数据两处用
 *    （卡牌说明卡片下方的「纹章」子框、以及点纹章弹出的说明，读的是同一条）。
 *    要给某枚纹章写说明，就去它对应卡牌的条目里填 `crest`。
 */
export function getCrestTip(id: string): CrestTipInfo | undefined {
    return getCardTip(id)?.crest;
}

/**
 * 需要**高亮**的关键字列表（= `TIP_KEYWORD_DESC` 的 key），按「先长后短」排好
 * （避免「进化」抢先切掉「超进化」）。
 *
 * 🔴 直接由说明表的 key 派生 —— 不另存一份清单，避免「高亮词表」和「说明表」两处不一致。
 */
export function sortedTipKeywords(): string[] {
    return Object.keys(TIP_KEYWORD_DESC)
        .filter((k) => typeof k === 'string' && k.length > 0)
        .sort((a, b) => b.length - a.length);
}

/**
 * 取某个关键字的「能力详情」说明（未登记 → `''`）。
 *
 * 🔴 详情卡片按**关键字原文**查这张表；查不到就跳过该条（并打一条告警），
 *    所以新增关键字时记得在 `TIP_KEYWORD_DESC` 里补上说明。
 */
export function getKeywordDesc(keyword: string): string {
    const k = typeof keyword === 'string' ? keyword.trim() : '';
    if (!k) return '';
    const v = TIP_KEYWORD_DESC[k];
    return typeof v === 'string' ? v : '';
}

/**
 * 把「说明项里写的那个名字」（可能是 `吟唱_4` / `【入场曲】` / `进化` 这类带修饰的写法）
 * **归一化**成 `TIP_KEYWORD_DESC` 里真正登记的关键字；解析不出来就返回 `''`。
 *
 * 依次尝试：
 *   ① 原文直接命中；
 *   ② 去掉【】与首尾空白；
 *   ③ 去掉尾部的 `_数字`（卡 3 的能力名是「吟唱_4」= 吟唱 4 回合）；
 *   ④ 与登记表里的词做「前缀匹配」（取最长的那个：`进化` → `进化时`）。
 */
export function resolveKeyword(name: string): string {
    const raw = typeof name === 'string' ? name.trim() : '';
    if (!raw) return '';
    const cands: string[] = [raw];
    const noBracket = raw.replace(/^[【\[]/, '').replace(/[】\]]$/, '').trim();
    if (noBracket && noBracket !== raw) cands.push(noBracket);
    for (const c of cands.slice()) {
        const noNum = c.replace(/_\d+$/, '').trim();
        if (noNum && noNum !== c) cands.push(noNum);
    }
    const keys = Object.keys(TIP_KEYWORD_DESC).sort((a, b) => b.length - a.length);
    for (const c of cands) {
        if (getKeywordDesc(c)) return c;
    }
    // ④ 前缀匹配（先长后短，保证「超进化时」不会被「进化」抢先）
    for (const c of cands) {
        for (const k of keys) {
            if (c.indexOf(k) === 0) return k;
        }
    }
    return '';
}

/**
 * 给一串关键字（**按出现顺序**）取出详情条目：`{ keyword, desc }[]`。
 * 每条都会先经 `resolveKeyword` 归一化（`吟唱_4` → `吟唱`），并**按归一化后的 key 去重**；
 * 解析不出来 / 没登记说明的会被**跳过**并告警（详情卡片里不显示空条目）。
 */
export function keywordDetails(keywords: string[]): Array<{ keyword: string; desc: string }> {
    const out: Array<{ keyword: string; desc: string }> = [];
    const seen = new Set<string>();
    for (const raw of keywords || []) {
        const kw = resolveKeyword(raw) || (typeof raw === 'string' ? raw.trim() : '');
        if (!kw || seen.has(kw)) continue;
        const desc = getKeywordDesc(kw);
        if (!desc) {
            console.warn(`[CardTipData] 关键字「${raw}」没有在 TIP_KEYWORD_DESC 里登记说明 → 详情卡片跳过它`);
            continue;
        }
        seen.add(kw);
        out.push({ keyword: kw, desc });
    }
    return out;
}

/**
 * 自检（**只读、只打日志**，不改任何数据）：在启动期帮忙抓出手写表里的低级错误。
 * 检查项：
 *   ① 说明项缺 `ability`；
 *   ② 副能力又写了 `subs`（本项目只支持两层）；
 *   ③ 纹章条目的 `items` 为空；
 *   ④ 关键字表（`TIP_KEYWORD_DESC`）里有**空说明**的条目 —— 高亮与详情共用这张表，
 *      空说明会让「点关键字弹出的详情」缺这一条。
 * @returns 全部通过返回 true
 */
export function validateTipData(): boolean {
    let ok = true;
    let descMissing = 0;
    const checkItems = (where: string, items: TipAbilityItem[]): void => {
        if (!Array.isArray(items)) {
            console.warn(`[CardTipData] ${where} 的 items 必须是数组`);
            ok = false;
            return;
        }
        for (const it of items) {
            const name = it && typeof it.ability === 'string' ? it.ability : '';
            const hasDesc = !!it && typeof it.desc === 'string' && it.desc.length > 0;
            // ability 与 desc 至少要有一个（两个都空 = 这一条什么都不显示）
            if (!it || (!name && !hasDesc)) {
                console.warn(`[CardTipData] ${where} 存在既没有 ability 也没有 desc 的说明项（不会显示）`);
                ok = false;
                continue;
            }
            for (const sub of it.subs || []) {
                const subName = sub && typeof sub.ability === 'string' ? sub.ability : '';
                const subDesc = !!sub && typeof sub.desc === 'string' && sub.desc.length > 0;
                if (!sub || (!subName && !subDesc)) {
                    console.warn(`[CardTipData] ${where} 的「${name || '(纯描述)'}」存在既没有 ability 也没有 desc 的副能力`);
                    ok = false;
                    continue;
                }
                if ((sub as unknown as TipAbilityItem).subs) {
                    console.warn(`[CardTipData] ${where} 的副能力「${subName || '(纯描述)'}」又写了 subs`
                        + '（本项目说明只支持两层，第三层不会显示）');
                    ok = false;
                }
            }
        }
    };
    let crestCount = 0;
    for (const k of Object.keys(CARD_TIP_DATA)) {
        const e = CARD_TIP_DATA[k];
        if (!e) continue;
        checkItems(`卡牌 ${k}`, e.items);
        if (e.crest) {
            crestCount++;
            checkItems(`卡牌 ${k} 的纹章「${e.crest.name || e.crest.id || ''}」`, e.crest.items);
        }
    }
    if (ok) {
        console.log(`[CardTipData] 说明数据自检通过：卡牌 ${Object.keys(CARD_TIP_DATA).length} 张、`
            + `带纹章说明 ${crestCount} 张、关键字 ${Object.keys(TIP_KEYWORD_DESC).length} 个。`);
    }
    // ④ 关键字表自检：每个关键字都必须有非空说明（高亮词 = 表的 key，缺说明就是详情缺条目）
    for (const kw of Object.keys(TIP_KEYWORD_DESC)) {
        if (getKeywordDesc(kw)) continue;
        descMissing++;
        ok = false;
        console.warn(`[CardTipData] 关键字「${kw}」在 TIP_KEYWORD_DESC 里没有说明（点它弹出的详情会缺这一条）`);
    }
    if (descMissing === 0) {
        console.log(`[CardTipData] 关键字详情说明齐全：${Object.keys(TIP_KEYWORD_DESC).length} 条。`);
    }
    return ok;
}
