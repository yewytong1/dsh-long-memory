/**
 * build-panel.mjs —— 生成「记忆星图」面板（自包含 HTML，双击就能看）
 *
 * 设计原则：
 *   1. 只读：用 readOnly 打开 sqlite，不写库、不建表、不改数据
 *   2. 离线：不引 CDN、不联网，图表全是内联 SVG
 *   3. 复用算法：保留度/半衰期/注入文本都调 core.js，不在面板里重算一套
 *
 * 用法：node scripts/build-panel.mjs [输出路径]
 * 产物：out/panel.html（默认），浏览器双击打开
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  DEFAULTS,
  ImpressionModel,
  halfLifeDays,
  recall,
  renderMemoryBlock,
  retention,
  scopeLabel,
} from '../src/core.js'

const DB = process.env.DSH_LONG_MEMORY_DB || join(homedir(), '.dsh', 'long-term-memory', 'memory.sqlite')
const OUT = process.argv[2] || join(process.cwd(), 'out', 'panel.html')
const MAX_CHARS = 700
const TOP_K = 6

// ---------------------------------------------------------------- 读库（只读）
const db = new DatabaseSync(DB, { readOnly: true })
const now = Date.now()

const memories = db.prepare('SELECT * FROM memories ORDER BY id').all().map((r) => ({
  id: r.id,
  text: r.text,
  kind: r.kind,
  scope: r.scope || 'world',
  importance: r.importance,
  emotion: r.emotion,
  hits: r.hits,
  createdAt: r.created_at,
  lastHitAt: r.last_hit_at,
  tags: safeJson(r.tags, []),
  archived: !!r.archived,
}))

const impressionRows = db.prepare('SELECT * FROM impressions').all().map((r) => ({
  trait: r.trait,
  value: r.value,
  confidence: r.confidence,
  evidence: r.evidence,
  conflicts: r.conflicts,
  updatedAt: r.updated_at,
  lastSource: r.last_source ?? null,
  sources: safeJson(r.evidence_sources ?? '[]', []),
}))
const impression = ImpressionModel.fromJSON(impressionRows, DEFAULTS)

const bindingRows = db.prepare('SELECT session_id, scope, bound_at FROM bindings ORDER BY bound_at').all()
// 老库可能还没有 tasks 表（升级发生在插件重新加载时）——面板要能容忍
let taskRows = []
try {
  taskRows = db
    .prepare("SELECT * FROM tasks WHERE status IN ('doing','blocked') ORDER BY updated_at DESC LIMIT 12")
    .all()
} catch {}
const bindings = new Map()
for (const b of bindingRows) {
  if (!bindings.has(b.session_id)) bindings.set(b.session_id, { scopes: [], lastAt: 0 })
  const g = bindings.get(b.session_id)
  g.scopes.push(b.scope)
  g.lastAt = Math.max(g.lastAt, b.bound_at)
}
db.close()

// ---------------------------------------------------------------- 算数（复用 core）
for (const m of memories) {
  m.R = retention(m, now, DEFAULTS)
  m.halfLife = halfLifeDays(m, DEFAULTS)
  m.ageDays = Math.max(0, (now - (m.lastHitAt ?? m.createdAt)) / 86400000)
}

const active = memories.filter((m) => !m.archived)
const archived = memories.filter((m) => m.archived)

const groups = new Map()
for (const m of memories) {
  if (!groups.has(m.scope)) groups.set(m.scope, [])
  groups.get(m.scope).push(m)
}

// 最近活跃的会话 → 拿它模拟一次注入
const recentSession = [...bindings.entries()].sort((a, b) => b[1].lastAt - a[1].lastAt)[0] ?? null
const recentScopes = recentSession ? recentSession[1].scopes : null
const recalled = recall(memories, now, {
  cfg: DEFAULTS,
  k: TOP_K,
  scopes: recentScopes ?? undefined,
  relevanceOf: () => 0.4,
})
const block = renderMemoryBlock(recalled, impression, { maxChars: MAX_CHARS })

// ---------------------------------------------------------------- 星图
const COLORS = {
  world: '#f5c451',
  'topic:学习': '#57c7ff',
  'topic:工具': '#b388ff',
  'topic:装机': '#ff8fb1',
  'topic:杂': '#97a3b8',
}
const colorOf = (scope) => COLORS[scope] ?? '#4ade80'

const W = 1000
const H = 668
const CX = 500
const CY = 315

/** 稳定的伪随机（同一个 id 每次都落在同一位置，重新生成不会跳） */
function hash01(n, salt = 1) {
  const x = Math.sin(n * 12.9898 + salt * 78.233) * 43758.5453
  return x - Math.floor(x)
}

