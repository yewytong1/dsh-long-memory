/**
 * inspect-session.mjs —— 开发期工具：解压一条 DSH 会话记录（多帧 zstd），看事件结构
 *
 * 结论（2026-11-10 实测）：session.v4.jsonl.zstd 是**多帧 zstd 拼接**，
 * 每帧解出来是一行 JSON 事件 {type, seq, time, data}，第一帧是 session 头。
 * 一次性 zstdDecompressSync 只解第一帧，所以必须按魔数切帧逐个解。
 *
 * 用法：node scripts/inspect-session.mjs <session.v4.jsonl.zstd> [最大样本数]
 */
import { readFileSync } from 'node:fs'
import zlib from 'node:zlib'

const file = process.argv[2]
const maxSample = Number(process.argv[3] ?? 2)
if (!file) {
  console.error('用法: node scripts/inspect-session.mjs <session.v4.jsonl.zstd> [最大样本数]')
  process.exit(1)
}

const buf = readFileSync(file)
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

const starts = []
for (let i = 0; i + 4 <= buf.length; i++) {
  if (buf.compare(MAGIC, 0, 4, i, i + 4) === 0) starts.push(i)
}

const events = []
let bad = 0
for (const s of starts) {
  let text
  try {
    text = zlib.zstdDecompressSync(buf.subarray(s)).toString('utf8')
  } catch {
    bad++
    continue
  }
  // 一帧里可能是多行 JSONL：逐行解析
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      bad++
    }
  }
}

console.log(`帧数: ${starts.length}  解析成功: ${events.length}  失败: ${bad}`)

const counts = new Map()
for (const ev of events) {
  const t = ev.type ?? '(none)'
  counts.set(t, (counts.get(t) ?? 0) + 1)
}
console.log('\n事件类型统计:')
for (const [t, c] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(c).padStart(5)}  ${t}`)
}

// 重点看：用户消息 / 助手消息 / 工具调用 长什么样
const wanted = ['message', 'user/message', 'assistant/message', 'tool/call', 'command/done']
console.log('\n样本:')
for (const t of wanted) {
  const arr = events.filter((e) => e.type === t).slice(0, maxSample)
  for (const ev of arr) {
    const s = JSON.stringify(ev)
    console.log(`\n--- ${t} (seq=${ev.seq}) ---`)
    console.log(s.length > 700 ? s.slice(0, 700) + ' …' : s)
  }
}
