/**
 * core.js —— 长时记忆插件（dsh-long-memory）的算法核心
 *
 * 设计目标：
 *   1. 长时记忆：跨会话保留，不是"这轮聊了什么"的摘要
 *   2. 多因素影响：重要度、情绪强度、复述次数、时间、内容相关度共同决定一条记忆的"存活"
 *   3. 记忆衰减：不是一刀切过期，而是按"强度 → 半衰期 → 指数遗忘"逐条算
 *   4. 印象更新：记忆越攒越多，对对话者的印象不是重写，而是**证据累积 + 置信度收敛**
 *
 * 这个文件不依赖 DSH，纯函数 + 一个小类，方便单测（node --test 直接跑）。
 * 刻意不引用任何第三方包：只为了将来放进插件时不会拖依赖。
 */

// ---------------------------------------------------------------------------
// 一、可调参数（全部集中在这里，改参只改这一段）
// ---------------------------------------------------------------------------
export const DEFAULTS = {
  // 强度 → 半衰期：halfLife = baseHalfLifeDays * strength
  baseHalfLifeDays: 3,
  // 强度是怎么来的：S0 = 1 + impW*importance + emoW*emotion（范围 1~6）
  impW: 3,
  emoW: 2,
  // 每被复述一次，强度按 log 增长：S = S0 * (1 + hitW*ln(1+hits))
  hitW: 0.6,
  // 检索打分权重（和必须为 1）
  // 2026-11-13 调整：原来是 0.45 / 0.3 / 0.25，实测搜"实习""OpenCV""UCPD"三组全没命中，
  // 四组不同查询返回的 6 条一模一样——importance 0.95 的常驻条目永远在头上，相关度只值 25 分，翻不动。
  // 现在相关度领跑，重要度和保留度降为加分项。Generative Agents 用三项等权（α 都取 1.0），
  // 但那边没有"常驻硬约束"的概念，这里保留 0.2 的重要度兜底，防止口吻/底线类记忆被随机旧事实顶掉。
  wRetention: 0.3,
  wImportance: 0.2,
  wRelevance: 0.5,
  // 相关度低于这个值就不算命中（0 表示不设门槛，回到"永远凑满 k 条"的旧行为）
  minRelevance: 0.05,
  // 查询词覆盖率门槛：查询里的词有多少比例必须真的出现在这条记忆里。
  // 与语料规模无关，比 BM25 绝对分数稳定（见 termCoverage 注释）。
  // 0.3 ≈ 三个查询词至少命中一个；单个词的查询（阈值退化）由 minRelevance 兜底。
  minTermCoverage: 0.3,
  // 进入候选 / 归档的门槛
  candidateRetention: 0.15,
  archiveRetention: 0.05,
  archiveImportance: 0.4,
  // 去重：字符二元组 Jaccard 超过阈值视为同一件事；
  // 另外"包含度"超过 dupContainment 也算（同一段话被补了一行的情况，Jaccard 会掉到 0.62 但包含度 0.9）
  dupThreshold: 0.82,
  dupContainment: 0.85,
  // 印象：一次证据的权重 / 反证的衰减系数 / 置信度上限
  evidenceWeight: 0.3,
  // 证据多了之后每次加权的衰减：第 n 条证据的权重 = evidenceWeight / (1 + (n-1) * evidenceDamp)
  // 不衰减的话第 3 次就到 66%、第 8 次钉死 95%，四个维度全是 95%，等于没信息
  evidenceDamp: 0.25,
  // 同一会话里重复说同一特征，权重再砍到这个比例（算确认，不算新证据）
  sameSessionWeight: 0.25,
  // 印象也会忘：距上次观察超过这个天数，置信度按半衰期折半（只在读的时候算，不回写）
  impressionHalfLifeDays: 45,
  // 低于这个置信度就不往 prompt 里写了
  retireConfidence: 0.15,
  contradictFactor: 0.5,
  maxConfidence: 0.95,
  // 印象输出上限（条数）
  maxImpressionLines: 6,
  // 常驻卡：只放"硬约束 / 已定决策 / 协作偏好"，按字数硬顶，不和普通记忆抢预算
  pinnedChars: 350,
  pinnedMax: 4,
}

const DAY_MS = 24 * 3600 * 1000

// ---------------------------------------------------------------------------
// 二、单条记忆的强度、半衰期、保留度
// ---------------------------------------------------------------------------

/** 基础强度 S0：越重要、情绪越强，起步越"结实" */
export function baseStrength(mem, cfg = DEFAULTS) {
  const imp = clamp01(mem.importance ?? 0)
  const emo = clamp01(mem.emotion ?? 0)
  return 1 + cfg.impW * imp + cfg.emoW * emo
}

/** 当前强度：基础强度 × 复述加成（log 增长，反复出现不会无限膨胀） */
export function strengthOf(mem, cfg = DEFAULTS) {
  const hits = Math.max(0, mem.hits ?? 0)
  return baseStrength(mem, cfg) * (1 + cfg.hitW * Math.log(1 + hits))
}

/** 半衰期（天）：强度 4.3 的"重要+伤心"记忆 ≈ 13 天掉一半 */
export function halfLifeDays(mem, cfg = DEFAULTS) {
  return cfg.baseHalfLifeDays * strengthOf(mem, cfg)
}

/** 保留度 R ∈ (0,1]：0.5 ^ (经过天数 / 半衰期) */
export function retention(mem, now = Date.now(), cfg = DEFAULTS) {
  const last = mem.lastHitAt ?? mem.createdAt ?? now
  const days = Math.max(0, (now - last) / DAY_MS)
  const h = halfLifeDays(mem, cfg)
  if (h <= 0) return 0
  return Math.pow(0.5, days / h)
}