const topicScopes = [...groups.keys()].filter((s) => s.startsWith('topic:')).sort()
const fileScopes = [...groups.keys()].filter((s) => s.startsWith('file:')).sort()
const centers = new Map()
centers.set('world', { x: CX, y: CY, ring: 62 })

// 话题线摆在内圈，但把「杂」固定放正下方：它是兜底线，通常星最多，放中下不挤别群
const MISC = 'topic:杂'
const namedTopics = topicScopes.filter((s) => s !== MISC)
const innerTopics = namedTopics.length + (topicScopes.includes(MISC) ? 1 : 0)
let ti = 0
for (const scope of namedTopics) {
  const slots = Math.max(innerTopics, 2)
  // 从左上开始顺时针铺开，正下方那个角度留给「杂」
  const a = -Math.PI * 0.78 + (ti * (Math.PI * 1.56)) / Math.max(1, slots - 1)
  ti++
  centers.set(scope, { x: CX + Math.cos(a) * 235, y: CY + Math.sin(a) * 150, ring: 0 })
}
if (topicScopes.includes(MISC)) {
  centers.set(MISC, { x: CX, y: CY + 184, ring: 0 })
}
// 文件线放外圈四个斜角，避开内圈星群
fileScopes.forEach((scope, i) => {
  const angles = [-2.36, -0.79, 0.79, 2.36]
  const a = angles[i % angles.length]
  centers.set(scope, { x: CX + Math.cos(a) * 405, y: CY + Math.sin(a) * 250, ring: 0 })
})

const placed = new Map()
const svgParts = []
svgParts.push(
  `<defs><radialGradient id="bg" cx="50%" cy="45%" r="70%"><stop offset="0%" stop-color="#14203a"/><stop offset="100%" stop-color="#070b14"/></radialGradient></defs>`,
)
svgParts.push(`<rect width="${W}" height="${H}" fill="url(#bg)"/>`)

// 淡淡的网格，像星图底图
for (let i = 1; i < 5; i++) {
  svgParts.push(`<circle cx="${CX}" cy="${CY}" r="${i * 120}" fill="none" stroke="#2b3a5c" stroke-width="0.6" opacity="0.35"/>`)
}
svgParts.push(`<line x1="0" y1="${CY}" x2="${W}" y2="${CY}" stroke="#2b3a5c" stroke-width="0.5" opacity="0.25"/>`)
svgParts.push(`<line x1="${CX}" y1="0" x2="${CX}" y2="${H}" stroke="#2b3a5c" stroke-width="0.5" opacity="0.25"/>`)

// 星群：先画星座连线，再画星，最后画标签
for (const [scope, list] of groups) {
  const c = centers.get(scope) ?? { x: CX, y: CY, ring: 60 }
  const n = list.length
  const ringCap = scope === MISC ? 68 : 88
  const ring = c.ring || Math.min(26 + n * 7, ringCap)
  const color = colorOf(scope)

  const nodes = list.map((m, i) => {
    if (n === 1) return { m, x: c.x, y: c.y }
    const baseAngle = (i * 2 * Math.PI) / n
    const jitter = (hash01(m.id, 3) - 0.5) * 0.42
    const rr = ring * (0.72 + hash01(m.id, 7) * 0.5)
    return { m, x: c.x + Math.cos(baseAngle + jitter) * rr, y: c.y + Math.sin(baseAngle + jitter) * rr * 0.86 }
  })
  for (const p of nodes) placed.set(p.m.id, p)

  if (nodes.length > 2) {
    const pts = nodes.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
    svgParts.push(
      `<polygon points="${pts}" fill="none" stroke="${color}" stroke-width="0.7" opacity="0.22" stroke-linejoin="round"/>`,
    )
  }
  // 群名
  const labelY = Math.min(...nodes.map((p) => p.y)) - 14
  const labelX = c.x
  svgParts.push(
    `<text x="${labelX.toFixed(0)}" y="${labelY.toFixed(0)}" fill="${color}" font-size="12" opacity="0.85" text-anchor="middle" font-family="Segoe UI, sans-serif">${esc(scope === 'world' ? '世界层 · 你这个人' : scope)} · ${n}</text>`,
  )
}

