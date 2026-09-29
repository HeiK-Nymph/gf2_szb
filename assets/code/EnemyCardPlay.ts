import {
    _decorator, Camera, Canvas, Component, Node, Tween, tween, UITransform, Vec3,
} from 'cc';
import { CardPlay, bezierAt, bezierControl, nodeWidth, toFront, canAffordPP, ppRemaining, spendPP } from './CardPlay';
import { EnemyHandLayout } from './EnemyHandLayout';
import { BattleFieldLayout, BattleSide } from './BattleFieldLayout';
import { CardComposer, killNode } from './CardComposer';
import { getCardInfo, maxEnhanceOf, markEnhancedThisPlay, resolveCardFrame } from './CardData';
import {
    cardTargetRequest, runCardFanfareAbilities, runCardPassiveAbilities, runCardUseAbilities,
} from './CardAbilitySystem';
import { TargetSelectSystem } from './TargetSelectSystem';
import { addToGrave } from './CardDeckManager';
import { playSpellCastOrb, preloadSpellCastOrbAssets } from './SpellCastOrbFx';

const { ccclass, property, requireComponent, menu } = _decorator;

/**
 * EnemyCardPlay —— 敌方手牌打出（指定一张 → 旋转变大移到正中展示 → 入敌方战场最左）
 * ===========================================================================
 * 挂在**敌方手牌区节点**（Canvas/EnemyHandArea）上，与 PlayerHandArea 的 CardPlay
 * 是「同一套打出手感」的敌方版本。流程（全部参数与我方 CardPlay **双向绑定**）：
 *
 * 第一步：卡背边旋转边移动到摄像头正中央展示（`playCardAt(index)` 触发）
 *   · 从 EnemyHandLayout 的第 index 张（0 = 最左）取出卡背节点，校验：
 *     **法术(Spell)可使用**：展示完成后直接消失，不进入敌方战场；
 *   · 卡背节点搬进专图层 `EnemyCardPlayLayer`（Canvas 下动态建、恒置顶），
 *     从 EnemyHandLayout 摘牌（不销毁），其余卡背 tween 到少一张后的新横排；
 *   · tween（总时长 = moveDuration，**与我方 CardPlay.moveDuration 绑定**）：
 *     位置 手牌位 → 摄像头正中（与我方展示位置同一换算）、
 *     缩放 手牌缩放 → ×centerScale（**展示大小与我方一致**）、
 *     旋转 **绕 Y 轴连续自转 0° → 360°**；
 *   · 🔴 **旋转到 Y=90°（完全侧对镜头、宽度为零）的那一瞬，立刻把卡背替换成
 *     对应的「真实战场卡牌」**（敌方战场工厂按 `frameFor(id)` 拼出），继续完成
 *     剩余的旋转移动动画 —— 90°/360≡0° 都不可见，换脸肉眼无缝；到正中时恰好转满
 *     一圈回到 0°，以**真实卡牌**的姿态开始展示（停留 holdDuration，与我方绑定）。
 *
 * 第二步：展示后飞入敌方战场**最左边**（参照我方 CardPlay 的飞行脚本）
 *   · 与我方完全同款的二次贝塞尔（控制点 = 中点 + 垂直向上 × arcHeight）+ sineInOut，
 *     总时长 travelDuration（**与我方绑定**）；飞行中缩放从展示大小补间到战场 cardScale，
 *     落地与 layout() 完全一致、不跳位；
 *   · 并行：敌方战场现有卡牌 tween 到「最左多一张、整体右移」后的新排布
 *     （`computeTargetsPrepend` / `adoptCardLeft`，与我方「最右入场、整排让位」同机制）；
 *     敌方手牌其余卡背同时 tween 收紧（tweenRest）。
 *
 * 参数双向绑定（需求：我方/敌方「进入战场」的参数永远一致）
 *   moveDuration / centerScale / holdDuration / arcHeight / travelDuration 五个参数
 *   与我方 CardPlay **互相同步**：`syncWithPlayer`（默认开）时，改任一侧的 Inspector 值，
 *   另一侧下一帧自动跟随（开局先以我方为基准对齐一次；快照比对防 ping-pong，
 *   与 BattleFieldLayout 的排布参数同步同一套路）。
 *
 * 实现要点（与 CardPlay 共享同一套坑位结论）
 *   · tween 回调异常会被 TweenSystem 吞掉 → onUpdate/land 全部套 try/catch 熔断兜底；
 *   · 复用/销毁节点用严格 isValid；killNode 先脱离父节点再 destroy；
 *   · 贝塞尔/取宽/置顶工具直接 import 自 CardPlay.ts（导出的同一份实现，不另抄一份）。
 * ===========================================================================
 */
@ccclass('EnemyCardPlay')
@requireComponent(UITransform)
@menu('gf2szb/EnemyCardPlay')
export class EnemyCardPlay extends Component {

