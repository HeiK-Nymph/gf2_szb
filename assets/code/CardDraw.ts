import {
    _decorator, assetManager, Button, Camera, Canvas, Color, Component, Label, Node, Sprite,
    SpriteFrame, Tween, UIOpacity, UITransform, Vec3, CCString, view, tween,
} from 'cc';
import { CardComposer, killNode } from './CardComposer';
import { CardDestroyFx } from './CardDestroyFx';
import { toCardId } from './HandLayout';
import { HandLayout, CardTarget } from './HandLayout';
import { HandDrag } from './HandDrag';
import { CardBackBorder } from './CardBackBorder';
import { TestConsole } from './TestConsole';
import { DeckPanel, DECK_PANEL_NAME } from './DeckPanel';
import { raiseLayer as raiseLayerShared, releaseLayer as releaseLayerShared } from './LayerOrder';
import { addToGrave } from './CardDeckManager';

const { ccclass, property, requireComponent, menu } = _decorator;

/**
 * CardDraw —— 抽卡入场动画（编排 PlayerHandArea 上的「卡背翻转 → 真卡揭示 → 飞向手牌」全流程）
 * ===========================================================================
 * 挂在**手牌区节点**（与 HandLayout / HandDrag 同一个节点，如 Canvas/PlayerHandArea）上。
 *
 * 🔴 卡背参考节点由本脚本**动态生成**（不再依赖场景里手动摆放的 CardBack / CardBack-001）：
 *   · CardBack        —— 卡牌刚抽出、还未翻转时的姿态（起始关键帧），名为 "CardBack"
 *   · CardBack-001    —— 卡背完全翻转到的姿态（结束关键帧，揭示前那一瞬），名为 "CardBack-001"
 *   两张节点在运行时由 ensureRefs() 创建（位置/旋转/缩放由下方 pose 属性控制），默认隐藏，
 *   仅作「设计参考」；真正播放动画的是另外建的工作卡背节点 `_drawBack`。
 *
 * 抽卡流程（draw(id) / drawMany(ids) 触发，全部用 tween）：
 *   ① 卡背 CardBack → CardBack-001 翻转（flipDuration 秒）—— 暴露 flipDuration
 *   ② 翻转完成那一瞬，立刻隐藏卡背、把**真实卡牌顶上来**；单抽时是一张、多抽时则是
 *      **N 张同时「瞬间」顶到 CardBack-001 那一帧的姿态**（同名临时节点，互不重叠前先叠在一起）
 *   ③ 所有真卡用 tween 同时「竖直立正(旋转归零) + 变成拖拽样式大小(dragScale) +
 *      移到屏幕正中并**排成一排**」（revealDuration 秒）—— 暴露 revealDuration；
 *      **排成一排时的卡牌间距**由 displaySpacing 控制（暴露该变量）
 *   ④ 在正中**等待 holdDuration 秒**（默认 1s）—— 暴露 holdDuration
 *   ⑤ 等待结束后，所有真卡 tween 飞进手牌**最右边**（依次追加）；与此同时**整份手牌用
 *      tween 重新排布**（每张旧卡从原位补间到新扇形位）—— 两段动画时长相等，均为
 *      placeDuration 秒 —— 暴露 placeDuration
 *   结束状态：所有真卡是手牌最右的连续一段，整份手牌扇形层序与 HandLayout 完全一致，
 *   可被后续 refresh 复用。
 *
 * 🔴 跨层遮挡：动画期间会把手牌层（本节点）整体提到**同层最上层**（raiseLayerOnDraw），
 *   让动画里的卡背与真卡盖住战场卡牌 —— 动画用的所有节点都是本节点的子节点，而本层在场景树里
 *   排在战场层之前，所以层内置顶（toFront）救不了跨层遮挡。动画全部结束（或组件被关闭）后
 *   自动还原；置顶状态由 LayerOrder 按引用计数与 HandDrag 共用，二者重叠时不会互相踩。
 *
 * 测试 UI（屏幕左上角）：showTestPanel = true 时，运行时在 Canvas 左上角生成控件
 *   [◀][当前卡id][▶][＋入队]  —— 选卡后「＋入队」把当前卡加入待抽队列
 *   [生成抽卡][批量生成(N)][清空] —— 「生成抽卡」单抽当前卡；「批量生成(N)」一次抽队列里
 *   的全部 N 张（用于测试本次的多抽功能）；「清空」清空队列。
 * ===========================================================================
 */
@ccclass('CardDraw')
@requireComponent(UITransform)
@menu('gf2szb/CardDraw')
export class CardDraw extends Component {

    // ====================== 卡背贴图 ======================
    @property({ type: SpriteFrame, tooltip: '卡背贴图（SpriteFrame）。留空则按内置 uuid 自动加载 CardBack.png；\n建议拖入 assets/image/cards/cardImage/CardBack.png 以保证发布包包含该资源。' })
    cardBackSpriteFrame: SpriteFrame | null = null;

    // ====================== 卡背关键帧姿态（设计可调）======================
    @property({ type: Vec3, tooltip: 'CardBack（起始关键帧）的本地位置。' })
    backStartPos = new Vec3(784.19, -12.323, 0);

    @property({ type: Vec3, tooltip: 'CardBack（起始关键帧）的欧拉角（度）。z 为手牌倾斜，x 一般为 0。' })
    backStartEuler = new Vec3(0, 0, 61.414);

    @property({ type: Vec3, tooltip: 'CardBack-001（结束关键帧）的本地位置。' })
    backEndPos = new Vec3(337.996, 230.808, 0);

    @property({ type: Vec3, tooltip: 'CardBack-001（结束关键帧）的欧拉角（度）。x=90 表示翻到侧边那一瞬，z 仍保留手牌倾斜。' })
    backEndEuler = new Vec3(90, 0, 61.414);

    @property({ range: [0.05, 3, 0.01], slide: true, tooltip: '卡背参考节点的整体缩放。' })
    backScale = 0.7;

    // ====================== 动画时长（核心可调参数）======================
    @property({ range: [0, 3, 0.01], slide: true, tooltip: '① 卡背从 CardBack 翻转到 CardBack-001 的动画时长（秒）。\n0 = 不做过渡，瞬间翻到。' })
    flipDuration = 0.5;

    @property({ range: [0, 3, 0.01], slide: true, tooltip: '③ 真卡「竖直立正 + 变拖拽样式大小 + 飞到屏幕正中」的动画时长（秒）。\n0 = 不做过渡，瞬间到位。' })
    revealDuration = 0.5;

