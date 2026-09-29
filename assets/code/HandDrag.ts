import { _decorator, Camera, Canvas, Component, EventTouch, Node, Tween, tween, UITransform, Vec2, Vec3 } from 'cc';
import { HandLayout } from './HandLayout';
import { isComposedCard } from './CardComposer';
import { raiseLayer as raiseLayerShared, releaseLayer as releaseLayerShared } from './LayerOrder';

const { ccclass, property, requireComponent, menu } = _decorator;

/**
 * HandDrag —— 手牌拖拽（按住拖动，松手匀速回位）
 * ===========================================================================
 * 挂在**手牌区节点**（与 HandLayout 同一个节点，如 Canvas/PlayerHandArea）上，
 * 由它统一监听整个手牌区的按下/移动/抬起，本节点就是「用户操作层」：
 *
 *   PlayerHandArea                       ← HandLayout（排布） + HandDrag（本脚本：交互）
 *   ├── Card_1.png                 ← 被按下的那张被"拖起来"，**其余卡牌一律不动**
 *   ├── Card_2.png_2
 *   └── CardFactory
 *
 * 交互流程
 *   按下：**只登记候选卡，不立刻起手**（🔴 按下 ≠ 准备使用）。
 *         命中哪张卡就记哪张 —— **同时只允许一张**（已在拖拽时忽略后续按下）；
 *         命中空白处不响应。此时卡牌的外观 / 层级**完全不变**，
 *         「按一下不动」= 只是点了一下（说明卡片接手）。
 *   拖动：按住后指针**移动超过 `dragStartDistance`**（UI 像素）才真正起手，
 *         起手那一刻才做以下事情：
 *           · 记录「**按下点** → 卡牌中心」的抓取偏移（手牌区本地单位），保证卡牌不会跳
 *           · **手牌层整体提到同层最上层**（raiseLayerOnDrag），使被拖的卡能盖住战场卡牌 ——
 *             只在本层内部置顶（bringToFront）管不了跨层遮挡：手牌层若排在战场层之前，
 *             无论层内怎么置顶，整层都会被战场压住
 *           · 该卡提到层内最上层（bringToFront，仅改它自己的兄弟序号）
 *           · 整体放大到 dragScale 倍（tween 过渡，growDuration 秒）
 *           · 旋转归零、竖直立正（straighten），不再保持手牌弧线上的微小倾角
 *         其余卡牌的位置 / 大小 / 角度 / 层级**完全不动**；被拖走的卡空出的位置
 *         **保持空着，不做任何合并或重排**。
 *   移动：卡牌跟随指针 —— 用**绝对 UI 坐标**换算到手牌区本地坐标后直接定位
 *         （不累加增量、不做补间），指针与卡牌严格 1:1，跟手不拖沓。
 *   松手：先问 `releaseHandler`（若有）要不要**接管**这张卡 —— 接管则交给它（如 CardPlay
 *         判定为「使用卡牌」并播入战场动画），本组件彻底放手；
 *         没接管则用 tween 以**匀速（linear）**在 returnDuration 秒内回到按下前的
 *         **位置 / 大小 / 角度**，动画走完再恢复它原来的兄弟序号（回程中仍压在最上层），
 *         并把手牌层放回原来的层级（若还有别的卡在拖/在回位，则留到最后一张收尾时再放）。
 *
 * 暴露给 Cocos 面板的可调参数
 *   dragScale       拖拽时卡牌整体放大的倍数（相对手牌中的原始大小）
 *   growDuration    「变大 + 立正」过渡动画时长（秒）
 *   returnDuration  松手后回位动画时长（秒）—— 恒定速度
 *   bringToFront    拖拽时在**手牌区内部**把该卡提到最上层
 *   raiseLayerOnDrag 拖拽时把手牌层提到**同层最上层**（跨层遮挡战场等其它图层）
 *
 * 说明
 *   · 需要手牌区节点自身带 UITransform 且尺寸能罩住所有卡牌（PlayerHandArea 的
 *     1280×400 足够），触摸事件在**手牌区节点**上做一次命中判定，卡牌本身不挂监听。
 *   · 本脚本只改「被拖的那张卡」的节点变换，不会调用 HandLayout.refresh()，
 *     因此在拖拽过程中其它手牌不会被重新排布。
 * ===========================================================================
 */
