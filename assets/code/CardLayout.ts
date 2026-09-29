/**
 * 卡框几何布局表（纯 TS 数据，无引擎依赖）
 * ============================================================================
 * 本文件登记**两个层次**的版式数据：
 *
 *  A. 按「卡牌类型」的度量（CardTypeMetrics）—— 与品质无关。
 *     同一种类型的所有品质共用同一套值（4 种品质的随从排布/版式完全一致）。
 *
 *  B. 按「卡框资源名」的几何（CardLayouts）—— 每个卡框的镂空开窗与文字槽位，
 *     这部分只能逐个卡框实测（各框美术各自不同）。
 *
 * 随从卡用的是**手牌版卡框**：Hand<品质>Follower.png（HandBronzeFollower 等）。
 * 与无 Hand 前缀的原版框相比，它把「攻击/血量徽记」从下边框外移进了**左侧竖栏**
 * （攻击在上、血量在下），因此：
 *   · 裁剪矩形底边 = 卡框下边框 → bottomInset = 0（排布基准与法术/护符一致）；
 *   · 血量不再位于右下角 → 右缘不必预留 keepRightInset = 0；
 *   · 血量/攻击数字槽从「左下 / 右下」改为「左栏上格 / 左栏下格」。
 *
 * 每个卡框（frame/*.png）的内部几何都不一样，这里按「卡框资源名」登记：
 *   - 开窗：卡图要填满的内框（相对卡框**裁剪后**矩形，单位 px）；
 *   - 各文字槽位的中心点（Cocos 节点坐标，原点在卡牌中心，y 向上）。
 *
 * 坐标怎么来的：用 .workbuddy/frame_geom.js 实测卡框像素得到（裁剪后图像坐标），
 * 再换算：nodeX = 图像X - 卡宽/2 ，nodeY = 卡高/2 - 图像Y。
 *
 * 新增卡框时：跑 `node .workbuddy/frame_geom.js <卡框.png> <卡图.png>` 拿数值填进来，
 * 并用 `node .workbuddy/leak_check.js <卡框.png> <卡图.png> <l,r,t,b>` 验证不外露。
 * ============================================================================
 */

import type { CardType } from './CardData';

// ============================================================================
// A. 类型级版式度量 —— 排布 / 样式只与「卡牌类型」有关，与品质无关
// ============================================================================

/**
 * 某一种卡牌类型（Follower / Spell / Amulet）共用的版式度量。
 * 4 种品质的随从（Bronze/Silver/Gold/Legendary Follower）共用同一份值，
 * 不会因为品质不同而出现不一样的对齐或间距。
 */
export interface CardTypeMetrics {
  /**
   * 卡框「下边框」距卡框裁剪矩形底边的高度（px，未缩放）。
   *
   * 为什么需要它：如果卡框把徽记画在**下边框之外**，裁剪矩形的底边就不是卡框的下边框，
   * 于是手牌圆弧排布拿裁剪底边当对齐基准时，这类卡会整体**抬高一个 bottomInset**
   * （表现为：它自己的徽记跟别的卡的下边框齐平，而它的下边框浮在上面）。
   *
   * 现状（2026-09-16 换用手牌版随从卡框 Hand*Follower 之后）：
   *   Follower = 0 —— 手牌版随从框把攻击/血量徽记移到了**左侧竖栏**（框内），
   *                   裁剪矩形底边就是下边框本身（实测末行 264 为整条底栏，见 .workbuddy/handframe_measure.py）。
   *   Spell    = 0
   *   Amulet   = 0
   * 历史：改用 Hand 版之前的原版随从框把血盾/攻击徽记悬挂在下边框外 17~18px，
   *       那几个框在 CardLayouts 里各自用 bottomInset 覆盖登记（见 LegendaryFollower.png）。
   */
  bottomInset: number;

  /**
   * 该类型卡牌**右缘可以再被右侧卡牌压过来**的宽度（px，未缩放）。
   *
   * 手牌版随从框的血量盾牌已经移到**左侧竖栏**（不会再被右侧的卡压住），
   * 所以随从右缘不再需要预留，与法术/护符一样为 0。
   * 历史：原版随从框的右盾内缩约 3px，那时曾用 3 把间距压到「刚好贴着血盾」。
   */
  keepRightInset: number;
}

