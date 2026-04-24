/**
 * Setup module — auto-configure AI CLIs during `skillseed init`.
 * Detects CLIs, injects MCP config, and creates CLAUDE.md prompts.
 */
interface DetectedCli {
    name: string;
    version: string;
    path: string;
}
/** Detect which AI CLIs are installed */
export declare function detectClis(): DetectedCli[];
/** Initialize ~/.skillseed/ directory structure */
export declare function initSkillseedDir(importStarters: boolean): void;
/** Configure Claude CLI MCP settings */
export declare function configureClaude(transport: "stdio" | "http", port: number): boolean;
/** Inject Skillseed instructions into CLAUDE.md */
export declare function injectClaudeMd(): boolean;
/** Configure Gemini CLI MCP settings */
export declare function configureGemini(transport: "stdio" | "http", port: number): boolean;
/** Update config.json with brain CLI choice */
export declare function setBrainCli(cli: "claude" | "gemini" | "none"): void;
/** Update config.json with device type */
export declare function setDeviceType(type: "work" | "personal" | "shared"): void;
/** Update config.json with transport */
export declare function setTransport(transport: "stdio" | "http", port?: number): void;
export {};
//# sourceMappingURL=setup.d.ts.map