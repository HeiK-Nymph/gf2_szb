import {
    _decorator, Color, Component, EffectAsset, Material, Node, resources, Sprite, SpriteFrame,
    Tween, tween, UITransform, Vec3,
} from 'cc';
import { killNode } from './CardComposer';

const { ccclass, property, menu } = _decorator;

/** 刀光节点名 */
export const BLADE_NODE_NAME = 'FlameBlade';
/** 刀光高亮芯线节点名 */
const BLADE_CORE_NAME = 'FlameBladeCore';

/** 刀光素材（软光带：横向拉伸后就是一道「刀光」） */
const BLADE_TEX_PATHS: readonly string[] = [
    'effects/LightOrb/light_03/spriteFrame',
    'effects/LightOrb/light_01/spriteFrame',
];
const ADD_EFFECT_NAME = 'SummonOrbAdd';
const ADD_EFFECT_RES_PATH = 'effects/SummonOrbAdd';

/**
 * FlameSweepFx —— 「**红色火焰刀光横扫**」全场攻击演出（卡 15「恶兆成谶·维克托」的入场曲）
 * ===========================================================================
 * 需求（按用户口径）：
 *   · **不是子弹**：不要弹头、不要尾焰/拖尾 —— 就是**一道红色火焰刀光**横着扫过；
 *   · 刀光从**一边屏幕外**出现 → 划过整个屏幕 → **刀光的头从另一边屏幕穿出时，刀光依然横贯整个屏幕**
 *     （所以刀光长度 ≥ 屏幕宽，滑到屏幕正中时正好铺满）；
 *   · 随后刀光**变细 + 渐渐消失**（停在屏幕正中完成这一下）；
 *   · **敌我相反**：我方使用 → 从**左往右**扫过敌方战场；**敌方人机使用 → 从右往左**扫过我方战场
 *     （`direction` 由调用方按「目标所在阵营」决定，见 BattleCommandSystem.playPoisonBulletCue）。
 *
 * Inspector 暴露：**长度 `length` / 宽度 `width` / 动画总时间 `duration`**（+ 颜色 / 相位比例等）。
 * 🔴 只做演出；`done` 一定会被调用（素材缺失 / 节点非法 / 超时熔断都保证放行）。
 * ===========================================================================
 */
@ccclass('FlameSweepFx')
@menu('gf2szb/FlameSweepFx')
export class FlameSweepFx extends Component {

    private static _inst: FlameSweepFx | null = null;
    public static get instance(): FlameSweepFx | null {
        return (FlameSweepFx._inst && FlameSweepFx._inst.isValid) ? FlameSweepFx._inst : null;
    }

    @property({ type: Color, tooltip: '★【火焰颜色】默认红 255,72,26。加色混合下 alpha 也参与亮度。' })
    color = new Color(255, 72, 26, 255);

    @property({ range: [200, 3200, 1], slide: true, tooltip: '★【刀光长度】默认 1500 —— 要 ≥ 屏幕宽(1280)，这样刀光头穿出另一边时刀光仍横贯整个屏幕。' })
    length = 1500;

    @property({ range: [4, 600, 1], slide: true, tooltip: '★【刀光宽度】刀光的厚度（px）。' })
    width = 150;

    @property({ range: [0.1, 6, 0.01], slide: true, tooltip: '★【动画总时间】出现 → 扫过 → 变细消失的总时长（秒）。' })
    duration = 1.05;

    @property({ range: [0.1, 0.95, 0.01], slide: true, tooltip: '【横扫相位占比】总时间里有多大比例用于「扫过屏幕」，其余用于「变细 + 消失」。' })
    sweepRatio = 0.6;

    @property({ range: [0, 1, 0.01], slide: true, tooltip: '【消失时最细比例】变细结束时宽度缩到原来的百分之几（0 = 完全细成一条线）。' })
    thinTo = 0.04;

    @property({ range: [0, 2, 0.01], slide: true, tooltip: '【芯线亮度】中间那条更亮的高光芯线相对刀光的亮度倍数（0 = 不要芯线）。' })
    coreGain = 1.35;

    @property({ tooltip: '是否用**加色（ADD）**混合（火焰发光感）。' })
    additive = true;

