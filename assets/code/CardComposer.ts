import { _decorator, CCString, Color, Component, Label, Node, Sprite, SpriteFrame, UITransform, Mask } from 'cc';
import { EDITOR } from 'cc/env';
import { getCardInfo, resolveCardFrame, frameBasename, CardInfo } from './CardData';
import { getCardLayout, CardLayout } from './CardLayout';
import {
    applyBattleValueOutline,
    BATTLE_VALUE_DEFAULT,
    formatBattleAttack,
    formatBattleValue,
} from './BattleValueStyle';

const { ccclass, property, executeInEditMode, requireComponent, menu } = _decorator;

/**
 * CardComposer —— 卡牌工厂
 * ---------------------------------------------------------------------------
 * 本脚本挂在**一个专用节点**上（而非单张卡牌），负责把所有需要的卡牌一次性生成出来：
 *   CardFactory            ← 挂本脚本（专用节点，一般放在 Canvas 下）
 *   ├── Card_1.png         ← 由 cardIds 生成：一张完整卡牌
 *   │   ├── CardImage      ← 卡图（底层），等比铺满卡框「开窗」
 *   │   ├── CardFrame      ← 卡框（顶层）
 *   │   ├── CardCost       ← 费用数字
 *   │   └── CardName       ← 卡名
 *   └── Card_2.png         ← 随从卡额外多两层：
 *       ├── CardImage / CardFrame / CardCost / CardName
 *       ├── CardHp         ← 血量数字（**左侧竖栏下格**的红盾内）
 *       └── CardAttack     ← 攻击数字（**左侧竖栏上格**的蓝金徽记内）
 *
 * 数据来源：
 *   - 卡牌数据（卡图名、品质、类型、名称、费用、血量、攻击）来自 CardData.CardMap；
 *     卡框资源名由 CardData.resolveCardFrame 推导 —— **随从一律用手牌版卡框
 *     Hand<品质>Follower.png**（HandBronzeFollower / HandSilverFollower /
 *     HandGoldFollower / HandLegendaryFollower），该族把攻击/血量徽记放在框架
 *     左侧竖栏（攻击在上、血量在下），裁剪底边即下边框，手牌圆弧排布不会偏斜；
 *   - 卡框几何（开窗、各文字槽位中心）来自 CardLayout.CardLayouts；
 *   - 贴图由本组件上的 assetNames / assets 两个平行数组登记（资源名 → SpriteFrame）。
 *
 * 卡牌生成到哪个父节点（两种模式，可共存）：
 *  1) 普通模式：卡牌生成在本节点（CardFactory）下，按 cardIds × copies 批量横排；
 *  2) 手牌模式：cardParent 指向手牌区（或本节点挂在手牌区之下，自动向上找到挂了
 *     HandLayout 的祖先节点）→ 卡牌直接成为**手牌区**的子节点，并且整份手牌的
 *     张数/顺序/扇形排布全部交给 HandLayout 驱动（此时 cardIds/copies 不再参与，
 *     HandLayout 会调用本组件的 composeCard(id, name) 逐张生成）。
 *
 * 三条关键实现（都踩过坑，务必保留）：
 *  1) 卡框导入时必须裁掉外圈镂空（trimType=auto）→ spriteFrame.rect 即卡牌标准尺寸。
 *  2) 两个 Sprite 都开 trim=true：引擎 2d/assembler/sprite/simple.ts 中 trim=true 时
 *     四边形严格等于节点 contentSize（不做 trimmedBorder 偏移），「节点矩形 = 贴图矩形」。
 *  3) 卡图按「开窗」铺（默认 COVER）：很多卡框铜框本体在画布内是内缩的（角部被装饰物
 *     占据，自动裁切去不掉那条透明带），按整张卡铺会露到框外；按开窗铺则溢出的部分
 *     正好落在不透明边框下面被盖住 → 开窗 100% 填满且绝不外露。
 *  4) 卡图按开窗铺时额外向外扩 artOverscan(px)：卡框镂空边缘的抗锯齿像素会让开窗检测
 *     少算约 1px（表现为镂空右侧/某侧漏出底色），外扩量落在卡框不透明边框之下被盖住
 *     （需求明确允许），从而确保镂空 100% 填满、绝不露底。
 */
@ccclass('CardComposer')
@executeInEditMode(true)
@requireComponent(UITransform)
@menu('gf2szb/CardComposer')
export class CardComposer extends Component {

