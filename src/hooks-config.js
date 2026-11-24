const NOT_JSON = Symbol("not-json");

// OPENCLAW_HOOKS_ENABLED=false (any case, surrounding whitespace ignored) keeps
// the token in config but does not turn hook ingress on.
export function hooksExplicitlyDisabled(envValue) {
  return String(envValue ?? "").trim().toLowerCase() === "false";
}

function parseJsonValue(text) {
  try {
    return JSON.parse(text);
  } catch {
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        return JSON.parse(lines[i]);
      } catch {
        // try the previous line
      }
    }
    return NOT_JSON;
  }
}

// `openclaw config get <path> --json` prints the value as JSON and exits 0.
// A missing path exits non-zero. stdout and stderr are combined by the wrapper,
// so accept a JSON value on its own line when warnings are mixed in.
export function parseConfigGetResult(code, output) {
  if (code !== 0) return { found: false, value: undefined };
  const text = String(output ?? "").trim();
  if (!text) return { found: false, value: undefined };
  const value = parseJsonValue(text);
  if (value === NOT_JSON) return { found: false, value: undefined };
  return { found: true, value };
}

// A path is custom when it normalizes to something other than the wrapper's /hooks route.
export function isCustomHooksPath(value) {
  if (typeof value !== "string") return false;
  let path = value.trim();
  if (!path) return false;
  if (!path.startsWith("/")) path = `/${path}`;
  if (path.length > 1) path = path.replace(/\/+$/, "");
  return path !== "/hooks";
}

// OpenClaw refuses to boot when allowedSessionKeyPrefixes is set, defaultSessionKey
// is unset, and the allowlist does not cover generated `hook:<uuid>` keys.
// A specific prefix such as hook:gazza: needs a default key inside that prefix.
// Do not add the bare "hook:" prefix; that would allow every hook session key.
export function resolveHookSessionPrefix(sessionKeyPrefix) {
  const prefix = String(sessionKeyPrefix ?? "").trim();
  if (!prefix) return { ok: true, prefix: "" };
  if (!prefix.toLowerCase().startsWith("hook:")) {
    return { ok: false, error: "OPENCLAW_HOOKS_SESSION_PREFIX must start with hook:" };
  }
  if (/[\s\p{Cc}]/u.test(prefix)) {
    return { ok: false, error: "OPENCLAW_HOOKS_SESSION_PREFIX must not contain whitespace" };
  }
  const defaultSessionKey = prefix.endsWith(":")
    ? `${prefix}main`
    : prefix.toLowerCase().endsWith(":main")
      ? prefix
      : `${prefix}:main`;
  if (!defaultSessionKey.toLowerCase().startsWith(prefix.toLowerCase())) {
    return { ok: false, error: "hooks.defaultSessionKey must start with the session prefix" };
  }
  return { ok: true, prefix, defaultSessionKey };
}

function admitsGeneratedHookKey(prefixes) {
  return prefixes.some((prefix) => "hook:example".startsWith(prefix.toLowerCase()));
}

// Drop wrapper-owned session policy when OPENCLAW_HOOKS_SESSION_PREFIX is empty.
// That includes the crashing shape (a single hook: prefix and no default key)
// and the pair this wrapper writes (`${prefix}main`). Leave any other list alone.
export function planWrapperSessionUnsets({
  sessionKeyPrefix,
  allowedSessionKeyPrefixes,
  defaultSessionKey,
}) {
  const requested = resolveHookSessionPrefix(sessionKeyPrefix);
  if (!requested.ok || requested.prefix) return [];
  if (!Array.isArray(allowedSessionKeyPrefixes)) return [];
  const prefixes = allowedSessionKeyPrefixes
    .map((prefix) => String(prefix ?? "").trim())
    .filter(Boolean);
  if (prefixes.length !== 1) return [];
  const prefix = prefixes[0];
  if (!prefix.toLowerCase().startsWith("hook:")) return [];
  const expected = resolveHookSessionPrefix(prefix);
  if (!expected.ok) return [];
  const currentDefault = typeof defaultSessionKey === "string" ? defaultSessionKey.trim() : "";
  const wrapperPair = currentDefault === expected.defaultSessionKey;
  const crashesWithoutDefault = !currentDefault && !admitsGeneratedHookKey(prefixes);
  if (!wrapperPair && !crashesWithoutDefault) return [];
  const unsets = ["hooks.allowedSessionKeyPrefixes"];
  if (currentDefault) unsets.push("hooks.defaultSessionKey");
  return unsets;
}

// Writes applied with `openclaw config set --json`, same as hooks.token.
// `allowedAgentIds` is omitted when it is already an array (including []).
// A non-default hooks.path is left alone.
// A valid session prefix opts into persistent caller-selected keys and sets
// hooks.defaultSessionKey so the gateway can boot.
export function planHooksConfigWrites({
  token,
  explicitlyDisabled,
  currentPath,
  allowedAgentIds,
  sessionKeyPrefix,
}) {
  const writes = [{ path: "hooks.token", value: token }];
  if (explicitlyDisabled) {
    writes.push({ path: "hooks.enabled", value: false });
    return writes;
  }

  writes.push({ path: "hooks.enabled", value: true });
  if (!isCustomHooksPath(currentPath)) {
    writes.push({ path: "hooks.path", value: "/hooks" });
  }
  if (!Array.isArray(allowedAgentIds)) {
    writes.push({ path: "hooks.allowedAgentIds", value: ["main"] });
  }
  const session = resolveHookSessionPrefix(sessionKeyPrefix);
  if (session.ok && session.prefix) {
    writes.push({ path: "hooks.allowRequestSessionKey", value: true });
    writes.push({ path: "hooks.allowedSessionKeyPrefixes", value: [session.prefix] });
    writes.push({ path: "hooks.defaultSessionKey", value: session.defaultSessionKey });
  } else {
    writes.push({ path: "hooks.allowRequestSessionKey", value: false });
  }
  return writes;
}
