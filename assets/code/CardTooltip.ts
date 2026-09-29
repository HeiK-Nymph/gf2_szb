import {
    _decorator, Canvas, Color, Component, EventMouse, EventTouch, Graphics, HorizontalTextAlignment,
    Label, Mask, Node, Rect, RichText, Sprite, SpriteFrame, UITransform, Vec2, Vec3,
} from 'cc';
import { CardInfo, getCardInfo } from './CardData';
import { activateAbilityOf, activateAmulet, canActivateAmulet } from './CardAbilitySystem';
import { cooperationRequirementOf } from './CardData';
import { ModeSelectPanel } from './ModeSelectPanel';
import { cardIdFromNodeName } from './CardGlow';
import { BattleFieldLayout, BattleSide } from './BattleFieldLayout';
import { CrestArea, CrestSide } from './CrestArea';
import { CrestSystem } from './CrestSystem';
import { crestNameOf } from './CrestEffects';
import { HandMinimize } from './HandMinimize';
import { TargetSelectSystem } from './TargetSelectSystem';
import { TipKeywordLink } from './TipKeywordLink';
import {
    CardTipInfo, CrestTipInfo, TipAbilityItem, canonTipId, getCardTip, getCrestTip,
    keywordDetails, resolveKeyword, sortedTipKeywords, validateTipData,
} from './CardTipData';

const { ccclass, property, menu } = _decorator;

/** 复用的临时对象（避免每次点击都 new） */
const _uiScratch = new Vec3();
const _worldScratch = new Vec3();
const _outScratch = new Vec3();
const _pointScratch = new Vec2();

/** 单击判定：按下到抬起的 UI 位移不超过它（px）才算「单击」而不是拖拽 */
const CLICK_SLOP = 14;

/** 面板 / 圆环 / 能力详情弹窗的子节点名（运行时构建，方便排查） */
const PANEL_NAME = 'CardTipPanel';
const RING_NAME = 'CardTipSelectRing';
/** 能力详情弹窗（屏幕正中） */
export const DETAIL_NAME = 'CardTipDetail';
/** 能力详情弹窗的「点空白关闭」接收层（全屏透明，压在说明卡片之上、弹窗之下） */
export const DETAIL_BLOCKER_NAME = 'CardTipDetailBlocker';
/** 弹窗内可滚动内容的裁剪区 */
const DETAIL_VIEW_NAME = 'DetailViewport';
/** 滚动内容容器（移动它实现滑动） */
const DETAIL_CONTENT_NAME = 'DetailContent';

/** 🔴 RichText 关键字点击的处理方法名 —— 必须与 `TipKeywordLink.onTipKeywordClick` 同名 */
const KEYWORD_CLICK_HANDLER = 'onTipKeywordClick';

/** 「纹章」关键字（说明卡片里那个黄字栏目标签；它不在富文本里，是普通 Label） */
const CREST_KEYWORD = '纹章';
/** 纹章栏目标签的节点名（卡牌说明下方的纹章子框 / 点纹章弹出的说明头部） */
const CREST_TAG_NAMES = ['TipCrestTag', 'TipCrestBoxTag'];

/** 一次命中的结果 */
interface TipPick {
    /** 'hand' 常态手牌 / 'card' 战场卡牌 / 'crest' 纹章 */
    kind: 'hand' | 'card' | 'crest';
    /** 命中的节点 */
    node: Node;
    /** 卡牌 id（纹章 = 纹章 id） */
    id: string;
    /** 纹章专用：所在区域与槽位序号 */
    area?: CrestArea;
    slotIndex?: number;
}

/**
 * CardTooltip —— 卡牌 / 纹章「说明卡片」+「选中圆环」
 * ===========================================================================
 * 挂在 `Canvas/CardTipLayer`（Canvas 的**最后一个**子节点，保证画在所有 UI 之上）。
 *
 * ── 触发方式（单击）──────────────────────────────────────────────────────
 *   · 单击**常态手牌**里的卡牌 → 显示该卡的说明；
 *   · 单击**敌我战场**上的卡牌   → 显示该卡的说明；
 *   · 单击**敌我纹章**（圆框里有纹章的）→ 显示该纹章的说明；
 *   · 单击**没有互动的地方**（战场背景、空纹章圆框…）→ 关闭说明卡片。
 *
 *   「单击」的口径 = 按下点与抬起点的位移 < `CLICK_SLOP`：
 *   拖拽手牌（出牌）/ 按住战场随从选目标 都**不会**触发说明卡片；
 *   真的打出了一次攻击（有指令进队列）时也会跳过，避免「点一下随从却弹出说明」。
 *
 * ── 监听挂哪（🔴 本项目实测口径）────────────────────────────────────────
 *   Cocos 3.8 web 端把触摸事件派发给**所有**「矩形包含该点、且挂了监听」的节点
 *   ⇒ 挂在 **Canvas** 上即可收到**包括空白处**在内的全部点击（无需全屏吞事件层）。
 *
 * ── 选中圆环 ─────────────────────────────────────────────────────────────
 *   四个**不连在一起**的弧围成一个圆（`cc.Graphics` 现画，不依赖任何贴图）：
 *   · 顺时针旋转（`ringSpinSpeed` 度/秒）；
 *   · 🔴 每个弧的**箭头与旋转同向**（都指向顺时针）：箭头画在弧的小角度端，朝角度减小方向
 *     —— 反了就成了「顺时针转、箭头指逆时针」的倒着转观感（见 `drawRing` / `headPath`）；
 *   · 呼吸式反复「渐渐变透明 → 渐渐恢复」（`ringBreathPeriod` 秒一个周期，
 *     最透明时保留 `ringMinAlpha`，**不会完全消失**）——**只对卡牌**：
 *     纹章圆框上默认**不呼吸**（`ringCrestBreath = false`，恒定 = `ringMaxAlpha`，只转不闪）；
 *   · 点在**纹章**上 → 圆正好包住纹章圆框（`ringCrestScale` 微调），
 *     点在**卡牌**上 → 圆出现在**卡图中央**，整体直径 = `ringSizeOnCard`。
 *
 * ── 说明内容从哪来（🔴 运行期不生成任何文字）──────────────────────────
 *   能力/描述的**文案**全部手写在 `CardTipData.ts` 里（卡牌 + 纹章两张表）；
 *   费用 / 卡名 / 攻击 / 血量由 `CardData.CardMap` 提供，本文件不重复写一遍。
 * ===========================================================================
 */
@ccclass('CardTooltip')
@menu('gf2szb/CardTooltip')
export class CardTooltip extends Component {

    // ====================== 说明卡片：尺寸 / 文字（Inspector 暴露）======================
    @property({ range: [160, 900, 1], slide: true, tooltip: '★【说明卡片宽度】(px) 改大改小后文字会自动重新换行适应。' })
    tipWidth = 420;

    @property({
        range: [60, 700, 1], slide: true,
        tooltip: '【说明卡片高度】(px)。\n'
            + '🔴 autoHeight = 开（默认）时**本项不生效**：高度完全由说明文字撑起（不设最小高度）；\n'
            + 'autoHeight = 关时它就是**固定高度**（内容超出会被画到面板外）。',
    })
    tipHeight = 240;

    @property({
        tooltip: '开（默认）= 高度完全由说明文字撑起（★不设最小高度，说明文字有多少面板就多高）；\n'
            + '关 = 严格按 tipHeight 固定高度。',
    })
    autoHeight = true;

    @property({ range: [8, 60, 1], slide: true, tooltip: '★【文字大小】(px) 正文与描述的字号；卡名 / 徽记数字按它等比推导。' })
    fontSize = 22;

    @property({ range: [0.8, 2.5, 0.01], slide: true, tooltip: '行高 ÷ 字号（1.35 ≈ 舒适行距）' })
    lineHeightRatio = 1.35;

    @property({ range: [0, 60, 1], slide: true, tooltip: '内容四周留白（px）' })
    padding = 16;

    @property({ range: [0, 40, 1], slide: true, tooltip: '两条说明项之间的间距（px）' })
    itemGap = 10;

    @property({ range: [0, 40, 1], slide: true, tooltip: '顶部（卡名行）与下方能力段之间的间距（px）' })
    sectionGap = 12;

    @property({ range: [0, 40, 1], slide: true, tooltip: '面板圆角半径（px）' })
    cornerRadius = 10;

    @property({ range: [0, 8, 0.5], slide: true, tooltip: '面板描边宽度（px）' })
    borderWidth = 2;

    // ====================== 说明卡片：配色 ======================
    @property({ type: Color, tooltip: '面板底色（深蓝半透明）' })
    bgColor = new Color(18, 26, 44, 242);

    @property({ type: Color, tooltip: '面板描边色（金）' })
    bgBorderColor = new Color(198, 168, 108, 255);

    @property({ type: Color, tooltip: '卡名 / 纹章名的颜色' })
    titleColor = new Color(255, 255, 255, 255);

    @property({ type: Color, tooltip: '正文（能力描述）颜色' })
    textColor = new Color(208, 218, 234, 255);

    @property({ type: Color, tooltip: '★关键字高亮色（【入场曲】【守护】以及描述里出现的登记关键字）' })
    keywordColor = new Color(255, 236, 176, 255);

    @property({ type: Color, tooltip: '纹章子框底色' })
    crestBoxColor = new Color(38, 50, 76, 240);

    @property({ type: Color, tooltip: '文字描边色（深色，保证亮底上也看得清）' })
    outlineColor = new Color(12, 16, 28, 220);

    @property({ tooltip: '字体族（留空 = 使用系统默认；中文靠系统字体渲染）' })
    fontFamily = 'Arial';

    @property({ type: Color, tooltip: '费用徽记底色（绿）' })
    costColor = new Color(46, 132, 66, 255);

    @property({ type: Color, tooltip: '攻击徽记底色（蓝）' })
    attackColor = new Color(40, 92, 168, 255);

    @property({ type: Color, tooltip: '血量徽记底色（红）' })
    hpColor = new Color(176, 58, 62, 255);

    @property({ type: Color, tooltip: '徽记描边色' })
    badgeRingColor = new Color(246, 236, 208, 255);

    @property({ type: Color, tooltip: '徽记上的数字颜色' })
    badgeTextColor = new Color(255, 255, 255, 255);

    // ====================== 说明卡片：位置 ======================
    @property({ tooltip: '面板水平居中于本节点（开 = 忽略 offsetX，用 -tipWidth/2）' })
    centerHorizontally = true;

    @property({ tooltip: '面板左上角相对本节点的额外偏移 X（px）' })
    offsetX = 0;

    @property({ tooltip: '面板左上角相对本节点的额外偏移 Y（px）' })
    offsetY = 0;

    // ====================== 能力详情弹窗（点黄字关键字弹出，屏幕正中）======================
    @property({
        range: [240, 1280, 1], slide: true,
        tooltip: '★【能力详情·面板宽度】(px)。\n'
            + '🔴 **固定宽度**：内容文字按「本宽度 − 左右留白」自动换行，不会把面板撑宽；\n'
            + '超出设计分辨率时会被屏幕裁掉，请控制在 1280 以内。',
    })
    detailWidth = 860;

    @property({
        range: [160, 720, 1], slide: true,
        tooltip: '★【能力详情·面板高度】(px)。\n'
            + '🔴 **固定高度**：内容（关键字条数 / 文字行数）超出这个高度时**不会把面板撑高**，\n'
            + '而是在内容区里**上下滑动**查看（见下面的滑动相关参数）。',
    })
    detailHeight = 430;

    @property({
        range: [8, 60, 1], slide: true,
        tooltip: '★【能力详情·内容文字大小】(px)：每个关键字的说明正文（如「从手牌中使用后进入战场时发动的能力。」）字号。\n'
            + '关键字名（黄字）比它大 2px，标题「能力详情」见 detailTitleFontSize。',
    })
    detailFontSize = 22;

    @property({ range: [10, 72, 1], slide: true, tooltip: '【能力详情·标题文字大小】(px)：顶部「能力详情」四个字。' })
    detailTitleFontSize = 28;

    @property({ range: [0.8, 2.5, 0.01], slide: true, tooltip: '【能力详情·行高 ÷ 字号】正文行距（1.45 ≈ 舒适）。' })
    detailLineHeightRatio = 1.45;

    @property({ range: [0, 80, 1], slide: true, tooltip: '【能力详情·内容四周留白】(px)：正文与面板内边距。' })
    detailPadding = 30;

    @property({ range: [0, 80, 1], slide: true, tooltip: '【能力详情·条与条之间的间距】(px)：一个关键字条目与下一个之间。' })
    detailItemGap = 20;

    @property({ range: [0, 40, 1], slide: true, tooltip: '【能力详情·关键字名与其说明的间距】(px)。' })
    detailNameGap = 4;

    @property({ range: [0, 80, 1], slide: true, tooltip: '【能力详情·标题栏高度】(px)：标题 + 标题下分隔线占的高度。' })
    detailHeaderH = 58;

    @property({ range: [0, 120, 1], slide: true, tooltip: '【能力详情·底部栏高度】(px)：底部「关闭」按钮那一块。' })
    detailFooterH = 62;

    @property({ range: [0, 60, 1], slide: true, tooltip: '【能力详情·滑动区与上下栏的间距】(px)。' })
    detailSectionGap = 6;

    @property({
        range: [0, 12, 0.5], slide: true,
        tooltip: '【能力详情·滑动线宽】(px)：内容右侧那根滑动条（0 = 不画）。\n'
            + '🔴 只有**内容超出可视高度**时才出现。',
    })
    detailScrollBarWidth = 5;

    @property({
        range: [0, 4, 0.05], slide: true,
        tooltip: '【能力详情·滑动条与右边缘的距离】÷ 内容留白（1 = 贴着留白内缘）。',
    })
    detailScrollBarInsetK = 0.35;

    @property({
        range: [10, 200, 1], slide: true,
        tooltip: '★【能力详情·滚轮一格滚多少】(px)：鼠标滚轮每滚一格的位移。',
    })
    detailWheelStep = 62;

    @property({
        tooltip: '★【能力详情·拖拽方向反转】\n'
            + '关（默认）= **内容跟着手指走**（按住往上拖 → 内容上移 → 看到更靠后的关键字，与手机列表一致）；\n'
            + '开 = 反向（按住往上拖 → 内容下移，类似"自然滚动 / 拖滚动条"）。',
    })
    detailDragInvert = false;

    @property({
        range: [0.2, 2, 0.05], slide: true,
        tooltip: '★【能力详情·拖拽跟手系数】：手指/鼠标拖动 1px 时内容移动多少 px（1 = 完全跟手）。',
    })
    detailDragScale = 1;

    // ── 弹性滑动（越界回弹 / 惯性）────────────────────────────────────────
    @property({
        range: [0, 400, 1], slide: true,
        tooltip: '★【能力详情·越界最多能拉出多少空白】(px)。\n'
            + '拖到顶 / 底之后继续往外拖时，空白会**越拉越费劲**（阻尼衰减），最多拉到这个量。\n'
            + '0 = 完全没有越界（硬边界，不拉出空白）。',
    })
    detailRubberLimit = 90;

    @property({
        range: [0.12, 1.2, 0.01], slide: true,
        tooltip: '★【能力详情·回弹弹簧周期】(秒)：松手后内容弹回合法边界的快慢。\n'
            + '越小 = 回弹越快越硬；越大 = 越软越慢。',
    })
    detailSpringPeriod = 0.42;

    @property({
        range: [0.1, 1.2, 0.01], slide: true,
        tooltip: '★【能力详情·回弹阻尼比】1 = 临界阻尼（不过冲）；\n'
            + '< 1 = 回弹时会**冲过边界再回来**（弹性手感，推荐 0.55~0.7）；> 1 = 粘滞不弹。',
    })
    detailSpringDamping = 0.62;

    @property({
        range: [0.0005, 1, 0.0005], slide: true,
        tooltip: '★【能力详情·惯性摩擦】松手后**每秒**保留速度的比例（0.02 ≈ 1 秒后基本滑停）。\n'
            + '越小 = 滑得越短越"粘"；越大 = 滑得越远。',
    })
    detailInertiaFriction = 0.02;

    @property({
        range: [0, 200, 1], slide: true,
        tooltip: '【能力详情·惯性停止阈值】(px/s)：滑行速度低于它就停下（越小越"余韵长"）。',
    })
    detailInertiaMinSpeed = 8;

    @property({
        range: [6, 120, 1], slide: true,
        tooltip: '【能力详情·滚动条滑块最短长度】(px)：越界把滑块压短时也不会短于它。',
    })
    detailScrollBarMinLen = 26;

    @property({ range: [0, 40, 1], slide: true, tooltip: '【能力详情·面板圆角】(px)。' })
    detailCornerRadius = 14;

    @property({ range: [0, 8, 0.5], slide: true, tooltip: '【能力详情·面板描边宽度】(px)。' })
    detailBorderWidth = 2;

    @property({ range: [60, 600, 1], slide: true, tooltip: '【能力详情·「关闭」按钮宽度】(px)。' })
    detailButtonWidth = 230;

    @property({ range: [20, 120, 1], slide: true, tooltip: '【能力详情·「关闭」按钮高度】(px)。' })
    detailButtonHeight = 44;