    // ====================== 生成位置 ======================
    @property({ type: Node, tooltip: '卡牌的父节点。留空 = 自动：若祖先里挂了 HandLayout(手牌区) 则生成到手牌区下，否则生成在本节点下' })
    cardParent: Node | null = null;

    // ====================== 要生成的卡牌 ======================
    @property({ type: [CCString], tooltip: '要生成的卡牌 id 列表（CardData.CardMap 的 key，即卡图资源名），如 ["1.png","2.png"]。手牌区(HandLayout)接管时本项不参与' })
    cardIds: string[] = ['1.png', '2.png'];

    @property({ tooltip: '是否按 cardIds 自动批量生成卡牌。战场等「由外部脚本（如 BattleFieldLayout）逐张收编」的卡牌工厂应关闭，避免 onLoad 自动铺一堆默认/手牌框卡牌' })
    autoGenerate = true;

    @property({ range: [1, 9, 1], slide: true, tooltip: '批量生产：每个 cardIds 条目重复生成的份数。3 = 每张卡出 3 份（共 cardIds.length×copies 张）' })
    copies = 1;

    // ====================== 贴图资源库（资源名 → SpriteFrame）======================
    @property({ type: [CCString], tooltip: '（可选）贴图资源名列表，与 assets 一一对应。留空则自动从 SpriteFrame 推断资源名' })
    assetNames: string[] = [];

    @property({ type: [SpriteFrame], tooltip: '贴图 SpriteFrame 列表（与 assetNames 一一对应）' })
    assets: SpriteFrame[] = [];

    @property({ type: Node, tooltip: '贴图库来源（可选）：填**另一个挂了 CardComposer 的节点** → 本工厂直接复用它的 assetNames/assets 贴图库，\n'
        + '本组件自己的 assets 可以留空。两个战场区就靠这个共用同一份卡框登记（改一处两边同时变），\n'
        + '也避免把同一批卡框资产登记两遍。留空 = 只用本组件的 assets。\n'
        + '（两边的 assets 都登记了同名资源时，以**本组件自己的**为准。）' })
    libSource: Node | null = null;

    // ====================== 生成布局 ======================
    @property({ tooltip: '多张卡之间的水平间距（px）' })
    spacing = 40;

    @property({ range: [0.1, 5, 0.05], slide: true, tooltip: '整卡缩放（uniform）：1 = 卡框原始尺寸，各子层随之等比缩放' })
    cardScale = 1;

    @property({ range: [0, 2, 1], slide: true, tooltip: '卡图适配开窗：0=等比铺满(默认，填满不变形) 1=等比放入 2=拉伸铺满' })
    artFit = 0;

    @property({ tooltip: '兜底：把超出卡框的卡图裁掉。几何已保证不超出，默认关闭以省一个 DrawCall' })
    clipArtToFrame = false;

    @property({ range: [0, 12, 1], slide: true, tooltip: '卡图向四周外扩的保险量(px)：抵消开窗检测在 AA 边缘的 ~1px 误差，确保镂空被填满；外扩部分落在卡框不透明边框下被盖住（允许）' })
    artOverscan = 2;

    // ====================== 文字：字号（已暴露，随时可调）======================
    @property({ tooltip: '费用数字字号（px）' })
    costFontSize = 30;

    @property({ tooltip: '卡名字号（px）' })
    nameFontSize = 14;

    @property({ tooltip: '血量数字字号（px）' })
    hpFontSize = 26;

    @property({ tooltip: '攻击数字字号（px）' })
    atkFontSize = 26;

    // ====================== 文字：颜色 ======================
    @property({ type: Color, tooltip: '费用数字颜色' })
    costColor = new Color(255, 255, 255, 255);

    @property({ type: Color, tooltip: '卡名颜色' })
    nameColor = new Color(255, 255, 255, 255);

    @property({ type: Color, tooltip: '血量数字颜色' })
    hpColor = new Color(BATTLE_VALUE_DEFAULT.r, BATTLE_VALUE_DEFAULT.g, BATTLE_VALUE_DEFAULT.b, BATTLE_VALUE_DEFAULT.a);

    @property({ type: Color, tooltip: '攻击数字颜色' })
    atkColor = new Color(BATTLE_VALUE_DEFAULT.r, BATTLE_VALUE_DEFAULT.g, BATTLE_VALUE_DEFAULT.b, BATTLE_VALUE_DEFAULT.a);

    // ====================== 位置微调（基础位置来自 CardLayout）======================
    @property costOffsetX = 0;
    @property costOffsetY = 0;
    @property nameOffsetX = 0;
    @property nameOffsetY = 0;
    @property hpOffsetX = 0;
    @property hpOffsetY = 0;
    @property atkOffsetX = 0;
    @property atkOffsetY = 0;

