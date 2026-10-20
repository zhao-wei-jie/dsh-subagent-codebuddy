/**
 * dsh MCP server 测试:端点 handler(真 HTTP;JSON-RPC over HTTP、工具执行、
 * 断连补投、转发看门狗)。从 codebuddy 迁入(原 tests/mcp-server.spec.ts),
 * codebuddy 方言(--mcp-config 文件、清扫)留在其 mcp-config.spec.ts。
 */
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  DSH_MCP_ENDPOINT_PATH,
  McpDispatchAbortedError,
  McpDispatchTimeoutError,
  registerDshMcpServer,
  registerMcpLoopDispatcher,
  dshMcpEndpointUrl,
} from '../src/mcp-server.ts'

interface McpTestHarness {
  server: Server
  baseUrl: string
  key: string
  executeCalls: Array<Record<string, unknown>>
  /** 客户端断连后才完成的结果,补投进会话的记录。 */
  deliveries: Array<{ kind: 'inject' | 'followup'; message: unknown }>
  close: () => Promise<void>
}

/** 起一个真 HTTP server,把 MCP handler 挂上(绕过 webserver 服务)。 */
async function makeHarness(
  options: {
    toolsExecuteError?: boolean
    toolDelayMs?: number
    agentStatus?: string
    /** attachments 服务面(图片回传用;缺省 = 无服务,图片降级为纯文本)。 */
    attachments?: { readImage: (ref: unknown) => Promise<{ data: Uint8Array; ref: { mediaType: string } }> }
    /** 追加到可见工具面的 schema(测试特定工具,如命令执行工具)。 */
    extraSchemas?: Array<{ name: string; description: string; parameters: unknown }>
  } = {},
): Promise<McpTestHarness> {
  const executeCalls: Array<Record<string, unknown>> = []
  const deliveries: Array<{ kind: 'inject' | 'followup'; message: unknown }> = []
  const toolsFace = {
    schemas: () => [
      { name: 'grep', description: 'Search files.', parameters: { type: 'object', properties: { pattern: { type: 'string' } } } },
      { name: 'read_image', description: 'Read an image.', parameters: { type: 'object', properties: {} } },
      { name: 'cli_read', description: 'mirror noise', parameters: {} },
      { name: 'mcp__x__y', description: 'mcp noise', parameters: {} },
      ...options.extraSchemas ?? [],
    ],
    execute: async (call: Record<string, unknown>) => {
      executeCalls.push(call)
      // 交互式工具(等用户作答)会长时间不返回;这里用它制造"客户端先放弃"的窗口。
      if (options.toolDelayMs !== undefined) {
        await new Promise(resolve => setTimeout(resolve, options.toolDelayMs))
      }
      if (options.toolsExecuteError === true) throw new Error('sandbox denied')
      return { isError: false, content: [{ type: 'text', text: 'executed!' }] }
    },
  }
  const agentFace = {
    id: 'sess-ok',
    status: options.agentStatus ?? 'idle',
    inject: (message: unknown) => { deliveries.push({ kind: 'inject', message }) },
    followup: (message: unknown) => { deliveries.push({ kind: 'followup', message }) },
  }
  const agentsFace = { get: (id: string) => (id === 'sess-ok' ? agentFace : undefined) }
  let routeHandler: ((req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void | Promise<void>) | undefined
  const ctx = {
    get: (key: string): unknown => {
      if (key === 'tools') return toolsFace
      if (key === 'agents') return agentsFace
      if (key === 'attachments') return options.attachments
      return undefined
    },
    // 模拟 cordis 的 inject:同步调用回调,并把回调**返回值**当作 disposer
    // 挂到 inject 子 fiber 上(生产代码依赖这一语义做清理)。
    inject: (_deps: string[], fn: (injected: Context) => (() => void) | void): { dispose: () => void } => {
      const disposer = fn({
        get: (key: string): unknown => key === 'webServer'
          ? {
              register: (route: { path: string; handler: typeof routeHandler }) => {
                routeHandler = route.handler
                return () => { routeHandler = undefined }
              },
              port: 0,
            }
          : undefined,
      } as unknown as Context)
      return { dispose: () => { disposer?.() } }
    },
  } as unknown as Context
  // 保存释放句柄:afterEach 必须释放,否则模块级 endpoint 会跨用例残留
  // (此前用例隐含依赖执行顺序,单独跑就失败)。
  disposeServer = registerDshMcpServer(ctx)
  expect(routeHandler).toBeDefined()
  const handler = routeHandler!
  const server = createServer((req, res) => { void handler(req, res) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as AddressInfo).port
  // 取 key:共享包导出的端点 URL(与注册时同源)。
  const url = new URL(dshMcpEndpointUrl('sess-ok')!)
  const key = url.searchParams.get('key')!
  return {
    server,
    baseUrl: `http://127.0.0.1:${port}${DSH_MCP_ENDPOINT_PATH}`,
    key,
    executeCalls,
    deliveries,
    close: async () => { await new Promise<void>(resolve => server.close(() => resolve())) },
  }
}

/**
 * 发一个请求,并在 handler 已进入、工具仍在跑时断连。
 * `res.on('close')` 看到 `writableFinished === false` 才会记下 `clientGoneAt`。
 */
async function rpcThenAbort(h: McpTestHarness, body: unknown, abortAfterMs = 60): Promise<void> {
  const controller = new AbortController()
  const pending = fetch(`${h.baseUrl}?session=sess-ok&key=${h.key}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: controller.signal,
  }).catch(() => undefined)
  await new Promise(resolve => setTimeout(resolve, abortAfterMs))
  controller.abort()
  await pending
}

let harness: McpTestHarness | undefined
let disposeServer: (() => void) | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
  disposeServer?.()
  disposeServer = undefined
})

async function rpc(h: McpTestHarness, body: unknown, query = `session=sess-ok&key=${h.key}`): Promise<{ status: number; json?: Record<string, unknown> }> {
  const response = await fetch(`${h.baseUrl}?${query}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  let json: Record<string, unknown> | undefined
  if (text.length > 0) {
    try {
      json = JSON.parse(text) as Record<string, unknown>
    } catch { /* 403/413 等为纯文本响应 */ }
  }
  return { status: response.status, ...(json === undefined ? {} : { json }) }
}

describe('dsh MCP server:JSON-RPC over HTTP', () => {
  it('initialize 协商版本并声明 tools 能力', async () => {
    harness = await makeHarness()
    const { status, json } = await rpc(harness, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {} },
    })
    expect(status).toBe(200)
    expect(json?.['result']).toMatchObject({
      protocolVersion: '2025-03-26',
      capabilities: { tools: {} },
      serverInfo: { name: 'dsh-harness' },
    })
  })

  it('tools/list 现取 schemas:排除镜像/自带 mcp 工具,保留完整 inputSchema', async () => {
    harness = await makeHarness()
    const { json } = await rpc(harness, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
    const tools = (json?.['result'] as { tools: Array<Record<string, unknown>> }).tools
    expect(tools.map(tool => tool['name'])).toEqual(['grep', 'read_image'])
    expect(tools[0]!['inputSchema']).toEqual({
      type: 'object',
      properties: { pattern: { type: 'string' } },
    })
  })

  it('tools/call 走 dsh 工具管线并按 MCP 形状返回;未知工具报 isError', async () => {
    harness = await makeHarness()
    const ok = await rpc(harness, {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'grep', arguments: { pattern: 'needle' } },
    })
    expect(ok.json?.['result']).toEqual({ content: [{ type: 'text', text: 'executed!' }] })
    expect(harness.executeCalls[0]).toMatchObject({ name: 'grep', arguments: { pattern: 'needle' } })

    const bad = await rpc(harness, {
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'cli_read', arguments: {} },
    })
    expect((bad.json?.['result'] as { isError?: boolean }).isError).toBe(true)
  })

  it('命令工具漏填 description(仅 UI 元数据)时自动派生;已有描述不覆盖', async () => {
    harness = await makeHarness({
      extraSchemas: [{
        name: 'pwsh',
        description: 'Execute a command.',
        parameters: {
          type: 'object',
          properties: { command: { type: 'string' }, description: { type: 'string' } },
          required: ['command', 'description'],
        },
      }],
    })
    // 现场:AGY 每次首轮的壳调用都漏 description → dsh 校验硬拒、白跑一次
    // (会话 914637da 实证)。端点派生兜底后首次调用即成功。
    const first = await rpc(harness, {
      jsonrpc: '2.0', id: 21, method: 'tools/call',
      params: { name: 'pwsh', arguments: { command: 'node -e "console.log(1)"' } },
    })
    expect(first.json?.['result']).toEqual({ content: [{ type: 'text', text: 'executed!' }] })
    expect(harness.executeCalls[0]).toMatchObject({
      name: 'pwsh',
      arguments: { command: 'node -e "console.log(1)"', description: 'node -e "console.log(1)"' },
    })
    // 模型自带描述时保持原样(不被覆盖)。
    await rpc(harness, {
      jsonrpc: '2.0', id: 22, method: 'tools/call',
      params: { name: 'pwsh', arguments: { command: 'ls', description: 'List files' } },
    })
    expect(harness.executeCalls[1]).toMatchObject({ arguments: { command: 'ls', description: 'List files' } })
  })

  it('tools/call 结果含图片 → MCP content 带 image 块(base64;CLI 侧转 image_url 给模型)', async () => {
    harness = await makeHarness({
      attachments: {
        readImage: async (ref: unknown) => ({
          data: Uint8Array.of(1, 2, 3),
          ref: { mediaType: (ref as { mediaType: string }).mediaType },
        }),
      },
    })
    const dispose = registerMcpLoopDispatcher('sess-ok', async () => ({
      output: 'head',
      isError: false,
      content: [
        { type: 'text', text: 'head' },
        { type: 'image', attachment: { mediaType: 'image/png' } },
      ],
    }))
    const res = await rpc(harness, {
      jsonrpc: '2.0', id: 30, method: 'tools/call',
      params: { name: 'read_image', arguments: { file_path: 'a.png' } },
    })
    expect(res.json?.['result']).toEqual({
      content: [
        { type: 'text', text: 'head' },
        { type: 'image', data: 'AQID', mimeType: 'image/png' },
      ],
    })
    dispose()
  })

  it('无 attachments 服务(或图读不出)→ 图片降级为纯文本单块(与历史行为一致)', async () => {
    harness = await makeHarness()
    const dispose = registerMcpLoopDispatcher('sess-ok', async () => ({
      output: 'head',
      isError: false,
      content: [
        { type: 'text', text: 'head' },
        { type: 'image', attachment: { mediaType: 'image/png' } },
      ],
    }))
    const res = await rpc(harness, {
      jsonrpc: '2.0', id: 31, method: 'tools/call',
      params: { name: 'read_image', arguments: { file_path: 'a.png' } },
    })
    expect(res.json?.['result']).toEqual({ content: [{ type: 'text', text: 'head' }] })
    dispose()
  })

  it('tools/call 可见性:命名合法但不在本会话工具面内的工具被拒绝(回归)', async () => {
    harness = await makeHarness()
    // 'write' 命名合法(isBridgeEligible 通过),但 harness 的 schemas 只暴露
    // 'grep' —— 必须按 tools/list 的口径拒绝,不能只查命名形态(否则持有 key
    // 的调用方可绕过 per-agent scope)。
    const denied = await rpc(harness, {
      jsonrpc: '2.0', id: 20, method: 'tools/call',
      params: { name: 'write', arguments: { file_path: 'x', content: 'y' } },
    })
    const result = denied.json?.['result'] as { isError?: boolean; content?: { text?: string }[] }
    expect(result.isError).toBe(true)
    expect(result.content?.[0]?.text).toContain('不可见')
    // 关键:越权调用不得落到直执通道。
    expect(harness.executeCalls).toHaveLength(0)
  })

  it('tools/call 会话无活跃 agent → 拒绝(不再回落直执)', async () => {
    harness = await makeHarness()
    const denied = await rpc(harness, {
      jsonrpc: '2.0', id: 21, method: 'tools/call',
      params: { name: 'grep', arguments: { pattern: 'x' } },
    }, `session=sess-missing&key=${harness.key}`)
    const result = denied.json?.['result'] as { isError?: boolean; content?: { text?: string }[] }
    expect(result.isError).toBe(true)
    expect(result.content?.[0]?.text).toContain('没有活跃的 agent')
    expect(harness.executeCalls).toHaveLength(0)
  })

  it('initialize 只回服务端支持的协议版本(不谎称支持客户端版本)', async () => {
    harness = await makeHarness()
    const known = await rpc(harness, {
      jsonrpc: '2.0', id: 22, method: 'initialize',
      params: { protocolVersion: '2025-03-26' },
    })
    expect((known.json?.['result'] as { protocolVersion?: string }).protocolVersion).toBe('2025-03-26')

    const unknown = await rpc(harness, {
      jsonrpc: '2.0', id: 23, method: 'initialize',
      params: { protocolVersion: '1999-01-01' },
    })
    // 回退到服务端版本,而不是回显客户端的 '1999-01-01'。
    expect((unknown.json?.['result'] as { protocolVersion?: string }).protocolVersion).toBe('2025-03-26')
  })

  it('端点 key 稳定:释放后重新注册复用同一把 key(已写入 CLI 配置的 URL 不失效)', async () => {
    // 回归:key 若随重建更换,各 CLI 配置文件里的旧 URL 当场失效,正在运行的
    // CLI 持久进程工具调用全数 bad key(实测:改插件 → 重建实例即复现)。
    harness = await makeHarness()
    const firstKey = harness.key
    await harness.close()
    harness = undefined
    disposeServer?.()
    disposeServer = undefined

    harness = await makeHarness()
    expect(harness.key).toBe(firstKey)
  })

  it('执行失败 → isError 内容;坏 key/坏 JSON 拒绝', async () => {
    harness = await makeHarness({ toolsExecuteError: true })
    const failed = await rpc(harness, {
      jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: 'grep', arguments: { pattern: 'x' } },
    })
    expect((failed.json?.['result'] as { isError?: boolean }).isError).toBe(true)

    const denied = await rpc(harness, { jsonrpc: '2.0', id: 6, method: 'tools/list' }, 'session=sess-ok&key=wrong')
    expect(denied.status).toBe(403)

    const badJson = await fetch(`${harness.baseUrl}?session=sess-ok&key=${harness.key}`, {
      method: 'POST', body: 'not-json',
    })
    expect(badJson.status).toBe(400)
  })

  it('tools/call 优先转发进 loop(注册 dispatcher);转发失败回落直接执行', async () => {
    harness = await makeHarness()
    const calls: string[] = []
    const dispose = registerMcpLoopDispatcher('sess-ok', async (_sessionId, name, input) => {
      calls.push(`${name}:${JSON.stringify(input)}`)
      return { output: 'loop-executed', isError: false }
    })
    const forwarded = await rpc(harness, {
      jsonrpc: '2.0', id: 9, method: 'tools/call',
      params: { name: 'grep', arguments: { pattern: 'loop' } },
    })
    expect(forwarded.json?.['result']).toEqual({ content: [{ type: 'text', text: 'loop-executed' }] })
    expect(calls).toEqual(['grep:{"pattern":"loop"}'])
    // 走了 loop 转发就不落直接执行。
    expect(harness.executeCalls).toHaveLength(0)
    dispose()

    // 转发抛错(回合收尾竞态)→ 回落直接执行,调用不失败。
    const disposeThrow = registerMcpLoopDispatcher('sess-ok', async () => { throw new Error('pump gone') })
    const fallback = await rpc(harness, {
      jsonrpc: '2.0', id: 10, method: 'tools/call',
      params: { name: 'grep', arguments: { pattern: 'x' } },
    })
    expect(fallback.json?.['result']).toEqual({ content: [{ type: 'text', text: 'executed!' }] })
    disposeThrow()
  })

  it('dispatcher 报超时(注入可能已执行)→ 回 isError 且不回落重执', async () => {
    // 回归:超时后若降级直执,长命令会在 loop 侧与直执各跑一遍(副作用翻倍)。
    harness = await makeHarness()
    const disposeTimeout = registerMcpLoopDispatcher('sess-ok', async () => {
      throw new McpDispatchTimeoutError('MCP 调用 grep 等待 loop 执行超时(300s)')
    })
    const timedOut = await rpc(harness, {
      jsonrpc: '2.0', id: 11, method: 'tools/call',
      params: { name: 'grep', arguments: { pattern: 'build' } },
    })
    const result = timedOut.json?.['result'] as { isError?: boolean; content?: { text?: string }[] }
    expect(result.isError).toBe(true)
    expect(result.content?.[0]?.text).toContain('未回落直执')
    // 关键断言:直接执行通道零调用(没有第二次执行)。
    expect(harness.executeCalls).toHaveLength(0)
    disposeTimeout()
  })

  it('转发因回合收尾被拒(McpDispatchAbortedError)→ 同样不回落重执', async () => {
    // 回归:泵 dispose 曾用普通 Error 拒绝,端点按"泵不在、尚未执行"回落直执,
    // 而该调用其实已被 loop 消费并开始执行——同一副作用跑两遍(生产实测)。
    harness = await makeHarness()
    const disposeAborted = registerMcpLoopDispatcher('sess-ok', async () => {
      throw new McpDispatchAbortedError('CodeBuddy 回合已收尾,该调用结果未能回填')
    })
    const aborted = await rpc(harness, {
      jsonrpc: '2.0', id: 12, method: 'tools/call',
      params: { name: 'grep', arguments: { pattern: 'build' } },
    })
    const result = aborted.json?.['result'] as { isError?: boolean; content?: { text?: string }[] }
    expect(result.isError).toBe(true)
    expect(result.content?.[0]?.text).toContain('未回落直执')
    expect(harness.executeCalls).toHaveLength(0)
    disposeAborted()
  })

  it('跨模块副本的拒绝(仅 name 相同,instanceof 不命中)→ 仍不回落重执', async () => {
    // 发布形态下本模块可能出现多份实例:对方副本抛的错误过不了本副本的
    // instanceof,判定必须同时认 name,否则回落重执在真实环境照样发生。
    harness = await makeHarness()
    const foreign = Object.assign(new Error('副本抛出的收尾拒绝'), { name: 'McpDispatchAbortedError' })
    const disposeForeign = registerMcpLoopDispatcher('sess-ok', async () => { throw foreign })
    const rejected = await rpc(harness, {
      jsonrpc: '2.0', id: 13, method: 'tools/call',
      params: { name: 'grep', arguments: { pattern: 'build' } },
    })
    const result = rejected.json?.['result'] as { isError?: boolean; content?: { text?: string }[] }
    expect(result.isError).toBe(true)
    expect(result.content?.[0]?.text).toContain('未回落直执')
    expect(harness.executeCalls).toHaveLength(0)
    disposeForeign()
  })

})