/** 是否该归档（软删除，不物理删；重要度高的永远留着） */
export function shouldArchive(mem, now = Date.now(), cfg = DEFAULTS) {
  return (
    retention(mem, now, cfg) < cfg.archiveRetention &&
    (mem.importance ?? 0) < cfg.archiveImportance
  )
}

/**
 * 把衰减到线的记忆批量转成归档（软删除）。
 *
 * 之前 shouldArchive() 只被单测调用、插件里一次没调过：记忆只会进 prompt 前被过滤掉，
 * `archived` 永远是 false，库只涨不落。这个函数是把它接上主循环的那一步。
 * 幂等：已经归档的跳过，返回的 archived 只含这次真正翻牌的那些（调用方拿它落盘即可）。
 *
 * @returns {{list: object[], archived: object[]}}
 */
export function sweepArchive(list, now = Date.now(), cfg = DEFAULTS) {
  const archived = []
  let changed = false
  const next = list.map((m) => {
    if (m.archived) return m
    if (!shouldArchive(m, now, cfg)) return m
    const hit = { ...m, archived: true, archivedAt: now }
    archived.push(hit)
    changed = true
    return hit
  })
  return { list: changed ? next : list, archived }
}

// ---------------------------------------------------------------------------
// 三、注意力调度：一次请求只往 prompt 里塞最有用的几条
// ---------------------------------------------------------------------------

/**
 * 单条记忆的检索分。
 * @param {object} mem 记忆
 * @param {number} relevance 内容相关度 0~1（关键词命中率，将来可换 embedding 余弦）
 */
export function retrievalScore(mem, now = Date.now(), relevance = 0.5, cfg = DEFAULTS) {
  const r = retention(mem, now, cfg)
  const imp = clamp01(mem.importance ?? 0)
  const rel = clamp01(relevance)
  return cfg.wRetention * r + cfg.wImportance * imp + cfg.wRelevance * rel
}

/** 检索分的三项拆开，用来回答"为什么这条被捞出来" */
export function scoreParts(mem, now = Date.now(), relevance = 0.5, cfg = DEFAULTS) {
  const r = retention(mem, now, cfg)
  const imp = clamp01(mem.importance ?? 0)
  const rel = clamp01(relevance)
  return {
    retention: Number(r.toFixed(3)),
    importance: Number(imp.toFixed(3)),
    relevance: Number(rel.toFixed(3)),
    total: Number((cfg.wRetention * r + cfg.wImportance * imp + cfg.wRelevance * rel).toFixed(3)),
  }
}

/**
 * 取 top-k 记忆。带"多样性惩罚"（MMR 的简化版）：
 * 同一 tag 的第三条会被压一点分，防止一次注入全是同一件事。
 *
 * 已被订正（superseded）的条目不参与默认检索——它留在库里只为追溯"当时为什么那么定"。
 * 需要看历史时传 includeSuperseded: true。
 */
export function recall(memories, now = Date.now(), opts = {}) {
  const cfg = opts.cfg ?? DEFAULTS
  const k = opts.k ?? 6
  const relevanceOf = opts.relevanceOf ?? (() => 0.5)
  const diversity = opts.diversity ?? 0.15
  const includeSuperseded = opts.includeSuperseded === true
  // 相关度门槛：显式传 relevanceOf 才算"在查东西"。
  // opts.query 用来区分「查了一次、但关键词没命中（返回空是正确行为）」和
  // 「压根没传查询、只是按重要度取几条（不该过滤）」——注入路径就是后者，不能误杀。
  const hasQuery = typeof opts.relevanceOf === 'function'
  const isSearch = hasQuery && opts.query !== false
  // 门槛按 termCoverage 判定（与语料规模无关），而不是 BM25 绝对分数。
  // opts.relevanceOf 仍用于排序打分，两者分工：打分看 BM25，门槛看覆盖率。
  const minCoverage = opts.minCoverage ?? (isSearch ? cfg.minTermCoverage : 0)
  const coverageOf = typeof opts.coverageOf === 'function' ? opts.coverageOf : null
  const onlyTags = opts.kinds ? new Set(opts.kinds) : null
  // 作用域过滤：给了 allowedScopes 就只在这个会话的线里取（world 永远算在内）
  const allowed = opts.scopes ? new Set(opts.scopes) : null
  const scopeOk = (m) => !allowed || m.scope === 'world' || allowed.has(m.scope)
  // 没有 coverageOf 时退回旧行为（只按 relevanceOf 过滤），避免不传覆盖率的调用被全灭
  const passGate = (m) =>
    coverageOf ? coverageOf(m) >= minCoverage : clamp01(relevanceOf(m)) >= 1e-9

  const pool = memories
    .filter((m) => !m.archived)
    .filter((m) => includeSuperseded || m.status !== 'superseded')
    .filter((m) => !onlyTags || onlyTags.has(m.kind))
    .filter(scopeOk)
    .filter((m) => retention(m, now, cfg) >= cfg.candidateRetention)
    .filter((m) => (isSearch ? passGate(m) : true)) // 不相关的硬过滤掉，宁可返空也不硬凑
    .map((m) => {
      const rel = clamp01(relevanceOf(m))
      return { mem: m, base: retrievalScore(m, now, rel, cfg), rel }
    })
    .sort((a, b) => b.base - a.base)

  const picked = []
  const tagSeen = new Map()
  const used = new Set()

  while (picked.length < k && used.size < pool.length) {
    let best = null
    let bestScore = -Infinity
    for (const item of pool) {
      if (used.has(item.mem.id)) continue
      const tags = item.mem.tags ?? []
      let penalty = 0
      for (const t of tags) {
        const c = tagSeen.get(t) ?? 0
        if (c > 0) penalty += diversity * c
      }
      const s = item.base - penalty
      if (s > bestScore) {
        bestScore = s
        best = item
      }
    }
    if (!best) break
    used.add(best.mem.id)
    picked.push({ ...best, score: bestScore })
    for (const t of best.mem.tags ?? []) tagSeen.set(t, (tagSeen.get(t) ?? 0) + 1)
  }
  return picked
}

