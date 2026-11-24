import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("ws upgrade requires dashboard auth before proxying", () => {
  const src = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const idx = src.indexOf('server.on("upgrade"');
  assert.ok(idx >= 0);
  const window = src.slice(idx, idx + 1600);

  // Auth is decided before the gateway token is injected and the socket is proxied.
  const authAt = window.indexOf("dashboardAuthSatisfied");
  const proxyAt = window.indexOf("proxy.ws");
  assert.ok(authAt >= 0 && proxyAt > authAt);
  assert.match(window, /isHooksRequest/);

  // Issue #162: browsers cannot set Authorization on a WebSocket handshake.
  // Do not require Basic auth specifically; the dashboard session cookie is enough.
  assert.doesNotMatch(window, /WebSocket password protection/);
  assert.doesNotMatch(window, /scheme === "Basic"/);
});

test("wrapper enables hooks from OPENCLAW_HOOKS_TOKEN without logging the secret", () => {
  const src = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  assert.match(src, /OPENCLAW_HOOKS_TOKEN/);
  assert.match(src, /syncHooksFromEnv/);
  assert.match(src, /releaseGatewayStart/);
  assert.doesNotMatch(src, /console\.(log|warn|error)\([^)]*OPENCLAW_HOOKS_TOKEN/);
});
