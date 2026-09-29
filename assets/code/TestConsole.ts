import { _decorator, Button, Color, Component, Graphics, Label, Node, Sprite, UITransform } from 'cc';

const { ccclass, menu } = _decorator;

/**
 * TestConsole —— 测试控制台（运行时由 CardDraw 的「控制台」按钮挂到 Canvas 上）
 * ===========================================================================
 * 取代旧的左上角「生成卡牌测试面板」。点击「控制台」按钮开/关，功能：
 *   ① 为**我方**生成指定卡牌 ×N（走 CardDraw 抽卡动画，一次 drawMany 批量抽）；
 *   ② 为**敌方**抽指定卡牌（EnemyCardDraw.drawMany：卡背从右上角镜像位入画，
 *      多张时一张入画后分裂、各自飞入敌方手牌最左，收编为真实卡背）；
 *   ③ 让**敌方手牌中的指定第几张**（1 = 最左）打出入敌方战场（EnemyCardPlay.playCardAt）；
 *   ④ 清空敌方手牌。
 *
 * 全部组件引用按**类名字符串**查找（CardDraw / EnemyHandLayout / EnemyCardPlay），
 * 不静态 import —— 避免与 CardDraw 形成循环依赖（CardDraw → 本组件）。
 * ===========================================================================
 */
@ccclass('TestConsole')
@menu('gf2szb/TestConsole')
export class TestConsole extends Component {

    // ------------------------------ 内部状态 ------------------------------
    private _panel: Node | null = null;
    private _selIdx = 0;            // 选中卡牌在 cardIds 里的下标
    private _count = 1;             // 一次生成几张
    private _playNo = 1;            // 敌方打出：第几张（1 基，1 = 最左）
    private _cardLabel: Node | null = null;
    private _countLabel: Node | null = null;
    private _playLabel: Node | null = null;
    private _ehCountLabel: Node | null = null;
    // 多选模式：勾选若干不同卡牌，一次各抽一张
    private _multi = false;
    private _picked: Set<string> = new Set<string>();
    private _chips: Node | null = null;
    private _singleWidgets: Node[] = [];
    // —— 回合控制区（操作 TurnManager）——
    private _turnStatusLabel: Node | null = null;   // 「第 N 大回合 · 先手(我方) 行动中 · 1/2」
    private _firstBtn: Node | null = null;          // 「先手: 我方 / 敌方」切换按钮
    private _tmCache: any = null;                   // TurnManager 引用缓存（findComp 是 BFS，别每帧重扫）
    // —— 敌方人机（EnemyBattleAI.autoDrive）——
    private _aiBtn: Node | null = null;             // 「AI: 开 / 关」总开关按钮
    private _aiCache: any = null;                   // EnemyBattleAI 引用缓存

    // ------------------------------ 生命周期 / 开关 ------------------------------
    start(): void {
        this.buildPanel();
    }

    update(): void {
        // 回合状态对账：只在**面板可见**时才做（面板关着时连 BFS 都不该跑）
        if (!this._panel || !this._panel.isValid || !this._panel.active) return;
        this.refreshTurnStatus();
    }

    /** 开/关控制台面板（CardDraw 的「控制台」按钮调用） */
    public toggle(): void {
        if (this._panel && this._panel.isValid) {
            this._panel.active = !this._panel.active;
        }
    }

