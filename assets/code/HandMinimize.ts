import {
    _decorator, Camera, Canvas, Component, EventTouch, Node, tween, UITransform, Vec2, Vec3,
} from 'cc';
import { HandLayout } from './HandLayout';
import { HandDrag } from './HandDrag';
import { BattleFieldLayout } from './BattleFieldLayout';
import { ModeSelectPanel } from './ModeSelectPanel';

const { ccclass, property, requireComponent, menu } = _decorator;

/**
 * HandMinimize —— 我方手牌「完整 ↔ 缩略靠边」切换
 * ===========================================================================
 * 挂在**手牌区节点**（Canvas/PlayerHandArea，与 HandLayout / HandDrag 同节点）。
 *
 * 缩略态（minimize）：
 *   · 排布样式与完整态**完全一样**（同一条向上拱起的圆弧扇形，复用 HandLayout）——
 *     只是把 `cardScale` / `cardGap` 过渡到缩略值、整块手牌区平移到缩略锚点（右下角）；
 *   · **不支持拖拽出牌**（HandDrag.enableDrag 置 false，恢复时还原）；
 *   · **抽卡动画照常可用**（CardDraw 走 HandLayout 收编，自动按当前缩略参数排布）。
 * 完整态（expand）：
 *   · 过渡回缩略前记录的原始位置 / 缩放 / 间距（Inspector 改的参数以缩略那一刻为准）。
 *
 * 触发（本组件自己监听，不侵入 HandDrag / CardDraw）：
 *   · 完整态下，按下**不是**自己手牌卡牌的任意位置（Canvas 全屏监听 + 卡牌矩形命中判定）
 *     → 缩小并移动到缩略锚点；
 *   · 缩略态下，**按下**（无需等待抬起）自己手牌中的某张卡牌 → 放大并移回原位。
 *   · **敌我战场卡牌例外**：按下点落在**我方或敌方战场的任意一张卡牌**上时**不缩略**
 *     —— 战场卡牌的点击 / 按住拖拽都属于「操作战场卡牌」，不该顺带把我方手牌收起来。
 *     卡牌集合取自各战场 `BattleFieldLayout.cards`（权威集合，与 CardPlay 同一份），
 *     因此打出的新卡自动纳入，无常量需要维护。开关 `ignoreBattleFieldTouch`（默认开）。
 *
 * 暴露给 Cocos 面板的可调参数：
 *   transformDuration  「缩小↔放大」过渡 tween **总时间**（秒）—— 两个方向共用同一时长
 *   miniCardScale      缩略态卡牌大小（过渡目标 = HandLayout.cardScale）
 *   miniCardGap        缩略态卡牌间距（过渡目标 = HandLayout.cardGap，px，自动间距模式的卡间空隙）
 *   miniX / miniY      缩略态手牌区锚点（Canvas 本地坐标，默认右下角）
 *
 * 🔴 实现注意：
 *   · HandLayout 的间距是「自动间距」模式（无独立 spacing 属性），缩略间距走 cardGap；
 *   · 过渡用「一个数值 tween 驱动 cardScale/cardGap/位置 + 每帧 refresh()」，位置与布局
 *     由同一份进度值驱动，绝不用两个独立 tween（会走出不一致的缓动）；
 *   · 触摸命中：手牌区节点（1280×400 矩形）包含大量空白，卡牌矩形命中判定自己算
 *     （与 HandDrag.pickCard 同一套换算），不能只看「事件是否落在手牌区」。
 * ===========================================================================
 */
@ccclass('HandMinimize')
@requireComponent(UITransform)
@menu('gf2szb/HandMinimize')
export class HandMinimize extends Component {

    // ====================== 可调参数（Inspector 暴露）======================
    @property({
        range: [0, 3, 0.01], slide: true,
        tooltip: '手牌「缩小↔放大」过渡 tween **总时间**（秒）。\n缩小移动与放大移动共用同一时长；0 = 瞬间切换。',
    })
    transformDuration = 0.35;

    @property({
        range: [0.05, 1, 0.01], slide: true,
        tooltip: '缩略态的**卡牌大小**（过渡目标 = HandLayout.cardScale）。\n弧线形状随缩放等比变化，样式与完整态一致。',
    })
    miniCardScale = 0.3;

    @property({
        range: [-80, 80, 1], slide: true,
        tooltip: '缩略态的**卡牌间距**（过渡目标 = HandLayout.cardGap，px）。\n自动间距模式下的卡间空隙：0 = 紧贴，>0 再拉开。',
    })
    miniCardGap = 0;

