import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as path from "node:path";
import { config, PROJECT_ROOT } from "./config.js";
import { session } from "./session.js";
import { getPositions } from "./midas.js";

const COOKIE_NAME = "midas_dashboard";
const DASHBOARD_LIFETIME_MS = 12 * 60 * 60 * 1_000;
const LOGIN_WINDOW_MS = 15 * 60 * 1_000;
const MAX_LOGIN_ATTEMPTS = 5;

type DashboardLogin = { csrf: string; expiresAt: number };
type SessionJob = {
  kind: "connect" | "renew";
  state: "running" | "done" | "failed";
  startedAt: number;
  finishedAt?: number;
  error?: string;
};

const logins = new Map<string, DashboardLogin>();
const attempts = new Map<string, { count: number; until: number }>();
let job: SessionJob | null = null;
let cancellingJob: Promise<void> | null = null;

function sameSecret(actual: string, expected: string): boolean {
  const a = createHash("sha256").update(actual).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function securityHeaders(res: ServerResponse): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy",
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; " +
    "connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
}

function json(res: ServerResponse, status: number, value: unknown): void {
  securityHeaders(res);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

function cookieValue(req: IncomingMessage): string | null {
  const entry = (req.headers.cookie ?? "").split(";").map((v) => v.trim())
    .find((v) => v.startsWith(`${COOKIE_NAME}=`));
  return entry?.slice(COOKIE_NAME.length + 1) ?? null;
}

function currentLogin(req: IncomingMessage): DashboardLogin | null {
  const token = cookieValue(req);
  if (!token) return null;
  const login = logins.get(token);
  if (!login) return null;
  if (login.expiresAt <= Date.now()) {
    logins.delete(token);
    return null;
  }
  return login;
}

function setLoginCookie(res: ServerResponse, token: string, maxAge: number): void {
  const parts = [
    `${COOKIE_NAME}=${token}`,
    "Path=/",
    `Max-Age=${maxAge}`,
    "HttpOnly",
    "SameSite=Strict",
  ];
  if (config.dashboardCookieSecure) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (typeof origin !== "string" || !req.headers.host) return false;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  if (!req.headers["content-type"]?.startsWith("application/json")) {
    throw new Error("JSON content type required");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4_096) throw new Error("Request body too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function startJob(kind: SessionJob["kind"]): SessionJob {
  if (job?.state === "running") return job;
  const next: SessionJob = { kind, state: "running", startedAt: Date.now() };
  job = next;
  console.error(`[midas-dashboard] ${kind} started`);
  void Promise.resolve()
    .then(() => kind === "renew" ? session.forceRelogin() : session.ensureStarted())
    .then(() => {
      if (next.state !== "running") return;
      next.state = "done";
      next.finishedAt = Date.now();
      console.error(`[midas-dashboard] ${kind} completed`);
    })
    .catch((error: unknown) => {
      if (next.state !== "running") return;
      next.state = "failed";
      next.finishedAt = Date.now();
      next.error = error instanceof Error ? error.message : String(error);
      console.error(`[midas-dashboard] ${kind} failed: ${next.error}`);
    });
  return next;
}

async function staticFile(res: ServerResponse, file: string, contentType: string): Promise<void> {
  const data = await readFile(path.join(PROJECT_ROOT, "public", file));
  securityHeaders(res);
  res.writeHead(200, { "Content-Type": contentType });
  res.end(data);
}

/** Returns true for dashboard routes; /mcp remains handled by the MCP transport. */
export async function handleDashboardRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  if (req.method === "GET" && pathname === "/") {
    await staticFile(res, currentLogin(req) ? "dashboard.html" : "index.html", "text/html; charset=utf-8");
    return true;
  }
  if (req.method === "GET" && pathname === "/favicon.svg") {
    await staticFile(res, "favicon.svg", "image/svg+xml");
    return true;
  }
  if (req.method === "GET" && pathname === "/login.css") {
    await staticFile(res, "login.css", "text/css; charset=utf-8");
    return true;
  }
  if (req.method === "GET" && pathname === "/login.js") {
    await staticFile(res, "login.js", "text/javascript; charset=utf-8");
    return true;
  }
  if (req.method === "GET" && (pathname === "/app.css" || pathname === "/app.js")) {
    if (!currentLogin(req)) {
      securityHeaders(res);
      res.writeHead(404).end();
      return true;
    }
    await staticFile(res, pathname.slice(1), pathname.endsWith(".css")
      ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8");
    return true;
  }
  if (!pathname.startsWith("/api/dashboard/")) return false;

  if (req.method === "POST" && !sameOrigin(req)) {
    json(res, 403, { error: "Origin doğrulanamadı." });
    return true;
  }

  if (req.method === "POST" && pathname === "/api/dashboard/login") {
    const ip = req.socket.remoteAddress ?? "unknown";
    const previous = attempts.get(ip);
    if (previous && previous.until > Date.now() && previous.count >= MAX_LOGIN_ATTEMPTS) {
      json(res, 429, { error: "Çok fazla deneme. Biraz sonra tekrar deneyin." });
      return true;
    }
    let input: unknown;
    try {
      input = await readJson(req);
    } catch {
      json(res, 400, { error: "Geçersiz giriş isteği." });
      return true;
    }
    const username = typeof input === "object" && input !== null && "username" in input
      ? String(input.username) : "";
    const password = typeof input === "object" && input !== null && "password" in input
      ? String(input.password) : "";
    const usernameMatches = sameSecret(username, config.dashboardUsername);
    const passwordMatches = sameSecret(password, config.dashboardPassword);
    if (!(usernameMatches && passwordMatches)) {
      const count = previous && previous.until > Date.now() ? previous.count + 1 : 1;
      attempts.set(ip, { count, until: Date.now() + LOGIN_WINDOW_MS });
      json(res, 401, { error: "Kullanıcı adı veya şifre hatalı." });
      return true;
    }
    attempts.delete(ip);
    const token = randomBytes(32).toString("hex");
    const login = { csrf: randomBytes(32).toString("hex"), expiresAt: Date.now() + DASHBOARD_LIFETIME_MS };
    logins.set(token, login);
    setLoginCookie(res, token, Math.floor(DASHBOARD_LIFETIME_MS / 1_000));
    startJob("connect");
    json(res, 200, { csrf: login.csrf, expiresAt: login.expiresAt });
    return true;
  }

  const login = currentLogin(req);
  if (!login) {
    json(res, 401, { error: "Oturum açmanız gerekiyor." });
    return true;
  }

  if (req.method === "GET" && pathname === "/api/dashboard/me") {
    json(res, 200, { csrf: login.csrf, expiresAt: login.expiresAt });
    return true;
  }
  if (req.method === "GET" && pathname === "/api/dashboard/state") {
    json(res, 200, { session: session.getStatus(), job });
    return true;
  }
  if (req.method === "GET" && pathname === "/api/dashboard/holdings") {
    if (job?.state === "running" || session.getStatus().state !== "active") {
      json(res, 409, { error: "Midas oturumu henüz hazır değil." });
      return true;
    }
    try {
      const positions = await getPositions();
      json(res, 200, {
        updatedAt: Date.now(),
        positions: positions.map(({ symbol, name, quantity, price, marketValue, currency, market }) =>
          ({ symbol, name, quantity, price, marketValue, currency, market })),
      });
    } catch (error) {
      console.error("[midas-dashboard] holdings failed:", error instanceof Error ? error.message : String(error));
      json(res, 502, { error: error instanceof Error ? error.message : "Varlıklar alınamadı." });
    }
    return true;
  }

  if (req.method === "POST") {
    if (req.headers["x-csrf-token"] !== login.csrf) {
      json(res, 403, { error: "Güvenlik doğrulaması başarısız." });
      return true;
    }
    if (pathname === "/api/dashboard/renew") {
      if (cancellingJob) {
        json(res, 409, { error: "Önceki giriş iptal ediliyor." });
        return true;
      }
      json(res, 202, { job: startJob("renew") });
      return true;
    }
    if (pathname === "/api/dashboard/cancel") {
      if (job?.state !== "running") {
        json(res, 409, { error: "İptal edilecek giriş yok." });
        return true;
      }
      const current = job;
      cancellingJob ??= session.cancelLogin().then(() => {
        current.state = "failed";
        current.error = "Giriş iptal edildi. Tekrar deneyebilirsiniz.";
        current.finishedAt = Date.now();
      }).finally(() => { cancellingJob = null; });
      await cancellingJob;
      json(res, 200, { job: current });
      return true;
    }
    if (pathname === "/api/dashboard/logout") {
      const token = cookieValue(req);
      if (token) logins.delete(token);
      setLoginCookie(res, "", 0);
      json(res, 200, { ok: true });
      return true;
    }
  }

  json(res, 404, { error: "Bulunamadı." });
  return true;
}