    // ------------------------------ 面板构建 ------------------------------
    private buildPanel(): void {
        const canvas = this.node;
        const panel = new Node('TestConsolePanel');
        panel.setParent(canvas);
        const put = panel.addComponent(UITransform);
        put.setAnchorPoint(0.5, 0.5);
        // 540×460：上半仍是原来的抽卡/打出控件，下半是本轮新增的**回合控制区**。
        // 位置：上边缘压在 y=300（避开左上角「控制台」按钮 314..350），下边缘到 y=-160。
        put.setContentSize(540, 460);
        panel.setPosition(-640 + 280, 300 - 230, 0);
        // 🔴 灰色半透明背景：Sprite 不给 spriteFrame 是渲染不出来的（之前那层底实际不可见），
        //    改用 Graphics 直接在面板根上画一块圆角矩形 —— 不依赖任何贴图资源。
        //    画在面板根节点 = 父节点先渲染、子节点（按钮）后渲染 → 背景天然垫底。
        const g = panel.addComponent(Graphics);
        g.fillColor = new Color(128, 128, 128, 165);      // 灰色 + 半透明
        g.strokeColor = new Color(90, 90, 90, 200);
        g.lineWidth = 2;
        g.roundRect(-270, -230, 540, 460, 10);
        g.fill();
        g.stroke();

        // —— 行 1：选卡 + 数量 ——
        const prev = this.makeButton(panel, '◀', -240, 72, 40);
        const cardLabel = this.makeLabel(panel, this.currentId(), -160, 72, 130);
        this._cardLabel = cardLabel;
        const next = this.makeButton(panel, '▶', -70, 72, 40);
        const cPrev = this.makeButton(panel, '◀', -10, 72, 40);
        const countLabel = this.makeLabel(panel, '数量: ' + this._count, 70, 72, 110);
        this._countLabel = countLabel;
        const cNext = this.makeButton(panel, '▶', 145, 72, 40);
        this._singleWidgets = [prev, cardLabel, next, cPrev, countLabel, cNext];

        // —— 行 1 右端：单选/多选切换 ——
        const multiBtn = this.makeButton(panel, '单张×N', 225, 72, 80);
        multiBtn.on(Button.EventType.CLICK, () => this.toggleMulti(multiBtn), this);
        this.buildChips(panel);

        prev.on(Button.EventType.CLICK, () => {
            const ids = this.cardIds();
            this._selIdx = (this._selIdx - 1 + ids.length) % ids.length;
            this.setLabel(this._cardLabel, this.currentId());
        }, this);
        next.on(Button.EventType.CLICK, () => {
            const ids = this.cardIds();
            this._selIdx = (this._selIdx + 1) % ids.length;
            this.setLabel(this._cardLabel, this.currentId());
        }, this);
        cPrev.on(Button.EventType.CLICK, () => {
            this._count = Math.max(1, this._count - 1);
            this.setLabel(this._countLabel, '数量: ' + this._count);
        }, this);
        cNext.on(Button.EventType.CLICK, () => {
            this._count = Math.min(9, this._count + 1);
            this.setLabel(this._countLabel, '数量: ' + this._count);
        }, this);

        // —— 行 2：我方抽卡 / 敌方抽卡 / 清空敌方 ——
        const drawBtn = this.makeButton(panel, '我方抽卡', -165, 24, 130);
        const ehAddBtn = this.makeButton(panel, '敌方抽卡', -15, 24, 130);
        const clearBtn = this.makeButton(panel, '清空敌方', 145, 24, 110);
        drawBtn.on(Button.EventType.CLICK, () => this.playerDraw(), this);
        ehAddBtn.on(Button.EventType.CLICK, () => this.enemyDraw(), this);
        clearBtn.on(Button.EventType.CLICK, () => {
            const ehl = this.findComp('EnemyHandLayout');
            if (ehl) { ehl.clearHand(); this.refreshEnemyCount(); }
        }, this);

        // —— 行 3：敌方打出指定第几张 ——
        const pPrev = this.makeButton(panel, '◀', -240, -24, 40);
        const playLabel = this.makeLabel(panel, '打出第 1 张', -150, -24, 150);
        this._playLabel = playLabel;
        const pNext = this.makeButton(panel, '▶', -60, -24, 40);
        const goBtn = this.makeButton(panel, '打出入战场', 45, -24, 140);
        const ehCount = this.makeLabel(panel, '敌方手牌: 0 张', 185, -24, 150);
        this._ehCountLabel = ehCount;
        pPrev.on(Button.EventType.CLICK, () => {
            this._playNo = Math.max(1, this._playNo - 1);
            this.setLabel(this._playLabel, '打出第 ' + this._playNo + ' 张');
        }, this);
        pNext.on(Button.EventType.CLICK, () => {
            const ehl = this.findComp('EnemyHandLayout');
            const max = ehl ? ehl.cardCount : 9;
            this._playNo = Math.min(Math.max(1, max), this._playNo + 1);
            this.setLabel(this._playLabel, '打出第 ' + this._playNo + ' 张');
        }, this);
        goBtn.on(Button.EventType.CLICK, () => this.enemyPlay(), this);

        // —— 行 4：提示 ——
        this.makeLabel(panel, '我方=抽卡动画入场；敌方=抽卡入列（多张时一张入画后分裂）；「多选」=勾选不同卡各抽一张',
            0, -72, 520);

        this.buildTurnSection(panel);

        this.refreshEnemyCount();
        this.refreshTurnStatus();
        this._panel = panel;
    }

