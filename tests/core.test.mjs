/**
 * core.test.mjs —— 算法核心的单测（node --test 直接跑，不需要装任何东西）
 * 运行：node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULTS,
  baseStrength,
  strengthOf,
  halfLifeDays,
  retention,
  shouldArchive,
  sweepArchive,
  retrievalScore,
  recall,
  extractCandidate,
  classifyScope,
  classifyUse,
  looksLikeFragment,
  tokenize,
  bm25Scores,
  scoreParts,
  detectFileMention,
  similarity,
  compact,
  consolidate,
  recalibrateImpression,
  ImpressionModel,
  renderMemoryBlock,
} from '../src/core.js'

const DAY = 24 * 3600 * 1000
const NOW = Date.UTC(2026, 10, 10, 12, 0, 0)

function mem(over = {}) {
  return {
    id: 1,
    text: '示例记忆',
    kind: 'fact',
    importance: 0.5,
    emotion: 0.2,
    hits: 0,
    createdAt: NOW,
    lastHitAt: NOW,
    tags: [],
    archived: false,
    ...over,
  }
}

test('1. 基础强度：重要度/情绪越强，起步越结实', () => {
  const low = baseStrength(mem({ importance: 0, emotion: 0 }))
  const high = baseStrength(mem({ importance: 1, emotion: 1 }))
  assert.equal(low, 1)
  assert.equal(high, 1 + DEFAULTS.impW + DEFAULTS.emoW) // 1+3+2 = 6
})

test('2. 半衰期与强度成正比，复述按 log 增长（不会线性膨胀）', () => {
  const m = mem({ importance: 0.8, emotion: 0.6 })
  const h0 = halfLifeDays(m)
  const s0 = strengthOf(m)
  assert.ok(Math.abs(h0 - DEFAULTS.baseHalfLifeDays * s0) < 1e-9)

  const m5 = { ...m, hits: 5 }
  const ratio = strengthOf(m5) / strengthOf(m)
  assert.ok(ratio > 1 && ratio < 2.5, `5 次复述强度涨幅应温和，实际 ${ratio}`)

  const m50 = { ...m, hits: 50 }
  assert.ok(strengthOf(m50) / strengthOf(m0(m)) > strengthOf(m5) / strengthOf(m0(m)))
}) 

function m0(m) {
  return { ...m, hits: 0 }
}

test('3. 保留度：正好过一个半衰期掉一半', () => {
  const m = mem({ importance: 0.8, emotion: 0.6 })
  const h = halfLifeDays(m)
  const r = retention(m, NOW + h * DAY)
  assert.ok(Math.abs(r - 0.5) < 1e-9, `应为 0.5，实际 ${r}`)
  assert.ok(Math.abs(retention(m, NOW) - 1) < 1e-9)
})

test('4. 时间越久 + 越不重要 → 归档；重要的不归档', () => {
  const weak = mem({ importance: 0.2, emotion: 0 })
  const strong = mem({ importance: 0.95, emotion: 0.5 })
  const later = NOW + 60 * DAY
  assert.equal(shouldArchive(weak, later), true)
  assert.equal(shouldArchive(strong, later), false)
  assert.equal(shouldArchive(weak, NOW), false)
})

test('5. 检索分：相关度高的排前面；权重和等于 1', () => {
  const w = DEFAULTS.wRetention + DEFAULTS.wImportance + DEFAULTS.wRelevance
  assert.ok(Math.abs(w - 1) < 1e-9, `权重和应为 1，实际 ${w}`)

  const a = mem({ id: 1, importance: 0.5 })
  const b = mem({ id: 2, importance: 0.5 })
  assert.ok(retrievalScore(a, NOW, 0.95) > retrievalScore(b, NOW, 0.1))
})

test('6. recall：过滤归档/过衰，取 top-k，且不会重复取同一条', () => {
  const list = [
    mem({ id: 1, text: 'A', importance: 0.9 }),
    mem({ id: 2, text: 'B', importance: 0.5 }),
    mem({ id: 3, text: 'C', importance: 0.9, archived: true }),
    mem({ id: 4, text: 'D', importance: 0.9, lastHitAt: NOW - 500 * DAY, createdAt: NOW - 500 * DAY }),
    mem({ id: 5, text: 'E', importance: 0.7 }),
  ]
  const got = recall(list, NOW, { k: 3 })
  const ids = got.map((x) => x.mem.id)
  assert.equal(ids.length, 3)
  assert.equal(new Set(ids).size, 3)
  assert.ok(!ids.includes(3), '归档的不该出现')
  assert.ok(!ids.includes(4), '衰减到 0.15 以下的不该出现')
})

test('7. 多样性：同 tag 的第 3 条会被压分，避免一次注入全是同一件事', () => {
  const list = [
    mem({ id: 1, importance: 0.6, tags: ['偏好'] }),
    mem({ id: 2, importance: 0.6, tags: ['偏好'] }),
    mem({ id: 3, importance: 0.6, tags: ['偏好'] }),
    mem({ id: 4, importance: 0.6, tags: ['目标'] }),
  ]
  const got = recall(list, NOW, { k: 3, diversity: 0.2 })
  const ids = got.map((x) => x.mem.id)
  assert.ok(ids.includes(4), `第 4 条（不同 tag）应当挤进前三，实际 ${ids}`)
})

test('8. 抽取：寒暄不记、短句不记、偏好/目标/情绪能记', () => {
  assert.equal(extractCandidate('你好', NOW), null)
  assert.equal(extractCandidate('嗯', NOW), null)
  assert.equal(extractCandidate('今晚吃啥？', NOW), null)

  const pref = extractCandidate('我不喜欢一上来就讲一堆理论', NOW)
  assert.equal(pref.kind, 'preference')
  assert.ok(pref.importance >= 0.75)

  const goal = extractCandidate('我年底前要投第一份实习', NOW)
  assert.equal(goal.kind, 'goal')

  const emo = extractCandidate('今天调摄像头调到崩溃', NOW)
  assert.equal(emo.kind, 'emotion')
  assert.ok(emo.emotion >= 0.7)
})

test('9. 相似度与合并：同一件事说第二遍 = hits+1，不新增条目', () => {
  const a = '我不喜欢一上来就讲一堆理论'
  const b = '我不喜欢一上来就讲一堆理论。'
  assert.ok(similarity(a, b) > 0.9)

  let list = []
  const r1 = consolidate(list, extractCandidate(a, NOW), NOW)
  assert.equal(r1.action, 'added')
  list = r1.list
  const r2 = consolidate(list, extractCandidate(b, NOW), NOW)
  assert.equal(r2.action, 'merged')
  assert.equal(r2.list.length, 1)
  assert.equal(r2.list[0].hits, 1)
  assert.ok(r2.list[0].importance >= r1.list[0].importance)
})

test('10. 不同的事不会误合并', () => {
  let list = []
  list = consolidate(list, extractCandidate('我不喜欢一上来就讲一堆理论', NOW), NOW).list
  list = consolidate(list, extractCandidate('我年底前要投第一份实习', NOW), NOW).list
  assert.equal(list.length, 2)
})

test('11. 印象：证据累积收敛到上限，不会越加越超 100%', () => {
  const im = new ImpressionModel()
  let last = null
  for (let i = 0; i < 30; i++) last = im.observe('沟通风格', '结论先行')
  assert.ok(last.confidence <= DEFAULTS.maxConfidence + 1e-9)
  assert.ok(last.confidence > 0.9)
  assert.equal(last.evidence, 30)
})

test('12. 印象：反证是对折，不是清零；两个面都留着 → 渲染成"有时…有时…"', () => {
  const im = new ImpressionModel()
  for (let i = 0; i < 6; i++) im.observe('沟通风格', '结论先行')
  for (let i = 0; i < 3; i++) im.observe('沟通风格', '喜欢先铺垫')
  const before = im.items.get(im.key('沟通风格', '结论先行')).confidence
  im.noteConflict('沟通风格', '结论先行', '沟通风格', '喜欢先铺垫')
  const after = im.items.get(im.key('沟通风格', '结论先行')).confidence
  assert.ok(after < before && after > 0, `应为对折，实际 ${before} → ${after}`)

  const lines = im.render()
  assert.equal(lines.length, 1)
  assert.match(lines[0], /有时/)
})

test('13. 注入文本：有预算上限，且带上印象与记忆', () => {
  const im = new ImpressionModel()
  im.observe('技术水平', 'OpenCV 在学')
  const list = [mem({ id: 1, text: '在做 Camera AI Assistant' })]
  const got = recall(list, NOW, { k: 3 })
  const block = renderMemoryBlock(got, im, { maxChars: 700 })
  assert.ok(block.includes('我对你的印象'))
  assert.ok(block.includes('OpenCV'))
  assert.ok(block.includes('Camera'))
  assert.ok(block.length <= 700)

  const tiny = renderMemoryBlock(got, im, { maxChars: 60 })
  assert.ok(tiny.length <= 60)
})

test('14. 印象可序列化往返（插件重启后不丢）', () => {
  const im = new ImpressionModel()
  im.observe('在意的点', '隐私不外传')
  const back = ImpressionModel.fromJSON(JSON.parse(JSON.stringify(im.toJSON())))
  assert.equal(back.render()[0], im.render()[0])
})

test('15. 同一段话第二次多补一行 → 仍合并（包含度捷径）', () => {
  const now = Date.now()
  // A 是 B 的前半段：包含度≈1，但 Jaccard 只有 0.3 左右 —— 专门走"包含度"这条捷径
  const a = '称呼：Alex\n语气：像个干过活的工程师，不上价值、不煽情'
  const b = a + '\n禁止：「作为一个 AI」「我很乐意」「让我们一起」这类句式\n允许：直接指出我错了，但必须带证据'
  // 先确认这两条 Jaccard 其实不高（否则这条测试没意义）
  assert.ok(similarity(a, b) < DEFAULTS.dupThreshold, `Jaccard 应低于阈值，实际 ${similarity(a, b)}`)

  const mk = (text) => ({ text, kind: 'fact', importance: 0.9, emotion: 0.2, tags: ['强调'], createdAt: now, lastHitAt: now, hits: 0, archived: false })
  let list = consolidate([], mk(a), now).list
  const r = consolidate(list, mk(b), now)
  assert.equal(r.action, 'merged')
  assert.equal(r.list.length, 1)
})

test('16. 太短的话不因包含度被吞掉', () => {
  const now = Date.now()
  const mk = (text) => ({ text, kind: 'fact', importance: 0.5, emotion: 0.1, tags: [], createdAt: now, lastHitAt: now, hits: 0, archived: false })
  const list = consolidate([], mk('好的'), now).list
  const r = consolidate(list, mk('好的，我记住了'), now)
  assert.equal(r.list.length, 2, '两句话不同，不该合并')
})

test('18. 注入文本里不留 {{ —— 否则宿主编译 prompt 时直接 throw', () => {
  const now = Date.now()
  const mk = (text) => ({ id: 1, text, kind: 'fact', importance: 0.9, emotion: 0.2, hits: 0, createdAt: now, lastHitAt: now, tags: [], archived: false })
  const list = [mk('模板写成 {{name}} 和 {{user.city}}，渲染前先替换')]
  const got = recall(list, now, { k: 3 })
  const block = renderMemoryBlock(got, null, { maxChars: 700 })
  assert.ok(block.includes('name'), '正文本身要保留（只拆括号，不吞内容）')
  assert.ok(!block.includes('{{'), `不该留下连续双花括号：${block}`)
  assert.ok(block.includes('{ {'), '应拆成 { {')
})

test('19. 转义后仍守住字符预算', () => {
  const now = Date.now()
  const list = Array.from({ length: 12 }, (_, i) => ({
    id: i + 1, text: '{{a}} {{b}} {{c}} 第 ' + i + ' 条记忆内容，凑长度凑长度凑长度',
    kind: 'fact', importance: 0.8, emotion: 0.2, hits: 0, createdAt: now, lastHitAt: now, tags: [], archived: false,
  }))
  const got = recall(list, now, { k: 12 })
  const block = renderMemoryBlock(got, null, { maxChars: 300 })
  assert.ok(block.length <= 300, `超预算了：${block.length}`)
  assert.ok(!block.includes('{{'))
})

test('21. 归档扫描：只收衰减到线的，重要的不收；幂等', () => {
  const weak = mem({ id: 1, importance: 0.2, emotion: 0, lastHitAt: NOW - 120 * DAY, createdAt: NOW - 120 * DAY })
  const strong = mem({ id: 2, importance: 0.95, emotion: 0.5, lastHitAt: NOW - 120 * DAY, createdAt: NOW - 120 * DAY })
  const fresh = mem({ id: 3, importance: 0.5 })
  const r1 = sweepArchive([weak, strong, fresh], NOW)
  assert.deepEqual(r1.archived.map((m) => m.id), [1], '只有弱且久的那条该归档')
  assert.equal(r1.list.find((m) => m.id === 1).archived, true)
  assert.equal(r1.list.find((m) => m.id === 2).archived, false, '重要度高永不归档')
  assert.equal(r1.list.find((m) => m.id === 3).archived, false)

  const r2 = sweepArchive(r1.list, NOW)
  assert.equal(r2.archived.length, 0, '第二次不该重复归档')
  assert.equal(r2.list, r1.list, '没变化时应原样返回，不制造新数组')
})

test('22. 同一会话里重复说同一特征：证据只算 1 条，置信度只小幅确认', () => {
  const im = new ImpressionModel()
  im.observe('要求', '要结论先行', NOW, 'session-A')
  im.observe('要求', '要结论先行', NOW + 1000, 'session-A')
  im.observe('要求', '要结论先行', NOW + 2000, 'session-A')
  const it = im.items.get(im.key('要求', '要结论先行'))
  assert.equal(it.evidence, 1, `同会话不该涨证据，实际 ${it.evidence}`)
  assert.ok(it.confidence < 0.5, `三句同一会话不该冲到 50% 以上，实际 ${it.confidence}`)
})

test('23. 不同会话各说一次：证据按会话累加，且不会 5 次就钉死 95%', () => {
  const im = new ImpressionModel()
  const sources = ['s1', 's2', 's3', 's4', 's5']
  for (const s of sources) im.observe('兴趣点', '想知道底层原理', NOW, s)
  const it = im.items.get(im.key('兴趣点', '想知道底层原理'))
  assert.equal(it.evidence, 5)
  assert.ok(it.confidence > 0.4 && it.confidence < 0.8, `5 个会话应落在 40%~80%，实际 ${(it.confidence * 100).toFixed(0)}%`)
})

test('24. 印象也会忘：90 天没观察，置信度折到 1/4 左右；淡到线以下就不注入', () => {
  const im = new ImpressionModel()
  im.observe('情绪', '会直接说感受', NOW, 's1')
  const it = im.items.get(im.key('情绪', '会直接说感受'))
  const far = NOW + 90 * DAY
  const c = im.confidenceOf(it, far)
  assert.ok(Math.abs(c - it.confidence * 0.25) < 1e-9, `半衰期 45 天 → 90 天剩 1/4，实际 ${c}`)

  // 淡到阈值以下：render 不再输出
  const lines = im.render(6, NOW + 400 * DAY)
  assert.equal(lines.length, 0, `早该淡没了，实际还输出：${lines}`)
})

test('26. 旧证据折算：53 条乘出来的 95% 折成按会话计的 7 条，且能被新证据推动', () => {
  const r = recalibrateImpression(53)
  assert.equal(r.evidence, 7, `√53≈7，实际 ${r.evidence}`)
  assert.ok(r.confidence < 0.85, `折算后不该还钉在 95%，实际 ${(r.confidence * 100).toFixed(0)}%`)

  const one = recalibrateImpression(1)
  assert.deepEqual(one, { evidence: 1, confidence: DEFAULTS.evidenceWeight })
})

test('25. 两个面都站得住时记一次"对立"，但不互相拉低置信度', () => {
  const im = new ImpressionModel()
  im.observe('表达习惯', '短句直给', NOW, 's1')
  im.observe('表达习惯', '短句直给', NOW, 's2')
  im.observe('表达习惯', '短句直给', NOW, 's3')
  const before = im.items.get(im.key('表达习惯', '短句直给')).confidence
  im.observe('表达习惯', '愿意展开细说', NOW, 's4')
  im.observe('表达习惯', '愿意展开细说', NOW, 's5') // 第二条证据触发对立计数
  const a = im.items.get(im.key('表达习惯', '短句直给'))
  assert.ok(a.conflicts >= 1, '老的那面应记到一次对立')
  assert.ok(a.confidence >= before, '记对立不该把置信度拉低')
  assert.equal(im.render().filter((l) => l.includes('有时')).length, 1, '应输出成「有时…有时…」')
})

test('20. 同一 trait 的两个值都能存进 ImpressionModel 并往返', () => {
  const im = new ImpressionModel()
  im.observe('表达习惯', '短句直给')
  im.observe('表达习惯', '愿意展开细说')
  assert.equal(im.items.size, 2)
  const back = ImpressionModel.fromJSON(JSON.parse(JSON.stringify(im.toJSON())))
  assert.equal(back.items.size, 2, '两个面都要活下来，否则重启就塌成一个人格')
})

test('27. 作用域归类：关于人的进 world，点名的文件进 file，其余按话题分线', () => {
  assert.equal(classifyScope('称呼：Alex\n身份：我的助手'), 'world')
  assert.equal(classifyScope('我的底线是绝不泄露隐私数据'), 'world')
  assert.equal(classifyScope('我不喜欢一上来就讲一堆理论'), 'world')

  assert.equal(classifyScope('帮我看下 C:\\work\\w04_canny.py 为什么报错'), 'file:w04_canny.py')
  assert.equal(classifyScope('把 roadmap.md 的第三周改一下'), 'file:roadmap.md')

  assert.equal(classifyScope('OpenCV 摄像头帧率掉到 5 了'), 'topic:学习')
  assert.equal(classifyScope('记忆插件注入的字符预算够不够'), 'topic:工具')
  assert.equal(classifyScope('D盘空间不足，想清理一下'), 'topic:装机')
  assert.equal(classifyScope('今天中午吃了碗面'), 'topic:杂')
})

test('28. recall 按作用域过滤：world 永远可见，别的线没绑就不出现', () => {
  const list = [
    mem({ id: 1, text: '称呼：Alex', scope: 'world' }),
    mem({ id: 2, text: 'OpenCV 摄像头帧率掉到 5', scope: 'topic:学习' }),
    mem({ id: 3, text: 'D盘空间不足', scope: 'topic:装机' }),
    mem({ id: 4, text: 'w04_canny 那个脚本', scope: 'file:w04_canny.py' }),
  ]
  const got = recall(list, NOW, { k: 6, scopes: ['topic:学习'] })
  const ids = got.map((r) => r.mem.id).sort()
  assert.deepEqual(ids, [1, 2], `只该看见 world + 学习线，实际 ${ids}`)

  const none = recall(list, NOW, { k: 6, scopes: [] })
  assert.deepEqual(none.map((r) => r.mem.id), [1], '没绑任何线时只剩 world')

  const all = recall(list, NOW, { k: 6 })
  assert.equal(all.length, 4, '不传 scopes 时退回全池（兼容旧行为）')
})

test('29. 文件识别：中文路径、无扩展名、通配符、一句话点两个文件', () => {
  assert.equal(detectFileMention('看下 D:\\projects\\main.py'), 'main.py')
  assert.equal(detectFileMention('打开 桌面\\实验报告.docx 填一下'), '实验报告.docx')
  assert.equal(detectFileMention('这个目录没有文件名'), null)
  assert.equal(detectFileMention('跑 **/*.py 看看'), null)
  assert.equal(detectFileMention('把 a.md 也写入 profile.md'), null, '一句话两个文件，分不清就不绑')
  assert.equal(detectFileMention('将 a.md也写入profile.md中'), null, '没空格粘成一串，也不绑')
})

