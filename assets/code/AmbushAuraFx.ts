import {
    _decorator, Color, Component, Node, Sprite, SpriteFrame, UITransform, resources,
} from 'cc';
import { killNode, releaseChildren } from './CardComposer';

const { ccclass, menu } = _decorator;

/**
 * AmbushAuraFx —— 「潜行」随从的**黑白烟雾**特效
 * ===========================================================================
 * 参考示例图：随从被一团黑白烟雾笼罩（隐约能看到卡面），
 * **但攻击 / 血量图标必须清晰可见**。
 *
 * 🔴 需求红线：
 *   1. 黑白烟雾「缭绕」（持续形变 + 缓慢旋转），不是静态贴图；
 *   2. **绝不遮挡攻击 / 血量图标** —— 见下面 `applyStatic()`：烟雾插在 `CardFrame` **之前**，
 *      而卡框（攻击/血量徽记画在框上）、卡名、两个数字节点都在其之上 ⇒ 渲染顺序保证图标清晰；
 *   3. 烟雾**不做加色混合**（加色只能变亮，做不出黑烟）⇒ 用默认的普通 alpha 混合 + 节点色染色：
 *      · 染成近黑 = 把卡片**压暗**（黑烟本体）；
 *      · 染成白 = 叠一层白雾（亮部）。
 *
 * 素材管线（`assets/resources/effects/Ambush/`）：
 *   源图 `smoke_01..10.png` 是 512×512 **调色板 PNG、无 alpha**（黑底 + 灰度烟雾，亮度 = 浓度）。
 *   预处理脚本 `.workbuddy/tmp/ambush_preprocess.js`：
 *     · 只取观感好的 8 帧（03 太稀碎、09 与 10 重复 → 源文件已按需求删除）；
 *     · 亮度域 2×2 降采样到 256×256；
 *     · 写 RGBA：**RGB = 纯白、A = (亮度/全局峰值)^0.8** ⇒ 白 RGB 才能被节点色染成黑/白。
 *   产物 `AmbushSmoke_01..08.png`（自带 `@f9941` spriteFrame，无需再改 meta）。
 *
 * 分层（3 层，各层**错开帧号 + 反向/差速旋转**，叠出「缭绕」感）：
 *   层 0 外层黑烟：最大、最暗、慢速正转
 *   层 1 内层黑烟：中等、稍亮、反向转
 *   层 2 白雾：略小、快速转 → 与黑层交错出黑白丝缕
 * 帧动画：相邻帧**交叉淡入淡出**（两帧权重和恒为 1），低帧率下也是「缓慢形变」而不是「跳变」。
 */

/** 烟雾贴图的原图边长（8 帧都是 256×256；用于把 trim 偏移换算成节点位移） */
const RAW_SIZE = 256;

/** 烟雾子节点名（运行时挂在卡牌下） */
export const AMBUSH_AURA_NODE = 'AmbushAura';

/** 8 帧贴图在 resources 下的路径（**子资源要带 `/spriteFrame`**），按播放顺序 */
export const AMBUSH_TEX_RES_PATHS: readonly string[] = [
    'effects/Ambush/AmbushSmoke_01/spriteFrame',
    'effects/Ambush/AmbushSmoke_02/spriteFrame',
    'effects/Ambush/AmbushSmoke_03/spriteFrame',
    'effects/Ambush/AmbushSmoke_04/spriteFrame',
    'effects/Ambush/AmbushSmoke_05/spriteFrame',
    'effects/Ambush/AmbushSmoke_06/spriteFrame',
    'effects/Ambush/AmbushSmoke_07/spriteFrame',
    'effects/Ambush/AmbushSmoke_08/spriteFrame',
];

/** 单层外观配置 */
export interface AmbushLayerConfig {
    /** 染色（近黑 = 黑烟压暗卡片；白 = 白雾） */
    color?: Color;
    /** 该层最大透明度 */
    alpha?: number;
    /** 相对基础尺寸的缩放 */
    scale?: number;
    /** 旋转速度（度/秒；正 = 顺时针。符号相反的两层叠出交织感） */
    spin?: number;
}

