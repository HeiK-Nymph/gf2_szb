import {
    _decorator, Color, Component, EffectAsset, Material, Node, resources, Sprite, SpriteFrame,
    Tween, tween, UITransform, Vec4,
} from 'cc';
import { getCardInfo, CardQuality } from './CardData';

const { ccclass, property, requireComponent, menu } = _decorator;

/** 光晕特效子节点名（挂在卡牌根节点下，siblingIndex 恒为 0 = 卡牌最底层） */
export const GLOW_FX_NAME = 'CardGlowFx';

/** 光晕效果名（= 资源文件名去扩展名，EffectAsset 按它注册） */
export const GLOW_EFFECT_NAME = 'CardGlow';

/** 光晕效果在 resources 下的路径（打包后即使没有任何场景引用也不会被裁掉） */
export const GLOW_EFFECT_RES_PATH = 'effects/CardGlow';

/**
 * 光晕「留白」相对厚度的倍数：光晕方块的尺寸 = 卡框 + 2×padding，
 * padding = 厚度 × 本值。留一点余量，避免最强的光晕被方块边界切掉。
 */
const GLOW_PADDING_SCALE = 1.25;

/** 强度视为「0」的阈值：低于它就整块节点隐藏（零渲染开销） */
const INTENSITY_EPS = 1e-3;

/**
 * CardGlow —— 卡牌「外描边发光」（挂在卡牌根节点 Card_xxx / BF_xxx 上）
 * ===========================================================================
 * 需求：战场卡牌被按住选中时，在卡牌轮廓**外侧**生成一圈柔和的渐变光晕
 *       （参考《影之诗》选中卡牌时的橙火外圈）。
 *
 * 一、它是怎么画出来的（为什么能适配异形卡框、且绝不向内覆盖卡牌本体）
 *   本组件在卡牌根节点下自动建一个专用子节点 `CardGlowFx`：
 *     · 它不是「另画一圈描边」，而是**复用卡框贴图**，
 *       由 CardGlow.effect 对贴图的 alpha 轮廓做「环形加权扩散」——
 *       把卡框的不透明区域向外糊开一圈 → 矩形/异形卡框、装饰镂空全部自动适配；
 *     · 它的 contentSize = 卡框 + 四周 padding，纹理缩回中间（见 effect 里的 innerScale），
 *       因此卡框图案保持原尺寸，方块四周留出的空白就是光晕的扩散空间；
 *     · 它的 **siblingIndex 固定为 0（卡牌最底层）**：CardImage / CardFrame 之后绘制，
 *       天然把光晕的内侧盖住 —— 所以「光晕只向外」是**结构上保证**的，
 *       不依赖任何手工调参，也不可能在卡牌上画出一条内部描边；
 *     · 片元里再把「卡面自身不透明处」的光晕压掉（过渡区间落在卡面内部，外轮廓不衰减，
 *       所以不会出现暗环），双保险。
 *
 * 二、参数（全部在 Inspector 暴露）
 *   · 开关：enableGlow
 *   · 颜色：glowColor（useQualityColor 关闭时使用）+ 4 个品质色
 *     （按卡牌品质自动切换：铜=橙铜火 / 银=冰蓝 / 金=金黄火 / 传说=蓝紫光）
 *   · 厚度：glowThickness   光晕向外扩散的距离（卡框纹理像素）
 *   · 柔和度：glowSoftness  0 = 贴着轮廓的硬光；1 = 向外拖很长的软光
 *   · 强度：glowIntensity（当前值，可 tween）/ maxIntensity（按住时达到的目标值）
 *   · 节奏：fadeInDuration / fadeOutDuration
 *
 * 三、运行时 API（供战场交互脚本 / 出场上色用）
 *   · fadeIn(dur?)      从当前强度 tween 到 maxIntensity（按住时从 0 慢慢亮起就是它）
 *   · fadeOut(dur?)     从当前强度 tween 到 0
 *   · setIntensity(v)   直接设定（不想用内置节奏时，自己 tween glowIntensity 也行）
 *   · pulse(n, dur)     出场动画：0 → 峰值 → 0 来回 n 次
 *   · setGlowColor(c)   切换光晕颜色（橙火焰 / 蓝紫光…），并自动关掉品质取色
 *   · useQualityColorOn()  重新按品质自动取色
 *
 * 四、性能（UI 专用，网页平台可控）
 *   · 强度为 0 时**整块节点 active = false** → 不产生 DrawCall、不跑片元着色；
 *   · 一张卡一个独立 Material（互不干扰），效果本身共用同一份 shader 程序；
 *   · 贴图直接从卡框 Sprite 复用（不额外占显存），无 RenderTexture、无额外 Pass；
 *   · update() 只在**正在发光**时才做事，且参数无变化时一次 setProperty 都不发。
 *
 * 五、踩坑提醒（与本工程其它脚本一致）
 *   · `Node` **没有 setName()**，`name` 是普通属性 → `node.name = 'x'`；
 *   · 抛在 tween 回调里的异常会被 TweenSystem 吞掉（控制台看不到），
 *     因此本组件所有 tween 回调都套了 try/catch（见 safePush）；
 *   · CardComposer 重拼一张卡时会清掉「非预期子节点」（CardGlowFx 不在其白名单里），
 *     所以这里统一走 `ensureFx()`：**每次都确认节点/材质/几何还在**，缺什么补什么
 *     （update() 在发光期间也会调用它，因此「光晕节点被清掉」能自愈）。
 * ===========================================================================
 */
