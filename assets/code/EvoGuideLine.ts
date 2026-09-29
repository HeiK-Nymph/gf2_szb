import {
    _decorator, Canvas, Color, Component, EffectAsset, Material, Node, resources, Sprite, SpriteFrame,
    Tween, tween, UIOpacity, Vec3, Vec4,
} from 'cc';
import { EDITOR } from 'cc/env';

const { ccclass, property, requireComponent, executeInEditMode, menu } = _decorator;

/** 复用的临时向量（避免每帧 new） */
const _p0 = new Vec3();
const _p3 = new Vec3();
const _v4a = new Vec4();
const _v4b = new Vec4();
const _v4c = new Vec4();
const _v4d = new Vec4();
const _v4e = new Vec4();
const _v4f = new Vec4();
const _v4g = new Vec4();
const _v4h = new Vec4();

/** effect 资源路径（必须在 assets/resources 下，否则构建会被裁掉） */
const EFFECT_URL = 'effects/EvoGuideLine/EvoGuideLine';

/**
 * EvoGuideLine —— 进化 / 攻击「引导线」：三阶贝塞尔金色发光光带
 * ===========================================================================
 * 节点结构：**单个 Sprite 节点**（挂本脚本 + `EvoGuideLine.effect`，运行时自动装配）。
 *   · 不用 Graphics、不用序列帧、不用多层 Sprite 叠加；
 *   · 曲线由片元着色器的**距离场**生成（见 effect 注释），所以只需要 4 个控制点 uniform
 *     就能实时扭曲，拖动鼠标时线条持续变形；
 *   · 流光 = 沿曲线参数滚动的一颗光斑（同样纯 shader）。
 *
 * 坐标系：对外接口（`setStartPoint` / `setEndPoint`）收的是**世界坐标**，
 * 内部统一换算成**节点本地坐标**再喂给 shader（适配任意 Canvas / 分辨率）。
 *
 * 用法：
 *   const line = node.getComponent(EvoGuideLine);
 *   line.show(startWorld, endWorld);   // 淡入并开始跟随
 *   line.setEndPoint(mouseWorld);      // 每帧更新终点
 *   line.hide();                       // 淡出
 * ===========================================================================
 */
@ccclass('EvoGuideLine')
@requireComponent(Sprite)
@executeInEditMode(true)
@menu('gf2szb/EvoGuideLine')
export class EvoGuideLine extends Component {

    // ====================== 形状 ======================

    @property({
        range: [2, 120, 1], slide: true,
        tooltip: '光带**半宽**（px）—— 🔴 调整引导线**粗细**就改这一个（实际可见宽度 ≈ 2×此值 + 外晕）',
    })
    halfWidth = 13;

    @property({
        range: [-500, 500, 1], slide: true,
        tooltip: '弧线**拱起高度**（px）。正 / 负 = 往曲线两侧拱；0 = 直线。',
    })
    curveHeight = 170;

    @property({
        range: [0, 0.5, 0.01], slide: true,
        tooltip: '控制点的横向位置（0.5 = 居中；越小弧顶越靠近起点）',
    })
    curveBias = 0.30;

    @property({
        range: [-1, 1, 2], slide: true,
        tooltip: '弧线**弯向**：+1 = 向右弯（超进化），-1 = 向左弯（普通进化）。0 视为 1。\n'
            + '🔴 拖拽控制器会按进化类型自动设置这个值（EP=-1 左 / SEP=+1 右），Inspector 手改会被覆盖。',
    })
    curveDir = 1;

    // ====================== 发光 ======================

    @property({ range: [0.2, 6, 0.05], slide: true, tooltip: '整体发光强度' })
    intensity = 2.0;

    @property({ type: Color, tooltip: '**亮芯**颜色（例图里是近白的暖色）' })
    coreColor = new Color(255, 246, 220, 255);

    @property({ type: Color, tooltip: '**外光晕**颜色（例图里是金色）' })
    edgeColor = new Color(255, 168, 40, 255);

    @property({ range: [0.5, 3, 0.05], slide: true, tooltip: '外光晕相对亮芯的扩散倍数（越大越柔）' })
    glowScale = 1.6;

    @property({ range: [0, 0.3, 0.005], slide: true, tooltip: '两端渐隐比例（避免起终点硬切）' })
    endFade = 0.06;

    // ====================== 流光 ======================

    @property({ range: [0, 4, 0.05], slide: true, tooltip: '流光速度（每秒滚过几遍曲线）' })
    flowSpeed = 1.1;

