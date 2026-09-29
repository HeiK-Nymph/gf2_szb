import {
    _decorator, Canvas, Color, Component, Material, Node, Sprite, SpriteFrame, Tween, tween, UITransform, Vec3,
} from 'cc';
import {
    getSummonOrbEffect, getSummonOrbSpriteFrames, orbAlphaAt, orbScaleAt, orbTimelineEnd,
    preloadSummonOrbAssets, SUMMON_ORB_LAYERS,
} from './CardSummonOrbFx';
import {
    applyWhiteFlash, preloadWhiteFlashEffect, releaseWhiteFlash, resolveWhiteFlashEffect, setWhiteFlash,
    WhiteFlashTarget,
} from './CardWhiteFlashFx';
import { killNode } from './CardComposer';
import { HeroArea } from './HeroArea';

const { ccclass, property, menu } = _decorator;

/** 一个光球实例：容器节点 + 加色材质 + 三层 Sprite 与各自的颜色 */
interface OrbRef {
    fx: Node;
    mat: Material;
    sprites: Sprite[];
    colors: Color[];
    base: number;
    /** 宿主本地坐标（迸发期间固定不动，不跟随卡牌） */
    local: Vec3;
}

/**
 * SuperEvolveDestroyFx —— 「超进化随从攻击破坏对方随从」专属破坏演出
 * ===========================================================================
 * 挂在 `Canvas/SuperEvolveDestroyFx`（宿主只当特效容器 + 组件宿主，自身不渲染）。
 * 由 BattleCommandSystem 的 `SuperEvolveDestroy` cue 在演出队列里调用
 * `play(card, heroNode, heroHpAfter, onComplete)` —— 逻辑破坏早已结算完毕，
 * 这里只负责表演；战场排布全程不动（Reflow cue 排在本演出之后）。
 *
 * 时序（与「进化光团」同款素材：三层 LightOrb + SummonOrbAdd 加色 + CardWhiteFlash 洗白）：
 *   ① 【卡牌光团·收缩】`orbShrinkDuration` 秒：光团从 `orbShrinkRange`（×卡牌长边）的
 *      最大范围收拢到「迸发起点」（= `orbBurstMaxRange` × 各层 from，与迸发 p=0 完全一致
 *      ⇒ 衔接无缝，参考 EvolveFollowerFx 的收缩/迸发边界）；**同一时间段卡牌持续变白**
 *      （0→1 与收缩共用同一进度，收缩到小圆点那一刻卡牌正好全白）；
 *   ② 收缩结束那一瞬：调整卡牌 Z 轴角度，使卡牌**头部（上边）朝向对方主战者**；
 *      随后【卡牌光团·迸发】`orbBurstDuration` 秒在**卡牌原位置**迸发
 *      （🔴 不跟随卡牌移动）；同时全白的倾斜卡牌用 `flyToHeroDuration` 秒
 *      飞到对方主战者**可见图像**的中心（大小按 `flyCardScale` 平滑过渡），到达即消失；
 *   ③ 卡牌消失的那一刻：【主战者光团·迸发】`heroBurstDuration` 秒在主战者正中
 *      迸发一个新光团（最大范围 `heroBurstMaxRange` × 主战者框长边），
 *      **同时**把对方主战者血量显示推进到结算快照值（原数值 -1）。
 *
 * 🔴 「主战者正中」= **玩家能看到的图像**的中心：Portrait 圆窗 ∩ 屏幕可见矩形的
 *    外接矩形中心（敌方圆框压在屏幕上缘、上半被裁，节点中心会比可见中心偏上）。
 *
 * Inspector 暴露的可调参数（需求 7 项）：
 *   · `orbShrinkDuration`   —— 卡牌的光团收缩时间；
 *   · `orbBurstDuration`    —— 卡牌的光团迸发时间；
 *   · `flyToHeroDuration`   —— 全白卡牌移动向对方主战者的时间；
 *   · `heroBurstDuration`   —— 对方主战者处的光团迸发时间；
 *   · `orbShrinkRange`      —— 卡牌的光团收缩前的最大范围（×卡牌长边）；
 *   · `orbBurstMaxRange`    —— 卡牌的光团迸发的最大范围（×卡牌长边）；
 *   · `heroBurstMaxRange`   —— 对方主战者处的光团迸发的最大范围（×主战者框长边）。
 * 另有颜色 / 提白 / 亮度（与进化光球同款默认值）。
 *
 * 🔴 铁律落实：整条时间轴 = **一条数值补间**驱动（onUpdate 里写位置/旋转/洗白/光球）；
 *    光球是独立节点（迸发不跟随卡牌）；洗白材质结束成对还原；运行时节点继承宿主 layer。
 * ===========================================================================
 */