    @property({ tooltip: '缩略态手牌区锚点 x（Canvas 本地坐标，右下角方向为正）' })
    miniX = 430;

    @property({ tooltip: '缩略态手牌区锚点 y（Canvas 本地坐标，向下为负）' })
    miniY = -306;

    // ====================== 依赖 ======================
    @property({ type: HandLayout, tooltip: '（可选）手牌布局组件；留空自动在本节点查找。' })
    handLayout: HandLayout | null = null;

    @property({ type: HandDrag, tooltip: '（可选）拖拽组件；缩略态自动禁用拖拽、恢复后重新启用。留空自动在本节点查找。' })
    handDrag: HandDrag | null = null;

    @property({ tooltip: '总开关：监听 Canvas 全屏按下，实现「点自己手牌卡牌以外 → 缩略」。' })
    listenOutsideClick = true;

    @property({
        tooltip: '按下点落在**我方 / 敌方战场的卡牌**上时**不触发手牌缩略**。\n'
            + '打开（默认）：对敌我战场卡牌做点击 / 按住拖拽时，手牌保持当前状态。\n'
            + '关闭 = 恢复旧行为（只有点在手牌卡牌本身才不会缩略）。\n'
            + '⚠️ 只认「卡牌」矩形；战场卡牌之间的空隙仍算空白（照旧缩略）。',
    })
    ignoreBattleFieldTouch = true;

    @property({
        tooltip: '按下点落在**说明卡片（CardTipLayer 的 CardTipPanel）**上时**不触发手牌缩略**。\n'
            + '打开（默认）：说明卡片当「只读浮层」—— 点它不算点空白，手牌保持常态。\n'
            + '⚠️ 与 CardTooltip 自己的「点卡片不收起」用的是同一份矩形判据（同挂 Canvas 各自 hitTest）。',
    })
    ignoreTipPanelTouch = true;

    // ------------------------------ 内部状态 ------------------------------
    private _minimized = false;
    private _animating = false;
    /** 🔴 抽卡动画锁：CardDraw 起手置位、endDraw 复位。锁定期间禁止 缩略↔完整 转换 */
    private _locked = false;
    /** 缩略前记录的原始姿态（位置 / 缩放 / 间距），放大时恢复到这里 */
    private _saved: { pos: Vec3; scale: number; gap: number } | null = null;
    private _cam: Camera | null = null;
    /** 敌我战场布局缓存（全场景 BFS 结果；节点失效时自动重查） */
    private _fields: BattleFieldLayout[] | null = null;
    /** 说明卡片（CardTooltip）引用缓存 —— 只 duck-type 调 `isPointOnPanel`，不 import 它（避免循环依赖） */
    private _tipCache: any = null;

    // ------------------------------ 对外状态 ------------------------------
    /** 当前是否处于缩略态（过渡中也按目标态算） */
    public get isMinimized(): boolean { return this._minimized; }

    /** 是否正在播放缩小/放大过渡 */
    public get isTransitioning(): boolean { return this._animating; }

    /** 抽卡动画锁是否生效（锁定期间 minimize/expand 一律拒绝） */
    public get isLocked(): boolean { return this._locked; }

    /** 供 CardDraw 在抽卡动画期间调用：锁定后禁止 缩略↔完整 转换，直到解锁 */
    public lockTransitions(v: boolean): void { this._locked = v; }

    /**
     * 抽卡动画的锚定补偿（手牌区本地坐标的平移量）：
     *   缩略态 / 任意过渡进行中 = 完整态手牌区位置（_saved.pos）− 当前位置
     *   —— 把「翻牌入场 / 真卡出生点」平移回完整态的位置，保证展示完成前的动画
     *   与正常抽卡逐帧一致（生成点、飞入角度）；
     *   完整态静止 = (0,0,0)。
     * 🔴 expand 过渡也算「手牌区滑动」：expand 起手就把 _minimized 置 false，但节点
     *    仍在从缩略锚点滑回原位 → 若此时立刻抽卡，只看 _minimized 会漏掉补偿，
     *    翻牌全程被手牌区滑动带偏（「每间隔一次抽卡不飞入」的根因）。
     */
    public get animationAnchorOffset(): Vec3 {
        if (!this._saved) return new Vec3(0, 0, 0);
        if (!this._minimized && !this._animating) return new Vec3(0, 0, 0);
        const s = this._saved.pos, c = this.node.position;
        return new Vec3(s.x - c.x, s.y - c.y, 0);
    }

