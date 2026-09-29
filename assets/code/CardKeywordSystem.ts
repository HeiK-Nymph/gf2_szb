import { attachBarrierFx } from './BarrierFx';
import {
    ABILITY_IMMUNITY_NODE,
    AbilityImmunityFx,
    attachAbilityImmunityFx,
    removeAbilityImmunityFx,
} from './AbilityImmunityFx';
import { _decorator, Color, Component, Label, Node, UITransform, Vec3 } from 'cc';
import { CardGlow, cardIdFromNodeName } from './CardGlow';
import {
    CardAbilityInvocation,
    getCardAbilities,
    getCardAbilityKeywords,
    getCardInfo,
} from './CardData';
import { BattleFieldLayout, BattleSide } from './BattleFieldLayout';
import { runCardAbilityEffect } from './CardAbilitySystem';
import { canActivateAmulet } from './CardAbilitySystem';
import { ensureShieldAura, preloadShieldAssets, removeShieldAura, SHIELD_AURA_NODE, ShieldAuraConfig } from './ShieldAuraFx';
import { DeterAuraConfig, DETER_AURA_NODE, ensureDeterAura, preloadDeterAssets, removeDeterAura } from './DeterAuraFx';
import {
    AMBUSH_AURA_NODE, AmbushAuraConfig, ensureAmbushAura, preloadAmbushAssets, removeAmbushAura,
} from './AmbushAuraFx';

const { ccclass, property, menu } = _decorator;

/** 当前已实现的卡牌词条关键字。 */
export const KEYWORD_RUSH = 'Rush';
export const KEYWORD_CHARGE = 'Charge';
/** 守护：此牌在场时，对方只能攻击拥有守护的随从（不能打其它随从与主战者）。 */
export const KEYWORD_GUARD = 'Guard';
/** 威慑：此牌无法被对方随从进行普通攻击。 */
export const KEYWORD_DETER = 'Deter';
/**
 * 潜行：**不会被对方的能力选中，且不会被对方随从攻击**。
 * 失去时机（只有两个）：① 自己**进行攻击**时；② 自己**通过能力造成伤害**时。
 * 🔴 「破坏」**不算**造成伤害 ⇒ 靠破坏类能力（如入场曲破坏随从）不会让潜行随从现形。
 */
export const KEYWORD_AMBUSH = 'Ambush';
/** 灵气：不会被对手的能力选中（目标选择层过滤）。 */
export const KEYWORD_AURA = 'Aura';
/** 不会被能力 / 毁灭 / 纹章等直接破坏；数字伤害照常结算。 */
export const KEYWORD_ABILITY_DESTROY_IMMUNE = 'AbilityDestroyImmune';

/** 词条生效时拖动随从使用的光晕颜色。 */
export const RUSH_GLOW_COLOR = new Color(246, 205, 68, 255);
export const CHARGE_GLOW_COLOR = new Color(77, 226, 117, 255);
/**
 * ★「启动」常亮光圈色（能启动的我方护符）。
 * 🔴 用**选择光圈同款**的暖橙（`TargetSelectSystem.glowColor` 默认值），
 *    让玩家一眼认出「这张卡现在可以操作」；它只是**光圈**，不会把卡抬起来。
 */
export const ACTIVATE_GLOW_COLOR = new Color(255, 150, 46, 255);

interface KeywordState {
    keywords: Set<string>;
    deployedTurnKey: string;
    /** 运行时授予的「一回合可攻击 N 次」。静态 MultiAttack 仍由 CardData 读取。 */
    maxAttacks?: number;
    chantTurns?: number;
    chantEffect?: CardAbilityInvocation;
    auraSources?: Set<Node>;
}

/**
 * CardKeywordSystem —— 卡牌词条关键字系统。
 *
 * 当前词条：
 *   · Rush / 突进：召唤当回合可以攻击敌方随从，但不能攻击敌方主战者。
 *   · Charge / 疾驰：召唤当回合可以攻击敌方随从和主战者。
 *   · Guard / 守护：在场时对方只能攻击拥有守护的随从。
 *   · Deter / 威慑：无法被对方随从普通攻击。
 *   · Ambush / 潜行：**不会被对方的能力选中，也不会被对方随从攻击**；
 *       自己「进行攻击」或「通过能力造成伤害」时失去潜行（**破坏不算造成伤害**）。
 *   · Aura / 灵气：不会被对手的能力选中。
 *
 * 普通随从召唤当回合不能攻击，下一回合恢复正常。
 */
@ccclass('CardKeywordSystem')
@menu('gf2szb/CardKeywordSystem')
export class CardKeywordSystem extends Component {

    private static readonly CHANT_BADGE = 'ChantBadge';
    /** 卡牌身上所有「词条特效」子节点名（进化演出期间整组隐藏）。 */
    private static readonly FX_NODES: readonly string[] = [
        AMBUSH_AURA_NODE, SHIELD_AURA_NODE, DETER_AURA_NODE, ABILITY_IMMUNITY_NODE,
        CardKeywordSystem.CHANT_BADGE,
    ];


    @property({ tooltip: '扫描战场中新出现随从的间隔（秒）。' })
    scanInterval = 0.1;

    // ====================== 守护护盾特效（Inspector 可调）======================
    @property({
        range: [0.6, 2.4, 0.01], slide: true,
        tooltip: '【护盾大小】护盾基础高度 = 卡牌显示高度 × 本值。\n'
            + '贴图里的强轮廓约占整张贴图高度的 0.70，故 1.26 左右时护盾正好贴住卡边。',
    })
    shieldScale = 1.26;

    @property({
        range: [-0.6, 0.6, 0.01], slide: true,
        tooltip: '【护盾位置】相对卡牌可视中心的 X 偏移（按卡牌宽度比例，正 = 右移）。',
    })
    shieldOffsetX = 0;

    @property({
        range: [-0.6, 0.6, 0.01], slide: true,
        tooltip: '【护盾位置】相对卡牌可视中心的 Y 偏移（按卡牌高度比例，正 = 上移）。',
    })
    shieldOffsetY = 0;

    @property({ type: Color, tooltip: '护盾主色（青绿）。三层里的中层光环与内亮芯以它为准。' })
    shieldColor = new Color(150, 255, 96, 255);

    @property({ type: Color, tooltip: '护盾最外圈的柔光色（暖金），给轮廓加一层暖光。' })
    shieldGlowColor = new Color(255, 226, 138, 255);

    @property({ range: [0, 2, 0.01], slide: true, tooltip: '护盾加色（ADD）亮度倍数。过高会在亮底上过曝成纯白。' })
    shieldIntensity = 0.85;

    @property({ range: [0.8, 1.6, 0.01], slide: true, tooltip: '外层柔光的相对尺寸（1 = 与护盾本体同大）。' })
    shieldOuterScale = 1.16;

    @property({ range: [0.8, 1.6, 0.01], slide: true, tooltip: '中层光环的相对尺寸。' })
    shieldMidScale = 1.06;

    @property({ range: [0.3, 6, 0.05], slide: true, tooltip: '护盾呼吸周期（秒）。' })
    shieldPulsePeriod = 2.4;

    @property({ range: [0, 0.3, 0.005], slide: true, tooltip: '护盾呼吸幅度（缩放/透明度的摆动比例）。' })
    shieldPulseAmount = 0.06;

