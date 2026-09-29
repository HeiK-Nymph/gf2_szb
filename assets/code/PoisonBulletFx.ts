import {
    _decorator, Color, Component, EffectAsset, Material, Node, resources, Sprite, SpriteFrame,
    Tween, tween, UITransform, Vec3,
} from 'cc';
import { killNode } from './CardComposer';

const { ccclass, property, menu } = _decorator;

/** 运行期生成的子弹节点名（每次播放一个，播完自行销毁）
 *  🔴 刻意与宿主节点名（`PoisonBulletFx`）**不同名** —— 否则按名字查找会先命中宿主，
 *     探针 / 调试时拿到的是宿主的位置（踩过）。 */
export const POISON_BULLET_NODE_NAME = 'PoisonBulletShot';
/** 命中毒雾节点名前缀 */
const MIST_NODE_PREFIX = 'PoisonMist';

/**
 * 主弹体素材（7 帧：细光条 → 电弧 → 亮球），`resources` 下的路径。
 * 🔴 子资源必须带 `/spriteFrame` 后缀；素材放在 `assets/resources/` 下才不会被构建裁剪。
 * 🔴 换皮只改这张表即可（当前复用通用子弹条 `effects/Bullet/`，靠节点色染成紫色）。
 */
export const POISON_BULLET_TEX_PATHS: readonly string[] = [
    'effects/Bullet/trace_01_rotated/spriteFrame',   // 细光条（出场）
    'effects/Bullet/trace_02_rotated/spriteFrame',
    'effects/Bullet/trace_03_rotated/spriteFrame',
    'effects/Bullet/trace_04_rotated/spriteFrame',
    'effects/Bullet/trace_05_rotated/spriteFrame',
    'effects/Bullet/trace_06_rotated/spriteFrame',
    'effects/Bullet/trace_07_rotated/spriteFrame',   // 亮球（命中）
];

/** 头部毒光晕素材（软光斑，越靠后越大越柔） */
const GLOW_TEX_PATHS: readonly string[] = [
    'effects/LightOrb/light_01/spriteFrame',
    'effects/LightOrb/light_02/spriteFrame',
    'effects/LightOrb/light_03/spriteFrame',
];

/** 命中毒雾素材（复用潜行烟雾，染成紫色当毒雾） */
const MIST_TEX_PATHS: readonly string[] = [
    'effects/Ambush/AmbushSmoke_01/spriteFrame',
    'effects/Ambush/AmbushSmoke_03/spriteFrame',
    'effects/Ambush/AmbushSmoke_05/spriteFrame',
    'effects/Ambush/AmbushSmoke_07/spriteFrame',
];

/** 复用召唤光球的加色 effect（同一份 shader：贴图 × 节点色 × intensity，加色混合） */
const ADD_EFFECT_NAME = 'SummonOrbAdd';
const ADD_EFFECT_RES_PATH = 'effects/SummonOrbAdd';

/**
 * PoisonBulletFx —— 「**毒弹**」能力演出（卡 2「全力突围·可露凯」/ 卡 6「异相浅眠·米什缇」）
 * ===========================================================================
 * 需求：模仿纹章 4 的子弹特效，但——
 *   · **紫色**（毒主题），颜色在 Inspector 上暴露；
 *   · 从**目标卡牌的右上方**沿**直线**射到**目标卡牌**（不是从施法者飞过去）；
 *   · Inspector 暴露：颜色 / 子弹长短 / 子弹粗细 / 最远出现距离 / 倾斜角度。
 * 在此基础上按「毒」的主题做了三点扩展（都可关 / 可调）：
 *   ① 弹头**毒光晕**（软光斑，跟着弹头一起走、微微涨缩）；
 *   ② 弹尾**毒液拖尾**（几颗滞后的小毒滴，逐颗变小变淡）；
 *   ③ 命中时目标处炸开一小片**毒雾**（复用潜行烟雾素材染色）。
 *
 * ── 它只是**演出**，不参与结算 ──────────────────────────────────────────
 * 🔴 伤害的判定 / 数值 / 摘场 / 记墓场在能力结算的那一瞬间就同步做完了，**不等**这颗子弹飞完。
 *    子弹是 `BattleCommandSystem` **演出队列**里排在 `Destroy` 之前的一段 cue
 *    （单通道 FIFO ⇒ 严格「先飞毒弹、再播破坏动画」），队列是唯一等待方。
 *
 * ── 挂载 ────────────────────────────────────────────────────────────────
 * `Canvas/PoisonBulletFx`（常驻节点，UITransform = 1280×720、锚点 0.5/0.5，与 CrestBulletFx 同款）。
 * 调用方只给**目标的世界坐标**，起点由「倾斜角度 + 最远出现距离」算出来。
 * 一次性特效**不挂在卡牌上**（卡牌会被销毁）—— 永远是本常驻节点下的临时子节点，播完 `killNode`。
 *
 * ── 时间轴（单条数值补间驱动 p，只有一次完成回调）──────────────────────
 *   p ∈ [0,1]：位置 = 起点 → 目标点的**线性插值**（直线飞行）；
 *   形态 = 7 帧按 p 推进（细光条 → 电弧 → 亮球 = 命中）；
 *   透明度 = 前 10% 渐显，末 8% 淡出（「溶进目标」的毒感）；
 *   p ≈ 0.88 时在目标处放一次毒雾（独立补间，自己收尾，不占用主时间轴）。
 * ===========================================================================
 */
