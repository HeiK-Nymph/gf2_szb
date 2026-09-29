import {
    _decorator, Camera, Canvas, Component, Node, Sprite, SpriteFrame, tween, UITransform, Vec3,
} from 'cc';
import { CardDraw } from './CardDraw';
import { killNode } from './CardComposer';
import { CardDestroyFx } from './CardDestroyFx';
import { findDeckManager } from './CardDeckManager';
import { toFront } from './CardPlay';
import { EnemyHandLayout } from './EnemyHandLayout';
import { CardBackBorder, CARD_BACK_CHILD_NAME } from './CardBackBorder';
import { toCardId } from './HandLayout';

const { ccclass, property, requireComponent, menu } = _decorator;

/** 敌方抽卡专图层名（与 EnemyCardPlay 共用；LayerOrder._alwaysTopNames 已收录该名字） */
const LAYER_NAME = 'EnemyCardPlayLayer';

/**
 * EnemyCardDraw —— 敌方抽卡动画（一张卡背右上角入画 → 分裂 → 各自飞入敌方手牌最左 N 格）
 * ===========================================================================
 * 挂在**敌方手牌区节点**（Canvas/EnemyHandArea）上，参照我方 CardDraw 的卡背起点，
 * 用**镜像**造出敌方抽卡的起点，分两段 tween（共用总时长 `drawDuration`，Inspector 暴露）：
 *
 * 第一步：镜像起点
 *   读取我方 CardDraw 的卡背起点姿态（backStartPos / backStartEuler / backScale，
 *   PlayerHandArea 本地系），换算到 **Canvas 本地系**后沿「摄像头上下中央的水平线」
 *   （= Canvas 局部 y=0）做完全镜像：位置 y 取反、倾斜角 z 取反 —— 即
 *   我方「右下角画面外倾斜入场」的镜像 = 敌方「右上角画面外反向倾斜入场」。
 *
 * 第二步：沿自身长边延长线直移入画（前 40% 总时长，**永远只此一张卡背**）
 *   卡背沿**自身长边（本地 Y 轴）的延长线**直直移动，直到整张卡（含旋转后的包围盒）
 *   完全进入摄像头可视区 —— 表现为从摄像头右上角进入了一个卡背。
 *
 * 第三步：分裂 → 各自转正飞入敌方手牌最左 N 格（后 60% 总时长）
 *   到达入画点瞬间，原地**分裂成 N 张**同款同姿态卡背（原卡背即其中一张），
 *   随后各自转正（倾角→0、缩放→敌方手牌 cardScale）飞入自己的槽位：
 *   新牌块占最左 N 格（ids[0] 在最左、左→右与传入顺序一致），与此同时敌方手牌
 *   现有卡背整体**右移 N 格让位**（与新卡飞行同一时长）。落位后由
 *   `EnemyHandLayout.adoptCardLeft(node, id)` 按**从右到左**的顺序依次收编
 *   （unshift 语义 → 收编完恰好保持 ids 左→右顺序）。
 *   N=1（drawCard / drawMany 单张）时无分裂观感，行为与旧版单张完全一致。
 *
 * 第四步（手牌装不下时）：**动画照走，飞到半路被破坏**
 *   敌方手牌已满（或一次抽多张、空位不够）时，装不下的那几张**不再取消 / 静默丢弃**：
 *   它们与正常抽卡走**完全一样的入画 / 分裂 / 飞向手牌**动画，但不会真的落进手牌 ——
 *   在「飞向手牌那一段」的 `overflowDestroyProgress`（Inspector 暴露，0~1）进度处
 *   播 `CardDestroyFx`（洗白 → 迸发 → 消失，与战场破坏 / 我方抽牌超上限同一套特效）后销毁。
 *   能装下的部分照常收编；此时现有手牌只按**真正收编的张数**右移让位。
 *
 * 队列：drawMany 支持连发多组（前一组收编进手牌后自动开始下一组）。
 *
 * 🔴 踩坑提醒：① 卡背尺寸一律用 `sf.rect`（sf.width/height 动态图集打包后 = 2048）；
 * ② 现有手牌让位 tween 直接用**手牌区本地**坐标（这些节点父节点就是手牌区，
 *    做 area→layer 换算会整体偏移一个区偏移量）。
 * ===========================================================================
 */
