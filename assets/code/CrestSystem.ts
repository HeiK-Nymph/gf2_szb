import { _decorator, Color, Component, Node, resources, SpriteFrame, Tween, tween, Vec3 } from 'cc';
import { findComponent } from './CardAbilitySystem';
import { CrestArea, CrestSide } from './CrestArea';
import { canCrestActivate, crestEffectsOf, crestNameOf, CrestTiming, runCrestTiming, tickCrestChants } from './CrestEffects';
import { CrestRippleConfig } from './CrestRipple';

const { ccclass, property, menu } = _decorator;

/** 纹章归属方（与 TurnManager.TurnSide 同字面量，避免循环 import） */
export type CrestOwner = 'player' | 'enemy';

/**
 * CrestSystem —— 「纹章」的**权威数据源 + 显示**
 * ===========================================================================
 * 挂在 `TurnManager` 节点上（与 EvoPointSystem 同一套路）。
 *
 * 规则：
 *   · 每个阵营各有一份**有序**的纹章列表（获得顺序）；
 *   · 纹章 id **与卡牌 id 相同**（卡 `4.png` 对应的纹章就是纹章素材 `4.png`）；
 *   · 获得一枚纹章 → 追加到该方列表末尾 → 按顺序落到该方纹章区（`CrestArea`）的
 *     5 个圆里：第 1 枚进 `Crest_0`、第 2 枚进 `Crest_1` ……（槽位名 = 顺序号）。
 * 🔴 两条硬性限制（`gainCrest` 强校验，`setCrests` 也过一遍）：
 *    ① **同名纹章不重复获取** —— `'4.png'` / `'4'` / `'4.PNG'` 视为同一枚（判据见 `canonId`）；
 *    ② **上限 5 枚** —— 满了就拒绝，不再往后溢出（圆只有 5 个）。
 *    两条预判入口：`hasCrest(side, id)` / `canGainCrest(side, id)`（无副作用）。
 *
 * 素材来源（两条路，先查登记库、再走 resources 兜底）：
 *   ① `crestFrames`：Inspector 登记的 SpriteFrame 列表 —— 资源名匹配纹章 id
 *      （`'4.png'` / `'4'` 都能命中）；
 *   ② `assets/resources/<crestResDir>/<id>/spriteFrame`（默认 `crest/4/spriteFrame`）。
 *
 * 显示：由本系统调用 `CrestArea.setSlotIcon(index, sf, ratio)` —— 圆圈本身仍由
 * CrestArea 绘制（@executeInEditMode 实时重排），这里只负责往槽位里放 / 清图标。
 * ===========================================================================
 */
@ccclass('CrestSystem')
@menu('gf2szb/CrestSystem')
export class CrestSystem extends Component {

    // ====================== 素材库 ======================
    @property({
        type: [SpriteFrame],
        tooltip: '纹章素材库：把纹章图（如 assets/image/crest/4.png）拖进来即可。\n'
            + '🔴 纹章 id **与卡牌 id 相同** —— 资源名 `4.png`（或不带扩展名的 `4`）对应卡牌 `4.png` 的纹章。\n'
            + '留空 / 找不到时会退到 `assets/resources/<resourcesDir>/<id>/spriteFrame`。',
    })
    crestFrames: SpriteFrame[] = [];

    @property({
        tooltip: 'resources 兜底目录（仅当素材库 `crestFrames` 里找不到该纹章 id 时使用）。\n'
            + '加载路径 = `assets/resources/<本值>/<纹章id（去扩展名）>/spriteFrame`，默认 `crest`。',
    })
    resourcesDir = 'crest';

    // ====================== 显示 ======================
    @property({
        range: [0.2, 1.2, 0.01], slide: true,
        tooltip: '纹章图标直径 ÷ **圆环内径**（1 = 正好填满圆圈：上下左右贴住环内缘，\n'
            + '方形纹章图的四个角由椭圆裁剪掉 → 看起来就是圆的）。',
    })
    iconSizeRatio = 1;

    @property({
        range: [0, 1, 0.01], slide: true,
        tooltip: '新获得纹章时的弹入时长（秒，图标从 0.6 倍放大到 1 倍）。0 = 不做动画。',
    })
    gainPopDuration = 0.22;

    @property({ tooltip: '打印「获得纹章 / 落位 / 效果发动」日志' })
    verbose = true;