    @property({ tooltip: '编辑器内实时预览：改属性立即重拼' })
    previewInEditor = true;

    // ------------------------------ 内部状态 ------------------------------
    /** 贴图库：资源名 → SpriteFrame（由 assetNames/assets 构建，或用 setAsset 注入） */
    private _lib: Record<string, SpriteFrame> = {};
    private _dirtyKey = '';
    /** 正在构建贴图库（防 libSource 互相引用时的无限递归） */
    private _building = false;
    /** 贴图库版本号：每次构建完成自增。BattleFieldLayout 把它纳入脏检查 →
     *  库一就绪（含通过 libSource 借来的键）战场就自动按正确卡框重建。 */
    private _libRev = 0;

    // ------------------------------ 生命周期 ------------------------------
    onLoad() { this.rebuild(); }
    onEnable() { this.rebuild(); }

    update() {
        if (!EDITOR || !this.previewInEditor) return;
        if (this.dirtyKey() !== this._dirtyKey) this.rebuild();
    }

    // ------------------------------ 对外 API ------------------------------
    /** 运行时注册一张贴图（资源名 → SpriteFrame），并重拼 */
    public setAsset(name: string, sf: SpriteFrame | null): void {
        if (!name || !sf) return;
        this._lib[name] = sf;
        this.rebuild();
    }

    /** 运行时批量注册贴图，并重拼 */
    public setAssets(map: Record<string, SpriteFrame>): void {
        for (const k of Object.keys(map)) {
            if (map[k]) this._lib[k] = map[k];
        }
        this.rebuild();
    }

    /** 运行时指定要生成哪些卡并重拼 */
    public showCards(ids: string[]): void {
        this.cardIds = (ids || []).slice();
        this.rebuild();
    }

    /** 当前实际生成出来的卡牌节点（容器里的「卡牌集合」，顺序 = 生成顺序） */
    public getCards(): Node[] {
        const parent = this.resolvedParent();
        const out: Node[] = [];
        for (const ch of parent.children) {
            if (isComposedCard(ch)) out.push(ch);
        }
        return out;
    }

    /**
     * 生成（或复用）**单张**卡牌节点并返回它；失败返回 null。
     * 供 HandLayout 等外部布局脚本调用：实例化一张卡 → 自己收进集合 → 自行排布。
     * @param id       卡牌 id（CardMap 的 key，即卡图资源名，如 '1.png'）
     * @param nodeName 节点名；留空时用 'Card_' + id。同名节点会被**复用**而不是重复创建（幂等）
     * @param index    兄弟节点序号；留空放到末尾
     * @param opts     可选覆盖项：
     *                 · frameOverride —— 强制使用指定卡框资源名（覆盖 resolveCardFrame）。
     *                   战场卡即用此项：随从/护符改用 BattleField 目录卡框（'BF_<原名>'）。
     *                   该名字必须同时满足：① 本组件贴图库里有对应 SpriteFrame；
     *                   ② CardLayout 里有同名布局登记。
     *                 · suppressCost —— 不生成费用数字（BattleField 卡框已去掉左上费用圈）。
     */
    public composeCard(id: string, nodeName?: string, index?: number,
                       opts?: { frameOverride?: string; suppressCost?: boolean }): Node | null {
        if (Object.keys(this._lib).length === 0) this.buildLib();
        const p = this.makePlan(id, opts && opts.frameOverride);
        if (!p) return null;
        const parent = this.resolvedParent();
        const name = (nodeName && nodeName.length > 0) ? nodeName : ('Card_' + p.id);
        const node = this.ensureChild(parent, name, index === undefined ? parent.children.length : index);
        this.buildCard(node, p, !!(opts && opts.suppressCost));
        return node;
    }

    /**
     * 清掉卡牌父节点下、不在 keep 名单里的**卡牌节点**（其它非卡牌子节点不动）。
     * 若卡牌父节点不是本节点（手牌模式），本节点下残留的旧卡牌也会一并清掉。
     * @param keep 需要保留的卡牌节点名列表
     */
    public clearGenerated(keep: string[] = []): void {
        const parent = this.resolvedParent();
        this.sweepCards(parent, keep);
        if (parent !== this.node) this.sweepCards(this.node, []);
    }

