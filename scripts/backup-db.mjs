/**
 * backup-db.mjs —— 给记忆库做一致性快照（VACUUM INTO），改表结构前先跑一次
 *
 * 用法：node scripts/backup-db.mjs [备份目录]
 * 默认备份到工作区 backups\，文件名带日期，不动原库。
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const src = join(homedir(), '.dsh', 'long-term-memory', 'memory.sqlite')
// 默认备份到当前目录下的 backups/，也可以用第一个参数指定
const dir = process.argv[2] ?? join(process.cwd(), 'backups')
mkdirSync(dir, { recursive: true })

const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '').slice(0, 8)
let dst = join(dir, `long-memory-${stamp}.sqlite`)
// VACUUM INTO 不覆盖已有文件：同一天跑第二次就加序号
for (let i = 2; existsSync(dst); i++) dst = join(dir, `long-memory-${stamp}-${i}.sqlite`)

const db = new DatabaseSync(src, { readOnly: true })
db.exec(`VACUUM INTO '${dst.replace(/\\/g, '/')}'`)
db.close()

const chk = new DatabaseSync(dst, { readOnly: true })
const mem = chk.prepare('SELECT count(*) AS c FROM memories').get().c
const imp = chk.prepare('SELECT count(*) AS c FROM impressions').get().c
const sch = chk.prepare("SELECT sql FROM sqlite_master WHERE name='impressions'").get()?.sql ?? ''
chk.close()

console.log(`备份完成：${dst}`)
console.log(`  记忆 ${mem} 条 · 印象 ${imp} 条 · 印象表主键：${/PRIMARY\s+KEY\s*\(\s*trait\s*,\s*value\s*\)/i.test(sch) ? '(trait,value) 新' : 'trait 旧'}`)
