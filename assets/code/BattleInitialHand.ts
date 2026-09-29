import {
    _decorator, BlockInputEvents, Camera, Color, Component, EventMouse, EventTouch, Graphics, Input, Label, Node, UITransform,
    Vec3, HorizontalTextAlignment, VerticalTextAlignment, Tween, tween, input,
} from 'cc';
import { killNode } from './CardComposer';
import { toCardId } from './HandLayout';
import { getCardInfo } from './CardData';
import { beginModalLayer, endModalLayer } from './LayerOrder';

const { ccclass, property, menu } = _decorator;

type Side = 'player' | 'enemy';
type Row = 'top' | 'bottom';

interface HandLike {
    cards: readonly Node[];
    cardCount: number;
    hand?: string[];
    suppressSweep: boolean;
    clearHand(): void;
    refresh(): void;
    adoptCard(node: Node, id: string): void;
    setHand?: (ids: string[]) => boolean;
    setInitialHand?: (ids: string[]) => boolean;
    maxCards?: number;
    adoptCardAt?: (node: Node, id: string, index: number) => void;
}
interface DrawLike {
    isDrawing: boolean;
    drawMany(ids: string[]): boolean;
    testCardIds?: string[];
}
interface DeckLike {
    drawManyFor(side: Side, n: number): string[];
    returnToDeck(side: Side, ids: string[]): number;
}
interface ComposerLike {
    composeCard(id: string, nodeName?: string, index?: number): Node | null;
}
interface CardHandlerSet {
    start: (event: EventTouch) => void;
    move: (event: EventTouch) => void;
    end: (event: EventTouch) => void;
    cancel: (event: EventTouch) => void;
}

/**
 * BattleInitialHand —— 对战开始时的「初始手牌 / 更换初始手牌」界面。
 *
 * 结构严格分成两行：
 *   · 上行：准备更换的牌。空槽显示循环箭头；把下行卡拖上来后填入。
 *   · 下行：当前最终手牌候选。初始 4 张都在这里；上行卡也能拖回这里。
 *
 * 选择期间卡牌只存在于本临时界面，不计入正式 HandLayout。点击「决定」后：
 *   1. 上行卡洗回牌组；
 *   2. 从牌组抽取同等数量的新卡，补进下行；
 *   3. 下行最终 4 张才收编进正式手牌；
 *   4. 临时页面消失，TurnManager 进入第一回合。
 */
@ccclass('BattleInitialHand')
@menu('gf2szb/BattleInitialHand')
export class BattleInitialHand extends Component {
    @property({ range: [1, 10, 1], slide: true, tooltip: '开局双方发几张初始手牌。' })
    initialHandSize = 4;

    @property({ range: [140, 220, 1], slide: true, tooltip: '上行交换槽宽度。' })
    slotWidth = 178;

    @property({ range: [180, 280, 1], slide: true, tooltip: '上行交换槽高度。' })
    slotHeight = 238;

    @property({ range: [0, 1.2, 0.01], slide: true, tooltip: '两行卡牌缩放。' })
    cardScale = 0.68;

    @property({ range: [0, 1.2, 0.01], slide: true, tooltip: '上行已选卡牌缩放。' })
    selectedCardScale = 0.68;

    @property({ range: [0, 100, 1], slide: true, tooltip: '下行卡牌中心间距额外像素。' })
    cardGap = 58;

    @property({ tooltip: '打印开局手牌与交换日志。' })
    verbose = true;

    private _active = false;
    private _confirming = false;
    private _done: (() => void) | null = null;
    private _overlay: Node | null = null;
    private _canvas: Node | null = null;
    private _handNode: Node | null = null;
    private _hand: HandLike | null = null;
    private _selected = new Map<Node, number>();
    private _row = new Map<Node, Row>();
    private _cardIds = new Map<Node, string>();
    private _handlers = new Map<Node, Array<{ node: Node; handlers: CardHandlerSet }>>();
    private _slots: Node[] = [];
    private _bottomSlots: Node[] = [];
    private _homeSlot = new Map<Node, number>();
    private _firstSide: Side = 'player';
    private _pressCard: Node | null = null;
    private _pressId = -1;
    private _pressMoved = false;
    private _pressOffset = new Vec3();
    private _lastPointer = new Vec3();
    private _pointerSource: 'touch' | 'mouse' | null = null;
    private _mouseBound = false;
    private _topRowY = 150;
    private _bottomRowY = -180;
    private _fallbackPlayer = false;

    public get isSelecting(): boolean { return this._active; }

