import { Color, Label, LabelOutline } from 'cc';

/** 战斗数值默认色：随从当前值等于初始值时使用。 */
export const BATTLE_VALUE_DEFAULT = new Color(255, 255, 255, 255);

/** 战斗数值增益色：参考例图里的高亮绿色。 */
export const BATTLE_VALUE_GREEN = new Color(171, 255, 42, 255);

/** 战斗数值减益色：参考例图里的高亮红色。 */
export const BATTLE_VALUE_RED = new Color(246, 26, 38, 255);

/** 按当前值与基准值的大小关系返回显示颜色（攻击力 / 通用数值用）。 */
export function battleValueColor(current: number, baseline: number): Color {
    if (current > baseline) return BATTLE_VALUE_GREEN;
    if (current < baseline) return BATTLE_VALUE_RED;
    return BATTLE_VALUE_DEFAULT;
}

/**
 * 血量数字的颜色：**基于战场动态血量上限判断**，不再看「是否小于基础血量上限」。
 *
 * 规则（需求）：
 *   · 战场上限 == 基础上限 且 当前血量 == 战场上限  → 白色（原始满血）
 *   · 战场上限  >  基础上限 且 当前血量 == 战场上限  → 绿色（被增益后的满血）
 *   · 其余（当前血量 < 战场上限，或上限被削）        → 红色（受伤）
 *
 * 例：基础上限 4、被效果抬到 6 → 满血 6 为绿色；掉到 5 / 4 都 < 6 ⇒ 红色（**不会**再出现白色）。
 *
 * @param hp       当前血量
 * @param maxHp    战场动态血量上限
 * @param baseMaxHp 基础（卡面）血量上限
 */
export function battleHpColor(hp: number, maxHp: number, baseMaxHp: number): Color {
    if (hp < maxHp) return BATTLE_VALUE_RED;              // 受伤 → 红
    if (maxHp > baseMaxHp) return BATTLE_VALUE_GREEN;     // 满血 + 上限被增益 → 绿
    if (maxHp === baseMaxHp) return BATTLE_VALUE_DEFAULT; // 满血 + 原始上限 → 白
    return BATTLE_VALUE_RED;                              // 上限被削且满血 → 视作受损
}

/** 血量数字是否应按「受伤红字」处理（= 需要白色描边）。与 battleHpColor 的红色分支一致。 */
export function battleHpIsDamaged(hp: number, maxHp: number, baseMaxHp: number): boolean {
    return hp < maxHp || maxHp < baseMaxHp;
}

/** 战斗数值显示：保留正负号，逻辑值原样展示。 */
export function formatBattleValue(v: number): string {
    return String(Math.round(v));
}

/** 攻击力卡面显示只允许非负数：负攻击逻辑值仍保留，但显示为 0。 */
export function formatBattleAttack(v: number): string {
    return String(Math.max(0, Math.round(v)));
}

/**
 * 给红色战斗数值添加白色描边；其它颜色关闭描边。
 * 只改变字形边缘，不改变 Label 自身的字体颜色。
 */
export function applyBattleValueOutline(label: Label | null, enabled: boolean): void {
    if (!label || !label.isValid) return;
    let outline = label.node.getComponent(LabelOutline);
    if (!outline) outline = label.node.addComponent(LabelOutline);
    outline.color = new Color(255, 255, 255, 255);
    outline.width = 1;
    outline.enabled = enabled;
}