@ccclass('HandDrag')
@requireComponent(UITransform)
@menu('gf2szb/HandDrag')
export class HandDrag extends Component {

    // ====================== 拖拽表现（核心可调参数）======================
    @property({ range: [1, 3, 0.01], slide: true, tooltip: '拖拽时卡牌**整体放大的倍数**（相对它在手牌里的原始大小）。\n'
        + '1.35 = 放大到 135%。\n'
        + '整张卡（卡图/卡框/费用/卡名/血攻）作为一个整体等比放大。' })
    dragScale = 1.35;

    @property({ range: [0, 1, 0.01], slide: true, tooltip: '「变大 + 立正」的过渡动画时长（秒），用 tween 完成。\n'
        + '0 = 不做过渡，按下瞬间直接变成拖拽状态。' })
    growDuration = 0.12;

    @property({ range: [0, 2, 0.01], slide: true, tooltip: '松手后回到手牌原位的动画时长（秒），用 tween 完成，**恒定速度**（linear，不缓入缓出）。\n'
        + '回位同时包含：位置、大小、角度三项。\n'
        + '0 = 立刻归位。' })
    returnDuration = 0.25;

    // ====================== 行为开关 ======================
    @property({ tooltip: '总开关：关闭后整块手牌区不响应任何拖拽' })
    enableDrag = true;

    @property({ tooltip: '拖拽时把卡牌提到手牌区最上层（会遮住相邻卡牌）。\n'
        + '只改这一张卡的兄弟序号，其余卡牌之间的先后关系不变。' })
    bringToFront = true;

    @property({ tooltip: '拖拽时把手牌层（本节点）临时提到**同一父节点下的最上层**，\n'
        + '让被拖的卡牌能盖住战场等其它图层（bringToFront 只管手牌区内部，管不了跨层遮挡）。\n'
        + '松手后的回位动画播放完毕自动还原原来的层级。\n'
        + '关闭后拖拽只在本层内部置顶，无法盖住战场卡牌。' })
    raiseLayerOnDrag = true;

    @property({ tooltip: '拖拽时把卡牌摆正（旋转归零、竖直立正），不再保持手牌扇形里的微小倾角。\n'
        + '与放大共用同一个过渡时长 growDuration。' })
    straighten = true;

    /**
     * 🔴 **按下不等于起手**：按住后指针**移动超过这个距离**（UI 像素）才真正进入拖拽
     *    （=「准备使用」：放大 / 立正 / 提到最上层）。
     *    按一下不动 → 什么都不发生（说明卡片接手），不会再出现「点一下卡牌就被
     *    放大立正一次」的准备使用表现。
     */
    @property({ range: [0, 120, 1], slide: true, tooltip: '★按住后**移动多少像素才进入拖拽（准备使用）**。\n'
        + '按一下不动 = 只是点了一下（说明卡片用），不会起手。0 = 按下立刻起手（旧行为）。' })
    dragStartDistance = 12;

    // ====================== 松手接管（供 CardPlay 等使用）======================
    /**
     * 松手接管钩子：设置后，`endDrag` 在播放回位动画**之前**先调用它。
     * 返回 `true` = 外部接管这张卡 —— 本组件随后**不再碰它**（不播回位动画、
     * 不还原它的层序、也不再认为它在拖拽），只把自己这层的临时提升还原掉。
     *
     * 典型用法：拖过判定高度 → 判定为「使用卡牌」，由 CardPlay 接管播
     * 「移到屏幕正中 → 绕 Y 翻转 + 贝塞尔飞入战场」。返回 false 则一切照旧（匀速回位）。
     */
    public releaseHandler: ((card: Node) => boolean) | null = null;