    /** TurnManager 调用的入口；返回 true 表示接管开局并等待本流程结束。 */
    public startInitialHand(_firstSide: Side, onDone: () => void): boolean {
        if (this._active) return true;
        this._done = onDone;
        this._active = true;
        this._confirming = false;
        this._fallbackPlayer = false;
        this._firstSide = _firstSide;
        this._selected.clear();
        this._row.clear();
        this._cardIds.clear();
        this._homeSlot.clear();
        this._slots = [];
        this._bottomSlots = [];

        this._canvas = this.findNode('Canvas');
        this._handNode = this.findNode('PlayerHandArea');
        this._hand = this.findComponent<HandLike>('HandLayout');
        const playerDraw = this.findComponent<DrawLike>('CardDraw');
        const enemyHand = this.findComponent<HandLike>('EnemyHandLayout');
        const deck = this.findComponent<DeckLike>('CardDeckManager');
        const composer = this.findComponent<ComposerLike>('CardComposer');

        if (!this._canvas || !this._hand || !this._handNode || !playerDraw || !enemyHand || !composer) {
            console.warn('[BattleInitialHand] 缺少初始手牌所需组件，跳过换牌界面。');
            this.finish();
            return true;
        }

        // 开战时清掉场景里的测试手牌；正式手牌等确认后才收编。
        this._hand.clearHand();
        enemyHand.clearHand();

        const n = Math.max(1, Math.floor(this.initialHandSize));
        let playerIds = deck ? deck.drawManyFor('player', n) : [];
        let enemyIds = deck ? deck.drawManyFor('enemy', n) : [];
        if (playerIds.length === 0) {
            playerIds = this.fallbackIds(playerDraw, n);
            this._fallbackPlayer = true;
        }
        if (enemyIds.length === 0) enemyIds = this.fallbackIds(playerDraw, n);

        this.buildOverlay(n, _firstSide);
        const playerCards = this.composeTemporaryCards(composer, playerIds, 'InitialMulligan_Player_');
        playerCards.forEach((card, index) => {
            this._row.set(card, 'bottom');
            this._homeSlot.set(card, index);
        });
        this.layoutRows();
        this.bindCardPointers();

        // 敌方初始 4 张直接落位为卡背，不再在选择界面播放一张一张的抽卡动画。
        // 真实 id 已经由 CardDeckManager 从敌方牌堆抽出，EnemyHandLayout 只展示卡背。
        // 初始手牌必须一次性落位 4 张。若场景里曾把 maxCards 序列化成 1，
        // setHand 会整批拒绝；setInitialHand 会在开局阶段先把容量提升到本局初始手牌数，再重排卡背。
        const enemyPlaced = enemyHand.setInitialHand
            ? enemyHand.setInitialHand(enemyIds)
            : (() => {
                if (typeof enemyHand.maxCards === 'number') enemyHand.maxCards = Math.max(enemyHand.maxCards, enemyIds.length);
                return enemyHand.setHand ? enemyHand.setHand(enemyIds) : false;
            })();
        if (!enemyPlaced || enemyHand.cardCount !== enemyIds.length) {
            console.warn(`[BattleInitialHand] 敌方初始手牌落位数量异常：期望 ${enemyIds.length}，实际 ${enemyHand.cardCount}`);
        }
        if (this.verbose) {
            console.log(`[BattleInitialHand] 开局候选牌：${playerIds.join(', ')}`);
            console.log(`[BattleInitialHand] 敌方初始手牌已直接落位：${enemyIds.join(', ')}`);
        }
        return true;
    }

    public onDisable(): void {
        this.unbindCardPointers();
        this.destroyTemporaryCards();
        this.clearOverlay();
        this._active = false;
        this._confirming = false;
    }

    public lateUpdate(): void {
        // 保留场上的 HUD 与计数器，只让换牌模态页始终压在最上层：
        // 视觉上由本页盖住，输入上也由 BlockInputEvents 统一拦住。
        if (!this._active || !this._overlay || !this._overlay.isValid || !this._overlay.parent) return;
        const parent = this._overlay.parent;
        const top = parent.children.length - 1;
        if (this._overlay.getSiblingIndex() !== top) this._overlay.setSiblingIndex(top);
    }

    private waitForEnemyReveal(enemyDraw: DrawLike): void {
        setTimeout(() => {
            if (!this._active) return;
            if (enemyDraw.isDrawing) {
                this.waitForEnemyReveal(enemyDraw);
                return;
            }
            if (this.verbose) console.log(`[BattleInitialHand] 两行换牌界面就绪：下行 ${this._row.size} 张`);
        }, 80);
    }

