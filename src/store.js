/**
 * store.js —— 记忆的落盘层（SQLite，node:sqlite 内置，不需要装包）
 *
 * 为什么用 SQLite 而不是 JSON：记忆会越攒越多，还要按键排序、按时间过滤；
 * JSON 每次全量读写，几百条之后就会拖慢每一轮。SQLite 单文件、零依赖、可随时用
 * DB Browser 打开看。
 *
 * 注意：如果运行环境没有 node:sqlite（Node < 22.5），openStore() 会退回内存模式，
 * 插件照常工作、只是重启后丢失——宁可用不了持久化，也不能让宿主起不来。
 */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const MEMORIES_SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
  id          INTEGER PRIMARY KEY,
  text        TEXT    NOT NULL,
  kind        TEXT    NOT NULL,
  importance  REAL    NOT NULL,
  emotion     REAL    NOT NULL,
  hits        INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  last_hit_at INTEGER NOT NULL,
  tags        TEXT    NOT NULL DEFAULT '[]',
  archived    INTEGER NOT NULL DEFAULT 0,
  scope       TEXT    NOT NULL DEFAULT 'world',
  status      TEXT    NOT NULL DEFAULT 'active',
  superseded_by INTEGER,
  corrected_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_memories_last_hit ON memories(archived, last_hit_at);
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bindings (
  session_id TEXT    NOT NULL,
  scope      TEXT    NOT NULL,
  bound_at   INTEGER NOT NULL,
  PRIMARY KEY (session_id, scope)
);
CREATE TABLE IF NOT EXISTS tasks (
  id         INTEGER PRIMARY KEY,
  title      TEXT    NOT NULL UNIQUE,
  status     TEXT    NOT NULL DEFAULT 'doing',
  note       TEXT    NOT NULL DEFAULT '',
  scope      TEXT    NOT NULL DEFAULT 'world',
  memory_id  INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`

// 依赖 scope 列的索引必须等 ensureColumn() 补完列之后再建（老库没有这一列）
const SCOPE_INDEX = 'CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope, archived, last_hit_at)'

// 印象表的主键必须是 (trait, value)。
// 早先版本拿 trait 单列做主键，跟内存里的 `trait::value` 键对不上：同一个 trait 的第二个
// value 落盘时被 ON CONFLICT 覆盖，重启后「有时 A 有时 B」只剩一个 A。见 migrateImpressions()。
const IMPRESSIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS impressions (
  trait       TEXT    NOT NULL,
  value       TEXT    NOT NULL,
  confidence  REAL    NOT NULL,
  evidence    INTEGER NOT NULL DEFAULT 0,
  conflicts   INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL,
  last_source TEXT,
  evidence_sources TEXT,
  PRIMARY KEY (trait, value)
);
`

/**
 * 打开记忆库。
 * @param {string} dbPath 绝对路径；父目录不存在会自动建
 * @returns {object} 统一接口（内存模式时同样可用）
 */
export function openStore(dbPath) {
  let DatabaseSync = null
  try {
    // process.getBuiltinModule 是 Node 22.3+ 的同步取内置模块方式；
    // 拿不到就降级成内存模式，绝不让宿主因为缺 API 起不来
    DatabaseSync = process.getBuiltinModule?.('node:sqlite')?.DatabaseSync ?? null
  } catch {
    DatabaseSync = null
  }

  if (!DatabaseSync) return memoryStore()

  try {
    mkdirSync(dirname(dbPath), { recursive: true })
    const db = new DatabaseSync(dbPath)
    db.exec(MEMORIES_SCHEMA)
    db.exec(IMPRESSIONS_SCHEMA)
    migrateImpressions(db)
    ensureColumn(db, 'impressions', 'last_source', 'TEXT')
    ensureColumn(db, 'impressions', 'evidence_sources', 'TEXT')
    ensureColumn(db, 'memories', 'scope', "TEXT NOT NULL DEFAULT 'world'")
    ensureColumn(db, 'memories', 'status', "TEXT NOT NULL DEFAULT 'active'")
    ensureColumn(db, 'memories', 'superseded_by', 'INTEGER')
    ensureColumn(db, 'memories', 'corrected_at', 'INTEGER')
    db.exec(SCOPE_INDEX)

    return {
      kind: 'sqlite',
      path: dbPath,

      listMemories() {
        const rows = db.prepare('SELECT * FROM memories ORDER BY id').all()
        return rows.map((r) => ({
          id: r.id,
          text: r.text,
          kind: r.kind,
          importance: r.importance,
          emotion: r.emotion,
          hits: r.hits,
          createdAt: r.created_at,
          lastHitAt: r.last_hit_at,
          tags: safeJson(r.tags, []),
          archived: !!r.archived,
          scope: r.scope || 'world',
          status: r.status || 'active',
          supersededBy: r.superseded_by ?? null,
          correctedAt: r.corrected_at ?? null,
        }))
      },

      saveMemories(list) {
        const up = db.prepare(`
          INSERT INTO memories (id, text, kind, importance, emotion, hits, created_at, last_hit_at, tags, archived, scope, status, superseded_by, corrected_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            text=excluded.text, kind=excluded.kind, importance=excluded.importance,
            emotion=excluded.emotion, hits=excluded.hits, last_hit_at=excluded.last_hit_at,
            tags=excluded.tags, archived=excluded.archived, scope=excluded.scope,
            status=excluded.status, superseded_by=excluded.superseded_by, corrected_at=excluded.corrected_at
        `)
        db.exec('BEGIN')
        try {
          for (const m of list) {
            up.run(
              m.id, m.text, m.kind, m.importance, m.emotion, m.hits ?? 0,
              m.createdAt, m.lastHitAt ?? m.createdAt,
              JSON.stringify(m.tags ?? []), m.archived ? 1 : 0,
              m.scope || 'world', m.status || 'active',
              m.supersededBy ?? null, m.correctedAt ?? null,
            )
          }
          db.exec('COMMIT')
        } catch (e) {
          db.exec('ROLLBACK')
          throw e
        }
        return list.length
      },

      /** 整表重写：清掉历史脏数据时用（DELETE + 批量插入，事务内完成） */
      replaceMemories(list) {
        db.exec('BEGIN')
        try {
          db.exec('DELETE FROM memories')
          const up = db.prepare(`
            INSERT INTO memories (id, text, kind, importance, emotion, hits, created_at, last_hit_at, tags, archived, scope, status, superseded_by, corrected_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `)
          for (const m of list) {
            up.run(
              m.id, m.text, m.kind, m.importance, m.emotion, m.hits ?? 0,
              m.createdAt, m.lastHitAt ?? m.createdAt,
              JSON.stringify(m.tags ?? []), m.archived ? 1 : 0,
              m.scope || 'world', m.status || 'active',
              m.supersededBy ?? null, m.correctedAt ?? null,
            )
          }
          db.exec('COMMIT')
        } catch (e) {
          db.exec('ROLLBACK')
          throw e
        }
        return list.length
      },

      /** 会话 → 作用域的绑定（读侧：这个会话该看哪些线） */
      listBindings(sessionId) {
        if (!sessionId) return []
        return db.prepare('SELECT scope FROM bindings WHERE session_id = ? ORDER BY bound_at').all(sessionId).map((r) => r.scope)
      },

      /** 绑一条线到会话；已绑过就只更新时间，不重复插 */
      bindScope(sessionId, scope) {
        if (!sessionId || !scope) return false
        const info = db
          .prepare(`
            INSERT INTO bindings (session_id, scope, bound_at) VALUES (?, ?, ?)
            ON CONFLICT(session_id, scope) DO UPDATE SET bound_at = excluded.bound_at
          `)
          .run(sessionId, scope, Date.now())
        return info.changes > 0
      },

      /** 清理很久没动过的绑定，防止表无限长 */
      pruneBindings(before) {
        return db.prepare('DELETE FROM bindings WHERE bound_at < ?').run(before).changes
      },

      /** 任务：按标题 upsert（同名视为同一件事，更新状态/备注） */
      upsertTask({ title, status = 'doing', note = '', scope = 'world', memoryId = null }) {
        const now = Date.now()
        db.prepare(`
          INSERT INTO tasks (title, status, note, scope, memory_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(title) DO UPDATE SET
            status=excluded.status, note=excluded.note, scope=excluded.scope,
            memory_id=coalesce(excluded.memory_id, tasks.memory_id), updated_at=excluded.updated_at
        `).run(title, status, note, scope, memoryId, now, now)
        return db.prepare('SELECT * FROM tasks WHERE title = ?').get(title)
      },

      clearTasks() {
        return db.prepare('DELETE FROM tasks').run().changes
      },

      listTasks(statuses = null) {
        const rows = statuses?.length
          ? db.prepare(`SELECT * FROM tasks WHERE status IN (${statuses.map(() => '?').join(',')}) ORDER BY updated_at DESC`).all(...statuses)
          : db.prepare('SELECT * FROM tasks ORDER BY updated_at DESC').all()
        return rows.map(toTask)
      },

      loadImpressions() {
        return db.prepare('SELECT * FROM impressions').all().map((r) => ({
          trait: r.trait,
          value: r.value,
          confidence: r.confidence,
          evidence: r.evidence,
          conflicts: r.conflicts,
          updatedAt: r.updated_at,
          lastSource: r.last_source ?? null,
          sources: safeJson(r.evidence_sources ?? '[]', []),
        }))
      },

      saveImpressions(items) {
        const up = db.prepare(`
          INSERT INTO impressions (trait, value, confidence, evidence, conflicts, updated_at, last_source, evidence_sources)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(trait, value) DO UPDATE SET
            confidence=excluded.confidence,
            evidence=excluded.evidence, conflicts=excluded.conflicts,
            updated_at=excluded.updated_at, last_source=excluded.last_source,
            evidence_sources=excluded.evidence_sources
        `)
        db.exec('BEGIN')
        try {
          for (const it of items) {
            up.run(
              it.trait, it.value, it.confidence, it.evidence, it.conflicts, it.updatedAt,
              it.lastSource ?? null,
              JSON.stringify(Array.isArray(it.sources) ? it.sources : []),
            )
          }
          db.exec('COMMIT')
        } catch (e) {
          db.exec('ROLLBACK')
          throw e
        }
      },

      /** 清空印象（证据被污染时重来一遍，比留着虚高置信度好） */
      clearImpressions() {
        db.exec('DELETE FROM impressions')
      },

      getMeta(k) {
        const row = db.prepare('SELECT v FROM meta WHERE k = ?').get(k)
        return row ? row.v : null
      },
      setMeta(k, v) {
        db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, String(v))
      },
      close() {
        try { db.close() } catch {}
      },
    }
  } catch {
    return memoryStore()
  }
}

