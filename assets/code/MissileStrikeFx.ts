import {
    _decorator, Color, Component, EffectAsset, Material, Node, resources, Sprite, SpriteFrame,
    Tween, tween, UITransform, Vec3,
} from 'cc';
import { killNode } from './CardComposer';

const { ccclass, property, menu } = _decorator;

/** 运行期生成的导弹节点名（每次一发，命中后自行销毁） */
export const MISSILE_NODE_NAME = 'MissileShot';
/** 命中爆炸的节点名前缀 */
const BLAST_NODE_PREFIX = 'MissileBlast';
/** 尾迹烟团节点名前缀 */
const SMOKE_NODE_PREFIX = 'MissileSmoke';

/**
 * 导弹本体素材（7 帧：细光条 → 电弧 → 亮球），`resources` 路径（子资源带 `/spriteFrame`）。
 * 🔴 与毒弹共用同一套 `effects/Bullet/`，靠**节点色**染成黄色。
 */
export const MISSILE_TEX_PATHS: readonly string[] = [
    'effects/Bullet/trace_01_rotated/spriteFrame',
    'effects/Bullet/trace_02_rotated/spriteFrame',
    'effects/Bullet/trace_03_rotated/spriteFrame',
    'effects/Bullet/trace_04_rotated/spriteFrame',
    'effects/Bullet/trace_05_rotated/spriteFrame',
    'effects/Bullet/trace_06_rotated/spriteFrame',
    'effects/Bullet/trace_07_rotated/spriteFrame',
];

/** 弹头光晕（软光斑） */
const GLOW_TEX_PATHS: readonly string[] = [
    'effects/LightOrb/light_01/spriteFrame',
    'effects/LightOrb/light_02/spriteFrame',
    'effects/LightOrb/light_03/spriteFrame',
];

/** 尾迹烟团（复用潜行烟雾，染成暖灰黄） */
const SMOKE_TEX_PATHS: readonly string[] = [
    'effects/Ambush/AmbushSmoke_01/spriteFrame',
    'effects/Ambush/AmbushSmoke_03/spriteFrame',
    'effects/Ambush/AmbushSmoke_05/spriteFrame',
    'effects/Ambush/AmbushSmoke_07/spriteFrame',
];

/** 命中爆炸的闪焰 */
const BLAST_TEX_PATHS: readonly string[] = [
    'effects/CardDestroy/flare_0/spriteFrame',
];

/** 复用召唤光球的加色 effect（贴图 × 节点色 × intensity，加色混合） */
const ADD_EFFECT_NAME = 'SummonOrbAdd';
const ADD_EFFECT_RES_PATH = 'effects/SummonOrbAdd';

/**
 * MissileStrikeFx —— 「**导弹打击**」能力演出（卡 9「史上最强·威玛西娜」模式②：对所有敌方随从 8 点）
 * ===========================================================================
 * 需求：**模仿可露凯的毒弹**（同一套直线飞行 + 从目标右上方射入 + 落地特效 + 多目标同时），
 * 但——
 *   · **颜色改成黄色**（Inspector 上 `color`，默认 `255,214,92`）；
 *   · **风格是导弹**：弹头有亮芯、**弹尾拖一条膨胀的烟迹**、命中时炸**闪焰 + 火球**，
 *     并且带一点**加速**（导弹不是匀速，`accel` 控制）。
 *
 * 与毒弹的对应关系（参数名一致，方便对照调参）：
 *   毒弹 `length/thickness/maxDistance/tiltAngle/duration` ↔ 导弹同名参数；
 *   毒弹的「毒液拖尾（droplets）」↔ 导弹的「尾迹烟团（smokeCount/smokeSize）」；
 *   毒弹的「命中毒雾（mist）」↔ 导弹的「命中爆炸（blastSize/blastDuration）」。
 *
 * 🔴 只是**演出**：伤害与破坏在能力结算那一瞬间就同步做完了，不等导弹飞完。
 * 🔴 **支持多目标同时飞**（一次打全场 ⇒ 每个目标一发，全部一起开播、全飞完才放行演出队列）。
 * 🔴 `done` 一定会被调用（素材缺失 / 节点非法 / 组件被关 / 补间异常 / 超时熔断都保证放行）。
 * ===========================================================================
 */
@ccclass('MissileStrikeFx')
@menu('gf2szb/MissileStrikeFx')
export class MissileStrikeFx extends Component {

    private static _inst: MissileStrikeFx | null = null;
    public static get instance(): MissileStrikeFx | null {
        return (MissileStrikeFx._inst && MissileStrikeFx._inst.isValid) ? MissileStrikeFx._inst : null;
    }