    @property({ range: [0, 1, 0.01], slide: true, tooltip: '呼吸最暗时的透明度比例（1 = 不呼吸）。' })
    shieldMinPulse = 0.55;

    // ====================== 威慑光圈特效（Inspector 可调）======================
    @property({
        range: [0.5, 2.4, 0.01], slide: true,
        tooltip: '【威慑光圈大小】光圈基础高度 = 卡牌显示高度 × 本值。',
    })
    deterScale = 1.24;

    @property({
        range: [-0.6, 0.6, 0.01], slide: true,
        tooltip: '【威慑光圈位置】相对卡牌可视中心的 X 偏移（按卡牌宽度比例，正 = 右移）。',
    })
    deterOffsetX = 0;

    @property({
        range: [-0.6, 0.6, 0.01], slide: true,
        tooltip: '【威慑光圈位置】相对卡牌可视中心的 Y 偏移（按卡牌高度比例，正 = 上移）。',
    })
    deterOffsetY = 0;

    @property({ type: Color, tooltip: '威慑光圈主色（绿）。' })
    deterColor = new Color(70, 255, 140, 255);

    @property({ type: Color, tooltip: '威慑光圈外层柔光色。' })
    deterGlowColor = new Color(120, 255, 175, 255);

    @property({ range: [0, 2, 0.01], slide: true, tooltip: '威慑光圈加色（ADD）亮度倍数。' })
    deterIntensity = 0.9;

    @property({ range: [0.5, 30, 0.5], slide: true, tooltip: '威慑光圈序列帧播放帧率（帧/秒）。越低越柔和；默认 4 = 一轮约 1 秒。' })
    deterFps = 4;

    @property({
        tooltip: '威慑光圈是否**交叉淡入淡出**相邻帧。\n'
            + '开（推荐）：帧 i 淡出、帧 i+1 淡入，两帧权重和恒为 1 ⇒ 看起来是缓慢「形变」而不是「跳变」；\n'
            + '关：直接切换贴图（低帧率下会有明显闪烁）。',
    })
    deterCrossFade = true;

    @property({
        tooltip: '外层柔光是否跟随序列帧动画。\n'
            + '关（默认，观感最柔和）：大面积柔光**静止**，只有内层细环缓慢形变；\n'
            + '开：外层也换帧（闪烁感更强）。',
    })
    deterOuterAnimate = false;

    @property({ range: [0.8, 1.6, 0.01], slide: true, tooltip: '外层柔光相对尺寸（恒定，不参与动画缩放）。' })
    deterOuterScale = 1.1;

    @property({ range: [0, 1, 0.01], slide: true, tooltip: '外层柔光透明度。' })
    deterOuterAlpha = 0.3;

    @property({ range: [0, 1, 0.01], slide: true, tooltip: '主环透明度。' })
    deterCoreAlpha = 0.95;

    @property({ range: [0, 0.6, 0.005], slide: true, tooltip: '亮度呼吸幅度（**只改透明度，不改尺寸**；0 = 不呼吸）。越小越柔和。' })
    deterShimmer = 0.07;

    @property({ range: [0.5, 12, 0.1], slide: true, tooltip: '亮度呼吸周期（秒）。越大越慢越柔和。' })
    deterShimmerPeriod = 3.6;

    // ====================== 潜行烟雾特效（Inspector 可调）======================
    @property({
        range: [0.6, 2.6, 0.01], slide: true,
        tooltip: '【潜行烟雾·整体大小】整团烟雾的大小：基础高度 = 卡牌显示高度 × 本值'
            + '（三层各自还有一个相对倍数）。\n'
            + '大于 1 时烟雾会溢出卡框（观感更"笼罩"）；素材本体已按 alpha 裁边，1.3 左右正好包住卡牌并略微外溢。',
    })
    ambushScale = 1.3;

    @property({
        range: [-0.6, 0.6, 0.01], slide: true,
        tooltip: '【潜行烟雾·位置】相对卡牌可视中心的 X 偏移（按卡牌宽度比例，正 = 右移）。',
    })
    ambushOffsetX = 0;

    @property({
        range: [-0.6, 0.6, 0.01], slide: true,
        tooltip: '【潜行烟雾·位置】相对卡牌可视中心的 Y 偏移（按卡牌高度比例，正 = 上移）。',
    })
    ambushOffsetY = 0;

    @property({
        range: [0.2, 8, 0.05], slide: true,
        tooltip: '【潜行烟雾·一次周期时长】烟雾序列帧走完**一整轮**（8 帧循环）的秒数。\n'
            + '越小 → 烟雾翻涌越快；越大 → 越缓慢。默认 1.33（≈ 每秒 6 帧）。\n'
            + '（各层的**旋转速度**是独立变量，单位是 度/秒，见下面三层各自的「旋转速度」。）',
    })
    ambushCycleSeconds = 1.33;

    @property({
        tooltip: '【潜行烟雾·交叉淡入淡出】\n'
            + '开（推荐）：相邻帧淡出/淡入，两帧权重和恒为 1 ⇒ 低帧率下也是缓慢「形变」而非「跳变」；\n'
            + '关：直接切贴图。',
    })
    ambushCrossFade = true;

    @property({ range: [0, 0.3, 0.005], slide: true, tooltip: '【潜行烟雾·呼吸幅度】整体轻微缩放幅度（0 = 不呼吸）。' })
    ambushBreathe = 0.05;

    @property({ range: [0.5, 12, 0.1], slide: true, tooltip: '【潜行烟雾·呼吸周期】秒。' })
    ambushBreathePeriod = 4.2;

    @property({
        range: [2, 30, 0.5], slide: true,
        tooltip: '【进化演出·隐藏特效兜底时长】秒。\n'
            + '进化 / 超进化动画期间会隐藏词条特效（烟雾 / 护盾 / 光圈 / 角标 / 光晕），'
            + '动画结束回调里恢复；万一演出异常没回调，超过本时长就自动恢复（防止特效永久消失）。',
    })
    fxSuppressSafetySeconds = 12;

    // —— 层 0：外层黑烟（最大最暗，压暗卡面 = "被藏起来"）——
    @property({ type: Color, tooltip: '【潜行烟雾·外层黑烟】染色（近黑 = 把卡面压暗；普通 alpha 混合，非加色）。' })
    ambushDarkColor = new Color(10, 10, 16, 255);

    @property({ range: [0, 1, 0.01], slide: true, tooltip: '【潜行烟雾·外层黑烟】最大透明度。越高卡面越"看不见"（0.94 时卡面只剩隐约轮廓）。' })
    ambushDarkAlpha = 0.94;

    @property({ range: [0.5, 1.8, 0.01], slide: true, tooltip: '【潜行烟雾·外层黑烟】相对基础尺寸的缩放。' })
    ambushDarkScale = 1.16;

    @property({ range: [-60, 60, 1], slide: true, tooltip: '【潜行烟雾·外层黑烟】旋转速度（度/秒，正 = 顺时针）。' })
    ambushDarkSpin = 7;

    // —— 层 1：内层黑烟（反向转，与外层交织）——
    @property({ type: Color, tooltip: '【潜行烟雾·内层黑烟】染色（比外层略亮一点，制造层次）。' })
    ambushDark2Color = new Color(26, 26, 34, 255);

