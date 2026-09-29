import {
    _decorator, Color, Component, Enum, Label, LabelOutline, Node, Size, Sprite, SpriteFrame, UITransform,
} from 'cc';
import { EDITOR } from 'cc/env';

const { ccclass, property, requireComponent, executeInEditMode, menu } = _decorator;

/** 进化点种类：普通进化点（金）/ 超进化点（紫） */
export enum EvoPointKind {
    EP = 0,
    SEP = 1,
}
Enum(EvoPointKind);

/**
 * EvoPointBadge —— 单枚「进化点徽记」（我方 / 敌方各两枚：左金 = 普通进化点，右紫 = 超进化点）
 * ===========================================================================
 * 挂在 HeroArea 的 `EvoEP` / `EvoSEP` 节点上（由 HeroArea 下发尺寸与位置）。
 * 本组件**自己 build 全部子节点**（与 HeroArea / TurnControlPanel 同一套路）：
 *
 *   EvoEP                    ← 本节点（UITransform = badgeSize × badgeSize）
 *   ├── Glow    cc.Sprite（外光晕，解禁且未使用时显示）
 *   ├── Disk    cc.Sprite（内盘：未解禁=暗盘 / 已解禁=发光球）
 *   ├── Ring    cc.Sprite（外圆环，染色区分金 / 紫 / 灰）
 *   ├── Dots    cc.Node
 *   │    ├── Dot0 / Dot1 ...  cc.Sprite（剩余次数菱形，用完的变暗）
 *   └── Num     cc.Label（倒计时数字；解禁后隐藏）
 *
 * 🔴 三种视觉状态（参考实机例图）：
 *   ① **未解禁**（countdown > 0）：环 = 类型色，内盘 = 暗盘，显示倒计时数字，菱形全亮
 *   ② **已解禁未使用**（countdown = 0 且 remaining = maxCount）：环 = 类型色 + 外光晕，
 *      内盘 = 发光球，数字隐藏，菱形全亮
 *   ③ **已使用过**（remaining < maxCount）：环 = 灰色，内盘 = 暗盘，数字隐藏，
 *      已用掉的菱形变暗（剩余菱形仍是类型色）
 * ===========================================================================
 */
@ccclass('EvoPointBadge')
@requireComponent(UITransform)
@executeInEditMode(true)
@menu('gf2szb/EvoPointBadge')
export class EvoPointBadge extends Component {

    // ====================== 基本身份 ======================

    @property({ type: Enum(EvoPointKind), tooltip: '进化点种类：\nEP = **普通进化点**（金色，左）；\nSEP = **超进化点**（紫色，右）。' })
    kind: EvoPointKind = EvoPointKind.EP;

    @property({ tooltip: '所属方（仅用于识别 / 调试）：player = 我方，enemy = 敌方' })
    sideLabel = 'player';

    // ====================== 状态（由 EvoPointSystem 写入）======================

    @property({ tooltip: '**解禁倒计时**（回合数）：\n> 0 = 尚未解禁（显示数字，不可拖动使用）；\n<= 0 = 已解禁（数字隐藏，可拖动使用）。' })
    countdown = 5;

    @property({ tooltip: '**剩余可用次数**（0 ~ maxCount）。用一次减一，菱形相应变暗。' })
    remaining = 2;

    @property({ tooltip: '总次数（参考例图 = 2，对应两颗菱形）' })
    maxCount = 2;

    // ====================== 尺寸 ======================

    @property({ range: [24, 200, 1], slide: true, tooltip: '徽记直径（px）。\n由 HeroArea 按 `badgeSize × frameSize` 下发；独立使用时可手动填。' })
    badgeSize = 88;

    // ====================== 素材 ======================

    @property({ type: SpriteFrame, tooltip: '外圆环素材（灰阶，靠节点色染成金 / 紫 / 灰）' })
    sfRing: SpriteFrame | null = null;

    @property({ type: SpriteFrame, tooltip: '未解禁内盘素材（暗盘 + 中心菱形暗纹）' })
    sfDisk: SpriteFrame | null = null;

    @property({ type: SpriteFrame, tooltip: '已解禁内盘素材（发光球）' })
    sfDiskGlow: SpriteFrame | null = null;

    @property({ type: SpriteFrame, tooltip: '外光晕素材（径向衰减，解禁时显示）' })
    sfGlow: SpriteFrame | null = null;