    @property({ type: HandLayout, tooltip: '（可选）手牌区布局组件；留空自动在本节点上查找。\n'
        + '用途：① 取得当帧实际生效的基础缩放（autoFit 收缩时以它为准）；② 取卡牌集合做命中判定。' })
    handLayout: HandLayout | null = null;

    // ------------------------------ 内部状态 ------------------------------
    /** 当前正在被拖拽的卡牌（null = 没有拖拽）—— 保证「同时只拖一张」 */
    private _card: Node | null = null;
    /** 正在拖拽的那根手指/指针 id，只有它的事件才驱动本次拖拽 */
    private _touchId = -1;
    /**
     * 🔴 已按下、但**还没拖够距离**的候选卡（null = 没有）。
     * 按下只登记候选，真正 `beginDrag` 要等 `onTouchMove` 里位移超过 `dragStartDistance`。
     * 这样「按一下不动」不会触发「放大 / 立正 / 提层」那套准备使用表现。
     */
    private _pendingCard: Node | null = null;
    /** 候选卡的按下点（UI 坐标）—— 起手时用它算抓取偏移，卡牌才不会跳 */
    private readonly _pendingUI = new Vec2();
    /** 按下点(手牌区本地坐标) → 卡牌中心 的抓取偏移，保证拖拽时卡牌不跳 */
    private readonly _grab = new Vec3();
    /** 被拖卡牌按下前的原始状态（位置/欧拉角/缩放/兄弟序号），松手后回到这里 */
    private _home: HomeState | null = null;
    /**
     * 正在「回位动画」中的卡牌 → 它们的原始状态。
     * 用途：动画没走完用户又按住同一张卡时，仍能拿到**真正的**原位（否则会把
     * 动画中途的位置误当成原位，导致手牌错位）；动画结束时清掉。
     */
    private readonly _returning = new Map<Node, HomeState>();
    /** 缓存的 UI 相机（Canvas 上那台），用于「屏幕(UI)坐标 → 世界坐标」换算 */
    private _cam: Camera | null = null;
    // 说明：拖拽期间的「手牌层临时置顶」状态由 LayerOrder 统一按引用计数管理
    //      （与 CardDraw 抽卡动画共用同一份计数，谁都不会把对方还在用的置顶态提前还原）。

    // ------------------------------ 生命周期 ------------------------------
    onEnable(): void {
        this.node.on(Node.EventType.TOUCH_START, this.onTouchStart, this);
        this.node.on(Node.EventType.TOUCH_MOVE, this.onTouchMove, this);
        this.node.on(Node.EventType.TOUCH_END, this.onTouchEnd, this);
        this.node.on(Node.EventType.TOUCH_CANCEL, this.onTouchEnd, this);
    }

    onDisable(): void {
        this.node.off(Node.EventType.TOUCH_START, this.onTouchStart, this);
        this.node.off(Node.EventType.TOUCH_MOVE, this.onTouchMove, this);
        this.node.off(Node.EventType.TOUCH_END, this.onTouchEnd, this);
        this.node.off(Node.EventType.TOUCH_CANCEL, this.onTouchEnd, this);
        // 组件被关掉时把正在拖的牌直接放回原位（不留下悬空状态）
        this._pendingCard = null;                     // 候选卡一并作废
        this._touchId = -1;
        if (this._card) this.endDrag(false);
        // 且确保手牌层的临时提升一定还原（回位 tween 被打断时 .call 不会执行）
        this.restoreLayer(true);
    }

