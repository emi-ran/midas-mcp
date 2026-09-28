import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

process.env.MIDAS_PHONE ??= "5000000000";
process.env.MIDAS_PASSWORD ??= "test-only";

const { handleDashboardRequest } = await import("../dist/dashboard.js");
const server = createServer(async (req, res) => {
  if (!(await handleDashboardRequest(req, res))) res.writeHead(404).end();
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const output = await mkdtemp(join(tmpdir(), "midas-dashboard-"));
const browser = await chromium.launch({ headless: true });

const positions = [
  { symbol: "ASELS", name: "Aselsan Elektronik Sanayi", market: "TR", currency: "TRY", quantity: 84, price: 143.6, marketValue: 12062.4 },
  { symbol: "THYAO", name: "Türk Hava Yolları", market: "TR", currency: "TRY", quantity: 32, price: 318.75, marketValue: 10200 },
  { symbol: "TUPRS", name: "Tüpraş", market: "TR", currency: "TRY", quantity: 18, price: 169.2, marketValue: 3045.6 },
  { symbol: "AAPL", name: "Apple Inc.", market: "US", currency: "USD", quantity: 3, price: 218.4, marketValue: 655.2 },
];

async function capture(name, viewport, loggedIn) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
  await page.route("**/api/dashboard/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (status, body) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path.endsWith("/me")) return json(loggedIn ? 200 : 401, loggedIn ? { csrf: "preview" } : { error: "Unauthorized" });
    if (path.endsWith("/state")) return json(200, {
      session: { state: "active", lastVerifiedAt: Date.now() - 90_000, refreshExpiresAt: Date.now() + 21 * 3_600_000 },
      job: null,
    });
    if (path.endsWith("/holdings")) return json(200, { updatedAt: Date.now(), positions });
    return json(404, {});
  });
  await page.goto(base, { waitUntil: "networkidle" });
  if (loggedIn) await page.getByText("Aselsan Elektronik Sanayi").waitFor();
  else await page.getByRole("heading", { name: "Hoş geldin." }).waitFor();
  const image = join(output, `${name}.png`);
  await page.screenshot({ path: image, fullPage: true });
  console.log(image);
  await page.close();
}

try {
  await capture("login-desktop", { width: 1440, height: 900 }, false);
  await capture("login-mobile", { width: 390, height: 844 }, false);
  await capture("dashboard-desktop", { width: 1440, height: 1000 }, true);
  await capture("dashboard-mobile", { width: 390, height: 844 }, true);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
