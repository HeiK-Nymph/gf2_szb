import { _decorator, CCString, Component, Node } from 'cc';
import { toCardId } from './HandLayout';
import { getCardInfo } from './CardData';
import { peekPending } from './BattleSetup';

const { ccclass, property, menu } = _decorator;

/** 阵营（与 TurnManager.TurnSide 同字面量，避免循环依赖不直接 import） */
export type DeckSide = 'player' | 'enemy';

/**
 * CardDeckManager —— 卡组背包（对战中抽出的「有限卡牌集合」）
 * ===========================================================================
 * 需求对齐：
 *   · 敌我**各有一个**卡组背包，**互相独立、不共用**；
 *   · 每个卡组上限 **40 张**；**同一张卡最多 3 张**；
 *   · 卡组是**真实的集合**（不是概率）：开战时把集合展开成牌堆，抽一张就少一张，
 *     **抽完就不能再抽**；
 *   · 对局中抽卡只能从各自卡组里**随机**抽（TurnManager 回合开始抽 1 张、
 *     控制台的抽卡按钮都走这里）。
 *
 * 在 Cocos 编辑器里暴露两个可编辑集合（Inspector 直接增删改条目）：
 *   · playerDeck / enemyDeck：`[CCString]` 数组，**每个条目的形式为「卡牌id 数量」**，
 *     例如 `"2 2"` = 2.png 的卡牌 **2 张**（id 带不带 .png 都行，'2' → '2.png'）。
 *     条目在 onLoad/开战时被解析并做合法性校验：
 *       - 格式不对 / 卡牌 id 不在 CardMap 里 → 告警并跳过该条目；
 *       - 同一张卡累计超过 3 张 → 超出部分被裁掉并告警；
 *       - 总张数超过 40 → 超出部分被裁掉并告警。
 *
 * 使用方式（与 TurnManager / TestConsole 的既有约定一致）：
 *   · 组件按**类名字符串** BFS 查找（`getComponent('CardDeckManager')`），不静态 import；
 *   · `resetDecks()` 在开战 / 重开时由 TurnManager 调用（重新按 Inspector 集合组牌堆）；
 *   · `drawFor(side)` 随机抽 1 张（splice 掉），空了返回 '' 并告警。
 * ===========================================================================
 */
@ccclass('CardDeckManager')
@menu('gf2szb/CardDeckManager')
export class CardDeckManager extends Component {

    // ====================== 规则常量 ======================
    /** 卡组总张数上限 */
    public static readonly MAX_DECK = 40;
    /** 同一张卡最多塞几张 */
    public static readonly MAX_COPIES = 3;

    // ====================== 编辑器可编辑集合 ======================
    @property({
        type: [CCString],
        tooltip: '**我方卡组背包**：每个条目「卡牌id 数量」，如 "2 2" = 2.png × 2 张。\n'
            + '上限 40 张、同一张卡最多 3 张；开战/重开时按本集合重建牌堆。\n'
            + '条目会做校验：格式非法 / 卡牌 id 不在 CardMap / 超上限 → 告警并裁掉。',
    })
    playerDeck: string[] = [];        // 🔴 默认**空牌组**（需求：清除默认卡组，默认 0 张）

    @property({
        type: [CCString],
        tooltip: '**敌方卡组背包**（与我方独立）：每个条目「卡牌id 数量」，如 "2 2" = 2.png × 2 张。\n'
            + '上限 40 张、同一张卡最多 3 张；开战/重开时按本集合重建牌堆。',
    })
    enemyDeck: string[] = [];         // 🔴 默认**空牌组**

    // ====================== 运行时状态（不序列化）======================
    /** 两个独立牌堆：开战时展开，抽一张少一张 */
    private _piles: Record<DeckSide, string[]> = { player: [], enemy: [] };
    /** 各卡组建堆后的总张数（供显示「剩余/总数」） */
    private _sizes: Record<DeckSide, number> = { player: 0, enemy: 0 };
    /**
     * 敌我**墓场**（Grave）：卡牌「离场」后的去向记录，与牌堆一样按阵营分开。
     *
     * 记账时机 = **逻辑离场那一刻**（不是演出动画播完）：
     *   · 战场上卡牌被**破坏**（含护符 DestroySelf）；
     *   · 手牌已满、抽出来加不进手牌而被**破坏**的牌；
     *   · **使用法术**（法术结算后卡本身进墓场）。
     * 存放卡牌 id（数量 = 数组长度），供 BattleStatusBar 之类的显示与后续规则读取。
     */
    private _graves: Record<DeckSide, string[]> = { player: [], enemy: [] };

