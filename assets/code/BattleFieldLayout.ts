import { _decorator, Component, Enum, Node, Tween, tween, UITransform, Vec3, CCString } from 'cc';
import { EDITOR } from 'cc/env';
import { getCardInfo, resolveBattleFieldFrame } from './CardData';
import { CardComposer, killNode } from './CardComposer';
import { CardGlow } from './CardGlow';
import { CardSummonOrbFx, preloadSummonOrbAssets } from './CardSummonOrbFx';

const { ccclass, property, executeInEditMode, requireComponent, menu } = _decorator;

/** 战场归属：Player = 我方（CardPlay 打出卡牌的落点）；Enemy = 敌方（只做样式/排布，不参与打出流程） */
export enum BattleSide {
    Player = 0,
    Enemy = 1,
}
Enum(BattleSide);

/**
 * BattleFieldLayout —— 战场区域
 * ---------------------------------------------------------------------------
 * 挂在**战场节点**上（建议放在 Canvas 下），用于生成并排布「放入场上」的卡牌。
 * 本工程有**两个**战场区，用同一个脚本 → 暴露的变量与方法天然一致，只由 `side` 区分归属：
 *
 *   Canvas
 *   ├── PlayerHandArea               ← 手牌区（另有 HandLayout/HandDrag/CardDraw/CardPlay）
 *   ├── PlayerBattleFieldArea  ← 我方战场（side = Player，CardPlay 打出卡牌的落点）
 *   │   ├── BF_2.png           ← 放上战场的卡（由本节点上的 CardComposer 生成在本节点下）
 *   │   └── BF_3.png_2
 *   └── EnemyBattleFieldArea   ← 敌方战场（side = Enemy，只做样式/排布）
 *
 * 一、两个战场区为什么永远保持一致
 *   · **排布参数**（spacing / cardScale / maxCards / showCost）**双向自动同步**：`syncLayout = true`
 *     （默认）时，任一侧这四个值一变，立刻 `adoptLayoutParams()` 推给另一侧；对面收到后同步刷新自己的
 *     基线 → **不会来回 ping-pong**。开局 `onLoad()` 时敌方再以我方（side = Player）的值对齐一次，
 *     所以**改一处、两边同时变**。想各调各的 → 把某一侧的 `syncLayout` 关掉。
 *   · **拼接样式**天然一致：两边都用同一份 `CardData`（品质 + 类型）推导卡框；敌方工厂用
 *     `CardComposer.libSource` 复用我方工厂的贴图库（见 CardComposer.ts），
 *     因此卡框、卡名/攻/血槽位、字号颜色不可能出现两套。
 *   · **卡牌内容各不相同**：`fieldCards` 是各方独立的「战场合集」，**不参与同步**。
 *   · 敌方战场**与 PlayerHandArea 零联动**：不读手牌、不接管拖拽；也不会被 CardPlay 选中
 *     （`CardPlay.resolveField()` 只认 side = Player 的战场）。
 *
 * 二、战场卡牌集合（内容，Inspector 可编辑）
 *   `fieldCards` 就是暴露给策划/测试用的「战场合集变量」，照 HandLayout 的 hand 套路：
 *       ["2"] → 只有 1 张传说随从
 *       ["2","3"] → 依序 2 张（随从、护符）
 *       ["2","2","3"]        → 2→2.png、3→3.png，依序 3 张（重复自动命名 2_2）
 *   元素直接写编号即可（不用 .png）：'2'→'2.png'、'3'→'3.png；已带 .png 则原样使用。
 *   集合写几张就生成几张；其中**法术(Spell)会被忽略**（打印提示、不生成），
 *   **最多 maxCards 张**（超出部分忽略 + 提示）。
 *
 * 三、规则（需求）
 *   1. **只有护符(Amulet)与随从(Follower)能上战场**，法术(Spell)一律忽略；
 *   2. 战场上**最多 maxCards 张**（默认 5），超出忽略；
 *   3. 战场卡牌**竖直立正**（旋转归零）、**等间隔排列成一排**、**整体水平居中
 *      （无论几张，排面中心恒在本节点 x=0）**；
 *   4. 战场卡牌使用 **BattleField 目录**的卡框（与手牌区不同的另一套框），
 *      且名字**完全由 CardData 卡牌字典推导**，本脚本不再自己按品质拼名字：
 *        CardMap[id] 的 quality + cardType
 *          → 手牌框（随从 Hand<品质>Follower.png／护符·法术 <品质><类型>.png）
 *          → 随从：手牌版 → 原版 <品质>Follower.png
 *          → 加 `BF_` 前缀（避免与手牌区同名护符框撞名）
 *        ⇒ 随从 `BF_<品质>Follower.png`、护符 `BF_<品质>Amulet.png`
 *      入口 = CardData.resolveBattleFieldFrame(info)。因此**改一处 quality，
 *      手牌与战场会同时换框**。卡片生成时通过 CardComposer.composeCard 的 frameOverride 指定。
 *      该族框已去掉左上「绿费用圈」，故默认 suppressCost（不画费用数字）。
 *
 * 四、暴露变量
 *   **side（归属 Player/Enemy）**、**fieldCards（战场合集，Inspector 可编辑）**、
 *   **spacing（卡牌间隔）**、**cardScale（卡牌大小）**、**maxCards（卡牌上限）**、**showCost**、
 *   **attachCardGlow（随从卡自动挂 CardGlow 外发光）**、
 *   **syncLayout（与我方双向同步这组排布参数）**、**twinArea（同步对象，留空自动找）**、**previewInEditor**。
 *   改 fieldCards 或任一排布参数 → 编辑器内实时重排（previewInEditor）。
 *
 * 五、给动画编排用的接口（CardPlay 打出卡牌时用）
 *   · `computeTargets(extraWidth)` —— 预演排布目标（含「末尾多一张」的情况），不写节点；与 layout() 同几何。
 *   · `frameFor(id)` / `composerRef` —— 取某卡的战场卡框名 / 战场卡牌工厂，供外部生成战场样式卡牌。
 *   · `adoptCard(node, id)`      —— 把外部已摆到目标位的战场样式卡牌收编为最右一张（不重建、不销毁其它卡）。
 *   · `adoptLayoutParams(...)`   —— 接收对面推来的排布参数（同步用，外部一般不必调）。
 * ---------------------------------------------------------------------------
 */
