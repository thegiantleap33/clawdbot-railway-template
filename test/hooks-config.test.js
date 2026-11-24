import test from "node:test";
import assert from "node:assert/strict";

import {
  hooksExplicitlyDisabled,
  isCustomHooksPath,
  parseConfigGetResult,
  planHooksConfigWrites,
  planWrapperSessionUnsets,
  resolveHookSessionPrefix,
} from "../src/hooks-config.js";

test("hooksExplicitlyDisabled only accepts the string false", () => {
  assert.equal(hooksExplicitlyDisabled("false"), true);
  assert.equal(hooksExplicitlyDisabled(" FALSE "), true);
  assert.equal(hooksExplicitlyDisabled(""), false);
  assert.equal(hooksExplicitlyDisabled(undefined), false);
  assert.equal(hooksExplicitlyDisabled("true"), false);
  assert.equal(hooksExplicitlyDisabled("0"), false);
});

test("planHooksConfigWrites enables hooks and fills defaults", () => {
  const writes = planHooksConfigWrites({
    token: "hook-env-token",
    explicitlyDisabled: false,
    currentPath: undefined,
    allowedAgentIds: undefined,
  });
  assert.deepEqual(writes, [
    { path: "hooks.token", value: "hook-env-token" },
    { path: "hooks.enabled", value: true },
    { path: "hooks.path", value: "/hooks" },
    { path: "hooks.allowedAgentIds", value: ["main"] },
    { path: "hooks.allowRequestSessionKey", value: false },
  ]);
});

test("planHooksConfigWrites keeps a custom path and an existing agent allowlist", () => {
  const writes = planHooksConfigWrites({
    token: "hook-env-token",
    explicitlyDisabled: false,
    currentPath: "/custom-hooks/",
    allowedAgentIds: ["other"],
  });
  assert.deepEqual(
    writes.map((write) => write.path),
    ["hooks.token", "hooks.enabled", "hooks.allowRequestSessionKey"],
  );
  assert.equal(writes.find((write) => write.path === "hooks.enabled").value, true);
  assert.equal(writes.find((write) => write.path === "hooks.allowRequestSessionKey").value, false);
});

test("planHooksConfigWrites treats an empty allowlist as already set", () => {
  const writes = planHooksConfigWrites({
    token: "hook-env-token",
    explicitlyDisabled: false,
    currentPath: "/hooks",
    allowedAgentIds: [],
  });
  assert.equal(writes.some((write) => write.path === "hooks.allowedAgentIds"), false);
  assert.equal(writes.find((write) => write.path === "hooks.path").value, "/hooks");
});

test("planHooksConfigWrites allows a persistent session prefix when configured", () => {
  const writes = planHooksConfigWrites({
    token: "hook-env-token",
    explicitlyDisabled: false,
    currentPath: "/hooks",
    allowedAgentIds: ["main"],
    sessionKeyPrefix: " hook:gazza: ",
  });
  assert.equal(writes.find((write) => write.path === "hooks.allowRequestSessionKey").value, true);
  assert.deepEqual(
    writes.find((write) => write.path === "hooks.allowedSessionKeyPrefixes").value,
    ["hook:gazza:"],
  );
  assert.equal(writes.find((write) => write.path === "hooks.defaultSessionKey").value, "hook:gazza:main");
  assert.equal(
    writes.find((write) => write.path === "hooks.allowedSessionKeyPrefixes").value.includes("hook:"),
    false,
  );
});