    // ====================== 「可发动」波纹特效 ======================
    // 🔴 效果实现在 CrestEffects.ts（纹章 → 效果的映射表）；这里只管**参数**与驱动。

    @property({
        tooltip: '「可发动」波纹总开关：纹章此刻**能发动**时，在它的圆框边缘循环播放一圈黄环 ——\n'
            + '环始终贴住框边，是**它的边**渐渐往外扩 + 渐渐消失（任何时刻只有这一圈，不是多圈往外跑）。\n'
            + '关闭 = 不做任何提示特效。',
    })
    rippleEnabled = true;

    @property({
        range: [1, 4, 0.01], slide: true,
        tooltip: '★【最大扩大范围】环最大半径 ÷ 圆框半径。\n'
            + '1.75 = 扩到 1.75 倍半径（圆直径 50.4px 时约 = 半径 25.2 → 44px，比圆框大一圈）。\n'
            + '环从圆框外缘出发、边扩边淡，扩到这个范围时刚好淡尽，随后从框边重新出现（一直只有一个环）。',
    })
    rippleMaxScale = 1.75;

    @property({
        range: [0.1, 5, 0.01], slide: true,
        tooltip: '★【一次扩大的时间】环从圆框外缘扩到最大范围的用时（秒），也就是一次呼吸的周期。\n'
            + '越小越急，越大越舒缓。',
    })
    rippleDuration = 1.1;

    @property({
        range: [0.5, 12, 0.5], slide: true,
        tooltip: '主环线宽（px）；外圈那层柔光按它 ×2.2 画。环外扩时会略微变宽 → 越来越柔。',
    })
    rippleThickness = 3;

    @property({
        range: [0, 0.6, 0.01], slide: true,
        tooltip: '★【渐渐出现】的占比：一圈生命周期的前这一小段用来渐入（透明度 0 → 峰值），\n'
            + '其余部分用于「边扩边渐渐消失」。0.18 ≈ 前 18% 时间在渐显（不会「啪」地冒出来）；\n'
            + '调大 = 出现得更慢更柔，调 0 = 一出现就是满亮度（突兀）。',
    })
    rippleAppear = 0.18;

    @property({ type: Color, tooltip: '环的颜色（默认暖黄）' })
    rippleColor = new Color(255, 214, 92, 255);

    @property({ range: [0, 2, 0.05], slide: true, tooltip: '整体透明度倍数（1 = 原色）' })
    rippleIntensity = 1;

    @property({
        range: [0.05, 1, 0.01], slide: true,
        tooltip: '「能否发动」的判定间隔（秒）—— 条件查询不必每帧跑，0.2s 足够跟手。',
    })
    ripplePollInterval = 0.2;

    // ====================== 内部状态 ======================
    /** 双方的纹章 id 列表（**获得顺序** = 落位顺序） */
    private _crests: Record<CrestOwner, string[]> = { player: [], enemy: [] };
    /** 纹章资源库（资源名 → SpriteFrame） */
    private _lib: Record<string, SpriteFrame> = {};
    /** 正在后台加载的纹章 id（防重复请求） */
    private readonly _loading = new Set<string>();
    /** resources 加载失败的 id（不再重复请求 / 刷屏告警） */
    private readonly _missing = new Set<string>();
    /** 弹入动画的补间代理（一槽一个，避免复用节点时串味） */
    private readonly _pops = new Map<number, { s: number }>();
    /** 波纹判定节流累加器 */
    private _rippleAcc = 0;
    /** 各槽位上一帧的波纹状态（只在**变化**时打日志，避免刷屏） */
    private readonly _rippleOn = new Map<string, boolean>();
    /** TurnManager 引用缓存（波纹判定要问「现在是谁的回合」） */
    private _tmCache: any = null;
    /**
     * 【触发型纹章】「本回合是否已触发过一次」的登记（key = **规范纹章 id**）。
     * 己方回合开始（`runTiming('turnStart', side)`）时清空该方的登记；
     * 重开对局（`clear`）时一并清空。
     */
    private readonly _triggerFiredOnce: Record<CrestOwner, Set<string>> =
        { player: new Set(), enemy: new Set() };

    // ------------------------------ 生命周期 ------------------------------
    onLoad(): void {
        this.buildLib();
        this.refresh();
    }

    onEnable(): void {
        this.buildLib();
        this.refresh();
    }

