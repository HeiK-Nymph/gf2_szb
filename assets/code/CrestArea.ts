import {
    _decorator, Color, Component, Enum, Graphics, Label, Mask, Node, Size, Sprite, SpriteFrame, UITransform,
} from 'cc';
import { EDITOR } from 'cc/env';
import { CrestRipple, CrestRippleConfig } from './CrestRipple';

const { ccclass, property, executeInEditMode, requireComponent, menu } = _decorator;

/** 纹章区归属：Player = 我方（画面下方）；Enemy = 敌方（我方的上下颠倒镜像） */
export enum CrestSide {
    Player = 0,
    Enemy = 1,
}
Enum(CrestSide);

/**
 * CrestArea —— 「纹章」区域（我方 / 敌方各一个，共 5 个圆圈槽位）
 * ===========================================================================
 * 参照例图：一排 3 个 + 错位内排 2 个的**金环暗底圆圈**，每个圆圈中央有一个
 * 纹章占位图样（小菱形，后续由纹章系统填充真实图标）。敌方区域 = 我方区域的
 * **整体上下颠倒镜像**（3 个的一排换到靠屏幕外那一侧）。
 *
 * 本组件**自己 build 全部子节点**（与 HeroArea / TurnControlPanel 同一套路）：
 * 场景里只需要一个空节点 + 本组件，改 Inspector 参数即实时重排（@executeInEditMode）。
 *
 *   CrestArea            ← 本节点（UITransform = 排布外接尺寸）
 *   ├── Crest_0 ~ Crest_4 ← 每个槽位一个 cc.Graphics（暗底盘 + 暗金底环 + 亮金环面
 *   │   │                    + 内侧细环 + 中央菱形纹章占位）
 *   │   └── CrestIcon      ← 有纹章时才建：cc.Mask(椭圆) 容器，尺寸 = **圆环内径**
 *   │       └── CrestIconImg ← 纹章贴图（方形 → 四角被椭圆裁掉）
 *
 * 排布（相对直径 D 的比例，改一个值整体等比缩放）：
 *   · 靠屏幕外一排 3 个，内排 2 个**错位**居中；
 *   · 我方：3 个的一排在下，节点（Crest_0~4）**从左到右**编号；
 *   · 敌方：上下颠倒 → 3 个的一排在上，节点**从右到左**编号（上排 0,1,2、下排 3,4）。
 *
 * 🔴 【整体大小】`sizeScale` 是**敌我共享**的一个变量：在任意一个区域的 Inspector
 *    里改它，另一个区域会自动同步（rebuild 时写回其它 CrestArea 实例），
 *    保证两个区域永远等大。
 * ===========================================================================
 */
@ccclass('CrestArea')
@executeInEditMode(true)
@requireComponent(UITransform)
@menu('gf2szb/CrestArea')
export class CrestArea extends Component {

    // ====================== 归属 ======================
    @property({
        type: Enum(CrestSide),
        tooltip: '纹章区归属：\n'
            + 'Player = 我方（3 个的一排靠画面下方）；\n'
            + 'Enemy  = 敌方（我方整体上下颠倒的镜像，3 个的一排靠画面上方）。',
    })
    side: CrestSide = CrestSide.Player;

    // ====================== 尺寸 ======================
    @property({
        tooltip: '【整体大小】敌我两个纹章区域**共享**的缩放系数（1 = 按 circleSize 原始尺寸）。\n'
            + '🔴 在任意一个区域的 Inspector 里改它，另一个区域会自动同步成一样的值。',
    })
    sizeScale = 1;

    @property({
        range: [40, 200, 1], slide: true,
        tooltip: '单个纹章圆圈的**直径**（px，sizeScale = 1 时）。所有间距都按它等比推导。',
    })
    circleSize = 84;

    @property({ range: [0, 0.6, 0.005], slide: true, tooltip: '同一排圆圈的水平间距 ÷ 直径' })
    gapRatio = 0.12;

