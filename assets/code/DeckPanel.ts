import {
    _decorator, Color, Component, EventMouse, EventTouch, Graphics, HorizontalTextAlignment,
    Label, Mask, Node, UITransform,
} from 'cc';
import { getCardInfo } from './CardData';
import { CardDeckManager } from './CardDeckManager';

const { ccclass, property, menu } = _decorator;

/** 面板根节点名（CardDraw 的「牌组」按钮据此复用，**不要**每次点都新建一个） */
export const DECK_PANEL_NAME = 'DeckPanel';
/** 可滚动内容节点名 */
const DECK_PANEL_BODY = 'DeckPanelBody';

/**
 * DeckPanel —— **「牌组」测试面板**（运行时由 CardDraw 的「牌组」按钮挂到 Canvas 上）
 * ===========================================================================
 * 需求：
 *   · 「控制台」按钮**下方**再加一个「牌组」按钮；点击展开**双方牌组剩余卡牌**，
 *     **按费用从小到大分类排序**（同费用一组，同卡合并成「卡名 ×N」）；再点一次关闭；
 *   · 背景 = **透明浅灰色**；
 *   · 卡牌可能很多 ⇒ 内容超出可视区时支持**上下滑动**（拖拽 + 滚轮）。
 *
 * 🔴 与「控制台」一样是**测试时才有的功能**：按钮由 `CardDraw.buildTestPanel()` 生成
 *    （`testCardIds` 为空就不建），面板也只在运行时 `addComponent`，不落盘。
 * 🔴 **单实例**：按钮那边必须先按节点名找回已有面板再 toggle，否则会叠出好几层（踩过：
 *    文字一层层叠起来越来越粗）。
 * ===========================================================================
 */
@ccclass('DeckPanel')
@menu('gf2szb/DeckPanel')
export class DeckPanel extends Component {

    @property({ range: [200, 700, 1], slide: true, tooltip: '【面板宽度】(px)' })
    panelWidth = 430;

    @property({ range: [160, 720, 1], slide: true, tooltip: '【可视区高度】(px)：超出部分靠上下滑动看' })
    panelHeight = 560;

    @property({
        type: Color,
        tooltip: '【面板底色】**灰色**（半透明，需求）：白字压在上面才看得清。\n'
            + '🔴 底色画在**独立子节点** `DeckPanelBg` 上 —— 不能和 Mask 放同一个节点：\n'
            + '    Mask 会把同节点的 Graphics 当成自己的**模板**用掉，结果底色根本不显示（踩过）。',
    })
    bgColor = new Color(88, 92, 100, 205);

    @property({ type: Color, tooltip: '【面板描边色】（浅灰偏白，压住边缘）' })
    borderColor = new Color(226, 230, 238, 210);

    @property({ range: [0, 24, 1], slide: true, tooltip: '【圆角半径】(px)' })
    cornerRadius = 10;

    @property({ type: Color, tooltip: '【阵营标题色】**白色**（需求：字要白的）' })
    sideColor = new Color(255, 255, 255, 255);

    @property({ type: Color, tooltip: '【费用小标题色】**白色**' })
    costColor = new Color(255, 255, 255, 255);

    @property({ type: Color, tooltip: '【卡名文字色】**白色**' })
    textColor = new Color(255, 255, 255, 255);

    @property({ range: [10, 40, 1], slide: true, tooltip: '【字号】(px)' })
    fontSize = 18;

    @property({ range: [4, 60, 1], slide: true, tooltip: '【行距】(px)' })
    lineGap = 8;

    @property({ tooltip: '打印开关日志（调试用）' })
    verbose = false;

    /** 面板是否已展开 */
    private _open = false;
    private _root: Node | null = null;
    private _body: Node | null = null;
    private _gfx: Graphics | null = null;
    /** 内容总高（滚动上限用） */
    private _contentH = 0;
    private _scrollY = 0;
    private _dragId = -1;
    private _dragFromY = 0;
    private _dragStartScroll = 0;
    private _bound = false;

    onLoad(): void {
        this.build();
        // 🔴 初始**关闭**：按钮点第一下是「打开」，再点一下才是关闭。
        this._open = false;
        if (this._root && this._root.isValid) this._root.active = false;
    }

    onDestroy(): void {
        this.unbindInput();
        this._root = null;
        this._body = null;
        this._gfx = null;
    }

    /** 开 / 关（CardDraw 的「牌组」按钮调用） */
    public toggle(): void {
        this._open = !this._open;
        if (!this._root || !this._root.isValid) this.build();
        if (this._root && this._root.isValid) this._root.active = this._open;
        if (this._open) { this._scrollY = 0; this.refresh(); }
        if (this.verbose) console.log(`[DeckPanel] ${this._open ? '展开' : '收起'}`);
    }

