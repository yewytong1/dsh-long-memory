# dsh-long-memory

给 [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/guide/quickstart) 加一套**跨会话长期记忆**：每轮自动挑几条相关记忆塞进 prompt，久了会按强度衰减，记得越多对"对话者是谁"的印象越准。

零外部依赖、零 API 调用、全本地 SQLite。带一个只读的「记忆星图」面板，看得见记忆库长什么样。

> 一句话定位：**工程可控性优先的确定性记忆**——不靠向量、不靠模型抽取，靠作用域 + 用途 + 衰减 + 状态机，行为可预测、可解释、可回滚。

---

## 为什么做这个

市面上的记忆方案大致三派：

| 流派 | 典型做法 | 问题 |
|---|---|---|
| 向量 + LLM 抽取 | 写入时让模型判断增删改，读时向量召回 | 每次写要调模型（钱 + 延迟），同一条信息两次跑出不同结果，难调试 |
| 图记忆 | 抽实体关系建图 | 重，抽取质量决定一切，小规模场景过度设计 |
| 分层 / 仿生 | 分短中长记忆 + 遗忘曲线 | 预算可控，但多数是"按条数/时间"粗粒度遗忘 |

这套插件取第三条的**预算分层**、第一条的**确定性检索**（BM25，不调模型），再加两样自己的东西：**作用域**（按线筛，避免串味）和**用途轴**（决策/约束永驻，事实按需）。

---

## 特性

- **作用域**：`world`（你这个人，永远注入）/ `topic:学习`、`topic:工具`、`topic:装机` / `file:<文件名>`。会话碰过哪个文件、聊过哪条线，才看得见那条线的记忆
- **用途轴**：`constraint` 硬约束 / `decision` 已定决策 / `preference` 协作偏好 / `fact` / `task` / `lesson`
- **两档注入**：常驻卡（约束+决策+偏好，硬顶 350 字）+ 按需检索（其余），总预算 700 字，放不下整条丢、不留半句
- **连续衰减**：强度 → 半衰期 → 保留度 `R = 0.5^(天数/半衰期)`；衰减到底自动归档（软删，可捞回）
- **印象模型**：证据按**会话**计数、加权递减、45 天半衰期；同一维度出现两面时输出「有时 A，有时 B」，不塌成一个人格
- **订正留痕**：`memory_correct` 把旧条目标 `superseded` 保留、新内容另存，历史可追溯
- **BM25 检索**：中文二元组 + 英文分词，罕见词权重高，短记忆不被长记忆稀释
- **防护**：噪声/回声/碎片过滤、近似去重、超长截断、`{{` 转义（防宿主模板注入把整轮请求打挂）
- **星图面板**：自包含 HTML，双击即开，不启服务、不联网

---

## 安装

```bash
# 方式一：插件管理器（推荐）
dsh plugin add dsh-long-memory

# 方式二：手动放进 profile
# 把本仓库放到 ~/.dsh/profiles/<profile>/node_modules/dsh-long-memory
# 并在 profile 的 cordis.patch.yml 里 insert 一行（见下）
```

`cordis.patch.yml` 会被包内的 `cordis.patch.yml` 自动应用：

```yaml
- insert:
    - id: long-term-memory
      name: 'dsh-long-memory'
      config:
        maxChars: 700      # 每轮注入总预算
        topK: 6            # 最多几条
        pinnedChars: 350   # 常驻卡字数顶
        pinnedMax: 4       # 常驻卡最多几条
        taskMax: 3         # 「进行中的事」最多几条
```

> `engines.dsh` 已按 DSH 0.2.x 的 rc 版本串声明；宿主版本不匹配时会被拒绝加载（这是预期行为）。

---

## 工具

| 工具 | 作用 |
|---|---|
| `memory_recall` | 检索，带 `why`（分数怎么算的、什么状态），支持按 `scope` / `kind` 过滤、`includeSuperseded` 追历史 |
| `memory_remember` | 手动记一条，可指定 `kind` / `scope` / `importance` |
| `memory_correct` | 订正：旧条目转 `superseded`，新内容另存 |
| `memory_forget` | 软删（归档），不物理删除 |
| `memory_impression` | 看当前印象：置信度、证据条数、对立次数 |
| `memory_review` | 盘点：条数、用途分布、按保留度排序 |
| `task_update` / `task_list` | 跨会话的「进行中的事」 |

---

## 算法

