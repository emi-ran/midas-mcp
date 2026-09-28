import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";

process.env.MIDAS_PHONE ??= "5000000000";
process.env.MIDAS_PASSWORD ??= "test-only";

const { handleDashboardRequest } = await import("../dist/dashboard.js");
const { config } = await import("../dist/config.js");
const { session } = await import("../dist/session.js");

test("dashboard login protects status and manual renewal", async () => {
  const original = {
    ensureStarted: session.ensureStarted,
    forceRelogin: session.forceRelogin,
    getStatus: session.getStatus,
  };
  let renews = 0;
  Object.assign(session, {
    ensureStarted: async () => {},
    forceRelogin: async () => { renews++; },
    getStatus: () => ({ state: "active", refreshExpiresAt: Date.now() + 86_000_000, lastVerifiedAt: Date.now() }),
  });
  const server = createServer(async (req, res) => {
    if (!(await handleDashboardRequest(req, res))) res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  const post = (path, cookie, csrf, body) => fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      Origin: base,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(csrf ? { "X-CSRF-Token": csrf } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  try {
    const page = await fetch(base);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Oturum ve varlıklar/);

    assert.equal((await fetch(`${base}/api/dashboard/state`)).status, 401);
    assert.equal((await post("/api/dashboard/login", null, null,
      { username: config.dashboardUsername, password: "wrong" })).status, 401);

    const loggedIn = await post("/api/dashboard/login", null, null,
      { username: config.dashboardUsername, password: config.dashboardPassword });
    assert.equal(loggedIn.status, 200);
    const cookie = loggedIn.headers.get("set-cookie").split(";")[0];
    assert.match(loggedIn.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
    const { csrf } = await loggedIn.json();

    const state = await fetch(`${base}/api/dashboard/state`, { headers: { Cookie: cookie } });
    assert.equal(state.status, 200);
    assert.equal((await state.json()).session.state, "active");
    assert.equal((await fetch(`${base}/api/dashboard/holdings`)).status, 401);
    assert.equal((await post("/api/dashboard/renew", cookie)).status, 403);
    assert.equal((await post("/api/dashboard/renew", cookie, csrf)).status, 202);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(renews, 1);

    assert.equal((await post("/api/dashboard/logout", cookie, csrf)).status, 200);
    assert.equal((await fetch(`${base}/api/dashboard/state`, { headers: { Cookie: cookie } })).status, 401);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    Object.assign(session, original);
  }
});
