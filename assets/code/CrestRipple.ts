import { _decorator, Color, Component, Graphics, UITransform } from 'cc';

const { ccclass } = _decorator;

/** 一个槽位的波纹状态（由 CrestArea 填好坐标后交给本组件） */
export interface CrestRippleSlot {
    /** 槽位序号（0 ~ 4） */
    index: number;
    /** 槽位中心（本组件所在节点 = 特效层 的局部坐标） */
    x: number;
    y: number;
    /** 圆框半径（波纹从这条边开始往外扩） */
    radius: number;
    /** 是否要波纹（true = 该纹章此刻可发动） */
    on: boolean;
    /** 起始半径倍数（默认 1 = 从圆框外缘出发） */
    startScale?: number;
}

/** 波纹参数（**权威值在 `CrestSystem` 的 Inspector 上**，这里只是运行期接收方） */
export interface CrestRippleConfig {
    /** 最大扩大范围：波纹最大半径 ÷ 圆框半径（1.75 = 扩到 1.75 倍半径） */
    maxScale: number;
    /** 一次扩大的时间（秒）：环从圆框边缘扩到最大范围的用时 */
    duration: number;
    /** 主环线宽（px）；外圈柔光按它 ×2.2 画 */
    thickness: number;
    /**
     * **渐入占比**（0~1）：一圈生命周期的前这一小段用来**渐渐出现**（透明度 0 → 峰值），
     * 剩下的部分用来「边扩边渐渐消失」。0 ≈ 一出现就是峰值（会显得很突兀）。
     */
    appear: number;
    /** 环的颜色（黄色系；alpha 由 intensity 与进度共同决定） */
    color: Color;
    /** 整体透明度倍数（0 = 不显示；1 = 原色） */
    intensity: number;
}

/**
 * CrestRipple —— 纹章「**可发动**」的循环外扩波纹
 * ===========================================================================
 * 由 `CrestSystem`（每帧节流轮询）判断某枚纹章此刻能否发动 → `CrestArea.setSlotRipple()`
 * → 本组件在**一个 `Graphics`** 上把每个「可发动」槽位的环画出来。
 *
 * ── 样式（按需求）：**始终只有一个环，贴住圆框边缘，环的「边」渐渐扩大 + 渐渐消失，循环往复** ──
 *   · 取一个归一化进度 `p ∈ [0,1)`，按 `1 / duration` 每秒推进（到 1 就回绕重来）；
 *   · 半径 = `圆框半径 + (最大半径 − 圆框半径) × p` —— p=0 时环**正好贴在圆框外缘**
 *     （看起来就是一整圈「附在框边」的光晕），随后这圈光的边缘不断往外扩；
 *   · 透明度：**先渐渐出现**（前 `appear` 段用 smoothstep 从 0 升到峰值 —— 🔴 不能一出现就是满亮度，
 *     那样看起来是「啪」地冒出来一圈），再 `1 − q^1.6` 渐渐消失；p→1 时淡尽，
 *     随即从框边**重新渐渐出现**（「渐渐扩大 + 渐渐消失」一直重复）；
 *   · 线宽 = `thickness × (1 + 0.7p)`，并额外叠一圈 **×2.2 宽、×0.35 透明度**的柔光 →
 *     外扩时越来越柔，接近示例里那种「发光带」而不是硬边细线。
 * 🔴 **不是多个环往外跑**：任何时刻每个「可发动」槽位只有这一圈（`waves` 参数已删除）。
 *
 * 🔴 必须挂在**纹章区的最后一个子节点**（`CrestArea.ensureFxLayer()` 负责摆位）：
 *    槽位 `Crest_0..4` 按兄弟序号渲染，特效层排在最后 → 波纹扩到相邻圆框上时
 *    **不会被那些圆框盖住**（需求）。同时它**不在**任何 `cc.Mask` 下面，
 *    所以也不会被纹章图标那层椭圆裁剪吃掉。
 * 🔴 只有一个 `Graphics` + 逐帧 `clear()/stroke()`：1 个绘制组件、几个圆，开销可忽略。
 * ===========================================================================
 */
@ccclass('CrestRipple')
export class CrestRipple extends Component {

    /** 波纹参数（运行期由 CrestSystem 注入；未注入时用这里的默认值） */
    private _cfg: CrestRippleConfig = {
        maxScale: 1.75,
        duration: 1.1,
        thickness: 3,
        appear: 0.18,
        color: new Color(255, 214, 92, 255),
        intensity: 1,
    };
    /** 各槽位状态（下标 = 槽位序号） */
    private readonly _slots: Record<number, CrestRippleSlot> = {};
    private _g: Graphics | null = null;
    /** 全局归一化进度 [0,1) */
    private _p = 0;