// ---------------------------------------------------------------------------
// 四、写入侧：从一句话里抽候选记忆 + 去重合并
// ---------------------------------------------------------------------------

const RULES = [
  // 偏好：说"我不喜欢…"时，句子里并没有"我喜欢"三个连续字，所以要把"不"分开写
  { re: /(喜欢|不喜欢|不爱|讨厌|习惯|受不了|一律|永远|别给我|不要给|偏好)/, kind: 'preference', importance: 0.75, tags: ['偏好'] },
  { re: /(我的?目标|计划|打算|截止|准备|想(要|做|学|去)|要(投|做|学|考|写|去)|实习|简历|面试)/, kind: 'goal', importance: 0.7, tags: ['目标'] },
  { re: /(我在|我是|我叫|我有|我住|我读|我做)/, kind: 'fact', importance: 0.55, tags: ['事实'] },
  { re: /(累|烦|焦虑|难受|开心|爽|无语|崩溃|失望|惊喜)/, kind: 'emotion', importance: 0.6, emotion: 0.7, tags: ['情绪'] },
  { re: /(记住|重要|一定|千万|底线|必须)/, kind: 'fact', importance: 0.85, tags: ['强调'] },
]

/**
 * 从一句用户话里抽 0~1 条候选记忆。
 * 规则很土但可解释、可调；以后接 LLM 抽取时，这个函数就是"兜底"。
 * @returns {object|null} 候选记忆（未入库，无 id）
 */
export function extractCandidate(text, now = Date.now(), cfg = DEFAULTS) {
  const t = String(text ?? '').trim()
  if (t.length < 6) return null

  // 纯提问、纯寒暄不当记忆
  const isQuestion = /[?？]$/.test(t) || /^(什么|怎么|为什么|哪|吗|呢)/.test(t)
  const isGreeting = /^(你好|在吗|嗨|hi|hello|早|晚安)/i.test(t) && t.length < 12
  if (isGreeting) return null

  let best = null
  for (const rule of RULES) {
    if (!rule.re.test(t)) continue
    if (!best || rule.importance > best.importance) {
      best = {
        text: t,
        kind: rule.kind,
        importance: rule.importance,
        emotion: rule.emotion ?? 0.2,
        tags: [...rule.tags],
        createdAt: now,
        lastHitAt: now,
        hits: 0,
        archived: false,
      }
    }
  }

  if (!best) {
    // 没命中规则：长句 / 含具体信息的句子降级为低重要度事实
    if (t.length < 20 || isQuestion) return null
    best = {
      text: t,
      kind: 'fact',
      importance: 0.35,
      emotion: 0.1,
      tags: ['杂项'],
      scope: classifyScope(t),
      createdAt: now,
      lastHitAt: now,
      hits: 0,
      archived: false,
    }
  }

  // 微调：越长越具体，稍微重要一点；提问口气，降一点
  if (t.length > 40) best.importance = clamp01(best.importance + 0.1)
  if (isQuestion) best.importance = clamp01(best.importance - 0.25)
  if (!best.scope) best.scope = classifyScope(t)
  return best
}

// ---------------------------------------------------------------------------
// 三点五、作用域：这条记忆属于哪条线
//
// 为什么要有：所有记忆堆一个池子时，取记忆只能靠"新 + 重要"，而相关性算法（字符 bigram）
// 在中文长句上算出来全是 0.00x —— 等于随机。结果是问摄像头的时候，注入里混着 D 盘清理和
// 三角洲。作用域是**先按线筛，再按分排**，从结构上不串味。
//
//   world      关于"你这个人"的长期事实（称呼、口吻、底线、沟通偏好）——永远注入
//   topic:名   一条长期线（学习 / 工具 / 装机 / 杂）——本会话聊到才注入
//   file:名    某个文件/工程——本会话碰过才注入
// ---------------------------------------------------------------------------