    // ------------------------------ 触摸入口 ------------------------------
    // 🔴 **按下 ≠ 起手**：按下只「登记候选卡」，要等按住并拖动超过 `dragStartDistance`
    //    才真正 `beginDrag`（= 进入准备使用模式：放大 / 立正 / 提到最上层）。
    //    这样「按一下不动」只是单纯点了一下卡牌（说明卡片接手），不会再出现
    //    「点一下手牌就被放大立正一次、再缩回去」的准备使用表现。
    private onTouchStart(event: EventTouch): void {
        if (!this.enableDrag) return;
        if (this._card) return;                       // 已在拖拽 → 忽略（同时只允许一张）
        if (!isPrimaryButton(event)) return;          // 鼠标右键/中键不参与

        const ui = event.getUILocation();
        const card = this.pickCard(ui);
        if (!card) return;                            // 没点到卡牌（空白处）

        this._touchId = event.getID();
        this._pendingCard = card;
        this._pendingUI.set(ui.x, ui.y);
    }

    private onTouchMove(event: EventTouch): void {
        if (event.getID() !== this._touchId) return;  // 不是本次按下的那根指针
        if (this._card) {                             // 已在拖拽 → 照旧跟手
            this.dragToUI(event.getUILocation());
            return;
        }
        if (!this._pendingCard) return;
        const ui = event.getUILocation();
        const dx = ui.x - this._pendingUI.x;
        const dy = ui.y - this._pendingUI.y;
        if (dx * dx + dy * dy <= this.dragStartDistance * this.dragStartDistance) return;
        // 起手：🔴 抓取偏移按**按下点**算（不是当前点）→ 卡牌不会因为先拖了一段而跳位
        const card = this._pendingCard;
        this._pendingCard = null;
        this.beginDrag(card, this._pendingUI);
        this.dragToUI(ui);
    }

    private onTouchEnd(event: EventTouch): void {
        if (event.getID() !== this._touchId) return;
        this._touchId = -1;
        this._pendingCard = null;                     // 没拖起来 = 只是点了一下（说明卡片接手）
        if (!this._card) return;
        this.endDrag(true);
    }

    // ------------------------------ 对外 API（也可用代码 / 测试脚本调用）-----------------------------
    /** 当前正在被拖拽的卡牌；没有则为 null */
    public get draggingCard(): Node | null {
        return this._card;
    }

    /** 是否正在拖拽 */
    public get isDragging(): boolean {
        return this._card !== null;
    }

    /** 已按下但还没拖够距离的候选卡（null = 没有）；探针 / 调试用 */
    public get pendingCard(): Node | null {
        return this._pendingCard;
    }

    /**
     * 用「UI 坐标」（= event.getUILocation() 的坐标系）起手拖拽。
     * 该方法内部会做命中判定：点到哪张卡就拖哪张，并记录抓取偏移。
     * @param uiPos UI 空间坐标（与 event.getUILocation() 同一坐标系）
     * @returns 是否成功抓起一张卡（false = 点在空白处 / 已在拖拽 / 总开关关闭）
     */
    public beginDragAt(uiPos: Vec2): boolean {
        if (!this.enableDrag || this._card) return false;
        const card = this.pickCard(uiPos);
        if (!card) return false;
        this._touchId = -1;
        this.beginDrag(card, uiPos);
        return true;
    }

    /**
     * 拖拽中：把被拖的卡牌移动到指针所在的 **UI 坐标**（绝对定位，1:1 跟手）。
     * 内部用「UI → 手牌区本地」的坐标换算，因此手牌区即便有缩放/旋转也跟得准，
     * 并且不依赖任何「增量」的单位假设（指针与卡牌中心保持按下瞬间的相对偏移）。
     */
    public dragToUI(uiPos: Vec2 | Vec3): void {
        const c = this._card;
        if (!c || !c.isValid) return;
        const local = this.toAreaLocal(uiPos);
        c.setPosition(local.x - this._grab.x, local.y - this._grab.y, c.position.z);
    }

    /**
     * 拖拽中：按「手牌区本地坐标」的位移增量平移被拖卡牌。
     * 供代码/脚本调用；鼠标与触摸走的是 dragToUI（绝对定位，不怕单位差异）。
     */
    public dragBy(delta: Vec2 | Vec3): void {
        const c = this._card;
        if (!c || !c.isValid) return;
        const p = c.position;
        c.setPosition(p.x + delta.x, p.y + delta.y, p.z);
    }