    onDisable(): void {
        for (const p of this._pops.values()) Tween.stopAllByTarget(p);
        this._pops.clear();
        this.clearRipples();
    }

    /**
     * 「可发动」波纹的**节流轮询**：每 `ripplePollInterval` 秒重新判定一次
     * （条件查询不必每帧跑；波纹本身的动画在 `CrestRipple` 里逐帧画）。
     */
    update(dt: number): void {
        if (!this.rippleEnabled) return;
        this._rippleAcc += dt;
        const step = Math.max(0.05, this.ripplePollInterval);
        if (this._rippleAcc < step) return;
        this._rippleAcc = 0;
        this.refreshRipples();
    }

    /** 熄灭双方所有槽位的波纹 */
    public clearRipples(): void {
        for (const side of ['player', 'enemy'] as CrestOwner[]) {
            const area = this.areaOf(side);
            if (area && area.isValid) area.clearSlotRipples();
        }
    }

    // ------------------------------ 对外 API ------------------------------
    /** 纹章上限（与 `CrestArea` 的 5 个圆一一对应） */
    public get crestLimit(): number {
        return MAX_CRESTS;
    }

    /**
     * 获得一枚纹章：追加到该方列表末尾，并立刻落到纹章区对应槽位。
     *
     * 🔴 两条硬性限制（需求）：
     *   ① **同名纹章不能重复获取** —— 该方已有同名纹章时直接拒绝
     *      （同名判据 = 去扩展名 + 忽略大小写，所以 `4.png` 与 `4` 视为同一枚）；
     *   ② **上限 5 枚** —— 已满时拒绝，不会再往后溢出（槽位只有 `Crest_0 ~ Crest_4`）。
     *
     * @param side    归属方
     * @param crestId 纹章 id（= 卡牌 id，如 '4.png'）
     * @returns 是否真的新增（id 为空 / 已有同名 / 该方已满 5 枚 → false）
     */
    /** 按纹章定义里的 chantTurns 刷一次吟唱角标（**获得时**就要显示，如纹章 15 → 2）。 */
    private primeChantBadge(side: CrestOwner, crestId: string): void {
        try {
            const defs = crestEffectsOf(crestId);
            let n = 0;
            for (const d of defs) n = Math.max(n, Math.max(0, Math.floor(Number(d.chantTurns) || 0)));
            if (n > 0) this.setChantBadge(side, crestId, n);
        } catch (e) { /* 角标失败不影响逻辑 */ }
    }

    public gainCrest(side: CrestOwner, crestId: string): boolean {
        const id = normalizeId(crestId);
        if (!id) return false;
        const list = this._listOf(side);
        if (list.length >= MAX_CRESTS) {
            console.warn(`[CrestSystem] ${side} 的纹章区已满（上限 ${MAX_CRESTS} 枚），无法获得新纹章 ${id}`);
            return false;
        }
        if (this.hasCrest(side, id)) {
            if (this.verbose) {
                console.log(`[CrestSystem] ${side} 已拥有同名纹章 ${id}，不重复获取（当前 ${list.length} 枚）`);
            }
            return false;
        }
        list.push(id);
        const index = list.length - 1;
        this.refreshSlot(side, index, true);
        const nm = crestNameOf(id);
        if (this.verbose) {
            console.log(`[CrestSystem] ${side} 获得纹章 ${id}${nm && nm !== id ? '「' + nm + '」' : ''}`
                + ` → 落到 Crest_${index}（共 ${list.length}/${MAX_CRESTS} 枚）`);
        }
        // ★ 获得时就刷一次**吟唱角标**（需求：刚拿到纹章 15 就要显示 2，而不是等第一次倒数）
        this.primeChantBadge(side, id);
        // 获得即生效的效果（timing = 'onGain'）
        this.runTiming('onGain', side);
        this.refreshRipples();
        return true;
    }

    // ====================== 纹章效果：触发 + 可发动提示 ======================
    /**
     * 结算某一方在某个**时机**下的全部纹章效果（由 `TurnManager` 在回合开始 / 结束时调用）。
     * 效果实现在 `CrestEffects.ts` 的映射表里，这里只负责「拿谁的纹章列表」。
     * @returns 实际发动了几个纹章
     */
    /**
     * ★ **纹章图标上的吟唱角标**（需求：像护符的吟唱那样显示当前吟唱数）。
     * `n <= 0` ⇒ 清掉角标。找不到纹章区 / 槽位时静默跳过。
     */
    public setChantBadge(side: CrestOwner, crestId: string, n: number): void {
        try {
            const area = this.areaOf(side) as unknown as { setSlotChant?: (index: number, n: number) => boolean } | null;
            const a = area;
            if (!a || typeof a.setSlotChant !== 'function') return;
            const idx = this.slotIndexOf(side, crestId);
            if (idx < 0) return;
            a.setSlotChant(idx, n);
        } catch (e) {
            console.error('[CrestSystem] 刷新吟唱角标失败：', e);
        }
    }