    // ====================== 展示段参数（与我方 CardPlay 绑定同步）======================
    @property({
        range: [0, 3, 0.01], slide: true,
        tooltip: '第一步「卡背边旋转边移动到摄像头正中」的 tween **总**时长（秒）。\n'
            + '🔗 与我方 CardPlay.moveDuration 双向绑定：改任一侧，另一侧自动一致。',
    })
    moveDuration = 0.35;

    @property({
        range: [0.1, 4, 0.01], slide: true,
        tooltip: '卡牌在摄像头正中**展示时的大小**（相对敌方手牌基础缩放）。\n'
            + '🔗 与我方 CardPlay.centerScale 双向绑定 → 展示大小与我方永远一致。',
    })
    centerScale = 1.6;

    @property({
        range: [0, 5, 0.01], slide: true,
        tooltip: '卡牌在摄像头正中**展示**的时长（秒），到点后开始飞入战场。\n'
            + '🔗 与我方 CardPlay.holdDuration 双向绑定。',
    })
    holdDuration = 1.0;

    // ====================== 入战场段参数（与我方 CardPlay 绑定同步）======================
    @property({
        range: [-800, 800, 1], slide: true,
        tooltip: '二次贝塞尔的拱起高度（px），与我方打出的弧线完全同款。\n'
            + '🔗 与我方 CardPlay.arcHeight 双向绑定。',
    })
    arcHeight = 180;

    @property({
        range: [0, 3, 0.01], slide: true,
        tooltip: '「飞入敌方战场最左 + 战场右移让位 + 敌方手牌收紧」的 tween **总**时长（秒）。\n'
            + '🔗 与我方 CardPlay.travelDuration 双向绑定。',
    })
    travelDuration = 0.55;

    // ====================== 开关 & 依赖 ======================
    @property({ tooltip: '总开关：关闭后 playCardAt 一律拒绝' })
    enablePlay = true;

    @property({ tooltip: '使用法术时是否播放「法术圈」特效（在**法术展示卡消失那一刻**触发，与能力结算时机无关）' })
    spellCastFxOnUse = true;

    @property({
        tooltip: '入场曲（Fanfare）是否在敌方随从入场时结算 —— 与我方 CardPlay 走**同一条能力管线**，\n'
            + '区别只在目标来源：我方等玩家点选，敌方由 AI 按统一策略自动选（TargetSelectSystem.autoPick）。',
    })
    autoFanfare = true;

    @property({ tooltip: '打印敌方入场曲 / 能力结算日志' })
    verbose = true;

    @property({
        tooltip: '与我方 CardPlay **双向绑定**这五个打出手感参数（moveDuration/centerScale/\n'
            + 'holdDuration/arcHeight/travelDuration）：任一侧改动，另一侧下一帧自动一致；\n'
            + '开局先以我方为基准对齐一次。关闭 = 各调各的（不推荐）。',
    })
    syncWithPlayer = true;

    @property({ type: CardPlay, tooltip: '（可选）我方打出组件（绑定同步对象）；留空自动在场景里查找。' })
    playerPlay: CardPlay | null = null;

    @property({ type: EnemyHandLayout, tooltip: '（可选）敌方手牌布局组件；留空自动在本节点上查找。' })
    enemyHand: EnemyHandLayout | null = null;

    @property({ type: BattleFieldLayout, tooltip: '（可选）敌方战场布局组件；留空自动在场景里查找 **side = Enemy** 的战场。' })
    battlefield: BattleFieldLayout | null = null;

    // ------------------------------ 内部状态 ------------------------------
    private _busy = false;
    private _fieldCard: Node | null = null;
    /** 本次打出的**敌方手牌节点**（卡背）：只在入场通知里用来搬运奥义槽快照，收尾即清 */
    private _handCard: Node | null = null;
    private _id = '';
    private _isSpell = false;
    private _playLayer: Node | null = null;
    private _cam: Camera | null = null;
    /** TargetSelectSystem 引用缓存（入场曲自动选目标用）。 */
    private _selectCache: TargetSelectSystem | null = null;
    private _seq = 0;
    /** 中央展示计时器（用定时器而非 scheduleOnce，避免预览环境重复触发 launch）。 */
    private _holdTimer: ReturnType<typeof setTimeout> | null = null;
    // —— 参数绑定快照（防 ping-pong，与 BattleFieldLayout.syncParams 同套路）——
    private _snapInit = false;
    private _snapM = 0;
    private _snapC = 0;
    private _snapH = 0;
    private _snapA = 0;
    private _snapT = 0;

    // ------------------------------ 生命周期 ------------------------------
    onLoad(): void {
        preloadSpellCastOrbAssets();   // 预加载法术特效资源，避免第一次用法术时还没就绪
    }