    public get isOpen(): boolean { return this._open; }

    /** 重建内容（每次打开都重新生成：牌堆随时可能变） */
    public refresh(): void {
        if (!this._body || !this._body.isValid) return;
        for (const c of this._body.children.slice()) { c.removeFromParent(); c.destroy(); }

        const W = Math.max(200, this.panelWidth);
        const H = Math.max(160, this.panelHeight);
        const left = -W / 2 + 16;
        const rowH = Math.max(14, this.fontSize + this.lineGap);
        let y = H / 2 - 20;                 // 内容坐标（自上而下）

        const deck = this.deckManager();
        if (!deck) {
            this.addLine('（找不到 CardDeckManager）', this.textColor, left, y, W - 32);
            y -= rowH;
        } else {
            for (const side of ['player', 'enemy'] as const) {
                const list = deck.remainingCards(side);
                const label = side === 'player' ? '我方牌组' : '敌方牌组';
                this.addLine(`${label}（剩余 ${list.length} 张）`, this.sideColor, left, y, W - 32);
                y -= rowH + 2;

                // 按费用分组（费用升序；同 id 合并成「卡名 ×N」）
                const byCost = new Map<number, Map<string, number>>();
                for (const id of list) {
                    const info = getCardInfo(id);
                    const cost = info ? info.cost : -1;
                    if (!byCost.has(cost)) byCost.set(cost, new Map());
                    const m = byCost.get(cost)!;
                    m.set(id, (m.get(id) || 0) + 1);
                }
                const costs = Array.from(byCost.keys()).sort((a, b) => a - b);
                if (costs.length === 0) {
                    this.addLine('（空）', this.textColor, left + 22, y, W - 64);
                    y -= rowH;
                }
                for (const cost of costs) {
                    this.addLine(`费用 ${cost}`, this.costColor, left + 10, y, W - 52);
                    y -= rowH;
                    for (const [id, n] of byCost.get(cost)!) {
                        const info = getCardInfo(id);
                        const nm = info ? info.cardName : id;
                        this.addLine(n > 1 ? `${nm} ×${n}` : nm, this.textColor, left + 22, y, W - 64);
                        y -= rowH;
                    }
                }
                y -= Math.max(6, rowH * 0.5);
            }
        }

        // 🔴 内容坐标是「自上而下」的，body 内部用「中心为 0」的坐标 ⇒ 记下总高供滚动用。
        this._contentH = Math.max(0, (H / 2 - 20) - y);
        this.applyScroll();
    }

    // ====================== 滚动（拖拽 + 滚轮）======================
    private maxScroll(): number {
        const H = Math.max(160, this.panelHeight);
        return Math.max(0, this._contentH + 28 - H);
    }

    private applyScroll(): void {
        this._scrollY = Math.max(0, Math.min(this.maxScroll(), this._scrollY));
        if (this._body && this._body.isValid) {
            // 内容整体上移 scrollY（内容本身已按可视区顶部对齐）
            this._body.setPosition(0, this._scrollY, 0);
        }
    }

    private bindInput(): void {
        if (this._bound) return;
        this._bound = true;
        this.node.on(Node.EventType.TOUCH_START, this.onDown, this);
        this.node.on(Node.EventType.TOUCH_MOVE, this.onMove, this);
        this.node.on(Node.EventType.TOUCH_END, this.onUp, this);
        this.node.on(Node.EventType.TOUCH_CANCEL, this.onUp, this);
        this.node.on(Node.EventType.MOUSE_WHEEL, this.onWheel, this);
    }

    private unbindInput(): void {
        if (!this._bound) return;
        this._bound = false;
        this.node.off(Node.EventType.TOUCH_START, this.onDown, this);
        this.node.off(Node.EventType.TOUCH_MOVE, this.onMove, this);
        this.node.off(Node.EventType.TOUCH_END, this.onUp, this);
        this.node.off(Node.EventType.TOUCH_CANCEL, this.onUp, this);
        this.node.off(Node.EventType.MOUSE_WHEEL, this.onWheel, this);
    }

    private readonly onDown = (e: EventTouch): void => {
        this._dragId = e.getID();
        this._dragFromY = e.getUILocation().y;
        this._dragStartScroll = this._scrollY;
    };

    private readonly onMove = (e: EventTouch): void => {
        if (this._dragId < 0 || e.getID() !== this._dragId) return;
        const dy = e.getUILocation().y - this._dragFromY;
        this._scrollY = this._dragStartScroll + dy;      // 手指上滑 = 内容上移 = 看后面的
        this.applyScroll();
    };

