import test from "node:test";
import assert from "node:assert/strict";

import {
  callbackBodyFromCompletion,
  createAgentEndHandler,
  createRunCorrelator,
  extractFinalAssistantText,
  planGazzaPluginWrites,
  postJsonWithRetry,
  sessionKeyMatchesPrefix,
} from "../src/gazza-callback.js";

test("session prefix matches the caller key and OpenClaw's agent-scoped form", () => {
  assert.equal(sessionKeyMatchesPrefix("hook:gazza:main", "hook:gazza:"), true);
  assert.equal(sessionKeyMatchesPrefix("agent:main:hook:gazza:main", "hook:gazza:"), true);
  assert.equal(sessionKeyMatchesPrefix("agent:main:main", "hook:gazza:"), false);
  assert.equal(sessionKeyMatchesPrefix("hook:other:main", "hook:gazza:"), false);
});

test("extractFinalAssistantText keeps the last assistant reply", () => {
  const text = extractFinalAssistantText([
    { role: "user", content: "do the thing" },
    { role: "assistant", content: [{ type: "text", text: "Working" }] },
    { role: "assistant", content: "The final Gazza reply" },
  ]);
  assert.equal(text, "The final Gazza reply");
});

test("correlator pairs a late admission with the HTTP run id", async () => {
  const correlator = createRunCorrelator({ waitMs: 500 });
  const pending = correlator.waitForAdmission({
    sessionKey: "agent:main:hook:gazza:main",
    prefix: "hook:gazza:",
  });
  correlator.noteAdmission({
    sessionKey: "hook:gazza:main",
    prefix: "hook:gazza:",
    httpRunId: "run-from-hooks",
    requestSessionKey: "hook:gazza:main",
  });
  const admission = await pending;
  assert.equal(admission.httpRunId, "run-from-hooks");
  const body = callbackBodyFromCompletion({
    admission,
    completion: { reply: "done", success: true, agentId: "main" },
  });
  assert.equal(body.runId, "run-from-hooks");
  assert.equal(body.sessionKey, "hook:gazza:main");
  assert.equal(body.status, "ok");
  assert.equal(body.error, undefined);
});

test("correlator keeps admission order for one persistent session", () => {
  const correlator = createRunCorrelator();
  correlator.noteAdmission({
    sessionKey: "hook:gazza:main",
    prefix: "hook:gazza:",
    httpRunId: "run-1",
    requestSessionKey: "hook:gazza:main",
  });
  correlator.noteAdmission({
    sessionKey: "hook:gazza:main",
    prefix: "hook:gazza:",
    httpRunId: "run-2",
    requestSessionKey: "hook:gazza:main",
  });
  return Promise.all([
    correlator.waitForAdmission({ sessionKey: "hook:gazza:main", prefix: "hook:gazza:" }),
    correlator.waitForAdmission({ sessionKey: "hook:gazza:main", prefix: "hook:gazza:" }),
  ]).then(([first, second]) => {
    assert.equal(first.httpRunId, "run-1");
    assert.equal(second.httpRunId, "run-2");
  });
});

test("agent_end handler ignores ordinary chats and posts prefixed replies", async () => {
  const calls = [];
  const handler = createAgentEndHandler({
    prefix: "hook:gazza:",
    bridgeUrl: "http://127.0.0.1:9/callback",
    bridgeToken: "bridge-secret",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { ok: true };
    },
  });
  handler(
    { success: true, messages: [{ role: "assistant", content: "hello gazza" }] },
    { sessionKey: "agent:main:main", agentId: "main", runId: "inner-1" },
  );
  handler(
    {
      success: false,
      error: "boom",
      messages: [{ role: "assistant", text: "partial" }],
    },
    { sessionKey: "agent:main:hook:gazza:main", agentId: "main", runId: "inner-2" },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers.authorization, "Bearer bridge-secret");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.reply, "partial");
  assert.equal(body.success, false);
  assert.equal(body.error, "boom");
  assert.equal(body.sessionKey, "agent:main:hook:gazza:main");
  assert.equal(body.runId, undefined);
});

test("callback retries then succeeds without putting the secret in the error", async () => {
  const statuses = [503, 500, 204];
  const result = await postJsonWithRetry({
    url: "http://callback.test/done",
    token: "grok-callback-secret",
    body: { reply: "secret reply", runId: "run-1" },
    retryDelaysMs: [0, 0],
    sleep: async () => {},
    fetchImpl: async (_url, init) => {
      assert.equal(init.headers.authorization, "Bearer grok-callback-secret");
      const status = statuses.shift();
      return { ok: status >= 200 && status < 300, status };
    },
  });
  assert.deepEqual(result, { ok: true, status: 204 });
  assert.equal(statuses.length, 0);
});

test("plugin config appends the load path and an existing allowlist", () => {
  const writes = planGazzaPluginWrites({
    pluginDir: "/app/src/plugins/gazza-callback/",
    loadPaths: { found: true, value: ["/other"] },
    allowList: { found: true, value: ["telegram"] },
  });
  assert.deepEqual(
    writes.find((write) => write.path === "plugins.load.paths").value,
    ["/other", "/app/src/plugins/gazza-callback/"],
  );
  assert.deepEqual(
    writes.find((write) => write.path === "plugins.allow").value,
    ["telegram", "gazza-callback"],
  );
});
