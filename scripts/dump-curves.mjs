/**
 * dump-curves.mjs —— 用核心算法算 4 类记忆的 60 天保留度曲线，输出 JSON
 * 给 scripts/plot-decay.py 画图用。这样"图上的线"和"插件里跑的算法"是同一份代码。
 */
import { writeFileSync } from 'node:fs'
import { retention, halfLifeDays } from '../src/core.js'

const DAY = 24 * 3600 * 1000
const START = Date.UTC(2026, 10, 1, 12, 0, 0)

const profiles = [
  { label: '闲聊/寒暄（重要度 0.2）', importance: 0.2, emotion: 0.1, hits: 0, kind: 'casual' },
  { label: '一般事实（重要度 0.5）', importance: 0.5, emotion: 0.3, hits: 1, kind: 'fact' },
  { label: '稳定偏好（重要度 0.8，说过 3 次）', importance: 0.8, emotion: 0.3, hits: 3, kind: 'preference' },
  { label: '底线/强情绪（重要度 0.95，说过 6 次）', importance: 0.95, emotion: 0.8, hits: 6, kind: 'core' },
]

const out = { days: [], series: [] }
for (let d = 0; d <= 60; d++) out.days.push(d)

for (const p of profiles) {
  const mem = {
    importance: p.importance,
    emotion: p.emotion,
    hits: p.hits,
    createdAt: START,
    lastHitAt: START,
    archived: false,
  }
  out.series.push({
    ...p,
    halfLifeDays: Number(halfLifeDays(mem).toFixed(2)),
    values: out.days.map((d) => Number(retention(mem, START + d * DAY).toFixed(4))),
  })
}

writeFileSync(new URL('../out/decay-curves.json', import.meta.url), JSON.stringify(out, null, 2))
console.log('半衰期（天）:')
for (const s of out.series) console.log(`  ${s.label} -> ${s.halfLifeDays}`)
console.log('已写出 out/decay-curves.json')