    // ====================== ★ 与毒弹同名的核心变量 ======================
    @property({ type: Color, tooltip: '★【导弹颜色】默认**黄色** 255,214,92（需求）。加色混合下 alpha 也参与亮度。' })
    color = new Color(255, 214, 92, 255);

    @property({ range: [8, 600, 1], slide: true, tooltip: '★【导弹长短】弹体长边（px）。' })
    length = 170;

    @property({ range: [2, 160, 1], slide: true, tooltip: '★【导弹粗细】弹体厚度（px）。' })
    thickness = 52;

    @property({ range: [20, 1400, 1], slide: true, tooltip: '★【最远出现距离】出场点离目标的距离（px）。默认 300：敌方那排也能全程可见。' })
    maxDistance = 300;

    @property({ range: [-180, 180, 1], slide: true, tooltip: '★【入射角度】0 = 正右方，正值 = 上方。默认 **62°**（导弹更像从高处砸下来）。' })
    tiltAngle = 62;

    @property({ range: [0.05, 3, 0.01], slide: true, tooltip: '★【飞行时长】从出场点飞到目标的总时长（秒）。' })
    duration = 0.5;

    @property({ range: [0.5, 2, 0.01], slide: true, tooltip: '【加速】1 = 匀速；> 1 = 越飞越快（导弹感）。进度 = t^accel。' })
    accel = 1.35;

    // ====================== 导弹风格扩展 ======================
    @property({ range: [0, 400, 1], slide: true, tooltip: '【弹头亮芯】弹头光斑大小（px）。0 = 不要。' })
    glowSize = 140;

    @property({ range: [0, 24, 1], slide: true, tooltip: '【尾迹烟团】弹尾拖几团烟。0 = 不要尾迹。' })
    smokeCount = 5;

    @property({ range: [8, 300, 1], slide: true, tooltip: '【烟团大小】第一团烟的基准尺寸（px，越往后越大）。' })
    smokeSize = 62;

    @property({ range: [0, 600, 1], slide: true, tooltip: '【命中爆炸大小】命中闪焰 / 火球的大小（px）。0 = 不要爆炸。' })
    blastSize = 260;

    @property({ range: [0.1, 3, 0.01], slide: true, tooltip: '【爆炸时长】闪焰从绽开到散尽的时长（秒）。不占演出队列。' })
    blastDuration = 0.5;

    // ====================== 观感开关 ======================
    @property({ tooltip: '是否用**加色（ADD）**混合（发光感）。' })
    additive = true;

    @property({ range: [0, 4, 0.01], slide: true, tooltip: '加色亮度倍数。别贪大：> 1.8 容易整颗过曝成纯白（黄色丢失）。' })
    intensity = 1.15;

    // ====================== 素材 ======================
    private readonly _frames: (SpriteFrame | null)[] = MISSILE_TEX_PATHS.map(() => null);
    private readonly _glows: (SpriteFrame | null)[] = GLOW_TEX_PATHS.map(() => null);
    private readonly _smokes: (SpriteFrame | null)[] = SMOKE_TEX_PATHS.map(() => null);
    private readonly _blasts: (SpriteFrame | null)[] = BLAST_TEX_PATHS.map(() => null);
    private _loading = false;
    private _effect: EffectAsset | null = null;
    private _loadingEffect = false;
    private _warned = false;
    private readonly _liveSmoke: Node[] = [];
    private readonly _actives = new Set<() => void>();

    // ------------------------------ 生命周期 ------------------------------
    onLoad(): void { MissileStrikeFx._inst = this; this.preload(); }
    onEnable(): void { this.preload(); }
    onDisable(): void { this.finishAll(); this.clearSmoke(); }
    onDestroy(): void {
        if (MissileStrikeFx._inst === this) MissileStrikeFx._inst = null;
        this.finishAll();
        this.clearSmoke();
    }

    private finishAll(): void {
        for (const f of Array.from(this._actives)) {
            try { f(); } catch (e) { /* 单发异常不影响其它 */ }
        }
        this._actives.clear();
    }

    public get assetsReady(): boolean {
        return this._frames.every((f) => f !== null && f.isValid);
    }

    /** 调试 / 探针：当前同时在飞的导弹数 */
    public get flyingCount(): number { return this._actives.size; }