    public runTiming(timing: CrestTiming, side: CrestOwner): number {
        // ★ 吟唱倒数（需求：纹章也有吟唱，跟护符一样，倒数完破坏自身）——
        //   🔴 **在自己回合「开始」时倒数**（用户口径：我方回合开始 -1；放回合结束会因为
        //      回合结束演出排在切回合前后，看起来像「敌方回合开始时破坏」）。
        if (timing === 'turnStart') {
            try {
                const ids = this.crestsOf(side);
                tickCrestChants(this as unknown as { setCrests?: (s: string, ids: string[]) => void }, side, ids, this);
            } catch (e) {
                console.error('[CrestSystem] 纹章吟唱结算出错：', e);
            }
        }
        // 🔴 触发型纹章（「每回合触发一次」）的登记在**己方回合开始**时清空。
        //    先清再做空表短路：哪怕该方此刻一枚纹章都没有，登记也必须复位。
        if (timing === 'turnStart') this._triggerFiredOnce[side] = new Set();
        const list = this._listOf(side);
        if (list.length === 0) return 0;
        const fired = runCrestTiming(this, timing, side, list, this.turnSideOf());
        if (fired > 0 && this.verbose) {
            console.log(`[CrestSystem] ${side} 在 ${timing} 时机发动了 ${fired} 枚纹章效果`);
        }
        this.refreshRipples();
        return fired;
    }

    /**
     * 【触发型纹章】对方**随从被破坏**时的事件入口（由 `BattleCommandSystem` 在
     * 「破坏」演出开播时调用；我方可调用、敌方 AI 的破坏同样会走到）。
     *
     * 触发判定（三重门槛，全部满足才结算）：
     *   ① 正在对局中（`TurnManager.isRunning` 守卫，防止未开战 / 清场误触发）；
     *   ② 被破坏的随从属于**当前操作回合那一方**（= 纹章归属方的「对方」随从）；
     *   ③ 当前是纹章归属方自己的回合（「我方回合时」）。
     * 「每回合触发一次」的登记在本方回合开始（`turnStart`）时清空。
     *
     * @param destroyedSide 被破坏的随从所属阵营（'player' / 'enemy'）
     * @returns 实际发动了几次
     */
    public notifyOppFollowerDestroyed(destroyedSide: CrestOwner): number {
        const tm = this.turnManagerOf();
        if (!tm || tm.isRunning !== true) return 0;
        const turnSide = (tm.turnSide as CrestOwner) ?? null;
        if (!turnSide) return 0;
        const owner: CrestOwner = destroyedSide === 'player' ? 'enemy' : 'player';
        if (turnSide !== owner) return 0;      // 只在纹章归属方自己的回合触发
        return this.runTiming('onOppFollowerDestroyed', owner);
    }

    /** 【触发型纹章】标记「本回合已触发过一次」（key = 规范 id：去扩展名 + 小写） */
    public markTriggerFiredOnce(side: CrestOwner, crestId: string): void {
        const key = canonId(crestId);
        if (!key) return;
        this._triggerFiredOnce[side].add(key);
    }

    /** 【触发型纹章】本回合是否已经触发过一次（纯查询，无副作用） */
    public hasTriggerFiredOnce(side: CrestOwner, crestId: string): boolean {
        const key = canonId(crestId);
        return !!key && this._triggerFiredOnce[side].has(key);
    }

    /** 某枚纹章的中文名（未登记 → 返回原 id） */
    public nameOf(crestId: string): string {
        return crestNameOf(crestId);
    }

