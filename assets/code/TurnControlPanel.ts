import { _decorator, Color, Component, EventTouch, Graphics, HorizontalTextAlignment, Label, Node, Size, Sprite, UITransform } from 'cc';
import { CardGlow } from './CardGlow';

const { ccclass, property, requireComponent, executeInEditMode, menu } = _decorator;

/** 白字 + 深色描边（参考图里的数字/按钮文字都是白字带暗边） */
const _colText = new Color(255, 255, 255, 255);
const _colOutline = new Color(10, 22, 18, 210);

/** PP 圆点绘制用的临时颜色（复用，避免每次 new Color） */
const _dotCol = new Color();

/**
 * TurnControlPanel —— 回合控制面板（纵向图片拼接）
 * ===========================================================================
 * 挂在面板根节点上（本组件与 6 个 Sprite 子节点同属一个节点树）。
 *
 * 结构（自上而下 4 个槽位，共 6 个 Sprite 子节点）：
 *   TurnControlPanel            ← 本组件
 *     ├── EnemyPP               ← 槽1 敌方能量点横幅   （+ PPText/NumCur、PPText/NumMax）
 *     ├── RoundButton           ← 槽2 我方回合钮「结束回合」 （+ RoundText）
 *     ├── EnemyRoundButton      ← 槽2 敌方回合钮「对手回合」 （+ RoundText）※与上者互斥
 *     ├── PlayerPP              ← 槽3 我方能量点横幅   （+ PPText/NumCur、PPText/NumMax）
 *     ├── ExtraPP               ← 槽4 可用态（「能量点+1」）
 *     └── LockedExtraPP         ← 槽4 锁定态（「5回合后可再次使用」）
 *
 * 🔴 **两组互斥槽位**（同位置、同尺寸，任一时刻只显示一个）：
 *   槽2  RoundButton      ⇄ EnemyRoundButton   ← showEnemyRound
 *   槽4  ExtraPP          ⇄ LockedExtraPP      ← showLockedExtra
 *
 * 🔴 文字（Label）由本组件**按名复用/就地创建**（`PPText` / `RoundText` 等），
 *    不依赖场景里预先摆好节点；`@executeInEditMode` 下在编辑器里也会生成。
 *
 * 暴露给 Cocos 面板的可调参数：
 *   panelScale          ★ 整体**等比**缩放（1 = 调好的原始尺寸；
 *                         同时缩放 4 张卡、3 个间隔、以及**所有字号** → 比例保持不变）
 *   enemyPPSize         ┐
 *   roundButtonSize     ├ 四个槽位各自的**基础**大小（最终 = 基础 × panelScale）
 *   playerPPSize        │  槽2 两个按钮共用 roundButtonSize
 *   extraPPSize         ┘ 槽4 基础大小（ExtraPP 与 LockedExtraPP 共用）
 *   gapEnemyToRound     ┐
 *   gapRoundToPlayer    ├ 三个间隔（同样随 panelScale 等比缩放）
 *   gapPlayerToExtra    ┘
 *   alignEnemyToPlayer  槽1 EnemyPP 的左右竖直边是否与槽3 PlayerPP 的竖直边对齐（默认 true）
 *   alignExtraToPlayer  槽4 左右竖直边是否与槽3 PlayerPP 的竖直边对齐（默认 true）
 *   showEnemyRound      槽2 显示敌方回合钮(true) 还是我方回合钮(false)
 *   showLockedExtra     槽4 显示锁定态(true) 还是可用态(false)
 *
 *   ── PP 数值（「能量点 1 / 10」）────────────────────
 *   enemyCurrentPP / enemyMaxPP     敌方：当前剩余 PP / 本回合上限 PP（= PP 槽位数）
 *   playerCurrentPP / playerMaxPP   我方：同上
 *   🔴 左边的数字 = 当前回合**还能用**的 PP；右边的 = 当前回合**最多能有**的 PP。
 *
 *   ── 字号（每个字体一个变量）───────────────────────────────────────
 *   enemyPPNumFontSize       仅敌方 PP 的「当前剩余」数字
 *   playerPPNumFontSize      仅我方 PP 的「当前剩余」数字
 *   ppMaxFontSize            🔴 **敌我 PP 共用同一个变量**的「/最大PP」数字（按需求比前者略小）
 *   roundLabelFontSize       我方回合钮「结束回合」
 *   enemyRoundLabelFontSize  敌方回合钮「对手回合」
 *   ppNumberFontFamily / roundLabelFontFamily  字体族（CSS font-family，留空用引擎默认）
 *
 * ── 竖直边对齐（bugfix 2026-09-19）──────────────────────────────────────
 * 素材的**裁剪框 ≠ 本体矩形**（导入 trimType=auto，裁剪框 = alpha 包围盒；
 * Sprite 用 SizeMode.CUSTOM 时，裁剪框会被拉伸铺满节点矩形）：
 *   PlayerPP       本体占裁剪框 x∈[0.56%, 99.35%]  ← 几乎满宽，作为对齐基准
 *   EnemyPP        本体占裁剪框 x∈[2.82%, 97.25%]  ← 左右各内缩约 2.8%/2.7%
 *   槽4 素材本体占 x∈[7.22%, 99.91%]               ← 左侧有一枚向左突出的圆
 * 因此把节点「等宽 / 居中」摆放时，本体的竖直边会错开（EnemyPP 窄 4.4%、槽4 窄 6.1%）。
 * 开关打开后由 `_fitBodyToPlayer()` 按比例**反推**该槽位的节点宽度与横向位置，
 * 使其**本体**的左右竖直边与 PlayerPP 本体重合（高度/纵向排布不受影响）。
 * 比例常数由 .workbuddy/tmp/measure_panel_bodies.py 对原始 PNG 实测得到。
 *
 * ── 文字锚点（素材实测，见 .workbuddy/tmp/verify_green_mask.py）──────
 * PP 数字要接在素材里**已烘焙的「能量点」绿字**右侧、并与它垂直居中：
 *   EnemyPP  「能量点」右缘 u=0.4790、垂直中心 v≈0.460
 *   PlayerPP 「能量点」右缘 u=0.4798、垂直中心 v=0.4685
 *   → 数字**左缘**锚点 u ≈ 0.4790 + 0.105(间隙) ≈ 0.590（与参考图空隙一致）
 * 锚点与间隙都用**归一比例**存（enemyNumAnchorU/V、playerNumAnchorU/V、ppNumGap），
 * 所以 panelScale 变化 / 竖直边对齐改变节点宽度时，数字都会牢牢粘在「能量点」右边；
 * 也方便直接在 Inspector 里微调（不必改代码）。
 * ===========================================================================
 */
@ccclass('TurnControlPanel')
@requireComponent(UITransform)
@executeInEditMode(true)
@menu('gf2szb/TurnControlPanel')
export class TurnControlPanel extends Component {

    // ====================== 整体缩放（等比）======================

    @property({
        range: [0.2, 3, 0.01],
        slide: true,
        tooltip: '**整体等比缩放**（1 = 调好的原始尺寸）。\n'
            + '同时缩放 4 张卡、3 个间隔、**以及所有字号** → **保持调好的比例不变**。\n'
            + '想整体放大/缩小面板调这一个值即可。',
    })
    panelScale = 1;

    // ====================== 单槽「基础」尺寸（再乘 panelScale）======================

    @property({
        type: Size,
        tooltip: '槽1 **EnemyPP**（敌方能量点横幅）基础大小（最终 = 基础 × panelScale）。\n'
            + '开启 alignEnemyToPlayer 时**宽度由竖直边对齐自动推导**（此时 width 不生效），高度照常用。',
    })
    enemyPPSize: Size = new Size(264, 90);

    @property({ type: Size, tooltip: '槽2 **回合钮**基础大小（最终 = 基础 × panelScale）；RoundButton 与 EnemyRoundButton **共用**' })
    roundButtonSize: Size = new Size(214, 216);

    @property({ type: Size, tooltip: '槽3 **PlayerPP**（我方能量点横幅）基础大小（最终 = 基础 × panelScale），同时作为两条竖直边对齐的基准' })
    playerPPSize: Size = new Size(264, 122);

    @property({
        type: Size,
        tooltip: '槽4 基础大小 —— **ExtraPP 与 LockedExtraPP 共用**。\n'
            + '高度永远生效；开启 alignExtraToPlayer 时**宽度由竖直边对齐自动推导**（此时 width 不生效）。',
    })
    extraPPSize: Size = new Size(300, 92);

    @property({
        tooltip: '槽1 的**左右竖直边**是否与槽3 PlayerPP 的竖直边对齐。\n'
            + '默认开 → 修复「敌方能量点横幅比我方能量点窄一圈、边框不齐」。\n'
            + '关闭则槽1 按 enemyPPSize.width 居中摆放。',
    })
    alignEnemyToPlayer = true;

    @property({
        tooltip: '槽4 的**左右竖直边**是否与槽3 PlayerPP 的竖直边对齐（左侧圆可照旧突出）。\n'
            + '默认开 → 修复「额外能量点与我方能量点竖直边框不齐」。\n'
            + '关闭则槽4 按 extraPPSize.width 居中摆放。',
    })
    alignExtraToPlayer = true;

    // ====================== 三个间隔 ======================

    @property({ range: [0, 300, 1], slide: true, tooltip: '间隔① **EnemyPP ↔ 回合钮** 的垂直距离（随 panelScale 等比缩放）' })
    gapEnemyToRound = 6;

    @property({ range: [0, 300, 1], slide: true, tooltip: '间隔② **回合钮 ↔ PlayerPP** 的垂直距离（随 panelScale 等比缩放）' })
    gapRoundToPlayer = 6;

    @property({
        range: [0, 300, 1], slide: true,
        tooltip: '**额外能量点 ↔ 它所属那一方的能量点横幅** 的垂直距离（随 panelScale 等比缩放）。\n'
            + '🔴 敌我**共用这一个变量**：我方为后手（横幅在 PlayerPP 下方）与 敌方为后手（横幅在 EnemyPP 上方）\n'
            + '   两种情况与各自能量点横幅的距离**必然一致**。',
    })
    gapPPToExtra = 8;

    // ====================== 两组互斥显隐 ======================

    @property({
        tooltip: '槽2 显示**敌方回合钮 EnemyRoundButton**（true，文字「对手回合」）\n'
            + '还是**我方回合钮 RoundButton**（false，文字「结束回合」）。\n'
            + '两者同位置同尺寸，任一时刻只显示一个 → 切换时位置大小必然不变。',
    })
    showEnemyRound = false;