    onDisable(): void {
        if (this._fieldCard) killNode(this._fieldCard);
        this._fieldCard = null;
        this._busy = false;
        this._isSpell = false;
        this.clearHoldTimer();
    }

    update(): void {
        this.syncParams();
    }

    // ------------------------------ 对外查询 / API ------------------------------
    /** 是否正在播放打出动画 */
    /**
     * ★ 指定本次打出的**「模式」选项下标**（-1 = 走默认第 1 个）。
     * 与玩家侧 `CardPlay` 的 `_fanfareMode` 完全同一份口径：`CardAbilitySystem.Mode` 读 `host._fanfareMode`。
     * 敌方 AI 在每次出牌前按「逐选项试算取最优」的结果下发。
     */
    public setFanfareMode(index: number): void {
        const n = Math.floor(Number(index));
        this._fanfareMode = Number.isFinite(n) && n >= 0 ? n : -1;
    }

    /** 本次打出的「模式」选项下标（-1 = 默认） */
    private _fanfareMode = -1;

    public get isPlaying(): boolean {
        return this._busy;
    }

    /** 打出专图层（供测试/排查） */
    public get playLayer(): Node | null {
        return this._playLayer;
    }

    /**
     * 让敌方手牌中**指定第几张**（0 = 最左，与手牌横排顺序一致）打出进入敌方战场。
     * 走完整流程：卡背旋转移动到正中（Y=90° 换成真实战场卡牌）→ 展示 → 飞入战场最左。
     * @param index 敌方手牌中的下标（0 基）；越界返回 false
     * @returns 是否成功起手（false = 开关关 / 动画中 / 越界 / 未登记 / 战场已满）
     */
    public playCardAt(index: number): boolean {
        if (!this.enablePlay) return false;
        if (this._busy) return false;
        const ehl = this.resolveEnemyHand();
        const bf = this.resolveField();
        if (!ehl || !bf) return false;
        const card = ehl.cards[index] ?? null;
        if (!card || !card.isValid) return false;
        const id = ehl.cardIdOf(card);
        if (!id) return false;
        const info = getCardInfo(id);
        if (!info) return false;
        // 🔴 费用判定（与我方 CardPlay 同一规则）：剩余费用不够 → 不做使用判定，卡背留在手牌
        if (!canAffordPP(this.node, 'enemy', info.cost)) {
            console.log(`[EnemyCardPlay] 剩余费用不足：${info.cardName}（费用 ${info.cost}）`
                + ` > 剩余 PP ${ppRemaining(this.node, 'enemy')}，不做使用判定`);
            return false;
        }
        // 法术不进入战场，不受战场容量 / 上阵类型判定约束。
        if (info.cardType !== 'Spell') {
            const chk = bf.canPlace(id);
            if (!chk.ok) {
                console.log(`[EnemyCardPlay] 无法打出：${chk.reason}`);
                return false;
            }
        }
        return this.play(card, id, ehl, bf);
    }