@ccclass('PoisonBulletFx')
@menu('gf2szb/PoisonBulletFx')
export class PoisonBulletFx extends Component {

    /** 场景里唯一的实例（调用方通过它播放；未挂载时为 null → 调用方跳过这段演出） */
    private static _inst: PoisonBulletFx | null = null;
    public static get instance(): PoisonBulletFx | null {
        return (PoisonBulletFx._inst && PoisonBulletFx._inst.isValid) ? PoisonBulletFx._inst : null;
    }

    // ====================== ★ 需求：Inspector 暴露的五个变量 ======================
    @property({
        type: Color,
        tooltip: '★【子弹颜色】毒弹的着色（默认**紫色** 176,92,236）。\n'
            + '加色混合下 alpha 也参与亮度：把 alpha 调低 = 更暗更阴的紫光。',
    })
    color = new Color(176, 92, 236, 255);

    @property({
        range: [8, 600, 1], slide: true,
        tooltip: '★【子弹长短】弹体沿飞行方向的长边（px）。\n'
            + '素材长边是 +X ⇒ 本值就是「这条毒光有多长」；拖尾毒滴不跟着变长（它们只按毒滴大小缩放）。',
    })
    length = 150;

    @property({
        range: [2, 160, 1], slide: true,
        tooltip: '★【子弹粗细】弹体垂直于飞行方向的厚度（px）。\n'
            + '素材可见部分约占高度 36% ⇒ 视觉粗细 ≈ 0.36 × 本值，想更粗就往大调。',
    })
    thickness = 46;

    @property({
        range: [20, 1400, 1], slide: true,
        tooltip: '★【最远出现距离】毒弹**出场点**离目标卡牌的距离（px）。\n'
            + '出场点 = 目标卡牌 + （倾斜角度方向）× 本值 ⇒ 本值越大，子弹从越远的地方射进来、飞得越久。\n'
            + '🔴 默认 280：对**敌方那一排**（世界 y≈494）刚好从画面右上角内侧射入 —— 全程可见。\n'
            + '   调到 400+ 会从画面**外面**射进来（只看得见后半段），想更远就配小一点的【飞行时长】。',
    })
    maxDistance = 280;

    @property({
        range: [-180, 180, 1], slide: true,
        tooltip: '★【子弹倾斜角度】毒弹的**入射方向角**（度）：0 = 从**正右方**射入，正值 = 从**上方**射入、负值 = 下方。\n'
            + '默认 42° ≈ 从**右上方**斜射下来（需求口径）。\n'
            + '🔴 弹体自身的倾斜（贴图旋转）**跟着飞行方向走**，所以本值同时决定了子弹看起来是「斜的」。',
    })
    tiltAngle = 42;

    @property({
        range: [0.05, 3, 0.01], slide: true,
        tooltip: '★【飞行时长】从出场点直线飞到目标卡牌的总时长（秒）。\n'
            + '🔴 它只是演出时长：伤害 / 破坏在能力结算那一瞬间就已算完（数据不等动画）。',
    })
    duration = 0.42;

    // ====================== 毒主题扩展（都可关 / 可调）======================
    @property({
        range: [0, 400, 1], slide: true,
        tooltip: '【弹头毒光晕】弹头那团软光斑的大小（px）。0 = 不要光晕（只剩光条本身）。',
    })
    glowSize = 130;

