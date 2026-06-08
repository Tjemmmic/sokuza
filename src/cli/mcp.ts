import { runMcpServer } from '../core/mcp-server.js';

/**
 * `sokuza mcp` — run Sokuza's MCP server over stdio.
 *
 * Intended to be launched by an MCP client (Claude Code et al.) via its config,
 * not run interactively. stdout is the protocol channel, so nothing here may
 * write to it; the server keeps the process alive on stdin.
 */
export async function runMcp(): Promise<void> {
    await runMcpServer();
}
