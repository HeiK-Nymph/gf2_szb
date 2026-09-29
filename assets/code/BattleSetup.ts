/**
 * BattleSetup —— **主界面 → 对战场景** 的设置传递（跨场景）
 * ===========================================================================
 * 为什么需要它：主界面与对战是**两个独立场景**，各自的组件实例互不可见
 * （`CardDeckManager.playerDeck` / `TurnManager.defaultFirstSide` 都序列化在**对战场景**里）。
 * 于是主界面把玩家选好的设置写进这个**模块级**暂存区，进入对战后由
 * `CardDeckManager.onLoad` / `TurnManager.onLoad` 各取一次并应用（`takePending` 取完即清）。
 *
 * 🔴 只应用**一次**：正常从主界面进入对战时生效；直接在编辑器里打开对战场景
 *    （没有 pending）时，一切按场景里序列化的值走，不受影响。
 * ===========================================================================
 */

/** 先后手选择：先手 / 后手 / 随机 */
export type FirstSideChoice = 'player' | 'enemy' | 'random';

/** 一套对战设置（牌组条目形如 `'2 3'` = 卡牌 id + 张数，与 CardDeckManager 同格式） */
export interface BattleSetupData {
    playerDeck: string[];
    enemyDeck: string[];
    first: FirstSideChoice;
}

/**
 * 默认设置 = **空牌组**（需求：清除默认卡组，默认 0 张）。
 * 玩家要在主界面里自己配牌组（双方都不能为空才能「开始对战」）。
 */
export const DEFAULT_SETUP: BattleSetupData = {
    playerDeck: [],
    enemyDeck: [],
    first: 'random',
};

/** 单卡最多张数 / 牌组总张数上限（与 CardDeckManager.buildPile 的校验一致） */
export const MAX_COPIES_PER_CARD = 3;
export const MAX_DECK_SIZE = 40;

import { sys } from 'cc';

/** 存档键（localStorage）—— 跨场景、**跨页面重载**都有效 */
const STORAGE_KEY = 'gf2szb.battleSetup';

let _pending: BattleSetupData | null = null;

/** 主界面点「开始对战」时写入（内存 + localStorage 双写） */
export function setPending(data: BattleSetupData): void {
    _pending = {
        playerDeck: (data.playerDeck || []).slice(),
        enemyDeck: (data.enemyDeck || []).slice(),
        first: data.first,
    };
    // 🔴 必须落 localStorage：编辑器**预览**在切场景时会重载页面 ⇒ 纯模块变量会丢（实测踩过）。
    try {
        sys.localStorage.setItem(STORAGE_KEY, JSON.stringify(_pending));
    } catch (e) {
        console.warn('[BattleSetup] 写入 localStorage 失败（仅内存生效）：', e);
    }
}

/** ★ 牌组**持久存储**的 key（卡组编辑保存的牌组放这里，跨场景 / 重载都在）。 */
const DECK_KEY = 'gf2szb.playerDeck';
/** ★ 人机（敌方）牌组的持久存储 key —— 与玩家牌组分开存，各自独立编辑。 */
const ENEMY_DECK_KEY = 'gf2szb.enemyDeck';

let _playerDeck: string[] | null = null;
let _enemyDeck: string[] | null = null;

/** 读/写某一侧牌组的持久存储 */
function readStored(key: string, cache: string[] | null): string[] {
    if (cache) return cache.slice();
    try {
        const raw = sys.localStorage.getItem(key);
        if (raw) {
            const d = JSON.parse(raw);
            if (Array.isArray(d)) return d.slice();
        }
    } catch (e) { /* 忽略 */ }
    return [];
}

function writeStored(key: string, entries: string[]): string[] {
    const v = (entries || []).slice();
    try { sys.localStorage.setItem(key, JSON.stringify(v)); } catch (e) { /* 忽略 */ }
    return v;
}

/**
 * ★ 保存「我方牌组」（卡组编辑场景调用）。
 * 🔴 不能只写 pending：主界面 onLoad 会 clearPending（它要保证「重新打开主界面从空牌组开始」），
 *    对战开始时再用 peekSetup() 取 —— 所以牌组必须有一份**独立持久**的存储（localStorage）。
 */
export function setPlayerDeck(entries: string[]): void {
    _playerDeck = writeStored(DECK_KEY, entries);
}

/** ★ 读取我方牌组（没有则返回空数组）。 */
export function getPlayerDeck(): string[] {
    _playerDeck = readStored(DECK_KEY, _playerDeck);
    return _playerDeck.slice();
}

/** ★ 保存「人机（敌方）牌组」（卡组编辑场景调用）。 */
export function setEnemyDeck(entries: string[]): void {
    _enemyDeck = writeStored(ENEMY_DECK_KEY, entries);
}

/** ★ 读取人机（敌方）牌组（没有则返回空数组）。 */
export function getEnemyDeck(): string[] {
    _enemyDeck = readStored(ENEMY_DECK_KEY, _enemyDeck);
    return _enemyDeck.slice();
}

// ---------------------------------------------------------------------------
//  卡组编辑场景「当前在编辑哪一侧」
// ---------------------------------------------------------------------------
/** 牌组归属方：我方 / 人机（敌方） */
export type DeckSide = 'player' | 'enemy';

const EDIT_SIDE_KEY = 'gf2szb.deckEditSide';
let _editSide: DeckSide | null = null;

