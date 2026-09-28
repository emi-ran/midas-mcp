#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { config } from "./config.js";
import { session } from "./session.js";
import * as midas from "./midas.js";
import { getTechnicals, getCandles } from "./technicals.js";
import { handleDashboardRequest } from "./dashboard.js";

function makeServer() {
const server = new McpServer({ name: "midas-mcp", version: "0.1.0" });

/** Tools return JSON text so the model gets structured, unambiguous data. */
function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
}

function tool<S extends z.ZodRawShape>(
  name: string,
  description: string,
  inputSchema: S,
  handler: (args: z.objectOutputType<S, z.ZodTypeAny>) => Promise<unknown>,
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean }
) {
  server.registerTool(name, { description, inputSchema, annotations }, (async (args: any) => {
    try {
      return json(await handler(args));
    } catch (error) {
      return failure(error);
    }
  }) as any);
}

const READ_ONLY = { readOnlyHint: true, openWorldHint: true };
const TRADING = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };

tool(
  "get_portfolio",
  "Get overall portfolio value in TRY, today's profit/loss, and cash balances and buying power for the Turkish (BIST/TRY) and US (USD) accounts.",
  {},
  () => midas.getPortfolio(),
  READ_ONLY
);

tool(
  "get_assets",
  "List all open positions (BIST stocks, US stocks, Turkish funds, US options) with quantity, average cost, current price, market value and profit/loss.",
  {},
  () => midas.getPositions(),
  READ_ONLY
);

tool(
  "get_asset_price",
  "Get the current trade price for a symbol, with previous close, percent change and whether the market session is open.",
  {
    symbol: z.string().describe("Ticker, e.g. TUCLK, THYAO, AAPL"),
    currency: z
      .enum(["TRY", "USD"])
      .optional()
      .describe("Convert the price to this currency instead of the instrument's native one"),
  },
  ({ symbol, currency }) => midas.getAssetPrice(symbol, currency),
  READ_ONLY
);

tool(
  "get_asset_info",
  "Get descriptive information about an instrument (full name, market, description) together with its current price.",
  { symbol: z.string().describe("Ticker or company name to look up") },
  ({ symbol }) => midas.getAssetInfo(symbol),
  READ_ONLY
);

tool(
  "get_asset_details",
  "Get Midas instrument overview stats and digest, analyst ratings, bull/bear views, Midas user trading trends, dividends and margin info. Stats are display-formatted strings; digest is Midas commentary, not independently verified fundamentals.",
  { symbol: z.string().describe("Ticker, e.g. ASELS") },
  ({ symbol }) => midas.getAssetDetails(symbol),
  READ_ONLY
);

tool(
  "get_asset_news",
  "Get latest Midas BIST news; optionally filter by stock. Returns title, provider, publication time and article URL. Defaults to 15 latest items.",
  {
    symbol: z.string().optional().describe("Optional ticker, e.g. ASELS; omit for all BIST news"),
    limit: z.number().int().min(1).max(100).optional().describe("Number of latest articles (default 15, max 100)"),
  },
  ({ symbol, limit }) => midas.getAssetNews(symbol, limit),
  READ_ONLY
);

tool(
  "buy_asset",
  `Place a BUY order. Orders whose estimated value exceeds ₺${config.maxOrderValueTry} are refused. ` +
    "Omit limit_price for a market order. Note that orders placed outside market hours queue for the next session " +
    "(BIST trades 10:00-18:00 Turkey time).",
  {
    symbol: z.string().describe("Ticker to buy, e.g. TUCLK"),
    quantity: z.number().positive().describe("Number of shares"),
    limit_price: z
      .number()
      .positive()
      .optional()
      .describe("Limit price; omit for a market order. Must sit inside the daily price band."),
  },
  ({ symbol, quantity, limit_price }) =>
    midas.placeOrder({ symbol, side: "BUY", quantity, limitPrice: limit_price }),
  TRADING
);

tool(
  "sell_asset",
  `Place a SELL order. Orders whose estimated value exceeds ₺${config.maxOrderValueTry} are refused. ` +
    "Omit limit_price for a market order. Note that orders placed outside market hours queue for the next session.",
  {
    symbol: z.string().describe("Ticker to sell, e.g. TUCLK"),
    quantity: z.number().positive().describe("Number of shares"),
    limit_price: z
      .number()
      .positive()
      .optional()
      .describe("Limit price; omit for a market order. Must sit inside the daily price band."),
  },
  ({ symbol, quantity, limit_price }) =>
    midas.placeOrder({ symbol, side: "SELL", quantity, limitPrice: limit_price }),
  TRADING
);