    @property({
        range: [0, 8, 1], slide: true,
        tooltip: '【毒液拖尾】弹尾滞后的小毒滴数量。0 = 不要拖尾。\n'
            + '每颗比前一颗更靠后、更小、更淡 ⇒ 拉出一条「毒液」尾迹。',
    })
    dropletCount = 3;

    @property({
        range: [4, 200, 1], slide: true,
        tooltip: '【毒滴大小】拖尾毒滴的基准尺寸（px，第一颗）。',
    })
    dropletSize = 40;

    @property({
        range: [0, 12, 1], slide: true,
        tooltip: '【命中毒雾】命中瞬间在目标处炸开的毒雾团数。0 = 不要毒雾。',
    })
    mistCount = 4;

    @property({
        range: [20, 600, 1], slide: true,
        tooltip: '【毒雾大小】每团毒雾的基准尺寸（px，会各自随机 ±25% 并随时间涨大）。\n'
            + '🔴 别盖住卡面信息：默认 140 ≈ 比一张卡略大一点的一小片雾。',
    })
    mistSize = 140;

    @property({
        range: [0.1, 3, 0.01], slide: true,
        tooltip: '【毒雾时长】一团毒雾从绽开到散尽的时长（秒）。\n'
            + '🔴 毒雾**不占用**演出队列（它和破坏动画并行播），所以调大不会拖慢战斗节奏。',
    })
    mistDuration = 0.55;

    // ====================== 观感开关 ======================
    @property({ tooltip: '是否用**加色（ADD）**混合（发光感）。关闭 = 普通 alpha 混合（在亮背景上更实）。' })
    additive = true;

    @property({
        range: [0, 4, 0.01], slide: true,
        tooltip: '加色亮度倍数（仅 additive = true 生效）。\n'
            + '🔴 别贪大：末两帧是近乎实心的亮球，intensity > 1.6 会整颗过曝成纯白（紫色丢失）。',
    })
    intensity = 1.1;

    // ====================== 素材（自动从 resources 加载）======================
    private readonly _frames: (SpriteFrame | null)[] = POISON_BULLET_TEX_PATHS.map(() => null);
    private readonly _glows: (SpriteFrame | null)[] = GLOW_TEX_PATHS.map(() => null);
    private readonly _mists: (SpriteFrame | null)[] = MIST_TEX_PATHS.map(() => null);
    private _loading = false;
    private _effect: EffectAsset | null = null;
    private _loadingEffect = false;
    private _warned = false;
    /** 还在播的毒雾节点（组件被关掉时强制收掉，绝不留悬空节点） */
    private readonly _liveMist: Node[] = [];

    /**
     * **同时在飞**的每一段演出的收尾函数（需求：一次能力打多个目标时，毒弹要**一起**飞）。
     * 收尾时把自己从集合里摘掉；组件被关掉 / 销毁时把它们全部收掉（否则演出队列永远等下去）。
     */
    private readonly _actives = new Set<() => void>();

    /** 当前这一段演出的收尾函数（再播一段时先把上一段收掉，绝不让演出队列卡住） */
    private _activeFinish: (() => void) | null = null;

    // ------------------------------ 生命周期 ------------------------------
    onLoad(): void {
        PoisonBulletFx._inst = this;
        this.preload();
    }

    onEnable(): void {
        this.preload();
    }

    onDisable(): void {
        // 组件被关掉：把**所有**在飞的毒弹立刻收尾（清节点 + 回调 done），否则演出队列永远等下去
        this.finishAll();
        this.clearMist();
    }

    onDestroy(): void {
        if (PoisonBulletFx._inst === this) PoisonBulletFx._inst = null;
        this.finishAll();
        this.clearMist();
    }

    /** 收掉全部在飞的毒弹（幂等） */
    private finishAll(): void {
        for (const f of Array.from(this._actives)) {
            try { f(); } catch (e) { /* 单段异常不影响其它 */ }
        }
        this._actives.clear();
        this._activeFinish = null;
    }

    /** 素材是否已就绪（主弹体 7 帧都在；光晕 / 毒雾缺了只是少点装饰，不阻塞） */
    public get assetsReady(): boolean {
        return this._frames.every((f) => f !== null && f.isValid);
    }