    @property({ range: [0, 1, 0.01], slide: true, tooltip: '【潜行烟雾·内层黑烟】最大透明度。' })
    ambushDark2Alpha = 0.82;

    @property({ range: [0.5, 1.8, 0.01], slide: true, tooltip: '【潜行烟雾·内层黑烟】相对基础尺寸的缩放。' })
    ambushDark2Scale = 0.98;

    @property({ range: [-60, 60, 1], slide: true, tooltip: '【潜行烟雾·内层黑烟】旋转速度（度/秒，负 = 逆时针）。' })
    ambushDark2Spin = -13;

    // —— 层 2：白雾（亮部丝缕）——
    @property({ type: Color, tooltip: '【潜行烟雾·白雾】染色（白 = 亮部丝缕）。' })
    ambushWhiteColor = new Color(232, 238, 248, 255);

    @property({ range: [0, 1, 0.01], slide: true, tooltip: '【潜行烟雾·白雾】最大透明度（越低越"黑烟为主"；0.24 时黑烟为主、白雾只做丝缕）。' })
    ambushWhiteAlpha = 0.24;

    @property({ range: [0.5, 1.8, 0.01], slide: true, tooltip: '【潜行烟雾·白雾】相对基础尺寸的缩放。' })
    ambushWhiteScale = 0.92;

    @property({ range: [-60, 60, 1], slide: true, tooltip: '【潜行烟雾·白雾】旋转速度（度/秒；比黑层快 → 丝缕流动感）。' })
    ambushWhiteSpin = 26;

    private readonly _states = new WeakMap<Node, KeywordState>();
    private readonly _auraVisible = new WeakSet<Node>();
    /**
     * 🔴 **被外部临时接管光晕**的卡（= 选择光圈接管）。
     * 优先级：选择光圈 > 突进 / 疾驰词条光圈 —— 接管期间 `refreshVisuals` **完全不碰**这张卡的
     * CardGlow（不改颜色、不 fadeIn / fadeOut），于是引导用户选择的提示不会被下一帧刷回词条色。
     */
    private readonly _glowOverride = new WeakSet<Node>();
    /**
     * 🔴 **被临时隐藏全部词条特效**的卡（进化 / 超进化演出期间）。
     * 需求：进化动画播放时「只保留最基础的战场卡牌样式」⇒ 潜行烟雾 / 守护护盾 / 威慑光圈 /
     * 吟唱角标 / 词条光晕全部藏起来。`refreshVisuals` 会**整张卡跳过**，所以 0.1s 一次的
     * 扫描不会把特效又刷回来；词条状态与规则判定完全不受影响。
     */
    private readonly _fxSuppressed = new WeakSet<Node>();
    /** 抑制状态的**兜底清单**（WeakSet 不能遍历）→ 超时自动恢复，见 `tickFxSuppressSafety`。 */
    private _fxSuppressList: Array<{ card: Node; until: number }> = [];

    // ====================== 「奥义 / 解放奥义」的奥义槽 ======================
    /**
     * 手牌节点 → 该卡**进入手牌那一刻**的快照 `{ side, count }`（count = 该方随从累计进化次数）。
     *
     * 🔴 奥义槽 = `现在的回合数` + `在手牌中时自己的随从的进化次数`，第二项就是
     *    `当前累计进化次数 − 本快照`。所以必须**在这张卡还在手牌时**就把计数记下来。
     *    手牌扫描每 `scanInterval` 秒一次（`syncHand`），新出现的手牌记一次快照。
     */
    private readonly _handSnapshot = new WeakMap<Node, { side: 'player' | 'enemy'; count: number }>();
    /**
     * 战场节点 → 从手牌搬过来的同一份快照。
     * 打出的瞬间手牌节点与战场节点是**两个不同节点**（`CardPlay` 会另建战场样式卡），
     * 所以 `CardPlay` / `EnemyCardPlay` 在「入场通知」里调 `carryHandState(手牌节点, 战场节点)` 搬运一次。
     */
    private readonly _handCarried = new WeakMap<Node, { side: 'player' | 'enemy'; count: number }>();
    /** 手牌期间运行时授予的词条；打出时搬到新建的战场节点。 */
    private readonly _handCarriedKeywords = new WeakMap<Node, string[]>();
    /** 手牌区组件缓存（按类名找，失效重查） */
    private _handLayouts: Array<{ cards: readonly Node[] }> = [];
    /** 按类名缓存的其它系统组件（`findComp`） */
    private readonly _compCache = new Map<string, Component>();

    private _attackedThisTurn = new WeakSet<Node>();
    private _acc = 0;
    private _tmCache: any = null;
    private _turnKey = '';
    /** 复用的护盾配置对象（避免每次扫描都新建对象） */
    private readonly _shieldCfg: ShieldAuraConfig = {};
    /** 复用的威慑光圈配置对象 */
    private readonly _deterCfg: DeterAuraConfig = {};
    /** 复用的潜行烟雾配置对象 */
    private readonly _ambushCfg: AmbushAuraConfig = {};

    onLoad(): void {
        preloadShieldAssets();      // 守护护盾素材：提前拉一次，避免第一只守护随从上场空一拍
        preloadDeterAssets();       // 威慑光圈素材：同上
        preloadAmbushAssets();      // 潜行烟雾素材：同上
        AbilityImmunityFx.preload();
    }

    update(dt: number): void {
        this.syncTurn();
        this.tickFxSuppressSafety();      // 兜底：演出异常时别让特效永久消失
        this._acc += dt;
        if (this._acc < Math.max(0.01, this.scanInterval)) return;
        this._acc = 0;
        this.sync();
        this.syncHand();                  // 奥义槽：给新进手牌记快照
        this.refreshVisuals();
    }

    /** 扫描敌我战场，登记尚未见过的随从。 */
    public sync(): void {
        for (const field of this.fields()) {
            for (const card of field.cards) {
                // 🔴 卡**还没显示**时（召唤期间 active=false 藏着）不要刷光晕：
                //    在隐藏节点上 fadeIn() 起不来，补间会把光晕停在初始**白色**
                //    ⇒ 入场打开后就是「光圈错乱」（实测：两张安朵丝各自召唤的自巡炮都是白圈）。
                //    显示那一刻由 deferSummonReveal 统一再刷一次。
                if (!card.activeInHierarchy) continue;
                if (!this._states.has(card)) this.registerCard(card);
            }
        }
    }

    // ====================== 「奥义 / 解放奥义」======================

    /** 手牌区组件（`HandLayout` / `EnemyHandLayout`；两者都有 `cards` 只读数组）。 */
    private handLayouts(): Array<{ cards: readonly Node[] }> {
        const alive = this._handLayouts.filter((h) => !!(h as unknown as Component)?.isValid);
        if (alive.length >= 2) return alive;
        const out: Array<{ cards: readonly Node[] }> = [];
        const scene = this.node.scene as unknown as Node | null;
        if (!scene) return alive;
        const stack: Node[] = [...scene.children];
        while (stack.length > 0) {
            const cur = stack.shift() as Node;
            for (const name of ['HandLayout', 'EnemyHandLayout']) {
                const c = cur.getComponent(name) as unknown as { cards?: readonly Node[] } | null;
                if (c && Array.isArray(c.cards)) out.push(c as unknown as { cards: readonly Node[] });
            }
            for (const ch of cur.children) stack.push(ch);
        }
        this._handLayouts = out.length > 0 ? out : alive;
        return this._handLayouts;
    }