@ccclass('EnemyCardDraw')
@requireComponent(UITransform)
@menu('gf2szb/EnemyCardDraw')
export class EnemyCardDraw extends Component {

    @property({
        range: [0, 3, 0.01], slide: true,
        tooltip: '敌方抽卡动画 tween **总时间**（秒）：「直移入画」+「分裂旋转入列」两段共用。\n'
            + '默认 0.6；0 = 瞬间到位（无动画）。',
    })
    drawDuration = 0.6;

    @property({
        range: [0, 1, 0.01], slide: true,
        tooltip: '【手牌已满时的破坏时机】装不进敌方手牌、抽出来就要被破坏的那张卡：\n'
            + '它照常播放「右上角入画 →（分裂）→ 飞向敌方手牌」的同一套动画，但**不会真的落进手牌**，\n'
            + '而是在「飞向手牌那一段」的这个进度处被破坏（破坏动画 + 特效与正常卡牌被破坏完全同一套）。\n'
            + '0 = 刚分裂还没飞就被破坏；0.5 = 飞到一半被破坏（默认）；1 = 飞到本该落位的手牌格才破坏。\n'
            + '⚠️ 手牌未满、没有装不下的卡时本项不起作用。',
    })
    overflowDestroyProgress = 0.5;

    @property({ type: EnemyHandLayout, tooltip: '（可选）敌方手牌布局组件；留空自动在本节点上查找。' })
    enemyHand: EnemyHandLayout | null = null;

    // ------------------------------ 内部状态 ------------------------------
    private _busy = false;
    /** 待播的抽卡批次（**逻辑已入账**，只等舞台空闲；见 drawMany 的两段式） */
    private _pending: EnemyDrawBatch[] = [];
    private _seq = 0;
    private _layer: Node | null = null;
    private _cam: Camera | null = null;
    /** **在途额度**：已定判「能进敌方手牌」、但还没收编的张数之和（逻辑手牌数的增量） */
    private _pendingAdopt = 0;
    /** 正在播的那一批（收尾时交还在途额度） */
    private _active: EnemyDrawBatch | null = null;
    /** EnemyCardPlay 组件缓存（判断敌方「打出 / 法术演出」是否占着舞台） */
    private _epCache: any = null;

    // ------------------------------ 对外 API ------------------------------
    /** 是否正在播放抽卡动画（含队列未清空） */
    public get isDrawing(): boolean {
        return this._busy || this._pending.length > 0;
    }

    /**
     * **逻辑敌方手牌数**：已收编的张数 + 本批「确实抽到、确实塞得进手牌、还在飞」的张数。
     * 供 BattleStatusBar 使用 —— 抽卡动画播多久都不影响这个数（需求：计数器不等动画）。
     */
    public get logicalHandCount(): number {
        const ehl = this.resolveEnemyHand();
        return (ehl ? ehl.cardCount : 0) + Math.max(0, this._pendingAdopt);
    }

    /**
     * 抽一张：等价于 drawMany([id])。
     * @param id 卡牌 id（CardMap 的 key，带不带扩展名皆可）
     * @returns 是否成功入队（false = 缺组件 / 手牌已满）
     */
    public drawCard(id: string): boolean {
        return this.drawMany([id]);
    }

