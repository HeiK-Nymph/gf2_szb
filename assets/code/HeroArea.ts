import {
    _decorator, Color, Component, Enum, Graphics, Label, Mask, Node, Size, Sprite, SpriteFrame,
    UITransform, Vec3,
} from 'cc';
import { EDITOR } from 'cc/env';
import { recordNumber } from './DamageNumberQueue';
import { applyBattleValueOutline, BATTLE_VALUE_GREEN, BATTLE_VALUE_RED } from './BattleValueStyle';
import { EvoPointBadge, EvoPointKind } from './EvoPointBadge';

const { ccclass, property, executeInEditMode, requireComponent, menu } = _decorator;

/** 主战者归属：Player = 我方（画面下方）；Enemy = 敌方（画面上方） */
export enum HeroSide {
    Player = 0,
    Enemy = 1,
}
Enum(HeroSide);

/**
 * HeroArea —— 主战者区域（我方 / 敌方各一个）
 * ===========================================================================
 * 参照实机例图的「敌我主战部分」：一个圆形华丽头像框、人物居中，框外一侧两个
 * 圆形徽记槽（敌我上下镜像），右侧一枚红色盾牌显示主战者血量。
 *
 * 本组件**自己 build 全部子节点**（与 TestConsole / TurnControlPanel 同一套路）：
 * 场景里只需要一个空节点 + 本组件，改 Inspector 参数即实时重排（@executeInEditMode）。
 *
 *   HeroArea            ← 本节点（UITransform = frameSize × frameSize）
 *   ├── FrameBack       cc.Graphics（暗红内底盘 —— 🔴 必须在 Portrait **之前**）
 *   ├── Portrait        cc.Mask(ELLIPSE) 圆形取景窗，尺寸 = 金环内径
 *   │     └── Art       cc.Sprite（人物立绘）
 *   ├── FrameRing       cc.Graphics（金属圆环：暗金底环 + 亮金环面 + 内侧细高光）
 *   ├── EvoEP           EvoPointBadge（左徽记槽 = **普通进化点**，金色）
 *   ├── EvoSEP          EvoPointBadge（右徽记槽 = **超进化点**，紫色）
 *   └── Hp              cc.Graphics（红色盾牌 + 金边）
 *         └── HpText     cc.Label（满血绿色 / 受伤红色衬线数字）
 *
 *   🔴 渲染序 = 兄弟序。底盘必须排在取景窗**前面**，否则那块暗红圆盘会把人物
 *     整个盖掉（人物确实在渲染，只是被上一层的不透明圆盖住了 —— 本组件首版踩过）。
 *
 * 位置约定（对照例图实测，全部是 frameSize 的比例 ⇒ 改一个值整体等比缩放）：
 *   · 敌方主战者在**画面上缘居中**（圆心压在上边缘 → 上半被裁，只露下半）；
 *   · 我方主战者在**画面下缘居中**（圆心压在下边缘 → 下半被裁）；
 *   · 血量盾牌在头像框**右侧**，且纵向**朝屏幕中心**（我方朝上、敌方朝下）；
 *   · 两个徽记槽同理镜像（我方在框顶，敌方在框底）。
 *
 * 人物取景：`focusX / focusY` 是「**原图**里的归一化取景点」（0..1，y 从**上**往下）。
 *   组件用 SpriteFrame 自带的 rect + offset 把该点平移到圆窗中心 ⇒ 不吃 Cocos 的
 *   alpha 自动裁剪（trim），换人物图不用改任何常数（详见 buildPortrait 注释）。
 * ===========================================================================
 */
@ccclass('HeroArea')
@executeInEditMode(true)
@requireComponent(UITransform)
@menu('gf2szb/HeroArea')
export class HeroArea extends Component {

    // ====================== 归属 & 血量 ======================
    @property({
        type: Enum(HeroSide),
        tooltip: '主战者归属：\n'
            + 'Player = 我方（框在画面下方，徽记槽在框顶，血量盾朝上）；\n'
            + 'Enemy  = 敌方（框在画面上方，徽记槽在框底，血量盾朝下）。\n'
            + '只影响镜像方向，不影响尺寸。',
    })
    side: HeroSide = HeroSide.Player;

    @property({ tooltip: '主战者血量 —— 显示在右侧红盾上的那个数字' })
    hp = 20;