    @property({
        range: [0, 0.8, 0.005], slide: true,
        tooltip: '上下两排的行距 ÷ 直径（两排圆心的垂直距离 = 直径 × (1 + 行距)）',
    })
    rowGapRatio = 0.16;

    // ====================== 配色（取自例图：暗蓝黑底盘 + 金环） ======================
    @property({ type: Color, tooltip: '圆圈内底盘（暗蓝黑）' })
    circleColor = new Color(24, 28, 44, 255);

    @property({ type: Color, tooltip: '金环主色（亮金环面）' })
    ringColor = new Color(211, 185, 131, 255);

    @property({ type: Color, tooltip: '金环暗部（底环 / 外缘，做金属立体感）' })
    ringDarkColor = new Color(120, 88, 38, 255);

    @property({ type: Color, tooltip: '中央纹章占位图样颜色（后续由纹章系统替换成真实图标）' })
    emblemColor = new Color(168, 146, 102, 255);

    // ====================== 编辑器预览 ======================
    @property({ tooltip: '编辑器内实时预览：改参数立即重排（与 BattleFieldLayout / HeroArea 同一约定）' })
    previewInEditor = true;

    // ====================== 内部 ======================
    private _sig = '';
    /** 本组件自己管的顶层子节点 —— 不在这张表里的旧节点会被清掉 */
    private static readonly OWNED = ['Crest_0', 'Crest_1', 'Crest_2', 'Crest_3', 'Crest_4'];
    /**
     * 槽位图标子节点的名字（由 `setSlotIcon` 建/管）。
     * 🔴 它现在是一个**容器**：挂 `cc.Mask`(椭圆) + 尺寸 = 圆环内径，
     *    真正显示纹章贴图的是它的子节点 `CrestIconImg`（同名尺寸）。
     *    这样方形纹章图会被裁掉四个角、看起来就是圆的。
     */
    private static readonly ICON = 'CrestIcon';
    /** 纹章贴图子节点名（`CrestIcon` 容器的唯一子节点） */
    private static readonly ICON_IMG = 'CrestIconImg';
    /** ★ 吟唱角标节点名（纹章图标右下角的数字） */
    private static readonly CHANT = 'CrestChantBadge';
    /** 特效层节点名（「可发动」波纹；必须是本节点**最后一个子节点**，见 `ensureFxLayer`） */
    private static readonly FX_LAYER = 'CrestFx';
    /** 已经被纹章图标占用的槽位 —— 重绘时不再画中央菱形占位图样 */
    private readonly _occupied = new Set<number>();

    // ====================== 对外 API（纹章系统调用）======================
    /** 槽位数量（＝节点名 Crest_0 ~ Crest_4） */
    public get slotCount(): number {
        return CrestArea.OWNED.length;
    }

    /** 单个圆圈的**实际直径**（含 sizeScale） */
    public get slotDiameter(): number {
        return Math.max(20, this.circleSize) * Math.max(0.05, this.sizeScale);
    }

    /** 金环的线宽（与 `drawCrest` 同一口径，供内径换算复用） */
    public ringThickness(diameter = this.slotDiameter): number {
        return Math.max(1.5, Math.max(20, diameter) * 0.045);
    }

    /**
     * 圆环**内径** = 纹章图标「正好填满圆圈上下左右」时的直径。
     * 🔴 这是 `setSlotIcon(ratio = 1)` 的基准：图标 = 内径 × ratio，
     *    方形图的外接正方形四边正好贴住圆环内缘，四个角由椭圆 Mask 裁掉。
     */
    public get slotInnerDiameter(): number {
        const d = this.slotDiameter;
        return Math.max(8, d - 2 * this.ringThickness(d));
    }

    /** 取某个槽位节点（越界返回 null） */
    public getSlot(index: number): Node | null {
        if (!(index >= 0) || index >= CrestArea.OWNED.length) return null;
        return this.node.getChildByName(CrestArea.OWNED[index]);
    }