    /**
     * 抽一组（可一张或多张）。多张时**只有一张卡背**长边直移入画，
     * 到入画点分裂成 N 张，各自转正飞入敌方手牌最左 N 格（ids[0] 在最左）。
     * 动画进行中调用会入队，当前组收编后自动开始。
     * @param ids 卡牌 id 数组（可含重复 id）
     */
    public drawMany(ids: string[]): boolean {
        const list: string[] = [];
        for (const raw of ids || []) {
            const id = toCardId(raw);
            if (id) list.push(id);
        }
        if (list.length === 0) return false;
        const ehl = this.resolveEnemyHand();
        if (!ehl) return false;

        // ① **逻辑入账（定判）**：调用当场完成 —— 能进手牌的张数计入在途额度、
        //    装不下注定被破坏的当场记墓场 ⇒ 状态栏立刻就是最终数字，与动画无关。
        const batch = this.decideBatch(list, ehl);
        this._pending.push(batch);

        // ② 演出：本组件忙、或敌方打出/法术演出占着舞台 → 只排队（逻辑已经入账，不会被拖延）
        if (!this._busy && !this.stageBusy()) this.nextBatch();
        return true;
    }

    /**
     * 【抽卡决定那一刻的定判】手牌上限固定（`ehl.maxCards`）⇒ 此刻的**逻辑占用**就是判据，
     * **与后面的入画/飞行/破坏动画完全无关**。
     *
     * 🔴 容量基准 = 敌方手牌集合张数 + **已在途（抽到但还没收编）的张数**（与我方同一口径）：
     *    只用 `ehl.cardCount` 会在连续抽卡时把同一批空位重复分配 → 逻辑手牌数超上限。
     * @returns 本批的定判结果（`adoptN` = 能进手牌的张数）
     */
    private decideBatch(list: string[], ehl: EnemyHandLayout): EnemyDrawBatch {
        const limit = Math.max(1, Math.floor(ehl.maxCards));
        const occupied = (ehl ? ehl.cardCount : 0) + Math.max(0, this._pendingAdopt);
        const capacity = Math.max(0, limit - occupied);
        const adoptN = Math.min(list.length, capacity);
        this._pendingAdopt += adoptN;
        if (adoptN < list.length) {
            const dm = findDeckManager(this.node);
            if (dm) for (let k = adoptN; k < list.length; k++) dm.addToGrave('enemy', list[k]);
        }
        return { ids: list, adoptN };
    }

    /** 交还一批的在途额度（该批已收编完 / 已作废） */
    private releaseBatch(batch: EnemyDrawBatch | null): void {
        if (!batch) return;
        this._pendingAdopt = Math.max(0, this._pendingAdopt - batch.adoptN);
        if (this._active === batch) this._active = null;
    }

    /** 逐帧兜底：舞台空了就把排队中的下一批放出来（逻辑早已入账，只差演出） */
    update(): void {
        if (this._busy || this._pending.length === 0) return;
        if (this.stageBusy()) return;
        this.nextBatch();
    }

    onDisable(): void {
        // 🔴 组件被关掉后动画不会再收尾 → 在途额度必须全部交还（否则逻辑手牌数永久虚高）
        for (const b of this._pending) this.releaseBatch(b);
        this._pending.length = 0;
        this.releaseBatch(this._active);
        this._busy = false;
    }

    /** 敌方「打出 / 法术演出」是否正占着舞台（抽卡动画要等它演完；**逻辑入账不受影响**） */
    private stageBusy(): boolean {
        const ep = this.resolveEnemyPlay();
        return !!(ep && ep.isPlaying);
    }

    private resolveEnemyPlay(): any {
        if (this._epCache && this._epCache.isValid) return this._epCache;
        const scene = this.node.scene as unknown as Node | null;
        if (!scene) return null;
        const stack: Node[] = [...scene.children];
        while (stack.length > 0) {
            const cur = stack.shift() as Node;
            const c = cur.getComponent('EnemyCardPlay');
            if (c && c.isValid) { this._epCache = c; return c; }
            for (const ch of cur.children) stack.push(ch);
        }
        this._epCache = null;
        return null;
    }

    // ------------------------------ 主流程 ------------------------------
    private nextBatch(): void {
        if (this._busy || this.stageBusy()) return;
        const batch = this._pending.shift();
        if (!batch) return;
        if (!this.doBatch(batch)) this.nextBatch();   // 失败也继续消化队列（防卡死）
    }