test('31. 重启后再喂同一批会话，证据不会重复涨', () => {
  const im = new ImpressionModel()
  for (const s of ['s1', 's2', 's3']) im.observe('要求', '要结论先行', NOW, s)
  const before = im.items.get(im.key('要求', '要结论先行')).evidence

  // 模拟重启：序列化 → 反序列化 → 再喂同一批会话（启动补捞就是这么干的）
  const back = ImpressionModel.fromJSON(JSON.parse(JSON.stringify(im.toJSON())))
  for (const s of ['s1', 's2', 's3']) back.observe('要求', '要结论先行', NOW + 1000, s)
  const after = back.items.get(back.key('要求', '要结论先行')).evidence

  assert.equal(after, before, `同一批会话重复喂不该涨证据：${before} → ${after}`)
})

test('32. 新增会话仍然算新证据', () => {
  const im = new ImpressionModel()
  for (const s of ['s1', 's2']) im.observe('要求', '要结论先行', NOW, s)
  const before = im.items.get(im.key('要求', '要结论先行')).evidence
  im.observe('要求', '要结论先行', NOW, 's3')
  assert.equal(im.items.get(im.key('要求', '要结论先行')).evidence, before + 1)
})

test('30. 预算放不下就整条丢，不留半句', () => {
  const now = Date.now()
  const mk = (id, text) => ({ id, text, kind: 'fact', importance: 0.9, emotion: 0.2, hits: 0, createdAt: now, lastHitAt: now, tags: [], archived: false })
  const list = [
    mk(1, '第一条记忆，长度适中，用来占位置'),
    mk(2, '第二条记忆' + '凑长度'.repeat(20)),
  ]
  const got = recall(list, now, { k: 2 })
  const block = renderMemoryBlock(got, null, { maxChars: 120 })
  assert.ok(block.length <= 120, `超预算：${block.length}`)
  assert.ok(!block.endsWith('…'), '不该以省略号结尾（那是半句）')
  const lastLine = block.split('\n').pop()
  assert.ok(lastLine.startsWith('- [fact|'), `最后一行应是完整条目，实际：${lastLine}`)
})