/** 按卡牌类型登记版式度量（key 只到类型，不区分品质） */
export const CardTypeMetricsMap: Record<CardType, CardTypeMetrics> = {
  Follower: { bottomInset: 0, keepRightInset: 0 },
  Spell: { bottomInset: 0, keepRightInset: 0 },
  Amulet: { bottomInset: 0, keepRightInset: 0 },
};

// ============================================================================
// B. 卡框级几何 —— 镂空开窗 + 文字槽位（逐框实测）
// ============================================================================

/** 单个卡框的几何布局 */
export interface CardLayout {
  // ===== 开窗（相对卡框裁剪后矩形）=====
  windowLeft: number;
  windowRight: number;
  windowTop: number;
  windowBottom: number;

  // ===== 文字槽位中心（卡牌节点坐标）=====
  /** 费用数字中心（左上角绿圈） */
  costX: number;
  costY: number;
  /** 卡名中心（顶部名字条） */
  nameX: number;
  nameY: number;
  /** 血量数字中心（左侧竖栏下格红盾内）——仅随从卡框有 */
  hpX?: number;
  hpY?: number;
  /** 攻击数字中心（左侧竖栏上格蓝金徽记内）——仅随从卡框有 */
  atkX?: number;
  atkY?: number;

  /**
   * （可选）单独覆盖该卡框的下边框内缩量；留空则用 CardTypeMetricsMap 里按类型给的值。
   * 正常情况下**不要**在这里逐个品质填不同数值——排布只应与卡牌类型有关。
   */
  bottomInset?: number;

  /** （可选）单独覆盖该卡框的「右缘可被压入量」；留空则用类型级默认值。 */
  keepRightInset?: number;
}

/**
 * 卡框布局表：key = 卡框资源名（与 CardData 由 quality + cardType 推导出的卡框名一致）
 *
 * 🔴 **登记铁律：一种卡牌的 4 个品质卡框必须全部登记，缺一不可。**
 *    CardComposer.makePlan 取不到布局会直接 return null → 那张卡**完全不生成**
 *    （不是"少个框"，是根本没有卡）。所以「让一张卡换用同类型其他品质的卡框」
 *    这件事，前提就是该类型 4 个品质的框在表里齐全：
 *      · Follower → Hand<品质>Follower.png   ×4
 *      · Spell    → <品质>Spell.png          ×4
 *      · Amulet   → <品质>Amulet.png         ×4
 *    ⚠️ 还有第二处同样必须齐全：场景里 CardFactory 组件的 `assets` 贴图数组
 *    （缺了 SpriteFrame，布局对了也画不出卡框）。
 */
