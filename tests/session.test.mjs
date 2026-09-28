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
  let requestedOptions;
  Object.assign(s, {
    context: {
      cookies: async (url) => {
        assert.match(url, /\/sso-bff\/v1\/oauth2\/web\/token$/);
        return [{ name: "refresh_token" }];
      },
      request: {
        post: async (url, options) => {
          calls++;
          requestedUrl = url;
          requestedOptions = options;
          await new Promise((resolve) => setTimeout(resolve, 5));
          return {
            ok: () => true,
            json: async () => ({ success: true, accessTokenExpiresIn: 899 }),
          };
        },
      },
      close: async () => {},
    },
  });

  await Promise.all([s.refreshAccessToken(), s.refreshAccessToken()]);
  assert.equal(calls, 1);
  assert.equal(requestedUrl, "https://api.atlas.getmidas.com/sso-bff/v1/oauth2/web/token");
  assert.equal(requestedOptions.data, "grant_type=refresh_token");
  assert.equal(requestedOptions.headers["content-type"], "application/x-www-form-urlencoded");
  assert.ok(s.refreshAt > Date.now() + 13 * 60_000);
  await s.close();
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
      request: {
        post: async () => {
          refreshes++;
          return {
            ok: () => true,
            json: async () => ({ success: true, accessTokenExpiresIn: 899 }),
          };
        },
      },
      close: async () => {},
    },
    page: {
      isClosed: () => false,
      url: () => pageUrl,
      goto: async () => { pageUrl = "https://sso.getmidas.com/login"; },
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
  Object.assign(s, {
    context: {
      cookies: async () => [{ name: "refresh_token" }],
      clearCookies: async ({ name }) => { cleared.push(name); },
      request: {
        post: async () => ({
          ok: () => true,
          json: async () => ({ success: true, accessTokenExpiresIn: 899, refreshTokenExpiresIn: 86_400 }),
        }),
      },
      close: async () => {},
    },
    page: {
      isClosed: () => false,
      url: () => url,
      goto: async () => { url = "https://sso.getmidas.com/login"; },
    },
    login: async () => { logins++; url = "https://atlas.getmidas.com/"; },
    waitForRid: async () => {},
    readMemberUid: async () => {},
  });

  await s.forceRelogin();
  assert.deepEqual(cleared, ["access_token", "refresh_token"]);
  assert.equal(logins, 1);
  assert.equal(s.getStatus().state, "active");
  assert.ok(s.getStatus().refreshExpiresAt > Date.now() + 23 * 3_600_000);
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
