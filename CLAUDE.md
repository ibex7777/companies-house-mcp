# Companies House MCP

## Project Overview

MCP server and CLI for the UK Companies House API. Provides 17 tools covering company search, profiles, officers, filings, ownership (PSCs), charges, insolvency, and composite operations (company reports, due diligence checks, officer network mapping).

## Monorepo Structure

This is a pnpm workspace with two packages:

```
/
├── packages/
│   ├── cli/          # Main package — all source code, CLI binary, MCP server
│   └── mcp/          # Thin wrapper for MCP registry distribution (one import)
├── docs/             # VitePress documentation site
├── .github/          # GitHub Actions workflows
├── package.json      # Root workspace (private), aggregates scripts
├── pnpm-workspace.yaml
├── tsconfig.json     # Root TS config — references cli + mcp
├── server.json       # MCP registry manifest
└── smithery.yaml     # Smithery deployment config
```

**All source code lives in `packages/cli/src/`.** The `packages/mcp` package is a single-line re-export used for NPM distribution under the `companies-house-mcp` name.

## Source Layout (`packages/cli/src/`)

```
src/
├── api/
│   ├── client.ts           # HTTP client (auth, retries, rate limiting, caching)
│   ├── rate-limiter.ts     # Token bucket rate limiter (never throws — queues)
│   ├── cache.ts            # LRU cache with per-entry TTL
│   └── endpoints/
│       ├── company.ts      # getCompanyProfile, getRegisteredOfficeAddress, getCompanyRegisters
│       ├── search.ts       # searchCompanies, advancedSearchCompanies, searchOfficers
│       ├── officers.ts     # getCompanyOfficers, getOfficerAppointments, disqualifications
│       ├── psc.ts          # getPersonsWithSignificantControl
│       ├── charges.ts      # getCompanyCharges
│       ├── filing.ts       # getFilingHistory, getFilingItem, getDocumentMetadata
│       ├── insolvency.ts   # getCompanyInsolvency
│       └── exemptions.ts   # getExemptions, getUKEstablishments
├── tools/
│   ├── registry.ts         # Core: registerTool, getTool, getAllTools, result helpers
│   ├── search.ts           # search_companies, search_officers
│   ├── company.ts          # get_company_profile
│   ├── officers.ts         # get_officers, get_appointments
│   ├── ownership.ts        # get_ownership
│   ├── financial.ts        # get_charges, get_insolvency
│   ├── extended.ts         # get_company_registers, get_exemptions, get_uk_establishments, get_officer_disqualifications
│   ├── composite.ts        # company_report, due_diligence_check, officer_network
│   └── download-filing-document.ts  # get_filing_document
├── server/
│   ├── index.ts            # MCP server (stdio + HTTP modes, OAuth, bearer auth)
│   └── oauth.ts            # OAuth request handler
├── cli/
│   ├── index.ts            # CLI entry point — command dispatch, flag parsing
│   └── terminal-format.ts  # ANSI color output, markdown-to-terminal
├── formatters/
│   └── index.ts            # Shared markdown formatters for all data types
├── types/
│   └── index.ts            # TypeScript interfaces (snake_case, matches API exactly)
└── config.ts               # API key resolution + storage (~/.config/companies-house/)
```

## Build & Run

All commands run from the **repo root** using pnpm:

```bash
pnpm build             # TypeScript compilation (both packages)
pnpm dev               # Build + run stdio MCP server
pnpm start             # Run from dist/ (stdio)
pnpm start:http        # Run in streamable HTTP mode

pnpm lint              # ESLint
pnpm typecheck         # tsc --noEmit
pnpm format            # Prettier
pnpm docs:dev          # VitePress dev server
```

Package-level builds from `packages/cli/`:
```bash
pnpm build             # tsc -p tsconfig.json
```

## Testing

```bash
pnpm test              # All tests (vitest)
pnpm test:unit         # Unit tests only
pnpm test:integration  # Integration tests — requires COMPANIES_HOUSE_API_KEY
pnpm test:coverage     # Coverage report (v8 provider)
```

Test files live in `packages/cli/tests/`:
- `tests/unit/api/` — client, rate-limiter, cache
- `tests/unit/tools/` — registry, tool execution, formatters, document download
- `tests/integration/tools.test.ts` — live API tests (skipped without key, 30s timeout)

Integration tests use Tesco (`00445790`) and Anthropic UK (`13861484`) as fixture companies.

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `COMPANIES_HOUSE_API_KEY` | Yes | — | Get from developer.company-information.service.gov.uk |
| `CH_MCP_RATE_LIMIT` | No | 600/5min | Request rate limit |
| `CH_MCP_CACHE_SIZE` | No | 1000 | LRU cache max entries |
| `CH_MCP_LOG_LEVEL` | No | info | Log verbosity |
| `MCP_BEARER_TOKEN` | No | — | HTTP mode bearer auth |
| `MCP_OAUTH_CLIENT_ID` | No | — | OAuth client ID (HTTP mode) |
| `MCP_OAUTH_CLIENT_SECRET` | No | — | OAuth client secret (HTTP mode) |
| `DEBUG` | No | — | Enable debug output |
| `NO_COLOR` | No | — | Disable ANSI terminal colors |

API key resolution order: `--key` flag > `COMPANIES_HOUSE_API_KEY` env var > `~/.config/companies-house/config.json`.

## The 17 Tools

### Search
| Tool | Description |
|---|---|
| `search_companies` | Full-text company search with filters (status, type, incorporation date, location, SIC codes) |
| `search_officers` | Officer name search across all UK companies |

