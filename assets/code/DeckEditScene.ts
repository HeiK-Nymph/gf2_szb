import {
    _decorator, Camera, Color, Component, director, Graphics, HorizontalTextAlignment, Label,
    Mask, Node, RichText, screen, ScrollView, UIOpacity, UITransform, Vec2, Vec3, VerticalTextAlignment, view,
} from 'cc';
import { CardMap, getCardInfo } from './CardData';
import { toCardId } from './HandLayout';
import { DeckTipKeywordLink, KEYWORD_CLICK_HANDLER } from './DeckTipKeywordLink';
import { CardTipInfo, CrestTipInfo, getCardTip, keywordDetails } from './CardTipData';
import {
    BattleSetupData, DeckSide, MAX_COPIES_PER_CARD, MAX_DECK_SIZE, countsToDeck, deckToCounts,
    getDeckBySide, getDeckEditSide, peekSetup, setDeckBySide, setPending,
} from './BattleSetup';

const { ccclass, property, menu } = _decorator;

const CARD_FACTORY = 'CardFactory';
const DRAG_LAYER = 'DeckEditDragLayer';
const DECK_VIEW = 'DeckView';
const DECK_CONTENT = 'DeckContent';
const POOL_VIEW = 'PoolView';
const POOL_CONTENT = 'PoolContent';
const TOOLTIP = 'DeckEditTooltip';
const DETAIL = 'DeckEditDetail';
const BLOCKER = 'DeckEditBlocker';
const SLOT_PREFIX = 'Slot_';
const POOL_PREFIX = 'PoolCard_';

/** 拖拽判定的位移阈值（px） */
const DRAG_THRESHOLD = 10;

/** 一次「按下 → 拖动 / 点击」的状态（卡牌自己 与 说明卡拦截层 共用同一套逻辑） */
type Press = {
    node: Node; id: string; from: 'pool' | 'deck';
    start: Vec3; moved: boolean; armed: boolean;
};

/** 说明卡打开时的全局触摸跟踪。
 *
 * 说明卡不再用全屏 blocker 抢走卡组 / 卡池 ScrollView 的触摸；
 * 这里只记录是否发生了拖动，用于「点空关闭、滑动不关闭」。
 */
type TooltipTouch = {
    start: Vec2; moved: boolean; target: 'tooltip' | 'detail' | 'detailMask' | 'other';
};

// ===========================================================================
//  参考坐标系（= 例图的 1280×720，y **自上而下**）
//  ---------------------------------------------------------------------------
//  例图逐带实测（1280×720 下的像素高度，行剖面 + 边缘检测量出）：
//    ① 标题栏   0 …  84   h= 84   11.67%
//    ② 控制区  84 … 210   h=126   17.50%
//    ③ 卡组区 210 … 394   h=184   25.56%
//    ④ 分隔带 394 … 404   h= 10    1.39%
//    ⑤ 卡池区 404 … 646   h=242   33.61%
//    ⑥ 底  栏 646 … 720   h= 74   10.28%
//
//  🔴 2026-09-27 需求变更：底栏里的东西（页码 / 持有卡牌·制作模式 / 搜索卡牌 / 两个筛选）**全部删除**
//     ⇒ 底栏整条去掉，**卡池区向下延伸到画面底**（404…720，h=316），多出来的高度用来**放大卡池卡牌**，
//     这样画面仍然铺满、底部不留空白。
//  下面所有布局常量都用这套坐标书写，运行时按「实际可见区」换算，
//  因此无论视口是 16:9（1280×720）还是预览窗口（更扁/更宽）都严格贴边填满。
// ===========================================================================
const REF_W = 1280;
const REF_H = 720;
const BAND_TITLE = { t: 0, b: 84 };
const BAND_CTRL = { t: 84, b: 210 };
const BAND_DECK = { t: 210, b: 394 };
const BAND_DIV = { t: 394, b: 404 };
const BAND_POOL = { t: 404, b: 720 };

/** 面板左右边距（例图：面板 20 … 1260，宽 1240 = 96.875% 画面宽） */
const PANEL_L = 20;
const PANEL_R = 1260;
const PANEL_W = PANEL_R - PANEL_L;

/** 卡组槽位（例图实测：节距 125.4、空槽 94×131、行内实卡宽 ≈118） */
const SLOT_PITCH = 125.4;
const SLOT_W = 94;
const SLOT_H = 131;
const DECK_CARD_W = 118;
/** 卡池卡牌：底栏去掉后卡池区变高（316），把卡放大到 170 宽（约 6 张一屏，仍可横向滑） */
const POOL_PITCH = 192;
const POOL_CARD_W = 170;
/** CardComposer 拼出来的卡节点基准宽度（204×252） */
const CARD_BASE_W = 204;
const CARD_BASE_H = 252;

// 各带底色（自例图采样）
const C_TITLE_TOP = new Color(58, 116, 152, 255);
const C_TITLE_BOT = new Color(34, 72, 100, 255);
const C_TITLE_LINE = new Color(88, 164, 196, 255);
const C_CTRL_L = new Color(20, 36, 50, 255);
const C_CTRL_R = new Color(33, 78, 102, 255);
const C_DECK_L = new Color(38, 50, 64, 255);
const C_DECK_R = new Color(47, 63, 78, 255);
const C_POOL_TOP = new Color(69, 126, 178, 255);
const C_POOL_BOT = new Color(32, 62, 88, 255);
const C_SLOT_FILL = new Color(35, 51, 70, 255);
const C_SLOT_LINE = new Color(108, 140, 166, 255);
const C_SLOT_INNER = new Color(58, 84, 108, 255);
const C_GOLD = new Color(206, 178, 112, 255);
const C_GOLD_DIM = new Color(120, 104, 68, 255);
const C_BTN_DARK = new Color(24, 40, 50, 255);
const C_CYAN_L = new Color(30, 151, 189, 255);
const C_CYAN_R = new Color(120, 190, 216, 255);
const C_WHITE = new Color(255, 255, 255, 255);

/** 十六进制颜色（#RRGGBB，富文本只吃 RGB） */
function hex(c: Color): string {
    const h = (v: number): string => {
        const t = Math.max(0, Math.min(255, Math.round(v))).toString(16);
        return t.length >= 2 ? t : ('0' + t);
    };
    return h(c.r) + h(c.g) + h(c.b);
}

/** 线性插值颜色 */
function lerpColor(a: Color, b: Color, p: number): Color {
    return new Color(
        Math.round(a.r + (b.r - a.r) * p),
        Math.round(a.g + (b.g - a.g) * p),
        Math.round(a.b + (b.b - a.b) * p),
        Math.round(a.a + (b.a - a.a) * p));
}

/**
 * DeckEditScene —— **卡组编辑场景（我方 / 人机共用）**
 * ===========================================================================
 * 需求（对照例图 + 2026-09-27 变更）：
 *   · 画面按 5 段带铺满（标题栏 / 控制区 / 卡组区 / 分隔带 / 卡池区），**底部不留空白**；
 *   · 上方卡组栏 = **一行**，**相同卡牌只显示一个图标**（角标 ×N）；
 *   · 从下方卡池**向上扇形**按住拖动 ⇒ 拖起卡牌放入卡组；其它角度 ⇒ 当作「滑动卡牌栏」；
 *   · 从上方卡组**向下扇形**拖动 ⇒ 拿出卡牌；其它角度 ⇒ 当作「滑动卡组栏」；
 *   · 两个扇形角度都在 Cocos 里暴露（poolDragAngle / deckDragAngle）；
 *   · **点击**卡牌 ⇒ 微微放大 + 左上角说明卡片（深蓝底 + 金描边、卡名 + 费用/攻击/生命徽记、
 *     关键字高亮**可点**）；点关键字 ⇒ 弹出**能力详情**卡片；点其它地方 ⇒ 关闭；
 *   · ★ 本场景**双方牌组共用**：进场景前由主界面 `setDeckEditSide('player'|'enemy')` 指定编辑哪一侧，
 *     保存时按侧写回 `BattleSetup`（我方 / 人机各一份独立持久牌组）。
 *
 *  已删除（2026-09-27 需求）：职业 / 名字整行、两个「筛选」、搜索卡牌、页码、持有卡牌·制作模式页签、
 *  确认牌组按钮、右上角金币图标与数字、以及整条底栏。
 *
 *  坐标空间约定（重要）：
 *   · `xr/yr/sw/sh` 把「参考坐标」换算到 **DeckEditBody 局部坐标**；
 *   · 挂在 `(0,0)`、尺寸铺满的**带级 Graphics 节点**上绘制 ⇒ 可直接用 xr/yr（等价局部坐标）；
 *   · 挂在**有位移的容器**（面板 / 按钮）上的 Graphics ⇒ 只能用**局部坐标**（见 grad*Local）。
 * ===========================================================================
 */
@ccclass('DeckEditScene')
@menu('gf2szb/DeckEditScene')
export class DeckEditScene extends Component {

    // ====================== 拖动扇形角度（用户要求暴露）======================
    @property({ range: [10, 90, 1], slide: true, tooltip: '★【卡池→卡组 扇形角度】(度)：以**正上方**为中心、左右各这么多度内按住拖动才拖起卡牌；其它角度当作滑动卡牌栏。' })
    poolDragAngle = 70;

    @property({ range: [10, 90, 1], slide: true, tooltip: '★【卡组→拿出 扇形角度】(度)：以**正下方**为中心、左右各这么多度内按住拖动才拿起卡牌；其它角度当作滑动卡组栏。' })
    deckDragAngle = 70;

    // ====================== 卡面尺寸（参考坐标 = 1280×720 下的像素）======================
    @property({ range: [60, 200, 1], slide: true, tooltip: '★【卡组栏·实卡宽度】(参考像素，例图 118)：卡组槽位里那张卡的宽度；空槽框固定 94×131。' })
    deckCardWidth = DECK_CARD_W;

    @property({ range: [60, 300, 1], slide: true, tooltip: '★【卡池·卡牌宽度】(参考像素，默认 170)：卡池里的卡宽，节距 192（约 6 张一屏）。' })
    poolCardWidth = POOL_CARD_W;

    @property({ range: [0.4, 1.5, 0.01], slide: true, tooltip: '【拖拽幽灵卡缩放】拖动时跟手的那张卡相对卡池卡的倍数' })
    ghostCardScale = 1;

    @property({ range: [1, 1.5, 0.01], slide: true, tooltip: '【点击放大倍数】卡牌被点击时微微放大' })
    pressScale = 1.12;

    // ====================== 说明卡片样式（对齐战斗场景 CardTooltip）======================
    @property({ range: [200, 900, 1], slide: true, tooltip: '★【说明卡片宽度】(px)' })
    tipWidth = 460;

    @property({ range: [8, 60, 1], slide: true, tooltip: '★【说明卡片文字大小】(px)' })
    tipFontSize = 22;

    @property({ range: [0.8, 2.5, 0.01], slide: true, tooltip: '说明卡片 行高 ÷ 字号' })
    tipLineHeightRatio = 1.35;

    @property({ range: [0, 60, 1], slide: true, tooltip: '说明卡片 内容四周留白（px）' })
    tipPadding = 16;

    @property({ range: [0, 40, 1], slide: true, tooltip: '说明卡片 说明项间距（px）' })
    tipItemGap = 10;

    @property({ type: Color, tooltip: '说明卡片 面板底色（深蓝半透明）' })
    tipBgColor = new Color(18, 26, 44, 242);

    @property({ type: Color, tooltip: '说明卡片 面板描边色（金）' })
    tipBorderColor = new Color(198, 168, 108, 255);

    @property({ type: Color, tooltip: '说明卡片 卡名颜色' })
    tipTitleColor = new Color(255, 255, 255, 255);

    @property({ type: Color, tooltip: '说明卡片 正文颜色' })
    tipTextColor = new Color(208, 218, 234, 255);

