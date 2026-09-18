<div align="center">

# Hearth

**A cozy personal dashboard on Cloudflare Workers**

[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare%20Workers-F38020?style=for-the-badge&logo=cloudflare&logoColor=white)](#)
[![D1](https://img.shields.io/badge/D1-SQLite-22D3EE?style=for-the-badge&logo=cloudflare&logoColor=white)](#)
[![license Non-Commercial](https://img.shields.io/badge/license-Non--Commercial-A855F7?style=for-the-badge)](LICENSE)

</div>

Hearth is a small personal dashboard for two people. It runs as a Cloudflare Worker with D1 storage and an optional R2 photo bucket. The same private data is available through a standards-compliant, OAuth-protected MCP Streamable HTTP endpoint so Claude and other compatible clients can discover and use Hearth's tools.

## Features

- Dashboard overview, moods, shared notes, moments, important dates and shopping list
- Food and water diary with private R2 photos and daily reviews
- Weather, barometric pressure history and pressure-shift alerts
- Configurable partner names
- Password-protected web dashboard with signed, expiring sessions
- Streamable HTTP MCP with JSON-RPC `initialize`, `ping`, `tools/list` and `tools/call`
- OAuth 2.1 authorization with PKCE, protected-resource discovery, CIMD and Dynamic Client Registration
- Separate `hearth:read` and `hearth:write` permissions
- Deployment and connector-configuration CLI

The MCP server exposes `hearth_status`, `hearth_mood`, `hearth_note`, `hearth_moment`, `hearth_date`, `hearth_shopping_list`, `hearth_shopping_add`, `hearth_pressure`, `hearth_food_diary_today`, `hearth_food_diary_history`, `hearth_food_review`, and `hearth_water_status`.

## Deploy

### Bundled CLI

```bash
npx hearth-dash deploy
npx hearth-dash mcp
```

The deploy command creates the D1 database, R2 bucket and OAuth KV namespace; installs the pinned runtime dependency; prompts for configuration; generates a session-signing secret; applies the schema; and deploys the Worker. It does not save the dashboard password locally.

### Manual deployment

```bash
npm install

# Create storage and put the returned IDs in wrangler.toml
npx wrangler d1 create hearth-dash-db
npx wrangler r2 bucket create hearth-dash-photos
npx wrangler kv namespace create hearth-dash-oauth

# Generate a SESSION_SECRET
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"

# Optional weather integration
# (set WEATHER_API_KEY after provisioning if wanted)

# Provision the Worker first, then initialize storage and set secrets
npm run deploy
npm run db:init:remote
npx wrangler secret put DASHBOARD_PASSWORD
npx wrangler secret put SESSION_SECRET
npx wrangler secret put WEATHER_API_KEY  # optional

# Activate the fully configured Worker
npm run deploy
```

Configuration lives in `wrangler.toml`: partner names under `[vars]`, the D1 binding, OAuth KV binding, R2 bucket binding and optional `WEATHER_LAT` / `WEATHER_LON`. Keep the `global_fetch_strictly_public` compatibility flag: it lets the OAuth provider resolve Claude's Client ID Metadata Document with Cloudflare's SSRF protections. OpenWeatherMap is required only for weather and pressure features.

## Connect Claude

After deployment, run `npx hearth-dash mcp`. The connector URL is:

```text
https://your-worker.example/mcp
```

There is no secret in that URL.

### Claude.ai, Claude Desktop and Claude mobile

1. Open **Customize → Connectors → Add custom connector**.
2. Enter the printed `/mcp` URL.
3. Choose **Sign in now** if Claude asks for an authentication mode.
4. Choose **Use Claude's published identity** (recommended) or **Register automatically**. Hearth supports both CIMD and DCR. Do not enter a client secret.
5. Claude opens Hearth's consent page. Enter the dashboard password, review the read/write permissions and approve.
6. Claude returns through `https://claude.ai/api/mcp/auth_callback` and stores revocable OAuth tokens. The dashboard password is never sent as an MCP credential.

Claude connects from Anthropic's cloud, so the Worker must be publicly reachable.

### Claude Code

```bash
claude mcp add --transport http hearth-dash https://your-worker.example/mcp
```

Then open `/mcp` inside Claude Code and complete authentication. Claude Code uses a loopback callback rather than Claude.ai's hosted callback; DCR handles its varying local port.

## Upgrading from 1.0.1

Version 1.0.1 labelled a custom `{ "tool": ..., "params": ... }` HTTP handler as MCP. It did not implement MCP JSON-RPC or tool discovery and could not work as a Claude.ai custom connector. Version 1.1.0 replaces it with Streamable HTTP MCP and OAuth 2.1. The old payload and secret-bearing URL formats are intentionally rejected.

Existing deployments must:

1. Install dependencies with `npm install`.
2. Create an OAuth KV namespace and add its ID as the `OAUTH_KV` binding in `wrangler.toml`.
3. Keep `compatibility_flags = ["global_fetch_strictly_public"]`.
4. Set a new `SESSION_SECRET` Worker secret.
5. Re-run `schema.sql` remotely to add the rate-limit table.
6. Deploy `oauth-entry.js` as the Worker entrypoint.
7. Remove and re-add the custom connector using `https://your-worker.example/mcp`.
8. Delete the obsolete secret with `npx wrangler secret delete MCP_SECRET` after the new deployment works.

The first-visit password setup page has also been removed. A public, unclaimed setup page allowed the first visitor—not necessarily the owner—to take control of a new deployment. Configure `DASHBOARD_PASSWORD` as a Worker secret instead.

## Security notes

- There are no functional default credentials, bearer tokens or secret-bearing connector URLs.
- OAuth uses authorization-code flow, S256 PKCE, RFC 9728 protected-resource metadata, RFC 8414 authorization-server metadata, resource-bound access tokens and refresh-token rotation from Cloudflare's maintained `workers-oauth-provider` library.
- Access tokens expire after one hour. Rotating refresh tokens have a 30-day TTL. Dynamically registered clients expire after 90 days.
- Consent requires either a valid signed dashboard session or the dashboard password. Consent POSTs use a short-lived CSRF cookie, same-origin checks and rate limiting.
- `hearth:read` and `hearth:write` are enforced at tool-call time. Read-only tokens cannot invoke write actions hidden inside mixed read/write tools.
- Session cookies are signed, expire after seven days and use the `__Host-` prefix plus `Secure`, `HttpOnly` and `SameSite=Strict`.
- Browser origins, JSON body size and tool arguments are validated. MCP, login, consent and dynamic-registration paths are rate-limited.
- Private R2 photos are served only through authenticated dashboard routes and use `private, no-store`. MCP results do not expose photo URLs.
- Compatible clients can revoke their grant through Hearth's OAuth revocation endpoint. Removing a connector always removes its locally stored token, but not every client promises server-side revocation. For emergency revocation of every OAuth grant, replace the `OAUTH_KV` binding with a fresh namespace (or delete all keys in the existing namespace) and redeploy.
- Hearth's bundled authorization screen represents one dashboard owner, not a multi-tenant identity system. Separate households should use separate deployments.

## Development

```bash
npm test
npx wrangler deploy --dry-run
npm run dev
```

The unit suite tests MCP protocol behavior, tool validation, scope enforcement and dashboard sessions. OAuth discovery and the full PKCE flow should also be exercised through a local HTTPS Wrangler server or a disposable deployment before release.

Requires Node.js 22 or newer. Hearth pins the tested Wrangler release used by its deployment CLI.

## License

Non-Commercial. Free for personal, educational and non-commercial use. See [LICENSE](LICENSE).