/** 从一句话里认出被提到的文件（只为绑定作用域，不做路径解析） */
export function detectFileMention(text) {
  const t = String(text ?? '')
  // 不吞空格：宁可只认出 "report.docx" 这一截（路径带空格时），也不要连前面的中文一起吃掉
  const re = /[^\s"'`<>|（）()，。；：]+\.(py|mjs|cjs|js|ts|tsx|json|md|ya?ml|cpp|cc|c|h|hpp|ps1|cmd|bat|txt|csv|docx|xlsx|pptx|sqlite|db)\b/gi
  const hits = [...t.matchAll(re)]
  if (hits.length === 0) return null
  // 一句话里点了两个以上文件（"a.md 也写入 b.md"），分不清要绑哪个 → 不绑
  if (hits.length > 1) return null
  const base = hits[0][0].split(/[\\/]/).pop()
  if (!base || base.length < 3 || base.length > 40) return null
  if (/[*?]/.test(base)) return null // 通配符指的不是某一个文件
  // 没有空格的中文会把两个文件粘成一个（"a.md也写入b.md中"），
  // 一个"文件名"里出现两个扩展名就说明粘了，宁可不绑
  if ((base.match(/\.(py|mjs|cjs|js|ts|tsx|json|md|ya?ml|cpp|cc|c|h|hpp|ps1|cmd|bat|txt|csv|docx|xlsx|pptx|sqlite|db)\b/gi) ?? []).length > 1) return null
  return base
}

/**
 * 给一条记忆判作用域。规则式、可解释、改起来就改这一段。
 * 顺序很重要：先认"关于人"的（世界层），再认文件，最后才是话题。
 */
export function classifyScope(text) {
  const t = String(text ?? '')

  // 世界层：说的是"怎么跟你说话/你的底线"，换哪个话题都成立。
  // 注意别把"人设"单独当世界层：讨论人设的改法（"两条人设的 Jaccard 只有 0.62"）是工程话题。
  if (/(称呼|叫我|别叫|口吻|语气|说话方式|措辞|口癖)/.test(t)) return 'world'
  if (/(底线|隐私|绝不|严禁|永远不要|不能泄露|红线)/.test(t)) return 'world'
  if (/(我不?喜欢|我不?爱|我讨厌|我习惯|我受不了|别给我|不要给|偏好|一上来就)/.test(t)) return 'world'

  // 文件线：句子里点了名，就绑到那个文件
  const file = detectFileMention(t)
  if (file) return `file:${file}`

  // 话题线（顺序：学习 → 工具 → 装机，最后兜到杂）
  if (/(OpenCV|cv2|摄像头|人脸|表情|关键点|帧率|帧数|学习|实习|简历|面试|课程|实验报告|作业|考试|路线|刷题|笔试|MATLAB|matlab)/i.test(t)) {
    return 'topic:学习'
  }
  if (/(插件|记忆|DSH|知识库|脚本|代码|接口|配置|报错|函数|仓库|sqlite|prompt|重启|日志|单测|迁移|表结构|工具|文件|路径|git|Python|python)/i.test(t)) {
    return 'topic:工具'
  }
  if (/(磁盘|卸载|安装|驱动|软件|空间|清理|C盘|D盘|显卡|显存|游戏|三角洲|VALORANT|Steam|steam)/i.test(t)) {
    return 'topic:装机'
  }
  return 'topic:杂'
}

// ---------------------------------------------------------------------------
// 三点六、用途轴：这条记忆是"用来干嘛的"
//
// 作用域回答"跟谁走"（world/topic/file），用途回答"什么时候该被看见、能不能丢"：
//   constraint 硬约束——永远进常驻卡，不按天数沉底
//   decision   已定决策——进常驻卡，不按天数沉底（项目周期决定寿命，不由天数决定）
//   preference 协作偏好——进常驻卡
//   fact       环境/配置事实——按需检索，会随天数沉底
//   task       任务状态——按需检索
//   lesson     踩坑教训——按需检索
// ---------------------------------------------------------------------------

export const USE_TAGS = ['constraint', 'decision', 'preference', 'fact', 'task', 'lesson']

/** 常驻卡只放这三类 */
export const PINNED_KINDS = ['constraint', 'decision', 'preference']

/**
 * 判用途。顺序即优先级：约束 > 决策 > 教训 > 任务 > 偏好 > 事实。
 * @param {string} text
 * @param {string} [hint] 旧 kind（decision 这种从助手回复里抽出来的，别被正文规则冲掉）
 */
export function classifyUse(text, hint) {
  const t = String(text ?? '')
  if (/(底线|隐私|绝不|严禁|禁止|不允许|不能泄露|红线|必须遵守|必须做到|只能|不准)/.test(t)) return 'constraint'
  if (/(决策|改用|换成|改成|结论是|正确做法|应该用|不要用|否决|定下来|就这么定|方案 ?[AB])/.test(t)) return 'decision'
  if (/(教训|踩坑|坑在|根因|根本原因|下次|别再|差点|翻车|实测)/.test(t)) return 'lesson'
  if (/(目标|计划|打算|截止|待办|下一步|进度|要做到|这周|本周)/.test(t)) return 'task'
  if (/(称呼|口吻|语气|说话方式|措辞|喜欢|讨厌|习惯|偏好|别给我|不要给|先给结论|说人话)/.test(t)) return 'preference'
  if (hint === 'decision') return 'decision'
  if (hint === 'goal') return 'task'
  if (hint === 'preference') return 'preference'
  return 'fact'
}

/** 这条用途该不该进常驻卡 */
export function isPinnedKind(kind) {
  return PINNED_KINDS.includes(kind)
}

/**
 * 看起来像我汇报里的清单碎片（"1. **时段**…"、表格行、加粗小标题），不是一条能独立站住的结论。
 * 这些进常驻卡最亏：占最贵的预算，还长得像决策。
 */
export function looksLikeFragment(text) {
  const s = String(text ?? '').trim()
  if (!s) return true
  if (/^\d+[.、)]/.test(s)) return true // 编号条目
  if (/\*\*/.test(s)) return true // markdown 加粗
  if (/^\|/.test(s)) return true // 表格
  if (/^(以下是|上面|下面|其中|另外|顺便|补充|总结：)/.test(s)) return true
  if (/^vs\s|→|×|=\s*0\.\d+/.test(s)) return true // 命令输出/对照表碎片（"vs 噪声过滤 … → 0.000"）
  if (/^[\d.%~\s]+$/.test(s)) return true // 纯数字行
  return false
}

