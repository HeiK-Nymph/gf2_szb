import { _decorator, CCString, Color, Component, isValid, Node, Sprite, SpriteFrame, tween, UITransform, Vec3 } from 'cc';
import { EDITOR } from 'cc/env';
import { CardBackBorder, CARD_BACK_CHILD_NAME } from './CardBackBorder';
import { HARD_MAX_CARDS, toCardId } from './HandLayout';

const { ccclass, property, executeInEditMode, requireComponent, menu } = _decorator;

/**
 * EnemyHandLayout —— 敌方手牌区（横排 CardBack 展示）
 * ===========================================================================
 * 挂在**敌方手牌区节点**（如 Canvas/EnemyHandArea）上，与 PlayerHandArea 的
 * HandLayout 保持同一套「集合驱动」思路，但展示形态完全不同：
 *
 *   EnemyHandArea             ← 挂本脚本 + UITransform
 *   └── EnemyCard_1.png       ← 卡背根节点（布局/缩放/记录作用在它上面）
 *       ├── CardBack          ← 底层卡背 Sprite（原图）
 *       └── BorderOutline     ← 金色描边覆盖层（CardBackBorder 组件自动维护，
 *                                 画在卡背上方，重叠时用于分辨张数）
 *
 * 一、与 HandLayout 相同的部分（需求：记录能力一致）
 *   · `hand` 是暴露在 Inspector 里的**有序集合**，元素 = 卡牌编号或资源名，
 *     映射规则一致（'1' → '1.png'，带扩展名原样使用）；
 *   · 集合写几张就生成几张；实际生成的卡背节点按顺序存在内部数组 `cards` 里，
 *     张数 / 顺序 == hand 的有效项 —— **显示的是 CardBack，但脚本记录的是真实
 *     的卡牌 id 与顺序**（例：集合 ["1","3","2"] → 三张卡背从左往右对应卡1、卡3、卡2）；
 *   · 重复 id 的命名约定一致：第 2/3 份为 `EnemyCard_<id>_2/_3`；
 *   · maxCards = 9（运行时容量上限），语义与 HandLayout 相同：
 *     Inspector 集合不受限，运行时 API（setHand/addCard）超限即拒绝；
 *   · 运行时 API 同构：setHand / addCard / removeCardAt / clearHand / refresh，
 *     以及 cardIdOf（节点 → 卡牌 id）。
 *
 * 二、与 HandLayout 不同的部分（需求：展示形态）
 *   · **不渲染真实卡牌**：每个子节点只有一张 CardBack Sprite（卡背贴图 Inspector 可换），
 *     不拼卡框/卡图/数字 —— 敌方手牌本来就只能看到背面；
 *   · **无圆弧**：全部竖直立正（旋转恒为 0°），一字横排，
 *     x = (i - (n-1)/2) × spacing × cardScale；
 *   · **保留右盖左**：setSiblingIndex(i) —— 越靠右的卡背越后绘制、压住左侧（与手牌一致）。
 *
 * 三、参数（全部 Inspector 暴露）
 *   · hand            敌方手牌集合（有序）
 *   · maxCards        运行时容量上限（默认 9）
 *   · spacing         相邻卡背**中心**间距（px，未乘缩放；实际间距 = spacing × cardScale，
 *                     改缩放时间距等比变化，与 HandLayout 行为一致）
 *   · cardScale       卡背整体缩放
 *   · yOffset         整排垂直偏移（本容器局部坐标）
 *   · cardBackSpriteFrame  卡背贴图（默认用 assets/image/cards/cardImage/CardBack.png）
 * ===========================================================================
 */
@ccclass('EnemyHandLayout')
@executeInEditMode(true)
@requireComponent(UITransform)
@menu('gf2szb/EnemyHandLayout')
export class EnemyHandLayout extends Component {

    // ====================== 敌方手牌集合（容器内容）======================
    @property({
        type: [CCString],
        tooltip: '敌方手牌集合（有序）：元素 = 卡牌编号或资源名，规则与 PlayerHandArea 的 hand 一致。\n'
            + '["1","3","2"] → 三张 CardBack 从左到右，脚本记录的顺序就是卡1、卡3、卡2。\n'
            + '⚠️ 显示全是卡背，但 cards / cardCount / cardIdOf 记录的是真实 id 与顺序。\n'
            + '⚠️ 写几张就生成几张，**不受 maxCards 限制**；maxCards 只约束运行时 setHand/addCard。',
    })
    hand: string[] = [];