    /**
     * 重新判定双方每个槽位的「**可发动**」波纹（纯查询，无副作用）。
     * 🔴 判据 = `CrestEffects.canCrestActivate`：效果已登记 + 时机对上自己回合 + 条件满足。
     */
    public refreshRipples(): void {
        const turnSide = this.turnSideOf();
        const cfg = this.rippleConfig();
        for (const side of ['player', 'enemy'] as CrestOwner[]) {
            const area = this.areaOf(side);
            if (!area || !area.isValid) continue;
            const list = this._listOf(side);
            for (let i = 0; i < MAX_CRESTS; i++) {
                const id = list[i];
                const on = this.rippleEnabled && !!id && canCrestActivate(this, side, id, turnSide);
                if (on) area.setSlotRipple(i, true, cfg);
                else area.setSlotRipple(i, false);
                this._logRippleChange(side, i, id, on, turnSide);
            }
        }
    }

    /** 波纹「亮/灭」发生**变化**时打一条日志（便于在现场判断为什么不亮） */
    private _logRippleChange(
        side: CrestOwner, index: number, id: string, on: boolean, turnSide: CrestOwner | null,
    ): void {
        const key = side + '#' + index;
        if (this._rippleOn.get(key) === on) return;
        this._rippleOn.set(key, on);
        if (!this.verbose || !id) return;
        const why = on ? '' : (turnSide !== side ? `（当前是 ${turnSide ?? '未开战'} 的回合）` : '（时机 / 条件不满足）');
        console.log(`[CrestSystem] ${side} Crest_${index}「${crestNameOf(id)}」可发动波纹 → ${on ? '亮' : '灭'}${why}`);
    }

    /** 波纹参数（权威值 = 上面那几个 @property）→ 传给 CrestRipple */
    private rippleConfig(): CrestRippleConfig {
        return {
            maxScale: this.rippleMaxScale,
            duration: this.rippleDuration,
            thickness: this.rippleThickness,
            appear: this.rippleAppear,
            color: this.rippleColor,
            intensity: this.rippleIntensity,
        };
    }

    /** 当前操作回合归属（未开战 / 找不到 TurnManager → null）；按类名查，避免循环 import */
    private turnSideOf(): CrestOwner | null {
        const tm = this.turnManagerOf();
        return tm ? (tm.turnSide as CrestOwner) ?? null : null;
    }

    /** TurnManager 组件（缓存，失效自动重查；按类名 BFS，避免循环 import） */
    private turnManagerOf(): any {
        if (this._tmCache && this._tmCache.isValid) return this._tmCache;
        const tm = findComponent(this, 'TurnManager');
        this._tmCache = tm;
        return tm;
    }

    /** 某一方是否**已经拥有**该纹章（同名判据 = 去扩展名 + 忽略大小写）。 */
    public hasCrest(side: CrestOwner, crestId: string): boolean {
        const key = canonId(crestId);
        if (!key) return false;
        return this._listOf(side).some((x) => canonId(x) === key);
    }

    /**
     * 现在能否获得这枚纹章（**不产生任何副作用**，供能力 / AI 预判）。
     * = 该方未满 5 枚 且 未拥有同名纹章。
     */
    public canGainCrest(side: CrestOwner, crestId: string): boolean {
        const id = normalizeId(crestId);
        if (!id) return false;
        if (this._listOf(side).length >= MAX_CRESTS) return false;
        return !this.hasCrest(side, id);
    }

    /**
     * 直接设置某一方的纹章列表（顺序 = 落位顺序），并整片刷新。
     * 🔴 同样过一遍「去重 + 上限」：重复项只保留第一次出现的那枚。
     */
    public setCrests(side: CrestOwner, ids: string[]): void {
        const list: string[] = [];
        const seen = new Set<string>();
        for (const raw of ids || []) {
            const id = normalizeId(raw);
            const key = canonId(id);
            if (!id || !key || seen.has(key) || list.length >= MAX_CRESTS) continue;
            seen.add(key);
            list.push(id);
        }
        this._crests[side] = list;
        this.refresh(side);
    }

    /** 某一方当前的纹章 id 列表（副本，按获得顺序） */
    public crestsOf(side: CrestOwner): string[] {
        return this._listOf(side).slice();
    }

    /** 某枚纹章落在**第几个槽位**（= 获得顺序；没这枚 / 参数空 → -1）。 */
    public slotIndexOf(side: CrestOwner, crestId: string): number {
        const key = canonId(crestId);
        if (!key) return -1;
        const list = this._listOf(side);
        for (let i = 0; i < list.length; i++) if (canonId(list[i]) === key) return i;
        return -1;
    }