test("resolveHookSessionPrefix rejects prefixes outside the hook: namespace", () => {
  assert.equal(resolveHookSessionPrefix("gazza:").ok, false);
  assert.equal(resolveHookSessionPrefix("hook:gazza:with space").ok, false);
  assert.deepEqual(resolveHookSessionPrefix("hook:gazza"), {
    ok: true,
    prefix: "hook:gazza",
    defaultSessionKey: "hook:gazza:main",
  });
  const writes = planHooksConfigWrites({
    token: "hook-env-token",
    explicitlyDisabled: false,
    currentPath: "/hooks",
    allowedAgentIds: ["main"],
    sessionKeyPrefix: "not-a-hook:",
  });
  assert.equal(writes.find((write) => write.path === "hooks.allowRequestSessionKey").value, false);
  assert.equal(writes.some((write) => write.path === "hooks.allowedSessionKeyPrefixes"), false);
  assert.equal(writes.some((write) => write.path === "hooks.defaultSessionKey"), false);
});

test("clearing the session prefix unsets wrapper-owned hook session keys", () => {
  assert.deepEqual(planWrapperSessionUnsets({
    sessionKeyPrefix: "",
    allowedSessionKeyPrefixes: ["hook:gazza:"],
    defaultSessionKey: undefined,
  }), ["hooks.allowedSessionKeyPrefixes"]);

  assert.deepEqual(planWrapperSessionUnsets({
    sessionKeyPrefix: "  ",
    allowedSessionKeyPrefixes: ["hook:gazza:"],
    defaultSessionKey: "hook:gazza:main",
  }), ["hooks.allowedSessionKeyPrefixes", "hooks.defaultSessionKey"]);

  assert.deepEqual(planWrapperSessionUnsets({
    sessionKeyPrefix: "",
    allowedSessionKeyPrefixes: ["hook:gazza:", "hook:"],
    defaultSessionKey: undefined,
  }), []);

  assert.deepEqual(planWrapperSessionUnsets({
    sessionKeyPrefix: "",
    allowedSessionKeyPrefixes: ["hook:gazza:"],
    defaultSessionKey: "hook:gazza:inbox",
  }), []);

  assert.deepEqual(planWrapperSessionUnsets({
    sessionKeyPrefix: "hook:gazza:",
    allowedSessionKeyPrefixes: ["hook:gazza:"],
    defaultSessionKey: undefined,
  }), []);
});

test("planHooksConfigWrites ignores a session prefix when hooks are disabled", () => {
  const writes = planHooksConfigWrites({
    token: "hook-env-token",
    explicitlyDisabled: true,
    sessionKeyPrefix: "hook:gazza:",
  });
  assert.deepEqual(writes, [
    { path: "hooks.token", value: "hook-env-token" },
    { path: "hooks.enabled", value: false },
  ]);
});

test("planHooksConfigWrites only forces hooks off when explicitly disabled", () => {
  const writes = planHooksConfigWrites({
    token: "hook-env-token",
    explicitlyDisabled: true,
    currentPath: "/custom",
    allowedAgentIds: ["other"],
  });
  assert.deepEqual(writes, [
    { path: "hooks.token", value: "hook-env-token" },
    { path: "hooks.enabled", value: false },
  ]);
});

test("isCustomHooksPath treats the wrapper route as the default", () => {
  assert.equal(isCustomHooksPath(undefined), false);
  assert.equal(isCustomHooksPath(""), false);
  assert.equal(isCustomHooksPath("/hooks"), false);
  assert.equal(isCustomHooksPath("/hooks/"), false);
  assert.equal(isCustomHooksPath("hooks"), false);
  assert.equal(isCustomHooksPath("/custom"), true);
});

test("parseConfigGetResult ignores non-zero exits and mixed warnings", () => {
  assert.deepEqual(parseConfigGetResult(1, '{"error":"unset"}\n'), { found: false, value: undefined });
  assert.deepEqual(parseConfigGetResult(0, ""), { found: false, value: undefined });
  assert.deepEqual(parseConfigGetResult(0, '"/custom"\n'), { found: true, value: "/custom" });
  assert.deepEqual(parseConfigGetResult(0, 'warning: noisy\n["main","ops"]\n'), {
    found: true,
    value: ["main", "ops"],
  });
  assert.deepEqual(parseConfigGetResult(0, "null"), { found: true, value: null });
});