    @property({ tooltip: '主战者最大血量。血量达到该值时数字显示为满血绿色，否则显示受伤红色。' })
    maxHp = 20;

    // ====================== 尺寸（全部相对 frameSize 等比）======================
    @property({
        range: [80, 600, 1], slide: true,
        tooltip: '头像框**外径**（px）。所有尺寸与偏移都按它等比推导 —— 改这一个值整体缩放。',
    })
    frameSize = 280;

    @property({ range: [0.01, 0.2, 0.005], slide: true, tooltip: '金环厚度 ÷ frameSize' })
    ringRatio = 0.055;

    // ====================== 人物取景 ======================
    @property({ type: SpriteFrame, tooltip: '人物立绘（SpriteFrame）。默认 assets/image/hero/Groza.png。' })
    portrait: SpriteFrame | null = null;

    @property({
        range: [0.05, 1.5, 0.01], slide: true,
        tooltip: '人物缩放：相对**原图**尺寸的倍率（Groza 原图 2048）。\n'
            + '0.34 → 取景窗内约可见 660 原图像素，正好是「头 + 肩」的胸像范围。',
    })
    portraitScale = 0.34;

    @property({
        range: [0, 1, 0.001], slide: true,
        tooltip: '取景点横向位置（0 = 原图最左，1 = 最右）。0.5 = 水平居中。',
    })
    focusX = 0.488;

    @property({
        range: [0, 1, 0.001], slide: true,
        tooltip: '取景点纵向位置（0 = 原图**最上**，1 = 最下）。\n'
            + '🔴 是从上往下数，且这是「放在圆框正中心」的那个点：\n'
            + '人物是全身立绘、要拍成胸像 → 填人的**脸中心**（Groza 全身图约 0.15）。',
    })
    focusY = 0.15;

    // ====================== 徽记槽（两个圆 = 进化点徽记）======================
    @property({ tooltip: '是否显示头像框上的两个进化点徽记（左金 = 普通进化点，右紫 = 超进化点）' })
    showBadges = true;

    @property({ range: [0, 0.6, 0.005], slide: true, tooltip: '进化点徽记直径 ÷ frameSize（仅在 badgePixelSize = 0 时生效）' })
    badgeSize = 0.26;

    @property({
        range: [0, 240, 1], slide: true,
        tooltip: '进化点徽记的**绝对**直径（px）。\n'
            + '🔴 > 0 时忽略 badgeSize —— 敌我两个 HeroArea 的 frameSize 不同（280 / 223），\n'
            + '用比例口径会让两侧徽记一大一小，故默认按绝对值给尺寸（位置仍随 frameSize 比例）。',
    })
    badgePixelSize = 72;

    @property({ range: [0, 0.6, 0.005], slide: true, tooltip: '徽记槽横向离框心距离 ÷ frameSize' })
    badgeSpread = 0.35;

    @property({ range: [0, 0.8, 0.005], slide: true, tooltip: '徽记槽纵向离框心距离 ÷ frameSize（我方朝上、敌方朝下）' })
    badgeDrop = 0.475;

    /**
     * 徽记位置的**对称微调**（px，绝对值为准，不是 frameSize 比例）。
     *
     * 🔴 这两个字段**不在 Inspector 上**：徽记是「四枚一起调」的，对外只保留一处可调入口 ——
     *    `EvoPointSystem.playerBadgeOffsetX / Y` 与 `enemyBadgeOffsetX / Y`（挂 TurnManager），
     *    由它统一下发到这里（见 `setBadgeOffset`），避免同一个位置有两份可以写歪的数据。
     *
     *   · `badgeOffsetX`：两个徽记**一起往外**分开（EP 左移 X、SEP 右移 X）⇒ 永远左右对称；
     *   · `badgeOffsetY`：两个徽记**一起**沿「朝屏幕中心」方向挪（乘 dir ⇒ 我方上 / 敌方下，两侧镜像）。
     */
    public badgeOffsetX = 0;
    public badgeOffsetY = 0;

    // ====================== 血量盾牌 ======================
    @property({ range: [0.05, 0.4, 0.005], slide: true, tooltip: '血量盾牌**宽** ÷ frameSize（高 = 宽 × shieldAspect）' })
    shieldRatio = 0.14;