    @property({ tooltip: '槽4 显示**锁定态 LockedExtraPP**（true）还是**可用态 ExtraPP**（false）' })
    showLockedExtra = true;

    // ====================== PP 数值 ======================

    @property({ tooltip: '敌方 PP —— **当前回合还能使用**的剩余 PP（横幅上左边那个大数字）' })
    enemyCurrentPP = 1;

    @property({ tooltip: '敌方 PP —— **当前回合最多能有**的 PP，即 PP 槽位数（"/" 后面那个小数字）' })
    enemyMaxPP = 9;

    @property({ tooltip: '我方 PP —— **当前回合还能使用**的剩余 PP（横幅上左边那个大数字）' })
    playerCurrentPP = 1;

    @property({ tooltip: '我方 PP —— **当前回合最多能有**的 PP，即 PP 槽位数（"/" 后面那个小数字）' })
    playerMaxPP = 10;

    // ====================== 字号（★ 注意哪个是共用的）======================

    @property({ range: [8, 160, 1], slide: true, tooltip: '【我方 PP】「当前剩余 PP」数字的字号（横幅上左边那个大数字）' })
    playerPPNumFontSize = 40;

    @property({ range: [8, 160, 1], slide: true, tooltip: '【敌方 PP】「当前剩余 PP」数字的字号（横幅上左边那个大数字）' })
    enemyPPNumFontSize = 40;

    @property({
        range: [8, 160, 1],
        slide: true,
        tooltip: '🔴【敌我 PP **共用同一个变量**】"/最大PP" 的字号。\n'
            + '改这一个值 → **两块能量点横幅的 "/数字" 一起变**（按需求两者必须一致）。\n'
            + '按需求它应比前面的「当前 PP」数字**略小**（默认 30 vs 40）。',
    })
    ppMaxFontSize = 30;

    @property({ range: [8, 160, 1], slide: true, tooltip: '【我方回合钮】文字「结束回合」的字号' })
    roundLabelFontSize = 48;

    @property({ range: [8, 160, 1], slide: true, tooltip: '【敌方回合钮】文字「对手回合」的字号' })
    enemyRoundLabelFontSize = 48;

    // ====================== 字体族 ======================

    @property({ tooltip: 'PP 数字字体（CSS font-family；留空 = 用引擎默认字体）。\n默认 Georgia：衬线加粗数字，接近参考图。' })
    ppNumberFontFamily = 'Georgia';

    @property({ tooltip: '回合钮文字字体（CSS font-family；留空 = 用引擎默认字体）。\n默认 KaiTi（Windows 自带中文楷体），接近参考图的毛笔感。' })
    roundLabelFontFamily = 'KaiTi';

    // ============ 文字位置：归一锚点（相对素材裁剪框 0..1，与 panelScale 解耦）============

    @property({ range: [0, 1, 0.001], slide: true, tooltip: '【敌方 PP】PP 数字**左缘**的归一横坐标（0=横幅左端，1=右端）。\n约 0.590 时数字正好落在素材里「能量点」绿字的右侧空隙上。' })
    enemyNumAnchorU = 0.590;

    @property({ range: [0, 1, 0.001], slide: true, tooltip: '【敌方 PP】「当前 PP」数字**底线**的归一纵坐标（0=横幅顶，1=底）。\n0.5698 = 实测素材里「能量点」三个字像素块的**底边** → 数字底线与其对齐。' })
    enemyNumAnchorV = 0.5698;

    @property({ range: [0, 1, 0.001], slide: true, tooltip: '【我方 PP】PP 数字**左缘**的归一横坐标（0=横幅左端，1=右端）。\n约 0.590 时数字正好落在素材里「能量点」绿字的右侧空隙上。' })
    playerNumAnchorU = 0.590;

    @property({ range: [0, 1, 0.001], slide: true, tooltip: '【我方 PP】「当前 PP」数字**底线**的归一纵坐标（0=横幅顶，1=底）。\n0.5518 = 实测素材里「能量点」三个字像素块的**底边** → 数字底线与其对齐。' })
    playerNumAnchorV = 0.5518;

    @property({
        range: [0, 0.4, 0.005],
        slide: true,
        tooltip: '「当前PP」与「/最大PP」之间的间隙（归一比例，相对横幅宽度）。\n'
            + '默认 0.105 ≈ 参考图里大数字与 "/数字" 的间距。调 0 则两者紧贴。',
    })
    ppNumGap = 0.105;

    // ============ 额外能量点（ExtraPP ⇄ LockedExtraPP）============

    @property({
        tooltip: '**对局开始时** label 最前面的数字（「N回合后可再次使用」），默认 6。\n'
            + '此后**后手的每个操作回合开始时 −1**；若再减会变成 0（不要显示「0回合后可再次使用」），\n'
            + '则把 label 换成 extraDepletedText 并**停止再更新数字**。',
    })
    extraStartRounds = 6;

    @property({
        tooltip: '倒计时走完后 label 的文字（不再显示数字），默认「已获取完所有额外能量点」。',
    })
    extraDepletedText = '已获取完所有额外能量点';

    @property({
        tooltip: '额外能量点归属哪一方（= 后手），由 TurnManager 开战时写入：\n'
            + '  · "player" —— 我方为后手 → 横幅在**我方能量点下方**（原槽4 位置）；\n'
            + '  · "enemy"  —— 敌方为后手 → 横幅在**敌方能量点上方**。',
    })
    extraSide: 'player' | 'enemy' = 'player';

    @property({
        tooltip: '额外能量点是否**只有我方**能点击、并参与「剩余费用 +1」的判定（默认开）。\n'
            + '开：敌方为后手时按钮不响应点击、也不参与费用判定（但倒计时/状态切换等其余逻辑照常保留）。\n'
            + '关：任一方为后手都能点（仅测试用）。',
    })
    extraPlayerOnly = true;

    @property({
        range: [1, 1.5, 0.01], slide: true,
        tooltip: '额外能量点点亮（高亮）时的整体缩放倍率（1 = 不缩放）。',
    })
    extraArmedScale = 1.06;

    @property({ type: Color, tooltip: '额外能量点点亮时外圈高亮光晕的颜色' })
    extraArmedGlowColor = new Color(255, 226, 130, 255);

    @property({
        range: [0, 240, 1], slide: true,
        tooltip: '点亮光晕的厚度 —— 单位是**按钮贴图的纹理像素**（与战场卡牌 CardGlow 同一口径）。\n'
            + '🔴 槽4 的贴图是 3312×999，节点只有约 197×64 → 纹理像素 ≈ 屏幕像素 ÷ 0.06，\n'
            + '   所以这里要填**上百**才能在屏幕上看到约 9px 的金边（默认 160 ≈ 屏幕 9.5px）。',
    })
    extraGlowThickness = 160;

    @property({
        range: [0, 1, 0.01], slide: true,
        tooltip: '点亮光晕的柔和度：0 = 紧贴轮廓的硬边光；1 = 向外拖得很远的软光。\n'
            + '默认 0.45：金边收得比较紧、轮廓清楚。',
    })
    extraGlowSoftness = 0.45;

    @property({
        range: [0, 4, 0.01], slide: true,
        tooltip: '点亮光晕达到的**强度**（越大越亮）。',
    })
    extraArmedIntensity = 3.0;

    @property({ range: [0, 2, 0.01], slide: true, tooltip: '点亮光晕的淡入时长（秒）' })
    extraGlowFadeIn = 0.18;

    @property({ range: [0, 2, 0.01], slide: true, tooltip: '点亮光晕的淡出时长（秒）' })
    extraGlowFadeOut = 0.14;

    @property({
        tooltip: '点击 **TurnControlPanel 里的任何节点**都不触发「手牌缩略」（默认开）。\n'
            + '手牌缩略是 Canvas 上的全屏 TOUCH_START 监听，不拦住的话点面板会把整份手牌缩下去。',
    })
    swallowPanelTouches = true;

    @property({
        range: [8, 120, 1], slide: true,
        tooltip: '「N回合后可再次使用」整行文字的**字号上限**（基值，最终 = 基值 × panelScale）。\n'
            + '🔴 这不再是「实际字号」而是**封顶值**：当文字宽度超过下方 extraTextBoxWU 定义的\n'
            + '   文字框时，会由 Overflow.SHRINK 自动等比缩小（见 extraTextShrinkToFit）。\n'
            + '24 × 0.7 = 16.8 ≈ 实测「4回合后可再次使用」正好铺满文字框的字号。',
    })
    extraReuseFontSize = 24;

    @property({ tooltip: '「N回合后可再次使用」的字体（CSS font-family；留空 = 引擎默认字体）' })
    extraReuseFontFamily = 'Microsoft YaHei';

    // ---- 槽4「文字框」：素材里那个**深色内嵌矩形**的实际范围（归一，相对横幅节点尺寸）----
    // 实测方法（.workbuddy/tmp/measure_box2.py）：对 ExtraPP.png / LockedExtraPP.png 的
    // 裁剪本体做「灰度 < 中位数 × 0.45」阈值 + 列/行投影找最长连续段，三种阈值结果一致：
    //   ExtraPP      u 0.1700..0.9523 (宽 0.7823)   v 0.5616..0.8849 (高 0.3233)
    //   LockedExtraPP u 0.1706..0.9517 (宽 0.7811)   v 0.5531..0.8735 (高 0.3204)
    // 两者几乎相同 → 共用一个「宽/高」参数，只有中心分开暴露。
    // 换算到节点单位（横幅 196.96 × 64.4）：文字框 ≈ 154 × 20.8。
    @property({
        range: [0.1, 1, 0.001], slide: true,
        tooltip: '【槽4 文字框】**宽**（归一，相对横幅节点宽）。\n'
            + '0.781 = 实测：ExtraPP 0.7823 / LockedExtraPP 0.7811 → 约 154px（节点单位）。\n'
            + '调小 → 文字更早触发自动缩字号；调大 → 文字可能压到素材边框上。',
    })
    extraTextBoxWU = 0.781;

    @property({
        range: [0.05, 1, 0.001], slide: true,
        tooltip: '【槽4 文字框】**高**（归一，相对横幅节点高）。\n'
            + '0.321 = 实测：ExtraPP 0.3233 / LockedExtraPP 0.3204 → 约 20.8px（节点单位）。',
    })
    extraTextBoxHV = 0.321;

    @property({
        range: [0, 0.4, 0.005], slide: true,
        tooltip: '文字在文字框内的**左右留白比例**（在 extraTextBoxWU 基础上再收这么多）。\n'
            + '0.06 ≈ 框宽 154px 时左右各留 ~4.6px，避免文字紧贴素材框边。',
    })
    extraTextBoxPad = 0.06;

