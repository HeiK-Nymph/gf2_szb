import {
    _decorator, Canvas, Color, Component, Node, tween, UITransform, Vec3,
} from 'cc';
import {
    createFollowerAttackOrb, FollowerAttackOrbHandle, preloadFollowerAttackOrbAssets,
} from './FollowerAttackOrbFx';

const { ccclass, property, menu } = _decorator;

/**
 * FollowerAttackAnim —— 随从「普通攻击」动画编排（卡牌绕 Y 旋转 + 特效球飞射）
 * ===========================================================================
 * 需求：
 *   1. 随从攻击随从时，**双方保持选择时抬起的高度不落下**；
 *   2. 攻击方先播一次「普通攻击」：卡牌绕 Y 轴转 -360°（到 -360 时归零），
 *      **同时**特效球从攻击方卡牌中心射向被攻击方卡牌中心，卡牌转完一圈时球
 *      **恰好**抵达目标中心并结束动画 —— 旋转与飞行**时间严格一致**；
 *   3. 攻击方的这一次普通攻击结束后，**被攻击方反击**（同样一次普通攻击）；
 *   4. 攻击敌方主战者时**只播一次**普通攻击（被攻击方不反击）；
 *   5. 在 Cocos 里**暴露「单次普通攻击的时长」变量** → `attackDuration`（秒）。
 *
 * 实现要点
 *   · 旋转与飞行共用一个 `p:0→1` 的**数值补间**：`onUpdate` 里同时写卡牌 eulerAngles.y
 *     与特效球进度。时间不可能漂移（不是两条补间「约好同时开始」）。
 *   · 特效球宿主是 Canvas 下动态建的 `BattleFxLayer`（始终置顶）——卡牌在各自的战场层里，
 *     飞行物不能挂在卡牌下（会被销毁 / 被层级切割）。
 *   · 补间回调里的异常会被 TweenSystem 吞掉 → 一律 try/catch；`done` 单一出口保证
 *     回调只跑一次（铁律：清理函数自带守卫时不要提前置位）。
 *   · 旋转结束后**显式归零**（写回进入攻击前的欧拉角），避免浮点残差。
 */
@ccclass('FollowerAttackAnim')
@menu('gf2szb/FollowerAttackAnim')
export class FollowerAttackAnim extends Component {

    // ====================== 对外暴露的参数 ======================
    @property({
        range: [0.05, 3, 0.01], slide: true,
        tooltip: '【单个卡牌的一次普通攻击的总时长（秒）】\n'
            + '卡牌绕 Y 轴旋转 -360° 与特效球从攻击方中心飞到被攻击方中心，'
            + '共用这一时长：同时开始、同时结束。\n'
            + '随从对随从 = 攻击 + 反击 = 2 × 本时长；攻击主战者 = 1 × 本时长。',
    })
    attackDuration = 0.5;

    @property({
        range: [-720, -1, 1], slide: true,
        tooltip: '单次普通攻击中，卡牌绕 Y 轴旋转的总角度（度）。默认 -360 = 正好一整圈，结束时归零。',
    })
    spinDegrees = -360;

    @property({
        range: [20, 400, 1], slide: true,
        tooltip: '攻击特效球的基础尺寸（像素）。',
    })
    orbSize = 130;

    @property({ type: Color, tooltip: '攻击特效球的染色（贴图本身是白色能量球，靠节点色染色）。' })
    orbColor = new Color(255, 214, 150, 255);

    @property({
        tooltip: '特效球使用加色（ADD）混合 —— 在偏暗的战场上更像发光；浅色背景上可能过曝，可关闭改用普通 alpha 混合。',
    })
    orbAdditive = true;

    @property({ range: [0, 2, 0.01], slide: true, tooltip: '加色亮度倍数（orbAdditive 打开时生效）。' })
    orbIntensity = 0.9;

    @property({
        range: [-400, 400, 1], slide: true,
        tooltip: '攻击特效球飞行路径的**贝塞尔弯曲偏移距离（像素）**。\n'
            + '垂直于「攻击方中心 → 被攻击方中心」的直线：0 = 直线；'
            + '正值 = 朝行进方向的**右侧**鼓起（鼓起量 = 本值，路径中点离直线最远），负值 = 左侧。',
    })
    curveOffset = 60;

    // ====================== 内部状态 ======================
    /** 特效球专图层（Canvas 下动态创建，始终置顶） */
    private _layer: Node | null = null;
    /** 正在播放整段攻击编排（对随从 = 攻击 + 反击） */
    private _busy = false;

    // ------------------------------ 生命周期 ------------------------------
    onLoad(): void {
        preloadFollowerAttackOrbAssets();
    }

