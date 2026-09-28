import * as dotenv from "dotenv";
import * as path from "node:path";
import * as url from "node:url";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(HERE, "..");

dotenv.config({ path: path.join(PROJECT_ROOT, ".env") });

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} in .env (copy .env.example and fill it in)`);
  return v;
}

export const config = {
  phone: required("MIDAS_PHONE"),
  password: required("MIDAS_PASSWORD"),
  /** Orders whose estimated value in TRY exceeds this are refused before submission. */
  maxOrderValueTry: Number(process.env.MAX_ORDER_VALUE_TRY ?? 5000),
  headless: (process.env.HEADLESS ?? "true").toLowerCase() !== "false",
  sessionDir: process.env.MIDAS_SESSION_DIR ?? path.join(PROJECT_ROOT, ".midas-session"),
  httpPort: process.env.MCP_HTTP_PORT ? Number(process.env.MCP_HTTP_PORT) : null,
  httpToken: process.env.MCP_HTTP_TOKEN,
  dashboardUsername: process.env.DASHBOARD_USERNAME ?? process.env.MIDAS_PHONE!,
  dashboardPassword: process.env.DASHBOARD_PASSWORD ?? process.env.MIDAS_PASSWORD!,
  dashboardCookieSecure: (process.env.DASHBOARD_COOKIE_SECURE ?? "true").toLowerCase() !== "false",
  atlasUrl: "https://atlas.getmidas.com/",
  graphqlUrl: "https://api.atlas.getmidas.com/router-graphql",
  /** Sent as x-client-version; only needs to look like a real web build. */
  clientVersion: process.env.MIDAS_CLIENT_VERSION ?? "v1.133.0",
};

if (!Number.isFinite(config.maxOrderValueTry) || config.maxOrderValueTry <= 0) {
  throw new Error("MAX_ORDER_VALUE_TRY must be a positive number");
}
if (config.httpPort !== null && (!Number.isInteger(config.httpPort) || config.httpPort < 1 || config.httpPort > 65535 || !config.httpToken || config.httpToken.length < 32)) {
  throw new Error("MCP_HTTP_PORT requires valid port and MCP_HTTP_TOKEN of at least 32 characters");
}