    // ------------------------------ 核心：批量生成 ------------------------------
    /** 重建所有卡牌（幂等，可反复调用） */
    public rebuild(): void {
        // 1) 构建贴图库（资源名 → SpriteFrame）
        this.buildLib();

        // 2) 手牌模式：卡牌父节点（或祖先）上挂了 HandLayout → 整份手牌交给它驱动
        //    （HandLayout 会回调 composeCard 逐张生成，并做扇形排布）
        const parent = this.resolvedParent();
        const hand = resolveHandLayout(parent);
        if (hand) {
            hand.refresh();
            this._dirtyKey = this.dirtyKey();
            return;
        }

        // 2.5) 关闭自动生成（战场工厂等）：仅构建贴图库，不铺任何卡牌，
        //      改由外部脚本（BattleFieldLayout.placeCard 等）逐张收编。
        if (!this.autoGenerate) {
            this._dirtyKey = this.dirtyKey();
            return;
        }

        // 3) 普通模式：把 cardIds 按 copies 展开成多份，便于批量生产
        const rawIds = (this.cardIds || []).filter((x) => !!x && x.length > 0);
        const expanded: string[] = [];
        const reps = Math.max(1, Math.floor(this.copies));
        for (const id of rawIds) {
            for (let c = 0; c < reps; c++) expanded.push(id);
        }

        const keep: string[] = [];
        const occ: Record<string, number> = {};   // 同 id 出现次数 → 唯一节点名
        for (const id of expanded) {
            const p = this.makePlan(id);
            if (!p) continue;
            occ[p.id] = (occ[p.id] || 0) + 1;
            const nodeName = occ[p.id] === 1 ? ('Card_' + p.id) : ('Card_' + p.id + '_' + occ[p.id]);
            keep.push(nodeName);
            this.composeCard(p.id, nodeName, keep.length - 1);
        }

        // 4) 清掉不再需要的旧卡节点
        this.clearGenerated(keep);

        // 5) 水平居中排布（手牌模式下由 HandLayout 负责，不会走到这里）
        this.layoutHorizontally(keep);

        this._dirtyKey = this.dirtyKey();
    }

    /** 组装一张卡的生成计划（解析数据 + 贴图 + 布局），失败返回 null */
    private makePlan(id: string, frameOverride?: string): CardPlan | null {
        const info = getCardInfo(id);
        if (!info) {
            console.warn(`[CardComposer] CardMap 中找不到 id="${id}"，已跳过。`);
            return null;
        }
        // 卡框资源名：默认随从取**手牌版** Hand<品质>Follower.png（见 CardData.resolveCardFrame，
        // 卡框完全由 quality + cardType 推导，卡表里没有可写的卡框字段）。
        // 战场等场景可用 frameOverride 强制换用别的卡框（如 BattleField 目录的 'BF_<原名>'）。
        // 统一做一次「资源路径 → 资源名」归一化：frameOverride 允许写成 'frame/xxx.png' 这类路径，
        // 归一化后才能同时命中 CardLayouts 的 key 与贴图库的键。
        const rawFrame = (frameOverride && frameOverride.length > 0)
            ? frameOverride
            : resolveCardFrame(info);
        const frameName = frameBasename(rawFrame);
        const art = this.resolveAsset(info.cardImage);
        const frame = this.resolveAsset(frameName);
        if (!art || !frame) {
            console.warn(`[CardComposer] 贴图缺失：art="${info.cardImage}"(${art ? 'ok' : '缺'}) frame="${frameName}"(${frame ? 'ok' : '缺'})；`
                + `当前贴图库键 = [${Object.keys(this._lib).join(', ')}]`);
        }

        const layout = getCardLayout(frameName);
        if (!layout) {
            console.warn(`[CardComposer] CardLayout 未登记卡框 "${frameName}"，跳过 id="${id}"。`);
            return null;
        }

        const w = frame ? frame.rect.width : 204;
        const h = frame ? frame.rect.height : 252;
        return { id, info, frameName, art, frame, layout, w, h };
    }

