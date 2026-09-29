import {
    _decorator, Color, Component, Label, Node, Size, Sprite, SpriteFrame, UITransform,
} from 'cc';
import { EDITOR } from 'cc/env';
import { BattleSide } from './BattleFieldLayout';
import { enforceAlwaysTop } from './LayerOrder';

const { ccclass, property, executeInEditMode, requireComponent, menu } = _decorator;

/**
 * BattleStatusBar —— 敌我共用的对战状态栏。
 *
 * 底图 BattleStatusBar.png 从左到右已经画好三个图标：
 *   手牌数量 / 卡组背包剩余数量 / 墓地数量
 *
 * 本组件负责生成三个数字 Label，并自动读取**逻辑计数**（🔴 全部不等任何演出动画）：
 *   · 手牌：CardDraw.logicalHandCount（我方）/ EnemyCardDraw.logicalHandCount（敌方）
 *           —— 含「**抽卡决定那一刻**已判定能进手牌、还在展示/飞行」的张数；
 *   · 卡组：CardDeckManager.remaining('player' | 'enemy')（抽出即从牌堆扣，本身就是逻辑值）；
 *   · 墓地：CardDeckManager.graveCount('player' | 'enemy')
 *           （战场破坏 / 手牌满被破坏 / 使用法术 → **逻辑那一刻** +1）。
 *
 * 🔴 刷新时机 = **每帧读逻辑值、数字变了才重建**（不是定时轮询、更不是等动画回调）：
 *    确实抽到牌并确实塞得进手牌、或卡牌被破坏的那一瞬，下一帧数字就是最终逻辑值。
 */
@ccclass('BattleStatusBar')
@executeInEditMode(true)
@requireComponent(UITransform)
@menu('gf2szb/BattleStatusBar')
export class BattleStatusBar extends Component {

    @property({ type: BattleSide, tooltip: '状态栏归属：Player = 我方，Enemy = 敌方' })
    side: BattleSide = BattleSide.Player;

    @property({ type: SpriteFrame, tooltip: '状态栏底图 SpriteFrame（BattleStatusBar.png）' })
    background: SpriteFrame | null = null;

    @property({ tooltip: '自动从 HandLayout / EnemyHandLayout 和 CardDeckManager 同步数量。' })
    autoBind = true;

    @property({ tooltip: '当前手牌数量；自动同步开启时由布局组件刷新。' })
    handCount = 0;

    @property({ tooltip: '当前卡组背包剩余数量；自动同步开启时由 CardDeckManager 刷新。' })
    deckCount = 0;

    @property({ tooltip: '当前墓地数量。自动同步开启时读 CardDeckManager.graveCount（破坏 / 手牌满被破坏 / 使用法术时当场 +1）。' })
    graveCount = 0;

    @property({ range: [16, 120, 1], slide: true, tooltip: '数字字号（px）' })
    fontSize = 54;

    @property({ range: [0.2, 3, 0.01], slide: true, tooltip: '状态栏整体大小' })
    barScale = 1;

    @property({ tooltip: '状态栏底图显示宽度（px，不乘 barScale）' })
    barWidth = 486;

    @property({ tooltip: '状态栏底图显示高度（px，不乘 barScale）' })
    barHeight = 95;

    @property({ tooltip: '手牌数字的左右位置（本节点局部 X）' })
    handX = -133.65;

    @property({ tooltip: '卡组数字的左右位置（本节点局部 X）' })
    deckX = -2.43;

    @property({ tooltip: '墓地数字的左右位置（本节点局部 X）' })
    graveX = 177.39;

    @property({ range: [0.2, 3, 0.01], slide: true, tooltip: '三个数字的统一大小倍数' })
    digitScale = 1;

    @property({ tooltip: '数字字体（例图为衬线数字）' })
    fontFamily = 'Georgia';

    @property({ tooltip: '是否使用斜体数字' })
    italic = true;

    @property({ type: Color, tooltip: '普通数字颜色' })
    normalColor = new Color(255, 255, 255, 255);

    @property({ type: Color, tooltip: '警告数字颜色（手牌 7~8、卡组 1~10）' })
    warnColor = new Color(245, 205, 45, 255);

    @property({ type: Color, tooltip: '危险数字颜色（手牌 9、卡组 0）' })
    dangerColor = new Color(225, 40, 45, 255);

    @property({ tooltip: '编辑器内实时刷新数字' })
    previewInEditor = true;

    private _sig = '';
    /** 解析到的组件缓存（逐帧读计数，缓存免得每帧全场景 BFS；失效自动重找） */
    private _handCache: any = null;
    private _deckCache: any = null;
    private _drawerCache: any = null;
    private _pDrawerCache: any = null;
    private static readonly OWNED = ['HandCount', 'DeckCount', 'GraveCount'];

