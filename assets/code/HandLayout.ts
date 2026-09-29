import { _decorator, CCString, Component, Node, UITransform, Vec3 } from 'cc';
import { EDITOR } from 'cc/env';
import { CardComposer, isComposedCard } from './CardComposer';
import { getCardInfo, resolveCardFrame } from './CardData';
import { getCardBottomInset, getCardKeepRightInset } from './CardLayout';

const { ccclass, property, executeInEditMode, requireComponent, menu } = _decorator;

/** 单张卡牌在某个布局状态下的「目标变换」（与 layout() 同算法，仅用于预演/动画） */
export interface CardTarget {
    /** 手牌区（父节点）本地坐标下的位置 */
    pos: Vec3;
    /** 欧拉角（手牌弧线上的倾斜角） */
    euler: Vec3;
    /** 缩放（已含 cardScale 与 autoFit 收缩） */
    scale: Vec3;
    /** 渲染层序（兄弟节点序号，越高越后绘制 → 压在左侧之上） */
    sibling: number;
}


/**
 * HandLayout —— 手牌区（向上拱起的圆弧扇形排布）
 * ===========================================================================
 * 挂在**手牌区节点**（如 Canvas/PlayerHandArea）上，本节点就是「手牌容器」：
 *   PlayerHandArea                 ← 挂本脚本 + UITransform
 *   ├── CardFactory          ← （可选）挂 CardComposer，作为卡牌工厂
 *   └── Card_1.png           ← 由本脚本驱动生成，直接是 PlayerHandArea 的子节点
 *       ├── Card_2.png_2
 *       └── …
 *
 * 一、手牌集合
 *   `hand` 是暴露在 Inspector 里的有序集合，元素是卡牌编号或资源名：
 *       ["1"]             → 只有 1 张「卡 1」
 *       ["1","1","3","2"] → 按集合顺序出 4 张：卡1、卡1、卡3、卡2
 *   映射：'1' → '1.png'（已带扩展名则原样使用）。
 *   `hand` 写几张就生成几张 —— **不受 maxCards 限制**（写 9 张就出 9 张）。
 *   `maxCards` 只是**运行时**容量上限，仅约束运行时 API（setHand / addCard 超出即拒绝）；
 *   集合元素数多于 maxCards 时只打印一条提示，不会丢弃任何一张。
 *   实际生成出来的卡牌节点按顺序存在内部数组 `cards` 里，张数/顺序 == hand 的有效项。
 *
 * 二、圆弧扇形排布（本脚本核心）
 *   把「卡框下边框」放在一段**向上拱起的圆弧**上（注意不是裁剪矩形的底边，见下）：
 *       圆心 P 位于手牌下方，半径 R = radius
 *       第 i 张卡的位置角  a_i = (i - (n-1)/2) * Δ
 *       第 i 张卡的**对齐基准**（卡牌中心 → 卡框下边框的距离）
 *           d_i = h_i/2 - bottomInset(type_i)
 *       卡牌中心          C_i = ((R + d_i)·sin a_i, R·(cos a_i - 1) + d_i·cos a_i - D)
 *         （D = 本帧最大的 d_i，仅作整份手牌的纵向基准；d_i 不同不影响下边框位置）
 *   于是任意一张卡的下边框中点恒为 (R·sin a_i, R·cos a_i - R - D) → **与自身卡高/类型无关**，
 *   所有卡的下边框都落在同一条圆弧上。
 *
 *   ⚠️ 为什么基准不能用「裁剪矩形底边」：有的卡框会把徽记画在**下边框之外**（旧版随从框的
 *   血量红盾 / 攻击徽记就挂在底边下方约 18px，裁剪底边其实是那两个徽记的最低点）。
 *   若按裁剪底边对齐，这类卡就会整体抬高 18px。bottomInset 只与**卡牌类型**有关
 *   （见 CardLayout.CardTypeMetricsMap），同类型的不同品质排布完全一致。
 *   ⚠️ 现在随从已改用**手牌版 Hand*Follower 框**（徽记移进左侧竖栏内、裁剪底边即下边框）
 *   → bottomInset = 0，随从与法术/护符在同一套度量下排布。
 *
 *   旋转 = 圆弧切线角：
 *       rotZ_i = -a_i   →  中间卡竖直(0°)、左侧逆时针(+)、右侧顺时针(-)，
 *                          越靠两端倾斜越大，两端分别为 ±总角/2
 *   位置与旋转都随 `cardScale` 等比缩放 → 改缩放不会改变扇形形状与间距比例。
 *
 *   三、卡间距 Δ 的两种模式
 *     · 自动间距（默认，useAutoSpacing = true）：**把间距压到最紧**。
 *       以「本卡右缘必须保留可见的边界」为基准 —— 让右侧卡牌的左缘**刚好贴住**这条边界：
 *           中心距 ≥ 本卡保留右界 + 右邻半宽 + 相对旋转的边缘倾斜补偿 + cardGap
 *           保留右界 = 卡宽/2 - keepRightInset
 *           （旧版随从框右下角挂着血盾，右缘需留 3px；现在 Hand 版把徽记移到左栏 →
 *            随从/法术/护符的 keepRightInset 都是 0）
 *           倾斜补偿 = (最高卡高/2)·sin(Δ)
 *       再由 中心距 = 2·(R + D)·sin(Δ/2)·scale 反解 Δ（迭代几次收敛）。
 *       所有相邻卡牌的中心距**完全相同**（间距相等）。
 *       cardGap = 0 就是最紧；>0 再拉开；<0 允许压过来（会开始遮住血盾，慎用）。
 *     · 手动角度（useAutoSpacing = false）：用 `totalFanAngle` 直接控制整份手牌的张角，
 *       卡牌之间可能出现重叠（保留给「刻意要叠压效果」的场合）。
 *       fixedTotalAngle = false → totalFanAngle 按满员 maxCards 张定义（Δ 恒定）；
 *       fixedTotalAngle = true  → totalFanAngle 就是当前手牌的实际总角度。
 *
 * 四、渲染层级（叠压）
 *   数组越靠右的卡越靠上：逐张 setSiblingIndex(i)（Cocos 3.x 取消了 Node.zIndex，
 *   同级节点的先后顺序即 2D 绘制顺序，序号大的后绘制 → 压在左侧卡牌之上）。
 *   若相机/材质确实需要 3D 深度排序，可把 depthStep 设为非 0，逐张写入 z 轴落差。
 *   （自动间距模式下卡牌互不重叠，该顺序只影响极端情况下的边界像素。）
 *
 * 五、动态刷新
 *   `hand` 或任一布局参数变化即自动重排（编辑器内实时预览）；
 *   运行时 API：setHand / addCard / removeCardAt / clearHand / refresh，
 *   以及给动画用的 adoptCard（收编一张已生成的卡为最右）、releaseCard（摘除登记不销毁）。
 *
 * 与 CardComposer 的联动：本脚本调用 composer.composeCard(id, name) 实例化卡牌、
 * 收进 `cards` 集合，然后统一排布；CardComposer 检测到手牌区后也会反向调用
 * 本脚本的 refresh()（双向自动刷新，无需手动挂接）。
 * ===========================================================================
 */