@ccclass('BattleFieldLayout')
@executeInEditMode(true)
@requireComponent(UITransform)
@menu('gf2szb/BattleFieldLayout')
export class BattleFieldLayout extends Component {

    // ====================== 战场卡牌集合（内容，Inspector 可编辑）======================
    @property({
        type: [CCString],
        tooltip: '战场卡牌集合（有序）：元素 = 卡牌编号，不用带 .png（脚本自动补）。\n'
            + '["2"] → 1 张随从；["2","3"] → 依序 2 张（随从、护符）。\n'
            + '自动映射：2→2.png、3→3.png；已带 .png 则原样使用。\n'
            + '⚠️ 只有护符(Amulet)与随从(Follower)能上战场；法术(Spell)会被忽略并打印提示。\n'
            + '⚠️ 最多 maxCards 张，超出部分忽略并打印提示。',
    })
    fieldCards: string[] = ['2', '3'];

    // ====================== 卡牌工厂 ======================
    @property({
        type: Node,
        tooltip: '战场专属卡牌工厂（挂 CardComposer 的节点，其 assets 须登记 BattleField 卡框）。留空 = 取本节点上的 CardComposer',
    })
    cardFactory: Node | null = null;

    // ====================== 归属 & 双方同步 ======================
    @property({
        type: Enum(BattleSide),
        tooltip: '战场归属：Player = 我方（CardPlay 打出卡牌的落点）；Enemy = 敌方（只做样式/排布）。\n'
            + 'CardPlay 自动查找战场时只会选中 Player 那一侧，敌方战场不会被卷入打出流程。',
    })
    side: BattleSide = BattleSide.Player;

    @property({
        tooltip: '与我方战场双向同步这组排布参数（spacing / cardScale / maxCards / showCost）：\n'
            + '打开时任一侧改动会立刻推给另一侧（敌方战场开局也以我方为准对齐一次）；\n'
            + '关闭 = 各调各的（只影响参数同步，不影响 side 归属判定）。',
    })
    syncLayout = true;

    @property({
        type: Node,
        tooltip: '同步对象（挂了 BattleFieldLayout 的战场节点）。留空 = 自动在全场景里找「另一个战场」——\n'
            + '优先取 side = Player 的那一个。只有在场景里出现第 3 个战场、或想指定特殊配对时才需要手填。',
    })
    twinArea: Node | null = null;

    // ====================== 排布参数（需求要求暴露）======================
    @property({ tooltip: '战场卡牌之间的水平间隔（px，卡牌边缘到边缘）' })
    spacing = 40;

    @property({ range: [0.1, 2, 0.05], slide: true, tooltip: '战场卡牌大小（uniform 缩放）：1 = 卡框原始尺寸' })
    cardScale = 1;

    // ====================== 规则 ======================
    @property({ range: [1, 5, 1], slide: true, tooltip: '战场上最多可同时存在的卡牌数' })
    maxCards = 5;

    @property({ tooltip: '是否画费用数字。BattleField 卡框已去掉左上费用圈，默认不画' })
    showCost = false;

    @property({
        tooltip: '给战场上的**随从卡牌**自动挂 CardGlow（外发光组件）。\n'
            + '挂上只是「具备发光能力」（强度默认 0 → 不渲染），真正点亮由 BattleFieldPressGlow\n'
            + '「按住我方随从」时驱动：被按住的那张 + 敌方全部随从一起亮。\n'
            + '关闭后战场卡不再具备外发光能力（BattleFieldPressGlow 会兜底补挂）。',
    })
    attachCardGlow = true;

    /**
     * 卡牌**进战场**时是否在卡上炸一颗召唤光球（CardSummonOrbFx）。
     * 只对「真正打出的卡」生效（CardPlay / EnemyCardPlay 的收编路径）；
     * 场景加载 / 程序化 placeCard 的**批量重建**不会播（否则开战瞬间满场爆闪）。
     */
    @property({ tooltip: '卡牌进战场时播放「召唤光球」入场特效（只对真正打出的卡生效，批量重建不播）' })
    summonOrbOnEnter = true;

    @property({ tooltip: '编辑器内实时预览：改 fieldCards / spacing / cardScale 立即重排' })
    previewInEditor = true;

    // ====================== 内部状态 ======================
    /** 战场上的卡牌（顺序 = 从左到右）。{ id: 卡牌 id, node: 卡牌节点 } */
    private _entries: { id: string; node: Node }[] = [];
    /**
     * 「逻辑已死、演出未完」的卡牌节点：已从 fieldCards 摘除（不参战、不可选），
     * 但节点仍留在场景里播**破坏**动画。仅用于 refresh() 时的兜底清理。
     */
    private _orphans: Node[] = [];
    /** 脏检查 key 缓存 */
    private _dirtyKey = '';
    /** 集合超 maxCards 的提示只打一次 */
    private _warnedOverflow = false;

    // ---- 排布参数双向同步（见文件头 §一）----
    /** 同步对象缓存（twinArea 指定的，或自动找到的另一个战场） */
    private _twin: BattleFieldLayout | null = null;
    /** 是否已记录参数基线：首次只记录、不推送，避免开局把默认值推给别人 */
    private _seenInit = false;
    private _sSpacing = 0;
    private _sCardScale = 0;
    private _sMaxCards = 0;
    private _sShowCost = false;
    /** 开局是否已做过「敌方以我方为准」的对齐（每次 onLoad 重置） */
    private _aligned = false;

    onLoad() {
        preloadSummonOrbAssets();   // 预加载召唤光球资源（效果 + 3 张贴图），避免第一张牌进场时还没就绪
        this._twin = null;
        this._aligned = false;
        this.alignWithPlayerSide();   // 敌方：开局以我方（side = Player）参数为准对齐一次
        this.refresh();
    }
    onEnable() { this.refresh(); }

    update() {
        this.syncParams();                            // 参数双向同步（不受 previewInEditor 影响）
        if (!EDITOR || !this.previewInEditor) return;
        if (this.dirtyKey() !== this._dirtyKey || this.entriesBroken()) this.refresh();
    }

    // ====================== 对外查询 ======================
    /** 当前战场卡牌数 */
    public get cardCount(): number { return this._entries.length; }

    /** 战场上的卡牌节点（顺序 = 从左到右，副本数组，外部改动不影响内部） */
    public get cards(): Node[] { return this._entries.map((e) => e.node); }