    /**
     * 「完整态」的卡牌基础缩放——供抽卡动画取用：
     *   完整态 = 实时 `appliedScale`（autoFit 收缩时以它为准，与旧行为完全一致）；
     *   缩略态 = 缩略前记录的原缩放（这样「翻牌入场 + 中央展示」的大小与正常抽卡一致，
     *   入场到手牌时再由 placeAllIntoHand 缩小到缩略参数）。
     */
    public get fullAppliedScale(): number {
        const hl = this.resolveHandLayout();
        // 🔴 expand 过渡中 cardScale 是过渡插值（0.3→0.7 途中）→ 必须回退到 _saved.scale，
        //    否则「点手牌卡展开后立刻抽卡」在正中展示出偏小的卡（与锚定漏补偿同源）。
        if (hl && !this._minimized && !this._animating) return hl.appliedScale;
        if (this._saved) return this._saved.scale;
        return hl ? hl.cardScale : 0.55;
    }

    // ------------------------------ 生命周期 ------------------------------
    protected onEnable(): void {
        const cv = this.canvasNode();
        if (cv && this.listenOutsideClick) {
            cv.on(Node.EventType.TOUCH_START, this.onOutsideTouch, this);
        }
        this.node.on(Node.EventType.TOUCH_START, this.onHandTouch, this);
    }

    protected onDisable(): void {
        const cv = this.canvasNode();
        if (cv) cv.off(Node.EventType.TOUCH_START, this.onOutsideTouch, this);
        this.node.off(Node.EventType.TOUCH_START, this.onHandTouch, this);
    }

    // ------------------------------ 对外 API ------------------------------
    /** 缩小并移动到缩略锚点（已在缩略态/过渡中/被抽卡锁定时忽略） */
    public minimize(): void {
        if (this._minimized || this._animating || this._locked) return;
        const hl = this.resolveHandLayout();
        if (!hl) return;
        this._minimized = true;
        this._saved = { pos: this.node.position.clone(), scale: hl.cardScale, gap: hl.cardGap };
        // 缩略态禁用拖拽（需求：缩略展示不需要拖拽出牌）；放大过渡结束后再还原
        const drag = this.resolveHandDrag();
        if (drag) drag.enableDrag = false;
        this.runTransition(hl, { scale: this.miniCardScale, gap: this.miniCardGap },
            new Vec3(this.miniX, this.miniY, this.node.position.z), () => { this._animating = false; });
    }

    /** 放大并移回缩略前的原位/原大小/原间距（已在完整态/过渡中/被抽卡锁定时忽略） */
    public expand(): void {
        if (!this._minimized || this._animating || this._locked) return;
        const hl = this.resolveHandLayout();
        if (!hl) return;
        this._minimized = false;
        const saved = this._saved
            ?? { pos: new Vec3(0, -283.1, this.node.position.z), scale: 0.55, gap: 0 };
        this.runTransition(hl, { scale: saved.scale, gap: saved.gap }, saved.pos.clone(), () => {
            const drag = this.resolveHandDrag();
            if (drag) drag.enableDrag = true;   // 完整态恢复拖拽
            this._animating = false;
        });
    }

    /** 切换缩略/完整 */
    public toggle(): void {
        if (this._minimized) this.expand();
        else this.minimize();
    }

    // ------------------------------ 过渡核心 ------------------------------
    /**
     * 「一个数值 tween」同时驱动 cardScale / cardGap / 节点位置，每帧 refresh() 重排。
     * 位置与布局共用同一份已缓动的进度值 → 两个方向时长必然一致、曲线必然同步。
     */
    private runTransition(hl: HandLayout, to: { scale: number; gap: number },
        toPos: Vec3, done: () => void): void {
        this._animating = true;
        const from = { scale: hl.cardScale, gap: hl.cardGap };
        const fromPos = this.node.position.clone();
        const dur = Math.max(0, this.transformDuration);

        const snap = (k: number): void => {
            hl.cardScale = from.scale + (to.scale - from.scale) * k;
            hl.cardGap = from.gap + (to.gap - from.gap) * k;
            this.node.setPosition(
                fromPos.x + (toPos.x - fromPos.x) * k,
                fromPos.y + (toPos.y - fromPos.y) * k,
                fromPos.z,
            );
            hl.refresh();     // 按当前插值参数瞬时重排（样式与完整态同一套圆弧算法）
        };

        if (dur <= 0) {
            snap(1);
            done();
            return;
        }
        const obj = { t: 0 };
        tween(obj)
            .to(dur, { t: 1 }, {
                easing: 'sineInOut',
                onUpdate: () => snap(obj.t),
            })
            .call(() => {
                snap(1);
                done();
            })
            .start();
    }

