import { _decorator, Color, Component, director, Graphics, HorizontalTextAlignment, Label, Node, UITransform } from 'cc';
import {
    BattleSetupData, FirstSideChoice, clearPending, peekSetup, setPending, setDeckEditSide,
} from './BattleSetup';

const { ccclass, property, menu } = _decorator;

/** 对战场景的资源名（`assets/scene.scene`） */
const BATTLE_SCENE = 'scene';
/** 卡组编辑场景 */
const DECK_EDIT_SCENE = 'DeckEdit';

/**
 * MainMenu —— **2D 主界面**（设置先后手、进入两个牌组的编辑场景、开始对战）
 * ===========================================================================
 * 需求（2026-09-27 变更）：
 *   · **删掉**主界面自身的「编辑卡牌区域」（左右两块逐张 ± 的面板）与旧的「牌组编辑」按钮
 *     —— 那个按钮只能编辑/保存我方牌组；
 *   · 改为 **「编辑我方牌组」/「编辑人机牌组」两个按钮**：点谁就进卡组编辑场景编辑哪一侧的牌组
 *     （靠 `BattleSetup.setDeckEditSide()` 指定，牌组各自独立持久化）；
 *   · 主界面只保留**只读**的两行牌组概况（几张 / 几种），便于确认双方都已配置；
 *   · 设置先后手：先手 / 后手 / 随机；
 *   · 「开始对战」→ 把设置写进 `BattleSetup` 并 `director.loadScene('scene')`。
 *
 * 界面**全部用代码搭**（不依赖场景里预摆节点）：只要把这个组件挂到 Canvas 上即可。
 * ===========================================================================
 */
@ccclass('MainMenu')
@menu('gf2szb/MainMenu')
export class MainMenu extends Component {

    @property({ tooltip: '标题文字' })
    title = '伊利昂之围';

    @property({ range: [10, 40, 1], slide: true, tooltip: '【正文字号】(px)' })
    fontSize = 20;

    @property({ range: [20, 80, 1], slide: true, tooltip: '【标题字号】(px)' })
    titleSize = 42;

    @property({ type: Color, tooltip: '【页面底色】' })
    bgColor = new Color(14, 22, 34, 255);

    @property({ type: Color, tooltip: '【文字色】（白）' })
    textColor = new Color(255, 255, 255, 255);

    @property({ type: Color, tooltip: '【提示文字色】（浅蓝灰）' })
    hintColor = new Color(168, 190, 210, 255);

    @property({ type: Color, tooltip: '【按钮底色】' })
    buttonColor = new Color(52, 86, 132, 240);

    @property({ type: Color, tooltip: '【按钮选中底色】' })
    buttonActiveColor = new Color(226, 176, 60, 245);

    @property({ type: Color, tooltip: '【开始对战按钮底色】' })
    startColor = new Color(196, 78, 62, 245);

    private _first: FirstSideChoice = 'random';
    private _firstButtons: Array<{ node: Node; choice: FirstSideChoice }> = [];
    private _root: Node | null = null;
    private _hintLabel: Label | null = null;

    // ------------------------------ 生命周期 ------------------------------
    onLoad(): void {
        // 🔴 进主界面就**清掉上一次「开始对战」留下的暂存**：主界面永远从**默认（空牌组）**开始
        //    （用户要求：重新打开时应当 0 张，而不是带出上次的牌组）。
        //    ⚠️ 牌组本体不放在 pending 里 —— 它由 BattleSetup 的**独立持久存储**保存（卡组编辑场景写入）。
        clearPending();
        const s = peekSetup();
        this._first = s.first;
        this.build();
    }

    // ------------------------------ 构建界面 ------------------------------
    private build(): void {
        const W = 1280, H = 720;
        const ut = this.getComponent(UITransform) || this.addComponent(UITransform);
        ut.setAnchorPoint(0.5, 0.5);
        ut.setContentSize(W, H);

        // 页面底
        const bg = this.makeNode('MainMenuBg', this.node, 0, 0, W, H);
        const bgG = bg.addComponent(Graphics);
        bgG.fillColor = this.bgColor;
        bgG.rect(-W / 2, -H / 2, W, H);
        bgG.fill();

        const root = this.makeNode('MainMenuBody', this.node, 0, 0, W, H);
        this._root = root;

        // 标题
        this.makeLabel('title', root, this.title, this.titleSize, this.textColor, 0, H / 2 - 70, W - 80, 60,
            HorizontalTextAlignment.CENTER);

        // ★ 两个入口按钮：编辑我方 / 编辑人机（点谁进卡组编辑场景就编辑哪一侧）
        const s = peekSetup();
        this.buildDeckEntry(root, 'player', '编辑我方牌组', -320, 120, s.playerDeck);
        this.buildDeckEntry(root, 'enemy', '编辑人机牌组', 320, 120, s.enemyDeck);

        // 提示行
        this._hintLabel = this.makeLabel('hint', root,
            '双方牌组都不能为空才能开始对战　·　点上面两个按钮分别编辑我方 / 人机的牌组',
            this.fontSize - 2, this.hintColor, 0, 6, W - 120, 30, HorizontalTextAlignment.CENTER);

        // 底部：先后手 + 开始对战
        this.makeLabel('firstTitle', root, '先后手', this.fontSize, this.hintColor, 0, -78, 200, 26,
            HorizontalTextAlignment.CENTER);
        this.buildFirstSideRow(root, 0, -122);
        this.buildStartButton(root, 0, -H / 2 + 62);
    }