    /**
     * 往某个槽位放 / 清纹章图标。
     * @param index 槽位序号（0 = Crest_0，与「获得顺序」一一对应）
     * @param sf    纹章 SpriteFrame；null = 清空该槽（恢复中央菱形占位图样）
     * @param ratio 图标直径 ÷ **圆环内径**（1 = 正好填满圆圈：上下左右贴住环内缘，
     *              方形图的四角由椭圆 Mask 裁掉；< 1 则等比例缩小）
     * @returns 是否成功
     */
    /**
     * ★ **纹章图标的吟唱角标**（需求：像护符的吟唱一样，在纹章图标上显示当前吟唱数）。
     * `n <= 0` ⇒ 隐藏角标。位置 = 槽位右下角（与例图一致），字号随槽位直径走。
     */
    public setSlotChant(index: number, n: number): boolean {
        const slot = this.getSlot(index);
        if (!slot) return false;
        let badge = slot.getChildByName(CrestArea.CHANT);
        const count = Math.max(0, Math.floor(Number(n) || 0));
        if (count <= 0) {
            if (badge) badge.active = false;
            return true;
        }
        if (!badge) {
            badge = new Node(CrestArea.CHANT);
            badge.layer = slot.layer;
            badge.setParent(slot);
            const ut = badge.addComponent(UITransform);
            const d = this.slotDiameter;
            ut.setAnchorPoint(0.5, 0.5);
            ut.setContentSize(d * 0.62, d * 0.62);
            const lb = badge.addComponent(Label) as Label;
            lb.string = String(count);
            lb.fontSize = Math.round(d * 0.46);
            lb.lineHeight = Math.round(d * 0.5);
            lb.isBold = true;
            lb.color = new Color(255, 250, 226, 255);
            lb.enableOutline = true;
            lb.outlineColor = new Color(28, 20, 12, 255);
            lb.outlineWidth = Math.max(2, Math.round(d * 0.045));
            lb.horizontalAlign = Label.HorizontalAlign.CENTER;
            lb.verticalAlign = Label.VerticalAlign.CENTER;
            badge.setPosition(d * 0.34, -d * 0.34, 0);
        }
        const lb2 = badge.getComponent(Label);
        if (lb2) lb2.string = String(count);
        badge.active = true;
        return true;
    }

    public setSlotIcon(index: number, sf: SpriteFrame | null, ratio = 1): boolean {
        const slot = this.getSlot(index);
        if (!slot) return false;
        if (sf) this._occupied.add(index);
        else this._occupied.delete(index);

        let icon = slot.getChildByName(CrestArea.ICON);
        if (!sf) {
            if (icon) icon.active = false;
        } else {
            if (!icon) icon = this.buildIconNode(slot);
            const d = this.slotInnerDiameter * Math.max(0.1, ratio);
            const sp = this.iconSpriteOf(icon);
            if (sp) sp.spriteFrame = sf;
            const iut = icon.getComponent(UITransform);
            if (iut) iut.setContentSize(d, d);
            const mut = icon.getChildByName(CrestArea.ICON_IMG)?.getComponent(UITransform);
            if (mut) mut.setContentSize(d, d);          // 贴图 = 容器大小 ⇒ 四角被椭圆裁掉
            icon.setPosition(0, 0, 0);
            icon.active = true;
        }

        // 重画该槽位：占位菱形只在「没有纹章」时画
        const g = slot.getComponent(Graphics);
        if (g) {
            g.clear();
            this.drawCrest(g, this.slotDiameter, this._occupied.has(index));
        }
        return true;
    }

    /** 取槽位图标的 Sprite —— 在容器（`CrestIcon`）的贴图子节点上 */
    private iconSpriteOf(icon: Node): Sprite | null {
        const img = icon.getChildByName(CrestArea.ICON_IMG);
        return img ? img.getComponent(Sprite) : null;
    }