    // ------------------------------ 输入 ------------------------------
    /**
     * 手牌区节点上的按下：命中卡牌且当前是缩略态 → 放大。
     * 「按下（无需等待抬起）」与「单击」都由 TOUCH_START 覆盖。
     */
    private onHandTouch(event: EventTouch): void {
        if (!isPrimaryButton(event)) return;
        if (!this._minimized || this._animating) return;
        const card = this.hitCard(event.getUILocation());
        if (card) this.expand();
    }

    /**
     * Canvas 全屏按下：完整态下，只要按的不是自己手牌里的卡牌 → 缩略。
     * （触摸事件会沿命中链冒泡到 Canvas；缩略态按下卡牌的放大由 onHandTouch 处理。）
     */
    private onOutsideTouch(event: EventTouch): void {
        if (!this.listenOutsideClick) return;
        if (!isPrimaryButton(event)) return;
        if (this._minimized || this._animating) return;
        // ★ 「模式」选择中：整屏都是选项面板的地盘 —— 点选项 = 选模式，点别处 = 取消模式，
        //   **都不该被当成「点了手牌外面」而把手牌缩略**（需求：只判定模式选项，不判定其它互动）。
        const mode = ModeSelectPanel.instance;
        if (mode && mode.isSelecting) return;
        const ui = event.getUILocation();
        if (this.hitCard(ui)) return;          // 点在自己手牌卡牌上 → 不缩小
        // 点 / 按住敌我战场上的卡牌 → 也算「在操作卡牌」，不缩小
        if (this.ignoreBattleFieldTouch && this.hitBattleFieldCard(ui)) return;
        // 点在**说明卡片**上 → 说明卡片是只读浮层，不算「点空白」（手牌保持常态、说明也不消失）
        if (this.ignoreTipPanelTouch && this.hitTipPanel(ui)) return;
        this.minimize();
    }

    // ------------------------------ 命中判定（与 HandDrag.pickCard 同一套换算）------------------------------
    /** UI 坐标落在自己手牌的哪张卡上（从最上层往下找）；没点到卡牌返回 null */
    private hitCard(uiPos: Vec2): Node | null {
        const hand = this.resolveHandLayout();
        if (!hand || hand.cards.length === 0) return null;
        const world = this.uiToWorld(uiPos);
        const list = hand.cards.slice().sort(
            (a, b) => a.getSiblingIndex() - b.getSiblingIndex());
        for (let i = list.length - 1; i >= 0; i--) {
            if (hitRect(list[i], world)) return list[i];
        }
        return null;
    }

    /**
     * UI 坐标是否落在**敌我战场**的任意一张卡牌上。
     *
     * 集合取自各战场 `BattleFieldLayout.cards`（战场里「已放上场的卡」的权威来源，
     * CardPlay / BattleFieldPressGlow 用的也是它）→ 新打出的卡自动纳入判定，
     * 不需要在这里维护任何常量或场景引用。
     */
    private hitBattleFieldCard(uiPos: Vec2): boolean {
        const fields = this.battleFields();
        if (fields.length === 0) return false;
        const world = this.uiToWorld(uiPos);
        for (const f of fields) {
            const cards = f.cards;
            for (let i = cards.length - 1; i >= 0; i--) {
                if (hitRect(cards[i], world)) return true;
            }
        }
        return false;
    }

    /**
     * UI 坐标是否落在**说明卡片**（`CardTooltip` 当前显示的面板）矩形内。
     *
     * 口径（与 CardTooltip 同源）：说明卡片是**只读浮层** —— 点它既不是「点空白」（不缩略手牌），
     * 也不是「点底下的卡」（不触发任何按压）；并且它自己也不会收起。
     * 🔴 判据只有一份：`CardTooltip.isPointOnPanel`（本组件不复制矩形算法，避免两处漂移）。
     */
    private hitTipPanel(uiPos: Vec2): boolean {
        const tip = this.tipTooltip();
        if (!tip) return false;
        return typeof tip.isPointOnPanel === 'function' && tip.isPointOnPanel(uiPos) === true;
    }

