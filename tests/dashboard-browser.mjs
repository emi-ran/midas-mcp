import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chromium } from "playwright";

process.env.MIDAS_PHONE ??= "5000000000";
process.env.MIDAS_PASSWORD ??= "test-only";

const { handleDashboardRequest } = await import("../dist/dashboard.js");
const { config } = await import("../dist/config.js");
const { session } = await import("../dist/session.js");
const original = {
  ensureStarted: session.ensureStarted,
  forceRelogin: session.forceRelogin,
  cancelLogin: session.cancelLogin,
  getStatus: session.getStatus,
};
Object.assign(session, {
  ensureStarted: async () => {},
  getStatus: () => ({ state: "unknown", refreshExpiresAt: null, lastVerifiedAt: null }),
});

const server = createServer(async (req, res) => {
  if (!(await handleDashboardRequest(req, res))) res.writeHead(404).end();
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(base);
  assert.equal(await page.title(), "Giriş");
  assert.doesNotMatch(await page.locator("body").innerText(), /midas|portföy|hesap yönetimi|oturum|varlık/i);
  assert.equal(await page.locator("link[rel=icon]").getAttribute("href"), "/favicon.svg");
  if (process.env.DASHBOARD_SCREENSHOT_DIR) {
    await page.screenshot({ path: `${process.env.DASHBOARD_SCREENSHOT_DIR}/login-desktop.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `${process.env.DASHBOARD_SCREENSHOT_DIR}/login-mobile.png`, fullPage: true });
  }

  await page.locator("#username").fill(config.dashboardUsername);
  await page.locator("#password").fill(config.dashboardPassword);
  await page.locator("#login-submit").click();
  await page.locator(".session-card").waitFor();
  assert.equal(await page.title(), "Midas · Oturum");
  assert.match(await page.locator("body").innerText(), /Oturum ve varlıklar/);

  let release;
  let entered;
  const began = new Promise((resolve) => { entered = resolve; });
  session.forceRelogin = async () => {
    entered();
    await new Promise((resolve) => { release = resolve; });
    throw new Error("Login cancelled");
  };
  session.cancelLogin = async () => { release(); };
  await page.locator("#renew-button").click();
  await began;
  await page.locator("#cancel-login").waitFor({ state: "visible" });
  assert.equal(await page.locator("#renew-button").isDisabled(), true);
  await page.locator("#cancel-login").click();
  await page.getByText("Giriş tamamlanamadı: Giriş iptal edildi.", { exact: false }).waitFor();
  assert.equal(await page.locator("#renew-button").isEnabled(), true);
  let retries = 0;
  session.forceRelogin = async () => { retries++; };
  await page.locator("#renew-button").click();
  await page.waitForFunction(() => document.querySelector("#renew-label")?.textContent === "Oturumu Yenile");
  assert.equal(retries, 1);

  await page.locator("#logout-button").click();
  await page.locator("#login-form").waitFor();
  assert.equal(await page.title(), "Giriş");
  assert.doesNotMatch(await page.locator("body").innerText(), /midas|portföy|hesap yönetimi|oturum|varlık/i);
  console.log("Dashboard browser login/privacy flow passed");
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  Object.assign(session, original);
}