    /**
     * 建「纹章图标」节点结构（首次放纹章时建一次）：
     *
     *   Crest_<i>
     *   └── CrestIcon      ← cc.Mask（GRAPHICS_ELLIPSE 椭圆裁剪）+ UITransform = 圆环内径
     *       └── CrestIconImg ← cc.Sprite（与容器同尺寸的**方形**贴图 → 四角被裁掉成圆形）
     *
     * 🔴 为什么必须有 Mask：纹章素材（如 `crest/4.png`）是**不透明方形图**，
     *    只放大到填满圆圈而不裁剪的话，四个角会盖在金环上。
     * 🔴 Mask 的椭圆 = 其 UITransform 矩形的**内切椭圆** ⇒ 容器做成正方形即可。
     */
    private buildIconNode(slot: Node): Node {
        const icon = new Node(CrestArea.ICON);
        icon.layer = slot.layer;                       // 🔴 继承宿主 layer（UI_2D 否则会被相机剔除）
        slot.addChild(icon);
        const iut = icon.addComponent(UITransform);
        iut.setAnchorPoint(0.5, 0.5);
        const mask = icon.addComponent(Mask);
        mask.type = Mask.Type.GRAPHICS_ELLIPSE;        // 圆形裁剪（方形图 → 圆）

        const img = new Node(CrestArea.ICON_IMG);
        img.layer = slot.layer;
        icon.addChild(img);
        const mut = img.addComponent(UITransform);
        mut.setAnchorPoint(0.5, 0.5);
        const sp = img.addComponent(Sprite);
        sp.type = Sprite.Type.SIMPLE;
        sp.sizeMode = Sprite.SizeMode.CUSTOM;           // 🔴 自己控尺寸（TRIMMED 会按裁剪框改写）
        sp.trim = false;
        img.setPosition(0, 0, 0);
        return icon;
    }

    /** 某槽位是否已被纹章占用 */
    public hasSlotIcon(index: number): boolean {
        return this._occupied.has(index);
    }

    /** 清掉全部纹章图标（重开对局用） */
    public clearAllSlotIcons(): void {
        for (let i = 0; i < CrestArea.OWNED.length; i++) this.setSlotIcon(i, null);
        this.clearSlotRipples();
    }

    // ====================== 特效层（「可发动」波纹） ======================
    /**
     * 取（或建）**特效层**节点 —— 纹章「可发动」波纹等特效都挂在这里。
     *
     * 🔴 它必须是本节点的**最后一个子节点**：槽位 `Crest_0 ~ Crest_4` 是按兄弟序号
     *    0~4 渲染的，特效层排在它们之后 → 波纹往外扩、压到相邻圆框上时
     *    **不会被那些纹章框盖住**（需求：波纹不能被别的纹章框「吃掉」）。
     * 🔴 它也不在任何 `cc.Mask` 之下（Mask 只挂在槽位内部的 `CrestIcon` 上），
     *    所以不会被纹章图标那层椭圆裁剪裁掉。
     */
    public ensureFxLayer(): Node {
        let fx = this.node.getChildByName(CrestArea.FX_LAYER);
        if (!fx || !fx.isValid) {
            fx = new Node(CrestArea.FX_LAYER);
            fx.layer = this.node.layer;              // 🔴 继承宿主 layer（UI_2D 否则会被相机剔除）
            this.node.addChild(fx);
        }
        const ut = fx.getComponent(UITransform) || fx.addComponent(UITransform);
        ut.setAnchorPoint(0.5, 0.5);
        ut.setContentSize(this.slotDiameter * 6, this.slotDiameter * 6);   // 够画扩出去的波纹
        fx.setPosition(0, 0, 0);
        const last = this.node.children.length - 1;
        if (fx.getSiblingIndex() !== last) fx.setSiblingIndex(last);
        return fx;
    }

    /** 某槽位中心（本节点局部坐标）；槽位不存在返回 null */
    public slotLocalPosition(index: number): { x: number; y: number } | null {
        const slot = this.getSlot(index);
        return slot ? { x: slot.position.x, y: slot.position.y } : null;
    }

