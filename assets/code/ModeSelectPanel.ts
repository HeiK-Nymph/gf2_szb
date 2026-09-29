import {
    _decorator, Color, Component, Graphics, HorizontalTextAlignment, Label, Node, UITransform,
    VerticalTextAlignment,
} from 'cc';

const { ccclass, property, menu } = _decorator;

/** 运行期生成的选项框节点名前缀（探针 / 调试用） */
export const MODE_OPTION_NODE = 'ModeOption';

/**
 * ModeSelectPanel —— 「**模式**」卡牌的**选项选择**界面
 * ===========================================================================
 * 需求（卡 9「史上最强·威玛西娜」入场曲的模式）：
 *   · 使用带「模式」的卡牌时，**先进入选择模式**：卡牌飞到左上角（这一步与卡牌 4 完全一样，
 *     由 `CardPlay.moveToFanfareCorner` 负责，本组件不管）；
 *   · 但**选择的对象不是卡牌而是选项** —— 选项出现在**屏幕中央**等待玩家点击；
 *   · 玩家点其它地方 = 与卡牌 4「不选择」一样（`onCancelled` → 卡牌回手、不消耗费用）；
 *   · **选项里文字的大小在 Cocos 里暴露**（本组件挂在常驻节点 `Canvas/ModeSelectPanel`，
 *     直接改 Inspector 即可）；
 *   · **选项框的高度由文字撑起**（文字换行后多高，框就多高 —— 见 `buildOption`）。
 *
 * 挂载：常驻节点 `Canvas/ModeSelectPanel`（UITransform 1280×720、锚点 0.5/0.5，与其它特效层同款）。
 * 一次性界面：每次 `begin()` 现建子节点，`settle()` 时全部清掉。
 * ===========================================================================
 */
@ccclass('ModeSelectPanel')
@menu('gf2szb/ModeSelectPanel')
export class ModeSelectPanel extends Component {

    private static _inst: ModeSelectPanel | null = null;
    public static get instance(): ModeSelectPanel | null {
        return (ModeSelectPanel._inst && ModeSelectPanel._inst.isValid) ? ModeSelectPanel._inst : null;
    }

    // ====================== ★ 需求：Inspector 暴露的变量 ======================
    @property({
        range: [12, 60, 1], slide: true,
        tooltip: '★【选项文字大小】(px)：模式选项里文字的字号。\n'
            + '🔴 **选项框的高度由文字撑起** —— 字号调大、文字换行变多，框会自动变高。',
    })
    optionFontSize = 26;

    @property({ range: [0, 40, 1], slide: true, tooltip: '【选项框·内边距】(px)：文字与框边的距离（上下各一份，直接决定框高增量）' })
    optionPadding = 16;

    @property({ range: [200, 1280, 1], slide: true, tooltip: '【选项框宽度】(px)：文字超过这个宽度就换行（换行 ⇒ 框更高）' })
    optionWidth = 720;

    @property({ range: [0, 60, 1], slide: true, tooltip: '【选项之间的间距】(px)' })
    optionGap = 18;

    @property({ range: [0, 120, 1], slide: true, tooltip: '【整组选项相对屏幕中心的纵向偏移】(px)：正值往上' })
    centerOffsetY = 0;

    @property({ range: [0, 40, 1], slide: true, tooltip: '【选项框圆角】(px)' })
    cornerRadius = 8;

    @property({ type: Color, tooltip: '【选项框底色】（半透明深色，压住战场）' })
    boxColor = new Color(16, 30, 46, 232);

    @property({ type: Color, tooltip: '【选项框描边色】' })
    boxBorderColor = new Color(150, 206, 226, 235);

    @property({ type: Color, tooltip: '【鼠标悬停 / 按下时的底色】' })
    boxHoverColor = new Color(38, 74, 104, 244);

    @property({ type: Color, tooltip: '【选项文字颜色】' })
    textColor = new Color(238, 246, 252, 255);

    @property({ tooltip: '打印选择日志' })
    verbose = true;

