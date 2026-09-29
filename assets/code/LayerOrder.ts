import { Node } from 'cc';

/**
 * LayerOrder —— 共享的「层节点临时置顶」工具（**引用计数**）
 * ===========================================================================
 * 解决的固定问题：**跨层遮挡**。
 *
 * 渲染顺序 = 场景树深度优先展开，而 `setSiblingIndex` / `bringToFront` 只能改「同一父节点内部」
 * 的先后。于是当 Canvas 下的子节点顺序是
 *
 *     Background(0) → PlayerHandArea(1) → PlayerBattleFieldArea(2) → EnemyBattleFieldArea(3) → ...
 *
 * 时，**整个手牌层永远在战场层之下** —— 手牌里无论怎么层内置顶，都会被战场卡牌压住。
 * 需要「让本层内容盖住其它层」的组件（HandDrag 拖拽、CardDraw 抽卡动画…），
 * 应在动画开始前 `raiseLayer(node, this)`、结束后 `releaseLayer(node, this)`。
 *
 * ---------------------------------------------------------------------------
 * 🔴 为什么必须引用计数，而不是各自记一份「原序号」
 *   两个组件可能**同时**需要置顶（例：抽卡动画播放中玩家又拖起一张手牌）。
 *   若各存一份 home 序号并各自还原，先收尾的那个会把层还原到「它提升前」的位置，
 *   而另一个仍在动画中 → 动画内容当场又被压回战场之下（旧 bug 复现，且时序相关、很难复现）。
 *   引用计数保证：**只有最后一个持有者释放时才真正还原**。
 *
 * 🔴 `_alwaysTopNames`：提升某层时，不能把「必须永远在最顶」的层压下去。
 *   例：CardPlay 的 `CardPlayLayer` 承载正在飞出/飞入战场的卡牌；
 *       战场计数器（PlayerBattleStatusBar / EnemyBattleStatusBar）是 HUD，绝不能被手牌 / 飞行的卡挡住。
 *   因此「置顶」的落点 = **同层最上，但不越过这些层**（见 moveToTop）。
 * ===========================================================================
 */

/** 各层节点当前的「置顶持有者」集合（谁在要求它置顶） */
const _holders = new Map<Node, Set<object>>();
/** 各层节点**首次**提升前的兄弟序号（最后一个持有者释放时写回） */
const _home = new Map<Node, number>();
/** 当前独占最上层的模态层（如初始换牌界面）。 */
let _modalLayer: Node | null = null;

/**
 * 任何时候都必须留在最顶端的节点名（越靠后越靠上）：
 *   ① 运行期动态创建的「卡牌飞行专图层」—— 正在飞出/飞入战场的卡不能被手牌层压住；
 *   ② 战场计数器 —— HUD，必须永远在手牌层（拖拽 / 抽卡动画都会把手牌层整体置顶）之上。
 */
const _alwaysTopNames = ['CardPlayLayer', 'EnemyCardPlayLayer',
    'PlayerBattleStatusBar', 'EnemyBattleStatusBar'];

/**
 * HUD 层（战场计数器）：比 `_alwaysTopNames` 更严 —— **它之上只允许有另一个 HUD**。
 * 也就是连「卡牌飞行专图层 / 攻击特效层 / 破坏特效层」都不许盖住计数器（需求：计数器位于最顶层）。
 */
const _hudNames = ['PlayerBattleStatusBar', 'EnemyBattleStatusBar'];

/**
 * 把 node 移到「同层最上，但**绝不越过** `_alwaysTopNames`」的位置。
 *
 * 🔴 不能无条件坐到最末位：拖拽手牌 / 抽卡动画都会把手牌层整体置顶，若直接坐到最末位，
 *    就会把手牌盖到战场计数器（以及正在飞行的卡）上面 —— 数字被挡住。
 *    落点取「所有必需置顶层里最低的那个序号」，因此提升后：
 *      手牌层 在战场层之上、在计数器之下（正好是 HUD 之下、玩法内容之上）。
 */
function moveToTop(node: Node): void {
    const parent = node.parent;
    if (!parent) return;
    if (_modalLayer && _modalLayer.isValid && _modalLayer.parent === parent && node !== _modalLayer) {
        node.setSiblingIndex(Math.max(0, _modalLayer.getSiblingIndex() - 1));
        return;
    }
    // 先取「必需置顶层里最低的序号」，落点 = 它 −1：
    // setSiblingIndex(i) 会把原本在 i 的那个节点挤到 i−1，因此要「正好垫在最低必需置顶层之下」
    // 必须落在 i−1，否则被提升的层会插到那个必需置顶层**之上**（差一帧的遮挡）。
    let lowestKeeper = parent.children.length;      // 没有必需置顶层时 → 落到最末位
    for (const sib of parent.children) {
        if (sib === node) continue;
        if (_alwaysTopNames.indexOf(sib.name) < 0) continue;
        const i = sib.getSiblingIndex();
        if (i < lowestKeeper) lowestKeeper = i;
    }
    const insertAt = (lowestKeeper >= parent.children.length) ? parent.children.length - 1 : lowestKeeper - 1;
    node.setSiblingIndex(Math.max(0, insertAt));
}

