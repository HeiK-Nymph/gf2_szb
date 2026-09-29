import { _decorator, Color, Component, Node, resources, Sprite, SpriteFrame, tween, Tween, UITransform, Vec3 } from 'cc';
import { killNode } from './CardComposer';

const { ccclass, property, menu } = _decorator;

/** 屏障罩节点名（挂成**卡牌子节点**） */
export const BARRIER_NODE = 'BarrierShield';
/** 素材（运行时 resources 路径，子资源带 /spriteFrame） */
const TEX_PATH = 'effects/Barrier/shieldWhite_Edit/spriteFrame';

/**
 * BarrierFx —— 【屏障】卡牌上的**蓝色护盾罩**
 * ===========================================================================
 * 需求（用户口径）：
 *   · 蓝色风格（素材是白色图 → 用**节点色**染成蓝）；
 *   · **包住卡牌**（比卡牌本体略大，形成一圈罩），
 *   · 🔴 **不要遮挡攻击 / 血量图标** ⇒ 罩节点插在「卡牌视觉的最底层之后、ATK/HP 徽标之前」：
 *     实测做法 = 把罩作为卡牌子节点，并把它的 siblingIndex 压到**两个徽标里更靠前的那个之前**；
 *     找不到徽标就放到最底层（宁可压在卡面下，也不盖住数值）。
 * 用法：`BarrierFx.attach(card)` 上罩；`BarrierFx.breakOn(card)` 播破碎并移除。
 * ===========================================================================
 */
@ccclass('BarrierFx')
@menu('gf2szb/BarrierFx')
export class BarrierFx extends Component {

    @property({ type: Color, tooltip: '★ 屏障颜色（蓝）。素材是白图，靠节点色染色。' })
    color = new Color(96, 186, 255, 235);

    @property({ range: [0.4, 3, 0.01], slide: true, tooltip: '★【屏障整体大小】罩的边长 = 卡牌高 × 该倍数（>1 才能「包住」卡牌）。\\n在场景节点 Canvas/BarrierFx 上调，所有卡通用。' })
    sizeRatio = 1.14;

    @property({ range: [0, 4, 0.01], slide: true, tooltip: '罩的呼吸幅度（0 = 不呼吸）。' })
    breath = 0.035;

    @property({ range: [0.05, 2, 0.01], slide: true, tooltip: '破碎演出时长（秒）。' })
    breakDuration = 0.28;

    private static _sf: SpriteFrame | null = null;
    private static _loading = false;
    private static _warned = false;
    /**
     * ★ **常驻宿主**（场景节点 `Canvas/BarrierFx` 上的那一份）。
     * 卡上的罩是运行时 `addComponent` 出来的（永远读类默认值，Inspector 改不到），
     * 所以**参数统一从宿主读** ⇒ 在 Cocos 里调宿主的 `sizeRatio` / `color` 就能整体调大小 / 配色。
     */
    private static _host: BarrierFx | null = null;

    public static get host(): BarrierFx | null {
        return (BarrierFx._host && BarrierFx._host.isValid) ? BarrierFx._host : null;
    }

    onLoad(): void {
        // 🔴 只有**常驻宿主**（场景节点 Canvas/BarrierFx）才能当参数源：
        //    卡上的罩也是本组件实例，若它们也把自己写成宿主，就会把宿主覆盖掉
        //    ⇒ Inspector 里调 sizeRatio 不生效（实测踩过：改成 1.4 罩还是 321）。
        if (!BarrierFx.isCardNode(this.node)) BarrierFx._host = this;
        BarrierFx.preload();
    }

    /** 这个节点是不是「卡牌」（Card_xxx / BF_xxx）—— 卡上的实例不能当参数源。 */
    private static isCardNode(node: Node | null): boolean {
        if (!node || !node.isValid) return false;
        const n = node.name || '';
        return /^Card_/.test(n) || /^BF_/.test(n);
    }

    /** 预载素材（找不到也不影响逻辑）。 */
    public static preload(): void {
        if (BarrierFx._sf || BarrierFx._loading) return;
        BarrierFx._loading = true;
        resources.load(TEX_PATH, SpriteFrame, (err, sf) => {
            BarrierFx._loading = false;
            if (err || !sf) {
                if (!BarrierFx._warned) {
                    BarrierFx._warned = true;
                    console.warn('[BarrierFx] 加载屏障素材失败："' + TEX_PATH + '" →', err);
                }
                return;
            }
            BarrierFx._sf = sf as SpriteFrame;
        });
    }