test('33. 用途轴：约束 > 决策 > 教训 > 任务 > 偏好 > 事实', () => {
  assert.equal(classifyUse('我的底线是绝不泄露隐私数据'), 'constraint')
  assert.equal(classifyUse('方案 B 否决，改用 SQLite 存'), 'decision')
  assert.equal(classifyUse('踩坑：WINDOW_NORMAL 会记住旧尺寸'), 'lesson')
  assert.equal(classifyUse('这周的目标是把 D1 演示跑通'), 'task')
  assert.equal(classifyUse('称呼：Alex，先给结论'), 'preference')
  assert.equal(classifyUse('机器是 Win11 25H2，Node 24'), 'fact')
  // 助手抽出来的决策，别被正文规则冲成 fact
  assert.equal(classifyUse('这一版就这样', 'decision'), 'decision')
})

test('34. 常驻卡只放约束/决策/偏好，且不和普通记忆重复', () => {
  const now = Date.now()
  const mk = (id, text, kind) => ({ id, text, kind, importance: 0.8, emotion: 0.2, hits: 0, createdAt: now, lastHitAt: now, tags: [], archived: false, status: 'active' })
  const pinned = [
    mk(1, '底线：绝不外传隐私', 'constraint'),
    mk(2, '决策：改用 SQLite', 'decision'),
  ]
  const recalled = [{ mem: mk(3, '一条普通事实', 'fact'), score: 0.6, rel: 0.5 }]
  const block = renderMemoryBlock(recalled, null, { maxChars: 700, pinned, pinnedChars: 350 })

  assert.match(block, /【常驻·硬约束与已定决策】/)
  assert.match(block, /绝不外传隐私/)
  assert.match(block, /改用 SQLite/)
  assert.match(block, /普通事实/)
  // 顺序：常驻卡在普通记忆之前
  assert.ok(block.indexOf('常驻') < block.indexOf('我记得的事'))
})