    /** 手牌扫描：给**新进手牌**的卡记下「进入手牌那一刻」的进化计数快照（幂等）。 */
    public syncHand(): void {
        for (const hand of this.handLayouts()) {
            for (const card of hand.cards || []) {
                if (!card || !card.isValid) continue;
                if (this._handSnapshot.has(card)) continue;
                const side = this.sideOfHandCard(card);
                if (!side) continue;
                this._handSnapshot.set(card, { side, count: this.evolveCount(side) });
            }
        }
    }

    /** 手牌节点属于哪一方（按它在哪个手牌区里判定；`PlayerHandArea` / `EnemyHandArea`）。 */
    private sideOfHandCard(card: Node): 'player' | 'enemy' | null {
        for (const hand of this.handLayouts()) {
            if ((hand.cards || []).indexOf(card) >= 0) {
                const nm = ((hand as unknown as Component).node?.name) || '';
                return nm.indexOf('Enemy') >= 0 ? 'enemy' : 'player';
            }
        }
        return null;
    }

    /**
     * 把「手牌期间」的奥义槽快照从**手牌节点**搬到**战场节点**（打出时调用一次）。
     * 见 `CardPlay.notifyCardEntered` / `EnemyCardPlay.notifyCardEntered`。
     *
     * 🔴 `fromHand` **可能已经被销毁**：`CardPlay` 在翻转飞行到 ±90°（宽度为零、看不见）那一刻就
     *    `killNode(手牌卡)`，而「落地 → 入场通知」在那之后。但 WeakMap 是以**那个对象**为键的，
     *    快照照样取得回来 ⇒ 这里**只校验非空，不要校验 `isValid`**（校验了就永远搬不到）。
     */
    public carryHandState(fromHand: Node | null, toField: Node | null): void {
        if (!fromHand || !toField || !toField.isValid) return;
        const handState = this._states.get(fromHand);
        const keywords = handState ? [...handState.keywords] : [];
        if (keywords.length > 0) this._handCarriedKeywords.set(toField, keywords);
        const snap = this._handSnapshot.get(fromHand);
        if (!snap) return;
        this._handCarried.set(toField, snap);
    }

    /** 该方随从本局累计进化次数（读 `EvoPointSystem`；缺失时 0）。 */
    private evolveCount(side: 'player' | 'enemy'): number {
        const sys = this.findComp('EvoPointSystem') as {
            evolveCountOf?: (s: 'player' | 'enemy') => number;
        } | null;
        const n = sys && typeof sys.evolveCountOf === 'function' ? sys.evolveCountOf(side) : 0;
        return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
    }

    /** 「现在的回合数」（= 大回合数，UI 上显示的「第 N 大回合」）。 */
    private currentTurnNumber(): number {
        const tm = this.turnManager();
        if (!tm || tm.isRunning !== true) return 0;
        const n = Number(tm.roundNumber);
        return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
    }

    /**
     * **奥义槽** = `现在的回合数` + `这张卡在手牌中时我方随从的进化次数`。
     * 卡不在手牌 / 没登记过快照（例如被效果直接召唤上场）→ 第二项按 0 算。
     */
    public ougiGauge(card: Node | null): number {
        const p = this.ougiParts(card);
        return p.turn + p.evolutions;
    }

    /** 奥义槽的两项拆开（日志 / 调试用）。 */
    public ougiParts(card: Node | null): { turn: number; evolutions: number; gauge: number } {
        const turn = this.currentTurnNumber();
        const evolutions = this.inHandEvolutions(card);
        return { turn, evolutions, gauge: turn + evolutions };
    }

    /** 这张卡**在手牌中时**我方随从的进化次数（战场卡读搬运过来的快照，手牌卡读自己的快照）。 */
    public inHandEvolutions(card: Node | null): number {
        if (!card || !card.isValid) return 0;
        const snap = this._handCarried.get(card) || this._handSnapshot.get(card);
        if (!snap) return 0;
        return Math.max(0, this.evolveCount(snap.side) - snap.count);
    }

    /** 手动设置某张卡的词条；deployNow=true 表示按当前回合的新登场处理。 */
    public setCardKeywords(card: Node | null, keywords: string[], deployNow = true): void {
        if (!card || !card.isValid) return;
        const set = new Set<string>();
        for (const k of keywords || []) if (k) set.add(k);
        const prev = this._states.get(card);
        this._states.set(card, {
            keywords: set,
            deployedTurnKey: deployNow ? this.turnKey() : (prev?.deployedTurnKey || ''),
            maxAttacks: prev?.maxAttacks,
            chantTurns: prev?.chantTurns,
            chantEffect: prev?.chantEffect,
            auraSources: prev?.auraSources || new Set<Node>(),
        });
        this.refreshVisuals();
    }

    /** 随从进入战场时立刻结算“友方随从入场”类光环，不必等下一次扫描。 */
    public onCardEnteredBattlefield(card: Node | null): void {
        if (!card || !card.isValid) return;
        if (!this._states.has(card)) this.registerCard(card);
        const carriedKeywords = this._handCarriedKeywords.get(card);
        if (carriedKeywords && carriedKeywords.length > 0) {
            const state = this.stateOf(card);
            if (state) for (const keyword of carriedKeywords) state.keywords.add(keyword);
            this.refreshVisuals();
        }
        const info = this.infoOf(card);
        if (info?.cardType === 'Follower') this.applyFollowerEntryBuffs(card);
        this.updateChantBadge(card);
        // ★ 飘字基准：卡牌入场时把当前血量记下来（否则它**第一次**受伤/治疗没有基准值 ⇒ 不显示数字）
        try {
            const nf = this.numberFxOf();
            const r = this.ruleSystemOf();
            if (nf && r && typeof r.getHp === 'function') nf.seed(card, r.getHp(card));
        } catch (e) { /* 忽略 */ }
        // ★ 【屏障】：带屏障词条的卡进场就上**蓝色护盾罩**（罩插在 ATK/HP 徽标之下，不挡数值）
        try {
            if (this.hasKeyword(card, 'Barrier')) attachBarrierFx(card);
        } catch (e) { /* 演出失败不影响逻辑 */ }
        try {
            if (this.hasKeyword(card, KEYWORD_ABILITY_DESTROY_IMMUNE)) attachAbilityImmunityFx(card);
        } catch (e) { /* 演出失败不影响逻辑 */ }
    }

    /** ★ 找 DamageNumberFx（飘字基准用）。 */
    private numberFxOf(): { seed?: (n: Node, hp: number) => void } | null {
        try {
            const scene = this.node.scene as unknown as Node | null;
            if (scene) {
                const stack: Node[] = [...scene.children];
                while (stack.length > 0) {
                    const cur = stack.shift() as Node;
                    const c = cur.getComponent('DamageNumberFx') as { seed?: (n: Node, hp: number) => void } | null;
                    if (c && typeof c.seed === 'function') return c;
                    for (const ch of cur.children) stack.push(ch);
                }
            }
        } catch (e) { /* 忽略 */ }
        return null;
    }