    onLoad(): void { this.keepOnTop(); this.rebuild(); this.syncAutoCounts(); }
    onEnable(): void { this.keepOnTop(); this.rebuild(); this.syncAutoCounts(); }

    /**
     * 🔴 **逐帧读逻辑计数 + 按签名去重**。
     *
     * 需求：状态栏显示的是**逻辑计数**，不等任何演出动画 ——
     *   · 确实抽到牌、确实塞得进手牌的那一刻，手牌数就该变（不等抽卡动画播完）；
     *   · 战场上卡牌被破坏（一张或多张）时，墓地数直接跳到最终逻辑值（不等破坏动画播完）。
     * 实现上就是「每帧读一次逻辑值，变了才重建数字」：既没有等待，也没有无谓的重复重建。
     */
    update(): void {
        this.keepOnTop();                     // 与 autoBind / 预览开关无关：HUD 永远最上层
        if (!this.autoBind) return;
        if (EDITOR && !this.previewInEditor) return;
        this.syncAutoCounts();
        if (this.signature() !== this._sig) this.rebuild();
    }

    /**
     * 🔴 **把计数器钉在同层最上层**（每帧一次 O(1) 比较，不是最末位才纠正）。
     *
     * 为什么必须兜底：拖拽手牌（HandDrag.raiseLayerOnDrag）与抽卡动画（CardDraw.raiseLayerOnDraw）
     * 都会把**整个手牌层**提到同层最上层（跨层遮挡战场是故意的），于是手牌 / 正在飞的卡会盖到
     * 计数器上，把数字挡住。`LayerOrder` 已经把计数器登记进「必须永远在最顶」，
     * 这里再逐帧自查一遍作为**最后一道兜底**（任何别的代码路径把计数器压下去都会被立刻纠正）。
     *
     * ⚠️ 编辑器场景视图里不改：避免仅打开场景就把序列化顺序改脏（预览 / 真机照常生效）。
     */
    private keepOnTop(): void {
        if (EDITOR) return;                   // 编辑器场景视图不动态改动节点顺序
        enforceAlwaysTop(this.node);          // 幂等：已经正确时不动任何节点
    }

    /** 主动设置三个数字。 */
    public setCounts(hand: number, deck: number, grave: number): void {
        this.handCount = Math.max(0, Math.round(hand));
        this.deckCount = Math.max(0, Math.round(deck));
        this.graveCount = Math.max(0, Math.round(grave));
        this.rebuild();
    }

    /** 只设置墓地数量，供后续破坏/弃牌/法术结算逻辑调用。 */
    public setGraveCount(v: number): void {
        this.graveCount = Math.max(0, Math.round(v));
        this.rebuild();
    }

    private rebuild(): void {
        const ut = this.getComponent(UITransform) || this.addComponent(UITransform);
        const sp = this.getComponent(Sprite) || this.addComponent(Sprite);
        sp.type = Sprite.Type.SIMPLE;
        sp.sizeMode = Sprite.SizeMode.CUSTOM;
        if (this.background) sp.spriteFrame = this.background;
        ut.setAnchorPoint(0.5, 0.5);
        ut.setContentSize(new Size(this.barWidth, this.barHeight));
        this.node.setScale(this.barScale, this.barScale, 1);

        this.buildLabel('HandCount', 0, this.handX, this.handCount, this.handColor());
        this.buildLabel('DeckCount', 1, this.deckX, this.deckCount, this.deckColor());
        this.buildLabel('GraveCount', 2, this.graveX, this.graveCount, this.normalColor);
        this.pruneStale();
        this._sig = this.signature();
    }

    private buildLabel(name: string, index: number, x: number, value: number, color: Color): void {
        let n = this.node.getChildByName(name);
        if (!n) {
            n = new Node(name);
            n.setParent(this.node);
        }
        n.setSiblingIndex(index);
        const fontSize = Math.max(1, this.fontSize * this.digitScale);
        const ut = n.getComponent(UITransform) || n.addComponent(UITransform);
        ut.setAnchorPoint(0.5, 0.5);
        ut.setContentSize(fontSize * 3, fontSize * 1.4);
        n.setPosition(x, 0, 0);
        n.setScale(1, 1, 1);

        const label = n.getComponent(Label) || n.addComponent(Label);
        label.string = String(Math.round(value));
        label.useSystemFont = true;
        label.fontFamily = this.fontFamily;
        label.fontSize = fontSize;
        label.lineHeight = Math.round(fontSize * 1.05);
        label.isBold = false;
        label.isItalic = this.italic;
        label.horizontalAlign = Label.HorizontalAlign.CENTER;
        label.verticalAlign = Label.VerticalAlign.CENTER;
        label.overflow = Label.Overflow.SHRINK;
        label.color = new Color(color.r, color.g, color.b, color.a);
    }

