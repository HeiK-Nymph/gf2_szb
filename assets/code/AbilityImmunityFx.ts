import { _decorator, Color, Component, Node, resources, Sprite, SpriteFrame, tween, Tween, UITransform } from 'cc';
import { killNode } from './CardComposer';
import { BarrierFx } from './BarrierFx';

const { ccclass, property, menu } = _decorator;

/** 不会被能力破坏的黄色护罩节点名（挂成卡牌子节点）。 */
export const ABILITY_IMMUNITY_NODE = 'AbilityImmunityAura';
/** 复用屏障素材；两者都靠节点色染成各自风格。 */
const TEX_PATH = 'effects/Barrier/shieldWhite_Edit/spriteFrame';

/**
 * AbilityImmunityFx —— 【不会被能力破坏】卡牌上的**黄色护罩**。
 *
 * 参照 BarrierFx，但只做常驻展示，不参与伤害消耗：
 *   · 白图靠节点色染成黄色；
 *   · 包住卡牌本体，并插在攻击 / 血量徽标下方；
 *   · 常驻轻微呼吸；
 *   · 参数从场景常驻宿主 `Canvas/AbilityImmunityFx` 读取，便于 Inspector 统一调参。
 */
@ccclass('AbilityImmunityFx')
@menu('gf2szb/AbilityImmunityFx')
export class AbilityImmunityFx extends Component {

    @property({ type: Color, tooltip: '护罩颜色（黄色）。素材是白图，靠节点色染色。' })
    color = new Color(255, 214, 70, 235);

    @property({
        range: [0.4, 3, 0.01], slide: true,
        tooltip: '【整体大小】护罩边长 = 卡牌高 × 该倍数（>1 才能包住卡牌）。\n在 Canvas/AbilityImmunityFx 上调，所有卡通用。',
    })
    sizeRatio = 0.84;

    @property({ range: [0, 4, 0.01], slide: true, tooltip: '护罩呼吸幅度（0 = 不呼吸）。' })
    breath = 0.035;

    private static _sf: SpriteFrame | null = null;
    private static _loading = false;
    private static _warned = false;
    private static _host: AbilityImmunityFx | null = null;

    public static get host(): AbilityImmunityFx | null {
        return (AbilityImmunityFx._host && AbilityImmunityFx._host.isValid) ? AbilityImmunityFx._host : null;
    }

    onLoad(): void {
        if (!AbilityImmunityFx.isCardNode(this.node)) AbilityImmunityFx._host = this;
        AbilityImmunityFx.preload();
    }

    private static isCardNode(node: Node | null): boolean {
        if (!node || !node.isValid) return false;
        return /^Card_/.test(node.name || '') || /^BF_/.test(node.name || '');
    }

    public static preload(): void {
        if (AbilityImmunityFx._sf || AbilityImmunityFx._loading) return;
        AbilityImmunityFx._loading = true;
        resources.load(TEX_PATH, SpriteFrame, (err, sf) => {
            AbilityImmunityFx._loading = false;
            if (err || !sf) {
                if (!AbilityImmunityFx._warned) {
                    AbilityImmunityFx._warned = true;
                    console.warn('[AbilityImmunityFx] 加载护罩素材失败："' + TEX_PATH + '" ->', err);
                }
                return;
            }
            AbilityImmunityFx._sf = sf as SpriteFrame;
        });
    }

    /** 给一张卡上黄色护罩（重复调用只刷新）。 */
    public static attach(card: Node | null): void {
        if (!card || !card.isValid) return;
        AbilityImmunityFx.preload();
        const fx = card.getComponent(AbilityImmunityFx) || card.addComponent(AbilityImmunityFx);
        if (fx.hasAura) return;
        fx.show();
        if (!fx.hasAura) {
            let tries = 0;
            const retry = (): void => {
                if (!card || !card.isValid) return;
                const f = card.getComponent(AbilityImmunityFx);
                if (!f) return;
                f.show();
                if (!f.hasAura && ++tries < 15) setTimeout(retry, 120);
            };
            setTimeout(retry, 120);
        }
    }

    public static detach(card: Node | null): void {
        if (!card || !card.isValid) return;
        const fx = card.getComponent(AbilityImmunityFx);
        if (fx) fx.clear();
    }

    public static setSuppressed(card: Node | null, on: boolean): void {
        if (!card || !card.isValid) return;
        const fx = card.getComponent(AbilityImmunityFx);
        if (!fx) return;
        fx._suppressed = !!on;
        if (fx._aura && fx._aura.isValid) fx._aura.active = !on;
    }

    private _aura: Node | null = null;
    private readonly _state = { p: 0 };
    private _suppressed = false;