    /** ★ 一侧的入口：大按钮 + 只读牌组概况（张数 / 种类数） */
    private buildDeckEntry(root: Node, side: 'player' | 'enemy', text: string, cx: number, cy: number, deck: string[]): void {
        const btn = this.makeTapButton(root, text, cx, cy, 380, 76, () => this.openDeckEdit(side));
        btn.name = 'DeckEntry_' + side;
        const total = MainMenu.deckTotal(deck);
        const kinds = deck.filter((e) => String(e || '').trim().length > 0).length;
        const summary = this.makeLabel('deckSummary_' + side, root,
            total > 0 ? `已配置：${total} 张 / ${kinds} 种` : '尚未配置（0 张）',
            this.fontSize, total > 0 ? this.textColor : this.hintColor,
            cx, cy - 58, 380, 30, HorizontalTextAlignment.CENTER);
        summary.node.name = 'deckSummary_' + side;
    }

    /** 牌组条目数组 → 总张数（形如 `'2 3'` = id + 张数） */
    private static deckTotal(entries: string[]): number {
        let n = 0;
        for (const raw of entries || []) {
            const s = String(raw || '').trim();
            if (!s) continue;
            const parts = s.split(/\s+/);
            const c = parts.length > 1 ? Math.round(Number(parts[1])) : 1;
            if (Number.isFinite(c) && c > 0) n += c;
        }
        return n;
    }

    /** 进卡组编辑场景：先指定编辑哪一侧，再切场景 */
    private openDeckEdit(side: 'player' | 'enemy'): void {
        try {
            setDeckEditSide(side);
            console.log(`[MainMenu] 进入卡组编辑场景：${side === 'enemy' ? '人机' : '我方'}牌组`);
            director.loadScene(DECK_EDIT_SCENE);
        } catch (e) { console.error('[MainMenu] 打开卡组编辑失败：', e); }
    }

    /** 底部「先后手」三选一 */
    private buildFirstSideRow(root: Node, cx: number, cy: number): void {
        const items: Array<{ c: FirstSideChoice; t: string }> = [
            { c: 'player', t: '我方先手' },
            { c: 'enemy', t: '敌方先手' },
            { c: 'random', t: '随机先后手' },
        ];
        const w = 170, gap = 20;
        const total = items.length * w + (items.length - 1) * gap;
        let x = cx - total / 2 + w / 2;
        for (const it of items) {
            const node = this.makeTapButton(root, it.t, x, cy, w, 46, () => {
                this._first = it.c;
                this.refresh();
            });
            this._firstButtons.push({ node, choice: it.c });
            x += w + gap;
        }
    }

    /** 「开始对战」 */
    private buildStartButton(root: Node, cx: number, cy: number): void {
        const node = this.makeTapButton(root, '开始对战', cx, cy, 320, 54, () => this.startBattle(), this.startColor);
        node.name = 'StartBattleBtn';
    }

    // ------------------------------ 状态 ------------------------------
    /** 把当前状态刷到界面（先后手高亮） */
    private refresh(): void {
        if (!this._root || !this._root.isValid) return;
        for (const b of this._firstButtons) {
            this.paintButton(b.node, b.choice === this._first);
        }
    }

    /** 点「开始对战」：写设置 → 载入对战场景 */
    private startBattle(): void {
        // ★ 双方牌组以**持久牌组**为准（卡组编辑场景保存的）
        const s = peekSetup();
        const data: BattleSetupData = {
            playerDeck: s.playerDeck.slice(),
            enemyDeck: s.enemyDeck.slice(),
            first: this._first,
        };
        if (data.playerDeck.length === 0 || data.enemyDeck.length === 0) {
            const msg = '双方牌组都不能为空，无法开始对战';
            console.log(`[MainMenu] ${msg}`);
            if (this._hintLabel && this._hintLabel.isValid) {
                this._hintLabel.string = `${msg}　·　请先用上面两个按钮编辑牌组`;
                this._hintLabel.color = new Color(255, 120, 110, 255);
            }
            return;
        }
        setPending(data);
        console.log(`[MainMenu] 开始对战：我方 ${data.playerDeck.join('、')} / 敌方 ${data.enemyDeck.join('、')}`
            + ` / 先后手=${data.first} → loadScene('${BATTLE_SCENE}')`);
        // 🔴 双保险：除了 `BattleSetup`（对战场景组件 onLoad 时读），这里在场景**加载完成回调**里
        //    直接找到对战场景的组件再写一次 —— 预览下切场景会重载页面，模块级暂存可能丢失（实测踩过）。
        director.loadScene(BATTLE_SCENE, (err, scene) => {
            if (err) { console.error('[MainMenu] 载入对战场景失败：', err); return; }
            try { this.applyToBattleScene(scene as unknown as Node, data); } catch (e) {
                console.error('[MainMenu] 直接应用设置失败：', e);
            }
        });
    }