@ccclass('CardGlow')
@requireComponent(UITransform)
@menu('gf2szb/CardGlow')
export class CardGlow extends Component {

    // ====================== 开关 & 效果资源 ======================
    @property({ tooltip: '总开关：关闭后完全不发光（光晕节点会隐藏，零渲染开销）' })
    enableGlow = true;

    @property({
        type: EffectAsset,
        tooltip: '光晕效果（assets/resources/effects/CardGlow.effect）。\n'
            + '留空时自动按效果名 "CardGlow" 查找，找不到再从 resources 异步加载 → 一般不用手填。',
    })
    glowEffect: EffectAsset | null = null;

    // ====================== 颜色 ======================
    @property({ type: Color, tooltip: '光晕颜色（useQualityColor 关闭时使用它）。默认影之诗式橙红光晕' })
    glowColor = new Color(245, 122, 40, 255);

    @property({
        tooltip: '按卡牌品质自动取光晕颜色（见下面 4 个品质色）——卡牌品质来自 CardData 的 quality，\n'
            + '所以「改一处 quality，卡框与光晕颜色同时变」。关闭则一律用 glowColor。\n'
            + '默认**关闭**：战场选中态统一用影之诗式橙火（glowColor），需要分品质配色时再打开。',
    })
    useQualityColor = false;

    @property({ type: Color, tooltip: '铜(Bronze) · 光晕颜色：橙铜火' })
    bronzeGlowColor = new Color(255, 146, 66, 255);

    @property({ type: Color, tooltip: '银(Silver) · 光晕颜色：冰蓝' })
    silverGlowColor = new Color(150, 214, 255, 255);

    @property({ type: Color, tooltip: '金(Gold) · 光晕颜色：金黄火' })
    goldGlowColor = new Color(255, 202, 82, 255);

    @property({ type: Color, tooltip: '传说(Legendary) · 光晕颜色：蓝紫光' })
    legendaryGlowColor = new Color(170, 124, 255, 255);

    // ====================== 光晕形状 ======================
    @property({
        range: [0, 64, 0.5], slide: true,
        tooltip: '光晕厚度（卡框纹理像素）：光晕从卡牌轮廓向外扩散多远。\n'
            + '注意是「纹理像素」，实际屏幕大小会随卡牌缩放一起缩放（如 cardScale=0.6 → 屏幕上是 0.6 倍）。',
    })
    glowThickness = 40;