    @property({
        tooltip: '🔴 文字宽度超过文字框时，是否**自动等比缩小字号**（Label.Overflow.SHRINK）来适配。\n'
            + '开（默认）→「12回合后可再次使用」这类更长的文字也不会溢出文字框；\n'
            + '关 → 固定用 extraReuseFontSize，文字过长会像修复前那样溢出。',
    })
    extraTextShrinkToFit = true;

    @property({ range: [0, 1, 0.001], slide: true, tooltip: '【ExtraPP（橙色·可用态）】文字框**中心**的归一 u（0=横幅左端，1=右端）\n0.5610 = 投影法实测深色文字框中心。' })
    extraTextAnchorU = 0.5610;

    @property({ range: [0, 1, 0.001], slide: true, tooltip: '【ExtraPP（橙色·可用态）】文字框**中心**的归一 v（0=横幅顶，1=底）\n0.7232 = 投影法实测深色文字框中心。' })
    extraTextAnchorV = 0.7232;

    @property({ range: [0, 1, 0.001], slide: true, tooltip: '【LockedExtraPP（灰色·锁定态）】文字框**中心**的归一 u（0=横幅左端，1=右端）\n0.5608 = 投影法实测深色文字框中心。' })
    lockedTextAnchorU = 0.5608;

    @property({ range: [0, 1, 0.001], slide: true, tooltip: '【LockedExtraPP（灰色·锁定态）】文字框**中心**的归一 v（0=横幅顶，1=底）\n0.7133 = 投影法实测深色文字框中心。' })
    lockedTextAnchorV = 0.7133;

    // ====================== PlayerPP 底部十个 PP 圆点 ======================
    // 素材 PlayerPP.png 底部**已经画好** 10 个「金环 + 黑芯」空槽；本组件在**黑芯上叠一层球**：
    //   · 前 NumCur 个          → 绿球（已用）
    //   · 接着 (NumMax-NumCur) 个 → 灰球（本回合上限内、尚未用）
    //   · 其余 (10-NumMax) 个     → 不叠，露出素材原本的黑芯
    // 下面这些「像素→归一」常量是量出来的（1339×685 素材，见 .workbuddy/tmp/measure_phase_d.py）。

    @property({ tooltip: '是否由本组件接管 PlayerPP 下方十个 PP 圆点的染色\n（关掉 = 只剩素材原本的 10 个黑芯，不做任何叠加）' })
    ppDotsEnabled = true;

    @property({
        range: [0.5, 1.3, 0.01], slide: true,
        tooltip: '球相对「素材黑芯」的大小倍率。1 = 正好盖满黑芯；略小于 1 会露出一点黑边。',
    })
    ppDotScale = 0.97;

    @property({ type: Color, tooltip: '【绿球·已用 PP】球心色（最亮处）' })
    ppDotGreenCore = new Color(170, 234, 132, 255);

    @property({ type: Color, tooltip: '【绿球·已用 PP】球边色（最暗处）' })
    ppDotGreenEdge = new Color(56, 138, 46, 255);

    @property({ type: Color, tooltip: '【灰球·上限内未用】球心色（最亮处）' })
    ppDotGrayCore = new Color(160, 158, 152, 255);

    @property({ type: Color, tooltip: '【灰球·上限内未用】球边色（最暗处）' })
    ppDotGrayEdge = new Color(76, 76, 74, 255);

    @property({
        range: [0, 0.6, 0.005], slide: true,
        tooltip: 'PP 数字「底线对齐」的**基线补偿系数**：数字文本框的**底边**要再往下压\n'
            + '「lineHeight × 本值」这么多，才能让**字形基线**正好落在「能量点」底边上。\n'
            + '🔴 0.315 = 实测值：Georgia 在 fontSize 33.6 / lineHeight 34 下，\n'
            + '   文本框底边到**基线**的距离 = 10.74px ≈ 34 × 0.315；\n'
            + '   NumMax(fontSize 21) 同系数得 21 × 0.315 = 6.62px ≈ 实测 6.53px\n'
            + '   → 「/最大PP」与「当前PP」**共用一条基线**，两条一起落在「能量点」底边上。\n'
            + '⚠️ Georgia 用的是**旧体数字**：0/1/2 只有 x 高（底边=基线），\n'
            + '   3/4/5/7/9 带降部（会比基线再低几个像素）——这是字体本身的特性。',
    })
    ppNumDescentRatio = 0.315;

    // ====================== 点击回合钮切换（任务四）======================

    @property({
        tooltip: '点击回合钮 → **RoundButton(结束回合) ⇄ EnemyRoundButton(对手回合)** 互相切换。\n'
            + '🔴 按下/抬起事件被本组件**当场吞掉**（propagationStopped）→ **不会**冒泡到 Canvas 上\n'
            + 'HandMinimize 的全屏 TOUCH_START 监听 → 因此**不会**顺带触发「手牌缩略」。',
    })
    roundButtonToggleOnClick = true;

    @property({
        range: [0.6, 1, 0.01], slide: true,
        tooltip: '按下时的缩放反馈（1 = 无反馈）。\n'
            + '🔴 直接改 scale、**不用 tween**：避免「补间没跑完就 active=false」留下未完成的补间（铁律16）。',
    })
    roundButtonPressScale = 0.94;

    /**
     * 回合钮点击回调（**运行时注入**，不序列化）。
     *   · 为 null  → 保持本组件自带的「我/敌回合钮互切」测试行为（任务四）。
     *   · 被赋值   → 点击**不再自动互切**，交由回调决定（TurnManager 用它推进回合流程）。
     * 参数 = 点击时回合钮**当前显示**的归属：'player' = 显示「结束回合」；'enemy' = 显示「对手回合」。
     */
    public roundClickHandler: ((side: 'player' | 'enemy') => void) | null = null;

    // ====================== 子节点名（结构固定）======================
    private static readonly N_ENEMY = 'EnemyPP';
    private static readonly N_ROUND = 'RoundButton';
    private static readonly N_ROUND_ENEMY = 'EnemyRoundButton';
    private static readonly N_PLAYER = 'PlayerPP';
    private static readonly N_EXTRA = 'ExtraPP';
    private static readonly N_LOCKED = 'LockedExtraPP';
    /**
     * 「吞触摸区」节点名：一个**不可见**的子节点，尺寸 = 面板**可视槽位**的包围并集。
     * 它排在兄弟序 **0**（渲染最底），只挂「吞事件」监听 → 点在面板任意槽位或槽位
     * 之间的空隙时，引擎命中它 → 事件被吞、不再冒泡到 Canvas 触发手牌缩略。
     *
     * 🔴 为什么不直接把监听挂在面板**根节点**上：
     *    根节点的 UITransform 是 `contentH` 逐段累加出来的对称包围盒，与各槽位**真实**
     *    包围盒可能对不上（实测：额外能量点排在底部时 ExtraPP 会探出根包围盒下沿约 13px；
     *    各槽位竖直方向本身是**紧贴无缝**的）。用「按真实槽位并集」定位的专用节点，
     *    命中范围永远贴合面板可视内容，且只需**一个**监听器（不必给每个子节点都挂）。
     */
    private static readonly N_SWALLOW = 'SwallowArea';
    /** 文字节点名（由本组件创建/复用） */
    private static readonly N_PP_TEXT_ROW = 'PPText';
    private static readonly N_NUM_CUR = 'NumCur';
    private static readonly N_NUM_MAX = 'NumMax';
    private static readonly N_ROUND_TEXT = 'RoundText';
    /** 槽4 两块横幅里「N回合后可再次使用」的 Label 名 */
    private static readonly N_EXTRA_TEXT = 'ExtraText';

    // ============ 素材「本体矩形」相对裁剪框的左右比例（实测）============
    /** PlayerPP 本体左边 / 右边（对齐基准） */
    private static readonly P_BODY_L = 0.0056;
    private static readonly P_BODY_R = 0.9935;
    /** EnemyPP 本体左边 / 右边 */
    private static readonly N_BODY_L = 0.0282;
    private static readonly N_BODY_R = 0.9725;
    /** 槽4 素材（ExtraPP / LockedExtraPP）本体左边 / 右边（取两者均值） */
    private static readonly E_BODY_L = 0.07215;
    private static readonly E_BODY_R = 0.99905;

    // ============ PlayerPP 素材底部 10 个 PP 圆点的实测几何（1339×685 素材，归一）============
    // 量法（2026-09-19 重测）：对**裁剪后**矩形（trimX=42, trimY=56, 1240×571）在 y∈[360,520] 槽位带里
    //   ① 用「近中性灰黑」掩码（max(rgb)<45 且 max-min<20，背景是青绿 g/b≫r 不会误中）
    //      找 10 个黑芯的连通块 → 圆心与直径；
    //   ② 金环外径 ≈108px、黑芯直径 ≈91px（圆形），环厚 ~8px。
    //   🔴 归一化基准 = **裁剪后矩形**（Sprite 用 CUSTOM+SIMPLE 把它拉伸铺满节点矩形），
    //      不是原始 1339×685 —— 旧常量就是按错的基准/错行量出来的，才会整体偏右偏上、还画小了。
    /** 第 0 个（最左）圆心 u */
    private static readonly DOT_U0 = 0.07737;
    /** 相邻圆心 u 步长（10 个圆心等距） */
    private static readonly DOT_DU = 0.0944;
    /** 圆心 v（10 个同心） */
    private static readonly DOT_V = 0.77011;
    /** 黑芯半径（分别按素材宽 / 高归一 → 直接乘节点宽/高即为像素正确的圆；黑芯在素材里是正圆） */
    private static readonly DOT_RU = 0.03669;
    private static readonly DOT_RV = 0.07968;
    /** 圆点数量 */
    private static readonly DOT_COUNT = 10;

    /** 十个圆点的容器名 / 球节点前缀（运行时按名复用/就地创建） */
    private static readonly N_DOTS = 'PPDots';
    private static readonly N_DOT_PREFIX = 'Dot';

    /** 上一次已应用的参数签名，用于「只在变化时重排」（编辑器实时预览） */
    private _sig = '';

    // ====================== 额外能量点：运行时状态（不序列化）======================
    /** 倒计时剩余回合数（对局开始 = extraStartRounds，此后每个后手操作回合开始时 −1） */
    private _extraRounds = 6;
    /** 倒计时是否已走完（label 已换成 extraDepletedText，之后**不再更新数字**） */
    private _extraDepleted = false;
    /** 是否处于「点亮（高亮）」状态 —— 点亮时打出卡牌的剩余费用 +1（额外费用最后花） */
    private _extraArmed = false;
    /** 上一次已经施加到 CardGlow 上的点亮态（避免每次重排都重启一次淡入/淡出补间） */
    private _extraGlowArmed = false;
    /** 本次触摸是否落在额外能量点上（只有 TOUCH_END 才算一次点击，拖出即作废） */
    private _extraTouchDown = false;

