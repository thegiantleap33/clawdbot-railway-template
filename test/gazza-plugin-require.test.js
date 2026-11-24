import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const pluginPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/plugins/gazza-callback/index.js",
);

test("require() loads the gazza-callback plugin without ERR_REQUIRE_ASYNC_MODULE", async () => {
  const loaded = require(pluginPath);
  const plugin = loaded && loaded.register ? loaded : loaded.default;
  assert.equal(plugin.id, "gazza-callback");
  assert.equal(typeof plugin.register, "function");

  const hooks = {};
  plugin.register({
    on(name, handler) {
      hooks[name] = handler;
    },
  });
  assert.equal(typeof hooks.agent_end, "function");

  const calls = [];
  const previousFetch = globalThis.fetch;
  const previousPrefix = process.env.OPENCLAW_HOOKS_SESSION_PREFIX;
  const previousUrl = process.env.OPENCLAW_GAZZA_BRIDGE_URL;
  const previousToken = process.env.OPENCLAW_GAZZA_BRIDGE_TOKEN;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true };
  };
  process.env.OPENCLAW_HOOKS_SESSION_PREFIX = "hook:gazza:";
  process.env.OPENCLAW_GAZZA_BRIDGE_URL = "http://127.0.0.1:9/callback";
  process.env.OPENCLAW_GAZZA_BRIDGE_TOKEN = "bridge-secret";
  try {
    const ignored = hooks.agent_end(
      { success: true, messages: [{ role: "assistant", content: "ordinary" }] },
      { sessionKey: "agent:main:main" },
    );
    const forwarded = hooks.agent_end(
      { success: true, messages: [{ role: "assistant", content: "The final Gazza reply" }] },
      { sessionKey: "agent:main:hook:gazza:main", agentId: "main" },
    );
    assert.equal(ignored, undefined);
    assert.equal(forwarded, undefined);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 1);
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.reply, "The final Gazza reply");
    assert.equal(body.sessionKey, "agent:main:hook:gazza:main");
    assert.equal(calls[0].init.headers.authorization, "Bearer bridge-secret");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousPrefix === undefined) delete process.env.OPENCLAW_HOOKS_SESSION_PREFIX;
    else process.env.OPENCLAW_HOOKS_SESSION_PREFIX = previousPrefix;
    if (previousUrl === undefined) delete process.env.OPENCLAW_GAZZA_BRIDGE_URL;
    else process.env.OPENCLAW_GAZZA_BRIDGE_URL = previousUrl;
    if (previousToken === undefined) delete process.env.OPENCLAW_GAZZA_BRIDGE_TOKEN;
    else process.env.OPENCLAW_GAZZA_BRIDGE_TOKEN = previousToken;
  }
});
