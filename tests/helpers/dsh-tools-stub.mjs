/**
 * dsh-tools-stub.mjs —— 测试用的 @deepseek-ai/dsh-tools 替身
 *
 * 为什么需要：src/index.js 顶部 import 了宿主提供的 `@deepseek-ai/dsh-tools`，
 * 但干净克隆的仓库没有 node_modules，`node --test` 会直接报
 * ERR_MODULE_NOT_FOUND，让人误以为插件坏了。
 *
 * 这里只实现测试路径真正用到的那一个函数。defineTool 在宿主里的职责是把
 * 声明式定义转成可注册的工具对象；假宿主不校验 schema，原样返回即可。
 */
export function defineTool(def) {
  return def
}