    /** 构建贴图库：优先用 assetNames 显式名，其次从 SpriteFrame 自身推断资源名，最后补来源库 */
    private buildLib(): void {
        // 防环：两个工厂互相把对方当 libSource 时，让「正在构建」的那一方先返回（拿到部分库也不会崩）
        if (this._building) return;
        this._building = true;
        try {
            this._lib = {};
            // 1) 显式名（可选，Inspector 里填了就用）
            const n = Math.min(this.assetNames.length, this.assets.length);
            for (let i = 0; i < n; i++) {
                const nm = this.assetNames[i];
                const sf = this.assets[i];
                if (nm && nm.length > 0 && sf) this._lib[nm] = sf;
            }
            // 2) 从资源自身推断（带扩展名与不带扩展名都登记，便于匹配）
            for (const sf of this.assets) {
                if (!sf) continue;
                for (const k of candidateNames(sf)) {
                    if (!k) continue;
                    if (!this._lib[k]) this._lib[k] = sf;
                    const noExt = k.replace(/\.[a-z0-9]+$/i, '');
                    if (noExt && !this._lib[noExt]) this._lib[noExt] = sf;
                }
            }
            // 3) 借来源库（只补本组件没有的键 → 本组件自己的登记永远优先）
            const src = this.sourceLib();
            if (src) {
                for (const k of Object.keys(src)) {
                    if (!this._lib[k]) this._lib[k] = src[k];
                }
            }
        } finally {
            this._building = false;
            this._libRev++;
        }
    }

    /**
     * 本组件的贴图库（必要时先构建一次）。**供其它 CardComposer 通过 `libSource` 复用**：
     * 两个战场工厂里，一个登记 assets、另一个把 `libSource` 指向它即可，无需重复登记同一批卡框。
     */
    public get textureLib(): Record<string, SpriteFrame> {
        if (Object.keys(this._lib).length === 0) this.buildLib();
        return this._lib;
    }

    /** 贴图库版本号（每次构建完成自增）。BattleFieldLayout 用它做脏检查，库一变就自动重拼 */
    public get libRev(): number {
        return this._libRev;
    }

    /** `libSource` 指向的那个工厂的贴图库（没填 / 指向自己 / 对方没有本组件 → null） */
    private sourceLib(): Record<string, SpriteFrame> | null {
        const src = this.libSource;
        if (!src || !src.isValid || src === this.node) return null;
        const c = src.getComponent(CardComposer);
        if (!c || c === this) return null;
        return c.textureLib;
    }

    /** 按资源名取 SpriteFrame（支持带 / 不带扩展名，也支持写成资源路径） */
    private resolveAsset(name: string): SpriteFrame | null {
        if (!name) return null;
        if (this._lib[name]) return this._lib[name];
        const noExt = name.replace(/\.[a-z0-9]+$/i, '');
        if (this._lib[noExt]) return this._lib[noExt];
        // 兜底：cardImage 或 frameOverride 写成路径（'frame/xxx.png'、'db://assets/...'）时取纯文件名再试
        const base = frameBasename(name);
        if (base && base !== name) {
            if (this._lib[base]) return this._lib[base];
            const baseNoExt = base.replace(/\.[a-z0-9]+$/i, '');
            if (this._lib[baseNoExt]) return this._lib[baseNoExt];
        }
        return null;
    }