    /** ★ 找 BattleRuleSystem（读血量用）。 */
    private ruleSystemOf(): { getHp?: (n: Node) => number } | null {
        try {
            const scene = this.node.scene as unknown as Node | null;
            if (scene) {
                const stack: Node[] = [...scene.children];
                while (stack.length > 0) {
                    const cur = stack.shift() as Node;
                    const r = cur.getComponent('BattleRuleSystem') as { getHp?: (n: Node) => number } | null;
                    if (r && typeof r.getHp === 'function') return r;
                    for (const ch of cur.children) stack.push(ch);
                }
            }
        } catch (e) { /* 忽略 */ }
        return null;
    }

    public hasKeyword(card: Node | null, keyword: string): boolean {
        return !!this.stateOf(card)?.keywords.has(keyword);
    }

    /**
     * 给某张卡**追加**一个词条（保留它已有的其它词条与登场回合信息）。
     * 用于「进化后获得突进」这类运行时授予。
     * ⚠️ 不要改用 `setCardKeywords`：那是**整表覆盖**，直接传新数组会把卡自带词条冲掉。
     * @returns 是否真的加上了（原本就有 / 参数非法 → false）
     */
    public addKeyword(card: Node | null, keyword: string): boolean {
        if (!card || !card.isValid || !keyword) return false;
        let state = this._states.get(card);
        if (!state) {
            state = {
                keywords: new Set<string>(),
                deployedTurnKey: this.turnKey(),
                auraSources: new Set<Node>(),
            } as KeywordState;
            this._states.set(card, state);
        }
        if (state.keywords.has(keyword)) return false;
        state.keywords.add(keyword);
        this.refreshVisuals();
        return true;
    }

    /** 该随从当前是否持有「守护」。 */
    /** ★ 通用移除一个词条（屏障发动后失效等）。 */
    public removeKeyword(card: Node | null, keyword: string): boolean {
        if (!card || !card.isValid || !keyword) return false;
        const st = this._states.get(card);
        if (!st || !st.keywords || !st.keywords.has(keyword)) return false;
        st.keywords.delete(keyword);
        try { this.refreshVisuals(); } catch (e) { /* 忽略 */ }
        console.log(`[CardKeywordSystem] ${card.name} 失去【${keyword}】`);
        return true;
    }

    public hasGuard(card: Node | null): boolean {
        return this.hasKeyword(card, KEYWORD_GUARD);
    }

    /** 该随从当前是否持有「威慑」。 */
    public hasDeter(card: Node | null): boolean {
        return this.hasKeyword(card, KEYWORD_DETER);
    }

    /** 该随从当前是否持有「潜行」（不会被对方能力选中 / 不会被对方随从攻击）。 */
    public hasAmbush(card: Node | null): boolean {
        return this.hasKeyword(card, KEYWORD_AMBUSH);
    }

    /** 该随从当前是否持有「灵气」。 */
    public hasAura(card: Node | null): boolean {
        return this.hasKeyword(card, KEYWORD_AURA);
    }

    /** 该随从当前是否持有「不会被能力破坏」。 */
    public hasAbilityDestroyImmune(card: Node | null): boolean {
        return this.hasKeyword(card, KEYWORD_ABILITY_DESTROY_IMMUNE);
    }

    /** 运行时授予「一回合可攻击 N 次」；只升不降。 */
    public grantMultiAttack(card: Node | null, times: number): void {
        if (!card || !card.isValid) return;
        const n = Math.max(1, Math.floor(Number(times) || 1));
        let state = this._states.get(card);
        if (!state) {
            state = {
                keywords: new Set<string>(),
                deployedTurnKey: this.turnKey(),
                auraSources: new Set<Node>(),
            };
            this._states.set(card, state);
        }
        state.maxAttacks = Math.max(state.maxAttacks || 1, n);
        console.log(`[CardKeywordSystem] ${card.name} 获得「1回合可以攻击${state.maxAttacks}次」`);
    }

    /** 运行时攻击次数上限；未授予返回 0，由 BattleRuleSystem 回退到 CardData 静态值。 */
    public attacksPerTurn(card: Node | null): number {
        const n = this.stateOf(card)?.maxAttacks || 0;
        return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
    }

    /**
     * 让某张卡**失去「潜行」**（并立刻摘掉烟雾特效）。
     *
     * 🔴 只有两个合法调用时机（对应关键字说明）：
     *   ① 该随从**进行了攻击**（`markAttacked` 里自动调用）；
     *   ② 该随从**通过能力造成伤害**（`CardAbilitySystem` 的伤害结算里调用）。
     *   **「破坏」不算造成伤害** —— 破坏类能力（入场曲破坏随从、纹章随机破坏…）**不要**调它。
     *
     * @returns 是否真的失去（原本就没有潜行 / 参数非法 → false）
     */
    public loseAmbush(card: Node | null, reason = ''): boolean {
        if (!card || !card.isValid) return false;
        const state = this.stateOf(card);
        if (!state || !state.keywords.has(KEYWORD_AMBUSH)) return false;
        state.keywords.delete(KEYWORD_AMBUSH);
        removeAmbushAura(card);
        console.log(`[CardKeywordSystem] ${card.name} 失去「潜行」${reason ? '（' + reason + '）' : ''}`);
        this.refreshVisuals();
        return true;
    }

    /** 某片战场上是否存在持有「守护」的随从（供选择门控与结算使用）。 */
    public anyGuardIn(field: BattleFieldLayout | null): boolean {
        if (!field || !field.isValid) return false;
        for (const card of field.cards) {
            if (!card || !card.isValid) continue;
            if (this.hasGuard(card)) return true;
        }
        return false;
    }

    /** 是否仍是「召唤当回合」（未经过一次回合切换）。 */
    public isFresh(card: Node | null): boolean {
        const state = this.stateOf(card);
        return !!state && state.deployedTurnKey === this.turnKey();
    }

    /** 召唤当回合是否允许攻击随从。 */
    public canAttackFollower(card: Node | null): boolean {
        if (!this.isFollowerCard(card)) return false;
        if (!this.isFresh(card)) return true;
        return this.hasKeyword(card, KEYWORD_RUSH) || this.hasKeyword(card, KEYWORD_CHARGE);
    }

    /** 召唤当回合是否允许攻击主战者。 */
    public canAttackHero(card: Node | null): boolean {
        if (!this.isFollowerCard(card)) return false;
        if (!this.isFresh(card)) return true;
        return this.hasKeyword(card, KEYWORD_CHARGE);
    }

    /**
     * 当前卡片应显示的词条光晕颜色；**按当前攻击能力判断**，不要求真实带词条：
     *   能攻击主战者 → 疾驰绿；
     *   只能攻击随从 → 突进黄；
     *   两者都不能 → 无光晕。
     */
    /** ★ 这张卡本回合还能攻击几次（问 BattleRuleSystem；找不到就退回旧判据）。 */
    private attacksLeftOf(card: Node | null): number {
        if (!card || !card.isValid) return 0;
        try {
            const scene = this.node.scene as unknown as Node | null;
            if (scene) {
                const stack: Node[] = [...scene.children];
                while (stack.length > 0) {
                    const cur = stack.shift() as Node;
                    const r = cur.getComponent('BattleRuleSystem') as { attacksLeft?: (n: Node) => number } | null;
                    if (r && typeof r.attacksLeft === 'function') return Math.max(0, r.attacksLeft(card) || 0);
                    for (const ch of cur.children) stack.push(ch);
                }
            }
        } catch (e) { /* 忽略 */ }
        return this._attackedThisTurn.has(card) ? 0 : 1;
    }