    /**
     * 按「**入场顺序**（从早到晚）」返回战场上的卡牌节点（副本数组）。
     *
     * 🔴 方位口径（策划定义，勿凭直觉改）：
     *    · **我方**早入场的卡牌在**左**边 ⇒ 正序遍历 `cards`；
     *    · **敌方**早入场的卡牌在**右**边 ⇒ 逆序遍历 `cards`。
     * 为什么两方是反的：`cards` 恒为「左 → 右」，而我方新卡由 `adoptCard` **追加到尾部**、
     * 敌方新卡由 `adoptCardLeft` **插到头部** ⇒ 「越靠尾/头 = 越晚入场」在两方是相反的方向。
     *
     * 用途：卡牌能力「**分配 X 伤害**」（先打最早入场的，打死后的溢出伤害给下一张）。
     */
    public cardsByEntryOrder(): Node[] {
        const list = this.cards.slice();
        return this.side === BattleSide.Player ? list : list.reverse();
    }

    /**
     * 该卡**是否仍在战场逻辑集合里**（= 还活着、还在场）。
     * 「逻辑已被破坏、破坏演出未完」的卡已被 detachCardNode 摘除 → 这里返回 false，
     * 于是它不可被选中、不参与守护/威慑计数（正是本项目的基层准则）。
     */
    public containsCard(card: Node | null): boolean {
        if (!card) return false;
        for (const e of this._entries) if (e.node === card) return true;
        return false;
    }


    /**
     * 能否把该卡放上战场。
     * @returns ok=true 可放；否则 reason 说明原因（未登记 / 是法术 / 已满）
     */
    public canPlace(id: string): { ok: boolean; reason?: string } {
        const realId = this.toId(id);
        const info = getCardInfo(realId);
        if (!info) return { ok: false, reason: `CardMap 未登记 id="${realId}"（输入："${id}"）` };
        if (info.cardType === 'Spell') return { ok: false, reason: `法术(Spell)不能上战场：id="${realId}"（${info.cardName}）` };
        if (this._entries.length >= this.maxCards) return { ok: false, reason: `战场已满（上限 ${this.maxCards} 张）` };
        return { ok: true };
    }

    // ====================== 对外操作（都会同步更新 fieldCards）======================
    /**
     * 把一张卡放上战场（仅护符 / 随从，且未超上限），成功后立即重排。
     * 会同步把该 id 追加进 `fieldCards`，因此 Inspector 面板也会跟着更新。
     * @param id 卡牌 id（CardMap 的 key，如 '2.png'）
     * @returns 成功返回 true；被规则拒绝或生成失败返回 false（原因见控制台）
     */
    public placeCard(id: string): boolean {
        const realId = this.toId(id);
        const chk = this.canPlace(realId);
        if (!chk.ok) { console.warn(`[BattleFieldLayout] ${chk.reason}`); return false; }
        this.fieldCards = this.fieldCards.concat([realId]);
        this.markEnteredForCooperation(realId);   // ★ 协作：随从进入战场 +1
        this.rebuildFromField();
        return true;
    }

    /**
     * 从战场移除卡牌：移除**最靠左**的一张指定 id，同步更新 fieldCards。
     * @returns 实际移除的数量（0 或 1）
     */
    public removeCard(id: string): number {
        const realId = this.toId(id);
        const fi = this.fieldCards.indexOf(realId);
        if (fi < 0) return 0;
        this.fieldCards = this.fieldCards.slice(0, fi).concat(this.fieldCards.slice(fi + 1));
        this.rebuildFromField();
        return 1;
    }

    /** 清空战场（销毁所有战场卡牌，并把 fieldCards 置空） */
    public clear(): void {
        this.fieldCards = [];
        this.rebuildFromField();
    }

    /**
     * 按**节点实例**精确移除一张战场卡牌。
     *
     * 与 `removeCard(id)` 的区别：同 id 多张时不会误删最左那张；移除后直接重排，
     * 并用剩余 `_entries` 回写 `fieldCards`，保证集合与场上节点始终一致。
     */
    public removeCardNode(card: Node): boolean {
        return this.detachCardNode(card, true);
    }

    /**
     * 从战场**逻辑集合**里摘除一张卡（同步更新 _entries / fieldCards 并重排剩余卡牌）。
     * @param destroy true（默认）= 摘除后立即销毁节点（旧行为）；
     *                false = **只摘除逻辑，保留节点** —— 用于「逻辑已死、破坏动画还没播完」：
     *                        摘除后该卡不再出现在 cards，因此不可被选中、不亮选择光圈、
     *                        不参与守护/威慑计数、不占排布位置；节点留给演出队列播完再销毁。
     * @param relayout true（默认）= 摘除后**立即**重排；false = **不重排**，把重排交给演出队列。
     *                 🔴 「破坏」必须用 relayout=false：排布要等破坏动画**播完**再用连续动画更新，
     *                    绝不能在逻辑移除的瞬间直接 snap 到最新排布。
     * @returns 是否找到并摘除
     */
    public detachCardNode(card: Node, destroy = true, relayout = true): boolean {
        if (!card) return false;
        const idx = this._entries.findIndex((e) => e.node === card);
        if (idx < 0) return false;

        const entry = this._entries[idx];
        this._entries.splice(idx, 1);
        const rawIdx = this.fieldCards.findIndex((raw) => this.toId(raw) === entry.id);
        if (rawIdx >= 0) {
            this.fieldCards = this.fieldCards.slice(0, rawIdx).concat(this.fieldCards.slice(rawIdx + 1));
        } else {
            this.fieldCards = this._entries.map((e) => e.id);
        }
        if (destroy) killNode(entry.node);
        else if (this._orphans.indexOf(entry.node) < 0) this._orphans.push(entry.node);
        if (relayout) {
            this.layout();
        } else {
            // 🔴 延迟重排时也要刷新脏检查值：否则编辑器下 update() 会认为「集合变了」而 refresh()，
            //    重建战场 → 立刻 snap 成最新排布，破坏「动画播完才重排」的需求。
            this._dirtyKey = this.dirtyKey();
        }
        return true;
    }

    /**
     * 演出播完、节点已销毁时，把它从「逻辑已死、演出未完」的兜底表里移除。
     * 未调用也不会漏 —— refresh() 会统一清掉残留孤儿。
     */
    public releaseOrphan(card: Node): void {
        if (!card) return;
        const i = this._orphans.indexOf(card);
        if (i >= 0) this._orphans.splice(i, 1);
    }