    @property({ range: [1, 2, 0.01], slide: true, tooltip: '血量盾牌高宽比（例图约 1.35）' })
    shieldAspect = 1.35;

    @property({ range: [0, 0.9, 0.005], slide: true, tooltip: '盾牌横向离框心距离 ÷ frameSize（正 = 在框右侧）' })
    shieldOffsetX = 0.48;

    @property({ range: [0, 0.9, 0.005], slide: true, tooltip: '盾牌纵向离框心距离 ÷ frameSize（我方朝上、敌方朝下）' })
    shieldOffsetY = 0.23;

    @property({ range: [0.05, 0.6, 0.005], slide: true, tooltip: '血量数字字号 ÷ frameSize' })
    hpFontRatio = 0.115;

    // ====================== 配色（取自例图实测）======================
    @property({ type: Color, tooltip: '头像框内底（暗红）—— 例图实测 #561213 ~ #5A1A1A' })
    innerColor = new Color(90, 22, 24, 255);

    @property({ type: Color, tooltip: '金环主色 —— 例图实测 #D3B983' })
    goldColor = new Color(211, 185, 131, 255);

    @property({ type: Color, tooltip: '金环暗部（做金属立体感的描边）' })
    goldDarkColor = new Color(120, 88, 38, 255);

    @property({ type: Color, tooltip: '血量盾牌底色 —— 例图实测 #96363A' })
    shieldColor = new Color(150, 54, 58, 255);

    @property({ type: Color, tooltip: '满血时血量数字颜色' })
    hpFullColor = new Color(BATTLE_VALUE_GREEN.r, BATTLE_VALUE_GREEN.g, BATTLE_VALUE_GREEN.b, BATTLE_VALUE_GREEN.a);

    @property({ type: Color, tooltip: '受伤时血量数字颜色' })
    hpDamagedColor = new Color(BATTLE_VALUE_RED.r, BATTLE_VALUE_RED.g, BATTLE_VALUE_RED.b, BATTLE_VALUE_RED.a);

    @property({ tooltip: '血量数字字体（CSS font-family；与能量点数字同一套 Georgia 衬线数字）' })
    hpFontFamily = 'Georgia';

    // ====================== 编辑器预览 ======================
    @property({ tooltip: '编辑器内实时预览：改参数立即重排（与 BattleFieldLayout / TurnControlPanel 同一约定）' })
    previewInEditor = true;

    // ====================== 内部 ======================
    private _sig = '';
    /**
     * 血量**显示值**：null = 跟随逻辑值 hp；非 null = 冻结/快照显示值。
     * 🔴 逻辑值 hp 可以早就变了，显示值由演出队列在「攻击动画播完」时推进 ——
     *    多条指令连续攻击同一主战者时，数字随每段动画逐段变化。
     */
    private _displayHp: number | null = null;
    /** 本组件自己管的顶层子节点 —— 不在这张表里的旧节点会被清掉 */
    private static readonly OWNED = ['FrameBack', 'Portrait', 'FrameRing', 'Hp'];
    /**
     * 进化点徽记的**独立渲染层**（挂在 Canvas 下）。
     * 🔴 我方 / 敌方拆成两层，因为两者「与手牌的前后关系」正好相反：
     *    · 我方徽记在底部、与玩家手牌重叠 ⇒ **手牌压在徽记之上**（手牌才是玩家主操作对象）；
     *    · 敌方徽记在顶部、会被敌方手牌 / 敌方英雄框盖住 ⇒ **徽记压在敌方手牌之上**（需求）。
     */
    private static readonly BADGE_LAYER_PLAYER = 'EvoPointLayer';
    private static readonly BADGE_LAYER_ENEMY = 'EvoPointLayer_Enemy';

    // ------------------------------ 生命周期 ------------------------------
    onLoad(): void { this.rebuild(); }
    onEnable(): void { this.rebuild(); }

    update(): void {
        if (EDITOR && !this.previewInEditor) return;
        if (this.signature() === this._sig) return;
        this.rebuild();
    }