    @property({ range: [0, 5, 0.01], slide: true, tooltip: '④ 真卡停在屏幕正中等待的时长（秒），默认 1 秒。\n到点后才飞进手牌。' })
    holdDuration = 1.0;

    @property({ range: [0, 3, 0.01], slide: true, tooltip: '⑤ 真卡飞进手牌最右 + 整份手牌 tween 重新排布 的动画时长（秒）；\n两段动画时长相等。0 = 不做过渡，瞬间归位。' })
    placeDuration = 0.4;

    @property({ range: [60, 600, 1], slide: true, tooltip: '③ 多抽时，真卡在屏幕正中「排成一排」的**相邻卡牌中心间距**（px，手牌区局部坐标）。\n间距越小牌越叠、越大牌越散；抽很多张时可调小以免超出屏幕。单抽时此值无意义。' })
    displaySpacing = 230;

    // ====================== 行为开关 ======================
    @property({ tooltip: '抽卡动画期间把手牌层整体提到**同层最上层**，让动画里的卡牌盖住战场卡牌。\n'
        + '手牌层在场景里排在战场层之前，所以层内置顶管不了跨层遮挡（同 HandDrag.raiseLayerOnDrag）。\n'
        + '动画全部结束（真卡飞进手牌落定）后自动还原原来的层级。\n'
        + '关闭后动画卡牌会被战场卡牌压住。' })
    raiseLayerOnDraw = true;

    // ====================== 超过手牌上限的「破坏」表现（Inspector 暴露）======================
    @property({ range: [0, 2, 0.01], slide: true, tooltip: '抽出的牌**超过手牌上限**、塞不进手牌时，在展示后播放破坏动画的时长（秒）。\n同时会在该卡位置播 CardDestroyFx 破坏特效。0 = 瞬间销毁（无动画）。' })
    burnDuration = 0.35;

    @property({ range: [0, 1, 0.01], slide: true, tooltip: '超上限破坏动画结束时缩小到的比例（1 = 不缩小）。' })
    burnEndScale = 0.4;

    @property({ tooltip: '超上限破坏是否做透明度淡出（关闭 = 只缩小）。' })
    burnFade = true;

    @property({ tooltip: '调试用：把动态生成的 CardBack / CardBack-001 参考节点显示出来，方便在运行时核对姿态。默认隐藏。' })
    debugShowReferences = false;

    // ====================== 测试 UI ======================
    @property({ tooltip: '在屏幕左上角生成测试控件：[◀ 选卡][生成抽卡]，方便手动触发抽卡动画。' })
    showTestPanel = true;

    @property({ type: [CCString], tooltip: '测试 UI 里可切换选择的卡牌 id 列表（CardData.CardMap 的 key，如 "1.png"）。' })
    testCardIds: string[] = ['1.png', '2.png', '3.png'];

    // ------------------------------ 内部状态 ------------------------------
    private _busy = false;
    /**
     * **在途额度**：已定判「能进手牌」、但还没落位的张数之和。
     * 逻辑手牌数 = 手牌集合张数 + 它 ⇒ 抽卡决定那一刻就 +N（不等抽卡动画）。
     * 多轮排队时逐批复式累加/交还。
     */
    private _pendingAdopt = 0;
    /** 等待播动画的批次（逻辑已入账，只是舞台被占用 / 上一轮还没播完） */
    private _pendingBatches: DrawBatch[] = [];
    /** 正在播的那一批（供 placeAllIntoHand / endDraw 交还在途额度、避免重复记墓场） */
    private _activeBatch: DrawBatch | null = null;
    /** CardPlay 组件缓存（判断「打出/法术演出」是否占着舞台） */
    private _cpCache: any = null;
    private _drawBack: Node | null = null;
    private _drawSeq = 0;
    /** 缓存的 UI 相机（Canvas 上那台），用于「屏幕(UI)坐标 → 世界坐标」换算 */
    private _cam: Camera | null = null;
    /** 动态生成的卡背参考节点 */
    private _cardBack: Node | null = null;
    private _cardBackRevealed: Node | null = null;
    /** 异步兜底加载到的卡背 SpriteFrame */
    private _backSf: SpriteFrame | null = null;

    // 卡背 SpriteFrame 的资源 uuid（CardBack.png 的 sprite-frame 子资源），兜底加载用
    private static readonly CARD_BACK_SF_UUID = 'ff94f979-116c-4c7a-9f1a-67b3a2ef2d46@f9941';

    // ------------------------------ 生命周期 ------------------------------
    onLoad(): void {
        // 若未指定卡背贴图，尝试按内置 uuid 异步加载（预览/开发服可随时取资源；发布包建议手动指定属性）
        if (!this.cardBackSpriteFrame) {
            assetManager.loadAny(CardDraw.CARD_BACK_SF_UUID, (err: any, asset: any) => {
                if (!err && asset) this._backSf = asset as SpriteFrame;
            });
        }
    }

    start(): void {
        if (this.showTestPanel) this.buildTestPanel();
    }

    onDisable(): void {
        // 组件被关掉时，动画不会再收尾 → 必须在这里放开手牌层的置顶要求，
        // 否则手牌层会永久停在最上层（把战场、UI 都压住）。
        this._busy = false;
        this.releaseLayerForDraw();
        // 🔴 同理：排队中 / 在播批次持有的「在途额度」必须全部交还，否则逻辑手牌数会永久虚高。
        for (const b of this._pendingBatches) this.releaseBatch(b);
        this._pendingBatches.length = 0;
        this.releaseBatch(this._activeBatch);
    }

    // ------------------------------ 对外 API ------------------------------
    /** 是否正在播放抽卡动画（动画期间再次调用 draw 会被忽略，避免状态错乱） */
    public get isDrawing(): boolean {
        return this._busy;
    }

    /**
     * 触发一次「单张」抽卡动画（= 抽 1 张）。等价于 drawMany([id])。
     * @param id 卡牌 id（CardData.CardMap 的 key，带不带扩展名皆可）；省略时抽测试面板当前选中的卡
     * @returns 是否成功起手（false = 缺少必要组件 / 卡背资源未就绪）
     */
    public draw(id?: string): boolean {
        const single = (id !== undefined && id.length > 0) ? id : this.currentTestId();
        if (!single) return false;
        return this.drawMany([single]);
    }