    // ====================== 生命周期 ======================
    onLoad(): void {
        // ★ 主界面（2D MainMenu 场景）设置的牌组：进入对战时应用**一次**
        //   （`takePending` 取完即清；直接在编辑器里打开对战场景时返回 null，一切按序列化值走）
        try {
            const pending = peekPending();
            if (pending) {
                if (pending.playerDeck.length > 0) this.playerDeck = pending.playerDeck.slice();
                if (pending.enemyDeck.length > 0) this.enemyDeck = pending.enemyDeck.slice();
                console.log(`[CardDeckManager] 应用主界面设置：我方 ${this.playerDeck.length} 条 / `
                    + `敌方 ${this.enemyDeck.length} 条`);
            }
        } catch (e) {
            console.error('[CardDeckManager] 应用主界面设置失败（按场景默认值继续）：', e);
        }
        this.resetDecks();
    }

    // ====================== 对外 API ======================
    /** 重建双方牌堆（开战 begin / 重开 restart 时调用）：按 Inspector 集合重新解析、洗开，并清空双方墓场 */
    public resetDecks(): void {
        this._piles.player = CardDeckManager.buildPile(this.playerDeck, '我方');
        // 未单独配置敌方牌组时，敌方沿用同一套对战牌组，保证开局能从真实牌堆抽出 4 张初始手牌。
        const enemyEntries = this.enemyDeck.length > 0 ? this.enemyDeck : this.playerDeck;
        this._piles.enemy = CardDeckManager.buildPile(enemyEntries, '敌方');
        this._sizes.player = this._piles.player.length;
        this._sizes.enemy = this._piles.enemy.length;
        this.clearGraves();          // 新开一局 = 墓场从 0 开始
        console.log(`[CardDeckManager] 卡组建堆完成 → 我方 ${this._sizes.player} 张 / 敌方 ${this._sizes.enemy} 张`
            + `（上限 ${CardDeckManager.MAX_DECK}、单卡≤${CardDeckManager.MAX_COPIES}）`);
    }

    // ------------------------------ 墓场（Grave）-----------------------------
    /**
     * 墓场 +1（卡牌离场时调用）。
     * 🔴 只增计数、不改牌堆、不碰任何演出 —— 调用方**必须在逻辑离场那一刻**调用，
     *    绝不能挂在破坏动画播完的回调里（BattleStatusBar 读的就是这个逻辑计数）。
     * @param side   归属阵营
     * @param cardId 卡牌 id（可省略：只计数不记名）
     * @returns 加完之后的墓场张数
     */
    public addToGrave(side: DeckSide, cardId?: string): number {
        const g = this._graves[side] || (this._graves[side] = []);
        g.push(cardId ? String(cardId) : '');
        return g.length;
    }

    /** 指定方墓场当前张数 */
    public graveCount(side: DeckSide): number {
        return (this._graves[side] || []).length;
    }

    /** 指定方墓场里的卡牌 id 列表（副本；无 id 的条目为空串） */
    public graveCards(side: DeckSide): string[] {
        return (this._graves[side] || []).slice();
    }

    /** 清空双方墓场（开战 / 重开由 resetDecks 自动调用，也可手动） */
    public clearGraves(): void {
        this._graves.player = [];
        this._graves.enemy = [];
    }

    /**
     * 从指定方的卡组里**随机**抽 1 张（真实集合：抽出即从牌堆移除）。
     * @returns 卡牌 id（CardMap 的 key，如 '2.png'）；卡组已空返回 ''（并告警）
     */
    public drawFor(side: DeckSide): string {
        const pile = this._piles[side] || [];
        if (pile.length === 0) {
            console.warn(`[CardDeckManager] ${CardDeckManager.label(side)}卡组已抽空（初始 ${this._sizes[side]} 张），不能再抽`);
            return '';
        }
        const i = Math.floor(Math.random() * pile.length);
        const id = pile.splice(i, 1)[0];
        return id;
    }

    /**
     * 从指定方的卡组里连续随机抽 n 张（逐张独立随机）。
     * 卡组不够时只抽剩下的（返回数量可能小于 n）。
     */
    public drawManyFor(side: DeckSide, n: number): string[] {
        const out: string[] = [];
        for (let i = 0; i < Math.max(0, Math.round(n)); i++) {
            const id = this.drawFor(side);
            if (!id) break;
            out.push(id);
        }
        return out;
    }

    /**
     * ★ **按条件**从卡组里随机取 1 张（取出即从牌堆移除，与抽牌同款「真实集合」）。
     * 供「召唤」用：召唤随机 1 张符合条件的随从。
     * @returns 卡牌 id；**没有符合条件的卡返回 ''**（调用方据此结算「召唤为空」）
     */
    public takeWhere(side: DeckSide, test: (id: string) => boolean): string {
        const pile = this._piles[side] || [];
        const hits: number[] = [];
        for (let i = 0; i < pile.length; i++) {
            try { if (test(pile[i])) hits.push(i); } catch (e) { /* 单条判定异常跳过 */ }
        }
        if (hits.length === 0) return '';
        const idx = hits[Math.floor(Math.random() * hits.length)];
        return pile.splice(idx, 1)[0];
    }

    /** 指定方卡组还剩几张 */
    public remaining(side: DeckSide): number {
        return (this._piles[side] || []).length;
    }

