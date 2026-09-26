#!/usr/bin/env node
/**
 * One-off login: opens a browser per HEADLESS, submits the SSO form and waits
 * for the push notification to be approved in the Midas mobile app. The resulting
 * session is stored in .midas-session/ and reused by the MCP server.
 */
import { MidasSession } from "./session.js";

const s = new MidasSession();
try {
  await s.ensureStarted();
  console.log("Logged in. Session saved to .midas-session/ — you can start the MCP server now.");
} finally {
  await s.close();
}