    /**
     * **逻辑我方手牌数**（BattleStatusBar 用）：
     * 手牌集合张数 + 已定判「能进手牌、但还在展示/飞行（或排队等舞台）」的张数。
     * 🔴 判定发生在「抽卡决定」那一刻（手牌上限固定 ⇒ 与展示无关）
     *    ⇒ 抽卡动画播多久都不影响这个数（需求：计数器不等动画）。
     */
    public get logicalHandCount(): number {
        const hand = this.resolveHandLayout();
        return (hand ? hand.cardCount : 0) + Math.max(0, this._pendingAdopt);
    }

    /**
     * 【抽卡决定那一刻的定判】把本次要抽的 id 列表判成「能进手牌 / 装不下要被破坏」两段。
     *
     * · 手牌上限固定（`hand.maxCards`），此刻的**逻辑占用**就是判据 ⇒ 与后面的展示动画完全无关；
     * · 「能进手牌的张数」立即计入在途额度（`logicalHandCount`）→ 状态栏当场 +N；
     * · 「装不下的张数」立即记墓场（它们注定被破坏）→ 状态栏墓地当场 +N；
     * · 判定结果即**最终结论**：`placeAllIntoHand` 不会再改判（见那里的注释）。
     *
     * 🔴🔴 容量基准必须是**逻辑占用** = 手牌集合张数 + **已在途（还没落位）的张数**，
     *    不能只用 `hand.cardCount`：
     *      · 连用两张抽二法术时，第一张抽到的牌还在展示，物理手牌里看不见它，
     *        但它**已经占住格子**了 —— 用物理张数当基准会把同一批空位重复分配，
     *        逻辑手牌数会短暂冲到 10（超上限），直到展示时破坏掉多出来的那张才回落；
     *      · 手牌 9（上限 9）用一张抽二同理。
     *    基准 = 逻辑占用后，任何时刻「手牌集合 + 在途」都不会越过上限。
     */
    private decideHandSplit(list: string[], hand: HandLayout): DrawBatch {
        const limit = Math.max(0, Math.floor(hand.maxCards));
        const occupied = (hand ? hand.cardCount : 0) + Math.max(0, this._pendingAdopt);
        const capacity = Math.max(0, limit - occupied);
        const keepN = Math.min(list.length, capacity);
        const burnIds = list.slice(keepN);
        this._pendingAdopt += keepN;
        for (const id of burnIds) addToGrave(this.node, 'player', id);
        return { ids: list, keepN, burns: burnIds.length };
    }

    /** 交还一批的在途额度（该批已落位 / 已作废） */
    private releaseBatch(batch: DrawBatch | null): void {
        if (!batch) return;
        this._pendingAdopt = Math.max(0, this._pendingAdopt - batch.keepN);
        if (this._activeBatch === batch) this._activeBatch = null;
    }

    /** 逐帧兜底：舞台空了就把排队中的下一批抽卡放出来（逻辑早已入账，只差演出） */
    update(): void {
        if (this._busy || this._pendingBatches.length === 0) return;
        if (this.stageBusy()) return;
        const b = this._pendingBatches.shift();
        if (b) this.startDraw(b);
    }

    /** 「打出 / 法术演出」是否正占着舞台（抽卡动画要等它演完再起手；**逻辑入账不受影响**） */
    private stageBusy(): boolean {
        const cp = this.resolveCardPlay();
        return !!(cp && cp.isBusy);
    }

    private resolveCardPlay(): any {
        if (this._cpCache && this._cpCache.isValid) return this._cpCache;
        const scene = this.node.scene as unknown as Node | null;
        if (!scene) return null;
        const stack: Node[] = [...scene.children];
        while (stack.length > 0) {
            const cur = stack.shift() as Node;
            const c = cur.getComponent('CardPlay');
            if (c && c.isValid) { this._cpCache = c; return c; }
            for (const ch of cur.children) stack.push(ch);
        }
        this._cpCache = null;
        return null;
    }

    /**
     * 触发一次「多张」抽卡（卡背翻转 → 揭示 N 张真卡 → 排到屏幕正中 → 等待 → 入场到手牌最右）。
     *
     * 🔴 两段式：**逻辑入账（定判）+ 演出**。
     *    · 逻辑入账：调用当场完成 —— 能进手牌的张数计入在途额度、装不下的当场记墓场
     *      ⇒ 状态栏立刻就是最终数字，**与后面的动画无关**；
     *    · 演出：本组件忙、或「打出/法术演出」占着舞台时，只排队等空闲再播（逐帧 update 兜底）。
     * @param ids 卡牌 id 数组（可包含重复 id）
     * @returns 是否被接受（true = 逻辑已入账，演出会按舞台空闲情况播）
     */
    public drawMany(ids: string[]): boolean {
        // 归一化卡牌 id（'1' → '1.png'），与 HandLayout / EnemyCardDraw 同一口径
        const list = (ids || [])
            .filter((x) => !!x && x.length > 0)
            .map((x) => toCardId(x))
            .filter((x) => !!x && x.length > 0);
        if (list.length === 0) return false;
        if (!this.ensureRefs()) return false;          // 动态生成 CardBack / CardBack-001（含卡背贴图）
        const hand = this.resolveHandLayout();
        if (!hand || !this.resolveComposer()) return false;

        // ① 逻辑入账（定判）：与动画无关，当场生效
        const batch = this.decideHandSplit(list, hand);

        // ② 演出：舞台忙就先排队（逻辑已经入账，不会被拖延）
        if (this._busy || this.stageBusy()) {
            this._pendingBatches.push(batch);
            return true;
        }
        return this.startDraw(batch);
    }

