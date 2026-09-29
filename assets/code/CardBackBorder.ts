import {
    _decorator, Color, Component, EffectAsset, isValid, Material, Node, resources, Sprite, SpriteFrame,
    UITransform, Vec4,
} from 'cc';

const { ccclass, property, menu } = _decorator;

/** 卡背 Sprite 子节点名（EnemyHandLayout 生成的 EnemyCard_* 根节点下的卡背贴图节点） */
export const CARD_BACK_CHILD_NAME = 'CardBack';

/** 描边覆盖层子节点名（本组件自动创建，永远画在卡背贴图上方） */
export const BORDER_OUTLINE_NAME = 'BorderOutline';

/** 描边效果名（= 资源文件名去扩展名，EffectAsset 按它注册） */
export const BORDER_EFFECT_NAME = 'CardBackOutline';

/** 描边效果在 resources 下的路径（打包后即使没有场景引用也不会被裁掉） */
export const BORDER_EFFECT_RES_PATH = 'effects/CardBackOutline';

/**
 * CardBackBorder —— 卡背金色描边（全局统一的卡背分隔线，挂在使用卡背的节点上）
 * ===========================================================================
 * 需求背景：多张卡背（CardBack.png）横向叠在一起时没有边缘分隔，分不清张数。
 * 解决：每张卡背的贴图上方叠一层**细描边**（只渲染卡牌轮廓最外圈，内部透明），
 *       互相重叠也各自有完整轮廓线。**不修改卡背原图资源** —— 描边是独立覆盖层。
 *
 * 一、节点结构（自动维护，缺什么补什么）
 *   本组件挂在「卡背宿主节点」上，自动创建一个 `BorderOutline` 子节点：
 *     · 宿主 = 根节点（如 EnemyHandArea/EnemyCard_1.png）
 *       └── CardBack        ← 卡背 Sprite（本组件自动找到它）
 *       └── BorderOutline   ← 描边层（本组件创建，排在 CardBack 之后 = 画在其上方）
 *     · 宿主自身带 Sprite（如 CardDraw 的工作卡背 _drawBack）
 *       └── (自身 Sprite = 卡背)
 *       └── BorderOutline   ← 描边层（子节点天然画在父节点 Sprite 上方）
 *   BorderOutline 复用同一张卡背 SpriteFrame + CardBackOutline 自定义材质，
 *   由 shader 只输出「轮廓最外圈」的描边像素；缩放交给宿主节点 → **描边跟着卡背一起缩放**。
 *
 * 二、卡背 Sprite 的查找顺序
 *   ① 名为 `CardBack` 的子节点上的 Sprite（EnemyHandLayout 生成的结构）；
 *   ② 宿主节点自身的 Sprite（CardDraw._drawBack 等自绘结构）。
 *
 * 三、参数（Inspector 暴露，运行时可改，即时生效）
 *   · showBorder      总开关（关 = 隐藏描边层，零渲染开销）
 *   · borderColor     描边颜色（默认金色 #E8C878）
 *   · borderThickness 描边粗细（卡背纹理像素，默认 2 = 细线）
 *
 * 四、踩坑提醒（与 CardGlow 同一套结论）
 *   · SpriteFrame 可能被 trim / 打进运行时动态图集（uv 只跨小子块）→
 *     shader 采样必须走 outlineUV 仿射映射（由本组件从 sf.uv 算好推给材质）；
 *   · 尺寸一律用 sf.rect（帧自身像素）—— sf.width/height 返回的是**所在纹理**
 *     的尺寸，卡背被打包后是 2048（CardDraw 巨型卡背 bug 的根因）；
 *   · 复用节点必须严格 isValid(n, true)（destroy 是延迟销毁）。
 * ===========================================================================
 */
@ccclass('CardBackBorder')
@menu('gf2szb/CardBackBorder')
export class CardBackBorder extends Component {

    // ====================== 参数（Inspector 暴露）======================
    @property({ tooltip: '总开关：关闭后隐藏描边层（不产生 DrawCall）' })
    showBorder = true;

    @property({ type: Color, tooltip: '描边颜色。默认金色 #E8C878' })
    borderColor = new Color(232, 200, 120, 255);

    @property({
        range: [0.5, 8, 0.1], slide: true,
        tooltip: '描边粗细（卡背纹理像素）。实际屏幕粗细随卡背缩放一起缩放。\n默认 2 = 细线（需求：只要轮廓分隔线，不要粗边框）。',
    })
    borderThickness = 2;