    /** UI 坐标 → 手牌区（本节点）本地坐标 */
    private toAreaLocal(uiPos: Vec2 | Vec3): Vec3 {
        const world = this.uiToWorld(uiPos);
        const ut = this.node.getComponent(UITransform);
        return ut ? ut.convertToNodeSpaceAR(world, _nodeLocal) : world;
    }

    /**
     * 🔴 关键：输入事件的 `getUILocation()` 是**屏幕(UI)坐标**，而 `convertToNodeSpaceAR`
     * 要的是**世界坐标**，两者之间隔着 UI 相机的正交投影（当「设计分辨率」与「实际可视区」
     * 高度不一致时，二者相差一个缩放系数；直接用 UI 坐标当世界坐标会让拖拽跟手比例错误）。
     * 这里用 Canvas 上的 UI 相机做一次 `screenToWorld`（与引擎自身命中判定用的是同一条路径），
     * 因此无论分辨率怎么适配都换算得准。结果写入模块级 scratch（同步使用，安全）。
     */
    private uiToWorld(uiPos: Vec2 | Vec3): Vec3 {
        Vec3.set(_uiScratch, uiPos.x, uiPos.y, 0);
        const cam = this.uiCamera();
        if (cam) cam.screenToWorld(_uiScratch, _worldScratch);
        else Vec3.copy(_worldScratch, _uiScratch);
        return _worldScratch;
    }

    /**
     * 取 UI 相机（Canvas 上那台）。
     * ⚠️ 本引擎构建的 `Node` **没有 `getComponentInParent`**（只有 `getComponentInChildren`），
     *    因此这里手动沿 `parent` 链向上找 Canvas，再取它的 `cameraComponent`。
     * 取不到时返回 null，调用方退化为「UI 坐标即世界坐标」。
     */
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

    /**
     * 松手：被拖的卡牌匀速（linear）回到手牌中原位、原大小、原角度。
     * @param animate false = 不播放动画，立刻归位（组件关掉/强制清理时用）
     * @returns 是否有卡牌被放下
     */
    public endDrag(animate = true): boolean {
        const card = this._card;
        const home = this._home;
        this._card = null;
        this._touchId = -1;
        this._home = null;
        if (!card || !home || !card.isValid) return false;

        Tween.stopAllByTarget(card);                  // 掐掉可能还在跑的「变大」动画

        // 🔑 松手接管：先问外部（CardPlay）要不要拿走这张卡。
        //    返回 true = 判定为「使用卡牌」等，本组件彻底放手，交给它播后续动画。
        if (animate && this.releaseHandler && this.releaseHandler(card)) {
            this._returning.delete(card);              // 回位记录一并清掉，避免留下僵尸条目
            this.restoreLayer();                       // 手牌层放回原位（卡已交出，不再需要压在最上层）
            return true;
        }

        // 入场动画期间手牌可能已经重排：回位目标以当前 HandLayout 为准，避免回到旧槽位。
        const targetHome = this.homeForReturn(card, home);
        const dur = Math.max(0, this.returnDuration);
        if (!animate || dur <= 0) {
            this.applyHome(card, targetHome);
            this.restoreLayer();
            return true;
        }

        // 回程中仍旧压在最上层（兄弟序号等动画结束再还回去）
        this._returning.set(card, targetHome);
        tween(card)
            .to(dur, {
                position: targetHome.pos.clone(),
                eulerAngles: targetHome.euler.clone(),
                scale: targetHome.scale.clone(),
            }, { easing: 'linear' })                  // 匀速
            .call(() => {
                this.applyHome(card, targetHome);
                this._returning.delete(card);
                // 回位动画彻底走完、且没有别的卡还在拖/在回位，才把手牌层放回原位
                this.restoreLayer();
            })
            .start();
        return true;
    }

