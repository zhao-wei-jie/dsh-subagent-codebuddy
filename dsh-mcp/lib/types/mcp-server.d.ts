/**
 * 共享 MCP server(HTTP/JSON-RPC):把**会话可见的 dsh 工具**以 MCP 协议暴露给
 * 外部 CLI(codebuddy / agy 通用)。
 *
 * 本实现从 codebuddy 桥的 mcp-server.ts 抽取(codebuddy 与 agy 两个桥共用同一
 * MCP 入口:端点 /api/dsh-mcp、进程级 key、per-session 工具面),避免两套复制
 * 实现。行为与抽取源逐字一致;codebuddy 专有的 `--mcp-config` 文件生成与陈旧
 * 配置清扫仍留在 codebuddy 插件侧(由它用 {@link dshMcpEndpointUrl} 组装)。
 * @module dsh-mcp/mcp-server
 */
import type { Context } from '@deepseek-ai/cordis';
import type { DshToolRunResult } from './dsh-tools-bridge.js';
/** 端点路径(exact 路由,挂 dsh webserver)。 */
export declare const DSH_MCP_ENDPOINT_PATH = "/api/dsh-mcp";
/** MCP server 名(CLI 侧工具呈现为 `mcp__dsh__<工具名>`)。 */
export declare const DSH_MCP_SERVER_NAME = "dsh";
/**
 * 转发兜底超时标记(pump.dispatchMcpCall 抛给端点)。
 *
 * 触发条件:注入的调用在 `MCP_CALL_TIMEOUT_MS` 内未被 loop 消费(loop 卡死等
 * 异常;正常路径由泵的 `finish()/dispose()` 释放等待者,不依赖本超时)。
 * 此时**无法确定**工具是否已在 loop 侧开始执行——所以端点收到本类型必须原样回
 * isError、**不得降级重跑**(重跑会让同一副作用执行两次),与"泵不在、工具尚未
 * 执行"的一般转发失败区别对待。
 */
export declare class McpDispatchTimeoutError extends Error {
    constructor(message: string);
}
/**
 * 调用已注入 loop、但回合在结果回填前收尾(dispose/中止)时,由泵抛给端点。
 *
 * 与 {@link McpDispatchTimeoutError} 同一语义族:**无法确定**工具是否已在 loop
 * 侧开始执行——端点必须原样回 isError、**不得回落重执**(重跑会让同一副作用
 * 执行两次)。此前泵用普通 Error 拒绝,端点按"泵不在、尚未执行"回落直执,
 * 而该调用其实已被 loop 消费并开始执行(生产实测:同一 pwsh 命令跑了两次)。
 * 独立类型让日志能区分"兜底超时"与"回合收尾"两条路径。
 */
export declare class McpDispatchAbortedError extends Error {
    constructor(message: string);
}
/** MCP → loop 转发器(由回合泵在生命周期内注册)。 */
export type McpLoopDispatcher = (sessionId: string, name: string, input: Record<string, unknown>, 
/**
 * 转发超时后结果迟到时的投递口(泵在 tool/result 到达时调用)。
 * 交互式工具(ask_user_question 等)用户作答慢于转发超时窗口时,CLI 收到的
 * 是超时错误而不是答案;没有这个口子,答案就永久丢失(CLI 只能重问)。
 */
lateSink?: (toolName: string, text: string) => void) => Promise<DshToolRunResult>;
/**
 * 注册/注销会话的 MCP→loop 转发器(回合泵构造/释放时调用;幂等注销)。
 * @param sessionId - dsh 会话 id。
 * @param dispatch - 转发实现。
 * @returns 注销函数。
 */
export declare function registerMcpLoopDispatcher(sessionId: string, dispatch: McpLoopDispatcher): () => void;
/**
 * 本 MCP 端点的完整 URL(含 session/key);端点未就绪时 undefined。
 * 各 CLI 桥用它生成自己的配置(codebuddy 的 --mcp-config 文件;agy 的
 * mcp_config.json 的 dsh 条目)。
 */
export declare function dshMcpEndpointUrl(sessionId: string): string | undefined;
/**
 * 注册 MCP 端点(插件初始化时调用一次;幂等)。
 *
 * 幂等是**跨调用方**的:本包被多个插件依赖(dsh-mcp 自己 / llm-agy /
 * codebuddy),而端点与 key 都是进程级的——谁后注册谁覆盖,会让先写入各
 * CLI 配置文件(codebuddy 的 --mcp-config、agy 的 mcp_config.json)的 URL
 * 当场失效(实测:两插件各注册一次后,AGY 拿旧 key 连 3083 报 bad key)。
 * 已在册则直接返回空释放函数,不新建 key、不换路由。
 * @param ctx - 插件上下文(webserver/agents/tools 服务)。
 * @returns 释放函数。
 */
export declare function registerDshMcpServer(ctx: Context): () => void;