    /** 本帧待修正「/最大PP」横向位置的行（文本宽要等 Label 真正排版完才准） */
    private _pendingRows: { cur: UITransform; max: Node; gap: number }[] = [];

    // ====================== 生命周期 ======================

    onLoad(): void {
        this.applyLayout();
    }

    update(): void {
        // 编辑器里直接改 Inspector 也能即时生效：参数变了才重排（开销极小）
        if (this._signature() !== this._sig) this.applyLayout();
    }

    lateUpdate(): void {
        // 🔴 Label 的文本宽在「设置 string 的同一帧」里不一定是最终值 →
        //    下一帧再用真实宽度把「/最大PP」贴到「当前PP」右边（只做一次，之后列表为空）
        if (!this._pendingRows.length) return;
        const rows = this._pendingRows;
        this._pendingRows = [];
        for (const r of rows) {
            if (!r.cur.isValid || !r.max.isValid) continue;
            // 🔴 强制排版后再量宽：「/最大PP」的字符串本帧刚从 "/9"→"/10" 时，
            //    它的排版数据（UITransform.width）仍是上一帧的旧值 —— 首次到 10/10
            //    会用旧宽（偏小）做钳制 → 依然溢出一帧且不再修正（修正是一次性的）。
            //    先对两个标签各做一次 updateRenderData(true)，保证本帧拿到的就是最终宽度。
            const curLb = r.cur.getComponent(Label);
            const maxLb = r.max.getComponent(Label);
            if (curLb) curLb.updateRenderData(true);
            if (maxLb) maxLb.updateRenderData(true);
            // 只改 x，**必须保留 y**：y 是「底线对齐」算出来的位置，写成 0 会把它顶掉
            let x = r.cur.width + r.gap;

            // 🔴「10/10」防溢出（任务：左边的 10 位置不动，保证 /10 不超出能量框）：
            //    「当前PP」位数变多（10）时，按 默认间隙+真实文本宽 算出的「/最大PP」
            //    右缘会超出横幅。处理：左数字锚点完全不动 → 先压缩与左数字的间隙，
            //    压到最小间隙还不够 → 等比缩小「/最大PP」节点（锚点在左下，向左收）。
            const row = r.max.parent;
            const hostUT = row && row.parent ? row.parent.getComponent(UITransform) : null;
            if (row && hostUT && hostUT.width > 0) {
                const w = hostUT.width;
                const rowX = row.position.x;                       // 行（=左数字左缘）在横幅内的 x
                const pad = w * 0.02;                              // 右缘内边距（横幅宽的 2%）
                const limit = w / 2 - pad - rowX;                  // row 本地系下「/最大PP」右缘的上限
                const mut = r.max.getComponent(UITransform);
                const maxW = mut ? mut.width : 0;
                const minGap = Math.max(0, w * 0.02);              // 与左数字的最小间隙
                if (maxW > 0 && x + maxW > limit) {
                    x = Math.max(Math.min(x, limit - maxW), r.cur.width + minGap);
                    if (mut && x + mut.width > limit) {
                        // 间隙压到最小还放不下 → 等比缩小（左缘不动，右缘收到 limit 内）
                        const k = Math.max(0.4, Math.min(1, (limit - x) / Math.max(1, mut.width)));
                        r.max.setScale(k, k, 1);
                    } else {
                        r.max.setScale(1, 1, 1);
                    }
                } else {
                    r.max.setScale(1, 1, 1);
                }
            }
            r.max.setPosition(x, r.max.position.y, 0);
        }
    }

    // ====================== 对外 API ======================

    /**
     * 切换槽4 状态：true = 锁定态(LockedExtraPP)，false = 可用态(ExtraPP)。
     * 🔴 宽松布尔化：Button 的 `customEventData` / JSON / MCP 传参到达时都是**字符串**
     *    （`'false'` 用 `!!` 会被判成 true）→ 必须走 `_toBool`。
     */
    public setExtraState(locked: boolean): void {
        const want = TurnControlPanel._toBool(locked);
        if (this.showLockedExtra === want) return;
        this.showLockedExtra = want;
        this.applyLayout();
    }

    /** 当前槽4 是否处于锁定态 */
    public isExtraLocked(): boolean {
        return this.showLockedExtra;
    }

    // ====================== 额外能量点：归属 / 倒计时 / 状态 ======================

    /**
     * 设置额外能量点归属方（= 后手），由 TurnManager 在开战 / 重开时写入。
     *   'player' → 我方为后手，《额外能量点》横幅排在**我方能量点（PlayerPP）下方**；
     *   'enemy'  → 敌方为后手，横幅排在**敌方能量点（EnemyPP）上方**；
     * 两种情况与各自能量点横幅的距离都用同一个 gapPPToExtra。
     */
    public setExtraSide(side: 'player' | 'enemy'): void {
        const want: 'player' | 'enemy' = (side === 'enemy') ? 'enemy' : 'player';
        if (this.extraSide === want) return;
        this.extraSide = want;
        this.applyLayout();
    }

    /** 额外能量点当前归属方 */
    public get extraOwner(): 'player' | 'enemy' {
        return this.extraSide;
    }

    /**
     * 对局开始 / 重开时重置额外能量点：
     *   倒计时 = extraStartRounds（label「6回合后可再次使用」）、未点亮、状态回到 **ExtraPP**（可用态）。
     */
    public resetExtra(): void {
        this._extraRounds = Math.max(0, Math.round(this.extraStartRounds));
        this._extraDepleted = this._extraRounds <= 0;
        this._extraArmed = false;
        this._extraTouchDown = false;
        this.showLockedExtra = false;              // 游戏一开始默认为 ExtraPP
        console.log(`[TurnControlPanel] 额外能量点初始化：归属${this.extraSide === 'player' ? '我方' : '敌方'}（后手）`
            + `、${this._extraDepleted ? this.extraDepletedText : this._extraRounds + '回合后可再次使用'}、状态 = ExtraPP`);
        this.applyLayout();
    }

    /**
     * 后手的操作回合开始时调用：倒计时 −1。
     * 🔴 若「再减 1 就变 0」→ **不显示 0**，直接把 label 换成 extraDepletedText 并停止更新数字；
     *    此时状态回到 **ExtraPP**（可用），可再次点亮使用；用过之后又变 LockedExtraPP。
     */
    public tickExtraCountdown(): void {
        if (this._extraDepleted) return;           // 已走完：不再更新数字
        if (this._extraRounds - 1 <= 0) {
            this._extraRounds = 0;
            this._extraDepleted = true;
            this._extraArmed = false;
            this.showLockedExtra = false;          // 变回 ExtraPP
            console.log(`[TurnControlPanel] 额外能量点：倒计时走完 → 「${this.extraDepletedText}」（状态回到 ExtraPP）`);
        } else {
            this._extraRounds -= 1;
            console.log(`[TurnControlPanel] 额外能量点：后手回合开始 → 「${this.extraReuseText(this._extraRounds)}」`);
        }
        this.applyLayout();
    }

    /** label 文本：倒计时走完显示 extraDepletedText（无数字），否则「N回合后可再次使用」 */
    private extraReuseText(n: number): string {
        return String(Math.max(0, Math.round(n))) + '回合后可再次使用';
    }

    /** 额外汇总文本（倒计时走完 → 无数字的那句） */
    private extraLabelText(): string {
        return this._extraDepleted ? this.extraDepletedText : this.extraReuseText(this._extraRounds);
    }

    /** 倒计时是否已走完（label 已无数字） */
    public get extraDepleted(): boolean {
        return this._extraDepleted;
    }

    /** label 当前实际显示的文字（供测试/探针核对） */
    public get extraText(): string {
        return this.extraLabelText();
    }

    /**
     * 现在能不能点这个额外能量点按钮：
     *   · 必须是 **ExtraPP**（可用态）——锁定态点了无效；
     *   · extraPlayerOnly 打开时，只允许**我方为后手**（横幅挂在我方那侧）时点击；
     *   · **任务二**：我方为后手时，敌方回合内一律锁定为普通态 → 点了也不进入点亮态；
     *   · ExtraPP 横幅节点必须存在且显示中。
     */
    public canClickExtra(): boolean {
        if (this.extraPlayerOnly && this.extraSide !== 'player') return false;
        if (TurnControlPanel._toBool(this.showLockedExtra)) return false;
        if (this.isExtraTurnLocked()) return false;
        const n = this.node.getChildByName(TurnControlPanel.N_EXTRA);
        return !!(n && n.isValid && n.activeInHierarchy);
    }

    /**
     * **任务二**：额外能量点是否被「回合」锁在普通态。
     *
     * 只有**我方为后手**（`extraPlayerOnly` 且归属我方）时才谈得上锁定 —— 此时
     * 额外能量点只应在我方自己的操作回合里可用；轮到敌方行动时，按钮既不能点亮、
     * 也不给任何费用加成，状态强制回到普通态。
     * 归属敌方为后手时恒为 false（那一侧本来就不能点，逻辑照旧保留）。
     */
    public isExtraTurnLocked(): boolean {
        if (!this.extraPlayerOnly) return false;
        if (this.extraSide !== 'player') return false;
        return this.isEnemyRound();
    }

    /**
     * **任务二**：把「回合锁」落到状态上 —— 处于锁定期却还亮着就强制取消点亮。
     * 幂等；返回是否真的改动了状态（调用方据此决定要不要重排）。
     */
    public enforceExtraTurnLock(): boolean {
        if (!this.isExtraTurnLocked()) return false;
        if (!this._extraArmed) return false;
        this._extraArmed = false;
        console.log('[TurnControlPanel] 额外能量点：敌方回合内 → 强制取消点亮，回到普通状态');
        return true;
    }

    /**
     * **任务一**：把额外能量点复位成**普通状态**（取消点亮），
     * **不动**倒计时、也不改 ExtraPP ⇄ LockedExtraPP 的归属状态。
     * 用于「带着点亮态结束我方回合」等需要收手的时机。
     */
    public disarmExtra(reason = ''): void {
        if (!this._extraArmed) return;
        this._extraArmed = false;
        console.log(`[TurnControlPanel] 额外能量点已取消点亮 → 回到普通状态`
            + (reason ? `（${reason}）` : ''));
        this.applyLayout();
    }