describe('客户端断连后才完成的调用:结果必须补投进会话', () => {
  const call = {
    jsonrpc: '2.0', id: 9, method: 'tools/call',
    params: { name: 'grep', arguments: { pattern: 'x' } },
  }

  it('工具在客户端放弃后才返回 → 会话空闲时唤起一轮', async () => {
    harness = await makeHarness({ toolDelayMs: 250 })

    await rpcThenAbort(harness, call)
    await new Promise(resolve => setTimeout(resolve, 350))

    // 交互式工具(ask_user_question / exit_plan_mode)全靠这条投递才有人接着走:
    // CLI 已经放弃这次调用,它的模型永远看不到结果,界面上就是"提问结束就完了"。
    expect(harness.deliveries.map(entry => entry.kind)).toEqual(['followup'])
    const text = JSON.stringify(harness.deliveries[0]?.message ?? {})
    expect(text).toContain('grep')
    expect(text).toContain('executed!')
    expect(text).toContain('dsh-mcp')
  })

  it('会话忙时排队等下一步,而不是抢开一轮', async () => {
    harness = await makeHarness({ toolDelayMs: 250, agentStatus: 'running' })

    await rpcThenAbort(harness, call)
    await new Promise(resolve => setTimeout(resolve, 350))

    expect(harness.deliveries.map(entry => entry.kind)).toEqual(['inject'])
  })

  it('客户端没断连时不补投(CLI 已经拿到响应,补投就是重复上报)', async () => {
    harness = await makeHarness({ toolDelayMs: 10 })

    const { status } = await rpc(harness, call)
    await new Promise(resolve => setTimeout(resolve, 120))

    expect(status).toBe(200)
    expect(harness.deliveries).toEqual([])
  })

  it('转发超时后工具才完成:迟到投递口把真实结果补投进会话', async () => {
    // 现场(2026-09-16):ask_user_question 等真人作答超过兜底窗口,CLI 收到超时
    // 错误并重问同一题;用户后来提交的答案没有通道可投,永久丢失。修复:端点把
    // 迟到投递口交给泵,泵在 tool/result 迟到时调用它 → 结果补投进会话。
    harness = await makeHarness()
    let sink: ((toolName: string, text: string) => void) | undefined
    const dispose = registerMcpLoopDispatcher('sess-ok', async (_sessionId, _name, _input, lateSink) => {
      sink = lateSink
      throw new McpDispatchTimeoutError('MCP 调用 ask_user_question 注入后 1800s 内未被 loop 消费')
    })
    const timedOut = await rpc(harness, call)
    const result = timedOut.json?.['result'] as { isError?: boolean }
    expect(result.isError).toBe(true)
    expect(typeof sink).toBe('function')

    // 用户此刻才点提交 → 泵观察到 tool/result 迟到 → 经投递口补投。
    sink?.('ask_user_question', '{"answers":[{"id":"q1","selected":["红色"]}]}')
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(harness.deliveries.map(entry => entry.kind)).toEqual(['followup'])
    const text = JSON.stringify(harness.deliveries[0]?.message ?? {})
    expect(text).toContain('红色')
    expect(text).toContain('超时')
    dispose()
  })
})