    @property({ range: [1, 20, 1], slide: true, tooltip: '运行时手牌容量上限（默认 9）。\n'
        + '⚠️ 只约束**运行时 API**（setHand/addCard 超出即拒绝、返回 false）。\n'
        + '不影响 Inspector 里手写的 hand 集合 —— hand 写几张就生成几张，绝不会被截断。' })
    maxCards = 9;

    // ====================== 横排布局参数 ======================
    @property({ range: [0, 300, 1], slide: true, tooltip: '相邻卡背**中心**的水平间距（px，未乘缩放）。\n'
        + '实际间距 = spacing × cardScale（改缩放时间距等比变化）。\n'
        + '间距小于卡背宽度时自然形成「右盖左」的叠压（渲染顺序恒为右压左）。' })
    spacing = 120;

    @property({ range: [0.1, 3, 0.01], slide: true, tooltip: '卡背整体缩放' })
    cardScale = 0.55;

    @property({ tooltip: '整排卡背的垂直偏移（px，本容器局部坐标）' })
    yOffset = 0;

    // ====================== 卡背贴图 & 预览 ======================
    @property({
        type: SpriteFrame,
        tooltip: '卡背贴图（所有敌方手牌共用这一张）。\n'
            + '留空 = 生成时保留节点上已有的 SpriteFrame（不会强行清空）；首次生成必须指定。',
    })
    cardBackSpriteFrame: SpriteFrame | null = null;

    // ====================== 卡背金色描边（全局 CardBackBorder 统一管理）======================
    @property({ tooltip: '卡背金色描边开关：每张卡背的贴图上方叠一层细描边作为分隔线，\n'
        + '互相重叠也能看清张数。不改卡背原图，描边是独立覆盖层（BorderOutline 节点）。' })
    showCardBorder = true;

    @property({ type: Color, tooltip: '描边颜色。默认金色 #E8C878' })
    borderColor = new Color(232, 200, 120, 255);

    @property({ range: [0.5, 8, 0.1], slide: true, tooltip: '描边粗细（卡背纹理像素），随卡背缩放一起缩放。默认 2 = 细线。' })
    borderThickness = 2;

    @property({ tooltip: '编辑器内实时预览：改集合或布局参数立即重排' })
    previewInEditor = true;

    // ------------------------------ 内部状态 ------------------------------
    /** 实际生成出来的卡背节点集合（顺序 = hand 中有效元素的顺序，[0] 最左） */
    private _cards: Node[] = [];
    /** 与 _cards 一一对应的卡牌 id（真实手牌信息：显示卡背，记录真身） */
    private _ids: string[] = [];
    private _sig = '';
    /** 「hand 项数 > maxCards」提示只打一次（不丢牌的纯告警） */
    private _warnedOverflow = false;

    // ------------------------------ 生命周期 ------------------------------
    onLoad() { this.refresh(); }
    onEnable() { this.refresh(); }

    update() {
        if (!EDITOR || !this.previewInEditor) return;
        if (this.signature() !== this._sig) this.refresh();
    }

    // ------------------------------ 对外 API ------------------------------
    /** 容器中的卡背节点集合（只读，顺序 = 敌方手牌顺序）；[0] 就是最左边那张 */
    public get cards(): readonly Node[] {
        return this._cards;
    }

    /** 当前有效敌方手牌张数（= 卡背张数 = hand 有效项数） */
    public get cardCount(): number {
        return this._cards.length;
    }

    /** 卡背背后的**真实卡牌 id 列表**（只读副本，顺序 = 从左到右） */
    public get ids(): string[] {
        return this._ids.slice();
    }

    /**
     * 某张卡背节点对应的卡牌 id（CardMap 的 key）；该节点不在敌方手牌集合里时返回 null。
     * @param node 卡背节点
     */
    public cardIdOf(node: Node): string | null {
        const i = this._cards.indexOf(node);
        return i >= 0 ? (this._ids[i] ?? null) : null;
    }

    /**
     * 运行时整体替换敌方手牌。**运行时**请求张数超过 maxCards 时拒绝（不改变现有手牌）并返回 false。
     * 注意：Inspector 里手写的 `hand` 集合不受 maxCards 限制（写几张就生成几张）。
     * @param list 卡牌编号或资源名数组，如 ['1','3','2']
     */
    public setHand(list: string[]): boolean {
        if (!this.checkCapacity((list || []).length)) return false;
        this.hand = (list || []).slice();
        this.refresh();
        return true;
    }