    @property({ range: [10, 80, 1], slide: true, tooltip: '【能力详情·右上角 ✕ 的大小】(px)。' })
    detailCloseMarkSize = 34;

    // ====================== ★「启动」按钮（护符的主动能力）======================
    @property({ range: [60, 600, 1], slide: true, tooltip: '★【启动按钮·宽度】(px)：说明卡片底部那个「启动」按钮。' })
    activateButtonWidth = 320;

    @property({ range: [20, 120, 1], slide: true, tooltip: '★【启动按钮·高度】(px)。' })
    activateButtonHeight = 46;

    @property({ type: Color, tooltip: '★【启动按钮·能启动时的底色】(亮 = 金色，可点)' })
    activateButtonColor = new Color(240, 196, 72, 255);

    @property({ type: Color, tooltip: '★【启动按钮·能启动时的描边色】' })
    activateButtonBorderColor = new Color(255, 236, 170, 255);

    @property({ type: Color, tooltip: '★【启动按钮·能启动时的文字色】' })
    activateButtonTextColor = new Color(60, 42, 10, 255);

    @property({ type: Color, tooltip: '★【启动按钮·不能启动时的底色】(暗 = 灰，点了只提示原因)' })
    activateButtonDisabledColor = new Color(70, 76, 92, 255);

    @property({ type: Color, tooltip: '★【启动按钮·不能启动时的描边色】' })
    activateButtonDisabledBorderColor = new Color(110, 118, 138, 255);

    @property({ type: Color, tooltip: '★【启动按钮·不能启动时的文字色】' })
    activateButtonDisabledTextColor = new Color(150, 156, 172, 255);

    @property({ type: Color, tooltip: '【能力详情·面板底色】(深蓝半透明)' })
    detailBgColor = new Color(20, 44, 66, 246);

    @property({ type: Color, tooltip: '【能力详情·面板描边色】(青金)' })
    detailBorderColor = new Color(120, 196, 214, 255);

    @property({ type: Color, tooltip: '【能力详情·标题颜色】' })
    detailTitleColor = new Color(226, 244, 255, 255);

    @property({ type: Color, tooltip: '【能力详情·关键字名颜色】(黄)' })
    detailKeywordColor = new Color(255, 236, 176, 255);

    @property({ type: Color, tooltip: '【能力详情·说明正文颜色】' })
    detailDescColor = new Color(226, 240, 252, 255);

    @property({ type: Color, tooltip: '【能力详情·分隔线 / 关闭按钮描边色】' })
    detailLineColor = new Color(150, 200, 220, 200);

    @property({ type: Color, tooltip: '【能力详情·关闭按钮文字颜色】' })
    detailButtonTextColor = new Color(214, 240, 252, 255);

    @property({ type: Color, tooltip: '【能力详情·滑动条颜色】' })
    detailScrollBarColor = new Color(180, 226, 240, 170);

    @property({ tooltip: '弹窗是否**点弹窗外**关闭（默认开：点空白 / 点别的卡都先关掉弹窗）' })
    detailCloseOnOutside = true;

    // ====================== 选中圆环（Inspector 暴露）======================
    @property({ range: [-720, 720, 5], slide: true, tooltip: '★【圆环旋转速度】(度/秒)。正值 = 顺时针；0 = 不转。' })
    ringSpinSpeed = 90;

    @property({ range: [20, 600, 1], slide: true, tooltip: '★【卡牌上圆环的整体大小】(px)。点击**卡牌**时圆环的外径（出现在卡图中央）。' })
    ringSizeOnCard = 150;

    @property({
        range: [0.1, 12, 0.05], slide: true,
        tooltip: '★【一个呼吸周期的时间】(秒)：圆环由「最亮」渐渐变透明、再渐渐恢复所用的时间。',
    })
    ringBreathPeriod = 2.2;

    @property({
        range: [0, 1, 0.01], slide: true,
        tooltip: '★【变透明的最透明时的程度】0 = 会完全消失，0.25 = 最淡时保留 25% 不透明度（推荐，圆环始终看得见）。',
    })
    ringMinAlpha = 0.25;

    @property({ range: [0, 1, 0.01], slide: true, tooltip: '圆环最亮时的整体不透明度' })
    ringMaxAlpha = 1;

    @property({
        tooltip: '点在**纹章**上时，圆环是否也做「呼吸变透明」。\n'
            + '关（默认）= **不呼吸**：恒定 = ringMaxAlpha，只保持常态旋转（纹章圆框小，呼吸会让它一闪一闪）；\n'
            + '开 = 与卡牌一样呼吸。',
    })
    ringCrestBreath = false;

    @property({
        range: [0.6, 1.6, 0.01], slide: true,
        tooltip: '点击**纹章**时圆环外径 ÷ 纹章圆框直径。\n'
            + '1 = 与圆框等大（贴着框）；1.06 ≈ 正好把圆框包在里面。',
    })
    ringCrestScale = 1.06;

    @property({ type: Color, tooltip: '圆环主色' })
    ringColor = new Color(255, 152, 48, 255);

    @property({ type: Color, tooltip: '圆环外层柔光色' })
    ringGlowColor = new Color(255, 214, 130, 255);

    @property({ range: [0.01, 0.2, 0.005], slide: true, tooltip: '弧的线宽 ÷ 外径' })
    ringThicknessRatio = 0.055;

    @property({ range: [1, 12, 1], slide: true, tooltip: '弧的数量（默认 4 = 四个不连在一起的弧）' })
    ringArcCount = 4;

    @property({ range: [0.3, 0.95, 0.01], slide: true, tooltip: '每段弧占「一段」的角度比例（越小 = 弧越短、间隙越大；0.68 ≈ 四段弧各留一小段空隙）' })
    ringArcSweepRatio = 0.68;

    @property({ range: [0.02, 0.35, 0.005], slide: true, tooltip: '弧首箭头长度 ÷ 外径' })
    ringHeadSizeRatio = 0.13;

    @property({
        range: [0, 1, 0.01], slide: true,
        tooltip: '外层柔光的不透明度（0 = 不要柔光）。\n'
            + '🔴 别调太大：柔光比主弧宽，圆环小的时候（纹章圆框上）会把四段弧之间的空隙糊成一条连续的环。',
    })
    ringGlowAlpha = 0.25;

    // ====================== 其它 ======================
    @property({ tooltip: '打印「点到了什么 / 显示或关闭说明」的日志' })
    verbose = false;

    // ====================== 内部状态 ======================
    /** 说明卡片本体（UITransform 锚点 (0,1)：局部原点 = 面板左上角） */
    private _panel: Node | null = null;
    private _panelGfx: Graphics | null = null;
    /** 选中圆环（旋转 + 呼吸） */
    private _ring: Node | null = null;
    private _ringGfx: Graphics | null = null;

    /** 面板内需要「最后统一画」的图形指令（分隔线 / 徽记圆 / 纹章子框底） */
    private readonly _ops: Array<(g: Graphics) => void> = [];
    /** 构建期间的「当前顶部 Y」（面板局部坐标，向下为负） */
    private _cursorY = 0;
    /** 纹章子框的矩形（用于最后画底） */
    private _crestBoxRect: { x: number; y: number; w: number; h: number } | null = null;
    /** 本次构建中出现过「文字高度为 0」（RichText 还没排版）→ 下一帧重建一次 */
    private _needRetry = false;

    /** 关键字表（先长后短，构造一次） */
    private _keywords: string[] = [];

    // —— 当前说明卡片里出现过的关键字（按出现顺序，去重）——
    /**
     * 本次构建的说明卡片里**渲染出来的关键字**（黄字），顺序 = 在文字里出现的先后顺序。
     * 点其中任意一个 → 弹出的「能力详情」按这个顺序列出**全部**关键字。
     */
    private readonly _panelKeywords: string[] = [];

    /**
     * 「可点关键字」的命中矩形（黄字段落的节点）。
     * 🔴 由 `collectKeywordHits()` 在每次构建完说明卡片后重建 —— 命中判定用**分段自己的节点矩形**
     *    （与引擎富文本分段是同一份数据），不依赖引擎的 `<on click>` 派发（本项目实测收不到，
     *    见 `collectKeywordHits` 的注释）。
     */
    private readonly _kwHits: Array<{ keyword: string; nodes: Node[] }> = [];

    // —— 能力详情弹窗 ——
    /** 弹窗本体（锚点 0.5/0.5，位置 = 屏幕正中） */
    private _detail: Node | null = null;
    private _detailGfx: Graphics | null = null;
    /** 全屏「点空白」接收层（透明；压在说明卡片之上、弹窗之下） */
    private _detailBlocker: Node | null = null;
    /** 可滚动内容容器（改动它的 y 实现滑动） */
    private _detailContent: Node | null = null;
    private _detailViewH = 0;
    private _detailContentH = 0;
    /** 本次弹窗的尺寸与可视区顶部（面板本地坐标；滑动条定位用） */
    private _detailW = 0;
    private _detailTop = 0;
    /** 「关闭」按钮的尺寸与中心 Y（按下缩放反馈用） */
    private _detailBtnSize = { w: 0, h: 0, cy: 0 };
    /** ★ 「启动」按钮（说明卡片底部）：节点（命中用）+ 目标卡 + 当前能否启动 */
    private _activateBtn: { node: Node; card: Node; ok: boolean; reason: string } | null = null;
    /** 当前内容最大可滚动距离（= 内容高 − 可视高；<= 0 表示不需要滑动） */
    private _detailScrollMax = 0;
    /** 当前滚动位移（0 = 顶部；正 = 往下滚；**越界时可为负 / 大于 scrollMax**） */
    private _detailScrollY = 0;
    /** 弹窗是否打开 */
    private _detailOpen = false;
    /** 拖拽滑动状态 */
    private _dragId = -1;
    private _dragFromY = 0;
    private _dragStartScrollY = 0;
    /** 本次按下是否已构成「拖动」（用来区分「滑动」与「点 ✕」） */
    private _dragMoved = false;
    /** 惯性速度（px/s，滚动单位；正 = 继续往下滚） */
    private _detailScrollVel = 0;
    /** 回弹弹簧：active = 正在弹；target = 要弹回到的合法位置 */
    private _detailSpring = { active: false, target: 0 };
    /** 上一次移动采样（算松手速度用） */
    private _detailLastMoveY = 0;
    private _detailLastMoveMs = 0;
    /**
     * 当前采样窗口内**累计**的滚动位移（px）。
     * 🔴 引擎可能把同一帧里的多个 TOUCH_MOVE 一起派发 ⇒ 逐事件算「位移 ÷ 帧间隔」会严重低估速度
     *    （后几个事件的 dt≈0 会被跳过）。所以先累计、等一个真实时间窗口过去再算速度。
     */
    private _detailPendingDy = 0;
    /** 当前越界量（0 = 在合法范围内；用于滚动条压缩） */
    private _detailOverscroll = 0;
    /** 可滚区在弹窗本地坐标里的上下边与宽度（滑动条定位用） */
    private _detailViewBottom = 0;
    /** 本次弹窗的内容条目（重排用） */
    private _detailList: Array<{ keyword: string; desc: string }> = [];
    /**
     * 「下一帧再量一次内容高度」的标记：RichText 偶尔在**刚激活的那一帧**量不出高度，
     * 若不补量，`contentH / scrollMax` 会偏小 ⇒ 用户滑不到最后一条。
     */
    private _detailRemeasure = false;
    /** 弹窗内各可点区域（弹窗本地坐标；用于 ✕ / 关闭按钮的命中） */
    private _detailCloseRect: { x: number; y: number; w: number; h: number } | null = null;
    private _detailButtonRect: { x: number; y: number; w: number; h: number } | null = null;
    /** 「关闭」按钮按下的缩放反馈（纯 UI，不进任何队列） */
    private _detailButtonDown = false;

    // —— 单击判定 ——
    private _downUI = new Vec2();
    private _downId = -1;
    /** 本次按下的落点是否落在**说明卡片自己**上（= 整段手势都当「无事发生」） */
    private _downOnPanel = false;
    private _moved = false;

    // —— 当前显示的目标（用于每帧校验是否还有效）——
    private _kind: 'hand' | 'card' | 'crest' | '' = '';
    private _targetNode: Node | null = null;
    private _targetId = '';
    /** ★ 说明卡片当前画出来的协作值（用于「协作数变了就刷新」，见 refreshCooperationIfNeeded）。 */
    private _coopShown = -1;
    private _targetArea: CrestArea | null = null;
    private _targetSlot = -1;
    private _ringOn = false;
    private _ringT = 0;
    private _ringAngle = 0;
    private _ringOuter = 0;

    // —— 监听的 Canvas / 复用的场景组件 ——
    private _listenNode: Node | null = null;
    private _cam: any = null;
    private _handMin: HandMinimize | null = null;
    private _targetSel: TargetSelectSystem | null = null;
    private _crestSys: CrestSystem | null = null;
    private _handNode: Node | null = null;
    /** 「RichText 没排版出高度」的兜底重试次数（★必须限次，否则会每帧重建） */
    private _retryGuard = 0;

    // ====================== 生命周期 ======================
    onLoad(): void {
        this._keywords = sortedTipKeywords();
        this.ensureLayerTransform();
        this.ensureNodes();
        if (this.verbose && !validateTipData()) {
            console.warn('[CardTooltip] 说明数据自检未通过，见上面的告警');
        }
        this.hide();
    }

    onEnable(): void {
        this.bind(this.node);
    }

    onDisable(): void {
        this.unbind();
        this.hide();
    }

    onDestroy(): void {
        this.unbind();
    }

    update(dt: number): void {
        if (this._ringOn) {
            this.followRing();            // 🔴 先钉位置，再画（旋转 / 呼吸）
            this.tickRing(dt);
        }
        if (this._detailOpen) this.tickDetail(dt);   // 能力详情：惯性 / 弹簧回弹
        if (this._kind) this.validateTarget();
    }

    // ====================== 对外 API（脚本 / 探针）======================
    /** 说明卡片此刻是否显示 */
    public get isShowing(): boolean {
        return !!this._kind;
    }

    /** 当前说明的目标节点（没有则 null） */
    public get target(): Node | null {
        return this._targetNode;
    }

    /** 当前选中圆环是否在显示 */
    public get isRingVisible(): boolean {
        return this._ringOn;
    }

    /** 关闭说明卡片与圆环（能力详情弹窗一并关掉） */
    public hide(): void {
        this._kind = '';
        this._targetNode = null;
        this._targetId = '';
        this._targetArea = null;
        this._targetSlot = -1;
        this._ringOn = false;
        if (this._panel && this._panel.isValid) this._panel.active = false;
        if (this._ring && this._ring.isValid) this._ring.active = false;
        this.closeDetail();
    }

    // ====================== 对外 API：能力详情弹窗 ======================
    /** 能力详情弹窗此刻是否打开 */
    public get isDetailOpen(): boolean {
        return this._detailOpen;
    }

    /** 本次说明卡片里收集到的关键字（按出现顺序） */
    public get panelKeywords(): string[] {
        return this._panelKeywords.slice();
    }

    /** 当前滚动位移（0 = 顶部；调试 / 探针用） */
    public get detailScrollY(): number {
        return this._detailScrollY;
    }

    /** 内容最大可滚动距离（<= 0 = 内容没超出，不需要滑动） */
    public get detailScrollMax(): number {
        return this._detailScrollMax;
    }

    /**
     * 打开「能力详情」弹窗：内容 = **当前说明卡片里的全部关键字**（按出现顺序）。
     *
     * 🔴 由 RichText 的 `<on click="onTipKeywordClick" param="...">` 派发进来
     *    （经 `TipKeywordLink` 转发）；`keyword` 只用于日志，**不影响内容** ——
     *    点「入场曲」与点「守护」弹出的是**同一张**卡片。
     * @returns 是否真的打开了（没有关键字 / 一个字都没登记说明 → false，不弹空卡片）
     */
    public openDetail(keyword = ''): boolean {
        const list = keywordDetails(this._panelKeywords);
        if (list.length === 0) {
            console.log('[CardTooltip] 本张说明卡片没有可展示的关键字说明，不弹能力详情');
            return false;
        }
        if (!this._detail || !this._detail.isValid) return false;
        // 🔴 **先激活再排版**：RichText 在「节点未激活」时量出来的高度可能是 0 或不完整，
        //    会让 `contentH / scrollMax` 偏小 ⇒ 用户滑不到最后一条。所以顺序必须是
        //    「激活 → 构建内容」，并留一次下一帧的复量兜底（见 `_detailRemeasure`）。
        this._detailOpen = true;
        this._detail.active = true;
        if (this._detailBlocker && this._detailBlocker.isValid) this._detailBlocker.active = true;
        this._detailList = list;
        this.buildDetail(list);
        if (this.verbose) {
            console.log(`[CardTooltip] 能力详情：点「${keyword}」→ 列出本卡全部关键字 `
                + `[${this._panelKeywords.join('、')}]（可滚动 ${Math.round(this._detailScrollMax)}px）`);
        }
        return true;
    }