@ccclass('HandLayout')
@executeInEditMode(true)
@requireComponent(UITransform)
@menu('gf2szb/HandLayout')
export class HandLayout extends Component {

    // ====================== 手牌集合（容器内容）======================
    @property({
        type: [CCString],
        tooltip: '手牌集合（有序）：元素 = 卡牌编号或资源名。\n'
            + '["1"] → 1 张卡 1；["1","1","3","2"] → 依序 4 张（卡1、卡1、卡3、卡2）。\n'
            + '映射：1→1.png、3→3.png（带扩展名则原样使用）。\n'
            + '⚠️ 写几张就生成几张，**不受 maxCards 限制**；maxCards 只约束运行时 setHand/addCard。',
    })
    hand: string[] = ['1', '1', '3', '2'];

    @property({ range: [1, 20, 1], slide: true, tooltip: '运行时手牌容量上限（默认 9）。\n'
        + '⚠️ 只约束**运行时 API**（setHand/addCard 超出即拒绝、返回 false）。\n'
        + '不影响 Inspector 里手写的 hand 集合 —— hand 写几张就生成几张，绝不会被截断。' })
    maxCards = 9;

    // ====================== 圆弧扇形布局参数 ======================
    @property({ tooltip: '间距模式：\n'
        + '✔ 自动间距（默认）—— 按卡牌尺寸自动算间距，把间距压到「右侧卡牌的左缘刚好贴住本卡右缘」，\n'
        + '   相邻卡牌的中心距完全相等。此时「总扇形角度」不参与计算。\n'
        + '□ 手动角度 —— 改用「总扇形角度」控制整份手牌的张角（卡牌之间可能互相重叠）。' })
    useAutoSpacing = true;

    @property({ range: [-40, 60, 1], slide: true, tooltip: '相邻卡牌之间的水平空隙（px，显示像素）。\n'
        + '仅「自动间距」模式生效。\n'
        + '  0（默认）= 最紧：右侧卡牌的左缘**刚好贴着**本卡右缘。\n'
        + '  >0  = 再拉开这么多。\n'
        + '  <0  = 允许压过来（会开始遮住卡框描边/卡面，慎用）。' })
    cardGap = 0;

    @property({ range: [0, 60, 0.1], slide: true, tooltip: '总扇形角度（度）= 最左卡与最右卡的倾斜角之和（两端各 ±一半）。\n'
        + '⚠️ 仅「手动角度」模式（useAutoSpacing = false）生效。\n'
        + 'fixedTotalAngle 关闭时按「满员 maxCards 张」定义：11° → 9 张时两端各倾斜 ±5.5°、中间卡竖直。' })
    totalFanAngle = 11;