    // ------------------------------ 内部状态 ------------------------------
    /** 描边覆盖层节点（宿主的子节点，画在卡背贴图上方） */
    private _fx: Node | null = null;
    private _fxSprite: Sprite | null = null;
    /** 描边层当前用的 SpriteFrame（变化时重推参数/几何） */
    private _frameSf: SpriteFrame | null = null;
    /** 本节点专属材质（颜色/粗细互不干扰；shader 程序共用） */
    private _mat: Material | null = null;
    private _effect: EffectAsset | null = null;
    private _loadingEffect = false;
    // —— 已推送参数快照（避免每帧 setProperty）——
    private _pushed = false;
    private _pThick = -1;
    private _pR = -1;
    private _pG = -1;
    private _pB = -1;
    private _pA = -1;

    // ------------------------------ 生命周期 ------------------------------
    onLoad(): void {
        // 预热：第一时间把效果资源加载起来（异步加载完成前 update 里 ensureFx 会安静返回）
        this.resolveEffect();
    }

    onDestroy(): void {
        if (this._mat) { this._mat.destroy(); this._mat = null; }
    }

    update(): void {
        if (!this.showBorder) {
            this.refreshActive();
            return;
        }
        if (!this.ensureFx()) return;
        this.pushIfChanged(false);
        this.refreshActive();
    }

    // ------------------------------ 对外 API ------------------------------
    /** 一次性设置样式（供 EnemyHandLayout 等批量管理方同步参数用） */
    public applyStyle(show: boolean, color: Color | Readonly<Color>, thickness: number): void {
        this.showBorder = show;
        this.borderColor.set(color);
        this.borderThickness = Math.max(0.5, thickness);
    }

    /** 描边层节点（null = 还没建出来）；供测试/排查 */
    public get fxNode(): Node | null {
        return this._fx;
    }

    // ------------------------------ 描边层 / 材质 ------------------------------
    /**
     * 确保「描边节点 + 材质 + 几何」都在位；返回是否可用。
     * 幂等：已正确时只做几次比较。被清掉（如父级重建）后能自愈重建。
     */
    private ensureFx(): boolean {
        const backSp = this.backSprite();
        if (!backSp) return false;                          // 卡背 Sprite 还没就绪
        const sf = backSp.spriteFrame;
        if (!sf) return false;
        const mat = this.ensureMaterial();
        if (!mat) return false;                             // 效果资源异步加载中

        let n = this._fx;
        if (!n || !n.isValid || n.parent !== this.node) {
            let found = this.node.getChildByName(BORDER_OUTLINE_NAME);
            // 🔴 只复用仍挂在本节点下且有效的同名节点（destroy 是延迟销毁）
            if (found && (!found.isValid || found.parent !== this.node)) found = null;
            if (!found) {
                found = new Node(BORDER_OUTLINE_NAME);
                found.setParent(this.node);
            }
            if (!found.getComponent(UITransform)) found.addComponent(UITransform);
            this._fx = found;
            this._fxSprite = found.getComponent(Sprite) ?? found.addComponent(Sprite);
            this._frameSf = null;
            this._pushed = false;
        }
        const sp = this._fxSprite;
        if (!sp) return false;

        // 几何：尺寸 = 卡背 rect（帧自身像素）；锚点居中、归零，与卡背贴图对齐。
        // 缩放不在这里做 —— 描边层跟随宿主节点缩放（需求：边框跟着卡牌一起缩放）。
        if (this._frameSf !== sf) {
            sp.type = Sprite.Type.SIMPLE;
            sp.sizeMode = Sprite.SizeMode.CUSTOM;
            sp.trim = false;
            if (sp.spriteFrame !== sf) sp.spriteFrame = sf;
            if (sp.customMaterial !== mat) sp.customMaterial = mat;
            const ut = this._fx!.getComponent(UITransform)!;
            ut.setAnchorPoint(0.5, 0.5);
            ut.setContentSize(sf.rect.width, sf.rect.height);
            this._fx!.setPosition(0, 0, 0);
            this._frameSf = sf;
            this._pushed = false;
        }

        // 层序：永远画在卡背贴图节点之后（同层上方）
        const backNode = backSp.node;
        if (backNode.parent === this.node) {
            const idx = backNode.getSiblingIndex();
            if (this._fx!.getSiblingIndex() < idx) this._fx!.setSiblingIndex(idx + 1);
        }

        this.pushIfChanged(false);
        return true;
    }