/** 潜行烟雾配置（由 CardKeywordSystem 的 Inspector 属性组装） */
export interface AmbushAuraConfig {
    /** 基础高度 = 卡牌显示高度 × 本值 */
    scale?: number;
    /** X 偏移（按卡宽比例；正 = 右移） */
    offsetX?: number;
    /** Y 偏移（按卡高比例；正 = 上移） */
    offsetY?: number;
    /** **一次周期时长**（秒）：序列帧走完一整轮（8 帧循环）的时间。越小翻涌越快。 */
    cycleSeconds?: number;
    /** 相邻帧交叉淡入淡出（关 = 直接切帧） */
    crossFade?: boolean;
    /** 轻微「呼吸」缩放幅度（0 = 不呼吸） */
    breathe?: number;
    /** 呼吸周期（秒） */
    breathePeriod?: number;
    /** 层 0 外层黑烟 */
    dark?: AmbushLayerConfig;
    /** 层 1 内层黑烟 */
    dark2?: AmbushLayerConfig;
    /** 层 2 白雾 */
    white?: AmbushLayerConfig;
}

// ============================================================================
// 模块级资源缓存（所有潜行随从共用 8 张贴图）
// ============================================================================
const _sfs: (SpriteFrame | null)[] = AMBUSH_TEX_RES_PATHS.map(() => null);
let _loading = false;
let _warned = false;

export function ambushAssetsReady(): boolean {
    return _sfs.every((s) => !!s && s.isValid);
}

/** 预加载潜行烟雾素材（幂等；建议在 CardKeywordSystem.onLoad 调一次） */
export function preloadAmbushAssets(): void {
    if (ambushAssetsReady() || _loading) return;
    _loading = true;
    let remain = AMBUSH_TEX_RES_PATHS.length;
    AMBUSH_TEX_RES_PATHS.forEach((p, i) => {
        resources.load(p, SpriteFrame, (err, sf) => {
            if (err || !sf) {
                if (!_warned) {
                    _warned = true;
                    console.warn(`[AmbushAuraFx] 加载烟雾贴图失败："${p}"`, err);
                }
            } else {
                _sfs[i] = sf;
            }
            if (--remain <= 0) _loading = false;
        });
    });
}

/** 在卡牌上挂（或复用）潜行烟雾；素材未就绪时返回 null（下一次扫描会补上）。 */
export function ensureAmbushAura(card: Node | null, cfg: AmbushAuraConfig): AmbushAuraFx | null {
    if (!card || !card.isValid) return null;
    if (!ambushAssetsReady()) { preloadAmbushAssets(); return null; }
    let node = card.getChildByName(AMBUSH_AURA_NODE);
    if (!node) {
        node = new Node(AMBUSH_AURA_NODE);
        node.setParent(card);
        node.addComponent(UITransform);
    }
    const fx = node.getComponent(AmbushAuraFx) || node.addComponent(AmbushAuraFx);
    fx.applyConfig(cfg);
    fx.refresh();
    return fx;
}

/** 移除卡牌上的潜行烟雾（没有则无害）。 */
export function removeAmbushAura(card: Node | null): void {
    if (!card || !card.isValid) return;
    const node = card.getChildByName(AMBUSH_AURA_NODE);
    if (node) killNode(node);
}

/** 该卡当前是否挂着潜行烟雾。 */
export function hasAmbushAura(card: Node | null): boolean {
    return !!card && card.isValid && !!card.getChildByName(AMBUSH_AURA_NODE);
}

// ============================================================================
// 组件：3 层错帧 + 交叉淡入淡出 + 差速旋转
// ============================================================================
interface AmbushLayer {
    /** 旋转载体（帧 sprite 挂它下面，只转它） */
    holder: Node;
    /** [0] = 当前帧；crossFade 时 [1] = 下一帧（淡入用） */
    sprites: Sprite[];
    cfg: Required<AmbushLayerConfig>;
    /** 该层的帧号偏移（错开各层帧号，避免三层同帧） */
    frameOffset: number;
    k: number;
}

@ccclass('AmbushAuraFx')
@menu('gf2szb/AmbushAuraFx')
export class AmbushAuraFx extends Component {