    // ------------------------------ 对外查询 ------------------------------
    /** 正在播放攻击编排（外部可据此拒绝新的攻击输入）。 */
    public get isBusy(): boolean {
        return this._busy;
    }

    /** 单个卡牌的一次普通攻击时长（秒），已做下限保护。 */
    public get singleAttackDuration(): number {
        return Math.max(0.05, this.attackDuration);
    }

    // ------------------------------ 播放接口 ------------------------------
    /**
     * 随从攻击随从：攻击方先一次普通攻击，随后被攻击方反击（同样一次普通攻击）。
     * @param onDone 两次动画都结束后的回调（结算伤害 / 落回原位）。
     */
    public playFollowerExchange(attacker: Node, defender: Node, onDone?: () => void): void {
        if (this._busy) { if (onDone) onDone(); return; }
        if (!attacker || !attacker.isValid || !defender || !defender.isValid) {
            if (onDone) onDone();
            return;
        }
        this._busy = true;
        this.playSingleAttack(attacker, defender, () => {
            // 攻击方结束 → 被攻击方反击（同一次普通攻击的表现）
            this.playSingleAttack(defender, attacker, () => {
                this._busy = false;
                if (onDone) onDone();
            });
        });
    }

    /** 随从攻击敌方主战者：只播一次普通攻击（被攻击方不反击）。 */
    public playHeroAttack(attacker: Node, heroNode: Node, onDone?: () => void): void {
        if (this._busy) { if (onDone) onDone(); return; }
        if (!attacker || !attacker.isValid || !heroNode || !heroNode.isValid) {
            if (onDone) onDone();
            return;
        }
        this._busy = true;
        this.playSingleAttack(attacker, heroNode, () => {
            this._busy = false;
            if (onDone) onDone();
        });
    }

    /**
     * 播放**一次普通攻击**：`attacker` 绕 Y 轴旋转 + 特效球从 `attacker` 中心飞向
     * `targetNode` 中心，两者共用 `attackDuration`。
     * @param onDone 本次普通攻击结束后回调（此时卡牌旋转已归零、特效球已释放）。
     */
    /** ★ 本次攻击特效球的颜色覆盖（卡 17 的暗红）。 */
    private _orbColorOverride: Color | null = null;
    /** ★ 本次攻击特效球的轨迹弯曲量覆盖（卡 17 的弧线）。 */
    private _orbCurveOverride: number | null = null;

    public playSingleAttack(
        attacker: Node,
        targetNode: Node,
        onDone?: () => void,
        skipOrb = false,
        orbOpts?: { color?: Color | null; curveOffset?: number | null },
    ): void {
        // ★ 需求（卡 17）：攻击特效**完全用普通攻击的特效球**，只允许改「颜色」和「轨迹」。
        this._orbColorOverride = orbOpts && orbOpts.color ? new Color(orbOpts.color) : null;
        this._orbCurveOverride = orbOpts && typeof orbOpts.curveOffset === 'number' ? orbOpts.curveOffset : null;
        try {
            this.playStrike(attacker, targetNode, true, onDone, skipOrb);
        } finally {
            this._orbColorOverride = null;
            this._orbCurveOverride = null;
        }
    }

    /**
     * **只发特效球、不转卡牌**的一次攻击演出（能力造成的攻击用，如卡 5 的「进化时 破坏」）。
     *
     * 与 `playSingleAttack` 的**唯一区别** = 不写 `attacker.eulerAngles`（卡牌一动不动），
     * 球的素材 / 尺寸 / 染色 / 加色 / 曲线偏移 / 时长**全部沿用同一套 Inspector 参数**。
     * @param onDone 球飞完后的回调（此时特效球已释放；卡牌从未被改动，无需复位）。
     */
    public playOrbAttack(attacker: Node, targetNode: Node, onDone?: () => void): void {
        this.playStrike(attacker, targetNode, false, onDone);
    }