/**
 * 把旧版 impressions 表（trait 单列主键）迁到 (trait, value) 复合主键。
 * 幂等：已经是复合主键就直接返回 false，不碰数据。
 * 旧表里每个 trait 只存了一条（其余在写入时就被覆盖了），迁移只能保住现存的那条，
 * 丢掉的第二面要在后续对话里重新观察才能长回来——这不是能补的，只能不再继续丢。
 */
function migrateImpressions(db) {
  let sql = null
  try {
    sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='impressions'").get()?.sql ?? null
  } catch {
    return false
  }
  if (!sql) return false
  if (/PRIMARY\s+KEY\s*\(\s*trait\s*,\s*value\s*\)/i.test(sql)) return false

  db.exec('BEGIN')
  try {
    db.exec('ALTER TABLE impressions RENAME TO impressions_legacy')
    db.exec(IMPRESSIONS_SCHEMA)
    db.exec(`
      INSERT OR IGNORE INTO impressions (trait, value, confidence, evidence, conflicts, updated_at)
      SELECT trait, value, confidence, evidence, conflicts, updated_at FROM impressions_legacy
    `)
    db.exec('DROP TABLE impressions_legacy')
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  return true
}

/**
 * 老库补列（SQLite 的 CREATE TABLE IF NOT EXISTS 不会给已存在的表加列）。
 * 幂等：列已经在就什么都不做。
 */
function ensureColumn(db, table, column, decl) {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)
    if (cols.length > 0 && !cols.includes(column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`)
    }
  } catch {
    // 补列失败不该拦住插件启动：读的时候 last_source 会退化成 null，只影响"同会话只记一条证据"的精度
  }
}

/** 内存版（降级用）：接口一样，重启即失 */
function memoryStore() {
  const mem = new Map()
  const imp = new Map()
  const meta = new Map()
  const bind = new Map() // `${sessionId}::${scope}` → boundAt
  return {
    kind: 'memory',
    path: '(in-memory)',
    listMemories: () => [...mem.values()].sort((a, b) => a.id - b.id),
    saveMemories(list) {
      for (const m of list) mem.set(m.id, m)
      return list.length
    },
    replaceMemories(list) {
      mem.clear()
      for (const m of list) mem.set(m.id, m)
      return list.length
    },
    listBindings(sessionId) {
      if (!sessionId) return []
      const out = []
      for (const k of bind.keys()) {
        const [sid, scope] = k.split('::')
        if (sid === sessionId) out.push(scope)
      }
      return out
    },
    bindScope(sessionId, scope) {
      if (!sessionId || !scope) return false
      bind.set(`${sessionId}::${scope}`, Date.now())
      return true
    },
    pruneBindings(before) {
      let n = 0
      for (const [k, at] of bind) if (at < before) { bind.delete(k); n++ }
      return n
    },
    upsertTask({ title, status = 'doing', note = '', scope = 'world', memoryId = null }) {
      const now = Date.now()
      const cur = tasks.get(title)
      const row = { id: cur?.id ?? tasks.size + 1, title, status, note, scope, memoryId, createdAt: cur?.createdAt ?? now, updatedAt: now }
      tasks.set(title, row)
      return row
    },
    clearTasks() {
      tasks.clear()
    },
    listTasks(statuses = null) {
      const all = [...tasks.values()]
      return statuses?.length ? all.filter((t) => statuses.includes(t.status)) : all
    },
    loadImpressions: () => [...imp.values()],
    saveImpressions(items) {
      for (const it of items) imp.set(`${it.trait}::${it.value}`, it)
    },
    clearImpressions() {
      imp.clear()
    },
    getMeta: (k) => meta.get(k) ?? null,
    setMeta: (k, v) => meta.set(k, String(v)),
    close() {},
  }
}

function toTask(r) {
  return {
    id: r.id,
    title: r.title,
    status: r.status,
    note: r.note,
    scope: r.scope,
    memoryId: r.memory_id ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

function safeJson(s, fallback) {
  try {
    return JSON.parse(s)
  } catch {
    return fallback
  }
}