    @property({ type: Color, tooltip: '★说明卡片 关键字高亮色（可点 ⇒ 弹能力详情）' })
    tipKeywordColor = new Color(255, 236, 176, 255);

    @property({ type: Color, tooltip: '费用徽记底色（绿）' })
    badgeCostColor = new Color(46, 132, 66, 255);

    @property({ type: Color, tooltip: '攻击徽记底色（蓝）' })
    badgeAttackColor = new Color(40, 92, 168, 255);

    @property({ type: Color, tooltip: '血量徽记底色（红）' })
    badgeHpColor = new Color(176, 58, 62, 255);

    @property({ type: Color, tooltip: '徽记描边色' })
    badgeRingColor = new Color(246, 236, 208, 255);

    @property({ range: [14, 48, 1], slide: true, tooltip: '徽记半径（px）' })
    badgeRadius = 26;

    // ====================== 能力详情弹窗（点关键字弹出，屏幕正中）======================
    @property({ range: [300, 1200, 1], slide: true, tooltip: '★【能力详情·宽度】(px)' })
    detailWidth = 860;

    @property({ range: [160, 640, 1], slide: true, tooltip: '★【能力详情·高度】(px)' })
    detailHeight = 430;

    @property({ range: [10, 48, 1], slide: true, tooltip: '【能力详情·标题字号】(px)' })
    detailTitleSize = 30;

    @property({ range: [10, 48, 1], slide: true, tooltip: '【能力详情·正文字号】(px)' })
    detailFontSize = 22;

    @property({ type: Color, tooltip: '能力详情 面板底色' })
    detailBgColor = new Color(16, 22, 40, 250);

    @property({ type: Color, tooltip: '能力详情 遮罩色（点击遮罩关闭）' })
    detailMaskColor = new Color(0, 0, 0, 150);

    // ====================== 其它 ======================
    @property({ type: Color, tooltip: '【屏幕底色】' })
    pageColor = new Color(14, 30, 46, 255);

    @property({ type: Color, tooltip: '【文字颜色】白色' })
    textColor = new Color(255, 255, 255, 255);

    @property({ type: Color, tooltip: '【上限提示颜色】红色' })
    limitColor = new Color(255, 72, 60, 255);

    // ------------------------------ 运行时状态 ------------------------------
    private _counts = new Map<string, number>();
    private _factory: Node | null = null;
    private _deckContent: Node | null = null;
    private _poolContent: Node | null = null;
    private _tooltip: Node | null = null;
    private _detail: Node | null = null;
    private _detailMask: Node | null = null;
    private _blocker: Node | null = null;
    private _dragLayer: Node | null = null;
    private _ghost: Node | null = null;
    private _press: Press | null = null;
    /** 说明卡打开时的全局触摸跟踪；滑动不应触发「点空关闭」。 */
    private _tooltipTouch: TooltipTouch | null = null;
    private _domCanvas: HTMLCanvasElement | null = null;
    private _domHandlers: Array<{ type: string; fn: (e: Event) => void }> = [];
    private _pressedCard: Node | null = null;
    /** 卡牌说明下方的纹章说明框（坐标相对说明卡左上锚点）。 */
    private _crestBox: { x: number; y: number; w: number; h: number } | null = null;
    private _deckSV: ScrollView | null = null;
    private _poolSV: ScrollView | null = null;
    private _overlay: Node | null = null;
    private _tipKeywords: string[] = [];
    /** 说明卡里「可点关键字」的命中节点（自己判命中，见 buildTooltip 注释） */
    private _kwHits: Array<{ keyword: string; nodes: Node[] }> = [];
    /**
     * 说明卡打开时，被全屏拦截层挡住的那批「可点卡牌」（卡池卡 + 卡组槽位卡）。
     * 拦截层的 TOUCH_END 用它判定「点到的是另一张卡」⇒ **直接切换说明卡**，
     * 而不是先关掉、要用户再点第二次（2026-09-27 用户需求）。
     */
    private _touchCards: Array<{ node: Node; id: string; from: 'pool' | 'deck' }> = [];

    // 控制区里需要随牌组数据刷新的那些
    private _totalLabel: Label | null = null;
    private _ppNums: Label[] = [];
    private _ppBars: Array<{ x: number; y: number; w: number; h: number; g: Graphics }> = [];
    private _typeNums: Label[] = [];

    // ============ 参考坐标 → 本地坐标的换算（每次构建按可见区刷新）============
    /** 可见区中心（DeckEditBody 局部坐标） */
    private _visCY = 0;
    /** 可见区高度（参考坐标单位 = 相机 2×orthoHeight） */
    private _visH = REF_H;
    /** 可见区宽度（参考坐标单位；视口比 16:9 宽时会更大） */
    private _visW = REF_W;
    /** 纵向比例（参考单位 → 本地单位） */
    private _ky = 1;
    /** 横向比例：把例图 1240 宽的面板铺满可见宽度 */
    private _kx = 1;

    /** ★ 本次在编辑哪一侧牌组（主界面进场景前指定，默认我方） */
    private _side: DeckSide = 'player';

    onLoad(): void {
        this._side = getDeckEditSide();
        const entries = getDeckBySide(this._side);
        this._counts = this.normalizeCounts(deckToCounts(entries));
        console.log(`[DeckEditScene] 编辑${this._side === 'enemy' ? '人机' : '我方'}牌组，`
            + `载入 ${this._counts.size} 种 / ${this.deckSize()} 张`);
        this.build();
    }

    onDestroy(): void {
        if (this._domCanvas) {
            for (const h of this._domHandlers) this._domCanvas.removeEventListener(h.type, h.fn, true);
        }
        this._domHandlers.length = 0;
        this._domCanvas = null;
    }

    // ======================================================================
    //  可见区换算
    // ======================================================================
    /**
     * 计算「实际可见区」在本节点（DeckEditBody）局部坐标里的位置与尺寸。
     * 相机 orthoHeight=360 ⇒ 纵向可见 720 参考单位；
     * 横向可见宽度 = 720 × 视口宽高比。这样排版在任何视口下都**恰好铺满**，底部不会留空白。
     */
    private measureViewport(): void {
        let visH = REF_H;
        let camY = 0;
        let canvasY = 0;
        let ar = REF_W / REF_H;
        try {
            let fw = 0, fh = 0;
            const ws = screen && screen.windowSize;
            if (ws && ws.width > 0 && ws.height > 0) { fw = ws.width; fh = ws.height; }
            if (!fw) {
                const fr = view.getFrameSize();
                if (fr && fr.width > 0 && fr.height > 0) { fw = fr.width; fh = fr.height; }
            }
            if (fw > 0 && fh > 0) ar = fw / fh;
            const cam = this.findCamera();
            if (cam) {
                visH = Math.max(200, cam.orthoHeight * 2);
                camY = cam.node.worldPosition.y;
            }
            const cv = this.canvasNode();
            if (cv) canvasY = cv.worldPosition.y;
        } catch (e) { /* 兜底用 1280×720 */ }
        this._visH = visH;
        this._visCY = camY - canvasY;
        this._visW = visH * ar;
        this._ky = visH / REF_H;
        // 横向：例图的面板占画面宽 96.875%；按可见宽度铺满（并夹住极端比例）
        const want = this._visW / REF_W;
        this._kx = Math.max(this._ky * 0.85, Math.min(this._ky * 1.3, want));
    }

    /** 参考 x（0…1280，640 = 中心）→ 本地 x（DeckEditBody 局部坐标） */
    private xr(x: number): number { return (x - REF_W / 2) * this._kx; }
    /** 参考 y（0 = 画面顶，720 = 画面底）→ 本地 y（DeckEditBody 自身居中于可见区 ⇒ 不带 _visCY） */
    private yr(y: number): number { return this._visH / 2 - y * this._ky; }
    /** 参考宽度 → 本地宽度 */
    private sw(w: number): number { return w * this._kx; }
    /** 参考高度 → 本地高度 */
    private sh(h: number): number { return h * this._ky; }
    /** 参考矩形 → 本地「中心点 + 尺寸」 */
    private box(l: number, t: number, w: number, h: number): { x: number; y: number; w: number; h: number } {
        return { x: this.xr(l + w / 2), y: this.yr(t + h / 2), w: this.sw(w), h: this.sh(h) };
    }

    // ======================================================================
    //  构建
    // ======================================================================
    private build(): void {
        this.measureViewport();
        const W = this._visW, H = this._visH;
        const root = this.makeNode('DeckEditBody', this.node, 0, this._visCY, W, H);
        // 底：多铺一点，任何视口都不露边
        const bg = this.makeNode('Bg', root, 0, 0, W + 80, H + 80);
        this.fillRect(bg, this.pageColor);

        this.buildTitleBar(root);
        this.buildControlBar(root);
        this.buildDeckArea(root);
        this.buildDivider(root);
        this.buildPoolArea(root);

        // 弹窗层放在所有带之上；层内固定顺序：Blocker(0) → Tooltip(1) → DetailMask(2) → Detail(3)。
        //
        // 说明卡打开时不能再让全屏 blocker 抢走卡组 / 卡池 ScrollView 的触摸：
        // ScrollView 只有收到完整的 START → MOVE → END，才会自己处理阻尼、回弹与惯性。
        // 因此 blocker 保留为调试节点但始终 inactive，改由 DeckEditBody 的冒泡事件
        // 记录「滑动不关闭、点空关闭」。卡牌自身的 TOUCH_* 则继续负责切换说明 / 拖牌。
        this._overlay = this.makeNode('Overlay', root, 0, 0, W, H);
        this.buildTooltip(this._overlay);
        this.buildDetail(this._overlay);
        this._blocker = this.makeNode(BLOCKER, this._overlay, 0, 0, W, H);
        this._blocker.active = false;
        // 关闭判定走 canvas 的捕获监听，不向 Cocos 分区节点挂监听，
        // 避免分区节点抢走卡牌 / ScrollView 的命中目标。
        this.bindTooltipDom();
        if (this._tooltip) this._tooltip.setSiblingIndex(1);
        if (this._detailMask) this._detailMask.setSiblingIndex(2);
        if (this._detail) this._detail.setSiblingIndex(3);


        this._dragLayer = this.makeNode(DRAG_LAYER, root, 0, 0, W, H);
        this.refresh();
    }

    /** 带级 Graphics 节点（挂在 (0,0)、铺满整屏 ⇒ 其局部坐标 = 参考坐标经 xr/yr 换算后的坐标） */
    private bandLayer(root: Node, name: string): Graphics {
        const n = this.makeNode(name, root, 0, 0, this._visW, this._visH);
        return n.addComponent(Graphics);
    }

    // ----------------------------------------------------------------------
    //  ① 标题栏（参考 y 0…84）—— 已删「右上角金币图标 + 数字」
    // ----------------------------------------------------------------------
    private buildTitleBar(root: Node): void {
        const T = BAND_TITLE.t, B = BAND_TITLE.b;
        const n = this.makeNode('TitleBar', root, 0, 0, this._visW, this._visH);
        const g = n.addComponent(Graphics);
        this.gradVRef(g, 0, T, REF_W, B - T, C_TITLE_TOP, C_TITLE_BOT, 18);
        this.rectRef(g, 0, B - 1.6, REF_W, 1.6, C_TITLE_LINE);
        this.rectRef(g, 0, B, REF_W, 2.4, new Color(14, 30, 46, 190));

        // 返回箭头（只占它自己那一小块，避免全屏吞掉卡牌触摸）
        const backArea = this.box(30, 26, 72, 52);
        const back = this.makeNode('Back', n, backArea.x, backArea.y, backArea.w, backArea.h);
        const gb = back.addComponent(Graphics);
        this.chevron(gb, 0, 0, this.sw(11), this.sh(16), C_GOLD);
        back.on(Node.EventType.TOUCH_END, () => this.back(), this);

        // 标题（按编辑哪一侧显示）
        const sideTxt = this._side === 'enemy' ? '人机牌组编辑' : '我方牌组编辑';
        this.labelLeft(n, 'Title', sideTxt, 34, this.textColor, 100, 24, 420, 56);
    }

