import {
    Color, EffectAsset, Label, Material, Node, resources, Sprite, UIRenderer,
} from 'cc';

/**
 * CardWhiteFlashFx —— 卡牌「整体发亮白光」共享工具
 * ===========================================================================
 * 把一张卡**自身**的可见渲染层（Sprite / Label）逐个套上 `CardWhiteFlash.effect`
 * 材质，用 uniform `flash`（0 = 原色 → 1 = 全 flashColor）驱动。
 *
 * 🔑 为什么是「逐层洗白」而不是盖一块白方块：
 *    每个 Sprite/Label 各自保留自己的贴图 alpha ⇒ 白光严格贴合卡牌**实际显示出来的
 *    形状**（卡框圆角 / 雕花边 / 拱顶都跟得上），不会变成平直的长方形。
 *
 * 使用方：
 *   · `CardDestroyFx`      —— 破坏时 0→1 洗白，随后卡牌消失；
 *   · `EvolveFollowerFx`   —— 进化旋转开始时 0→1 变白，转到 630° 再 1→0 恢复。
 *
 * 🔴 生命周期铁律：
 *   · 结束时必须 `releaseWhiteFlash(targets)` —— 把 `customMaterial` **成对还原**为
 *     null 再 destroy。只 destroy 材质而把引用留在节点上 → 节点下次渲染会引用一个
 *     已销毁的材质（卡牌还在场时尤其明显）。
 *   · 跳过已经带自定义材质的层（如 CardGlow 光圈），避免把它一起刷白。
 * ===========================================================================
 */

/** 「洗白」期间临时挂在卡牌各层上的（渲染组件, 材质）对 */
export interface WhiteFlashTarget {
    r: UIRenderer;
    m: Material;
}

/** 效果名（= 资源文件名去扩展名，EffectAsset 按它注册） */
const EFFECT_NAME = 'CardWhiteFlash';
/** 洗白 effect 在 resources 下的路径（打包后即使没有任何场景引用也不会被裁掉） */
const EFFECT_RES_PATH = 'effects/CardWhiteFlash';

// 模块级缓存：全场共用一份 effect（每个卡牌层各自只有材质实例）
let _loaded: EffectAsset | null = null;
let _loading = false;

/**
 * 解析洗白 effect（幂等）：① override（Inspector 指定的）；② 已注册的效果名；
 * ③ 从 resources 异步加载（只发起一次）。未就绪时返回 null。
 */
export function resolveWhiteFlashEffect(override?: EffectAsset | null): EffectAsset | null {
    if (override && override.isValid) return override;
    if (_loaded && _loaded.isValid) return _loaded;
    const byName = EffectAsset.get(EFFECT_NAME);
    if (byName) { _loaded = byName; return byName; }
    if (!_loading) {
        _loading = true;
        resources.load(EFFECT_RES_PATH, EffectAsset, (err, asset) => {
            _loading = false;
            if (!err && asset) _loaded = asset;
        });
    }
    return (_loaded && _loaded.isValid) ? _loaded : null;
}

/** 预加载洗白 effect（场景启动调一次即可，避免第一次播放时素材还没到）。 */
export function preloadWhiteFlashEffect(): void {
    resolveWhiteFlashEffect();
}

/**
 * 给卡牌**自身**的可见渲染组件套上洗白材质（递归整棵子树）。
 * @param root   卡牌根节点
 * @param effect 洗白 effect（用 resolveWhiteFlashEffect 取）
 * @param tint   洗白后的颜色（默认纯白）
 * @returns 本次生效的 {渲染组件, 材质} 对（播放结束由调用方 releaseWhiteFlash）
 */
export function applyWhiteFlash(root: Node, effect: EffectAsset, tint?: Color): WhiteFlashTarget[] {
    const targets: WhiteFlashTarget[] = [];
    if (!root || !root.isValid || !effect || !effect.isValid) return targets;
    const flashColor = tint ? new Color(tint) : new Color(255, 255, 255, 255);
    const walk = (n: Node): void => {
        if (!n || !n.isValid) return;
        let r: UIRenderer | null = n.getComponent(Sprite) as UIRenderer | null;
        if (!r) r = n.getComponent(Label) as UIRenderer | null;
        // 只处理「没有自定义材质」的普通卡面层；CardGlow 等特效层跳过
        if (r && !r.customMaterial && !/^CardGlow/i.test(n.name)) {
            try {
                const m = new Material();
                m.initialize({ effectAsset: effect });
                m.setProperty('flash', 0);
                try { m.setProperty('flashColor', flashColor); } catch (e) { /* 颜色 uniform 可选 */ }
                r.customMaterial = m;
                targets.push({ r, m });
            } catch (e) { /* 单个组件失败不影响整体 */ }
        }
        for (const c of n.children) walk(c);
    };
    walk(root);
    return targets;
}

/** 设置洗白程度 v ∈ [0,1]（0 = 原色，1 = 全 tint）。对失效条目自动跳过。 */
export function setWhiteFlash(targets: WhiteFlashTarget[] | null | undefined, v: number): void {
    if (!targets || targets.length === 0) return;
    const f = Math.max(0, Math.min(1, v));
    for (const t of targets) {
        try { if (t.m && t.m.isValid) t.m.setProperty('flash', f); } catch (e) { /* 单帧忽略 */ }
    }
}

/** 成对还原并销毁本次创建的材质实例（幂等；还原后清空数组）。 */
export function releaseWhiteFlash(targets: WhiteFlashTarget[] | null | undefined): void {
    if (!targets) return;
    for (const t of targets) {
        try {
            if (t.r && t.r.isValid && t.r.customMaterial === t.m) t.r.customMaterial = null;
        } catch (e) { /* 忽略 */ }
        try { if (t.m && t.m.isValid) t.m.destroy(); } catch (e) { /* 忽略 */ }
    }
    targets.length = 0;
}