    /** 把一张卡拼到指定节点上 */
    private buildCard(node: Node, p: CardPlan, suppressCost = false): void {
        // 卡牌基准尺寸 = 卡框裁剪后尺寸
        const ut = node.getComponent(UITransform) ?? node.addComponent(UITransform);
        ut.setAnchorPoint(0.5, 0.5);
        ut.setContentSize(p.w, p.h);
        node.setScale(this.cardScale, this.cardScale, 1);

        const L = p.layout;

        // 开窗（图像坐标，左上原点，y 向下）
        const innerW = Math.max(1, p.w - L.windowLeft - L.windowRight);
        const innerH = Math.max(1, p.h - L.windowTop - L.windowBottom);
        // 每侧外扩量：抵消镂空抗锯齿边缘(~1px)漏算；外扩部分落在卡框不透明边框下被盖住（需求允许）
        const ov = this.artOverscan;
        const osL = ov, osR = ov, osT = ov, osB = ov;

        const aw = p.art ? p.art.rect.width : (innerW + osL + osR);
        const ah = p.art ? p.art.rect.height : (innerH + osT + osB);

        // 卡图目标矩形：宽=开窗+左右外扩，高=开窗+上下外扩（仅用于求缩放）
        const rectW = innerW + osL + osR;
        const rectH = innerH + osT + osB;
        let dw: number, dh: number;
        if (this.artFit === 2) { dw = rectW; dh = rectH; }                                  // 拉伸铺满
        else if (this.artFit === 1) { const s = Math.min(rectW / aw, rectH / ah); dw = aw * s; dh = ah * s; }  // 等比放入
        else { const s = Math.max(rectW / aw, rectH / ah); dw = aw * s; dh = ah * s; }       // 等比铺满（默认）

        // 底锚定：卡图底边贴在「镂空底边 + osB」(图像 y 向下)；水平居中对齐镂空中心。
        // 这样宽度/高度过填充的溢出一律向上进入不透明上边框（被盖住），
        // 右侧与底部抗锯齿带被卡图覆盖 → 镂空 100% 填满、绝不露底、绝不漏进卡框装饰镂空。
        const hollowCx = L.windowLeft + innerW / 2;     // 镂空中心 x（图像坐标）
        const ayBottom = (p.h - L.windowBottom) + osB;  // 卡图底边图像 y
        const axNode = hollowCx - p.w / 2;
        const ayNode = p.h / 2 - (ayBottom - dh / 2);

        const expected: string[] = ['CardImage', 'CardFrame', 'CardName'];

        // [0] 卡图 —— 底层，底锚定铺满开窗
        this.buildSprite(node, 'CardImage', 0, p.art, dw, dh, axNode, ayNode);

        // [1] 卡框 —— 顶层，铺满整张卡牌
        this.buildSprite(node, 'CardFrame', 1, p.frame, p.w, p.h, 0, 0);

        const info = p.info;

        // [2] 费用数字（suppressCost 时不生成，末尾清理会把残留的旧 CardCost 一并销毁）
        if (!suppressCost) {
            expected.push('CardCost');
            this.buildLabel(node, 'CardCost', 2, String(info.cost),
                this.costFontSize, this.costColor,
                L.costX + this.costOffsetX, L.costY + this.costOffsetY);
        }

        // [3] 卡名
        this.buildLabel(node, 'CardName', 3, info.cardName || '',
            this.nameFontSize, this.nameColor,
            L.nameX + this.nameOffsetX, L.nameY + this.nameOffsetY);

        // [4][5] 随从专属：血量 / 攻击
        if (info.cardType === 'Follower') {
            if (L.hpX !== undefined && L.hpY !== undefined) {
                expected.push('CardHp');
                this.buildLabel(node, 'CardHp', 4, fmtStat(info.hp),
                    this.hpFontSize, this.hpColor,
                    L.hpX + this.hpOffsetX, L.hpY + this.hpOffsetY);
                applyBattleValueOutline(node.getChildByName('CardHp')?.getComponent(Label) ?? null, false);
            }
            if (L.atkX !== undefined && L.atkY !== undefined) {
                expected.push('CardAttack');
                this.buildLabel(node, 'CardAttack', 5, fmtStat(info.attack, true),
                    this.atkFontSize, this.atkColor,
                    L.atkX + this.atkOffsetX, L.atkY + this.atkOffsetY);
                applyBattleValueOutline(node.getChildByName('CardAttack')?.getComponent(Label) ?? null, false);
            }
        }

        // 兜底遮罩（默认关闭）
        this.applyClip(node, this.clipArtToFrame);

        // 清掉本卡不需要的旧子节点（例如非随从残留的 CardHp）
        for (const ch of [...node.children]) {
            if (!expected.includes(ch.name)) killNode(ch);
        }
    }

    // ------------------------------ 工具方法 ------------------------------
    /** 销毁某父节点下不在 keep 名单里的卡牌节点（不碰非卡牌子节点） */
    private sweepCards(parent: Node, keep: string[]): void {
        for (const ch of [...parent.children]) {
            if (keep.indexOf(ch.name) >= 0) continue;
            if (!isComposedCard(ch)) continue;
            killNode(ch);
        }
    }

    /** 卡牌实际生成到哪个父节点：cardParent 优先；否则向上找「手牌区」(挂了 HandLayout 的祖先)；再否则本节点 */
    private resolvedParent(): Node {
        if (this.cardParent) return this.cardParent;
        let cur: Node | null = this.node;
        while (cur) {
            if (cur.getComponent('HandLayout')) return cur;
            cur = cur.parent;
        }
        return this.node;
    }

    /** 默认排布：所有卡牌水平等距、整体左右居中（手牌模式下不会走到这里） */
    private layoutHorizontally(names: string[]): void {
        const parent = this.resolvedParent();
        const nodes: Node[] = [];
        for (const nm of names) {
            const n = parent.getChildByName(nm);
            if (n) nodes.push(n);
        }
        if (nodes.length === 0) return;

        const widths = nodes.map((n) => {
            const ut = n.getComponent(UITransform);
            return (ut ? ut.contentSize.width : 0) * this.cardScale;
        });
        let total = 0;
        for (let i = 0; i < widths.length; i++) total += widths[i] + (i < widths.length - 1 ? this.spacing : 0);
        let cursor = -total / 2;
        nodes.forEach((n, i) => {
            const w = widths[i];
            const cx = cursor + w / 2;
            cursor += w + this.spacing;
            n.setPosition(cx, 0, 0);
            n.setSiblingIndex(i);
        });
    }