    // ====================== 排布 ======================
    /**
     * 按当前 `fieldCards` 重建战场（幂等）：
     * 归一化集合 → 清空旧卡牌节点 → 逐张生成（跳过法术 / 受 maxCards 截断）→ 排布。
     */
    public refresh(): void {
        this.rebuildFromField();
    }

    /**
     * 预演战场排布目标（**本战场节点本地坐标**），**不写任何节点**。
     * 与 `layout()` 共用同一份几何，因此预演结果就是落定结果 —— 供 CardPlay 做
     * 「整排让位」与「飞入最右格」的 tween 目标（两边共用同一套坐标才不会收尾时突然平移）。
     * @param extraWidth 追加在**最右**的一张卡的宽度（已含 cardScale）；0 = 只算现有卡
     * @returns 长度 = 现有卡数 + (extraWidth>0 ? 1 : 0)，顺序与 `cards` 一致（[0] 最左）
     */
    public computeTargets(extraWidth = 0): Vec3[] {
        const widths: number[] = [];
        for (const e of this._entries) {
            const ut = e.node ? e.node.getComponent(UITransform) : null;
            widths.push((ut ? ut.contentSize.width : 0) * this.cardScale);
        }
        if (extraWidth > 0) widths.push(extraWidth);
        const n = widths.length;
        const out: Vec3[] = [];
        if (n === 0) return out;

        let total = 0;
        for (let i = 0; i < n; i++) total += widths[i] + (i < n - 1 ? this.spacing : 0);

        // 始终把整排的中点放在本节点 x=0 处（战场节点是 Canvas 直接子节点、局部 x=0 就在屏幕水平中心），
        // 因此无论场上 1 张还是 5 张卡牌，战场整体中心都锁定在节点（= 屏幕）水平中点。
        let cursor = -total / 2;
        for (let i = 0; i < n; i++) {
            out.push(new Vec3(cursor + widths[i] / 2, 0, 0));
            cursor += widths[i] + this.spacing;
        }
        return out;
    }

    /**
     * 重排战场卡牌：**竖直立正**（旋转归零）、等间隔**排列成一排**、整体水平居中。
     * 几何完全走 `computeTargets()`（卡宽取各卡自身 contentSize.width × cardScale，
     * 不同品质卡框宽度略有差异也能正确间隔）。
     */
    /** ★ 排布动画（layoutAnimated）进行中标记。 */
    private _layoutAnimating = false;

    /** ★ 排布动画（layoutAnimated）是否正在播 —— 召唤入场动画要等它播完。 */
    public get isLayoutAnimating(): boolean { return this._layoutAnimating; }

    public layout(): void {
        const targets = this.computeTargets();
        for (let i = 0; i < this._entries.length && i < targets.length; i++) {
            const node = this._entries[i].node;
            if (!node || !node.isValid) continue;
            node.setRotationFromEuler(0, 0, 0);                // 竖直立正
            node.setScale(this.cardScale, this.cardScale, 1);   // 卡牌大小
            node.setPosition(targets[i]);                      // 一排（整体居中）
            node.setSiblingIndex(i);                           // 左→右的层级顺序
        }
        // 🔴 即使一张卡都没有也要刷新脏检查值：否则 update() 会每帧都认为「集合变了」
        //    而反复 refresh（空战场时表现为编辑器里无意义的高频重建）。
        this._dirtyKey = this.dirtyKey();
    }

    /**
     * **连续动画重排**：与 `layout()` 目标完全相同（同一份 `computeTargets()` 几何），
     * 但把每张卡的**位置**从当前位置补间到目标位，而不是瞬间落下。
     *
     * 用途：破坏 / 消失动画播完之后再更新战场排布（需求：不能先 snap 到最新排布）。
     * · 旋转立正 / 缩放 / 兄弟序**立即**生效（它们不是"排布位置"，不需要补间）；
     * · 只用**一条数值补间**同时驱动所有卡的位置 → 各卡严格同步、不会各跑各的；
     * · `duration<=0` 或没有卡时等价于 `layout()`（瞬时）。
     * @param duration 动画时长（秒）
     * @param onDone 补间结束回调（只会调用一次）
     */
    public layoutAnimated(duration: number, onDone?: () => void): void {
        // ★ 排布动画进行中标记（召唤要等它播完再播入场动画，见 CardAbilitySystem.deferSummonReveal）
        this._layoutAnimating = true;
        const targets = this.computeTargets();
        const nodes: Node[] = [];
        const starts: Vec3[] = [];
        for (let i = 0; i < this._entries.length && i < targets.length; i++) {
            const node = this._entries[i].node;
            if (!node || !node.isValid) continue;
            node.setRotationFromEuler(0, 0, 0);                // 竖直立正（立即）
            node.setScale(this.cardScale, this.cardScale, 1);   // 卡牌大小（立即）
            node.setSiblingIndex(i);                           // 左→右层级（立即）
            nodes.push(node);
            starts.push(node.position.clone());
        }
        this._dirtyKey = this.dirtyKey();

        const dur = Math.max(0, duration);
        if (nodes.length === 0 || dur <= 0) {
            for (let i = 0; i < nodes.length; i++) {
                try { nodes[i].setPosition(targets[i]); } catch (e) { /* 节点可能已被销毁 */ }
            }
            this._layoutAnimating = false;
            if (onDone) onDone();
            return;
        }

        const state = { p: 0 };
        let settled = false;
        const finish = (): void => {
            if (settled) return;
            settled = true;
            this._layoutAnimating = false;
            if (onDone) onDone();
        };
        const apply = (p: number): void => {
            for (let i = 0; i < nodes.length; i++) {
                const nd = nodes[i];
                if (!nd || !nd.isValid) continue;
                const s0 = starts[i];
                const tg = targets[i];
                nd.setPosition(s0.x + (tg.x - s0.x) * p, s0.y + (tg.y - s0.y) * p, s0.z + (tg.z - s0.z) * p);
            }
        };
        try {
            tween(state)
                .to(dur, { p: 1 }, {
                    easing: 'quadInOut',
                    // 🔴 tween 回调里的异常会被引擎吞 → 一律 try/catch
                    onUpdate: () => {
                        if (settled) return;
                        try { apply(state.p); } catch (e) { /* 单帧异常忽略，让动画继续 */ }
                    },
                })
                .call(() => {
                    try { apply(1); } catch (e) { /* 同上 */ }
                    finish();
                })
                .start();
        } catch (e) {
            console.error('[BattleFieldLayout] 连续重排动画出错：', e);
            try { apply(1); } catch (err) { /* 忽略 */ }
            finish();
        }
    }

