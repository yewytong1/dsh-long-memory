/**
 * plugin.test.mjs —— 不装宿主也能跑的"假宿主"集成测试
 *
 * 用一个假 ctx（只有 systemPrompt.context / tools.register / on 三个口子）跑一遍：
 *   用户说话 → 采集 → 存库 → 下一轮注入文本里出现
 * 这样在装进 DSH 之前，就能证明插件的主干逻辑是通的。
 *
 * 运行：node tests/plugin.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../src/index.js'

/** 造一个假宿主 */
function fakeHost() {
  const h = { contextDef: null, tools: {}, handlers: {}, guard: null }
  h.ctx = {
    systemPrompt: {
      context(def) {
        h.contextDef = def
        return () => {}
      },
    },
    tools: {
      register(tool) {
        h.tools[tool.name] = tool
        return () => {}
      },
      guard(fn) {
        h.guard = fn
        return () => {}
      },
    },
    on(event, fn) {
      h.handlers[event] = fn
      return () => {}
    },
  }
  return h
}

/** 注入时按会话取文本：sessionId 为空表示"不知道是谁在问" */
function blockFor(h, sessionId) {
  return h.contextDef.text(sessionId ? { agent: { session: { id: sessionId } } } : {})
}

/** 造一条用户消息事件 */
function userEvent(seq, text) {
  return {
    type: 'user/message',
    seq,
    time: Date.now(),
    data: { role: 'user', content: [{ type: 'text', text }] },
  }
}

test('宿主注入的运行时快照不进记忆，真用户消息照进（按 source.kind 判）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lm-'))
  const h = fakeHost()
  apply(h.ctx, { dbPath: join(dir, 'm.sqlite') })

  // 注入块：正文里恰好有"我打算投 20 家"这种会被规则命中的话，但来源是 runtime-context
  h.handlers['session/event'](null, {
    type: 'user/message',
    seq: 1,
    data: {
      role: 'user',
      content: [{ type: 'text', text: 'Current runtime context. 我打算投 20 家实习，这是我的目标' }],
      source: { kind: 'runtime-context', form: 'snapshot', sections: [] },
    },
  })
  // 策略变更提醒（之前真把原文存进库的那种）
  h.handlers['session/event'](null, {
    type: 'user/message',
    seq: 2,
    data: {
      role: 'user',
      content: [{ type: 'text', text: 'The user changed the approval policy from "ask" to "never ask".' }],
      source: { kind: 'plugin', plugin: 'approval', form: 'notice', summary: 'policy' },
    },
  })
  // 真用户消息
  h.handlers['session/event'](null, {
    type: 'user/message',
    seq: 3,
    data: {
      role: 'user',
      content: [{ type: 'text', text: '我年底前要投第一份实习，目标是 OpenCV 方向' }],
      source: { kind: 'user' },
    },
  })

  const review = JSON.parse(await h.tools.memory_review.execute({ includeArchived: true }))
  assert.equal(review.total, 1, `只该存真用户那条，实际：${JSON.stringify(review.rows.map((r) => r.text))}`)
  assert.match(review.rows[0].text, /实习/)

  try { rmSync(dir, { recursive: true, force: true }) } catch {}
})

test('记忆里带 {{ 也不会让注入文本出现变量占位符', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lm-'))
  const h = fakeHost()
  apply(h.ctx, { dbPath: join(dir, 'm.sqlite') })

  await h.tools.memory_remember.execute({
    text: '我的报告模板是 {{name}} + {{date}}，每次替换',
    importance: 0.8,
  })
  const block = h.contextDef.text({})
  assert.ok(block.includes('name'), '正文要留着')
  assert.ok(!block.includes('{{'), `注入文本不该带 {{：${block}`)

  try { rmSync(dir, { recursive: true, force: true }) } catch {}
})