    // ------------------------------ 主流程 ------------------------------
    private play(card: Node, id: string, ehl: EnemyHandLayout, bf: BattleFieldLayout): boolean {
        const info = getCardInfo(id);
        if (!info) return false;
        const isSpell = info.cardType === 'Spell';
        const composer = bf.composerRef;
        const frame = isSpell ? resolveCardFrame(info) : bf.frameFor(id);
        if (!composer || !frame) {
            console.log(`[EnemyCardPlay] 起手失败：战场卡框/工厂不可用（id=${id}、frame=${frame}）。`);
            return false;
        }
        const layer = this.playLayerNode();
        if (!layer) return false;

        // 🔴 基础缩放在摘牌之前取（敌方卡背根节点的当前缩放，如 0.55）
        const baseScale = card.scale.x;

        // ① 先建好「真实战场卡牌」（隐藏）：Y=90° 换脸那一瞬才显示
        const tempName = 'EPlay_' + id.replace(/[^\w]/g, '_') + '_' + (this._seq++);
        // 法术展示卡**必须画费用**（需求：敌方使用法术时费用要正常显示）。
        // enemyBf.showCost=false 只针对进入战场的牌（战场框已去掉左上绿费用圈）；
        // 法术不进入战场，这里用的是手牌法术框（含绿费用圈），费用必须补上。
        const fieldCard = composer.composeCard(id, tempName, undefined,
            { frameOverride: frame, suppressCost: isSpell ? false : !bf.showCost }) as Node | null;
        if (!fieldCard || !fieldCard.isValid) {
            console.log(`[EnemyCardPlay] 起手失败：战场样式卡牌生成不出来（id=${id}、frame=${frame}）。`);
            return false;
        }
        fieldCard.setParent(layer, true);
        fieldCard.active = false;

        // ② 卡背搬进专图层 + 从敌方手牌集合摘除（不销毁、不重排）
        card.setParent(layer, true);
        if (!ehl.releaseCard(card)) {
            killNode(fieldCard);
            return false;
        }

        this._busy = true;
        this._fieldCard = fieldCard;
        this._handCard = card;
        this._id = id;
        this._isSpell = isSpell;

        // 🔴 费用消耗（与我方同一条规则）：提交打出的这一刻扣敌方 PP 并更新右侧显示
        // ★ 爆能强化：剩余能量点 ≥ 强化值时**改为消耗强化值**并打标记（与我方 CardPlay 完全同口径）。
        //   🔴 此前只实现了我方一侧 ⇒ 敌方手上的 16/27/28/32/35 这些牌永远打不出强化效果（本次补齐）。
        const played = getCardInfo(id);
        const enhVal = maxEnhanceOf(id);
        const useEnh = enhVal > 0 && canAffordPP(this.node, 'enemy', enhVal);
        const pay = useEnh ? enhVal : Math.max(0, played ? played.cost : 0);
        if (pay > 0) spendPP(this.node, 'enemy', pay, 'EnemyCardPlay');
        if (useEnh) {
            markEnhancedThisPlay('enemy', id);
            if (played) console.log(`[EnemyCardPlay] ${played.cardName} 以【爆能强化_${enhVal}】打出（消耗 ${enhVal} 点）`);
        }

        // 🔴🔴 与我方 CardPlay 同一口径：「确定使用」这一刻 = 去向与能力都已定死 ⇒ **逻辑当场结算**：
        //       · 法术：卡本身此刻就进墓场（不等它在屏幕上消失）；
        //       · 法术的 use 能力（当前只有 DrawCards）：当场抽牌 —— 敌方牌堆立即 -N、
        //         敌方手牌逻辑立即 +N（抽卡动画由 EnemyCardDraw 延后到本次演出收尾再播）。
        if (isSpell) this.resolveSpellUseNow(id);

        // ③ 第一步：边旋转（Y 0°→360°）边移动到摄像头正中 + 放大到展示大小
        const p0 = card.position.clone();
        const center = this.centerLocal(layer).clone();
        const s1 = Math.max(0.01, baseScale * Math.max(0.01, this.centerScale));
        const dur = Math.max(0, this.moveDuration);

        // 换脸：Y≥90°（零宽）那一瞬销毁卡背、显示真实战场卡牌（后续动画由它继续）
        let swapped = false;
        const swap = () => {
            if (swapped) return;
            swapped = true;
            if (card.isValid) killNode(card);
            if (fieldCard.isValid) {
                fieldCard.active = true;
                toFront(fieldCard);
            }
        };
        /**
         * 把「当前驱动姿态」（位置/缩放/自转角）写给当下应显示的卡牌。
         * 🔴 换脸发生的**同一帧**必须立刻把姿态写给真卡：
         *    真卡在 composeCard → setParent(layer, true) 后带着初始位置（敌方战场中心），
         *    若换脸帧没有写姿态，它会以那个位置闪现一整帧、下一帧才被摆正（实测踩过）。
         */
        const applyPose = (t: number) => {
            const f = swapped ? fieldCard : card;
            if (!f || !f.isValid) return;
            f.setPosition(p0.x + (center.x - p0.x) * t,
                p0.y + (center.y - p0.y) * t, p0.z);
            const s = baseScale + (s1 - baseScale) * t;
            f.setScale(s, s, 1);
            f.setRotationFromEuler(0, 360 * t, 0);   // 连续自转一圈，落位恰好回 0°
        };

        if (dur <= 0) {
            swap();                  // 先换脸
            applyPose(1);            // 再把终点姿态（正中/展示大小/转正）写给真卡
            this.hold();
            return true;
        }

        const drive = { t: 0 };
        let aborted = false;
        const abort = (e: unknown) => {
            if (aborted) return;
            aborted = true;
            console.error('[EnemyCardPlay] 展示段补间出错，本次打出已中止：', e);
            Tween.stopAllByTarget(drive);
            swap();
            this.hold();
        };

        tween(drive)
            .to(dur, { t: 1 }, {
                easing: 'quadOut',
                onUpdate: (tgt?: object) => {
                    try {
                        const t = (tgt as { t: number } | undefined)?.t ?? 0;
                        // 🔴 先换脸、同一帧立刻把驱动姿态写给真卡（见 applyPose 注释）——
                        //    顺序反了真卡就会带着战场中心的初始位置闪现一帧。
                        if (t >= 0.25) swap();
                        applyPose(t);
                    } catch (e) {
                        abort(e);
                    }
                },
            })
            .call(() => {
                if (aborted) return;
                swap();              // 兜底：确保换脸一定发生过
                applyPose(1);        // 终点姿态兜底（转正、正中、展示大小）
                this.hold();
            })
            .start();
        return true;
    }