    // ====================== 供外部（CardPlay）用的接口 ======================
    /** 战场卡牌工厂（挂在**本战场节点**上的 CardComposer），供外部生成战场样式卡牌 */
    public get composerRef(): CardComposer | null {
        return this.composer();
    }

    /** 某张卡在战场上应使用的卡框资源名（带 BF_ 前缀）；法术/未登记返回 null */
    public frameFor(id: string): string | null {
        return this.battleFieldFrame(this.toId(id));
    }

    /**
     * 把外部已经生成好的**战场样式**卡牌节点收编为战场「最右一张」。
     *
     * 与 `placeCard()` 的区别：**不重建、不销毁任何现有卡牌**，也不做排布动画 ——
     * 调用方（CardPlay）已经用 tween 把新卡与其余卡牌带到了 `computeTargets()` 给出的目标位，
     * 这里只负责：搬进本节点（保世界变换，本地坐标自动落到目标位）→ 改名 → 登记 → 落定 + 同步 `fieldCards`。
     * @param node 已经摆在目标位的战场样式卡牌节点
     * @param id   卡牌 id（CardMap 的 key，带不带扩展名皆可）
     * @returns 是否收编成功
     */
    public adoptCard(node: Node, id: string): boolean {
        if (!node || !node.isValid) return false;
        const realId = this.toId(id);
        const info = getCardInfo(realId);
        if (!info) return false;
        if (info.cardType !== 'Follower' && info.cardType !== 'Amulet') return false;
        if (this._entries.length >= this.maxCards) return false;
        for (const e of this._entries) if (e.node === node) return false;

        // 保世界变换：调用方已把节点带到目标位，本地坐标由引擎换算，收编瞬间不跳位
        node.setParent(this.node, true);
        // 🔴 Node **没有 setName()**：`name` 是普通属性（直接赋值即走 setter）。
        //    写成 node.setName(x) 会抛 `TypeError: node.setName is not a function`；
        //    而本方法常被 tween 的 CallFunc 回调调用 → 异常被 TweenSystem 吞掉，
        //    只留一个浏览器红框，收编后的 layout() 与调用方的收尾逻辑**全都不会执行**。
        node.name = this.uniqueFieldName(realId);
        this.ensureCardGlow(node, realId);          // 收编进来的随从卡同样要有外发光能力
        this.playSummonOrb(node);                    // 进战场：在卡上炸一颗召唤光球
        this._entries.push({ id: realId, node });
        this.fieldCards = this.fieldCards.concat([realId]);
        this.markEnteredForCooperation(realId);   // ★ 协作：随从进入战场 +1
        this.layout();
        return true;
    }

    /**
     * ★ **召唤入场**：把已经生成好的「战场样式」卡牌**直接放上战场**（不经过手牌、不飞过来）。
     *
     * 与 `adoptCard()` 的区别（对应「召唤」关键字的需求）：
     *   · 🔴 **不触发入场曲** —— 入场曲由 `CardPlay.land()` 单独调用，本方法只负责「进场」；
     *   · 🔴 先 `layout()` 落位、**再**在**正确位置**炸落地光球（adoptCard 是「调用方已把卡带到目标位」，
     *     先炸球再落位；召唤没有飞行过程，必须先落位再炸球，否则光球会出现在战场中心）；
     *   · 不做屏幕中央展示（那是手牌打出的流程）。
     *
     * @returns ok=false + reason：节点非法 / 卡表没登记 / 不是随从护符 / **战场已满**（调用方据此走溢出流程）
     */
    public summonCard(node: Node, id: string, opts?: { silent?: boolean; deferLayout?: boolean }): { ok: boolean; reason?: string } {
        if (!node || !node.isValid) return { ok: false, reason: '节点无效' };
        const realId = this.toId(id);
        const info = getCardInfo(realId);
        if (!info) return { ok: false, reason: `CardMap 未登记 id="${realId}"` };
        if (info.cardType !== 'Follower' && info.cardType !== 'Amulet') {
            return { ok: false, reason: `只有随从 / 护符能上战场：${realId}` };
        }
        if (this._entries.length >= this.maxCards) {
            return { ok: false, reason: `战场已满（上限 ${this.maxCards} 张）` };
        }
        for (const e of this._entries) if (e.node === node) return { ok: false, reason: '该节点已在战场上' };

        node.setParent(this.node, true);
        node.name = this.uniqueFieldName(realId);
        this.ensureCardGlow(node, realId);
        // ★★ **敌我相反**：召唤落位要分阵营 ——
        //    · 我方：追加到**最右**；
        //    · 敌方：插到**最左**（玩家视角与敌方相反，敌方从右往左推进）。
        //    踩过：敌方安朵丝召唤出来的随从跑到了敌方战场最右边（不符合相反原则）。
        const toLeft = this.side === BattleSide.Enemy;
        if (toLeft) {
            this._entries.unshift({ id: realId, node });
            this.fieldCards = [realId].concat(this.fieldCards);
        } else {
            this._entries.push({ id: realId, node });
            this.fieldCards = this.fieldCards.concat([realId]);
        }
        this.markEnteredForCooperation(realId);   // ★ 协作：随从进入战场 +1
        // ① 落位：默认瞬时排布；`deferLayout` = **只把新卡摆到它自己的槽位**、其余卡先不动，
        //    由调用方补一条 `Reflow` cue 做**连续动画重排**（需求：召唤不能让排布瞬间跳过去）。
        if (opts && opts.deferLayout) {
            const targets = this.computeTargets();
            const i = toLeft ? 0 : this._entries.length - 1;   // ★ 敌方插在最左 ⇒ 槽位 0
            if (targets[i]) {
                node.setRotationFromEuler(0, 0, 0);
                node.setScale(this.cardScale, this.cardScale, 1);
                node.setPosition(targets[i]);
            }
            node.setSiblingIndex(i);
            this._dirtyKey = this.dirtyKey();
        } else {
            this.layout();
        }
        // ② 再在正确位置炸「落地」光球（`silent` = 调用方要等**上一张卡**的落地特效播完再播，见 CardAbilitySystem）
        if (!(opts && opts.silent)) this.playSummonOrb(node);
        return { ok: true };
    }

