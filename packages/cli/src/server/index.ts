#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
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

/** Constant-time string compare so /token's client_secret check doesn't
 *  leak timing info. Both inputs must be the same byte length; if not,
 *  we hash them first and compare hashes. */
function safeStringEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf-8');
  const bb = Buffer.from(b, 'utf-8');
  if (ba.length !== bb.length) {
    // Different lengths can never match. Still run a constant-time op
    // on equal-length hashes to avoid timing differences between this
    // branch and the equal-length branch below.
    const ha = createHash('sha256').update(ba).digest();
    const hb = createHash('sha256').update(bb).digest();
    timingSafeEqual(ha, hb);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

/** Build a stateless OAuth authorization code: a base64url-encoded JSON
 *  payload joined to an HMAC signature. Verifying the signature later is
 *  enough to trust the payload — no server-side store is needed. This
 *  works across Fly's HA pair because both machines share the signing
 *  secret via env var. */
function makeAuthCode(
  payload: Record<string, unknown>,
  signingKey: string,
): string {
  const json = JSON.stringify(payload);
  const body = Buffer.from(json, 'utf-8').toString('base64url');
  const sig = createHmac('sha256', signingKey).update(body).digest('base64url');
  return `${body}.${sig}`;
}

/** Verify an auth code's HMAC signature and return the decoded payload,
 *  or null if the signature doesn't match / the code is malformed. */
function verifyAuthCode(
  code: string,
  signingKey: string,
): Record<string, unknown> | null {
  const dotIdx = code.lastIndexOf('.');
  if (dotIdx < 0) return null;
  const body = code.slice(0, dotIdx);
  const sig = code.slice(dotIdx + 1);
  const expectedSig = createHmac('sha256', signingKey)
    .update(body)
    .digest('base64url');
  if (!safeStringEqual(sig, expectedSig)) return null;
  try {
    const json = Buffer.from(body, 'base64url').toString('utf-8');
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
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

    // OAuth — optional, enabled when both MCP_OAUTH_CLIENT_ID and
    // MCP_OAUTH_CLIENT_SECRET are set. Supports two grants:
    //  - client_credentials  (server-to-server, e.g. curl tests)
    //  - authorization_code  (with PKCE, used by Claude desktop's
    //                         Custom Connector UI)
    // Issued access tokens equal MCP_BEARER_TOKEN, so the existing /mcp
    // bearer-auth check accepts both manual and OAuth-issued tokens.
    const oauthClientId = process.env.MCP_OAUTH_CLIENT_ID?.trim();
    const oauthClientSecret = process.env.MCP_OAUTH_CLIENT_SECRET?.trim();
    const oauthEnabled = Boolean(oauthClientId && oauthClientSecret);
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

    // Used to sign authorization codes. Reusing the bearer token as the
    // HMAC key is fine for a single-user server: anyone who can read it
    // could also read access tokens directly.
    const codeSigningKey = expectedToken ?? '';

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

      // ---- OAuth: discovery metadata ------------------------------------
      if (url.pathname === '/.well-known/oauth-authorization-server') {
        if (!oauthEnabled) {
          res.writeHead(404);
          res.end('Not Found');
          return;
        }
        const proto =
          (req.headers['x-forwarded-proto'] as string | undefined) ?? 'http';
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
            authorization_endpoint: `${issuer}/oauth/authorize`,
            token_endpoint: `${issuer}/oauth/token`,
            response_types_supported: ['code'],
            grant_types_supported: [
              'authorization_code',
              'client_credentials',
            ],
            code_challenge_methods_supported: ['S256', 'plain'],
            token_endpoint_auth_methods_supported: [
              'client_secret_basic',
              'client_secret_post',
              'none',
            ],
            scopes_supported: ['mcp'],
          }),
        );
        return;
      }

      // ---- OAuth: authorization endpoint --------------------------------
      // Single-user server: validate the request, mint a signed code, and
      // 302 back to the redirect_uri. There's no login UI because there's
      // only one user; possession of client_id is treated as approval.
      if (url.pathname === '/oauth/authorize') {
        if (!oauthEnabled) {
          res.writeHead(404);
          res.end('Not Found');
          return;
        }
        if (req.method !== 'GET') {
          res.writeHead(405, { Allow: 'GET' });
          res.end('Method Not Allowed');
          return;
        }

        const q = url.searchParams;
        const responseType = q.get('response_type');
        const reqClientId = q.get('client_id');
        const redirectUri = q.get('redirect_uri');
        const state = q.get('state') ?? '';
        const codeChallenge = q.get('code_challenge') ?? '';
        const codeChallengeMethod = q.get('code_challenge_method') ?? 'plain';
        const scope = q.get('scope') ?? '';

        // Helper: redirect back to the client with an OAuth-style error.
        const redirectError = (code: string, description: string) => {
          if (!redirectUri) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({ error: code, error_description: description }),
            );
            return;
          }
          let target: URL;
          try {
            target = new URL(redirectUri);
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                error: 'invalid_request',
                error_description: 'Malformed redirect_uri',
              }),
            );
            return;
          }
          target.searchParams.set('error', code);
          target.searchParams.set('error_description', description);
          if (state) target.searchParams.set('state', state);
          res.writeHead(302, { Location: target.toString() });
          res.end();
        };

        if (!reqClientId || reqClientId !== oauthClientId) {
          // Per RFC 6749 §4.1.2.1, an unknown client_id should NOT
          // redirect — return a direct error to avoid open-redirect risk.
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: 'invalid_client',
              error_description: 'Unknown client_id',
            }),
          );
          return;
        }
        if (!redirectUri) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: 'invalid_request',
              error_description: 'Missing redirect_uri',
            }),
          );
          return;
        }
        if (responseType !== 'code') {
          redirectError(
            'unsupported_response_type',
            'Only response_type=code is supported',
          );
          return;
        }
        if (
          codeChallengeMethod !== 'S256' &&
          codeChallengeMethod !== 'plain'
        ) {
          redirectError(
            'invalid_request',
            'Unsupported code_challenge_method',
          );
          return;
        }

        // Mint a 10-minute auth code containing everything we'll need to
        // verify the subsequent /oauth/token request.
        const code = makeAuthCode(
          {
            cid: reqClientId,
            rdi: redirectUri,
            cch: codeChallenge,
            ccm: codeChallengeMethod,
            sco: scope,
            exp: Date.now() + 10 * 60 * 1000,
          },
          codeSigningKey,
        );

        let target: URL;
        try {
          target = new URL(redirectUri);
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: 'invalid_request',
              error_description: 'Malformed redirect_uri',
            }),
          );
          return;
        }
        target.searchParams.set('code', code);
        if (state) target.searchParams.set('state', state);
        res.writeHead(302, { Location: target.toString() });
        res.end();
        return;
      }

      // ---- OAuth: token endpoint ---------------------------------------
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
        // (RFC 6749 §2.3.1) or in the request body. PKCE-only
        // public clients may omit the secret entirely.
        let reqClientId: string | undefined;
        let reqClientSecret: string | undefined;

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
              reqClientId = decodeURIComponent(decoded.slice(0, colonIdx));
              reqClientSecret = decodeURIComponent(
                decoded.slice(colonIdx + 1),
              );
            }
          } catch {
            /* fall through to body credentials */
          }
        }
        if (!reqClientId) reqClientId = params.get('client_id') ?? undefined;
        if (!reqClientSecret)
          reqClientSecret = params.get('client_secret') ?? undefined;

        const grantType = params.get('grant_type');

        // Helper used by both grants to issue the access token.
        const issueToken = () => {
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            Pragma: 'no-cache',
            'Access-Control-Allow-Origin': '*',
          });
          res.end(
            JSON.stringify({
              access_token: expectedToken,
              token_type: 'Bearer',
              expires_in: 3600,
            }),
          );
        };

        if (grantType === 'client_credentials') {
          if (
            !reqClientId ||
            !reqClientSecret ||
            !oauthClientId ||
            !oauthClientSecret ||
            !safeStringEqual(reqClientId, oauthClientId) ||
            !safeStringEqual(reqClientSecret, oauthClientSecret)
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
          issueToken();
          return;
        }

        if (grantType === 'authorization_code') {
          const code = params.get('code') ?? '';
          const codeVerifier = params.get('code_verifier') ?? '';
          const redirectUri = params.get('redirect_uri') ?? '';

          if (!code) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                error: 'invalid_request',
                error_description: 'Missing code',
              }),
            );
            return;
          }
          const payload = verifyAuthCode(code, codeSigningKey);
          if (!payload) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                error: 'invalid_grant',
                error_description: 'Invalid authorization code signature',
              }),
            );
            return;
          }

          const exp = typeof payload.exp === 'number' ? payload.exp : 0;
          if (Date.now() > exp) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                error: 'invalid_grant',
                error_description: 'Authorization code expired',
              }),
            );
            return;
          }

          const expectedClientId = String(payload.cid ?? '');
          if (
            !reqClientId ||
            !oauthClientId ||
            !safeStringEqual(reqClientId, expectedClientId) ||
            !safeStringEqual(expectedClientId, oauthClientId)
          ) {
            res.writeHead(401, {
              'Content-Type': 'application/json',
              'WWW-Authenticate': 'Basic',
            });
            res.end(
              JSON.stringify({
                error: 'invalid_client',
                error_description: 'client_id mismatch',
              }),
            );
            return;
          }

          // Confidential clients (those that registered a secret) must
          // present it. Public clients (PKCE-only) may omit the secret.
          // Since we only have one configured client and it has a secret,
          // we accept either: secret present and matches, OR secret
          // absent + valid PKCE (checked below).
          if (reqClientSecret) {
            if (
              !oauthClientSecret ||
              !safeStringEqual(reqClientSecret, oauthClientSecret)
            ) {
              res.writeHead(401, {
                'Content-Type': 'application/json',
                'WWW-Authenticate': 'Basic',
              });
              res.end(
                JSON.stringify({
                  error: 'invalid_client',
                  error_description: 'Bad client_secret',
                }),
              );
              return;
            }
          }

          const expectedRedirectUri = String(payload.rdi ?? '');
          if (
            !redirectUri ||
            !safeStringEqual(redirectUri, expectedRedirectUri)
          ) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                error: 'invalid_grant',
                error_description: 'redirect_uri mismatch',
              }),
            );
            return;
          }

          // PKCE verification — required if the original /authorize
          // request included a code_challenge.
          const challenge = String(payload.cch ?? '');
          const challengeMethod = String(payload.ccm ?? 'plain');
          if (challenge) {
            if (!codeVerifier) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  error: 'invalid_grant',
                  error_description: 'Missing code_verifier',
                }),
              );
              return;
            }
            let derived: string;
            if (challengeMethod === 'S256') {
              derived = createHash('sha256')
                .update(codeVerifier, 'utf-8')
                .digest('base64url');
            } else {
              derived = codeVerifier;
            }
            if (!safeStringEqual(derived, challenge)) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  error: 'invalid_grant',
                  error_description: 'PKCE verification failed',
                }),
              );
              return;
            }
          } else if (!reqClientSecret) {
            // No PKCE and no client secret — not allowed.
            res.writeHead(401, {
              'Content-Type': 'application/json',
            });
            res.end(
              JSON.stringify({
                error: 'invalid_client',
                error_description:
                  'Public clients must use PKCE; confidential clients must present client_secret',
              }),
            );
            return;
          }

          issueToken();
          return;
        }

        // Unknown / missing grant_type
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: 'unsupported_grant_type',
            error_description: `Grant type '${grantType ?? ''}' is not supported`,
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
          'OAuth: enabled (authorization_code + client_credentials grants)',
        );
        console.error(`OAuth authorize: http://localhost:${port}/oauth/authorize`);
        console.error(`OAuth token:     http://localhost:${port}/oauth/token`);
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