    /**
     * 把开局更换掉的卡牌洗回指定方牌堆。
     * 只用于「初始手牌更换」等规则：卡牌没有进入墓场，也不改变牌组总数。
     */
    public returnToDeck(side: DeckSide, ids: string[]): number {
        const pile = this._piles[side] || (this._piles[side] = []);
        let added = 0;
        for (const raw of ids || []) {
            const id = toCardId(raw);
            if (!id || !getCardInfo(id)) continue;
            pile.push(id);
            added++;
        }
        // Fisher-Yates：交换回牌堆后重新洗牌，避免下一次抽卡总拿到刚换回的牌。
        for (let i = pile.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            const t = pile[i];
            pile[i] = pile[j];
            pile[j] = t;
        }
        if (added > 0) console.log(`[CardDeckManager] ${CardDeckManager.label(side)}初始手牌换回牌堆 ${added} 张（剩余 ${pile.length} 张）`);
        return added;
    }
    /**
     * ★ 指定方卡组里**剩余的卡牌 id 列表**（副本，顺序 = 当前牌堆顺序）。
     * 供「牌组」测试面板按费用分类展示（见 DeckPanel.ts）。
     */
    public remainingCards(side: DeckSide): string[] {
        return (this._piles[side] || []).slice();
    }

    /** 指定方卡组建堆时的总张数 */
    public initialSize(side: DeckSide): number {
        return this._sizes[side];
    }

    // ====================== 内部：集合解析 ======================
    /** 「卡牌id 数量」条目解析 + 校验（格式 / 卡牌存在性 / 单卡≤3 / 总数≤40），展开成牌堆 */
    private static buildPile(entries: string[], label: string): string[] {
        const pile: string[] = [];
        const counts: Record<string, number> = {};
        for (const raw of entries || []) {
            const s = (raw === null || raw === undefined) ? '' : String(raw).trim();
            if (!s) continue;
            const m = /^(\S+)[ \t]+(\d+)$/.exec(s);
            if (!m) {
                console.warn(`[CardDeckManager] ${label}卡组条目「${raw}」格式非法（应为「卡牌id 数量」，如 "2 2"），已跳过`);
                continue;
            }
            const id = toCardId(m[1]);
            if (!getCardInfo(id)) {
                console.warn(`[CardDeckManager] ${label}卡组条目「${raw}」的卡牌 id "${id}" 不在 CardMap 里，已跳过`);
                continue;
            }
            const want = Math.max(0, parseInt(m[2], 10));
            if (want <= 0) continue;
            // 单卡 ≤ 3：超出裁掉
            const used = counts[id] || 0;
            const leftByCopies = Math.max(0, CardDeckManager.MAX_COPIES - used);
            // 总数 ≤ 40：超出裁掉
            const leftByDeck = Math.max(0, CardDeckManager.MAX_DECK - pile.length);
            const take = Math.min(want, leftByCopies, leftByDeck);
            if (take < want) {
                console.warn(`[CardDeckManager] ${label}卡组条目「${raw}」超限：`
                    + `单卡最多 ${CardDeckManager.MAX_COPIES} 张、卡组上限 ${CardDeckManager.MAX_DECK} 张 → 只收 ${take} 张`);
            }
            for (let i = 0; i < take; i++) pile.push(id);
            counts[id] = used + take;
            if (pile.length >= CardDeckManager.MAX_DECK) break;
        }
        return pile;
    }

    private static label(side: DeckSide): string {
        return side === 'player' ? '我方' : '敌方';
    }
}

// ====================== 模块级便捷入口（给「卡牌离场」的各条路径用）======================
/** 组件/节点 → 所属节点（Node 自身没有 .node，用鸭子判别，避免 instanceof 的打包差异） */
function asNode(from: Component | Node | null): Node | null {
    if (!from) return null;
    const maybe = from as unknown as { node?: Node };
    if (maybe.node && maybe.node.isValid) return maybe.node;
    return from as unknown as Node;
}

/** 从任意节点 / 组件出发（全场景 BFS）找 CardDeckManager；找不到返回 null。 */
export function findDeckManager(from: Component | Node | null): CardDeckManager | null {
    const start = asNode(from);
    const scene = (start && start.isValid && start.scene) ? (start.scene as unknown as Node) : null;
    if (!scene) return null;
    const stack: Node[] = [...scene.children];
    while (stack.length > 0) {
        const cur = stack.shift() as Node;
        if (!cur || !cur.isValid) continue;
        const c = cur.getComponent(CardDeckManager);
        if (c && c.isValid) return c;
        for (const ch of cur.children) stack.push(ch);
    }
    return null;
}

/**
 * 墓场 +1 的**一句话入口**（供战场上被破坏 / 手牌满被破坏 / 使用法术各路径调用）。
 * 🔴 必须在**逻辑离场那一刻**调用；找不到 CardDeckManager 时静默忽略，绝不影响主流程。
 */
export function addToGrave(from: Component | Node | null, side: DeckSide, cardId?: string): boolean {
    const dm = findDeckManager(from);
    if (!dm) return false;
    dm.addToGrave(side, cardId);
    return true;
}