### Core Company Data
| Tool | Description |
|---|---|
| `get_company_profile` | Full profile: status, type, addresses, SIC codes, key dates, accounts info |
| `get_officers` | Company officers (active/resigned) with pagination |
| `get_appointments` | All directorships for an officer across all companies |
| `get_ownership` | Persons with Significant Control — ownership %, voting rights, nature of control |

### Financial & Legal
| Tool | Description |
|---|---|
| `get_charges` | Registered charges (mortgages, debentures) with status tracking |
| `get_insolvency` | Insolvency cases, proceedings, practitioners, key dates |

### Extended
| Tool | Description |
|---|---|
| `get_company_registers` | Location of statutory registers (members, directors, secretaries, charges) |
| `get_exemptions` | Filing exemptions and PSC exemptions |
| `get_uk_establishments` | UK branches of overseas companies |
| `get_officer_disqualifications` | Disqualification orders (natural persons and corporates) |

### Documents
| Tool | Description |
|---|---|
| `get_filing_document` | Downloads filed documents (PDF/XHTML/XML/JSON) via Document API — two-step fetch (metadata → signed S3 URL) |

### Composite (multi-call wrappers)
| Tool | Description |
|---|---|
| `company_report` | Single call returning profile + active officers + PSCs + charges + recent filings + insolvency |
| `due_diligence_check` | Automated red-flag scan with severity ratings (HIGH/MEDIUM/LOW): dissolved, liquidation, overdue accounts, charges, disqualified directors |
| `officer_network` | Maps an officer's full network of directorships across companies |

## Code Conventions

### ESM & TypeScript
- ESM modules (`"type": "module"`) — all imports use `.js` extensions even for `.ts` source files
- ES2022 target, strict mode
- Types in `src/types/index.ts` use snake_case to match the Companies House API exactly

### Tool Registration Pattern
Tools self-register by calling `registerTool()` at module level. The server and CLI import these modules for side effects only:

```typescript
// In server/index.ts or cli/index.ts:
import '../tools/search.js';     // registers search_companies, search_officers
import '../tools/composite.js';  // registers company_report, due_diligence_check, officer_network

// In tools/search.ts:
import { registerTool } from './registry.js';

registerTool({
  name: 'search_companies',
  description: '...',
  inputSchema: { q: z.string().describe('...') },  // Zod raw shape
  parseSchema: z.object({ q: z.string() }),          // full Zod schema for parsing
  annotations: TOOL_ANNOTATIONS,
  async execute(args, client) { ... }
});
```

### Tool Return Shape
All tools return a `ToolResult`:

```typescript
interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;  // markdown for humans
  structuredContent?: Record<string, unknown>;       // JSON for agents
  isError?: boolean;
}
```

Use the helpers: `makeTextResult(text, data?)` and `makeErrorResult(message)`.

### API Client Patterns
- Authentication: HTTP Basic auth with base64-encoded API key (no password)
- Retries: exponential backoff for 5xx errors (500ms → 1s → 2s), max 3 attempts
- Rate limiter: token bucket, **never throws** — queues requests until a token is available
- Cache: LRU, checked before every request, stored after success

**Cache TTLs:**
| Endpoint type | TTL |
|---|---|
| Company profile, charges, insolvency, registers | 30 min |
| Officers, PSC data | 15 min |
| Search results, filing history | 5 min |

### Error Handling
- `CompaniesHouseAPIError` carries `status` and `endpoint` — thrown for non-404/429 HTTP errors
- 404 responses: return empty/graceful message (charges and insolvency endpoints return 404 for companies with no data)
- 429 (rate limit): handled silently by the rate limiter queue — never reaches tool code
- Zod validation runs before tool execution; invalid input returns a structured error

### Formatters
`src/formatters/index.ts` exports pure functions for markdown output. Use these everywhere instead of inline string formatting:
- `formatDate()` — en-GB locale ("14 May 2026")
- `formatCompanyStatus()`, `formatCompanyType()`, `formatOfficerRole()`, `formatNatureOfControl()`
- `formatCompanyProfile()`, `formatOfficers()`, `formatPSCs()`, `formatCharges()`, `formatInsolvency()`, `formatFilings()`, `formatAppointments()`, `formatCompanySearchResults()`, `formatOfficerSearchResults()`

## Important Invariants

- **Never commit API keys** — `.env` is gitignored; config file is mode `0o600`
- **Company numbers are 8-digit zero-padded strings** — e.g., `"00445790"` not `445790`
- **The API returns 404 for valid companies with no data** on insolvency and charges endpoints — this is not an error, return a "no data" message
- **Rate limiter never throws** — do not add timeout/error handling around rate-limited calls
- **All tools are read-only** — `TOOL_ANNOTATIONS` marks them as non-destructive and idempotent
- **`.js` extensions required in imports** — TypeScript ESM convention; omitting them breaks at runtime
- **pnpm only** — the repo uses `pnpm-lock.yaml`; do not use npm or yarn

## CLI Reference

```bash
ch search <query> [--status active] [--type ltd] [--sic 6201] [--location london] [--limit 10]
ch profile <company_number>
ch officers <company_number> [--all]
ch ownership <company_number>
ch filings <company_number> [--limit 10]
ch charges <company_number>
ch report <company_number>
ch check <company_number>
ch network <officer_id>

# Output modes (all commands)
ch profile 00445790 --json    # Raw JSON
ch profile 00445790 --md      # Markdown
```