test('35. 常驻卡有自己的字数顶，不会把普通记忆挤没', () => {
  const now = Date.now()
  const mk = (id, text) => ({ id, text, kind: 'constraint', importance: 0.9, emotion: 0.2, hits: 0, createdAt: now, lastHitAt: now, tags: [], archived: false, status: 'active' })
  const pinned = [mk(1, '约束一'.repeat(60)), mk(2, '约束二'.repeat(60)), mk(3, '约束三')]
  const recalled = [{ mem: { ...mk(9, '普通记忆'), kind: 'fact' }, score: 0.5, rel: 0.4 }]
  const block = renderMemoryBlock(recalled, null, { maxChars: 700, pinned, pinnedChars: 120 })
  const card = block.split('【我记得的事】')[0]
  assert.ok(card.length <= 120 + 40, `常驻卡应被 120 字顶住，实际 ${card.length}`)
  assert.match(block, /普通记忆/, '普通记忆仍在')
})

test('36. 已更正的条目默认不检索，显式要才给', () => {
  const now = Date.now()
  const mk = (id, status) => ({ id, text: '旧说法' + id, kind: 'decision', importance: 0.9, emotion: 0.2, hits: 0, createdAt: now, lastHitAt: now, tags: [], archived: false, status })
  const list = [mk(1, 'superseded'), mk(2, 'active')]
  const normal = recall(list, now, { k: 5 })
  assert.deepEqual(normal.map((r) => r.mem.id), [2])
  const all = recall(list, now, { k: 5, includeSuperseded: true })
  assert.equal(all.length, 2)
})