    @property({
        range: [0, 1, 0.01], slide: true,
        tooltip: '光晕柔和度：0 = 紧贴轮廓的硬边光（收得很干净）；1 = 向外拖得很长的软光。\n'
            + '（只影响渐变分布，不影响最远扩散距离——那是厚度管的。）',
    })
    glowSoftness = 0.7;

    // ====================== 强度 & 节奏 ======================
    @property({
        range: [0, 4, 0.01], slide: true,
        tooltip: '**当前**发光强度（0 = 不发光）。按住卡牌时从 0 慢慢亮起 tween 的就是它。\n'
            + '0 时整个光晕节点会隐藏 → 没有渲染开销。',
    })
    glowIntensity = 0;

    @property({
        range: [0, 4, 0.01], slide: true,
        tooltip: '按住 / 选中时达到的**目标**强度（fadeIn 的终点）。一般 1 ~ 2，越大越刺眼。',
    })
    maxIntensity = 2.4;

    @property({ range: [0, 2, 0.01], slide: true, tooltip: '淡入时长（秒）：强度 0 → maxIntensity' })
    fadeInDuration = 0.28;

    @property({ range: [0, 2, 0.01], slide: true, tooltip: '淡出时长（秒）：当前强度 → 0' })
    fadeOutDuration = 0.2;

    // ====================== 内部状态 ======================
    /** 光晕特效节点（卡牌根节点的第一个子节点） */
    private _fx: Node | null = null;
    private _fxSprite: Sprite | null = null;
    /** 本卡专属材质（每张卡一个 → 强度/颜色互不干扰） */
    private _mat: Material | null = null;
    /** 已解析到的效果资源 */
    private _effect: EffectAsset | null = null;
    /** 是否正在从 resources 异步加载效果（防重复发起） */
    private _loadingEffect = false;
    /** 效果未就绪时挂起的「淡入目标强度」；加载完成后自动续播（null = 无挂起） */
    private _pendingIntensity: number | null = null;
    /** 当前生效的光晕贴图（= 卡框 SpriteFrame），用于判断方块/几何是否过期 */
    private _frameSf: SpriteFrame | null = null;
    /** 当前方块四周留白（纹理像素）；-1 = 还没算过 */
    private _geomP = -1;
    /** 生成当前方块时，卡框 Sprite 所在节点的矩形（节点尺寸变了要重算方块）；-1 = 还没算过 */
    private _geomW = -1;
    private _geomH = -1;
    // —— 已推送到材质的参数快照（避免每帧重复 setProperty）——
    private _pushed = false;
    private _pThick = -1;
    private _pSoft = -1;
    private _pInt = -1;
    private _pR = -1;
    private _pG = -1;
    private _pB = -1;
    private _pA = -1;
    // —— 品质（从节点名反查 CardData 得到，onLoad 缓存）——
    private _quality: CardQuality | null = null;

    // ------------------------------ 生命周期 ------------------------------
    onLoad(): void {
        this.resolveQuality();
        // 🔑 预热：第一时间把光晕效果资源异步加载起来。
        //    若等到「按住卡牌」那一刻才发起加载，tweenTo 会因 ensureFx() 失败而放弃，
        //    玩家就要等下一次按住才能看到光晕（实测踩过：首次按下永远不亮）。
        this.resolveEffect();
    }

    onDisable(): void {
        // 组件被关掉时把正在跑的强度补间停掉，不留悬空状态
        Tween.stopAllByTarget(this);
        this.refreshActive();
    }

    onDestroy(): void {
        Tween.stopAllByTarget(this);
        if (this._mat) { this._mat.destroy(); this._mat = null; }
    }

    /**
     * 只在**正在发光**时做事（不发光时每帧只做 1 次数值比较）：
     *  · ensureFx() 会补齐「节点 / 材质 / 方块几何」，所以 CardComposer 重拼把
     *    CardGlowFx 清掉后能自愈重建，不会出现「按住没反应」的静默失败；
     *  · 编辑器里改 Inspector 的厚度/柔和度/颜色也会即时生效。
     */
    update(): void {
        if (!this.enableGlow || this.glowIntensity <= INTENSITY_EPS) return;
        if (!this.ensureFx()) return;
        this.pushIfChanged(false);
        this.refreshActive();
    }