test('印象多值重启后不丢（走真库，不只在内存里）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lm-'))
  const dbPath = join(dir, 'm.sqlite')
  const h = fakeHost()
  apply(h.ctx, { dbPath })

  h.handlers['session/event'](null, { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: '为什么底层是这么实现的？' }], source: { kind: 'user' } } })
  h.handlers['session/event'](null, { type: 'user/message', seq: 2, data: { content: [{ type: 'text', text: '我要知道原理，原理在哪' }], source: { kind: 'user' } } })

  const before = JSON.parse(await h.tools.memory_impression.execute({}))
  assert.ok(before.明细.length >= 1)
  const evidenceBefore = before.明细.find((r) => r.trait === '兴趣点').evidence

  const h2 = fakeHost()
  apply(h2.ctx, { dbPath })
  const after = JSON.parse(await h2.tools.memory_impression.execute({}))
  const point = after.明细.find((r) => r.trait === '兴趣点')
  assert.ok(point, '重启后这条印象该还在')
  assert.equal(point.evidence, evidenceBefore, `证据条数应一致：${evidenceBefore} vs ${point.evidence}`)

  try { rmSync(dir, { recursive: true, force: true }) } catch {}
})

test('启动时把衰减到线的记忆自动归档（shouldArchive 真的接上了）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lm-'))
  const dbPath = join(dir, 'm.sqlite')
  const OLD = Date.now() - 200 * 86400000

  // 先往库里塞两条很老的：一条弱（该归档）、一条很重要（不该归档）
  const { openStore } = await import('../src/store.js')
  const seed = openStore(dbPath)
  seed.saveMemories([
    { id: 1, text: '今天吃了碗面', kind: 'fact', importance: 0.15, emotion: 0, hits: 0, createdAt: OLD, lastHitAt: OLD, tags: [], archived: false },
    { id: 2, text: '我的底线是绝不泄露隐私数据', kind: 'fact', importance: 0.95, emotion: 0.5, hits: 0, createdAt: OLD, lastHitAt: OLD, tags: [], archived: false },
  ])
  seed.close()

  const h = fakeHost()
  apply(h.ctx, { dbPath })

  const review = JSON.parse(await h.tools.memory_review.execute({ includeArchived: true }))
  const weak = review.rows.find((r) => r.id === 1)
  const strong = review.rows.find((r) => r.id === 2)
  assert.equal(weak.archived, true, '弱且老的那条该被自动归档')
  assert.equal(strong.archived, false, '重要度高的永不自动归档')

  // 归档的不进注入
  const block = h.contextDef.text({})
  assert.ok(!/今天吃了碗面/.test(block), '归档的不该再注入')

  try { rmSync(dir, { recursive: true, force: true }) } catch {}
})

test('同一会话里重复说同一特征，证据只算一条（按 session id）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lm-'))
  const h = fakeHost()
  apply(h.ctx, { dbPath: join(dir, 'm.sqlite') })

  const session = { id: 'session-xyz' }
  for (const t of ['为什么要这么实现，底层原理是什么', '我还是想知道原理和机制', '原理没讲清，再说一遍底层']) {
    h.handlers['session/event'](session, { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: t }], source: { kind: 'user' } } })
  }

  const imp = JSON.parse(await h.tools.memory_impression.execute({}))
  const point = imp.明细.find((r) => r.trait === '兴趣点')
  assert.equal(point.evidence, 1, `同一会话三句只该算 1 条证据，实际 ${point.evidence}`)
  assert.equal(point.lastSource, 'session-xyz')

  try { rmSync(dir, { recursive: true, force: true }) } catch {}
})

test('两条线各聊各的：注入不串（world 永远都在）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lm-'))
  const h = fakeHost()
  apply(h.ctx, { dbPath: join(dir, 'm.sqlite') })

  await h.tools.memory_remember.execute({ text: '称呼：Alex，说话结论先行', importance: 0.9 })
  // 会话 A 聊学习线
  h.handlers['session/event']({ id: 'sess-A' }, { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: '我在做 OpenCV 摄像头，一开帧率就掉到 5' }], source: { kind: 'user' } } })
  // 会话 B 聊装机线
  h.handlers['session/event']({ id: 'sess-B' }, { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: '我在 D 盘装了游戏，空间不足想清理一下' }], source: { kind: 'user' } } })

  const a = blockFor(h, 'sess-A')
  const b = blockFor(h, 'sess-B')
  const c = blockFor(h, 'sess-C')

  assert.match(a, /摄像头/, 'A 会话该看见学习线')
  assert.ok(!/D 盘装了游戏/.test(a), `A 不该看见装机线：${a}`)
  assert.match(b, /D 盘装了游戏/, 'B 会话该看见装机线')
  assert.ok(!/摄像头/.test(b), `B 不该看见学习线：${b}`)
  assert.match(a, /称呼：Alex/, 'world 在 A 里')
  assert.match(b, /称呼：Alex/, 'world 在 B 里')
  assert.ok(!/摄像头|D 盘/.test(c), `没绑线的会话只该看见 world：${c}`)

  try { rmSync(dir, { recursive: true, force: true }) } catch {}
})