    @property({ type: SpriteFrame, tooltip: '剩余次数菱形素材' })
    sfDiamond: SpriteFrame | null = null;

    // ====================== 布局比例（全部 ÷ badgeSize）======================

    @property({ range: [0.5, 1.4, 0.01], slide: true, tooltip: '圆环节点尺寸 ÷ badgeSize' })
    ringRatio = 1.0;

    @property({ range: [0.4, 1.3, 0.01], slide: true, tooltip: '内盘节点尺寸 ÷ badgeSize' })
    diskRatio = 0.99;

    @property({ range: [0.6, 2.4, 0.01], slide: true, tooltip: '外光晕直径 ÷ badgeSize' })
    glowRatio = 1.52;

    @property({ range: [0.05, 0.6, 0.001], slide: true, tooltip: '菱形**宽** ÷ badgeSize' })
    diamondRatio = 0.22;

    @property({ range: [0, 0.6, 0.005], slide: true, tooltip: '菱形横向间距（单侧偏移）÷ badgeSize' })
    diamondSpread = 0.14;

    @property({ range: [-0.6, 0.2, 0.005], slide: true, tooltip: '菱形中心纵向位置 ÷ badgeSize（负 = 在圆心下方）' })
    diamondOffsetY = -0.12;

    @property({
        range: [0.1, 1, 0.005], slide: true,
        tooltip: '倒计时数字字号 ÷ badgeSize。\n'
            + '🔴 运行时由 `EvoPointSystem.numFontRatio` **统一覆盖**（一处改四枚同时变）——\n'
            + '只有当场景里找不到 EvoPointSystem 时，这里的值才生效。',
    })
    numFontRatio = 0.54;

    @property({
        range: [-0.4, 0.4, 0.005], slide: true,
        tooltip: '数字**横向**偏移 ÷ badgeSize（正 = 向右）。同理由 `EvoPointSystem.numOffsetX` 统一覆盖。',
    })
    numOffsetX = 0;

    @property({
        range: [-0.4, 0.4, 0.005], slide: true,
        tooltip: '数字**纵向**偏移 ÷ badgeSize（正 = 向上）。同理由 `EvoPointSystem.numOffsetY` 统一覆盖。',
    })
    numOffsetY = 0.03;

    @property({ tooltip: '数字字体（与 PP / 血量同一套 Georgia 衬线数字）' })
    numFontFamily = 'Georgia';

    // ====================== 配色 ======================

    @property({ type: Color, tooltip: '普通进化点主色（金）—— 环 / 发光球 / 剩余菱形' })
    epColor = new Color(242, 199, 92, 255);

    @property({ type: Color, tooltip: '超进化点主色（紫）' })
    sepColor = new Color(176, 140, 255, 255);

    @property({ type: Color, tooltip: '**已使用过**之后环的颜色（银灰）—— 参考例图用过后整圈变灰' })
    usedColor = new Color(168, 168, 178, 255);

    @property({ type: Color, tooltip: '未解禁 / 已使用时的内盘颜色（暗）' })
    diskColor = new Color(58, 58, 68, 255);

    @property({ type: Color, tooltip: '已经用掉的那颗菱形颜色（暗）' })
    diamondOffColor = new Color(74, 74, 84, 255);

    @property({ type: Color, tooltip: '倒计时数字颜色' })
    numColor = new Color(255, 255, 255, 255);

    @property({ type: Color, tooltip: '倒计时数字描边色' })
    numOutlineColor = new Color(12, 12, 18, 220);

    @property({ range: [0, 1, 0.01], slide: true, tooltip: '外光晕的不透明度系数（解禁态）' })
    glowAlpha = 0.75;

    @property({ tooltip: '编辑器内实时预览（改参数立即重排）' })
    previewInEditor = true;

    // ====================== 内部 ======================
    private _sig = '';
    private static readonly OWNED = ['Glow', 'Disk', 'Ring', 'Dots', 'Num'];

    // ------------------------------ 生命周期 ------------------------------
    onLoad(): void { this.rebuild(); }
    onEnable(): void { this.rebuild(); }

    update(): void {
        if (EDITOR && !this.previewInEditor) return;
        if (this.signature() === this._sig) return;
        this.rebuild();
    }

    // ------------------------------ 对外 API ------------------------------

