#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { APIClient } from '../api/client.js';
import { getAllTools } from '../tools/registry.js';
import { resolveApiKey } from '../config.js';

// Import all tool modules to trigger registration
import '../tools/search.js';
import '../tools/company.js';
import '../tools/officers.js';
import '../tools/ownership.js';
import '../tools/filings.js';
import '../tools/financial.js';
import '../tools/extended.js';
import '../tools/composite.js';
import '../tools/download-filing-document.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(
  readFileSync(join(__dirname, '../../package.json'), 'utf-8')
) as { version: string };

function getApiKey(): string {
  const resolved = resolveApiKey();
  if (!resolved) {
    console.error(
      'Error: No API key found.\n\n' +
        'Set one using either:\n' +
        '  1. COMPANIES_HOUSE_API_KEY env var (in MCP config or shell)\n' +
        '  2. Config file: run "ch config set-key <key>"\n\n' +
        'Get a free API key at https://developer.company-information.service.gov.uk/'
    );
    process.exit(1);
  }
  return resolved.key;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const isHttp = args.includes('--http');
  const portArgIdx = args.indexOf('--port');
  const portArg = portArgIdx !== -1 ? args[portArgIdx + 1] : undefined;

  const apiKey = getApiKey();
  const client = new APIClient({ api_key: apiKey });
  const tools = getAllTools();

  /**
   * Build a fresh McpServer with all tools registered.
   *
   * For stdio mode this is called once at startup. For HTTP mode it is
   * called per request — the MCP SDK doesn't allow re-using a single
   * server/transport across multiple connections, so each HTTP request
   * gets a disposable server+transport pair (stateless mode).
   */
  const buildServer = (): McpServer => {
    const s = new McpServer({
      name: 'companies-house',
      version,
    });
    for (const tool of tools) {
      s.registerTool(
        tool.name,
        {
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: tool.annotations,
        },
        async (params: Record<string, unknown>) => {
          return tool.execute(client, params);
        }
      );
    }
    return s;
  };

  if (isHttp) {
    const { StreamableHTTPServerTransport } = await import(
      '@modelcontextprotocol/sdk/server/streamableHttp.js'
    );
    const http = await import('node:http');
    const port = portArg ? parseInt(portArg, 10) : 3000;
    const expectedToken = process.env.MCP_BEARER_TOKEN?.trim();

    if (!expectedToken) {
      console.error(
        'WARNING: MCP_BEARER_TOKEN env var not set — server is unauthenticated.\n' +
          '         Do not expose this server publicly without setting a token.'
      );
    }

    const httpServer = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${port}`);

      if (url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', tools: tools.length }));
        return;
      }

      if (url.pathname !== '/mcp') {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }

      // Bearer token auth (only enforced when MCP_BEARER_TOKEN is set)
      if (expectedToken) {
        const authHeader = req.headers.authorization ?? '';
        const match = /^Bearer\s+(.+)$/i.exec(authHeader);
        if (!match || match[1] !== expectedToken) {
          res.writeHead(401, {
            'Content-Type': 'application/json',
            'WWW-Authenticate': 'Bearer',
          });
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }
      }

      // Stateless: build a fresh server + transport per request and tear
      // them down when the response closes. This works because each MCP
      // tool call is self-contained — we don't need cross-request session
      // state for this server.
      let sessionServer: McpServer | undefined;
      let transport: InstanceType<typeof StreamableHTTPServerTransport> | undefined;
      try {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined, // stateless mode
        });
        sessionServer = buildServer();

        const cleanup = () => {
          try {
            transport?.close();
          } catch {
            /* ignore */
          }
          try {
            sessionServer?.close();
          } catch {
            /* ignore */
          }
        };
        res.on('close', cleanup);

        await sessionServer.connect(transport);
        await transport.handleRequest(req, res);
      } catch (err) {
        console.error('Error handling /mcp request:', err);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'internal_server_error' }));
        }
        try {
          transport?.close();
        } catch {
          /* ignore */
        }
        try {
          sessionServer?.close();
        } catch {
          /* ignore */
        }
      }
    });

    httpServer.listen(port, () => {
      console.error(`Companies House MCP server (HTTP) listening on port ${port}`);
      console.error(`MCP endpoint: http://localhost:${port}/mcp`);
      console.error(`Health check: http://localhost:${port}/health`);
      console.error(`${tools.length} tools registered`);
      if (expectedToken) {
        console.error('Auth: bearer token required (MCP_BEARER_TOKEN)');
      } else {
        console.error('Auth: NONE — set MCP_BEARER_TOKEN before exposing publicly');
      }
    });
  } else {
    const server = buildServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(
      `Companies House MCP server (stdio) started — ${tools.length} tools registered`
    );
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