    // ------------------------------ 对外 API ------------------------------
    /**
     * 设置血量（最高钳制到 maxHp，允许负血显示；胜负逻辑由回合或战斗系统驱动）。
     * @param deferDisplay true = 只改**逻辑值**，卡面数字冻结到 `flushDisplay()` 再刷新
     *                     （数字显示属于演出：攻击动画播完前不能改）。
     */
    public setHp(v: number, deferDisplay = false): void {
        // ★ 飘字登记（主战者）：差值当场算好，正 = 受伤、负 = 治疗。
        try {
            const before = this.hp;
            const after = Math.min(this.maxHp, Math.round(v));
            if (Number.isFinite(before) && before !== after) {
                const d = before - after;
                recordNumber(this.node, d, true, false, undefined, false, d < 0);   // 治疗（d<0）立刻播
            }
        } catch (e) { /* 忽略 */ }
        const prevDisplay = this.displayedHp;
        this.hp = Math.min(this.maxHp, Math.round(v));
        if (deferDisplay) {
            this._displayHp = prevDisplay;              // 显示冻结在当前显示值
            // 🔴 关键：把**当前**签名记为「已应用」，否则 update() 下一帧发现 hp 变了会立刻 rebuild，
            //    延迟显示当场失效（卡面数字必须在演出播完前保持不变）。
            this._sig = this.signature();
            return;
        }
        this._displayHp = null;
        this.rebuild();
    }

    /** 扣血并返回扣血后的当前血量。伤害为负数时按 0 处理。 */
    public takeDamage(damage: number, deferDisplay = false): number {
        this.setHp(this.hp - Math.max(0, Math.round(damage)), deferDisplay);
        return this.hp;
    }

    /** 当前**实际显示**的血量数字（可能与逻辑值 hp 不同 = 演出还没播到）。 */
    public get displayedHp(): number {
        return this._displayHp === null ? this.hp : this._displayHp;
    }

    /**
     * 把主战者血量数字**推进到某个快照值**（演出队列在「攻击动画播完」后调用）。
     * 🔴 传的是该条指令结算后的血量，不是当前最终逻辑值 —— 这样多段攻击才能逐段变化。
     */
    public applyDisplayHp(hp: number): void {
        this._displayHp = Math.round(hp);
        this.rebuild();
    }

    /** 解除冻结：让显示重新跟随逻辑值（非演出路径用）。 */
    public flushDisplay(): void {
        if (this._displayHp === null) return;
        this._displayHp = null;
        this.rebuild();
    }

    /** 显示值是否落后于逻辑值（= 正在冻结；调试 / 测试）。 */
    public get isDisplayFrozen(): boolean {
        return this._displayHp !== null && this._displayHp !== this.hp;
    }

    /** 当前血量数字应使用的颜色。 */
    public get hpTextColor(): Color {
        // 颜色跟随**显示值**：数字还是满血时不能先变红。
        return this.displayedHp >= this.maxHp ? this.hpFullColor : this.hpDamagedColor;
    }

    /** 当前血量数字 Label（供外部取宽度、做动画） */
    public get hpLabel(): Label | null {
        const hpNode = this.node.getChildByName('Hp');
        const t = hpNode ? hpNode.getChildByName('HpText') : null;
        return t ? t.getComponent(Label) : null;
    }

    // ------------------------------ 构建 ------------------------------
    /** 参数签名：变了才重建（编辑器里逐帧只是拼一次短字符串） */
    private signature(): string {
        const c = (x: Color): string => `${x.r},${x.g},${x.b},${x.a}`;
        return [
            this.side, this.displayedHp, this.maxHp, this.frameSize, this.ringRatio,
            this.portrait ? this.portrait.uuid : '-', this.portraitScale, this.focusX, this.focusY,
            this.showBadges ? 1 : 0, this.badgeSize, this.badgePixelSize, this.badgeSpread, this.badgeDrop,
            this.badgeOffsetX, this.badgeOffsetY,
            this.shieldRatio, this.shieldAspect, this.shieldOffsetX, this.shieldOffsetY,
            this.hpFontRatio, this.hpFontFamily,
            c(this.innerColor), c(this.goldColor), c(this.goldDarkColor),
            c(this.shieldColor), c(this.hpFullColor), c(this.hpDamagedColor),
        ].join('|');
    }

    /** 竖直镜像方向：我方徽记/血盾朝**上**，敌方朝**下**（始终朝屏幕中心） */
    private get dir(): number { return this.side === HeroSide.Player ? 1 : -1; }