    /**
     * 在**已经落位**的战场卡上补炸一次「落地光球」（召唤的入场动画特效）。
     * 供「等上一张卡的落地特效播完再播召唤入场」的延迟流程调用（见 CardAbilitySystem.summonCards）。
     */
    public playEnterOrb(node: Node): void {
        if (!node || !node.isValid) return;
        this.playSummonOrb(node);
    }

    /** 取某张战场卡上挂的召唤光球特效（判「落地特效是否播完」用）。 */
    public summonOrbOf(node: Node): { isPlaying?: boolean } | null {
        if (!node || !node.isValid) return null;
        const c = node.getComponent('CardSummonOrbFx') as { isPlaying?: boolean } | null;
        return c || null;
    }

    /**
     * 召唤**溢出**时的站位：战场最右（我方）/ 最左（敌方）**再往外一格**。
     * 调用方拿到坐标后自己摆卡（这张卡不进 `_entries` / 不进墓场，只是「出现一下就被破坏特效收掉」）。
     */
    public overflowSlot(side: BattleSide): Vec3 {
        const list = this.cards;
        const ref = side === BattleSide.Player ? list[list.length - 1] : list[0];
        const ut = ref ? ref.getComponent(UITransform) : null;
        const w = (ut ? ut.contentSize.width : 186) * this.cardScale;
        const dir = side === BattleSide.Player ? 1 : -1;
        const x = ref ? ref.position.x + dir * (w + this.spacing) : 0;
        return new Vec3(x, ref ? ref.position.y : 0, 0);
    }

    /** 战场节点的规范命名：'BF_<id>'，同 id 第 2/3 份为 'BF_<id>_2/_3'（与 rebuildFromField 一致） */
    private uniqueFieldName(id: string): string {
        let occ = 0;
        for (const e of this._entries) if (e.id === id) occ++;
        occ++;
        return occ === 1 ? (`BF_${id}`) : (`BF_${id}_${occ}`);
    }

    /**
     * 预演战场排布目标（**新卡插在最左**，EnemyCardPlay 敌方打出用）：
     * 返回 [0] = 新卡的目标位，[1..] = 现有卡依次「右移让位」的目标位。
     * 几何与 `computeTargets()` / `layout()` 完全同源（整排水平居中），因此飞行目标
     * 与收尾落定坐标一致，不会在收尾瞬间跳位。
     * @param extraWidth 插在**最左**的新卡宽度（已含 cardScale）；0 = 只算现有卡
     */
    public computeTargetsPrepend(extraWidth = 0): Vec3[] {
        const widths: number[] = [];
        if (extraWidth > 0) widths.push(extraWidth);
        for (const e of this._entries) {
            const ut = e.node ? e.node.getComponent(UITransform) : null;
            widths.push((ut ? ut.contentSize.width : 0) * this.cardScale);
        }
        const n = widths.length;
        const out: Vec3[] = [];
        if (n === 0) return out;

        let total = 0;
        for (let i = 0; i < n; i++) total += widths[i] + (i < n - 1 ? this.spacing : 0);
        let cursor = -total / 2;
        for (let i = 0; i < n; i++) {
            out.push(new Vec3(cursor + widths[i] / 2, 0, 0));
            cursor += widths[i] + this.spacing;
        }
        return out;
    }

    /**
     * 把外部已经生成好的**战场样式**卡牌节点收编为战场「**最左一张**」。
     * 与 `adoptCard()` 的唯一区别：登记到 `_entries` / `fieldCards` 的**头部**，
     * 其余卡牌整体右移一格（敌方手牌打出流程：新卡永远排最左）。
     * 同样不重建、不销毁任何现有卡牌、不做排布动画 —— 调用方已用 tween 把新卡与
     * 其余卡牌带到 `computeTargetsPrepend()` 的目标位。
     */
    public adoptCardLeft(node: Node, id: string): boolean {
        if (!node || !node.isValid) return false;
        const realId = this.toId(id);
        const info = getCardInfo(realId);
        if (!info) return false;
        if (info.cardType !== 'Follower' && info.cardType !== 'Amulet') return false;
        if (this._entries.length >= this.maxCards) return false;
        for (const e of this._entries) if (e.node === node) return false;

        node.setParent(this.node, true);            // 保世界变换收编，本地坐标自动落到目标位
        node.name = this.uniqueFieldName(realId);   // 🔴 Node 没有 setName()，直接赋值
        this.ensureCardGlow(node, realId);
        this.playSummonOrb(node);                   // 进战场：敌方卡同样炸一颗召唤光球
        this._entries.unshift({ id: realId, node });
        this.fieldCards = [realId].concat(this.fieldCards);
        this.layout();
        return true;
    }

    // ====================== 排布参数双向同步（两个战场区保持一致）======================
    /**
     * 接收对面推来的排布参数（我方 ↔ 敌方双向同步的落点）。
     *
     * 除改值外还会**同步刷新自己的基线**（`_seen*`）→ 下一帧 `syncParams()` 看不到「变化」，
     * 因此不会把同样的值再推回去（否则两边会无限来回推送）。
     * 值本来就相同时直接返回，不动节点、不重排。
     */
    public adoptLayoutParams(spacing: number, cardScale: number, maxCards: number, showCost: boolean): void {
        if (this.spacing === spacing && this.cardScale === cardScale
            && this.maxCards === maxCards && this.showCost === showCost) return;
        this.spacing = spacing;
        this.cardScale = cardScale;
        this.maxCards = maxCards;
        this.showCost = showCost;
        this.snapshotParams();   // 记基线：防止回推造成 ping-pong
        this.refresh();          // 立刻按新参数重排（编辑器 / 运行时都生效）
    }

    /** 记下当前参数作为「已处理的基线」 */
    private snapshotParams(): void {
        this._sSpacing = this.spacing;
        this._sCardScale = this.cardScale;
        this._sMaxCards = this.maxCards;
        this._sShowCost = this.showCost;
        this._seenInit = true;
    }

    /**
     * 本帧检测：排布参数是否被本地改过？改过就推给同步对象。
     * 每帧只是 4 次数值比较，没有字符串拼接/数组分配。
     */
    private syncParams(): void {
        if (!this._seenInit) { this.snapshotParams(); return; }
        if (this._sSpacing === this.spacing && this._sCardScale === this.cardScale
            && this._sMaxCards === this.maxCards && this._sShowCost === this.showCost) return;
        this.snapshotParams();                    // 先记基线：无论能否推出去，本次变化都算已处理
        if (!this.syncLayout) return;
        const twin = this.twinLayout();
        if (!twin) return;
        twin.adoptLayoutParams(this.spacing, this.cardScale, this.maxCards, this.showCost);
    }

