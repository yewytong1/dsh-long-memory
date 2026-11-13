/**
 * ab-real.mjs — 用真实库做 A/B：旧权重 vs 新权重
 *
 * 用法：node scripts/ab-real.mjs [数据库路径]
 * 默认读 $DSH_HOME/long-term-memory/memory.sqlite（只读），
 * 拿真实记忆跑同一批查询，比较新旧权重下"该命中的有没有进前 3"。
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { recall, bm25Scores, scoreParts, DEFAULTS } from '../src/core.js'

const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const DB = process.argv[2] || join(dshHome, 'long-term-memory', 'memory.sqlite')

if (!existsSync(DB)) {
  console.error(`找不到记忆库：${DB}`)
  console.error('用法：node scripts/ab-real.mjs [数据库路径]')
  console.error('如果 DSH 装在别处，设置环境变量 DSH_HOME 指向 .dsh 目录。')
  process.exit(1)
}
const db = new DatabaseSync(DB, { readOnly: true })
const raw = db.prepare(
  'SELECT id, text, kind, scope, importance, hits, created_at, last_hit_at, tags, archived, status, superseded_by FROM memories'
).all()
db.close()

const list = raw.map((r) => ({
  id: r.id,
  text: r.text,
  kind: r.kind,
  scope: r.scope ?? 'world',
  importance: r.importance,
  hits: r.hits,
  createdAt: r.created_at,
  lastHitAt: r.last_hit_at,
  tags: r.tags ? JSON.parse(r.tags) : [],
  archived: !!r.archived,
  status: r.status,
  supersededBy: r.superseded_by,
}))

const oldCfg = { ...DEFAULTS, wRetention: 0.45, wImportance: 0.3, wRelevance: 0.25, minRelevance: 0 }
const newCfg = { ...DEFAULTS }
const now = Date.now()

// 用"这个词真的存在于某条记忆里"来判断期望值，不靠硬编码
const cases = ['实习', 'OpenCV', 'UCPD', 'imread', 'PowerShell', '摄像头', '实验报告', '默认应用']
  .map((q) => ({ q, want: list.filter((m) => m.text.includes(q)).map((m) => m.id) }))
  .filter((c) => c.want.length > 0)

const K = 6

function run(cfg) {
  let top1 = 0
  let topK = 0
  const rows = []
  for (const c of cases) {
    const bm25 = bm25Scores(list, c.q)
    const got = recall(list, now, { cfg, k: K, relevanceOf: (m) => bm25.get(m.id) ?? 0 })
    const ids = got.map((r) => r.mem.id)
    const has1 = c.want.includes(ids[0])
    const hasK = ids.some((id) => c.want.includes(id))
    if (has1) top1++
    if (hasK) topK++
    rows.push({ q: c.q, want: c.want, ids, has1, hasK, n: got.length })
  }
  return { top1, topK, rows }
}

const A = run(oldCfg)
const B = run(newCfg)

const pad = (s, n) => String(s).padEnd(n)
console.log(`库内记忆 ${list.length} 条，查询 ${cases.length} 组，取前 ${K} 条\n`)
console.log(`${pad('查询', 12)}${pad('期望 id', 16)}${pad('旧:实际返回', 40)}旧${pad('', 3)}${pad('新:实际返回', 40)}新`)
for (let i = 0; i < cases.length; i++) {
  const a = A.rows[i]
  const b = B.rows[i]
  console.log(
    pad(a.q, 12) +
    pad(a.want.join('/'), 16) +
    pad(a.ids.join(',') || '空', 40) + (a.has1 ? '✅' : '❌') + '  ' +
    pad(b.ids.join(',') || '空', 40) + (b.has1 ? '✅' : '❌')
  )
}
console.log(`\n${pad('', 68)}旧 ${A.top1}/${cases.length}  新 ${B.top1}/${cases.length}   ← top1 命中`)
console.log(`${pad('', 68)}旧 ${A.topK}/${cases.length}  新 ${B.topK}/${cases.length}   ← top${K} 命中`)
console.log(`${pad('', 68)}旧 平均返回 ${(A.rows.reduce((s, r) => s + r.n, 0) / A.rows.length).toFixed(1)} 条   新 平均返回 ${(B.rows.reduce((s, r) => s + r.n, 0) / B.rows.length).toFixed(1)} 条`)