    /** 建/取一个 Sprite 子节点：CUSTOM 尺寸 + trim=true（节点矩形即贴图矩形） */
    private buildSprite(parent: Node, name: string, index: number, sf: SpriteFrame | null,
                        w: number, h: number, x: number, y: number): void {
        const n = this.ensureChild(parent, name, index);
        let sp = n.getComponent(Sprite);
        if (!sp) sp = n.addComponent(Sprite);
        sp.type = Sprite.Type.SIMPLE;
        sp.sizeMode = Sprite.SizeMode.CUSTOM;
        sp.trim = true;
        sp.spriteFrame = sf;

        const ut = n.getComponent(UITransform)!;
        ut.setAnchorPoint(0.5, 0.5);
        ut.setContentSize(w, h);
        n.setPosition(x, y, 0);
    }

    /** 建/取一个文字子节点：系统字体、加粗、居中、锚点 0.5（文字天然以节点位置为中心） */
    private buildLabel(parent: Node, name: string, index: number, text: string,
                       fontSize: number, color: Color, x: number, y: number): void {
        const n = this.ensureChild(parent, name, index);
        let lb = n.getComponent(Label);
        if (!lb) {
            lb = n.addComponent(Label);
            lb.useSystemFont = true;   // 不引字体资源，系统字体直接可用
        }
        lb.string = text;
        lb.fontSize = fontSize;
        lb.lineHeight = fontSize;
        lb.isBold = true;
        lb.horizontalAlign = Label.HorizontalAlign.CENTER;
        lb.verticalAlign = Label.VerticalAlign.CENTER;
        lb.overflow = Label.Overflow.NONE;
        lb.color = new Color(color.r, color.g, color.b, color.a);

        const ut = n.getComponent(UITransform)!;
        ut.setAnchorPoint(0.5, 0.5);
        ut.setContentSize(fontSize * 4, fontSize * 1.5);
        n.setPosition(x, y, 0);
    }

    /** 按需在卡节点上开关矩形遮罩 */
    private applyClip(node: Node, on: boolean): void {
        let mask = node.getComponent(Mask);
        if (on) {
            if (!mask) mask = node.addComponent(Mask);
            mask.type = Mask.Type.GRAPHICS_RECT;
            mask.enabled = true;
        } else if (mask && mask.enabled) {
            mask.enabled = false;
        }
    }

    /** 按名字建/取子节点，并放到指定层级 */
    private ensureChild(parent: Node, name: string, index: number): Node {
        let n = parent.getChildByName(name);
        // 🔴 只复用「仍然挂在父节点上且有效」的节点。destroy() 是延迟销毁（帧末才真正移除），
        //    若复用了一个已排队销毁的同名节点，帧末它照样会被摘掉 → 表现为「卡刚生成就消失」。
        if (n && (!n.isValid || n.parent !== parent)) n = null;
        if (!n) {
            n = new Node(name);
            n.setParent(parent);
        }
        if (!n.getComponent(UITransform)) n.addComponent(UITransform);
        n.setSiblingIndex(index);
        return n;
    }

    /** 脏检查 key：任一属性变化都会触发编辑器内重拼 */
    private dirtyKey(): string {
        const assetUuids = this.assets.map((a) => (a ? a.uuid : 'none')).join(',');
        const colors = [this.costColor, this.nameColor, this.hpColor, this.atkColor]
            .map((c) => `${c.r},${c.g},${c.b},${c.a}`).join(';');
        return [
            this.cardIds.join(','), this.copies,
            this.cardParent ? this.cardParent.uuid : 'auto',
            this.libSource ? this.libSource.uuid : 'no-libsource',
            this.assetNames.join(','), assetUuids,
            this.spacing, this.cardScale, this.artFit, this.clipArtToFrame ? 1 : 0, this.artOverscan,
            this.costFontSize, this.nameFontSize, this.hpFontSize, this.atkFontSize,
            colors,
            this.costOffsetX, this.costOffsetY, this.nameOffsetX, this.nameOffsetY,
            this.hpOffsetX, this.hpOffsetY, this.atkOffsetX, this.atkOffsetY,
        ].join('|');
    }
}

/** 单张卡的生成计划 */
interface CardPlan {
    id: string;
    info: CardInfo;
    /** 实际使用的卡框资源名（随从 = 手牌版 Hand<品质>Follower.png） */
    frameName: string;
    art: SpriteFrame | null;
    frame: SpriteFrame | null;
    layout: CardLayout;
    w: number;
    h: number;
}