    /** 关闭能力详情弹窗（幂等） */
    public closeDetail(): void {
        this._detailOpen = false;
        this._dragId = -1;
        this._detailButtonDown = false;
        this._detailScrollVel = 0;                 // 惯性 / 回弹一并收掉
        this._detailSpring.active = false;
        this._detailOverscroll = 0;
        if (this._detail && this._detail.isValid) this._detail.active = false;
        if (this._detailBlocker && this._detailBlocker.isValid) this._detailBlocker.active = false;
    }

    /**
     * UI 坐标是否落在**当前显示的说明卡片**矩形内（面板没显示 / 未建 → false）。
     *
     * 口径：**点说明卡片自己 = 无事发生** —— 既不是「点没有互动的地方」，也不是「点底下的卡」。
     * 用途：① 本组件 `resolveClick` 提前放行 → 说明不消失；
     *       ② `HandMinimize.onOutsideTouch` 放行 → 常态手牌不缩略；
     *       ③ 按下点落在卡片上的整段手势（含抖动 / 拖拽）都不再收起说明。
     *
     * 🔴 两侧都**挂在 Canvas 上各自 hitTest**（同层），不要改成「面板子节点吞事件」——
     *    本引擎 UI 事件派发会先父后子（项目铁律 59），子节点的 TOUCH_START 可能根本收不到。
     */
    public isPointOnPanel(ui: Vec2 | Vec3): boolean {
        // 能力详情弹窗打开时，它压在说明卡片之上 —— 点在它上面同样算「点在说明面板上」
        // （HandMinimize 据此不缩略手牌；CardTooltip 自己的点击判定则走 openDetail 分支）。
        if (this.isPointOnDetail(ui)) return true;
        const p = this._panel;
        if (!this._kind || !p || !p.isValid || !p.activeInHierarchy) return false;
        const world = this.uiToWorld(ui, _worldScratch);
        return this.hitTest(p, world);
    }

    /** UI 坐标是否落在**能力详情弹窗**矩形内（弹窗没显示 → false） */
    public isPointOnDetail(ui: Vec2 | Vec3): boolean {
        const d = this._detail;
        if (!this._detailOpen || !d || !d.isValid || !d.activeInHierarchy) return false;
        const world = this.uiToWorld(ui, _worldScratch);
        return this.hitTest(d, world);
    }

    /**
     * 用 UI 坐标（= `event.getUILocation()` 的坐标系）走一遍「单击」逻辑。
     * 供脚本 / 探针直接触发，等价于玩家在那个点单击了一下。
     */
    public clickAt(uiPos: Vec2 | Vec3): void {
        this.resolveClick(Vec2.set(_pointPreview, uiPos.x, uiPos.y));
    }

    /** 程序化：为某个节点弹说明（找不到对应数据则关闭） */
    public showForNode(node: Node): boolean {
        const pick = this.pickOfNode(node);
        if (!pick) { this.hide(); return false; }
        this._retryGuard = 0;
        this.showPick(pick);
        return true;
    }

    // ====================== 单击判定（挂在 Canvas 上）======================
    private bind(node: Node): void {
        const canvas = this.findCanvas(node);
        if (!canvas) return;
        if (this._listenNode === canvas) return;
        this.unbind();
        this._listenNode = canvas;
        canvas.on(Node.EventType.TOUCH_START, this._onDown, this);
        canvas.on(Node.EventType.TOUCH_MOVE, this._onMove, this);
        canvas.on(Node.EventType.TOUCH_END, this._onUp, this);
        canvas.on(Node.EventType.TOUCH_CANCEL, this._onUp, this);
    }

    private unbind(): void {
        const n = this._listenNode;
        this._listenNode = null;
        if (!n || !n.isValid) return;
        n.off(Node.EventType.TOUCH_START, this._onDown, this);
        n.off(Node.EventType.TOUCH_MOVE, this._onMove, this);
        n.off(Node.EventType.TOUCH_END, this._onUp, this);
        n.off(Node.EventType.TOUCH_CANCEL, this._onUp, this);
    }

    private readonly _onDown = (e: EventTouch): void => {
        if (!isPrimaryButton(e)) return;
        this._downId = e.getID();
        this._moved = false;
        const ui = e.getUILocation();
        this._downUI.set(ui.x, ui.y);
        // 按下的落点是否在说明卡片上：是 → 整段手势（按下/移动/抬起）全部当无事发生。
        this._downOnPanel = this.isPointOnPanel(ui);
    };

    private readonly _onMove = (e: EventTouch): void => {
        if (this._moved || this._downId < 0) return;
        if (e.getID() !== this._downId) return;
        const ui = e.getUILocation();
        const dx = ui.x - this._downUI.x;
        const dy = ui.y - this._downUI.y;
        if (dx * dx + dy * dy > CLICK_SLOP * CLICK_SLOP) {
            this._moved = true;
            // 一旦判定为拖拽（= 出牌 / 按住选目标）→ 立刻收起说明，别挡着操作。
            // 🔴 只有「从说明卡片自己身上起手」的拖拽不算 —— 那种点数说明卡片也在跟着动，
            //    收起它反而变成「点说明卡片 = 说明消失」（需求：点它应当无事发生）。
            if (this._kind && !this._downOnPanel) this.hide();
        }
    };

    private readonly _onUp = (e: EventTouch): void => {
        const id = this._downId;
        const moved = this._moved;
        this._downId = -1;
        this._moved = false;
        this._downOnPanel = false;
        if (moved || id < 0 || e.getID() !== id) return;
        // 🔴 从说明卡片自己身上起手：**仍然要走一遍单击判定** —— 卡片里的**黄字关键字**是可点的
        //    （点它弹「能力详情」）；`resolveClick` 内部会区分「关键字」与「卡片其它地方
        //    （= 无事发生）」，所以不能在这里按 `_downOnPanel` 一刀切掉。
        // 延迟一帧再判定：让「战场按压 → 真的打出一次攻击」这类同帧逻辑先走完，
        // 免得「按住随从打了一下」也把说明卡片弹出来（此时演出队列已非空闲）。
        const ui = this._downUI.clone();
        this.scheduleOnce(() => this.resolveClick(ui), 0);
    };

    /** 真正的单击判定：命中卡牌 / 纹章 → 弹出说明；命中空白 → 关闭说明 */
    private resolveClick(ui: Vec2): void {
        if (!this.node || !this.node.isValid) return;
        // 🔴 能力详情弹窗打开时它是**模态**：这一下点击只用来关弹窗（若允许点外关闭），
        //    不再往下走「弹说明 / 关说明」的判定 —— 避免「关弹窗的同时又弹出一张新说明」。
        if (this._detailOpen) {
            if (this.isPointOnDetail(ui)) return;            // 点在弹窗自己身上 → 交给弹窗的监听处理
            if (this.detailCloseOnOutside) this.closeDetail();
            return;                                          // 关掉弹窗也**吞掉**这一下点击
        }
        // 🔴 点在说明卡片里的**黄字关键字**上 → 弹出「能力详情」（模态，居屏幕正中）。
        //    必须排在 `isPointOnPanel` 之前：那一条会把「面板上的点击」当无事发生直接吞掉。
        const kw = this.hitKeywordAt(ui);
        if (kw) {
            this.openDetail(kw);
            return;
        }
        // ★ 「启动」按钮（护符）：排在关键字之后、面板吞点击之前 —— 它本身就是面板上的一块可点区域。
        if (this.hitActivateButtonAt(ui)) {
            this.onActivatePressed();
            return;
        }
        // 🔴 点在**说明卡片自己**身上：当无事发生 —— 不收起说明，也不当「点空白」
        //    （`HandMinimize.onOutsideTouch` 用同一个判据放行 → 常态手牌不缩略）。
        if (this.isPointOnPanel(ui)) return;
        // 选择目标模式（入场曲 / 进化时能力）整个让位：那套交互有自己的全屏接事件节点
        if (this.blocked()) { this.hide(); return; }

        const pick = this.pickAt(ui);
        if (!pick) {
            if (this.verbose && this._kind) console.log('[CardTooltip] 点到没有互动的地方 → 关闭说明');
            this.hide();
            return;
        }

        // 手牌正在「缩略 ↔ 展开」过渡时，点手牌是「展开手牌」的语义 → 不给它弹说明
        // （其它目标不受手牌过渡影响，照常弹 —— 否则点纹章 / 战场卡会莫名没反应）
        if (pick.kind === 'hand') {
            const hm = this._handMin;
            if (hm && hm.isValid && (hm.isTransitioning || hm.isMinimized)) return;
        }

        // 🔴 唯一「可能把单击变成一次攻击」的场合 = 点**我方战场**上的卡牌
        //    （按住 → 抬卡 → 拖到敌方目标上松手 = 确定攻击）。这时若演出队列已经在播，
        //    说明这一次按压真的打出去了 → 不弹说明。
        //    卡牌之外的点击（手牌 / 纹章 / 敌方战场卡）永远不会触发攻击，不受此限，
        //    否则敌方回合（人机一直在演出）就完全看不了说明了。
        if (this.maybeAttack(pick)) {
            const cmds = this.comp('BattleCommandSystem') as { isIdle?: boolean } | null;
            if (cmds && typeof cmds.isIdle === 'boolean' && !cmds.isIdle) {
                this.hide();
                return;
            }
        }
        this._retryGuard = 0;
        this.showPick(pick);
    }

    /** 「启动」按钮被按下：能启动 → 发动；不能 → 只打日志说明原因（按钮本身是暗的） */
    private onActivatePressed(): void {
        const btn = this._activateBtn;
        if (!btn || !btn.card || !btn.card.isValid) return;
        if (!btn.ok) {
            console.log(`[CardTooltip] 「启动」按钮当前不可用：${btn.reason || '条件不满足'}`);
            return;
        }
        const started = activateAmulet(this, btn.card, 'player');
        if (this.verbose) console.log(`[CardTooltip] 按下「启动」→ ${started ? '已发动 / 已进入选择' : '被拒绝'}`);
        if (!started) return;
        // 需要选目标 → 选择模式接管，说明卡片让位；否则（如只回血）就地重建一次，
        // 让按钮立刻变成「本回合已启动」的暗态。
        const sel = this.comp('TargetSelectSystem') as { isSelecting?: boolean } | null;
        if (sel && sel.isSelecting) { this.hide(); return; }
        const n = this._targetNode;
        if (n && n.isValid && this._kind) {
            const pick = this.pickOfNode(n);
            if (pick) this.showPick(pick);
        }
    }

    /** 这一击是否可能被我方战场按压消费成一次攻击 */
    private maybeAttack(pick: TipPick): boolean {
        if (pick.kind !== 'card') return false;
        const f = this.fieldOf(pick.node);
        return !!f && f.side === BattleSide.Player;
    }

    /** 有些「正在进行的流程」里不该弹说明 */
    private blocked(): boolean {
        const sel = this._targetSel;
        if (sel && sel.isValid && sel.isSelecting) return true;         // 正在选目标（入场曲 / 进化）
        // ★ 「模式」选择中：整屏都是选项面板的地盘，点哪儿都只算「选选项 / 取消选择」，不弹说明
        const mode = ModeSelectPanel.instance;
        if (mode && mode.isSelecting) return true;
        return false;
    }

    // ====================== 命中判定 ======================
    /** 按 UI 坐标找「被点到的东西」（渲染在上的优先） */
    private pickAt(ui: Vec2 | Vec3): TipPick | null {
        const world = this.uiToWorld(ui, _worldScratch);
        this.refreshContext();

        const cands: TipPick[] = [];

        // ① 纹章：只有「圆框里确实有纹章」的槽位才算可点（空圆框 = 没有互动的地方）
        const areas = this.allComps('CrestArea') as CrestArea[];
        for (const area of areas) {
            if (!area || !area.isValid) continue;
            const side = area.side === CrestSide.Player ? 'player' : 'enemy';
            const ids = this.crestIdsOf(side);
            for (let i = 0; i < area.slotCount; i++) {
                if (!area.hasSlotIcon(i)) continue;
                const id = ids[i] || '';
                if (!id) continue;
                const slot = area.getSlot(i);
                if (!slot) continue;
                cands.push({ kind: 'crest', node: slot, id, area, slotIndex: i });
            }
        }

        // ② 常态手牌（缩略态不弹：那时点击是「展开手牌」）
        const hm = this._handMin;
        const handMinimized = !!(hm && hm.isValid && hm.isMinimized);
        const hand = handMinimized ? null : this.handNode();
        if (hand) {
            for (const c of hand.children) {
                if (!c || !c.isValid || !/^Card_/.test(c.name)) continue;
                const id = handCardId(c);
                if (!id) continue;
                cands.push({ kind: 'hand', node: c, id });
            }
        }

        // ③ 敌我战场卡牌
        const fields = this.allComps('BattleFieldLayout') as BattleFieldLayout[];
        for (const f of fields) {
            if (!f || !f.isValid) continue;
            for (const c of f.cards) {
                if (!c || !c.isValid) continue;
                const id = cardIdFromNodeName(c.name);
                if (!id) continue;
                cands.push({ kind: 'card', node: c, id });
            }
        }

        // 渲染顺序 = 节点树 DFS ⇒ 用「顶层兄弟序号 + 同级序号」作排序键（大的在上）
        cands.sort((a, b) => this.layerKey(b.node) - this.layerKey(a.node));
        for (const c of cands) {
            if (this.hitTest(c.node, world)) return c;
        }
        return null;
    }

    /** 命中一个节点：世界矩形包含该点 */
    private hitTest(n: Node, world: Vec3): boolean {
        const ut = n.getComponent(UITransform);
        if (!ut) return false;
        const r: Rect = ut.getBoundingBoxToWorld();
        _pointScratch.set(world.x, world.y);
        return r.contains(_pointScratch);
    }

    /** 渲染层级键：顶层（Canvas 的子节点）序号 × 100000 + 自身兄弟序号 */
    private layerKey(n: Node): number {
        const canvas = this._listenNode;
        let top: Node | null = n;
        while (top.parent && top.parent !== canvas) top = top.parent;
        const topIdx = canvas ? canvas.children.indexOf(top) : 0;
        return topIdx * 100000 + (n.getSiblingIndex() || 0);
    }

    private uiToWorld(ui: Vec2 | Vec3, out: Vec3): Vec3 {
        Vec3.set(_uiScratch, ui.x, ui.y, 0);
        const cam = this.uiCamera();
        if (cam) cam.screenToWorld(_uiScratch, out);
        else Vec3.copy(out, _uiScratch);
        return out;
    }

    private uiCamera(): any {
        if (this._cam && this._cam.isValid) return this._cam;
        this._cam = null;
        let n: Node | null = this.node;
        while (n) {
            const cv = n.getComponent(Canvas) as unknown as
                { camera?: any; cameraComponent?: any } | null;
            if (cv) {
                this._cam = cv.cameraComponent || cv.camera || null;
                if (this._cam) return this._cam;
            }
            n = n.parent;
        }
        return null;
    }

    // ====================== 显示 ======================
    private showPick(pick: TipPick): void {
        if (!this._panel || !this._panel.isValid) return;
        this.refreshContext();
        this._kind = pick.kind;
        this._targetNode = pick.node;
        this._targetId = pick.id;
        this._targetArea = pick.area || null;
        this._targetSlot = pick.slotIndex === undefined ? -1 : pick.slotIndex;

        if (pick.kind === 'crest') this.buildCrestPanel(pick.id, pick.node);
        else this.buildCardPanel(pick.id);

        this.placeRing(pick);
        if (this.verbose) {
            console.log(`[CardTooltip] 显示说明：${pick.kind} ${pick.id}`
                + `（面板 ${Math.round(this.tipWidth)}×${Math.round(this._panel.getComponent(UITransform)!.contentSize.height)}）`);
        }
    }

    /** 每帧校验：目标被销毁 / 纹章消失 / 手牌缩略 → 自动收起 */
    /**
     * ★ 「启动」按钮可用性变化时就地刷新说明卡片（需求：敌方回合点开是灰的，
     * 轮到我方后应当**自动变亮**，而不是要再点一次卡）。
     * 只在「当前显示的是我方护符 + 带启动能力」时判定；可用性没变就什么都不做（每帧 O(1)）。
     */
    /**
     * ★ 需求：**协作数变了就立刻刷新说明卡片**（如维克托的协作刚满足时，卡里的「协作(x/n)」要马上跟着变）。
     * 只在当前显示的是「带协作机制的卡」时判定；协作值没变就什么都不做（每帧 O(1)）。
     */
    private refreshCooperationIfNeeded(n: Node): void {
        if (!this._targetId) return;
        let need = 0;
        try { need = cooperationRequirementOf(this._targetId); } catch (e) { return; }
        if (need <= 0) return;
        const cur = this.cooperationNow();
        if (this._coopShown === cur) return;              // 没变化 → 不动
        const pick = this.pickOfNode(n);
        if (pick) this.showPick(pick);                    // 就地重建（首行会按新协作值重画）
    }

    private refreshActivateButtonIfNeeded(n: Node): void {
        if (this._kind !== 'card') return;
        const id = cardIdFromNodeName(n.name);
        if (!id || !activateAbilityOf(id)) return;
        const field = this.fieldOf(n);
        if (!field || field.side !== BattleSide.Player) return;
        const ok = canActivateAmulet(this, n, 'player').ok;
        const cur = this._activateBtn;
        if (cur && cur.ok === ok) return;                 // 没变化 → 不动
        const pick = this.pickOfNode(n);
        if (pick) this.showPick(pick);                    // 就地重建（按钮会按新状态重画）
    }

