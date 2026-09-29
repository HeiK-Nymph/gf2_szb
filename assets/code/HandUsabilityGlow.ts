import { _decorator, Color, Component, Node } from 'cc';
import { CardGlow } from './CardGlow';
import { cooperationRequirementOf, getCardInfo, maxEnhanceOf } from './CardData';

import { CardPlay } from './CardPlay';
import { HandLayout } from './HandLayout';
import { HandDrag } from './HandDrag';

const { ccclass, property, menu } = _decorator;

/**
 * HandUsabilityGlow —— 手牌“当前可用”提示光圈。
 *
 * 判定统一交给 CardPlay.canUseCard(id)：费用、队列预留、额外能量点、战场条件都在那里算。
 * 外观沿用疾驰的绿色光圈，但它只是“可用提示”，不会给卡牌添加疾驰词条。
 */
@ccclass('HandUsabilityGlow')
@menu('gf2szb/HandUsabilityGlow')
export class HandUsabilityGlow extends Component {

    @property({ range: [0.02, 0.5, 0.01], slide: true, tooltip: '扫描手牌可用性的间隔（秒）。' })
    scanInterval = 0.08;

    @property({ type: Color, tooltip: '可用提示光圈颜色，默认与疾驰绿色一致。' })
    glowColor = new Color(77, 226, 117, 255);

    @property({ type: Color, tooltip: '★ 已满足【协作】条件的可用手牌用的**黄色选择光圈**（需求）。' })
    cooperationGlowColor = new Color(246, 205, 68, 255);

    @property({ range: [0, 4, 0.01], slide: true })
    maxIntensity = 1.6;

    @property({ range: [0, 64, 0.5], slide: true })
    glowThickness = 40;

    @property({ range: [0, 1, 0.01], slide: true })
    glowSoftness = 0.7;

    @property({ range: [0, 2, 0.01], slide: true })
    fadeInDuration = 0.12;

    @property({ range: [0, 2, 0.01], slide: true })
    fadeOutDuration = 0.12;

    private _acc = 0;
    private readonly _visible: Set<Node> = new Set<Node>();

    update(dt: number): void {
        this._acc += dt;
        if (this._acc < Math.max(0.01, this.scanInterval)) return;
        this._acc = 0;
        this.refresh();
    }

    /** 立刻按当前预算 / 战场条件刷新所有手牌光圈。 */
    public refresh(): void {
        const hand = this.handLayout && this.handLayout.isValid
            ? this.handLayout
            : this.getComponent(HandLayout);
        const play = this.cardPlay && this.cardPlay.isValid
            ? this.cardPlay
            : this.getComponent(CardPlay);
        const drag = this.handDrag && this.handDrag.isValid
            ? this.handDrag
            : this.getComponent(HandDrag);
        if (!hand || !play) return;
        const keep = new Set<Node>();

        for (const card of hand.cards) {
            if (!card || !card.isValid) continue;
            const id = hand.cardIdOf(card);
            const dragging = !!drag && drag.isDragging && drag.draggingCard === card;
            const usable = !!id && !dragging && play.canUseCard(id);
            // ★ 需求：已满足【协作】条件、且这张牌当前能用的 ⇒ 显示**黄色选择光圈**（不用绿色可用光圈）
            const coopMet = usable && this.isCooperationMet(id);
            // ★★ 需求（海伦娜）：**爆能强化付得起**时 —— 费用数字要显示强化值（8），
            //    并且手牌要用**黄色选择光圈**（和「协作已满足」同一种提示）。
            const enhVal = maxEnhanceOf(id);
            const enhOk = enhVal > 0 && this.canAffordEnhance(play, enhVal);
            this.syncCostText(card, id, enhOk ? enhVal : null);
            const highlight = coopMet || enhOk;
            if (usable) this.show(card, highlight);
            else this.hide(card);
            if (usable) keep.add(card);
        }
        // 卡已经离开手牌（入场 / 排队 / 法术消失）时，立刻清掉遗留光圈。
        for (const card of this._visible) {
            if (!card || !card.isValid) {
                this._visible.delete(card);
                continue;
            }
            if (!keep.has(card)) this.hide(card);
        }
    }