    // ====================== 对外 API ======================
    /** 当前是否正在发光（开关打开 且 强度 > 0） */
    public get isGlowing(): boolean {
        return this.enableGlow && this.glowIntensity > INTENSITY_EPS;
    }

    /** 当前生效的光晕节点（null = 还没建出来）；供测试/排查 */
    public get fxNode(): Node | null {
        return this._fx;
    }

    /** 当前生效的材质（null = 还没建出来）；供测试/排查 */
    public get fxMaterial(): Material | null {
        return this._mat;
    }

    /** 本卡品质（从节点名 BF_<id> 反查 CardData；查不到为 null） */
    public get quality(): CardQuality | null {
        return this._quality;
    }

    /** 直接设定发光强度（**不走内置节奏**）。想自己 tween 的话直接 tween `glowIntensity` 也可以。 */
    public setIntensity(v: number): void {
        this.glowIntensity = Math.max(0, v);
        if (this.glowIntensity <= INTENSITY_EPS) {
            this._pendingIntensity = null;              // 直接归零 = 取消挂起的淡入
            this.refreshActive();                       // 归零：只关节点，不必再推材质
            return;
        }
        if (!this.ensureFx()) { this.refreshActive(); return; }
        this.pushIfChanged(false);
        this.refreshActive();
    }

    /**
     * 淡入到 `maxIntensity`（**从当前强度开始**，因此反复调用不会跳变）。
     * 「按住卡牌时从 0 慢慢亮起」= 在按下那一刻调用它。
     * @param duration 覆盖 fadeInDuration；不传则用 Inspector 上的值
     */
    public fadeIn(duration?: number): void {
        if (!this.enableGlow) return;
        this.tweenTo(this.maxIntensity, duration === undefined ? this.fadeInDuration : duration, 'quadOut');
    }

    /** 淡出到 0（松手时调用） */
    public fadeOut(duration?: number): void {
        this.tweenTo(0, duration === undefined ? this.fadeOutDuration : duration, 'quadIn');
    }

    /** 立刻熄灭（不播动画） */
    public glowOffImmediate(): void {
        Tween.stopAllByTarget(this);
        this.setIntensity(0);
    }

    /**
     * 出场动画：强度在 0 ↔ 峰值之间来回 `times` 次（末次停在峰值）。
     * 用于「这张卡入场时闪一下」这类表现。
     */
    public pulse(times = 1, duration = 0.3): void {
        if (!this.enableGlow) return;
        const n = Math.max(1, Math.floor(times));
        const d = Math.max(0.01, duration / 2);
        const peak = Math.max(0, this.maxIntensity);
        this.glowIntensity = 0;
        let t = tween(this);
        for (let i = 0; i < n; i++) {
            t = t.to(d, { glowIntensity: peak }, { easing: 'quadOut' });
            t = t.to(d, { glowIntensity: i === n - 1 ? peak : 0 }, { easing: 'quadIn' });
        }
        t.call(() => this.safePush()).start();
    }

    /** 指定一个光晕颜色（橙火焰 / 蓝紫光…），并**关掉**品质自动取色，使指定色稳定生效 */
    public setGlowColor(color: Color | Readonly<Color>): void {
        this.glowColor.set(color);
        this.useQualityColor = false;
        this.pushIfChanged(true);
    }

    /** 恢复「按品质自动取色」 */
    public useQualityColorOn(): void {
        this.useQualityColor = true;
        this.pushIfChanged(true);
    }

    /** 重新读一次品质（CardData 的 quality 改了之后调用；一般不需要手动调） */
    public refreshQuality(): void {
        this.resolveQuality();
        this.pushIfChanged(true);
    }