/** 注入时给人的短标签：world 不标，topic:学习 → 学习，file:x.py → x.py */
export function scopeLabel(scope) {  const s = String(scope ?? '')
  if (!s || s === 'world') return ''
  return s.replace(/^topic:/, '').replace(/^file:/, '')
}


/** 字符二元组集合（中文没有空格，按 bigram 比最稳，且不需要分词库） */
export function bigrams(text) {
  const s = String(text ?? '').replace(/\s+/g, '')
  const set = new Set()
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2))
  if (s.length === 1) set.add(s)
  return set
}

// ---------------------------------------------------------------------------
// 三点七、BM25 检索
//
// 之前的相关度是"整句 bigram Jaccard"：中文长句对长句普遍 0.00x（实测过），排序等于抛硬币。
// BM25 不同：它算的是"查询里的词在这条记忆里出现得有多稀罕、多密集"，
// 短记忆不会被长记忆稀释，罕见词（"摄像头""SQLite"）会顶上来。零依赖，纯本地算。
// ---------------------------------------------------------------------------

const CJK = /[\u4e00-\u9fa5]/
const TOKEN_SPLIT = /[^a-z0-9\u4e00-\u9fa5]+/

/**
 * 切词：英文/数字按词切，中文按二元组切（不分词库的折中）。
 * @returns {string[]} 词列表（有重复，供 TF 用）
 */
export function tokenize(text) {
  const out = []
  for (const chunk of String(text ?? '').toLowerCase().split(TOKEN_SPLIT)) {
    if (!chunk) continue
    if (!CJK.test(chunk)) {
      out.push(chunk)
      continue
    }
    // 中文块：整块 + 二元组（单字块就用单字）
    if (chunk.length === 1) out.push(chunk)
    for (let i = 0; i < chunk.length - 1; i++) out.push(chunk.slice(i, i + 2))
  }
  return out
}

/**
 * BM25 打分（Robertson/Sparck-Jones，参数用常见默认 k1=1.2, b=0.75）。
 * @param {{id?:any, text:string}[]} docs
 * @param {string} query
 * @returns {Map<any, number>} id → 归一化到 0~1 的分数（除以本次最高分）
 */
export function bm25Scores(docs, query, opts = {}) {
  const k1 = opts.k1 ?? 1.2
  const b = opts.b ?? 0.75
  const qTokens = [...new Set(tokenize(query))]
  const scores = new Map()
  if (docs.length === 0 || qTokens.length === 0) return scores

  const tfs = docs.map((d) => {
    const tokens = tokenize(d.text)
    const tf = new Map()
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1)
    return { id: d.id, tf, len: tokens.length || 1 }
  })
  const avgLen = tfs.reduce((a, x) => a + x.len, 0) / tfs.length
  const N = tfs.length

  for (const q of qTokens) {
    // 文档频率：多少条记忆里出现过这个词
    let df = 0
    for (const d of tfs) if (d.tf.has(q)) df++
    if (df === 0) continue
    const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5))
    for (const d of tfs) {
      const f = d.tf.get(q) ?? 0
      if (f === 0) continue
      const denom = f + k1 * (1 - b + (b * d.len) / avgLen)
      scores.set(d.id, (scores.get(d.id) ?? 0) + idf * ((f * (k1 + 1)) / denom))
    }
  }

  let max = 0
  for (const v of scores.values()) if (v > max) max = v
  // 归一化到 max（最高分 = 1.0）。
  // 2026-11-13：中途试过 1-exp(-v/k) 的饱和归一化，后来撤了——不是因为"除以 max 是缺陷"，
  // 而是因为下游 minScore / minRelevance 门槛的语义建立在"最高分 = 1.0"之上
  // （Elasticsearch RRF、Qdrant、Weaviate 的 score contract 都是先 normalize-to-max 再过阈值）。
  // 最高分不到 1，阈值就没有可比性。区分度的问题交给 termCoverage 和权重解决，不在这里改。
  if (max > 0) for (const [k, v] of scores) scores.set(k, v / max)
  return scores
}

/**
 * 词覆盖率：查询词里有多少比例真的出现在这条记忆里。
 *
 * 为什么不直接用 BM25 分数做门槛：BM25 是绝对分数，会随语料条数和 IDF 漂移，
 * 换个库、加几条记忆，同一个阈值就失效。term coverage 只问"查询里的词命中了几成"，
 * 与语料规模无关，天然可做固定阈值。（参考 fare-policy-assistant 的 ADR 0013：
 * 绝对 BM25 阈值是陷阱，他们改用 term_coverage + z_score，其中只有 coverage 在小语料上真正起作用。）
 *
 * @returns {number} 0~1。查询词为空时返回 1（视为不过滤）。
 */
export function termCoverage(text, query) {
  const q = [...new Set(tokenize(query))]
  if (q.length === 0) return 1
  const doc = new Set(tokenize(text))
  let hit = 0
  for (const t of q) if (doc.has(t)) hit++
  return hit / q.length
}


/** 前 n 个字是否一致（判断"同一句话说第二遍"，不受后半截截断影响） */
export function sameHead(a, b, n = 24) {
  const x = String(a ?? '').replace(/\s+/g, '').slice(0, n)
  const y = String(b ?? '').replace(/\s+/g, '').slice(0, n)
  return x.length >= 8 && x === y
}

/**
 * 包含度：A 的 bigram 有多少比例出现在 B 里（除以较小的那个集合）。
 * 用来抓"同一段话，第二次多说了一行"——这种 Jaccard 只有 0.6，但明显是同一条。
 */
