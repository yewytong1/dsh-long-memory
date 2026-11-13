// tests/register-stub.mjs —— 让 `@deepseek-ai/dsh-tools` 在没有宿主的机器上也能解析
//
// 用法：node --import ./tests/register-stub.mjs --test "tests/*.test.mjs"
//
// 原理：Node 的模块解析钩子。当有人 import '@deepseek-ai/dsh-tools' 且这个包
// 实际不存在时，改指向 tests/helpers/dsh-tools-stub.mjs。
// 宿主进程里包是存在的（由 DSH 提供），这条规则只在独立跑测试时生效。
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'

register('./resolve-stub.mjs', pathToFileURL(import.meta.filename))