    /** 当前是否在等玩家点选项 */
    private _active = false;
    /** 每次 begin 的收尾函数（幂等） */
    private _settle: ((index: number | null, reason: string) => void) | null = null;
    /** 现建的界面根（全屏接事件层） */
    private _layer: Node | null = null;
    /** 选项框（命中用） */
    private _boxes: Array<{ node: Node; index: number }> = [];
    private _optionTexts: string[] = [];
    private _hover = -1;

    onLoad(): void {
        ModeSelectPanel._inst = this;
    }

    onEnable(): void {
        ModeSelectPanel._inst = this;
    }

    onDisable(): void {
        if (this._settle) this._settle(null, '组件被关闭');
    }

    onDestroy(): void {
        if (ModeSelectPanel._inst === this) ModeSelectPanel._inst = null;
        if (this._settle) this._settle(null, '组件被销毁');
        this.clearLayer();
    }

    public get isSelecting(): boolean { return this._active; }

    /**
     * 弹出选项等待玩家点选。
     * @param texts    选项文字（顺序 = 索引）
     * @param onPicked 选中回调（索引）
     * @param onCancelled 点其它地方 / 被强制收尾时回调（与卡牌 4「不选择」同一语义）
     * @returns 是否成功进入选择（组件缺失 / 没有选项 → false）
     */
    public begin(
        texts: string[],
        onPicked: (index: number) => void,
        onCancelled: (reason: string) => void,
    ): boolean {
        const list = (texts || []).map((t) => String(t));
        if (list.length === 0) return false;
        if (!this.node || !this.node.isValid) return false;
        if (this._settle) this._settle(null, '新的选择顶替');      // 兜底：上一轮先收尾

        this._optionTexts = list;
        this._active = true;
        let done = false;
        const settle = (index: number | null, reason: string): void => {
            if (done) return;
            done = true;
            this._active = false;
            this._settle = null;
            this.clearLayer();
            try {
                if (index === null) onCancelled(reason);
                else onPicked(index);
            } catch (e) {
                console.error('[ModeSelectPanel] 选择回调出错：', e);
            }
        };
        this._settle = settle;

        this.buildLayer(list);
        if (this.verbose) console.log(`[ModeSelectPanel] 等待选择模式：${list.length} 个选项`);
        return true;
    }

    /** 程序化选中第 index 个选项（探针 / AI 用） */
    public pick(index: number): void {
        if (!this._settle) return;
        const i = Math.max(0, Math.min(this._optionTexts.length - 1, Math.round(index)));
        this._settle(i, 'pick');
    }

    /** 程序化取消（= 玩家点了别的地方） */
    public cancel(reason = 'cancel'): void {
        if (this._settle) this._settle(null, reason);
    }

    // ====================== 界面 ======================
    private buildLayer(texts: string[]): void {
        this.clearLayer();
        const layer = new Node('ModeSelectLayer');
        layer.layer = this.node.layer;
        layer.setParent(this.node);
        layer.setSiblingIndex(layer.parent ? layer.parent.children.length - 1 : 0);   // 画在最上层
        const lut = layer.addComponent(UITransform);
        lut.setAnchorPoint(0.5, 0.5);
        lut.setContentSize(2000, 2000);            // 全屏接事件（点在别处 = 取消）
        layer.setPosition(0, 0, 0);
        this._layer = layer;
        layer.on(Node.EventType.TOUCH_END, this.onLayerTouch, this);

        // 先量总高（框高由文字撑起）→ 整组纵向居中
        const gap = Math.max(0, this.optionGap);
        const heights: number[] = [];
        let total = 0;
        for (const t of texts) {
            const h = this.measureTextHeight(t);
            heights.push(h);
            total += h;
        }
        total += gap * Math.max(0, texts.length - 1);

        let cursor = total / 2 + Math.max(0, this.centerOffsetY);
        this._boxes = [];
        for (let i = 0; i < texts.length; i++) {
            const h = heights[i];
            const cy = cursor - h / 2;
            cursor -= h + gap;
            const box = this.buildOption(texts[i], i, h, cy);
            this._boxes.push({ node: box, index: i });
        }
    }