test('guard 从工具参数里自动绑定文件线', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lm-'))
  const h = fakeHost()
  apply(h.ctx, { dbPath: join(dir, 'm.sqlite') })

  assert.equal(typeof h.guard, 'function', '应注册 tools.guard')
  await h.tools.memory_remember.execute({
    text: 'w04_canny.py 里原来的阈值 100/200 在光照差的时候会丢边缘',
    importance: 0.7,
    scope: 'file:w04_canny.py',
  })

  // 会话 s1 没碰过这个文件 → 看不见
  assert.ok(!/w04_canny/.test(blockFor(h, 's1')), '没碰过文件的会话不该看见这条')

  // 模拟一次 read 调用
  const verdict = h.guard({
    name: 'read',
    arguments: { file_path: 'C:\\work\\w04_canny.py' },
    agent: { session: { id: 's1' } },
  })
  assert.equal(verdict, undefined, 'guard 只绑定，不拦截')

  assert.match(blockFor(h, 's1'), /w04_canny\.py 里原来的阈值/, '碰过文件的会话该看见')
  assert.ok(!/w04_canny/.test(blockFor(h, 's2')), '别的会话仍然看不见')

  try { rmSync(dir, { recursive: true, force: true }) } catch {}
})

test('我的记忆块被抄回库里（回声）不该当记忆存', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lm-'))
  const h = fakeHost()
  apply(h.ctx, { dbPath: join(dir, 'm.sqlite') })

  h.handlers['session/event'](null, {
    type: 'assistant/message',
    seq: 1,
    data: {
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '- [工具|decision|0天前|R=1.00] Now index.js：噪声过滤换成 source.kind，结论是改用这个' }],
      },
    },
  })
  const review = JSON.parse(await h.tools.memory_review.execute({}))
  assert.equal(review.total, 0, `回声不该入库，实际 ${review.total} 条`)

  try { rmSync(dir, { recursive: true, force: true }) } catch {}
})

test('常驻卡：约束/决策每轮都在，普通事实走按需', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lm-'))
  const h = fakeHost()
  apply(h.ctx, { dbPath: join(dir, 'm.sqlite') })

  const exec = { agent: { session: { id: 's1' } } }
  await h.tools.memory_remember.execute({ text: '底线：绝不把隐私数据上传到任何第三方', importance: 0.95, kind: 'constraint' }, exec)
  await h.tools.memory_remember.execute({ text: '决策：改用 SQLite 存，不上 JSON 全量读写', importance: 0.9, kind: 'decision' }, exec)
  const fact = await h.tools.memory_remember.execute({ text: '这台机器是 Win11 25H2，Node 24', importance: 0.5, kind: 'fact' }, exec)
  assert.match(fact, /"pinned": false/)

  const block = blockFor(h, 's1')
  assert.match(block, /常驻·硬约束与已定决策/)
  assert.match(block, /绝不把隐私数据上传/)
  assert.match(block, /改用 SQLite/)
  // 事实不该进常驻卡
  const card = block.split('我记得的事')[0]
  assert.ok(!/Win11 25H2/.test(card), `事实不该进常驻卡：${card}`)

  try { rmSync(dir, { recursive: true, force: true }) } catch {}
})