    private doBatch(batch: EnemyDrawBatch): boolean {
        const ehl = this.resolveEnemyHand();
        const ids = batch.ids;
        const adoptN = batch.adoptN;
        if (!ehl || ids.length === 0) { this.releaseBatch(batch); return false; }

        // 容量分配（前 adoptN 张进手牌 / 装不下的 burnN 张照常飞、半路被破坏）与墓场记账
        // 都已在**抽卡决定那一刻**完成（decideBatch）；这里只负责播这批的演出。
        const limit = Math.max(1, Math.floor(ehl.maxCards));
        const burnN = ids.length - adoptN;
        if (burnN > 0) {
            console.warn(`[EnemyCardDraw] 敌方手牌已满（maxCards=${limit}，当前 ${ehl.cardCount} 张）：`
                + `装不下的 ${burnN} 张照常飞向敌方手牌，并在行程 ${Math.round(this.overflowBurnProgress() * 100)}% 处被破坏。`);
        }

        const sf = ehl.cardBackSpriteFrame;
        if (!sf) {
            console.warn('[EnemyCardDraw] 缺少 cardBackSpriteFrame，无法生成卡背。');
            this.releaseBatch(batch);
            return false;
        }
        const layer = this.playLayerNode();
        if (!layer) { this.releaseBatch(batch); return false; }

        this._busy = true;
        this._active = batch;
        const N = ids.length;

        // —— 第一步：我方卡背起点 → 沿摄像头水平中央线完全镜像 ——
        const start = this.mirroredStart();
        const back = this.makeBackNode('EnemyDrawBack_' + (this._seq++), sf);
        back.setParent(layer, false);
        back.setPosition(start.pos);
        back.setRotationFromEuler(0, 0, start.rotZ);
        back.setScale(start.scale, start.scale, 1);

        // —— 第二步：沿自身长边延长线直移，直到完全进入摄像头 ——
        const dir = this.longEdgeDir(start.rotZ, start.pos);
        const D = this.travelToFullyVisible(start.pos, dir, start.scale,
            Math.abs(start.rotZ), sf.rect.width, sf.rect.height);
        const inPos = new Vec3(start.pos.x + dir.x * D, start.pos.y + dir.y * D, 0);

        // —— 第三步目标 ——
        // · 真正入手的 adoptN 张：占最左 adoptN 格（ids[j] → 槽位 j，左→右），现有牌右移 adoptN 格；
        // · 装不下的 burnN 张：拿「假设手牌还有空位」时的槽位（最左 N 格里的后 burnN 格）当**飞行目标**，
        //   飞到半路就被破坏 → 不会真的落进手牌（观感 = 照常飞向敌方手牌、中途被破坏）。
        const step = ehl.spacing * ehl.cardScale;
        const slotAdopt: Vec3[] = [];
        const halfAdopt = (ehl.cardCount + adoptN - 1) / 2;
        for (let j = 0; j < adoptN; j++) {
            slotAdopt.push(this.areaLocalToLayerLocal(layer, ehl,
                new Vec3((j - halfAdopt) * step, ehl.yOffset, 0)));
        }
        const halfAll = (ehl.cardCount + N - 1) / 2;
        const slotBurn: Vec3[] = [];
        for (let k = 0; k < burnN; k++) {
            slotBurn.push(this.areaLocalToLayerLocal(layer, ehl,
                new Vec3((adoptN + k - halfAll) * step, ehl.yOffset, 0)));
        }

        const total = Math.max(0, this.drawDuration);
        const durA = total * 0.4;               // 入画段
        const durB = total - durA;              // 分裂→旋转入列段

        const flyers: Node[] = [];
        /** 分裂：在入画点原地生成 N 张同款同姿态卡背（原卡背即 j=0 那张，不再重建） */
        const split = () => {
            flyers.push(back);
            for (let j = 1; j < N; j++) {
                const f = this.makeBackNode('EnemyDrawBack_' + (this._seq++), sf);
                f.setParent(layer, false);
                f.setPosition(inPos);
                f.setRotationFromEuler(0, 0, start.rotZ);
                f.setScale(start.scale, start.scale, 1);
                flyers.push(f);
            }
        };

        /**
         * 全部落定：只收编**装得下**的前 adoptN 张（从最右的新牌开始，unshift 语义 → 保持 ids 左→右顺序）。
         * 装不下的 burnN 张已在半路被破坏，这里不再处理（仍留在专图层上的作异常兜底清掉）。
         */
        const finishAll = () => {
            try {
                for (let j = adoptN - 1; j >= 0; j--) {
                    const f = flyers[j];
                    if (!f || !f.isValid) continue;
                    f.setPosition(slotAdopt[j]);
                    f.setRotationFromEuler(0, 0, 0);
                    f.setScale(ehl.cardScale, ehl.cardScale, 1);
                    if (!ehl.adoptCardLeft(f, ids[j])) killNode(f);
                }
            } catch (e) {
                console.error('[EnemyCardDraw] 批量收编进敌方手牌时出错：', e);
            } finally {
                // 兜底：任何仍挂在专图层上的飞行卡背一律清掉（防异常路径残留）
                for (const f of flyers) {
                    if (f && f.isValid && f.parent === layer) killNode(f);
                }
                // 本批结束：交还在途额度（逻辑手牌数回到「已收编的张数」；收编失败的已在上面销毁，不进手牌）
                this.releaseBatch(this._active);
                this._busy = false;
                this.nextBatch();
            }
        };
        let remain = N;
        const finishOne = () => { remain--; if (remain <= 0) finishAll(); };

        if (total <= 0 || durA <= 0 || durB <= 0) {
            // 瞬时模式：装得下的由 finishAll 统一摆位收编；装不下的仍走「破坏特效」（停在入画点原地播）。
            split();
            for (let j = 0; j < N; j++) {
                const f = flyers[j];
                if (!f || !f.isValid) { finishOne(); continue; }
                if (j < adoptN) finishOne();
                else this.burnFlyer(f, finishOne);
            }
            return true;
        }

        // 入画段只驱动「那一张」卡背；到位瞬间分裂 + 现有手牌让位，然后 N 张并行转入列段
        tween(back)
            .to(durA, { position: inPos.clone() }, { easing: 'sineInOut' })
            .call(() => {
                split();
                if (adoptN > 0) this.tweenRestCards(ehl, durB, adoptN);
                for (let j = 0; j < N; j++) {
                    const f = flyers[j];
                    if (!f || !f.isValid) { finishOne(); continue; }
                    if (j < adoptN) {
                        // 正常入列：转正 + 缩到敌方手牌卡背尺寸，落到自己的槽位
                        tween(f)
                            .to(durB, {
                                position: slotAdopt[j].clone(),
                                scale: new Vec3(ehl.cardScale, ehl.cardScale, 1),
                                eulerAngles: new Vec3(0, 0, 0),
                            }, { easing: 'sineInOut' })
                            .call(finishOne)
                            .start();
                    } else {
                        // 装不进手牌：沿同一路径飞到 overflowDestroyProgress 成进度处 → 原地破坏
                        this.tweenBurnFlyer(f, inPos, slotBurn[j - adoptN], start, ehl, durB, finishOne);
                    }
                }
            })
            .start();
        return true;
    }

