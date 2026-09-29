import {
    _decorator, Color, Component, Label, LabelOutline, Node, Tween, tween, UITransform, Vec2, Vec3,
} from 'cc';
import { killNode } from './CardComposer';
import { HeroArea } from './HeroArea';
import { setNumberSink } from './DamageNumberQueue';

const { ccclass, property, menu } = _decorator;

/** 飘字节点名前缀 */
const NUM_NODE_PREFIX = 'DmgNum_';

/**
 * DamageNumberFx —— 随从 / 主战者**受伤或治疗时的飘字**
 * ===========================================================================
 * 需求（用户口径）：
 *   · 随从：**被攻击特效动画播完那一刻**（= 演出队列的 RefreshNumbers 时点），在**卡图中央**出现数字；
 *     受伤 = **红色**，治疗 = **绿色**；
 *   · 主战者：同样红/绿，位置按主战者头像（敌我各一个偏移）；
 *   · 在 Cocos 里暴露**整体大小**与**相对随从 / 主战者的位置**变量（见下面 @property）。
 *
 * 数据来源：`BattleDisplayBatch`（每段演出后的血量快照）—— 本组件自己记住「上次显示过的血量」，
 * 差值就是本次的伤害/治疗量（正数 = 掉血 = 红，负数 = 回血 = 绿）。
 * ===========================================================================
 */
@ccclass('DamageNumberFx')
@menu('gf2szb/DamageNumberFx')
export class DamageNumberFx extends Component {

    private static _inst: DamageNumberFx | null = null;
    public static get instance(): DamageNumberFx | null {
        return (DamageNumberFx._inst && DamageNumberFx._inst.isValid) ? DamageNumberFx._inst : null;
    }

    @property({ range: [10, 200, 1], slide: true, tooltip: '★【整体大小】飘字字号（px）。' })
    fontSize = 64;

    @property({ type: Vec2, tooltip: '★【随从位置偏移】相对**卡牌中心**的偏移（px，x 右为正 / y 上为正）。' })
    followerOffset = new Vec2(0, 0);

    @property({ type: Vec2, tooltip: '★【我方主战者偏移】相对我方主战者节点的偏移（px）。\\n主战者节点原点在屏幕边缘 ⇒ 默认往画面内偏（我方在下方 ⇒ y 为正）。' })
    heroOffsetPlayer = new Vec2(0, 96);

    @property({ type: Vec2, tooltip: '★【敌方主战者偏移】相对敌方主战者节点的偏移（px）。\\n敌方主战者节点在屏幕上方 ⇒ y 为负才是往画面内。' })
    heroOffsetEnemy = new Vec2(0, -96);

    @property({ range: [0.05, 1, 0.01], slide: true,
        tooltip: '★【同目标多条飘字的间隔】秒。同一批里打在同一个目标上的多次伤害（如两个「持续的轰炸」护符）\n'
            + '按这个间隔**依次**出现 —— 用户口径：要看到两次 2，而不是合并成一个 4。' })
    numberStagger = 0.22;

    @property({ range: [0, 80, 1], slide: true,
        tooltip: '★【同目标多条飘字的错位】px。第 n 条往上错开 n×本值，避免完全重叠。' })
    numberStackOffset = 20;

    @property({ type: Color, tooltip: '★【受伤颜色】默认红。' })
    damageColor = new Color(255, 60, 48, 255);

    @property({ type: Color, tooltip: '★【治疗颜色】默认绿。' })
    healColor = new Color(80, 226, 90, 255);

    @property({ range: [0, 4, 0.01], slide: true, tooltip: '【描边宽度】数字描边（深色，保证任何底色都看得清）。' })
    outlineWidth = 4;

    @property({ type: Color, tooltip: '【描边颜色】' })
    outlineColor = new Color(40, 20, 16, 255);

    @property({ range: [0.2, 5, 0.01], slide: true, tooltip: '★【显示时间】数字完整显示多久（秒），默认 1s；之后才开始渐渐消失。' })
    displayTime = 1.0;

    @property({ range: [0.05, 2, 0.01], slide: true, tooltip: '★【消失时间】渐渐淡出的时长（秒）。' })
    fadeTime = 0.35;