    private handColor(): Color {
        if (this.handCount >= 9) return this.dangerColor;
        if (this.handCount >= 7) return this.warnColor;
        return this.normalColor;
    }

    private deckColor(): Color {
        if (this.deckCount <= 0) return this.dangerColor;
        if (this.deckCount <= 10) return this.warnColor;
        return this.normalColor;
    }

    /**
     * 读**逻辑计数**（全部与演出动画无关）：
     *   · 手牌：我方 = CardDraw.logicalHandCount / 敌方 = EnemyCardDraw.logicalHandCount
     *          （= 已收编张数 + **抽卡决定那一刻已判定能进手牌**、还在展示/飞行的张数）；
     *   · 牌堆：抽出即从牌堆移除 ⇒ 本身就是逻辑值；
     *   · 墓地：CardDeckManager.graveCount（破坏 / 手牌满被破坏 / 使用法术 时当场 +1）。
     */
    private syncAutoCounts(): void {
        const sideKey: 'player' | 'enemy' = this.side === BattleSide.Player ? 'player' : 'enemy';

        // 手牌 = max(布局里已收编的, 抽卡组件给出的逻辑值)
        //   · 逻辑值含「抽卡决定那一刻已判定进手牌、还在展示/飞行」的张数
        //     → 数字在**决定抽了**的那一刻就变，不等抽卡动画播完；
        //   · 取 max 是兜底：任何一边拿不到（组件缺失 / 尚未解析）也不会把数字读小。
        const hand = this.handLayout();
        const layoutCount = hand ? hand.cardCount : 0;
        const drawer = sideKey === 'enemy' ? this.enemyDrawer() : this.playerDrawer();
        const logical = (drawer && typeof drawer.logicalHandCount === 'number')
            ? drawer.logicalHandCount : 0;
        this.handCount = Math.max(layoutCount, logical);

        const deck = this.deckManager();
        if (deck) {
            this.deckCount = deck.remaining(sideKey);
            if (typeof deck.graveCount === 'function') this.graveCount = deck.graveCount(sideKey);
        }
    }

    /** 手牌布局：我方 HandLayout / 敌方 EnemyHandLayout。 */
    private handLayout(): any {
        if (this._handCache && this._handCache.isValid) return this._handCache;
        this._handCache = this.findComponent(this.side === BattleSide.Player ? 'HandLayout' : 'EnemyHandLayout');
        return this._handCache;
    }

    /** 卡组管理器（牌堆 + 墓场）。 */
    private deckManager(): any {
        if (this._deckCache && this._deckCache.isValid) return this._deckCache;
        this._deckCache = this.findComponent('CardDeckManager');
        return this._deckCache;
    }

    /** 敌方抽卡组件（提供 logicalHandCount）。 */
    private enemyDrawer(): any {
        if (this._drawerCache && this._drawerCache.isValid) return this._drawerCache;
        this._drawerCache = this.findComponent('EnemyCardDraw');
        return this._drawerCache;
    }

    /** 我方抽卡组件（提供 logicalHandCount）。 */
    private playerDrawer(): any {
        if (this._pDrawerCache && this._pDrawerCache.isValid) return this._pDrawerCache;
        this._pDrawerCache = this.findComponent('CardDraw');
        return this._pDrawerCache;
    }

    private findComponent(className: string): any {
        const scene = this.node.scene as unknown as Node | null;
        if (!scene) return null;
        const stack: Node[] = [...scene.children];
        while (stack.length > 0) {
            const cur = stack.shift() as Node;
            const c = cur.getComponent(className);
            if (c && c.isValid) return c;
            for (const ch of cur.children) stack.push(ch);
        }
        return null;
    }

    private pruneStale(): void {
        for (const child of [...this.node.children]) {
            if (!child || !child.isValid) continue;
            if (BattleStatusBar.OWNED.indexOf(child.name) >= 0) continue;
            if (child.getComponent(Label)) {
                child.removeFromParent();
                child.destroy();
            }
        }
    }

    private signature(): string {
        const c = (v: Color): string => `${v.r},${v.g},${v.b},${v.a}`;
        return [
            this.side, this.handCount, this.deckCount, this.graveCount,
            this.fontSize, this.barScale, this.barWidth, this.barHeight,
            this.handX, this.deckX, this.graveX, this.digitScale,
            this.fontFamily, this.italic ? 1 : 0,
            c(this.normalColor), c(this.warnColor), c(this.dangerColor),
        ].join('|');
    }
}
