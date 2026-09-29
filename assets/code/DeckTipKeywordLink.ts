import { _decorator, Component } from 'cc';

const { ccclass, property, menu } = _decorator;

/** 关键字点击转发器的引擎回调名（与战斗场景 CardTooltip 的 KEYWORD_CLICK_HANDLER 一致） */
export const KEYWORD_CLICK_HANDLER = 'onTipKeywordClick';

/**
 * DeckTipKeywordLink —— 富文本关键字点击转发器
 * ===========================================================================
 * 引擎的富文本 `<on click='xxx'>` 是在**富文本节点自身**上按方法名找组件方法，
 * 所以必须单独挂一个小组件在这条富文本节点上（战斗场景 `CardTooltip` 的 `TipKeywordLink` 同款做法）。
 *
 * 🔴 Cocos 限制「一个脚本文件最多一个 Component」⇒ 这个类必须单独一个文件
 *    （曾经和 DeckEditScene 放一起 ⇒ 预览整包白屏：`Each script can have at most one Component`）。
 * ===========================================================================
 */
@ccclass('DeckTipKeywordLink')
@menu('gf2szb/DeckTipKeywordLink')
export class DeckTipKeywordLink extends Component {

    /** 被点的关键字回调（由使用方赋值） */
    public onKeyword: ((kw: string) => void) | null = null;

    /** 引擎回调（方法名必须是 KEYWORD_CLICK_HANDLER） */
    public onTipKeywordClick(_event: unknown, param: string): void {
        try {
            if (this.onKeyword) this.onKeyword(param || '');
        } catch (e) {
            console.error('[DeckTipKeywordLink] 关键字点击出错：', e);
        }
    }
}