    @property({ range: [0, 200, 1], slide: true, tooltip: '【上升距离】飘字期间向上飘多少 px。' })
    riseDistance = 54;

    @property({ range: [0, 3, 0.01], slide: true, tooltip: '【起始放大】出现瞬间的放大倍数（1 = 不放大）。' })
    popScale = 1.35;

    private readonly _lastHp = new WeakMap<Node, number>();
    private readonly _live: Node[] = [];

    onLoad(): void {
        DamageNumberFx._inst = this;
        // ★ 注册为飘字消费者：兜底路径（有些能力不压 RefreshNumbers cue）也能把数字播出来
        try { setNumberSink((list) => this.playRecorded(list)); } catch (e) { /* 忽略 */ }
        // ★ 开局就把**主战者**的当前血量记下来：否则「第一次受到伤害/治疗」因为没有基准值而被跳过
        //   ⇒ 玩家看到的就是「主战者有时候不显示数字」（用户报的 bug）。
        this.scheduleOnce(() => this.seedAllHeroes(), 0.1);
    }

    /** 把场上所有主战者的当前血量记为基准。 */
    private seedAllHeroes(): void {
        try {
            const scene = this.node.scene as unknown as Node | null;
            if (!scene) return;
            const stack: Node[] = [...scene.children];
            while (stack.length > 0) {
                const cur = stack.shift() as Node;
                const h = cur.getComponent(HeroArea) as HeroArea | null;
                if (h && typeof h.hp === 'number') this.seed(cur, h.hp);
                for (const ch of cur.children) stack.push(ch);
            }
        } catch (e) { /* 忽略 */ }
    }
    onDestroy(): void {
        if (DamageNumberFx._inst === this) DamageNumberFx._inst = null;
        for (const n of this._live.slice()) { if (n && n.isValid) { try { killNode(n); } catch (e) { /* 忽略 */ } } }
        this._live.length = 0;
    }

    /** ★ 该主战者节点属于哪一方（0 = 我方 / 1 = 敌方；查不到按我方）。 */
    private heroSideOf(node: Node | null): number {
        try {
            const h = node ? node.getComponent(HeroArea) : null;
            if (h) return Number(h.side) === 1 ? 1 : 0;
        } catch (e) { /* 忽略 */ }
        return 0;
    }

    /** 记下某张卡/主战者**当前显示的血量**（首次调用只记录，不飘字）。 */
    public seed(node: Node | null, hp: number): void {
        if (!node || !node.isValid) return;
        this._lastHp.set(node, Math.round(hp));
    }

    /**
     * 用一段演出的血量快照刷飘字（在 RefreshNumbers 时点调用）。
     * @returns 本次飘了几个字
     */
    public consumeBatch(batch: { cards?: Map<Node, { hp?: number }>; heroes?: Map<HeroArea, number> } | null): number {
        if (!batch) return 0;
        let n = 0;
        try {
            if (batch.cards) {
                batch.cards.forEach((snap, node) => {
                    if (!node || !node.isValid || !snap || typeof snap.hp !== 'number') return;
                    const cur = Math.round(snap.hp);
                    const prev = this._lastHp.get(node);
                    this._lastHp.set(node, cur);
                    if (prev === undefined) return;                 // 第一次见到 → 只记不发
                    const delta = prev - cur;
                    if (delta === 0) return;
                    this.spawn(node, delta, delta > 0);
                    n++;
                });
            }
            if (batch.heroes) {
                batch.heroes.forEach((hp, hero) => {
                    const node = hero && hero.isValid ? hero.node : null;
                    if (!node || !node.isValid || typeof hp !== 'number') return;
                    const cur = Math.round(hp);
                    const prev = this._lastHp.get(node);
                    this._lastHp.set(node, cur);
                    if (prev === undefined) return;
                    const delta = prev - cur;
                    if (delta === 0) return;
                    this.spawn(node, delta, delta > 0, true);
                    n++;
                });
            }
        } catch (e) {
            console.error('[DamageNumberFx] 刷新飘字失败：', e);
        }
        return n;
    }

