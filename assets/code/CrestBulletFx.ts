import {
    _decorator, Color, Component, EffectAsset, Material, Node, resources, Sprite, SpriteFrame,
    Tween, tween, UITransform, Vec3,
} from 'cc';
import { killNode } from './CardComposer';

const { ccclass, property, menu } = _decorator;

/** 运行期生成的子弹节点名（每次播放一个，播完自行销毁） */
export const CREST_BULLET_NODE_NAME = 'CrestBullet';

/**
 * 子弹素材（7 帧，横向光条 → 电弧 → 光球），`resources` 下的路径。
 * 🔴 子资源必须带 `/spriteFrame` 后缀；素材放在 `assets/resources/` 下才不会被构建裁剪。
 */
export const CREST_BULLET_TEX_PATHS: readonly string[] = [
    'effects/crest/4/trace_01_rotated/spriteFrame',   // 细光条（发射）
    'effects/crest/4/trace_02_rotated/spriteFrame',
    'effects/crest/4/trace_03_rotated/spriteFrame',
    'effects/crest/4/trace_04_rotated/spriteFrame',
    'effects/crest/4/trace_05_rotated/spriteFrame',
    'effects/crest/4/trace_06_rotated/spriteFrame',
    'effects/crest/4/trace_07_rotated/spriteFrame',   // 亮球（命中）
];

/** 复用召唤光球的加色 effect（同一份 shader：贴图 × 节点色 × intensity，加色混合） */
const ADD_EFFECT_NAME = 'SummonOrbAdd';
const ADD_EFFECT_RES_PATH = 'effects/SummonOrbAdd';

/**
 * CrestBulletFx —— 纹章效果的「**子弹飞行**」演出（从纹章图标中心射向目标卡牌中心）
 * ===========================================================================
 * 需求（纹章 4「缜密之思」）：纹章触发时，从**纹章图标的中心**发射一颗子弹
 * 飞到**目标卡牌的中心**，然后目标卡牌播放破坏动画。
 *
 * ── 它只是**演出**，不参与结算 ──────────────────────────────────────────
 * 🔴 目标卡牌被破坏的**判定 / 数值 / 摘场 / 记墓场**全部发生在「纹章触发的那一瞬间」
 *    （`CrestEffects` → `destroyFieldCard`，同步执行），**不等**这颗子弹飞完。
 *    子弹是 `BattleCommandSystem` **演出队列**里排在 `Destroy` 之前的一段 cue
 *    （单通道 FIFO ⇒ 严格「先飞子弹、再播破坏动画」），队列是唯一等待方。
 *
 * ── 挂载 ────────────────────────────────────────────────────────────────
 * `Canvas/CrestBulletFx`（常驻节点，UITransform = 1280×720、锚点 0.5/0.5，与 CardDestroyFx 同款）。
 * 调用方只给两个**世界坐标**，组件自己换算到本节点本地空间。
 * 一次性特效**不挂在纹章图标 / 卡牌上**（两者都可能被销毁 / 被裁剪）——
 * 永远是本常驻节点下的临时子节点，播完 `killNode`。
 *
 * ── Inspector 暴露的变量（需求）────────────────────────────────────────
 *   ★ bulletSize  【特效大小（粗细）】基础尺寸（px）＝ 厚度 ≈0.36×本值、基础长度 ≈0.97×本值
 *   ★ bulletLengthK 【子弹长度】沿飞行方向拉伸的倍数（只改长度、不改粗细；1 = 素材原比例）
 *   ★ duration    【动画总时间】从纹章中心飞到卡牌中心的总时长（秒）
 *   ★ color       【颜色】子弹着色（默认黄色）
 *   另有两个观感开关：additive（加色发光）/ intensity（加色亮度倍数）。
 *
 * ── 时间轴（单条数值补间驱动 p，只有一次完成回调）──────────────────────
 *   p ∈ [0,1]：位置 = 两个世界坐标的**线性插值**（直线飞行，子弹不需要贝塞尔）；
 *   朝向 = `atan2(dy,dx)`（素材长边是 +X ⇒ 旋转到飞行方向，永远指向目标）；
 *   形态 = 7 帧按 p 顺序推进（细光条 → 电弧 → 亮球 = 命中）；
 *   透明度 = 前 12% 渐显，之后保持峰值（p=1 命中那一刻直接交给破坏动画，不做淡出）。
 * ===========================================================================
 */
