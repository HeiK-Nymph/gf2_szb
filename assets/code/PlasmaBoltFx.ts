import {
    _decorator, Color, Component, EffectAsset, Material, Node, resources, Sprite, SpriteFrame,
    Tween, tween, UITransform, Vec3,
} from 'cc';
import { killNode } from './CardComposer';

const { ccclass, property, menu } = _decorator;

/** 运行期生成的闪电节点名（一次一发，命中后自行销毁） */
export const PLASMA_NODE_NAME = 'PlasmaBoltShot';
/** 命中电浆爆裂的节点名前缀 */
const BLAST_NODE_PREFIX = 'PlasmaBlast';
/** 闪电分段节点名前缀 */
const SEG_NODE_PREFIX = 'PlasmaSeg';

/** 弹体素材（细光条 → 电弧 → 亮球），`resources` 路径（子资源带 `/spriteFrame`） */
const BOLT_TEX_PATHS: readonly string[] = [
    'effects/Bullet/trace_01_rotated/spriteFrame',
    'effects/Bullet/trace_03_rotated/spriteFrame',
    'effects/Bullet/trace_05_rotated/spriteFrame',
    'effects/Bullet/trace_07_rotated/spriteFrame',
];
/** 弹头 / 爆裂光斑（软光球，被节点色染成电浆青） */
const GLOW_TEX_PATHS: readonly string[] = [
    'effects/LightOrb/light_01/spriteFrame',
    'effects/LightOrb/light_03/spriteFrame',
];
/** 命中闪焰 */
const BLAST_TEX_PATHS: readonly string[] = [
    'effects/CardDestroy/flare_0/spriteFrame',
];
const ADD_EFFECT_NAME = 'SummonOrbAdd';
const ADD_EFFECT_RES_PATH = 'effects/SummonOrbAdd';

/**
 * PlasmaBoltFx —— 「**电浆弹**」攻击演出（卡 12「自巡炮」的攻击特性）
 * ===========================================================================
 * 需求：**参照纹章4 的子弹特效**（同一条直线飞行：从攻击者飞向目标、命中处炸一下），
 * 但**风格改成闪电 / 电浆**：
 *   · 弹体不是一整根光条，而是 **N 段短电弧**沿飞行方向串起来，每段**随机偏折 + 随机抖动**，
 *     并每隔一小段时间**重新随机一次** ⇒ 视觉上就是噼啪乱窜的闪电；
 *   · 颜色默认**电浆青** `150,225,255`（Inspector 上可改）；
 *   · 命中处炸一团**电浆爆裂**（闪焰 + 光球）。
 *
 * 🔴 只是**演出**：伤害在结算那一瞬间就做完了，不等闪电飞完。
 * 🔴 `done` 一定被调用（素材缺失 / 节点非法 / 组件被关 / 超时熔断都保证放行）。
 * ===========================================================================
 */
@ccclass('PlasmaBoltFx')
@menu('gf2szb/PlasmaBoltFx')
export class PlasmaBoltFx extends Component {

    private static _inst: PlasmaBoltFx | null = null;
    public static get instance(): PlasmaBoltFx | null {
        return (PlasmaBoltFx._inst && PlasmaBoltFx._inst.isValid) ? PlasmaBoltFx._inst : null;
    }

    @property({ type: Color, tooltip: '★【电浆颜色】默认**电浆青** 150,225,255。加色混合下 alpha 也参与亮度。' })
    color = new Color(150, 225, 255, 255);

    @property({ range: [0.05, 3, 0.01], slide: true, tooltip: '★【飞行时长】从攻击者飞到目标的时长（秒）。' })
    duration = 0.34;

    @property({ range: [3, 24, 1], slide: true, tooltip: '★【电弧段数】沿飞行方向串几段电弧（越多越碎、越像闪电）。' })
    segmentCount = 9;

    @property({ range: [8, 400, 1], slide: true, tooltip: '★【单段长度】每段电弧的长度（px）。' })
    segmentLength = 74;

    @property({ range: [2, 160, 1], slide: true, tooltip: '★【粗细】电弧的厚度（px）。' })
    thickness = 26;

    @property({ range: [0, 160, 1], slide: true, tooltip: '★【抖动幅度】每段电弧**垂直方向**随机偏折的最大距离（px）。0 = 笔直一条。' })
    jitter = 34;