    // ------------------------------ 回合控制区 ------------------------------
    /**
     * 下半区的回合控制（全部操作 TurnManager）：
     *   ① 状态行：第 N 大回合 · 先手/后手(我方/敌方) 行动中 · x/2
     *   ② [先手: 我方/敌方] 点击切换（**立即从第 1 大回合重开**，效果马上可见）
     *   ③ [随机开战]   重新掷先后手并进入第 1 大回合（= TurnManager.begin）
     *   ④ [重开对决]   保留当前先后手，从第 1 大回合重来（= TurnManager.restart）
     *   ⑤ [结束我方回合] / [结束敌方回合]  —— 「结束我方回合」与点右侧回合钮等价
     *   ⑥ [AI: 开/关]  敌方人机总开关（`EnemyBattleAI.autoDrive`）——
     *      开 = 敌方回合自动「出牌 → 进化 → 攻击 → 结束回合」；关 = 完全不自动行动，
     *      敌方回合交回给 ⑤ 的手动按钮（标签每帧与组件实际值对账）。
     */
    private buildTurnSection(panel: Node): void {
        this._turnStatusLabel = this.makeLabel(panel, '回合状态：—', 0, -116, 520);

        const firstBtn = this.makeButton(panel, '先手: 我方', -150, -158, 140);
        this._firstBtn = firstBtn;
        const newBtn = this.makeButton(panel, '随机开战', 0, -158, 120);
        const restartBtn = this.makeButton(panel, '重开对决', 140, -158, 120);
        firstBtn.on(Button.EventType.CLICK, () => this.toggleFirstSide(), this);
        newBtn.on(Button.EventType.CLICK, () => this.newBattle(), this);
        restartBtn.on(Button.EventType.CLICK, () => this.restartBattle(), this);

        const endPlayerBtn = this.makeButton(panel, '结束我方回合', -95, -200, 170);
        const endEnemyBtn = this.makeButton(panel, '结束敌方回合', 95, -200, 170);
        endPlayerBtn.on(Button.EventType.CLICK, () => this.endPlayerTurn(), this);
        endEnemyBtn.on(Button.EventType.CLICK, () => this.endEnemyTurn(), this);

        // —— 同行右端：敌方人机总开关（改 EnemyBattleAI.autoDrive，标签实时对账）——
        //   🔴 关掉后敌方回合完全不自动行动，仍可用左边的「结束敌方回合」手动推进。
        const aiBtn = this.makeButton(panel, 'AI: 开', 224, -200, 86);
        aiBtn.on(Button.EventType.CLICK, () => this.toggleEnemyAI(), this);
        this._aiBtn = aiBtn;
        this.refreshEnemyAiLabel();
    }

    /** TurnManager 引用（带缓存；组件销毁后自动重找） */
    private turnManager(): any {
        if (this._tmCache && this._tmCache.isValid) return this._tmCache;
        this._tmCache = this.findComp('TurnManager');
        return this._tmCache;
    }

    /** 把 TurnManager 的状态刷到控制台（文本没变就不写 Label） */
    private refreshTurnStatus(): void {
        const tm = this.turnManager();
        const txt = tm && tm.statusText ? tm.statusText : '回合状态：未找到 TurnManager';
        const node = this._turnStatusLabel;
        if (node && node.isValid) {
            const lb = node.getComponent(Label);
            if (lb && lb.string !== txt) lb.string = txt;
        }
        const btn = this._firstBtn;
        if (btn && btn.isValid && tm && tm.firstSide) {
            const lb = btn.getChildByName('label');
            const label = lb ? lb.getComponent(Label) : null;
            const want = '先手: ' + (tm.firstSide === 'player' ? '我方' : '敌方');
            if (label && label.string !== want) label.string = want;
        }
        // 敌方人机开关：值可能被脚本 / Inspector 改掉 → 每帧对账一次
        this.refreshEnemyAiLabel();
    }

    /** 切换先后手：立即从第 1 大回合重开（方便对两种先手流程各测一遍） */
    private toggleFirstSide(): void {
        const tm = this.turnManager();
        if (!tm) { console.warn('[TestConsole] 找不到 TurnManager'); return; }
        tm.setFirstSide(tm.firstSide === 'player' ? 'enemy' : 'player', true);
        this.refreshTurnStatus();
    }