    /** 本节点专属材质（每张卡背一个 → 颜色/粗细互不干扰；shader 程序共用） */
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
     * 解析描边效果资源，三级兜底（与 CardGlow 同套路）：
     *   ① 已注册的效果名 'CardBackOutline'（预览 / 被引用过时走这条）；
     *   ② 从 `resources/effects/CardBackOutline` 异步加载。
     */
    private resolveEffect(): EffectAsset | null {
        if (this._effect && this._effect.isValid) return this._effect;
        const byName = EffectAsset.get(BORDER_EFFECT_NAME);
        if (byName) { this._effect = byName; return byName; }
        this.requestEffect();
        return null;
    }

    /** 从 resources 异步加载效果（只发起一次） */
    private requestEffect(): void {
        if (this._loadingEffect) return;
        this._loadingEffect = true;
        resources.load(BORDER_EFFECT_RES_PATH, EffectAsset, (err, asset) => {
            this._loadingEffect = false;
            if (err || !asset) {
                console.warn(`[CardBackBorder] 加载描边效果 "${BORDER_EFFECT_RES_PATH}" 失败 →`, err);
                return;
            }
            this._effect = asset;
            this._mat = null;                           // 丢掉建不出来的空材质，下次 update 重建
        });
    }

    /** 描边层是否可见 */
    private refreshActive(): void {
        const n = this._fx;
        if (n && n.isValid && n.active !== this.showBorder) n.active = this.showBorder;
    }

    // ------------------------------ 参数推送 ------------------------------
    /** 把「颜色 / 粗细 / UV 映射」推给材质（值没变则什么都不做） */
    private pushIfChanged(force: boolean): void {
        const mat = this._mat;
        if (!mat || !mat.isValid) return;
        const sf = this._frameSf;
        if (!sf) return;
        const c = this.borderColor;
        if (!force
            && this._pushed
            && this._pThick === this.borderThickness
            && this._pR === c.r && this._pG === c.g && this._pB === c.b && this._pA === c.a) {
            return;
        }

        mat.setProperty('outlineColor', _c4.set(c.r / 255, c.g / 255, c.b / 255, c.a / 255));
        // outlineParams：x = 粗细（卡背纹理像素） y = 强度
        mat.setProperty('outlineParams', _p4.set(Math.max(0, this.borderThickness), 1.0, 0, 0));
        // outlineShape：帧分数单位的纹素尺寸（1/rect宽, 1/rect高）
        // 🔴 一律用 sf.rect —— sf.width/height 返回所在纹理尺寸（动态图集打包后 = 2048）
        const W = sf.rect.width;
        const H = sf.rect.height;
        mat.setProperty('outlineShape', _s4.set(1 / W, 1 / H, 0, 0));
        // outlineUV：rect 在纹理 UV 空间的原点与尺寸（兼容 trim / 动态图集）
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
        mat.setProperty('outlineUV', _uv4.set(uMin, vMin, uMax - uMin, vMax - vMin));

        this._pushed = true;
        this._pThick = this.borderThickness;
        this._pR = c.r; this._pG = c.g; this._pB = c.b; this._pA = c.a;
    }

    // ------------------------------ 卡背 Sprite 查找 ------------------------------
    /**
     * 找到卡背 Sprite：
     *   ① 名为 `CardBack` 的子节点（EnemyHandLayout 生成的结构）；
     *   ② 宿主节点自身的 Sprite（CardDraw._drawBack 等自绘结构）。
     * 🔴 复用判定用严格 isValid(n, true)（destroy 是延迟销毁，同帧复用待销毁节点会炸）。
     */
    private backSprite(): Sprite | null {
        const child = this.node.getChildByName(CARD_BACK_CHILD_NAME);
        if (child && isValid(child, true)) {
            const sp = child.getComponent(Sprite);
            if (sp && sp.spriteFrame) return sp;
        }
        const own = this.node.getComponent(Sprite);
        return own && own.spriteFrame ? own : null;
    }
}

// ------------------------------ 模块内部暂存 ------------------------------
const _c4 = new Vec4();
const _p4 = new Vec4();
const _s4 = new Vec4();
const _uv4 = new Vec4();