    // —— 本实例当前生效值；真正在 Inspector 调的是 CardKeywordSystem 上的同名属性 ——
    scale = 1.3;
    offsetX = 0;
    offsetY = 0;
    /** 一次周期时长（秒）＝ 序列帧走完一整轮的时间（8 帧循环）。 */
    cycleSeconds = 1.33;
    crossFade = true;
    breathe = 0.05;
    breathePeriod = 4.2;
    dark: Required<AmbushLayerConfig> = {
        color: new Color(10, 10, 16, 255), alpha: 0.94, scale: 1.16, spin: 7,
    };
    dark2: Required<AmbushLayerConfig> = {
        color: new Color(26, 26, 34, 255), alpha: 0.82, scale: 0.98, spin: -13,
    };
    white: Required<AmbushLayerConfig> = {
        color: new Color(232, 238, 248, 255), alpha: 0.24, scale: 0.92, spin: 26,
    };

    private _layers: AmbushLayer[] = [];
    private _baseW = 0;
    private _baseH = 0;
    private _t = 0;
    private _built = false;
    private _sig = '';

    // ------------------------------ 生命周期 ------------------------------
    onEnable(): void {
        this.refresh();
    }

    onDisable(): void {
        this.teardown();
    }

    onDestroy(): void {
        this.teardown();
    }

    /** 下发 Inspector 配置。 */
    public applyConfig(cfg: AmbushAuraConfig): void {
        if (typeof cfg.scale === 'number') this.scale = cfg.scale;
        if (typeof cfg.offsetX === 'number') this.offsetX = cfg.offsetX;
        if (typeof cfg.offsetY === 'number') this.offsetY = cfg.offsetY;
        if (typeof cfg.cycleSeconds === 'number') this.cycleSeconds = Math.max(0.1, cfg.cycleSeconds);
        if (typeof cfg.crossFade === 'boolean') this.crossFade = cfg.crossFade;
        if (typeof cfg.breathe === 'number') this.breathe = Math.max(0, cfg.breathe);
        if (typeof cfg.breathePeriod === 'number') this.breathePeriod = Math.max(0.2, cfg.breathePeriod);
        this.dark = mergeLayer(this.dark, cfg.dark);
        this.dark2 = mergeLayer(this.dark2, cfg.dark2);
        this.white = mergeLayer(this.white, cfg.white);
    }

    /** 依据宿主卡牌尺寸重建 / 刷新（尺寸或外观参数变化时重建）。 */
    public refresh(): void {
        const host = this.node.parent;
        if (!host || !host.isValid) return;
        if (!ambushAssetsReady()) { preloadAmbushAssets(); return; }

        const hut = host.getComponent(UITransform);
        const cw = hut ? hut.contentSize.width : 204;
        const ch = hut ? hut.contentSize.height : 252;

        // 🔴 素材是 256×256 正方形 ⇒ 这里**固定按 1:1**，不要用 `sf.rect` 推宽高比：
        //    Cocos 会按 alpha 自动 trim，而 8 帧的 trim 矩形差异很大（180×189 ~ 228×230），
        //    拿某一帧的 rect 当基准会让各帧被拉伸成不同比例。
        //    各帧的**自然尺寸与对齐**改由 `update()` 里按 rect/raw + trim offset 逐帧还原。
        const aspect = 1;

        const baseH = Math.max(40, ch * this.scale);
        const baseW = baseH * aspect;

        const sig = [
            Math.round(baseW), Math.round(baseH),
            this.dark.alpha, this.dark.scale, this.dark.spin,
            this.dark2.alpha, this.dark2.scale, this.dark2.spin,
            this.white.alpha, this.white.scale, this.white.spin,
            this.dark.color.r, this.dark.color.g, this.dark.color.b,
            this.dark2.color.r, this.dark2.color.g, this.dark2.color.b,
            this.white.color.r, this.white.color.g, this.white.color.b,
        ].join(',');

        if (sig === this._sig && this._built) {
            this.applyStatic();
            return;
        }
        this._sig = sig;
        this._baseW = baseW;
        this._baseH = baseH;
        this.build();
    }