    public activeGlowColor(card: Node | null): Color | null {
        this.syncTurn();
        // ★ 「启动」常亮光圈（需求）：我方战场上**能启动**的护符 → 常亮选择光圈。
        //   🔴 只是**光圈**（不抬卡）—— 抬卡只属于拖拽类选择，见 TargetSelectSystem.liftCandidate。
        //   放在随从词条之前判：护符不是随从，两条互斥，顺序只为读起来清楚。
        if (this.canActivateAmuletNow(card)) return ACTIVATE_GLOW_COLOR;
        // ★ 需求（卡 17）：一回合能攻击多次的随从，**打完第 1 次仍应保留疾驰/突进光圈**，
        //   判据从「本回合是否攻击过」改成「本回合**还有没有攻击次数**」。
        if (!this.isFollowerCard(card) || !card) return null;
        if (this.attacksLeftOf(card) <= 0) return null;
        if (!this.isOwnerTurn(card)) return null;
        if (this.canAttackHero(card)) return CHARGE_GLOW_COLOR;
        if (this.canAttackFollower(card)) return RUSH_GLOW_COLOR;
        return null;
    }

    /**
     * 这张卡此刻是否**能启动**（护符的「启动」能力）。
     * 🔴 判据只有一份真源 = `CardAbilitySystem.canActivateAmulet`（自己回合 + 1 回合 1 次 + 费用够）。
     * 🔴 **敌我通用**：按这张卡所在战场的阵营判定（此前硬编码只看我方 ⇒ 敌方护符永远不亮，
     *    敌方 AI 也就没法启动自己的护符）。
     */
    public canActivateAmuletNow(card: Node | null): boolean {
        if (!card || !card.isValid) return false;
        const field = this.fieldOf(card);
        if (!field) return false;
        const side = field.side === BattleSide.Player ? 'player' : 'enemy';
        try {
            return canActivateAmulet(this, card, side).ok;
        } catch (e) {
            return false;
        }
    }

    /** ★ 吟唱剩余回合（0 = 没有吟唱）—— 供敌方 AI 评估「临时卡牌」的价值。 */
    public chantTurnsOf(card: Node | null): number {
        const st = card ? this.stateOf(card) : null;
        const n = st && typeof st.chantTurns === 'number' ? st.chantTurns : 0;
        return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
    }

    /** 随从完成攻击后立刻移除自身词条光晕，并**失去「潜行」**（潜行的两个失去时机之一）。 */
    public markAttacked(card: Node | null): void {
        if (!card || !card.isValid) return;
        this._attackedThisTurn.add(card);
        this.loseAmbush(card, '进行了攻击');     // 🔴 攻击 → 现形（破坏不算伤害，但攻击算）
        this.refreshVisuals();
    }

    /**
     * **接管 / 交还**某张卡的光晕控制权（选择光圈用，优先级最高）。
     *   · on = true：接管 —— 之后 `refreshVisuals` 不再改这张卡的 CardGlow，外部可自由上色；
     *   · on = false：交还 —— 并（默认）立刻刷新一次，把词条光圈恢复到该有的样子。
     */
    public setGlowOverride(card: Node | null, on: boolean, refresh = true): void {
        if (!card || !card.isValid) return;
        if (on) {
            this._glowOverride.add(card);
            return;
        }
        this._glowOverride.delete(card);
        // 交还后这张卡的光晕该不该亮由词条状态决定 ⇒ 清掉「已点亮」记录，让下次刷新重新判定
        this._auraVisible.delete(card);
        if (refresh) this.refreshVisuals();
    }

    /** 某张卡的光晕是否正被外部接管（选择光圈）。 */
    public isGlowOverridden(card: Node | null): boolean {
        return !!card && card.isValid && this._glowOverride.has(card);
    }

    /**
     * 【进化演出】临时**隐藏 / 恢复**某张卡身上的**全部词条特效**
     * （潜行烟雾 `AmbushAura` / 守护护盾 `ShieldAura` / 威慑光圈 `DeterAura` / 吟唱角标 `ChantBadge`
     *  / 词条光晕 `CardGlow`）。
     *
     * 需求：播放**进化 / 超进化动画**时只保留最基础的战场卡牌样式。
     * 🔴 只是「不显示」—— 词条状态、数值、规则判定全部照旧；`refreshVisuals` 会跳过被抑制的卡，
     *    所以 0.1s 一次的扫描不会把特效又刷回来。
     * 🔴 演出结束**务必**调 `setFxSuppressed(card, false)`（`FollowerEvolve` 在动画完成回调里调）。
     * @param on true = 隐藏（进入演出）；false = 恢复（按当前词条重新挂回特效）
     */
    public setFxSuppressed(card: Node | null, on: boolean): void {
        if (!card || !card.isValid) return;
        if (on) {
            this._fxSuppressed.add(card);
            this._fxSuppressList.push({
                card,
                until: Date.now() + Math.max(1, this.fxSuppressSafetySeconds) * 1000,
            });
            this.hideCardFx(card);
        } else {
            this._fxSuppressed.delete(card);
            this._fxSuppressList = this._fxSuppressList.filter((it) => it.card !== card);
            this.showCardFx(card);
        }
        this.refreshVisuals();
    }

    /**
     * 兜底：抑制状态超时（演出因为异常 / 被打断没回调 `setFxSuppressed(card,false)`）时自动恢复特效。
     * 视觉 bug 一旦「永久不恢复」很难排查，这里用一条廉价的时间检查把它变成自愈。
     */
    private tickFxSuppressSafety(): void {
        if (this._fxSuppressList.length === 0) return;
        const now = Date.now();
        let expired = 0;
        const still: Array<{ card: Node; until: number }> = [];
        for (const it of this._fxSuppressList) {
            if (!it.card || !it.card.isValid) continue;              // 卡没了 → 直接丢（WeakSet 会自己回收）
            if (now < it.until) { still.push(it); continue; }
            expired++;
            this._fxSuppressed.delete(it.card);
            this.showCardFx(it.card);
            console.warn(`[CardKeywordSystem] ${it.card.name} 的进化演出超时未收尾 → 自动恢复词条特效`);
        }
        this._fxSuppressList = still;
        if (expired > 0) this.refreshVisuals();
    }

    /** 该卡当前是否处于「进化演出期间隐藏特效」状态。 */
    public isFxSuppressed(card: Node | null): boolean {
        return !!card && card.isValid && this._fxSuppressed.has(card);
    }

    /** 把这张卡身上的词条特效全部隐藏（幂等；光晕用瞬时关闭，避免演出里还在淡出）。 */
    private hideCardFx(card: Node): void {
        for (const name of CardKeywordSystem.FX_NODES) {
            const n = card.getChildByName(name);
            if (n && n.isValid && n.active) n.active = false;
        }
        const g = card.getComponent(CardGlow);
        if (g && g.isGlowing) g.glowOffImmediate();
    }

    /** 把这张卡身上的词条特效恢复显示（随后由 `refreshVisuals` 按词条重新挂上 / 刷新）。 */
    private showCardFx(card: Node): void {
        for (const name of CardKeywordSystem.FX_NODES) {
            const n = card.getChildByName(name);
            if (n && n.isValid && !n.active) n.active = true;
        }
        this.updateChantBadge(card);
    }