    /**
     * 设置徽记位置的**对称微调**（由 `EvoPointSystem` 统一下发）：
     *   · x = 两个徽记一起往外分开的像素（+x → EP 左移 x、SEP 右移 x，永远左右对称）；
     *   · y = 两个徽记一起沿「朝屏幕中心」方向挪的像素（乘 dir ⇒ 我方上 / 敌方下）。
     * 值没变则直接返回（避免每帧无谓重建）；变了立刻重排，编辑器里也能实时看到。
     */
    public setBadgeOffset(x: number, y: number): void {
        const nx = Number.isFinite(x) ? x : 0;
        const ny = Number.isFinite(y) ? y : 0;
        if (this.badgeOffsetX === nx && this.badgeOffsetY === ny) return;
        this.badgeOffsetX = nx;
        this.badgeOffsetY = ny;
        this.rebuild();
    }

    /** 取（或建）子节点并固定兄弟序号 —— 保证渲染层级稳定 */
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

    /** 顶层子节点（本组件自己挂的那几个） */
    private child(name: string, index: number): Node { return this.nodeOf(this.node, name, index); }

    private rebuild(): void {
        const F = Math.max(40, this.frameSize);
        const ut = this.getComponent(UITransform) || this.addComponent(UITransform);
        ut.setAnchorPoint(0.5, 0.5);
        ut.setContentSize(new Size(F, F));

        this.buildBackDisc(F);
        this.buildPortrait(F);
        this.buildFrameRing(F);
        this.buildBadges(F);
        this.buildShield(F);
        this.pruneStale();
        this._sig = this.signature();
    }

    /**
     * 清掉**不再属于本组件**的顶层子节点（改名 / 删除过的旧结构残留）。
     * 🔴 必须做：节点按名字复用，历史版本留下的旧节点（例如早期的 `FrameArt`）
     *    不会被任何一次 build 覆盖，会一直留在场景里继续渲染并盖住人物。
     * 先脱离父节点再 destroy —— destroy 是延迟销毁，留在原地会同名重建成同一个节点。
     */
    private pruneStale(): void {
        const kids = this.node.children.slice();
        for (const n of kids) {
            if (!n || !n.isValid) continue;
            if (HeroArea.OWNED.indexOf(n.name) >= 0) continue;
            n.removeFromParent();
            n.destroy();
        }
    }

    /**
     * 人物：Mask(ELLIPSE) 圆窗 + 内部 Sprite。
     *
     * 🔴 取景**不吃 trim**：Cocos 转 sprite-frame 时会按 alpha 自动裁剪，
     *    `spriteFrame.rect` 已是「可见内容尺寸」，`offset` 记录了这块内容相对
     *    **原图中心**的位移（y 向上）。这里用 rect + offset 把「原图里的取景点」
     *    换算到圆窗中心 ⇒ 换任何人物图都不用改常数。
     *    取景点 = (focusX × 原图宽, focusY × 原图高)，focusY **从上往下**数。
     */
    private buildPortrait(F: number): void {
        const win = this.child('Portrait', 1);
        const wut = win.getComponent(UITransform) as UITransform;
        const ring = Math.max(1, F * this.ringRatio);
        const inner = Math.max(40, F - ring * 2);
        wut.setContentSize(new Size(inner, inner));
        win.setPosition(0, 0, 0);

        let mask = win.getComponent(Mask);
        if (!mask) mask = win.addComponent(Mask);
        // 🔴 MaskType.ELLIPSE 在 3.8.8 已废弃（仍可用）→ 优先用新名字 GRAPHICS_ELLIPSE
        const MT = Mask.Type as unknown as { ELLIPSE: number; GRAPHICS_ELLIPSE?: number };
        mask.type = (MT.GRAPHICS_ELLIPSE !== undefined ? MT.GRAPHICS_ELLIPSE : MT.ELLIPSE) as Mask.Type;

        const art = this.nodeOf(win, 'Art', 0);
        const sp = art.getComponent(Sprite) || art.addComponent(Sprite);
        sp.type = Sprite.Type.SIMPLE;
        sp.sizeMode = Sprite.SizeMode.CUSTOM;
        sp.spriteFrame = this.portrait;

        const sf = this.portrait;
        if (!sf) { art.active = false; return; }
        art.active = true;

        const rawW = sf.originalSize ? sf.originalSize.width : sf.rect.width;
        const rawH = sf.originalSize ? sf.originalSize.height : sf.rect.height;
        const s = Math.max(0.01, this.portraitScale);

        // CUSTOM 模式下节点尺寸 = 可见内容（trim 后）× 缩放
        const aut = art.getComponent(UITransform) as UITransform;
        aut.setContentSize(new Size(sf.rect.width * s, sf.rect.height * s));

        // 取景点相对**原图中心**的偏移（Cocos 坐标：x 向右、y 向上）
        const fx = (this.focusX - 0.5) * rawW;
        const fy = (0.5 - this.focusY) * rawH;
        // sf.offset = trim 后内容中心相对原图中心的偏移
        const off = sf.offset;
        // 让取景点落到圆窗中心 ⇒ 反向平移
        art.setPosition((off.x - fx) * s, (off.y - fy) * s, 0);

        void F;
    }

