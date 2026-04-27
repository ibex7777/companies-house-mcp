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

/** Read a request body to a string. Used for parsing the form-encoded
 *  body of the OAuth token endpoint. */
function readRequestBody(req: {
  on: (event: string, cb: (chunk?: unknown) => void) => void;
}): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: unknown) => {
      body += String(chunk);
    });
    req.on('end', () => resolve(body));
    req.on('error', (err: unknown) => reject(err));
  });
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

    // OAuth (client_credentials grant) — optional, enabled when both
    // MCP_OAUTH_CLIENT_ID and MCP_OAUTH_CLIENT_SECRET are set. This lets
    // clients that don't support a manually-pasted bearer header (e.g.
    // Claude desktop's Custom Connector UI) authenticate via OAuth and
    // receive an access token that is identical to MCP_BEARER_TOKEN.
    const oauthClientId = process.env.MCP_OAUTH_CLIENT_ID?.trim();
    const oauthClientSecret = process.env.MCP_OAUTH_CLIENT_SECRET?.trim();
    const oauthEnabled = Boolean(oauthClientId && oauthClientSecret);
    // Optional override for the public URL announced in OAuth discovery
    // metadata. Falls back to deriving it from the request headers, which
    // works when the server sits behind Fly's edge (which sets
    // X-Forwarded-Proto correctly).
    const publicUrlOverride = process.env.MCP_PUBLIC_URL?.trim();

    if (!expectedToken) {
      console.error(
        'WARNING: MCP_BEARER_TOKEN env var not set — server is unauthenticated.\n' +
          '         Do not expose this server publicly without setting a token.'
      );
    }

    if (oauthEnabled && !expectedToken) {
      console.error(
        'ERROR: MCP_OAUTH_CLIENT_ID/SECRET are set but MCP_BEARER_TOKEN is not.\n' +
          '       OAuth would have nothing to issue. Aborting.'
      );
      process.exit(1);
    }

    const httpServer = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${port}`);

      // CORS preflight — Claude desktop may invoke OAuth from a webview.
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type',
          'Access-Control-Max-Age': '86400',
        });
        res.end();
        return;
      }

      if (url.pathname === '/health') {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(
          JSON.stringify({
            status: 'ok',
            tools: tools.length,
            oauth: oauthEnabled,
          }),
        );
        return;
      }

      // ---- OAuth: discovery metadata
      if (url.pathname === '/.well-known/oauth-authorization-server') {
        if (!oauthEnabled) {
          res.writeHead(404);
          res.end('Not Found');
          return;
        }
        const proto =
          (req.headers['x-forwarded-proto'] as string | undefined) ??
          'http';
        const host =
          (req.headers.host as string | undefined) ?? `localhost:${port}`;
        const issuer = publicUrlOverride || `${proto}://${host}`;
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(
          JSON.stringify({
            issuer,
            token_endpoint: `${issuer}/oauth/token`,
            grant_types_supported: ['client_credentials'],
            token_endpoint_auth_methods_supported: [
              'client_secret_basic',
              'client_secret_post',
            ],
            response_types_supported: [],
          }),
        );
        return;
      }

      // ---- OAuth: token endpoint
      if (url.pathname === '/oauth/token') {
        if (!oauthEnabled) {
          res.writeHead(404);
          res.end('Not Found');
          return;
        }
        if (req.method !== 'POST') {
          res.writeHead(405, {
            'Content-Type': 'application/json',
            Allow: 'POST',
          });
          res.end(
            JSON.stringify({
              error: 'invalid_request',
              error_description: 'Only POST is supported',
            }),
          );
          return;
        }

        let bodyText = '';
        try {
          bodyText = await readRequestBody(req);
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: 'invalid_request',
              error_description: `Could not read body: ${(err as Error).message}`,
            }),
          );
          return;
        }
        const params = new URLSearchParams(bodyText);

        // Client credentials may arrive via HTTP Basic auth header
        // (RFC 6749 §2.3.1) or in the request body.
        let clientId: string | undefined;
        let clientSecret: string | undefined;

        const authHeader =
          (req.headers.authorization as string | undefined) ?? '';
        const basicMatch = /^Basic\s+(.+)$/i.exec(authHeader);
        if (basicMatch && basicMatch[1]) {
          try {
            const decoded = Buffer.from(basicMatch[1], 'base64').toString(
              'utf-8',
            );
            const colonIdx = decoded.indexOf(':');
            if (colonIdx >= 0) {
              clientId = decodeURIComponent(decoded.slice(0, colonIdx));
              clientSecret = decodeURIComponent(decoded.slice(colonIdx + 1));
            }
          } catch {
            /* fall through to body credentials */
          }
        }
        if (!clientId) clientId = params.get('client_id') ?? undefined;
        if (!clientSecret)
          clientSecret = params.get('client_secret') ?? undefined;

        if (
          !clientId ||
          !clientSecret ||
          clientId !== oauthClientId ||
          clientSecret !== oauthClientSecret
        ) {
          res.writeHead(401, {
            'Content-Type': 'application/json',
            'WWW-Authenticate': 'Basic',
          });
          res.end(
            JSON.stringify({
              error: 'invalid_client',
              error_description: 'Unknown client_id or client_secret',
            }),
          );
          return;
        }

        const grantType = params.get('grant_type');
        if (grantType !== 'client_credentials') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: 'unsupported_grant_type',
              error_description:
                'Only client_credentials grant is supported by this server',
            }),
          );
          return;
        }

        // Issue an access token. We re-use the static MCP_BEARER_TOKEN
        // value as the access token, which means the existing /mcp
        // bearer-auth check accepts OAuth-issued tokens with no extra
        // logic. expires_in is advisory; the server doesn't actually
        // expire tokens (the static bearer never expires).
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          Pragma: 'no-cache',
        });
        res.end(
          JSON.stringify({
            access_token: expectedToken,
            token_type: 'Bearer',
            expires_in: 3600,
          }),
        );
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
      if (oauthEnabled) {
        console.error(
          'OAuth: enabled — client_credentials grant accepted at /oauth/token',
        );
        console.error(
          `OAuth discovery: http://localhost:${port}/.well-known/oauth-authorization-server`,
        );
      } else {
        console.error(
          'OAuth: disabled — set MCP_OAUTH_CLIENT_ID and MCP_OAUTH_CLIENT_SECRET to enable',
        );
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