    /** 预加载素材（幂等；场景启动时调一次，避免第一次触发时贴图还没到） */
    public preload(): void {
        this.ensureAddEffect();
        if (this.assetsReady || this._loading) return;
        this._loading = true;
        const jobs: Array<{ path: string; put: (sf: SpriteFrame) => void }> = [];
        POISON_BULLET_TEX_PATHS.forEach((path, i) => jobs.push({ path, put: (sf) => { this._frames[i] = sf; } }));
        GLOW_TEX_PATHS.forEach((path, i) => jobs.push({ path, put: (sf) => { this._glows[i] = sf; } }));
        MIST_TEX_PATHS.forEach((path, i) => jobs.push({ path, put: (sf) => { this._mists[i] = sf; } }));
        let remain = jobs.length;
        for (const job of jobs) {
            resources.load(job.path, SpriteFrame, (err, sf) => {
                remain--;
                if (err || !sf) this.warnOnce(`加载毒弹贴图失败："${job.path}"`, err);
                else job.put(sf as SpriteFrame);
                if (remain <= 0) this._loading = false;
            });
        }
    }

    private warnOnce(msg: string, err: unknown): void {
        if (this._warned) return;
        this._warned = true;
        console.warn('[PoisonBulletFx] ' + msg + ' →', err);
    }

    private ensureAddEffect(): EffectAsset | null {
        if (this._effect && this._effect.isValid) return this._effect;
        const byName = EffectAsset.get(ADD_EFFECT_NAME);
        if (byName) { this._effect = byName; return byName; }
        if (!this._loadingEffect) {
            this._loadingEffect = true;
            resources.load(ADD_EFFECT_RES_PATH, EffectAsset, (err, asset) => {
                this._loadingEffect = false;
                if (err || !asset) { this.warnOnce(`加载加色效果失败："${ADD_EFFECT_RES_PATH}"`, err); return; }
                this._effect = asset;
            });
        }
        return null;
    }

    /** 新建一份加色材质（每次播放独立，收尾时 destroy） */
    private makeMaterial(): Material | null {
        if (!this.additive) return null;
        const eff = this.ensureAddEffect();
        if (!eff) return null;
        const mat = new Material();
        try {
            mat.initialize({ effectAsset: eff });
            mat.setProperty('intensity', Math.max(0, this.intensity));
        } catch (e) {
            this.warnOnce('初始化加色材质失败', e);
            return null;
        }
        return mat;
    }