    /**
     * 开关某槽位的「**可发动**」波纹（由 `CrestSystem` 按效果的可发动判定驱动）。
     * @param index 槽位序号
     * @param on    是否亮波纹
     * @param cfg   波纹参数（权威值在 `CrestSystem` 的 Inspector 上）—— 传了就同步一次
     */
    public setSlotRipple(index: number, on: boolean, cfg?: Partial<CrestRippleConfig>): void {
        const pos = this.slotLocalPosition(index);
        if (!pos) return;
        const fx = this.ensureFxLayer();
        const comp = fx.getComponent(CrestRipple) || fx.addComponent(CrestRipple);
        if (cfg) comp.applyConfig(cfg);
        comp.setSlot({
            index,
            x: pos.x,
            y: pos.y,
            radius: this.slotDiameter / 2,          // 从圆框外缘开始往外扩
            on: on === true,
        });
    }

    /** 熄灭全部波纹（重开对局 / 组件关闭 / 纹章清空） */
    public clearSlotRipples(): void {
        const fx = this.node.getChildByName(CrestArea.FX_LAYER);
        const comp = fx && fx.isValid ? fx.getComponent(CrestRipple) : null;
        if (comp && comp.isValid) comp.clearSlots();
    }

    /** 当前亮着波纹的槽位数（调试 / 探针用） */
    public get rippleCount(): number {
        const fx = this.node.getChildByName(CrestArea.FX_LAYER);
        const comp = fx && fx.isValid ? fx.getComponent(CrestRipple) : null;
        return comp && comp.isValid ? comp.activeCount : 0;
    }

    // ------------------------------ 生命周期 ------------------------------
    onLoad(): void { this.rebuild(); }
    onEnable(): void { this.rebuild(); }

    update(): void {
        if (EDITOR && !this.previewInEditor) return;
        if (this.signature() === this._sig) return;
        this.rebuild();
    }

    // ------------------------------ 构建 ------------------------------
    /** 参数签名：变了才重建（编辑器里逐帧只是拼一次短字符串） */
    private signature(): string {
        const c = (x: Color): string => `${x.r},${x.g},${x.b},${x.a}`;
        return [
            this.side, this.sizeScale, this.circleSize, this.gapRatio, this.rowGapRatio,
            c(this.circleColor), c(this.ringColor), c(this.ringDarkColor), c(this.emblemColor),
        ].join('|');
    }

    private rebuild(): void {
        // 【整体大小】敌我共享：把本实例的 sizeScale 同步给场景里的其它 CrestArea
        // （对方实例自己的 update 检测到签名变化会重建；值相同则不写，无递归）。
        this.propagateScale();

        const scale = Math.max(0.05, this.sizeScale);
        const D = Math.max(20, this.circleSize) * scale;          // 圆圈直径
        const gapX = D * Math.max(0, this.gapRatio);              // 同排水平间距
        const rowDy = D * (1 + Math.max(0, this.rowGapRatio)) / 2; // 排心到区域中心的垂直距离

        const ut = this.getComponent(UITransform) || this.addComponent(UITransform);
        ut.setAnchorPoint(0.5, 0.5);
        ut.setContentSize(new Size(3 * D + 2 * gapX, 2 * D + D * Math.max(0, this.rowGapRatio)));

        // 靠屏幕外的一排 3 个，内排 2 个错位居中；
        // 🔴 敌方 = 我方的上下颠倒镜像 → 3 个的一排换边。
        const threeY = this.side === CrestSide.Player ? -rowDy : rowDy;
        const twoY = -threeY;
        // 🔴 槽位编号 = 节点名（Crest_0 ~ Crest_4），按下表落位：
        //   · 我方：3 个的一排（靠下）**从左到右** 0,1,2；2 个的一排（靠上）**从左到右** 3,4；
        //   · 敌方：3 个的一排（靠上）**从右到左** 0,1,2；2 个的一排（靠下）**从右到左** 3,4。
        const rev = this.side === CrestSide.Enemy;
        const x3 = rev ? [D + gapX, 0, -D - gapX] : [-D - gapX, 0, D + gapX];
        const x2 = rev ? [(D + gapX) / 2, -(D + gapX) / 2] : [-(D + gapX) / 2, (D + gapX) / 2];

        let i = 0;
        for (const x of x3) this.slot(i++, x, threeY, D);
        for (const x of x2) this.slot(i++, x, twoY, D);

        this.pruneStale();
        this._sig = this.signature();
    }