    /** 给一张卡上罩（重复调用只刷新，不重复建）。 */
    public static attach(card: Node | null): void {
        if (!card || !card.isValid) return;
        BarrierFx.preload();
        const fx = card.getComponent(BarrierFx) || card.addComponent(BarrierFx);
        fx.show();
        // 🔴 素材是**异步**加载的：第一帧往往还没到 ⇒ 罩建不出来（实测踩过：词条有、罩没有）。
        //    这里按 120ms 重试最多 15 次（约 1.8s），到齐了就把罩补上；到点还没到就放弃（只影响外观）。
        if (!fx.hasShield) {
            let tries = 0;
            const retry = (): void => {
                if (!card || !card.isValid) return;
                const f = card.getComponent(BarrierFx);
                if (!f) return;
                f.show();
                if (!f.hasShield && ++tries < 15) setTimeout(retry, 120);
            };
            setTimeout(retry, 120);
        }
    }

    /** 屏障发动（被打掉）时的破碎演出。 */
    public static breakOn(card: Node | null): void {
        if (!card || !card.isValid) return;
        const fx = card.getComponent(BarrierFx);
        if (fx) fx.playBreak();
    }

    /** 卡牌离开战场 / 被销毁时清掉罩（由调用方按需触发）。 */
    public static detach(card: Node | null): void {
        if (!card || !card.isValid) return;
        const fx = card.getComponent(BarrierFx);
        if (fx) fx.clear();
    }

    private _shield: Node | null = null;
    private readonly _state = { p: 0 };
    /** ★ 被压制期间（进化动画等）不显示罩。 */
    private _suppressed = false;

    /**
     * ★ 压制 / 解除压制屏障罩 —— 需求：**进化动画期间不要有屏障特效**
     * （动画开始藏起来、完全结束再恢复）。找不到组件时静默。
     */
    public static setSuppressed(card: Node | null, on: boolean): void {
        if (!card || !card.isValid) return;
        const fx = card.getComponent(BarrierFx);
        if (!fx) return;
        fx._suppressed = !!on;
        if (fx._shield && fx._shield.isValid) fx._shield.active = !on;
    }

    /** ★ 生效的**整体大小倍数**：宿主（Inspector 可调）优先，卡上那份兜底。 */
    private get cfgSizeRatio(): number {
        const host = BarrierFx.host;
        const v = (host && host !== this) ? host.sizeRatio : this.sizeRatio;
        return Math.max(0.2, Number(v) || 1);
    }
    /** ★ 生效的颜色：宿主优先。 */
    private get cfgColor(): Color {
        const host = BarrierFx.host;
        const c = (host && host !== this) ? host.color : this.color;
        return c ? new Color(c) : new Color(96, 186, 255, 235);
    }
    /** ★ 生效的呼吸幅度：宿主优先。 */
    private get cfgBreath(): number {
        const host = BarrierFx.host;
        const v = (host && host !== this) ? host.breath : this.breath;
        return Math.max(0, Number(v) || 0);
    }

    onDisable(): void { this.clear(); }
    onDestroy(): void {
        if (BarrierFx._host === this) BarrierFx._host = null;
        this.clear();
    }

    public get hasShield(): boolean { return !!this._shield && this._shield.isValid && this._shield.active; }

    private show(): void {
        const sf = BarrierFx._sf;
        if (!sf || !sf.isValid) { BarrierFx.preload(); return; }   // 素材还没到 → 下次 attach 再试
        const card = this.node;
        const ut = card.getComponent(UITransform);
        const cw = ut ? ut.contentSize.width : 186;
        const ch = ut ? ut.contentSize.height : 254;
        let shield = this._shield;
        if (!shield || !shield.isValid) {
            shield = new Node(BARRIER_NODE);
            shield.layer = card.layer;
            shield.setParent(card);
            const sut = shield.addComponent(UITransform);
            sut.setAnchorPoint(0.5, 0.5);
            const sp = shield.addComponent(Sprite);
            sp.sizeMode = Sprite.SizeMode.CUSTOM;
            sp.type = Sprite.Type.SIMPLE;
            sp.spriteFrame = sf;
            this._shield = shield;
        }
        const sp2 = shield.getComponent(Sprite);
        if (sp2) {
            sp2.spriteFrame = sf;
            sp2.color = new Color(this.cfgColor);
        }
        const w = cw * this.cfgSizeRatio;
        const h = ch * this.cfgSizeRatio;
        // 🔴 素材是**正方形**盾牌（556×556）⇒ 直接按卡牌宽高拉伸会变成椭圆（实测截图是「蓝椭圆」）。
        //    这里保持素材比例：取「卡牌高度 × 倍数」作为边长，正方形铺开 ⇒ 盾形完整、且仍包住卡牌。
        const side = Math.max(w, h);
        const sut2 = shield.getComponent(UITransform);
        if (sut2) sut2.setContentSize(side, side);
        shield.setPosition(0, 0, 0);
        shield.setScale(1, 1, 1);
        shield.active = !this._suppressed;      // ★ 被压制（进化动画中）时不显示
        this.placeBehindBadges(shield, card);
        this.startBreath();
    }