/** 血量/攻击数字格式化：null → 空串（不渲染）；clampZero = true 时负值只显示 0。 */
function fmtStat(v: number | null, clampZero = false): string {
    if (v === null || v === undefined) return '';
    return clampZero ? formatBattleAttack(v) : formatBattleValue(v);
}

/**
 * 判断某节点是不是「本工厂拼出来的卡牌」。
 * 依据：卡牌节点名统一 Card_ 前缀（CardFactory 无下划线，不会误判），或含 CardFrame 子节点。
 */
export function isComposedCard(n: Node): boolean {
    if (/^Card_/.test(n.name)) return true;
    return !!n.getChildByName('CardFrame');
}

/**
 * 彻底干掉一个节点：**先脱离父节点再 destroy**。
 *
 * 为什么必须这样（踩过的坑）：`Node.destroy()` 是**延迟销毁** —— 它只给节点打上 Destroying 标记，
 * 真正从父节点摘除发生在**本帧末尾**。而卡牌生成走的是「按名字建/取子节点」（ensureChild）。
 * 于是当同一帧内发生两次重建（典型场景：`onLoad` 里刷一次，紧跟着 `onEnable` 又刷一次；
 * 编辑器里属性变更后的重绘也会再刷一次）时会出现：
 *   1) 第一次重建 → 生成 `Card_2.png`（记作 A）；
 *   2) 第二次重建 → 把 A 标记销毁（还没摘除）→ ensureChild 按名字又找到 A 并复用；
 *   3) 帧末 A 照旧被摘除 → 目标容器里**一张卡都没有**，而调用方手里还攥着 A 这个僵尸引用。
 * 表现为「脚本明明跑了、集合里也有牌，但节点一棵都不剩」，且脏检查值没变、再也不会重试。
 * 先 `removeFromParent()` 让名字查找立刻落空，ensureChild 就会老老实实新建节点。
 */
export function killNode(n: Node | null | undefined): void {
    if (!n || !n.isValid) return;
    n.removeFromParent();
    n.destroy();
}

/**
 * 释放 `node` 下的**全部子节点**（一次性特效收尾用）。
 *
 * 🔴 **宿主正在被停用 / 销毁时不能立刻 `killNode`**：引擎在父节点处于 Deactivating 期间会拒绝
 *    `removeFromParent`，并打一条 error
 *    （3821 "Cannot change hierarchy while activating or deactivating the parent"）。
 *    典型触发路径 = `onDisable → teardown`（卡牌离场 / 被销毁时必踩）。
 *    所以：**已激活**才立刻清；停用中则延到**下一帧**再清（届时要么已随宿主销毁、要么已重新激活）。
 *    延后只清「当时那批子节点」，且要求它们**仍是本节点的子节点** ⇒ 即使中间重建过也不会误杀新节点。
 */
export function releaseChildren(node: Node | null | undefined): void {
    if (!node || !node.isValid) return;
    const kids = [...node.children];
    if (kids.length === 0) return;
    if (node.activeInHierarchy) {
        for (const ch of kids) killNode(ch);
        return;
    }
    setTimeout(() => {
        if (!node || !node.isValid) return;
        for (const ch of kids) {
            if (ch && ch.isValid && ch.parent === node) killNode(ch);
        }
    }, 0);
}

/** HandLayout 的最小接口（只用到 refresh），用类名字符串查找以避免与 HandLayout.ts 形成循环 import */
interface HandLayoutLike extends Component {
    refresh(): void;
}

/** 在节点上找「手牌区」组件 HandLayout；没有或未启用返回 null */
function resolveHandLayout(node: Node): HandLayoutLike | null {
    const c = node.getComponent('HandLayout') as unknown as HandLayoutLike | null;
    return c && c.enabledInHierarchy ? c : null;
}

/** 从一个 SpriteFrame 上尽力推断其资源名（不同导入方式名字落点不同，多留几个候选） */
function candidateNames(sf: SpriteFrame): string[] {
    const out: string[] = [];
    const push = (v: unknown) => { if (typeof v === 'string' && v.length > 0 && out.indexOf(v) < 0) out.push(v); };
    const s = sf as unknown as Record<string, unknown>;
    push(s.name);
    push(s._name);
    const tex = (s.texture ?? s._texture) as Record<string, unknown> | undefined;
    if (tex) {
        push(tex.name);
        push(tex._name);
        const img = (tex.image ?? tex._image) as Record<string, unknown> | undefined;
        if (img) { push(img.name); push(img._name); }
    }
    return out;
}