    /**
     * 全场景 BFS 找说明卡片组件（`CardTooltip`）。
     * 🔴 用**类名字符串**取组件、不 import —— `CardTooltip` 已经 import 本文件，反向 import 会成环。
     * 缓存引用，节点销毁时自动重查。
     */
    private tipTooltip(): any {
        if (this._tipCache && this._tipCache.isValid) return this._tipCache;
        const scene = this.node.scene as unknown as Node | null;
        if (!scene) { this._tipCache = null; return null; }
        const stack: Node[] = [...scene.children];
        while (stack.length > 0) {
            const cur = stack.shift() as Node;
            const c = cur.getComponent('CardTooltip');
            if (c) { this._tipCache = c; return c; }
            for (const ch of cur.children) stack.push(ch);
        }
        this._tipCache = null;
        return null;
    }

    /**
     * 全场景 BFS 收集所有战场布局（我方 + 敌方，只认 `side` 不认节点名）。
     * 结果缓存 —— 战场数量固定，命中判定每帧只发生在触摸时，缓存后即为常数开销；
     * 任一战场节点被销毁 / 移出场景时缓存自动作废并重查。
     */
    private battleFields(): BattleFieldLayout[] {
        const cached = this._fields;
        if (cached && cached.length > 0) {
            let alive = true;
            for (const f of cached) {
                if (!f || !f.isValid) { alive = false; break; }
            }
            if (alive) return cached;
        }
        const scene = this.node.scene as unknown as Node | null;
        if (!scene) { this._fields = null; return []; }
        const out: BattleFieldLayout[] = [];
        const stack: Node[] = [...scene.children];
        while (stack.length > 0) {
            const cur = stack.shift() as Node;
            const c = cur.getComponent(BattleFieldLayout);
            if (c && c.isValid) out.push(c);
            for (const ch of cur.children) stack.push(ch);
        }
        this._fields = out;
        return out;
    }

    /** UI(屏幕)坐标 → 世界坐标（用 Canvas 上的 UI 相机，与引擎命中判定同一条路径） */
    private uiToWorld(uiPos: Vec2 | Vec3): Vec3 {
        Vec3.set(_uiScratch, uiPos.x, uiPos.y, 0);
        const cam = this.uiCamera();
        if (cam) cam.screenToWorld(_uiScratch, _worldScratch);
        else Vec3.copy(_worldScratch, _uiScratch);
        return _worldScratch;
    }

    /** 取 UI 相机（Canvas 上那台；本引擎构建的 Node 没有 getComponentInParent，手动沿 parent 找） */
    private uiCamera(): Camera | null {
        if (this._cam && this._cam.isValid) return this._cam;
        let n: Node | null = this.node;
        while (n) {
            const cv = n.getComponent(Canvas) as unknown as
                { camera?: Camera | null; cameraComponent?: Camera | null } | null;
            if (cv) {
                this._cam = cv.cameraComponent || cv.camera || null;
                if (this._cam) return this._cam;
            }
            n = n.parent;
        }
        return null;
    }

    private canvasNode(): Node | null {
        let n: Node | null = this.node;
        while (n) {
            if (n.getComponent(Canvas)) return n;
            n = n.parent;
        }
        return null;
    }

    private resolveHandLayout(): HandLayout | null {
        if (this.handLayout && this.handLayout.isValid) return this.handLayout;
        return this.getComponent(HandLayout);
    }

    /** 供本组件内部/测试用的拖拽组件解析 */
    resolveHandDrag(): HandDrag | null {
        if (this.handDrag && this.handDrag.isValid) return this.handDrag;
        return this.getComponent(HandDrag);
    }
}

// ------------------------------ 模块内部工具 ------------------------------
const _uiScratch = new Vec3();
const _worldScratch = new Vec3();
const _pickLocal = new Vec3();

/**
 * 世界坐标是否落在该节点的 UITransform 矩形内（缩放 / 旋转都已算进去）。
 * 手牌命中与战场卡牌命中**共用同一套换算**，避免两处判据漂移。
 */
function hitRect(n: Node | null, world: Vec3): boolean {
    if (!n || !n.isValid) return false;
    const ut = n.getComponent(UITransform);
    if (!ut) return false;
    const local = ut.convertToNodeSpaceAR(world, _pickLocal);
    const w = ut.contentSize.width;
    const h = ut.contentSize.height;
    const left = -ut.anchorX * w;
    const right = (1 - ut.anchorX) * w;
    const bottom = -ut.anchorY * h;
    const top = (1 - ut.anchorY) * h;
    return local.x >= left && local.x <= right && local.y >= bottom && local.y <= top;
}

/** 是否「主键」事件（鼠标左键 / 触摸）；右键、中键不参与 */
function isPrimaryButton(event: EventTouch): boolean {
    const e = event as unknown as { getButton?: () => number };
    if (typeof e.getButton !== 'function') return true;
    return e.getButton() === 0;
}