    /** 按回合和攻击状态刷新所有拥有词条的随从自身光晕。 */
    public refreshVisuals(): void {
        for (const field of this.fields()) {
            for (const card of field.cards) {
                if (!this._states.has(card)) this.registerCard(card);
                // 🔴 进化 / 超进化演出期间：整张卡跳过（特效保持隐藏，只留最基础的卡面）
                if (this._fxSuppressed.has(card)) {
                    this.hideCardFx(card);
                    continue;
                }
                // 「守护」护盾特效：持有守护 → 挂上；失去守护 / 卡离场 → 摘掉
                if (this.hasGuard(card)) ensureShieldAura(card, this.shieldConfig());
                else removeShieldAura(card);

                // 「威慑」光圈特效：同上
                if (this.hasDeter(card)) ensureDeterAura(card, this.deterConfig());
                else removeDeterAura(card);

                // 「潜行」黑白烟雾特效：同上（烟雾插在 CardHp 之前 ⇒ 攻击/血量数字永远压在烟雾之上）
                if (this.hasAmbush(card)) ensureAmbushAura(card, this.ambushConfig());
                else removeAmbushAura(card);

                // 「不会被能力破坏」黄色护罩：常驻到卡牌离开战场。
                if (this.hasKeyword(card, KEYWORD_ABILITY_DESTROY_IMMUNE)) attachAbilityImmunityFx(card);
                else removeAbilityImmunityFx(card);

                // 🔴 选择光圈接管中（引导用户选择）→ 完全跳过词条光晕，别把它刷回去
                if (this._glowOverride.has(card)) continue;

                const g = card.getComponent(CardGlow) || card.addComponent(CardGlow);
                const color = this.activeGlowColor(card);
                if (color) {
                    g.useQualityColor = false;
                    g.glowColor.set(color);
                    g.maxIntensity = Math.max(g.maxIntensity, 1.6);
                    if (!g.isGlowing) g.fadeIn();
                    this._auraVisible.add(card);
                } else if (this._auraVisible.has(card)) {
                    g.fadeOut();
                    this._auraVisible.delete(card);
                }
            }
        }
    }

    private registerCard(card: Node): void {
        const id = cardIdFromNodeName(card.name);
        const info = id ? getCardInfo(id) : undefined;
        const abilities = id ? getCardAbilities(id) : [];
        const keywords = new Set<string>([
            ...(info?.keywords || []),
            ...(id ? getCardAbilityKeywords(id) : []),
        ].map((k) => String(k)));
        const chant = abilities.find((a) => a.name === 'Chant');
        const chantTurns = chant ? Math.max(1, Math.floor(Number(chant.params?.turns) || 0)) : 0;
        const rawEffect = chant?.params?.effect;
        const chantEffect = rawEffect && typeof rawEffect === 'object' && !Array.isArray(rawEffect)
            ? rawEffect as CardAbilityInvocation
            : undefined;
        const state: KeywordState = {
            keywords,
            deployedTurnKey: this.turnKey(),
            chantTurns: chantTurns > 0 ? chantTurns : undefined,
            chantEffect,
            auraSources: new Set<Node>(),
        };
        this._states.set(card, state);
        this.updateChantBadge(card);
        if (info?.cardType === 'Follower') this.applyFollowerEntryBuffs(card);
    }

    private applyFollowerEntryBuffs(follower: Node): void {
        const field = this.fieldOf(follower);
        const info = this.infoOf(follower);
        if (!field || !info || info.cardType !== 'Follower') return;
        const state = this.stateOf(follower);
        if (!state) return;
        if (!state.auraSources) state.auraSources = new Set<Node>();

        let attack = 0;
        let hp = 0;
        const selfAttackSources: Array<{ card: Node; attack: number }> = [];
        const gainedKeywords: string[] = [];
        for (const source of field.cards) {
            if (!source || !source.isValid) continue;
            const sourceId = cardIdFromNodeName(source.name);
            const aura = sourceId
                ? getCardAbilities(sourceId).find((a) => a.name === 'FriendlyFollowerEnterBuff')
                : undefined;
            if (!aura) continue;
            // 普通光环不回头作用于自己；卡 19 只在其他己方随从入场时累计自身攻击力。
            if (source === follower && aura.params?.includeSelf !== true) continue;
            if (state.auraSources.has(source)) continue;
            state.auraSources.add(source);

            attack += Math.round(Number(aura.params?.attack) || 0);
            hp += Math.round(Number(aura.params?.hp) || 0);
            const selfAttack = Math.round(Number(aura.params?.selfAttack) || 0);
            if (selfAttack !== 0) {
                if (source === follower) attack += selfAttack;
                else selfAttackSources.push({ card: source, attack: selfAttack });
            }
            const kw = aura.params?.keywords;
            if (Array.isArray(kw)) {
                for (const k of kw) if (typeof k === 'string') gainedKeywords.push(k);
            }
        }

        const rules = this.battleRules();
        if (attack || hp) rules?.addStats?.(follower, attack, hp);
        for (const sourceBuff of selfAttackSources) {
            if (sourceBuff.card.isValid) rules?.addStats?.(sourceBuff.card, sourceBuff.attack, 0);
        }
        for (const keyword of gainedKeywords) state.keywords.add(keyword);
        if (gainedKeywords.length > 0) this.refreshVisuals();
    }
    private tickChantsForCurrentTurn(): void {
        const tm = this.turnManager();
        if (!tm || !tm.isRunning) return;
        for (const field of this.fields()) {
            const side = field.side === BattleSide.Player ? 'player' : 'enemy';
            if (side !== tm.turnSide) continue;
            for (const card of field.cards) {
                const state = this.stateOf(card);
                const turns = Math.max(0, Math.floor(Number(state?.chantTurns) || 0));
                if (!state || turns <= 0) continue;
                if (turns <= 1) {
                    state.chantTurns = 0;
                    this.hideChantBadge(card);
                    const effect = state.chantEffect;
                    const id = cardIdFromNodeName(card.name);
                    // 🔴 咏唱倒数结束 = **一定破坏自身**（内建逻辑，卡表里不用再配 DestroySelf）。
                    //    params.effect 只是「额外的」效果；先结算它再离场，
                    //    这样额外效果结算时这张牌还在战场上（依赖在场的效果才不会落空）。
                    if (effect && id) runCardAbilityEffect(this, id, side, effect, card);
                    if (id) runCardAbilityEffect(this, id, side, { name: 'DestroySelf' }, card);
                } else {
                    state.chantTurns = turns - 1;
                    this.updateChantBadge(card);
                }
            }
        }
    }

    /** 把 Inspector 上的护盾参数组装成一份复用对象，下发给 ShieldAuraFx。 */
    private shieldConfig(): ShieldAuraConfig {
        const c = this._shieldCfg;
        c.shieldScale = this.shieldScale;
        c.offsetX = this.shieldOffsetX;
        c.offsetY = this.shieldOffsetY;
        c.color = this.shieldColor;
        c.glowColor = this.shieldGlowColor;
        c.intensity = this.shieldIntensity;
        c.outerScale = this.shieldOuterScale;
        c.midScale = this.shieldMidScale;
        c.pulsePeriod = this.shieldPulsePeriod;
        c.pulseAmount = this.shieldPulseAmount;
        c.minPulse = this.shieldMinPulse;
        return c;
    }