    /** 手牌已满时「飞向手牌途中的破坏进度」（0~1，越界自动夹紧；非法值回退 0.5） */
    private overflowBurnProgress(): number {
        const p = Number(this.overflowDestroyProgress);
        if (!Number.isFinite(p)) return 0.5;
        return Math.max(0, Math.min(1, p));
    }

    /**
     * 一张「装不进手牌」的卡背：沿与正常入列**同一条路径**飞到 `overflowDestroyProgress` 成进度处，
     * 然后原地播破坏特效（不再继续飞、也不进手牌）。
     * · 位置 / 缩放 / 倾角都取该进度处的插值 → 破坏前与「正常飞行到这一刻」的观感完全一致；
     * · `p = 0` = 刚分裂就被破坏；`p = 1` = 飞到本该落位的手牌格才破坏。
     */
    private tweenBurnFlyer(f: Node, from: Vec3, to: Vec3, start: { rotZ: number; scale: number },
        ehl: EnemyHandLayout, durB: number, onDone: () => void): void {
        const p = this.overflowBurnProgress();
        const px = from.x + (to.x - from.x) * p;
        const py = from.y + (to.y - from.y) * p;
        const pz = from.z + (to.z - from.z) * p;
        const sc = start.scale + (ehl.cardScale - start.scale) * p;
        const rz = start.rotZ * (1 - p);
        const seg = Math.max(0, durB) * p;
        if (seg <= 0) {                    // p = 0：还没飞就被破坏
            try {
                f.setPosition(px, py, pz);
                f.setScale(sc, sc, 1);
                f.setRotationFromEuler(0, 0, rz);
            } catch (e) { /* 节点可能已被销毁 */ }
            this.burnFlyer(f, onDone);
            return;
        }
        try {
            tween(f)
                .to(seg, {
                    position: new Vec3(px, py, pz),
                    scale: new Vec3(sc, sc, 1),
                    eulerAngles: new Vec3(0, 0, rz),
                }, { easing: 'sineInOut' })
                .call(() => this.burnFlyer(f, onDone))   // burnFlyer 自带守卫，不要在回调里提前置位
                .start();
        } catch (e) {
            console.error('[EnemyCardDraw] 手牌已满的飞行破坏动画出错：', e);
            this.burnFlyer(f, onDone);
        }
    }

