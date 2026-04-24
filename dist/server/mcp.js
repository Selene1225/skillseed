/**
 * MCP Server — dual transport: stdio (default) + HTTP.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import http from "node:http";
import { registerTools } from "./tools.js";
import { batchCommitAndPush } from "../cli/sync.js";
const PKG_VERSION = "0.1.0";
const SYNC_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
function createServer() {
    const server = new McpServer({
        name: "skillseed",
        version: PKG_VERSION,
    });
    registerTools(server);
    return server;
}
/** Start in stdio mode (for CLI auto-launch via MCP config) */
export async function serveStdio() {
    const server = createServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    // Background sync: pull on start, batch every 30 min
    batchCommitAndPush().catch(() => { });
    const syncTimer = setInterval(() => {
        batchCommitAndPush().catch(() => { });
    }, SYNC_INTERVAL_MS);
    // Graceful shutdown: commit + push before exit
    const shutdown = () => {
        clearInterval(syncTimer);
        batchCommitAndPush()
            .catch(() => { })
            .finally(() => process.exit(0));
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
}
/** Start in HTTP mode (multi-client) */
export async function serveHttp(port = 9527) {
    const server = createServer();
    const httpServer = http.createServer(async (req, res) => {
        if (req.url === "/health") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "ok", version: PKG_VERSION }));
            return;
        }
        if (req.url === "/mcp" && req.method === "POST") {
            const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => `session-${Date.now()}` });
            await server.connect(transport);
            await transport.handleRequest(req, res);
            return;
        }
        res.writeHead(404);
        res.end("Not found");
    });
    return new Promise((resolve, reject) => {
        httpServer.listen(port, () => {
            console.log(`🌱 Skillseed MCP server running on http://localhost:${port}/mcp`);
            resolve(httpServer);
        });
        httpServer.on("error", (err) => {
            if (err.code === "EADDRINUSE") {
                console.log(`Port ${port} in use, trying ${port + 1}...`);
                httpServer.listen(port + 1, () => {
                    console.log(`🌱 Skillseed MCP server running on http://localhost:${port + 1}/mcp`);
                    resolve(httpServer);
                });
            }
            else {
                reject(err);
            }
        });
    });
}
//# sourceMappingURL=mcp.js.map