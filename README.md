# 伊利昂之围 · gf2_szb

基于 **Cocos Creator 3.8.8** 的**单机网页卡牌对战**游戏（人机对战）。
设计分辨率 **1280×720（16:9）**，目标平台 B 站 Toy，包体上限 140MB。

> 卡面取材自《少女前线 2》，玩法是经典的「能量点 → 出牌 / 进化 → 随从交换 → 打脸」，
> 在此之上做了 **纹章 / 超进化 / 爆能强化 / 协作 / 奥义** 等自定义词条系统。

---

## 1. 玩法概览

### 对局流程

1. **主界面**：分别编辑「我方牌组」和「人机牌组」，选先后手，点「开始对战」
2. **开局换牌**：双方各发 4 张候选牌，可把不想要的拖到上方槽位换掉，点「决定」收牌
3. **回合**：进入操作回合时按「大回合数」刷新能量点（PP），上限 10
4. **出牌**：从手牌拖到战场；随从可攻击，法术 / 护符结算能力
5. **胜负**：把对方主战者的 20 点血量打光

### 卡牌规模

| 项目 | 数值 |
| --- | --- |
| 卡牌总数 | **37 张**（资源名 `1.png` – `37.png`，资源名即卡牌 id） |
| 类型 | 随从 29 / 法术 5 / 护符 3 |
| 品质 | 铜 6 / 银 9 / 金 9 / 传说 13 |
| 牌组规则 | 上限 40 张，同名卡最多 3 张 |

### 关键词（23 个）

纹章 · 吟唱 · 入场曲 · 守护 · 突进 · 疾驰 · 威慑 · 超进化时 · 进化时 · 分配伤害 ·
潜行 · 奥义 · 解放奥义 · 启动 · 召唤 · 模式 · 谢幕曲 · 协作 · 爆能强化 · 屏障 · 毁灭 · 交战时 · 灵气

### 特色系统

- **进化 / 超进化**：进化点资源；超进化随从自带「守护」，且自己回合内免疫伤害
- **纹章**：挂在主战者身上的持续效果（可由卡牌能力获得）
- **爆能强化 / 协作 / 奥义**：满足阈值时触发强化版结算
- **人机 AI**：`EnemyBattleAI` 决策 + `AiPlan` 规划出牌与攻击

---

## 2. 环境与运行

### 环境要求

- **Cocos Creator 3.8.8**（请使用同版本；跨版本打开会重写场景序列化格式）
- Node.js（可选，仅 `.workbuddy/` 下的辅助脚本需要）

### 打开工程

1. Cocos Dashboard → 「添加」→ 选择本目录 → 用 **3.8.8** 打开
2. 首次打开会自动生成 `library/`、`temp/`（这两个目录不入库，属正常现象）
3. 打开 `assets/MainMenu.scene`，点「预览」即可在浏览器里玩

### 构建 Web 版

编辑器 → **项目 → 构建发布** → 平台选 `web-mobile` → **起始场景务必设为 `MainMenu`**。

> ⚠️ **构建产物必须用 HTTP 访问**：直接双击 `build/web-mobile/index.html` 会白屏 ——
> 浏览器会以 `file://` 跨域策略拦住 SystemJS 加载 `src/import-map.json`。
> 本地随便起个静态服务器（例如 `npx serve build/web-mobile`）即可。

---

## 3. 场景与流程

| 场景 | 作用 |
| --- | --- |
| `assets/MainMenu.scene` | **主界面**：双方牌组概况与编辑入口、先后手选择、开始对战（构建起始场景用它） |
| `assets/DeckEdit.scene` | **卡组编辑**：40 张上限、同名 ≤3、自动编辑、保存 |
| `assets/scene.scene` | **对战主场景**：战场、手牌、主战者、纹章区、控制台 |

流程：`MainMenu` →（编辑牌组）`DeckEdit` →（保存 / 返回）`MainMenu` →（开始对战）`scene`

跨场景参数（双方牌组、先后手）由 `assets/code/BattleSetup.ts` + localStorage 传递。

---

## 4. 目录结构