    /**
     * 半路破坏一张「装不进手牌」的飞行卡背：
     * 与战场破坏 / 我方抽牌超上限复用**同一套** `CardDestroyFx`（洗白 → 迸发 → 消失，特效自己销毁节点）。
     * 特效宿主缺失时退化为直接销毁（绝不卡住演出队列）。
     * @param onDone 破坏演出结束（节点已销毁）后回调
     */
    private burnFlyer(f: Node, onDone: () => void): void {
        const finish = (): void => { try { onDone(); } catch (e) { /* 忽略 */ } };
        if (!f || !f.isValid) { finish(); return; }
        const fx = CardDestroyFx.instance;
        if (fx && fx.destroyCard) {
            try { fx.playOnCard(f, finish); return; }
            catch (e) { console.error('[EnemyCardDraw] 手牌已满 → 破坏特效启动失败，回退直接销毁：', e); }
        }
        try { killNode(f); } catch (e) { /* 忽略 */ }
        finish();
    }

    /** 敌方手牌现有卡背：tween 到「多 shift 张后」各自右移的新横排位（与新卡入列同时长） */
    private tweenRestCards(ehl: EnemyHandLayout, dur: number, shift: number): void {
        const nNew = ehl.cardCount + shift;
        const half = (nNew - 1) / 2;
        for (let i = 0; i < ehl.cards.length; i++) {
            const card = ehl.cards[i];
            if (!card || !card.isValid) continue;
            // 🔴 现有卡背的父节点是敌方手牌区本身 → 直接用**手牌区本地**坐标，
            // 不要做 area→layer 换算（换算结果写进 area 子节点会整体偏移一个区偏移量）。
            const local = new Vec3(((i + shift) - half) * ehl.spacing * ehl.cardScale, ehl.yOffset, 0);
            if (dur <= 0) card.setPosition(local);
            else tween(card).to(dur, { position: local }, { easing: 'sineInOut' }).start();
        }
    }