    private readonly onUp = (e: EventTouch): void => {
        if (this._dragId >= 0 && e.getID() !== this._dragId) return;
        this._dragId = -1;
        this.applyScroll();
    };

    private readonly onWheel = (e: EventMouse): void => {
        const dy = e.getScrollY();
        if (!dy) return;
        this._scrollY += dy * 0.5;
        this.applyScroll();
    };

    // ====================== 构建 ======================
    private build(): void {
        const W = Math.max(200, this.panelWidth);
        const H = Math.max(160, this.panelHeight);
        const ut = this.getComponent(UITransform) || this.addComponent(UITransform);
        ut.setAnchorPoint(0.5, 0.5);
        ut.setContentSize(W, H);

        // 🔴 底色画在**独立子节点**上：Mask 会把**同节点**的 Graphics 当模板用掉 ⇒ 同节点画不出底色（踩过）。
        let bgNode = this.node.getChildByName('DeckPanelBg');
        if (!bgNode) {
            bgNode = new Node('DeckPanelBg');
            bgNode.layer = this.node.layer;
            bgNode.setParent(this.node);
            bgNode.setSiblingIndex(0);                 // 永远在最底
            const but = bgNode.addComponent(UITransform);
            but.setAnchorPoint(0.5, 0.5);
        }
        const but = bgNode.getComponent(UITransform)!;
        but.setContentSize(W, H);
        bgNode.setPosition(0, 0, 0);
        const g = bgNode.getComponent(Graphics) || bgNode.addComponent(Graphics);
        this._gfx = g;
        this.drawBg(W, H);

        // 可视区遮罩（超出部分裁掉）—— 单独一层节点，只负责裁剪
        let view = this.node.getChildByName('DeckPanelView');
        if (!view) {
            view = new Node('DeckPanelView');
            view.layer = this.node.layer;
            view.setParent(this.node);
            const vut = view.addComponent(UITransform);
            vut.setAnchorPoint(0.5, 0.5);
            view.addComponent(Mask);
        }
        const vut = view.getComponent(UITransform)!;
        vut.setContentSize(W, H);
        view.setPosition(0, 0, 0);
        const mask = view.getComponent(Mask)!;
        mask.type = Mask.Type.GRAPHICS_RECT;

        let root = view.getChildByName(DECK_PANEL_BODY);
        if (!root) {
            root = new Node(DECK_PANEL_BODY);
            root.layer = this.node.layer;
            root.setParent(view);
            const rut = root.addComponent(UITransform);
            rut.setAnchorPoint(0.5, 0.5);
        }
        const rut = root.getComponent(UITransform)!;
        rut.setContentSize(W, H);
        root.setPosition(0, 0, 0);
        root.active = this._open;
        this._root = root;
        this._body = root;

        this.bindInput();
        this.refresh();
    }

    private drawBg(W: number, H: number): void {
        const g = this._gfx;
        if (!g) return;
        const r = Math.max(0, this.cornerRadius);
        g.clear();
        g.fillColor = this.bgColor;
        g.roundRect(-W / 2, -H / 2, W, H, r);
        g.fill();
        if (this.borderColor.a > 0) {
            g.lineWidth = 2;
            g.strokeColor = this.borderColor;
            g.roundRect(-W / 2, -H / 2, W, H, r);
            g.stroke();
        }
    }

    private addLine(text: string, color: Color, x: number, y: number, width: number): Label | null {
        if (!this._body || !this._body.isValid) return null;
        const n = new Node('line');
        n.layer = this._body.layer;
        n.setParent(this._body);
        const ut = n.addComponent(UITransform);
        ut.setAnchorPoint(0, 0.5);
        const w = Math.max(20, width);
        ut.setContentSize(w, this.fontSize + 6);
        n.setPosition(x, y, 0);
        const lb = n.addComponent(Label);
        lb.string = text;
        lb.fontSize = this.fontSize;
        lb.lineHeight = this.fontSize + 4;
        lb.color = color;
        lb.horizontalAlign = HorizontalTextAlignment.LEFT;
        lb.overflow = Label.Overflow.SHRINK;      // 🔴 先 SHRINK 再定尺寸，避免被文本冲掉
        ut.setContentSize(w, this.fontSize + 6);
        return lb;
    }

    private deckManager(): CardDeckManager | null {
        const scene = this.node.scene as unknown as Node | null;
        if (!scene) return null;
        const stack: Node[] = [...scene.children];
        while (stack.length > 0) {
            const cur = stack.shift() as Node;
            const c = cur.getComponent(CardDeckManager);
            if (c) return c;
            for (const ch of cur.children) stack.push(ch);
        }
        return null;
    }
}