    /** 真正起手一轮抽卡动画（批次来自**已定判**的 batch）。 */
    private startDraw(batch: DrawBatch): boolean {
        if (this._busy) { this._pendingBatches.push(batch); return true; }
        const list = batch.ids;
        const back = this._cardBack!;
        const backR = this._cardBackRevealed!;
        const composer = this.resolveComposer();
        const hand = this.resolveHandLayout();
        const drag = this.resolveHandDrag();
        if (!composer || !hand) { this.releaseBatch(batch); return false; }

        this._busy = true;
        this._activeBatch = batch;
        // 🔴 抽卡期间抑制 HandLayout.refresh() 的节点清扫：正在飞行的临时真卡（Draw_*）
        //    此刻不属于 hand 集合，任何一次 refresh（如手牌缩小过渡的逐帧重排）都会把它
        //    销毁掉 → 「中央展示 → 入场」链路静默中断。endDraw 里统一解除。
        hand.suppressSweep = true;
        // 🔴 抽卡期间锁定手牌的 缩略↔完整 转换（展示完成前动画与手牌状态无关，
        //    入场到手牌后 endDraw 统一解锁）
        this.resolveHandMinimize()?.lockTransitions(true);
        // 🔴 抽卡动画期间把手牌层整体提到最上层：
        //    动画用的卡背（_drawBack）与所有真卡都是**手牌区节点的子节点**，
        //    而手牌层在场景树里排在战场层之前 → 层内置顶救不了跨层遮挡，必须整层上提。
        this.raiseLayerForDraw();

        // ① 读两张参考卡的变换作为关键帧
        //    🔴 缩略态动态锚定：手牌区可能正在向缩略锚点滑动（抽卡前一刻点了缩小），
        //    一次性补偿会在起手时算成 0、随后整段动画被手牌区带着漂移。因此关键帧用
        //    **原始本地坐标**，位置在 tween 的 onUpdate 里每帧叠加实时锚定补偿
        //    （= 完整态位置 − 当前位置），保证展示完成前的动画与正常抽卡逐帧一致。
        const startPos = back.position.clone();
        const startEuler = back.eulerAngles.clone();
        const startScale = back.scale.clone();
        const endPos = backR.position.clone();
        const endEuler = backR.eulerAngles.clone();
        const endScale = backR.scale.clone();

        // 工作卡背：复用同一张卡背贴图，从 CardBack 姿态播到 CardBack-001 姿态
        const work = this.ensureDrawBack();
        // 🔴🔴 复用前必须清掉该节点上遗留的补间 —— 「每隔一次抽卡卡牌凭空出现在画面里」的根因：
        //    上一轮 flip 结束时把 work.active 置 false（好让真卡顶上来），而那一刻它的
        //    旋转/缩放补间**还差最后一帧没跑完** → 被 ActionManager 连同节点一起暂停并留存。
        //    下一次抽卡把 active 置回 true 时，这条陈旧补间会先「补完」，把**结束姿态**
        //    （eulerAngles.x = 90°，即卡背侧面对着镜头、宽度为零、完全不可见）写进本轮的
        //    起始帧；而属性补间的起始值又是在它**第一次 step 里才采样**的 → 新补间采到 90
        //    → 90→90 毫无变化 → 整段「从屏幕外飞入」都在不可见姿态下播完，用户只看到
        //    真卡在 CardBack-001 位置凭空出现再飞向正中。陈旧补间被消耗掉 → 严格隔次触发。
        Tween.stopAllByTarget(work);
        const sf = this.resolveBackSprite();
        const ws = work.getComponent(Sprite);
        if (ws && sf) ws.spriteFrame = sf;
        work.setPosition(this.anchorPos(startPos));
        work.setRotationFromEuler(startEuler);
        work.setScale(startScale);
        work.active = true;
        this.toFront(work);

        const flip = Math.max(0, this.flipDuration);
        if (flip <= 0) {
            work.active = false;
            this.revealRealMany(composer, hand, drag, endPos, endEuler, endScale, list);
        } else {
            // 🔴 位置 / 旋转 / 缩放**全部由同一个数值补间的 onUpdate 显式写入**：
            //    ① 三者共用同一条缓动曲线（原先旋转/缩放另开一个属性补间，参数虽同但非同源）；
            //    ② 避开属性补间（`{eulerAngles: xxx}`）的「起始值延迟到第一次 step 才采样」，
            //       一旦同帧内有别的动作改过该属性，采样到的起始值就是错的（见上面 stopAllByTarget
            //       那段根因说明）——改成每帧用 setter 直接写目标值，姿态完全确定。
            const startE = startEuler.clone();
            const endE = endEuler.clone();
            const sS = startScale.x;
            const eS = endScale.x;
            const prog = { k: 0 };
            tween(prog)
                .to(flip, { k: 1 }, {
                    easing: 'sineInOut',
                    onUpdate: () => {
                        const k = prog.k;
                        // 位置：进度 + 每帧动态锚定（手牌区可能在滑动，必须每帧重算补偿）
                        work.setPosition(this.anchorPos(Vec3.lerp(
                            _flipOut, _flipFrom.set(startPos), _flipTo.set(endPos), k)));
                        // 旋转 / 缩放：同一进度值，用 setter 写绝对姿态
                        work.setRotationFromEuler(Vec3.lerp(_flipEuler, startE, endE, k));
                        const sc = sS + (eS - sS) * k;
                        work.setScale(sc, sc, 1);
                    },
                })
                .call(() => {
                    // 🔴 收尾必须精确落到结束帧：补间最后一帧的进度只是「≈1」，随后立刻 active=false
                    //    会把这最后一点点差值冻结并留到下一轮（实测残留 89.3°/90° 的错位就源于此）。
                    work.setRotationFromEuler(endE);
                    work.setScale(endScale.x, endScale.y, 1);
                    work.active = false;
                    this.revealRealMany(composer, hand, drag, endPos, endEuler, endScale, list);
                })
                .start();
        }
        return true;
    }

    /** 原始手牌区本地坐标 + 实时锚定补偿 → 实际应写入的位置（每帧调用） */
    private anchorPos(local: Vec3): Vec3 {
        const m = this.resolveHandMinimize();
        const a = m ? m.animationAnchorOffset : null;
        if (!a) return local;
        return new Vec3(local.x + a.x, local.y + a.y, local.z);
    }