    private buildOverlay(slotCount: number, firstSide: Side): void {
        if (!this._canvas) return;
        const layer = new Node('BattleInitialHandLayer');
        layer.layer = this._canvas.layer;
        layer.setParent(this._canvas);
        layer.setSiblingIndex(this._canvas.children.length - 1);
        const layerUt = layer.addComponent(UITransform);
        layerUt.setAnchorPoint(0.5, 0.5);
        layerUt.setContentSize(1280, 720);
        layer.addComponent(BlockInputEvents);
        this._overlay = layer;
        beginModalLayer(layer);

        // 上行区域：约占屏幕中上部 2/5。
        const topPanel = new Node('MulliganTopPanel');
        topPanel.layer = layer.layer;
        topPanel.setParent(layer);
        const topUt = topPanel.addComponent(UITransform);
        topUt.setAnchorPoint(0.5, 0.5);
        topUt.setContentSize(970, 280);
        topPanel.setPosition(-65, 145, 0);
        const topG = topPanel.addComponent(Graphics);
        topG.fillColor = new Color(11, 25, 40, 232);
        topG.roundRect(-485, -140, 970, 280, 18);
        topG.fill();
        topG.lineWidth = 3;
        topG.strokeColor = new Color(193, 158, 76, 245);
        topG.roundRect(-485, -140, 970, 280, 18);
        topG.stroke();

        this.addLabel(layer, '交换', -65, 286, 300, 42, 28, new Color(180, 230, 249, 255), true);
        const prompt = new Node('MulliganPromptBar');
        prompt.layer = layer.layer;
        prompt.setParent(layer);
        const promptUt = prompt.addComponent(UITransform);
        promptUt.setAnchorPoint(0.5, 0.5);
        promptUt.setContentSize(920, 46);
        // 上下两块主面板的可视间隙中点是 y = -18；提示条放在这里才不会贴住上框。
        prompt.setPosition(-65, -18, 0);
        const promptG = prompt.addComponent(Graphics);
        promptG.fillColor = new Color(8, 20, 34, 226);
        promptG.roundRect(-460, -23, 920, 46, 10);
        promptG.fill();
        promptG.lineWidth = 2;
        promptG.strokeColor = new Color(193, 158, 76, 235);
        promptG.roundRect(-460, -23, 920, 46, 10);
        promptG.stroke();
        this.addLabel(prompt, '请将想要更换的卡牌拖动至上方框内。', 0, 0, 860, 36, 20, new Color(235, 241, 247, 255), false);

        const slotGap = 42;
        const startX = -((slotCount - 1) * (this.slotWidth + slotGap)) / 2 - 65;
        for (let i = 0; i < slotCount; i++) {
            this._slots.push(this.makeSlot(layer, startX + i * (this.slotWidth + slotGap), this._topRowY, i));
        }

        // 下行卡牌栏：背景与金色描边由同一个节点绘制，边界严格重合，不越出卡槽栏。
        const bottomPanel = new Node('MulliganBottomPanel');
        bottomPanel.layer = layer.layer;
        bottomPanel.setParent(layer);
        const bottomUt = bottomPanel.addComponent(UITransform);
        bottomUt.setAnchorPoint(0.5, 0.5);
        bottomUt.setContentSize(970, 280);
        bottomPanel.setPosition(-65, -180, 0);
        const bottomG = bottomPanel.addComponent(Graphics);
        bottomG.fillColor = new Color(11, 25, 40, 232);
        bottomG.roundRect(-485, -140, 970, 280, 18);
        bottomG.fill();
        bottomG.lineWidth = 3;
        bottomG.strokeColor = new Color(193, 158, 76, 245);
        bottomG.roundRect(-485, -140, 970, 280, 18);
        bottomG.stroke();
        this.addLabel(layer, '保留', -65, -326, 260, 38, 23, new Color(183, 231, 249, 255), true);

        // 下行和上行使用同一组 x 坐标：卡牌上移后，下行原位保留空槽。
        for (let i = 0; i < slotCount; i++) {
            this._bottomSlots.push(this.makeBottomSlot(layer, startX + i * (this.slotWidth + slotGap), this._bottomRowY, i));
        }
        this.buildSideHints(layer, firstSide);

        // 决定按钮放在上行区域右侧，和例图一样不压住上行卡槽。
        const confirm = new Node('MulliganConfirm');
        confirm.layer = layer.layer;
        confirm.setParent(layer);
        const cut = confirm.addComponent(UITransform);
        cut.setAnchorPoint(0.5, 0.5);
        cut.setContentSize(168, 168);
        confirm.setPosition(535, -18, 0);
        const cg = confirm.addComponent(Graphics);
        cg.fillColor = new Color(9, 122, 224, 248);
        cg.circle(0, 0, 76);
        cg.fill();
        cg.lineWidth = 4;
        cg.strokeColor = new Color(104, 226, 255, 255);
        cg.circle(0, 0, 76);
        cg.stroke();
        this.addLabel(confirm, '决定', 0, 0, 130, 54, 28, Color.WHITE, true);
        confirm.on(Node.EventType.TOUCH_END, this.onConfirm, this);
    }

    private buildSideHints(parent: Node, firstSide: Side): void {
        // 位置固定表达阵营：上方永远是对手红框，下方永远是我方绿框。
        // 先后手文字根据本局结果交换，不再随颜色交换。
        const enemyTurn = firstSide === 'enemy';
        this.makeHintPanel(parent, 535, 220, enemyTurn ? '先手' : '后手', '对手', new Color(112, 48, 55, 245));
        this.makeHintPanel(parent, 535, -225, enemyTurn ? '后手' : '先手', '我方', new Color(42, 108, 66, 245));
    }

    private makeHintPanel(parent: Node, x: number, y: number, title: string, side: string, fill: Color): Node {
        const panel = new Node('MulliganSideHint_' + title);
        panel.layer = parent.layer;
        panel.setParent(parent);
        const ut = panel.addComponent(UITransform);
        ut.setAnchorPoint(0.5, 0.5);
        ut.setContentSize(220, 112);
        panel.setPosition(x, y, 0);
        const g = panel.addComponent(Graphics);
        g.fillColor = fill;
        g.roundRect(-110, -56, 220, 112, 16);
        g.fill();
        g.lineWidth = 3;
        g.strokeColor = new Color(193, 158, 76, 245);
        g.roundRect(-110, -56, 220, 112, 16);
        g.stroke();
        this.addLabel(panel, title + '\n' + side, 0, 0, 200, 92, 22, new Color(246, 246, 246, 255), true);
        return panel;
    }

    private makeBottomSlot(parent: Node, x: number, y: number, index: number): Node {
        const slot = new Node('MulliganBottomSlot_' + index);
        slot.layer = parent.layer;
        slot.setParent(parent);
        const ut = slot.addComponent(UITransform);
        ut.setAnchorPoint(0.5, 0.5);
        ut.setContentSize(this.slotWidth, this.slotHeight);
        slot.setPosition(x, y, 0);
        const g = slot.addComponent(Graphics);
        g.fillColor = new Color(18, 30, 45, 210);
        g.roundRect(-this.slotWidth / 2, -this.slotHeight / 2, this.slotWidth, this.slotHeight, 12);
        g.fill();
        g.lineWidth = 3;
        g.strokeColor = new Color(70, 87, 105, 225);
        g.roundRect(-this.slotWidth / 2, -this.slotHeight / 2, this.slotWidth, this.slotHeight, 12);
        g.stroke();
        return slot;
    }