export function containment(a, b) {
  const A = bigrams(a)
  const B = bigrams(b)
  if (A.size === 0 || B.size === 0) return 0
  let inter = 0
  for (const x of A) if (B.has(x)) inter++
  return inter / Math.min(A.size, B.size)
}

/** 两条记忆是否算"同一件事"（开头一致，或包含度够高且都不算太短） */
export function isDuplicate(a, b, cfg = DEFAULTS) {
  if (sameHead(a, b, 24)) return true
  const shorter = Math.min(bigrams(a).size, bigrams(b).size)
  if (shorter < 12) return false // 太短的一句话不做包含度判断，否则"好的"会被吞掉
  return containment(a, b) >= cfg.dupContainment
}

/** Jaccard 相似度 0~1 */
export function similarity(a, b) {
  const A = bigrams(a)
  const B = bigrams(b)
  if (A.size === 0 || B.size === 0) return 0
  let inter = 0
  for (const x of A) if (B.has(x)) inter++
  return inter / (A.size + B.size - inter)
}

/**
 * 把候选并进已有记忆列表：相似就合并（算复述一次），否则新增。
 * 合并时重要度取大、情绪取大、文本保留更长的那个（信息更多）。
 * @returns {{list: object[], action: 'merged'|'added'|'skipped', target?: object}}
 */
export function consolidate(list, candidate, now = Date.now(), cfg = DEFAULTS) {
  if (!candidate) return { list, action: 'skipped' }
  let bestIdx = -1
  let bestSim = 0
  for (let i = 0; i < list.length; i++) {
    // 判定重复：开头一致 或 包含度够高（同一段话第二次多补了一行）
    if (isDuplicate(list[i].text, candidate.text, cfg)) {
      bestIdx = i
      bestSim = 1
      break
    }
    const sim = similarity(list[i].text, candidate.text)
    if (sim > bestSim) {
      bestSim = sim
      bestIdx = i
    }
  }

  if (bestIdx >= 0 && bestSim >= cfg.dupThreshold) {
    const old = list[bestIdx]
    const merged = {
      ...old,
      text: candidate.text.length > old.text.length ? candidate.text : old.text,
      importance: Math.max(old.importance ?? 0, candidate.importance ?? 0),
      emotion: Math.max(old.emotion ?? 0, candidate.emotion ?? 0),
      tags: uniq([...(old.tags ?? []), ...(candidate.tags ?? [])]),
      hits: (old.hits ?? 0) + 1,
      lastHitAt: now,
      archived: false,
    }
    const next = list.slice()
    next[bestIdx] = merged
    return { list: next, action: 'merged', target: merged }
  }

  const created = { ...candidate, id: nextId(list), hits: 0 }
  return { list: [...list, created], action: 'added', target: created }
}

/**
 * 合并历史遗留的重复条目（开头 24 字相同即视为同一条）：
 * 早期没有"开头捷径"时会重复入库，这里做一次规整，幂等，可以每次启动都跑。
 * 保留靠前的 id，复述次数相加，重要度/情绪取大，正文取更长的。
 */
