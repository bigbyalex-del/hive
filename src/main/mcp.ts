// MCP (Model Context Protocol) client for Hive workers.
//
// Connects to one or more MCP servers as child processes, lists their tools,
// and exposes them in the same shape as our built-in ToolDef so they slot
// into the worker tool loop alongside Read/Write/Edit/Run.
//
// v0 scope: hardcoded server registry, manual reload required to add servers.
// Full UI / dynamic registry lands in next session.

import * as path from 'path';
import { ToolDef } from './providers/types';
import { audit } from './runtime';

const dynamicImport = new Function('m', 'return import(m)') as (m: string) => Promise<any>;

export interface McpServerConfig {
  name: string;          // logical name shown in audit + UI
  command: string;       // executable, e.g. "npx"
  args: string[];        // e.g. ["-y", "@modelcontextprotocol/server-filesystem", "<dir>"]
  env?: Record<string, string>;
  enabled?: boolean;     // default true
}

export interface McpClient {
  name: string;
  tools: ToolDef[];
  close: () => Promise<void>;
}

const activeClients = new Map<string, McpClient>();

export async function connectMcpServer(config: McpServerConfig): Promise<McpClient | null> {
  if (config.enabled === false) return null;

  try {
    const sdk = await dynamicImport('@modelcontextprotocol/sdk/client/index.js');
    const stdio = await dynamicImport('@modelcontextprotocol/sdk/client/stdio.js');
    const Client = sdk.Client;
    const StdioClientTransport = stdio.StdioClientTransport;

    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: { ...process.env, ...(config.env ?? {}) },
    });

    const client = new Client(
      { name: 'hive', version: '0.3.0' },
      { capabilities: {} }
    );

    await client.connect(transport);

    // List tools the server exposes.
    const toolList = await client.listTools();

    // Wrap each MCP tool as a Hive ToolDef. Names get prefixed with `mcp_<server>_`
    // to avoid collisions with our built-ins.
    const tools: ToolDef[] = toolList.tools.map((t: any) => ({
      name: `mcp_${config.name}_${t.name}`,
      description: `[${config.name}] ${t.description ?? t.name}`,
      schema: t.inputSchema ?? { type: 'object', properties: {}, additionalProperties: true },
      run: async (input: any) => {
        audit({
          ts: Date.now(),
          agent: 'unknown',
          tool: `mcp:${config.name}:${t.name}`,
          input: typeof input === 'object' ? Object.keys(input || {}) : String(input),
          decision: 'allow',
        });
        const result = await client.callTool({ name: t.name, arguments: input ?? {} });
        // MCP returns content blocks — flatten to a string for the worker.
        if (Array.isArray(result.content)) {
          return result.content
            .map((b: any) => (b.type === 'text' ? b.text : JSON.stringify(b)))
            .join('\n');
        }
        return typeof result === 'string' ? result : JSON.stringify(result);
      },
    }));

    const wrapper: McpClient = {
      name: config.name,
      tools,
      close: async () => {
        try { await client.close(); } catch { /* ignore */ }
      },
    };
    activeClients.set(config.name, wrapper);
    console.log(`[hive] MCP connected: ${config.name} (${tools.length} tools)`);
    return wrapper;
  } catch (err: any) {
    console.error(`[hive] MCP connect failed for ${config.name}:`, err?.message ?? err);
    return null;
  }
}

export async function loadDefaultMcpServers(): Promise<ToolDef[]> {
  const defaults: McpServerConfig[] = [
    {
      name: 'fs',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', path.join(process.cwd(), 'worktrees')],
    },
  ];

  const allTools: ToolDef[] = [];
  for (const cfg of defaults) {
    const client = await connectMcpServer(cfg);
    if (client) allTools.push(...client.tools);
  }
  return allTools;
}

export async function shutdownAllMcp(): Promise<void> {
  for (const c of activeClients.values()) await c.close();
  activeClients.clear();
}

export function getMcpToolsForWorker(): ToolDef[] {
  const out: ToolDef[] = [];
  for (const c of activeClients.values()) out.push(...c.tools);
  return out;
}