    @property({ range: [0.02, 0.5, 0.005], slide: true, tooltip: '流光宽度（沿曲线参数 0~1）' })
    flowWidth = 0.10;

    @property({ range: [0, 4, 0.05], slide: true, tooltip: '流光亮度' })
    flowStrength = 1.2;

    // ====================== 淡入淡出 ======================

    @property({ range: [0, 1, 0.01], slide: true, tooltip: '淡入时长（秒）' })
    fadeIn = 0.10;

    @property({ range: [0, 1, 0.01], slide: true, tooltip: '淡出时长（秒）' })
    fadeOut = 0.16;

    // ====================== 内部 ======================
    private _mat: Material | null = null;
    private _opacity: UIOpacity | null = null;
    /** 曲线起点 / 终点（世界坐标） */
    private readonly _start = new Vec3();
    private readonly _end = new Vec3();
    /** 流光进度（0~1 循环） */
    private _flow = 0;
    private _visible = false;
    private _ready = false;

    // ------------------------------ 生命周期 ------------------------------
    onLoad(): void {
        // 🔴 编辑器里这层是 1280×720 的大四边形，占位贴图会把整个场景视图挡死 ——
        //    编辑器中直接禁用 Sprite 渲染（shader 本来也不采样贴图，纯靠距离场画线）。
        const sp = this.getComponent(Sprite);
        if (sp) sp.enabled = !EDITOR;
        this.reparentToCanvas();

        this._opacity = this.getComponent(UIOpacity) || this.addComponent(UIOpacity);
        this._opacity.opacity = 0;
        if (!EDITOR) {
            this.node.active = true;                // 常驻节点，用透明度控制显隐
            this.setupMaterial();
        }
    }

    /**
     * 🔴 自愈：本节点**必须挂在 Canvas 下**（距离场在片元里用世界坐标计算，且要参与 UI 渲染树
     *     才画得出来）。被人在编辑器里拖到 Canvas 之外 ⇒ 引导线整条消失。这里自动放回
     *     Canvas 的最上层。
     */
    private reparentToCanvas(): void {
        const scene = this.node.scene;
        if (!scene) return;
        let p: Node | null = this.node.parent;
        while (p) {
            if (p.getComponent(Canvas)) return;     // 已在 Canvas 子树内 ✓
            p = p.parent;
        }
        const stack: Node[] = [...scene.children];
        while (stack.length > 0) {
            const n = stack.shift() as Node;
            if (n !== this.node && n.getComponent(Canvas)) {
                this.node.setParent(n);
                this.node.setSiblingIndex(n.children.length - 1);
                return;
            }
            for (const ch of n.children) stack.push(ch);
        }
    }

    onEnable(): void {
        if (EDITOR) return;
        this.setupMaterial();
    }

    update(dt: number): void {
        if (!this._ready) return;
        // 流光即使不可见也停掉，省一点开销
        if (this._visible) {
            this._flow += dt * this.flowSpeed;
            if (this._flow > 1) this._flow -= Math.floor(this._flow);
        }
        this.applyCurve();
    }

    // ------------------------------ 对外 API ------------------------------

    /** 设置曲线起点（世界坐标） */
    public setStartPoint(start: Vec3): void {
        this._start.set(start);
    }

    /** 设置曲线终点（世界坐标）—— 拖动时每帧调用 */
    public setEndPoint(end: Vec3): void {
        this._end.set(end);
    }

    /** 控制弧线拱起高度（px） */
    public setCurveHeight(height: number): void {
        this.curveHeight = height;
    }

    /** 一次设置两端 */
    public setPoints(start: Vec3, end: Vec3): void {
        this._start.set(start);
        this._end.set(end);
    }

    /** 显示（淡入）并开始跟随 */
    public show(start?: Vec3, end?: Vec3): void {
        if (start) this._start.set(start);
        if (end) this._end.set(end);
        this._visible = true;
        this.node.active = true;
        const op = this.opacity();
        Tween.stopAllByTarget(op);
        tween(op)
            .to(Math.max(0, this.fadeIn), { opacity: 255 }, { easing: 'quadOut' })
            .start();
        this.applyCurve();
    }

    /** 隐藏（淡出；淡出结束再关节点） */
    public hide(): void {
        this._visible = false;
        const op = this.opacity();
        Tween.stopAllByTarget(op);
        tween(op)
            .to(Math.max(0, this.fadeOut), { opacity: 0 }, { easing: 'quadOut' })
            .call(() => {
                // 🔴 tween 回调里的异常会被引擎吞掉 → 一律 try/catch
                try { if (!this._visible) this.node.active = false; } catch (e) { /* 忽略 */ }
            })
            .start();
    }