export function compact(list, cfg = DEFAULTS) {
  const out = []
  for (const m of list) {
    const idx = out.findIndex((x) => isDuplicate(x.text, m.text, cfg))
    if (idx === -1) {
      out.push({ ...m })
      continue
    }
    const a = out[idx]
    out[idx] = {
      ...a,
      text: (m.text?.length ?? 0) > (a.text?.length ?? 0) ? m.text : a.text,
      importance: Math.max(a.importance ?? 0, m.importance ?? 0),
      emotion: Math.max(a.emotion ?? 0, m.emotion ?? 0),
      tags: uniq([...(a.tags ?? []), ...(m.tags ?? [])]),
      hits: (a.hits ?? 0) + (m.hits ?? 0),
      lastHitAt: Math.max(a.lastHitAt ?? 0, m.lastHitAt ?? 0),
      archived: !!(a.archived && m.archived),
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// 五、印象：证据累积，不重写；冲突保留，不塌陷
// ---------------------------------------------------------------------------

/**
 * 对对话者的印象。
 * 每条印象 = { trait, value, confidence, evidence, conflicts }
 *  - 命中证据：c' = c + w*(1-c)，**w 随证据数递减**（w = evidenceWeight / (1 + (n-1)*evidenceDamp)）
 *    → 前 3 次快速成形，之后慢慢爬；不会第 8 次就钉死 95%
 *  - 证据只按**会话**记：同一会话里说 10 遍同一特征只 +1 条证据（否则 95% 是"话多"换来的）
 *  - 读的时候按时间折半：距上次观察超过 impressionHalfLifeDays 天就掉一半，淡到阈值以下就不再注入
 *  - 反证：c' = c * (1-0.5) → 不是清零，是一半一半，允许人本来就有两面
 */
export class ImpressionModel {
  constructor(cfg = DEFAULTS) {
    this.cfg = cfg
    /** @type {Map<string, {trait:string,value:string,confidence:number,evidence:number,conflicts:number,updatedAt:number,lastSource?:string|null}>} */
    this.items = new Map()
  }

  key(trait, value) {
    return `${trait}::${value}`
  }

  /**
   * 记一条印象证据。
   * @param {string} trait 维度
   * @param {string} value 取值
   * @param {number} [now]
   * @param {string|null} [source] 证据来源（会话 id）；同一来源只算一条证据
   */
  observe(trait, value, now = Date.now(), source = null) {
    const k = this.key(trait, value)
    const cur = this.items.get(k)
    if (cur) {
      // 证据按来源去重：同一会话说十遍只算一条；重开宿主时同一批老会话也不会重复计数。
      // 同一个会话第二次及以后只刷新"最近一次见到"的时间，不再抬置信度——
      // 否则每次重启补捞本会话的老消息，都会给置信度偷偷加一截（实测两次重载就从 70% 爬到 95%）。
      const seen = Array.isArray(cur.sources) ? cur.sources : []
      const fresh = source == null || !seen.includes(source)
      if (!fresh) {
        cur.updatedAt = now
        return cur
      }
      const n = Math.max(1, cur.evidence ?? 1)
      const w = this.cfg.evidenceWeight / (1 + (n - 1) * this.cfg.evidenceDamp)
      cur.confidence = Math.min(this.cfg.maxConfidence, cur.confidence + w * (1 - cur.confidence))
      cur.evidence = (cur.evidence ?? 0) + 1
      if (source != null) {
        cur.sources = [...seen, source].slice(-30)
        cur.lastSource = source
      }
      cur.updatedAt = now
      this.noteRivalry(trait, value, now)
    } else {
      this.items.set(k, {
        trait,
        value,
        confidence: this.cfg.evidenceWeight,
        evidence: 1,
        conflicts: 0,
        updatedAt: now,
        lastSource: source ?? null,
        sources: source == null ? [] : [source],
      })
    }
    return this.items.get(k)
  }

  /**
   * 同一 trait 下出现第二个都还站得住的值时，给两边各记一次"对立"计数。
   * 只记数，不动置信度——render() 会自己输出"有时 A 有时 B"，强行对折会让两边来回抖。
   */
  noteRivalry(trait, value, now = Date.now()) {
    const peers = []
    for (const it of this.items.values()) {
      if (it.trait !== trait || it.value === value) continue
      if (this.confidenceOf(it, now) >= 0.3) peers.push(it)
    }
    if (peers.length === 0) return
    const self = this.items.get(this.key(trait, value))
    if (!self || self.conflicts > 0) return // 已经记过就不重复记
    self.conflicts += 1
    for (const p of peers) p.conflicts += 1
  }

  /** 当前置信度：存入时的置信度按时间折半（只读，不回写） */
  confidenceOf(item, now = Date.now()) {
    const days = Math.max(0, (now - (item.updatedAt ?? now)) / DAY_MS)
    const hl = this.cfg.impressionHalfLifeDays
    if (!hl || hl <= 0) return item.confidence
    return item.confidence * Math.pow(0.5, days / hl)
  }

  /** 记一条反证（同一 trait 下的另一面）：置信度对折，并计一次冲突 */
  contradict(trait, value, now = Date.now()) {
    const k = this.key(trait, value)
    const cur = this.items.get(k)
    if (!cur) return null
    cur.confidence = cur.confidence * this.cfg.contradictFactor
    cur.conflicts += 1
    cur.updatedAt = now
    return cur
  }

  /** 同 trait 下的两个值互相冲突时，把两边都记一次冲突 → 输出会写成"有时 A 有时 B" */
  noteConflict(traitA, valueA, traitB, valueB, now = Date.now()) {
    this.contradict(traitA, valueA, now)
    this.contradict(traitB, valueB, now)
  }

  /**
   * 渲染成给模型看的一段话（控制在 maxImpressionLines 行内）。
   * 用**衰减后**的置信度排序和筛；同一 trait 出现两个值且都还有分，就并成"有时…有时…"。
   */
  render(maxLines = this.cfg.maxImpressionLines, now = Date.now()) {
    const byTrait = new Map()
    for (const it of this.items.values()) {
      const c = this.confidenceOf(it, now)
      if (c < (this.cfg.retireConfidence ?? 0.15)) continue
      if (!byTrait.has(it.trait)) byTrait.set(it.trait, [])
      byTrait.get(it.trait).push({ item: it, c })
    }

    const lines = []
    for (const [trait, arr] of byTrait) {
      arr.sort((a, b) => b.c - a.c)
      const top = arr[0]
      if (arr.length >= 2 && arr[1].c >= 0.3) {
        lines.push(
          `${trait}：有时「${top.item.value}」（${pct(top.c)}），有时「${arr[1].item.value}」（${pct(arr[1].c)}）`,
        )
      } else {
        lines.push(
          `${trait}：${top.item.value}（置信 ${pct(top.c)}｜证据 ${top.item.evidence} 条${top.item.conflicts ? '｜出现过反面' : ''}）`,
        )
      }
    }
    return lines.slice(0, maxLines)
  }

  toJSON() {
    return [...this.items.values()]
  }

  static fromJSON(arr, cfg = DEFAULTS) {
    const m = new ImpressionModel(cfg)
    for (const it of arr) m.items.set(m.key(it.trait, it.value), { ...it })
    return m
  }
}

/**
 * 把"按消息条数"计的旧证据折算成"按会话"计的等效条数，并按新曲线重算置信度。
 *
 * 为什么需要：0.1.1 之前每来一条用户消息 evidence+1，于是 25 条证据其实是同一个下午说的 25 句，
 * 置信度早就钉在 95%。改成按会话计数后，旧计数只增不减且权重分母巨大（w 趋近 0），
 * 旧数据会永远卡在 95%——必须一次性折一下。用 √n 是因为"旧计数 ≥ 新计数"，取平方根是
 * 一个温和的近似，比清零更能保住已经学到的四个维度。
 */
export function recalibrateImpression(evidence, cfg = DEFAULTS) {
  const n = Math.max(1, Math.round(Math.sqrt(Math.max(1, Number(evidence) || 1))))
  let c = cfg.evidenceWeight
  for (let i = 2; i <= n; i++) {
    const w = cfg.evidenceWeight / (1 + (i - 1) * cfg.evidenceDamp)
    c = Math.min(cfg.maxConfidence, c + w * (1 - c))
  }
  return { evidence: n, confidence: c }
}

// ---------------------------------------------------------------------------
// 六、注入 prompt 的文本（预算控制在这里）
// ---------------------------------------------------------------------------

/**
 * 把印象 + 常驻卡 + top-k 记忆拼成一段注入文本。
 *
 * 分两档花预算：
 *   【常驻】硬约束 / 已定决策 / 协作偏好 —— 用户原话说的"换窗口还记得上次为什么否掉方案 B"
 *   【按需】其余（事实、任务、教训）—— 靠检索分挑，随天数沉底
 * 常驻卡有自己的字数顶（pinnedChars，默认 350），不跟普通记忆抢。
 *
 * @param {object[]} recalled recall() 的返回值
 * @param {ImpressionModel} impression
 * @param {{maxChars?:number, pinned?:object[], pinnedChars?:number}} [opts]
 */
export function renderMemoryBlock(recalled, impression, opts = {}) {
  const maxChars = opts.maxChars ?? 700
  const pinnedChars = opts.pinnedChars ?? 350
  const pinnedMax = opts.pinnedMax ?? 4
  // 先转义再截断：转义会让文本变长，倒过来做就冲破预算了
  const lines = []
  const imp = impression ? impression.render() : []
  if (imp.length) {
    lines.push('【我对你的印象】')
    for (const l of imp) lines.push('- ' + l)
  }

  const pinned = (opts.pinned ?? []).slice(0, pinnedMax)
  if (pinned.length) {    const head = '【常驻·硬约束与已定决策】（用户原话，优先遵守）'
    let used = head.length
    const body = []
    for (const m of pinned) {
      const line = `- [${m.kind}] ${truncate(m.text, 70)}`
      if (used + line.length + 1 > pinnedChars) break
      body.push(line)
      used += line.length + 1
    }
    if (body.length) {
      lines.push(head)
      lines.push(...body)
    }
  }

  // 进行中的事：跨会话最常断的一环——换窗口不知道做到哪、下一步是什么
  const tasks = (opts.tasks ?? [])
    .filter((t) => t.status === 'doing' || t.status === 'blocked')
    .slice(0, opts.taskMax ?? 3)
  if (tasks.length) {
    const taskChars = opts.taskChars ?? 160
    let used = 0
    const body = []
    for (const t of tasks) {
      const mark = t.status === 'blocked' ? '⏸' : '▸'
      const line = `- ${mark} ${truncate(t.title, 48)}${t.note ? '｜' + truncate(t.note, 24) : ''}`
      if (used + line.length + 1 > taskChars) break
      body.push(line)
      used += line.length + 1
    }
    if (body.length) {
      lines.push('【进行中的事】（接着干，不用重问）')
      lines.push(...body)
    }
  }

  if (recalled.length) {
    lines.push('【我记得的事】（按相关度排序，越上面越该用）')
    for (const r of recalled) {
      const m = r.mem
      const age = Math.max(0, Math.round((Date.now() - (m.lastHitAt ?? m.createdAt ?? Date.now())) / DAY_MS))
      const tag = scopeLabel(m.scope)
      const head = tag ? `${tag}|${m.kind}` : m.kind
      const flag = m.status === 'disputed' ? '｜未确认' : ''
      lines.push(`- [${head}|${age}天前|R=${retention(m).toFixed(2)}${flag}] ${truncate(m.text, 80)}`)
    }
  }
  let out = escapePromptBraces(lines.join('\n'))
  if (out.length > maxChars) {
    // 放不下就按整条丢，不留半句：半句话最容易被模型当成完整意思去用
    const kept = []
    for (const line of lines) {
      const cand = escapePromptBraces([...kept, line].join('\n'))
      if (cand.length > maxChars) break
      kept.push(line)
    }
    out = escapePromptBraces(kept.join('\n'))
  }
  return out
}

/**
 * 把 `{{` 拆成 `{ {`。
 *
 * 为什么必须做：`systemPrompt.context` 的正文会被宿主当模板扫描（`dsh-system-prompt`
 * 的 interpolate），遇到 `{{name}}` 会去查变量表，查不到就 throw——而这个 throw 发生在
 * 组装 prompt 时、不在我们 try/catch 的范围里，会把整轮请求打挂。记忆正文是用户原话，
 * 贴一段 Vue 模板或 YAML 就可能带 `{{`。宿主没有 `interpolate: false` 开关，只能自己挡。
 */
export function escapePromptBraces(text) {
  return String(text ?? '').replace(/\{\{/g, '{ {')
}

// ---------------------------------------------------------------------------
// 七、小工具
// ---------------------------------------------------------------------------
export function clamp01(x) {
  const n = Number(x)
  if (!Number.isFinite(n)) return 0
  return Math.min(1, Math.max(0, n))
}
export function uniq(arr) {
  return [...new Set(arr)]
}
export function truncate(s, n) {
  const t = String(s ?? '')
  return t.length <= n ? t : t.slice(0, n - 1) + '…'
}
export function pct(x) {
  return Math.round(clamp01(x) * 100) + '%'
}
function nextId(list) {
  let max = 0
  for (const m of list) if (typeof m.id === 'number' && m.id > max) max = m.id
  return max + 1
}