    /** 点击一次：点亮（高亮）；再点一次：取消点亮（需求：点一次高亮、再点一次恢复） */
    public toggleExtraArm(): void {
        if (!this.canClickExtra()) {
            console.log('[TurnControlPanel] 额外能量点当前不可点击'
                + `（归属=${this.extraSide}、锁定=${TurnControlPanel._toBool(this.showLockedExtra)}、`
                + `extraPlayerOnly=${this.extraPlayerOnly}）`);
            return;
        }
        this._extraArmed = !this._extraArmed;
        console.log(`[TurnControlPanel] 额外能量点${this._extraArmed
            ? '**已点亮**：打出卡牌时剩余费用 +1（仍然最后花，仅当正常剩余不足时补差额）'
            : '已取消点亮'}`);
        this.applyLayout();
    }

    /** 是否已点亮 */
    public get extraArmed(): boolean {
        return this._extraArmed;
    }

    /**
     * 某一方**当前可用的额外费用**（0 或 1）：
     * 只有「已点亮 且 未锁定 且 该方就是额外能量点的归属方」才给 1。
     * **任务二**：被「回合锁」锁住时恒为 0（我方为后手的敌方回合里不该有任何加成）。
     */
    public extraCharge(side: 'player' | 'enemy'): number {
        if (!this._extraArmed) return 0;
        if (TurnControlPanel._toBool(this.showLockedExtra)) return 0;
        if (this.isExtraTurnLocked()) return 0;
        return this.extraSide === side ? 1 : 0;
    }

    /**
     * 消耗掉额外能量点（打出卡牌时真的用到了那 1 点额外费用）：
     * **立刻**把状态切成 LockedExtraPP 并取消点亮（需求）。
     */
    public consumeExtra(): void {
        this._extraArmed = false;
        this.showLockedExtra = true;
        console.log('[TurnControlPanel] 额外能量点已被使用 → 状态切换为 LockedExtraPP');
        this.applyLayout();
    }

    /**
     * ★ **把消耗掉的额外能量点还回来**（`consumeExtra` 的逆操作）。
     * 用于「扣费时动用了额外能量点、但这张牌最终**没打出去**」（入场曲 / 模式选择点空白回手）：
     * 只退普通 PP 是不够的 —— 卡没打出去、跳费却没了（实测 bug，见 CardPlay.refundPP）。
     * 幂等：本来就可用时再调一次也无害。
     */
    public restoreExtra(): void {
        if (this._extraArmed && !TurnControlPanel._toBool(this.showLockedExtra)) return;
        this._extraArmed = true;
        this.showLockedExtra = false;
        console.log('[TurnControlPanel] 额外能量点已返还 → 状态回到 ExtraPP（可用）');
        this.applyLayout();
    }

    /**
     * 切换槽2 状态：true = 敌方回合钮(EnemyRoundButton)，false = 我方回合钮(RoundButton)。同样走宽松布尔化。
     *
     * **任务二**：切到「敌方回合」时，顺手把「回合锁」落到额外能量点上
     * （我方为后手时强制取消点亮 → 状态回到普通态）。
     */
    public setRoundSide(enemy: boolean): void {
        const want = TurnControlPanel._toBool(enemy);
        if (this.showEnemyRound === want) return;
        this.showEnemyRound = want;
        this.enforceExtraTurnLock();
        this.applyLayout();
    }

    /** 当前槽2 是否显示敌方回合钮 */
    public isEnemyRound(): boolean {
        return this.showEnemyRound;
    }

    /**
     * 更新 PP 数值（左边的数字 = 当前还能用；右边的 = 本回合上限 = PP 槽位数）。
     * 传入 side='enemy' | 'player'。只改数值不重排（除非数值真的变了）。
     */
    public setPP(side: 'enemy' | 'player', current: number, max: number): void {
        if (side === 'enemy') {
            this.enemyCurrentPP = Math.max(0, Math.round(current));
            this.enemyMaxPP = Math.max(0, Math.round(max));
        } else {
            this.playerCurrentPP = Math.max(0, Math.round(current));
            this.playerMaxPP = Math.max(0, Math.round(max));
        }
        this.applyLayout();
    }

    /**
     * 按当前参数重排整个面板 + 刷新所有文字。幂等，可随时调用。
     * 最终尺寸 = 各槽位「基础尺寸」× panelScale；字号同理。
     */
    public applyLayout(): void {
        this._sig = this._signature();

        // ---- 0. 取子节点（槽1/2/3 必需；槽4 与敌方回合钮缺失则跳过对应部分）----
        const enemy = this.node.getChildByName(TurnControlPanel.N_ENEMY);
        const round = this.node.getChildByName(TurnControlPanel.N_ROUND);
        const player = this.node.getChildByName(TurnControlPanel.N_PLAYER);
        const enemyRound = this.node.getChildByName(TurnControlPanel.N_ROUND_ENEMY);
        const extra = this.node.getChildByName(TurnControlPanel.N_EXTRA);
        const locked = this.node.getChildByName(TurnControlPanel.N_LOCKED);
        if (!enemy || !round || !player) return;

        // ---- 1. 等比缩放：基础尺寸 × panelScale ----
        const s = this.panelScale;
        const hEnemy = this.enemyPPSize.height * s;
        const wRound = this.roundButtonSize.width * s;
        const hRound = this.roundButtonSize.height * s;
        const wPlayer = this.playerPPSize.width * s;
        const hPlayer = this.playerPPSize.height * s;
        const hExtra = this.extraPPSize.height * s;
        const g1 = this.gapEnemyToRound * s;
        const g2 = this.gapRoundToPlayer * s;
        // 🔴 额外能量点 ↔ **它所属那一方**能量点横幅 的距离：敌我共用同一个变量
        const gx = this.gapPPToExtra * s;
        /** 额外能量点排在**敌方能量点上方**（敌方为后手）；否则排在我方能量点下方（我方为后手） */
        const extraAtTop = this.extraSide === 'enemy';
        const hasExtra = !!(extra && locked);

        // ---- 2. 横向对齐：槽1 / 槽4 的「本体左右竖直边」与槽3 PlayerPP 重合 ----
        //     （只动宽度与横向位置，不动高度 → 不影响下面的纵向排布）
        let wEnemy = this.enemyPPSize.width * s;
        let enemyX = 0;
        if (this.alignEnemyToPlayer) {
            const fit = this._fitBodyToPlayer(wPlayer, TurnControlPanel.N_BODY_L, TurnControlPanel.N_BODY_R);
            wEnemy = fit.w;
            enemyX = fit.x;
        }

        let wExtra = this.extraPPSize.width * s;
        let extraX = 0;
        if (this.alignExtraToPlayer) {
            const fit = this._fitBodyToPlayer(wPlayer, TurnControlPanel.E_BODY_L, TurnControlPanel.E_BODY_R);
            wExtra = fit.w;
            extraX = fit.x;
        }

        // ---- 3. 竖向排布：内容整体在面板内垂直居中 ----
        //    · 我方为后手 → ExtraPP ⇄ LockedExtraPP 排在 PlayerPP **下方**；
        //    · 敌方为后手 → 同样的两块横幅排在 EnemyPP **上方**（与 EnemyPP 的距离同样是 gx）。
        const contentH = (hasExtra ? hExtra + gx : 0) + hEnemy + g1 + hRound + g2 + hPlayer;
        let cursor = contentH / 2;                       // 内容顶边（相对面板中心，向下为负）
        let extraY = 0;

        if (hasExtra && extraAtTop) {
            cursor -= hExtra / 2;
            extraY = cursor;
            // 两块横幅用**同一份尺寸与坐标** → 切换时位置大小必然不变
            this._place(extra!, wExtra, hExtra, extraX, extraY);
            this._place(locked!, wExtra, hExtra, extraX, extraY);
            cursor -= hExtra / 2 + gx;
        }

        cursor -= hEnemy / 2;
        this._place(enemy, wEnemy, hEnemy, enemyX, cursor);
        cursor -= hEnemy / 2 + g1;

        cursor -= hRound / 2;
        const roundY = cursor;
        this._place(round, wRound, hRound, 0, roundY);
        // 槽2 两个按钮**同尺寸同坐标**（缺一个也不影响另一个）
        if (enemyRound) this._place(enemyRound, wRound, hRound, 0, roundY);
        cursor -= hRound / 2 + g2;

        cursor -= hPlayer / 2;
        this._place(player, wPlayer, hPlayer, 0, cursor);
        cursor -= hPlayer / 2;

        if (hasExtra && !extraAtTop) {
            cursor -= gx + hExtra / 2;
            extraY = cursor;
            this._place(extra!, wExtra, hExtra, extraX, extraY);
            this._place(locked!, wExtra, hExtra, extraX, extraY);
        }

        // ---- 4. 两组互斥显隐 ----
        // 🔴 一律用「规范化后的布尔」比较：万一场景里残留了字符串 'true'/'false'
        //    （MCP / JSON / customEventData 传参所致），`x === 'true'` 会恒不成立 →
        //    这里统一归一，既能正确互斥，也能在下一帧把脏数据自愈回真布尔。
        const wantEnemyRound = TurnControlPanel._toBool(this.showEnemyRound);
        const wantLockedExtra = TurnControlPanel._toBool(this.showLockedExtra);
        if (enemyRound && round.active === wantEnemyRound) round.active = !wantEnemyRound;
        if (enemyRound && enemyRound.active !== wantEnemyRound) enemyRound.active = wantEnemyRound;
        if (extra && locked) {
            if (extra.active === wantLockedExtra) extra.active = !wantLockedExtra;
            if (locked.active !== wantLockedExtra) locked.active = wantLockedExtra;
        }

        // ---- 4b. 任务四：两个回合钮都挂「点击互切」，并把事件吞掉 ----
        this._bindRoundButtons(round, enemyRound);

        // ---- 4c. 额外能量点：点亮高亮 + 点击判定 ----
        if (extra && locked) this._applyExtraVisual(extra);
        this._bindExtraClick(extra, locked);

        // ---- 5. 文字 ----
        const numCurEnemy = this.enemyPPNumFontSize * s;
        const numCurPlayer = this.playerPPNumFontSize * s;
        const numMax = this.ppMaxFontSize * s;
        this._layoutPPLabels(enemy, wEnemy, hEnemy, this.enemyCurrentPP, this.enemyMaxPP,
            numCurEnemy, numMax, this.enemyNumAnchorU, this.enemyNumAnchorV);
        this._layoutPPLabels(player, wPlayer, hPlayer, this.playerCurrentPP, this.playerMaxPP,
            numCurPlayer, numMax, this.playerNumAnchorU, this.playerNumAnchorV);
        this._layoutRoundLabel(round, '结束\n回合', this.roundLabelFontSize * s);
        if (enemyRound) this._layoutRoundLabel(enemyRound, '对手\n回合', this.enemyRoundLabelFontSize * s);
        // 任务一：槽4 两块横幅里各自文字框的「N回合后可再次使用」——数字共用 extraReuseRounds
        if (extra && locked) {
            this._layoutExtraText(extra, wExtra, hExtra, this.extraTextAnchorU, this.extraTextAnchorV);
            this._layoutExtraText(locked, wExtra, hExtra, this.lockedTextAnchorU, this.lockedTextAnchorV);
        }
        // 任务三：PlayerPP 底部素材自带的 10 个空槽，按 NumCur / NumMax 染色
        this._layoutDots(player, wPlayer, hPlayer);

        // ---- 6. 根节点尺寸 = 内容包围盒（水平对称包络 + 内容高度）----
        const rootUT = this.node.getComponent(UITransform);
        if (rootUT) {
            const halfW = Math.max(
                Math.abs(enemyX) + wEnemy / 2,
                wRound / 2,
                wPlayer / 2,
                Math.abs(extraX) + wExtra / 2,
            );
            rootUT.setContentSize(halfW * 2, contentH);
        }

        // ---- 7. 「吞触摸区」= 可视内容包围列（不含根包围盒下方那段空白）----
        this._layoutSwallowArea();
    }