    // ----------------------------------------------------------------------
    //  ② 控制区（参考 y 84…210，h=126）
    //    已删「职业 / 名字」整行、「确认牌组」、「筛选」
    //    ⇒ 左半只剩三个功能按钮（带内垂直居中），右半是 PP 费用曲线 + 兵种统计 + n/40。
    // ----------------------------------------------------------------------
    private buildControlBar(root: Node): void {
        const T = BAND_CTRL.t, B = BAND_CTRL.b;
        const n = this.makeNode('ControlBar', root, 0, 0, this._visW, this._visH);
        const g = n.addComponent(Graphics);
        this.gradHRef(g, 0, T, REF_W, B - T, C_CTRL_L, C_CTRL_R, 20);
        this.rectRef(g, 0, B - 2, REF_W, 2, new Color(10, 24, 36, 180));

        // ---------- 左：三个功能按钮（带内垂直居中）----------
        const yB = (T + B) / 2, bh = 35;
        this.goldButton(n, '保存', 15, yB - bh / 2, 160, bh, true, () => this.saveAndBack());
        this.goldButton(n, '清空卡组', 207, yB - bh / 2, 157, bh, false, () => {
            this._counts.clear(); this.refresh();
        });
        this.goldButton(n, '自动编辑', 395, yB - bh / 2, 161, bh, false, () => this.autoEdit());

        // ---------- 右簇：PP 费用曲线 / 兵种统计 / n/40 ----------
        this._ppNums = [];
        this._ppBars = [];
        const ppX0 = 589, ppStep = 45;
        for (let i = 0; i < 8; i++) {
            const cx = ppX0 + ppStep * i;
            const nl = this.makeLabel('PPNum' + (i + 1), n, '0', 24, this.textColor,
                this.xr(cx), this.yr(100), this.sw(40), this.sh(28), HorizontalTextAlignment.CENTER);
            this._ppNums.push(nl);
            const bar = this.box(cx - 9, 110, 18, 48);
            this.roundRectLocal(g, bar.x - bar.w / 2, bar.y - bar.h / 2, bar.w, bar.h, this.sw(3),
                new Color(30, 52, 33, 255), new Color(58, 108, 68, 255), this.sw(1.6));
            this._ppBars.push({ x: bar.x, y: bar.y, w: bar.w, h: bar.h, g });
            const dot = this.makeNode('PPDot' + (i + 1), n, this.xr(cx), this.yr(188), this.sw(30), this.sh(30));
            const gd = dot.addComponent(Graphics);
            gd.fillColor = new Color(46, 116, 58, 255);
            gd.circle(0, 0, this.sw(11)); gd.fill();
            gd.lineWidth = this.sw(1.6); gd.strokeColor = new Color(180, 232, 170, 255);
            gd.circle(0, 0, this.sw(11)); gd.stroke();
            this.makeLabel('PPCnt' + (i + 1), dot, String(i + 1), 16, this.textColor,
                0, 0, this.sw(24), this.sh(22), HorizontalTextAlignment.CENTER);
        }

        const rows: Array<[string, number, Color]> = [
            ['随从', 150, new Color(236, 128, 148, 255)],
            ['法术', 175, new Color(190, 152, 232, 255)],
            ['护符', 200, new Color(120, 220, 160, 255)],
        ];
        this._typeNums = [];
        for (const [txt, yy, col] of rows) {
            this.labelRight(n, 'TypeName_' + txt, txt, 21, col, 1010, yy - 13, 56, 26);
            this._typeNums.push(this.labelRight(n, 'TypeNum_' + txt, '0', 21, col, 1086, yy - 13, 54, 26));
        }

        const bk = this.makeNode('Book', n, this.xr(1120), this.yr(115), this.sw(30), this.sh(28));
        this.drawBook(bk.addComponent(Graphics), this.sw(13), this.sh(11));
        this._totalLabel = this.labelRight(n, 'Total', '0/40', 34, this.textColor, 1244, 95, 120, 34);
    }

    // ----------------------------------------------------------------------
    //  ③ 卡组区（参考 y 210…394，h=184）
    // ----------------------------------------------------------------------
    private buildDeckArea(root: Node): void {
        const T = BAND_DECK.t, B = BAND_DECK.b;
        const panel = this.makeNode('DeckPanel', root, 0, this.yr((T + B) / 2), this.sw(PANEL_W), this.sh(B - T));
        const g = panel.addComponent(Graphics);
        this.gradHLocal(g, -this.sw(PANEL_W) / 2, -this.sh(B - T) / 2, this.sw(PANEL_W), this.sh(B - T), C_DECK_L, C_DECK_R, 18);

        const viewH = this.sh(160);
        // 例图：10 个槽位共占 9×125.4+94 = 1222.6，面板 1240 ⇒ 可视宽取 1232 才能整 10 格
        const viewW = this.sw(PANEL_W - 8);
        const view = this.makeNode(DECK_VIEW, panel, 0, 0, viewW, viewH);
        view.addComponent(Mask);
        const pad = 6;
        // 内容按「最多 40 格」初始化，重建时再按实际种类数收紧（见 rebuildDeckSlots）
        const contentW = Math.max(viewW, this.sw(pad * 2 + MAX_DECK_SIZE * SLOT_PITCH));
        const content = this.makeNode(DECK_CONTENT, view, 0, 0, contentW, viewH);
        const cut = content.getComponent(UITransform)!;
        cut.setAnchorPoint(0.5, 0.5);
        cut.setContentSize(contentW, viewH);
        try {
            const sv = view.addComponent(ScrollView);
            sv.content = content;
            sv.horizontal = true;
            sv.vertical = false;
            sv.inertia = true;
            sv.brake = 0.75;
            sv.cancelInnerEvents = false;      // 卡牌拖牌需要保留子节点触摸；横滑判定后再让 ScrollView 取消子事件
            sv.scrollToLeft(0);
            this._deckSV = sv;
        } catch (e) { console.error('[DeckEditScene] 卡组栏 ScrollView 失败：', e); }
        this._deckContent = content;
    }

    // ----------------------------------------------------------------------
    //  ④ 分隔带（参考 y 394…404）
    // ----------------------------------------------------------------------
    private buildDivider(root: Node): void {
        const T = BAND_DIV.t, B = BAND_DIV.b;
        const g = this.bandLayer(root, 'Divider');
        this.rectRef(g, 0, T, REF_W, B - T, new Color(22, 42, 60, 255));
        this.rectRef(g, PANEL_L, T + 1, PANEL_W, 1.8, new Color(74, 138, 172, 255));
        this.rectRef(g, PANEL_L, B - 1.4, PANEL_W, 1.4, new Color(16, 34, 50, 210));
    }

    // ----------------------------------------------------------------------
    //  ⑤ 卡池区（参考 y 404…720，h=316 —— 底栏已去掉，卡池区延伸到画面底）
    // ----------------------------------------------------------------------
    private buildPoolArea(root: Node): void {
        const T = BAND_POOL.t, B = BAND_POOL.b;
        const panel = this.makeNode('PoolPanel', root, 0, this.yr((T + B) / 2), this.sw(PANEL_W), this.sh(B - T));
        const g = panel.addComponent(Graphics);
        const pw = this.sw(PANEL_W), ph = this.sh(B - T);
        this.gradVLocal(g, -pw / 2, -ph / 2, pw, ph, C_POOL_BOT, C_POOL_TOP, 26);
        // 水印（两个很淡的大圆环，模拟例图背景纹样）
        g.lineWidth = this.sw(2);
        g.strokeColor = new Color(255, 255, 255, 18);
        g.circle(-this.sw(430), -this.sh(10), this.sw(150)); g.stroke();
        g.circle(this.sw(300), this.sh(50), this.sw(190)); g.stroke();
        // 左右滚动箭头（与卡牌中线对齐）
        const arrowY = -this.sh(6);
        this.chevronLeft(g, -pw / 2 + this.sw(30), arrowY, this.sw(16), this.sh(26), C_GOLD);
        this.chevronRight(g, pw / 2 - this.sw(30), arrowY, this.sw(16), this.sh(26), C_GOLD);

        const viewH = this.sh(B - T - 26);
        const viewW = this.sw(PANEL_W - 76);
        const view = this.makeNode(POOL_VIEW, panel, 0, -this.sh(6), viewW, viewH);
        view.addComponent(Mask);
        const ids = Object.keys(CardMap);
        const contentW = Math.max(viewW, this.sw(4 + ids.length * POOL_PITCH));
        const content = this.makeNode(POOL_CONTENT, view, 0, 0, contentW, viewH);
        const cut = content.getComponent(UITransform)!;
        cut.setAnchorPoint(0.5, 0.5);
        cut.setContentSize(contentW, viewH);
        try {
            const sv = view.addComponent(ScrollView);
            sv.content = content;
            sv.horizontal = true;
            sv.vertical = false;
            sv.inertia = true;
            sv.brake = 0.75;
            sv.cancelInnerEvents = false;      // 卡牌拖牌需要保留子节点触摸；横滑判定后再让 ScrollView 取消子事件
            sv.scrollToLeft(0);
            this._poolSV = sv;
        } catch (e) { console.error('[DeckEditScene] 卡池栏 ScrollView 失败：', e); }
        this._poolContent = content;
    }

    // ----------------------------------------------------------------------
    //  说明卡片（样式与功能对齐战斗场景 CardTooltip）
    // ----------------------------------------------------------------------
    private buildTooltip(root: Node): void {
        const w = this.tipWidth;
        const n = this.makeNode(TOOLTIP, root, 0, 0, w, 300);
        n.getComponent(UITransform)!.setAnchorPoint(0, 1);
        n.setPosition(-this._visW / 2 + this.sw(12), this._visH / 2 - this.sh(10), 0);
        // 🔴 关键字命中**自己做**：引擎的 `<on click>` 派发要求「触摸点同时落在 RichText 节点
        //    与富文本分段的世界矩形内」，本项目 7456 预览的坐标口径（画布 1280×673 ≠ 设计高 720）
        //    下实测**收不到**（与战斗场景 CardTooltip 同一坑）。这里复用分段自己的节点矩形来判定。
        n.on(Node.EventType.TOUCH_END, (e: { getUILocation: () => Vec2 }) => {
            try {
                const kw = this.hitKeyword(e.getUILocation());
                if (kw) this.openDetail(kw);
            } catch (err) { console.error('[DeckEditScene] 关键字命中判定出错：', err); }
        }, this);
        this._tooltip = n;
        n.active = false;
        n.setSiblingIndex(1);
    }

    // ------------------------------ 关键字命中 ------------------------------
    /** 去掉书名号/方括号/空白（`【突进】` → `突进`） */
    private normKw(s: string): string {
        return String(s || '').replace(/[【】\[\]\s]/g, '');
    }

    /** 收集说明卡里「可点关键字」的命中节点（顺序 = 文字顺序） */
    private collectKeywordHits(panel: Node): void {
        this._kwHits.length = 0;
        const dfs = (n: Node): void => {
            if (n.getComponent(RichText)) this.collectRichTextHits(n);
            for (const c of n.children) dfs(c);
        };
        dfs(panel);
    }

    private collectRichTextHits(rtNode: Node): void {
        const segs = this.segmentsOf(rtNode);
        let i = 0;
        while (i < segs.length) {
            let acc = '';
            const spanNodes: Node[] = [];
            let hit: { keyword: string; nodes: Node[] } | null = null;
            for (let j = i; j < segs.length; j++) {
                const s = segs[j];
                if (spanNodes.length > 0) {
                    const prev = spanNodes[spanNodes.length - 1];
                    if (Math.abs(s.y - prev.worldPosition.y) > s.h * 0.6) break;   // 只拼同一行
                }
                acc += s.text;
                spanNodes.push(s.node);
                const norm = this.normKw(acc);
                if (norm && this._tipKeywords.indexOf(norm) >= 0) { hit = { keyword: norm, nodes: spanNodes.slice() }; break; }
                if (!this._tipKeywords.some((k) => k.indexOf(acc) === 0)) break;   // 连前缀都不是
            }
            if (hit) { this._kwHits.push(hit); i += hit.nodes.length; } else { i++; }
        }
    }