    @property({ tooltip: '（仅手动角度模式生效）总角度固定：勾选后 totalFanAngle 就是当前手牌的实际总扇形角度；\n'
        + '不勾选（默认）则 totalFanAngle 表示满员 maxCards 张时的总角度，张数少时按比例收窄。' })
    fixedTotalAngle = false;

    @property({ range: [200, 40000, 10], slide: true, tooltip: '圆弧半径（单位 = 卡牌原始像素，随从卡约 203×262）。\n'
        + '半径越大弧线越平缓、卡牌越散；越小弧线越弯、牌与牌越挤。\n'
        + '9000 约等于模板图那种平缓悠长的弧度（注意：改成等间距后同样的半径会比之前更弯，故默认值调大了）。' })
    radius = 9000;

    @property({ range: [0.1, 3, 0.01], slide: true, tooltip: '卡牌基础缩放（作用于整张卡，覆盖 CardComposer 的 cardScale）' })
    cardScale = 0.55;

    @property({ tooltip: '卡牌垂直抬升偏移（px，本容器局部坐标）：整份手牌一起上下平移' })
    yOffset = 0;

    @property({ tooltip: '相邻卡牌 z 轴落差（3D 深度用，2D UI 靠同级顺序即可，默认 0）' })
    depthStep = 0;

    @property({ tooltip: '自动适配：整行手牌（含两端旋转后的包围盒）超出 maxWidth 时，自动等比减小「卡牌基础缩放」使其收进屏幕。\n'
        + '自动间距模式下不会为了塞进屏幕而制造重叠。' })
    autoFit = true;

    @property({ tooltip: '手牌允许的最大横向宽度（px，本容器局部坐标）' })
    maxWidth = 1240;

    /**
     * 🔴 抽卡动画期间的清扫抑制开关（运行时由 CardDraw 置位/复位，不进 Inspector）：
     * 置位期间 refresh() 跳过「清理多余节点」——因为 CardDraw 正在飞行的临时真卡
     * （Draw_* 临时名）此刻不属于 hand 集合，任何一次清扫都会把它销毁掉，
     * 导致「中央展示 → 入场到手牌」链路静默中断（busy 永真、手牌永远不加牌）。
     */
    public suppressSweep = false;

    // ====================== 依赖 & 预览 ======================
    @property({ type: CardComposer, tooltip: '（可选）卡牌工厂；留空自动在自身/子节点/场景里查找' })
    composer: CardComposer | null = null;

    @property({ tooltip: '编辑器内实时预览：改集合或布局参数立即重排' })
    previewInEditor = true;

    // ------------------------------ 内部状态 ------------------------------
    /** 实际生成出来的卡牌节点集合（顺序 = hand 中有效元素的顺序，[0] 最左） */
    private _cards: Node[] = [];
    /** 与 _cards 一一对应的卡牌 id（用于查卡框类型 → bottomInset） */
    private _ids: string[] = [];
    private _sig = '';
    /** 「hand 项数 > maxCards」提示只打一次（不丢牌的纯告警） */
    private _warnedOverflow = false;
    /** 「集合里有 id 没拼出来」提示只打一次 */
    private _warnedMissing = false;
    private _warnedTooWide = false;

    // ------------------------------ 生命周期 ------------------------------
    onLoad() { this.refresh(); }
    onEnable() { this.refresh(); }

    update() {
        if (!EDITOR || !this.previewInEditor) return;
        if (this.signature() !== this._sig) this.refresh();
    }

    // ------------------------------ 对外 API ------------------------------
    /** 容器中的卡牌集合（只读，顺序 = 手牌顺序）；[0] 就是最左边那张 */
    public get cards(): readonly Node[] {
        return this._cards;
    }

    /** 当前有效手牌张数 */
    public get cardCount(): number {
        return this._cards.length;
    }

    /**
     * 相邻卡牌中心的水平间距（px，本容器局部坐标，已含 cardScale）——只读，便于核对间距/空隙。
     * 圆弧上相邻中心弦长 = 2 * (R+D) * sin(Δ/2)，Δ 很小时在 x 方向的投影 ≈ 弦长。
     */
    public get stepPx(): number {
        if (this._cards.length < 2) return 0;
        return this.computeGeometry().stepPx;
    }

    /** 本帧实际的总扇形角度（度）——只读，便于核对 */
    public get fanAngleDeg(): number {
        return this.computeGeometry().totalDeg;
    }

    /** 本帧实际生效的卡牌缩放（autoFit 触发时会小于 cardScale）——只读 */
    public get appliedScale(): number {
        return this.computeGeometry().scale;
    }

    /**
     * 运行时整体替换手牌。**运行时**请求张数超过 maxCards 时拒绝（不改变现有手牌）并返回 false。
     * 注意：Inspector 里手写的 `hand` 集合不受 maxCards 限制（写几张就生成几张）。
     * @param list 卡牌编号或资源名数组，如 ['1','3','2'] / ['1.png']
     */
    public setHand(list: string[]): boolean {
        if (!this.checkCapacity((list || []).length)) return false;
        this.hand = (list || []).slice();
        this.refresh();
        return true;
    }