    /**
     * 摆放 / 维护「吞触摸区」节点（见 `N_SWALLOW` 注释）。
     *
     * 尺寸取所有**可视槽位**（EnemyPP / PlayerPP / RoundButton / EnemyRoundButton /
     * ExtraPP / LockedExtraPP）在面板局部坐标下的并集，即
     *   left/right = min/max 各槽位左右边，bottom/top = min/max 各槽位上下边。
     * 该并集覆盖整条面板「列」（各槽位竖直紧贴，若有空隙也一并覆盖 → 点空隙同样
     * 不缩手牌），且**不超出槽位真实边界**（不会像根包围盒那样多吞一圈）。
     * 节点排在兄弟序 0 → 渲染最底、命中优先级最低，回合钮 / 额外能量点自己的监听
     * 依然优先命中，互不干扰。
     */
    private _layoutSwallowArea(): void {
        const area = this._ensureNode(this.node, TurnControlPanel.N_SWALLOW);
        const aut = area.getComponent(UITransform) || area.addComponent(UITransform);

        const names = [
            TurnControlPanel.N_ENEMY, TurnControlPanel.N_PLAYER, TurnControlPanel.N_ROUND,
            TurnControlPanel.N_ROUND_ENEMY, TurnControlPanel.N_EXTRA, TurnControlPanel.N_LOCKED,
        ];
        let l = Number.POSITIVE_INFINITY, r = Number.NEGATIVE_INFINITY;
        let b = Number.POSITIVE_INFINITY, t = Number.NEGATIVE_INFINITY;
        for (const nm of names) {
            const c = this.node.getChildByName(nm);
            if (!c || !c.activeInHierarchy) continue;
            const cut = c.getComponent(UITransform);
            if (!cut || cut.width <= 0 || cut.height <= 0) continue;
            const cl = c.position.x - cut.width * cut.anchorPoint.x;
            const cr = c.position.x + cut.width * (1 - cut.anchorPoint.x);
            const cb = c.position.y - cut.height * cut.anchorPoint.y;
            const ct = c.position.y + cut.height * (1 - cut.anchorPoint.y);
            l = Math.min(l, cl); r = Math.max(r, cr);
            b = Math.min(b, cb); t = Math.max(t, ct);
        }
        const ok = Number.isFinite(l) && Number.isFinite(b) && r > l && t > b;
        if (!ok) { area.active = false; return; }        // 拿不到任何槽位 → 本帧不吞
        area.active = true;
        area.setSiblingIndex(0);                          // 渲染最底，槽位/按钮优先命中
        aut.setAnchorPoint(0.5, 0.5);
        aut.setContentSize(r - l, t - b);
        area.setPosition((l + r) / 2, (b + t) / 2, 0);
        this._bindSwallowArea(area);
    }

    /**
     * 给「吞触摸区」挂 TOUCH_START / END / CANCEL 做吞事件（幂等：先 off 再 on）。
     *
     * 🔴 为什么必须自己 `node.on(...)` 而**不是**加 `cc.Button`：
     *    · `Button` 的 click 回调拿不到原始 `EventTouch` → 没法设 `propagationStopped`；
     *    · `HandMinimize` 是挂在 **Canvas** 上监听全屏 `TOUCH_START` 的
     *      （见 `HandMinimize.onOutsideTouch`：按下的不是自己手牌里的卡 → `minimize()`）。
     *    面板里的槽位不在手牌里 ⇒ 不拦截的话，点一下面板就会**顺带把手牌缩略掉**。
     *    在这层 `propagationStopped = true` → 冒泡链在到达 Canvas 前就断掉。
     */
    private _bindSwallowArea(area: Node): void {
        for (const ev of [Node.EventType.TOUCH_START, Node.EventType.TOUCH_END, Node.EventType.TOUCH_CANCEL]) {
            area.off(ev as unknown as string, this._onPanelTouch, this);
        }
        if (!this.swallowPanelTouches) return;
        area.on(Node.EventType.TOUCH_START, this._onPanelTouch, this);
        area.on(Node.EventType.TOUCH_END, this._onPanelTouch, this);
        area.on(Node.EventType.TOUCH_CANCEL, this._onPanelTouch, this);
    }

    // ====================== 内部工具 ======================

    /**
     * 宽松布尔化。
     * 🔴 场景/Button 事件/JSON/MCP 传进来的布尔常常是**字符串**，而 `!!'false' === true`
     *    → 直接 `!!` 会把「关闭」当成「开启」。这里显式把 'false'/'0'/'' 判为 false。
     */
    private static _toBool(v: unknown): boolean {
        if (typeof v === 'string') {
            const s = v.trim().toLowerCase();
            return s !== '' && s !== '0' && s !== 'false';
        }
        return !!v;
    }

    /**
     * 令某槽位素材的**本体左右竖直边**与 PlayerPP 的本体重合，
     * 反推该槽位应使用的**节点宽度**与**中心 x**。
     *
     * 推导（节点中心为原点，节点矩形 ↔ 裁剪框）：
     *   本体左边 = x - w/2 + w·bodyL = x + w·(bodyL - 0.5)
     *   本体右边 = x + w·(bodyR - 0.5)
     * 令「本体宽 == PlayerPP 本体宽」→ w = pBodyW / (bodyR - bodyL)
     * 令「本体左边 == PlayerPP 本体左边」→ x = pBodyL + w·(0.5 - bodyL)
     */
    private _fitBodyToPlayer(playerW: number, bodyL: number, bodyR: number): { w: number; x: number } {
        const pBodyL = -playerW / 2 + playerW * TurnControlPanel.P_BODY_L;
        const pBodyR = -playerW / 2 + playerW * TurnControlPanel.P_BODY_R;
        const w = (pBodyR - pBodyL) / (bodyR - bodyL);
        return { w, x: pBodyL + w * (0.5 - bodyL) };
    }

    /** 设置一个槽位节点的尺寸与位置（并保证 Sprite 用 CUSTOM 模式按节点尺寸铺满） */
    private _place(n: Node, w: number, h: number, x: number, y: number): void {
        const ut = n.getComponent(UITransform) || n.addComponent(UITransform);
        ut.setContentSize(w, h);
        n.setPosition(x, y, 0);

        const sp = n.getComponent(Sprite);
        if (sp) {
            sp.sizeMode = Sprite.SizeMode.CUSTOM;        // 0 = CUSTOM，贴图铺满节点矩形
            sp.type = Sprite.Type.SIMPLE;                // 0 = SIMPLE，整图拉伸
        }
    }

    /** 按名取子节点，没有就就地新建（层级/可渲染性与父节点一致） */
    private _ensureNode(parent: Node, name: string): Node {
        let n = parent.getChildByName(name);
        if (!n) {
            n = new Node(name);
            n.layer = parent.layer;
            n.parent = parent;
        }
        return n;
    }

    /** 按名取（或新建）一个 Label 子节点，并统一基础设置 */
    private _ensureLabel(parent: Node, name: string): { lb: Label; ut: UITransform } {
        const n = this._ensureNode(parent, name);
        const ut = n.getComponent(UITransform) || n.addComponent(UITransform);
        let lb = n.getComponent(Label);
        if (!lb) lb = n.addComponent(Label);
        lb.useSystemFont = true;
        lb.overflow = Label.Overflow.NONE;               // 不自适应父框，节点尺寸 = 文本尺寸
        lb.enableWrapText = false;
        lb.verticalAlign = Label.VerticalAlign.CENTER;
        return { lb, ut };
    }

    /** 写一个 Label 的文字 / 字号 / 字体族 / 对齐（颜色与描边固定为白字暗边） */
    private _style(lb: Label, text: string, size: number, family: string, hAlign: HorizontalTextAlignment, lineGap = 1.02): void {
        lb.string = text;
        lb.fontSize = size;
        lb.lineHeight = Math.round(size * lineGap);
        lb.fontFamily = family || '';
        lb.color = _colText;
        lb.horizontalAlign = hAlign;
        lb.enableOutline = true;
        lb.outlineColor = _colOutline;
        lb.outlineWidth = Math.max(1, Math.round(size * 0.055));
    }