    /**
     * 🔴 把罩塞到**攻击 / 血量徽标之下**：找卡牌里名字含 Attack/Hp 的徽标节点，
     * 取它们 siblingIndex 的最小值作为插入位置；找不到就放最底层。
     */
    private placeBehindBadges(shield: Node, card: Node): void {
        try {
            let minIdx = -1;
            for (const ch of card.children) {
                const n = ch.name || '';
                if (/Attack|Hp|HpNum|Atk/i.test(n) && ch !== shield) {
                    const i = card.children.indexOf(ch);
                    if (i >= 0 && (minIdx < 0 || i < minIdx)) minIdx = i;
                }
            }
            shield.setSiblingIndex(minIdx > 0 ? minIdx : 0);
        } catch (e) { /* 忽略 */ }
    }

    private startBreath(): void {
        const shield = this._shield;
        if (!shield || !shield.isValid) return;
        if (this.cfgBreath <= 0) return;
        try {
            Tween.stopAllByTarget(this._state);
            this._state.p = 0;
            tween(this._state)
                .to(1.1, { p: 1 }, {
                    easing: 'sineInOut',
                    onUpdate: () => {
                        if (!shield.isValid) return;
                        const k = 1 + this.cfgBreath * Math.sin(this._state.p * Math.PI);
                        shield.setScale(k, k, 1);
                    },
                })
                .to(1.1, { p: 0 }, {
                    easing: 'sineInOut',
                    onUpdate: () => {
                        if (!shield.isValid) return;
                        const k = 1 + this.cfgBreath * Math.sin(this._state.p * Math.PI);
                        shield.setScale(k, k, 1);
                    },
                })
                .union()
                .repeatForever()
                .start();
        } catch (e) { /* 忽略 */ }
    }

    private playBreak(): void {
        const shield = this._shield;
        if (!shield || !shield.isValid) return;
        try { Tween.stopAllByTarget(this._state); } catch (e) { /* 忽略 */ }
        const st = { p: 0 };
        const dur = Math.max(0.05, this.breakDuration);
        const sp = shield.getComponent(Sprite);
        const base = sp ? new Color(sp.color) : this.cfgColor;
        let settled = false;
        const finish = (): void => {
            if (settled) return;
            settled = true;
            try { Tween.stopAllByTarget(st); } catch (e) { /* 忽略 */ }
            if (shield.isValid) { try { killNode(shield); } catch (e) { /* 忽略 */ } }
            this._shield = null;
        };
        try {
            tween(st)
                .to(dur, { p: 1 }, {
                    easing: 'quadOut',
                    onUpdate: () => {
                        if (settled || !shield.isValid) return;
                        const k = 1 + 0.25 * st.p;
                        shield.setScale(k, k, 1);
                        if (sp) {
                            const c = new Color(base);
                            c.a = Math.round(base.a * (1 - st.p));
                            sp.color = c;
                        }
                    },
                })
                .call(() => finish())
                .start();
            this.scheduleOnce(() => finish(), dur + 0.3);   // 熔断
        } catch (e) { finish(); }
    }

    private clear(): void {
        try { Tween.stopAllByTarget(this._state); } catch (e) { /* 忽略 */ }
        const s = this._shield;
        this._shield = null;
        if (s && s.isValid) { try { killNode(s); } catch (e) { /* 忽略 */ } }
    }
}

/** 供逻辑层调用：屏障被打掉时的破碎演出（找不到宿主就静默）。 */
export function breakBarrierFx(card: Node | null): void {
    BarrierFx.breakOn(card);
}

/** 供逻辑层调用：给一张卡上屏障罩。 */
export function attachBarrierFx(card: Node | null): void {
    BarrierFx.attach(card);
}

void Vec3;
