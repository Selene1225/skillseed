/**
 * MCP Server — dual transport: stdio (default) + HTTP.
 */
import http from "node:http";
/** Start in stdio mode (for CLI auto-launch via MCP config) */
export declare function serveStdio(): Promise<void>;
/** Start in HTTP mode (multi-client) */
export declare function serveHttp(port?: number): Promise<http.Server>;
//# sourceMappingURL=mcp.d.ts.map