    // ------------------------------ 内部 ------------------------------
    private build(): void {
        this.teardown();
        this._built = true;

        const defs: Required<AmbushLayerConfig>[] = [this.dark, this.dark2, this.white];
        // 各层错开帧号：外层 0、内层 +3、白雾 +5（8 帧循环下三层永不同帧）
        const offsets = [0, 3, 5];
        for (let i = 0; i < defs.length; i++) {
            const cfg = defs[i];
            const holder = new Node('Ambush_' + i);
            holder.setParent(this.node);
            holder.addComponent(UITransform);
            const sprites: Sprite[] = [];
            // 每层两张 sprite：A = 当前帧，B = 下一帧（交叉淡入淡出用）
            for (let j = 0; j < 2; j++) {
                const n = new Node('Frame_' + j);
                n.setParent(holder);
                const tn = n.addComponent(UITransform);
                const sp = n.addComponent(Sprite);
                // 🔴 默认 TRIMMED 会按裁剪后的 frame 尺寸改写 contentSize ⇒ 必须 CUSTOM
                sp.sizeMode = Sprite.SizeMode.CUSTOM;
                sp.spriteFrame = _sfs[0];
                const c = new Color(cfg.color);
                c.a = 0;
                sp.color = c;
                tn.setContentSize(this._baseW * cfg.scale, this._baseH * cfg.scale);
                sprites.push(sp);
            }
            this._layers.push({
                holder, sprites, cfg: { ...cfg, color: new Color(cfg.color) },
                frameOffset: offsets[i] || 0, k: cfg.scale,
            });
        }
        this.applyStatic();
        this.update(0);
    }

    /**
     * 位置 / 层级。
     *
     * 🔴 层级（需求红线：**不遮挡攻击 / 血量图标**）：
     *   卡牌子节点顺序是 `CardImage(卡面) → CardFrame(卡框，攻击/血量徽记画在框上) → CardName →
     *   CardHp(血量数字) → CardAttack(攻击数字)`，而**卡框中心是全透明的**（实测中心 alpha=0）。
     *   所以把烟雾插在 `CardFrame` **之前**：
     *     · 卡面（CardImage）在烟雾之下 → 被烟雾笼罩（= 潜行"藏起来"）；
     *     · 卡框 / 攻击·血量徽记 / 卡名 / 两个数字**全部**在烟雾之上 → 永远清晰可见；
     *     · 烟雾溢出卡框的部分没有任何东西遮挡 → 仍能看到"烟雾缭绕"。
     *   锚点优先级：CardFrame → CardHp → CardAttack（任一缺失就退到下一个）。
     */
    private applyStatic(): void {
        const host = this.node.parent;
        if (!host || !host.isValid) return;
        // 🔴 卡牌正在被**停用**（离场 / 破坏演出中）时**不要动层级**：引擎在父节点 `Deactivating`
        //    期间会拒绝 `setSiblingIndex` 并打一条 error（"Cannot change hierarchy while activating
        //    or deactivating the parent"）。卡都要走了，层级也不需要再纠正。
        if (!host.active) return;
        const hut = host.getComponent(UITransform);
        const cw = hut ? hut.contentSize.width : 0;
        const ch = hut ? hut.contentSize.height : 0;
        const ox = hut ? (0.5 - hut.anchorX) * cw : 0;
        const oy = hut ? (0.5 - hut.anchorY) * ch : 0;
        this.node.setPosition(ox + cw * this.offsetX, oy + ch * this.offsetY, 0);

        const anchor = host.getChildByName('CardFrame')
            || host.getChildByName('CardHp')
            || host.getChildByName('CardAttack');
        if (!anchor || anchor === this.node) return;
        // 🔴 自校正：卡牌被**重新合成**（子节点重建，如进化换卡框）时烟雾节点可能被挤到锚点之后，
        //    这里复核「我是否已经在锚点之前」，不是就再插一次。
        //    插完再复核一次：**没生效**说明引擎拒绝了（父节点正在激活/停用）→ 立刻收手，等下一帧，
        //    否则会连刷 3 条引擎 error 日志。
        for (let i = 0; i < 3; i++) {
            const me = this.node.getSiblingIndex();
            const ai = anchor.getSiblingIndex();
            if (me < ai) break;
            this.node.setSiblingIndex(Math.max(0, ai));
            if (this.node.getSiblingIndex() >= anchor.getSiblingIndex()) break;
        }
    }

    private teardown(): void {
        this._layers.length = 0;
        this._built = false;
        // 收尾统一走 `releaseChildren`：宿主正在被停用 / 销毁时它会**延后一帧**再清，
        // 避免引擎 3821（Deactivating 期间拒绝改层级）—— 见 CardComposer.releaseChildren。
        releaseChildren(this.node);
    }