    /** 末尾加一张牌；**运行时**已达上限（≥ maxCards）时拒绝并返回 false */
    public addCard(id: string): boolean {
        if (!this.checkCapacity((this.hand || []).length + 1)) return false;
        this.hand = (this.hand || []).concat([id]);
        this.refresh();
        return true;
    }

    /**
     * ★ **插到最左边**加一张牌（需求：**非抽卡方式**入手牌的卡都放最左，不放末尾）。
     * 与 addCard 同款容量判定；失败返回 false。
     */
    public addCardLeft(id: string): boolean {
        if (!this.checkCapacity((this.hand || []).length + 1)) return false;
        this.hand = [id].concat(this.hand || []);
        this.refresh();
        return true;
    }

    /** 从指定位置移除一张牌（越界返回 false） */
    public removeCardAt(index: number): boolean {
        const cur = (this.hand || []).slice();
        if (index < 0 || index >= cur.length) return false;
        cur.splice(index, 1);
        this.hand = cur;
        this.refresh();
        return true;
    }

    /** 清空手牌集合 */
    public clearHand(): void {
        this.hand = [];
        this.refresh();
    }

    /**
     * 把一张**已经由外部生成好**的卡牌节点收编为手牌的「最右一张」（即数组末尾）。
     * 与 refresh() 的区别：本方法**不重新拼卡、不立即重排**，只是把节点登记进手牌集合，
     * 并把它在 `hand` 集合里的对应项补上（保证后续任何一次 refresh() 都能按名字复用该节点、
     * 而非重建），同时把节点改名为 refresh() 会使用的规范名（'Card_<id>' 或 'Card_<id>_N'）。
     * 调用方（如 CardDraw）通常随后用 currentTargets() 取目标、自己用 tween 做「整体重排」入场动画。
     * @param node 已生成好的卡牌节点（必须已是本手牌区的子节点）
     * @param id   卡牌 id（CardData.CardMap 的 key，带不带扩展名皆可）
     */
    public adoptCard(node: Node, id: string): void {
        if (!node || !node.isValid) return;
        const sane = toCardId(id);
        const oldIds = this.buildIds();
        const occ: Record<string, number> = {};
        for (const x of oldIds) occ[x] = (occ[x] || 0) + 1;
        occ[sane] = (occ[sane] || 0) + 1;
        const name = occ[sane] === 1 ? ('Card_' + sane) : ('Card_' + sane + '_' + occ[sane]);
        node.name = name;

        this._cards.push(node);
        this._ids.push(sane);
        this.hand = oldIds.concat([sane]);
        this._sig = this.signature();
    }

    /**
     * 与 adoptCard 相同，但按有效手牌下标插回原位置。
     * 用于队列失败回手：不能再像新抽到的卡一样永远追加到最右边。
     */
    public adoptCardAt(node: Node, id: string, index: number): void {
        if (!node || !node.isValid) return;
        const sane = toCardId(id);
        const oldIds = this.buildIds();
        const occ: Record<string, number> = {};
        for (const x of oldIds) occ[x] = (occ[x] || 0) + 1;
        occ[sane] = (occ[sane] || 0) + 1;
        const name = occ[sane] === 1 ? ('Card_' + sane) : ('Card_' + sane + '_' + occ[sane]);
        node.name = name;

        const at = Math.max(0, Math.min(Math.floor(index), this._cards.length));
        this._cards.splice(at, 0, node);
        this._ids.splice(at, 0, sane);

        const raw = Array.isArray(this.hand) ? this.hand.slice() : [];
        let valid = 0;
        let insert = raw.length;
        for (let k = 0; k < raw.length; k++) {
            if (!toCardId(raw[k])) continue;
            if (valid === at) { insert = k; break; }
            valid++;
        }
        raw.splice(insert, 0, sane);
        this.hand = raw;
        this._sig = this.signature();
    }

    /**
     * 某张卡牌对应的卡牌 id（CardMap 的 key）；该节点不在手牌集合里时返回 null。
     * @param node 手牌卡牌节点
     */
    public cardIdOf(node: Node): string | null {
        const i = this._cards.indexOf(node);
        return i >= 0 ? (this._ids[i] ?? null) : null;
    }