@ccclass('CrestBulletFx')
@menu('gf2szb/CrestBulletFx')
export class CrestBulletFx extends Component {

    /** 场景里唯一的实例（调用方通过它播放；未挂载时为 null → 调用方跳过这段演出） */
    private static _inst: CrestBulletFx | null = null;
    public static get instance(): CrestBulletFx | null {
        return (CrestBulletFx._inst && CrestBulletFx._inst.isValid) ? CrestBulletFx._inst : null;
    }

    // ====================== ★ 需求：Inspector 暴露的三个变量 ======================
    @property({
        range: [8, 400, 1], slide: true,
        tooltip: '★【特效大小（粗细）】子弹的**基础尺寸**（px）：厚度 ≈ 0.36 × 本值，基础长度 ≈ 0.97 × 本值\n'
            + '（长度再用下面的「子弹长度」倍数拉伸，粗细只认本值）。\n'
            + '素材是 512×512 的横向光条，可见部分约占 97% 宽 × 36% 高。',
    })
    bulletSize = 96;

    @property({
        range: [0.05, 5, 0.01], slide: true,
        tooltip: '★【动画总时间】子弹从**纹章图标中心**飞到**目标卡牌中心**的总时长（秒）。\n'
            + '🔴 它只是演出时长：目标卡牌的破坏在纹章触发那一瞬间就已结算完（数据不等动画）。\n'
            + '0.5 ≈ 子弹速度；调大 = 慢动作、调小 = 快如闪光。',
    })
    duration = 0.5;

    @property({
        type: Color,
        tooltip: '★【颜色】子弹的着色（默认**黄色** 255,214,92）。\n'
            + '加色混合下 alpha 也参与亮度：把 alpha 调低 = 更柔和的黄光。',
    })
    color = new Color(255, 214, 92, 255);

    @property({
        range: [0.2, 5, 0.05], slide: true,
        tooltip: '★【子弹长度】沿**飞行方向**把光条拉伸的倍数（1 = 素材原比例，长 ≈ 0.97 × 特效大小）。\n'
            + '🔴 只改**长度**、不改粗细（粗细仍由上面的「特效大小（粗细）」决定）：\n'
            + '实际长边 = bulletSize × 0.97 × 本值，厚度 = bulletSize × 0.36 不变。\n'
            + '拉伸以**子弹中心**为基准左右对称加长（素材本身左右对称）；>3 时贴图会被明显放大、观感更虚。',
    })
    bulletLengthK = 1;

    // ====================== 观感开关 ======================
    @property({ tooltip: '是否用**加色（ADD）**混合（发光感）。关闭 = 普通 alpha 混合（在亮背景上更实）。' })
    additive = true;

    @property({
        range: [0, 4, 0.01], slide: true,
        tooltip: '加色亮度倍数（仅 additive = true 生效）。\n'
            + '🔴 别贪大：素材末两帧是近乎实心的亮球，intensity > 1.6 会整颗过曝成纯白（黄色丢失）。',
    })
    intensity = 1.0;

    // ====================== 素材（自动从 resources 加载）======================
    private readonly _frames: (SpriteFrame | null)[] = CREST_BULLET_TEX_PATHS.map(() => null);
    private _loadingFrames = false;
    private _effect: EffectAsset | null = null;
    private _loadingEffect = false;
    private _warned = false;

    // ====================== 正在播的一段（单飞）======================
    /** 当前这一段演出的收尾函数（再播一段时先把上一段收掉，绝不让演出队列卡住） */
    private _activeFinish: (() => void) | null = null;

    // ------------------------------ 生命周期 ------------------------------
    onLoad(): void {
        CrestBulletFx._inst = this;
        this.preload();
    }