    // ------------------------------ 强度补间 ------------------------------
    /**
     * 把强度 tween 到 `to`。
     * 🔴 回调一律走 safePush（内部 try/catch）：抛在 tween 回调里的异常会被
     *    TweenSystem 吞掉（控制台看不到），出错后状态就再也回不来（见文件头 §五）。
     */
    private tweenTo(to: number, duration: number, easing: 'quadOut' | 'quadIn'): void {
        const target = Math.max(0, to);
        const from = this.glowIntensity;
        Tween.stopAllByTarget(this);
        if (target <= INTENSITY_EPS) this._pendingIntensity = null;   // 熄灭 = 取消挂起的淡入

        if (duration <= 0 || Math.abs(target - from) <= 1e-4) {
            this.setIntensity(target);
            return;
        }
        // 先把节点/材质准备好，避免补间第一帧才开始建材质（那会有一次卡顿）
        if (target > INTENSITY_EPS && !this.ensureFx()) {
            // 🔴 效果资源还没就绪（正在从 resources 异步加载）→ 不能就这么放弃：
            //    记下目标强度，等 requestEffect 加载完成后自动续播淡入（见 requestEffect）。
            //    否则「第一次按住永远不亮」，且 intensity=0 时 update() 早退，永远不会自愈。
            this._pendingIntensity = target;
            this.glowIntensity = 0;
            this.refreshActive();
            return;
        }
        tween(this)
            .to(duration, { glowIntensity: target }, {
                easing,
                onUpdate: () => this.safePush(),
            })
            .call(() => this.safePush())
            .start();
    }

    /** 把当前强度兜底刷进材质（出错只记日志，绝不让异常穿出 tween 回调） */
    private safePush(): void {
        try {
            if (this.glowIntensity > INTENSITY_EPS) {
                if (!this.ensureFx()) return;           // 内部已推送过一次
                this.pushIfChanged(false);
            }
            this.refreshActive();
        } catch (e) {
            console.error('[CardGlow] 刷新光晕参数时出错：', e);
        }
    }

    // ------------------------------ 光晕节点 / 材质 / 几何 ------------------------------
    /**
     * 确保「光晕节点 + 材质 + 方块几何」都在位；返回是否可用。
     * 幂等：已经正确时只做几次比较（几何未变不会重复 setContentSize）。
     */
    private ensureFx(): boolean {
        const frameSp = this.frameSprite();
        if (!frameSp) return false;                     // 卡还没拼好 / 卡框 Sprite 缺失
        const sf = frameSp.spriteFrame;
        if (!sf) return false;
        const mat = this.ensureMaterial();
        if (!mat) return false;                         // 效果资源还没就绪（异步加载中）

        let n = this._fx;
        if (!n || !n.isValid || n.parent !== this.node) {
            let found = this.node.getChildByName(GLOW_FX_NAME);
            // 🔴 只复用「仍然挂在卡牌节点上且有效」的同名节点：destroy 是延迟销毁，
            //    复用待销毁节点会在帧末被摘掉（与 CardComposer.ensureChild 同一个坑）。
            if (found && (!found.isValid || found.parent !== this.node)) found = null;
            if (!found) {
                found = new Node(GLOW_FX_NAME);
                found.setParent(this.node);
            }
            if (!found.getComponent(UITransform)) found.addComponent(UITransform);
            this._fx = found;
            this._fxSprite = found.getComponent(Sprite) ?? found.addComponent(Sprite);
            this._frameSf = null;                       // 新节点 → 强制走一次几何写入
            this._geomP = -1;
            this._geomW = -1;
            this._geomH = -1;
            this._pushed = false;
        }
        const sp = this._fxSprite;
        if (!sp) return false;

        const fut = frameSp.node.getComponent(UITransform);
        const fw = fut ? fut.contentSize.width : sf.rect.width;
        const fh = fut ? fut.contentSize.height : sf.rect.height;

        if (this.needsGeom(fw, fh)) this.applyGeometry(sp, sf, mat, fw, fh);
        this.pushIfChanged(false);                      // 几何写完后顺手把参数也同步过去（幂等）
        return true;
    }