    /** 第一步收尾：真实卡牌在摄像头正中展示 holdDuration 秒，然后开始第二步 */
    private hold(): void {
        this.clearHoldTimer();
        this._holdTimer = setTimeout(() => {
            this._holdTimer = null;
            if (this._busy) this.launch();
        }, Math.max(0, this.holdDuration) * 1000);
    }

    /**
     * 第二步：参照我方 CardPlay 的飞行脚本 —— 同款二次贝塞尔 + sineInOut，
     * 飞向敌方战场**最左一格**；并行「战场右移让位 + 敌方手牌收紧」，三者共用 travelDuration。
     */
    private launch(): void {
        // 防御调度器重复触发：一次使用只能进入一个结算分支。
        if (!this._busy) return;
        const layer = this._playLayer;
        const ehl = this.resolveEnemyHand();
        const bf = this.resolveField();
        const fieldCard = this._fieldCard;
        const id = this._id;

        if (!ehl || !fieldCard || !fieldCard.isValid) {
            console.log('[EnemyCardPlay] 飞行起手条件不满足，已中止。');
            this.finish();
            return;
        }

        // 法术：展示完成后不飞入战场，直接从摄像头正中消失；敌方手牌同时收紧。
        if (this._isSpell) {
            this.launchSpell(ehl, fieldCard);
            return;
        }

        if (!layer || !layer.isValid || !bf) {
            console.log('[EnemyCardPlay] 飞行起手条件不满足，已中止。');
            this.finish();
            return;
        }

        // 战场「最左一格」的目标位：把新卡宽度算进去预演（现有卡整体右移让位）
        const extraW = nodeWidth(fieldCard) * bf.cardScale;
        const targets = bf.computeTargetsPrepend(extraW);
        const targetFieldLocal = targets.length > 0 ? targets[0] : new Vec3(0, 0, 0);

        // 战场本地坐标 → 专图层本地坐标（世界坐标做桥，与我方同套路）
        const p0 = fieldCard.position.clone();
        const p2 = this.fieldLocalToLayerLocal(layer, bf, targetFieldLocal);
        const p1 = bezierControl(p0, p2, this.arcHeight, new Vec3());

        const dur = Math.max(0.0001, this.travelDuration);
        const cur = new Vec3();
        const s0 = fieldCard.scale.x;             // 展示大小
        const s1 = Math.max(0.01, bf.cardScale);  // 战场落定大小（= layout() 会写的值，收尾不跳位）

        // 并行：敌方战场现有卡 → 右移让位；敌方手牌其余卡背 → 收紧
        this.tweenFieldRest(bf, dur, extraW);
        ehl.tweenRest(dur);

        let aborted = false;
        const abort = (e: unknown) => {
            if (aborted) return;
            aborted = true;
            console.error('[EnemyCardPlay] 飞行补间出错，本次打出已中止：', e);
            Tween.stopAllByTarget(drive);
            this.land(bf);
        };

        const drive = { t: 0 };
        tween(drive)
            .to(dur, { t: 1 }, {
                easing: 'sineInOut',
                onUpdate: (tgt?: object) => {
                    try {
                        const t = (tgt as { t: number } | undefined)?.t ?? 0;
                        if (!fieldCard.isValid) return;
                        bezierAt(p0, p1, p2, t, cur);
                        fieldCard.setPosition(cur);
                        const s = s0 + (s1 - s0) * t;    // 展示大小 → 战场大小，落地与 layout 一致
                        fieldCard.setScale(s, s, 1);
                    } catch (e) {
                        abort(e);
                    }
                },
            })
            .call(() => {
                if (aborted) return;
                this.land(bf);
            })
            .start();
    }

    /** 法术第二步：不进入战场，只在 travelDuration 收尾时销毁展示卡并触发使用能力。 */
    private launchSpell(ehl: EnemyHandLayout, fieldCard: Node): void {
        const id = this._id;
        const dur = Math.max(0, this.travelDuration);
        ehl.tweenRest(dur);
        this.spawnSpellFx(fieldCard);   // 🔴 卡牌消失那一刻炸法术圈（与能力时机无关）
        if (fieldCard.isValid) killNode(fieldCard);
        this._fieldCard = null;
        // 使用法术 → 卡本身进墓场（逻辑这一刻记账，不等任何动画/能力结算）
        this.finish();
    }