    /** 把 Inspector 上的威慑光圈参数组装成一份复用对象，下发给 DeterAuraFx。 */
    private deterConfig(): DeterAuraConfig {
        const c = this._deterCfg;
        c.scale = this.deterScale;
        c.offsetX = this.deterOffsetX;
        c.offsetY = this.deterOffsetY;
        c.color = this.deterColor;
        c.glowColor = this.deterGlowColor;
        c.intensity = this.deterIntensity;
        c.fps = this.deterFps;
        c.outerScale = this.deterOuterScale;
        c.outerAlpha = this.deterOuterAlpha;
        c.coreAlpha = this.deterCoreAlpha;
        c.shimmer = this.deterShimmer;
        c.shimmerPeriod = this.deterShimmerPeriod;
        c.crossFade = this.deterCrossFade;
        c.outerAnimate = this.deterOuterAnimate;
        return c;
    }

    private ambushConfig(): AmbushAuraConfig {
        const c = this._ambushCfg;
        c.scale = this.ambushScale;
        c.offsetX = this.ambushOffsetX;
        c.offsetY = this.ambushOffsetY;
        c.cycleSeconds = this.ambushCycleSeconds;
        c.crossFade = this.ambushCrossFade;
        c.breathe = this.ambushBreathe;
        c.breathePeriod = this.ambushBreathePeriod;
        c.dark = {
            color: this.ambushDarkColor, alpha: this.ambushDarkAlpha,
            scale: this.ambushDarkScale, spin: this.ambushDarkSpin,
        };
        c.dark2 = {
            color: this.ambushDark2Color, alpha: this.ambushDark2Alpha,
            scale: this.ambushDark2Scale, spin: this.ambushDark2Spin,
        };
        c.white = {
            color: this.ambushWhiteColor, alpha: this.ambushWhiteAlpha,
            scale: this.ambushWhiteScale, spin: this.ambushWhiteSpin,
        };
        return c;
    }

    private updateChantBadge(card: Node): void {
        const state = this.stateOf(card);
        const turns = Math.max(0, Math.floor(Number(state?.chantTurns) || 0));
        if (turns <= 0) {
            this.hideChantBadge(card);
            return;
        }
        const ut = card.getComponent(UITransform);
        const w = ut ? ut.contentSize.width : 204;
        const h = ut ? ut.contentSize.height : 252;
        let badge = card.getChildByName(CardKeywordSystem.CHANT_BADGE);
        if (!badge) {
            badge = new Node(CardKeywordSystem.CHANT_BADGE);
            badge.setParent(card);
            const but = badge.addComponent(UITransform);
            but.setAnchorPoint(0.5, 0.5);
            const label = badge.addComponent(Label);
            label.horizontalAlign = Label.HorizontalAlign.CENTER;
            label.verticalAlign = Label.VerticalAlign.CENTER;
            label.isBold = true;
            label.enableOutline = true;
            label.outlineColor = new Color(28, 92, 76, 210);
            label.outlineWidth = 4;
        }
        const but = badge.getComponent(UITransform);
        if (but) but.setContentSize(w * 0.28, h * 0.32);
        badge.setPosition(new Vec3(w * 0.34, -h * 0.32, 0));
        const label = badge.getComponent(Label);
        if (label) {
            label.string = String(turns);
            label.fontSize = Math.max(28, Math.round(h * 0.28));
            label.lineHeight = Math.max(28, Math.round(h * 0.30));
            label.color = new Color(168, 255, 205, 255);
        }
        badge.active = true;
    }

    private hideChantBadge(card: Node): void {
        const badge = card.getChildByName(CardKeywordSystem.CHANT_BADGE);
        if (badge) badge.active = false;
    }

    private isFollowerCard(card: Node | null): boolean {
        if (!card || !card.isValid) return false;
        const info = this.infoOf(card);
        return !!info && info.cardType === 'Follower';
    }

    private infoOf(card: Node | null) {
        const id = card && card.isValid ? cardIdFromNodeName(card.name) : '';
        return id ? getCardInfo(id) : undefined;
    }

    private stateOf(card: Node | null): KeywordState | undefined {
        if (!card || !card.isValid) return undefined;
        let state = this._states.get(card);
        if (!state) {
            this.registerCard(card);
            state = this._states.get(card);
        }
        return state;
    }

    private isOwnerTurn(card: Node): boolean {
        const tm = this.turnManager();
        if (!tm || !tm.isRunning) return true;
        const field = this.fieldOf(card);
        if (!field) return false;
        return (field.side === BattleSide.Player && tm.turnSide === 'player')
            || (field.side === BattleSide.Enemy && tm.turnSide === 'enemy');
    }

    private fieldOf(card: Node): BattleFieldLayout | null {
        let n: Node | null = card.parent;
        while (n) {
            const f = n.getComponent(BattleFieldLayout);
            if (f && f.isValid) return f;
            n = n.parent;
        }
        return null;
    }

    private fields(): BattleFieldLayout[] {
        const out: BattleFieldLayout[] = [];
        const scene = this.node.scene as unknown as Node | null;
        if (!scene) return out;
        const stack: Node[] = [...scene.children];
        while (stack.length > 0) {
            const cur = stack.shift() as Node;
            const field = cur.getComponent(BattleFieldLayout);
            if (field && field.isValid) out.push(field);
            for (const ch of cur.children) stack.push(ch);
        }
        return out;
    }

    private turnKey(): string {
        const tm = this.turnManager();
        if (!tm || !tm.isRunning) return 'not-running';
        return `${tm.roundNumber}:${tm.turnIndexInRound}:${tm.turnSide}`;
    }

    private syncTurn(): void {
        const key = this.turnKey();
        if (key === this._turnKey) return;
        const first = this._turnKey === '';
        this._turnKey = key;
        this._attackedThisTurn = new WeakSet<Node>();
        if (!first) this.tickChantsForCurrentTurn();
    }

    private battleRules(): any {
        const scene = this.node.scene as unknown as Node | null;
        if (!scene) return null;
        const stack: Node[] = [...scene.children];
        while (stack.length > 0) {
            const cur = stack.shift() as Node;
            const c = cur.getComponent('BattleRuleSystem');
            if (c) return c;
            for (const ch of cur.children) stack.push(ch);
        }
        return null;
    }

    /** 全场景 BFS 按**类名**找一个组件（带缓存；失效自动重查）。 */
    private findComp(name: string): Component | null {
        const cached = this._compCache.get(name);
        if (cached && cached.isValid) return cached;
        const scene = this.node.scene as unknown as Node | null;
        if (!scene) return null;
        const stack: Node[] = [...scene.children];
        while (stack.length > 0) {
            const cur = stack.shift() as Node;
            const c = cur.getComponent(name);
            if (c) { this._compCache.set(name, c); return c; }
            for (const ch of cur.children) stack.push(ch);
        }
        return null;
    }

    private turnManager(): any {
        if (this._tmCache && this._tmCache.isValid) return this._tmCache;
        const scene = this.node.scene as unknown as Node | null;
        if (!scene) return null;
        const stack: Node[] = [...scene.children];
        while (stack.length > 0) {
            const cur = stack.shift() as Node;
            const c = cur.getComponent('TurnManager');
            if (c) { this._tmCache = c; return c; }
            for (const ch of cur.children) stack.push(ch);
        }
        this._tmCache = null;
        return null;
    }
}