    /**
     * 把一张卡从手牌集合里**摘除**（`adoptCard` 的逆操作）。
     *
     * 🔴 只摘登记、**不销毁节点、不重排**。供 CardPlay 在「打出卡牌」时调用：
     *   卡牌飞出手牌期间它已经不属于手牌了 —— 若不移除登记，任何一次 refresh() 都会把它
     *   当成「多余的卡牌」销毁掉，或者用 currentTargets() 把它算进新排布里。
     *   排布交给调用方自己用 tween 补间（这样才是动画而不是瞬移）。
     * @param node 要摘除的卡牌节点（须已经是本手牌区的卡牌）
     * @returns 是否摘除成功（false = 它本来就不在手牌集合里）
     */
    public releaseCard(node: Node): boolean {
        const i = this._cards.indexOf(node);
        if (i < 0) return false;
        this._cards.splice(i, 1);
        this._ids.splice(i, 1);

        // 同步把 hand 里**对应的那一项**删掉。i 是「有效 id」的序号（空项已被过滤），
        // 所以要走一遍原始数组、数到第 i 个有效项再删，不能直接 hand.splice(i,1)。
        const raw = Array.isArray(this.hand) ? this.hand.slice() : [];
        let ordinal = -1;
        for (let k = 0; k < raw.length; k++) {
            if (!toCardId(raw[k])) continue;
            ordinal++;
            if (ordinal === i) { raw.splice(k, 1); break; }
        }
        this.hand = raw;

        this._sig = this.signature();
        return true;
    }

    /**
     * 按当前 `hand` 重排手牌（幂等）。
     * 流程：集合 → 有效卡牌 id 列表 → 逐张实例化并收进卡牌集合 → 清理多余节点 → 圆弧扇形排布。
     */
    public refresh(): void {
        const ids = this.buildIds();
        const composer = this.resolveComposer();

        // 1) 逐张实例化（或复用）卡牌，并收进「卡牌集合」，顺序严格 = hand 顺序
        const nodes: Node[] = [];
        const usedIds: string[] = [];
        const occ: Record<string, number> = {};
        for (let i = 0; i < ids.length; i++) {
            const id = ids[i];
            occ[id] = (occ[id] || 0) + 1;
            const name = occ[id] === 1 ? ('Card_' + id) : ('Card_' + id + '_' + occ[id]);
            const n = composer ? composer.composeCard(id, name, i) : this.node.getChildByName(name);
            if (n) { nodes.push(n); usedIds.push(id); }
        }

        // 1.5) 张数对不上时必须出声：只有 composeCard 失败（id 不在 CardMap、或贴图/版式缺失）才会少牌，
        //      否则「手牌写 N 张却只出现 M 张」这种问题会被静默吞掉。
        if (nodes.length < ids.length) {
            if (!this._warnedMissing) {
                this._warnedMissing = true;
                console.warn(`[HandLayout] 手牌集合 ${ids.length} 张，实际只生成 ${nodes.length} 张 ——`
                    + ` 有 ${ids.length - nodes.length} 张没拼出来（详见上面 CardComposer 的警告）。`
                    + ` 请检查这些 id 是否在 CardData.CardMap 里：${JSON.stringify(ids)}`);
            }
        } else {
            this._warnedMissing = false;
        }

        // 2) 清掉本轮不需要的旧卡牌节点（非卡牌子节点如 CardFactory 不动）
        //    🔴 suppressSweep（抽卡动画期间置位）：refresh 过程中的清扫会把 CardDraw 还在
        //    飞行途中的临时真卡（Draw_* 临时名、已 compose 出来但尚未收编）当成「多余的
        //    卡牌」销毁掉 —— reveal 的 tween 目标被毁后整条抽卡链就静默卡死（busy 永真）。
        const keep = nodes.map((n) => n.name);
        if (!this.suppressSweep) {
            if (composer) composer.clearGenerated(keep);
            else this.dropStale(keep);
        }

        // 3) 圆弧扇形排布
        this._cards = nodes;
        this._ids = usedIds;
        this.layout();

        this._sig = this.signature();
    }

    // ------------------------------ 集合 → 卡牌 id ------------------------------
    /**
     * 把 `hand` 转成有效卡牌 id 列表（做映射、剔除空项）。
     *
     * 🔴 **不按 maxCards 截断**：`hand` 是 Inspector 里手写的「内容」，写几张就出几张；
     *    `maxCards` 只是**运行时**容量上限（见 setHand / addCard），不是「显示过滤器」。
     *    （旧实现按 maxCards 截断 → 集合里第 6 张起的卡牌被静默丢弃，看起来就像「最多只生成前 N 张」，
     *      这里已改为：超限仅提示 + 不丢弃。）
     */
    private buildIds(): string[] {
        const raw = Array.isArray(this.hand) ? this.hand : [];
        const out: string[] = [];
        for (const e of raw) {
            const id = toCardId(e);
            if (id) out.push(id);
        }

        // 提示（不丢牌）：Inspector 手牌数多于运行时容量上限
        const limit = Math.max(1, Math.floor(this.maxCards));
        if (out.length > limit) {
            if (!this._warnedOverflow) {
                this._warnedOverflow = true;
                console.warn(`[HandLayout] 手牌集合 ${out.length} 张 > maxCards=${limit}：`
                    + `hand 里的 ${out.length} 张**全部会生成**（maxCards 不截断 Inspector 集合）；`
                    + `maxCards 只约束运行时 setHand/addCard。若运行时也要能拿到 ${out.length} 张，请把 maxCards 调到 ${out.length}。`);
            }
        } else {
            this._warnedOverflow = false;
        }

        // 硬上限：防止误填出上百张卡把编辑器/运行时拖死（正常手牌远小于此值）
        if (out.length > HARD_MAX_CARDS) {
            console.warn(`[HandLayout] 手牌集合 ${out.length} 张，超过硬上限 ${HARD_MAX_CARDS} 张，只生成前 ${HARD_MAX_CARDS} 张。`);
            out.length = HARD_MAX_CARDS;
        }
        return out;
    }