    /** 写入状态（解禁倒计时 + 剩余次数）。由 EvoPointSystem 在对局开始 / 回合开始 / 使用后调用。 */
    public applyState(countdown: number, remaining: number): void {
        const c = Math.max(0, Math.round(countdown));
        const r = Math.max(0, Math.min(this.maxCount, Math.round(remaining)));
        if (this.countdown === c && this.remaining === r) return;
        this.countdown = c;
        this.remaining = r;
        this.rebuild();
    }

    /** 是否已解禁（= 可以拖动使用） */
    public get isUnlocked(): boolean { return this.countdown <= 0; }

    /** 是否还有剩余次数 */
    public get hasStock(): boolean { return this.remaining > 0; }

    /** 是否当前可用（解禁 + 还有次数） */
    public get isUsable(): boolean { return this.isUnlocked && this.hasStock; }

    /** 由 HeroArea 下发尺寸（frameSize × badgeSize），并刷新显示。 */
    public applyLayout(size: number, kind?: EvoPointKind, sideLabel?: string): void {
        if (kind !== undefined) this.kind = kind;
        if (sideLabel !== undefined) this.sideLabel = sideLabel;
        this.badgeSize = Math.max(12, size);
        this.rebuild();
    }

    /**
     * 由 `EvoPointSystem` 下发的**统一数字样式**（字号 / 偏移）。
     * 🔴 四枚徽记共用同一套值 ⇒ 在 `EvoPointSystem` 上改一次，四枚一起变。
     */
    public applyNumStyle(fontRatio: number, offX: number, offY: number): void {
        if (this.numFontRatio === fontRatio && this.numOffsetX === offX && this.numOffsetY === offY) return;
        this.numFontRatio = fontRatio;
        this.numOffsetX = offX;
        this.numOffsetY = offY;
        this.rebuild();
    }

    // ------------------------------ 构建 ------------------------------

    private signature(): string {
        const c = (x: Color): string => `${x.r},${x.g},${x.b},${x.a}`;
        return [
            this.kind, this.countdown, this.remaining, this.maxCount, this.badgeSize,
            this.sfRing ? this.sfRing.uuid : '-', this.sfDisk ? this.sfDisk.uuid : '-',
            this.sfDiskGlow ? this.sfDiskGlow.uuid : '-', this.sfGlow ? this.sfGlow.uuid : '-',
            this.sfDiamond ? this.sfDiamond.uuid : '-',
            this.ringRatio, this.diskRatio, this.glowRatio, this.diamondRatio, this.diamondSpread,
            this.diamondOffsetY, this.numFontRatio, this.numOffsetX, this.numOffsetY,
            this.numFontFamily, this.glowAlpha,
            c(this.epColor), c(this.sepColor), c(this.usedColor), c(this.diskColor),
            c(this.diamondOffColor), c(this.numColor), c(this.numOutlineColor),
        ].join('|');
    }

    /** 取（或建）子节点并固定兄弟序号 —— 渲染层级 = 兄弟序 */
    private nodeOf(parent: Node, name: string, index: number): Node {
        let n = parent.getChildByName(name);
        if (!n) {
            n = new Node(name);
            parent.addChild(n);
        }
        if (n.getSiblingIndex() !== index) n.setSiblingIndex(index);
        let ut = n.getComponent(UITransform);
        if (!ut) ut = n.addComponent(UITransform);
        ut.setAnchorPoint(0.5, 0.5);
        return n;
    }

    /** 取（或建）Sprite，统一 SIMPLE + CUSTOM（🔴 CUSTOM 才能自己控尺寸，否则被 trim 尺寸改写） */
    private spriteOf(parent: Node, name: string, index: number): Sprite {
        const n = this.nodeOf(parent, name, index);
        const sp = n.getComponent(Sprite) || n.addComponent(Sprite);
        sp.type = Sprite.Type.SIMPLE;
        sp.sizeMode = Sprite.SizeMode.CUSTOM;
        return sp;
    }

    private setSprite(sp: Sprite, sf: SpriteFrame | null, size: number, color: Color, aspect = 1): void {
        const n = sp.node;
        sp.spriteFrame = sf;
        const ut = n.getComponent(UITransform) as UITransform;
        ut.setContentSize(new Size(size, size * aspect));
        sp.color = color;
        n.active = !!sf;
    }