tool(
  "get_technicals",
  "Compute a full technical-analysis snapshot for a symbol from its daily price history: " +
    "RSI(14), SMA/EMA (20/50/200), MACD, Bollinger Bands, ATR and annualized volatility, " +
    "52-week range, swing-pivot support/resistance levels, and volume-vs-average. " +
    "Feed this into the scan scoring formula in CLAUDE.md.",
  {
    symbol: z.string().describe("Ticker to analyze, e.g. TUCLK, ASELS, THYAO"),
    interval: z
      .enum(["1d", "1w"])
      .optional()
      .describe("Candle interval; defaults to daily (1d)"),
  },
  ({ symbol, interval }) => getTechnicals(symbol, interval ?? "1d"),
  READ_ONLY
);

tool(
  "get_chart",
  "Get raw OHLCV candles for a symbol (open, high, low, close, volume, timestamp). " +
    "Use get_technicals for computed indicators; use this only when you need the raw series.",
  {
    symbol: z.string().describe("Ticker to fetch candles for"),
    interval: z
      .enum(["1m", "5m", "15m", "30m", "1h", "4h", "1d", "1w"])
      .optional()
      .describe("Candle interval; defaults to daily (1d)"),
    limit: z.number().int().positive().max(500).optional().describe("Number of candles (max 500)"),
  },
  async ({ symbol, interval, limit }) => {
    const asset = await midas.resolveSymbol(symbol);
    const candles = await getCandles(asset.uid, interval ?? "1d", limit ?? 200);
    return { symbol: asset.symbol, interval: interval ?? "1d", count: candles.length, candles };
  },
  READ_ONLY
);

tool(
  "get_pending_orders",
  "List orders for a symbol that are still waiting to execute, including their order ids for cancellation.",
  { symbol: z.string().describe("Ticker whose pending orders to list") },
  ({ symbol }) => midas.getPendingOrders(symbol),
  READ_ONLY
);

tool(
  "get_recent_orders",
  "List recent pending and historical orders across the account, including final cancellation or fill status. Read-only.",
  { limit: z.number().int().min(1).max(200).optional().describe("Page size (default 20, max 200)") },
  ({ limit }) => midas.getRecentOrders(limit),
  READ_ONLY
);

tool(
  "cancel_order",
  "Cancel a pending order by its order id. Use get_pending_orders to find the id.",
  {
    order_id: z.string().describe("Order uid returned by buy_asset/sell_asset or get_pending_orders"),
    symbol: z.string().describe("Ticker the order belongs to"),
  },
  ({ order_id, symbol }) => midas.cancelOrder(order_id, symbol),
  { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
);
return server;
}

const server = config.httpPort ? null : makeServer();

const shutdown = async () => {
  await session.close().catch(() => {});
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

if (config.httpPort) {
  const token = Buffer.from(config.httpToken!);
  const http = createServer(async (req, res) => {
    if ((req.url ?? "/").split("?", 1)[0] !== "/mcp") {
      try {
        if (await handleDashboardRequest(req, res)) return;
      } catch (error) {
        console.error("Dashboard request failed", error);
        if (!res.headersSent) res.writeHead(500).end();
        return;
      }
      res.writeHead(404).end();
      return;
    }
    const supplied = req.headers.authorization;
    const bearer = supplied?.startsWith("Bearer ") ? Buffer.from(supplied.slice(7)) : Buffer.alloc(0);
    if (bearer.length !== token.length || !timingSafeEqual(bearer, token)) {
      res.writeHead(401, { "content-type": "application/json" }).end('{"error":"Unauthorized"}');
      return;
    }
    if (req.method !== "POST") {
      // A stateless MCP server has no standalone GET SSE stream. Streamable HTTP
      // clients probe it after initialization and expect 405 (not 404) here.
      res.writeHead(405, { Allow: "POST" }).end();
      return;
    }
    const instance = makeServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    transport.onerror = (error) => {
      console.error("[midas-mcp] transport error:", error instanceof Error ? error.message : String(error));
    };
    try {
      await instance.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error("MCP HTTP request failed", error);
      if (!res.headersSent) res.writeHead(500).end();
    } finally {
      await instance.close();
    }
  });
  http.listen(config.httpPort, "0.0.0.0");
} else {
  await server!.connect(new StdioServerTransport());
}