    /** 量文字高度：先按固定宽度排一次（RESIZE_HEIGHT = 宽固定、高跟文字），再读 contentSize */
    private measureTextHeight(text: string): number {
        const pad = Math.max(0, this.optionPadding);
        const probe = new Node('ModeOptionProbe');
        probe.layer = this.node.layer;
        probe.setParent(this.node);
        const put = probe.addComponent(UITransform);
        put.setAnchorPoint(0.5, 0.5);
        const w = Math.max(60, this.optionWidth) - pad * 2;
        put.setContentSize(w, this.optionFontSize + 4);
        const lb = probe.addComponent(Label);
        lb.string = text;
        lb.fontSize = Math.max(8, this.optionFontSize);
        lb.lineHeight = Math.max(10, this.optionFontSize + 6);
        lb.horizontalAlign = HorizontalTextAlignment.LEFT;
        lb.verticalAlign = VerticalTextAlignment.CENTER;
        lb.overflow = Label.Overflow.RESIZE_HEIGHT;    // 🔴 宽固定、高跟文字 ⇒ 框高由文字撑起
        lb.enableWrapText = true;
        put.setContentSize(w, lb.node.getComponent(UITransform)!.contentSize.height);
        const h = Math.max(this.optionFontSize + pad * 2, put.contentSize.height + pad * 2);
        probe.removeFromParent();
        probe.destroy();
        return h;
    }

    private buildOption(text: string, index: number, h: number, cy: number): Node {
        const W = Math.max(120, this.optionWidth);
        const pad = Math.max(0, this.optionPadding);
        const n = new Node(MODE_OPTION_NODE + '_' + index);
        n.layer = this._layer ? this._layer.layer : this.node.layer;
        n.setParent(this._layer);
        const ut = n.addComponent(UITransform);
        ut.setAnchorPoint(0.5, 0.5);
        ut.setContentSize(W, h);
        n.setPosition(0, cy, 0);

        const g = n.addComponent(Graphics);
        this.drawBox(g, W, h, this.boxColor);

        const t = new Node('text');
        t.layer = n.layer;
        t.setParent(n);
        const tut = t.addComponent(UITransform);
        tut.setAnchorPoint(0.5, 0.5);
        tut.setContentSize(W - pad * 2, h - pad * 2);
        t.setPosition(0, 0, 0);
        const lb = t.addComponent(Label);
        lb.string = text;
        lb.fontSize = Math.max(8, this.optionFontSize);
        lb.lineHeight = Math.max(10, this.optionFontSize + 6);
        lb.color = this.textColor;
        lb.horizontalAlign = HorizontalTextAlignment.LEFT;
        lb.verticalAlign = VerticalTextAlignment.CENTER;
        lb.overflow = Label.Overflow.SHRINK;
        lb.enableWrapText = true;

        n.on(Node.EventType.TOUCH_END, () => {
            if (this.verbose) console.log(`[ModeSelectPanel] 选中模式选项 ${index}：${text.slice(0, 24)}`);
            if (this._settle) this._settle(index, 'picked');
        }, this);
        return n;
    }

    private drawBox(g: Graphics, W: number, h: number, color: Color): void {
        const r = Math.max(0, this.cornerRadius);
        g.clear();
        g.fillColor = color;
        g.roundRect(-W / 2, -h / 2, W, h, r);
        g.fill();
        g.lineWidth = 2;
        g.strokeColor = this.boxBorderColor;
        g.roundRect(-W / 2, -h / 2, W, h, r);
        g.stroke();
    }

    /** 点在选项之外（全屏层）→ 取消（与卡牌 4「不选择」同语义） */
    private onLayerTouch(): void {
        if (!this._active) return;
        if (this.verbose) console.log('[ModeSelectPanel] 点到选项之外 → 取消（卡牌回手、不消耗费用）');
        if (this._settle) this._settle(null, '点击了其它地方');
    }

    private clearLayer(): void {
        const l = this._layer;
        this._layer = null;
        this._boxes = [];
        if (l && l.isValid) {
            l.off(Node.EventType.TOUCH_END, this.onLayerTouch, this);
            l.removeFromParent();
            l.destroy();
        }
    }
}