    /** 当前布局下这张牌应回到的目标；不在手牌集合时退回按下时记录。 */
    private homeForReturn(card: Node, fallback: HomeState): HomeState {
        const hand = this.resolveHandLayout();
        if (!hand || hand.cards.length === 0) return fallback;
        const idx = hand.cards.indexOf(card);
        if (idx < 0) return fallback;
        const t = hand.currentTargets()[idx];
        if (!t) return fallback;
        return {
            pos: t.pos.clone(),
            euler: t.euler.clone(),
            scale: t.scale.clone(),
            sibling: t.sibling,
        };
    }

    /** 中断拖拽并立刻归位（不播动画） */
    public cancelDrag(): void {
        this.endDrag(false);
    }

    /** 编辑器内调试用：把当前手牌所有卡牌记录的原位状态清掉 */
    public clearReturningRecords(): void {
        this._returning.clear();
    }

    // ------------------------------ 拖拽核心 ------------------------------
    /** 开始拖拽某张卡：记录原始状态与抓取偏移 → 提到最上层 → tween 放大 + 立正 */
    private beginDrag(card: Node, uiPos?: Vec2 | Vec3): void {
        Tween.stopAllByTarget(card);                  // 之前可能还在回位，先停掉

        // 原始状态：优先复用「回位动画」里记着的那份（动画中途再按住同一张卡时，
        // 节点当前位置不是原位，必须用记录里的原位，否则回错地方）
        const pending = this._returning.get(card);
        if (pending) this._returning.delete(card);
        // 🔧 起手前先整队：把上一次拖拽「回位中」仍压在最上层、导致盖住右侧卡的卡，
        //    回落到规范层序（详见 restackCanonical），避免本次拖拽时被它遮挡。
        this.restackCanonical();
        // 🔴 关键：兄弟序号必须用「规范层序」（= 卡牌在手牌数组里的稳定下标），
        //    不能用 captureHome 里 card.getSiblingIndex() 取到的**实时**序号。
        //    因为 bringToFront 把某张卡提到末位时，会把它右边的所有卡序号都 -1；
        //    若此时再拖右邻卡，右邻记录到的实时序号是「被左移后的」，会导致两张卡
        //    回位时抢同一个序号、最后谁先到 0 谁被推到上层 —— 出现「左卡盖住右卡」的层序反转 bug。
        const home = pending ?? captureHome(card, this.canonicalSibling(card));

        this._card = card;
        this._home = home;

        // 抓取偏移：按下点 → 卡牌中心（手牌区本地单位）。没有坐标（纯代码调用）时按中心对齐。
        if (uiPos) {
            const local = this.toAreaLocal(uiPos);
            Vec3.set(this._grab, local.x - home.pos.x, local.y - home.pos.y, 0);
        } else {
            Vec3.set(this._grab, 0, 0, 0);
        }

        // 先把手牌层整体提到同层最上层，这样下面 card 的「层内置顶」才有意义
        // （否则本层还在战场层之下，层内怎么置顶都会被战场卡牌压住）
        this.raiseLayer();

        if (this.bringToFront && card.parent) {
            card.setSiblingIndex(card.parent.children.length - 1);
        }

        const target = this.baseScale() * Math.max(0.01, this.dragScale);
        const z = card.scale.z;
        const props: { scale: Vec3; eulerAngles?: Vec3 } = { scale: new Vec3(target, target, z) };
        if (this.straighten) props.eulerAngles = new Vec3(0, 0, 0);

        const dur = Math.max(0, this.growDuration);
        if (dur <= 0) {
            card.setScale(props.scale);
            if (props.eulerAngles) card.setRotationFromEuler(props.eulerAngles);
            return;
        }
        tween(card).to(dur, props, { easing: 'quadOut' }).start();
    }