@ccclass('SuperEvolveDestroyFx')
@menu('gf2szb/SuperEvolveDestroyFx')
export class SuperEvolveDestroyFx extends Component {

    // ====================== 单例（场景挂一份；BattleCommandSystem 取用） ======================
    private static _inst: SuperEvolveDestroyFx | null = null;
    public static get instance(): SuperEvolveDestroyFx | null {
        return (SuperEvolveDestroyFx._inst && SuperEvolveDestroyFx._inst.isValid) ? SuperEvolveDestroyFx._inst : null;
    }

    // ====================== 时长（需求暴露的 4 个时间） ======================

    @property({
        range: [0.05, 3, 0.01], slide: true,
        tooltip: '【卡牌光团·收缩】时长（秒）：光团从最大范围收拢到迸发起点（小圆点），卡牌同时持续变白',
    })
    orbShrinkDuration = 0.55;

    @property({
        range: [0.05, 3, 0.01], slide: true,
        tooltip: '【卡牌光团·迸发】时长（秒）：在卡牌**原位置**迸发（不跟随飞行的卡牌）',
    })
    orbBurstDuration = 0.3;

    @property({
        range: [0.05, 3, 0.01], slide: true,
        tooltip: '【全白卡牌移动】时长（秒）：全白的倾斜卡牌飞向对方主战者头像正中间并消失',
    })
    flyToHeroDuration = 0.45;

    @property({
        range: [0.2, 2, 0.01], slide: true,
        tooltip: '【全白卡牌移动】飞行途中全白倾斜卡牌的**大小倍数**：1 = 保持原大小，'
            + '<1 逐渐缩小、>1 逐渐放大（随飞行进度平滑过渡）',
    })
    flyCardScale = 1;

    @property({
        range: [0.05, 3, 0.01], slide: true,
        tooltip: '【主战者光团·迸发】时长（秒）：卡牌消失那一刻在主战者正中迸发新光团',
    })
    heroBurstDuration = 0.35;

    // ====================== 范围（需求暴露的 3 个范围，均 = 相对长边的倍数） ======================

    @property({
        range: [0.3, 6, 0.05], slide: true,
        tooltip: '【卡牌光团·收缩】收缩开始时的最大范围：×卡牌长边（= 最大弥散层直径）',
    })
    orbShrinkRange = 2.6;

    @property({
        range: [0.3, 6, 0.05], slide: true,
        tooltip: '【卡牌光团·迸发】最大范围：×卡牌长边（= 最大弥散层直径）',
    })
    orbBurstMaxRange = 1.9;

    @property({
        range: [0.3, 6, 0.05], slide: true,
        tooltip: '【主战者光团·迸发】最大范围：×主战者头像框长边（= 最大弥散层直径）',
    })
    heroBurstMaxRange = 1.9;

    // ====================== 配色 / 亮度（与进化光球同款） ======================

    @property({ type: Color, tooltip: '【光团】颜色（默认亮白，与进化光球一致）' })
    orbColor = new Color(236, 246, 255, 255);

    @property({ range: [0, 1, 0.05], slide: true, tooltip: '【光团】核心层提白程度：0=与颜色一致，1=纯白亮芯' })
    orbCoreWhiten = 0.9;

    @property({ range: [0.1, 4, 0.05], slide: true, tooltip: '【光团】加色亮度倍数（>1 更亮更「过曝」）' })
    orbIntensity = 1.0;

    @property({ tooltip: '打印动画日志' })
    verbose = true;

    // ====================== 内部状态 ======================
    private _playing = false;
    /** 是否正在播放 */
    public get isPlaying() { return this._playing; }