test('memory_correct：旧条目标已更正、新条目生效，默认检索看不到旧的', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lm-'))
  const h = fakeHost()
  apply(h.ctx, { dbPath: join(dir, 'm.sqlite') })

  const created = JSON.parse(await h.tools.memory_remember.execute({
    text: '决策：摄像头截图用 png 存',
    importance: 0.9,
    kind: 'decision',
  }))
  const oldId = created.id

  const fixed = JSON.parse(await h.tools.memory_correct.execute({
    id: oldId,
    text: '决策：摄像头截图改存 jpg，省磁盘',
    reason: '磁盘不够',
  }))
  assert.equal(fixed.ok, true)
  assert.equal(fixed.superseded, oldId)

  const normal = JSON.parse(await h.tools.memory_recall.execute({ query: '摄像头 截图', k: 10 }))
  assert.ok(!normal.rows.some((r) => r.id === oldId), '旧条目不该再被检索到')
  assert.ok(normal.rows.some((r) => r.text.includes('jpg')), '新条目该在')

  const withHistory = JSON.parse(await h.tools.memory_recall.execute({ query: '摄像头 截图', k: 10, includeSuperseded: true }))
  const old = withHistory.rows.find((r) => r.id === oldId)
  assert.ok(old, '显式要历史时能翻出来')
  assert.equal(old.status, 'superseded')
  assert.match(old.why, /已更正/)
  assert.match(old.why, /→#/)

  try { rmSync(dir, { recursive: true, force: true }) } catch {}
})

test('memory_recall 每条都带 why', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lm-'))
  const h = fakeHost()
  apply(h.ctx, { dbPath: join(dir, 'm.sqlite') })
  await h.tools.memory_remember.execute({ text: '我在做 OpenCV 摄像头项目', importance: 0.7 })

  const got = JSON.parse(await h.tools.memory_recall.execute({ query: '摄像头', k: 3 }))
  assert.equal(got.matched, 1)
  assert.match(got.rows[0].why, /R [\d.]+×/)
  assert.match(got.rows[0].why, /重要度/)

  try { rmSync(dir, { recursive: true, force: true }) } catch {}
})

test('插件主干：采集 → 落库 → 下一轮注入', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lm-'))
  const dbPath = join(dir, 'memory.sqlite')
  const h = fakeHost()

  apply(h.ctx, { dbPath, maxChars: 700 })

  // 1) 注册成功：上下文 + 5 个工具 + 请求钩子
  assert.ok(h.contextDef, '应注册 systemPrompt.context')
  assert.equal(h.contextDef.name, 'long-term-memory')
  assert.deepEqual(Object.keys(h.tools).sort(), [
    'memory_correct',
    'memory_forget',
    'memory_impression',
    'memory_recall',
    'memory_remember',
    'memory_review',
    'task_list',
    'task_update',
  ])
  assert.ok(h.handlers['session/event'], '应挂 session/event')

  // 2) 用户说话了 → 触发一次请求钩子
  const events = [
    userEvent(1, '你好'),
    userEvent(2, '我不喜欢一上来就讲一堆理论，先给结论'),
  ]
  for (const ev of events) h.handlers['session/event'](null, ev)

  // 3) 注入文本里应该出现这条记忆 + 印象
  const block = h.contextDef.text({})
  assert.match(block, /长期记忆/)
  assert.match(block, /不喜欢一上来就讲一堆理论/)
  assert.match(block, /结论先行/)

  // 4) 工具能查到，并且带衰减信息
  const recalled = JSON.parse(await h.tools.memory_recall.execute({ query: '理论', k: 5 }))
  assert.equal(recalled.matched, 1)
  assert.ok(recalled.rows[0].retention > 0.9)
  assert.ok(recalled.rows[0].halfLifeDays > 5)

  // 5) 同一条消息重复处理不应翻倍（seq 游标）
  for (const ev of events) h.handlers['session/event'](null, ev)
  const review = JSON.parse(await h.tools.memory_review.execute({}))
  assert.equal(review.total, 1, `重复采集不该新增，实际 total=${review.total}`)

  // 6) 归档后不再出现在注入里
  await h.tools.memory_forget.execute({ id: recalled.rows[0].id })
  const block2 = h.contextDef.text({})
  assert.ok(!/不喜欢一上来就讲一堆理论/.test(block2), '归档后不该再注入')

  // 7) 落盘：重开一个插件实例，记忆还在
  const h2 = fakeHost()
  apply(h2.ctx, { dbPath })
  const review2 = JSON.parse(await h2.tools.memory_review.execute({ includeArchived: true }))
  assert.equal(review2.total, 1, '重启后记忆应仍在 SQLite 里')
  assert.equal(review2.rows[0].archived, true)

  try { rmSync(dir, { recursive: true, force: true }) } catch {}
})