    // ------------------------------ 播放 ------------------------------
    /**
     * 朝 `toWorld`（**目标卡牌的世界坐标**）射一颗毒弹：出场点由「倾斜角度 + 最远出现距离」算出，
     * 沿**直线**飞向目标，播完回调 `onComplete`。
     *
     * 🔴 **支持同时在飞多颗**（需求：一次能力打多个目标时，毒弹要一起飞）——
     *    本方法**不会**打断上一颗；每颗各有独立的节点 / 材质 / 补间 / 收尾。
     * 🔴 `onComplete` 一定会被调用（且只一次）：素材没就绪 / 节点非法 / 组件被关掉 /
     *    补间异常 / **超时熔断**都保证放行 —— 演出队列是单通道的，少一次 done 就会全场停摆。
     */
    public play(toWorld: Vec3, onComplete?: () => void): void {
        const done = onceGuard(() => { if (onComplete) safeCall(onComplete); });

        // 组件被关掉 / 节点不可用 = 这段特效「不存在」→ 直接放行（破坏动画照旧播）
        if (!this.enabled || !this.node || !this.node.isValid) { done(); return; }
        if (!toWorld) { done(); return; }
        this.preload();
        if (!this.assetsReady) {
            this.warnOnce('毒弹贴图未就绪，跳过本段演出', null);
            done();
            return;
        }

        const hostUT = this.node.getComponent(UITransform);
        const to = hostUT ? hostUT.convertToNodeSpaceAR(toWorld, new Vec3()) : toWorld.clone();

        // ★ 出场点 = 目标 + （倾斜角度方向）× 最远出现距离
        const ang = (Number.isFinite(this.tiltAngle) ? this.tiltAngle : 42) * Math.PI / 180;
        const dist = Math.max(0, this.maxDistance);
        const from = new Vec3(to.x + Math.cos(ang) * dist, to.y + Math.sin(ang) * dist, 0);
        // 弹体朝向 = 出场点 → 目标（直线飞行；素材长边 = +X）
        const rotDeg = Math.atan2(to.y - from.y, to.x - from.x) * 180 / Math.PI;

        const base = this.color ? new Color(this.color) : new Color(176, 92, 236, 255);
        const baseAlpha = Math.max(0, Math.min(255, base.a)) / 255;
        const mat = this.makeMaterial();

        // ---- 主弹体 ----
        const fx = new Node(POISON_BULLET_NODE_NAME);
        fx.layer = this.node.layer;          // 🔴 必须继承宿主 layer（UI_2D 会被相机剔除）
        fx.setParent(this.node);
        if (fx.parent) fx.setSiblingIndex(fx.parent.children.length - 1);   // 画在最上层
        const ut = fx.addComponent(UITransform);
        ut.setAnchorPoint(0.5, 0.5);
        const lenW = Math.max(8, this.length);
        const thickH = Math.max(2, this.thickness);
        ut.setContentSize(lenW, thickH);
        const sp = fx.addComponent(Sprite);
        sp.sizeMode = Sprite.SizeMode.CUSTOM;   // 🔴 默认 TRIMMED 会按裁剪框改写 contentSize
        sp.type = Sprite.Type.SIMPLE;
        sp.trim = false;                        // 整张贴进节点矩形 ⇒ 长短 / 粗细完全由上面两个变量决定
        sp.spriteFrame = this._frames[0];
        if (mat) sp.customMaterial = mat;
        fx.setRotationFromEuler(0, 0, rotDeg);
        fx.setPosition(from.x, from.y, 0);
        const bulletCol = new Color(base);
        bulletCol.a = 0;
        sp.color = bulletCol;

        // ---- 弹头毒光晕（跟着弹头走；弹头 = 弹体中心再往前半个身位）----
        const headDir = new Vec3(to.x - from.x, to.y - from.y, 0);
        if (headDir.length() > 0.0001) headDir.normalize();
        let glow: Node | null = null;
        let glowSp: Sprite | null = null;
        const glowCol = new Color(base);
        if (this.glowSize > 0 && this._glows.some((g) => !!g && g.isValid)) {
            glow = new Node('PoisonBulletGlow');
            glow.layer = this.node.layer;
            glow.setParent(this.node);
            const gut = glow.addComponent(UITransform);
            gut.setAnchorPoint(0.5, 0.5);
            gut.setContentSize(this.glowSize, this.glowSize);
            glowSp = glow.addComponent(Sprite);
            glowSp.sizeMode = Sprite.SizeMode.CUSTOM;
            glowSp.type = Sprite.Type.SIMPLE;
            glowSp.spriteFrame = this._glows[this._glows.length - 1] || this._glows[0];
            if (mat) glowSp.customMaterial = mat;
            glowCol.a = 0;
            glowSp.color = glowCol;
        }

        // ---- 弹尾毒液拖尾（滞后的小毒滴）----
        const drops: Array<{ node: Node; sp: Sprite; lag: number; scale: number; col: Color }> = [];
        const dropCount = Math.max(0, Math.round(this.dropletCount));
        for (let i = 0; i < dropCount; i++) {
            const n = new Node('PoisonDroplet_' + i);
            n.layer = this.node.layer;
            n.setParent(this.node);
            const dut = n.addComponent(UITransform);
            dut.setAnchorPoint(0.5, 0.5);
            const size = Math.max(4, this.dropletSize) * (1 - 0.22 * i);
            dut.setContentSize(size, size);
            const dsp = n.addComponent(Sprite);
            dsp.sizeMode = Sprite.SizeMode.CUSTOM;
            dsp.type = Sprite.Type.SIMPLE;
            dsp.spriteFrame = this._glows[Math.min(i, this._glows.length - 1)] || this._frames[this._frames.length - 1];
            if (mat) dsp.customMaterial = mat;
            const dc = new Color(base);
            dc.a = 0;
            dsp.color = dc;
            n.setPosition(from.x, from.y, 0);
            drops.push({ node: n, sp: dsp, lag: 0.055 * (i + 1), scale: 1 - 0.22 * i, col: dc });
        }

        // 单条数值补间驱动整条时间轴（只有一个完成回调，没有多条补间抢结束的竞态）
        const state = { p: 0 };
        const dur = Math.max(0.05, this.duration);
        let frameIndex = -1;
        let settled = false;
        let mistSpawned = false;

        const cleanup = (): void => {
            try { Tween.stopAllByTarget(state); } catch (e) { /* 忽略 */ }
            if (fx.isValid) { try { killNode(fx); } catch (e) { /* 忽略 */ } }
            if (glow && glow.isValid) { try { killNode(glow); } catch (e) { /* 忽略 */ } }
            for (const d of drops) { if (d.node && d.node.isValid) { try { killNode(d.node); } catch (e) { /* 忽略 */ } } }
            if (mat && mat.isValid) { try { mat.destroy(); } catch (e) { /* 忽略 */ } }
        };
        const finish = (): void => {
            if (settled) return;
            settled = true;
            this._actives.delete(finish);
            if (this._activeFinish === finish) this._activeFinish = null;
            cleanup();
            done();
        };
        this._actives.add(finish);
        this._activeFinish = finish;

        // 🔴 熔断：补间一旦被外部打断 / 被吞，这里必须在 dur 之后放行（否则演出队列永久卡住）。
        this.scheduleOnce(() => {
            if (settled) return;
            console.warn('[PoisonBulletFx] 毒弹演出超时未结束 → 强制放行演出队列');
            finish();
        }, dur + 0.6);

        try {
            tween(state)
                .to(dur, { p: 1 }, {
                    easing: 'linear',
                    // 🔴 补间回调里的异常会被引擎吞 → 一律 try/catch
                    onUpdate: () => {
                        if (settled) return;
                        try {
                            const t = Math.max(0, Math.min(1, state.p));
                            const x = from.x + (to.x - from.x) * t;
                            const y = from.y + (to.y - from.y) * t;
                            // ① 主弹体：直线推进 + 起步略小 + 前 10% 渐显 / 末 8% 淡出（溶进目标）
                            fx.setPosition(x, y, 0);
                            const k = 0.8 + 0.2 * smoothstep(0, 0.15, t);
                            ut.setContentSize(lenW * k, thickH * k);
                            const fadeIn = smoothstep(0, 0.10, t);
                            const fadeOut = 1 - smoothstep(0.92, 1, t);
                            bulletCol.a = Math.round(255 * baseAlpha * fadeIn * fadeOut);
                            sp.color = bulletCol;
                            const fi = Math.min(POISON_BULLET_TEX_PATHS.length - 1,
                                Math.floor(t * POISON_BULLET_TEX_PATHS.length));
                            if (fi !== frameIndex) {
                                frameIndex = fi;
                                const sf = this._frames[fi];
                                if (sf && sf.isValid) sp.spriteFrame = sf;
                            }
                            // ② 弹头光晕：贴在弹头（中心再往前半身位），随进度微微涨缩
                            if (glow && glow.isValid && glowSp) {
                                const headX = x + headDir.x * lenW * 0.5 * k;
                                const headY = y + headDir.y * lenW * 0.5 * k;
                                glow.setPosition(headX, headY, 0);
                                const gs = 1 + 0.18 * Math.sin(t * Math.PI);
                                const gut = glow.getComponent(UITransform);
                                if (gut) gut.setContentSize(this.glowSize * gs, this.glowSize * gs);
                                glowCol.a = Math.round(255 * baseAlpha * 0.75 * fadeIn * fadeOut);
                                glowSp.color = glowCol;
                            }
                            // ③ 毒液拖尾：每颗滞后一点、逐颗变小变淡
                            for (const d of drops) {
                                if (!d.node || !d.node.isValid) continue;
                                const dt = Math.max(0, Math.min(1, t - d.lag));
                                d.node.setPosition(from.x + (to.x - from.x) * dt, from.y + (to.y - from.y) * dt, 0);
                                const da = Math.round(255 * baseAlpha * 0.62 * d.scale
                                    * smoothstep(0, 0.14, dt) * (1 - smoothstep(0.92, 1, dt)));
                                d.col.a = da;
                                d.sp.color = d.col;
                            }
                            // ④ 命中前一点：目标处炸一小片毒雾（独立补间，自己收尾）
                            if (!mistSpawned && t >= 0.88) {
                                mistSpawned = true;
                                this.spawnMist(to, baseAlpha);
                            }
                        } catch (e) { /* 单帧异常忽略，让演出继续 */ }
                    },
                })
                .call(() => finish())     // 🔴 不要在 .call 里提前置位：finish 自带守卫
                .start();
        } catch (e) {
            console.error('[PoisonBulletFx] 毒弹演出出错：', e);
            finish();
        }
    }