    /** 取一个 RichText 节点里的分段（文本 + 节点 + 世界 y/行高） */
    private segmentsOf(rtNode: Node): Array<{ text: string; node: Node; y: number; h: number }> {
        const out: Array<{ text: string; node: Node; y: number; h: number }> = [];
        const push = (node: Node): void => {
            const lb = node.getComponent(Label);
            const ut = node.getComponent(UITransform);
            if (!lb || !ut || !lb.string) return;
            out.push({ text: lb.string, node, y: node.worldPosition.y, h: Math.max(0, ut.contentSize.height) });
        };
        const segs = (rtNode as unknown as { _segments?: Array<{ node?: Node }> })._segments;
        if (Array.isArray(segs) && segs.length > 0) {
            for (const s of segs) if (s && s.node && s.node.isValid) push(s.node);
        }
        if (out.length === 0) for (const c of rtNode.children) push(c);
        for (const s of out) if (!(s.h > 0)) s.h = Math.max(6, this.tipFontSize * this.tipLineHeightRatio);
        return out;
    }

    /** UI 坐标 → 命中的关键字（'' = 没命中） */
    private hitKeyword(ui: Vec2): string {
        if (this._kwHits.length === 0) return '';
        const world = this.uiToWorld(ui);
        for (const hit of this._kwHits) {
            for (const n of hit.nodes) {
                if (!n || !n.isValid) continue;
                const ut = n.getComponent(UITransform);
                if (!ut) continue;
                const l = ut.convertToNodeSpaceAR(world, new Vec3());
                const pad = 3;
                const w = ut.contentSize.width * 0.5 + pad;
                const h = Math.max(ut.contentSize.height, Math.max(6, this.tipFontSize * this.tipLineHeightRatio)) * 0.5 + pad;
                if (l.x >= -w && l.x <= w && l.y >= -h && l.y <= h) return hit.keyword;
            }
        }
        return '';
    }

    private buildDetail(root: Node): void {
        const mask = this.makeNode('DetailMask', root, 0, 0, this._visW, this._visH);
        this.fillRect(mask, this.detailMaskColor);
        mask.active = false;
        mask.on(Node.EventType.TOUCH_END, () => { this.closeDetail(); }, this);
        mask.setSiblingIndex(2);
        this._detailMask = mask;
        const n = this.makeNode(DETAIL, root, 0, 0, this.detailWidth, this.detailHeight);
        this._detail = n;
        n.active = false;
        n.setSiblingIndex(3);
    }

    // ======================================================================
    //  刷新
    // ======================================================================
    private refresh(): void {
        this._touchCards.length = 0;          // 先清空可点卡登记（重建时会重新登记）
        this.rebuildDeckSlots();
        this.rebuildPoolCards();
        this.refreshStats();
    }

    /** PP 费用曲线（= 各费用张数）+ 随从/法术/护符 + n/40 */
    private refreshStats(): void {
        const cost = new Array(8).fill(0) as number[];
        const byType: Record<string, number> = { Follower: 0, Spell: 0, Amulet: 0 };
        for (const [id, c] of this._counts) {
            const info = getCardInfo(id);
            const cs = info && typeof info.cost === 'number' ? Math.max(1, Math.min(8, Math.round(info.cost))) : 1;
            cost[cs - 1] += c;
            const t = info ? String(info.cardType) : 'Follower';
            byType[t] = (byType[t] || 0) + c;
        }
        const peak = Math.max(1, ...cost);
        for (let i = 0; i < this._ppNums.length; i++) {
            const lb = this._ppNums[i];
            lb.string = String(cost[i]);
            lb.color = cost[i] > 0 ? this.textColor : new Color(150, 168, 182, 255);
            const bar = this._ppBars[i];
            if (!bar) continue;
            const hh = bar.h * (cost[i] / peak);
            if (hh > this.sh(2)) {
                bar.g.fillColor = new Color(64, 168, 76, 255);
                bar.g.rect(bar.x - bar.w / 2 + this.sw(1.5), bar.y - bar.h / 2 + this.sh(1.5),
                    Math.max(this.sw(1), bar.w - this.sw(3)), Math.max(this.sh(1), hh - this.sh(3)));
                bar.g.fill();
            }
        }
        const typeKeys = ['Follower', 'Spell', 'Amulet'];
        for (let i = 0; i < this._typeNums.length; i++) {
            this._typeNums[i].string = String(byType[typeKeys[i]] || 0);
        }
        if (this._totalLabel) this._totalLabel.string = `${this.deckSize()}/${MAX_DECK_SIZE}`;
    }

    /**
     * 卡组栏：**相同卡牌只显示一个图标**（按 id 去重 + ×N 角标）。
     * 槽位总数 = max(卡牌种类数, 一屏能显示的格数) —— 卡少时不拖一长串空格子。
     */
    private rebuildDeckSlots(): void {
        const content = this._deckContent;
        if (!content || !content.isValid) return;
        for (const ch of content.children.slice()) { ch.removeFromParent(); ch.destroy(); }
        // ★ 任务2：卡组栏按**费用升序**从左到右（与卡池栏共用同一套 sortByCost 口径）
        const ids = this.sortByCost(Array.from(this._counts.keys()));
        const pitch = this.sw(SLOT_PITCH);
        const pad = this.sw(6);
        const viewW = (content.parent && content.parent.isValid
            ? content.parent.getComponent(UITransform)!.contentSize.width
            : content.getComponent(UITransform)!.contentSize.width);
        const minSlots = Math.max(1, Math.ceil((viewW - pad * 2) / pitch));
        const total = Math.max(ids.length, minSlots);
        const cw = Math.max(viewW, pad * 2 + total * pitch);
        const cut = content.getComponent(UITransform)!;
        const oldW = cut.contentSize.width;
        cut.setContentSize(cw, cut.contentSize.height);
        // 🔴 内容宽度变了（卡牌种类数变化 / 40 格初值收紧）必须把滚动位置**拉回左端**：
        //    否则 content.position.x 还是按旧宽度算的，内容一缩就整体偏到右边、
        //    玩家看到的是卡组末端（实测：17 种卡时首屏显示的是最后那几张）。
        if (Math.abs(cw - oldW) > 0.5 && this._deckSV && this._deckSV.isValid) {
            try { this._deckSV.scrollToLeft(0); } catch (e) { /* 忽略 */ }
        }

        const slotW = this.sw(SLOT_W), slotH = this.sh(SLOT_H);
        for (let i = 0; i < total; i++) {
            // ★ 例图的槽位是「贴格左缘」（格距 125.4 > 槽宽 94 ⇒ 右侧留 31.4 的间隙），不是居中
            const x = -cw / 2 + pad + slotW / 2 + i * pitch;
            const slot = this.makeNode(SLOT_PREFIX + i, content, x, 0, slotW, slotH);
            const g = slot.addComponent(Graphics);
            this.roundRectLocal(g, -slotW / 2, -slotH / 2, slotW, slotH, this.sw(6), C_SLOT_FILL, C_SLOT_LINE, this.sw(1.8));
            const iw = slotW - this.sw(7), ih = slotH - this.sh(7);
            this.roundRectLocal(g, -iw / 2, -ih / 2, iw, ih, this.sw(4), null, C_SLOT_INNER, this.sw(1));
            const id = ids[i];
            if (!id) continue;
            const card = this.compose(id, 'SlotCard_' + i);
            if (card) {
                card.setParent(slot);
                card.setPosition(0, 0, 0);
                this.scaleCardToWidth(card, this.deckCardWidth);
            }
            const n = this._counts.get(id) || 0;
            const badge = this.makeNode('Count', slot, slotW / 2 - this.sw(4) - this.sw(31), slotH / 2 + this.sh(1), this.sw(62), this.sh(24));
            const bg = badge.addComponent(Graphics);
            const bw = this.sw(62), bh = this.sh(24);
            this.octagon(bg, -bw / 2, -bh / 2, bw, bh, this.sw(7), new Color(20, 24, 32, 235),
                new Color(120, 132, 150, 190), this.sw(1.2));
            this.makeLabel('t', badge, '×' + n, 20, this.textColor, 0, 0, bw - this.sw(6), bh, HorizontalTextAlignment.CENTER);
            this.bindCardTouch(slot, id, 'deck');
            this._touchCards.push({ node: slot, id, from: 'deck' });
        }
    }

    /** 卡池：每张卡 + ×N 角标 + 「已加入牌组 ×N」/「牌组上限 ×3」 */
    private rebuildPoolCards(): void {
        const content = this._poolContent;
        if (!content || !content.isValid) return;
        for (const ch of content.children.slice()) { ch.removeFromParent(); ch.destroy(); }
        const ids = this.poolIds();
        const viewW = content.getComponent(UITransform)!.contentSize.width;
        const pitch = this.sw(POOL_PITCH);
        const hw = pitch - this.sw(6);
        const cardScale = this.sw(this.poolCardWidth) / CARD_BASE_W;
        const cardH = CARD_BASE_H * cardScale;
        const hh = cardH + this.sh(64);
        for (let i = 0; i < ids.length; i++) {
            const id = ids[i];
            const holder = this.makeNode(POOL_PREFIX + id, content,
                -viewW / 2 + this.sw(4) + pitch / 2 + i * pitch, 0, hw, hh);
            const card = this.compose(id, 'PoolCardArt_' + id);
            if (card) {
                card.setParent(holder);
                card.setPosition(0, 0, 0);
                this.scaleCardToWidth(card, this.poolCardWidth);
            }
            const n = this._counts.get(id) || 0;
            if (n > 0) {
                const atLimit = n >= MAX_COPIES_PER_CARD;
                const cw2 = this.sw(150), chh = this.sh(58);
                const dim = this.makeNode('State', holder, 0, 0, cw2, chh);
                const gd = dim.addComponent(Graphics);
                gd.fillColor = new Color(8, 12, 24, 170);
                gd.rect(-cw2 / 2, -chh / 2, cw2, chh); gd.fill();
                gd.lineWidth = this.sw(1.4);
                gd.strokeColor = atLimit ? new Color(200, 70, 60, 220) : new Color(180, 196, 214, 180);
                gd.rect(-cw2 / 2, -chh / 2, cw2, chh); gd.stroke();
                const lb = this.makeLabel('t', dim, atLimit ? `牌组上限\n×${n}` : `已加入牌组\n×${n}`,
                    20, atLimit ? this.limitColor : this.textColor, 0, 0, cw2 - this.sw(6), chh, HorizontalTextAlignment.CENTER);
                lb.lineHeight = 26;
                lb.verticalAlign = VerticalTextAlignment.CENTER;
                lb.isBold = true;
            }
            // ×N 角标（只有已加入牌组的卡才画）
            if (n > 0) {
                const badge = this.makeNode('Count', holder, hw / 2 - this.sw(30), cardH / 2 + this.sh(12), this.sw(64), this.sh(24));
                const bg = badge.addComponent(Graphics);
                const bw = this.sw(64), bh = this.sh(24);
                this.octagon(bg, -bw / 2, -bh / 2, bw, bh, this.sw(7), new Color(20, 24, 32, 235),
                    new Color(120, 132, 150, 190), this.sw(1.2));
                this.makeLabel('t', badge, '×' + n, 20, this.textColor, 0, 0, bw, bh, HorizontalTextAlignment.CENTER);
            }
            this.bindCardTouch(holder, id, 'pool');
            this._touchCards.push({ node: holder, id, from: 'pool' });
        }
    }