    private validateTarget(): void {
        const n = this._targetNode;
        if (!this._panel || !this._panel.isValid) { this.hide(); return; }
        if (!n || !n.isValid || !n.activeInHierarchy) { this.hide(); return; }
        if (this._kind === 'hand') {
            const hm = this._handMin;
            if (hm && hm.isValid && hm.isMinimized) { this.hide(); return; }
            if (!/^Card_/.test(n.name)) { this.hide(); return; }
        } else if (this._kind === 'crest') {
            const area = this._targetArea;
            if (!area || !area.isValid || this._targetSlot < 0) { this.hide(); return; }
            if (!area.hasSlotIcon(this._targetSlot)) { this.hide(); return; }
            const side = area.side === CrestSide.Player ? 'player' : 'enemy';
            const now = (this.crestIdsOf(side)[this._targetSlot] || '');
            if (canonTipId(now) !== canonTipId(this._targetId)) { this.hide(); return; }
        } else if (this._kind === 'card') {
            if (!cardIdFromNodeName(n.name)) { this.hide(); return; }
            // ★ 「启动」按钮的**可用性会随回合变化**（敌方回合灰、轮到我方应变亮）⇒
            //   每帧比对一次，变了就**就地重建说明卡片**，不必等玩家再点一次这张卡。
            this.refreshActivateButtonIfNeeded(n);
        this.refreshCooperationIfNeeded(n);
            // 已经被摘出战场（破坏 / 消失逻辑先摘牌、动画后销毁）→ 说明也一并收起
            const field = this.fieldOf(n);
            const holder = field as unknown as { containsCard?: (c: Node) => boolean } | null;
            if (!field || (holder && typeof holder.containsCard === 'function' && !holder.containsCard(n))) {
                this.hide();
                return;
            }
        }
    }

    // ====================== 面板：卡牌 ======================
    private buildCardPanel(id: string): void {
        const info = getCardInfo(id);
        const tip = getCardTip(id) as CardTipInfo | undefined;
        this.beginPanel();
        this._cursorY -= this.padding;              // 顶部留白

        if (info) {
            this.addCardHeader(info);
        } else {
            this.addTitleRow(id);
        }

        if (tip && tip.items.length > 0) {
            this.addItems(tip.items, this.padding, this.innerWidth());
        }

        if (tip && tip.crest) {
            this.addCrestSection(tip.crest, this.crestIconOf(tip.crest.id || id));
        }

        // ★ 「启动」按钮（需求）：**我方战场**上、卡表登记了 `Activate` 的护符 →
        //    在说明卡片最下方加一个「启动」按钮；能启动 = 亮（金色），不能 = 暗（灰）。
        this.addActivateButton(id);

        this.endPanel();
    }

    // ====================== 「启动」按钮（护符的主动能力）======================
    /**
     * 在说明卡片底部加「启动」按钮。
     *
     * 需求口径：
     *   · 只对**我方战场**上、卡表登记了 `Activate` 能力的卡出现（手牌 / 敌方 / 没有启动能力 → 不加）；
     *   · 能启动（自己回合 + 本回合没启动过 + 费用够）→ **亮**（金色，可点）；
     *     不能启动 → **暗**（灰色，点了只打日志说明原因）；
     *   · 按钮**不抬卡**：护符的「常亮选择特效」由 CardKeywordSystem 负责，本按钮只是入口。
     */
    private addActivateButton(id: string): void {
        this._activateBtn = null;
        if (this._kind !== 'card') return;
        const card = this._targetNode;
        if (!card || !card.isValid) return;
        // 必须是我方战场上的卡
        const field = this.fieldOf(card);
        if (!field || field.side !== BattleSide.Player) return;
        // 必须有「启动」能力（用卡表数据判，与 CardAbilitySystem.activateAmulet 同一份真源）
        if (!activateAbilityOf(id)) return;

        const gate = canActivateAmulet(this, card, 'player');
        const W = Math.max(120, this.tipWidth);
        const bw = Math.max(60, Math.min(W - this.padding * 2, this.activateButtonWidth));
        const bh = Math.max(20, this.activateButtonHeight);
        const cx = W / 2;
        const cy = this._cursorY - this.itemGap - bh / 2;

        // 按钮节点（只为命中判定；视觉画在面板的 Graphics 上，与其它内容同一套坐标）
        const n = new Node('TipActivateBtn');
        n.layer = this._panel!.layer;
        this._panel!.addChild(n);
        const ut = n.addComponent(UITransform);
        ut.setAnchorPoint(0.5, 0.5);
        ut.setContentSize(bw, bh);
        n.setPosition(cx, cy, 0);

        const label = this.makeLabel('TipActivateBtnText', '启动',
            Math.max(10, this.fontSize + 2),
            gate.ok ? this.activateButtonTextColor : this.activateButtonDisabledTextColor,
            HorizontalTextAlignment.CENTER, true, 0.5, 0.5, bw, bh);
        label.node.setPosition(cx, cy, 0);

        const fill = gate.ok ? this.activateButtonColor : this.activateButtonDisabledColor;
        const line = gate.ok ? this.activateButtonBorderColor : this.activateButtonDisabledBorderColor;
        this._ops.push((g) => {
            const r = Math.max(2, this.cornerRadius * 0.6);
            g.fillColor = fill;
            g.roundRect(cx - bw / 2, cy - bh / 2, bw, bh, r);
            g.fill();
            g.lineWidth = Math.max(1, this.borderWidth * 0.7);
            g.strokeColor = line;
            g.roundRect(cx - bw / 2, cy - bh / 2, bw, bh, r);
            g.stroke();
        });

        this._activateBtn = { node: n, card, ok: gate.ok, reason: gate.reason };
        this._cursorY = cy - bh / 2 - this.padding;
        if (this.verbose) {
            console.log(`[CardTooltip] 说明卡片加「启动」按钮：${id}`
                + `${gate.ok ? '（可启动）' : '（不可启动：' + gate.reason + '）'}`);
        }
    }

    /** 这一下点击是否落在我方护符的「启动」按钮上（UI 坐标） */
    private hitActivateButtonAt(ui: Vec2 | Vec3): boolean {
        const btn = this._activateBtn;
        if (!btn || !btn.node || !btn.node.isValid) return false;
        const ut = btn.node.getComponent(UITransform);
        if (!ut) return false;
        const world = this.uiToWorld(ui, _worldScratch);
        _pointScratch.set(world.x, world.y);
        return ut.getBoundingBoxToWorld().contains(_pointScratch);
    }

    // ====================== 面板：纹章 ======================
    private buildCrestPanel(id: string, slot: Node): void {
        const tip = getCrestTip(id) as CrestTipInfo | undefined;
        const sf = this.slotIconFrame(slot);
        this.beginPanel();
        this._cursorY -= this.padding;

        const name = (tip && tip.name) || crestNameOf(id) || id;
        this.addCrestHeader(name, sf);

        const indent = this.iconRowH() + 8;
        const x = this.padding + indent;
        const w = Math.max(40, this.innerWidth() - indent);
        if (tip && tip.items.length > 0) {
            this.addItems(tip.items, x, w);
        } else {
            const txt = this.addRichText(
                `<color=#${hex(this.textColor)}>（这枚纹章暂时没有登记说明文案）</color>`, x, this._cursorY, w,
            );
            this._cursorY -= txt + this.itemGap;
        }
        this.endPanel();
    }

    // ====================== 面板：通用件 ======================
    private beginPanel(): void {
        const p = this._panel!;
        p.active = true;
        for (const c of p.children.slice()) {
            if (!c || !c.isValid) continue;
            c.removeFromParent();
            c.destroy();
        }
        this._panelGfx!.clear();
        this._ops.length = 0;
        this._crestBoxRect = null;
        this._needRetry = false;
        this._cursorY = 0;
        // 每次重建说明卡片都重新收集关键字（顺序 = 本次实际渲染出来的先后顺序）
        this._panelKeywords.length = 0;
        this._kwHits.length = 0;
    }

    private endPanel(): void {
        const W = Math.max(120, this.tipWidth);
        // 🔴 【高度完全由内容撑起】不设最小高度 —— 卡牌一定会有说明文字，
        //    面板高度 = 上下留白 + 全部内容。`tipHeight` 只在 autoHeight = 关 时生效。
        const contentH = -this._cursorY + this.padding;
        const H = Math.max(8, this.autoHeight ? contentH : this.tipHeight);

        const ut = this._panel!.getComponent(UITransform)!;
        ut.setContentSize(W, H);

        const g = this._panelGfx!;
        const r = Math.max(0, this.cornerRadius);
        g.clear();
        g.fillColor = this.bgColor;
        g.roundRect(0, -H, W, H, r);
        g.fill();
        if (this.borderWidth > 0) {
            g.lineWidth = this.borderWidth;
            g.strokeColor = this.bgBorderColor;
            g.roundRect(0, -H, W, H, r);
            g.stroke();
        }
        for (const op of this._ops) {
            try { op(g); } catch (e) { /* 画不动就跳过，不影响内容 */ }
        }

        const px = this.centerHorizontally ? (-W / 2 + this.offsetX) : this.offsetX;
        this._panel!.setPosition(px, this.offsetY, 0);

        // 🔴 收集「可点关键字」的命中矩形：必须在**富文本已经排版完**之后（本方法末尾），
        //    这时每个关键字都是富文本里一个独立分段，能拿到它的节点与世界矩形。
        this.collectKeywordHits();

        if (this._needRetry && this._retryGuard < 1) {
            // RichText 偶发「刚挂上还没排版」→ 下一帧按同一目标重建一次（★只重试一次）
            this._retryGuard += 1;
            this.scheduleOnce(() => {
                const n = this._targetNode;
                if (!n || !n.isValid || !this._kind) return;
                const pick = this.pickOfNode(n);
                if (pick) this.showPick(pick);
            }, 0);
        }
    }

    private innerWidth(): number {
        return Math.max(40, this.tipWidth - this.padding * 2);
    }

    /** 图标行高（= 2 × 徽记半径），纹章头部 / 首行缩进共用 */
    private iconRowH(): number {
        return Math.max(24, this.fontSize * 2.1);
    }

    /** 徽记半径 */
    private badgeR(): number {
        return Math.max(9, this.fontSize * 0.9);
    }

    // ---- 卡牌头：费用 / 卡名 / 攻击 / 血量 ----
    private addCardHeader(info: CardInfo): void {
        const W = Math.max(120, this.tipWidth);
        const P = this.padding;
        const R = this.badgeR();
        const rowH = R * 2;
        const cy = this._cursorY - rowH / 2;

        const hasCost = typeof info.cost === 'number';
        const isFollower = info.cardType === 'Follower';
        const hasStats = isFollower && typeof info.attack === 'number' && typeof info.hp === 'number';

        if (hasCost) {
            const cx = P + R;
            const cost = Math.round(info.cost);
            this._ops.push((g) => this.drawBadge(g, cx, cy, R, this.costColor));
            this.addCenteredLabel('TipCost', String(cost), cx, cy, R * 1.15);
        }

        let rightLimit = W - P;
        if (hasStats) {
            const hx = W - P - R;
            const ax = hx - R * 2 - Math.max(4, R * 0.4);
            const atk = Math.round(info.attack as number);
            const hp = Math.round(info.hp as number);
            this._ops.push((g) => {
                this.drawBadge(g, ax, cy, R, this.attackColor);
                this.drawBadge(g, hx, cy, R, this.hpColor);
            });
            this.addCenteredLabel('TipAtk', String(atk), ax, cy, R * 1.15);
            this.addCenteredLabel('TipHp', String(hp), hx, cy, R * 1.15);
            rightLimit = ax - R - 6;
        }

        const nameLeft = P + (hasCost ? R * 2 + 8 : 0);
        const nameW = Math.max(30, rightLimit - nameLeft);
        const nl = this.makeLabel('TipName', info.cardName || '', this.fontSize + 4, this.titleColor,
            HorizontalTextAlignment.LEFT, true, 0, 0.5, nameW, rowH);
        nl.node.setPosition(nameLeft, cy, 0);

        // 卡名下方的分隔线
        const lineY = this._cursorY - rowH - Math.max(2, this.sectionGap * 0.45);
        this._ops.push((g) => {
            g.lineWidth = Math.max(1, this.borderWidth * 0.6);
            g.strokeColor = new Color(this.bgBorderColor.r, this.bgBorderColor.g, this.bgBorderColor.b, 120);
            g.moveTo(P, lineY);
            g.lineTo(W - P, lineY);
            g.stroke();
        });

        this._cursorY -= rowH + this.sectionGap;
    }

    /** 没有卡牌数据时的兜底标题行 */
    private addTitleRow(text: string): void {
        const W = Math.max(120, this.tipWidth);
        const P = this.padding;
        const rowH = this.iconRowH();
        const cy = this._cursorY - rowH / 2;
        const nl = this.makeLabel('TipName', text, this.fontSize + 4, this.titleColor,
            HorizontalTextAlignment.LEFT, true, 0, 0.5, Math.max(30, W - P * 2), rowH);
        nl.node.setPosition(P, cy, 0);
        this._cursorY -= rowH + this.sectionGap;
    }

    // ---- 纹章头：圆形图标 + 「纹章」+ 名字 ----
    private addCrestHeader(name: string, sf: SpriteFrame | null): void {
        const W = Math.max(120, this.tipWidth);
        const P = this.padding;
        const rowH = this.iconRowH();
        const cy = this._cursorY - rowH / 2;
        const d = rowH * 0.98;

        if (sf) this.addRoundIcon('TipCrestIcon', sf, P + d / 2, cy, d);

        const tagW = this.fontSize * 2.2;
        const tagX = P + (sf ? d : 0) + 6;
        const tag = this.makeLabel('TipCrestTag', '纹章', this.fontSize + 2, this.keywordColor,
            HorizontalTextAlignment.LEFT, true, 0, 0.5, tagW, rowH);
        tag.node.setPosition(tagX, cy, 0);
        // 🔴 「纹章」这个黄字**也是关键字**：登记进本卡关键字表（点击命中由 `collectKeywordHits` 补）
        this.noteKeyword(CREST_KEYWORD);

        const nameX = tagX + tagW + 4;
        const nameW = Math.max(30, W - P - nameX);
        const nl = this.makeLabel('TipCrestName', name, this.fontSize + 2, this.titleColor,
            HorizontalTextAlignment.LEFT, true, 0, 0.5, nameW, rowH);
        nl.node.setPosition(nameX, cy, 0);

        this._cursorY -= rowH + this.sectionGap;
    }

    // ---- 说明项列表 ----
    private addItems(items: TipAbilityItem[], x: number, width: number): void {
        // ★ 需求：带【协作】机制的卡，说明卡片**第一行**单独显示「协作(x/n)」
        //   （x = 当前协作值 = 本次对战中进入战场的自己的随从张数；n = 该卡触发协作能力所需值）。
        try {
            const need = cooperationRequirementOf(this._targetId);
            if (need > 0) {
                const cur = this.cooperationNow();
                this._coopShown = cur;                    // 记下本次画出来的协作值
                const line = this.renderItem({ ability: '协作', desc: `${cur}/${need}` } as TipAbilityItem);
                if (line) {
                    const h0 = this.addRichText(line, x, this._cursorY, width);
                    this._cursorY -= h0 + this.itemGap;
                }
            }
        } catch (e) { /* 协作行失败不影响其余说明 */ }
        for (const it of items) {
            const html = this.renderItem(it);
            if (!html) continue;                       // ability / desc 都没写 → 跳过
            const h = this.addRichText(html, x, this._cursorY, width);
            this._cursorY -= h + this.itemGap;
        }
    }

    /**
     * 一条说明项 → 富文本串。
     * 形态：`【能力】描述` + 逐个 `【副能力】副描述`；
     * 能力名（含副能力名）永远高亮，描述里出现的登记关键字也高亮。
     * 🔴 `ability` 可省略 —— 省略时这一条就是纯描述（不带【】，正文色）。
     * 🔴 高亮出来的关键字（含能力名去掉【】后的原文）都包一层
     *    `<on click=... param=关键字>` ⇒ 点它就能弹出「能力详情」（见 `onTipKeywordClick`）。
     * @returns 空串 = 这一条什么都不显示（ability / desc 都没写）
     */
    /** ★ 当前协作值（我方；找不到 BattleRuleSystem ⇒ 0）。 */
    private cooperationNow(): number {
        try {
            const scene = this.node.scene as unknown as Node | null;
            if (!scene) return 0;
            const stack: Node[] = [...scene.children];
            while (stack.length > 0) {
                const cur = stack.shift() as Node;
                const r = cur.getComponent('BattleRuleSystem') as { cooperationOf?: (s: string) => number } | null;
                if (r && typeof r.cooperationOf === 'function') return Math.max(0, r.cooperationOf('player') || 0);
                for (const ch of cur.children) stack.push(ch);
            }
        } catch (e) { /* 忽略 */ }
        return 0;
    }