    /** ★ 是否付得起爆能强化值（含「额外能量点」模式 —— 直接问 CardPlay 的同一套判定）。 */
    private canAffordEnhance(play: unknown, enhVal: number): boolean {
        try {
            const fn = (play as { canAffordWithReserved?: (n: number) => boolean }).canAffordWithReserved;
            if (typeof fn === 'function') return fn.call(play, enhVal) === true;
        } catch (e) { /* 忽略 */ }
        return false;
    }

    /**
     * ★ **同步手牌上的费用数字**：付得起爆能强化时显示强化值（如 8），否则显示卡牌原费用。
     * 只在该卡有爆能强化时才动它，避免影响别的卡。
     */
    private syncCostText(card: Node, id: string, showValue: number | null): void {
        try {
            const info = getCardInfo(id);
            if (!info || maxEnhanceOf(id) <= 0) return;
            const costNode = card.getChildByName('CardCost');
            const label = costNode ? costNode.getComponent('cc.Label') as { string?: string } | null : null;
            if (!label) return;
            const want = String(showValue === null ? info.cost : showValue);
            if (label.string !== want) {
                label.string = want;
                console.log(`[HandUsabilityGlow] ${id} 费用显示 → ${want}`);
            }
        } catch (e) { /* 忽略 */ }
    }

    /** 该手牌是否已满足它的【协作】需求（没有协作机制 ⇒ false）。 */
    private isCooperationMet(id: string): boolean {
        try {
            if (cooperationRequirementOf(id) <= 0) return false;
            const rules = (this.getComponent('BattleRuleSystem') as { cooperationOf?: (s: string) => number } | null)
                || (this.node.scene ? this.bfsRules() : null);
            if (rules) return (rules.cooperationOf('player') || 0) >= cooperationRequirementOf(id);
        } catch (e) { /* 忽略 */ }
        return false;
    }

    /** 全场景找一个 BattleRuleSystem（手牌区节点上通常没有）。 */
    private bfsRules(): { cooperationOf?: (s: string) => number } | null {
        try {
            const scene = this.node.scene as unknown as Node | null;
            if (!scene) return null;
            const stack: Node[] = [...scene.children];
            while (stack.length > 0) {
                const cur = stack.shift() as Node;
                const r = cur.getComponent('BattleRuleSystem') as { cooperationOf?: (s: string) => number } | null;
                if (r) return r;
                for (const ch of cur.children) stack.push(ch);
            }
        } catch (e) { /* 忽略 */ }
        return null;
    }

    private show(card: Node, cooperation = false): void {
        const glow = card.getComponent(CardGlow) || card.addComponent(CardGlow);
        glow.useQualityColor = false;
        // 🔴 必须走 setGlowColor（它会立刻把颜色推给材质 uniform）。
        //    只改 glowColor 字段的话，光晕已经在亮时颜色不会变 ⇒ 协作刚满足时黄色光圈不刷新（踩过）。
        glow.setGlowColor(cooperation ? this.cooperationGlowColor : this.glowColor);
        glow.maxIntensity = Math.max(glow.maxIntensity, this.maxIntensity);
        glow.glowThickness = this.glowThickness;
        glow.glowSoftness = this.glowSoftness;
        glow.fadeInDuration = this.fadeInDuration;
        glow.fadeOutDuration = this.fadeOutDuration;
        if (!glow.isGlowing) glow.fadeIn();
        this._visible.add(card);
    }

    private hide(card: Node): void {
        if (!this._visible.has(card)) return;
        if (!card || !card.isValid) {
            this._visible.delete(card);
            return;
        }
        const glow = card.getComponent(CardGlow);
        if (glow) glow.fadeOut();
        this._visible.delete(card);
    }

    @property({ type: HandLayout, tooltip: '手牌布局组件；留空自动在本节点查找。' })
    handLayout: HandLayout | null = null;

    @property({ type: CardPlay, tooltip: '打出组件；留空自动在本节点查找。' })
    cardPlay: CardPlay | null = null;

    @property({ type: HandDrag, tooltip: '手牌拖拽组件；留空自动在本节点查找。' })
    handDrag: HandDrag | null = null;
}