```
强度      S0 = 1 + 3×重要度 + 2×情绪            (1~6)
复述加成   S  = S0 × (1 + 0.6×ln(1+次数))        (log 增长，不膨胀)
半衰期     H  = 3 天 × S                          (5.4 ~ 35 天)
保留度     R  = 0.5^(距上次提起天数 / H)
检索分     score = 0.45×R + 0.30×重要度 + 0.25×BM25相关度
           （再叠同标签多样性惩罚，防一次注入全是同一件事）
归档        R < 0.05 且 重要度 < 0.4 → 软删
```

印象：

```
命中   c ← c + w×(1-c)，w = 0.3 / (1 + (n-1)×0.25)   n = 证据条数
去重   同一会话重复说不重复计数（证据按会话 id 去重）
衰减   距上次观察 45 天，置信度折半（读时计算，不回写）
反证   c ← c×0.5，不清零
```

---

## 数据

默认库：`~/.dsh/long-term-memory/memory.sqlite`（`node:sqlite`，Node ≥ 22.5；没有则自动降级内存模式，不影响宿主启动）。

| 表 | 作用 |
|---|---|
| `memories` | 记忆本体：正文、用途、作用域、重要度、情绪、提及次数、时间、状态、归档位 |
| `impressions` | 印象：维度 + 取值 + 置信度 + 证据数 + 来源集合 |
| `bindings` | 会话 → 作用域绑定（谁碰过哪条线） |
| `tasks` | 进行中的事（标题唯一） |
| `meta` | 一次性迁移标记、最近一句话 |

老库自动迁移：缺列补列、印象表主键升级、历史记忆按正文重新分线/分用途，全部幂等。

---

## 记忆星图

只读面板，生成一个自包含 HTML（内联 SVG，无外部请求）：

```bash
node scripts/build-panel.mjs      # 产物 out/panel.html
```

- 星群 = 作用域，星越大越重要，越亮越新鲜，虚线空心 = 已归档，悬停看原文
- 附「本轮会注入什么」（含预算条和最终注入原文）、记忆表、印象表、会话绑定、进行中的事

Windows 上可双击 `记忆星图.cmd`（生成 + 用 Edge/Chrome 打开，不依赖 `.html` 关联）。

---

## 开发

```bash
npm test        # 全部测试（core / store / plugin，共 70 条）
```

**不需要先 `npm install`。** 插件零运行时依赖；`src/index.js` 只 import 了一个宿主包 `@deepseek-ai/dsh-tools`，测试时会由 `tests/register-stub.mjs` 提供的桩顶上，所以干净克隆直接能跑。

```
src/core.js               算法核心（纯函数，零依赖，可单测）
src/store.js              SQLite 落盘 + 迁移（缺 node:sqlite 自动降级内存）
src/index.js              宿主端：注入 + 采集 + 工具注册
tests/register-stub.mjs   测试钩子：宿主包缺失时用桩解析
tests/helpers/            桩实现
scripts/ab-real.mjs       拿真实记忆库做检索 A/B（读 DSH_HOME）
scripts/build-panel.mjs   星图面板生成
scripts/backup-db.mjs     改结构前的一致性快照（VACUUM INTO）
sync-to-profile.ps1       改了源码后同步到 profile（file: 依赖是拷贝，不是链接）
```

### 改完源码不生效？

`package.json` 里的 `file:` 依赖在安装时是**复制**，不是建链接。所以你改了 `projects\dsh-long-memory\src\`，宿主加载的 `~/.dsh/profiles/<profile>/node_modules/dsh-long-memory/src/` 还是旧的，重启也没用（`why` 字段里的权重还是老值）。改完跑一次：

```powershell
pwsh -File sync-to-profile.ps1              # 同步
pwsh -File sync-to-profile.ps1 -CheckOnly   # 只看差异不动手
```

然后**完全退出 DSH 再打开**。脚本会自动备份旧副本到 `.sync-backup\<时间戳>`（已在 .gitignore 里）。

---

## 已知限制（诚实版）

- **没有向量/语义检索**：换个说法就找不到（"摄像头打不开" vs "VideoCapture 报错"）。作用域能挡串味，挡不住同义改写。下一步最划算的是加本地 embedding 做第二路召回 + RRF
- **规则抽取召回低**：只有命中关键词的句子才进库，隐含表达会漏
- **单用户假设**：没有"谁说的"这个维度
- **规模上限**：每轮全表扫描，几百到几千条没问题，上万条需要索引层
- **不做自动建任务**：试过把判成 task 的发言自动写成任务，结果每句"我想…"都进了交接卡片——现在只认显式调用
- **检索门槛偏严**：`minTermCoverage = 0.3` 意味着查询词至少命中三成，改写/近义词查询会返回空。宁可空也不塞噪音，这是有意的取舍（见 CHANGELOG 0.5.1）

---

## License

MIT