    /**
     * 一次攻击演出的共用实现（特效球 + 可选的卡牌旋转，两者由**同一条数值补间**驱动 ⇒ 时间不可能漂移）。
     * @param spin true = 卡牌绕 Y 轴转 `spinDegrees`（普通攻击）；false = 卡牌完全不旋转（只发球）
     */
    private playStrike(attacker: Node, targetNode: Node, spin: boolean, onDone?: () => void, skipOrb = false): void {
        if (!attacker || !attacker.isValid || !targetNode || !targetNode.isValid) {
            if (onDone) onDone();
            return;
        }

        const duration = this.singleAttackDuration;

        // 特效球（资源未就绪 / 找不到宿主时返回 null —— 仍照常播卡牌旋转）
        // ★ `skipOrb`：卡牌有**自己的攻击特性特效**（如卡 12 的电浆闪电）时，
        //   只借这里的**卡牌旋转**，内置特效球交给调用方去放 ⇒ 不会出现「双弹」。
        let orb: FollowerAttackOrbHandle | null = null;
        const host = this.fxLayer();
        if (host && !skipOrb) {
            try {
                const from = nodeCenterWorld(attacker, _tmpA);
                const to = nodeCenterWorld(targetNode, _tmpB);
                orb = createFollowerAttackOrb(host, from, to, {
                    size: this.orbSize,
                    // ★ 每卡覆盖：颜色（卡 17 暗红）/ 轨迹（卡 17 弧线）—— 球本体与其余参数完全沿用普通攻击
                    color: this._orbColorOverride || this.orbColor,
                    additive: this.orbAdditive,
                    intensity: this.orbIntensity,
                    curveOffset: this._orbCurveOverride === null ? this.curveOffset : this._orbCurveOverride,
                });
            } catch (e) {
                console.warn('[FollowerAttackAnim] 创建攻击特效球失败：', e);
                orb = null;
            }
        }

        // 进入攻击前的欧拉角（结束时要**显式写回**，不留浮点残差）。
        // 🔴 只发球（spin=false）时**一次都不写** eulerAngles —— 连「写回原值」都不做，
        //    免得与别的系统（进化动画 / 卡牌自身朝向）抢同一份旋转。
        const home = attacker.eulerAngles.clone();

        const state = { p: 0 };
        let done = false;
        const finish = (): void => {
            if (done) return;
            done = true;
            if (spin) {
                try {
                    if (attacker.isValid) attacker.setRotationFromEuler(home.x, home.y, home.z);
                } catch (e) { /* 节点可能已被销毁，忽略 */ }
            }
            try { if (orb) orb.dispose(); } catch (e) { /* 同上 */ }
            try { if (onDone) onDone(); } catch (e) {
                console.error('[FollowerAttackAnim] 普通攻击完成回调出错：', e);
            }
        };

        try {
            tween(state)
                .to(duration, { p: 1 }, {
                    easing: 'linear',
                    // 🔴 tween 回调里的异常会被 TweenSystem 吞掉 → 一律包 try/catch
                    onUpdate: (t) => {
                        if (done) return;
                        try {
                            const p = (t as { p: number }).p;
                            if (spin && attacker.isValid) {
                                attacker.setRotationFromEuler(home.x, home.y + this.spinDegrees * p, home.z);
                            }
                            if (orb) orb.setProgress(p);
                        } catch (e) { /* 单帧异常忽略，让动画继续 */ }
                    },
                })
                .call(() => finish())   // 🔴 不要在 .call 里提前置 done：finish 自己就有守卫
                .start();
        } catch (e) {
            console.error('[FollowerAttackAnim] 播放普通攻击动画出错：', e);
            finish();
        }
    }

    // ------------------------------ 专图层 & 坐标 ------------------------------
    /** 取/建特效球专图层（Canvas 下动态节点，始终置顶） */
    private fxLayer(): Node | null {
        if (this._layer && this._layer.isValid) {
            const parent = this._layer.parent;
            if (parent) this._layer.setSiblingIndex(parent.children.length - 1);
            return this._layer;
        }
        const canvas = this.canvasNode();
        if (!canvas) return null;
        const n = new Node('BattleFxLayer');
        n.setParent(canvas);
        const ut = n.addComponent(UITransform);
        ut.setAnchorPoint(0.5, 0.5);
        ut.setContentSize(1280, 720);
        n.setPosition(0, 0, 0);                 // Canvas 局部原点 = 屏幕正中心
        n.setSiblingIndex(canvas.children.length - 1);
        this._layer = n;
        return n;
    }

    /** 沿父链找 Canvas（本引擎的 Node 没有 getComponentInParent，只能手动走父链） */
    private canvasNode(): Node | null {
        let n: Node | null = this.node;
        while (n) {
            if (n.getComponent(Canvas)) return n;
            n = n.parent;
        }
        return null;
    }
}

// ============================================================================
// 工具
// ============================================================================
const _tmpA = new Vec3();
const _tmpB = new Vec3();
const _off = new Vec3();

/**
 * 取节点的**可视中心**世界坐标（锚点不一定是 (0.5,0.5)，按锚点反推偏移）。
 * @returns 写入 `out` 并返回（out 由调用方提供，避免每帧分配）。
 */
function nodeCenterWorld(node: Node, out: Vec3): Vec3 {
    const ut = node.getComponent(UITransform);
    if (!ut) return Vec3.copy(out, node.worldPosition);
    _off.set((0.5 - ut.anchorX) * ut.contentSize.width, (0.5 - ut.anchorY) * ut.contentSize.height, 0);
    return ut.convertToWorldSpaceAR(_off, out);
}