test('37. 检索分能拆开解释（why 的来源）', () => {
  const m = mem({ importance: 0.8 })
  const p = scoreParts(m, NOW, 0.5)
  assert.ok(p.total > 0 && p.total <= 1)
  assert.ok(Math.abs(p.total - (DEFAULTS.wRetention * p.retention + DEFAULTS.wImportance * 0.8 + DEFAULTS.wRelevance * 0.5)) < 1e-6)
})
test('17. compact 也能合并"多补一行"的重复条目', () => {
  const now = Date.now()
  const mk = (id, text) => ({ id, text, kind: 'fact', importance: 0.9, emotion: 0.2, tags: [], createdAt: now, lastHitAt: now, hits: 0, archived: false })
  const list = [
    mk(1, '称呼：Alex\n语气：像个干过活的工程师，不上价值、不煽情\n禁止：「作为一个 AI」'),
    mk(2, '称呼：Alex\n身份：我的助手\n语气：像个干过活的工程师，不上价值、不煽情\n禁止：「作为一个 AI」'),
  ]
  const out = compact(list)
  assert.equal(out.length, 1, '应只剩一条')
  assert.equal(out[0].id, 1, '保留靠前的 id')
})

test('38. 碎片不进常驻卡：编号、加粗、表格行', () => {
  assert.equal(looksLikeFragment('1. **时段**——你现在 23 点干活'), true)
  assert.equal(looksLikeFragment('- 普通条目'), false)
  assert.equal(looksLikeFragment('| 列一 | 列二 |'), true)
  assert.equal(looksLikeFragment('以下是三条结论'), true)
  assert.equal(looksLikeFragment('决策：改用 SQLite 存'), false)
})