    /** 时间轴补间的数值对象（纯数值 target，onDestroy 必须单独停） */
    private _state: { t: number } | null = null;
    /** 本次播放的卡牌 / 主战者光球 */
    private _cardOrb: OrbRef | null = null;
    private _heroOrb: OrbRef | null = null;
    /** 本次播放的洗白材质对（结束成对还原） */
    private _flashTargets: WhiteFlashTarget[] | null = null;
    /** 正在飞行的卡牌（结束 / 中止时兜底销毁） */
    private _card: Node | null = null;
    /** 时间轴分段（秒） */
    private _d1 = 0; private _d2 = 0; private _d3 = 0; private _d4 = 0;
    private _tFlyEnd = 0;
    /** 阶段标志（幂等） */
    private _tilted = false;
    private _cardGone = false;

    // ------------------------------ 生命周期 ------------------------------
    onLoad(): void {
        SuperEvolveDestroyFx._inst = this;
        // 与「进化光球」共用同一份模块级缓存：这里发起预加载，正式播放时直接取。
        preloadSummonOrbAssets();
        preloadWhiteFlashEffect();
    }

    onDestroy(): void {
        if (SuperEvolveDestroyFx._inst === this) SuperEvolveDestroyFx._inst = null;
        this.cleanup();
    }

    protected update(): void {
        // 🔴 与 EvolveFollowerFx 同款：播放期间每帧把宿主按回 Canvas 最后，
        //    保证光效与飞行的卡牌永远压在所有战场卡牌之上。
        if (!this._playing || !this.node.parent) return;
        const last = this.node.parent.children.length - 1;
        if (this.node.getSiblingIndex() !== last) this.node.setSiblingIndex(last);
    }

