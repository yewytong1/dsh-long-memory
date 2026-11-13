// tests/resolve-stub.mjs —— 解析钩子本体
//
// 只在 '@deepseek-ai/dsh-tools' 解析失败时生效：把它指到 helpers/dsh-tools-stub.mjs。
// 其它模块一律走默认解析。
import { pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const STUB = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), 'helpers', 'dsh-tools-stub.mjs')
).href

export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@deepseek-ai/dsh-tools') {
    try {
      return await nextResolve(specifier, context)
    } catch {
      // 宿主没提供这个包 —— 用桩顶上
      return { url: STUB, shortCircuit: true }
    }
  }
  return nextResolve(specifier, context)
}