    /**
     * 法术「确定使用」那一刻的**逻辑结算**（在 play() 里调用，早于一切演出）：
     *   ① 卡本身进墓场；② use 触发的能力（DrawCards / 需要选目标的效果）当场结算。
     * 🔴 只做逻辑：法术圈、手牌收紧、抽卡动画仍按各自的动画时序播。
     * 🔴 **需要选目标的法术**（`use` 触发的能力带 params.select）：敌方 AI 用与入场曲
     *    **完全同一套**自动选目标口径（`TargetSelectSystem.autoPick`）当场选好再结算。
     */
    private resolveSpellUseNow(id: string): void {
        addToGrave(this.node, 'enemy', id);
        let target: Node | null = null;
        const req = cardTargetRequest(id, ['use'], 'enemy');
        if (req) {
            const sys = this.selectSystem();
            target = sys ? sys.autoPick('enemy', req.select, req.filter) : null;
            if (!target && this.verbose) {
                console.log(`[EnemyCardPlay] ${id} 需要选目标但没有合法候选（${req.select}`
                    + `${req.filter ? ' / ' + req.filter : ''}）→ 能力侧跳过`);
            }
        }
        try {
            runCardUseAbilities(this, id, 'enemy', null, target);
        } catch (e) {
            console.error(`[EnemyCardPlay] 法术使用能力结算失败（id=${id}）：`, e);
        }
    }

    /**
     * 法术展示卡「消失那一刻」的法术特效（敌方版本）。
     * 🔴 只与**卡牌消失**同步，与能力结算时机无关；先捕获父节点 / 坐标 / 尺寸再销毁卡牌。
     */
    private spawnSpellFx(card: Node): void {
        if (!this.spellCastFxOnUse) return;
        if (!card || !card.isValid) return;
        const parent = card.parent;
        if (!parent || !parent.isValid) return;
        const pos = card.position.clone();
        const ut = card.getComponent(UITransform);
        const sx = Math.abs(card.scale.x) || 1;
        const sy = Math.abs(card.scale.y) || 1;
        const w = ut ? ut.contentSize.width * sx : 0;
        const h = ut ? ut.contentSize.height * sy : 0;
        playSpellCastOrb(parent, pos, Math.max(w, h, 120));
    }

    /** 第二步收尾：收编为敌方战场**最左一张**（try/finally 保证 _busy 一定能复位） */
    private land(bf: BattleFieldLayout): void {
        const fieldCard = this._fieldCard;
        const id = this._id;
        try {
            if (fieldCard && fieldCard.isValid) {
                fieldCard.setRotationFromEuler(0, 0, 0);
                if (!bf.adoptCardLeft(fieldCard, id)) {
                    console.log(`[EnemyCardPlay] 收编失败：战场已满或卡牌不合法（id=${id}）。`);
                    killNode(fieldCard);
                } else {
                    runCardPassiveAbilities(this, id, 'enemy', fieldCard);
                    this.notifyCardEntered(fieldCard, this._handCard);
                    // 🔴 入场曲：与我方 CardPlay **同一套能力管线**（`runCardFanfareAbilities`），
                    //    唯一区别是目标来源 —— 我方等玩家点选，敌方由 AI 自动选（见 fanfareTargetFor）。
                    //    场上没有合法候选 → target = null（能力侧会跳过 / 告警），卡牌照常入场。
                    this.runFanfareOnEntry(fieldCard, id);
                }
            }
        } catch (e) {
            console.error(`[EnemyCardPlay] 收编进战场时出错（id=${id}）：`, e);
            if (fieldCard && fieldCard.isValid && fieldCard.parent !== bf.node) killNode(fieldCard);
        } finally {
            this.finish();
            runCardUseAbilities(this, id, 'enemy', fieldCard);
        }
    }

    // ------------------------------ 入场曲（敌方 AI 版） ------------------------------
    /**
     * 随从落到敌方战场后结算**入场曲**。
     *
     * 与我方 `CardPlay` 的唯一区别是「目标从哪来」：
     *   · 我方：卡牌先停在**摄像头左上角**等玩家点选（`beginFanfareSelect`）；
     *   · 敌方：不打断演出，直接 `TargetSelectSystem.autoPick('enemy', req.select)` 自动选一只
     *     （候选口径与选择模式完全一致：对方战场上的随从）。
     * 没有需要选目标的能力 → 直接跑（target = null）；有需要但没有候选 → 同样 target = null，
     * 由能力侧跳过（与我方「场上没随从就直接入场」同一结论）。
     */
    private runFanfareOnEntry(fieldCard: Node, id: string): void {
        if (!this.autoFanfare) return;
        const target = this.fanfareTargetFor(id);
        if (this.verbose) {
            console.log(`[EnemyCardPlay] 入场曲结算：${id}，目标=${target ? target.name : '（无）'}`);
        }
        try {
            runCardFanfareAbilities(this, id, 'enemy', fieldCard, target);
        } catch (e) {
            console.error(`[EnemyCardPlay] 入场曲结算失败（id=${id}）：`, e);
        }
    }