    /**
     * 一块 PP 横幅上的「当前PP / 最大PP」文字。
     * 位置用**归一锚点**（相对素材裁剪框）换算 → 与面板缩放、竖直边对齐都解耦。
     */
    private _layoutPPLabels(host: Node, w: number, h: number, cur: number, max: number,
                            curSize: number, maxSize: number, u: number, vBottom: number): void {
        // === 任务二：让「当前 PP」数字的**可见底边**与素材里「能量点」三字的底边齐平 ===
        // vBottom = 实测的「能量点」像素底边（归一）。row 的 y 先按「文本框底边落在 vBottom」
        // 算出来，再整体下压 lineHeight×descentRatio —— Label 基线下方本来就有降部留白，
        // 不补这一下，字形底边会浮在「能量点」底边上方几个像素。
        const row = this._ensureNode(host, TurnControlPanel.N_PP_TEXT_ROW);
        const curLine = Math.round(curSize * 1.02);
        const maxLine = Math.round(maxSize * 1.02);
        const lift = this.ppNumDescentRatio;
        row.setPosition(-w / 2 + w * u, h / 2 - h * vBottom - curLine * lift, 0);

        const curLab = this._ensureLabel(row, TurnControlPanel.N_NUM_CUR);
        const maxLab = this._ensureLabel(row, TurnControlPanel.N_NUM_MAX);
        // 🔴 左**底**对齐（anchor = (0,0) → 节点原点即文本框左下角）。
        //    两个字号不同 → 各用自己的 lineHeight×lift 补偿，两条字的**底线**才会共线。
        curLab.ut.setAnchorPoint(0, 0);
        maxLab.ut.setAnchorPoint(0, 0);
        curLab.lb.node.setPosition(0, 0, 0);
        const maxDy = (curLine - maxLine) * lift;        // 「/最大」更小 → 相对抬一点
        maxLab.lb.node.setPosition(0, maxDy, 0);

        const curTxt = String(Math.max(0, Math.round(cur)));
        const maxTxt = '/' + String(Math.max(0, Math.round(max)));
        this._style(curLab.lb, curTxt, curSize, this.ppNumberFontFamily, Label.HorizontalAlign.LEFT);
        this._style(maxLab.lb, maxTxt, maxSize, this.ppNumberFontFamily, Label.HorizontalAlign.LEFT);

        // 🔴 文本宽要等 Label 真正排版完才准：本帧先按「强制刷新」拿一次，
        //    下一帧再由 lateUpdate 用最终宽度修正（只修正一次；**必须保留 y**）。
        curLab.lb.updateRenderData(true);
        const gap = this.ppNumGap * w;                   // 归一间隙 → 绝对单位
        maxLab.lb.node.setPosition(curLab.ut.width + gap, maxDy, 0);
        this._pendingRows.push({ cur: curLab.ut, max: maxLab.lb.node, gap });
    }

    /**
     * 任务一：一块「+1 能量点」横幅（ExtraPP 橙色可用态 / LockedExtraPP 灰色锁定态）里的
     * 「N回合后可再次使用」。N 由**唯一一个** `extraReuseRounds` 决定 → 两块横幅数字必然一致。
     * 位置用归一锚点（文字框中心），各素材量各自的。
     */
    private _layoutExtraText(host: Node, w: number, h: number, u: number, v: number): void {
        const lab = this._ensureLabel(host, TurnControlPanel.N_EXTRA_TEXT);
        // 🔴 修复「label 超出文字框」：
        //    修复前 = `Overflow.NONE` → Label 节点尺寸**跟着文字自动变宽**，
        //    实测「4回合后可再次使用」在该字号下宽 206.36px，而素材里的深色文字框只有 154px，
        //    于是文字左/右各溢出 ~26px / ~20px（比横幅本体还宽 11px）。
        //    现在 = 把 Label 尺寸**钉死成文字框**（归一 0.781 × 0.321，再按 pad 内收），
        //    并开 `Overflow.SHRINK`：文字再长也只等比缩字号，永远不越框。
        const boxW = Math.max(1, w * this.extraTextBoxWU * (1 - this.extraTextBoxPad));
        const boxH = Math.max(1, h * this.extraTextBoxHV);
        lab.ut.setAnchorPoint(0.5, 0.5);
        // 🔴 顺序要紧：先改 overflow，再设 contentSize。
        //    overflow=NONE 时 Label 会在渲染时用文本尺寸**反写**节点尺寸，把我们的框冲掉。
        lab.lb.overflow = this.extraTextShrinkToFit ? Label.Overflow.SHRINK : Label.Overflow.NONE;
        lab.lb.enableWrapText = false;
        lab.ut.setContentSize(boxW, boxH);
        lab.lb.node.setPosition(-w / 2 + w * u, h / 2 - h * v, 0);
        // 🔴 文字由**倒计时状态**决定：没走完 = 「N回合后可再次使用」（N = 剩余回合）；
        //    走完 = extraDepletedText（「已获取完所有额外能量点」，**不带数字**，此后再不更新）。
        this._style(lab.lb, this.extraLabelText(),
            this.extraReuseFontSize * this.panelScale, this.extraReuseFontFamily,
            Label.HorizontalAlign.CENTER);
    }

    /**
     * 任务三：PlayerPP 横幅底部**素材自带的 10 个「金环+黑芯」空槽**上叠球。
     *   · i < NumCur                → 绿球（已用）
     *   · NumCur <= i < NumMax      → 灰球（本回合上限内、尚未用）
     *   · i >= NumMax               → 不画（露出素材原本的黑芯）
     * 用 `Graphics` 直接画球：**不引入任何新素材**，也就没有「贴图导入类型 / spriteFrame 丢失」的风险。
     */
    private _layoutDots(host: Node, w: number, h: number): void {
        const box = this._ensureNode(host, TurnControlPanel.N_DOTS);
        box.setPosition(0, 0, 0);
        if (!this.ppDotsEnabled) { box.active = false; return; }
        box.active = true;

        const cur = Math.max(0, Math.round(this.playerCurrentPP));
        const max = Math.max(0, Math.round(this.playerMaxPP));
        const rU = TurnControlPanel.DOT_RU * this.ppDotScale;
        const rV = TurnControlPanel.DOT_RV * this.ppDotScale;

        for (let i = 0; i < TurnControlPanel.DOT_COUNT; i++) {
            const dot = this._ensureNode(box, TurnControlPanel.N_DOT_PREFIX + i);
            // 位置：素材归一 → 节点本地（相对横幅中心）
            dot.setPosition(-w / 2 + w * (TurnControlPanel.DOT_U0 + TurnControlPanel.DOT_DU * i),
                h / 2 - h * TurnControlPanel.DOT_V, 0);
            const ut = dot.getComponent(UITransform) || dot.addComponent(UITransform);
            ut.setContentSize(w * rU * 2, h * rV * 2);
            const g = dot.getComponent(Graphics) || dot.addComponent(Graphics);
            // 0 = 不画（黑芯），1 = 绿球（已用），2 = 灰球（上限内未用）
            const state = i < cur ? 1 : (i < max ? 2 : 0);
            this._drawDot(g, ut.contentSize.width * 0.5, state);
        }
    }

    /** 画一个「径向渐变 + 左上高光」的球（state: 0=清空不画, 1=绿, 2=灰） */
    private _drawDot(g: Graphics, r: number, state: number): void {
        g.clear();
        if (state === 0 || r <= 0) return;
        const green = state === 1;
        const core = green ? this.ppDotGreenCore : this.ppDotGrayCore;
        const edge = green ? this.ppDotGreenEdge : this.ppDotGrayEdge;

        // 由外向内逐层收小：外圈先画，内圈覆盖上去 → 等效径向渐变（球面感）
        const steps = 18;
        for (let k = steps; k >= 1; k--) {
            const t = k / steps;                          // 1 = 最外圈
            _dotCol.set(
                Math.round(edge.r + (core.r - edge.r) * (1 - t)),
                Math.round(edge.g + (core.g - edge.g) * (1 - t)),
                Math.round(edge.b + (core.b - edge.b) * (1 - t)),
                255,
            );
            g.fillColor = _dotCol;
            g.circle(0, 0, r * t);
            g.fill();
        }
        // 左上镜面高光：几层递减的白色椭圆叠出柔和亮斑
        for (let k = 0; k < 3; k++) {
            const f = 1 - k * 0.3;
            _dotCol.set(255, 255, 255, Math.round(70 - k * 18));
            g.fillColor = _dotCol;
            g.ellipse(-r * 0.30, r * 0.34, r * 0.36 * f, r * 0.26 * f);
            g.fill();
        }
    }

    // ====================== 额外能量点：高亮 / 点击 / 面板内不缩手牌 ======================

    /**
     * 点亮态的外观：整体轻微放大 + **贴着按钮本体轮廓**的外圈金色光晕。
     *
     * 🔴 光晕改用战场卡牌那一套（`CardGlow` + `resources/effects/CardGlow.effect`）：
     *    · 旧实现是 `Graphics.roundRect(节点宽, 节点高)` 描三层边 —— 但槽4 素材的
     *      **裁剪框 ≠ 本体矩形**（本体只占裁剪框 x∈[7.2%, 99.9%]，左边有 7.2% 全透明留白），
     *      于是金边画在**节点矩形**上、比用户实际看到的按钮整整宽出一圈（左缘实测空出 ~14px）。
     *    · CardGlow 是对贴图 **alpha 轮廓**做「环形加权扩散」，异形/带留白的素材自动贴合，
     *      与「我方战场卡牌被按住选中」用的是同一份实现，视觉口径完全一致。
     *    · 按钮节点自身带 Sprite ⇒ `CardGlow.frameSprite()` 回退取本节点 Sprite 作为轮廓来源。
     */
    private _applyExtraVisual(extra: Node): void {
        const armed = this._extraArmed && !TurnControlPanel._toBool(this.showLockedExtra);

        // 旧实现留下的 Graphics 光晕节点：见到就清掉，免得和新光晕叠在一起
        const legacy = extra.getChildByName('ExtraArmedGlow');
        if (legacy && legacy.isValid) legacy.destroy();

        const glow = this._ensureExtraGlow(extra);
        if (glow) {
            glow.glowThickness = Math.max(0, this.extraGlowThickness);
            glow.glowSoftness = this.extraGlowSoftness;
            glow.maxIntensity = Math.max(0, this.extraArmedIntensity);
            glow.fadeInDuration = Math.max(0, this.extraGlowFadeIn);
            glow.fadeOutDuration = Math.max(0, this.extraGlowFadeOut);
            glow.useQualityColor = false;                  // 槽4 不是卡牌（品质回查恒为空），固定用指定色
            glow.glowColor.set(this.extraArmedGlowColor);
            if (armed !== this._extraGlowArmed) {          // 只在状态真的翻转时播补间（别每帧重启淡入）
                this._extraGlowArmed = armed;
                if (armed) glow.fadeIn();
                else glow.fadeOut();
            }
        }

        const k = armed ? Math.max(1, this.extraArmedScale) : 1;
        extra.setScale(k, k, 1);
    }

    /** 取（或补挂）额外能量点按钮上的 `CardGlow` —— 轮廓光晕的唯一来源 */
    private _ensureExtraGlow(extra: Node): CardGlow | null {
        let g = extra.getComponent(CardGlow);
        if (!g) {
            try {
                g = extra.addComponent(CardGlow);
            } catch (e) {
                console.warn('[TurnControlPanel] 无法给额外能量点添加 CardGlow：', e);
                return null;
            }
        }
        return g;
    }