    /** 方块几何是否需要重写（首次 / 卡框换了 / 厚度变了导致留白变了 / 卡框节点尺寸变了） */
    private needsGeom(fw: number, fh: number): boolean {
        if (this._frameSf === null) return true;
        if (this._geomP !== this.paddingPx(this._frameSf)) return true;
        return this._geomW !== fw || this._geomH !== fh;
    }

    /** 写入方块几何：尺寸 = 卡框**节点矩形**按 padding 比例放大；层序 = 卡牌最底层 */
    private applyGeometry(sp: Sprite, sf: SpriteFrame, mat: Material, fw: number, fh: number): void {
        const W = sf.rect.width;
        const H = sf.rect.height;
        const P = this.paddingPx(sf);

        sp.type = Sprite.Type.SIMPLE;
        sp.sizeMode = Sprite.SizeMode.CUSTOM;
        sp.trim = true;                                 // 节点矩形 = 贴图矩形（与 CardComposer 同口径）
        if (sp.spriteFrame !== sf) sp.spriteFrame = sf;  // 直接复用卡框贴图：不额外占显存
        if (sp.customMaterial !== mat) sp.customMaterial = mat;

        // 🔴 光晕方块以**卡框 Sprite 所在节点的矩形**为基准按 k 倍放大，而不是
        //    `rect + 2P`（后者单位是**纹理像素**，只在「节点矩形 == sf.rect」时才等价）：
        //    · 卡牌：CardFrame 节点 204×252 ↔ rect 204×252（实测完全相等）→ 两种算法**逐字等价**，
        //      所以战场光晕的表现一字不变；
        //    · 按钮类素材（如槽4 ExtraPP）：贴图 3312×999 铺进 197×64 的节点，
        //      若用 rect+2P 会把方块放大到 3500+ 像素（≈16.8 倍）→ 光晕直接飞出屏幕。
        //    k = (rect+2P)/rect 与 uniform `glowShape.zw = W/(W+2P)` (= 1/k) 是同一口径，
        //    因此只有「方块尺寸」换基准，扩散半径/贴图映射的数学完全不变。
        const ut = this._fx!.getComponent(UITransform)!;
        ut.setAnchorPoint(0.5, 0.5);
        ut.setContentSize(fw * (W + 2 * P) / W, fh * (H + 2 * P) / H);
        this._fx!.setPosition(0, 0, 0);
        // 🔑 放到卡牌**最底层**：CardImage / CardFrame 之后绘制 → 光晕内侧被卡牌盖住，
        //    于是「光晕只向外」成为结构保证，不可能在卡牌上画出内部描边。
        this._fx!.setSiblingIndex(0);

        this._frameSf = sf;
        this._geomP = P;
        this._geomW = fw;
        this._geomH = fh;
        this._pushed = false;
    }

    /** 本卡专属材质（每张卡一个，强度/颜色互不干扰；shader 程序仍是共用的） */
    private ensureMaterial(): Material | null {
        if (this._mat && this._mat.isValid) return this._mat;
        const eff = this.resolveEffect();
        if (!eff) return null;
        const m = new Material();
        m.initialize({ effectAsset: eff });
        this._mat = m;
        this._pushed = false;
        return m;
    }

    /**
     * 解析光晕效果资源，三级兜底：
     *   ① Inspector 上指定的 glowEffect；
     *   ② 已注册的效果名 'CardGlow'（编辑器预览 / 被场景引用过时走这条）；
     *   ③ 从 `resources/effects/CardGlow` 异步加载（打包后没有场景引用也不会被裁掉）。
     * ③ 是异步的：加载完成后重建材质并补上当前强度。
     */
    private resolveEffect(): EffectAsset | null {
        if (this._effect && this._effect.isValid) return this._effect;
        if (this.glowEffect && this.glowEffect.isValid) {
            this._effect = this.glowEffect;
            return this._effect;
        }
        const byName = EffectAsset.get(GLOW_EFFECT_NAME);
        if (byName) { this._effect = byName; return byName; }
        this.requestEffect();
        return null;
    }