    /**
     * 开局对齐：**只有敌方**（side ≠ Player）执行 —— 主动以我方战场的参数为准，
     * 这样即便 .scene 里两边数值不一致（手改过、或新加的战场带着默认值），
     * 一进游戏也会自动与手牌打出侧统一，不需要人工再点一遍。
     * 在 `onLoad()` 里调用：此时读到的都是 .scene 反序列化后的配置值，与加载顺序无关。
     */
    private alignWithPlayerSide(): void {
        if (this._aligned) return;
        this._aligned = true;
        if (this.side === BattleSide.Player) return;   // 我方是基准，不反向对齐
        if (!this.syncLayout) return;
        const twin = this.twinLayout();
        if (!twin) return;
        this.spacing = twin.spacing;
        this.cardScale = twin.cardScale;
        this.maxCards = twin.maxCards;
        this.showCost = twin.showCost;
    }

    /**
     * 同步对象：`twinArea` 指定优先，否则**全场景 BFS** 找「另一个战场」——
     * 优先 `side = Player` 的那一个（没有才退而取任意另一个）。
     * 结果缓存；被销毁或停用时自动重新解析。
     */
    private twinLayout(): BattleFieldLayout | null {
        if (this._twin && this._twin.isValid && this._twin !== this) return this._twin;
        if (this.twinArea && this.twinArea.isValid) {
            const c = this.twinArea.getComponent(BattleFieldLayout);
            if (c && c !== this) { this._twin = c; return c; }
        }
        const scene = this.node.scene as unknown as Node | null;
        if (!scene) return null;
        let fallback: BattleFieldLayout | null = null;
        const stack: Node[] = [...scene.children];
        while (stack.length > 0) {
            const cur = stack.shift() as Node;
            const c = cur.getComponent(BattleFieldLayout);
            if (c && c !== this && c.isValid) {
                if (c.side === BattleSide.Player) { this._twin = c; return c; }
                if (!fallback) fallback = c;
            }
            for (const ch of cur.children) stack.push(ch);
        }
        this._twin = fallback;
        return fallback;
    }

    // ====================== 内部 ======================
    /**
     * 给战场卡（**仅随从**）挂上 CardGlow —— 即「外发光能力」。
     *
     * 为什么只挂随从：需求要求「按住我方随从卡牌」时，**被按住的这一张 + 敌方全部随从**
     * 一起发光，护符不参与。挂上时强度为 0（CardGlow 会把光晕节点隐藏）→ 常态零渲染开销，
     * 真正点亮由 BattleFieldPressGlow 驱动。
     *
     * ⚠️ 必须在 composeCard（把卡拼好）**之后**调用：CardGlow 要从 CardFrame 子节点
     *    取卡框贴图来生成光晕方块。
     */
    /** ★ 协作记账：随从进入战场 +1（护符 / 法术不计）。 */
    private markEnteredForCooperation(id: string): void {
        const info = getCardInfo(this.toId(id));
        if (!info || info.cardType !== 'Follower') return;
        const side = this.side === BattleSide.Player ? 'player' : 'enemy';
        try {
            const scene = this.node.scene as unknown as Node | null;
            if (!scene) return;
            const stack: Node[] = [...scene.children];
            while (stack.length > 0) {
                const cur = stack.shift() as Node;
                const r = cur.getComponent('BattleRuleSystem') as { markFollowerEntered?: (s: string) => void } | null;
                if (r && typeof r.markFollowerEntered === 'function') { r.markFollowerEntered(side); return; }
                for (const ch of cur.children) stack.push(ch);
            }
        } catch (e) { console.error('[BattleFieldLayout] 协作记账失败：', e); }
    }
    private ensureCardGlow(node: Node, id: string): void {
        if (!this.attachCardGlow) return;
        if (!node || !node.isValid) return;
        const info = getCardInfo(this.toId(id));
        if (!info || info.cardType !== 'Follower') return;
        if (!node.getComponent(CardGlow)) node.addComponent(CardGlow);
    }

    /**
     * 给卡牌挂上「入场召唤光球」组件（**幂等**，只挂不播）。
     * 战场重建（rebuildFromField）时也调用它，保证之后被收编 / 手动触发时有组件可用；
     * 但重建本身**不播**动画 —— 否则开战瞬间整场卡牌会一起爆闪。
     */
    private ensureSummonOrbFx(node: Node): CardSummonOrbFx | null {
        if (!node || !node.isValid) return null;
        return node.getComponent(CardSummonOrbFx) ?? node.addComponent(CardSummonOrbFx);
    }

    /**
     * 卡牌进战场：在卡上炸一颗召唤光球。
     * 🔴 只由 adoptCard / adoptCardLeft（= 真正打出的卡）调用，**不要**放进 rebuildFromField。
     */
    private playSummonOrb(node: Node): void {
        if (!this.summonOrbOnEnter) return;
        const fx = this.ensureSummonOrbFx(node);
        if (fx) fx.play();
    }

    /** 取战场卡牌工厂（CardComposer） */
    private composer(): CardComposer | null {
        const host = this.cardFactory ?? this.node;
        const c = host.getComponent(CardComposer);
        if (c) return c;
        return this.node.getComponent(CardComposer);
    }

    /**
     * 推导该卡在战场使用的卡框资源名 —— **与手牌同源**，不另立一套按品质拼名字的逻辑。
     *
     * 名字完全由 CardData 的卡牌字典决定：
     *   CardMap[id] 的 quality + cardType
     *     → 手牌框（随从 Hand<品质>Follower.png／护符 <品质>Amulet.png）
     *     → 随从：手牌版 → 原版 <品质>Follower.png
     *     → 加 `BF_` 前缀（战场框在本工程资源库里的登记名，见 CardLayout.ts）
     * 即：改一处 `quality`，手牌与战场会**同时**换框。
     *
     * 例：'2.png' Legendary 随从 HandLegendaryFollower.png → 'BF_LegendaryFollower.png'
     *     '3.png' Silver   护符 SilverAmulet.png          → 'BF_SilverAmulet.png'
     *
     * 法术（Spell）返回 null —— 战场框不存在，不允许上战场。
     */
    private battleFieldFrame(id: string): string | null {
        const info = getCardInfo(id);
        if (!info) return null;
        if (info.cardType !== 'Follower' && info.cardType !== 'Amulet') return null;
        return resolveBattleFieldFrame(info);
    }