    /** 容量校验（**仅运行时 API 用**）：请求张数超过 maxCards 时拒绝并告警；Inspector 的 hand 不走这里 */
    private checkCapacity(count: number): boolean {
        const limit = Math.max(1, Math.floor(this.maxCards));
        if (count > limit) {
            console.warn(`[HandLayout] 运行时手牌上限 maxCards=${limit}，请求 ${count} 张 → 拒绝（不改变现有手牌）。`
                + `如需 ${count} 张，请把 maxCards 调到 ${count}。`);
            return false;
        }
        return true;
    }

    // ------------------------------ 几何 ------------------------------
    /**
     * 量出每张卡的三项尺寸（未缩放）：
     *   w[i]     —— 卡框裁剪矩形宽
     *   h[i]     —— 卡框裁剪矩形高
     *   align[i] —— **对齐基准**：卡牌中心 → 卡框「下边框」的距离 = h/2 - bottomInset
     *              （随从的血盾/攻击徽记挂在下边框之外，不能拿裁剪矩形底边当基准）
     */
    private measure(): { w: number[]; h: number[]; align: number[] } {
        const w: number[] = [];
        const h: number[] = [];
        const align: number[] = [];
        for (let i = 0; i < this._cards.length; i++) {
            const ut = this._cards[i].getComponent(UITransform);
            const wi = ut ? ut.contentSize.width : 214;
            const hi = ut ? ut.contentSize.height : 280;
            w.push(wi);
            h.push(hi);
            align.push(Math.max(1, hi / 2 - this.frameBottomInset(i)));
        }
        return { w, h, align };
    }

    /**
     * 第 i 张卡的「下边框内缩量」= 卡框下边框距裁剪矩形底边的高度（px，未缩放）。
     * 只与**卡牌类型**有关，同类型的不同品质值完全一致。
     * 现在随从也用手牌版卡框（徽记在左侧竖栏、裁剪底边即下边框）→ 0，与法术/护符一致。
     */
    private frameBottomInset(i: number): number {
        const id = this._ids[i];
        const info = id ? getCardInfo(id) : undefined;
        if (!info) return 0;
        return getCardBottomInset(resolveCardFrame(info), info.cardType);
    }

    /**
     * 第 i 张卡「右缘还必须保留可见」的内缩量（px，未缩放）。
     * 随从的血量盾牌已移到左栏 → 右缘不再需要预留，与法术/护符一样为 0。
     * 同样只与卡牌类型有关。
     */
    private frameKeepRight(i: number): number {
        const id = this._ids[i];
        const info = id ? getCardInfo(id) : undefined;
        if (!info) return 0;
        return getCardKeepRightInset(resolveCardFrame(info), info.cardType);
    }