    private rebuild(): void {
        const S = Math.max(12, this.badgeSize);
        const ut = this.getComponent(UITransform) || this.addComponent(UITransform);
        ut.setAnchorPoint(0.5, 0.5);
        ut.setContentSize(new Size(S, S));

        const unlocked = this.countdown <= 0;
        const used = this.remaining < this.maxCount;
        const lit = unlocked && !used;
        const base = this.kind === EvoPointKind.EP ? this.epColor : this.sepColor;
        const ringTint = used ? this.usedColor : base;

        // ① 外光晕（解禁且未使用）
        const glow = this.spriteOf(this.node, 'Glow', 0);
        const glowCol = new Color(base.r, base.g, base.b, Math.round(255 * Math.max(0, Math.min(1, this.glowAlpha))));
        this.setSprite(glow, lit ? this.sfGlow : null, S * this.glowRatio, glowCol);
        glow.node.setPosition(0, 0, 0);

        // ② 内盘：解禁未使用 = 发光球（类型色），否则 = 暗盘
        const disk = this.spriteOf(this.node, 'Disk', 1);
        this.setSprite(
            disk,
            lit ? (this.sfDiskGlow || this.sfDisk) : this.sfDisk,
            S * this.diskRatio,
            lit ? base : this.diskColor,
        );
        disk.node.setPosition(0, 0, 0);

        // ③ 外圆环
        const ring = this.spriteOf(this.node, 'Ring', 2);
        this.setSprite(ring, this.sfRing, S * this.ringRatio, ringTint);
        ring.node.setPosition(0, 0, 0);

        // ④ 剩余次数菱形
        const dots = this.nodeOf(this.node, 'Dots', 3);
        dots.getComponent(UITransform)!.setContentSize(new Size(S, S));
        dots.setPosition(0, 0, 0);
        const dw = S * this.diamondRatio;
        const dh = dw * 1.571;                     // 素材 112 × 176
        const spread = S * this.diamondSpread;
        const dy = S * this.diamondOffsetY;
        const dotNodes: Node[] = [];
        for (let i = 0; i < this.maxCount; i++) {
            const isLeft = i % 2 === 0;
            const slot = Math.floor(i / 2);
            const x = (isLeft ? -1 : 1) * (spread + slot * dw * 1.15);
            const d = this.spriteOf(dots, 'Dot' + i, i);
            const on = i < this.remaining;
            const col = on ? base : this.diamondOffColor;
            this.setSprite(d, this.sfDiamond, dw, col, dh / dw);
            d.node.setPosition(x, dy, 0);
            dotNodes.push(d.node);
        }
        // 多出来的旧菱形（maxCount 调小时）关掉
        for (const ch of dots.children) {
            const m = /^Dot(\d+)$/.exec(ch.name);
            if (m && Number(m[1]) >= this.maxCount) ch.active = false;
        }

        // ⑤ 倒计时数字（解禁后隐藏）
        const num = this.nodeOf(this.node, 'Num', 4);
        const nut = num.getComponent(UITransform) as UITransform;
        const showNum = !unlocked;
        num.active = showNum;
        if (showNum) {
            const lb = num.getComponent(Label) || num.addComponent(Label);
            lb.string = String(Math.max(0, Math.round(this.countdown)));
            lb.useSystemFont = true;
            lb.fontFamily = this.numFontFamily;
            lb.fontSize = Math.max(8, Math.round(S * this.numFontRatio));
            lb.lineHeight = Math.round(lb.fontSize * 1.05);
            lb.horizontalAlign = Label.HorizontalAlign.CENTER;
            lb.verticalAlign = Label.VerticalAlign.CENTER;
            lb.overflow = Label.Overflow.SHRINK;    // 🔴 先 SHRINK 再设尺寸，反序会被冲掉
            nut.setContentSize(new Size(S * 0.9, S * 0.9));
            lb.color = this.numColor;
            num.setPosition(S * this.numOffsetX, S * this.numOffsetY, 0);
            const ol = num.getComponent(LabelOutline) || num.addComponent(LabelOutline);
            ol.color = this.numOutlineColor;
            ol.width = Math.max(1, Math.round(S * 0.045));
        }

        this.pruneStale();
        this._sig = this.signature();
    }

    /** 清掉不属于本组件的顶层子节点（历史结构残留） */
    private pruneStale(): void {
        const kids = this.node.children.slice();
        for (const n of kids) {
            if (!n || !n.isValid) continue;
            if (EvoPointBadge.OWNED.indexOf(n.name) >= 0) continue;
            n.removeFromParent();
            n.destroy();
        }
    }
}