    @property({ range: [-60, 60, 1], slide: true, tooltip: '【每段偏转角】每段相对飞行方向的随机偏转上限（度）。' })
    segmentTilt = 26;

    @property({ range: [0.01, 0.5, 0.005], slide: true, tooltip: '【重随机间隔】每隔多久重新随机一次电弧形状（秒）——越小越「噼啪」。' })
    reseedInterval = 0.045;

    @property({ range: [0, 400, 1], slide: true, tooltip: '【弹头光核】弹头光斑大小（px）。0 = 不要。' })
    glowSize = 90;

    @property({ range: [0, 600, 1], slide: true, tooltip: '【命中爆裂大小】命中处电浆爆裂的大小（px）。0 = 不要。' })
    blastSize = 210;

    @property({ range: [0.1, 3, 0.01], slide: true, tooltip: '【爆裂时长】爆裂从绽开到散尽的时长（秒）。不占演出队列。' })
    blastDuration = 0.42;

    @property({ tooltip: '是否用**加色（ADD）**混合（发光感）。' })
    additive = true;

    @property({ range: [0, 4, 0.01], slide: true, tooltip: '加色亮度倍数。> 1.8 容易整颗过曝成纯白（青色丢失）。' })
    intensity = 1.1;

    private readonly _bolts: (SpriteFrame | null)[] = BOLT_TEX_PATHS.map(() => null);
    private readonly _glows: (SpriteFrame | null)[] = GLOW_TEX_PATHS.map(() => null);
    private readonly _blasts: (SpriteFrame | null)[] = BLAST_TEX_PATHS.map(() => null);
    private _loading = false;
    private _effect: EffectAsset | null = null;
    private _loadingEffect = false;
    private _warned = false;
    private readonly _actives = new Set<() => void>();
    private readonly _live: Node[] = [];

    onLoad(): void { PlasmaBoltFx._inst = this; this.preload(); }
    onEnable(): void { this.preload(); }
    onDisable(): void { this.finishAll(); this.clearLive(); }
    onDestroy(): void {
        if (PlasmaBoltFx._inst === this) PlasmaBoltFx._inst = null;
        this.finishAll();
        this.clearLive();
    }

    private finishAll(): void {
        for (const f of Array.from(this._actives)) { try { f(); } catch (e) { /* 忽略 */ } }
        this._actives.clear();
    }

    public get flyingCount(): number { return this._actives.size; }

    public preload(): void {
        this.ensureAddEffect();
        if (this._loading || this.assetsReady) return;
        this._loading = true;
        const jobs: Array<{ path: string; put: (sf: SpriteFrame) => void }> = [];
        BOLT_TEX_PATHS.forEach((p, i) => jobs.push({ path: p, put: (sf) => { this._bolts[i] = sf; } }));
        GLOW_TEX_PATHS.forEach((p, i) => jobs.push({ path: p, put: (sf) => { this._glows[i] = sf; } }));
        BLAST_TEX_PATHS.forEach((p, i) => jobs.push({ path: p, put: (sf) => { this._blasts[i] = sf; } }));
        let remain = jobs.length;
        for (const job of jobs) {
            resources.load(job.path, SpriteFrame, (err, sf) => {
                remain--;
                if (err || !sf) this.warnOnce(`加载电浆贴图失败："${job.path}"`, err);
                else job.put(sf as SpriteFrame);
                if (remain <= 0) this._loading = false;
            });
        }
    }

    public get assetsReady(): boolean {
        return this._bolts.some((f) => !!f && f.isValid);
    }