    @property({ range: [0, 4, 0.01], slide: true, tooltip: '加色亮度倍数。> 1.8 容易整条过曝成纯白（红色丢失）。' })
    intensity = 1.1;

    private readonly _tex: (SpriteFrame | null)[] = BLADE_TEX_PATHS.map(() => null);
    private _loading = false;
    private _effect: EffectAsset | null = null;
    private _loadingEffect = false;
    private _warned = false;
    private readonly _actives = new Set<() => void>();
    private readonly _live: Node[] = [];

    onLoad(): void { FlameSweepFx._inst = this; this.preload(); }
    onEnable(): void { this.preload(); }
    onDisable(): void { this.finishAll(); this.clearLive(); }
    onDestroy(): void {
        if (FlameSweepFx._inst === this) FlameSweepFx._inst = null;
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
        let remain = BLADE_TEX_PATHS.length;
        BLADE_TEX_PATHS.forEach((p, i) => {
            resources.load(p, SpriteFrame, (err, sf) => {
                remain--;
                if (err || !sf) this.warnOnce(`加载刀光贴图失败："${p}"`, err);
                else this._tex[i] = sf as SpriteFrame;
                if (remain <= 0) this._loading = false;
            });
        });
    }

    public get assetsReady(): boolean {
        return this._tex.some((f) => !!f && f.isValid);
    }

    private warnOnce(msg: string, err: unknown): void {
        if (this._warned) return;
        this._warned = true;
        console.warn('[FlameSweepFx] ' + msg + ' →', err);
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
     * 一道火焰刀光横扫 `fieldNode`（被打击的那片战场）。
     * @param fieldNode 目标战场节点（用它的中心作为刀光最终停住的位置）
     * @param leftToRight true = 左→右（我方出手）；false = 右→左（敌方人机出手，玩家视角相反）
     * @param onComplete 一定被调用（且只一次）
     */
    /**
     * @param colorOverride 本次演出的颜色（不传 = 用宿主上 Inspector 的 `color`）。
     *   用途：卡 28「骇人的轰炸」爆能强化_10 的全场扫 4 = **黄色**横扫（与卡 15 维克托的红色横扫同款特效）。
     */
    public play(fieldNode: Node | null, leftToRight = true, onComplete?: () => void, colorOverride?: Color | null): void {
        const prevColor = this.color;
        if (colorOverride) { try { this.color = new Color(colorOverride); } catch (e) { /* 忽略 */ } }
        const restoreColor = (): void => { if (colorOverride) { try { this.color = prevColor; } catch (e) { /* 忽略 */ } } };
        let called = false;
        const done = (): void => {
            if (called) return;
            called = true;
            restoreColor();                       // 还原宿主颜色（下次别的卡再横扫时不受影响）
            try { if (onComplete) onComplete(); } catch (e) { console.error('[FlameSweepFx] 完成回调出错：', e); }
        };
        if (!this.enabled || !this.node || !this.node.isValid) { done(); return; }
        this.preload();
        if (!this.assetsReady) { this.warnOnce('刀光贴图未就绪，跳过本段演出', null); done(); return; }

        const hostUT = this.node.getComponent(UITransform);
        const hostW = hostUT ? hostUT.contentSize.width : 1280;
        const hostH = hostUT ? hostUT.contentSize.height : 720;
        const toLocal = (w: Vec3): Vec3 => (hostUT ? hostUT.convertToNodeSpaceAR(w, new Vec3()) : w.clone());

        // 目标战场的中心（刀光最终停在这里 = 屏幕正中）
        let center = new Vec3(0, 0, 0);
        try {
            if (fieldNode && fieldNode.isValid) center = toLocal(fieldNode.worldPosition.clone());
        } catch (e) { this.warnOnce('取目标战场中心失败，用屏幕中心', e); }

        const L = Math.max(200, this.length);
        const W = Math.max(4, this.width);
        const screenW = Math.max(200, Math.abs(hostW));
        const base = this.color ? new Color(this.color) : new Color(255, 72, 26, 255);
        const baseAlpha = Math.max(0, Math.min(255, base.a)) / 255;
        const mat = this.makeMaterial();
        const frames = this._tex.filter((f) => !!f && f.isValid);
        if (frames.length === 0) { done(); return; }

        // ---- 刀光主体（一条横向拉伸的软光带 = 刀光）+ 中间更亮的芯线 ----
        const mk = (name: string, w: number, h: number, gain: number): { node: Node; sp: Sprite; col: Color } | null => {
            const node = new Node(name);
            node.layer = this.node.layer;
            node.setParent(this.node);
            if (node.parent) node.setSiblingIndex(node.parent.children.length - 1);
            const ut = node.addComponent(UITransform);
            ut.setAnchorPoint(0.5, 0.5);
            ut.setContentSize(w, h);
            const sp = node.addComponent(Sprite);
            sp.sizeMode = Sprite.SizeMode.CUSTOM;
            sp.type = Sprite.Type.SIMPLE;
            sp.spriteFrame = frames[0];
            if (mat) sp.customMaterial = mat;
            const col = new Color(base);
            col.a = 0;
            sp.color = col;
            node.setPosition(center.x, center.y, 0);
            this._live.push(node);
            void gain;
            return { node, sp, col };
        };
        const blade = mk(BLADE_NODE_NAME, L, W, 1);
        const core = this.coreGain > 0 ? mk(BLADE_CORE_NAME, L, Math.max(2, W * 0.32), this.coreGain) : null;
        if (!blade) { done(); return; }

        // 起点：完全在屏幕外（头朝前）；终点：屏幕正中（此时刀光仍横贯整个屏幕）
        const off = screenW * 0.5 + L * 0.5 + 40;
        const startX = center.x + (leftToRight ? -off : off);
        const endX = center.x;

        const state = { p: 0 };
        const dur = Math.max(0.05, this.duration);
        const sweepRatio = Math.max(0.1, Math.min(0.95, this.sweepRatio));
        const thinTo = Math.max(0, Math.min(1, this.thinTo));
        const coreK = Math.max(1, this.coreGain);
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
            console.warn('[FlameSweepFx] 刀光演出超时未结束 → 强制放行演出队列');
            finish();
        }, dur + 0.6);