// 星
for (const m of memories) {
  const p = placed.get(m.id)
  if (!p) continue
  const color = colorOf(m.scope)
  const r = 2.2 + 5.6 * clamp01(m.importance)
  const bright = 0.3 + 0.7 * clamp01(m.R)
  const tip = `${m.scope}｜R=${m.R.toFixed(2)}｜重要度 ${m.importance.toFixed(2)}｜${m.hits} 次提起\n${m.text.slice(0, 90)}`
  if (m.archived) {
    svgParts.push(
      `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${(r + 1).toFixed(1)}" fill="none" stroke="${color}" stroke-width="0.9" opacity="0.45" stroke-dasharray="2 2"><title>${esc(tip)}\n(已归档)</title></circle>`,
    )
  } else {
    svgParts.push(`<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${(r * 2.6).toFixed(1)}" fill="${color}" opacity="${(bright * 0.14).toFixed(3)}"><title>${esc(tip)}</title></circle>`)
    svgParts.push(`<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r.toFixed(1)}" fill="${color}" opacity="${bright.toFixed(3)}"><title>${esc(tip)}</title></circle>`)
  }
  // 特别重要的星加个十字光芒
  if (!m.archived && m.importance >= 0.9) {
    const s = r * 3.4
    svgParts.push(
      `<g stroke="${color}" stroke-width="0.6" opacity="${(bright * 0.5).toFixed(2)}"><line x1="${(p.x - s).toFixed(1)}" y1="${p.y.toFixed(1)}" x2="${(p.x + s).toFixed(1)}" y2="${p.y.toFixed(1)}"/><line x1="${p.x.toFixed(1)}" y1="${(p.y - s).toFixed(1)}" x2="${p.x.toFixed(1)}" y2="${(p.y + s).toFixed(1)}"/></g>`,
    )
  }
}

// 图例
const legendY = H - 30
svgParts.push(
  `<text x="24" y="${legendY}" fill="#8fa3c8" font-size="12" font-family="Segoe UI, sans-serif">星越大越重要｜越亮越新鲜（暗=快忘）｜虚线空心=已归档｜鼠标悬停看原文</text>`,
)
let lx = 24
let ly = legendY + 20
for (const [scope, color] of [
  ['world', COLORS.world],
  ['topic:学习', COLORS['topic:学习']],
  ['topic:工具', COLORS['topic:工具']],
  ['topic:装机', COLORS['topic:装机']],
  ['topic:杂', COLORS['topic:杂']],
  ['file:*', '#4ade80'],
]) {
  svgParts.push(`<circle cx="${lx}" cy="${ly - 4}" r="4" fill="${color}"/>`)
  svgParts.push(`<text x="${lx + 10}" y="${ly}" fill="#a8b8d8" font-size="11" font-family="Segoe UI, sans-serif">${esc(scope)}</text>`)
  lx += 24 + scope.length * 7.4
}

const svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="记忆星图">${svgParts.join('')}</svg>`

// ---------------------------------------------------------------- 表格
const scopeRows = [...groups.entries()]
  .sort((a, b) => b[1].length - a[1].length)
  .map(([scope, list]) => {
    const alive = list.filter((m) => !m.archived).length
    return `<tr><td><span class="dot" style="background:${colorOf(scope)}"></span>${esc(scope)}</td><td class="num">${list.length}</td><td class="num">${alive}</td><td class="num">${list.length - alive}</td></tr>`
  })
  .join('')

const memoryRows = [...memories]
  .sort((a, b) => a.R - b.R)
  .slice(0, 30)
  .map(
    (m) => `<tr class="${m.archived ? 'arch' : ''}">
      <td class="num">#${m.id}</td>
      <td><span class="tag" style="color:${colorOf(m.scope)}">${esc(scopeLabel(m.scope) || 'world')}</span></td>
      <td class="txt">${esc(m.text.slice(0, 60))}${m.text.length > 60 ? '…' : ''}</td>
      <td class="num">${m.R.toFixed(2)}</td>
      <td class="num">${m.halfLife.toFixed(0)}d</td>
      <td class="num">${m.importance.toFixed(2)}</td>
      <td class="num">${m.hits}</td>
      <td class="num">${m.ageDays.toFixed(0)}d</td>
    </tr>`,
  )
  .join('')

const impressionRowsHtml = impressionRows
  .map((it) => {
    const model = impression.items.get(impression.key(it.trait, it.value))
    const current = model ? impression.confidenceOf(model, now) : it.confidence
    const dropped = it.confidence - current
    return `<tr>
      <td>${esc(it.trait)}</td>
      <td>${esc(it.value)}</td>
      <td class="num">${(current * 100).toFixed(0)}%${dropped > 0.005 ? ` <span class="dim">(存 ${(it.confidence * 100).toFixed(0)}%)</span>` : ''}</td>
      <td class="num">${it.evidence}</td>
      <td class="num">${it.conflicts}</td>
      <td class="num">${Math.round((now - it.updatedAt) / 86400000)}d</td>
    </tr>`
  })
  .join('')

const bindingRowsHtml = [...bindings.entries()]
  .sort((a, b) => b[1].lastAt - a[1].lastAt)
  .map(
    ([sid, g]) => `<tr>
      <td class="mono">${esc(sid.slice(0, 8))}…</td>
      <td>${g.scopes.map((s) => `<span class="tag" style="color:${colorOf(s)}">${esc(s)}</span>`).join(' ')}</td>
      <td class="num">${Math.round((now - g.lastAt) / 60000)} 分钟前</td>
    </tr>`,
  )
  .join('')

const recalledRowsHtml = recalled
  .map(
    (r) => `<tr>
      <td class="num">${r.score.toFixed(2)}</td>
      <td><span class="tag" style="color:${colorOf(r.mem.scope)}">${esc(scopeLabel(r.mem.scope) || 'world')}</span></td>
      <td class="txt">${esc(r.mem.text.slice(0, 56))}${r.mem.text.length > 56 ? '…' : ''}</td>
      <td class="num">${r.mem.R.toFixed(2)}</td>
    </tr>`,
  )
  .join('')

const blockPct = Math.min(100, (block.length / MAX_CHARS) * 100)

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>记忆星图 · dsh-long-memory</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; background:#070b14; color:#dbe4f5; font:14px/1.6 "Segoe UI","Microsoft YaHei",sans-serif; }
  .wrap { max-width: 1040px; margin: 0 auto; padding: 28px 20px 60px; }
  h1 { font-size: 22px; margin: 0 0 4px; letter-spacing: .5px; }
  .sub { color:#7f8fb0; font-size:12px; margin-bottom:18px; }
  .kpis { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:18px; }
  .kpi { background:#0e1729; border:1px solid #1c2942; border-radius:10px; padding:10px 14px; min-width:104px; }
  .kpi b { display:block; font-size:20px; color:#eaf1ff; }
  .kpi span { font-size:11px; color:#7f8fb0; }
  .card { background:#0a1120; border:1px solid #18233a; border-radius:12px; margin:16px 0; overflow:hidden; }
  .card h2 { font-size:13px; font-weight:600; margin:0; padding:11px 16px; color:#9fb4d8; border-bottom:1px solid #18233a; letter-spacing:.4px; }
  .card .body { padding: 6px 0 2px; }
  .card .pad { padding: 12px 16px; }
  table { width:100%; border-collapse: collapse; font-size:12.5px; }
  th { text-align:left; font-weight:500; color:#6f82a6; padding:6px 12px; border-bottom:1px solid #18233a; white-space:nowrap; }
  td { padding:6px 12px; border-bottom:1px solid #101a2c; vertical-align: top; }
  tr:last-child td { border-bottom: none; }
  td.num { color:#9fb4d8; white-space:nowrap; font-variant-numeric: tabular-nums; }
  td.txt { color:#c8d4ea; }
  tr.arch td { opacity:.45; text-decoration: line-through; }
  .tag { font-size:11px; border:1px solid currentColor; border-radius:5px; padding:0 5px; opacity:.9; }
  .dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:6px; vertical-align:1px; }
  .dim { color:#5d6f92; }
  .mono { font-family: Consolas, monospace; color:#8ba0c8; }
  .bar { height:6px; background:#121c30; border-radius:3px; overflow:hidden; margin:6px 0 12px; }
  .bar > i { display:block; height:100%; background:linear-gradient(90deg,#57c7ff,#b388ff); }
  pre { margin:0; padding:12px 16px; background:#060b14; border-top:1px solid #18233a; font:12px/1.7 Consolas,"Microsoft YaHei",monospace; color:#a9bbd9; white-space:pre-wrap; }
  .note { color:#5d6f92; font-size:11.5px; padding:10px 16px 14px; }
  svg { display:block; }
</style></head>
<body><div class="wrap">
  <h1>记忆星图</h1>
  <div class="sub">由 dsh-long-memory 库生成 · 只读快照 · 生成于 ${new Date(now).toLocaleString('zh-CN')} · 库文件 ${esc(DB)}</div>

  <div class="kpis">
    <div class="kpi"><b>${memories.length}</b><span>记忆总数</span></div>
    <div class="kpi"><b>${active.length}</b><span>活跃</span></div>
    <div class="kpi"><b>${archived.length}</b><span>已归档</span></div>
    <div class="kpi"><b>${impressionRows.length}</b><span>印象条目</span></div>
    <div class="kpi"><b>${bindings.size}</b><span>绑定会话</span></div>
    <div class="kpi"><b>${groups.size}</b><span>记忆线</span></div>
  </div>

  <div class="card">
    <h2>进行中的事（跨会话交接用）</h2>
    <div class="body"><table>
      <tr><th>状态</th><th>任务</th><th>到哪了</th><th>更新</th></tr>
      ${
        taskRows.length
          ? taskRows
              .map(
                (t) => `<tr>
        <td>${t.status === 'blocked' ? '⏸ 卡住' : '▸ 在做'}</td>
        <td class="txt">${esc(String(t.title).slice(0, 56))}</td>
        <td class="dim">${esc(String(t.note ?? '').slice(0, 40))}</td>
        <td class="num">${Math.round((now - t.updated_at) / 3600000)} 小时前</td>
      </tr>`,
              )
              .join('')
          : '<tr><td colspan="4" class="dim">还没有进行中的事（用 task_update 记）</td></tr>'
      }
    </table></div>
  </div>

  <div class="card">
    <h2>星图 · 每个星群是一条线</h2>
    <div class="body">${svg}</div>
  </div>

  <div class="card">
    <h2>本轮会注入什么${recentSession ? `（最近活跃会话 ${esc(recentSession[0].slice(0, 8))}…）` : '（没有会话绑定，退回全池）'}</h2>
    <div class="pad">
      <div class="bar"><i style="width:${blockPct.toFixed(1)}%"></i></div>
      <div class="dim" style="font-size:11.5px">${block.length} / ${MAX_CHARS} 字符${block.length >= MAX_CHARS ? '（已到顶，放不下的整条丢弃）' : ''}</div>
    </div>
    <div class="body"><table>
      <tr><th>检索分</th><th>线</th><th>内容</th><th>保留度</th></tr>
      ${recalledRowsHtml}
    </table></div>
    <pre>${esc(block)}</pre>
  </div>

  <div class="card">
    <h2>各条线</h2>
    <div class="body"><table>
      <tr><th>线</th><th>条数</th><th>活跃</th><th>归档</th></tr>
      ${scopeRows}
    </table></div>
  </div>

  <div class="card">
    <h2>记忆（按保留度升序，先看快忘的；最多列 30 条）</h2>
    <div class="body"><table>
      <tr><th>id</th><th>线</th><th>内容</th><th>R</th><th>半衰期</th><th>重要度</th><th>提起</th><th>多久没提</th></tr>
      ${memoryRows}
    </table></div>
    <div class="note">R = 0.5^(距上次提起天数 / 半衰期)。R 低于 ${DEFAULTS.archiveRetention} 且重要度低于 ${DEFAULTS.archiveImportance} 会被自动归档（软删，可捞回）。</div>
  </div>

  <div class="card">
    <h2>印象（置信度按 45 天半衰期折算后的当前值）</h2>
    <div class="body"><table>
      <tr><th>维度</th><th>取值</th><th>当前置信度</th><th>证据（会话数）</th><th>对立</th><th>最近见到</th></tr>
      ${impressionRowsHtml}
    </table></div>
  </div>

  <div class="card">
    <h2>会话 → 线 的绑定</h2>
    <div class="body"><table>
      <tr><th>会话</th><th>绑定的线</th><th>最后活跃</th></tr>
      ${bindingRowsHtml}
    </table></div>
    <div class="note">绑定由写入记忆和使用 read/write/edit 等工具时自动产生；没绑的线不会进入该会话的注入。</div>
  </div>

  <div class="note" style="text-align:center;padding-top:20px">
    只读快照 · 不联网 · 不加载任何外部资源。刷新方式：重跑 <span class="mono">node scripts/build-panel.mjs</span>
  </div>
</div></body></html>`

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, html, 'utf8')
console.log(`已生成：${OUT}`)
console.log(`  记忆 ${memories.length} 条（活跃 ${active.length} / 归档 ${archived.length}）· 线 ${groups.size} 条 · 印象 ${impressionRows.length} 条 · 绑定会话 ${bindings.size} 个`)
console.log(`  注入预览 ${recalled.length} 条 / ${block.length} 字符（上限 ${MAX_CHARS}）`)

// ---------------------------------------------------------------- 小工具
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
function clamp01(x) {
  const n = Number(x)
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0
}
function safeJson(s, fallback) {
  try {
    return JSON.parse(s)
  } catch {
    return fallback
  }
}
