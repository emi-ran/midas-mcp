# midas-mcp

An [MCP](https://modelcontextprotocol.io) server for the **Midas** brokerage
([atlas.getmidas.com](https://atlas.getmidas.com/)), so an AI assistant can read your
portfolio and place orders on BIST and US markets.

Midas has no public API. This server drives the Atlas web app with
[Playwright](https://playwright.dev): it keeps one authenticated browser session alive
and issues the same GraphQL calls the web app itself makes, from inside the page so the
session cookies are attached automatically.

> **This places real orders with real money.** Read the safety section before using it.

## Tools

| Tool | Arguments | What you get |
| --- | --- | --- |
| `get_portfolio` | – | Total value in TRY, today's P/L, cash and buying power per account |
| `get_assets` | – | Every open position: quantity, average cost, price, market value, P/L |
| `get_asset_price` | `symbol`, optional `currency` | Last price, previous close, % change, session status |
| `get_asset_info` | `symbol` | Instrument name, market and description, plus current price |
| `get_asset_details` | `symbol` | Midas overview stats/digest, analyst and trading trends, dividends and margin info |
| `get_asset_news` | optional `symbol`, `limit` (default 15, max 100) | Latest Midas BIST news; optionally filter by stock. Title, source, date and URL |
| `buy_asset` | `symbol`, `quantity`, optional `limit_price` | Places a buy order, returns the order id and status |
| `sell_asset` | `symbol`, `quantity`, optional `limit_price` | Places a sell order, returns the order id and status |
| `get_pending_orders` | `symbol` | Orders still waiting to execute, with their ids |
| `get_recent_orders` | optional `limit` (default 20, max 200) | Pending orders and recent order history, including cancellation or fill status |
| `cancel_order` | `order_id`, `symbol` | Cancels a pending order |

Omitting `limit_price` places a market order. Symbols are resolved by search, so both
tickers (`TUCLK`) and names work; BIST and US instruments are both supported.

## Safety

Every order is checked **before** it reaches Midas:

- **Value cap** — the order's estimated value is converted to TRY (Midas will quote any
  instrument in TRY) and refused if it exceeds `MAX_ORDER_VALUE_TRY`, which defaults to
  5000. One cap therefore covers both the TRY and USD accounts.
- **Price band** — limit prices outside the instrument's daily band are refused locally
  rather than bounced by the exchange.
- **Position check** — sells larger than your sellable quantity are refused.
- **Fractional check** — fractional quantities are refused for instruments that don't
  support them.

`cancel_order` exists so a mistake can be undone immediately. Note that BIST trades
10:00–18:00 Turkey time; orders placed outside the session queue for the next one, which
means they can be cancelled before they ever reach the exchange.

## Setup

Requires Node.js 20+.

```bash
git clone https://github.com/<you>/midas-mcp.git
cd midas-mcp
npm install
npx playwright install chromium
cp .env.example .env    # then fill in your credentials
npm run build
```

`.env`:

```ini
MIDAS_PHONE=5XXXXXXXXX      # Turkish mobile number, no country code
MIDAS_PASSWORD=your-password
MAX_ORDER_VALUE_TRY=5000    # refuse any order estimated above this, in TRY
HEADLESS=true
```

`.env` and the browser profile in `.midas-session/` are both gitignored — they hold your
credentials and session cookies, so keep them out of version control.

### First login

Midas requires approving a push notification in the Midas mobile app. The login
browser follows `HEADLESS` from `.env` (set `HEADLESS=false` to see it):

```bash
npm run login          # approve the prompt on your phone
```

The session is saved to `.midas-session/` and reused afterwards. The server renews the
access token with the profile's refresh cookie before it expires, including while idle.
Midas's refresh-token lifetime counts down from the original login (about 24 hours);
refreshing the access token does not extend it. Once the refresh token expires or is
revoked, the next tool call starts the normal login flow and requires approval in the
Midas mobile app. Only one process can use that profile at a time — stop the MCP
server before running `npm run login` manually.

### Dokploy / MetaMCP (Streamable HTTP)

Deploy this repository as a separate Dockerfile application in Dokploy. Attach a
persistent volume at `/data` before starting it; this keeps the authenticated browser
profile across container restarts. Set environment variables `MIDAS_PHONE`,
`MIDAS_PASSWORD`, `HEADLESS=true`, `MCP_HTTP_PORT=3000`,
`MIDAS_SESSION_DIR=/data/midas-session`, and a random `MCP_HTTP_TOKEN` of at least
32 characters. Never commit these credentials. Use one replica: Chromium cannot
share the same profile across processes. The first tool call starts headless login if
the saved session cannot be renewed; approve the notification in the Midas phone app.
If login fails, the tool returns an error; retry after correcting credentials.

Route a HTTPS domain to container port 3000, or use a private Docker network.
In MetaMCP choose **Streamable HTTP**, URL `https://YOUR_DOMAIN/mcp`, and header
`Authorization: Bearer <MCP_HTTP_TOKEN>` (use MetaMCP's secure header field).
Every request, including discovery, needs this header. Keep this endpoint private:
it exposes real-money trading tools. No separate `npm run login` or `npm run start`.

### Web dashboard

In HTTP mode, open `https://YOUR_DOMAIN/` to use the management dashboard. The
dashboard has its own username/password login. By default, it accepts `MIDAS_PHONE`
as the username and `MIDAS_PASSWORD` as the password; set `DASHBOARD_USERNAME` and
`DASHBOARD_PASSWORD` for a separate dashboard login. These values stay on the server.
Use HTTPS: the dashboard cookie is `Secure`, `HttpOnly`, and `SameSite=Strict` by
default. Set `DASHBOARD_COOKIE_SECURE=false` only when testing on plain local HTTP.

The page shows whether the Midas browser session is active, when its fixed 24-hour
refresh token expires, and your open holdings with quantity and market value. The
**Oturumu Yenile** button starts a fresh Midas login even if time remains. Approve
the resulting push notification in the Midas mobile app; the page follows the
progress automatically. No trading controls are exposed in this dashboard. The
existing `/mcp` endpoint continues to require `MCP_HTTP_TOKEN`.

Session progress and failures are written to standard error with `[midas-session]`
and `[midas-dashboard]` prefixes, so they appear in Dokploy's application logs (or
`docker logs`). Passwords, cookies, and token values are not logged.

Verify it works:

```bash
npm run smoke          # prints your portfolio, positions and a quote
```

### Register with Claude Code

```bash
claude mcp add midas -- node /absolute/path/to/midas-mcp/dist/index.js
```

Or, for any MCP client that reads a JSON config:

```json
{
  "mcpServers": {
    "midas": {
      "command": "node",
      "args": ["/absolute/path/to/midas-mcp/dist/index.js"]
    }
  }
}
```

## How it works

`src/session.ts` launches a persistent Chromium profile and handles login. Auth is
entirely cookie-based, so `src/api.ts` runs each GraphQL request via `page.evaluate`
inside the authenticated page rather than reimplementing the token flow.
Token renewal uses the same browser profile and Midas's web refresh endpoint; it
does not store token values separately or print them to logs. A rejected GraphQL
request gets one renewal and retry. Interrupted order mutations are not replayed
when their outcome is unknown.

Two details are easy to miss when working on this:

- The API gateway requires an `x-midas-rid` header. It is a stable per-profile request
  id generated by the web app, so the session observes it on the app's own requests
  instead of trying to recompute it.
- The gateway routes on `x-apollo-operation-name`, which must be the **root field name**,
  not the operation name. When a document's first selection is an alias (as in
  `OverviewAllPositions`), the real field name has to be passed explicitly.

Headless Chromium is rejected with a 403 unless it presents a normal user agent and
client hints; `session.ts` sets these.

`scripts/` holds the tooling used to map the API, kept for when Midas changes it:
`browser-daemon.ts` (logging browser with a CDP port), `analyze.ts` (summarise captured
GraphQL traffic), `dump-panel-bundles.ts` (download lazy-loaded chunks), and
`extract-ops.ts` / `extract-document.ts` (recover GraphQL documents from the minified
bundle's embedded AST — introspection is disabled server-side).

## Verifying trading end-to-end

`src/order-test.ts` places one real single-share order and cancels it immediately. It
also checks that the value cap rejects an oversized order. It refuses to run without an
explicit confirmation:

```bash
CONFIRM_REAL_ORDER=yes node dist/order-test.js CANTE 1.08 BUY
CONFIRM_REAL_ORDER=yes node dist/order-test.js TUCLK 4.04 SELL
```

Pick a limit price at the far end of the daily band so the order cannot fill, and run it
while the market is closed for extra margin.

## Disclaimer

Unofficial, not affiliated with or endorsed by Midas. It depends on undocumented
internal endpoints that can change without notice. You are responsible for every order
it places. Use at your own risk.

## License

MIT