    // ------------------------------ 对外 API ------------------------------
    /**
     * 播放「超进化破坏」演出。
     * @param card        被破坏的对方随从节点（逻辑上已从战场摘除，节点保留待演出）
     * @param heroNode    对方主战者节点（HeroArea 所在节点）
     * @param heroHpAfter 主战者扣血后的**逻辑血量**（结尾那一刻推进显示）
     * @param onComplete  演出全部结束后的回调（卡牌已销毁）；可省略
     */
    public play(card: Node, heroNode: Node, heroHpAfter: number, onComplete?: () => void): void {
        if (!card || !card.isValid || !heroNode || !heroNode.isValid) {
            if (onComplete) onComplete();
            return;
        }
        if (this._playing) {
            console.warn('[SuperEvolveDestroyFx] 上一段演出还没播完，忽略本次');
            if (onComplete) onComplete();
            return;
        }
        this._playing = true;
        this._card = card;
        this._tilted = false;
        this._cardGone = false;

        const host = this.node;
        const hostUT = host.getComponent(UITransform) || host.addComponent(UITransform);

        // ---- 采集：卡牌世界坐标 / 显示长边（含世界缩放，参照 CardDestroyFx.playOnCard） ----
        const cardWorld = card.worldPosition.clone();
        let longEdge = 1;
        try {
            const ut = card.getComponent(UITransform);
            if (ut) {
                const ws = card.worldScale;
                longEdge = Math.max(
                    Math.abs(ut.contentSize.width * ws.x),
                    Math.abs(ut.contentSize.height * ws.y), 1);
            }
        } catch (e) { /* 读取失败按 1 处理 */ }

        // ---- 主战者：**可见图像**的中心（Portrait 圆窗 ∩ 屏幕可见区的外接矩形中心） ----
        // 🔴 敌方主战者圆框压在屏幕上缘、上半被裁 ⇒ 节点中心比玩家看到的图像中心偏上。
        const heroWorld = this.heroVisibleCenterWorld(heroNode);
        let heroBase = 120;
        try {
            const hut = heroNode.getComponent(UITransform);
            if (hut) {
                const ws = heroNode.worldScale;
                heroBase = Math.max(
                    Math.abs(hut.contentSize.width * ws.x),
                    Math.abs(hut.contentSize.height * ws.y), 120);
            }
        } catch (e) { /* 同上 */ }
        // 飞行卡牌的起始缩放（flyCardScale 在飞行途中按进度平滑过渡）
        let startScaleX = 1, startScaleY = 1;
        try { startScaleX = card.scale.x; startScaleY = card.scale.y; } catch (e) { /* 忽略 */ }

        // ---- 停掉卡牌上可能跑着的补间（避免起始帧被旧补间写坏） ----
        try { Tween.stopAllByTarget(card); } catch (e) { /* 忽略 */ }

        // ---- 卡牌临时挂到宿主（Canvas 最上层）——飞行途中不被战场/手牌挡住 ----
        try {
            card.setParent(host, true);
            card.setSiblingIndex(host.children.length - 1);
        } catch (e) { /* 换父失败就留在原地飞 */ }

        // ---- 洗白：0→1 与光团收缩共用同一进度（收缩到小圆点那一刻正好全白） ----
        this._flashTargets = null;
        const eff = resolveWhiteFlashEffect();
        if (eff) {
            this._flashTargets = applyWhiteFlash(card, eff);
            setWhiteFlash(this._flashTargets, 0);
        }

        // ---- 宿主本地坐标（动画全部在宿主坐标系里做） ----
        const originLocal = hostUT.convertToNodeSpaceAR(cardWorld, new Vec3());
        const heroLocal = hostUT.convertToNodeSpaceAR(heroWorld, new Vec3());

        // ---- 倾斜角：让卡牌「头部（本地上边 +Y）」指向主战者 ----
        // up 旋 θ 后 = (-sinθ, cosθ) ∝ (dx, dy) ⇒ θ = atan2(-dx, dy)
        const dx = heroWorld.x - cardWorld.x;
        const dy = heroWorld.y - cardWorld.y;
        const tiltDeg = Math.atan2(-dx, dy) * 180 / Math.PI;

        // ---- 时间轴分段 ----
        const d1 = Math.max(0.05, this.orbShrinkDuration);
        const d2 = Math.max(0.05, this.orbBurstDuration);
        const d3 = Math.max(0.05, this.flyToHeroDuration);
        const d4 = Math.max(0.05, this.heroBurstDuration);
        this._d1 = d1; this._d2 = d2; this._d3 = d3; this._d4 = d4;
        this._tFlyEnd = d1 + d3;
        const total = this._tFlyEnd + d4;

        let settled = false;
        const finish = (): void => {
            if (settled) return;
            settled = true;
            this.cleanup();
            if (this.verbose) console.log('[SuperEvolveDestroyFx] 演出完成 → ' + (card && card.isValid ? card.name : '(已销毁)'));
            if (onComplete) {
                try { onComplete(); } catch (e) { console.error('[SuperEvolveDestroyFx] onComplete 出错：', e); }
            }
        };

        const heroComp = heroNode.getComponent(HeroArea);
        const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

        const state = { t: 0 };
        this._state = state;

        // 🔴 一条数值补间驱动整条时间轴（铁律：位置/旋转/洗白/光球都在 onUpdate 里写）
        tween(state)
            .to(total, { t: 1 }, {
                easing: 'linear',
                onUpdate: () => {
                    if (settled) return;
                    try {
                        const t = state.t * total;      // 绝对时间（秒）
                        if (t < d1) {
                            // ---------- ① 光团收缩 + 卡牌持续变白 ----------
                            const q = t / d1;
                            this.ensureCardOrb(originLocal, longEdge);
                            this.updateCardOrbShrink(longEdge, q);
                            setWhiteFlash(this._flashTargets, q);
                        } else {
                            // ---------- ② 收缩到小圆点那一瞬：倾斜 + 全白 ----------
                            if (!this._tilted) {
                                this._tilted = true;
                                setWhiteFlash(this._flashTargets, 1);
                                try {
                                    if (card && card.isValid) card.setRotationFromEuler(0, 0, tiltDeg);
                                } catch (e) { /* 节点可能已被销毁 */ }
                                if (this.verbose) console.log('[SuperEvolveDestroyFx] 收缩结束 → 倾斜 ' + tiltDeg.toFixed(1) + '° + 全白，卡牌光团迸发（原位置）');
                            }
                            // 卡牌光团迸发（固定在原位置，不跟随卡牌）
                            this.ensureCardOrb(originLocal, longEdge);
                            this.updateCardOrbBurst(longEdge, clamp01((t - d1) / d2));
                            // 全白倾斜卡牌飞向主战者正中（大小随 flyCardScale 平滑过渡）
                            if (card && card.isValid) {
                                const fp = clamp01((t - d1) / d3);
                                const e = fp * fp * (3 - 2 * fp);   // smoothstep（quadInOut 手写版）
                                card.setPosition(
                                    originLocal.x + (heroLocal.x - originLocal.x) * e,
                                    originLocal.y + (heroLocal.y - originLocal.y) * e, 0);
                                const sk = 1 + (this.flyCardScale - 1) * e;
                                card.setScale(startScaleX * sk, startScaleY * sk, 1);
                            }
                            // ---------- ③ 到达主战者：卡牌消失 + 主战者迸发 + 血量显示推进 ----------
                            if (t >= this._tFlyEnd && !this._cardGone) {
                                this._cardGone = true;
                                try { if (card && card.isValid) killNode(card); } catch (e) { /* 忽略 */ }
                                releaseWhiteFlash(this._flashTargets);
                                this._flashTargets = null;
                                this.ensureHeroOrb(heroLocal, heroBase);
                                // 血量显示推进到结算快照值（原数值 -1）—— 显示属于演出，此刻才更新
                                try { if (heroComp) heroComp.applyDisplayHp(heroHpAfter); } catch (e) { /* 忽略 */ }
                                if (this.verbose) console.log('[SuperEvolveDestroyFx] 卡牌在主战者正中消失 → 主战者光团迸发 + 血量显示=' + heroHpAfter);
                            }
                            if (t >= this._tFlyEnd) {
                                this.updateHeroOrbBurst(clamp01((t - this._tFlyEnd) / d4));
                            }
                        }
                    } catch (e) {
                        console.error('[SuperEvolveDestroyFx] 播放出错（熔断）：', e);
                        finish();
                    }
                },
            })
            .call(() => finish())
            .start();
    }