    // ------------------------------ 镜像起点 & 入画几何 ------------------------------
    /**
     * 我方 CardDraw 卡背起点 → Canvas 本地系 → 沿「摄像头上下中央的水平线」（y=0）完全镜像：
     * 位置 y 取反、倾斜角 z 取反（缩放不变）。我方 Inspector 改了起点/倾角，这里自动跟随。
     */
    private mirroredStart(): { pos: Vec3; rotZ: number; scale: number } {
        // 兜底默认 = 我方默认姿态的镜像（CardDraw 组件找不到时用）
        const fallback = { pos: new Vec3(784.19, 295.4, 0), rotZ: -61.414, scale: 0.7 };
        const canvas = this.canvasNode();
        const cd = this.resolvePlayerDraw();
        if (!canvas || !cd || !cd.node || !cd.node.isValid) return fallback;
        const phut = cd.node.getComponent(UITransform);
        const cut = canvas.getComponent(UITransform);
        if (!phut || !cut) return fallback;
        const world = phut.convertToWorldSpaceAR(new Vec3(cd.backStartPos.x, cd.backStartPos.y, 0), _wScratch);
        const canvasLocal = cut.convertToNodeSpaceAR(world, new Vec3());
        // 🔴 backStartPos 是相对手牌区「完整态」位置设计的本地姿态；手牌区滑到缩略锚点后
        //    convertToWorldSpaceAR 会把姿态整体带偏 → 用 HandMinimize.animationAnchorOffset
        //    （= 完整态位置 − 当前位置，Canvas 系）补偿回完整态基准，再镜像。
        //    （PlayerHandArea 是 Canvas 直接子节点，区本地位移 = Canvas 本地位移。）
        const hm = cd.node.getComponent('HandMinimize') as unknown as
            { animationAnchorOffset: Vec3 } | null;
        if (hm && hm.animationAnchorOffset) {
            canvasLocal.x += hm.animationAnchorOffset.x;
            canvasLocal.y += hm.animationAnchorOffset.y;
        }
        return {
            pos: new Vec3(canvasLocal.x, -canvasLocal.y, 0),
            rotZ: -cd.backStartEuler.z,
            scale: cd.backScale,
        };
    }

    /**
     * 卡牌「长边方向」（本地 +Y 轴经 rotZ 旋转后的朝向），并取**朝画面内**的那一侧
     * （从画面外起点指向可视区，即 x/y 绝对值变小的方向）。
     */
    private longEdgeDir(rotZ: number, start: Vec3): Vec3 {
        const th = rotZ * Math.PI / 180;
        const d = new Vec3(-Math.sin(th), Math.cos(th), 0);
        if (d.x * start.x > 0 || (Math.abs(d.x) < 1e-6 && d.y * start.y > 0)) {
            d.x = -d.x;
            d.y = -d.y;
        }
        return d;
    }

    /**
     * 沿 dir 直移多少距离后，**整张卡（旋转后包围盒）完全进入可视区**。
     * 可视区 = 专图层（Canvas 同尺寸）本地 [-640,640]×[-360,360]。
     */
    private travelToFullyVisible(start: Vec3, dir: Vec3, scale: number, absRotDeg: number,
        rectW: number, rectH: number): number {
        const w = rectW * scale;
        const h = rectH * scale;
        const th = absRotDeg * Math.PI / 180;
        const c = Math.cos(th), s = Math.sin(th);
        const hx = (w * c + h * s) / 2;          // 旋转后包围盒半宽
        const hy = (w * s + h * c) / 2;          // 旋转后包围盒半高
        let need = 0;
        if (dir.x < -1e-6) need = Math.max(need, (start.x + hx - 640) / -dir.x);
        else if (dir.x > 1e-6) need = Math.max(need, (640 - hx - start.x) / dir.x);
        if (dir.y < -1e-6) need = Math.max(need, (start.y + hy - 360) / -dir.y);
        else if (dir.y > 1e-6) need = Math.max(need, (360 - hy - start.y) / dir.y);
        if (!isFinite(need) || need < 0) need = 0;
        return Math.min(need, 2000);
    }