    /** 入场曲需要的目标 —— 敌方 AI 按统一策略自动选（没有需要 / 没有候选都返回 null） */
    private fanfareTargetFor(id: string): Node | null {
        const req = cardTargetRequest(id, ['fanfare'], 'enemy');
        if (!req) return null;
        const sys = this.selectSystem();
        if (!sys) {
            console.warn('[EnemyCardPlay] 找不到 TargetSelectSystem，入场曲无法自动选目标');
            return null;
        }
        return sys.autoPick('enemy', req.select, req.filter);
    }

    /** 选择模式组件（挂在 Canvas 上；懒查找 + 缓存） */
    private selectSystem(): TargetSelectSystem | null {
        if (this._selectCache && this._selectCache.isValid) return this._selectCache;
        const scene = this.node.scene as unknown as Node | null;
        if (!scene) return null;
        const stack: Node[] = [...scene.children];
        while (stack.length > 0) {
            const cur = stack.shift() as Node;
            const c = cur.getComponent(TargetSelectSystem);
            if (c) { this._selectCache = c; return c; }
            for (const ch of cur.children) stack.push(ch);
        }
        return null;
    }

    private finish(): void {
        this._busy = false;
        this.clearHoldTimer();
        this._fieldCard = null;
        this._handCard = null;
        this._id = '';
        this._isSpell = false;
    }

    private clearHoldTimer(): void {
        if (this._holdTimer !== null) {
            clearTimeout(this._holdTimer);
            this._holdTimer = null;
        }
    }

    private notifyCardEntered(card: Node, fromHand: Node | null = null): void {
        const scene = this.node.scene as unknown as Node | null;
        if (!scene) return;
        const stack: Node[] = [...scene.children];
        while (stack.length > 0) {
            const cur = stack.shift() as Node;
            const kw = cur.getComponent('CardKeywordSystem') as any;
            if (kw) {
                // 「奥义 / 解放奥义」：把手牌期间的奥义槽快照搬到战场卡（与我方同一条管线）
                if (fromHand && typeof kw.carryHandState === 'function') kw.carryHandState(fromHand, card);
                if (typeof kw.onCardEnteredBattlefield === 'function') kw.onCardEnteredBattlefield(card);
                return;
            }
            for (const ch of cur.children) stack.push(ch);
        }
    }

    // ------------------------------ 并行重排 ------------------------------
    /** 敌方战场现有卡牌：从当前位置 tween 到「最左多一张、整体右移」后的新排布 */
    private tweenFieldRest(bf: BattleFieldLayout, dur: number, extraW: number): void {
        const targets = bf.computeTargetsPrepend(extraW);
        const cards = bf.cards;
        // targets[0] 是新卡的位子，现有卡从 targets[1] 开始依次右移
        for (let i = 0; i < cards.length && i + 1 < targets.length; i++) {
            const node = cards[i];
            if (!node || !node.isValid) continue;
            const t = targets[i + 1];
            if (dur <= 0) node.setPosition(t);
            else tween(node).to(dur, { position: t.clone() }, { easing: 'sineInOut' }).start();
        }
    }

    // ------------------------------ 参数双向绑定（我方 CardPlay）------------------------------
    /**
     * 五个打出手感参数与我方 CardPlay 双向绑定：任一侧 Inspector 改动，另一侧下一帧跟随。
     * 开局（首帧）先以我方为基准对齐一次；快照比对防 ping-pong（ adopt 后立刻刷新基线，
     * 对面下帧看不到「变化」→ 与 BattleFieldLayout.syncParams 同一套路）。
     * 每帧开销 = 5 次数值比较，无分配。
     */
    private syncParams(): void {
        if (!this.syncWithPlayer) return;
        const twin = this.resolveTwin();
        if (!twin || (twin as unknown as Component) === this) return;
        const tm = twin.moveDuration, tc = twin.centerScale, th = twin.holdDuration,
            ta = twin.arcHeight, tt = twin.travelDuration;

        if (!this._snapInit) {
            // 开局以我方为基准对齐（我方是基准，与 BattleFieldLayout.alignWithPlayerSide 同思路）
            this.moveDuration = tm; this.centerScale = tc; this.holdDuration = th;
            this.arcHeight = ta; this.travelDuration = tt;
            this.snapshot(tm, tc, th, ta, tt);
            return;
        }
        if (tm !== this._snapM || tc !== this._snapC || th !== this._snapH
            || ta !== this._snapA || tt !== this._snapT) {
            // 对面改了 → 采纳（并刷新基线，防回推）
            this.moveDuration = tm; this.centerScale = tc; this.holdDuration = th;
            this.arcHeight = ta; this.travelDuration = tt;
            this.snapshot(tm, tc, th, ta, tt);
            return;
        }
        if (this.moveDuration !== this._snapM || this.centerScale !== this._snapC
            || this.holdDuration !== this._snapH || this.arcHeight !== this._snapA
            || this.travelDuration !== this._snapT) {
            // 自己改了 → 推给对面（同时刷新基线）
            twin.moveDuration = this.moveDuration;
            twin.centerScale = this.centerScale;
            twin.holdDuration = this.holdDuration;
            twin.arcHeight = this.arcHeight;
            twin.travelDuration = this.travelDuration;
            this.snapshot(tm, tc, th, ta, tt);
        }
    }

