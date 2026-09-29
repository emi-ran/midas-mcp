import { chromium, type BrowserContext, type Page } from "playwright";
import { config } from "./config.js";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
const TOKEN_URL = "https://api.atlas.getmidas.com/sso-bff/v1/oauth2/web/token";

class RefreshTokenExpiredError extends Error {}

/**
 * Owns the single authenticated Playwright session.
 *
 * Auth is entirely cookie-based, so GraphQL calls are issued from inside the page
 * context (see api.ts). The API additionally requires an `x-midas-rid` header — a
 * per-profile request id the web app generates — which we observe on the app's own
 * requests rather than trying to recompute.
 */
export class MidasSession {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private rid: string | null = null;
  private memberUid: string | null = null;
  private starting: Promise<void> | null = null;
  private refreshing: Promise<void> | null = null;
  private recovering: Promise<void> | null = null;
  private manualRelogin: Promise<void> | null = null;
  private cancelRequested = false;

  private checkCancelled(): void {
    if (this.cancelRequested) throw new Error("Login cancelled");
  }

  async cancelLogin(): Promise<void> {
    const pending = this.manualRelogin ?? this.starting;
    if (!pending) return;
    this.cancelRequested = true;
    try {
      await pending;
    } catch {
      // Cancelled work reports failure to its original caller.
    } finally {
      this.cancelRequested = false;
    }
  }
  private refreshTimer: NodeJS.Timeout | null = null;
  private refreshAt = 0;
  private refreshExpiresAt: number | null = null;
  private lastVerifiedAt: number | null = null;
  private readonly headless: boolean;

  constructor(options: { headless?: boolean } = {}) {
    this.headless = options.headless ?? config.headless;
  }