    /**
     * 开局一次性发放初始手牌。
     *
     * 初始手牌不是普通的「抽一张」运行时入手流程：即使旧场景把 maxCards
     * 序列化成了 1，也必须允许本局的 4 张起手牌整体落位，否则 setHand 会
     * 整批拒绝，表现为敌方开局只有一张卡背。这里把容量提升到本局请求数，
     * 再复用 setHand 的正常刷新和布局逻辑；后续抽卡仍继续受 maxCards 约束。
     */
    public setInitialHand(list: string[]): boolean {
        const ids = Array.isArray(list) ? list : [];
        const required = ids.length;
        if (required > 0 && this.maxCards < required) {
            console.warn(`[EnemyHandLayout] 开局初始手牌需要 ${required} 张，maxCards=${this.maxCards} → 临时提升容量`);
            this.maxCards = required;
        }
        if (!this.setHand(ids)) return false;
        return this.cardCount === ids.length;
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

    /** 清空敌方手牌集合 */
    public clearHand(): void {
        this.hand = [];
        this.refresh();
    }

    /**
     * `addCard` 的逆：把指定卡背节点从集合里**摘除但不销毁**（EnemyCardPlay 打出流程用）。
     * 与 HandLayout.releaseCard 同一口径：不 refresh、不重排、不销毁 —— 排布由调用方
     * （EnemyCardPlay.tweenRest）用 tween 补间，节点本身被搬去播打出动画。
     * @returns 是否摘除成功（节点不在集合里返回 false）
     */
    public releaseCard(node: Node): boolean {
        const i = this._cards.indexOf(node);
        if (i < 0) return false;
        const idIdx = i;
        this._cards.splice(i, 1);
        this._ids.splice(idIdx, 1);
        // 同步移除 hand 里对应的「第 i 个有效项」（hand 可能有空项，按有效项计数对齐）
        const arr = (this.hand || []).slice();
        let valid = -1;
        for (let k = 0; k < arr.length; k++) {
            if (!toCardId(arr[k])) continue;
            valid++;
            if (valid === idIdx) { arr.splice(k, 1); break; }
        }
        this.hand = arr;
        this._sig = this.signature();       // 摘牌后立即刷新脏检查基线（防编辑器预览重复重排）
        return true;
    }

    /**
     * 把外部（EnemyCardDraw）已经摆到最左目标位的卡背节点**收编为敌方手牌最左一张**。
     * 与 releaseCard 相反方向：不 refresh、不重建 —— 节点已由调用方 tween 到最终姿态，
     * 这里只负责：搬进本节点（保世界变换）→ 改规范名（EnemyCard_<id>[_N]）→
     * 登记到集合头部 → 层序排 0（保持右盖左）。
     * @returns 是否收编成功（越界/重复/超上限返回 false）
     */
    public adoptCardLeft(node: Node, id: string): boolean {
        if (!node || !isValid(node, true)) return false;
        const realId = toCardId(id);
        if (!realId) return false;
        if (this._cards.indexOf(node) >= 0) return false;
        const limit = Math.max(1, Math.floor(this.maxCards));
        if (this._cards.length >= limit) {
            console.warn(`[EnemyHandLayout] 运行时敌方手牌上限 maxCards=${limit}，拒绝收编（drawCard 前请先检查容量）。`);
            return false;
        }
        node.setParent(this.node, true);                    // 保世界变换：本地坐标自动落到目标位
        const occ = this._ids.filter((x) => x === realId).length;
        node.name = occ === 0 ? ('EnemyCard_' + realId) : ('EnemyCard_' + realId + '_' + (occ + 1));
        this._cards.unshift(node);
        this._ids.unshift(realId);
        this.hand = [realId].concat(this.hand || []);
        node.setSiblingIndex(0);
        this._sig = this.signature();
        return true;
    }

    /**
     * 其余卡牌从当前位置 tween 到「少一张」之后的新横排目标位（打出流程与飞行同时长）。
     * 层序先排好（右盖左不变），位置用 sineInOut 补间，与 CardPlay.tweenHandRest 同套路。
     */
    public tweenRest(dur: number): void {
        const n = this._cards.length;
        const half = (n - 1) / 2;
        for (let i = 0; i < n; i++) {
            const node = this._cards[i];
            if (!node || !node.isValid) continue;
            node.setSiblingIndex(i);
            const p = new Vec3((i - half) * this.spacing * this.cardScale, this.yOffset, 0);
            if (dur <= 0) {
                node.setPosition(p);
            } else {
                tween(node).to(dur, { position: p }, { easing: 'sineInOut' }).start();
            }
        }
    }

    /**
     * 按当前 `hand` 重排敌方手牌（幂等）。
     * 流程：集合 → 有效卡牌 id 列表 → 逐张生成（或按名复用）卡背节点 → 清理多余节点 → 横排布局。
     */
    public refresh(): void {
        const ids = this.buildIds();

        // 1) 逐张生成（或按名复用）卡背节点，顺序严格 = hand 顺序
        const nodes: Node[] = [];
        const usedIds: string[] = [];
        const occ: Record<string, number> = {};
        for (let i = 0; i < ids.length; i++) {
            const id = ids[i];
            occ[id] = (occ[id] || 0) + 1;
            const name = occ[id] === 1 ? ('EnemyCard_' + id) : ('EnemyCard_' + id + '_' + occ[id]);
            const n = this.ensureBackNode(name);
            if (n) { nodes.push(n); usedIds.push(id); }
        }

        // 1.5) 张数对不上必须出声：只有「卡背贴图缺失导致节点建不出来」才会少牌
        if (nodes.length < ids.length) {
            console.warn(`[EnemyHandLayout] 敌方手牌集合 ${ids.length} 张，实际只生成 ${nodes.length} 张`
                + ` —— 请检查 cardBackSpriteFrame 是否已指定。`);
        }

        // 2) 清掉本轮不需要的旧卡背节点（只清本脚本命名规范的子节点，别的子节点不动）
        this.dropStale(nodes.map((n) => n.name));

        // 3) 横排布局
        this._cards = nodes;
        this._ids = usedIds;
        this.layout();

        this._sig = this.signature();
    }

    // ------------------------------ 集合 → 卡牌 id ------------------------------
    /**
     * 把 `hand` 转成有效卡牌 id 列表（做映射、剔除空项）。
     * 与 HandLayout 同一口径：🔴 **不按 maxCards 截断**（Inspector 集合是「内容」，
     * maxCards 只是运行时 API 的容量上限），超限仅提示；硬上限挡异常输入。
     */
    private buildIds(): string[] {
        const raw = Array.isArray(this.hand) ? this.hand : [];
        const out: string[] = [];
        for (const e of raw) {
            const id = toCardId(e);
            if (id) out.push(id);
        }

        const limit = Math.max(1, Math.floor(this.maxCards));
        if (out.length > limit) {
            if (!this._warnedOverflow) {
                this._warnedOverflow = true;
                console.warn(`[EnemyHandLayout] 敌方手牌集合 ${out.length} 张 > maxCards=${limit}：`
                    + `hand 里的 ${out.length} 张**全部会生成**（maxCards 不截断 Inspector 集合）；`
                    + `maxCards 只约束运行时 setHand/addCard。`);
            }
        } else {
            this._warnedOverflow = false;
        }

        if (out.length > HARD_MAX_CARDS) {
            console.warn(`[EnemyHandLayout] 敌方手牌集合 ${out.length} 张，超过硬上限 ${HARD_MAX_CARDS} 张，只生成前 ${HARD_MAX_CARDS} 张。`);
            out.length = HARD_MAX_CARDS;
        }
        return out;
    }

    /** 容量校验（**仅运行时 API 用**）：请求张数超过 maxCards 时拒绝并告警 */
    private checkCapacity(count: number): boolean {
        const limit = Math.max(1, Math.floor(this.maxCards));
        if (count > limit) {
            console.warn(`[EnemyHandLayout] 运行时敌方手牌上限 maxCards=${limit}，请求 ${count} 张 → 拒绝（不改变现有手牌）。`
                + `如需 ${count} 张，请把 maxCards 调到 ${count}。`);
            return false;
        }
        return true;
    }

    // ------------------------------ 卡背节点 ------------------------------
    /**
     * 按规范名取（或创建）一张卡背节点。
     * 节点结构（与卡背预制体约定一致）：
     *   EnemyCard_<id>          ← 根节点（布局/缩放/记录都作用在它上面）
     *   ├── CardBack            ← 底层卡背 Sprite（原图，本脚本维护）
     *   └── BorderOutline       ← 金色描边覆盖层（由 CardBackBorder 组件自动创建维护，
     *                              画在卡背贴图上方；不改原图，跟随根节点缩放）
     * 🔴 同名复用与 HandLayout/CardComposer 同一套坑位守则：
     *    只复用「仍挂在本节点下且有效」的同名节点。判活必须用 **严格模式 isValid(n, true)**：
     *    destroy 是延迟销毁，普通 isValid 在销毁当帧仍返回 true，复用待销毁节点会在
     *    帧末被摘掉 → 集合里留下死引用（实测：removeCardAt→setHand 同帧连调时复用待销毁节点，
     *    下一次 getComponent 直接抛 TypeError）。
     */
    private ensureBackNode(name: string): Node | null {
        let n = this.node.getChildByName(name);
        if (n && (!isValid(n, true) || n.parent !== this.node)) n = null;
        if (!n) {
            n = new Node(name);
            n.addComponent(UITransform);
            n.setParent(this.node);
        }
        const ut = n.getComponent(UITransform)!;
        ut.setAnchorPoint(0.5, 0.5);

        // —— 兼容清理：旧结构的 Sprite 直接挂在根节点上 → 移除（贴图统一挪到 CardBack 子节点）——
        const legacySp = n.getComponent(Sprite);
        if (legacySp) n.removeComponent(legacySp);

        // —— 底层：CardBack 子节点（卡背原图 Sprite）——
        let back = n.getChildByName(CARD_BACK_CHILD_NAME);
        if (back && (!isValid(back, true) || back.parent !== n)) back = null;
        if (!back) {
            back = new Node(CARD_BACK_CHILD_NAME);
            back.addComponent(UITransform);
            back.addComponent(Sprite);
            back.setParent(n);
        }
        const sp = back.getComponent(Sprite);
        if (!sp) return null;
        // 卡背贴图：Inspector 指定优先；没指定则保留节点上已有的（不清空）
        if (this.cardBackSpriteFrame && sp.spriteFrame !== this.cardBackSpriteFrame) {
            sp.spriteFrame = this.cardBackSpriteFrame;
        }
        if (!sp.spriteFrame) return null;                       // 连贴图都没有 → 视为生成失败（出声少牌）
        sp.sizeMode = Sprite.SizeMode.CUSTOM;
        sp.trim = false;
        const but = back.getComponent(UITransform)!;
        const rect = sp.spriteFrame.rect;
        // 🔴 尺寸用 sf.rect（帧自身像素）—— sf.width/height 返回所在纹理尺寸
        //    （动态图集打包后 = 2048，CardDraw 巨型卡背 bug 的根因）
        if (but.contentSize.width !== rect.width || but.contentSize.height !== rect.height) {
            but.setContentSize(rect.width, rect.height);        // 卡背原始尺寸（缩放交给布局统一做）
        }
        but.setAnchorPoint(0.5, 0.5);
        back.setPosition(0, 0, 0);

        // —— 上层：金色描边覆盖层（全局 CardBackBorder 统一管理，缺什么补什么）——
        let border = n.getComponent(CardBackBorder);
        if (!border) border = n.addComponent(CardBackBorder);
        border.applyStyle(this.showCardBorder, this.borderColor, this.borderThickness);

        return n;
    }

    /** 清掉「不在保留名单里」的本脚本卡背节点（命名规范 EnemyCard_* 才清，别的子节点不动） */
    private dropStale(keep: string[]): void {
        for (const ch of [...this.node.children]) {
            if (keep.indexOf(ch.name) >= 0) continue;
            if (ch.name.indexOf('EnemyCard_') !== 0) continue;
            ch.destroy();
        }
    }

    // ------------------------------ 横排布局 ------------------------------
    /**
     * 一字横排：全部竖直立正（旋转恒 0°），无圆弧。
     *   x = (i - (n-1)/2) × spacing × cardScale   （以整排中点对称）
     *   渲染层级：setSiblingIndex(i) → 越靠右越后绘制 → 压住左侧（与 PlayerHandArea 一致）。
     */
    private layout(): void {
        const n = this._cards.length;
        const half = (n - 1) / 2;
        for (let i = 0; i < n; i++) {
            const node = this._cards[i];
            node.setScale(this.cardScale, this.cardScale, 1);
            node.setPosition((i - half) * this.spacing * this.cardScale, this.yOffset, 0);
            node.setRotationFromEuler(0, 0, 0);                 // 竖直立正
            node.setSiblingIndex(i);                            // 右盖左
        }
    }

    // ------------------------------ 脏检查 ------------------------------
    /** 脏检查 key：集合或任一布局参数变化 → 自动重排（编辑器内实时预览） */
    private signature(): string {
        return [
            (this.hand || []).join(','), this.maxCards,
            this.spacing, this.cardScale, this.yOffset,
            this.cardBackSpriteFrame ? this.cardBackSpriteFrame.uuid : 'none',
        ].join('|');
    }
}
