import assert from "node:assert/strict";
import { test } from "node:test";

process.env.MIDAS_PHONE ??= "5000000000";
process.env.MIDAS_PASSWORD ??= "test-only";

const { MidasSession, session } = await import("../dist/session.js");
const { gql, MidasApiError } = await import("../dist/api.js");

test("refresh uses the profile cookie and schedules the next renewal", async () => {
  const s = new MidasSession();
  let calls = 0;
  let requestedUrl;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls++;
    requestedUrl = url;
    assert.equal(options.credentials, "include");
    assert.equal(options.body, "grant_type=refresh_token");
    assert.equal(options.headers["content-type"], "application/x-www-form-urlencoded");
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { status: 200, ok: true, json: async () => ({ success: true, accessTokenExpiresIn: 899 }) };
  };
  Object.assign(s, {
    context: {
      cookies: async (url) => {
        assert.match(url, /\/sso-bff\/v1\/oauth2\/web\/token$/);
        return [{ name: "refresh_token" }];
      },
      close: async () => {},
    },
    page: {
      url: () => "https://atlas.getmidas.com/",
      evaluate: async (fn, url) => fn(url),
    },
  });

  try {
    await Promise.all([s.refreshAccessToken(), s.refreshAccessToken()]);
    assert.equal(calls, 1);
    assert.equal(requestedUrl, "https://api.atlas.getmidas.com/sso-bff/v1/oauth2/web/token");
    assert.ok(s.refreshAt > Date.now() + 13 * 60_000);
  } finally {
    globalThis.fetch = originalFetch;
    await s.close();
  }
});

test("an expired refresh cookie clears auth cookies before mobile login", async () => {
  const s = new MidasSession();
  const cleared = [];
  let hasRefreshCookie = false;
  let pageUrl = "https://atlas.getmidas.com/";
  let refreshes = 0;
  Object.assign(s, {
    context: {
      cookies: async () => hasRefreshCookie ? [{ name: "refresh_token" }] : [],
      clearCookies: async ({ name }) => { cleared.push(name); },
      close: async () => {},
    },
    page: {
      isClosed: () => false,
      url: () => pageUrl,
      goto: async () => { pageUrl = "https://sso.getmidas.com/login"; },
      evaluate: async () => {
        refreshes++;
        return { status: 200, result: { success: true, accessTokenExpiresIn: 899 } };
      },
    },
    login: async () => {
      hasRefreshCookie = true;
      pageUrl = "https://atlas.getmidas.com/";
    },
    waitForRid: async () => {},
    readMemberUid: async () => {},
  });

  await s.recoverAuth();
  assert.deepEqual(cleared, ["access_token", "refresh_token"]);
  assert.equal(refreshes, 1);
  await s.close();
});

test("manual renewal starts a fresh login and records the new 24-hour expiry", async () => {
  const s = new MidasSession();
  const cleared = [];
  let url = "https://atlas.getmidas.com/";
  let logins = 0;
  let redundantRefreshes = 0;
  const expiresAt = Math.floor(Date.now() / 1_000);
  const cookie = (name, seconds) => ({
    name,
    value: `header.${Buffer.from(JSON.stringify({ exp: expiresAt + seconds })).toString("base64url")}.signature`,
    expires: expiresAt + seconds,
  });
  Object.assign(s, {
    context: {
      cookies: async (requestedUrl) => requestedUrl.includes("router-graphql")
        ? [cookie("access_token", 899)] : [cookie("refresh_token", 86_400)],
      clearCookies: async ({ name }) => { cleared.push(name); },
      close: async () => {},
    },
    page: {
      isClosed: () => false,
      url: () => url,
      goto: async () => { url = "https://sso.getmidas.com/login"; },
      evaluate: async () => { redundantRefreshes++; throw new Error("unexpected refresh"); },
    },
    login: async () => { logins++; url = "https://atlas.getmidas.com/"; },
    waitForRid: async () => {},
    readMemberUid: async () => {},
  });

  await s.forceRelogin();
  assert.deepEqual(cleared, ["access_token", "refresh_token"]);
  assert.equal(logins, 1);
  assert.equal(redundantRefreshes, 0);
  assert.equal(s.getStatus().state, "active");
  assert.ok(s.getStatus().refreshExpiresAt > Date.now() + 23 * 3_600_000);
  await s.close();
});

test("RID from context-level app requests is captured before page navigation", async () => {
  const s = new MidasSession();
  let requestListener;
  const context = { on: (event, listener) => {
    if (event === "request") requestListener = listener;
  } };
  Object.assign(s, { context });
  s.observeRid();
  assert.equal(typeof requestListener, "function");
  await requestListener({
    url: () => "https://api.atlas.getmidas.com/router-graphql",
    allHeaders: async () => ({ "x-midas-rid": "observed-rid" }),
  });
  assert.equal(s.rid, "observed-rid");
});

test("a pending manual login can be cancelled and retried", async () => {
  const s = new MidasSession();
  let attempts = 0;
  let release;
  let started;
  const entered = new Promise((resolve) => { started = resolve; });
  Object.assign(s, {
    context: { clearCookies: async () => {}, close: async () => {} },
    page: {
      isClosed: () => false,
      url: () => "https://sso.getmidas.com/login",
      goto: async () => {},
    },
    login: async () => {
      attempts++;
      started();
      if (attempts === 1) await new Promise((resolve) => { release = resolve; });
    },
    waitForRid: async () => {},
    readMemberUid: async () => {},
    restoreTokenTimingFromCookies: async () => true,
  });
  const first = s.forceRelogin();
  await entered;
  const cancelling = s.cancelLogin();
  release();
  await cancelling;
  await assert.rejects(first, /cancel/i);
  await s.forceRelogin();
  assert.equal(attempts, 2);
  await s.close();
});

test("a confirmed auth rejection is retried once after renewal", async () => {
  const original = {
    ensureFresh: session.ensureFresh,
    getPage: session.getPage,
    getRid: session.getRid,
    recoverAuth: session.recoverAuth,
  };
  let requests = 0;
  let recoveries = 0;
  Object.assign(session, {
    ensureFresh: async () => {},
    getRid: async () => "test-rid",
    getPage: async () => ({
      evaluate: async () => {
        requests++;
        return requests === 1
          ? { status: 401, text: "" }
          : { status: 200, text: JSON.stringify({ data: { ok: true } }) };
      },
    }),
    recoverAuth: async () => { recoveries++; },
  });
  try {
    assert.deepEqual(await gql("Check", "query Check { check }"), { ok: true });
    assert.equal(requests, 2);
    assert.equal(recoveries, 1);
  } finally {
    Object.assign(session, original);
  }
});

test("an interrupted order mutation is not replayed", async () => {
  const original = {
    ensureFresh: session.ensureFresh,
    getPage: session.getPage,
    getRid: session.getRid,
    recoverAuth: session.recoverAuth,
    isLoggedOut: session.isLoggedOut,
  };
  let requests = 0;
  Object.assign(session, {
    ensureFresh: async () => {},
    getRid: async () => "test-rid",
    getPage: async () => ({
      evaluate: async () => {
        requests++;
        throw new Error("page navigated");
      },
    }),
    recoverAuth: async () => {},
    isLoggedOut: () => true,
  });
  try {
    await assert.rejects(
      gql("PlaceOrder", "mutation PlaceOrder { placeOrderV2 { order { uid } } }"),
      (error) => error instanceof MidasApiError && /checking its status/.test(error.message),
    );
    assert.equal(requests, 1);
  } finally {
    Object.assign(session, original);
  }
});