    /**
     * 把手牌所有卡牌的兄弟序号一次性恢复成「HandLayout.cards 数组顺序」对应的规范层序
     * （第 i 张卡固定到第 i 层，最右边那张在最上层）。
     *
     * 为什么必须整队而不是只还原单张：
     *   bringToFront 把某张卡提到末位时，会把**它右边所有卡**的兄弟序号都 -1（被压到下层）。
     *   如果只在「被拖 / 回位」的那张卡上 setSiblingIndex(home.sibling) 还原，那些被连带下移、
     *   但自己从未被拖拽过的卡（比如最右边的卡）就永远卡在底层 —— 这正是「左/中卡盖住右卡」的
     *   层序反转 bug。因此每次「起手拖拽」和「回位动画结束」都要全队重排，保证右手永远压在左手之上。
     *   正在被拖拽的那张卡（this._card）不参与整队，保持它最上层的置顶态。
     */
    private restackCanonical(): void {
        const hand = this.resolveHandLayout();
        if (!hand || hand.cards.length === 0) return;
        for (let i = 0; i < hand.cards.length; i++) {
            const c = hand.cards[i];
            if (!c || !c.isValid) continue;
            if (c === this._card) continue;          // 正在拖的卡保持置顶
            c.setSiblingIndex(i);
        }
    }

    /** 把卡牌按记录的原位状态摆回去（位置 / 欧拉角 / 缩放 / 兄弟序号） */
    private applyHome(card: Node, home: HomeState): void {
        if (!card.isValid) return;
        card.setPosition(home.pos);
        card.setRotationFromEuler(home.euler);
        card.setScale(home.scale);
        // 整队重排（右手压左手）；没有布局组件时退回「按记录的规范层序」还原单张
        const hand = this.resolveHandLayout();
        if (hand && hand.cards.length > 0) this.restackCanonical();
        else card.setSiblingIndex(home.sibling);
    }

    // ------------------------------ 跨层遮挡（手牌层 vs 战场层）------------------------------
    /**
     * 把手牌层（本节点）临时提到**同一父节点下的最上层**。
     *
     * 为什么需要：`bringToFront` 只在本层内部调兄弟序号，管不了**跨层**遮挡。
     * 渲染顺序 = 场景树深度优先展开，所以只要手牌层在战场层之前（兄弟序号更小），
     * 那么无论手牌内部怎么置顶，被拖的卡牌都会整体被战场卡牌压住。
     * 把本层提到最上层后，手牌层的所有卡（含正被拖的那张）就都盖上去了。
     *
     * 状态由 LayerOrder 按**引用计数**统一管理（CardDraw 抽卡动画共用一个计数器，
     * 因此两者重叠时不会互相把对方还在用的置顶态提前还原）。
     */
    private raiseLayer(): void {
        if (!this.raiseLayerOnDrag) return;
        raiseLayerShared(this.node, this);
    }

    /**
     * 释放本组件对「手牌层置顶」的要求。
     * @param force true = 无条件释放（组件关闭等必须收尾的场合）；
     *              false = 仅在「没有卡在拖、也没有卡在回位」时释放
     *              （否则回位动画还没播完，把层放回去会让回程中的卡被战场盖住）。
     *
     * 注：这里是「释放本组件的这一份要求」。若 CardDraw 等其它组件仍持有该层，
     *     层会保持置顶不动（引用计数 > 0）。
     */
    private restoreLayer(force = false): void {
        if (!force && (this._card !== null || this._returning.size > 0)) return;
        releaseLayerShared(this.node, this);
    }

    /**
     * 手牌当前的基础缩放（未放大时的大小）。
     * 以 HandLayout 当帧**实际生效**的缩放为准（autoFit 收缩时 cardScale 不是真值）；
     * 没有 HandLayout 时退回卡牌节点自身的 x 缩放。
     */
    private baseScale(): number {
        const hand = this.resolveHandLayout();
        if (hand) return hand.appliedScale;
        return this._card ? this._card.scale.x : 1;
    }