    /** 重新随机开战（清空双方战场+手牌 → 重掷先后手 → 第 1 大回合） */
    private newBattle(): void {
        const tm = this.turnManager();
        if (!tm) { console.warn('[TestConsole] 找不到 TurnManager'); return; }
        if (tm.resetBattle) tm.resetBattle(true); else tm.begin();
        this.refreshTurnStatus();
    }

    /** 保留当前先手，清空双方战场+手牌，从第 1 大回合重开 */
    private restartBattle(): void {
        const tm = this.turnManager();
        if (!tm) { console.warn('[TestConsole] 找不到 TurnManager'); return; }
        if (tm.resetBattle) tm.resetBattle(false); else tm.restart();
        this.refreshTurnStatus();
    }

    // ------------------------------ 敌方人机开关 ------------------------------
    /** EnemyBattleAI 引用（带缓存；组件销毁后自动重找） */
    private enemyAI(): any {
        if (this._aiCache && this._aiCache.isValid) return this._aiCache;
        this._aiCache = this.findComp('EnemyBattleAI');
        return this._aiCache;
    }

    /**
     * 开/关敌方人机：直接改 `EnemyBattleAI.autoDrive`（与 Inspector 上那个勾选框同一个值）。
     * 关掉 = 敌方回合完全不自动行动（仍可用「结束敌方回合」手动推进）；
     * 打开 = 该敌方回合会按 出牌 → 进化 → 攻击 → 结束回合 自动走完。
     */
    private toggleEnemyAI(): void {
        const ai = this.enemyAI();
        if (!ai) {
            console.warn('[TestConsole] 找不到 EnemyBattleAI（应挂在 EnemyHandArea 上）');
            return;
        }
        ai.autoDrive = !ai.autoDrive;
        console.log(`[TestConsole] 敌方人机自动行动 → ${ai.autoDrive ? '开' : '关'}`);
        this.refreshEnemyAiLabel();
    }

    /** 把当前 autoDrive 值刷到按钮标签（没变就不写 Label） */
    private refreshEnemyAiLabel(): void {
        const btn = this._aiBtn;
        if (!btn || !btn.isValid) return;
        const lb = btn.getChildByName('label');
        const label = lb ? lb.getComponent(Label) : null;
        if (!label) return;
        const ai = this.enemyAI();
        const want = ai ? (ai.autoDrive ? 'AI: 开' : 'AI: 关') : 'AI: —';
        if (label.string !== want) label.string = want;
    }

    /** 结束我方操作回合（与点右侧「结束回合」钮同一条路径） */
    private endPlayerTurn(): void {
        const tm = this.turnManager();
        if (!tm) { console.warn('[TestConsole] 找不到 TurnManager'); return; }
        if (!tm.endPlayerTurn()) console.warn('[TestConsole] 当前不是我方操作回合，无法结束我方回合');
        this.refreshTurnStatus();
    }

    /** 结束敌方操作回合 → 走完后手，大回合 +1 */
    private endEnemyTurn(): void {
        const tm = this.turnManager();
        if (!tm) { console.warn('[TestConsole] 找不到 TurnManager'); return; }
        if (!tm.endEnemyTurn()) console.warn('[TestConsole] 当前不是敌方操作回合，无法结束敌方回合');
        this.refreshTurnStatus();
    }

    // ------------------------------ 功能 ------------------------------
    /** 当前抽卡 id 列表：单选 = 选中 id × 数量；多选 = 勾选的各 id 各一张（null = 未选有效项） */
    private pickIds(): string[] | null {
        if (!this._multi) {
            const ids: string[] = [];
            for (let i = 0; i < this._count; i++) ids.push(this.currentId());
            return ids;
        }
        const picked = this.cardIds().filter((id) => this._picked.has(id));
        if (picked.length === 0) {
            console.warn('[TestConsole] 多选模式：请先勾选至少一张卡牌');
            return null;
        }
        return picked;
    }

