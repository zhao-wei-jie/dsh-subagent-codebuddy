/**
 * 共享 MCP 插件(@flg1217/dsh-mcp):为 codebuddy / agy 两个 CLI 桥提供统一的
 * dsh MCP 端点(端点注册、key、工具面、执行、图片回传;实现见 mcp-server.ts)。
 *
 * 本插件零设置项:作为两个桥插件的**依赖**被自动安装,并在 profile 安装时由
 * `dsh plugin add` 的 reconcile 机制自动加入 bundles(因为它声明了
 * `dsh.bundle`)——用户无需单独安装或配置。
 * @module dsh-mcp
 */
import { registerDshMcpServer } from './mcp-server.js';
export { DSH_MCP_ENDPOINT_PATH, DSH_MCP_SERVER_NAME, dshMcpEndpointUrl, McpDispatchAbortedError, McpDispatchTimeoutError, registerDshMcpServer, registerMcpLoopDispatcher } from './mcp-server.js';
export { blocksToMcpContent, blocksToText, BRIDGE_TOOL_PREFIX, bridgeTargetTool, bridgeToolId, CLI_MIRROR_TOOL_PREFIX, excludeDshMcpTools, isBridgeEligible, listDshBridgeTools, listDshMcpTools, runDshBridgeTool, } from './dsh-tools-bridge.js';
export function apply(ctx) {
    // 挂 MCP 端点(webServer 就绪时注册;卸载/热重载自动释放)。
    ctx.effect(() => registerDshMcpServer(ctx));
}