    // ------------------------------ 卡背节点 ------------------------------
    /** 生成抽卡用卡背（结构与 EnemyHandLayout.ensureBackNode 产品一致：根 → CardBack → BorderOutline） */
    private makeBackNode(name: string, sf: SpriteFrame): Node {
        const n = new Node(name);
        const ut = n.addComponent(UITransform);
        ut.setAnchorPoint(0.5, 0.5);
        // 🔴 用 sf.rect（帧自身像素）；sf.width/height 在动态图集打包后 = 2048
        ut.setContentSize(sf.rect.width, sf.rect.height);
        const back = new Node(CARD_BACK_CHILD_NAME);
        const but = back.addComponent(UITransform);
        but.setAnchorPoint(0.5, 0.5);
        but.setContentSize(sf.rect.width, sf.rect.height);
        const sp = back.addComponent(Sprite);
        sp.type = Sprite.Type.SIMPLE;
        sp.sizeMode = Sprite.SizeMode.CUSTOM;
        sp.trim = false;
        sp.spriteFrame = sf;
        back.setParent(n);
        n.addComponent(CardBackBorder);          // 金色描边（与敌方手牌卡背统一）
        return n;
    }

    // ------------------------------ 专图层 & 坐标 ------------------------------
    /** 取/建专图层（与 EnemyCardPlay 共用 'EnemyCardPlayLayer'，恒置顶） */
    private playLayerNode(): Node | null {
        if (this._layer && this._layer.isValid && this._layer.parent) {
            toFront(this._layer);
            return this._layer;
        }
        const canvas = this.canvasNode();
        if (!canvas) return null;
        let n = canvas.getChildByName(LAYER_NAME);
        if (!n || !n.isValid) {
            n = new Node(LAYER_NAME);
            n.setParent(canvas);
            const ut = n.addComponent(UITransform);
            ut.setAnchorPoint(0.5, 0.5);
            ut.setContentSize(1280, 720);
            n.setPosition(0, 0, 0);
        }
        this._layer = n;
        toFront(n);
        return n;
    }

    /** 敌方手牌区本地坐标 → 专图层本地坐标（世界坐标做桥） */
    private areaLocalToLayerLocal(layer: Node, ehl: EnemyHandLayout, local: Vec3): Vec3 {
        const aut = ehl.node.getComponent(UITransform);
        const lut = layer.getComponent(UITransform);
        if (!aut || !lut) return local.clone();
        const world = aut.convertToWorldSpaceAR(local, _wScratch);
        return lut.convertToNodeSpaceAR(world, new Vec3());
    }

    private canvasNode(): Node | null {
        let n: Node | null = this.node;
        while (n) {
            if (n.getComponent(Canvas)) return n;
            n = n.parent;
        }
        return null;
    }

    /** 我方 CardDraw（读卡背起点姿态用；全场景 BFS） */
    private resolvePlayerDraw(): CardDraw | null {
        const scene = this.node.scene as unknown as Node | null;
        if (!scene) return null;
        const stack: Node[] = [...scene.children];
        while (stack.length > 0) {
            const cur = stack.shift() as Node;
            const c = cur.getComponent(CardDraw);
            if (c) return c;
            for (const ch of cur.children) stack.push(ch);
        }
        return null;
    }

    private resolveEnemyHand(): EnemyHandLayout | null {
        if (this.enemyHand && this.enemyHand.isValid) return this.enemyHand;
        return this.getComponent(EnemyHandLayout);
    }
}

/**
 * 一批敌方抽卡的**定判结果**（逻辑入账在前、演出在后）：
 *   · ids     —— 本批要抽的卡牌 id（已归一化）
 *   · adoptN  —— 定判为「能进敌方手牌」的张数（计入在途额度，收编完交还）；
 *                其余 `ids.length - adoptN` 张已按定判当场记入墓场。
 */
interface EnemyDrawBatch {
    ids: string[];
    adoptN: number;
}

// ------------------------------ 模块内部 scratch（同步使用，安全）------------------------------
const _wScratch = new Vec3();
