/**
 * store.test.mjs —— 落盘层的回归测试
 *
 * 盯的是两个曾经真出过事的地方：
 *   1. impressions 表用 trait 单列做主键 → 同一 trait 的第二个值被覆盖，重启后「有时 A 有时 B」消失
 *   2. 旧库（已是单列主键）能不能自动迁移，不丢现存数据
 *
 * 运行：node tests/store.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openStore } from '../src/store.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'dsh-lm-store-'))

function imp(value, confidence, evidence = 1) {
  return { trait: '表达习惯', value, confidence, evidence, conflicts: 0, updatedAt: 1 }
}

test('1. 同一 trait 的多个值都落盘，重开库不丢', () => {
  const dir = tmp()
  const dbPath = join(dir, 'm.sqlite')

  const s1 = openStore(dbPath)
  assert.equal(s1.kind, 'sqlite', '本机 Node 应带 node:sqlite')
  s1.saveImpressions([imp('短句直给', 0.9, 20), imp('愿意展开细说', 0.8, 5)])
  assert.equal(s1.loadImpressions().length, 2)
  s1.close()

  const s2 = openStore(dbPath)
  const back = s2.loadImpressions()
  const values = back.map((r) => r.value).sort()
  assert.deepEqual(values, ['愿意展开细说', '短句直给'], `重启后两个值都应在，实际：${values}`)
  const short = back.find((r) => r.value === '短句直给')
  assert.equal(short.evidence, 20)
  s2.close()

  rmSync(dir, { recursive: true, force: true })
})

test('2. 同一个 (trait,value) 重复写是更新，不新增行', () => {
  const dir = tmp()
  const s = openStore(join(dir, 'm.sqlite'))
  s.saveImpressions([imp('短句直给', 0.5, 1)])
  s.saveImpressions([imp('短句直给', 0.9, 7)])
  const rows = s.loadImpressions()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].confidence, 0.9)
  assert.equal(rows[0].evidence, 7)
  s.close()
  rmSync(dir, { recursive: true, force: true })
})

test('3. 旧库（trait 单列主键）自动迁移，现存数据保住', () => {
  const dir = tmp()
  const dbPath = join(dir, 'legacy.sqlite')

  // 手搓一个旧版表结构，塞进一条旧数据
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
  const raw = new DatabaseSync(dbPath)
  raw.exec(`
    CREATE TABLE impressions (
      trait       TEXT PRIMARY KEY,
      value       TEXT    NOT NULL,
      confidence  REAL    NOT NULL,
      evidence    INTEGER NOT NULL DEFAULT 0,
      conflicts   INTEGER NOT NULL DEFAULT 0,
      updated_at  INTEGER NOT NULL
    );
  `)
  raw.prepare('INSERT INTO impressions (trait,value,confidence,evidence,conflicts,updated_at) VALUES (?,?,?,?,?,?)')
    .run('表达习惯', '短句直给', 0.95, 25, 0, 1)
  raw.close()

  const s = openStore(dbPath)
  const after = s.loadImpressions()
  assert.equal(after.length, 1, '迁移不该丢旧数据')
  assert.equal(after[0].value, '短句直给')

  // 迁移之后，同 trait 的第二个值必须能存下（旧表这里会被覆盖）
  s.saveImpressions([imp('短句直给', 0.95, 25), imp('愿意展开细说', 0.7, 4)])
  assert.equal(s.loadImpressions().length, 2, '迁移后应支持同 trait 多值')
  s.close()

  // 再开一次：已经迁过，不该重复迁移、也不该再动数据
  const s2 = openStore(dbPath)
  assert.equal(s2.loadImpressions().length, 2)
  s2.close()

  rmSync(dir, { recursive: true, force: true })
})

test('5. last_source 落盘 + 老库（没有这一列）自动补列', () => {
  const dir = tmp()
  const dbPath = join(dir, 'm.sqlite')

  // 先手搓一个"上一版"的表：复合主键正确，但没有 last_source 列
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
  const raw = new DatabaseSync(dbPath)
  raw.exec(`
    CREATE TABLE impressions (
      trait TEXT NOT NULL, value TEXT NOT NULL, confidence REAL NOT NULL,
      evidence INTEGER NOT NULL DEFAULT 0, conflicts INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL, PRIMARY KEY (trait, value)
    );
  `)
  raw.prepare('INSERT INTO impressions VALUES (?,?,?,?,?,?)').run('要求', '要结论先行', 0.8, 3, 0, 1)
  raw.close()

  const s = openStore(dbPath)
  assert.equal(s.loadImpressions()[0].lastSource, null, '老库读出来 last_source 应是 null，不是崩')

  s.saveImpressions([
    { trait: '要求', value: '要结论先行', confidence: 0.8, evidence: 3, conflicts: 0, updatedAt: 1, lastSource: 'session-abc' },
  ])
  assert.equal(s.loadImpressions()[0].lastSource, 'session-abc', '补列后应能存会话 id')
  s.close()

  const s2 = openStore(dbPath)
  assert.equal(s2.loadImpressions()[0].lastSource, 'session-abc', '重开库应还在')
  s2.close()

  rmSync(dir, { recursive: true, force: true })
})

test('6. scope 落盘 + 会话绑定（只绑不重复、能清理）', () => {
  const dir = tmp()
  const s = openStore(join(dir, 'm.sqlite'))

  s.saveMemories([
    { id: 1, text: '称呼：Alex', kind: 'fact', importance: 0.9, emotion: 0.2, hits: 0, createdAt: 1, lastHitAt: 1, tags: [], archived: false, scope: 'world' },
    { id: 2, text: 'OpenCV 摄像头', kind: 'fact', importance: 0.7, emotion: 0.2, hits: 0, createdAt: 1, lastHitAt: 1, tags: [], archived: false, scope: 'topic:学习' },
  ])
  const rows = s.listMemories()
  assert.equal(rows[1].scope, 'topic:学习', 'scope 应原样落盘')

  s.bindScope('sess-a', 'topic:学习')
  s.bindScope('sess-a', 'topic:学习')
  s.bindScope('sess-b', 'topic:装机')
  assert.deepEqual(s.listBindings('sess-a'), ['topic:学习'], '重复绑不该出现两条')
  assert.deepEqual(s.listBindings('sess-b'), ['topic:装机'])
  assert.deepEqual(s.listBindings('sess-none'), [])
  assert.deepEqual(s.listBindings(null), [], '没会话 id 就是空')

  assert.equal(s.pruneBindings(Date.now() + 1000), 2, '绑定时戳都早于阈值 → 全清')
  assert.deepEqual(s.listBindings('sess-a'), [])
  s.close()

  rmSync(dir, { recursive: true, force: true })
})

test('7. 老库没有 scope 列 → 自动补列，老数据落 world', () => {
  const dir = tmp()
  const dbPath = join(dir, 'legacy.sqlite')
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
  const raw = new DatabaseSync(dbPath)
  raw.exec(`
    CREATE TABLE memories (
      id INTEGER PRIMARY KEY, text TEXT NOT NULL, kind TEXT NOT NULL,
      importance REAL NOT NULL, emotion REAL NOT NULL, hits INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, last_hit_at INTEGER NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]', archived INTEGER NOT NULL DEFAULT 0
    );
  `)
  raw.prepare('INSERT INTO memories (id,text,kind,importance,emotion,hits,created_at,last_hit_at,tags,archived) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(1, '称呼：Alex', 'fact', 0.9, 0.2, 0, 1, 1, '[]', 0)
  raw.close()

  const s = openStore(dbPath)
  const rows = s.listMemories()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].scope, 'world', '补列后老数据默认 world')

  s.saveMemories([{ ...rows[0], scope: 'topic:工具' }])
  assert.equal(s.listMemories()[0].scope, 'topic:工具', '补列后能写进去')
  s.close()

  rmSync(dir, { recursive: true, force: true })
})

test('4. 记忆读写往返 + 归档位', () => {  const dir = tmp()
  const dbPath = join(dir, 'm.sqlite')
  const s = openStore(dbPath)
  s.saveMemories([
    { id: 1, text: '我的底线是隐私不外传', kind: 'fact', importance: 0.95, emotion: 0.4, hits: 2, createdAt: 1000, lastHitAt: 2000, tags: ['底线'], archived: false },
  ])
  const back = s.listMemories()
  assert.equal(back.length, 1)
  assert.deepEqual(back[0].tags, ['底线'])
  assert.equal(back[0].archived, false)
  s.close()
  rmSync(dir, { recursive: true, force: true })
})

test('8. status / superseded_by 落盘往返；老库缺这三列时默认 active', () => {
  const dir = tmp()
  const dbPath = join(dir, 'm.sqlite')
  const s = openStore(dbPath)
  s.saveMemories([
    { id: 1, text: '旧决策：用 png', kind: 'decision', importance: 0.9, emotion: 0.2, hits: 0, createdAt: 1, lastHitAt: 1, tags: [], archived: false, scope: 'world', status: 'superseded', supersededBy: 2, correctedAt: 123 },
    { id: 2, text: '新决策：用 jpg', kind: 'decision', importance: 0.9, emotion: 0.2, hits: 0, createdAt: 2, lastHitAt: 2, tags: [], archived: false, scope: 'world', status: 'active' },
  ])
  const rows = s.listMemories()
  assert.equal(rows[0].status, 'superseded')
  assert.equal(rows[0].supersededBy, 2)
  assert.equal(rows[0].correctedAt, 123)
  assert.equal(rows[1].status, 'active')
  s.close()

  const s2 = openStore(dbPath)
  assert.equal(s2.listMemories()[0].status, 'superseded', '重开库状态应保留')
  s2.close()
  rmSync(dir, { recursive: true, force: true })
})