    /** 我方抽卡：走 CardDraw.drawMany（带翻牌/飞入手牌动画）。
     *  🔴 优先从卡组背包随机抽（对局中只能从卡组抽）；无 CardDeckManager 时退回「指定卡牌」。 */
    private playerDraw(): void {
        const cd = this.findComp('CardDraw');
        if (!cd) { console.warn('[TestConsole] 找不到 CardDraw'); return; }
        const dm = this.findComp('CardDeckManager');
        let ids: string[] | null = null;
        if (dm && dm.drawManyFor) {
            ids = dm.drawManyFor('player', this._count);
            if (ids.length === 0) { console.warn('[TestConsole] 我方卡组已抽空'); return; }
            if (ids.length < this._count) console.warn(`[TestConsole] 我方卡组只剩 ${ids.length} 张，本次按剩余张数抽`);
        } else {
            ids = this.pickIds();
        }
        if (!ids) return;
        const ok = cd.drawMany(ids);
        if (!ok) console.warn('[TestConsole] 我方抽卡未起手（动画进行中 / 卡背未就绪）');
    }

    /**
     * 敌方抽卡（EnemyCardDraw.drawMany，队列化）：
     * 一张卡背从我方抽卡起点的镜像位（右上角）沿长边直移入画；
     * **多张时在入画点分裂成 N 张**，各自转正飞入敌方手牌最左 N 格。
     */
    private enemyDraw(): void {
        const ecd = this.findComp('EnemyCardDraw');
        if (!ecd) { console.warn('[TestConsole] 找不到 EnemyCardDraw（需挂在 EnemyHandArea 上）'); return; }
        const dm = this.findComp('CardDeckManager');
        let ids: string[] | null = null;
        if (dm && dm.drawManyFor) {
            // 🔴 从敌方卡组背包随机抽（与回合开始抽卡同一条路）；卡组空则按剩余量抽
            ids = dm.drawManyFor('enemy', this._count);
            if (ids.length === 0) { console.warn('[TestConsole] 敌方卡组已抽空'); return; }
            if (ids.length < this._count) console.warn(`[TestConsole] 敌方卡组只剩 ${ids.length} 张，本次按剩余张数抽`);
        } else {
            ids = this.pickIds();
        }
        if (!ids) return;
        const ok = ecd.drawMany(ids);
        if (!ok) console.warn('[TestConsole] 敌方抽卡未起手（队列为空？）');
        // 收编发生在动画结束时，延迟刷新一次计数
        this.scheduleOnce(() => this.refreshEnemyCount(), 1.0);
    }

    // ------------------------------ 多选模式 ------------------------------
    /** 单选（选中的 id × 数量）↔ 多选（勾选的各 id 各一张）切换 */
    private toggleMulti(btn: Node): void {
        this._multi = !this._multi;
        const lb = btn.getChildByName('label');
        const label = lb ? lb.getComponent(Label) : null;
        if (label) label.string = this._multi ? '多选' : '单张×N';
        for (const w of this._singleWidgets) {
            if (w && w.isValid) w.active = !this._multi;
        }
        if (this._chips && this._chips.isValid) this._chips.active = this._multi;
    }

    /** 构建多选卡牌勾选行（按 CardDraw.testCardIds 生成，勾选态用 ✓ + 变色标注） */
    private buildChips(panel: Node): void {
        const box = new Node('PickChips');
        box.setParent(panel);
        const ut = box.addComponent(UITransform);
        ut.setAnchorPoint(0.5, 0.5);
        ut.setContentSize(520, 40);
        box.setPosition(0, 72, 0);
        box.active = false;
        const ids = this.cardIds();
        const w = 52, gap = 8;
        const total = ids.length * (w + gap) - gap;
        const startX = -total / 2 + w / 2;
        for (let i = 0; i < ids.length; i++) {
            const id = ids[i];
            const name = id.replace(/\.[a-z0-9]+$/i, '');
            const chip = this.makeButton(box, name, startX + i * (w + gap), 0, w);
            chip.on(Button.EventType.CLICK, () => this.togglePick(chip, id, name), this);
        }
        this._chips = box;
    }

    /** 勾/取消一张卡牌（选中：✓ + 橙色文字；取消：还原） */
    private togglePick(chip: Node, id: string, name: string): void {
        const added = !this._picked.has(id);
        if (added) this._picked.add(id);
        else this._picked.delete(id);
        const lb = chip.getChildByName('label');
        const label = lb ? lb.getComponent(Label) : null;
        if (label) {
            label.string = added ? ('✓' + name) : name;
            label.color = added ? new Color(255, 200, 80, 255) : new Color(255, 255, 255, 255);
        }
    }