    // ------------------------------ 命中判定 ------------------------------
    /**
     * 找出 UI 坐标 `uiPos` 落在哪张卡上（从最上层往下找，先命中的就是它）。
     * 用卡牌自身的 UITransform 把世界坐标换算到卡牌本地空间再比矩形，
     * 因此卡牌的缩放、旋转都已经算进去了。
     */
    private pickCard(uiPos: Vec2): Node | null {
        const list = this.cardList();
        const world = this.uiToWorld(uiPos);                   // UI(屏幕)坐标 → 世界坐标
        for (let i = list.length - 1; i >= 0; i--) {           // 列表已按「越上层越靠后」排好
            const n = list[i];
            const ut = n.getComponent(UITransform);
            if (!ut) continue;
            const local = ut.convertToNodeSpaceAR(world, _pickLocal);
            const w = ut.contentSize.width;
            const h = ut.contentSize.height;
            const left = -ut.anchorX * w;
            const right = (1 - ut.anchorX) * w;
            const bottom = -ut.anchorY * h;
            const top = (1 - ut.anchorY) * h;
            if (local.x >= left && local.x <= right && local.y >= bottom && local.y <= top) return n;
        }
        return null;
    }

    /** 手牌区里的卡牌集合，按**绘制层级从低到高**排序（最后一个 = 最上层） */
    private cardList(): Node[] {
        const hand = this.resolveHandLayout();
        const out: Node[] = [];
        if (hand && hand.cards.length > 0) {
            for (const c of hand.cards) if (c && c.isValid) out.push(c);
        } else {
            for (const ch of this.node.children) if (isComposedCard(ch)) out.push(ch);
        }
        out.sort((a, b) => a.getSiblingIndex() - b.getSiblingIndex());
        return out;
    }

    /** 找手牌区布局组件：优先 Inspector 指定，其次本节点 */
    private resolveHandLayout(): HandLayout | null {
        if (this.handLayout && this.handLayout.isValid) return this.handLayout;
        return this.getComponent(HandLayout);
    }

    /**
     * 卡牌的「规范渲染层序」= 它在 HandLayout.cards 里的稳定下标
     * （HandLayout.layout() 用 setSiblingIndex(i) 把第 i 张卡固定到第 i 层，所以该下标
     * 就是这张卡在手牌扇形里**本该**处于的层级，无论此刻是否被临时提到最上层）。
     * 找不到布局组件时退化为「实时兄弟序号」（此时无权威层序来源，沿用旧行为）。
     */
    private canonicalSibling(card: Node): number {
        const hand = this.resolveHandLayout();
        if (hand && hand.cards.length > 0) {
            const idx = hand.cards.indexOf(card);
            if (idx >= 0) return idx;
        }
        return card.getSiblingIndex();
    }
}

// ------------------------------ 模块内部工具 ------------------------------
/** 屏幕(UI)坐标暂存（随后被 screenToWorld 覆写为世界坐标） */
const _uiScratch = new Vec3();
/** UI 坐标换算出来的世界坐标 */
const _worldScratch = new Vec3();
/** 命中判定：卡牌自身本地坐标 */
const _pickLocal = new Vec3();
/** 手牌区（本节点）本地坐标 */
const _nodeLocal = new Vec3();

/** 卡牌按下前的原始状态快照 */
interface HomeState {
    /** 手牌区（父节点）本地坐标下的原始位置 */
    pos: Vec3;
    /** 原始欧拉角（手牌弧线上的微小倾角） */
    euler: Vec3;
    /** 原始缩放 */
    scale: Vec3;
    /** 原始兄弟序号（渲染层级） */
    sibling: number;
}

/** 采集一张卡牌当前的完整状态（sibling 用调用方传入的「规范层序」，避免取到被上抬偏移过的实时序号） */
function captureHome(card: Node, sibling = card.getSiblingIndex()): HomeState {
    return {
        pos: card.position.clone(),
        euler: card.eulerAngles.clone(),
        scale: card.scale.clone(),
        sibling,
    };
}

/**
 * 是否「主键」事件（鼠标左键 / 触摸）。
 * 右键、中键不参与拖拽；触摸事件没有按键概念（默认 0）。
 */
function isPrimaryButton(event: EventTouch): boolean {
    const e = event as unknown as { getButton?: () => number };
    if (typeof e.getButton !== 'function') return true;
    return e.getButton() === 0;
}