    /** 【整体大小】同步给场景里其它 CrestArea 实例（敌我共享一个变量）。 */
    private propagateScale(): void {
        const scene = this.node.scene;
        if (!scene) return;
        const stack: Node[] = [...scene.children];
        while (stack.length > 0) {
            const n = stack.shift() as Node;
            const c = n.getComponent(CrestArea);
            if (c && c !== this && c.isValid && Math.abs(c.sizeScale - this.sizeScale) > 1e-6) {
                c.sizeScale = this.sizeScale;
            }
            for (const ch of n.children) stack.push(ch);
        }
    }

    /** 取（或建）槽位节点并固定兄弟序号 —— 保证渲染层级稳定 */
    private slot(index: number, x: number, y: number, D: number): void {
        const name = 'Crest_' + index;
        let n = this.node.getChildByName(name);
        if (!n) {
            n = new Node(name);
            this.node.addChild(n);
        }
        if (n.getSiblingIndex() !== index) n.setSiblingIndex(index);
        const ut = n.getComponent(UITransform) || n.addComponent(UITransform);
        ut.setAnchorPoint(0.5, 0.5);
        ut.setContentSize(new Size(D, D));
        n.setPosition(x, y, 0);

        const g = n.getComponent(Graphics) || n.addComponent(Graphics);
        g.clear();
        this.drawCrest(g, D, this._occupied.has(index));
    }

    /**
     * 单个纹章圆圈（例图风格）：
     *   暗蓝黑底盘 → 暗金底环 → 亮金环面 → 内侧细环 →（未被纹章占用时）中央菱形占位。
     * @param occupied true = 该槽位已有纹章图标 → **不画**中央菱形占位图样
     */
    private drawCrest(g: Graphics, D: number, occupied = false): void {
        const r = D / 2;
        const t = this.ringThickness(D);             // 环厚（与 slotInnerDiameter 同一口径）

        // ① 底盘（暗蓝黑）
        g.fillColor = this.circleColor;
        g.circle(0, 0, r - t * 0.5);
        g.fill();

        // ② 暗金底环
        g.lineWidth = t;
        g.strokeColor = this.ringDarkColor;
        g.circle(0, 0, r - t / 2);
        g.stroke();

        // ③ 亮金环面（略内缩 → 露出暗金边做金属立体感，与 HeroArea 金环同一手法）
        g.lineWidth = t * 0.6;
        g.strokeColor = this.ringColor;
        g.circle(0, 0, r - t / 2);
        g.stroke();

        // ④ 内侧细环（纹章图的边界参考线）
        g.lineWidth = Math.max(1, D * 0.012);
        g.strokeColor = this.ringColor;
        g.circle(0, 0, r * 0.62);
        g.stroke();

        // ⑤ 中央纹章占位（小菱形；已有真实纹章图标时跳过）
        if (occupied) return;
        const s = r * 0.16;
        g.fillColor = this.emblemColor;
        g.moveTo(0, s);
        g.lineTo(s, 0);
        g.lineTo(0, -s);
        g.lineTo(-s, 0);
        g.close();
        g.fill();
    }

    /**
     * 清掉**不再属于本组件**的顶层子节点（改名 / 删除过的旧结构残留）。
     * 先脱离父节点再 destroy —— destroy 是延迟销毁，留在原地会同名重建成同一个节点。
     */
    private pruneStale(): void {
        const kids = this.node.children.slice();
        for (const n of kids) {
            if (!n || !n.isValid) continue;
            if (CrestArea.OWNED.indexOf(n.name) >= 0) continue;
            if (n.name === CrestArea.FX_LAYER) continue;    // 🔴 特效层不是「槽位」，别清掉
            n.removeFromParent();
            n.destroy();
        }
    }
}