    private renderItem(it: TipAbilityItem): string {
        let s = '';
        if (it.ability) s += this.kw(`【${it.ability}】`, it.ability);
        if (it.desc) s += `<color=#${hex(this.textColor)}>${this.highlight(it.desc)}</color>`;
        for (const sub of it.subs || []) {
            if (sub.ability) s += this.kw(`【${sub.ability}】`, sub.ability);
            if (sub.desc) s += `<color=#${hex(this.textColor)}>${this.highlight(sub.desc)}</color>`;
        }
        return s;
    }

    /**
     * 高亮一段描述里的关键字（每个都做成可点 → 弹出能力详情）。
     *
     * 🔴 支持**在描述正文里直接写【关键字】**（用户需求）—— 与 `ability` 字段同款渲染：
     *    `【】` 连括号一起染成关键字色 + 加粗；括号里的词能解析成登记关键字时**还可点**弹详情。
     *    所以描述里想强调某个关键词，写 `【守护】` 即可，不必再拆成单独一条 `ability`。
     *    （`ability` 那条的写法不变，仍然只认「句首」那一个名字。）
     */
    private highlight(text: string): string {
        let rest = this.escape(text);
        let out = '';
        let guard = 0;
        while (rest.length > 0 && guard++ < 500) {
            const open = rest.indexOf('【');
            // ① 「【」之前的部分：按登记关键字高亮（老逻辑）
            out += this.highlightPlain(open >= 0 ? rest.slice(0, open) : rest);
            if (open < 0) break;
            const close = rest.indexOf('】', open + 1);
            if (close < 0) { out += rest.slice(open); break; }     // 没有闭合 → 原样输出
            // ② 「【xxx】」整段当作一个关键字：能解析成登记关键字 → 可点；否则只高亮
            const inner = rest.slice(open + 1, close);
            const known = resolveKeyword(inner);
            out += this.kw(rest.slice(open, close + 1), known ? inner : undefined);
            rest = rest.slice(close + 1);
        }
        return out;
    }

    /** 描述正文里**不带括号**的登记关键字高亮（每个都做成可点 → 弹出能力详情） */
    private highlightPlain(text: string): string {
        let rest = text;
        let out = '';
        let guard = 0;
        while (rest.length > 0 && guard++ < 500) {
            let best = -1;
            let bestKw = '';
            for (const k of this._keywords) {
                const i = rest.indexOf(k);
                if (i < 0) continue;
                if (best < 0 || i < best || (i === best && k.length > bestKw.length)) {
                    best = i;
                    bestKw = k;
                }
            }
            if (best < 0) { out += rest; break; }
            out += rest.slice(0, best) + this.kw(bestKw, bestKw);
            rest = rest.slice(best + bestKw.length);
        }
        return out;
    }

    /**
     * 高亮片段（黄字加粗）。
     * @param text    要显示的文本（能力名带【】）
     * @param keyword 关键字原文（**不含**【】）；给了就登记进「本卡关键字」并做成可点。
     *                🔴 同一个关键字在描述里可能出现多次，但**只登记一次**（去重、保持出现顺序）。
     */
    private kw(text: string, keyword?: string): string {
        const body = `<b><color=#${hex(this.keywordColor)}>${this.escape(text)}</color></b>`;
        const raw = typeof keyword === 'string' ? keyword.trim() : '';
        if (!raw) return body;
        // 🔴 登记的是**归一化**后的关键字（`吟唱_4` → `吟唱`、`【入场曲】` → `入场曲`）：
        //    说明项里写的名字可能带修饰（回合数 / 括号），而详情表按关键字原文登记。
        const k = resolveKeyword(raw) || raw;
        this.noteKeyword(k);
        // 🔴 标签与方法名必须与 TipKeywordLink.onTipKeywordClick 一致
        //    （RichText 在**自己所在节点**上按方法名找组件方法 → 见 TipKeywordLink 注释）
        return `<on click="${KEYWORD_CLICK_HANDLER}" param="${this.attr(k)}">${body}</on>`;
    }

    /** 记录本张说明卡片里出现过的关键字（去重，保持出现顺序） */
    private noteKeyword(keyword: string): void {
        const k = typeof keyword === 'string' ? keyword.trim() : '';
        if (!k) return;
        if (this._panelKeywords.indexOf(k) >= 0) return;
        this._panelKeywords.push(k);
    }

    /**
     * 收集「说明卡片里可点的关键字」的**命中矩形**（黄字段落节点）。
     *
     * 🔴 为什么自己做命中判定，而不是只靠富文本的 `<on click=...>`：
     *    `<on click>` 的派发由 `RichText._onTouchEnded` 完成，而它要求
     *    「触摸点既落在 RichText 节点的矩形内、又落在**分段**的 world 矩形内」；
     *    本项目 7456 实时预览的坐标口径（画布 backing 1280×673 ≠ 设计高度 720）下实测
     *    引擎那一路**收不到**（点明明在关键字上却不触发）。这里复用**分段自身的节点矩形**
     *    （与引擎同一份数据），在 Canvas 的单击判定里自己测 —— 稳、且与既有交互同一处逻辑。
     *    `<on click>` 标记仍然保留（其它运行时若生效，两条路都指向同一个 `openDetail`，幂等）。
     */
    private collectKeywordHits(): void {
        this._kwHits.length = 0;
        const panel = this._panel;
        if (!panel) return;
        // 🔴 一次**按文档顺序**的深度优先遍历：既处理富文本分段，也处理「纹章」这种普通 Label 标签，
        //    保证 `_kwHits` 的顺序与 `_panelKeywords`（构建时登记的顺序）一致。
        const dfs = (n: Node): void => {
            // ① 纹章栏目标签（黄字 Label）：整块作为「纹章」关键字的命中区
            if (CREST_TAG_NAMES.indexOf(n.name) >= 0 && n.getComponent(Label)) {
                this._kwHits.push({ keyword: CREST_KEYWORD, nodes: [n] });
            }
            // ② 富文本：逐段找出「文本正好是某关键字」的分段（可能被换行切成两段 → 同行内贪心拼接）
            if (n.getComponent(RichText)) this.collectRichTextHits(n);
            for (const c of n.children) dfs(c);
        };
        dfs(panel);
    }

    /** 收集单个富文本节点里的关键字段落（顺序 = 文字顺序） */
    private collectRichTextHits(rtNode: Node): void {
        const segs = this.segmentsOf(rtNode);
        let i = 0;
        while (i < segs.length) {
            // 从第 i 段起贪心拼接：拼到某个关键字为止（关键字可能被换行切成两段）
            let acc = '';
            let spanNodes: Node[] = [];
            let hit: { keyword: string; nodes: Node[] } | null = null;
            for (let j = i; j < segs.length; j++) {
                const s = segs[j];
                // 只拼**同一行**的分段（y 差在半行以内），避免把上下行的字拼到一起
                if (spanNodes.length > 0) {
                    const prev = spanNodes[spanNodes.length - 1];
                    if (Math.abs(s.y - this.segY(prev)) > s.h * 0.6) break;
                }
                acc += s.text;
                spanNodes.push(s.node);
                const kw = this.keywordOf(acc);
                if (kw) { hit = { keyword: kw, nodes: spanNodes.slice() }; break; }
                // 连「任何关键字的前缀」都不是 → 这一轮放弃，从下一段重新开始
                if (!this.isKeywordPrefix(acc)) break;
            }
            if (hit) {
                this._kwHits.push({ keyword: hit.keyword, nodes: hit.nodes });
                i += hit.nodes.length;
            } else {
                i++;
            }
        }
    }

    /** 取一个 RichText 节点里的分段（顺序 = 文字顺序）：文本 + 节点 + 世界 y/行高 */
    private segmentsOf(rtNode: Node): Array<{ text: string; node: Node; y: number; h: number }> {
        const out: Array<{ text: string; node: Node; y: number; h: number }> = [];
        const push = (node: Node): void => {
            const lb = node.getComponent(Label);
            const ut = node.getComponent(UITransform);
            if (!lb || !ut || !lb.string) return;
            out.push({
                text: lb.string,
                node,
                y: node.worldPosition.y,
                h: Math.max(4, ut.contentSize.height || ut.contentSize.width * 0),
            });
        };
        // `_segments` 是引擎内部字段（存在就用它，顺序最准）；取不到就退回「子节点里的 Label」
        const segs = (rtNode as unknown as { _segments?: Array<{ node?: Node }> })._segments;
        if (Array.isArray(segs) && segs.length > 0) {
            for (const s of segs) if (s && s.node && s.node.isValid) push(s.node);
        }
        if (out.length === 0) {
            for (const c of rtNode.children) push(c);
        }
        // 行高兜底（分段的 UITransform 高度可能是 0：Label 用 lineHeight 排版）
        for (const s of out) if (!(s.h > 0)) s.h = Math.max(6, this.fontSize * this.lineHeightRatio);
        return out;
    }

    private segY(n: Node): number {
        return n && n.isValid ? n.worldPosition.y : 0;
    }

    /** 整段文字正好是某个登记关键字 → 返回该关键字；否则 '' */
    private keywordOf(text: string): string {
        return resolveKeyword(text);
    }

    /** 这段文字是不是「某个登记关键字的前缀」（决定还要不要继续往右拼） */
    private isKeywordPrefix(text: string): boolean {
        if (!text) return true;
        for (const k of this._keywords) {
            if (k.indexOf(text) === 0) return true;
        }
        return false;
    }

    /**
     * 这一下点击是否落在某个**黄字关键字**上（UI 坐标）。
     * @returns 命中的关键字（没命中 → ''）
     */
    private hitKeywordAt(ui: Vec2 | Vec3): string {
        if (this._kwHits.length === 0) return '';
        const world = this.uiToWorld(ui, _worldScratch);
        _pointScratch.set(world.x, world.y);
        for (const h of this._kwHits) {
            for (const n of h.nodes) {
                if (!n || !n.isValid) continue;
                const ut = n.getComponent(UITransform);
                if (!ut) continue;
                if (ut.getBoundingBoxToWorld().contains(_pointScratch)) return h.keyword;
            }
        }
        return '';
    }