    // ------------------------------ 抽卡流程细分 ------------------------------
    /**
     * ② + ③ + ④：揭示 N 张真卡（瞬间顶到 CardBack-001 姿态）→ 立正放大、排成一排飞到屏幕正中
     *            → 在正中等待 holdDuration → 入场到手牌。
     * 单抽时 list 只有 1 张，与旧行为完全一致。
     */
    private revealRealMany(
        composer: CardComposer, hand: HandLayout, drag: HandDrag | null,
        endPos: Vec3, endEuler: Vec3, endScale: Vec3, list: string[],
    ): void {
        // ② 用 Composer 拼出所有真实卡牌（各自唯一临时名），全部「瞬间」顶到 CardBack-001 那一帧
        const cards: Node[] = [];
        const ids: string[] = [];
        for (let k = 0; k < list.length; k++) {
            const id = list[k];
            const tempName = 'Draw_' + id.replace(/[^\w]/g, '_') + '_' + (this._drawSeq++);
            const real = composer.composeCard(id, tempName) as Node | null;
            if (!real || !real.isValid) continue;
            // 原样保留 CardBack-001 的位置与倾斜角（无缝接上卡背停住的那一帧），多张先叠在一起
            real.setPosition(this.anchorPos(endPos));
            real.setRotationFromEuler(endEuler);
            real.setScale(endScale);
            real.active = true;
            this.toFront(real);
            cards.push(real);
            ids.push(id);
        }
        if (cards.length === 0) { this.endDraw(); return; }

        // ③ 目标：每张竖直立正 + 拖拽样式大小 + 屏幕正中、按 displaySpacing 排成一排（居中）
        //    🔴 展示大小与「正常情况」一致：手牌处于缩略态时用完整态的基础缩放
        //    （HandMinimize.fullAppliedScale），否则缩略态抽卡会在正中展示出迷你卡。
        //    入场到手牌时 placeAllIntoHand 会按当前（缩略）布局参数边缩小边飞入。
        const mini = this.resolveHandMinimize();
        const baseScale = mini ? mini.fullAppliedScale : hand.appliedScale;
        const dragScale = drag ? drag.dragScale : 1.35;
        const targetScale = Math.max(0.01, baseScale * dragScale);
        const center = this.screenCenterLocal().clone();
        const n = cards.length;
        const targets: Vec3[] = [];
        for (let i = 0; i < n; i++) {
            const x = center.x + (i - (n - 1) / 2) * this.displaySpacing;
            targets.push(new Vec3(x, center.y, 0));
        }

        const reveal = Math.max(0, this.revealDuration);
        const goPlace = () => this.placeAllIntoHand(cards, ids);
        if (reveal <= 0) {
            for (let i = 0; i < n; i++) {
                cards[i].setPosition(targets[i]);
                cards[i].setRotationFromEuler(new Vec3(0, 0, 0));
                cards[i].setScale(targetScale, targetScale, 1);
            }
            this.scheduleOnce(goPlace, Math.max(0, this.holdDuration));
        } else {
            for (let i = 0; i < n; i++) {
                const card = cards[i];
                // 位置：进度 tween（从出生点 → 屏幕正中，与手牌区滑动无关）
                // 🔴 targets 不做锚定：screenCenterLocal 是动态换算（已含手牌区当前位移），
                //    再叠加 animationAnchorOffset 会双重补偿 → 展示位偏离正中。
                const fromP = this.anchorPos(endPos);
                const toP = targets[i];
                const prog = { k: 0 };
                tween(prog)
                    .to(reveal, { k: 1 }, {
                        easing: 'sineInOut',
                        onUpdate: () => {
                            card.setPosition(Vec3.lerp(
                                _flipOut, _flipFrom.set(fromP), _flipTo.set(toP), prog.k));
                        },
                    })
                    .call(() => {
                        // ④ 在正中等待 holdDuration 秒（以最后一张到位为准起算）
                        if (i === n - 1) this.scheduleOnce(goPlace, Math.max(0, this.holdDuration));
                    })
                    .start();
                // 旋转 / 缩放：直接走节点 tween（同一缓动同一时长）
                tween(card)
                    .to(reveal, {
                        eulerAngles: new Vec3(0, 0, 0),
                        scale: new Vec3(targetScale, targetScale, 1),
                    }, { easing: 'sineInOut' })
                    .start();
            }
        }
    }

    /**
     * ⑤ N 张真卡一起飞进手牌最右（依次追加）+ 整份手牌 tween 重新排布（两段时长相等 = placeDuration）。
     * 每张新卡从「正中排排站」补间到各自最右目标位；现有手牌从原位补间到新扇形位。
     *
     * 🔴 手牌上限（HandLayout.maxCards）：**塞不进手牌的牌在展示之后直接破坏** ——
     *    播 CardDestroyFx 烟雾特效 + 本体缩小淡出后销毁，绝不进入手牌。
     */
    private placeAllIntoHand(cards: Node[], ids: string[]): void {
        const hand = this.resolveHandLayout();
        if (!hand) { this.endDraw(); return; }
        const n0 = cards.length;

        // 收编前的旧目标（当前每张手牌的位置）
        const oldTargets = hand.currentTargets();
        const oldCount = oldTargets.length;

        // —— 手牌容量：**沿用「抽卡决定那一刻」的定判**（decideHandSplit），不按此刻重算 ——
        //    重算会在展示期间手牌变化时改写结论 → 表现为「数字刚 +N 又掉回来」或「墓场多记一张」。
        const batch = this._activeBatch;
        const limit = Math.max(0, Math.floor(hand.maxCards));
        const capacityNow = Math.max(0, limit - oldCount);
        const decided = batch ? batch.keepN : capacityNow;
        const capacity = Math.max(0, Math.min(decided, capacityNow));   // 定判为准，但绝不越过硬上限
        const keptCards: Node[] = [];
        const keptIds: string[] = [];
        const burned: Node[] = [];
        const burnedIds: string[] = [];
        for (let j = 0; j < n0; j++) {
            if (j < capacity) { keptCards.push(cards[j]); keptIds.push(ids[j]); }
            else if (cards[j] && cards[j].isValid) { burned.push(cards[j]); burnedIds.push(ids[j]); }
        }
        // 墓场：抽卡决定那一刻已按定判记过 `batch.burns` 张，这里只补记**多出来**的那些
        // （展示期间手牌反而变多时才会出现），绝不重复记账。
        const alreadyBurned = batch ? batch.burns : 0;
        for (let k = alreadyBurned; k < burned.length; k++) {
            addToGrave(this.node, 'player', burnedIds[k]);
        }
        this.burnOverflowCards(burned);

        // 收编：把能进手牌的真实卡登记为手牌最右的连续一段（改名 + 登记 hand，不重排）
        const n = keptCards.length;
        for (let j = 0; j < n; j++) {
            if (keptCards[j] && keptCards[j].isValid) hand.adoptCard(keptCards[j], keptIds[j]);
        }
        // 定判已落地（该入手的已收编、该破坏的已记账）→ 本批在途额度交还给手牌集合本身
        this.releaseBatch(batch);

        // 收编后的新目标（含新卡在末尾）
        const newTargets = hand.currentTargets();

        // 动画期间即按最终层序排好（新卡在最右、最上），避免穿插错乱
        for (let i = 0; i < newTargets.length; i++) {
            const node = hand.cards[i];
            if (node && node.isValid) node.setSiblingIndex(newTargets[i].sibling);
        }

        const dur = Math.max(0, this.placeDuration);
        const dragging = this.resolveHandDrag()?.draggingCard || null;

        // 现有手牌：旧位置 → 新位置（扇形重排）
        for (let i = 0; i < oldCount; i++) {
            const node = hand.cards[i];
            if (!node || !node.isValid) continue;
            // 抽牌动画也要给正在拖拽的卡让路：保留它的槽位，但不替用户移动它。
            if (dragging && node === dragging) continue;
            const o = oldTargets[i];
            const nn = newTargets[i];
            if (dur <= 0) {
                node.setPosition(nn.pos);
                node.setRotationFromEuler(nn.euler);
                node.setScale(nn.scale);
            } else {
                tween(node)
                    .to(dur, {
                        position: nn.pos.clone(),
                        eulerAngles: nn.euler.clone(),
                        scale: nn.scale.clone(),
                    }, { easing: 'sineInOut' })
                    .start();
            }
        }

        // 新卡：从「正中排排站」→ 各自最右目标位（最右一张落定后解除 busy）
        let anyValid = false;
        for (let j = 0; j < n; j++) {
            const node = keptCards[j];
            if (!node || !node.isValid) continue;
            anyValid = true;
            const t = newTargets[oldCount + j];
            if (dur <= 0) {
                node.setPosition(t.pos);
                node.setRotationFromEuler(t.euler);
                node.setScale(t.scale);
            } else {
                tween(node)
                    .to(dur, {
                        position: t.pos.clone(),
                        eulerAngles: t.euler.clone(),
                        scale: t.scale.clone(),
                    }, { easing: 'sineInOut' })
                    // 最后一张新卡落定 → 整轮抽卡结束：解除 busy 并放回原来层级
                    .call(() => { if (j === n - 1) this.endDraw(); })
                    .start();
            }
        }
        if (!anyValid || dur <= 0) this.endDraw();
    }