    /** 自动编辑：按费用从低到高，每张塞满 3 张，直到 40 张 */
    private autoEdit(): void {
        const ids = this.poolIds();
        this._counts.clear();
        let total = 0;
        for (let round = 0; round < MAX_COPIES_PER_CARD && total < MAX_DECK_SIZE; round++) {
            for (const id of ids) {
                if (total >= MAX_DECK_SIZE) break;
                const n = this._counts.get(id) || 0;
                if (n >= MAX_COPIES_PER_CARD) continue;
                this._counts.set(id, n + 1);
                total++;
            }
        }
        console.log(`[DeckEditScene] 自动编辑完成：${this.deckSize()} / ${MAX_DECK_SIZE} 张`);
        this.refresh();
    }

    // ======================================================================
    //  交互：扇形方向判定 + 点击说明 / 拖动
    // ======================================================================
    /**
     * 是否落在「拖动扇形」内。
     * @param from 'pool' = 以正上方为中心（卡池→卡组）；'deck' = 以正下方为中心（卡组→拿出）
     * 角度来自 `poolDragAngle` / `deckDragAngle`（Cocos Inspector 可调）。
     */
    private inDragFan(from: 'pool' | 'deck', dx: number, dy: number): boolean {
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len < 1) return false;
        const deg = Math.max(5, Math.min(90, (from === 'pool' ? this.poolDragAngle : this.deckDragAngle) || 55));
        const ty = from === 'pool' ? 1 : -1;              // up = (0,1) / down = (0,-1)
        const cos = (dy * ty) / len;
        const ang = Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI;
        return ang <= deg;
    }

    /**
     * ★ 任务3：这张卡**还能不能拖**。
     * 卡池卡已经满 `MAX_COPIES_PER_CARD`（3）张 ⇒ 再拖上去也不会被接受 ⇒ **直接禁止拖拽**
     * （点击看说明卡仍然可用）。卡组里的卡永远可拖（向下拿出去）。
     */
    private canDragCard(id: string, from: 'pool' | 'deck'): boolean {
        if (from !== 'pool') return true;
        return (this._counts.get(id) || 0) < MAX_COPIES_PER_CARD;
    }

    /** 触摸事件的 UI 坐标（取值失败返回 null） */
    private uiOf(e: { getUILocation?: () => Vec2 } | null | undefined): Vec2 | null {
        try { return e && typeof e.getUILocation === 'function' ? e.getUILocation() : null; } catch (err) { return null; }
    }

    /**
     * 说明卡打开时只做「关闭判定」，不抢触摸。
     *
     * 关闭判定放在 canvas DOM 捕获层，而不是 Cocos 的 PoolPanel / DeckPanel 上：
     * 后者一旦挂监听，可能成为卡牌触摸的命中目标，反过来阻断 ScrollView。
     * DOM 层只观察，不阻止事件；卡牌与 ScrollView 仍完整处理自己的 START/MOVE/END。
     */
    private bindTooltipDom(): void {
        if (typeof document === 'undefined') return;
        const canvas = document.querySelector('canvas') as HTMLCanvasElement | null;
        if (!canvas) return;
        this._domCanvas = canvas;

        const classify = (ui: Vec2): TooltipTouch['target'] => {
            if (this._detailMask && this._detailMask.isValid && this._detailMask.active && this.pointIn(this._detailMask, ui)) return 'detailMask';
            if (this._detail && this._detail.isValid && this._detail.active && this.pointIn(this._detail, ui)) return 'detail';
            if (this._tooltip && this._tooltip.isValid && this.pointIn(this._tooltip, ui)) return 'tooltip';
            return 'other';
        };
        const down = (event: Event): void => {
            if (!this._tooltip || !this._tooltip.isValid || !this._tooltip.active) {
                this._tooltipTouch = null;
                return;
            }
            const ui = this.domUi(event);
            this._tooltipTouch = ui
                ? { start: new Vec2(ui.x, ui.y), moved: false, target: classify(ui) }
                : null;
        };
        const move = (event: Event): void => {
            const track = this._tooltipTouch;
            if (!track) return;
            const ui = this.domUi(event);
            if (!ui) return;
            const dx = ui.x - track.start.x;
            const dy = ui.y - track.start.y;
            if (Math.sqrt(dx * dx + dy * dy) > DRAG_THRESHOLD) track.moved = true;
        };
        const up = (event: Event): void => {
            const track = this._tooltipTouch;
            this._tooltipTouch = null;
            if (!track || track.moved || !this._tooltip || !this._tooltip.isValid || !this._tooltip.active) return;
            // 说明卡 / 能力详情自身的点击由 Cocos 节点处理；详情遮罩只关闭详情。
            if (track.target !== 'other') return;
            const ui = this.domUi(event);
            if (!ui || this.cardAt(ui)) return;
            this.hideTooltip();
        };
        const cancel = (): void => { this._tooltipTouch = null; };
        for (const [type, fn] of [['mousedown', down], ['mousemove', move], ['mouseup', up], ['mouseleave', cancel]] as Array<[string, (e: Event) => void]>) {
            canvas.addEventListener(type, fn, true);
            this._domHandlers.push({ type, fn });
        }
    }

    /** 浏览器 canvas 像素坐标 → Cocos 参考坐标（1280×720、左下为原点）。 */
    private domUi(event: Event): Vec2 | null {
        const canvas = this._domCanvas;
        const e = event as MouseEvent;
        if (!canvas || !isFinite(e.clientX) || !isFinite(e.clientY)) return null;
        const rect = canvas.getBoundingClientRect();
        if (!(rect.width > 0) || !(rect.height > 0)) return null;
        const cw = canvas.width || rect.width;
        const ch = canvas.height || rect.height;
        const px = (e.clientX - rect.left) * cw / rect.width;
        const py = (e.clientY - rect.top) * ch / rect.height;
        const s = ch / REF_H;
        return new Vec2((px - 640 * (1 - s)) / s, (ch - py) / s);
    }

    /** 按下：记住「哪张卡 / 从哪来 / 起点」。卡牌自己 与 说明卡拦截层 共用 */
    private beginPress(node: Node, id: string, from: 'pool' | 'deck', ui: Vec2): void {
        // Cocos 会在 ScrollView 启用后的首帧把 cancelInnerEvents 恢复为 true；
        // 先保留卡牌子事件，才能在首次 MOVE 判断出竖直扇形并起拖拽幽灵。
        this.setScrollCancelInnerEvents(false);
        this._press = { node, id, from, start: new Vec3(ui.x, ui.y, 0), moved: false, armed: false };
    }

    /** 移动：超过阈值后判「拖动扇形」；只有落进扇形才真的拖起幽灵卡 */
    private movePress(node: Node, ui: Vec2): void {
        const pr = this._press;
        if (!pr || pr.node !== node) return;
        const dx = ui.x - pr.start.x;
        const dy = ui.y - pr.start.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (!pr.moved) {
            if (d <= DRAG_THRESHOLD) return;                // 还没动够
            pr.moved = true;
            if (!this.canDragCard(pr.id, pr.from)) {
                // 满 3 张的卡不允许竖直拖入，但仍要把这次手势交回 ScrollView，
                // 否则说明卡打开时从卡面横滑会失去惯性。
                this.setScrollCancelInnerEvents(true);
                return;
            }
            // ★ 只有落进「拖动扇形」才真的拖起卡牌；其它角度当作滑动卡牌栏
            pr.armed = this.inDragFan(pr.from, dx, dy);
            if (!pr.armed) {
                // 已确定是横滑 / 非拖牌方向，让 ScrollView 取消子卡牌事件，
                // 这样它能完整执行阻尼、回弹和松手惯性。
                this.setScrollCancelInnerEvents(true);
                return;
            }
            this.setScrollEnabled(false);
            // 真的进入扇形拖牌：避免 ScrollView 为了接管横滑而取消卡牌事件。
            this.setScrollCancelInnerEvents(false);
            // 真的开始拖了 ⇒ 收掉说明卡（否则它挡住半个牌组区；现在不再停用 blocker，
            // 免得触摸进行中被停用导致 MOVE/END 收不到）
            this.clearPressedCard();
            if (this._tooltip && this._tooltip.isValid) this._tooltip.active = false;
            this.startGhost(pr.id);
        }
        if (pr.armed) this.moveGhost(ui);
    }

    /** 抬起 / 取消：收尾幽灵卡；返回本次按下的状态（调用方据此决定「点击」还是「关闭」） */
    private endPress(node: Node, ui: Vec2 | null): { had: boolean; moved: boolean; armed: boolean } {
        const pr = this._press;
        this._press = null;
        if (!pr || pr.node !== node) return { had: false, moved: false, armed: false };
        if (pr.moved && pr.armed) {
            if (ui) this.endGhost(ui, pr.id, pr.from); else this.destroyGhost();
        }
        this.setScrollEnabled(true);
        // TOUCH_END 仍处于事件冒泡阶段时，不能立刻把 cancelInnerEvents 改回 true：
        // ScrollView 需要先收到完整的 END，才能根据最近位移启动松手惯性 / 回弹。
        // 延后一拍恢复默认值，避免说明卡打开时横向滑动在松手瞬间被截断。
        setTimeout(() => {
            if (!this._press) this.setScrollCancelInnerEvents(true);
        }, 0);
        return { had: true, moved: pr.moved, armed: pr.armed };
    }

    private bindCardTouch(holder: Node, id: string, from: 'pool' | 'deck'): void {
        holder.on(Node.EventType.TOUCH_START, (e: { getUILocation: () => Vec2 }) => {
            const p = this.uiOf(e);
            if (p) this.beginPress(holder, id, from, p);
        }, this);
        holder.on(Node.EventType.TOUCH_MOVE, (e: { getUILocation: () => Vec2 }) => {
            const p = this.uiOf(e);
            if (p) this.movePress(holder, p);
        }, this);
        holder.on(Node.EventType.TOUCH_END, (e: { getUILocation: () => Vec2 }) => {
            const r = this.endPress(holder, this.uiOf(e));
            if (r.had && !r.moved) this.onClickCard(holder, id);   // 没动过 = 点击 ⇒ 说明卡
        }, this);
        // 拖出 Mask / ScrollView 可视区时引擎派发的是 TOUCH_CANCEL ⇒ 落点判定也要挂这里
        holder.on(Node.EventType.TOUCH_CANCEL, (e: { getUILocation: () => Vec2 }) => {
            this.endPress(holder, this.uiOf(e));
        }, this);
    }

    /** 复位「被点击放大」的那张卡 */
    private clearPressedCard(): void {
        if (this._pressedCard && this._pressedCard.isValid) this._pressedCard.setScale(1, 1, 1);
        this._pressedCard = null;
    }

    private onClickCard(holder: Node, id: string): void {
        if (this._pressedCard && this._pressedCard.isValid && this._pressedCard !== holder) {
            this._pressedCard.setScale(1, 1, 1);
        }
        holder.setScale(this.pressScale, this.pressScale, 1);
        this._pressedCard = holder;
        this.showTooltip(id);
    }

    // ======================================================================
    //  说明卡片（样式与功能对齐战斗场景 CardTooltip）
    // ======================================================================
    private showTooltip(id: string): void {
        const tip = this._tooltip;
        if (!tip || !tip.isValid) return;
        for (const ch of tip.children.slice()) { ch.removeFromParent(); ch.destroy(); }
        this._tipKeywords = [];
        this._crestBox = null;
        const info = getCardInfo(id);
        const tipData: CardTipInfo | undefined = getCardTip(id);
        const W = this.tipWidth;
        const P = this.tipPadding;
        const fs = this.tipFontSize;
        const R = this.badgeRadius;
        let cursor = 0;                                  // 自上而下累计（锚点在左上角 ⇒ y 向下为负）

        const rowH = R * 2;
        const cy = -(P + rowH / 2);
        const hasCost = !!info && typeof info.cost === 'number';
        const isFollower = !!info && info.cardType === 'Follower';
        const hasStats = isFollower && typeof info.attack === 'number' && typeof info.hp === 'number';
        if (hasCost) {
            const cx = P + R;
            this.drawBadge(tip, cx, cy, R, this.badgeCostColor);
            this.makeCentered(tip, 'TipCost', String(Math.round(info!.cost)), cx, cy, R * 1.15);
        }
        let rightLimit = W - P;
        if (hasStats) {
            const hx = W - P - R;
            const ax = hx - R * 2 - Math.max(4, R * 0.4);
            this.drawBadge(tip, ax, cy, R, this.badgeAttackColor);
            this.drawBadge(tip, hx, cy, R, this.badgeHpColor);
            this.makeCentered(tip, 'TipAtk', String(Math.round(info!.attack as number)), ax, cy, R * 1.15);
            this.makeCentered(tip, 'TipHp', String(Math.round(info!.hp as number)), hx, cy, R * 1.15);
            rightLimit = ax - R - 6;
        }
        const nameLeft = P + (hasCost ? R * 2 + 8 : 0);
        const nameW = Math.max(30, rightLimit - nameLeft);
        const nl = this.makeLabel('TipName', tip, info ? info.cardName : id, fs + 4, this.tipTitleColor,
            nameLeft, cy, nameW, rowH, HorizontalTextAlignment.LEFT);
        nl.node.getComponent(UITransform)!.setAnchorPoint(0, 0.5);
        cursor = -(P + rowH + 12);

        if (tipData && tipData.items && tipData.items.length > 0) {
            for (const it of tipData.items) {
                const html = this.renderItem(it);
                if (!html) continue;
                const h = this.addRichText(tip, html, P, cursor, W - P * 2);
                cursor -= h + this.tipItemGap;
            }
        } else {
            const lb = this.makeLabel('Tip', tip, '（暂无说明文案）', fs - 2, this.tipTextColor, P, cursor, W - P * 2, 30, HorizontalTextAlignment.LEFT);
            lb.node.getComponent(UITransform)!.setAnchorPoint(0, 1);
            cursor -= 30 + this.tipItemGap;
        }

        // 与对战场景 CardTooltip 相同：卡牌有纹章时，在说明卡底部补出
        // 「纹章 + 名称 + 纹章效果」区块，而不是只显示卡牌本身的能力。
        if (tipData && tipData.crest) {
            cursor = this.addCrestSection(tip, tipData.crest, cursor);
        }

        const H = Math.max(120, -cursor + P - this.tipItemGap);
        tip.getComponent(UITransform)!.setContentSize(W, H);
        const g = this.gfx(tip);
        g.clear();
        g.fillColor = this.tipBgColor;
        g.roundRect(0, -H, W, H, 10);          // 🔴 锚点在左上角 ⇒ 矩形从 (0,-H) 画起
        g.fill();
        g.lineWidth = 2;
        g.strokeColor = this.tipBorderColor;
        g.roundRect(0, -H, W, H, 10);
        g.stroke();
        if (this._crestBox) {
            const b = this._crestBox;
            g.fillColor = new Color(30, 44, 66, 235);
            g.roundRect(b.x, b.y, b.w, b.h, 8);
            g.fill();
            g.lineWidth = 1.5;
            g.strokeColor = new Color(this.tipBorderColor.r, this.tipBorderColor.g, this.tipBorderColor.b, 170);
            g.roundRect(b.x, b.y, b.w, b.h, 8);
            g.stroke();
        }
        tip.active = true;
        this.collectKeywordHits(tip);
        console.log(`[DeckEditScene] 说明卡：${id} 关键字 [${this._tipKeywords.join('、')}] 命中区 ${this._kwHits.length} 个`);
        tip.setSiblingIndex(1);
        // 不启用全屏 blocker：让上下两个 ScrollView 收到完整触摸序列，
        // 从而保留原生阻尼、边界回弹和松手惯性。
        if (this._blocker && this._blocker.isValid) this._blocker.active = false;
    }

    private hideTooltip(): void {
        this.closeDetail();
        if (this._pressedCard && this._pressedCard.isValid) this._pressedCard.setScale(1, 1, 1);
        this._pressedCard = null;
        if (this._tooltip && this._tooltip.isValid) this._tooltip.active = false;
        this._tooltipTouch = null;
        if (this._blocker && this._blocker.isValid) this._blocker.active = false;
    }

    /**
     * 卡牌说明下方的纹章区块；布局口径参照对战场景 CardTooltip.addCrestSection。
     * 返回值是绘制完区块后的下一个 cursor（仍然是左上锚点、y 向下为负）。
     */
    private addCrestSection(parent: Node, crest: CrestTipInfo, topY: number): number {
        const W = this.tipWidth;
        const P = this.tipPadding;
        const inner = Math.max(8, P * 0.75);
        const boxX = P;
        const boxW = Math.max(40, W - P * 2);
        const rowH = Math.max(34, this.badgeRadius * 1.55);
        const headerTop = topY - inner;
        const cy = headerTop - rowH / 2;
        const tagW = Math.max(54, this.tipFontSize * 2.35);
        const tagX = boxX + inner;

        const tag = this.makeLabel('TipCrestTag', parent, '纹章', this.tipFontSize + 2, this.tipKeywordColor,
            tagX, cy, tagW, rowH, HorizontalTextAlignment.LEFT);
        tag.node.getComponent(UITransform)!.setAnchorPoint(0, 0.5);
        const nameX = tagX + tagW + 6;
        const name = this.makeLabel('TipCrestName', parent, crest.name || crest.id || '未命名纹章',
            this.tipFontSize + 2, this.tipTitleColor, nameX, cy, Math.max(30, boxX + boxW - inner - nameX), rowH,
            HorizontalTextAlignment.LEFT);
        name.node.getComponent(UITransform)!.setAnchorPoint(0, 0.5);

        let y = headerTop - rowH - this.tipItemGap;
        const textX = boxX + inner;
        const textW = Math.max(30, boxW - inner * 2);
        let hasItem = false;
        for (const it of crest.items || []) {
            const html = this.renderItem(it);
            if (!html) continue;
            hasItem = true;
            const h = this.addRichText(parent, html, textX, y, textW);
            y -= h + this.tipItemGap;
        }
        if (!hasItem) {
            const empty = this.makeLabel('TipCrestEmpty', parent, '（暂无纹章效果说明）', this.tipFontSize - 2,
                this.tipTextColor, textX, y, textW, 30, HorizontalTextAlignment.LEFT);
            empty.node.getComponent(UITransform)!.setAnchorPoint(0, 1);
            y -= 30 + this.tipItemGap;
        }

        const bottom = y - inner;
        this._crestBox = { x: boxX, y: bottom, w: boxW, h: topY - bottom };
        return bottom - this.tipItemGap;
    }

    private renderItem(it: { ability?: string; desc?: string; subs?: Array<{ ability?: string; desc?: string }> }): string {
        let s = '';
        if (it.ability) s += this.kw(`【${it.ability}】`, it.ability);
        if (it.desc) s += `<color=#${hex(this.tipTextColor)}>${this.highlight(it.desc)}</color>`;
        for (const sub of it.subs || []) {
            if (sub.ability) s += this.kw(`【${sub.ability}】`, sub.ability);
            if (sub.desc) s += `<color=#${hex(this.tipTextColor)}>${this.highlight(sub.desc)}</color>`;
        }
        return s;
    }

    private kw(text: string, keyword: string): string {
        const k = (keyword || '').trim();
        if (k) this.noteKeyword(k);
        return `<color=#${hex(this.tipKeywordColor)}><b><on click='${KEYWORD_CLICK_HANDLER}' param='${k}'>${text}</on></b></color>`;
    }

    private highlight(text: string): string {
        let rest = String(text || '');
        let out = '';
        let guard = 0;
        while (rest.length > 0 && guard++ < 500) {
            const open = rest.indexOf('【');
            if (open < 0) { out += rest; break; }
            out += rest.slice(0, open);
            const close = rest.indexOf('】', open + 1);
            if (close < 0) { out += rest.slice(open); break; }
            const inner = rest.slice(open + 1, close);
            out += this.kw(rest.slice(open, close + 1), inner);
            rest = rest.slice(close + 1);
        }
        return out;
    }

    private noteKeyword(k: string): void {
        if (!k) return;
        if (this._tipKeywords.indexOf(k) >= 0) return;
        this._tipKeywords.push(k);
    }

    private addRichText(parent: Node, html: string, x: number, topY: number, width: number): number {
        const n = new Node('TipText');
        n.layer = parent.layer;
        n.setParent(parent);
        const ut = n.addComponent(UITransform);
        ut.setAnchorPoint(0, 1);
        n.setPosition(x, topY, 0);
        const rt = n.addComponent(RichText);
        rt.fontSize = Math.max(6, Math.round(this.tipFontSize));
        rt.lineHeight = Math.round(Math.max(6, this.tipFontSize) * Math.max(0.8, this.tipLineHeightRatio));
        rt.fontColor = this.tipTextColor;
        rt.horizontalAlign = HorizontalTextAlignment.LEFT;
        rt.verticalAlign = VerticalTextAlignment.TOP;
        rt.maxWidth = Math.max(20, width);
        rt.string = html;
        if (html.indexOf(KEYWORD_CLICK_HANDLER) >= 0) {
            const link = n.getComponent(DeckTipKeywordLink) || n.addComponent(DeckTipKeywordLink);
            link.onKeyword = (k: string) => { this.openDetail(k); };
        }
        const h = ut.contentSize.height;
        return h > 0 ? h : Math.max(8, this.tipFontSize * this.tipLineHeightRatio);
    }

    // ======================================================================
    //  能力详情弹窗
    //  🔴 修复（2026-09-27）：
    //   ① **内容偏右**：内容节点锚点是 (0.5,1)（顶部居中），子节点 x 却按「左边界 = 12」写
    //      ⇒ 整块内容被推到面板中线右侧、并顶破右边框。正解：左边界 = `-内容宽/2 + 内边距`。
    //   ② **文字不换行、被裁掉**：正文原先用固定 60 高 + `Overflow.CLAMP`，
    //      高度不够就直接截断。正解：`Overflow.RESIZE_HEIGHT`（按宽度自动换行 + 高度自适应），
    //      再读回真实高度累加 y，最后按总高设置内容节点尺寸（滚动范围随内容增长）。
    // ======================================================================
    private openDetail(keyword: string): void {
        const d = this._detail;
        if (!d || !d.isValid) return;
        const list = keywordDetails(this._tipKeywords);
        if (list.length === 0) {
            console.log(`[DeckEditScene] 点「${keyword}」：本张说明卡片没有可展示的关键字说明，不弹能力详情`);
            return;
        }
        for (const ch of d.children.slice()) { ch.removeFromParent(); ch.destroy(); }
        d.active = true;
        if (this._detailMask && this._detailMask.isValid) { this._detailMask.active = true; this._detailMask.setSiblingIndex(2); }
        d.setSiblingIndex(3);

        const W = this.detailWidth, H = this.detailHeight, P = 24;
        const ut = d.getComponent(UITransform)!;
        ut.setContentSize(W, H);
        const g = this.gfx(d);
        g.clear();
        g.fillColor = this.detailBgColor;
        g.roundRect(-W / 2, -H / 2, W, H, 12);
        g.fill();
        g.lineWidth = 2;
        g.strokeColor = this.tipBorderColor;
        g.roundRect(-W / 2, -H / 2, W, H, 12);
        g.stroke();
        this.makeLabel('DetailTitle', d, '能力详情', this.detailTitleSize, this.tipKeywordColor,
            0, H / 2 - 34, W - P * 2, 40, HorizontalTextAlignment.CENTER);

        const cw = W - P * 2;              // 内容可用宽度
        const viewH = H - 100;
        const view = this.makeNode('DetailView', d, 0, -40, cw, viewH);
        view.addComponent(Mask);
        const content = this.makeNode('DetailContent', view, 0, viewH / 2, cw, viewH);
        const cut = content.getComponent(UITransform)!;
        cut.setAnchorPoint(0.5, 1);        // 🔴 顶部居中 ⇒ 子节点 x 必须自己减半个宽度
        cut.setContentSize(cw, viewH);

        const left = -cw / 2 + 10;         // ← 关键修复①：真正的左边界
        const textW = cw - 20;
        const gap = 16;
        let y = -8;
        for (const it of list) {
            const head = this.makeLabel('DetailKw', content, `【${it.keyword}】`, this.detailFontSize + 2,
                this.tipKeywordColor, left, y, textW, this.detailFontSize + 10, HorizontalTextAlignment.LEFT);
            head.node.getComponent(UITransform)!.setAnchorPoint(0, 1);
            y -= this.detailFontSize + 12;

            const body = this.makeLabel('DetailDesc', content, it.desc || '（暂无说明）', this.detailFontSize,
                this.tipTextColor, left, y, textW, this.detailFontSize + 6, HorizontalTextAlignment.LEFT);
            body.lineHeight = this.detailFontSize + 6;
            body.enableWrapText = true;
            body.overflow = Label.Overflow.RESIZE_HEIGHT;   // ← 关键修复②：自动换行 + 高度自适应
            body.node.getComponent(UITransform)!.setAnchorPoint(0, 1);
            try { body.updateRenderData(true); } catch (e) { /* 忽略 */ }
            const bh = Math.max(this.detailFontSize + 6, body.node.getComponent(UITransform)!.contentSize.height);
            y -= bh + gap;
        }
        const contentH = Math.max(viewH, -y + 6);
        cut.setContentSize(cw, contentH);
        try {
            const sv = view.addComponent(ScrollView);
            sv.content = content;
            sv.vertical = true;
            sv.horizontal = false;
            sv.inertia = true;
            sv.brake = 0.75;
            sv.scrollToTop(0);
        } catch (e) { /* 详情滚动失败不影响阅读 */ }
        console.log(`[DeckEditScene] 能力详情：点「${keyword}」→ 列出 [${this._tipKeywords.join('、')}]`
            + `，内容高 ${Math.round(contentH)} / 视窗 ${Math.round(viewH)}`);
    }

    private closeDetail(): void {
        if (this._detail && this._detail.isValid) this._detail.active = false;
        if (this._detailMask && this._detailMask.isValid) this._detailMask.active = false;
    }

    // ------------------------------ 拖拽幽灵 ------------------------------
    private setScrollEnabled(on: boolean): void {
        if (this._deckSV && this._deckSV.isValid) this._deckSV.enabled = on;
        if (this._poolSV && this._poolSV.isValid) this._poolSV.enabled = on;
    }

    /** 横滑时让 ScrollView 取消子卡牌事件；进入竖直扇形拖牌后再放开取消。 */
    private setScrollCancelInnerEvents(on: boolean): void {
        if (this._deckSV && this._deckSV.isValid) this._deckSV.cancelInnerEvents = on;
        if (this._poolSV && this._poolSV.isValid) this._poolSV.cancelInnerEvents = on;
    }

    private startGhost(id: string): void {
        this.destroyGhost();
        const ghost = this.compose(id, 'Ghost_' + id);
        if (!ghost || !this._dragLayer) return;
        ghost.setParent(this._dragLayer);
        this.scaleCardToWidth(ghost, this.poolCardWidth * this.ghostCardScale);
        const op = ghost.getComponent(UIOpacity) || ghost.addComponent(UIOpacity);
        op.opacity = 210;
        this._ghost = ghost;
    }

    private moveGhost(ui: Vec2): void {
        const ghost = this._ghost;
        const layer = this._dragLayer;
        if (!ghost || !ghost.isValid || !layer || !layer.isValid) return;
        const ut = layer.getComponent(UITransform)!;
        const local = ut.convertToNodeSpaceAR(this.uiToWorld(ui), new Vec3());
        ghost.setPosition(local.x, local.y, 0);
    }

    private destroyGhost(): void {
        if (this._ghost && this._ghost.isValid) { this._ghost.removeFromParent(); this._ghost.destroy(); }
        this._ghost = null;
    }

    private endGhost(ui: Vec2, id: string, from: 'pool' | 'deck'): void {
        this.destroyGhost();
        const inDeck = this.pointIn(this._deckContent ? this._deckContent.parent : null, ui);
        const inPool = this.pointIn(this._poolContent ? this._poolContent.parent : null, ui);
        if (from === 'pool' && inDeck) { this.addCard(id); return; }
        if (from === 'deck' && inPool) { this.removeCard(id); return; }
        this.refresh();
    }

    // ======================================================================
    //  数据
    // ======================================================================
    private addCard(id: string): void {
        const n = this._counts.get(id) || 0;
        if (n >= MAX_COPIES_PER_CARD) { console.log(`[DeckEditScene] ${id} 已达放入上限 ${MAX_COPIES_PER_CARD} 张`); this.refresh(); return; }
        if (this.deckSize() >= MAX_DECK_SIZE) { console.log(`[DeckEditScene] 卡组已满 ${MAX_DECK_SIZE} 张`); this.refresh(); return; }
        this._counts.set(id, n + 1);
        console.log(`[DeckEditScene] 加入 ${id} ⇒ ${n + 1} 张（合计 ${this.deckSize()}）`);
        this.refresh();
    }

    private removeCard(id: string): void {
        const n = this._counts.get(id) || 0;
        if (n <= 0) return;
        if (n - 1 <= 0) this._counts.delete(id); else this._counts.set(id, n - 1);
        console.log(`[DeckEditScene] 移出 ${id} ⇒ ${Math.max(0, n - 1)} 张（合计 ${this.deckSize()}）`);
        this.refresh();
    }

    private deckSize(): number {
        let n = 0;
        for (const v of this._counts.values()) n += v;
        return n;
    }

    /** 保存到**当前编辑的那一侧**（我方 / 人机各有独立持久牌组），然后回主界面 */
    private saveAndBack(): void {
        try {
            const s: BattleSetupData = peekSetup();
            const deck = countsToDeck(this._counts);
            setDeckBySide(this._side, deck);
            if (this._side === 'enemy') setPending({ ...s, enemyDeck: deck });
            else setPending({ ...s, playerDeck: deck });
            console.log(`[DeckEditScene] 已保存${this._side === 'enemy' ? '人机' : '我方'}牌组：${deck.join(', ')}`);
        } catch (e) { console.error('[DeckEditScene] 保存失败：', e); }
        this.back();
    }

    private back(): void {
        try { director.loadScene('MainMenu'); } catch (e) { console.error('[DeckEditScene] 返回主界面失败：', e); }
    }

    /**
     * ★ 任务2：按**费用升序**（同费按 id 字典序）—— 卡组栏 / 卡池栏 / 自动编辑**共用同一口径**，
     * 保证上下两栏的左右顺序一致、且与「自动编辑从低费开始塞」一致。
     */
    private sortByCost(ids: string[]): string[] {
        const arr = ids.slice();
        arr.sort((a, b) => {
            const ia = getCardInfo(a), ib = getCardInfo(b);
            const ca = ia ? ia.cost : 0, cb = ib ? ib.cost : 0;
            if (ca !== cb) return ca - cb;
            return a.localeCompare(b);
        });
        return arr;
    }

    private poolIds(): string[] {
        return this.sortByCost(Object.keys(CardMap));
    }

    private normalizeCounts(src: Map<string, number>): Map<string, number> {
        const out = new Map<string, number>();
        for (const [id, n] of src) {
            const key = toCardId(id) || id;
            out.set(key, (out.get(key) || 0) + n);
        }
        return out;
    }

    // ======================================================================
    //  工具
    // ======================================================================
    private factory(): Node | null {
        if (this._factory && this._factory.isValid) return this._factory;
        const scene = this.node.scene as unknown as Node | null;
        if (!scene) return null;
        const stack: Node[] = [...scene.children];
        while (stack.length > 0) {
            const cur = stack.shift() as Node;
            if (cur.name === CARD_FACTORY) { this._factory = cur; return cur; }
            for (const ch of cur.children) stack.push(ch);
        }
        return null;
    }

    private compose(id: string, nodeName: string): Node | null {
        const f = this.factory();
        if (!f) { console.warn('[DeckEditScene] 找不到 CardFactory（CardComposer）'); return null; }
        try {
            const comp = f.getComponent('CardComposer') as unknown as {
                composeCard?: (id: string, name?: string) => Node | null;
            } | null;
            if (!comp || typeof comp.composeCard !== 'function') { console.warn('[DeckEditScene] CardFactory 上没有 composeCard'); return null; }
            const node = comp.composeCard(id, nodeName);
            if (node) node.name = nodeName;      // 🔴 查找之后再改名
            return node;
        } catch (e) {
            console.error('[DeckEditScene] composeCard 失败：', e);
            return null;
        }
    }

    /** 把拼好的卡按「目标宽度（参考坐标）」等比缩放 */
    private scaleCardToWidth(card: Node, refWidth: number): void {
        try {
            const ut = card.getComponent(UITransform);
            const base = ut && ut.contentSize.width > 1 ? ut.contentSize.width : CARD_BASE_W;
            const s = this.sw(refWidth) / base;
            card.setScale(s, s, 1);
        } catch (e) { /* 忽略 */ }
    }

    /**
     * 触摸事件的 `getUILocation()` 是**渲染屏坐标**（本项目：画布 backing 1280×673 ≠ 设计高 720，
     * 相机 orthoHeight=360 ⇒ 渲染比例 S = 673/720 ≈ 0.9347，横轴还带 `640(1−S)` 的偏移），
     * 而 `convertToNodeSpaceAR` / `pointIn` 要**世界坐标** ⇒ 必须用相机反解。
     *
     * 🔴 这里踩过坑：曾按「UI 坐标 = 设计坐标」直接减半个画布尺寸再 `convertToWorldSpaceAR`
     *    （因为 Canvas 锚点在中心，那一步恰好是恒等变换）⇒ 得到的「世界点」其实是屏坐标，
     *    横向偏 41.8、纵向偏 6.5% ⇒ **拖拽落点判定与关键字命中全都不准**（点明明在关键字上也不触发）。
     */
    private uiToWorld(ui: Vec2): Vec3 {
        const cam = this.findCamera();
        if (cam) {
            try {
                const out = new Vec3();
                cam.screenToWorld(new Vec3(ui.x, ui.y, 0), out);
                out.z = 0;
                if (isFinite(out.x) && isFinite(out.y)) return out;
            } catch (e) { /* 退回手算 */ }
        }
        // 兜底：按渲染比例手算
        let fw = REF_W, fh = this._visH;
        try {
            const ws = screen && screen.windowSize;
            if (ws && ws.width > 0 && ws.height > 0) { fw = ws.width; fh = ws.height; }
        } catch (e) { /* 忽略 */ }
        const k = this._visH > 0 ? fh / this._visH : 1;
        const s = k > 0 ? k : 1;
        return new Vec3((ui.x - (fw / 2) * (1 - s)) / s, ui.y / s, 0);
    }

    private canvasNode(): Node | null {
        let n: Node | null = this.node;
        while (n) {
            if (n.name === 'Canvas') return n;
            n = n.parent;
        }
        return null;
    }

    /** 🔴 相机挂在场景根（不是 Canvas 子节点）⇒ 走全场景 BFS */
    private findCamera(): Camera | null {
        const scene = this.node.scene as unknown as Node | null;
        if (!scene) return null;
        const stack: Node[] = [...scene.children];
        while (stack.length > 0) {
            const cur = stack.shift() as Node;
            const c = cur.getComponent(Camera);
            if (c) return c;
            for (const ch of cur.children) stack.push(ch);
        }
        return null;
    }

    /**
     * 【说明卡切换】命中的可点卡牌（卡池 / 卡组槽位）。null = 没点到卡。
     * · 倒序遍历：后登记（渲染更靠上层）的先判；
     * · 必须同时落在**滚动可视区**（ScrollView 的 view 节点矩形）内 —— 滚出 Mask 的卡不算。
     */
    private cardAt(ui: Vec2): { node: Node; id: string; from: 'pool' | 'deck' } | null {
        for (let i = this._touchCards.length - 1; i >= 0; i--) {
            const c = this._touchCards[i];
            if (!c.node || !c.node.isValid || !c.node.activeInHierarchy) continue;
            const sv = c.from === 'pool' ? this._poolSV : this._deckSV;
            const view = sv && sv.isValid ? sv.node : null;
            if (view && !this.pointIn(view, ui)) continue;
            if (this.pointIn(c.node, ui)) return c;
        }
        return null;
    }

    private pointIn(node: Node | null, ui: Vec2): boolean {
        if (!node || !node.isValid) return false;
        const ut = node.getComponent(UITransform);
        if (!ut) return false;
        const local = ut.convertToNodeSpaceAR(this.uiToWorld(ui), new Vec3());
        const w = ut.contentSize.width * 0.5;
        const h = ut.contentSize.height * 0.5;
        return local.x >= -w && local.x <= w && local.y >= -h && local.y <= h;
    }

    private makeNode(name: string, parent: Node, x: number, y: number, w: number, h: number): Node {
        const n = new Node(name);
        n.layer = parent.layer;
        n.setParent(parent);
        const ut = n.addComponent(UITransform);
        ut.setAnchorPoint(0.5, 0.5);
        ut.setContentSize(w, h);
        n.setPosition(x, y, 0);
        return n;
    }

    private makeLabel(name: string, parent: Node, text: string, size: number, color: Color,
                      x: number, y: number, w: number, h: number, align: HorizontalTextAlignment): Label {
        const n = this.makeNode(name, parent, x, y, w, h);
        const lb = n.addComponent(Label);
        lb.string = text;
        lb.fontSize = size;
        lb.lineHeight = size + 4;
        lb.color = color;
        lb.horizontalAlign = align;
        lb.verticalAlign = VerticalTextAlignment.CENTER;
        lb.overflow = Label.Overflow.SHRINK;      // 🔴 先 SHRINK 再定尺寸
        n.getComponent(UITransform)!.setContentSize(w, h);
        return lb;
    }

    /** 徽记里的居中数字（与 CardTooltip 同款） */
    private makeCentered(parent: Node, name: string, text: string, x: number, y: number, size: number): Label {
        const lb = this.makeLabel(name, parent, text, Math.round(size), C_WHITE, x, y, size * 2.4, size * 1.6, HorizontalTextAlignment.CENTER);
        lb.isBold = true;
        lb.node.setPosition(x, y, 0);
        return lb;
    }

    /** 左对齐标签：`refX` = **文字左边缘**的参考 x（锚点 0 ⇒ 位置就是左边缘） */
    private labelLeft(parent: Node, name: string, text: string, size: number, color: Color,
                      refX: number, refTop: number, refW: number, refH: number): Label {
        const b = this.box(refX, refTop, refW, refH);
        const lb = this.makeLabel(name, parent, text, size, color, this.xr(refX), b.y, b.w, b.h, HorizontalTextAlignment.LEFT);
        lb.node.getComponent(UITransform)!.setAnchorPoint(0, 0.5);
        return lb;
    }

    /** 右对齐标签：`refRight` = **文字右边缘**的参考 x（锚点 1 ⇒ 位置就是右边缘） */
    private labelRight(parent: Node, name: string, text: string, size: number, color: Color,
                       refRight: number, refTop: number, refW: number, refH: number): Label {
        const b = this.box(refRight - refW, refTop, refW, refH);
        const lb = this.makeLabel(name, parent, text, size, color, this.xr(refRight), b.y, b.w, b.h, HorizontalTextAlignment.RIGHT);
        lb.node.getComponent(UITransform)!.setAnchorPoint(1, 0.5);
        return lb;
    }

    /** 圆形徽记（底色 + 浅色描边） */
    private drawBadge(parent: Node, x: number, y: number, r: number, color: Color): void {
        const n = this.makeNode('TipBadge', parent, x, y, r * 2, r * 2);
        const g = n.addComponent(Graphics);
        g.fillColor = color;
        g.circle(0, 0, r);
        g.fill();
        g.lineWidth = 2;
        g.strokeColor = this.badgeRingColor;
        g.circle(0, 0, r);
        g.stroke();
    }

    /** 取节点的 Graphics（没有就加一个） */
    private gfx(n: Node): Graphics {
        return n.getComponent(Graphics) || n.addComponent(Graphics);
    }

    // ------------------------------ 矢量绘制辅助 ------------------------------
    /** 【参考坐标】矩形填充（仅用于挂在 (0,0) 的整屏 Graphics 节点） */
    private rectRef(g: Graphics, l: number, t: number, w: number, h: number, c: Color): void {
        g.fillColor = c;
        g.rect(this.xr(l), this.yr(t + h), this.sw(w), Math.max(0.5, this.yr(t) - this.yr(t + h)));
        g.fill();
    }

    /** 【本地坐标】圆角矩形（含可选描边） */
    private roundRectLocal(g: Graphics, x: number, y: number, w: number, h: number, r: number,
                           fill: Color | null, line: Color | null, lw = 2): void {
        const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2));
        if (fill) {
            g.fillColor = fill;
            g.roundRect(x, y, w, h, rr);
            g.fill();
        }
        if (line) {
            g.lineWidth = lw;
            g.strokeColor = line;
            g.roundRect(x, y, w, h, rr);
            g.stroke();
        }
    }

    /** 【参考坐标】竖直渐变 */
    private gradVRef(g: Graphics, l: number, t: number, w: number, h: number, c0: Color, c1: Color, steps: number): void {
        const n = Math.max(1, steps);
        for (let i = 0; i < n; i++) {
            const p = n === 1 ? 0 : i / (n - 1);
            this.rectRef(g, l, t + (h * i) / n, w, h / n + 0.6, lerpColor(c0, c1, p));
        }
    }

    /** 【参考坐标】水平渐变 */
    private gradHRef(g: Graphics, l: number, t: number, w: number, h: number, c0: Color, c1: Color, steps: number): void {
        const n = Math.max(1, steps);
        for (let i = 0; i < n; i++) {
            const p = n === 1 ? 0 : i / (n - 1);
            this.rectRef(g, l + (w * i) / n, t, w / n + 0.6, h, lerpColor(c0, c1, p));
        }
    }

    /** 【本地坐标】竖直渐变 */
    private gradVLocal(g: Graphics, x: number, y: number, w: number, h: number, cBottom: Color, cTop: Color, steps: number): void {
        const n = Math.max(1, steps);
        for (let i = 0; i < n; i++) {
            const p = n === 1 ? 0 : i / (n - 1);
            g.fillColor = lerpColor(cBottom, cTop, p);
            g.rect(x, y + (h * i) / n, w, h / n + 0.6);
            g.fill();
        }
    }

    /** 【本地坐标】水平渐变 */
    private gradHLocal(g: Graphics, x: number, y: number, w: number, h: number, c0: Color, c1: Color, steps: number): void {
        const n = Math.max(1, steps);
        for (let i = 0; i < n; i++) {
            const p = n === 1 ? 0 : i / (n - 1);
            g.fillColor = lerpColor(c0, c1, p);
            g.rect(x + (w * i) / n, y, w / n + 0.6, h);
            g.fill();
        }
    }

    /** 【本地坐标】八边形（切角矩形，例图按钮/角标的形状） */
    private octagon(g: Graphics, x: number, y: number, w: number, h: number, cut: number,
                    fill: Color | null, line: Color | null, lw = 2): void {
        const c = Math.max(0, Math.min(cut, Math.min(w, h) / 2));
        const pts: Array<[number, number]> = [
            [x + c, y], [x + w - c, y], [x + w, y + c], [x + w, y + h - c],
            [x + w - c, y + h], [x + c, y + h], [x, y + h - c], [x, y + c],
        ];
        const path = () => {
            g.moveTo(pts[0][0], pts[0][1]);
            for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
            g.close();
        };
        if (fill) { g.fillColor = fill; path(); g.fill(); }
        if (line) { g.lineWidth = lw; g.strokeColor = line; path(); g.stroke(); }
    }

    /** 金色描边功能按钮（例图同款：切角矩形 + 金字） */
    private goldButton(parent: Node, text: string, l: number, t: number, w: number, h: number,
                       bright: boolean, onTap: () => void): Node {
        const b = this.box(l, t, w, h);
        const n = this.makeNode('btn_' + text, parent, b.x, b.y, b.w, b.h);
        const g = n.addComponent(Graphics);
        if (bright) {
            // 亮青渐变（保存）
            const steps = 10;
            for (let i = 0; i < steps; i++) {
                const p = i / (steps - 1);
                g.fillColor = lerpColor(C_CYAN_L, C_CYAN_R, p);
                g.rect(-b.w / 2, -b.h / 2 + (b.h * i) / steps, b.w, b.h / steps + 0.6);
                g.fill();
            }
            this.octagon(g, -b.w / 2, -b.h / 2, b.w, b.h, this.sw(10), null, C_GOLD, this.sw(2));
        } else {
            this.octagon(g, -b.w / 2, -b.h / 2, b.w, b.h, this.sw(10), C_BTN_DARK, C_GOLD, this.sw(2));
        }
        this.makeLabel('t', n, text, 23, this.textColor, 0, 0, b.w - this.sw(14), b.h, HorizontalTextAlignment.CENTER);
        n.on(Node.EventType.TOUCH_END, () => { try { onTap(); } catch (e) { console.error('[DeckEditScene] 按钮回调出错：', e); } }, this);
        return n;
    }

    /** 金色雪佛龙（返回箭头）；(cx,cy) 为**节点局部**坐标 */
    private chevron(g: Graphics, cx: number, cy: number, r: number, half: number, col: Color): void {
        g.lineWidth = this.sw(7);
        g.strokeColor = col;
        g.moveTo(cx + r, cy + half);
        g.lineTo(cx - r, cy);
        g.lineTo(cx + r, cy - half);
        g.stroke();
        g.lineWidth = this.sw(2);
        g.strokeColor = new Color(255, 244, 214, 220);
        g.moveTo(cx + r, cy + half);
        g.lineTo(cx - r, cy);
        g.lineTo(cx + r, cy - half);
        g.stroke();
    }

    private chevronLeft(g: Graphics, x: number, y: number, w: number, h: number, col: Color): void {
        g.lineWidth = this.sw(3);
        g.strokeColor = col;
        g.moveTo(x + w / 2, y + h / 2);
        g.lineTo(x - w / 2, y);
        g.lineTo(x + w / 2, y - h / 2);
        g.stroke();
    }

    private chevronRight(g: Graphics, x: number, y: number, w: number, h: number, col: Color): void {
        g.lineWidth = this.sw(3);
        g.strokeColor = col;
        g.moveTo(x - w / 2, y + h / 2);
        g.lineTo(x + w / 2, y);
        g.lineTo(x - w / 2, y - h / 2);
        g.stroke();
    }

    private drawBook(g: Graphics, w: number, h: number): void {
        g.fillColor = new Color(232, 208, 152, 255);
        g.rect(-w, -h, w * 2, h * 2); g.fill();
        g.fillColor = new Color(198, 168, 108, 255);
        g.rect(-w, -h, w * 2, h * 0.5); g.fill();
        g.lineWidth = this.sw(1.4);
        g.strokeColor = new Color(120, 96, 52, 255);
        g.moveTo(-w, -h); g.lineTo(w, -h); g.lineTo(w, h); g.lineTo(-w, h); g.close(); g.stroke();
        g.moveTo(-w, -h + h * 0.5); g.lineTo(w, -h + h * 0.5); g.stroke();
    }

    /** 填充整个节点矩形（不含圆角） */
    private fillRect(node: Node, color: Color): void {
        const g = this.gfx(node);
        const ut = node.getComponent(UITransform)!;
        const w = ut.contentSize.width, h = ut.contentSize.height;
        g.clear();
        g.fillColor = color;
        g.rect(-w / 2, -h / 2, w, h);
        g.fill();
    }
}