    private makeSlot(parent: Node, x: number, y: number, index: number): Node {
        const slot = new Node('MulliganSlot_' + index);
        slot.layer = parent.layer;
        slot.setParent(parent);
        const ut = slot.addComponent(UITransform);
        ut.setAnchorPoint(0.5, 0.5);
        ut.setContentSize(this.slotWidth, this.slotHeight);
        slot.setPosition(x, y, 0);
        const g = slot.addComponent(Graphics);
        g.fillColor = new Color(23, 34, 48, 215);
        g.roundRect(-this.slotWidth / 2, -this.slotHeight / 2, this.slotWidth, this.slotHeight, 12);
        g.fill();
        g.lineWidth = 3;
        g.strokeColor = new Color(97, 111, 126, 225);
        g.roundRect(-this.slotWidth / 2, -this.slotHeight / 2, this.slotWidth, this.slotHeight, 12);
        g.stroke();
        this.addLabel(slot, '↻', 0, 3, this.slotWidth, 88, 70, new Color(143, 153, 163, 210), true);
        return slot;
    }

    private ensureAmuletCostBadge(card: Node, id: string): void {
        const info = getCardInfo(id);
        if (!info || info.cardType !== 'Amulet') return;
        const cost = card.getChildByName('CardCost');
        if (!cost) return;
        let badge = card.getChildByName('InitialMulliganAmuletCostBadge');
        if (!badge) {
            badge = new Node('InitialMulliganAmuletCostBadge');
            badge.layer = card.layer;
            badge.setParent(card);
            const ut = badge.addComponent(UITransform);
            ut.setAnchorPoint(0.5, 0.5);
            ut.setContentSize(54, 54);
            const g = badge.addComponent(Graphics);
            g.fillColor = new Color(104, 205, 83, 255);
            g.circle(0, 0, 25);
            g.fill();
            g.lineWidth = 2.5;
            g.strokeColor = new Color(207, 255, 153, 255);
            g.circle(0, 0, 25);
            g.stroke();
        }
        badge.setPosition(cost.position);
        // 数字在徽章上方，徽章在卡框上方，确保护符费用不会只剩文字。
        badge.setSiblingIndex(Math.max(0, cost.getSiblingIndex()));
    }

    private addLabel(parent: Node, text: string, x: number, y: number, width: number, height: number,
                     fontSize: number, color: Color, bold: boolean): Label {
        const n = new Node('Label');
        n.layer = parent.layer;
        n.setParent(parent);
        const ut = n.addComponent(UITransform);
        ut.setAnchorPoint(0.5, 0.5);
        ut.setContentSize(width, height);
        n.setPosition(x, y, 0);
        const lb = n.addComponent(Label);
        lb.string = text;
        lb.fontSize = fontSize;
        lb.lineHeight = Math.max(fontSize + 5, 18);
        lb.color = color;
        lb.isBold = bold;
        lb.horizontalAlign = HorizontalTextAlignment.CENTER;
        lb.verticalAlign = VerticalTextAlignment.CENTER;
        lb.overflow = Label.Overflow.SHRINK;
        lb.enableWrapText = true;
        return lb;
    }

    private composeTemporaryCards(composer: ComposerLike, ids: string[], prefix: string): Node[] {
        const out: Node[] = [];
        if (!this._overlay) return out;
        ids.forEach((raw, index) => {
            const id = toCardId(raw);
            const card = composer.composeCard(id, prefix + index + '_' + Date.now());
            if (!card || !card.isValid) return;
            card.setParent(this._overlay, true);
            card.setRotationFromEuler(0, 0, 0);
            card.setScale(this.cardScale, this.cardScale, 1);
            card.setSiblingIndex(this._overlay.children.length - 1);
            this._cardIds.set(card, id);
            this.ensureAmuletCostBadge(card, id);
            out.push(card);
        });
        return out;
    }

    private layoutRows(): void {
        const all = Array.from(this._cardIds.keys()).filter(n => n && n.isValid);
        const bottom = all
            .filter(n => this._row.get(n) !== 'top')
            .sort((a, b) => (this._homeSlot.get(a) ?? 0) - (this._homeSlot.get(b) ?? 0));
        for (const card of bottom) {
            const home = Math.max(0, Math.min(this._bottomSlots.length - 1, this._homeSlot.get(card) ?? 0));
            const slot = this._bottomSlots[home];
            if (!slot) continue;
            Tween.stopAllByTarget(card);
            const p = slot.position;
            card.setPosition(p.x, p.y, 10 + home);
            card.setRotationFromEuler(0, 0, 0);
            card.setScale(this.cardScale, this.cardScale, 1);
            card.setSiblingIndex(this._overlay ? this._overlay.children.length - 1 : card.getSiblingIndex());
        }
        for (const [card, slot] of this._selected) {
            if (!card.isValid || !this._slots[slot]) continue;
            const p = this._slots[slot].position;
            Tween.stopAllByTarget(card);
            card.setPosition(p.x, p.y, 20 + slot);
            card.setRotationFromEuler(0, 0, 0);
            card.setScale(this.selectedCardScale, this.selectedCardScale, 1);
            card.setSiblingIndex(this._overlay ? this._overlay.children.length - 1 : card.getSiblingIndex());
        }
    }

    private measureCardWidth(card: Node | undefined): number {
        const ut = card?.getComponent(UITransform);
        return ut ? ut.contentSize.width * this.cardScale : 145;
    }