    /**
     * 超过手牌上限、塞不进手牌的牌：在**展示之后**被破坏 ——
     *   ① 在该卡世界坐标处播放 CardDestroyFx 烟雾特效；
     *   ② 卡牌本体缩小（+ 可选淡出）后销毁。
     * 纯表现：找不到特效宿主 / 缺组件都不影响本体的销毁。
     */
    /**
     * ★ **手牌满时把「加不进来的那张」按规则破坏**（供能力类「加入手牌」用）：
     * 拼一个临时节点 → 复用 `burnOverflowCards`（同一套破坏演出）。
     */
    public burnOverflowCard(id: string): void {
        if (!id) return;
        try {
            const hl = this.resolveHandLayout ? this.resolveHandLayout() : null;
            const handNode = hl && hl.isValid ? hl.node : null;
            // 🔴 手牌区根节点通常没有 CardComposer；工厂挂在子节点 `CardFactory`。
            //    原来只查 handNode.getComponent ⇒ 纹章谢幕曲发来的卡节点生成失败（没有破坏动画）。
            let composer = (handNode ? handNode.getComponent(CardComposer) : null) as unknown as
                { composeCard?: (id: string, name?: string) => Node | null } | null;
            if (!composer && handNode) {
                const factory = handNode.getChildByName('CardFactory');
                composer = (factory ? factory.getComponent(CardComposer) : null) as unknown as
                    { composeCard?: (id: string, name?: string) => Node | null } | null;
            }
            if (!composer) {
                const scene = this.node.scene as unknown as Node | null;
                const q = scene ? [...scene.children] : [];
                while (q.length > 0) {
                    const n = q.shift() as Node;
                    const c = n.getComponent(CardComposer) as unknown as
                        { composeCard?: (id: string, name?: string) => Node | null } | null;
                    if (c && typeof c.composeCard === 'function') { composer = c; break; }
                    for (const ch of n.children) q.push(ch);
                }
            }
            const node = composer && typeof composer.composeCard === 'function'
                ? composer.composeCard(id, 'Burn_' + id.replace(/[^\w]/g, '_') + '_' + Date.now()) : null;
            if (!node || !node.isValid) { console.warn('[CardDraw] 手牌溢出破坏：节点生成失败 → ' + id); return; }
            if (handNode) {
                node.setParent(handNode, true);
                node.setPosition(0, 0, 0);
                node.active = true;
            }
            this.burnOverflowCards([node]);
            console.log('[CardDraw] 手牌已满 ⇒ 破坏 ' + id);
        } catch (e) {
            console.error('[CardDraw] 手牌溢出破坏失败：', e);
        }
    }

    private burnOverflowCards(cards: Node[]): void {
        if (!cards || cards.length === 0) return;
        const fx = CardDestroyFx.instance;
        const dur = Math.max(0, this.burnDuration);
        const endScale = Math.max(0, Math.min(1, this.burnEndScale));
        for (const node of cards) {
            if (!node || !node.isValid) continue;
            // 首选：复用「整体高亮白 → 由里向外迸发 → 消失」特效（特效自己负责销毁卡牌）。
            if (fx && fx.destroyCard) {
                try { fx.playOnCard(node); continue; } catch (e) { /* 启动失败 → 回退旧动画 */ }
            }
            // 兜底：没有特效宿主（或它不负责销毁）时的旧「缩小淡出」动画。
            if (dur <= 0) { try { killNode(node); } catch (e) { /* 忽略 */ } continue; }
            const op = this.ensureOpacity(node);
            const sx = node.scale.x;
            const sy = node.scale.y;
            const state = { p: 0 };
            let done = false;
            const finish = () => {
                if (done) return;
                done = true;
                try { Tween.stopAllByTarget(state); } catch (e) { /* 忽略 */ }
                try { killNode(node); } catch (e) { /* 忽略 */ }
            };
            try {
                tween(state)
                    .to(dur, { p: 1 }, {
                        easing: "quadIn",
                        onUpdate: () => {
                            if (done) return;
                            try {
                                if (node.isValid) {
                                    const k = 1 - (1 - endScale) * state.p;
                                    node.setScale(sx * k, sy * k, 1);
                                }
                                if (this.burnFade && op && op.isValid) op.opacity = Math.round(255 * (1 - state.p));
                            } catch (e) { /* 单帧异常忽略 */ }
                        },
                    })
                    .call(() => finish())   // 🔴 finish 自带守卫，不要在这里提前置位
                    .start();
            } catch (e) {
                console.error("[CardDraw] 超上限破坏动画出错：", e);
                finish();
            }
        }
    }