    /**
     * 暗红内底盘 —— 铺在人物取景窗**后面**（兄弟序 0）。
     * 半径取到金环内缘：取景窗（inner）比它小一圈，于是人物四周会露出一圈暗红，
     * 正是例图里「人物 → 暗红 → 金环」的三层观感。
     */
    private buildBackDisc(F: number): void {
        const n = this.child('FrameBack', 0);
        const ut = n.getComponent(UITransform) as UITransform;
        ut.setContentSize(new Size(F, F));
        n.setPosition(0, 0, 0);
        const g = n.getComponent(Graphics) || n.addComponent(Graphics);
        g.clear();
        const t = Math.max(1, F * this.ringRatio);
        const rIn = F / 2 - t;
        g.fillColor = this.innerColor;
        g.circle(0, 0, rIn + Math.max(0.5, t * 0.14));
        g.fill();
    }

    /** 金属圆环：暗金底环 + 亮金环面 + 内侧细高光（不含内底，内底在 FrameBack） */
    private buildFrameRing(F: number): void {
        const n = this.child('FrameRing', 2);
        const ut = n.getComponent(UITransform) as UITransform;
        ut.setContentSize(new Size(F, F));
        n.setPosition(0, 0, 0);

        const g = n.getComponent(Graphics) || n.addComponent(Graphics);
        g.clear();

        const rOuter = F / 2;
        const t = Math.max(1, F * this.ringRatio);   // 环厚
        const rMid = rOuter - t / 2;
        const rIn = rOuter - t;

        // ① 环底：暗金整环
        g.lineWidth = t;
        g.strokeColor = this.goldDarkColor;
        g.circle(0, 0, rMid);
        g.stroke();

        // ② 环面：亮金，略内缩 → 露出暗金边做出金属立体感
        g.lineWidth = t * 0.62;
        g.strokeColor = this.goldColor;
        g.circle(0, 0, rMid);
        g.stroke();

        // ③ 最内侧细高光（与暗红内底的交界）
        g.lineWidth = Math.max(0.6, t * 0.1);
        g.strokeColor = this.goldColor;
        g.circle(0, 0, rIn + t * 0.1);
        g.stroke();

        // ④ 环外缘暗线：让金环贴住背景，不「浮」起来
        g.lineWidth = Math.max(0.8, t * 0.12);
        g.strokeColor = this.goldDarkColor;
        g.circle(0, 0, rOuter - t * 0.06);
        g.stroke();
    }