    // ------------------------------ 对外 API ------------------------------
    /** 注入 / 更新波纹参数（每次调用都会立刻按新参数重画） */
    public applyConfig(cfg: Partial<CrestRippleConfig>): void {
        if (!cfg) return;
        if (typeof cfg.maxScale === 'number' && isFinite(cfg.maxScale)) {
            this._cfg.maxScale = Math.max(1, cfg.maxScale);
        }
        if (typeof cfg.duration === 'number' && isFinite(cfg.duration)) {
            this._cfg.duration = Math.max(0.05, cfg.duration);
        }
        if (typeof cfg.thickness === 'number' && isFinite(cfg.thickness)) {
            this._cfg.thickness = Math.max(0.5, cfg.thickness);
        }
        if (typeof cfg.appear === 'number' && isFinite(cfg.appear)) {
            this._cfg.appear = Math.min(0.6, Math.max(0, cfg.appear));
        }
        if (typeof cfg.intensity === 'number' && isFinite(cfg.intensity)) {
            this._cfg.intensity = Math.max(0, cfg.intensity);
        }
        if (cfg.color) this._cfg.color = cfg.color;
    }

    /** 设置 / 更新某个槽位的波纹状态 */
    public setSlot(slot: CrestRippleSlot): void {
        if (!slot) return;
        this._slots[slot.index] = {
            index: slot.index,
            x: slot.x,
            y: slot.y,
            radius: Math.max(1, slot.radius),
            on: slot.on === true,
            startScale: slot.startScale,
        };
    }

    /** 全部熄灭（重开对局 / 组件关闭） */
    public clearSlots(): void {
        for (const k of Object.keys(this._slots)) delete this._slots[k];
        const g = this.graphics();
        if (g) g.clear();
    }

    /** 当前是否至少有一个槽位在亮波纹（调试 / 探针用） */
    public get activeCount(): number {
        let n = 0;
        for (const k of Object.keys(this._slots)) if (this._slots[Number(k)].on) n++;
        return n;
    }

    // ------------------------------ 生命周期 ------------------------------
    onLoad(): void {
        this.graphics();          // 预建 Graphics（避免第一帧丢一次绘制）
    }

    onEnable(): void {
        this._p = 0;
    }

    update(dt: number): void {
        const g = this.graphics();
        if (!g) return;
        const cfg = this._cfg;
        const anyOn = this.activeCount > 0;
        if (!anyOn) {
            // 没有可发动的纹章：清一次屏就彻底不画（零开销）
            if (this._drawn) { g.clear(); this._drawn = false; }
            return;
        }
        this._drawn = true;

        // 全局进度推进（归一化 → 0..1 循环；到 1 表示这一圈已经淡尽，下一帧从框边重新开始）
        this._p += dt / cfg.duration;
        if (!isFinite(this._p) || this._p < 0) this._p = 0;
        this._p -= Math.floor(this._p);

        const p = this._p;
        const col = cfg.color;
        const baseA = col.a / 255;
        // 这一圈的透明度：**先渐渐出现、再边扩边渐渐消失**。
        //   ① 渐入段 p ∈ [0, appear)：smoothstep 从 0 升到峰值 —— 环不会「啪」地冒出来；
        //   ② 渐出段：`1 − q^1.6`（q = 渐出段内的进度）—— 前段保持清晰可见、末段快速淡尽。
        // 🔴 不要用线性 / `(1−p)^n` 当渐出：那样扩到一半就只剩 5 成、后半段几乎看不见，
        //    在亮背景（水晶 / 火光）上会被误判成「没特效」。
        const inEnd = Math.min(0.6, Math.max(0, cfg.appear));
        let alpha;
        if (inEnd > 0.001 && p < inEnd) {
            const t = p / inEnd;
            alpha = t * t * (3 - 2 * t);                        // smoothstep 渐入
        } else {
            const q = inEnd > 0.001 ? (p - inEnd) / (1 - inEnd) : p;
            alpha = 1 - Math.pow(Math.max(0, Math.min(1, q)), 1.6);
        }
        const fade = alpha * baseA * cfg.intensity;
        if (fade <= 0.02) { g.clear(); return; }          // 已淡尽：这一帧不画
        const w = cfg.thickness * (1 + 0.7 * p);          // 越扩越宽 → 越来越柔
        const softA = Math.round(Math.min(1, fade * 0.35) * 255);
        const mainA = Math.round(Math.min(1, fade) * 255);

        g.clear();
        for (const key of Object.keys(this._slots)) {
            const s = this._slots[Number(key)];
            if (!s.on) continue;
            const start = s.radius * Math.max(0.1, s.startScale === undefined ? 1 : s.startScale);
            const r = start + (s.radius * cfg.maxScale - start) * p;
            // ① 外圈柔光（宽而淡）→ 「发光带」的观感
            g.lineWidth = w * 2.2;
            g.strokeColor = new Color(col.r, col.g, col.b, softA);
            g.circle(s.x, s.y, r);
            g.stroke();
            // ② 主环
            g.lineWidth = w;
            g.strokeColor = new Color(col.r, col.g, col.b, mainA);
            g.circle(s.x, s.y, r);
            g.stroke();
        }
    }

    /** 已经画过东西（用于「没波纹时只清一次」） */
    private _drawn = false;

    /** 取（或建）本节点上的 Graphics */
    private graphics(): Graphics | null {
        if (this._g && this._g.isValid) return this._g;
        const n = this.node;
        if (!n || !n.isValid) return null;
        if (!n.getComponent(UITransform)) {
            const ut = n.addComponent(UITransform);
            ut.setAnchorPoint(0.5, 0.5);
        }
        this._g = n.getComponent(Graphics) || n.addComponent(Graphics);
        return this._g;
    }
}