    private warnOnce(msg: string, err: unknown): void {
        if (this._warned) return;
        this._warned = true;
        console.warn('[PlasmaBoltFx] ' + msg + ' →', err);
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

    /**
     * 从 `fromWorld`（攻击者）朝 `toWorld`（目标）打一道电浆闪电。
     * @param onComplete 一定被调用（且只一次）
     */
    public play(fromWorld: Vec3, toWorld: Vec3, onComplete?: () => void, colorOverride?: Color | null): void {
        // ★ 本次演出换色（卡 17 的攻击特效要暗红）：临时替换组件 color，结束时还原。
        const _savedColor = this.color ? new Color(this.color) : null;
        if (colorOverride) this.color = new Color(colorOverride);
        const _restoreColor = (): void => { if (_savedColor) this.color = _savedColor; };
        let called = false;
        const done = (): void => {
            if (called) return;
            called = true;
            _restoreColor();
            try { if (onComplete) onComplete(); } catch (e) { console.error('[PlasmaBoltFx] 完成回调出错：', e); }
        };
        if (!this.enabled || !this.node || !this.node.isValid || !fromWorld || !toWorld) { done(); return; }
        this.preload();
        if (!this.assetsReady) { this.warnOnce('电浆贴图未就绪，跳过本段演出', null); done(); return; }

        const hostUT = this.node.getComponent(UITransform);
        const from = hostUT ? hostUT.convertToNodeSpaceAR(fromWorld, new Vec3()) : fromWorld.clone();
        const to = hostUT ? hostUT.convertToNodeSpaceAR(toWorld, new Vec3()) : toWorld.clone();

        const base = this.color ? new Color(this.color) : new Color(150, 225, 255, 255);
        const baseAlpha = Math.max(0, Math.min(255, base.a)) / 255;
        const mat = this.makeMaterial();
        const dir = new Vec3(to.x - from.x, to.y - from.y, 0);
        const total = dir.length();
        if (total < 0.001) { done(); return; }
        dir.normalize();
        const perp = new Vec3(-dir.y, dir.x, 0);
        const rotDeg = Math.atan2(dir.y, dir.x) * 180 / Math.PI;

        const segN = Math.max(3, Math.round(this.segmentCount));
        const segLen = Math.max(8, this.segmentLength);
        const thick = Math.max(2, this.thickness);
        const jitter = Math.max(0, this.jitter);
        const tilt = Math.max(0, this.segmentTilt);
        const frames = this._bolts.filter((f) => !!f && f.isValid);
        if (frames.length === 0) { done(); return; }

        // ---- 电弧分段（沿飞行方向均匀铺开，每段各自抖动/偏转）----
        const segs: Array<{ node: Node; sp: Sprite; col: Color; t: number }> = [];
        const segCols: Color[] = [];
        for (let i = 0; i < segN; i++) {
            const n = new Node(SEG_NODE_PREFIX + '_' + i);
            n.layer = this.node.layer;
            n.setParent(this.node);
            if (n.parent) n.setSiblingIndex(n.parent.children.length - 1);
            const ut = n.addComponent(UITransform);
            ut.setAnchorPoint(0.5, 0.5);
            ut.setContentSize(segLen, thick);
            const sp = n.addComponent(Sprite);
            sp.sizeMode = Sprite.SizeMode.CUSTOM;
            sp.type = Sprite.Type.SIMPLE;
            sp.spriteFrame = frames[i % frames.length];
            if (mat) sp.customMaterial = mat;
            const col = new Color(base);
            col.a = 0;
            sp.color = col;
            segCols.push(col);
            segs.push({ node: n, sp, col, t: (i + 0.5) / segN });
            this._live.push(n);
        }

        // ---- 弹头光核 ----
        let glow: Node | null = null;
        let glowSp: Sprite | null = null;
        const glowCol = new Color(base);
        if (this.glowSize > 0 && this._glows.some((g) => !!g && g.isValid)) {
            glow = new Node('PlasmaHead');
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
            this._live.push(glow);
        }

        /** 重新随机一次电弧形状（每段：沿线位置 + 垂直抖动 + 随机偏转） */
        const reseed = (): void => {
            for (const s of segs) {
                if (!s.node || !s.node.isValid) continue;
                const along = s.t + (Math.random() - 0.5) * 0.06;
                const off = (Math.random() - 0.5) * 2 * jitter;
                s.node.setPosition(from.x + dir.x * total * along + perp.x * off,
                    from.y + dir.y * total * along + perp.y * off, 0);
                s.node.setRotationFromEuler(0, 0, rotDeg + (Math.random() - 0.5) * 2 * tilt);
            }
        };
        reseed();

        const state = { p: 0 };
        const dur = Math.max(0.05, this.duration);
        const reseedEvery = Math.max(0.01, this.reseedInterval);
        let acc = 0;
        let settled = false;

        const cleanup = (): void => {
            try { Tween.stopAllByTarget(state); } catch (e) { /* 忽略 */ }
            for (const n of this._live.slice()) {
                if (n && n.isValid) { try { killNode(n); } catch (e) { /* 忽略 */ } }
            }
            this._live.length = 0;
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
            console.warn('[PlasmaBoltFx] 电浆演出超时未结束 → 强制放行演出队列');
            finish();
        }, dur + 0.6);

        // ---- 沿飞行方向整体推进（分段随进度「流动」，头部到达目标即命中）----
        const head = new Vec3(from.x, from.y, 0);
        try {
            tween(state)
                .to(dur, { p: 1 }, {
                    easing: 'quadOut',
                    onUpdate: (target?: unknown, ratio?: number) => {
                        if (settled) return;
                        try {
                            const t = Math.max(0, Math.min(1, typeof ratio === 'number' ? ratio : state.p));
                            // 整条闪电沿方向**流动**：把分段按进度往前推一个身位（首段从攻击者冒出、末段打到目标）
                            const lead = -segLen * (1 - t);
                            head.set(from.x + dir.x * (total * t), from.y + dir.y * (total * t), 0);
                            for (const s of segs) {
                                if (!s.node || !s.node.isValid) continue;
                                const pos = s.node.position;
                                const along = Math.max(0, Math.min(1, s.t)) * total + lead;
                                const off = (Math.random() - 0.5) * 2 * jitter * 0.35;   // 每帧微抖
                                s.node.setPosition(from.x + dir.x * along + perp.x * off,
                                    from.y + dir.y * along + perp.y * off, pos.z);
                                // 电弧闪烁：随机亮度
                                const flick = 0.55 + 0.45 * Math.random();
                                s.col.a = Math.round(255 * baseAlpha * flick * (1 - Math.max(0, t - 0.9) * 10 > 0 ? 1 : 0));
                                s.sp.color = s.col;
                            }
                            if (glow && glow.isValid && glowSp) {
                                glow.setPosition(head.x, head.y, 0);
                                const gs = 0.85 + 0.3 * Math.random();
                                const gut = glow.getComponent(UITransform);
                                if (gut) gut.setContentSize(this.glowSize * gs, this.glowSize * gs);
                                glowCol.a = Math.round(255 * baseAlpha * 0.9 * (1 - Math.max(0, t - 0.9) * 10));
                                glowSp.color = glowCol;
                            }
                            acc += 1 / 60;
                            if (acc >= reseedEvery) { acc = 0; reseed(); }
                        } catch (e) { /* 单帧异常忽略 */ }
                    },
                })
                .call(() => {
                    if (!settled) this.spawnBlast(to, baseAlpha);
                    finish();
                })
                .start();
        } catch (e) {
            console.error('[PlasmaBoltFx] 电浆演出出错：', e);
            finish();
        }
    }