    private bindCardPointers(): void {
        for (const card of this._cardIds.keys()) {
            const start = (event: EventTouch) => this.onCardStart(card, event);
            const move = (event: EventTouch) => this.onCardMove(card, event);
            const end = (event: EventTouch) => this.onCardEnd(card, event);
            const cancel = (event: EventTouch) => this.onCardEnd(card, event);
            const handlers = { start, move, end, cancel };
            const nodes = [card, ...this.descendants(card)];
            const bound: Array<{ node: Node; handlers: CardHandlerSet }> = [];
            for (const node of nodes) {
                node.on(Node.EventType.TOUCH_START, start, this);
                node.on(Node.EventType.TOUCH_MOVE, move, this);
                node.on(Node.EventType.TOUCH_END, end, this);
                node.on(Node.EventType.TOUCH_CANCEL, cancel, this);
                bound.push({ node, handlers });
            }
            this._handlers.set(card, bound);
        }
        this.bindGlobalMouse();
    }

    private bindGlobalMouse(): void {
        if (this._mouseBound) return;
        input.on(Input.EventType.MOUSE_DOWN, this.onGlobalMouseDown, this);
        input.on(Input.EventType.MOUSE_MOVE, this.onGlobalMouseMove, this);
        input.on(Input.EventType.MOUSE_UP, this.onGlobalMouseUp, this);
        this._mouseBound = true;
    }

    private unbindGlobalMouse(): void {
        if (!this._mouseBound) return;
        input.off(Input.EventType.MOUSE_DOWN, this.onGlobalMouseDown, this);
        input.off(Input.EventType.MOUSE_MOVE, this.onGlobalMouseMove, this);
        input.off(Input.EventType.MOUSE_UP, this.onGlobalMouseUp, this);
        this._mouseBound = false;
    }

    private unbindCardPointers(): void {
        for (const bound of this._handlers.values()) {
            for (const item of bound) {
                const node = item.node;
                const h = item.handlers;
                if (!node.isValid) continue;
                node.off(Node.EventType.TOUCH_START, h.start, this);
                node.off(Node.EventType.TOUCH_MOVE, h.move, this);
                node.off(Node.EventType.TOUCH_END, h.end, this);
                node.off(Node.EventType.TOUCH_CANCEL, h.cancel, this);
            }
        }
        this._handlers.clear();
        this.unbindGlobalMouse();
        this._pointerSource = null;
        this._pressCard = null;
        this._pressId = -1;
    }

    private descendants(root: Node): Node[] {
        const out: Node[] = [];
        const queue: Node[] = [...root.children];
        while (queue.length) {
            const node = queue.shift() as Node;
            out.push(node);
            for (const child of node.children) queue.push(child);
        }
        return out;
    }

    private onCardStart(card: Node, event: EventTouch): void {
        if (!this._active || this._confirming || !card.isValid || this._pointerSource === 'mouse') return;
        this._pointerSource = 'touch';
        this._pressCard = card;
        this._pressId = event.getID();
        this._pressMoved = false;
        this.moveToCanvas(card, card.worldPosition.clone());
        const pointer = this.canvasLocal(this.eventWorld(event));
        this._pressOffset.set(card.position.x - pointer.x, card.position.y - pointer.y, 0);
        this._lastPointer.set(pointer.x, pointer.y, 0);
    }

    private onCardMove(card: Node, event: EventTouch): void {
        if (!this._active || this._confirming || this._pointerSource !== 'touch' || this._pressCard !== card || event.getID() !== this._pressId) return;
        const pointer = this.canvasLocal(this.eventWorld(event));
        const dx = pointer.x - this._lastPointer.x;
        const dy = pointer.y - this._lastPointer.y;
        if (!this._pressMoved && dx * dx + dy * dy < 36) return;
        this._pressMoved = true;
        this._lastPointer.set(pointer.x, pointer.y, 0);
        card.setPosition(pointer.x + this._pressOffset.x, pointer.y + this._pressOffset.y, 40);
    }

    private onCardEnd(card: Node, event: EventTouch): void {
        if (this._pointerSource !== 'touch' || this._pressCard !== card || event.getID() !== this._pressId) return;
        this._pressCard = null;
        this._pressId = -1;
        this._pointerSource = null;
        if (!this._active || this._confirming) return;
        const moved = this._pressMoved;
        this._pressMoved = false;
        const pointer = this.canvasLocal(this.eventWorld(event));
        this.finishCardDrag(card, pointer, moved);
    }

    private finishCardDrag(card: Node, pointer: Vec3, moved: boolean): void {
        this._pressMoved = false;
        if (!moved) {
            this.layoutRows();
            return;
        }
        const slot = this.findDropSlot(pointer.x, pointer.y);
        if (slot >= 0) this.select(card, slot);
        else if (this.isBottomDrop(pointer.y)) this.deselect(card);
        else this.layoutRows();
    }

    private onGlobalMouseDown(event: EventMouse): void {
        if (!this._active || this._confirming || this._pointerSource !== null) return;
        const world = this.mouseEventWorld(event);
        const card = this.pickCard(world);
        if (!card || !card.isValid) return;
        this._pointerSource = 'mouse';
        this._pressCard = card;
        this._pressId = -2;
        this._pressMoved = false;
        this.moveToCanvas(card, card.worldPosition.clone());
        const pointer = this.canvasLocal(world);
        this._pressOffset.set(card.position.x - pointer.x, card.position.y - pointer.y, 0);
        this._lastPointer.set(pointer.x, pointer.y, 0);
    }

    private onGlobalMouseMove(event: EventMouse): void {
        if (!this._active || this._confirming || this._pointerSource !== 'mouse' || !this._pressCard) return;
        const card = this._pressCard;
        if (!card.isValid) return;
        const pointer = this.canvasLocal(this.mouseEventWorld(event));
        const dx = pointer.x - this._lastPointer.x;
        const dy = pointer.y - this._lastPointer.y;
        if (!this._pressMoved && dx * dx + dy * dy < 36) return;
        this._pressMoved = true;
        this._lastPointer.set(pointer.x, pointer.y, 0);
        card.setPosition(pointer.x + this._pressOffset.x, pointer.y + this._pressOffset.y, 40);
    }