  async ensureStarted(): Promise<void> {
    if (this.starting) return this.starting;
    if (this.page && !this.page.isClosed()) return;
    this.starting = this.start().catch(async (error) => {
      await this.close();
      throw error;
    }).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async start(): Promise<void> {
    this.context = await chromium.launchPersistentContext(config.sessionDir, {
      headless: this.headless,
      viewport: { width: 1440, height: 900 },
      locale: "tr-TR",
      // Headless Chromium advertises "HeadlessChrome" and omits these hints, which the
      // API gateway rejects with a 403 before the request is ever routed.
      userAgent: USER_AGENT,
      extraHTTPHeaders: {
        "sec-ch-ua": '"Chromium";v="151", "Not=A?Brand";v="99"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
      },
      args: ["--disable-blink-features=AutomationControlled"],
    });
    console.error("[midas-session] browser profile opened");
    this.observeRid();
    this.page = this.context.pages()[0] ?? (await this.context.newPage());

    // Refresh before navigating: an expired access token may otherwise send the
    // browser to SSO even while its refresh cookie is still valid.
    if (await this.hasRefreshCookie()) {
      try {
        await this.refreshFromAtlasOrigin();
      } catch (error) {
        if (error instanceof RefreshTokenExpiredError) await this.clearAuthCookies();
        else console.error("[midas-session] startup refresh failed:", error);
      }
    } else {
      // An access cookie can outlive the fixed 24-hour refresh token briefly.
      await this.clearAuthCookies();
    }
    await this.page.goto(config.atlasUrl, { waitUntil: "domcontentloaded" });
    await this.page.waitForTimeout(3000);
    this.checkCancelled();

    const loginRequired = this.needsLogin();
    if (loginRequired) await this.login();
    this.checkCancelled();
    await this.waitForRid();
    this.checkCancelled();
    await this.readMemberUid();
    if ((loginRequired || !this.refreshAt) && !(await this.restoreTokenTimingFromCookies())) {
      await this.refreshAccessToken();
    }
    console.error("[midas-session] Atlas session ready");
  }

  private observeRid(): void {
    this.context!.on("request", (req) => {
      if (!req.url().includes("router-graphql")) return;
      void req.allHeaders().then((headers) => {
        if (headers["x-midas-rid"]) this.rid = headers["x-midas-rid"];
      }).catch(() => {});
    });
  }

  private async hasRefreshCookie(): Promise<boolean> {
    const cookies = await this.context!.cookies(TOKEN_URL);
    return cookies.some((cookie) => cookie.name === "refresh_token");
  }

  private async clearAuthCookies(): Promise<void> {
    await this.context!.clearCookies({ name: "access_token" });
    await this.context!.clearCookies({ name: "refresh_token" });
  }

  private cookieExpiryMs(cookie: { value: string; expires: number }): number | null {
    try {
      const payload = JSON.parse(Buffer.from(cookie.value.split(".")[1] ?? "", "base64url").toString("utf8"));
      if (Number.isFinite(payload.exp) && payload.exp > 0) return payload.exp * 1_000;
    } catch {
      // Non-JWT cookies can still carry an Expires attribute.
    }
    return cookie.expires > 0 ? cookie.expires * 1_000 : null;
  }

  /** A fresh login already issued both tokens; no immediate refresh call is needed. */
  private async restoreTokenTimingFromCookies(): Promise<boolean> {
    const access = (await this.context!.cookies(config.graphqlUrl)).find((cookie) => cookie.name === "access_token");
    const refresh = (await this.context!.cookies(TOKEN_URL)).find((cookie) => cookie.name === "refresh_token");
    const accessExpiresAt = access ? this.cookieExpiryMs(access) : null;
    const refreshExpiresAt = refresh ? this.cookieExpiryMs(refresh) : null;
    if (!accessExpiresAt || !refreshExpiresAt || accessExpiresAt <= Date.now() || refreshExpiresAt <= Date.now()) {
      return false;
    }
    this.refreshExpiresAt = refreshExpiresAt;
    this.lastVerifiedAt = Date.now();
    this.scheduleRefresh(Math.ceil((accessExpiresAt - Date.now()) / 1_000));
    console.error("[midas-session] token expiry loaded from browser cookies");
    return true;
  }

  /** Give Chromium an Atlas page origin before the real app is loaded. */
  private async refreshFromAtlasOrigin(): Promise<void> {
    const page = await this.context!.newPage();
    try {
      await page.route(config.atlasUrl, (route) => route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<!doctype html><title>Midas session renewal</title>",
      }));
      await page.goto(config.atlasUrl, { waitUntil: "domcontentloaded" });
      await this.refreshAccessToken(page);
    } finally {
      await page.close();
    }
  }

  private scheduleRefresh(expiresInSeconds: number): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    // Leave a minute for network delay and clock differences.
    const delay = Math.max(1_000, expiresInSeconds * 1_000 - 60_000);
    this.refreshAt = Date.now() + delay;
    this.refreshTimer = setTimeout(() => {
      void this.refreshAccessToken().catch((error) => {
        console.error("[midas-session] token refresh failed; the next request will retry:", error);
      });
    }, delay);
    this.refreshTimer.unref();
  }

  /** Browser fetch uses the real page network stack and shares its HttpOnly cookies. */
  async refreshAccessToken(refreshPage?: Page): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      if (!this.context || !(await this.hasRefreshCookie())) {
        throw new RefreshTokenExpiredError("No Midas refresh cookie is available; mobile login is required.");
      }
      const page = refreshPage ?? this.page;
      if (!page || new URL(page.url()).origin !== new URL(config.atlasUrl).origin) {
        throw new Error("Midas token refresh requires an Atlas browser page");
      }
      const response = await page.evaluate(async (url) => {
        const res = await fetch(url, {
          method: "POST",
          credentials: "include",
          headers: { accept: "*/*", "content-type": "application/x-www-form-urlencoded" },
          body: "grant_type=refresh_token",
        });
        return { status: res.status, result: res.ok ? await res.json() : null };
      }, TOKEN_URL);
      if (response.status < 200 || response.status >= 300) {
        if ([400, 401].includes(response.status)) {
          throw new RefreshTokenExpiredError(`Midas refresh token was rejected (HTTP ${response.status})`);
        }
        throw new Error(`Midas token refresh returned HTTP ${response.status}`);
      }
      const result = response.result as { success?: boolean; accessTokenExpiresIn?: number; refreshTokenExpiresIn?: number } | null;
      if (result?.success !== true || !Number.isFinite(result.accessTokenExpiresIn) ||
          result.accessTokenExpiresIn! <= 0) {
        throw new Error("Midas token refresh returned an invalid response");
      }
      this.scheduleRefresh(result.accessTokenExpiresIn!);
      this.lastVerifiedAt = Date.now();
      this.refreshExpiresAt = Number.isFinite(result.refreshTokenExpiresIn) && result.refreshTokenExpiresIn! > 0
        ? Date.now() + result.refreshTokenExpiresIn! * 1_000
        : null;
      const refreshLifetime = result.refreshTokenExpiresIn === undefined
        ? "unknown" : `${result.refreshTokenExpiresIn}s`;
      console.error(`[midas-session] access token renewed; access lifetime ${result.accessTokenExpiresIn}s, refresh lifetime ${refreshLifetime}`);
    })().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  /** Refreshes just before expiry, including after a failed background attempt. */
  async ensureFresh(): Promise<void> {
    await this.ensureStarted();
    if (this.manualRelogin) await this.manualRelogin;
    if (!this.refreshAt || Date.now() >= this.refreshAt) {
      try {
        await this.refreshAccessToken();
      } catch {
        await this.recoverAuth();
      }
    }
  }

  /** One recovery at a time when an authenticated GraphQL request is rejected. */
  async recoverAuth(): Promise<void> {
    if (this.manualRelogin) return this.manualRelogin;
    if (this.recovering) return this.recovering;
    this.recovering = (async () => {
      if (!this.page || this.page.isClosed()) {
        await this.close();
        await this.ensureStarted();
        return;
      }
      try {
        await this.refreshAccessToken();
        if (!this.isLoggedOut()) return;
        // The app may already have navigated to SSO before the cookie was renewed.
      } catch (error) {
        if (!(error instanceof RefreshTokenExpiredError)) throw error;
        // Remove only the auth cookies so Atlas redirects to SSO even if the
        // short-lived access cookie has not expired yet.
        await this.clearAuthCookies();
      }
      this.rid = null;
      this.memberUid = null;
      this.refreshAt = 0;
      if (this.refreshTimer) clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
      await this.page!.goto(config.atlasUrl, { waitUntil: "domcontentloaded" });
      if (this.needsLogin()) await this.login();
      this.checkCancelled();
      await this.waitForRid();
      this.checkCancelled();
      await this.readMemberUid();
      if (!(await this.restoreTokenTimingFromCookies())) await this.refreshAccessToken();
    })().finally(() => {
      this.recovering = null;
    });
    return this.recovering;
  }

  /** Starts a new 24-hour login period. Midas still requires mobile approval. */
  async forceRelogin(): Promise<void> {
    if (this.manualRelogin) return this.manualRelogin;
    if (this.recovering) await this.recovering;
    if (this.starting) return this.starting;
    if (!this.context || !this.page || this.page.isClosed()) return this.ensureStarted();
    this.manualRelogin = (async () => {
      if (this.refreshTimer) clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
      this.refreshAt = 0;
      this.refreshExpiresAt = null;
      this.lastVerifiedAt = null;
      this.rid = null;
      this.memberUid = null;
      await this.clearAuthCookies();
      await this.page!.goto(config.atlasUrl, { waitUntil: "domcontentloaded" });
      if (this.needsLogin()) await this.login();
      this.checkCancelled();
      await this.waitForRid();
      this.checkCancelled();
      await this.readMemberUid();
      if (!(await this.restoreTokenTimingFromCookies())) await this.refreshAccessToken();
    })().finally(() => {
      this.manualRelogin = null;
    });
    return this.manualRelogin;
  }

  getStatus() {
    const active = !!this.page && !this.page.isClosed() && !this.needsLogin();
    const accessRefreshOverdue = this.refreshAt > 0 && Date.now() >= this.refreshAt;
    return {
      state: this.starting || this.manualRelogin || this.recovering
        ? "connecting"
        : this.refreshExpiresAt !== null && this.refreshExpiresAt <= Date.now()
          ? "expired"
          : active && this.lastVerifiedAt !== null && !accessRefreshOverdue ? "active" : "unknown",
      refreshExpiresAt: this.refreshExpiresAt,
      lastVerifiedAt: this.lastVerifiedAt,
    } as const;
  }

  private needsLogin(): boolean {
    const url = this.page!.url();
    return url.includes("sso.getmidas.com") || url.includes("/login");
  }

  /**
   * True once the app has bounced the page back to the login screen, which is how an
   * expired session shows up mid-request.
   */
  isLoggedOut(): boolean {
    return !this.page || this.page.isClosed() || this.needsLogin();
  }

  /**
   * Fills the SSO form and then waits for the user to approve the push notification
   * in the Midas mobile app. There is no way to complete this without the phone.
   */
  private async login(): Promise<void> {
    const page = this.page!;
    await page.waitForSelector("#phone", { timeout: 30_000 });
    await page.fill("#phone", config.phone);
    await page.fill("#password", config.password);
    await page.click("button[type=submit]:not([disabled])");
    console.error("[midas-session] login submitted; waiting for mobile approval");

    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      this.checkCancelled();
      const url = page.url();
      if (url.startsWith(config.atlasUrl) && !url.includes("/auth/") && !url.includes("/login")) {
        console.error("[midas-session] mobile approval completed; Atlas opened");
        return;
      }
      await page.waitForTimeout(1000);
    }
    throw new Error(
      "Login timed out after 3 minutes — the push notification was not approved in the Midas app."
    );
  }

  /** Reload if needed until we observe the app sending an x-midas-rid header. */
  private async waitForRid(): Promise<void> {
    const page = this.page!;
    for (let attempt = 0; attempt < 3 && !this.rid; attempt++) {
      this.checkCancelled();
      if (attempt > 0) await page.reload({ waitUntil: "domcontentloaded" });
      for (let i = 0; i < 40 && !this.rid; i++) {
        this.checkCancelled();
        await page.waitForTimeout(250);
      }
    }
    if (!this.rid) {
      throw new Error("Could not observe the app's x-midas-rid header; the session may be invalid.");
    }
  }

  private async readMemberUid(): Promise<void> {
    this.memberUid = (await this.page!.evaluate(
      `localStorage.getItem("midas:member-uid")`
    )) as string | null;
    if (!this.memberUid) {
      throw new Error("Could not read midas:member-uid — not logged in?");
    }
  }

  async getPage(): Promise<Page> {
    await this.ensureStarted();
    if (this.manualRelogin) await this.manualRelogin;
    return this.page!;
  }

  async getRid(): Promise<string> {
    await this.ensureStarted();
    if (this.manualRelogin) await this.manualRelogin;
    return this.rid!;
  }

  async getMemberUid(): Promise<string> {
    await this.ensureStarted();
    if (this.manualRelogin) await this.manualRelogin;
    return this.memberUid!;
  }

  async close(): Promise<void> {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    this.refreshAt = 0;
    this.refreshExpiresAt = null;
    this.lastVerifiedAt = null;
    await this.context?.close();
    this.context = null;
    this.page = null;
    this.rid = null;
    this.memberUid = null;
  }
}

export const session = new MidasSession();