/** 主界面点「编辑我方牌组 / 编辑人机牌组」时写入，卡组编辑场景 onLoad 时读取 */
export function setDeckEditSide(side: DeckSide): void {
    _editSide = side === 'enemy' ? 'enemy' : 'player';
    try { sys.localStorage.setItem(EDIT_SIDE_KEY, _editSide); } catch (e) { /* 忽略 */ }
}

/** 读「当前在编辑哪一侧」（默认我方） */
export function getDeckEditSide(): DeckSide {
    if (_editSide) return _editSide;
    try {
        const raw = sys.localStorage.getItem(EDIT_SIDE_KEY);
        if (raw === 'enemy' || raw === 'player') { _editSide = raw; return raw; }
    } catch (e) { /* 忽略 */ }
    _editSide = 'player';
    return 'player';
}

/** 按侧读牌组 */
export function getDeckBySide(side: DeckSide): string[] {
    return side === 'enemy' ? getEnemyDeck() : getPlayerDeck();
}

/** 按侧写牌组 */
export function setDeckBySide(side: DeckSide, entries: string[]): void {
    if (side === 'enemy') setEnemyDeck(entries); else setPlayerDeck(entries);
}

/** 供菜单显示：当前待应用的设置（没有则返回默认设置的副本） */
export function peekSetup(): BattleSetupData {
    const src = readPending() || DEFAULT_SETUP;
    // ★ 双方牌组都以**持久牌组**为准（卡组编辑保存的）；它为空时才用 pending / 默认
    const saved = getPlayerDeck();
    const playerDeck = saved.length > 0 ? saved : src.playerDeck.slice();
    const savedEnemy = getEnemyDeck();
    const enemyDeck = savedEnemy.length > 0 ? savedEnemy : src.enemyDeck.slice();
    return { playerDeck, enemyDeck, first: src.first };
}

/** 读待应用设置：先内存、再 localStorage（预览重载后仍能拿到） */
function readPending(): BattleSetupData | null {
    if (_pending) return _pending;
    try {
        const raw = sys.localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const d = JSON.parse(raw) as BattleSetupData;
        if (!d || !Array.isArray(d.playerDeck) || !Array.isArray(d.enemyDeck)) return null;
        _pending = { playerDeck: d.playerDeck.slice(), enemyDeck: d.enemyDeck.slice(), first: d.first || 'random' };
        return _pending;
    } catch (e) {
        return null;
    }
}

/**
 * 对战场景启动时**取一次并清空**（只应用一次）。
 * @returns 有设置返回它；没有（直接在编辑器里跑对战场景）返回 null
 */
export function takePending(): BattleSetupData | null {
    const d = readPending();
    _pending = null;
    try { sys.localStorage.removeItem(STORAGE_KEY); } catch (e) { /* 忽略 */ }
    return d;
}

/**
 * ★ 对战场景里**多个组件**都要读这套设置（`CardDeckManager` 读牌组、`TurnManager` 读先后手）——
 * 所以读取**不能消费**：谁先 `onLoad` 谁就把设置吃掉，另一个就什么也拿不到（踩过）。
 * 真正「只应用一次」的语义由**主界面每次点开始对战时覆盖写入**来保证。
 * @returns 待应用设置（副本）；没有则 null
 */
export function peekPending(): BattleSetupData | null {
    const d = readPending();
    if (!d) return null;
    return { playerDeck: d.playerDeck.slice(), enemyDeck: d.enemyDeck.slice(), first: d.first };
}

/** 清掉待应用设置（测试 / 调试用） */
export function clearPending(): void {
    _pending = null;
    try { sys.localStorage.removeItem(STORAGE_KEY); } catch (e) { /* 忽略 */ }
}

/** 是否已经有一套待应用的设置（调试用） */
export function hasPending(): boolean {
    return _pending !== null;
}

// ============================================================================
// 牌组条目 ↔ 「卡牌 id → 张数」映射
// ============================================================================
/** 解析条目数组（`['2 3','1 3']`）→ `Map<id, count>`（非法条目忽略） */
export function deckToCounts(entries: string[]): Map<string, number> {
    const out = new Map<string, number>();
    for (const raw of entries || []) {
        const s = String(raw || '').trim();
        if (!s) continue;
        const parts = s.split(/\s+/);
        const id = parts[0];
        const n = parts.length > 1 ? Math.round(Number(parts[1])) : 1;
        if (!id || !Number.isFinite(n) || n <= 0) continue;
        out.set(id, (out.get(id) || 0) + n);
    }
    return out;
}

/** 映射 → 条目数组（只导出 > 0 的；顺序按 id 里的数字升序，稳定好看） */
export function countsToDeck(counts: Map<string, number>): string[] {
    const ids = Array.from(counts.keys()).sort((a, b) => {
        const na = parseInt(a, 10);
        const nb = parseInt(b, 10);
        if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
        return a.localeCompare(b);
    });
    const out: string[] = [];
    for (const id of ids) {
        const n = Math.max(0, Math.round(counts.get(id) || 0));
        if (n > 0) out.push(`${id} ${n}`);
    }
    return out;
}

/** 牌组总张数 */
export function deckSize(counts: Map<string, number>): number {
    let total = 0;
    for (const n of counts.values()) total += Math.max(0, Math.round(n));
    return total;
}