test('39. 切词：中文二元组 + 英文小写词', () => {
  const t = tokenize('OpenCV 摄像头抓帧')
  assert.ok(t.includes('opencv'))
  assert.ok(t.includes('摄像'))
  assert.ok(t.includes('像头'))
  assert.ok(t.includes('头抓'))
})

test('40. BM25：查询词命中正确的文档，且短文档不吃亏', () => {
  const docs = [
    { id: 'a', text: 'OpenCV 摄像头帧率掉到 5' },
    { id: 'b', text: 'D 盘空间不足，想清理一下装游戏的地方，顺便看看这几个目录能不能删' },
  ]
  const s = bm25Scores(docs, '摄像头')
  assert.equal(s.get('a'), 1)
  assert.ok(!s.has('b'), '完全没命中的不给分')
  assert.equal(bm25Scores(docs, '').size, 0, '空查询返回空表')
})

test('41. 进行中的事进注入块，done 的不进去', () => {
  const now = Date.now()
  const tasks = [
    { id: 1, title: '把 D2 的表情识别跑通', status: 'doing', note: '阈值没调好' },
    { id: 2, title: '写 README', status: 'done', note: '' },
  ]
  const block = renderMemoryBlock([], null, { maxChars: 700, tasks })
  assert.match(block, /进行中的事/)
  assert.match(block, /表情识别/)
  assert.match(block, /阈值没调好/)
  assert.ok(!/写 README/.test(block), 'done 的不该进')
})