    private snapshot(m: number, c: number, h: number, a: number, t: number): void {
        this._snapM = m; this._snapC = c; this._snapH = h; this._snapA = a; this._snapT = t;
        this._snapInit = true;
    }

    private resolveTwin(): CardPlay | null {
        if (this.playerPlay && this.playerPlay.isValid) return this.playerPlay;
        const scene = this.node.scene as unknown as Node | null;
        if (!scene) return null;
        const stack: Node[] = [...scene.children];
        while (stack.length > 0) {
            const cur = stack.shift() as Node;
            const c = cur.getComponent(CardPlay);
            if (c) { this.playerPlay = c; return c; }
            for (const ch of cur.children) stack.push(ch);
        }
        return null;
    }

    // ------------------------------ 专图层 & 坐标（与 CardPlay 同套路）------------------------------
    /** 取/建敌方打出专图层（Canvas 下动态节点，恒置顶；LayerOrder._alwaysTopNames 已收录该名字） */
    private playLayerNode(): Node | null {
        if (this._playLayer && this._playLayer.isValid) {
            toFront(this._playLayer);
            return this._playLayer;
        }
        const canvas = this.canvasNode();
        if (!canvas) return null;
        const n = new Node('EnemyCardPlayLayer');
        n.setParent(canvas);
        const ut = n.addComponent(UITransform);
        ut.setAnchorPoint(0.5, 0.5);
        ut.setContentSize(1280, 720);
        n.setPosition(0, 0, 0);
        this._playLayer = n;
        toFront(n);
        return n;
    }

    /** 摄像头正中（UI 相机注视点世界坐标）在专图层本地坐标下的位置（与我方展示位置同一换算） */
    private centerLocal(layer: Node): Vec3 {
        const cam = this.uiCamera();
        const ut = layer.getComponent(UITransform);
        if (cam) {
            const wp = cam.node.worldPosition;
            return ut ? ut.convertToNodeSpaceAR(new Vec3(wp.x, wp.y, 0), _centerOut)
                : _centerOut.set(wp.x, wp.y, 0);
        }
        return _centerOut.set(0, 0, 0);
    }

    /** 战场本地坐标 → 专图层本地坐标 */
    private fieldLocalToLayerLocal(layer: Node, bf: BattleFieldLayout, fieldLocal: Vec3): Vec3 {
        const but = bf.node.getComponent(UITransform);
        const lut = layer.getComponent(UITransform);
        if (!but || !lut) return fieldLocal.clone();
        but.convertToWorldSpaceAR(fieldLocal, _worldScratch);
        return lut.convertToNodeSpaceAR(_worldScratch, new Vec3());
    }

    private canvasNode(): Node | null {
        let n: Node | null = this.node;
        while (n) {
            if (n.getComponent(Canvas)) return n;
            n = n.parent;
        }
        return null;
    }

    private uiCamera(): Camera | null {
        if (this._cam && this._cam.isValid) return this._cam;
        let n: Node | null = this.node;
        while (n) {
            const cv = n.getComponent(Canvas) as unknown as
                { camera?: Camera | null; cameraComponent?: Camera | null } | null;
            if (cv) {
                this._cam = cv.cameraComponent || cv.camera || null;
                if (this._cam) return this._cam;
            }
            n = n.parent;
        }
        return null;
    }

    // ------------------------------ 依赖解析 ------------------------------
    private resolveEnemyHand(): EnemyHandLayout | null {
        if (this.enemyHand && this.enemyHand.isValid) return this.enemyHand;
        return this.getComponent(EnemyHandLayout);
    }

    /** 敌方战场：优先 Inspector 指定，其次场景 BFS **只认 side = Enemy**（与我方 resolveField 镜像） */
    private resolveField(): BattleFieldLayout | null {
        if (this.battlefield && this.battlefield.isValid) return this.battlefield;
        const scene = this.node.scene as unknown as Node | null;
        if (!scene) return null;
        let fallback: BattleFieldLayout | null = null;
        const stack: Node[] = [...scene.children];
        while (stack.length > 0) {
            const cur = stack.shift() as Node;
            const c = cur.getComponent(BattleFieldLayout);
            if (c && c.isValid) {
                if (c.side === BattleSide.Enemy) { this.battlefield = c; return c; }
                if (!fallback) fallback = c;
            }
            for (const ch of cur.children) stack.push(ch);
        }
        this.battlefield = fallback;
        return fallback;
    }
}

// ------------------------------ 模块内部 scratch（同步使用，安全）------------------------------
const _worldScratch = new Vec3();
const _centerOut = new Vec3();