```
gf2_szb/
├── assets/                     游戏本体（唯一需要长期维护的内容）
│   ├── code/                   71 个 TypeScript 脚本（全部游戏逻辑与演出）
│   ├── image/                  美术资源
│   │   ├── bg/                 战场背景
│   │   ├── cards/cardImage/    卡面插画（1.png – 37.png …）
│   │   ├── cards/frame/        卡框（BattleField/ 战场版、test/ 备用）
│   │   ├── crest/              纹章图标
│   │   ├── hero/               主战者头像
│   │   └── ui/                 UI 素材
│   ├── resources/effects/      运行时加载的特效素材（resources.load 专用）
│   ├── MainMenu.scene          主界面
│   ├── DeckEdit.scene          卡组编辑
│   └── scene.scene             对战主场景
├── settings/v2/packages/       Cocos 工程设置（引擎、物理、程序、构建…）
├── .creator/                   自定义脚本模板
├── package.json                工程标识（名称 / uuid / 引擎版本）
├── tsconfig.json               TypeScript 配置
└── 战场背景场景配置.md          战场背景的节点结构与挂载说明
```

> `library/`、`temp/`、`build/`、`profiles/`、`local/`、`native/` 都是**生成物**，
> 已在 `.gitignore` 中排除，克隆后由编辑器自动重建。

---

## 5. 核心模块

| 模块 | 职责 |
| --- | --- |
| `CardData.ts` | **卡表**：37 张卡的图形 / 品质 / 类型 / 费用 / 攻血 / 能力；`CARD_ABILITY_MAP` 能力映射 |
| `CardTipData.ts` | **说明文案表**：卡牌能力文案、关键字高亮词表 |
| `CardAbilitySystem.ts` | 能力结算内核（入场曲 / 谢幕曲 / 启动 / 进化 / 召唤 / 纹章…） |
| `BattleRuleSystem.ts` | 战斗规则（攻击、交战、伤害、破坏、消失） |
| `BattleCommandSystem.ts` | 战斗指令队列与配套演出 |
| `TurnManager.ts` | 回合、能量点（PP）、先后手、回合开始抽牌 |
| `BattleInitialHand.ts` | 开局发牌与「更换初始手牌」界面 |
| `CardDeckManager.ts` | 卡组背包（40 张上限 / 同名 ≤3 / 牌堆 / 墓场记账） |
| `CardDraw.ts` · `EnemyCardDraw.ts` | 抽卡与手牌管理 |
| `CardPlay.ts` · `EnemyCardPlay.ts` | 出牌与结算入口 |
| `HandLayout.ts` · `HandDrag.ts` · `HandMinimize.ts` | 手牌布局、拖拽、最小化 |
| `BattleFieldLayout.ts` | 战场排布（随从站位、间距、缩放） |
| `CardComposer.ts` | 卡牌拼装（卡图 + 卡框 + 数值 + 文本） |
| `CardKeywordSystem.ts` | 关键词判定（守护 / 突进 / 疾驰 / 潜行 / 灵气…） |
| `CrestSystem.ts` · `CrestEffects.ts` · `CrestArea.ts` | 纹章系统与纹章区显示 |
| `EvoPointSystem.ts` · `EvoDragController.ts` · `EvolveFollowerFx.ts` | 进化 / 超进化的资源、交互与演出 |
| `EnemyBattleAI.ts` · `AiPlan.ts` | 人机 AI 的决策与规划 |
| `CardTooltip.ts` · `CardTipData.ts` | 卡牌详情浮层与富文本关键字点击 |
| `LayerOrder.ts` | 节点层级 z 序（引用计数式抬高 / 释放） |
| `MainMenu.ts` · `DeckEditScene.ts` | 主界面与卡组编辑界面 |
| `BattleSetup.ts` | 跨场景参数传递（牌组 / 先后手） |
| `*Fx.ts` | 各类特效（破坏、光球、子弹、护盾、飘字…） |

---

## 6. 改卡最常动的两个文件

### 加一张新卡

1. 卡面放进 `assets/image/cards/cardImage/`，命名 `N.png`
2. 在 `CardData.ts` 的 `CardMap` 里加一条：

