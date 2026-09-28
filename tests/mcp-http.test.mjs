import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const token = "local-test-bearer-token-32-characters-minimum";

async function freePort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

test("stateless HTTP MCP keeps working after the client's optional GET probe and tool errors", async () => {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(projectRoot, "dist", "index.js")], {
    cwd: projectRoot,
    env: {
      ...process.env,
      MIDAS_PHONE: "5000000000",
      MIDAS_PASSWORD: "test-only",
      MCP_HTTP_TOKEN: token,
      MCP_HTTP_PORT: String(port),
    },
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr = (stderr + chunk).slice(-4_000); });
  let client;

  try {
    const deadline = Date.now() + 10_000;
    while (true) {
      if (child.exitCode !== null) throw new Error(`MCP server exited early: ${stderr}`);
      try {
        const response = await fetch(base);
        if (response.ok) break;
      } catch { /* Wait for the server to start. */ }
      if (Date.now() >= deadline) throw new Error(`MCP server did not start: ${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const unauthorized = await fetch(`${base}/mcp`, { headers: { Accept: "text/event-stream" } });
    assert.equal(unauthorized.status, 401);
    const unsupported = await fetch(`${base}/mcp?probe=1`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" },
    });
    assert.equal(unsupported.status, 405);
    assert.equal(unsupported.headers.get("allow"), "POST");

    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    const transportErrors = [];
    transport.onerror = (error) => transportErrors.push(error);
    client = new Client({ name: "mcp-http-test", version: "1.0.0" });
    await client.connect(transport);
    // The client probes GET asynchronously after initialized; give it time to fail.
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.deepEqual(transportErrors, []);

    for (let attempt = 0; attempt < 3; attempt++) {
      const listed = await client.listTools();
      assert.ok(listed.tools.some((tool) => tool.name === "get_assets"));
      assert.ok(listed.tools.some((tool) => tool.name === "get_recent_orders"));
      // Missing required symbol is rejected before any live brokerage request.
      const invalid = await client.callTool({ name: "get_asset_price", arguments: {} });
      assert.equal(invalid.isError, true);
    }
    const concurrent = await Promise.all(Array.from({ length: 4 }, () => client.listTools()));
    assert.ok(concurrent.every((listed) => listed.tools.some((tool) => tool.name === "get_portfolio")));
    assert.deepEqual(transportErrors, []);
  } finally {
    await client?.close();
    if (child.exitCode === null) {
      child.kill();
      await Promise.race([once(child, "exit"), new Promise((resolve) => {
        const timer = setTimeout(resolve, 2_000);
        timer.unref();
      })]);
    }
  }
});