    /** 是否正在显示（供外部查询） */
    public get isShowing(): boolean { return this._visible; }

    // ------------------------------ 材质 ------------------------------
    private opacity(): UIOpacity {
        if (!this._opacity || !this._opacity.isValid) {
            this._opacity = this.getComponent(UIOpacity) || this.addComponent(UIOpacity);
        }
        return this._opacity;
    }

    /** 兜底：Sprite 必须有 spriteFrame 才会产生渲染数据（shader 并不采样它，内容无所谓） */
    private ensureSpriteFrame(): void {
        const sp = this.getComponent(Sprite);
        if (!sp || sp.spriteFrame) return;
        resources.load('effects/EvoGuideLine/blue_laser/spriteFrame', SpriteFrame, (err, sf) => {
            if (err || !sf || !this.isValid) return;
            const s = this.getComponent(Sprite);
            if (s && !s.spriteFrame) s.spriteFrame = sf;
        });
    }

    private setupMaterial(): void {
        if (this._mat && this._mat.isValid) return;
        const sp = this.getComponent(Sprite);
        if (!sp) return;
        this.ensureSpriteFrame();
        resources.load(EFFECT_URL, EffectAsset, (err, eff) => {
            if (err || !eff || !this.isValid) {
                console.warn('[EvoGuideLine] 引导线 effect 加载失败：', err);
                return;
            }
            const mat = new Material();
            mat.initialize({ effectAsset: eff });
            this._mat = mat;
            sp.customMaterial = mat;
            this._ready = true;
            this.applyMaterialParams();
            this.applyCurve();
        });
    }

    /** 把 Inspector 上的颜色 / 强度写进材质（改参数后调用即可生效） */
    public applyMaterialParams(): void {
        const m = this._mat;
        if (!m) return;
        _v4a.set(this.coreColor.r / 255, this.coreColor.g / 255, this.coreColor.b / 255, 1);
        _v4b.set(this.edgeColor.r / 255, this.edgeColor.g / 255, this.edgeColor.b / 255, 1);
        _v4c.set(this.halfWidth, this.glowScale, this.intensity, this.endFade);
        m.setProperty('coreColor', _v4a);
        m.setProperty('edgeColor', _v4b);
        m.setProperty('shapeParams', _v4c);
    }

    /**
     * 每帧：4 个贝塞尔控制点 + 流光位置。
     * 🔴🔴 **控制点直接用世界坐标，不要再换算成节点本地坐标**：
     *    Cocos 3.x 的 2D 批渲染把**世界坐标**直接烘进 `a_position`（UI 渲染不走 `USE_LOCAL`），
     *    所以片元里的 `localPos` 实际是**世界坐标** —— 换算成本地坐标会让整条曲线
     *    偏移一个 Canvas 原点 (640,360)，直接画到屏幕外（实测踩过）。
     */
    private applyCurve(): void {
        const m = this._mat;
        if (!m) return;

        _p0.set(this._start);
        _p3.set(this._end);

        const dx = _p3.x - _p0.x;
        const dy = _p3.y - _p0.y;
        const len = Math.max(1e-3, Math.hypot(dx, dy));
        // 曲线法线（🔴 顺时针 90° = 弧顶朝**右**弯；乘 curveDir 翻转：-1 → 向左弯）
        const dir = this.curveDir === 0 ? 1 : this.curveDir;
        const nx = dir * dy / len;
        const ny = dir * -dx / len;
        const h = this.curveHeight;
        const b = Math.min(0.85, Math.max(0.15, this.curveBias));
        const c1x = _p0.x + dx * b + nx * h;
        const c1y = _p0.y + dy * b + ny * h;
        const c2x = _p0.x + dx * (1 - b) + nx * h;
        const c2y = _p0.y + dy * (1 - b) + ny * h;

        _v4d.set(_p0.x, _p0.y, 0, 0);
        _v4e.set(c1x, c1y, 0, 0);
        _v4f.set(c2x, c2y, 0, 0);
        _v4g.set(_p3.x, _p3.y, 0, 0);
        _v4h.set(this._flow, this.flowWidth, this.flowStrength, 0);
        m.setProperty('p0', _v4d);
        m.setProperty('p1', _v4e);
        m.setProperty('p2', _v4f);
        m.setProperty('p3', _v4g);
        m.setProperty('flowParams', _v4h);
    }
}