        const apply = (p: number): void => {
            const t = Math.max(0, Math.min(1, p));
            if (t <= sweepRatio) {
                // ① 横扫：从屏幕外滑到正中（头先出、尾随后 ⇒ 头穿出时仍横贯全屏）
                const k = sweepRatio <= 0 ? 1 : (t / sweepRatio);
                const x = startX + (endX - startX) * k;
                const fadeIn = Math.min(1, k / 0.12);
                blade.node.setPosition(x, center.y, 0);
                blade.col.a = Math.round(255 * baseAlpha * fadeIn);
                blade.sp.color = blade.col;
                if (core) {
                    core.node.setPosition(x, center.y, 0);
                    core.col.a = Math.round(255 * baseAlpha * fadeIn * 0.85);
                    core.sp.color = core.col;
                }
            } else {
                // ② 变细 + 渐渐消失（停在正中）
                const k = (t - sweepRatio) / Math.max(0.01, 1 - sweepRatio);
                const sy = 1 - (1 - thinTo) * k;
                const fade = 1 - k;
                blade.node.setPosition(endX, center.y, 0);
                blade.node.setScale(1, Math.max(0.001, sy), 1);
                blade.col.a = Math.round(255 * baseAlpha * fade);
                blade.sp.color = blade.col;
                if (core) {
                    core.node.setPosition(endX, center.y, 0);
                    core.node.setScale(1, Math.max(0.001, sy), 1);
                    core.col.a = Math.round(255 * baseAlpha * fade * 0.85);
                    core.sp.color = core.col;
                }
            }
            void coreK;
        };

        try {
            apply(0);
            tween(state)
                .to(dur, { p: 1 }, { easing: 'linear', onUpdate: () => { if (!settled) { try { apply(state.p); } catch (e) { /* 忽略 */ } } } })
                .call(() => finish())
                .start();
        } catch (e) {
            console.error('[FlameSweepFx] 刀光演出出错：', e);
            finish();
        }
        void hostH;
    }

    private clearLive(): void {
        for (const n of this._live.slice()) {
            if (n && n.isValid) { try { killNode(n); } catch (e) { /* 忽略 */ } }
        }
        this._live.length = 0;
    }
}