    /** 调试 / 探针：当前是否有毒弹在飞（可能有**多颗**同时在飞） */
    public get isPlaying(): boolean {
        return this._actives.size > 0;
    }

    /** 调试 / 探针：当前同时在飞的毒弹数量 */
    public get flyingCount(): number {
        return this._actives.size;
    }

    // ------------------------------ 命中毒雾 ------------------------------
    /** 在目标处绽开 `mistCount` 团毒雾（各自独立补间，播完自行销毁；不占用演出队列） */
    private spawnMist(at: Vec3, baseAlpha: number): void {
        const count = Math.max(0, Math.round(this.mistCount));
        if (count <= 0) return;
        const frames = this._mists.filter((f) => !!f && f.isValid);
        if (frames.length === 0) return;
        const base = this.color ? new Color(this.color) : new Color(176, 92, 236, 255);
        const dur = Math.max(0.1, this.mistDuration);
        for (let i = 0; i < count; i++) {
            const n = new Node(MIST_NODE_PREFIX + '_' + i);
            n.layer = this.node.layer;
            n.setParent(this.node);
            if (n.parent) n.setSiblingIndex(n.parent.children.length - 1);
            const ut = n.addComponent(UITransform);
            ut.setAnchorPoint(0.5, 0.5);
            const size = Math.max(20, this.mistSize) * (0.75 + Math.random() * 0.5);
            ut.setContentSize(size, size);
            const sp = n.addComponent(Sprite);
            sp.sizeMode = Sprite.SizeMode.CUSTOM;
            sp.type = Sprite.Type.SIMPLE;
            sp.spriteFrame = frames[i % frames.length];
            const mat = this.makeMaterial();
            if (mat) sp.customMaterial = mat;
            const col = new Color(base);
            col.a = 0;
            sp.color = col;
            // 随机散开一点（毒雾是一小片，不是一团）
            const a = Math.random() * Math.PI * 2;
            const r = size * (0.12 + Math.random() * 0.22);
            n.setPosition(at.x + Math.cos(a) * r, at.y + Math.sin(a) * r, 0);
            n.setScale(0.55, 0.55, 1);
            this._liveMist.push(n);

            const st = { p: 0 };
            let done = false;
            const finishMist = (): void => {
                if (done) return;
                done = true;
                const idx = this._liveMist.indexOf(n);
                if (idx >= 0) this._liveMist.splice(idx, 1);
                try { Tween.stopAllByTarget(st); } catch (e) { /* 忽略 */ }
                if (n.isValid) { try { killNode(n); } catch (e) { /* 忽略 */ } }
                if (mat && mat.isValid) { try { mat.destroy(); } catch (e) { /* 忽略 */ } }
            };
            // 🔴 熔断：毒雾不占队列，但也不能留悬空节点
            this.scheduleOnce(() => { if (!done) finishMist(); }, dur + 0.5);
            try {
                tween(st)
                    .to(dur, { p: 1 }, {
                        easing: 'quadOut',
                        onUpdate: () => {
                            if (done) return;
                            try {
                                const t = Math.max(0, Math.min(1, st.p));
                                const s = 0.55 + 0.75 * t;
                                n.setScale(s, s, 1);
                                col.a = Math.round(255 * baseAlpha * 0.55 * Math.sin(Math.PI * Math.min(1, t * 1.05)));
                                sp.color = col;
                            } catch (e) { /* 忽略 */ }
                        },
                    })
                    .call(() => finishMist())
                    .start();
            } catch (e) {
                finishMist();
            }
        }
    }

    /** 强制收掉所有还在播的毒雾（组件被关掉 / 销毁时） */
    private clearMist(): void {
        for (const n of this._liveMist.slice()) {
            if (n && n.isValid) { try { killNode(n); } catch (e) { /* 忽略 */ } }
        }
        this._liveMist.length = 0;
    }
}

// ============================================================================
// 工具
// ============================================================================
/** 平滑阶跃 smoothstep（a == b 时退化为阶跃） */
function smoothstep(a: number, b: number, x: number): number {
    const t = Math.max(0, Math.min(1, (b - a) === 0 ? (x >= b ? 1 : 0) : (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
}

/** 包一层「只执行一次」，供回调守卫 */
function onceGuard(fn: () => void): () => void {
    let called = false;
    return () => {
        if (called) return;
        called = true;
        fn();
    };
}

function safeCall(fn: () => void): void {
    try { fn(); } catch (e) { console.error('[PoisonBulletFx] 完成回调出错：', e); }
}