    /** 取/加 UIOpacity 组件（超上限破坏淡出用） */
    private ensureOpacity(node: Node): UIOpacity | null {
        if (!node || !node.isValid) return null;
        return node.getComponent(UIOpacity) ?? node.addComponent(UIOpacity);
    }

    // ------------------------------ 工具 ------------------------------
    /** 把节点提到父节点最上层（绘制时压住其它卡） */
    private toFront(node: Node): void {
        if (node.parent) node.setSiblingIndex(node.parent.children.length - 1);
    }

    /**
     * 抽卡动画开始时把手牌层提到**同层最上层**（受 raiseLayerOnDraw 开关控制）。
     * 状态由 LayerOrder 按引用计数管理，与 HandDrag 拖拽共用同一份计数。
     */
    private raiseLayerForDraw(): void {
        if (!this.raiseLayerOnDraw) return;
        raiseLayerShared(this.node, this);
    }

    /** 释放本组件对「手牌层置顶」的要求（未持有时是无害的 no-op） */
    private releaseLayerForDraw(): void {
        releaseLayerShared(this.node, this);
    }

    /**
     * 抽卡流程收尾：解除 busy + 放开手牌层的置顶要求。
     * 🔴 所有结束路径（正常落定 / 生成失败 / 缺组件 / 组件关闭）都必须走这里，
     *    否则手牌层会被永久留在最上层。
     */
    private endDraw(): void {
        this._busy = false;
        // 🔴 抽卡链结束（含异常路径）：解除 refresh 清扫抑制（任何路径都必须到这里收尾）
        const hand0 = this.resolveHandLayout();
        if (hand0) hand0.suppressSweep = false;
        // 解除手牌 缩略↔完整 转换锁
        this.resolveHandMinimize()?.lockTransitions(false);
        this.releaseLayerForDraw();
        // 🔴 异常路径兜底：本批的「在途额度」必须交还，否则逻辑手牌数会一直虚高
        //    （正常路径在 placeAllIntoHand 收编之后就已交还，这里是幂等兜底）。
        this.releaseBatch(this._activeBatch);
    }

    /** 动态生成 CardBack / CardBack-001 两张参考节点（仅构建一次） */
    private ensureRefs(): boolean {
        if (this._cardBack && this._cardBack.isValid && this._cardBackRevealed && this._cardBackRevealed.isValid) {
            return true;
        }
        const sf = this.resolveBackSprite();
        if (!sf) return false;
        if (!this._cardBack || !this._cardBack.isValid) {
            this._cardBack = this.makeBackNode('CardBack', sf, this.backStartPos, this.backStartEuler, this.backScale);
        }
        if (!this._cardBackRevealed || !this._cardBackRevealed.isValid) {
            this._cardBackRevealed = this.makeBackNode('CardBack-001', sf, this.backEndPos, this.backEndEuler, this.backScale);
        }
        return true;
    }

    /** 建一个卡背参考节点（带 Sprite，位置/旋转/缩放由调用方给定） */
    private makeBackNode(name: string, sf: SpriteFrame, pos: Vec3, euler: Vec3, scale: number): Node {
        const n = new Node(name);
        n.setParent(this.node);
        const ut = n.addComponent(UITransform);
        ut.setAnchorPoint(0.5, 0.5);
        // 🔴 不能用 sf.width/height：SpriteFrame 的 width getter 返回的是**所在纹理**的尺寸，
        //    卡背被运行时动态图集打包后 _texture 换成 2048×2048 图集页 → 会得到巨型卡背。
        //    sf.rect 在打包后仍是帧自身的像素区域尺寸（_updateDynamicAtlasFrame 只改 x/y）。
        if (sf) ut.setContentSize(sf.rect.width, sf.rect.height);
        const sp = n.addComponent(Sprite);
        sp.type = Sprite.Type.SIMPLE;
        sp.sizeMode = Sprite.SizeMode.CUSTOM;
        sp.trim = true;
        if (sf) sp.spriteFrame = sf;
        n.setPosition(pos);
        n.setRotationFromEuler(euler);
        n.setScale(scale, scale, 1);
        n.active = this.debugShowReferences;     // 默认隐藏，仅作设计参考
        return n;
    }

    /** 解析卡背 SpriteFrame：优先 Inspector 指定，其次异步兜底加载结果 */
    private resolveBackSprite(): SpriteFrame | null {
        if (this.cardBackSpriteFrame && this.cardBackSpriteFrame.isValid) return this.cardBackSpriteFrame;
        if (this._backSf && this._backSf.isValid) return this._backSf;
        return null;
    }

    /**
     * 屏幕正中（= UI 相机注视点的世界坐标）转换到手牌区（本节点）本地坐标。
     * 直接取 UI 相机的世界位置作为「屏幕中心在世界里的位置」，比用「设计分辨率中心 + screenToWorld」
     * 更准：当可视区高度与设计分辨率不一致（本项目可视高 673 ≠ 设计高 720）时，后者会偏约 25px。
     */
    private screenCenterLocal(): Vec3 {
        const cam = this.uiCamera();
        const ut = this.node.getComponent(UITransform);
        if (cam) {
            const wp = cam.node.worldPosition;
            return ut ? ut.convertToNodeSpaceAR(new Vec3(wp.x, wp.y, 0), _centerLocal) : _centerLocal.set(wp.x, wp.y, 0);
        }
        const d = view.getDesignResolutionSize();
        Vec3.set(_uiScratch, d.width / 2, d.height / 2, 0);
        const world = this.uiToWorld(_uiScratch);
        return ut ? ut.convertToNodeSpaceAR(world, _centerLocal) : world;
    }

    /** UI(屏幕)坐标 → 世界坐标：走 Canvas 上的 UI 相机 screenToWorld（与引擎自身命中判定同路径） */
    private uiToWorld(uiPos: Vec3): Vec3 {
        Vec3.set(_uiScratch, uiPos.x, uiPos.y, 0);
        const cam = this.uiCamera();
        if (cam) cam.screenToWorld(_uiScratch, _worldScratch);
        else Vec3.copy(_worldScratch, _uiScratch);
        return _worldScratch;
    }