    /** 富文本**属性值**里的转义（`param="..."`；中文本身无需转义，只需挡住引号与 & < >） */
    private attr(text: string): string {
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    /** 富文本里 `<` `>` `&` 必须转义（引擎解析时会还原成原字符） */
    private escape(text: string): string {
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    /**
     * 建一个富文本节点并排版。
     * 🔴 直接读「设置 string 之后的节点高度」—— RichText 的 `string` setter 是**同步排版**
     *    （引擎 `_updateRichText` 里立刻 `setContentSize`），所以布局可以一次性算完。
     */
    private addRichText(html: string, x: number, topY: number, width: number): number {
        const n = new Node('TipText');
        n.layer = this._panel!.layer;
        this._panel!.addChild(n);
        const ut = n.addComponent(UITransform);
        ut.setAnchorPoint(0, 1);
        n.setPosition(x, topY, 0);

        const rt = n.addComponent(RichText);
        rt.fontFamily = this.fontFamily;
        rt.fontSize = Math.max(6, Math.round(this.fontSize));
        rt.lineHeight = Math.round(Math.max(6, this.fontSize) * Math.max(0.8, this.lineHeightRatio));
        rt.fontColor = this.textColor;
        rt.horizontalAlign = HorizontalTextAlignment.LEFT;
        rt.verticalAlign = Label.VerticalAlign.TOP;
        rt.maxWidth = Math.max(20, width);
        rt.string = html;

        // 🔴 带 `<on click=...>` 的富文本 → 挂一个**关键字点击转发器**：
        //    引擎的富文本点击是在**本节点**上按方法名找组件方法（见 TipKeywordLink 注释），
        //    挂在 CardTipLayer 上的本组件同名方法是收不到回调的。
        if (html.indexOf(KEYWORD_CLICK_HANDLER) >= 0) {
            const link = n.getComponent(TipKeywordLink) || n.addComponent(TipKeywordLink);
            link.onKeyword = (kw: string) => { this.openDetail(kw); };
        }

        const h = ut.contentSize.height;
        if (!(h > 0)) {
            this._needRetry = true;
            return Math.max(8, Math.max(6, this.fontSize) * Math.max(0.8, this.lineHeightRatio));
        }
        return h;
    }

    // ---- 纹章子框（卡牌下方的「纹章」块，形如例图）----
    private addCrestSection(entry: CrestTipInfo, sf: SpriteFrame | null): void {
        const P = this.padding;
        const innerP = Math.max(6, P * 0.7);
        const boxX = P;
        const boxW = Math.max(40, this.tipWidth - P * 2);
        const boxTop = this._cursorY;
        const cx = boxX + innerP;
        const cw = Math.max(20, boxW - innerP * 2);
        const rowH = this.iconRowH();
        const cy = boxTop - innerP - rowH / 2;

        if (sf) this.addRoundIcon('TipCrestBoxIcon', sf, cx + rowH / 2, cy, rowH * 0.98);
        const tagW = this.fontSize * 2.2;
        const tagX = cx + (sf ? rowH : 0) + 6;
        const tag = this.makeLabel('TipCrestBoxTag', '纹章', this.fontSize + 2, this.keywordColor,
            HorizontalTextAlignment.LEFT, true, 0, 0.5, tagW, rowH);
        tag.node.setPosition(tagX, cy, 0);
        // 🔴 「纹章」这个黄字**也是关键字**：登记进本卡关键字表（卡牌下方的纹章子框同理）
        this.noteKeyword(CREST_KEYWORD);
        const nameX = tagX + tagW + 4;
        const nl = this.makeLabel('TipCrestBoxName', entry.name || '', this.fontSize + 2, this.titleColor,
            HorizontalTextAlignment.LEFT, true, 0, 0.5, Math.max(20, cx + cw - nameX), rowH);
        nl.node.setPosition(nameX, cy, 0);

        let y = boxTop - innerP - rowH - Math.max(2, this.itemGap * 0.6);
        for (const it of entry.items || []) {
            const html = this.renderItem(it);
            if (!html) continue;
            const h = this.addRichText(html, cx, y, cw);
            y -= h + this.itemGap;
        }

        const boxH = (boxTop - y) + innerP - this.itemGap;
        this._crestBoxRect = { x: boxX, y: boxTop - boxH, w: boxW, h: boxH };
        const r = Math.max(2, this.cornerRadius * 0.8);
        this._ops.push((g) => {
            g.fillColor = this.crestBoxColor;
            g.roundRect(boxX, boxTop - boxH, boxW, boxH, r);
            g.fill();
            g.lineWidth = Math.max(1, this.borderWidth * 0.6);
            g.strokeColor = new Color(this.bgBorderColor.r, this.bgBorderColor.g, this.bgBorderColor.b, 150);
            g.roundRect(boxX, boxTop - boxH, boxW, boxH, r);
            g.stroke();
        });

        this._cursorY = this._crestBoxRect.y - this.sectionGap;
    }

    // ====================== 面板：绘制 / 排版零件 ======================
    private makeLabel(
        name: string, text: string, size: number, color: Color,
        hAlign: HorizontalTextAlignment, bold: boolean,
        ax: number, ay: number, w: number, h: number,
    ): Label {
        const n = new Node(name);
        n.layer = this._panel!.layer;
        this._panel!.addChild(n);
        const ut = n.addComponent(UITransform);
        ut.setAnchorPoint(ax, ay);
        const lb = n.addComponent(Label);
        lb.fontFamily = this.fontFamily;
        lb.fontSize = Math.max(6, Math.round(size));
        lb.lineHeight = Math.round(Math.max(6, size) * 1.05);
        lb.horizontalAlign = hAlign;
        lb.verticalAlign = Label.VerticalAlign.CENTER;
        lb.overflow = Label.Overflow.SHRINK;               // 🔴 先定 SHRINK 再设尺寸（铁律 24）
        lb.isBold = bold;
        lb.enableOutline = true;
        lb.outlineColor = this.outlineColor;
        lb.outlineWidth = Math.max(1, Math.round(size * 0.06));
        lb.color = new Color(color.r, color.g, color.b, color.a);
        lb.string = text;
        ut.setContentSize(Math.max(8, w), Math.max(8, h));
        return lb;
    }

    private addCenteredLabel(name: string, text: string, cx: number, cy: number, size: number): void {
        const lb = this.makeLabel(name, text, size, this.badgeTextColor,
            HorizontalTextAlignment.CENTER, true, 0.5, 0.5, size * 2.4, size * 1.7);
        lb.node.setPosition(cx, cy, 0);
    }

    /** 徽记圆（底 + 亮边） */
    private drawBadge(g: Graphics, cx: number, cy: number, r: number, fill: Color): void {
        g.fillColor = fill;
        g.circle(cx, cy, r);
        g.fill();
        const lw = Math.max(1, r * 0.15);
        g.lineWidth = lw;
        g.strokeColor = this.badgeRingColor;
        g.circle(cx, cy, r - lw * 0.5);
        g.stroke();
    }

    /** 圆形图标（方形贴图四角用椭圆 Mask 裁掉，与纹章区同一手法） */
    private addRoundIcon(name: string, sf: SpriteFrame, cx: number, cy: number, d: number): void {
        const holder = new Node(name);
        holder.layer = this._panel!.layer;
        this._panel!.addChild(holder);
        const hut = holder.addComponent(UITransform);
        hut.setAnchorPoint(0.5, 0.5);
        hut.setContentSize(d, d);
        holder.setPosition(cx, cy, 0);
        const mask = holder.addComponent(Mask);
        mask.type = Mask.Type.GRAPHICS_ELLIPSE;

        const img = new Node(name + 'Img');
        img.layer = this._panel!.layer;
        holder.addChild(img);
        const iut = img.addComponent(UITransform);
        iut.setAnchorPoint(0.5, 0.5);
        iut.setContentSize(d, d);
        const sp = img.addComponent(Sprite);
        sp.type = Sprite.Type.SIMPLE;
        sp.sizeMode = Sprite.SizeMode.CUSTOM;              // 🔴 自己控尺寸（TRIMMED 会改写 contentSize）
        sp.trim = false;
        sp.spriteFrame = sf;
        img.setPosition(0, 0, 0);
    }

    // ====================== 选中圆环 ======================
    /**
     * 圆环该画在哪、画多大。
     * · 卡牌 → **卡图中央**（`CardImage` 子节点的世界中心），外径 = `ringSizeOnCard`；
     * · 纹章 → 槽位中心，外径 = 圆框直径 × `ringCrestScale`。
     * @returns 外径（px）；找不到渲染层返回 0（调用方跳过）
     */
    private ringTargetOf(pick: TipPick, out: Vec3): number {
        Vec3.set(out, 0, 0, 0);
        const layerUT = this.node.getComponent(UITransform);
        if (!layerUT) return 0;
        let outer = 0;
        if (pick.kind === 'crest' && pick.area && pick.slotIndex !== undefined) {
            outer = Math.max(20, pick.area.slotDiameter * Math.max(0.1, this.ringCrestScale));
        } else {
            outer = Math.max(20, this.ringSizeOnCard);
        }
        const src = pick.kind === 'card' || pick.kind === 'hand'
            ? (pick.node.getChildByName('CardImage') || pick.node)
            : pick.node;
        if (!src || !src.isValid) return 0;
        src.getWorldPosition(_outScratch);
        layerUT.convertToNodeSpaceAR(_outScratch, out);
        return outer;
    }

    private placeRing(pick: TipPick): void {
        const ring = this._ring;
        if (!ring || !ring.isValid) return;
        const outer = this.ringTargetOf(pick, _outScratch);
        if (outer <= 0) return;

        ring.setPosition(_outScratch.x, _outScratch.y, 0);
        this._ringOuter = outer;
        const rut = ring.getComponent(UITransform);
        if (rut) {
            rut.setAnchorPoint(0.5, 0.5);
            rut.setContentSize(outer, outer);
        }
        this._ringAngle = 0;
        this._ringT = 0;
        this._ringOn = true;
        ring.active = true;
        this.tickRing(0);
    }

    /**
     * 🔴 每帧把圆环**钉在目标中心**。
     *
     * 为什么要每帧跟：点**我方战场**随从的那一下，`BattleFieldPressGlow` 会先把卡牌
     * `position.y` 抬高 `liftY`（0.12s 补间），松手才落回 —— 说明卡片是在**抬起状态**下
     * 弹出来的，若只在显示那一刻取一次位置，圆环就会永远停在高 14px 的地方（实测 bug）。
     * 每帧跟随 = 卡牌落回时圆环跟着归位，之后无论是战场重排（Reflow）、进化动画把卡牌
     * 换父节点，圆环都不会飘走。
     */
    private followRing(): void {
        if (!this._ringOn || !this._ring || !this._ring.isValid) return;
        if (!this._targetNode || !this._targetNode.isValid) return;
        const pick: TipPick = {
            kind: (this._kind || 'card') as TipPick['kind'],
            node: this._targetNode,
            id: this._targetId,
            area: this._targetArea || undefined,
            slotIndex: this._targetSlot >= 0 ? this._targetSlot : undefined,
        };
        const outer = this.ringTargetOf(pick, _outScratch);
        if (outer <= 0) return;
        this._ring.setPosition(_outScratch.x, _outScratch.y, 0);
    }

    /** 每帧：顺时针旋转 + 呼吸透明度 + 重画 */
    private tickRing(dt: number): void {
        const ring = this._ring;
        if (!ring || !ring.isValid) { this._ringOn = false; return; }
        if (!ring.active) ring.active = true;

        this._ringAngle -= this.ringSpinSpeed * dt;      // 减小 = 顺时针（见引擎 angle = eulerAngles.z）
        ring.angle = this._ringAngle;

        this._ringT += dt;
        const period = Math.max(0.05, this.ringBreathPeriod);
        const w = 0.5 + 0.5 * Math.cos((this._ringT / period) * Math.PI * 2);   // 1 → 0 → 1
        const minA = clamp01(this.ringMinAlpha);
        const maxA = Math.max(minA, clamp01(this.ringMaxAlpha));
        // 🔴 纹章圆框上的圆环**默认不呼吸**（`ringCrestBreath = false`）：恒定 = maxA，
        //    只保留常态旋转 —— 纹章圆环本来就小，呼吸的一闪一闪反而像在提醒 / 闪烁。
        const breathe = this._kind !== 'crest' || this.ringCrestBreath;
        const alpha = breathe ? minA + (maxA - minA) * w : maxA;
        this.drawRing(alpha);
    }

    /**
     * 画选中圆环：`ringArcCount` 个**不连在一起**的弧，每个弧由细到粗 + 首端箭头。
     * alpha 直接写进颜色（与 `CrestRipple` 同一手法：每帧重画，不依赖材质 / UIOpacity）。
     *
     * 🔴 **弧的首尾方向必须与旋转方向一致**（`tickRing` 里 `_ringAngle` 递减 = 顺时针）：
     * 每条弧 = 一枚「细尾 → 渐粗 → 箭头」的**顺时针飞行**的彗星，箭头画在本段角度的
     * **小角度端**，箭头朝向角度**减小**方向。反了就会出现「顺时针转、箭头却指逆时针」
     * 的倒着转观感（历史 bug）。
     */
    private drawRing(alpha: number): void {
        const g = this._ringGfx;
        if (!g || !g.isValid) return;
        g.clear();
        const outer = Math.max(20, this._ringOuter);
        const a = clamp01(alpha);
        if (a <= 0.004) return;

        const n = Math.max(1, Math.round(this.ringArcCount));
        const t = Math.max(1, outer * clamp(this.ringThicknessRatio, 0.005, 0.4));
        const R = Math.max(2, outer / 2 - t / 2);
        const seg = (Math.PI * 2) / n;
        const sweep = seg * clamp(this.ringArcSweepRatio, 0.1, 0.98);
        const headLen = outer * clamp(this.ringHeadSizeRatio, 0.01, 0.4);
        const steps = 12;

        const main = this.ringColor;
        const glow = this.ringGlowColor;
        const mainA = Math.round(a * (main.a / 255) * 255);
        const glowA = Math.round(a * (glow.a / 255) * 255 * clamp01(this.ringGlowAlpha));

        for (let i = 0; i < n; i++) {
            const a0 = i * seg;
            const a1 = a0 + sweep;
            // 本段弧的两个端点：**尾 = 大角度端 a1**（细端），**首 = 小角度端 a0**（箭头端）。
            // 顺时针前进 ⇒ 前端在小角度那一侧，于是箭头落在 a0、朝角度减小方向。
            const tail = a1;
            const head = a0;
            // 外层柔光：更宽、更淡的同形弧（宽度别太大，否则小块头下会把弧间空隙糊掉）
            if (glowA > 3) {
                g.fillColor = new Color(glow.r, glow.g, glow.b, glowA);
                this.arcPath(g, R, t * 1.9, tail, head, steps);
                g.fill();
                this.headPath(g, R, t, head, headLen * 1.2);
                g.fill();
            }
            g.fillColor = new Color(main.r, main.g, main.b, mainA);
            this.arcPath(g, R, t, tail, head, steps);
            g.fill();
            this.headPath(g, R, t, head, headLen);
            g.fill();
        }
    }

    /** 一条「由尾到首渐细」的弧（闭合多边形，可直接 fill） */
    private arcPath(g: Graphics, R: number, t: number, a0: number, a1: number, steps: number): void {
        const taper = 0.55;                 // 首端比尾端细 55%
        g.moveTo(...this.arcPoint(R, t, a0, 0, taper));
        for (let k = 1; k <= steps; k++) {
            const f = k / steps;
            const p = this.arcPoint(R, t, a0 + (a1 - a0) * f, f, taper);
            g.lineTo(p[0], p[1]);
        }
        for (let k = steps; k >= 0; k--) {
            const f = k / steps;
            const ang = a0 + (a1 - a0) * f;
            const w = t * (1 - taper * f);
            g.lineTo(Math.cos(ang) * (R - w / 2), Math.sin(ang) * (R - w / 2));
        }
        g.close();
    }

    private arcPoint(R: number, t: number, ang: number, f: number, taper: number): [number, number] {
        const w = t * (1 - taper * f);
        return [Math.cos(ang) * (R + w / 2), Math.sin(ang) * (R + w / 2)];
    }

    /** 弧首端的箭头（沿切线方向指出去；切线方向 = 角度**减小**方向 = 圆环的顺时针旋转方向） */
    private headPath(g: Graphics, R: number, t: number, ang: number, headLen: number): void {
        const hx = Math.cos(ang) * R;
        const hy = Math.sin(ang) * R;
        const tx = Math.sin(ang);           // 切线（角度减小方向 = 顺时针，与 ringSpinSpeed 同向）
        const ty = -Math.cos(ang);
        const nx = Math.cos(ang);           // 径向
        const ny = Math.sin(ang);
        const half = Math.max(1.5, t * 0.62);
        g.moveTo(hx + tx * headLen, hy + ty * headLen);
        g.lineTo(hx + nx * half, hy + ny * half);
        g.lineTo(hx - tx * headLen * 0.55, hy - ty * headLen * 0.55);
        g.lineTo(hx - nx * half, hy - ny * half);
        g.close();
    }

    // ====================== 能力详情弹窗 ======================
    /**
     * 构建并显示「能力详情」的内容（屏幕正中的模态弹窗）。
     *
     * 🔴 面板**宽高固定**（`detailWidth` / `detailHeight`）：内容只会影响**滚动范围**，
     *    永远不会把面板撑大；超出可视高度的部分靠上下滑动查看。
     * @param list 关键字条目（**已按出现顺序**），来自 `CardTipData.keywordDetails`
     */
    private buildDetail(list: Array<{ keyword: string; desc: string }>): void {
        const panel = this._detail!;
        const W = Math.max(240, Math.round(this.detailWidth));
        const H = Math.max(160, Math.round(this.detailHeight));
        const ut = panel.getComponent(UITransform)!;
        ut.setContentSize(W, H);
        this.centerOnScreen(panel);          // 🔴 摆到屏幕正中（不是本节点局部原点）
        this.centerOnScreen(this._detailBlocker!);
        this._detailRemeasure = false;       // 本次构建会重新判定是否需要补量

        // 清掉上一次的内容（每次都整片重建，避免残留）
        for (const c of panel.children.slice()) {
            if (!c || !c.isValid) continue;
            c.removeFromParent();
            c.destroy();
        }

        const pad = Math.max(0, this.detailPadding);
        const headerH = Math.max(0, this.detailHeaderH);
        const footerH = Math.max(0, this.detailFooterH);
        const gap = Math.max(0, this.detailSectionGap);
        const sbW = Math.max(0, this.detailScrollBarWidth);
        const sbReserve = sbW > 0 ? sbW + Math.max(4, sbW) : 0;

        const top = H / 2;
        const viewTop = top - headerH - gap;
        const viewBottom = -H / 2 + footerH + gap;
        const viewW = Math.max(40, W - pad * 2 - sbReserve);
        const viewH = Math.max(20, viewTop - viewBottom);

        // ---- 标题「能力详情」----
        const title = this.makeDetailLabel('DetailTitle', '能力详情',
            Math.max(10, this.detailTitleFontSize), this.detailTitleColor,
            HorizontalTextAlignment.CENTER, true, 0.5, 0.5, W - pad * 2, headerH);
        title.node.setPosition(0, top - headerH / 2, 0);

        // ---- 右上角 ✕ ----
        const markS = Math.max(10, this.detailCloseMarkSize);
        const markCx = W / 2 - pad * 0.5 - markS / 2;
        const markCy = top - headerH / 2;
        const mark = this.makeDetailLabel('DetailClose', '✕', markS * 0.86, this.detailTitleColor,
            HorizontalTextAlignment.CENTER, true, 0.5, 0.5, markS * 1.3, markS * 1.3);
        mark.node.setPosition(markCx, markCy, 0);
        this._detailCloseRect = { x: markCx - markS * 0.85, y: markCy - markS * 0.85, w: markS * 1.7, h: markS * 1.7 };

        // ---- 可滚动区：Viewport(Mask) → Content ----
        const view = new Node(DETAIL_VIEW_NAME);
        view.layer = panel.layer;
        panel.addChild(view);
        const vut = view.addComponent(UITransform);
        vut.setAnchorPoint(0.5, 0.5);
        vut.setContentSize(viewW, viewH);
        const mask = view.addComponent(Mask);
        mask.type = Mask.Type.GRAPHICS_RECT;              // 矩形裁剪：超出可视高度的内容被裁掉
        view.setPosition(-W / 2 + pad + viewW / 2, viewTop - viewH / 2, 0);

        const content = new Node(DETAIL_CONTENT_NAME);
        content.layer = panel.layer;
        view.addChild(content);
        const cut = content.addComponent(UITransform);
        cut.setAnchorPoint(0, 1);                          // 局部原点 = 内容左上角
        content.setPosition(-viewW / 2, viewH / 2, 0);     // 初始：内容顶部对齐可视区顶部

        // 逐条排版：关键字名（黄字） + 说明正文（按内容字号自动换行）
        const descSize = Math.max(8, Math.round(this.detailFontSize));
        const nameSize = descSize + 2;
        const lineH = Math.round(descSize * Math.max(0.8, this.detailLineHeightRatio));
        const nameGap = Math.max(0, this.detailNameGap);
        const itemGap = Math.max(0, this.detailItemGap);
        let y = 0;                                         // 内容本地坐标（向下为负）
        // 🔴 内容用量按**实际渲染出来的底边**量：`minBottom = min(子节点顶部 y − 自身高度)`。
        //    这样即使某段 RichText 这一帧还没排版出高度（= 0），也只是暂时偏小，
        //    标记 `_detailRemeasure` 后下一帧重排一次即可拿到真实高度（避免「滑不到最后一条」）。
        let minBottom = 0;
        const noteBottom = (node: Node): void => {
            const hut = node.getComponent(UITransform);
            const h = hut ? hut.contentSize.height : 0;
            if (!(h > 0)) this._detailRemeasure = true;
            minBottom = Math.min(minBottom, node.position.y - Math.max(0, h));
        };
        for (const entry of list) {
            const nl = this.makeLabelOn(content, 'DetailKw', entry.keyword, nameSize, this.detailKeywordColor,
                HorizontalTextAlignment.LEFT, true, 0, 1, viewW, nameSize * 1.4);
            nl.node.setPosition(0, y, 0);
            const nh = Math.max(nl.node.getComponent(UITransform)!.contentSize.height, nameSize * 1.2);
            noteBottom(nl.node);
            y -= nh + nameGap;

            const h = this.addDetailText(content, entry.desc, descSize, lineH, viewW, y);
            const descNode = content.children[content.children.length - 1];
            if (descNode) noteBottom(descNode);
            y -= h + itemGap;
        }
        const contentH = Math.max(viewH, -minBottom + itemGap);
        cut.setContentSize(viewW, contentH);
        this._detailContent = content;
        this._detailViewH = viewH;
        this._detailContentH = contentH;
        this._detailScrollMax = Math.max(0, contentH - viewH);
        this._detailW = W;
        this._detailTop = viewTop;
        this._detailViewBottom = viewBottom;

        // ---- 右侧滑动条（内容超出时才画；滑动时重画）----
        // 🔴 滑动条的 Graphics 直接画在**弹窗本地坐标**里（节点放在 (0,0) 不偏移），
        //    这样 `updateDetailScrollBar` 里那套坐标可以同时用于绘制与命中，不会出现两套基准。
        const bar = new Node('DetailScrollBar');
        bar.layer = panel.layer;
        panel.addChild(bar);
        const but = bar.addComponent(UITransform);
        but.setAnchorPoint(0.5, 0.5);
        but.setContentSize(Math.max(1, sbW), viewH);
        bar.setPosition(0, 0, 0);
        bar.addComponent(Graphics);

        // ---- 底部「关闭」按钮 ----
        const bw = Math.max(60, this.detailButtonWidth);
        const bh = Math.max(20, this.detailButtonHeight);
        const btnCy = -H / 2 + footerH / 2;
        const btn = this.makeDetailLabel('DetailCloseText', '关闭', descSize, this.detailButtonTextColor,
            HorizontalTextAlignment.CENTER, true, 0.5, 0.5, bw, bh);
        btn.node.setPosition(0, btnCy, 0);
        this._detailButtonRect = { x: -bw / 2, y: btnCy - bh / 2, w: bw, h: bh };
        this._detailBtnSize = { w: bw, h: bh, cy: btnCy };

        // ---- 画底：面板 / 分隔线 / 按钮框 ----
        this.drawDetailChrome(W, H, headerH, bw, bh, btnCy);

        // ---- 复位滚动 ----
        this._detailScrollVel = 0;
        this._detailSpring.active = false;
        this.applyDetailScroll(0);
        this.updateDetailScrollBar();
    }

    /** 弹窗底图：面板圆角底 + 描边 + 标题下分隔线 + 底部按钮框 */
    private drawDetailChrome(W: number, H: number, headerH: number,
        bw: number, bh: number, btnCy: number): void {
        const g = this._detailGfx!;
        g.clear();
        const r = Math.max(0, this.detailCornerRadius);
        const halfW = W / 2;
        const halfH = H / 2;

        g.fillColor = this.detailBgColor;
        g.roundRect(-halfW, -halfH, W, H, r);
        g.fill();
        if (this.detailBorderWidth > 0) {
            g.lineWidth = this.detailBorderWidth;
            g.strokeColor = this.detailBorderColor;
            g.roundRect(-halfW, -halfH, W, H, r);
            g.stroke();
        }

        // 标题下分隔线
        const pad = Math.max(0, this.detailPadding);
        const lineY = halfH - headerH;
        g.lineWidth = Math.max(1, this.detailBorderWidth * 0.7);
        g.strokeColor = this.detailLineColor;
        g.moveTo(-halfW + pad, lineY);
        g.lineTo(halfW - pad, lineY);
        g.stroke();

        // 底部按钮框（描边 + 极淡底）
        g.lineWidth = Math.max(1, this.detailBorderWidth * 0.8);
        g.strokeColor = this.detailLineColor;
        g.roundRect(-bw / 2, btnCy - bh / 2, bw, bh, Math.min(8, bh * 0.25));
        g.stroke();
    }

    /** 在**弹窗内容**里加一段说明正文（纯文本，按 `detailFontSize` 自动换行） */
    private addDetailText(parent: Node, text: string, size: number, lineH: number,
        width: number, topY: number): number {
        const n = new Node('DetailDesc');
        n.layer = parent.layer;
        parent.addChild(n);
        const ut = n.addComponent(UITransform);
        ut.setAnchorPoint(0, 1);
        n.setPosition(0, topY, 0);
        const rt = n.addComponent(RichText);
        rt.fontFamily = this.fontFamily;
        rt.fontSize = Math.max(6, Math.round(size));
        rt.lineHeight = Math.max(6, lineH);
        rt.fontColor = this.detailDescColor;
        rt.horizontalAlign = HorizontalTextAlignment.LEFT;
        rt.verticalAlign = Label.VerticalAlign.TOP;
        rt.maxWidth = Math.max(20, width);
        rt.string = `<color=#${hex(this.detailDescColor)}>${this.escape(text)}</color>`;
        const h = ut.contentSize.height;
        return h > 0 ? h : lineH;
    }

    /** 在**任意父节点**下建一个 Label（弹窗 / 说明卡片共用同一套排版口径） */
    private makeLabelOn(
        parent: Node, name: string, text: string, size: number, color: Color,
        hAlign: HorizontalTextAlignment, bold: boolean,
        ax: number, ay: number, w: number, h: number,
    ): Label {
        const n = new Node(name);
        n.layer = parent.layer;
        parent.addChild(n);
        const ut = n.addComponent(UITransform);
        ut.setAnchorPoint(ax, ay);
        const lb = n.addComponent(Label);
        lb.fontFamily = this.fontFamily;
        lb.fontSize = Math.max(6, Math.round(size));
        lb.lineHeight = Math.round(Math.max(6, size) * 1.05);
        lb.horizontalAlign = hAlign;
        lb.verticalAlign = Label.VerticalAlign.CENTER;
        lb.overflow = Label.Overflow.SHRINK;               // 🔴 先定 SHRINK 再设尺寸（铁律 24）
        lb.isBold = bold;
        lb.enableOutline = true;
        lb.outlineColor = this.outlineColor;
        lb.outlineWidth = Math.max(1, Math.round(size * 0.06));
        lb.color = new Color(color.r, color.g, color.b, color.a);
        lb.string = text;
        ut.setContentSize(Math.max(8, w), Math.max(8, h));
        return lb;
    }

    /** 弹窗里的 Label 便捷版（挂到弹窗节点上） */
    private makeDetailLabel(
        name: string, text: string, size: number, color: Color,
        hAlign: HorizontalTextAlignment, bold: boolean,
        ax: number, ay: number, w: number, h: number,
    ): Label {
        return this.makeLabelOn(this._detail!, name, text, size, color, hAlign, bold, ax, ay, w, h);
    }

    /**
     * 把滚动位移写进内容节点位置（**不夹取** —— 越界交给弹性回弹负责）。
     *
     * 🔴 **方向口径（别写反）**：`_detailScrollY` 是「已经往下滚了多少」，
     *    0 = 内容顶部贴住可视区顶部。要让**后面的内容**进入可视区，内容块必须**往上**走 ⇒
     *    `content.y = viewH/2 + scrollY`（scrollY 变大 → y 变大 → 内容上移）。
     *    写成 `viewH/2 − scrollY` 会让「往下滚」把内容往下推 ⇒ 底部永远看不到（历史 bug，任务3）。
     */
    private applyDetailScroll(y: number): void {
        this._detailScrollY = y;
        const c = this._detailContent;
        if (c && c.isValid) c.setPosition(c.position.x, this._detailViewH / 2 + y, 0);
        const max = this._detailScrollMax;
        this._detailOverscroll = y < 0 ? -y : (y > max ? y - max : 0);
    }

    /**
     * 越界阻尼：把「往外拖的原始位移」映射成**实际位移**。
     * 🔴 越往外拖阻力越大（指数饱和）：起点斜率 = 1（前几像素完全跟手），
     *    越接近 `detailRubberLimit` 越拉不动，永远拉不超过它。
     */
    private rubberDamp(over: number): number {
        const limit = Math.max(0, this.detailRubberLimit);
        if (limit <= 0 || !(over > 0)) return 0;
        return limit * (1 - Math.exp(-over / limit));
    }

    /** 把「原始滚动值」按边界做橡皮筋处理（范围内原样返回） */
    private rubber(raw: number): number {
        const max = this._detailScrollMax;
        if (raw < 0) return -this.rubberDamp(-raw);
        if (raw > max) return max + this.rubberDamp(raw - max);
        return raw;
    }

    /** 启动回弹：弹回最近的合法边界（保留当前速度 ⇒ 会有过冲的弹性感） */
    private startDetailSpring(target: number): void {
        this._detailSpring.active = true;
        this._detailSpring.target = target;
        this._detailScrollVel = 0;               // 回弹由弹簧自己积速度，不从惯性带
    }

    /**
     * 每帧推进弹窗的**惯性 / 回弹**（只在弹窗打开且没在拖拽时跑）。
     *
     * · 越界（`_detailOverscroll > 0`）或弹簧已激活 → 走**弹簧积分**回弹到合法边界；
     * · 否则按 `detailInertiaFriction` 衰减速度做**惯性滑行**，撞到边界就转成回弹。
     * 弹簧用**半隐式欧拉 + 固定小步长**积分（显式积分在大 dt 下会发散）。
     */
    private tickDetail(dt: number): void {
        if (!this._detailOpen) return;
        // 一次性补量：上一帧构建时若有 RichText 还没量出高度 → 现在（弹窗已激活）重排一次
        if (this._detailRemeasure && this._detailList.length > 0) {
            this._detailRemeasure = false;
            const keep = this._detailScrollY;
            this.buildDetail(this._detailList);
            this.applyDetailScroll(Math.max(0, Math.min(this._detailScrollMax, keep)));
            this.updateDetailScrollBar();
        }
        if (this._dragId >= 0) return;
        const s = this._detailSpring;
        const max = this._detailScrollMax;

        if (s.active) {
            const w = (Math.PI * 2) / Math.max(0.06, this.detailSpringPeriod);   // 角频率
            const zeta = Math.max(0.05, this.detailSpringDamping);
            const steps = Math.max(1, Math.min(24, Math.ceil(dt / 0.008)));
            const h = dt / steps;
            for (let i = 0; i < steps; i++) {
                const a = -w * w * (this._detailScrollY - s.target)
                    - 2 * zeta * w * this._detailScrollVel;
                this._detailScrollVel += a * h;
                this._detailScrollY += this._detailScrollVel * h;
            }
            this.applyDetailScroll(this._detailScrollY);
            if (Math.abs(this._detailScrollY - s.target) < 0.5
                && Math.abs(this._detailScrollVel) < 12) {
                s.active = false;
                this._detailScrollVel = 0;
                this.applyDetailScroll(s.target);
            }
            this.updateDetailScrollBar();
            return;
        }

        if (this._detailOverscroll > 0.5) {
            // 还在界外（例如滚轮顶出去的）→ 直接开始回弹
            this.startDetailSpring(this._detailScrollY < 0 ? 0 : max);
            this.updateDetailScrollBar();
            return;
        }

        if (Math.abs(this._detailScrollVel) <= Math.max(0, this.detailInertiaMinSpeed)) {
            this._detailScrollVel = 0;
            return;
        }
        // 惯性：速度按每秒保留比衰减（帧率无关）
        const f = Math.max(0.0001, Math.min(1, this.detailInertiaFriction));
        this._detailScrollVel *= Math.pow(f, dt);
        const y = this._detailScrollY + this._detailScrollVel * dt;
        if (y < 0 || y > max) {
            // 撞边界：先按橡皮筋压出去一点，再回弹（视觉上「顶一下再弹回来」）
            this.applyDetailScroll(this.rubber(y));
            this.startDetailSpring(y < 0 ? 0 : max);
        } else {
            this.applyDetailScroll(y);
        }
        this.updateDetailScrollBar();
    }

    /**
     * 重画右侧滑动条。
     *
     * 🔴 用「**虚拟条带**」口径：条带 = 内容本体 ∪ 当前可视窗口（越界时窗口会伸到内容之外，
     *    条带就被拉长）⇒ 越界时滑块自然**变短**（`trackH / stripH` 变小），回弹时随条带恢复而复原；
     *    滑块位置 = 窗口起点在条带里的比例 ⇒ 越界拖拽时位置也跟着走。
     */
    private updateDetailScrollBar(): void {
        const bar = this._detail ? this._detail.getChildByName('DetailScrollBar') : null;
        const g = bar ? bar.getComponent(Graphics) : null;
        if (!g) return;
        g.clear();
        const sbW = Math.max(0, this.detailScrollBarWidth);
        const trackH = this._detailViewH;
        if (sbW <= 0 || trackH <= 0) return;

        const stripTop = Math.min(0, this._detailScrollY);
        const stripBottom = Math.max(this._detailContentH, this._detailScrollY + trackH);
        const stripH = Math.max(1, stripBottom - stripTop);
        if (stripH <= trackH + 0.5) return;              // 内容没超出、也没越界 → 不画

        const minLen = Math.max(4, Math.min(trackH, this.detailScrollBarMinLen));
        const thumbH = Math.max(minLen, trackH * (trackH / stripH));
        const t = (this._detailScrollY - stripTop) / stripH;
        const thumbTop = this._detailTop - trackH * t;
        const x = this._detailW / 2 - Math.max(0, this.detailPadding)
            - Math.max(4, sbW) / 2 - sbW * 0.5;
        g.fillColor = this.detailScrollBarColor;
        g.roundRect(x - sbW / 2, thumbTop - thumbH, sbW, thumbH, sbW / 2);
        g.fill();
    }

    // ====================== 弹窗输入（拖拽滑动 / 滚轮 / ✕ / 关闭）======================
    /**
     * 绑定弹窗与「空白接收层」的输入。
     *
     * 🔴 为什么用「接收层 + 弹窗各挂自己的监听」而不是只靠 Canvas 的单击判定：
     *    引擎的触摸派发是**从上往下**取第一个命中的节点就**吞掉**（见 PointerEventDispatcher），
     *    弹窗打开时点在弹窗外面的那一下根本到不了 Canvas —— 所以让一个全屏透明节点
     *    （`DETAIL_BLOCKER_NAME`，兄弟序在说明卡片之后、弹窗之前）来接管「点空白」。
     *
     * 🔴🔴 **模态隔离（任务1/2 的核心）**：引擎的 UI 触摸事件在派发给「命中并吞下它」的节点之后
     *    还会**沿父链冒泡**（`NodeEventProcessor.dispatchEvent` 的 BUBBLING_PHASE，`event.bubbles = true`）。
     *    本项目大量交互挂在 **Canvas** 上（`BattleFieldPressGlow.resolveListenNode` 沿父链找 Canvas、
     *    `HandMinimize.onOutsideTouch` 也挂 Canvas、`EvoDragController` / `TargetSelectSystem` 同理），
     *    而弹窗 / 接收层都是 Canvas 的后代 ⇒ 事件**冒泡到 Canvas** 就会被那些交互当成「点在自己身上」：
     *      · 点「关闭」→ 底下的战场随从被选中；
     *      · 点 ✕ → 说明卡片被当成「点空白」而收起；
     *      · 点弹窗外 → 手牌缩略 / 别的交互照常发生。
     *    所以：弹窗与接收层的**每一个**触摸回调都在最前面写
     *    `event.propagationStopped = true` —— 引擎在 AT_TARGET 之后会检查它并**跳过整段冒泡**
     *    （见 `dispatchEvent` 的 `if (!event.propagationStopped && event.bubbles)`），
     *    于是「关闭弹窗」这件事只属于弹窗自己，底下的东西一个都收不到。
     */
    private bindDetailInput(): void {
        const blocker = this._detailBlocker;
        if (blocker && !(blocker as unknown as { _tipBound?: boolean })._tipBound) {
            (blocker as unknown as { _tipBound?: boolean })._tipBound = true;
            // 🔴 必须在 TOUCH_START 就截住：接收层「命中即吞下」会让它成为本次触摸的 claimer，
            //    但**冒泡**仍会把 START 送到 Canvas —— 不截住的话底下的按压/手牌缩略照样触发。
            blocker.on(Node.EventType.TOUCH_START, this._onBlockerDown, this);
            blocker.on(Node.EventType.TOUCH_MOVE, this._swallowDetailTouch, this);
            blocker.on(Node.EventType.TOUCH_END, this._onBlockerUp, this);
            blocker.on(Node.EventType.TOUCH_CANCEL, this._swallowDetailTouch, this);
        }
        const panel = this._detail;
        if (panel && !(panel as unknown as { _tipBound?: boolean })._tipBound) {
            (panel as unknown as { _tipBound?: boolean })._tipBound = true;
            panel.on(Node.EventType.TOUCH_START, this._onDetailDown, this);
            panel.on(Node.EventType.TOUCH_MOVE, this._onDetailMove, this);
            panel.on(Node.EventType.TOUCH_END, this._onDetailUp, this);
            panel.on(Node.EventType.TOUCH_CANCEL, this._onDetailUp, this);
            panel.on(Node.EventType.MOUSE_WHEEL, this._onDetailWheel, this);
        }
    }

    /** 接收层上的 START / MOVE / CANCEL：只负责「截断冒泡」，不做别的 */
    private readonly _swallowDetailTouch = (e: EventTouch): void => {
        if (this._detailOpen) e.propagationStopped = true;
    };

    /** 接收层按下：截断冒泡（不让底下的按压 / 手牌缩略收到） */
    private readonly _onBlockerDown = (e: EventTouch): void => {
        e.propagationStopped = true;
    };

    /** 点在弹窗**外面**（接收层覆盖全屏）→ 关弹窗；并**吞掉整个手势** */
    private readonly _onBlockerUp = (e: EventTouch): void => {
        e.propagationStopped = true;
        if (!this._detailOpen) return;
        if (this.detailCloseOnOutside) this.closeDetail();
    };

    /** 把 UI 坐标转成**弹窗本地坐标**（锚点 0.5/0.5） */
    private detailLocalOf(ui: Vec2 | Vec3, out: Vec3): Vec3 {
        const world = this.uiToWorld(ui, _worldScratch);
        const ut = this._detail ? this._detail.getComponent(UITransform) : null;
        if (!ut) { Vec3.set(out, 0, 0, 0); return out; }
        return ut.convertToNodeSpaceAR(world, out);
    }

    private readonly _onDetailDown = (e: EventTouch): void => {
        // 🔴 模态隔离：见 bindDetailInput 的注释（不冒泡到 Canvas）
        e.propagationStopped = true;
        if (!this._detailOpen) return;
        const ui = e.getUILocation();
        this._dragId = e.getID();
        this._dragFromY = ui.y;
        this._dragMoved = false;
        this._dragStartScrollY = this._detailScrollY;
        // 按下即刹停：惯性 / 回弹一律让位给手指
        this._detailScrollVel = 0;
        this._detailSpring.active = false;
        this._detailLastMoveY = ui.y;
        this._detailLastMoveMs = Date.now();
        this._detailPendingDy = 0;
        const local = this.detailLocalOf(ui, _outScratch);
        const btn = this._detailButtonRect;
        this._detailButtonDown = !!btn && local.x >= btn.x && local.x <= btn.x + btn.w
            && local.y >= btn.y && local.y <= btn.y + btn.h;
        if (this._detailButtonDown) this.pressDetailButton(true);
    };

    private readonly _onDetailMove = (e: EventTouch): void => {
        e.propagationStopped = true;
        if (!this._detailOpen || this._dragId < 0 || e.getID() !== this._dragId) return;
        const ui = e.getUILocation();
        const rawDy = ui.y - this._dragFromY;
        if (Math.abs(rawDy) > CLICK_SLOP) this._dragMoved = true;
        const k = Math.max(0.05, this.detailDragScale) * (this.detailDragInvert ? -1 : 1);
        // 松手惯性用：累计位移 ÷ 真实耗时（见 `_detailPendingDy` 注释）
        this._detailPendingDy += (ui.y - this._detailLastMoveY) * k;
        this._detailLastMoveY = ui.y;
        const now = Date.now();
        const dt = (now - this._detailLastMoveMs) / 1000;
        if (dt > 0.008) {
            this._detailScrollVel = this._detailPendingDy / dt;
            this._detailPendingDy = 0;
            this._detailLastMoveMs = now;
        }
        // 🔴 越界部分经过**阻尼衰减**（越往外越拉不动）→ 内容跟着手指走时的手感在界外会变"重"
        this.applyDetailScroll(this.rubber(this._dragStartScrollY + rawDy * k));
        this.updateDetailScrollBar();
        if (this._detailButtonDown) {
            // 拖动途中离开按钮 → 取消按下反馈与点击语义
            const local = this.detailLocalOf(ui, _outScratch);
            const btn = this._detailButtonRect;
            const inside = !!btn && local.x >= btn.x && local.x <= btn.x + btn.w
                && local.y >= btn.y && local.y <= btn.y + btn.h;
            if (!inside) { this._detailButtonDown = false; this.pressDetailButton(false); }
        }
    };

    private readonly _onDetailUp = (e: EventTouch): void => {
        e.propagationStopped = true;
        if (!this._detailOpen) { this._dragId = -1; return; }
        const wasDrag = this._dragId >= 0 && e.getID() === this._dragId;
        const moved = this._dragMoved;
        this._dragId = -1;
        this._dragMoved = false;
        const pressed = this._detailButtonDown;
        this._detailButtonDown = false;
        this.pressDetailButton(false);
        if (!wasDrag) return;

        const local = this.detailLocalOf(e.getUILocation(), _outScratch);
        // ① 底部「关闭」按钮（按下与抬起都在按钮内才算点它）
        if (pressed) {
            const btn = this._detailButtonRect;
            if (btn && local.x >= btn.x && local.x <= btn.x + btn.w
                && local.y >= btn.y && local.y <= btn.y + btn.h) {
                this.closeDetail();
                return;
            }
        }
        // ② 右上角 ✕（滑动之后松手不算点它）
        const hitMark = !moved && !!this._detailCloseRect
            && local.x >= this._detailCloseRect.x && local.x <= this._detailCloseRect.x + this._detailCloseRect.w
            && local.y >= this._detailCloseRect.y && local.y <= this._detailCloseRect.y + this._detailCloseRect.h;
        if (hitMark) { this.closeDetail(); return; }

        // ③ 松手：越界 → 弹簧回弹；界内 → 惯性滑行（任务5）
        const max = this._detailScrollMax;
        const now = Date.now();
        const gapMs = now - this._detailLastMoveMs;
        // 收尾：把最后一个采样窗口里的位移折进速度（否则「最后一次移动后立刻松手」会丢掉这一截）
        if (Math.abs(this._detailPendingDy) > 0.5 && gapMs > 8) {
            this._detailScrollVel = this._detailPendingDy / (gapMs / 1000);
            this._detailPendingDy = 0;
            this._detailLastMoveMs = now;
        }
        // 🔴「停住再松手」判据用**更宽松的窗口**（250ms）：低帧率环境（软件渲染 / 重负载）下
        //    两次移动之间本来就可能隔上百毫秒，用 120ms 会把正常的甩动误判成「停住」而清掉惯性。
        if (Date.now() - this._detailLastMoveMs > 250) this._detailScrollVel = 0;
        if (this._detailScrollY < 0) this.startDetailSpring(0);
        else if (this._detailScrollY > max) this.startDetailSpring(max);
        else if (Math.abs(this._detailScrollVel) <= Math.max(0, this.detailInertiaMinSpeed)) this._detailScrollVel = 0;
        this.updateDetailScrollBar();
    };

    /**
     * 滚轮：一格滚 `detailWheelStep` px。
     * 滚到顶 / 底再继续滚 → 同样按橡皮筋压出去一点、松手（无后续事件）由 `tickDetail` 弹回来。
     */
    private readonly _onDetailWheel = (e: EventMouse): void => {
        if (!this._detailOpen) return;
        const step = Math.max(1, this.detailWheelStep);
        // getScrollY() > 0 = 向上滚 → 往内容更靠上的位置走（scrollY 变小）
        const raw = this._detailScrollY - e.getScrollY() * step;
        this._detailSpring.active = false;
        this._detailScrollVel = 0;
        this.applyDetailScroll(this.rubber(raw));
        // 越界 → 交给 tickDetail 弹回（不需要用户松手）
        if (this._detailOverscroll > 0.5) {
            this.startDetailSpring(this._detailScrollY < 0 ? 0 : this._detailScrollMax);
        }
        this.updateDetailScrollBar();
    };

    /** 「关闭」按钮的按下反馈（纯 UI：文字整体缩放，不进任何队列） */
    private pressDetailButton(pressed: boolean): void {
        const panel = this._detail;
        if (!panel || !panel.isValid) return;
        const node = panel.getChildByName('DetailCloseText');
        if (!node || !node.isValid) return;
        const s = pressed ? 0.94 : 1;
        node.setScale(s, s, 1);
    }

    // ====================== 节点构建 ======================
    private ensureLayerTransform(): void {
        let ut = this.node.getComponent(UITransform);
        if (!ut) ut = this.node.addComponent(UITransform);
        ut.setAnchorPoint(0.5, 0.5);
        if (ut.contentSize.width < 1 || ut.contentSize.height < 1) ut.setContentSize(1280, 720);
    }

    private ensureNodes(): void {
        // 圆环先建（渲染在下），面板后建（渲染在上）
        let ring = this.node.getChildByName(RING_NAME);
        if (!ring || !ring.isValid) {
            ring = new Node(RING_NAME);
            ring.layer = this.node.layer;
            this.node.addChild(ring);
        }
        let rut = ring.getComponent(UITransform);
        if (!rut) rut = ring.addComponent(UITransform);
        rut.setAnchorPoint(0.5, 0.5);
        let rg = ring.getComponent(Graphics);
        if (!rg) rg = ring.addComponent(Graphics);
        this._ring = ring;
        this._ringGfx = rg;

        let panel = this.node.getChildByName(PANEL_NAME);
        if (!panel || !panel.isValid) {
            panel = new Node(PANEL_NAME);
            panel.layer = this.node.layer;
            this.node.addChild(panel);
        }
        let put = panel.getComponent(UITransform);
        if (!put) put = panel.addComponent(UITransform);
        put.setAnchorPoint(0, 1);                       // 局部原点 = 面板左上角
        put.setContentSize(Math.max(120, this.tipWidth), Math.max(40, this.tipHeight));
        let pg = panel.getComponent(Graphics);
        if (!pg) pg = panel.addComponent(Graphics);
        this._panel = panel;
        this._panelGfx = pg;

        // 🔴 能力详情弹窗的两层，**兄弟序必须是**：说明卡片 → 空白接收层 → 弹窗本体。
        //    引擎按「兄弟序大的先派发」决定谁拿到触摸（见 PointerEventDispatcher._sortByPriority），
        //    所以弹窗压在最上、接收层压在说明卡片之上 ⇒ 点弹窗外一定被接收层吞掉。
        this.ensureDetailBlocker();
        this.ensureDetailPanel();
        this.bindDetailInput();
    }

    /** 全屏「点空白」接收层（透明；压在说明卡片之上、弹窗之下） */
    private ensureDetailBlocker(): void {
        let n = this.node.getChildByName(DETAIL_BLOCKER_NAME);
        if (!n || !n.isValid) {
            n = new Node(DETAIL_BLOCKER_NAME);
            n.layer = this.node.layer;
            this.node.addChild(n);
        }
        const ut = n.getComponent(UITransform) || n.addComponent(UITransform);
        ut.setAnchorPoint(0.5, 0.5);
        const layerUT = this.node.getComponent(UITransform);
        const w = layerUT ? Math.max(1280, layerUT.contentSize.width) : 1280;
        const h = layerUT ? Math.max(720, layerUT.contentSize.height) : 720;
        ut.setContentSize(w, h);
        n.active = false;                                // 只在弹窗打开时激活
        this._detailBlocker = n;
        this.centerOnScreen(n);
    }

    /** 弹窗本体（锚点 0.5/0.5 ⇒ 摆到**屏幕正中**） */
    private ensureDetailPanel(): void {
        let n = this.node.getChildByName(DETAIL_NAME);
        if (!n || !n.isValid) {
            n = new Node(DETAIL_NAME);
            n.layer = this.node.layer;
            this.node.addChild(n);
        }
        const ut = n.getComponent(UITransform) || n.addComponent(UITransform);
        ut.setAnchorPoint(0.5, 0.5);
        ut.setContentSize(Math.max(240, this.detailWidth), Math.max(160, this.detailHeight));
        const g = n.getComponent(Graphics) || n.addComponent(Graphics);
        n.active = false;
        this._detail = n;
        this._detailGfx = g;
        this.centerOnScreen(n);
    }

    /**
     * 把某个节点摆到**屏幕正中**。
     *
     * 🔴 不能简单写 `setPosition(0,0)` —— 本组件的宿主 `CardTipLayer` 在场景里**不在屏幕中心**
     *    （说明卡片本来就显示在左上角那种位置），所以「本节点局部 (0,0)」≠「屏幕正中」。
     *    这里用 Canvas 的中心（Canvas 锚点 0.5/0.5 ⇒ 它的世界原点就是可视区正中）反算到本节点局部坐标。
     */
    private centerOnScreen(n: Node): void {
        const layerUT = this.node.getComponent(UITransform);
        const canvas = this.findCanvas(this.node);
        const cut = canvas ? canvas.getComponent(UITransform) : null;
        if (!layerUT || !cut) { n.setPosition(0, 0, 0); return; }
        const worldCenter = cut.convertToWorldSpaceAR(new Vec3(0, 0, 0));
        const local = layerUT.convertToNodeSpaceAR(worldCenter, _outScratch);
        n.setPosition(local.x, local.y, 0);
    }

    // ====================== 场景查询 ======================
    private findCanvas(node: Node): Node | null {
        let n: Node | null = node;
        while (n) {
            if (n.getComponent(Canvas)) return n;
            n = n.parent;
        }
        return null;
    }

    private findByName(name: string): Node | null {
        const scene = this.node.scene as unknown as Node | null;
        if (!scene) return null;
        const stack: Node[] = [...scene.children];
        while (stack.length) {
            const cur = stack.shift() as Node;
            if (cur.name === name) return cur;
            for (const c of cur.children) stack.push(c);
        }
        return null;
    }

    /** 我方手牌区节点（HandLayout / HandDrag 所在的那个节点） */
    private handNode(): Node | null {
        if (this._handNode && this._handNode.isValid) return this._handNode;
        this._handNode = this.findByName('PlayerHandArea');
        return this._handNode;
    }

    /** 某个节点所在的战场（沿父链找 BattleFieldLayout；战场卡必在战场节点之下） */
    private fieldOf(node: Node): BattleFieldLayout | null {
        let n: Node | null = node.parent;
        while (n) {
            const f = n.getComponent(BattleFieldLayout);
            if (f) return f;
            n = n.parent;
        }
        return null;
    }

    private allComps(className: string): Component[] {
        const scene = this.node.scene as unknown as Node | null;
        if (!scene) return [];
        const out: Component[] = [];
        const stack: Node[] = [...scene.children];
        while (stack.length) {
            const cur = stack.shift() as Node;
            const cs = cur.getComponents(className);
            if (cs) for (const c of cs) out.push(c);
            for (const ch of cur.children) stack.push(ch);
        }
        return out;
    }

    private comp(className: string): Component | null {
        const scene = this.node.scene as unknown as Node | null;
        if (!scene) return null;
        const stack: Node[] = [...scene.children];
        while (stack.length) {
            const cur = stack.shift() as Node;
            const c = cur.getComponent(className);
            if (c) return c;
            for (const ch of cur.children) stack.push(ch);
        }
        return null;
    }

    /** 刷新复用的场景组件引用（每次点击 / 显示时调一次，不在 update 里刷） */
    private refreshContext(): void {
        if (!this._handMin || !this._handMin.isValid) this._handMin = this.comp('HandMinimize') as HandMinimize | null;
        if (!this._targetSel || !this._targetSel.isValid) this._targetSel = this.comp('TargetSelectSystem') as TargetSelectSystem | null;
        if (!this._crestSys || !this._crestSys.isValid) this._crestSys = this.comp('CrestSystem') as CrestSystem | null;
    }

    private crestIdsOf(side: 'player' | 'enemy'): string[] {
        const cs = this._crestSys;
        if (!cs || !cs.isValid) return [];
        try { return cs.crestsOf(side) || []; } catch (e) { return []; }
    }

    /** 取某个纹章槽位当前显示的图标贴图（复用纹章区已经放好的那张，不再重复加载资源） */
    private slotIconFrame(slot: Node): SpriteFrame | null {
        const icon = slot.getChildByName('CrestIcon');
        const img = icon ? icon.getChildByName('CrestIconImg') : null;
        const sp = img ? img.getComponent(Sprite) : null;
        return sp && sp.spriteFrame ? sp.spriteFrame : null;
    }

    /** 按纹章 id 找它此刻显示在哪（用于卡牌下方的纹章子框取图标） */
    private crestIconOf(id: string): SpriteFrame | null {
        const key = canonTipId(id);
        if (!key) return null;
        const areas = this.allComps('CrestArea') as CrestArea[];
        for (const area of areas) {
            if (!area || !area.isValid) continue;
            const side = area.side === CrestSide.Player ? 'player' : 'enemy';
            const ids = this.crestIdsOf(side);
            for (let i = 0; i < area.slotCount; i++) {
                if (canonTipId(ids[i] || '') !== canonTipId(key)) continue;
                const slot = area.getSlot(i);
                const sf = slot ? this.slotIconFrame(slot) : null;
                if (sf) return sf;
            }
        }
        return null;
    }

    /** 已经知道是哪个节点时，反推它对应的说明目标 */
    private pickOfNode(node: Node): TipPick | null {
        if (!node || !node.isValid) return null;
        this.refreshContext();
        // 纹章
        let p: Node | null = node;
        while (p) {
            if (/^Crest_\d+$/.test(p.name)) {
                const area = p.parent ? p.parent.getComponent(CrestArea) : null;
                if (!area) return null;
                const m = /^Crest_(\d+)$/.exec(p.name);
                const idx = m ? parseInt(m[1], 10) : -1;
                const side = area.side === CrestSide.Player ? 'player' : 'enemy';
                const id = this.crestIdsOf(side)[idx] || '';
                if (!id || !area.hasSlotIcon(idx)) return null;
                return { kind: 'crest', node: p, id, area, slotIndex: idx };
            }
            if (p.parent && p.parent.getComponent(Canvas)) break;
            p = p.parent;
        }
        // 手牌
        if (/^Card_/.test(node.name)) {
            const id = handCardId(node);
            return id ? { kind: 'hand', node, id } : null;
        }
        // 战场
        const id = cardIdFromNodeName(node.name);
        return id ? { kind: 'card', node, id } : null;
    }
}

// ============================================================================
// 工具
// ============================================================================

const _pointPreview = new Vec2();

/** 手牌卡牌节点名 → 卡牌 id（`Card_4.png` / `Card_2.png_2` → `4.png` / `2.png`） */
function handCardId(node: Node): string {
    const m = /^Card_(.+?)(?:_\d+)?$/.exec(node.name);
    return m ? m[1] : '';
}

function clamp01(v: number): number {
    if (!isFinite(v)) return 0;
    return v < 0 ? 0 : (v > 1 ? 1 : v);
}

function clamp(v: number, lo: number, hi: number): number {
    if (!isFinite(v)) return lo;
    return v < lo ? lo : (v > hi ? hi : v);
}

/** Color → `rrggbb`（富文本标签用） */
function hex(c: Color): string {
    const f = (v: number): string => {
        const n = Math.max(0, Math.min(255, Math.round(v)));
        return (n < 16 ? '0' : '') + n.toString(16);
    };
    return f(c.r) + f(c.g) + f(c.b);
}

function isPrimaryButton(event: EventTouch): boolean {
    const e = event as unknown as { getButton?: () => number };
    if (typeof e.getButton !== 'function') return true;
    return e.getButton() === 0;
}