    /**
     * 两个徽记槽 = **进化点徽记**（左 = 普通进化点 EP 金色，右 = 超进化点 SEP 紫色）。
     * 🔴 本组件只负责**位置与尺寸**（随 frameSize / badgeSize / badgeSpread / badgeDrop 联动）：
     *    外观（圆环 / 内盘 / 倒计时数字 / 剩余次数菱形）全部交给 `EvoPointBadge` —— 它自己
     *    build 子节点，并按「未解禁 / 已解禁未使用 / 已使用过」三态换色换图。
     *
     * 🔴🔴 徽记**不挂在 HeroArea 下**，而是迁到 `Canvas/EvoPointLayer`（我方）/ `Canvas/EvoPointLayer_Enemy`（敌方）：
     *    HeroArea 在 Canvas 里的兄弟序早于手牌 / 战场卡牌，直接挂进来会被卡牌整个盖住
     *    （`UITransform.priority` 实测无效，2D 渲染顺序按节点树 DFS）。✅ 这里把**世界坐标**
     *    换算成图层的本地坐标写入，位置上仍然等价于「挂在 HeroArea 上」。
     */
    private buildBadges(F: number): void {
        const size = this.badgePixelSize > 0 ? this.badgePixelSize : F * this.badgeSize;
        // 🔴 两个「对称微调」变量（Inspector 可调，绝对 px）：
        //    · badgeOffsetX —— EP / SEP 一起**往外**分开（+X 时 EP -X、SEP +X）⇒ 永远左右对称；
        //    · badgeOffsetY —— 两个一起沿「朝屏幕中心」方向挪（乘 dir ⇒ 我方上 / 敌方下，两侧镜像）。
        const dx = F * this.badgeSpread + this.badgeOffsetX;
        const dy = (F * this.badgeDrop + this.badgeOffsetY) * this.dir;
        const side = this.side === HeroSide.Player ? 'player' : 'enemy';
        const layer = this.badgeLayer();
        const lut = layer.getComponent(UITransform) as UITransform;
        const mk = (base: string, kind: EvoPointKind, x: number): void => {
            const name = base + '_' + side;
            // 复用已有节点（改名 / 换父节点时**保留组件与已绑定的素材引用**）
            // 🔴 还要在全场景按名兜底：敌方徽记原挂在共享的 `EvoPointLayer` 下，
            //    拆分后必须**迁移**进 `EvoPointLayer_Enemy`，否则会新建出重复徽记。
            let n = layer.getChildByName(name) || this.node.getChildByName(base) || this.findBadgeNode(name);
            if (!n) n = new Node(name);
            if (n.parent !== layer) layer.addChild(n);
            if (n.name !== name) n.name = name;

            const ut = n.getComponent(UITransform) || n.addComponent(UITransform);
            ut.setAnchorPoint(0.5, 0.5);
            ut.setContentSize(new Size(size, size));

            const wp = this.node.worldPosition;
            const ws = this.node.worldScale;
            const world = new Vec3(wp.x + x * ws.x, wp.y + dy * ws.y, 0);
            const local = lut.convertToNodeSpaceAR(world);
            n.setPosition(local.x, local.y, 0);
            n.active = this.showBadges;

            // 旧版占位绘制（Graphics 画的金环暗盘）→ 清空并销毁，避免与新徽记重叠
            const g = n.getComponent(Graphics);
            if (g && g.isValid) { g.clear(); g.enabled = false; g.destroy(); }
            let badge = n.getComponent(EvoPointBadge);
            if (!badge) badge = n.addComponent(EvoPointBadge);
            badge.applyLayout(size, kind, side);
        };
        mk('EvoEP', EvoPointKind.EP, -dx);
        mk('EvoSEP', EvoPointKind.SEP, +dx);
    }

    /**
     * 进化点徽记的独立渲染层：挂在 Canvas 下。
     * 🔴 层级目标（按阵营相反）：
     *    · 我方 = **压住战场卡牌，但被玩家手牌压住**（手牌是玩家的主要操作对象，不能被图标挡）；
     *    · 敌方 = **压在敌方手牌 / 敌方英雄框之上**（需求：敌方进化图标不能被敌方手牌遮挡）。
     *    渲染顺序 = Canvas 的子节点顺序，所以两层各自落在不同的位置（见 placeBadgeLayer）。
     */
    private badgeLayer(): Node {
        const canvas = this.node.parent;
        if (!canvas) return this.node;
        const name = this.badgeLayerName();
        let layer = canvas.getChildByName(name);
        if (!layer) {
            layer = new Node(name);
            canvas.addChild(layer);
        }
        if (!layer.getComponent(UITransform)) layer.addComponent(UITransform);
        this.placeBadgeLayer(canvas, layer);
        return layer;
    }

    /** 本阵营用的徽记层名。 */
    private badgeLayerName(): string {
        return this.side === HeroSide.Player ? HeroArea.BADGE_LAYER_PLAYER : HeroArea.BADGE_LAYER_ENEMY;
    }