    /** 从 resources 异步加载效果（只发起一次） */
    private requestEffect(): void {
        if (this._loadingEffect) return;
        this._loadingEffect = true;
        resources.load(GLOW_EFFECT_RES_PATH, EffectAsset, (err, asset) => {
            this._loadingEffect = false;
            if (err || !asset) {
                console.warn(`[CardGlow] 生成光晕失败：加载效果 "${GLOW_EFFECT_RES_PATH}" 出错 →`, err);
                return;
            }
            this._effect = asset;
            this._mat = null;                           // 丢掉之前建不出来的空材质
            this.safePush();                            // 立刻把当前强度/颜色补上去
            // 🔑 效果就绪前若有挂起的淡入（按下时资源还没加载完）→ 现在补播
            if (this._pendingIntensity !== null) {
                const to = this._pendingIntensity;
                this._pendingIntensity = null;
                this.tweenTo(to, this.fadeInDuration, 'quadOut');
            }
        });
    }

    /** 光晕节点是否应该可见（= 开关打开 且 强度 > 0） */
    private refreshActive(): void {
        const n = this._fx;
        const on = this.enableGlow && this.glowIntensity > INTENSITY_EPS;
        if (n && n.isValid && n.active !== on) n.active = on;
    }

    // ------------------------------ 参数推送 ------------------------------
    /**
     * 把「颜色 / 厚度 / 柔和度 / 强度」推给材质（**值没变则什么都不做**，无字符串、无分配）。
     * 用 8 个数值直接比较，避免每帧拼 key。
     */
    private pushIfChanged(force: boolean): void {
        const mat = this._mat;
        if (!mat || !mat.isValid) return;
        const c = this.resolveColor(_tmpColor);
        if (!force
            && this._pushed
            && this._pThick === this.glowThickness
            && this._pSoft === this.glowSoftness
            && this._pInt === this.glowIntensity
            && this._pR === c.r && this._pG === c.g && this._pB === c.b && this._pA === c.a) {
            return;
        }
        const P = this._geomP;
        const sf = this._frameSf;
        if (!sf || P < 0) return;

        // glowColor：Color → 归一化 Vec4。FLOAT4 uniform 的校验器同时接受 Color / Vec4，
        // 但 Color 的分量是 r/g/b/a（0..255），直接塞进去数值角度不对，这里显式归一化。
        mat.setProperty('glowColor', _c4.set(c.r / 255, c.g / 255, c.b / 255, c.a / 255));
        // glowParams：x = 厚度（纹理像素） y = 柔和度 0..1 z = 发光强度
        mat.setProperty('glowParams', _p4.set(this.glowThickness, this.glowSoftness, this.glowIntensity, 0));
        // glowShape：xy = 采样步长（1/rect宽, 1/rect高，「帧分数」单位）
        //            zw = innerScale（卡框本体占光晕方块的比例）——
        // 🔑 Sprite SIMPLE 会把整张卡框拉伸铺满方块，shader 必须用 innerScale 把
        //    「方块坐标 q」换算回「卡框帧分数 t0=(q-pad)/zw」，否则卡框被放大
        //    (W+2P)/W 倍，膨胀包络趋向方块形状 → 光晕变成圆角矩形描边（实测踩过）。
        const W = sf.rect.width;
        const H = sf.rect.height;
        mat.setProperty('glowShape', _s4.set(1 / W, 1 / H, W / (W + 2 * P), H / (H + 2 * P)));
        // glowUV：卡框 rect 在纹理 UV 空间的原点与尺寸。
        // 🔑 SpriteFrame 会被 trim（rect < 整图）甚至打进运行时动态图集（uv 只跨一个小子块，
        //    实测 2048 图集里 uv ∈ 0.09~0.20）——effect 采样前必须用这组值把「帧分数」
        //    映射回纹理 UV，否则会采到图集里隔壁的卡图，把光晕画成实心矩形色块。
        const uvArr = sf.uv;
        let uMin = 1, uMax = 0, vMin = 1, vMax = 0;
        for (let i = 0; i < 4; i++) {
            const u = uvArr[i * 2];
            const v = uvArr[i * 2 + 1];
            if (u < uMin) uMin = u;
            if (u > uMax) uMax = u;
            if (v < vMin) vMin = v;
            if (v > vMax) vMax = v;
        }
        mat.setProperty('glowUV', _uv4.set(uMin, vMin, uMax - uMin, vMax - vMin));

        this._pushed = true;
        this._pThick = this.glowThickness;
        this._pSoft = this.glowSoftness;
        this._pInt = this.glowIntensity;
        this._pR = c.r; this._pG = c.g; this._pB = c.b; this._pA = c.a;
    }