    update(dt: number): void {
        if (!this._built || this._layers.length === 0) return;
        const d = Math.min(Math.max(dt, 0), 0.1);          // 掉帧时别让烟雾瞬移
        this._t += d;

        const n = _sfs.length;
        // 呼吸：整体轻微缩放 + 白雾透明度摆动（只改数值，不做补间）
        const period = Math.max(0.2, this.breathePeriod);
        const ph = (this._t / period) * Math.PI * 2;
        const breatheK = 1 + this.breathe * Math.sin(ph);

        const framePos = (this._t / Math.max(0.1, this.cycleSeconds)) * n;
        for (let i = 0; i < this._layers.length; i++) {
            const L = this._layers[i];
            if (!L.holder || !L.holder.isValid) continue;
            L.holder.angle = (L.holder.angle + L.cfg.spin * d) % 360;
            const k = L.k * breatheK;

            const pos = framePos + L.frameOffset;
            const idx = Math.floor(pos) % n;
            const frac = this.crossFade ? (pos - Math.floor(pos)) : 0;
            const aIdx = ((idx % n) + n) % n;
            const bIdx = ((idx + 1) % n + n) % n;
            const aA = 1 - frac;
            const aB = frac;
            // 白雾额外做亮度摆动（黑烟不动，避免整体忽明忽暗）
            const peak = L.cfg.alpha * (i === 2 ? (0.75 + 0.25 * Math.sin(ph + Math.PI / 2)) : 1);
            const parts = [
                { sp: L.sprites[0], sf: _sfs[aIdx], w: aA },
                { sp: L.sprites[1], sf: _sfs[bIdx], w: aB },
            ];
            // 每「原图像素」在本层里的尺寸（用于把 trim 偏移换算成节点位移）
            const scx = (this._baseW * k) / RAW_SIZE;
            const scy = (this._baseH * k) / RAW_SIZE;
            for (const pt of parts) {
                const sp = pt.sp;
                if (!sp || !sp.isValid) continue;
                if (pt.sf && pt.sf.isValid && sp.spriteFrame !== pt.sf) sp.spriteFrame = pt.sf;
                const c = L.cfg.color;
                sp.color = new Color(c.r, c.g, c.b, Math.round(255 * peak * pt.w));
                const tn = sp.node.getComponent(UITransform);
                if (!tn) continue;
                // 🔴 逐帧还原「自然尺寸 + 原始对齐」：CUSTOM 模式会把 **trim 后的内容**拉伸铺满节点，
                //    而各帧 trim 矩形不同 ⇒ 不补偿的话烟雾会随帧忽大忽小、位置漂移。
                //    节点尺寸 = 基础尺寸 × (trim 尺寸 / 原图尺寸)；再按 trim 偏移把中心挪回原图里的位置。
                const sf = pt.sf;
                const r = sf ? sf.rect : null;
                const ow = sf ? Math.max(1, sf.originalSize.width) : RAW_SIZE;
                const oh = sf ? Math.max(1, sf.originalSize.height) : RAW_SIZE;
                tn.setContentSize(
                    this._baseW * k * (r ? r.width / ow : 1),
                    this._baseH * k * (r ? r.height / oh : 1),
                );
                const off = sf ? sf.offset : null;
                sp.node.setPosition(off ? off.x * scx : 0, off ? off.y * scy : 0, 0);
            }
        }
    }
}

/** 把（可选的）层配置合并到当前值上；未提供的字段保持原样。 */
function mergeLayer(
    base: Required<AmbushLayerConfig>, patch?: AmbushLayerConfig,
): Required<AmbushLayerConfig> {
    const out: Required<AmbushLayerConfig> = {
        color: new Color(base.color),
        alpha: base.alpha,
        scale: base.scale,
        spin: base.spin,
    };
    if (!patch) return out;
    if (patch.color) out.color = new Color(patch.color);
    if (typeof patch.alpha === 'number') out.alpha = Math.max(0, patch.alpha);
    if (typeof patch.scale === 'number') out.scale = Math.max(0.05, patch.scale);
    if (typeof patch.spin === 'number') out.spin = patch.spin;
    return out;
}