    // ------------------------------ 清理（幂等） ------------------------------
    /** 停时间轴 + 销毁两个光球 + 成对还原洗白材质 + 兜底销毁还没消失的卡牌。 */
    private cleanup(): void {
        if (this._state) {
            Tween.stopAllByTarget(this._state);
            this._state = null;
        }
        this._cardOrb = this.destroyOrb(this._cardOrb);
        this._heroOrb = this.destroyOrb(this._heroOrb);
        if (this._flashTargets) {
            releaseWhiteFlash(this._flashTargets);
            this._flashTargets = null;
        }
        if (this._card && this._card.isValid && !this._cardGone) {
            try { killNode(this._card); } catch (e) { /* 忽略 */ }
        }
        this._card = null;
        this._playing = false;
    }

    private destroyOrb(orb: OrbRef | null): OrbRef | null {
        if (orb) {
            if (orb.fx && orb.fx.isValid) {
                Tween.stopAllByTarget(orb.fx);
                orb.fx.destroy();
            }
            if (orb.mat) orb.mat.destroy();
        }
        return null;
    }

    // ------------------------------ 主战者可见中心 ------------------------------
    /**
     * 主战者**可见图像**的中心（世界坐标）。
     * 🔴 敌方主战者的圆框压在屏幕上缘、上半被屏幕裁掉 ⇒ HeroArea 节点中心（= Portrait
     *    圆窗圆心）比玩家**实际看到的图像**中心偏上。这里取「Portrait 圆窗 ∩ 屏幕可见
     *    矩形」的外接矩形中心：被裁一侧的中点往可见侧收 —— 圆窗完整可见时与节点中心一致。
     */
    private heroVisibleCenterWorld(heroNode: Node): Vec3 {
        const wp = heroNode.worldPosition.clone();
        // Portrait 圆窗（与节点同心）的世界半径；缺 Portrait 时退回节点本身
        const win = heroNode.getChildByName('Portrait') || heroNode;
        let r = 0;
        try {
            const ut = win.getComponent(UITransform);
            if (ut) r = Math.abs(ut.contentSize.width * win.worldScale.x) / 2;
        } catch (e) { /* 忽略 */ }
        if (r <= 0) return wp;
        // 屏幕可见矩形（世界坐标）= Canvas 中心 ± 半尺寸
        const canvas = this.findCanvas();
        if (!canvas) return wp;
        const cut = canvas.getComponent(UITransform);
        if (!cut) return wp;
        const c = canvas.worldPosition;
        const hw = cut.contentSize.width * canvas.worldScale.x / 2;
        const hh = cut.contentSize.height * canvas.worldScale.y / 2;
        const x0 = Math.max(wp.x - r, c.x - hw);
        const x1 = Math.min(wp.x + r, c.x + hw);
        const y0 = Math.max(wp.y - r, c.y - hh);
        const y1 = Math.min(wp.y + r, c.y + hh);
        return new Vec3((x0 + x1) / 2, (y0 + y1) / 2, wp.z);
    }