```ts
'38.png': {
  cardImage: '38.png',
  quality: 'Silver',          // Bronze | Silver | Gold | Legendary
  cardType: 'Follower',       // Follower | Spell | Amulet
  cardName: '卡名',
  cost: 3,
  attack: 3,
  hp: 4,
  abilities: [
    { trigger: 'fanfare', name: 'DrawCards', params: { count: 1 } },
  ],
},
```

3. 在 `CardTipData.ts` 的 `CARD_TIP_DATA['38.png']` 写能力文案（`items` 里的
   `ability` / `desc` / `subs`），文案与 `abilities` 要逐条对应
4. 保存后编辑器会重新编译，**不需要改场景**

### 改能力 / 关键词

- 能力实现集中在 `CardAbilitySystem.ts`，能力名 → 实现在 `CARD_ABILITY_MAP`
- 关键词判定在 `CardKeywordSystem.ts`
- 说明文案与高亮词表在 `CardTipData.ts`（关键字说明表 `TIP_KEYWORD_DESC`）

---

## 7. 素材规范

- **卡框**：`assets/image/cards/frame/` 放原图（勿覆盖），战场版在 `BattleField/`
- **无 alpha 的 PNG** 会被 Cocos 导成 `texture` 而不是 `spriteFrame`，
  这种图挂不到 `cc.Sprite` 上 —— 需要给对应 `.meta` 补上 spriteFrame 子资源
- **发光 / 光球类素材**通常是「黑底灰度、无 alpha」：先批量转成
  `RGB=白 + A=原亮度` 的 RGBA，再转 spriteFrame。这样既能被节点色染色，
  也能在加色（ADD）混合下当纯亮度用
- **运行时加载的素材（含 effect）必须放在 `assets/resources/`**，
  否则会被构建裁剪掉；加载图片子资源时路径要带 `/spriteFrame` 后缀
- 加色发光材质的参数为 `blendSrc: src_alpha` / `blendDst: one`；
  多层叠加时把 `intensity` 压到 1 以下，否则容易叠成纯白

---

## 8. 开发须知（容易踩的坑）

- 🔴 **不要用文本编辑器直接改 `.scene` / `.prefab` / `.anim` / `.meta`**：
  里面是 UUID 引用，手改极易损坏；请一律在 Cocos 编辑器里操作。
- 🔴 **场景是配置的唯一事实来源**：改 `@property` 的**类默认值对已序列化的实例无效**，
  必须改场景里组件实例的值并保存。
- 🔴 **保存后要回读验证**：文件 mtime / 体积 + 搜索关键名，别只看编辑器不报错。
- 🔴 补间（tween）回调里的异常会被引擎吞掉 —— 回调统一 `try/catch/finally`。
- 🔴 复用节点前先 `Tween.stopAllByTarget(target)`：补间没跑完就 `active=false`，
  下次激活会先把上次结束姿态写进起始帧（表现为「隔次出现」的怪 bug）。
- 🔴 运行时 `addComponent` 出来的组件永远是类默认值（没有序列化覆盖）。
- 层级 z 序统一走 `LayerOrder.raiseLayer / releaseLayer`（引用计数）。
- 交互跟随视觉：谁渲染在上层谁赢输入，被盖住的区域不应响应下层点击。

---

## 9. 关于本仓库

仓库里**只保留能构建、能继续开发**的工程本体：

**会提交**：`assets/`、`settings/v2/packages/`、`package.json`、`tsconfig.json`、
`.creator/`、本文档。

**不提交**（见 `.gitignore`）：

| 类别 | 内容 |
| --- | --- |
| 生成物 | `library/`、`temp/`、`build/`、`profiles/`、`local/`、`native/`（编辑器会自动重建） |
| 临时 / 中间文件 | 各种 `*.log / *.tmp / *.bak / *.err`、根目录下的卡图处理中间产物 |
| 场景快照 | `assets/*.before_*.scene`（开发时"改前留一手"的副本，代码中无引用） |
| AI 辅助开发 | Agent 工作区、AI 约定文件、MCP 工具链与其配置 |
| 敏感信息 | `*.key / *.pem / *.env / credentials*.json` 等（任何情况下都不进仓库） |

**只克隆仓库后如何跑起来**：用 Cocos Creator 3.8.8 打开本目录 → 编辑器自动生成
`library/ temp/` → 打开 `assets/MainMenu.scene` 预览即可。