    /**
     * 某枚纹章**图标的中心**（世界坐标）—— 供「从纹章中心发射子弹」这类特效取起点。
     *
     * 🔴 返回的是**副本**（`.clone()`）：`node.worldPosition` 是共享可变引用，
     *    直接把它交出去会被后续的坐标运算写坏。
     * @returns 世界坐标；找不到这枚纹章 / 找不到纹章区 / 槽位尚未建出来 → null
     */
    public slotWorldCenter(side: CrestOwner, crestId: string): Vec3 | null {
        const index = this.slotIndexOf(side, crestId);
        if (index < 0) return null;
        const area = this.areaOf(side);
        if (!area || !area.isValid) return null;
        const slot = area.getSlot(index);
        if (!slot || !slot.isValid) return null;
        // 图标节点（CrestIcon）在槽位中心 (0,0)；它存在时以它为准，否则退回槽位中心
        const icon = slot.getChildByName('CrestIcon');
        const node = (icon && icon.isValid) ? icon : slot;
        return node.worldPosition.clone();
    }

    /** 清空纹章（side 留空 = 双方一起清）；重开对局用 */
    public clear(side?: CrestOwner): void {
        const sides: CrestOwner[] = side ? [side] : ['player', 'enemy'];
        for (const s of sides) {
            this._crests[s] = [];
            this._triggerFiredOnce[s] = new Set();      // 触发型登记一并清空
            this.refresh(s);
            const area = this.areaOf(s);
            if (area && area.isValid) area.clearSlotRipples();      // 波纹一并熄灭
        }
    }

    /** 重开对局：双方纹章清空（由 TurnManager.resetBattle 调用） */
    public resetForBattle(): void {
        this.clear();
        if (this.verbose) console.log('[CrestSystem] 重开对局 → 双方纹章已清空');
    }

    /** 把某一方（留空 = 双方）的纹章按顺序刷到纹章区 */
    public refresh(side?: CrestOwner): void {
        const sides: CrestOwner[] = side ? [side] : ['player', 'enemy'];
        for (const s of sides) {
            const n = this._listOf(s).length;
            for (let i = 0; i < MAX_CRESTS; i++) this.refreshSlot(s, i, false, i < n);
        }
    }

    // ------------------------------ 内部：落位 ------------------------------
    /**
     * 刷新单个槽位。
     * @param pop true = 本次是「新获得」→ 播放弹入动画
     */
    private refreshSlot(side: CrestOwner, index: number, pop: boolean, occupiedForce?: boolean): void {
        const area = this.areaOf(side);
        if (!area || !area.isValid) {
            if (this.verbose) console.warn(`[CrestSystem] 找不到 ${side} 的纹章区（CrestArea），纹章仅记录不显示`);
            return;
        }
        const id = this._listOf(side)[index] || '';
        const occupied = occupiedForce === undefined ? !!id : occupiedForce;
        const sf = occupied && id ? this.iconOf(id) : null;
        area.setSlotIcon(index, sf, this.iconSizeRatio);
        if (occupied && id && !sf) {
            console.warn(`[CrestSystem] 纹章素材缺失：id=${id}（既不在 crestFrames 里，resources/${this.resourcesDir}/${stripExt(id)} 也没找到）`);
        }
        if (pop && sf) this.playPop(area, index);
    }

    /** 新获得纹章的弹入：图标从 0.6 倍放大到 1 倍（与槽位尺寸无关，只动 scale） */
    private playPop(area: CrestArea, index: number): void {
        const slot = area.getSlot(index);
        const icon = slot ? slot.getChildByName('CrestIcon') : null;
        if (!icon || !icon.isValid) return;
        const dur = Math.max(0, this.gainPopDuration);
        if (dur <= 0) { icon.setScale(1, 1, 1); return; }

        let proxy = this._pops.get(index);
        if (!proxy) { proxy = { s: 1 }; this._pops.set(index, proxy); }
        Tween.stopAllByTarget(proxy);
        proxy.s = 0.6;
        icon.setScale(0.6, 0.6, 1);
        tween(proxy)
            .to(dur, { s: 1 }, {
                easing: 'backOut',
                onUpdate: () => {
                    try { if (icon.isValid) icon.setScale(proxy!.s, proxy!.s, 1); } catch (e) { /* 节点可能已销毁 */ }
                },
            })
            .call(() => {
                try { if (icon.isValid) icon.setScale(1, 1, 1); } catch (e) { /* 同上 */ }
            })
            .start();
    }