    /**
     * 算出本帧的圆弧几何参数（不写节点）。
     * 返回: { n, stepDeg, totalDeg, arm, scale, radius, cardH, stepPx, tiltDeg }
     *   stepDeg  —— 相邻卡牌的位置角步进（度），同时也是相邻倾角差
     *   totalDeg —— 本帧实际的总扇形角度（= stepDeg * (n-1)）
     *   arm      —— 基准卡中心到圆心的距离（未缩放）= radius + 最大对齐基准
     *   cardH    —— 本帧最高的那张卡的高度（未缩放）
     *   stepPx   —— 相邻卡中心水平间距（已缩放，显示像素）
     *   tiltDeg  —— 两端卡牌的倾斜角（= 总角/2）
     *   scale    —— 本帧实际生效的卡牌缩放（autoFit 触发时 < cardScale）
     */
    public computeGeometry(): {
        n: number; stepDeg: number; totalDeg: number; arm: number;
        scale: number; radius: number; cardH: number; stepPx: number; tiltDeg: number;
    } {
        const n = this._cards.length;
        const n1 = Math.max(0, n - 1);
        const m = this.measure();
        const wMax = n > 0 ? Math.max(...m.w) : 214;
        const hMax = n > 0 ? Math.max(...m.h) : 280;
        const alignMax = n > 0 ? Math.max(...m.align) : 140;

        const R = Math.max(1, this.radius);
        const arm = R + alignMax;
        let scale = Math.max(0.01, this.cardScale);
        let stepDeg = 0;
        let stepPx = 0;

        if (n1 > 0) {
            if (this.useAutoSpacing) {
                // —— 自动间距：把间距压到「右侧卡牌刚好贴住本卡必须保留的右界」——
                // 本卡必须保留的右界 = 卡框右缘 - keepRightInset（随从的右下血盾内缩约 3px，
                // 所以右侧卡牌最多压过来这 3px 而血盾仍完整）；右侧卡牌的左缘到达该处即止。
                //   stepPx ≥ 本卡保留右界 + 右侧卡半宽 + 相对旋转的边缘倾斜补偿 + cardGap
                const keepR: number[] = [];
                for (let i = 0; i < n; i++) keepR.push(m.w[i] / 2 - this.frameKeepRight(i));
                const hHalf = hMax / 2;

                const solve = (): void => {
                    const halfRel = stepDeg * Math.PI / 360;      // Δ/2（弧度）
                    const rotComp = hHalf * Math.sin(2 * halfRel) * scale;   // 相邻卡相对倾斜的边缘补偿
                    let base = 0;
                    for (let i = 0; i + 1 < n; i++) {
                        base = Math.max(base, (keepR[i] + m.w[i + 1] / 2) * scale);
                    }
                    const need = base + rotComp + this.cardGap;
                    const denom = 2 * arm * scale;
                    stepDeg = 2 * Math.asin(Math.min(0.999999, Math.max(1e-4, need) / denom)) * 180 / Math.PI;
                    stepPx = need;
                };
                for (let k = 0; k < 8; k++) {
                    const before = stepDeg;
                    solve();
                    if (Math.abs(stepDeg - before) < 1e-6) break;
                }

                // —— 自适应：整行（含两端旋转包围盒）超出 maxWidth → 等比缩小卡牌缩放 ——
                if (this.autoFit && this.maxWidth > 0) {
                    for (let k = 0; k < 6; k++) {
                        const halfRel = stepDeg * Math.PI / 360;
                        const W1 = wMax * Math.cos(halfRel) + hMax * Math.sin(halfRel);
                        const want = (this.maxWidth - n1 * this.cardGap) / ((n1 + 1) * Math.max(1e-3, W1));
                        if (want >= scale) break;
                        scale = Math.max(0.05, want);
                        solve();
                    }
                    if (this.rowWidth(stepDeg, scale, wMax, hMax, arm, n1) > this.maxWidth + 1 && !this._warnedTooWide) {
                        this._warnedTooWide = true;
                        console.warn(`[HandLayout] 手牌 ${n} 张在缩放 ${scale.toFixed(3)} 下整行宽约 `
                            + `${this.rowWidth(stepDeg, scale, wMax, hMax, arm, n1).toFixed(0)}px，已超出 maxWidth=${this.maxWidth}；`
                            + `请调小「卡牌基础缩放」或调大 maxWidth。`);
                    }
                } else if (this.rowWidth(stepDeg, scale, wMax, hMax, arm, n1) <= this.maxWidth + 1) {
                    this._warnedTooWide = false;
                }
            } else {
                // —— 手动角度：直接用 totalFanAngle 控制张角（可能出现重叠）——
                const total = Math.max(0, this.totalFanAngle);
                const maxN1 = Math.max(1, Math.max(1, Math.floor(this.maxCards)) - 1);
                const totalDeg = this.fixedTotalAngle ? total : total * n1 / maxN1;
                stepDeg = totalDeg / n1;
                stepPx = 2 * arm * Math.sin(stepDeg * Math.PI / 360) * scale;
            }
        }

        return {
            n, stepDeg, totalDeg: stepDeg * n1, arm,
            scale, radius: R, cardH: hMax, stepPx, tiltDeg: Math.abs(stepDeg) * n1 / 2,
        };
    }

    /**
     * 预演当前手牌（`_cards` 现有成员）的「目标变换」数组，**不写任何节点**。
     * 与 layout() 使用完全相同的几何算法，只是把结果返回出来供抽卡动画做「整体重排」时用
     * （动画开始前的旧目标 / 收编新卡后的新目标，两者相减即为每张牌需要补间的位移）。
     * 返回顺序与 `_cards` 一致，[0] 最左、[last] 最右（也是最上层）。
     */
    public currentTargets(): CardTarget[] {
        const n = this._cards.length;
        if (n === 0) return [];
        const g = this.computeGeometry();
        const m = this.measure();
        const half = (n - 1) / 2;
        const s = g.scale;
        const R = g.radius;
        const D = Math.max(...m.align);
        const out: CardTarget[] = [];
        for (let i = 0; i < n; i++) {
            const node = this._cards[i];
            const a = (i - half) * g.stepDeg;
            const rad = a * Math.PI / 180;
            const d = m.align[i];
            const x = (R + d) * Math.sin(rad) * s;
            const y = (R * (Math.cos(rad) - 1) + d * Math.cos(rad) - D) * s + this.yOffset;
            out.push({
                pos: new Vec3(x, y, (i - half) * this.depthStep),
                euler: new Vec3(0, 0, -a),
                scale: new Vec3(s, s, 1),
                sibling: i,
            });
        }
        return out;
    }