export const CardLayouts: Record<string, CardLayout> = {
  // ==========================================================================
  // 法术框 <品质>Spell.png（4 种品质**全部登记**）
  //
  // ⚠️ 为什么必须 4 个品质都登记：CardComposer.makePlan 里一旦 getCardLayout(frameName)
  //    取不到值，会直接 return null → **整张卡都不生成**（不是少个框，是完全没有卡）。
  //    所以「一张卡想换用同类型其他品质的卡框」的前提，是这一族框在表里一个都不能缺。
  //
  // 数值来源（2026-09-17 实测，工具 .workbuddy/frame_final_measure.py + handframe_name.py 同口径）：
  //   · 开窗 = alpha 洪水填充内部孔洞（原图 220×284，trimType=auto 裁掉外圈镂空后测量）
  //   · 费用槽 = 严格绿色连通块（g 显著强于 r、b）的 bbox 中心；已用 BronzeSpell 复现旧登记值
  //     (-75.5, 100.5)，误差 0.0px
  //   · 卡名槽 = 紫色名字条色块中心。4 个品质经**轮廓配准**验证为同一套美术（alpha 轮廓
  //     互配 dx=dy=0），故统一按源图坐标 (121.5, 40.5) 迁移：
  //       nameX = 121.5 − bx0 − W/2 ，nameY = H/2 − 40.5 + by0
  //     （bx0/by0 为 trim 原点，W/H 为裁后尺寸）——BronzeSpell 旧值 nameX=13 偏左约 6px，
  //     本次一并修正为 19.5（与其余 3 个法术框、以及 4 个护符框视觉一致）。
  // ==========================================================================

  // —— 铜框法术：原图 220×284 → 裁切 204×252，原点(0,14) ——
  'BronzeSpell.png': {
    windowLeft: 29, windowRight: 11, windowTop: 42, windowBottom: 15,
    costX: -75.5, costY: 100.5,   // 绿圈圆心
    nameX: 19.5, nameY: 99.5,     // 紫色名字条中心（由 13 修正，见上方说明）
  },

  // —— 银框法术：裁切 203×252，原点(1,14) ——
  'SilverSpell.png': {
    windowLeft: 28, windowRight: 11, windowTop: 42, windowBottom: 15,
    costX: -76.0, costY: 100.5,
    nameX: 19.0, nameY: 99.5,
  },

  // —— 金框法术：裁切 203×251，原点(1,14) ——
  'GoldSpell.png': {
    windowLeft: 28, windowRight: 11, windowTop: 44, windowBottom: 14,
    costX: -76.0, costY: 99.0,
    nameX: 19.0, nameY: 99.0,
  },

  // —— 传说法术：裁切 202×250，原点(1,15) ——
  'LegendarySpell.png': {
    windowLeft: 28, windowRight: 11, windowTop: 41, windowBottom: 14,
    costX: -75.0, costY: 100.5,
    nameX: 19.5, nameY: 99.5,
  },

  // —— 传说随从【原版框】（原图 220×284 → 裁切后 214×280，顶部裁掉 3px 透明边）——
  // ⚠️ 已被手牌版 HandLegendaryFollower.png 取代（随从一律用手牌版卡框），此处仅作保留/回退用。
  // 原版框把「攻击徽记(左下)」「血量红盾(右下)」画在**下边框之外**，故裁剪底边不是下边框：
  // 实测下边框比裁剪底边高 17~18px，必须用 bottomInset 覆盖，否则随从会整体抬高。
  'LegendaryFollower.png': {
    windowLeft: 29, windowRight: 22, windowTop: 53, windowBottom: 31,
    costX: -80.4, costY: 103.3,   // 绿圈圆心
    nameX: 15, nameY: 101.5,      // 栗红色名字条中心
    atkX: -78.9, atkY: -114.7,    // 左下蓝金徽记中心 = 攻击
    hpX: 85.2, hpY: -111.4,       // 右下红盾中心 = 血量
    bottomInset: 18, keepRightInset: 3,
  },

  // ==========================================================================
  // 手牌版随从框 Hand<品质>Follower.png（随从卡一律用这一族）
  //   原图 220×284 → 裁切后约 202~203×262~264（底部不再悬挂徽记，故比原版矮 18px、窄 11px）
  //   改动：把原版左下「攻击徽记」与右下「血量红盾」剪到**左侧竖栏**，攻击在上、血量在下
  //        （中轴对齐左边框中心线），并原位重建了下边框。
  //   本表数值来源（全部实测，见 .workbuddy/handframe_*.py）：
  //     · 开窗 = .workbuddy/frame_geom.js（镂空洪水填充；底栏重建后底边比原版深约 6px）
  //     · 血量槽 = 红盾色块的质心（盾牌是单一形状，质心即视觉中心）
  //     · 攻击槽 = 蓝金徽记**主体（菱形）的质心**，不含下缘那两片装饰翼 ——
  //       整块质心会被装饰翼往下拉，数字会掉到菱形腰部以下、贴住装饰翼（.workbuddy/handframe_body.py）
  //     · 费用/卡名槽 = 原版槽位 + 精确平移（顶部区域与原版**逐像素一致**，
  //       裁切原点由 (ox,oy) 变为 (ox−5.5, oy−9) → 节点坐标整体 +5.5, −9）
  //   4 种品质的对应槽位彼此相差 ≤1.8px（同一套美术的调色板互换），排布与版式完全一致。
  // ==========================================================================

  // —— 铜框随从（手牌版）：裁切 203×264，原点(102.5,133) ——
  'HandBronzeFollower.png': {
    windowLeft: 27, windowRight: 11, windowTop: 55, windowBottom: 9,
    costX: -76.7, costY: 93.4,    // 绿圈圆心
    nameX: 19.5, nameY: 91.5,     // 名字条中心
    atkX: -79.1, atkY: 31.6,      // 左栏上格 蓝金徽记（菱形主体中心）= 攻击
    hpX: -78.9, hpY: -28.4,       // 左栏下格 红盾中心 = 血量
  },

  // —— 银框随从（手牌版）：裁切 202×264，原点(102,133) ——
  'HandSilverFollower.png': {
    windowLeft: 27, windowRight: 9, windowTop: 55, windowBottom: 8,
    costX: -75.8, costY: 93.5,
    nameX: 20, nameY: 91.5,
    atkX: -78.2, atkY: 31.6,
    hpX: -78.7, hpY: -28.4,
  },

  // —— 金框随从（手牌版）：裁切 202×264，原点(102,133) ——
  'HandGoldFollower.png': {
    windowLeft: 28, windowRight: 10, windowTop: 55, windowBottom: 8,
    costX: -75.9, costY: 93.5,
    nameX: 20, nameY: 91.5,
    atkX: -78.1, atkY: 31.6,
    hpX: -78.5, hpY: -28.2,
  },

  // —— 传说随从（手牌版）：裁切 203×262，原点(101.5,134) ——
  'HandLegendaryFollower.png': {
    windowLeft: 29, windowRight: 11, windowTop: 53, windowBottom: 7,
    costX: -74.9, costY: 94.3,
    nameX: 20.5, nameY: 92.5,
    atkX: -77.4, atkY: 32.6,
    hpX: -78.3, hpY: -27.4,
  },

  // ==========================================================================
  // 护符框 <品质>Amulet.png（4 种品质**全部登记**，理由同法术框：缺一个 → 整张卡不生成）
  //
  // 护符与法术一样没有 hp/attack，只有费用(左上绿圈)与卡名(青色名字条)。
  // 数值来源同法术框（洪水填充开窗 / 严格绿圈 / 轮廓配准后按源图坐标迁移卡名槽）：
  //   4 个品质互配 dx=dy=0 → 卡名槽统一用源图 (121.5, 40.5)。
  // 2026-09-16 实测（SilverAmulet，作为本族基准框，其值经本次复测验证 0.0px 误差）：
  //   开窗 163×196 左28/右11/上53/下14；绿圈圆心 node(-75.8,95.4)；名字横幅中心 node(19.5,94.0)。
  // ==========================================================================

  // —— 银框护符（本族基准框）：原图 220×284 → 裁切 202×263，原点(1,3) ——
  'SilverAmulet.png': {
    windowLeft: 28, windowRight: 11, windowTop: 53, windowBottom: 14,
    costX: -75.8, costY: 95.4,    // 绿圈圆心
    nameX: 19.5, nameY: 94.0,     // 青色名字条中心
  },

  // —— 铜框护符：裁切 202×262，原点(1,3) ——
  'BronzeAmulet.png': {
    windowLeft: 28, windowRight: 11, windowTop: 54, windowBottom: 14,
    costX: -75.5, costY: 94.0,
    nameX: 19.5, nameY: 93.5,
  },

  // —— 金框护符：裁切 202×262，原点(1,3) ——
  'GoldAmulet.png': {
    windowLeft: 28, windowRight: 11, windowTop: 55, windowBottom: 14,
    costX: -75.5, costY: 94.0,
    nameX: 19.5, nameY: 93.5,
  },

  // —— 传说护符：裁切 203×261，原点(1,4) ——
  'LegendaryAmulet.png': {
    windowLeft: 28, windowRight: 11, windowTop: 54, windowBottom: 14,
    costX: -76.0, costY: 94.0,
    nameX: 19.0, nameY: 94.0,
  },

  // ==========================================================================
  // 战场版卡框 BattleField/<品质><类型>.png —— key 统一加 `BF_` 前缀
  //
  // 为什么必须加前缀：BattleField 目录里护符框的文件名与手牌区护符框**同名**
  //   （都是 BronzeAmulet.png 等），而两者的裁剪/槽位并不相同（BF 版去掉了左上
  //   绿费用圈，青铜/黄金护符因左侧被裁掉一截而更窄：185/184 vs 202）。
  //   若沿用同名 key，就会与上面手牌区护符框的登记**撞 key**，其中一方被覆盖。
  //   故战场框一律登记成 `BF_<原名>`；资源侧也由 BattleField 工厂用 assetNames
  //   显式登记同名（见 scene 的 PlayerBattleFieldArea/CardComposer）。
  //
  // 数值来源（2026-09-18 重标，.workbuddy/measure_bf_icons.py；开窗沿用 09-17 的实测）：
  //   · 开窗 = alpha 洪水填充内部孔洞（相对各自裁剪矩形）；
  //   · 卡名槽 = 名字条**本体**的 bbox 中心（逐行取「不透明 + 有饱和度」像素的最大连通横段，
  //     按左右端点稳定性分组，取纯色横条面积最大的那一组）；
  //   · 随从攻/血 = 徽记色块最大连通块的**整体质心**；
  //   · 费用槽 = 源图绿圈圆心（护符 26.5,41.0 / 随从 26.3,39.6）经 trim 变换 ——
  //     战场框已无绿圈，无可实测，故沿用旧值；showCost 默认 false，不影响显示。
  //   详见下面 8 个条目前的说明（含「旧值为什么错」）。
  //
  // ⚠️ 战场版随从框是**原版随从框**样式（攻/血徽记悬挂在下边框之外，裁剪高 280~282
  //    > 手牌版 262~264），故 windowBottom ≈ 32 把下方留给徽记；它与手牌版
  //    Hand<品质>Follower.png 不可混用。
  // ==========================================================================

  // ⚠️ 下面 8 个 BF 框的 nameX/nameY（卡名槽）与 atkX/atkY、hpX/hpY（攻/血槽）
  //    已于 2026-09-18 用 .workbuddy/measure_bf_icons.py **逐框实测**重标，
  //    不要再退回用「原版模板源图坐标 (121.5,40.5)/(31.1,257.7)/(195.2,254.4) 经 trim 平移」的旧值。
  //
  //    为什么旧值是错的：
  //      · 卡名槽：旧值假设名字条在源图上的中心恒为 x=121.5。手牌区框恰好成立（名字条左端被
  //        左上**绿费用圈**压住，露出来的那一截的中心正好落在 121.5 附近），但战场框把费用圈
  //        去掉了，**露出了名字条真正的左端**（银护符实测跨图内 26..193，中心 ≈110）。
  //        于是旧值让卡名整体右偏约 10~12px、几乎贴到名字条右斜角。
  //        （BF_SilverAmulet.png 与手牌区 SilverAmulet.png 裁剪几何完全相同 202×263@1,3，
  //          像素差异仅落在 x 0..110 / y 11..68 的费用圈区域 —— 正是这条线索。）
  //      · 攻/血槽：旧值同样是模板平移来的，横向偏右 2~4px。
  //        本次改为「取徽记色块最大连通块的**整体质心**」，并用原版 LegendaryFollower 交叉验证：
  //        实测 atk(-78.9,-114.7) / hp(85.2,-111.4)，与下面已登记的原版值逐位一致。
  //        注：**不要**套用手牌版用的「腰部截断取主体质心」（handframe_body.py）——
  //        那是为重排过的 Hand 版框准备的，用在原版徽记上会把质心抬高约 6px。
  //
  //    costX/costY 仍为旧值（战场框已无绿费用圈可测）；showCost 默认 false，不影响显示。
  // ==========================================================================

  // —— 战场·铜框护符：裁切 185×262，原点(18,3) ——
  'BF_BronzeAmulet.png': {
    windowLeft: 11, windowRight: 12, windowTop: 53, windowBottom: 14,
    costX: -84.0, costY: 93.0,
    nameX: 0.0, nameY: 92.5,
  },

  // —— 战场·银框护符：裁切 202×263，原点(1,3) ——
  'BF_SilverAmulet.png': {
    windowLeft: 27, windowRight: 11, windowTop: 53, windowBottom: 14,
    costX: -75.5, costY: 93.5,
    nameX: 9.0, nameY: 93.5,
  },

  // —— 战场·金框护符：裁切 184×262，原点(19,3) ——
  'BF_GoldAmulet.png': {
    windowLeft: 10, windowRight: 11, windowTop: 54, windowBottom: 14,
    costX: -84.5, costY: 93.0,
    nameX: 0.0, nameY: 90.0,
  },

  // —— 战场·传说护符：裁切 203×261，原点(1,4) ——
  'BF_LegendaryAmulet.png': {
    windowLeft: 27, windowRight: 12, windowTop: 53, windowBottom: 15,
    costX: -76.0, costY: 93.5,
    nameX: 8.5, nameY: 91.5,
  },

  // —— 战场·铜框随从（原版样式，攻/血在下方）：裁切 211×282，原点(4,1) ——
  'BF_BronzeFollower.png': {
    windowLeft: 24, windowRight: 22, windowTop: 55, windowBottom: 32,
    costX: -83.2, costY: 102.4,
    nameX: 1.5, nameY: 102.5,
    atkX: -82.1, atkY: -115.4,
    hpX: 83.2, hpY: -112.4,
  },

  // —— 战场·银框随从：裁切 209×282，原点(5,1) ——
  'BF_SilverFollower.png': {
    windowLeft: 23, windowRight: 22, windowTop: 54, windowBottom: 32,
    costX: -83.2, costY: 102.4,
    nameX: 1.5, nameY: 99.5,
    atkX: -81.7, atkY: -115.6,
    hpX: 82.8, hpY: -112.4,
  },

  // —— 战场·金框随从：裁切 210×282，原点(4,1) ——
  'BF_GoldFollower.png': {
    windowLeft: 24, windowRight: 21, windowTop: 55, windowBottom: 32,
    costX: -82.7, costY: 102.4,
    nameX: 2.0, nameY: 102.5,
    atkX: -81.1, atkY: -115.4,
    hpX: 83.5, hpY: -112.2,
  },

  // —— 战场·传说随从：裁切 214×280，原点(0,3) ——
  'BF_LegendaryFollower.png': {
    windowLeft: 29, windowRight: 22, windowTop: 53, windowBottom: 32,
    costX: -80.7, costY: 103.4,
    nameX: 4.0, nameY: 100.5,
    atkX: -78.9, atkY: -114.7,
    hpX: 85.2, hpY: -111.4,
  },
};