    /** 敌方手牌第 _playNo 张（1 基）打出入敌方战场 */
    private enemyPlay(): void {
        const ecp = this.findComp('EnemyCardPlay');
        if (!ecp) { console.warn('[TestConsole] 找不到 EnemyCardPlay（需挂在 EnemyHandArea 上）'); return; }
        const ehl = this.findComp('EnemyHandLayout');
        if (ehl && this._playNo > ehl.cardCount) {
            console.warn(`[TestConsole] 敌方手牌只有 ${ehl.cardCount} 张，无法打出第 ${this._playNo} 张`);
            this._playNo = Math.max(1, ehl.cardCount);
            this.setLabel(this._playLabel, '打出第 ' + this._playNo + ' 张');
            return;
        }
        const ok = ecp.playCardAt(this._playNo - 1);
        if (!ok) console.warn('[TestConsole] 敌方打出未起手（动画中 / 法术 / 战场已满）');
        this.refreshEnemyCount();
    }

    // ------------------------------ 小工具 ------------------------------
    private cardIds(): string[] {
        const cd = this.findComp('CardDraw');
        const ids = cd && cd.testCardIds && cd.testCardIds.length > 0
            ? cd.testCardIds.slice()
            : ['1.png', '2.png', '3.png'];
        return ids;
    }

    private currentId(): string {
        const ids = this.cardIds();
        if (this._selIdx >= ids.length) this._selIdx = 0;
        return ids[this._selIdx];
    }

    /** 全场景按类名找组件（BFS） */
    private findComp(className: string): any {
        const scene = this.node.scene as unknown as Node | null;
        if (!scene) return null;
        const stack: Node[] = [...scene.children];
        while (stack.length > 0) {
            const cur = stack.shift() as Node;
            const c = cur.getComponent(className);
            if (c) return c;
            for (const ch of cur.children) stack.push(ch);
        }
        return null;
    }

    private setLabel(labelNode: Node | null, text: string): void {
        if (!labelNode || !labelNode.isValid) return;
        const lb = labelNode.getComponent(Label);
        if (lb) lb.string = text;
    }

    private refreshEnemyCount(): void {
        const ehl = this.findComp('EnemyHandLayout');
        this.setLabel(this._ehCountLabel, '敌方手牌: ' + (ehl ? ehl.cardCount : 0) + ' 张');
    }

    // ------------------------------ 控件工厂（与 CardDraw 同款样式）------------------------------
    private makeButton(parent: Node, text: string, x: number, y: number, w = 78): Node {
        const n = new Node('btn');
        n.setParent(parent);
        const ut = n.addComponent(UITransform);
        ut.setAnchorPoint(0.5, 0.5);
        ut.setContentSize(w, 36);
        n.setPosition(x, y, 0);
        const sp = n.addComponent(Sprite);
        sp.type = Sprite.Type.SIMPLE;
        sp.sizeMode = Sprite.SizeMode.CUSTOM;
        sp.color = new Color(58, 92, 150, 255);
        const btn = n.addComponent(Button);
        btn.transition = Button.Transition.COLOR;
        btn.hoverColor = new Color(78, 112, 170, 255);
        btn.pressedColor = new Color(40, 70, 120, 255);
        const lb = new Node('label');
        lb.setParent(n);
        const lut = lb.addComponent(UITransform);
        lut.setAnchorPoint(0.5, 0.5);
        lut.setContentSize(w, 36);
        const label = lb.addComponent(Label);
        label.string = text;
        label.fontSize = w <= 50 ? 14 : 15;
        label.isBold = true;
        label.color = new Color(255, 255, 255, 255);
        label.horizontalAlign = Label.HorizontalAlign.CENTER;
        label.verticalAlign = Label.VerticalAlign.CENTER;
        return n;
    }

    private makeLabel(parent: Node, text: string, x: number, y: number, w = 96): Node {
        const lb = new Node('label');
        lb.setParent(parent);
        const ut = lb.addComponent(UITransform);
        ut.setAnchorPoint(0.5, 0.5);
        ut.setContentSize(w, 30);
        lb.setPosition(x, y, 0);
        const label = lb.addComponent(Label);
        label.string = text;
        label.fontSize = 15;
        label.isBold = true;
        label.color = new Color(255, 240, 200, 255);
        label.horizontalAlign = Label.HorizontalAlign.CENTER;
        label.verticalAlign = Label.VerticalAlign.CENTER;
        return lb;
    }
}