    public preload(): void {
        this.ensureAddEffect();
        if (this.assetsReady || this._loading) return;
        this._loading = true;
        const jobs: Array<{ path: string; put: (sf: SpriteFrame) => void }> = [];
        MISSILE_TEX_PATHS.forEach((p, i) => jobs.push({ path: p, put: (sf) => { this._frames[i] = sf; } }));
        GLOW_TEX_PATHS.forEach((p, i) => jobs.push({ path: p, put: (sf) => { this._glows[i] = sf; } }));
        SMOKE_TEX_PATHS.forEach((p, i) => jobs.push({ path: p, put: (sf) => { this._smokes[i] = sf; } }));
        BLAST_TEX_PATHS.forEach((p, i) => jobs.push({ path: p, put: (sf) => { this._blasts[i] = sf; } }));
        let remain = jobs.length;
        for (const job of jobs) {
            resources.load(job.path, SpriteFrame, (err, sf) => {
                remain--;
                if (err || !sf) this.warnOnce(`加载导弹贴图失败："${job.path}"`, err);
                else job.put(sf as SpriteFrame);
                if (remain <= 0) this._loading = false;
            });
        }
    }

    private warnOnce(msg: string, err: unknown): void {
        if (this._warned) return;
        this._warned = true;
        console.warn('[MissileStrikeFx] ' + msg + ' →', err);
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
     * 朝 `toWorld`（目标卡牌世界坐标）打一发导弹。**支持同时多发**（每个目标一发）。
     * @param onComplete 一定被调用（且只一次）
     */
    /** ★ 本次调用的颜色覆盖（卡 15 的单体分支要「红色火焰子弹」，其余仍是原色）。 */
    private _colorOverride: Color | null = null;

    public play(toWorld: Vec3, onComplete?: () => void, colorOverride?: Color | null): void {
        // ★ 本次演出换色：临时替换组件的 color（演出是队列串行的，不会并发），结束时还原。
        const _savedColor = this.color ? new Color(this.color) : null;
        if (colorOverride) this.color = new Color(colorOverride);
        const _restoreColor = (): void => { if (_savedColor) this.color = _savedColor; };
        const done = onceGuard(() => { _restoreColor(); if (onComplete) safeCall(onComplete); });
        if (!this.enabled || !this.node || !this.node.isValid) { done(); return; }
        if (!toWorld) { done(); return; }
        this.preload();
        if (!this.assetsReady) {
            this.warnOnce('导弹贴图未就绪，跳过本段演出', null);
            done();
            return;
        }

        const hostUT = this.node.getComponent(UITransform);
        const to = hostUT ? hostUT.convertToNodeSpaceAR(toWorld, new Vec3()) : toWorld.clone();

        const ang = (Number.isFinite(this.tiltAngle) ? this.tiltAngle : 62) * Math.PI / 180;
        const dist = Math.max(0, this.maxDistance);
        const from = new Vec3(to.x + Math.cos(ang) * dist, to.y + Math.sin(ang) * dist, 0);
        const rotDeg = Math.atan2(to.y - from.y, to.x - from.x) * 180 / Math.PI;

        const base = this.color ? new Color(this.color) : new Color(255, 214, 92, 255);
        const baseAlpha = Math.max(0, Math.min(255, base.a)) / 255;
        const mat = this.makeMaterial();

        // ---- 弹体 ----
        const fx = new Node(MISSILE_NODE_NAME);
        fx.layer = this.node.layer;
        fx.setParent(this.node);
        if (fx.parent) fx.setSiblingIndex(fx.parent.children.length - 1);
        const ut = fx.addComponent(UITransform);
        ut.setAnchorPoint(0.5, 0.5);
        const lenW = Math.max(8, this.length);
        const thickH = Math.max(2, this.thickness);
        ut.setContentSize(lenW, thickH);
        const sp = fx.addComponent(Sprite);
        sp.sizeMode = Sprite.SizeMode.CUSTOM;
        sp.type = Sprite.Type.SIMPLE;
        sp.trim = false;
        sp.spriteFrame = this._frames[0];
        if (mat) sp.customMaterial = mat;
        fx.setRotationFromEuler(0, 0, rotDeg);
        fx.setPosition(from.x, from.y, 0);
        const bulletCol = new Color(base);
        bulletCol.a = 0;
        sp.color = bulletCol;

        const dir = new Vec3(to.x - from.x, to.y - from.y, 0);
        if (dir.length() > 0.0001) dir.normalize();

        // ---- 弹头亮芯 ----
        let glow: Node | null = null;
        let glowSp: Sprite | null = null;
        const glowCol = new Color(base);
        if (this.glowSize > 0 && this._glows.some((g) => !!g && g.isValid)) {
            glow = new Node('MissileGlow');
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

        // ---- 尾迹烟团（越往后越大越淡）----
        const smokes: Array<{ node: Node; sp: Sprite; lag: number; k: number; col: Color }> = [];
        const smokeN = Math.max(0, Math.round(this.smokeCount));
        const smokeFrames = this._smokes.filter((f) => !!f && f.isValid);
        for (let i = 0; i < smokeN; i++) {
            if (smokeFrames.length === 0) break;
            const n = new Node(SMOKE_NODE_PREFIX + '_' + i);
            n.layer = this.node.layer;
            n.setParent(this.node);
            const sut = n.addComponent(UITransform);
            sut.setAnchorPoint(0.5, 0.5);
            const size = Math.max(8, this.smokeSize) * (1 + 0.28 * i);
            sut.setContentSize(size, size);
            const ssp = n.addComponent(Sprite);
            ssp.sizeMode = Sprite.SizeMode.CUSTOM;
            ssp.type = Sprite.Type.SIMPLE;
            ssp.spriteFrame = smokeFrames[i % smokeFrames.length];
            if (mat) ssp.customMaterial = mat;
            const sc = new Color(base);
            sc.a = 0;
            ssp.color = sc;
            n.setPosition(from.x, from.y, 0);
            smokes.push({ node: n, sp: ssp, lag: 0.05 * (i + 1), k: 1 + 0.28 * i, col: sc });
        }

        const state = { p: 0 };
        const dur = Math.max(0.05, this.duration);
        const accel = Math.max(0.5, this.accel);
        let frameIndex = -1;
        let settled = false;
        let blastDone = false;

        const cleanup = (): void => {
            try { Tween.stopAllByTarget(state); } catch (e) { /* 忽略 */ }
            for (const n of [fx, glow]) {
                if (n && n.isValid) { try { killNode(n); } catch (e) { /* 忽略 */ } }
            }
            for (const s of smokes) {
                if (s.node && s.node.isValid) { try { killNode(s.node); } catch (e) { /* 忽略 */ } }
            }
            if (mat && mat.isValid) { try { mat.destroy(); } catch (e) { /* 忽略 */ } }
        };
        const finish = (): void => {
            if (settled) return;
            settled = true;
            this._actives.delete(finish);
            cleanup();
            done();
        };
        this._actives.add(finish);
        this.scheduleOnce(() => {
            if (settled) return;
            console.warn('[MissileStrikeFx] 导弹演出超时未结束 → 强制放行演出队列');
            finish();
        }, dur + 0.6);

        try {
            tween(state)
                .to(dur, { p: 1 }, {
                    easing: 'linear',
                    onUpdate: () => {
                        if (settled) return;
                        try {
                            const raw = Math.max(0, Math.min(1, state.p));
                            const t = Math.pow(raw, accel);          // ★ 导弹：越飞越快
                            const x = from.x + (to.x - from.x) * t;
                            const y = from.y + (to.y - from.y) * t;
                            fx.setPosition(x, y, 0);
                            const k = 0.85 + 0.15 * smoothstep(0, 0.2, raw);
                            ut.setContentSize(lenW * k, thickH * k);
                            const fadeIn = smoothstep(0, 0.08, raw);
                            const fadeOut = 1 - smoothstep(0.94, 1, raw);
                            bulletCol.a = Math.round(255 * baseAlpha * fadeIn * fadeOut);
                            sp.color = bulletCol;
                            const fi = Math.min(MISSILE_TEX_PATHS.length - 1,
                                Math.floor(raw * MISSILE_TEX_PATHS.length));
                            if (fi !== frameIndex) {
                                frameIndex = fi;
                                const sf = this._frames[fi];
                                if (sf && sf.isValid) sp.spriteFrame = sf;
                            }
                            // 弹头亮芯
                            if (glow && glow.isValid && glowSp) {
                                glow.setPosition(x + dir.x * lenW * 0.5 * k, y + dir.y * lenW * 0.5 * k, 0);
                                const gs = 1 + 0.22 * Math.sin(raw * Math.PI);
                                const gut = glow.getComponent(UITransform);
                                if (gut) gut.setContentSize(this.glowSize * gs, this.glowSize * gs);
                                glowCol.a = Math.round(255 * baseAlpha * 0.85 * fadeIn * fadeOut);
                                glowSp.color = glowCol;
                            }
                            // 尾迹烟团：滞后 + 各自膨胀 + 淡出
                            for (const s of smokes) {
                                if (!s.node || !s.node.isValid) continue;
                                const st = Math.max(0, Math.min(1, t - s.lag));
                                s.node.setPosition(from.x + (to.x - from.x) * st, from.y + (to.y - from.y) * st, 0);
                                const grow = s.k * (1 + 0.5 * st);
                                const sut = s.node.getComponent(UITransform);
                                if (sut) {
                                    const base0 = Math.max(8, this.smokeSize);
                                    sut.setContentSize(base0 * grow, base0 * grow);
                                }
                                s.col.a = Math.round(255 * baseAlpha * 0.5 * smoothstep(0, 0.12, st) * (1 - smoothstep(0.75, 1, st)));
                                s.sp.color = s.col;
                            }
                            // 命中爆炸
                            if (!blastDone && raw >= 0.92) {
                                blastDone = true;
                                this.spawnBlast(to, baseAlpha);
                            }
                        } catch (e) { /* 单帧异常忽略 */ }
                    },
                })
                .call(() => finish())
                .start();
        } catch (e) {
            console.error('[MissileStrikeFx] 导弹演出出错：', e);
            finish();
        }
    }

    // ------------------------------ 命中爆炸 ------------------------------
    /** 命中处炸一团「闪焰 + 火球」（独立补间、自行收尾，不占演出队列） */
    private spawnBlast(at: Vec3, baseAlpha: number): void {
        if (this.blastSize <= 0) return;
        const frames = this._blasts.filter((f) => !!f && f.isValid);
        const glows = this._glows.filter((f) => !!f && f.isValid);
        const pool = frames.length > 0 ? frames : glows;
        if (pool.length === 0) return;
        const base = this.color ? new Color(this.color) : new Color(255, 214, 92, 255);
        const dur = Math.max(0.1, this.blastDuration);
        const count = frames.length > 0 ? 2 : 1;              // 闪焰 + 一层火球
        for (let i = 0; i < count; i++) {
            const n = new Node(BLAST_NODE_PREFIX + '_' + i);
            n.layer = this.node.layer;
            n.setParent(this.node);
            if (n.parent) n.setSiblingIndex(n.parent.children.length - 1);
            const ut = n.addComponent(UITransform);
            ut.setAnchorPoint(0.5, 0.5);
            const size = Math.max(20, this.blastSize) * (i === 0 ? 1 : 1.35);
            ut.setContentSize(size, size);
            const sp = n.addComponent(Sprite);
            sp.sizeMode = Sprite.SizeMode.CUSTOM;
            sp.type = Sprite.Type.SIMPLE;
            sp.spriteFrame = i === 0 ? pool[0] : (glows[glows.length - 1] || pool[0]);
            const mat = this.makeMaterial();
            if (mat) sp.customMaterial = mat;
            const col = new Color(base);
            col.a = 0;
            sp.color = col;
            n.setPosition(at.x, at.y, 0);
            n.setScale(0.5, 0.5, 1);
            this._liveSmoke.push(n);

            const st = { p: 0 };
            let done = false;
            const finishBlast = (): void => {
                if (done) return;
                done = true;
                const idx = this._liveSmoke.indexOf(n);
                if (idx >= 0) this._liveSmoke.splice(idx, 1);
                try { Tween.stopAllByTarget(st); } catch (e) { /* 忽略 */ }
                if (n.isValid) { try { killNode(n); } catch (e) { /* 忽略 */ } }
                if (mat && mat.isValid) { try { mat.destroy(); } catch (e) { /* 忽略 */ } }
            };
            this.scheduleOnce(() => { if (!done) finishBlast(); }, dur + 0.5);
            try {
                tween(st)
                    .to(dur, { p: 1 }, {
                        easing: 'quadOut',
                        onUpdate: () => {
                            if (done) return;
                            try {
                                const t = Math.max(0, Math.min(1, st.p));
                                const s = 0.5 + 0.9 * t;
                                n.setScale(s, s, 1);
                                col.a = Math.round(255 * baseAlpha * 0.95 * Math.sin(Math.PI * Math.min(1, t * 1.05)));
                                sp.color = col;
                            } catch (e) { /* 忽略 */ }
                        },
                    })
                    .call(() => finishBlast())
                    .start();
            } catch (e) {
                finishBlast();
            }
        }
    }

    private clearSmoke(): void {
        for (const n of this._liveSmoke.slice()) {
            if (n && n.isValid) { try { killNode(n); } catch (e) { /* 忽略 */ } }
        }
        this._liveSmoke.length = 0;
    }
}

// ============================================================================
// 工具
// ============================================================================
function smoothstep(a: number, b: number, x: number): number {
    const t = Math.max(0, Math.min(1, (b - a) === 0 ? (x >= b ? 1 : 0) : (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
}

function onceGuard(fn: () => void): () => void {
    let called = false;
    return () => {
        if (called) return;
        called = true;
        fn();
    };
}

function safeCall(fn: () => void): void {
    try { fn(); } catch (e) { console.error('[MissileStrikeFx] 完成回调出错：', e); }
}