/**
 * 按卡框资源名取布局；找不到返回 undefined。
 * @param frameName 卡框资源名，如 'BronzeSpell.png'
 */
export function getCardLayout(frameName: string): CardLayout | undefined {
  return CardLayouts[frameName];
}

/** 是否已登记该卡框的布局 */
export function hasCardLayout(frameName: string): boolean {
  return !!CardLayouts[frameName];
}

/**
 * 取某个卡框的「下边框内缩量」（px，未缩放）——手牌圆弧排布的对齐基准要用它。
 *
 * 优先级：卡框级覆盖(CardLayout.bottomInset) > 类型级默认(CardTypeMetricsMap)。
 * 也就是说默认「排布只与卡牌类型有关」，只有确实需要单独微调某个卡框时才写覆盖。
 *
 * @param frameName 卡框资源名，如 'LegendaryFollower.png'
 * @param cardType  卡牌类型（Follower / Spell / Amulet）
 */
export function getCardBottomInset(frameName: string, cardType: CardType): number {
  const L = CardLayouts[frameName];
  if (L && L.bottomInset !== undefined) return L.bottomInset;
  const m = CardTypeMetricsMap[cardType];
  return m ? m.bottomInset : 0;
}

/**
 * 取某个卡型的「右缘可被压入量」（px，未缩放）——手牌自动间距靠它把间距压到最紧。
 * 优先级：卡框级覆盖(CardLayout.keepRightInset) > 类型级默认(CardTypeMetricsMap)。
 * 手牌版随从框的血量盾牌在左侧竖栏，右侧不再需要预留 → 默认 0。
 *
 * @param frameName 卡框资源名，如 'HandLegendaryFollower.png'
 * @param cardType  卡牌类型（Follower / Spell / Amulet）
 */
export function getCardKeepRightInset(frameName: string, cardType: CardType): number {
  const L = CardLayouts[frameName];
  if (L && L.keepRightInset !== undefined) return L.keepRightInset;
  const m = CardTypeMetricsMap[cardType];
  return m ? m.keepRightInset : 0;
}

/** 按卡牌类型取度量（找不到返回全 0 的兜底值） */
export function getTypeMetrics(cardType: CardType): CardTypeMetrics {
  return CardTypeMetricsMap[cardType] ?? { bottomInset: 0, keepRightInset: 0 };
}