    /** 本次实际应使用的颜色：品质自动取色 或 指定的 glowColor */
    private resolveColor(out: Color): Color {
        if (this.useQualityColor && this._quality) {
            switch (this._quality) {
            case 'Bronze': return out.set(this.bronzeGlowColor);
            case 'Silver': return out.set(this.silverGlowColor);
            case 'Gold': return out.set(this.goldGlowColor);
            case 'Legendary': return out.set(this.legendaryGlowColor);
            default: break;
            }
        }
        return out.set(this.glowColor);
    }

    /** 光晕方块的四周留白（卡框纹理像素）；厚度不会超过卡框最长边 */
    private paddingPx(sf: SpriteFrame): number {
        const t = Math.max(0, Math.min(this.glowThickness, Math.max(sf.rect.width, sf.rect.height)));
        return Math.max(1, t * GLOW_PADDING_SCALE);
    }

    /**
     * 光晕的**贴图来源**（= 要被向外糊开一圈的轮廓）：
     *   ① 优先取 `CardFrame` 子节点的 Sprite（卡牌的标准结构：CardComposer 把卡框拼在这里）；
     *   ② 没有 `CardFrame` 时**退回本节点自身的 Sprite** —— 让本组件也能直接用在
     *      「按钮类节点」上（如 TurnControlPanel 的 ExtraPP 按钮，贴图就挂在节点自己身上）。
     * 🔑 退回自身是安全的：光晕方块是本节点的**子节点**，与本体用的是同一张贴图，
     *    几何按「卡框节点矩形 × k」反推（见 applyGeometry），所以轮廓照样贴得准。
     */
    private frameSprite(): Sprite | null {
        const n = this.node.getChildByName('CardFrame');
        if (n) {
            const sp = n.getComponent(Sprite);
            if (sp && sp.spriteFrame) return sp;
        }
        const self = this.node.getComponent(Sprite);
        return self && self.spriteFrame ? self : null;
    }

    /** 从节点名反查卡牌 id 并记住品质（卡框 Sprite 缺失时也照样能取到品质） */
    private resolveQuality(): void {
        const id = cardIdFromNodeName(this.node.name);
        const info = id ? getCardInfo(id) : undefined;
        this._quality = info ? info.quality : null;
    }
}

// ------------------------------ 模块内部工具 ------------------------------
/** 推送 uniform 用的暂存（同步使用，安全：setProperty 会立刻写入 pass 的 UBO） */
const _c4 = new Vec4();
const _p4 = new Vec4();
const _s4 = new Vec4();
const _uv4 = new Vec4();
const _tmpColor = new Color();

/**
 * 从战场卡牌节点名反查卡牌 id。
 * 战场卡命名规则：`BF_<id>`，同 id 第 2/3 份为 `BF_<id>_2/_3`（见 BattleFieldLayout.uniqueFieldName）。
 * 例：'BF_2.png' → '2.png'；'BF_2.png_2' → '2.png'；其它命名（如 CardPlay 的临时名）返回 ''。
 *
 * 说明：与 CardData「卡框由 quality + cardType 推导」保持同一思路 ——
 * 节点名是战场卡牌的**唯一约定**，光晕用它回查品质，不另立一套数据。
 */
export function cardIdFromNodeName(name: string): string {
    const m = /^BF_(.+?)(?:_\d+)?$/.exec(name);
    if (!m) return '';
    const raw = m[1];
    return /\.[a-z0-9]+$/i.test(raw) ? raw : (raw + '.png');
}
