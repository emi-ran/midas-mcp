import assert from "node:assert/strict";
import { chromium } from "playwright";

process.env.MIDAS_PHONE ??= "5000000000";
process.env.MIDAS_PASSWORD ??= "test-only";

const { MidasSession } = await import("../dist/session.js");
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const tokenUrl = "https://api.atlas.getmidas.com/sso-bff/v1/oauth2/web/token";
let requests = 0;

try {
  await context.addCookies([{
    name: "refresh_token",
    value: "test-refresh-cookie",
    domain: "api.atlas.getmidas.com",
    path: "/sso-bff/v1/oauth2/web",
    expires: Math.floor(Date.now() / 1_000) + 3_600,
    secure: true,
    httpOnly: true,
    sameSite: "Strict",
  }]);
  await context.route(tokenUrl, async (route) => {
    requests++;
    const request = route.request();
    assert.equal(request.method(), "POST");
    assert.equal(request.postData(), "grant_type=refresh_token");
    assert.match(request.headers().cookie ?? "", /refresh_token=test-refresh-cookie/);
    assert.equal(request.headers().origin, "https://atlas.getmidas.com");
    await route.fulfill({
      status: 200,
      headers: {
        "content-type": "application/json",
        "access-control-allow-origin": "https://atlas.getmidas.com",
        "access-control-allow-credentials": "true",
        "set-cookie": "access_token=test-access-cookie; Path=/; Secure; HttpOnly; SameSite=Strict",
      },
      body: JSON.stringify({ success: true, accessTokenExpiresIn: 899, refreshTokenExpiresIn: 86_000 }),
    });
  });
  const session = new MidasSession();
  Object.assign(session, { context });
  await session.refreshFromAtlasOrigin();
  assert.equal(requests, 1);

  const page = await context.newPage();
  await page.route("https://atlas.getmidas.com/", (route) => route.fulfill({
    status: 200,
    contentType: "text/html",
    body: "<!doctype html><title>Atlas test page</title>",
  }));
  await page.goto("https://atlas.getmidas.com/");
  Object.assign(session, { page });
  await session.refreshAccessToken();
  assert.equal(requests, 2);
  assert.equal(session.getStatus().state, "active");
  assert.ok((await context.cookies(tokenUrl)).some((cookie) => cookie.name === "access_token"));
  await session.close();
  console.log("Browser refresh flow passed");
} finally {
  await browser.close();
}