    /** 命中处炸一团电浆爆裂（独立补间，自行收尾，不占演出队列） */
    private spawnBlast(at: Vec3, baseAlpha: number): void {
        if (this.blastSize <= 0) return;
        const frames = this._blasts.filter((f) => !!f && f.isValid);
        const glows = this._glows.filter((f) => !!f && f.isValid);
        const pool = frames.length > 0 ? frames : glows;
        if (pool.length === 0) return;
        const base = this.color ? new Color(this.color) : new Color(150, 225, 255, 255);
        const dur = Math.max(0.1, this.blastDuration);
        const count = frames.length > 0 ? 2 : 1;
        for (let i = 0; i < count; i++) {
            const n = new Node(BLAST_NODE_PREFIX + '_' + i);
            n.layer = this.node.layer;
            n.setParent(this.node);
            if (n.parent) n.setSiblingIndex(n.parent.children.length - 1);
            const ut = n.addComponent(UITransform);
            ut.setAnchorPoint(0.5, 0.5);
            const size = Math.max(20, this.blastSize) * (i === 0 ? 1 : 1.4);
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
            n.setScale(0.45, 0.45, 1);
            this._live.push(n);
            const st = { p: 0 };
            let done = false;
            const finishBlast = (): void => {
                if (done) return;
                done = true;
                const idx = this._live.indexOf(n);
                if (idx >= 0) this._live.splice(idx, 1);
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
                                const s = 0.45 + 0.95 * t;
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

    private clearLive(): void {
        for (const n of this._live.slice()) {
            if (n && n.isValid) { try { killNode(n); } catch (e) { /* 忽略 */ } }
        }
        this._live.length = 0;
    }
}