test('记忆按重要度/情绪分档衰减，重要的话留得更久', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lm-'))
  const h = fakeHost()
  apply(h.ctx, { dbPath: join(dir, 'm.sqlite') })

  await h.tools.memory_remember.execute({ text: '我的底线是绝不泄露隐私数据', importance: 0.95, tags: '底线' })
  await h.tools.memory_remember.execute({ text: '今天吃了碗面', importance: 0.1 })

  const review = JSON.parse(await h.tools.memory_review.execute({}))
  const a = review.rows.find((r) => r.text.includes('底线'))
  const b = review.rows.find((r) => r.text.includes('吃'))
  assert.ok(a.halfLife > b.halfLife * 2, `底线记忆半衰期应远长于闲聊：${a.halfLife} vs ${b.halfLife}`)

  try { rmSync(dir, { recursive: true, force: true }) } catch {}
})

test('助手的技术结论会被记成 decision（P2）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lm-'))
  const h = fakeHost()
  apply(h.ctx, { dbPath: join(dir, 'm.sqlite') })

  const said = 'Node 24 上实测 Session.events 取到 undefined，改用 session.log 才对。其余不用改。'
  h.handlers['session/event'](null, {
    type: 'assistant/message',
    seq: 9,
    data: { message: { role: 'assistant', content: [{ type: 'text', text: said }] } },
  })

  const review = JSON.parse(await h.tools.memory_review.execute({}))
  const row = review.rows.find((r) => r.kind === 'decision')
  assert.ok(row, `应有一条 decision，实际：${JSON.stringify(review.rows)}`)
  assert.match(row.text, /改用 session/)

  // 普通解释性长文不该被记
  h.handlers['session/event'](null, {
    type: 'assistant/message',
    seq: 10,
    data: { message: { role: 'assistant', content: [{ type: 'text', text: '这个函数的作用是把图像转成灰度，然后做高斯模糊，最后检测边缘。' }] } },
  })
  const review2 = JSON.parse(await h.tools.memory_review.execute({}))
  assert.equal(review2.total, review.total, '无结论句的回复不应新增记忆')

  try { rmSync(dir, { recursive: true, force: true }) } catch {}
})

test('「测试/检验一下」这类元讨论不进记忆；带具体活儿的照记', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lm-'))
  const h = fakeHost()
  apply(h.ctx, { dbPath: join(dir, 'm.sqlite') })

  h.handlers['session/event'](null, { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: '只是检验一下你会不会读取失误' }] } })
  h.handlers['session/event'](null, { type: 'user/message', seq: 2, data: { content: [{ type: 'text', text: '测试一下我的人设你还记得吗' }] } })
  let review = JSON.parse(await h.tools.memory_review.execute({}))
  assert.equal(review.total, 0, `元讨论不该入库，实际 ${review.total} 条`)

  h.handlers['session/event'](null, { type: 'user/message', seq: 3, data: { content: [{ type: 'text', text: '测试一下那个 w04 的 canny 脚本为什么一跑就报错，我这边卡在阈值那步了' }] } })
  review = JSON.parse(await h.tools.memory_review.execute({}))
  assert.equal(review.total, 1, '带具体任务的测试请求应当入库')

  try { rmSync(dir, { recursive: true, force: true }) } catch {}
})