    /**
     * 把徽记层挪到正确的渲染位置（幂等）。
     *
     * 🔴 只有层「站错边」时才挪 —— 直接写 `setSiblingIndex(目标下标)` 会在两个 HeroArea
     *    各调一遍时反复交换位置（旧实现踩过：徽记又跑回手牌后面）。
     *   · 我方：排在 `PlayerHandArea` **之前** ⇒ 玩家手牌压在徽记之上；
     *   · 敌方：排在 `EnemyHandArea` / `HeroArea_Enemy` **之后** ⇒ 徽记压在敌方手牌与英雄框之上。
     */
    private placeBadgeLayer(canvas: Node, layer: Node): void {
        if (this.side === HeroSide.Player) {
            const hand = canvas.getChildByName('PlayerHandArea');
            if (!hand) return;
            const li = layer.getSiblingIndex();
            const hi = hand.getSiblingIndex();
            if (li > hi) layer.setSiblingIndex(hi);   // 插到手牌前一位 ⇒ 手牌压在徽记之上
            return;
        }
        // 敌方：锚点 = 敌方手牌区 + 敌方英雄区，取靠后者，排在它后面一位。
        let anchorIdx = -1;
        for (const nm of ['EnemyHandArea', 'HeroArea_Enemy']) {
            const n = canvas.getChildByName(nm);
            if (n && n.getSiblingIndex() > anchorIdx) anchorIdx = n.getSiblingIndex();
        }
        if (anchorIdx < 0) return;
        // 强制落在锚点后一位（幂等：已经在正确位置就不动）——让渲染位置可预测。
        if (layer.getSiblingIndex() !== anchorIdx + 1) layer.setSiblingIndex(anchorIdx + 1);
    }

    /**
     * 按节点名在**整个 Canvas** 里找旧徽记节点。
     * 🔴 仅供迁移用：敌方徽记曾与玩家徽记共用一个 `EvoPointLayer`，拆分出
     *    `EvoPointLayer_Enemy` 后必须把老节点搬进来，否则会再 new 出一个重复徽记。
     *    徽记名（`EvoEP_<side>` / `EvoSEP_<side>`）全局唯一，安全。
     */
    private findBadgeNode(name: string): Node | null {
        const canvas = this.node.parent;
        if (!canvas) return null;
        const stack: Node[] = [canvas];
        while (stack.length > 0) {
            const n = stack.shift() as Node;
            if (n.name === name) return n;
            for (const ch of n.children) stack.push(ch);
        }
        return null;
    }

    /** 血量盾牌：红盾 + 金边 + 中央金色大数字 */
    private buildShield(F: number): void {
        const w = F * this.shieldRatio;
        const h = w * this.shieldAspect;
        const n = this.child('Hp', 5);
        const ut = n.getComponent(UITransform) as UITransform;
        ut.setContentSize(new Size(w, h));
        n.setPosition(F * this.shieldOffsetX, F * this.shieldOffsetY * this.dir, 0);

        const g = n.getComponent(Graphics) || n.addComponent(Graphics);
        g.clear();
        const w2 = w / 2;
        const h2 = h / 2;
        const shoulder = -h2 * 0.18;     // 直边到此为止，往下收成尖底
        g.moveTo(-w2, h2);
        g.lineTo(w2, h2);
        g.lineTo(w2, shoulder);
        g.quadraticCurveTo(w2, -h2, 0, -h2);
        g.quadraticCurveTo(-w2, -h2, -w2, shoulder);
        g.close();
        g.fillColor = this.shieldColor;
        g.fill();
        g.lineWidth = Math.max(1, w * 0.11);
        g.strokeColor = this.goldColor;
        g.stroke();

        // 血量数字
        const tn = this.nodeOf(n, 'HpText', 0);
        const tut = tn.getComponent(UITransform) as UITransform;
        tut.setContentSize(new Size(w * 1.6, h * 0.72));
        tn.setPosition(0, h2 * 0.06, 0);
        const lb = tn.getComponent(Label) || tn.addComponent(Label);
        lb.string = String(this.displayedHp);
        lb.useSystemFont = true;
        lb.fontFamily = this.hpFontFamily;
        lb.fontSize = Math.max(6, Math.round(F * this.hpFontRatio));
        lb.lineHeight = Math.round(lb.fontSize * 1.05);
        lb.horizontalAlign = Label.HorizontalAlign.CENTER;
        lb.verticalAlign = Label.VerticalAlign.CENTER;
        lb.overflow = Label.Overflow.SHRINK;   // 🔴 必须先定 SHRINK 再设尺寸，反序会被文本冲掉
        lb.color = this.hpTextColor;
        applyBattleValueOutline(lb, this.displayedHp < this.maxHp);
    }
}