    // ------------------------------ 内部：资源 ------------------------------
    /** 由 `crestFrames` 建「资源名 → SpriteFrame」的库（带扩展名与不带扩展名都登记） */
    private buildLib(): void {
        const lib: Record<string, SpriteFrame> = {};
        for (const sf of this.crestFrames || []) {
            if (!sf) continue;
            for (const name of candidateNames(sf)) {
                if (!name) continue;
                if (!lib[name]) lib[name] = sf;
                const noExt = stripExt(name);
                if (noExt && !lib[noExt]) lib[noExt] = sf;
            }
        }
        this._lib = lib;
    }

    /** 取某个纹章 id 的 SpriteFrame（先查库、再异步走 resources 兜底） */
    private iconOf(id: string): SpriteFrame | null {
        if (Object.keys(this._lib).length === 0) this.buildLib();
        const key = normalizeId(id);
        if (!key) return null;
        const hit = this._lib[key] || this._lib[stripExt(key)] || null;
        if (hit) return hit;
        this.requestResourceIcon(key);
        return null;
    }

    /** resources 兜底：`<resourcesDir>/<id 去扩展名>/spriteFrame`（加载成功后自动重刷显示） */
    private requestResourceIcon(id: string): void {
        const dir = (this.resourcesDir || '').replace(/^\/+|\/+$/g, '');
        if (!dir) return;
        const path = `${dir}/${stripExt(id)}/spriteFrame`;
        if (this._loading.has(path) || this._missing.has(path)) return;
        this._loading.add(path);
        resources.load(path, SpriteFrame, (err, asset) => {
            this._loading.delete(path);
            if (err || !asset) {
                this._missing.add(path);
                console.warn(`[CrestSystem] resources 里找不到纹章素材：${path}`);
                return;
            }
            this._lib[normalizeId(id)] = asset as SpriteFrame;
            this._lib[stripExt(id)] = asset as SpriteFrame;
            this.refresh();
        });
    }

    // ------------------------------ 内部：解析 ------------------------------
    private _listOf(side: CrestOwner): string[] {
        if (!this._crests[side]) this._crests[side] = [];
        return this._crests[side];
    }

    /** 找某一方的纹章区组件（按 `CrestArea.side` 全场景 BFS，不依赖节点名） */
    public areaOf(side: CrestOwner): CrestArea | null {
        const want = side === 'enemy' ? CrestSide.Enemy : CrestSide.Player;
        const scene = this.node.scene as unknown as Node | null;
        if (!scene) return null;
        const stack: Node[] = [...scene.children];
        while (stack.length > 0) {
            const cur = stack.shift() as Node;
            const area = cur.getComponent(CrestArea);
            if (area && area.isValid && area.side === want) return area;
            for (const ch of cur.children) stack.push(ch);
        }
        return null;
    }
}

/** 纹章槽位数（与 CrestArea 的 Crest_0 ~ Crest_4 一致） */
const MAX_CRESTS = 5;

/** 归一化纹章 id：留空返回 ''，其余 trim（保持原样，如 '4.png'） */
function normalizeId(id: string): string {
    return typeof id === 'string' ? id.trim() : '';
}

/**
 * 同名判据（`'4.png'` 与 `'4'` / `'4.PNG'` 视为**同一枚**纹章）。
 * 只用于「是否重复」的比较，落位仍存原始 id（显示要找素材）。
 */
function canonId(id: string): string {
    return stripExt(normalizeId(id)).toLowerCase();
}

/** 去掉扩展名：'4.png' → '4' */
function stripExt(name: string): string {
    return name.replace(/\.[a-z0-9]+$/i, '');
}

/** 从一个 SpriteFrame 上尽力推断其资源名（与 CardComposer 同一套口径） */
function candidateNames(sf: SpriteFrame): string[] {
    const out: string[] = [];
    const push = (v: unknown) => { if (typeof v === 'string' && v.length > 0 && out.indexOf(v) < 0) out.push(v); };
    const s = sf as unknown as Record<string, unknown>;
    push(s.name);
    push(s._name);
    const tex = (s.texture ?? s._texture) as Record<string, unknown> | undefined;
    if (tex) {
        push(tex.name);
        push(tex._name);
        const img = (tex.image ?? tex._image) as Record<string, unknown> | undefined;
        if (img) { push(img.name); push(img._name); }
    }
    return out;
}