    /** 取 UI 相机（沿 parent 链向上找 Canvas，再取 cameraComponent） */
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

    /** 取/建一个工作卡背节点（挂在手牌区下，复用卡背贴图） */
    private ensureDrawBack(): Node {
        if (this._drawBack && this._drawBack.isValid) return this._drawBack;
        const n = new Node('_drawBack');
        n.setParent(this.node);
        const ut = n.addComponent(UITransform);
        ut.setAnchorPoint(0.5, 0.5);
        // 尺寸对齐卡背参考卡 / 卡背贴图
        const but = this._cardBack?.getComponent(UITransform);
        const sf = this.resolveBackSprite();
        // 同上：sf.width/height 会因动态图集打包变成 2048，必须用 sf.rect
        const w = but ? but.contentSize.width : (sf ? sf.rect.width : 220);
        const h = but ? but.contentSize.height : (sf ? sf.rect.height : 284);
        ut.setContentSize(w, h);
        const sp = n.addComponent(Sprite);
        sp.type = Sprite.Type.SIMPLE;
        sp.sizeMode = Sprite.SizeMode.CUSTOM;
        sp.trim = true;
        // 🔸 需求：抽卡用的卡背也要有同款金色描边（与敌方手牌卡背统一，全局 CardBackBorder 管理）
        n.addComponent(CardBackBorder);
        n.active = false;
        this._drawBack = n;
        return n;
    }

    // ------------------------------ 测试控制台 ------------------------------
    /**
     * 左上角只放一个「控制台」小按钮；点击后挂出/展开 TestConsole 面板
     * （我方抽卡 / 敌方加入卡背 / 敌方指定第几张打出入战场 / 清空敌方手牌）。
     * 旧的常驻测试面板已由 TestConsole 取代（见 TestConsole.ts）。
     */
    private buildTestPanel(): void {
        const canvas = this.node.parent;
        if (!canvas) return;
        if (this.testCardIds.length === 0) return;
        const btn = this.makeButton(canvas, '控制台', -640 + 62, 360 - 28, 92);
        btn.name = 'ConsoleToggle';
        btn.on(Button.EventType.CLICK, () => {
            let tc = canvas.getComponent(TestConsole);
            if (!tc) tc = canvas.addComponent(TestConsole);
            tc.toggle();
        }, this);

        // ★ 需求（Task 3）：控制台按钮**下方**再加一个「牌组」按钮 —— 点击展开双方牌组剩余卡牌
        //    （按费用从小到大分类），再点一次关闭。同样是**测试时才有的功能**（跟着本方法一起建）。
        const deckBtn = this.makeButton(canvas, '牌组', -640 + 62, 360 - 28 - 46, 92);
        deckBtn.name = 'DeckToggle';
        deckBtn.on(Button.EventType.CLICK, () => {
            // 🔴 面板组件挂在**独立节点**上，不在 Canvas 上 ⇒ 必须按**节点名**找回已有的那个。
            //    曾经写成 canvas.getComponent(DeckPanel)（恒为 null）⇒ 每点一次都新建一层，
            //    多层文字叠在一起越来越粗、还关不掉。
            let holder = canvas.getChildByName(DECK_PANEL_NAME);
            if (!holder || !holder.isValid) {
                holder = new Node(DECK_PANEL_NAME);
                holder.layer = canvas.layer;
                holder.setParent(canvas);
                holder.setPosition(-640 + 62 + 92 / 2 + 230, 360 - 28 - 300, 0);
            }
            let dp = holder.getComponent(DeckPanel);
            if (!dp) dp = holder.addComponent(DeckPanel);
            dp.toggle();
        }, this);
    }

    private makeButton(parent: Node, text: string, x: number, y: number, w = 78): Node {
        const n = new Node('btn');
        n.setParent(parent);
        const ut = n.addComponent(UITransform);
        ut.setAnchorPoint(0.5, 0.5);
        ut.setContentSize(w, 40);
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
        lut.setContentSize(w, 40);
        const label = lb.addComponent(Label);
        label.string = text;
        label.fontSize = w <= 60 ? 14 : (w <= 110 ? 15 : 17);
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

    // ------------------------------ 依赖解析 ------------------------------
    private resolveComposer(): CardComposer | null {
        const card = this.node.getComponent(CardComposer);
        if (card) return card;
        const fac = this.node.getChildByName('CardFactory');
        return fac ? fac.getComponent(CardComposer) : null;
    }

    private resolveHandLayout(): HandLayout | null {
        return this.getComponent(HandLayout);
    }

    private resolveHandDrag(): HandDrag | null {
        return this.getComponent(HandDrag);
    }

    /**
     * 手牌缩略控制器（可选，按类名字符串查找，组件不存在时返回 null）：
     * ① fullAppliedScale —— 缩略态下中央展示仍用完整态的基础缩放；
     * ② animationAnchorOffset —— 缩略态下把「翻牌入场 / 真卡出生点」平移回完整态位置；
     * ③ lockTransitions —— 抽卡期间锁定手牌的 缩略↔完整 转换。
     */
    private resolveHandMinimize(): {
        fullAppliedScale: number; animationAnchorOffset: Vec3; lockTransitions: (v: boolean) => void;
    } | null {
        return this.getComponent('HandMinimize') as unknown as {
            fullAppliedScale: number; animationAnchorOffset: Vec3; lockTransitions: (v: boolean) => void;
        } | null;
    }
}

/**
 * 一批抽卡的**定判结果**（逻辑入账在前、演出在后）：
 *   · ids   —— 本批要抽的卡牌 id
 *   · keepN —— 定判为「能进手牌」的张数（计入在途额度，落位后交还）
 *   · burns —— 定判为「装不下、当场记墓场」的张数（防重复记账）
 */
interface DrawBatch {
    ids: string[];
    keepN: number;
    burns: number;
}

// ------------------------------ 模块内部 scratch ------------------------------
const _uiScratch = new Vec3();
const _worldScratch = new Vec3();
const _centerLocal = new Vec3();
/** 动态锚定 tween 的插值暂存（onUpdate 内同步用完，多张卡并行安全） */
const _flipFrom = new Vec3();
const _flipTo = new Vec3();
const _flipOut = new Vec3();
/** 翻牌补间里欧拉角的插值暂存 */
const _flipEuler = new Vec3();