    private get cfgSizeRatio(): number {
        // ★ 与蓝色屏障共用同一尺寸口径：屏障宿主在场景里调大 / 调小时，黄色护罩同步。
        const barrier = BarrierFx.host;
        if (barrier && barrier.isValid) return Math.max(0.2, Number(barrier.sizeRatio) || 1);
        const host = AbilityImmunityFx.host;
        const v = (host && host !== this) ? host.sizeRatio : this.sizeRatio;
        return Math.max(0.2, Number(v) || 1);
    }

    private get cfgColor(): Color {
        const host = AbilityImmunityFx.host;
        const c = (host && host !== this) ? host.color : this.color;
        return c ? new Color(c) : new Color(255, 214, 70, 235);
    }

    private get cfgBreath(): number {
        const host = AbilityImmunityFx.host;
        const v = (host && host !== this) ? host.breath : this.breath;
        return Math.max(0, Number(v) || 0);
    }

    public get hasAura(): boolean {
        return !!this._aura && this._aura.isValid && this._aura.active;
    }

    onDisable(): void { this.clear(); }

    onDestroy(): void {
        if (AbilityImmunityFx._host === this) AbilityImmunityFx._host = null;
        this.clear();
    }

    private show(): void {
        const sf = AbilityImmunityFx._sf;
        if (!sf || !sf.isValid) {
            AbilityImmunityFx.preload();
            return;
        }

        const card = this.node;
        const ut = card.getComponent(UITransform);
        const cw = ut ? ut.contentSize.width : 186;
        const ch = ut ? ut.contentSize.height : 254;
        let aura = this._aura;
        if (!aura || !aura.isValid) {
            aura = new Node(ABILITY_IMMUNITY_NODE);
            aura.layer = card.layer;
            aura.setParent(card);
            const aut = aura.addComponent(UITransform);
            aut.setAnchorPoint(0.5, 0.5);
            const sp = aura.addComponent(Sprite);
            sp.sizeMode = Sprite.SizeMode.CUSTOM;
            sp.type = Sprite.Type.SIMPLE;
            sp.spriteFrame = sf;
            this._aura = aura;
        }

        const sp2 = aura.getComponent(Sprite);
        if (sp2) {
            sp2.spriteFrame = sf;
            sp2.color = new Color(this.cfgColor);
        }

        const side = Math.max(cw * this.cfgSizeRatio, ch * this.cfgSizeRatio);
        const aut2 = aura.getComponent(UITransform);
        if (aut2) aut2.setContentSize(side, side);
        aura.setPosition(0, 0, 0);
        aura.setScale(1, 1, 1);
        aura.active = !this._suppressed;
        this.placeBehindBadges(aura, card);
        this.startBreath();
    }

    /** 插到攻击 / 血量徽标下方；找不到就放最底层。 */
    private placeBehindBadges(aura: Node, card: Node): void {
        try {
            let minIdx = -1;
            for (const child of card.children) {
                const n = child.name || '';
                if (/Attack|Hp|HpNum|Atk/i.test(n) && child !== aura) {
                    const i = card.children.indexOf(child);
                    if (i >= 0 && (minIdx < 0 || i < minIdx)) minIdx = i;
                }
            }
            aura.setSiblingIndex(minIdx > 0 ? minIdx : 0);
        } catch (e) { /* 忽略 */ }
    }

    private startBreath(): void {
        const aura = this._aura;
        if (!aura || !aura.isValid || this.cfgBreath <= 0) return;
        try {
            Tween.stopAllByTarget(this._state);
            this._state.p = 0;
            tween(this._state)
                .to(1.1, { p: 1 }, {
                    easing: 'sineInOut',
                    onUpdate: () => {
                        if (!aura.isValid) return;
                        const k = 1 + this.cfgBreath * Math.sin(this._state.p * Math.PI);
                        aura.setScale(k, k, 1);
                    },
                })
                .to(1.1, { p: 0 }, {
                    easing: 'sineInOut',
                    onUpdate: () => {
                        if (!aura.isValid) return;
                        const k = 1 + this.cfgBreath * Math.sin(this._state.p * Math.PI);
                        aura.setScale(k, k, 1);
                    },
                })
                .union()
                .repeatForever()
                .start();
        } catch (e) { /* 忽略 */ }
    }

    private clear(): void {
        try { Tween.stopAllByTarget(this._state); } catch (e) { /* 忽略 */ }
        const aura = this._aura;
        this._aura = null;
        if (aura && aura.isValid) {
            try { killNode(aura); } catch (e) { /* 忽略 */ }
        }
    }
}

/** 供逻辑层调用：给一张卡上“不会被能力破坏”的黄色护罩。 */
export function attachAbilityImmunityFx(card: Node | null): void {
    AbilityImmunityFx.attach(card);
}

/** 供逻辑层调用：移除护罩。 */
export function removeAbilityImmunityFx(card: Node | null): void {
    AbilityImmunityFx.detach(card);
}