    /** 整行手牌的横向占用宽度（含两端卡牌旋转后的包围盒），已缩放，单位=显示像素 */
    private rowWidth(stepDeg: number, scale: number, wMax: number, hMax: number, arm: number, n1: number): number {
        if (n1 <= 0) return wMax * scale;
        const tilt = Math.abs(stepDeg) * n1 / 2 * Math.PI / 180;      // 两端倾角（弧度）
        const centerSpan = 2 * arm * Math.sin(tilt) * scale;         // 首尾中心水平距
        const bboxHalf = (wMax / 2 * Math.cos(tilt) + hMax / 2 * Math.sin(tilt)) * scale;
        return centerSpan + 2 * bboxHalf;
    }

    // ------------------------------ 圆弧扇形排布 ------------------------------
    /** 批量更新每张卡牌：位置 / 欧拉旋转 / 基础缩放 / 渲染层级(zIndex) */
    private layout(): void {
        const n = this._cards.length;
        if (n === 0) return;

        const g = this.computeGeometry();
        const m = this.measure();
        const half = (n - 1) / 2;
        const s = g.scale;
        const R = g.radius;
        const D = Math.max(...m.align);      // 纵向基准：最大的「中心→下边框」距离

        for (let i = 0; i < n; i++) {
            const node = this._cards[i];
            const a = (i - half) * g.stepDeg;                     // 位置角（度），右为正
            const rad = a * Math.PI / 180;
            const d = m.align[i];                                 // 本卡的「中心→下边框」距离

            // 让**卡框下边框**落在半径 R 的圆上：
            //   下边框中点 = 中心 + rot((0, -d), -a) = (x - d·sin a, y - d·cos a)
            //   要求 = (R·sin a, R·cos a - R - D)  →  解得下面的 x / y
            // 于是下边框中点恒为 (R·sin a, R·cos a - R - D)，**与卡高/卡牌类型无关**：
            // 随从（血盾/徽记挂在框外）与法术/护符的下边框齐平落在同一条圆弧上。
            const x = (R + d) * Math.sin(rad) * s;
            const y = (R * (Math.cos(rad) - 1) + d * Math.cos(rad) - D) * s + this.yOffset;

            node.setScale(s, s, 1);                               // 基础缩放
            node.setPosition(x, y, (i - half) * this.depthStep);  // 位置（+ 可选 z 落差）
            node.setRotationFromEuler(0, 0, -a);                  // 欧拉旋转：左逆右顺、中间竖直
            node.setSiblingIndex(i);                              // 渲染层级：越右越后绘制 → 压住左侧
        }
    }

    // ------------------------------ 依赖解析 ------------------------------
    /** 找卡牌工厂：优先 Inspector 指定，其次自身、子节点，最后整场景兜底 */
    private resolveComposer(): CardComposer | null {
        if (this.composer && this.composer.isValid) return this.composer;
        const self = this.getComponent(CardComposer);
        if (self) return self;

        const stack: Node[] = [...this.node.children];
        while (stack.length > 0) {
            const cur = stack.shift() as Node;
            const c = cur.getComponent(CardComposer);
            if (c) return c;
            for (const ch of cur.children) stack.push(ch);
        }

        const scene = this.node.scene as unknown as Node | null;
        if (scene) {
            const roots: Node[] = [...scene.children];
            while (roots.length > 0) {
                const cur = roots.shift() as Node;
                const c = cur.getComponent(CardComposer);
                if (c) return c;
                for (const ch of cur.children) roots.push(ch);
            }
        }
        return null;
    }

    /** 没有 CardComposer 时的兜底清理：只销毁卡牌节点 */
    private dropStale(keep: string[]): void {
        for (const ch of [...this.node.children]) {
            if (keep.indexOf(ch.name) >= 0) continue;
            if (isComposedCard(ch)) ch.destroy();
        }
    }

    /** 脏检查 key：集合或任一布局参数变化 → 自动重排 */
    private signature(): string {
        return [
            (this.hand || []).join(','), this.maxCards,
            this.useAutoSpacing ? 1 : 0, this.cardGap,
            this.totalFanAngle, this.fixedTotalAngle ? 1 : 0,
            this.radius, this.cardScale, this.yOffset, this.depthStep,
            this.autoFit ? 1 : 0, this.maxWidth,
            this.composer ? this.composer.uuid : 'auto',
        ].join('|');
    }
}

/**
 * 手牌集合的**硬上限**：只用于挡住「误填空/粘贴出上百项」这种异常输入，
 * 正常手牌规模远小于此值。它与 maxCards（运行时容量上限）无关：
 * `hand` 只要不超过硬上限就**全部生成**，不做任何截断。
 */
export const HARD_MAX_CARDS = 20;

/**
 * 集合元素 → 卡牌 id（CardData.CardMap 的 key）。
 * '1' → '1.png'；'3' → '3.png'；已带扩展名（'1.png'）则原样返回；空值返回 ''。
 */
export function toCardId(entry: string): string {
    const s = (entry === null || entry === undefined) ? '' : String(entry).trim();
    if (!s) return '';
    return /\.[a-z0-9]+$/i.test(s) ? s : (s + '.png');
}