/**
 * 把 `layer` 提升到**同层最上层**（可重入：同一 holder 重复调用无副作用）。
 * @param layer  要提升的层节点（如手牌区 PlayerHandArea）
 * @param holder 持有者标识，传组件实例 `this` 即可（用于区分是谁在要求置顶）
 */
export function raiseLayer(layer: Node, holder: object): void {
    if (!layer || !layer.isValid || !layer.parent) return;
    let set = _holders.get(layer);
    if (!set) {
        set = new Set<object>();
        _holders.set(layer, set);
    }
    if (set.has(holder)) return;                       // 已持有 → 不重复记 home、不重复搬位置
    set.add(holder);
    if (!_home.has(layer)) _home.set(layer, layer.getSiblingIndex());
    moveToTop(layer);
}

/**
 * 释放 `holder` 对 `layer` 的置顶要求。
 * **最后一个**持有者释放时才把 `layer` 写回提升前的兄弟序号；否则保持置顶。
 * 未持有时调用是无害的 no-op。
 */
export function releaseLayer(layer: Node, holder: object): void {
    if (!layer) return;
    const set = _holders.get(layer);
    if (!set || !set.delete(holder)) return;
    if (set.size > 0) return;                          // 还有别的持有者 → 继续置顶
    _holders.delete(layer);
    const home = _home.get(layer);
    _home.delete(layer);
    if (!layer.isValid || !layer.parent || home === undefined) return;
    const parent = layer.parent;
    // 期间父节点可能增删过子节点，序号收敛到合法范围再写回
    const clamped = Math.max(0, Math.min(home, parent.children.length - 1));
    if (layer.getSiblingIndex() !== clamped) {
        layer.setSiblingIndex(clamped);
        // 模态层期间不能把释放后的旧层盖到模态层上。
        if (_modalLayer && _modalLayer.isValid && _modalLayer.parent === parent && layer !== _modalLayer) {
            layer.setSiblingIndex(Math.max(0, _modalLayer.getSiblingIndex() - 1));
        }
    }
}

/** 开始 / 结束一个独占最上层的模态层（初始换牌等全屏流程）。 */
export function beginModalLayer(node: Node): void {
    if (!node || !node.isValid) return;
    _modalLayer = node;
    if (node.parent) node.setSiblingIndex(node.parent.children.length - 1);
}

export function endModalLayer(node: Node): void {
    if (_modalLayer === node) _modalLayer = null;
}

/**
 * 把「必须永远在最顶」的层**重新钉回同层最上**——只要它下面还压着任何一个非必需置顶层。
 *
 * 供 HUD（战场计数器）逐帧兜底调用：拖拽手牌 / 抽卡动画会把整层手牌置顶，
 * 这里保证计数器的渲染顺序始终在它们之上（数字不会被手牌挡住）。
 * 幂等：已经正确时不移动任何节点（也不会在两个计数器之间来回换位）。
 * @param from 任意同层节点（如计数器自己的节点）
 * @returns 是否发生了移动
 */
export function enforceAlwaysTop(from: Node): boolean {
    const parent = (from && from.isValid) ? from.parent : null;
    if (!parent || !parent.isValid) return false;
    const sibs = parent.children;
    let moved = false;

    // 模态层期间：只保证模态层在最上，HUD / 飞图层都不得越过它。
    if (_modalLayer && _modalLayer.isValid && _modalLayer.parent === parent) {
        if (_modalLayer.getSiblingIndex() !== sibs.length - 1) {
            _modalLayer.setSiblingIndex(sibs.length - 1);
            moved = true;
        }
        return moved;
    }

    /** 某个节点之上是否存在「不允许压在它上面」的兄弟 */
    const blockedBy = (node: Node, allowed: string[]): boolean => {
        for (let i = node.getSiblingIndex() + 1; i < sibs.length; i++) {
            const s = sibs[i];
            if (!s || !s.isValid) continue;
            if (allowed.indexOf(s.name) >= 0) continue;
            return true;
        }
        return false;
    };

    // ① 必需置顶层（卡牌飞行专图层 / 计数器）：上面不能有非必需置顶层
    for (const name of _alwaysTopNames) {
        const node = findChild(sibs, name);
        if (node && blockedBy(node, _alwaysTopNames)) {
            node.setSiblingIndex(sibs.length - 1);
            moved = true;
        }
    }
    // ② HUD（计数器）：更严 —— 上面只允许有另一个计数器（连飞图层/特效层都不许盖住）
    for (const name of _hudNames) {
        const node = findChild(sibs, name);
        if (node && blockedBy(node, _hudNames)) {
            node.setSiblingIndex(sibs.length - 1);
            moved = true;
        }
    }
    return moved;
}

function findChild(sibs: readonly Node[], name: string): Node | null {
    for (const c of sibs) {
        if (c && c.isValid && c.name === name) return c;
    }
    return null;
}

/** 该层当前是否处于「被提升」状态（供测试 / 排查） */
export function isLayerRaised(layer: Node): boolean {
    const set = _holders.get(layer);
    return !!set && set.size > 0;
}

/** 该层当前的持有者数量（供测试 / 排查；0 = 未被提升） */
export function layerHolderCount(layer: Node): number {
    const set = _holders.get(layer);
    return set ? set.size : 0;
}