    private findCanvas(): Node | null {
        const scene = this.node.scene;
        if (!scene) return null;
        const stack: Node[] = [...scene.children];
        while (stack.length > 0) {
            const n = stack.shift() as Node;
            if (n.getComponent(Canvas)) return n;
            for (const ch of n.children) stack.push(ch);
        }
        return null;
    }

    // ------------------------------ 光球（复用进化光球素材 / 时间轴） ------------------------------
    /** 三层直径比例照搬 EvolveFollowerFx / CardSummonOrbFx（核心 : 冲击环 : 弥散 = 0.85 : 1.35 : 1.70）。 */
    private orbSizesOf(rr: number): number[] {
        const r = Math.max(0.01, rr);
        return [r * (0.85 / 1.70), r * (1.35 / 1.70), r];
    }

    /** 光球资产是否就绪（effect + 三张贴图）。 */
    private orbAssetsReady(): boolean {
        const eff = getSummonOrbEffect();
        const sfs = getSummonOrbSpriteFrames();
        return !!eff && !!sfs[0] && !!sfs[1] && !!sfs[2];
    }

    /** 确保光球实例存在（素材未就绪时静默返回，调用方每帧重试 —— 就绪那一刻自动补上）。 */
    private ensureOrb(which: 'card' | 'hero', local: Vec3, base: number): OrbRef | null {
        const existing = which === 'card' ? this._cardOrb : this._heroOrb;
        if (existing) return existing;
        if (!this.orbAssetsReady()) return null;
        const eff = getSummonOrbEffect();
        const sfs = getSummonOrbSpriteFrames();
        const made = this.makeOrb(which === 'card' ? 'SuperEvolveOrbFx' : 'SuperEvolveHeroOrbFx', local);
        if (!made || !eff) return null;
        const { fx, mat } = made;
        mat.setProperty('intensity', Math.max(0, this.orbIntensity));

        // 分层配色：核心提白，其余保持设定色（与进化光球一致）。
        const kw = Math.max(0, Math.min(1, this.orbCoreWhiten));
        const baseColor = this.orbColor;
        const core = new Color(
            Math.round(baseColor.r + (255 - baseColor.r) * kw),
            Math.round(baseColor.g + (255 - baseColor.g) * kw),
            Math.round(baseColor.b + (255 - baseColor.b) * kw),
            0,
        );
        const tints: Color[] = [core, new Color(baseColor.r, baseColor.g, baseColor.b, 0), new Color(baseColor.r, baseColor.g, baseColor.b, 0)];

        const sprites: Sprite[] = [];
        const colors: Color[] = [];
        for (let i = 0; i < SUMMON_ORB_LAYERS.length; i++) {
            const cfg = SUMMON_ORB_LAYERS[i];
            const sp = this.frameSprite(fx, (sfs as readonly SpriteFrame[])[cfg.tex]!, tints[i], mat);
            sprites.push(sp);
            colors.push(new Color(tints[i]));
        }
        const orb: OrbRef = { fx, mat, sprites, colors, base, local };
        if (which === 'card') this._cardOrb = orb; else this._heroOrb = orb;
        return orb;
    }

    private ensureCardOrb(local: Vec3, base: number): OrbRef | null {
        return this.ensureOrb('card', local, base);
    }

    private ensureHeroOrb(local: Vec3, base: number): OrbRef | null {
        return this.ensureOrb('hero', local, base);
    }