    private onGlobalMouseUp(event: EventMouse): void {
        if (this._pointerSource !== 'mouse' || !this._pressCard) return;
        const card = this._pressCard;
        const moved = this._pressMoved;
        this._pressCard = null;
        this._pressId = -1;
        this._pointerSource = null;
        if (!this._active || this._confirming || !card.isValid) return;
        this.finishCardDrag(card, this.canvasLocal(this.mouseEventWorld(event)), moved);
    }

    private pickCard(world: Vec3): Node | null {
        const cards = Array.from(this._cardIds.keys()).filter(card => card && card.isValid);
        cards.sort((a, b) => b.getSiblingIndex() - a.getSiblingIndex());
        for (const card of cards) {
            const ut = card.getComponent(UITransform);
            if (!ut) continue;
            const local = ut.convertToNodeSpaceAR(world, new Vec3());
            const w = ut.contentSize.width;
            const h = ut.contentSize.height;
            if (local.x >= -ut.anchorX * w && local.x <= (1 - ut.anchorX) * w
                && local.y >= -ut.anchorY * h && local.y <= (1 - ut.anchorY) * h) return card;
        }
        return null;
    }

    private findDropSlot(x: number, y: number): number {
        if (Math.abs(y - this._topRowY) > this.slotHeight * 0.7) return -1;
        let best = -1;
        let bestDistance = Number.POSITIVE_INFINITY;
        for (let i = 0; i < this._slots.length; i++) {
            if (Array.from(this._selected.values()).includes(i)) continue;
            const distance = Math.abs(x - this._slots[i].position.x);
            if (distance < this.slotWidth * 0.75 && distance < bestDistance) {
                best = i;
                bestDistance = distance;
            }
        }
        return best;
    }

    private isBottomDrop(y: number): boolean {
        return Math.abs(y - this._bottomRowY) <= 110;
    }

    private select(card: Node, forcedSlot = -1): void {
        const slot = forcedSlot >= 0 ? forcedSlot : this.firstFreeSlot();
        if (slot < 0) { this.layoutRows(); return; }
        const previous = this._selected.get(card);
        if (previous !== undefined) this._selected.delete(card);
        this._selected.set(card, slot);
        this._row.set(card, 'top');
        this.layoutRows();
        if (this.verbose) console.log(`[BattleInitialHand] 拖入上行：${this._cardIds.get(card) || card.name}`);
    }

    private deselect(card: Node): void {
        this._selected.delete(card);
        this._row.set(card, 'bottom');
        this.layoutRows();
        if (this.verbose) console.log(`[BattleInitialHand] 拖回下行：${this._cardIds.get(card) || card.name}`);
    }

    private firstFreeSlot(): number {
        for (let i = 0; i < this._slots.length; i++) {
            if (!Array.from(this._selected.values()).includes(i)) return i;
        }
        return -1;
    }

    private onConfirm(): void {
        if (!this._active || this._confirming) return;
        this._confirming = true;
        this.unbindCardPointers();
        const selectedEntries = Array.from(this._selected.keys())
            .filter(card => card && card.isValid)
            .map(card => ({
                card,
                id: this._cardIds.get(card) || '',
                slot: this._selected.get(card) ?? this._homeSlot.get(card) ?? 0,
            }))
            .filter(x => !!x.id)
            .sort((a, b) => a.slot - b.slot);
        const selectedIds = selectedEntries.map(x => x.id);
        const deck = this.findComponent<DeckLike>('CardDeckManager');
        const playerDraw = this.findComponent<DrawLike>('CardDraw');
        const composer = this.findComponent<ComposerLike>('CardComposer');

        if (deck && selectedIds.length > 0 && !this._fallbackPlayer) {
            deck.returnToDeck('player', selectedIds);
        }
        if (!composer || !playerDraw) {
            this.removeExchangedCards(selectedEntries);
            this.finalizeIntoHand();
            return;
        }

        const returnItems = selectedEntries.map(entry => ({
            card: entry.card,
            start: entry.card.position.clone(),
            target: this.canvasLocal(this.deckWorldPoint()),
            startScale: entry.card.scale.clone(),
            targetScale: new Vec3(0.24, 0.24, 1),
            startEuler: entry.card.eulerAngles.clone(),
            targetEuler: new Vec3(0, 0, entry.slot % 2 === 0 ? -8 : 8),
        }));
        if (this.verbose && selectedIds.length > 0) console.log('[BattleInitialHand] 开始将 ' + selectedIds.length + ' 张更换牌洗回牌组');
        this.animateNodeBatch(returnItems, 0.48, () => {
            this.removeExchangedCards(selectedEntries);
            const replacementIds = selectedIds.length > 0
                ? ((!this._fallbackPlayer && deck)
                    ? deck.drawManyFor('player', selectedIds.length)
                    : this.fallbackIds(playerDraw, selectedIds.length))
                : [];
            this.animateReplacementCards(composer, replacementIds, selectedEntries);
        });
    }

    private removeExchangedCards(entries: Array<{ card: Node; id: string; slot: number }>): void {
        for (const { card } of entries) {
            this.detachCardHandlers(card);
            this._selected.delete(card);
            this._row.delete(card);
            this._homeSlot.delete(card);
            this._cardIds.delete(card);
            if (card && card.isValid) killNode(card);
        }
    }

