import { _decorator, Component, EventTouch } from 'cc';

const { ccclass, menu } = _decorator;

/**
 * TipKeywordLink —— 「说明卡片里的关键字」点击转发器
 * ===========================================================================
 * 挂在**含关键字的 RichText 节点**上（由 `CardTooltip.addRichText` 自动添加）。
 *
 * ── 为什么需要这个小组件（🔴 引擎约束，别改回去）────────────────────────────
 * 富文本标签 `<on click="handler" param="kw">关键字</on>` 的点击派发由 **RichText 自己**完成：
 *   `RichText._onTouchEnded` → 遍历它自己的每个文本分段 → 命中分段的包围盒时，
 *   取 **`this.node.getComponents(Component)`**（= **RichText 所在节点**上的组件）
 *   → 找到名字等于 `handler` 的方法并调用 `func.call(component, event, param)`。
 *
 * 也就是说：**handler 必须是「挂在该 RichText 节点上」的组件的方法**，
 * 挂在父节点（`CardTipLayer` 上的 `CardTooltip`）上的同名方法**永远不会被调用**。
 * 所以这里放一个极薄的转发组件：真正的逻辑仍在 `CardTooltip`。
 *
 * 每个带关键字的 RichText 节点加一个实例，回调里把关键字原文回传给 CardTooltip。
 * ===========================================================================
 */
@ccclass('TipKeywordLink')
@menu('gf2szb/TipKeywordLink')
export class TipKeywordLink extends Component {

    /**
     * 关键字被点击时的回调：`(keyword, event)`。
     * 由 `CardTooltip` 在创建 RichText 后赋值；留空 = 不做任何事（点它当无事发生）。
     */
    public onKeyword: ((keyword: string, event: EventTouch) => void) | null = null;

    /**
     * 🔴 方法名必须与 RichText 标签里写的 `<on click="???">` **完全一致**
     *    （引擎按方法名在节点组件上查找）。
     * @param event 引擎派发的触摸事件（TOUCH_END）
     * @param param 标签里的 `param="..."`（= 关键字原文，如 `入场曲`）
     */
    public onTipKeywordClick(event: EventTouch, param: string): void {
        const cb = this.onKeyword;
        if (!cb) return;
        try {
            cb(param || '', event);
        } catch (e) {
            // 铁律：回调里的异常会被引擎吞掉 → 自己兜一层，至少留下日志
            console.error('[TipKeywordLink] 关键字点击回调出错：', e);
        }
    }
}
