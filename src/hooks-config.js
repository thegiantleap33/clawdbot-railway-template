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

// Writes applied with `openclaw config set --json`, same as hooks.token.
// `allowedAgentIds` is omitted when it is already an array (including []).
// A non-default hooks.path is left alone.
export function planHooksConfigWrites({
  token,
  explicitlyDisabled,
  currentPath,
  allowedAgentIds,
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
  writes.push({ path: "hooks.allowRequestSessionKey", value: false });
  return writes;
}