    /**
     * 收缩段：光团从 `orbShrinkRange` 的最大范围收拢到迸发起点。
     * 🔴 与 EvolveFollowerFx.updateOrbShrink 同一套衔接逻辑：
     *    终点尺寸 = 迸发 p=0 的尺寸（`sizes[i] × cfg.from`）、终点 alpha = 0 ——
     *    与 `updateCardOrbBurst(0)` 完全一致，两段交接那一帧没有任何跳变。
     */
    private updateCardOrbShrink(base: number, q: number): void {
        const orb = this._cardOrb;
        if (!orb || !orb.fx || !orb.fx.isValid) return;
        const startSizes = this.orbSizesOf(this.orbShrinkRange);
        const endSizes = this.orbSizesOf(this.orbBurstMaxRange);
        const e = q * q * (3 - 2 * q);                       // smoothstep：先缓后急再缓
        for (let i = 0; i < orb.sprites.length; i++) {
            const sp = orb.sprites[i];
            if (!sp || !sp.isValid) continue;
            const cfg = SUMMON_ORB_LAYERS[i];
            const startSize = base * startSizes[i];
            const endSize = base * endSizes[i] * cfg.from;
            const size = startSize + (endSize - startSize) * e;
            const tn = sp.node.getComponent(UITransform);
            if (tn) tn.setContentSize(size, size);
            // 透明度：前 12% 淡入 → 保持 → 末 18% 淡出到 0（= 迸发 p=0 的 alpha，无缝）
            const fin = Math.min(1, q / 0.12);
            const fout = Math.min(1, (1 - q) / 0.18);
            const a = cfg.peak * Math.max(0, Math.min(fin, fout));
            const c = orb.colors[i];
            c.a = Math.round(255 * a);
            sp.color = c;
        }
    }

    /** 迸发段：按进度 p ∈ [0,1] 驱动三层（时间轴按 orbTimelineEnd() 拉伸，p=1 恰好熄灭）。 */
    private updateCardOrbBurst(base: number, p: number): void {
        this.updateOrbBurst(this._cardOrb, base, this.orbBurstMaxRange, p);
    }

    /** 主战者处的迸发段。 */
    private updateHeroOrbBurst(p: number): void {
        this.updateOrbBurst(this._heroOrb, this._heroOrb ? this._heroOrb.base : 120, this.heroBurstMaxRange, p);
    }

    private updateOrbBurst(orb: OrbRef | null, base: number, maxRange: number, p: number): void {
        if (!orb || !orb.fx || !orb.fx.isValid) return;
        const sizes = this.orbSizesOf(maxRange);
        const pp = Math.min(1, Math.max(0, p) * orbTimelineEnd());
        for (let i = 0; i < orb.sprites.length; i++) {
            const sp = orb.sprites[i];
            if (!sp || !sp.isValid) continue;
            const cfg = SUMMON_ORB_LAYERS[i];
            const sc = orbScaleAt(pp, cfg);
            const size = base * sizes[i] * sc;
            const tn = sp.node.getComponent(UITransform);
            if (tn) tn.setContentSize(size, size);
            const c = orb.colors[i];
            c.a = Math.round(255 * Math.max(0, Math.min(1, orbAlphaAt(pp, cfg))));
            sp.color = c;
        }
    }

    // ------------------------------ 特效基元（与 EvolveFollowerFx 同款） ------------------------------
    /** 在宿主下建一个光球容器（位置固定在 local —— 迸发不跟随卡牌）。 */
    private makeOrb(name: string, local: Vec3): { fx: Node; mat: Material } | null {
        const eff = getSummonOrbEffect();
        if (!eff || !eff.isValid) return null;
        const fx = new Node(name);
        // 🔴🔴 运行时创建的节点必须继承宿主的 layer（本项目 UI 相机可见层是 DEFAULT，不含 UI_2D）。
        fx.layer = this.node.layer;
        fx.setParent(this.node);
        fx.setSiblingIndex(this.node.children.length - 1);
        const fut = fx.addComponent(UITransform);
        fut.setAnchorPoint(0.5, 0.5);
        fx.setPosition(local.x, local.y, 0);
        const mat = new Material();
        mat.initialize({ effectAsset: eff });
        return { fx, mat };
    }

    private frameSprite(parent: Node, sf: SpriteFrame, tint: Color, mat: Material): Sprite {
        const n = new Node('f');
        n.layer = parent.layer;   // 🔴 继承宿主 layer
        n.setParent(parent);
        const sp = n.addComponent(Sprite);
        sp.sizeMode = Sprite.SizeMode.CUSTOM;   // 🔴 默认 TRIMMED 会改写 contentSize
        sp.spriteFrame = sf;
        sp.customMaterial = mat;
        const c = new Color(tint);
        c.a = 0;
        sp.color = c;
        n.getComponent(UITransform)!.setContentSize(1, 1);
        return sp;
    }
}