    private animateReplacementCards(composer: ComposerLike, ids: string[], entries: Array<{ card: Node; id: string; slot: number }>): void {
        const items: Array<{ card: Node; start: Vec3; target: Vec3; startScale: Vec3; targetScale: Vec3; startEuler: Vec3; targetEuler: Vec3 }> = [];
        const start = this.canvasLocal(this.deckWorldPoint());
        for (let i = 0; i < ids.length; i++) {
            const entry = entries[i];
            if (!entry) break;
            const card = composer.composeCard(toCardId(ids[i]), 'InitialMulligan_Replacement_' + entry.slot + '_' + Date.now());
            if (!card || !card.isValid || !this._overlay) continue;
            card.setParent(this._overlay, true);
            card.setPosition(start.x, start.y, 40 + entry.slot);
            card.setRotationFromEuler(0, 0, 0);
            card.setScale(0.24, 0.24, 1);
            card.setSiblingIndex(this._overlay.children.length - 1);
            this._cardIds.set(card, toCardId(ids[i]));
            this.ensureAmuletCostBadge(card, toCardId(ids[i]));
            this._row.set(card, 'bottom');
            this._homeSlot.set(card, entry.slot);
            const bottomSlot = this._bottomSlots[entry.slot];
            const target = bottomSlot ? bottomSlot.position.clone() : new Vec3(-65, this._bottomRowY, 10 + entry.slot);
            items.push({
                card,
                start: start.clone(),
                target,
                startScale: new Vec3(0.24, 0.24, 1),
                targetScale: new Vec3(this.cardScale, this.cardScale, 1),
                startEuler: new Vec3(0, 0, entry.slot % 2 === 0 ? 8 : -8),
                targetEuler: new Vec3(0, 0, 0),
            });
        }
        if (this.verbose && ids.length > 0) console.log('[BattleInitialHand] 从牌组抽取并飞入原位置：' + ids.join(', '));
        this.animateNodeBatch(items, 0.58, () => {
            this.layoutRows();
            this.finalizeIntoHand();
        });
    }

    private finalizeIntoHand(): void {
        if (!this._active || !this._hand || !this._handNode) return;
        const finalCards = Array.from(this._cardIds.keys())
            .filter(card => card && card.isValid && this._row.get(card) === 'bottom')
            .sort((a, b) => (this._homeSlot.get(a) ?? 0) - (this._homeSlot.get(b) ?? 0));
        if (finalCards.length === 0) {
            this.clearOverlay();
            this.finish();
            return;
        }
        const starts = new Map<Node, { world: Vec3; scale: Vec3; euler: Vec3 }>();
        for (const card of finalCards) {
            starts.set(card, { world: card.worldPosition.clone(), scale: card.scale.clone(), euler: card.eulerAngles.clone() });
        }
        this._hand.suppressSweep = true;
        for (let i = 0; i < finalCards.length; i++) {
            const card = finalCards[i];
            const id = this._cardIds.get(card);
            if (!id) continue;
            this.detachCardHandlers(card);
            card.setParent(this._handNode, true);
            const adoptAt = this._hand.adoptCardAt;
            if (adoptAt) adoptAt.call(this._hand, card, id, i);
            else this._hand.adoptCard(card, id);
        }
        this._hand.suppressSweep = false;
        this._hand.refresh();
        const items = finalCards.map(card => {
            const start = starts.get(card);
            const target = card.position.clone();
            const targetScale = card.scale.clone();
            const targetEuler = card.eulerAngles.clone();
            const startLocal = start ? this.localInParent(start.world, this._handNode!) : card.position.clone();
            if (start) {
                card.setPosition(startLocal);
                card.setScale(start.scale);
                card.setRotationFromEuler(start.euler.x, start.euler.y, start.euler.z);
            }
            return {
                card,
                start: startLocal,
                target,
                startScale: start?.scale || card.scale.clone(),
                targetScale,
                startEuler: start?.euler || new Vec3(),
                targetEuler,
            };
        });
        // 两段换牌动画完成后先移除交换界面，再播放最终手牌入场动画。
        this.clearOverlay();
        this.animateNodeBatch(items, 0.66, () => {
            for (const item of items) {
                if (!item.card.isValid) continue;
                item.card.setPosition(item.target);
                item.card.setScale(item.targetScale);
                item.card.setRotationFromEuler(item.targetEuler.x, item.targetEuler.y, item.targetEuler.z);
            }
            this._selected.clear();
            this._row.clear();
            this._homeSlot.clear();
            this._cardIds.clear();
            this._handlers.clear();
            this.clearOverlay();
            this._hand.refresh();
            if (this.verbose) console.log('[BattleInitialHand] 下行最终 ' + finalCards.length + ' 张收编进正式手牌并完成入场动画');
            this.finish();
        });
    }