    /**
     * 战场各卡推导出的卡框名签名（顺序 = fieldCards 顺序）。
     * 用于脏检查：CardData 的 quality / cardType 一变，编辑器预览里的战场就跟着重排换框。
     * 这里刻意不走 buildFieldIds()，避免逐帧刷「超硬上限」告警。
     */
    private frameSignature(): string {
        const raw = Array.isArray(this.fieldCards) ? this.fieldCards : [];
        const out: string[] = [];
        for (const e of raw) {
            const id = this.toId(e);
            if (id) out.push(this.battleFieldFrame(id) ?? '-');
        }
        return out.join(',');
    }

    /** 集合元素 → 卡牌 id（CardData.CardMap 的 key）。'2'→'2.png'；已带扩展名则原样；空值返回 '' */
    private toId(entry: string): string {
        const s = (entry === null || entry === undefined) ? '' : String(entry).trim();
        if (!s) return '';
        return /\.[a-z0-9]+$/i.test(s) ? s : (s + '.png');
    }

    /** 把 `fieldCards` 转成有效卡牌 id 列表（做映射、剔除空项、硬上限截断） */
    private buildFieldIds(): string[] {
        const raw = Array.isArray(this.fieldCards) ? this.fieldCards : [];
        const out: string[] = [];
        for (const e of raw) {
            const id = this.toId(e);
            if (id) out.push(id);
        }
        if (out.length > HARD_MAX_CARDS) {
            console.warn(`[BattleFieldLayout] 战场集合 ${out.length} 张超过硬上限 ${HARD_MAX_CARDS}，只生成前 ${HARD_MAX_CARDS} 张。`);
            out.length = HARD_MAX_CARDS;
        }
        return out;
    }

    /**
     * 销毁当前所有战场卡牌节点（不动 fieldCards）。
     * 🔴 必须走 killNode（先脱离父节点再 destroy）：destroy 是延迟销毁，同帧内二次 refresh 时
     *    composeCard 的「按名字取子节点」会复用到这个待销毁节点，帧末它照样被摘除 →
     *    战场变成一张卡都没有（详见 CardComposer.killNode 的注释）。
     */
    private clearNodes(): void {
        for (const e of this._entries) killNode(e.node);
        this._entries = [];
        // 顺带清掉「逻辑已死、演出未完」的残留节点（正常路径里演出结束已自行销毁 + releaseOrphan）。
        for (const n of this._orphans) killNode(n);
        this._orphans = [];
    }

    /**
     * 战场卡牌节点是否已与场景脱钩（被销毁 / 被移出 / 换过父节点）。
     * 作为兜底自愈：一旦发现脱钩就重建，避免「脚本跑过但场上空无一物」这种静默失败
     * 因脏检查值没变而永远不再重试。
     */
    private entriesBroken(): boolean {
        for (const e of this._entries) {
            if (!e.node || !e.node.isValid || e.node.parent !== this.node) return true;
        }
        return false;
    }

    /** 按 `fieldCards` 重建战场：清空旧节点 → 逐张生成（跳过法术 / 受 maxCards 截断）→ 排布 */
    private rebuildFromField(): void {
        const comp = this.composer();
        if (!comp) {
            console.warn('[BattleFieldLayout] 找不到 CardComposer（战场卡牌工厂），无法生成卡牌。');
            this.clearNodes();
            this._dirtyKey = this.dirtyKey();
            return;
        }
        comp.cardScale = this.cardScale;

        const ids = this.buildFieldIds();
        this.clearNodes();

        const occ: Record<string, number> = {};
        const keep: string[] = [];
        let placed = 0;
        for (const id of ids) {
            if (placed >= this.maxCards) {
                if (!this._warnedOverflow) {
                    this._warnedOverflow = true;
                    console.warn(`[BattleFieldLayout] 战场集合 ${ids.length} 张 > maxCards=${this.maxCards}：只生成前 ${this.maxCards} 张（超出的忽略）。`);
                }
                break;
            }
            this._warnedOverflow = false;

            const frame = this.battleFieldFrame(id);
            if (!frame) { console.warn(`[BattleFieldLayout] 跳过不能上战场的卡（法术或未登记）：id="${id}"`); continue; }

            occ[id] = (occ[id] || 0) + 1;
            const name = occ[id] === 1 ? (`BF_${id}`) : (`BF_${id}_${occ[id]}`);
            const node = comp.composeCard(id, name, keep.length, { frameOverride: frame, suppressCost: !this.showCost });
            if (node) {
                this.ensureCardGlow(node, id);      // 随从卡挂上外发光能力（默认强度 0 = 不渲染）
                this.ensureSummonOrbFx(node);       // 挂上召唤光球组件（只挂不播；重建不炸闪）
                this._entries.push({ id, node });
                keep.push(name);
                placed++;
            }
        }

        this.layout();
        comp.clearGenerated(keep);
    }

    /**
     * 脏检查 key：`fieldCards` / 任一布局参数 / **各卡推导出的战场卡框名** / **工厂贴图库版本** 变化 → 触发重排。
     * 把卡框名纳入 key（而不是只留 fieldCards），是为了让「改了 CardData 的 quality / cardType」
     * 能在编辑器预览里自动反映到战场 —— 否则 key 不变，update() 永远不会重排。
     * 把工厂的 `libRev` 纳入 key，是为了让「工厂贴图库（含 libSource 借来的）准备就绪」被立刻感知。
     */
    private dirtyKey(): string {
        // 工厂贴图库的版本号也要进 key：敌方工厂靠 `CardComposer.libSource` 复用我方贴图库，
        // 库一就绪（或我方 Inspector 里改了登记资源）战场就得按正确卡框重建 ——
        // 否则会出现「卡框没取到 → 宽度掉到 204 兜底值、Sprite 空帧」的静默半成品。
        const comp = this.composer();
        return [
            (this.fieldCards || []).join(','),
            this.spacing, this.cardScale, this.maxCards, this.showCost ? 1 : 0,
            this.frameSignature(),
            comp ? comp.libRev : -1,
        ].join('|');
    }
}

/** 战场集合的硬上限：只用于挡住「误填空/粘贴出上百项」这种异常输入 */
const HARD_MAX_CARDS = 20;