test('汇报里的编号条目不算决策（否则常驻卡会被清单塞满）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lm-'))
  const h = fakeHost()
  apply(h.ctx, { dbPath: join(dir, 'm.sqlite') })

  h.handlers['session/event'](null, {
    type: 'assistant/message',
    seq: 1,
    data: {
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '1. **时段**——你现在 23 点干活，正好是空闲价，改成白天直接翻倍' }],
      },
    },
  })
  const review = JSON.parse(await h.tools.memory_review.execute({}))
  assert.equal(review.total, 0, '编号条目不该入库')

  try { rmSync(dir, { recursive: true, force: true }) } catch {}
})

test('启动时归档"汇报碎片当决策"的旧记忆', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lm-'))
  const dbPath = join(dir, 'm.sqlite')
  const { openStore } = await import('../src/store.js')
  const seed = openStore(dbPath)
  seed.saveMemories([
    { id: 1, text: '1. **时段**——你现在 23 点干活，正好是空闲价', kind: 'decision', importance: 0.7, emotion: 0.2, hits: 0, createdAt: 1, lastHitAt: Date.now(), tags: [], archived: false, scope: 'world', status: 'active' },
    { id: 2, text: '决策：改用 SQLite 存，不上 JSON 全量读写', kind: 'decision', importance: 0.8, emotion: 0.2, hits: 0, createdAt: 1, lastHitAt: Date.now(), tags: [], archived: false, scope: 'world', status: 'active' },
  ])
  seed.close()

  const h = fakeHost()
  apply(h.ctx, { dbPath })
  const review = JSON.parse(await h.tools.memory_review.execute({ includeArchived: true }))
  const junk = review.rows.find((r) => r.id === 1)
  const real = review.rows.find((r) => r.id === 2)
  assert.equal(junk.archived, true, '编号条目该被归档')
  assert.equal(real.archived, false, '真决策不动')

  try { rmSync(dir, { recursive: true, force: true }) } catch {}
})

test('任务：记进行中的事、跨重启还在、注入里能看到', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lm-'))
  const dbPath = join(dir, 'm.sqlite')
  const exec = { agent: { session: { id: 's-task' } } }

  const h = fakeHost()
  apply(h.ctx, { dbPath })
  const up = JSON.parse(await h.tools.task_update.execute({ title: '把 D2 的表情识别跑通', status: 'doing', note: '还在调阈值' }, exec))
  assert.equal(up.ok, true)
  assert.equal(up.task.status, 'doing')

  // 同标题再更新 = 改状态，不新增
  await h.tools.task_update.execute({ title: '把 D2 的表情识别跑通', status: 'blocked', note: '卡在数据标注' }, exec)
  const list = JSON.parse(await h.tools.task_list.execute({}))
  assert.equal(list.total, 1)
  assert.equal(list.tasks[0].status, 'blocked')

  // 注入里能看到
  assert.match(blockFor(h, 's-task'), /进行中的事/)
  assert.match(blockFor(h, 's-task'), /表情识别/)

  // 重启后任务还在
  const h2 = fakeHost()
  apply(h2.ctx, { dbPath })
  const list2 = JSON.parse(await h2.tools.task_list.execute({ status: 'all' }))
  assert.equal(list2.total, 1)
  assert.equal(list2.tasks[0].note, '卡在数据标注')

  try { rmSync(dir, { recursive: true, force: true }) } catch {}
})

test('BM25：罕见词能把对的记忆顶上来', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lm-'))
  const h = fakeHost()
  apply(h.ctx, { dbPath: join(dir, 'm.sqlite') })
  await h.tools.memory_remember.execute({ text: 'D 盘空间不足，想清理一下装游戏的地方', importance: 0.6 })
  await h.tools.memory_remember.execute({ text: 'OpenCV 摄像头帧率掉到 5，一开就卡', importance: 0.6 })
  await h.tools.memory_remember.execute({ text: '记忆插件的注入预算 maxChars 700 够不够', importance: 0.6 })

  const got = JSON.parse(await h.tools.memory_recall.execute({ query: '摄像头 帧率', k: 3 }))
  assert.match(got.rows[0].text, /摄像头/, `第一条应是摄像头那条，实际：${got.rows[0].text}`)
  assert.ok(got.rows[0].why.includes('相关'), 'why 里要有相关度这一项')

  try { rmSync(dir, { recursive: true, force: true }) } catch {}
})