    /**
     * ★ 播一批**登记好的**飘字（演出队列在 RefreshNumbers 时点调用）。
     * 数据来自 DamageNumberQueue（谁改血谁登记）⇒ 不依赖「上次显示基准」，不会时有时无。
     * @returns 实际飘了几个
     */
    public playRecorded(list: Array<{ anchor?: unknown; delta?: number; isHero?: boolean }> | null): number {
        if (!list || list.length === 0) return 0;
        // ★★ **同一批里同一个目标的多次伤害：按顺序逐个飘**（用户口径）。
        //   例：场上两个「持续的轰炸」护符各自在回合结束打 2 点 —— 护符是**先后触发**的，
        //   玩家要看到两条 "2" 依次出现，而不是合并成一个 "4"。
        //   实现：同目标的第 n 条延后 `numberStagger × n` 秒出现，并给一点垂直错位，避免完全重叠。
        const merged: Array<{ anchor: Node | null; delta: number; isHero: boolean; blocked: boolean; allowZero: boolean; wx?: number; wy?: number; wz?: number }> = [];
        const at = new Map<string, number>();
        for (const raw of list) {
            const it = raw as {
                anchor?: unknown; delta?: number; isHero?: boolean; blocked?: boolean; allowZero?: boolean;
                wx?: number; wy?: number; wz?: number;
            };
            const anchor = (it && it.anchor) as Node | null;
            const delta = Math.round(Number(it && it.delta) || 0);
            const blocked = !!(it && it.blocked);
            const allowZero = !!(it && it.allowZero);
            const isHero = !!(it && it.isHero);
            const alive = !!(anchor && anchor.isValid);
            const hasPos = typeof it?.wx === 'number' && typeof it?.wy === 'number';
            if (!alive && !hasPos) continue;
            // 合并键：同一节点（或同一坐标）+ 同类型（随从/主战者）+ 同「被挡」状态
            const key = alive
                ? ('n:' + anchor!.uuid + ':' + (isHero ? 'h' : 'f') + ':' + (blocked ? 'b' : '-'))
                : ('p:' + (it?.wx) + ',' + (it?.wy) + ':' + (isHero ? 'h' : 'f'));
            const idx = at.get(key);
            if (idx !== undefined) { /* 不合并：同目标的多条各自成一条（下面按序号错开时间） */ }
            at.set(key, merged.length);
            merged.push({ anchor, delta, isHero, blocked, allowZero, wx: it?.wx, wy: it?.wy, wz: it?.wz });
        }
        // 同目标出现的**序号**（第 1 条立即、第 2 条延后一格……）—— 保证「依次可见」。
        const seq = new Map<string, number>();
        let n = 0;
        for (const it of merged) {
            const anchor = it.anchor;
            const delta = it.delta;
            const blocked = it.blocked;
            const allowZero = it.allowZero;
            const hasPos = typeof it.wx === 'number' && typeof it.wy === 'number';
            if ((!anchor || !anchor.isValid) && !hasPos) continue;      // 节点没了但记了坐标 ⇒ 照样飘
            // 0 值：被挡下的伤害 ⇒ 红 0；满血被治疗 ⇒ 绿 +0（显示实际治疗值）；其它 0 不飘
            if (delta === 0 && !blocked && !allowZero) continue;
            const alive = !!(anchor && anchor.isValid);
            const key = alive ? ('n:' + anchor!.uuid + ':' + (it.isHero ? 'h' : 'f') + ':' + (blocked ? 'b' : '-'))
                : ('p:' + it.wx + ',' + it.wy + ':' + (it.isHero ? 'h' : 'f'));
            const order = seq.get(key) || 0;
            seq.set(key, order + 1);
            const delay = order * Math.max(0.05, this.numberStagger);
            const stack = { x: 0, y: order * Math.max(0, this.numberStackOffset) };
            const fire = (): void => {
                try {
                    // ★ 「被挡下的伤害」永远是**红色 0**（不是绿色 +0）——屏障/超进化守护挡伤都属于这类
                    this.spawn(anchor, delta, blocked ? true : delta > 0, it.isHero,
                        hasPos ? { x: it.wx!, y: it.wy!, z: it.wz } : undefined, stack);
                } catch (e) { /* 忽略 */ }
            };
            if (delay > 0) this.scheduleOnce(fire, delay);
            else fire();
            n++;
        }
        return n;
    }