    /** 在对战场景里直接应用设置（牌组 + 先后手） */
    private applyToBattleScene(scene: Node | null, data: BattleSetupData): void {
        if (!scene) return;
        const stack: Node[] = [...scene.children];
        let deck: { playerDeck?: string[]; enemyDeck?: string[]; resetDecks?: () => void } | null = null;
        let tm: { randomFirstSideAtStart?: boolean; defaultFirstSide?: string } | null = null;
        while (stack.length > 0) {
            const n = stack.shift() as Node;
            if (!deck) deck = n.getComponent('CardDeckManager') as typeof deck;
            if (!tm) tm = n.getComponent('TurnManager') as typeof tm;
            for (const c of n.children) stack.push(c);
        }
        if (deck) {
            deck.playerDeck = data.playerDeck.slice();
            deck.enemyDeck = data.enemyDeck.slice();
            if (typeof deck.resetDecks === 'function') deck.resetDecks();
            console.log(`[MainMenu] 已把牌组写入对战场景：我方 ${data.playerDeck.join('、')} / 敌方 ${data.enemyDeck.join('、')}`);
        } else {
            console.warn('[MainMenu] 对战场景里没找到 CardDeckManager');
        }
        if (tm) {
            if (data.first === 'random') {
                tm.randomFirstSideAtStart = true;
            } else {
                tm.randomFirstSideAtStart = false;
                tm.defaultFirstSide = data.first;
            }
            console.log(`[MainMenu] 已把先后手写入对战场景：${data.first}`);
        } else {
            console.warn('[MainMenu] 对战场景里没找到 TurnManager');
        }
    }

    // ------------------------------ 小工具 ------------------------------
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

    private makeLabel(
        name: string, parent: Node, text: string, size: number, color: Color,
        x: number, y: number, w: number, h: number, align: HorizontalTextAlignment,
    ): Label {
        const n = this.makeNode(name, parent, x, y, w, h);
        const lb = n.addComponent(Label);
        lb.string = text;
        lb.fontSize = size;
        lb.lineHeight = size + 4;
        lb.color = color;
        lb.horizontalAlign = align;
        lb.overflow = Label.Overflow.SHRINK;      // 🔴 先 SHRINK 再定尺寸
        n.getComponent(UITransform)!.setContentSize(w, h);
        return lb;
    }

    /** 手搓按钮：节点 + Graphics 圆角底 + 文字 + TOUCH_END（不需要 Sprite / cc.Button） */
    private makeTapButton(
        parent: Node, text: string, x: number, y: number, w: number, h: number, onTap: () => void,
        fill?: Color,
    ): Node {
        const n = this.makeNode('btn_' + text, parent, x, y, w, h);
        const g = n.addComponent(Graphics);
        this.drawButton(g, w, h, fill || this.buttonColor);
        const lb = this.makeLabel('t', n, text, Math.min(this.fontSize + 4, h - 22), this.textColor,
            0, 0, w - 18, h, HorizontalTextAlignment.CENTER);
        lb.node.setPosition(0, 0, 0);
        n.on(Node.EventType.TOUCH_END, () => {
            try { onTap(); } catch (e) { console.error('[MainMenu] 按钮回调出错：', e); }
        }, this);
        return n;
    }

    private paintButton(node: Node, active: boolean): void {
        if (!node || !node.isValid) return;
        const ut = node.getComponent(UITransform);
        const g = node.getComponent(Graphics);
        if (!ut || !g) return;
        this.drawButton(g, ut.contentSize.width, ut.contentSize.height,
            active ? this.buttonActiveColor : this.buttonColor);
    }

    private drawButton(g: Graphics, w: number, h: number, color: Color): void {
        g.clear();
        g.fillColor = color;
        g.roundRect(-w / 2, -h / 2, w, h, 8);
        g.fill();
        g.lineWidth = 2;
        g.strokeColor = new Color(240, 244, 250, 200);
        g.roundRect(-w / 2, -h / 2, w, h, 8);
        g.stroke();
    }
}