    private animateNodeBatch(items: Array<{ card: Node; start: Vec3; target: Vec3; startScale: Vec3; targetScale: Vec3; startEuler: Vec3; targetEuler: Vec3 }>, duration: number, done: () => void): void {
        if (items.length === 0) {
            setTimeout(() => { if (this._active) done(); }, 180);
            return;
        }
        const timeline = { p: 0 };
        const stagger = 0.1;
        const total = duration + Math.max(0, items.length - 1) * stagger;
        let completed = false;
        const apply = (): void => {
            try {
                for (let i = 0; i < items.length; i++) {
                    const item = items[i];
                    if (!item.card || !item.card.isValid) continue;
                    const local = Math.max(0, Math.min(1, (timeline.p * total - i * stagger) / duration));
                    const eased = local * (2 - local);
                    item.card.setPosition(
                        item.start.x + (item.target.x - item.start.x) * eased,
                        item.start.y + (item.target.y - item.start.y) * eased,
                        item.start.z + (item.target.z - item.start.z) * eased,
                    );
                    item.card.setScale(
                        item.startScale.x + (item.targetScale.x - item.startScale.x) * eased,
                        item.startScale.y + (item.targetScale.y - item.startScale.y) * eased,
                        item.startScale.z + (item.targetScale.z - item.startScale.z) * eased,
                    );
                    item.card.setRotationFromEuler(
                        item.startEuler.x + (item.targetEuler.x - item.startEuler.x) * eased,
                        item.startEuler.y + (item.targetEuler.y - item.startEuler.y) * eased,
                        item.startEuler.z + (item.targetEuler.z - item.startEuler.z) * eased,
                    );
                }
            } catch (e) {
                // 动画期间节点可能被场景重载销毁，下一帧继续由完成守卫收束。
            }
        };
        tween(timeline)
            .to(total, { p: 1 }, { easing: 'quadInOut', onUpdate: apply })
            .call(() => {
                if (completed) return;
                completed = true;
                try { apply(); } catch (e) { /* 最终回调仍需执行 */ }
                if (this._active) done();
            })
            .start();
    }

    private finish(): void {
        if (!this._active) return;
        this._active = false;
        this._confirming = false;
        this.unbindCardPointers();
        this.clearOverlay();
        const done = this._done;
        this._done = null;
        if (this.verbose) console.log('[BattleInitialHand] 初始手牌阶段完成，进入第一回合');
        if (done) done();
    }

    private destroyTemporaryCards(): void {
        for (const card of Array.from(this._cardIds.keys())) {
            this.detachCardHandlers(card);
            if (card && card.isValid) killNode(card);
        }
        this._cardIds.clear();
        this._homeSlot.clear();
        this._row.clear();
        this._selected.clear();
    }

    private clearOverlay(): void {
        if (this._overlay && this._overlay.isValid) {
            endModalLayer(this._overlay);
            this._overlay.removeFromParent();
            this._overlay.destroy();
        }
        this._overlay = null;
        this._slots = [];
        this._bottomSlots = [];
    }

    private detachCardHandlers(card: Node): void {
        const bound = this._handlers.get(card);
        if (!bound) return;
        for (const item of bound) {
            const node = item.node;
            const h = item.handlers;
            if (!node.isValid) continue;
            node.off(Node.EventType.TOUCH_START, h.start, this);
            node.off(Node.EventType.TOUCH_MOVE, h.move, this);
            node.off(Node.EventType.TOUCH_END, h.end, this);
            node.off(Node.EventType.TOUCH_CANCEL, h.cancel, this);
        }
        this._handlers.delete(card);
    }

    private moveToCanvas(card: Node, world: Vec3): void {
        if (!this._overlay || !card.isValid) return;
        card.setParent(this._overlay, true);
        const local = this.canvasLocal(world);
        card.setPosition(local.x, local.y, 40);
        card.setSiblingIndex(this._overlay.children.length - 1);
    }

    private eventWorld(event: EventTouch): Vec3 {
        const ui = event.getUILocation();
        return this.screenToWorld(ui.x, ui.y);
    }

    private mouseEventWorld(event: EventMouse): Vec3 {
        const ui = event.getLocation();
        return this.screenToWorld(ui.x, ui.y);
    }

    private screenToWorld(x: number, y: number): Vec3 {
        const screen = new Vec3(x, y, 0);
        const out = new Vec3();
        const cam = this.findComponent<Camera>('cc.Camera');
        if (cam) cam.screenToWorld(screen, out); else out.set(x, y, 0);
        return out;
    }

    private canvasLocal(world: Vec3): Vec3 {
        const ut = this._canvas?.getComponent(UITransform);
        return ut ? ut.convertToNodeSpaceAR(world, new Vec3()) : world.clone();
    }

    private localInParent(world: Vec3, parent: Node): Vec3 {
        const ut = parent.getComponent(UITransform);
        return ut ? ut.convertToNodeSpaceAR(world, new Vec3()) : world.clone();
    }

    private deckWorldPoint(): Vec3 {
        // 换牌演出统一飞向画面右下角，避免和左下角我方状态栏重叠。
        const canvasUt = this._canvas?.getComponent(UITransform);
        if (canvasUt) return canvasUt.convertToWorldSpaceAR(new Vec3(540, -270, 0), new Vec3());
        return this._canvas?.worldPosition.clone() || new Vec3(0, 0, 0);
    }

    private fallbackIds(draw: DrawLike, n: number): string[] {
        const pool = (draw.testCardIds || ['1.png', '2.png', '3.png', '4.png']).filter(Boolean).map(toCardId);
        if (pool.length === 0) return [];
        const out: string[] = [];
        for (let i = 0; i < n; i++) out.push(pool[i % pool.length]);
        return out;
    }

    private findNode(name: string): Node | null {
        const scene = this.node.scene as unknown as Node | null;
        if (!scene) return null;
        const queue: Node[] = [...scene.children];
        while (queue.length) {
            const node = queue.shift() as Node;
            if (node.name === name) return node;
            for (const child of node.children) queue.push(child);
        }
        return null;
    }

    private findComponent<T>(className: string): T | null {
        const scene = this.node.scene as unknown as Node | null;
        if (!scene) return null;
        const queue: Node[] = [...scene.children];
        while (queue.length) {
            const node = queue.shift() as Node;
            const component = node.getComponent(className);
            if (component) return component as unknown as T;
            for (const child of node.children) queue.push(child);
        }
        return null;
    }
}