    /** 额外能量点「点一次点亮、再点一次取消」的触摸绑定（幂等：先 off 再 on） */
    private _bindExtraClick(extra: Node | null, locked: Node | null): void {
        const nodes: Node[] = [];
        if (extra) nodes.push(extra);
        if (locked) nodes.push(locked);
        for (const n of nodes) {
            n.off(Node.EventType.TOUCH_START, this._onExtraTouchStart, this);
            n.off(Node.EventType.TOUCH_END, this._onExtraTouchEnd, this);
            n.off(Node.EventType.TOUCH_CANCEL, this._onExtraTouchCancel, this);
            if (!this.roundButtonToggleOnClick) continue;   // 复用同一个「是否接管点击」总开关
            n.on(Node.EventType.TOUCH_START, this._onExtraTouchStart, this);
            n.on(Node.EventType.TOUCH_END, this._onExtraTouchEnd, this);
            n.on(Node.EventType.TOUCH_CANCEL, this._onExtraTouchCancel, this);
        }
    }

    private _onExtraTouchStart(event: EventTouch): void {
        this._extraTouchDown = true;
        this._swallow(event);              // 必须吞掉：否则 Canvas 上的 HandMinimize 会缩手牌
    }

    private _onExtraTouchEnd(event: EventTouch): void {
        const wasDown = this._extraTouchDown;
        this._extraTouchDown = false;
        if (wasDown) this.toggleExtraArm();      // 只有「按在这个按钮上再抬起」才算一次点击
        this._swallow(event);
    }

    private _onExtraTouchCancel(event: EventTouch): void {
        this._extraTouchDown = false;            // 拖出 → 本次点击作废
        this._swallow(event);
    }

    /**
     * 「吞触摸区」的统一回调（只为阻止冒泡到 Canvas 的手牌缩略监听）。
     * 命中范围由 `_layoutSwallowArea()` 决定：贴合面板可视内容的包围列。
     */
    private readonly _onPanelTouch = (event: EventTouch): void => {
        this._swallow(event);
    };

    // ====================== 任务四：回合钮点击互切 ======================

    /**
     * 给 RoundButton / EnemyRoundButton 挂触摸监听（幂等：先 off 再 on）。
     *
     * 🔴 为什么必须自己 `node.on(...)` 而**不是**加 `cc.Button`：
     *    · `Button` 的 click 回调拿不到原始 `EventTouch` → 没法设 `propagationStopped`；
     *    · 而 `HandMinimize` 是挂在 **Canvas** 上监听全屏 `TOUCH_START` 的
     *      （见 `HandMinimize.onOutsideTouch`：只要按下的不是自己手牌里的卡 → `minimize()`）。
     *    回合钮不在手牌里 ⇒ 不拦截的话，点一下回合钮会**顺带把手牌缩略掉**。
     *    在按钮自己这一层 `propagationStopped = true` → 冒泡链在到达 Canvas 前就断掉。
     *
     * 🔴 **敌方回合（显示「对手回合」）时它不是按钮**：只有吞事件，没有按下缩放反馈、
     *    也没有任何点击行为（见 `_onRoundTouchStart / _onRoundTouchEnd`）。
     */
    private _bindRoundButtons(round: Node, enemyRound: Node | null): void {
        const targets: Node[] = enemyRound ? [round, enemyRound] : [round];
        for (const n of targets) {
            n.off(Node.EventType.TOUCH_START, this._onRoundTouchStart, this);
            n.off(Node.EventType.TOUCH_END, this._onRoundTouchEnd, this);
            n.off(Node.EventType.TOUCH_CANCEL, this._onRoundTouchCancel, this);
            if (!this.roundButtonToggleOnClick) continue;
            n.on(Node.EventType.TOUCH_START, this._onRoundTouchStart, this);
            n.on(Node.EventType.TOUCH_END, this._onRoundTouchEnd, this);
            n.on(Node.EventType.TOUCH_CANCEL, this._onRoundTouchCancel, this);
        }
    }

    /**
     * 按下：吞掉事件（防手牌缩略）+ 按下反馈。
     * 🔴 敌方回合时显示的是 `EnemyRoundButton`（「对手回合」）—— 它**不是按钮**：
     *    只是状态显示，玩家点它既不会结束回合、也**不该有按下变小的反馈** → 直接返回。
     *    （仍然吞事件：否则点面板会冒泡到 Canvas 触发手牌缩略。）
     */
    private _onRoundTouchStart(event: EventTouch): void {
        this._swallow(event);
        if (this.roundShowsEnemy) return;      // 「对手回合」= 纯状态显示，无互动反馈
        this._setRoundPress(true);
    }

    /**
     * 抬起：吞事件 + 还原 scale + 处理点击。
     * 🔴 有 `roundClickHandler`（= 回合系统接管）时**不再自动互切**，改由回调决定 ——
     *    否则「点结束回合」会先把显示切到敌方钮、再被回合系统覆盖，视觉上闪一下。
     *
     * **任务一**：我方为后手时，若**带着点亮态**结束我方的操作回合 →
     * 先把额外能量点复位成普通态（取消点亮），再交给回合系统推进。
     */
    private _onRoundTouchEnd(event: EventTouch): void {
        this._swallow(event);
        // 无论哪一侧都先还原缩放（防止「玩家回合按下 → 回合切走 → 抬在对手回合」时卡在 0.94）
        this._setRoundPress(false);
        const cur: 'player' | 'enemy' = this.roundShowsEnemy ? 'enemy' : 'player';
        // 🔴 「对手回合」不是按钮：不推进回合、不切显示、不触发任何回调（纯状态显示）
        if (cur === 'enemy') return;
        if (cur === 'player') this.disarmExtra('我方回合结束 → 额外能量点回到普通状态');
        if (this.roundClickHandler) {
            try {
                this.roundClickHandler(cur);
            } catch (e) {
                // 铁律5：回调里的异常会被引擎吞掉 → 自己兜一层，至少留下日志
                console.error('[TurnControlPanel] roundClickHandler 抛错：', e);
            }
            return;
        }
        this.setRoundSide(!this.roundShowsEnemy);
    }

    /** 滑出取消：只还原按下反馈，**不**切换 */
    private _onRoundTouchCancel(event: EventTouch): void {
        this._swallow(event);
        this._setRoundPress(false);
    }

    /** 当前槽2 显示的是不是**敌方回合钮**（「对手回合」= 纯状态显示，不是按钮） */
    private get roundShowsEnemy(): boolean {
        return TurnControlPanel._toBool(this.showEnemyRound);
    }

    /** 阻止事件继续冒泡（同时掐掉同节点的其它监听器）→ Canvas 上的 HandMinimize 收不到 */
    private _swallow(event: EventTouch): void {
        event.propagationStopped = true;
        event.propagationImmediateStopped = true;
    }

    /**
     * 按下反馈：直接改 `scale`，**不用 tween**。
     * 🔴 铁律16：补间没跑完就 `active = false` 会被 ActionManager 暂停留存，
     *    下次激活时「补完」把结束姿态写进新补间 → 严格隔次的怪 bug。
     *    这里按下后马上要切 `active`，所以必须避免 tween。
     */
    private _setRoundPress(down: boolean): void {
        const s = down ? Math.min(1, Math.max(0.6, this.roundButtonPressScale)) : 1;
        for (const nm of [TurnControlPanel.N_ROUND, TurnControlPanel.N_ROUND_ENEMY]) {
            const n = this.node.getChildByName(nm);
            if (n && n.isValid) n.setScale(s, s, 1);
        }
    }

    /** 回合钮上的文字（两行居中） */
    private _layoutRoundLabel(host: Node, text: string, size: number): void {
        const lab = this._ensureLabel(host, TurnControlPanel.N_ROUND_TEXT);
        lab.ut.setAnchorPoint(0.5, 0.5);
        lab.lb.node.setPosition(0, 0, 0);
        this._style(lab.lb, text, size, this.roundLabelFontFamily, Label.HorizontalAlign.CENTER, 1.0);
    }

    /** 参数签名（用于变化检测；不参与序列化） */
    private _signature(): string {
        const a = this.enemyPPSize, b = this.roundButtonSize;
        const c = this.playerPPSize, d = this.extraPPSize;
        return [this.panelScale, a.width, a.height, b.width, b.height,
            c.width, c.height, d.width, d.height,
            this.gapEnemyToRound, this.gapRoundToPlayer, this.gapPPToExtra,
            this.alignEnemyToPlayer ? 1 : 0, this.alignExtraToPlayer ? 1 : 0,
            this.showEnemyRound ? 1 : 0, this.showLockedExtra ? 1 : 0,
            this.enemyCurrentPP, this.enemyMaxPP, this.playerCurrentPP, this.playerMaxPP,
            this.enemyPPNumFontSize, this.playerPPNumFontSize, this.ppMaxFontSize,
            this.roundLabelFontSize, this.enemyRoundLabelFontSize,
            this.ppNumberFontFamily, this.roundLabelFontFamily,
            this.enemyNumAnchorU, this.enemyNumAnchorV,
            this.playerNumAnchorU, this.playerNumAnchorV, this.ppNumGap,
            this.ppNumDescentRatio,
            // 任务一：槽4「N回合后可再次使用」（现在由倒计时状态决定文本）
            this.extraStartRounds, this._extraRounds, this._extraDepleted ? 1 : 0,
            this._extraArmed ? 1 : 0, this.extraSide, this.extraPlayerOnly ? 1 : 0,
            this.extraArmedScale, this.extraDepletedText, this.swallowPanelTouches ? 1 : 0,
            // 点亮光晕（CardGlow 口径：厚度是**纹理像素**）
            this.extraGlowThickness, this.extraGlowSoftness, this.extraArmedIntensity,
            this.extraGlowFadeIn, this.extraGlowFadeOut,
            this.extraArmedGlowColor.r, this.extraArmedGlowColor.g,
            this.extraArmedGlowColor.b, this.extraArmedGlowColor.a,
            this.extraReuseFontSize, this.extraReuseFontFamily,
            this.extraTextBoxWU, this.extraTextBoxHV, this.extraTextBoxPad,
            this.extraTextShrinkToFit ? 1 : 0,
            this.extraTextAnchorU, this.extraTextAnchorV,
            this.lockedTextAnchorU, this.lockedTextAnchorV,
            // 任务三：PlayerPP 十个圆点
            this.ppDotsEnabled ? 1 : 0, this.ppDotScale,
            this.ppDotGreenCore.r, this.ppDotGreenCore.g, this.ppDotGreenCore.b,
            this.ppDotGreenEdge.r, this.ppDotGreenEdge.g, this.ppDotGreenEdge.b,
            this.ppDotGrayCore.r, this.ppDotGrayCore.g, this.ppDotGrayCore.b,
            this.ppDotGrayEdge.r, this.ppDotGrayEdge.g, this.ppDotGrayEdge.b,
            // 任务四：点击互切
            this.roundButtonToggleOnClick ? 1 : 0, this.roundButtonPressScale].join(',');
    }
}