    onEnable(): void {
        this.preload();
    }

    onDisable(): void {
        // 组件被关掉：把正在播的一段立刻收尾（清节点 + 回调 done），否则演出队列永远等下去
        if (this._activeFinish) this._activeFinish();
    }

    onDestroy(): void {
        if (CrestBulletFx._inst === this) CrestBulletFx._inst = null;
        if (this._activeFinish) this._activeFinish();
    }

    /** 素材是否已就绪（7 帧都在） */
    public get assetsReady(): boolean {
        return this._frames.every((f) => f !== null && f.isValid);
    }

    /** 预加载素材（幂等；场景启动时调一次，避免第一次触发纹章时贴图还没到） */
    public preload(): void {
        this.ensureAddEffect();
        if (this.assetsReady || this._loadingFrames) return;
        this._loadingFrames = true;
        let remain = CREST_BULLET_TEX_PATHS.length;
        CREST_BULLET_TEX_PATHS.forEach((path, i) => {
            resources.load(path, SpriteFrame, (err, sf) => {
                remain--;
                if (err || !sf) this.warnOnce(`加载子弹贴图失败："${path}"`, err);
                else this._frames[i] = sf as SpriteFrame;
                if (remain <= 0) this._loadingFrames = false;
            });
        });
    }

    private warnOnce(msg: string, err: unknown): void {
        if (this._warned) return;
        this._warned = true;
        console.warn('[CrestBulletFx] ' + msg + ' →', err);
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

    // ------------------------------ 播放 ------------------------------
    /**
     * 从 `fromWorld` 飞一颗子弹到 `toWorld`（两个**世界坐标**），播完回调 `onComplete`。
     * 🔴 `onComplete` 一定会被调用（且只一次）：素材没就绪 / 节点非法 / 组件被关掉 /
     *    补间异常 / **超时熔断**都保证放行 —— 演出队列是单通道的，少一次 done 就会全场停摆。
     */
    public play(fromWorld: Vec3, toWorld: Vec3, onComplete?: () => void): void {
        // 单飞：理论上演出队列已经串行，这里只是兜底（重入时先把上一段收掉）
        if (this._activeFinish) this._activeFinish();

        const done = onceGuard(() => { if (onComplete) safeCall(onComplete); });

        // 组件被关掉 / 节点不可用 = 这段特效「不存在」→ 直接放行（破坏动画照旧播）
        if (!this.enabled || !this.node || !this.node.isValid) { done(); return; }
        if (!fromWorld || !toWorld) { done(); return; }
        this.preload();
        if (!this.assetsReady) {
            this.warnOnce('子弹贴图未就绪，跳过本段演出', null);
            done();
            return;
        }

        const hostUT = this.node.getComponent(UITransform);
        const from = hostUT ? hostUT.convertToNodeSpaceAR(fromWorld, new Vec3()) : fromWorld.clone();
        const to = hostUT ? hostUT.convertToNodeSpaceAR(toWorld, new Vec3()) : toWorld.clone();

        const size = Math.max(8, this.bulletSize);
        // ★【子弹长度】沿飞行方向拉伸；节点被旋转到飞行方向 ⇒ 本地 X = 长边、本地 Y = 粗细
        const lenK = Math.max(0.05, this.bulletLengthK);
        // 🔴 alpha = 亮度的一部分（加色混合）：alpha=0 就整颗不可见，与 tooltip 口径一致
        const base = this.color ? new Color(this.color) : new Color(255, 214, 92, 255);
        const baseAlpha = Math.max(0, Math.min(255, base.a)) / 255;

        // 加色材质：每次播放新建一份（intensity 可独立），结束时 destroy
        let mat: Material | null = null;
        if (this.additive) {
            const eff = this.ensureAddEffect();
            if (eff) {
                mat = new Material();
                mat.initialize({ effectAsset: eff });
                mat.setProperty('intensity', Math.max(0, this.intensity));
            }
        }

        const fx = new Node(CREST_BULLET_NODE_NAME);
        fx.layer = this.node.layer;          // 🔴 必须继承宿主 layer（UI_2D 会被相机剔除，见铁律 60）
        fx.setParent(this.node);
        if (fx.parent) fx.setSiblingIndex(fx.parent.children.length - 1);   // 画在最上层
        const ut = fx.addComponent(UITransform);
        ut.setAnchorPoint(0.5, 0.5);
        ut.setContentSize(size * lenK, size);      // ★ 长边 = size × 长度倍数（粗细仍是 size）

        const sp = fx.addComponent(Sprite);
        sp.sizeMode = Sprite.SizeMode.CUSTOM;   // 🔴 默认 TRIMMED 会按裁剪框改写 contentSize
        sp.type = Sprite.Type.SIMPLE;
        sp.trim = false;                        // 整张 512×512 贴进方形节点 ⇒ 每帧保持素材原比例
        sp.spriteFrame = this._frames[0];
        if (mat) sp.customMaterial = mat;

        // 朝向：素材长边 = +X ⇒ 旋转到飞行方向（两个端点都已换到本节点本地空间）
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        fx.setRotationFromEuler(0, 0, Math.atan2(dy, dx) * 180 / Math.PI);
        fx.setPosition(from.x, from.y, 0);

        const col = new Color(base);
        col.a = 0;
        sp.color = col;

        // 单条数值补间驱动整条时间轴（只有一个完成回调，没有多条补间抢结束的竞态）
        const state = { p: 0 };
        const dur = Math.max(0.05, this.duration);
        let frameIndex = -1;
        let settled = false;

        const cleanup = (): void => {
            try { Tween.stopAllByTarget(state); } catch (e) { /* 忽略 */ }
            if (fx.isValid) { try { killNode(fx); } catch (e) { /* 忽略 */ } }
            if (mat && mat.isValid) { try { mat.destroy(); } catch (e) { /* 忽略 */ } }
        };
        const finish = (): void => {
            if (settled) return;
            settled = true;
            if (this._activeFinish === finish) this._activeFinish = null;
            cleanup();
            done();
        };
        this._activeFinish = finish;

        // 🔴 熔断：补间一旦被外部打断 / 被吞，这里必须在 dur 之后放行（否则演出队列永久卡住）。
        //    `scheduleOnce` 返回值是 void（不能 unschedule），所以这里只靠 settled 守卫空转一次。
        this.scheduleOnce(() => {
            if (settled) return;
            console.warn('[CrestBulletFx] 子弹演出超时未结束 → 强制放行演出队列');
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
                            fx.setPosition(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, 0);
                            // 形态：7 帧按进度推进（细光条 → 电弧 → 亮球「命中」）
                            const fi = Math.min(CREST_BULLET_TEX_PATHS.length - 1,
                                Math.floor(t * CREST_BULLET_TEX_PATHS.length));
                            if (fi !== frameIndex) {
                                frameIndex = fi;
                                const sf = this._frames[fi];
                                if (sf && sf.isValid) sp.spriteFrame = sf;
                            }
                            // 尺寸：起步略小、迅速涨满（发射的「窜出去」感）；长边再乘【子弹长度】倍数
                            const k = 0.72 + 0.28 * smoothstep(0, 0.22, t);
                            ut.setContentSize(size * k * lenK, size * k);
                            col.a = Math.round(255 * baseAlpha * smoothstep(0, 0.12, t));
                            sp.color = col;
                        } catch (e) { /* 单帧异常忽略，让演出继续 */ }
                    },
                })
                .call(() => finish())     // 🔴 不要在 .call 里提前置位：finish 自带守卫
                .start();
        } catch (e) {
            console.error('[CrestBulletFx] 子弹演出出错：', e);
            finish();
        }
    }

    /** 调试 / 探针：当前是否有子弹在飞 */
    public get isPlaying(): boolean {
        return this._activeFinish !== null;
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
    try { fn(); } catch (e) { console.error('[CrestBulletFx] 完成回调出错：', e); }
}