    /**
     * 直接飘一个数字（也可以给别的系统调用）。
     * @param anchor 卡牌 / 主战者节点（用它的世界坐标）
     * @param amount 正数 = 掉血（红）；负数 = 回血（绿）
     * @param isHero 是否按主战者的偏移（true 用 heroOffset）
     */
    public spawn(anchor: Node | null, amount: number, isDamage: boolean, isHero = false, worldPos?: { x: number; y: number; z?: number }, stackOffset?: { x: number; y: number }): void {
        if (!this.node || !this.node.isValid) return;
        // ★ 锚点可能已经被销毁（致命伤害先破坏再演出）⇒ 用登记时记下的世界坐标兜底
        const aliveAnchor = !!(anchor && anchor.isValid);
        if (!aliveAnchor && !worldPos) return;
        // ★ 主战者按**阵营**取偏移：我方节点在屏幕下边缘、敌方在上边缘，符号相反（否则数字跑到屏幕外）。
        const off = isHero ? (this.heroSideOf(anchor) === 0 ? this.heroOffsetPlayer : this.heroOffsetEnemy) : this.followerOffset;
        const base = aliveAnchor ? anchor!.worldPosition.clone() : new Vec3(worldPos!.x, worldPos!.y, worldPos!.z || 0);
        const world = new Vec3(base.x + (off ? off.x : 0) + (stackOffset ? stackOffset.x : 0),
            base.y + (off ? off.y : 0) + (stackOffset ? stackOffset.y : 0), base.z);
        const hostUT = this.node.getComponent(UITransform);
        const local = hostUT ? hostUT.convertToNodeSpaceAR(world, new Vec3()) : world;

        const node = new Node(NUM_NODE_PREFIX + Math.abs(Math.round(amount)));
        node.layer = this.node.layer;
        node.setParent(this.node);
        const ut = node.addComponent(UITransform);
        ut.setAnchorPoint(0.5, 0.5);
        ut.setContentSize(220, this.fontSize + 20);
        const lb = node.addComponent(Label);
        lb.string = (isDamage ? '' : '+') + Math.abs(Math.round(amount));
        lb.fontSize = this.fontSize;
        lb.lineHeight = this.fontSize + 6;
        lb.isBold = true;
        lb.color = isDamage ? new Color(this.damageColor) : new Color(this.healColor);
        lb.enableOutline = true;
        lb.outlineColor = new Color(this.outlineColor);
        lb.outlineWidth = Math.max(0, this.outlineWidth);
        node.setPosition(local.x, local.y, 0);
        node.setScale(this.popScale, this.popScale, 1);
        this._live.push(node);

        const st = { p: 0 };
        // ★ 需求：数字**完整显示 displayTime 秒**之后，才用 fadeTime 渐渐消失。
        const hold = Math.max(0.1, this.displayTime);
        const fade = Math.max(0.05, this.fadeTime);
        const dur = hold + fade;
        let settled = false;
        const finish = (): void => {
            if (settled) return;
            settled = true;
            try { Tween.stopAllByTarget(st); } catch (e) { /* 忽略 */ }
            const i = this._live.indexOf(node);
            if (i >= 0) this._live.splice(i, 1);
            if (node.isValid) { try { killNode(node); } catch (e) { /* 忽略 */ } }
        };
        try {
            tween(st)
                .to(dur, { p: 1 }, {
                    easing: 'quadOut',
                    onUpdate: () => {
                        if (settled || !node.isValid) return;
                        const k = st.p;
                        node.setPosition(local.x, local.y + this.riseDistance * k, 0);
                        const s = this.popScale + (1 - this.popScale) * Math.min(1, k / 0.25);
                        node.setScale(s, s, 1);
                        // 前 hold 秒保持不透明，最后 fade 秒线性淡出
                        const fadeK = k <= hold ? 0 : (k - hold) / fade;
                        const c = lb.color.clone();
                        c.a = Math.round(255 * (1 - Math.min(1, Math.max(0, fadeK))));
                        lb.color = c;
                    },
                })
                .call(() => finish())
                .start();
            this.scheduleOnce(() => finish(), dur + 0.5);          // 熔断
        } catch (e) {
            console.error('[DamageNumberFx] 飘字动画出错：', e);
            finish();
        }
    }
}
