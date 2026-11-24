import crypto from "node:crypto";
import http from "node:http";

const PLUGIN_ID = "gazza-callback";

export function normalizeSessionPrefix(value) {
  return String(value ?? "").trim();
}

function startsWithIgnoreCase(value, prefix) {
  return value.toLowerCase().startsWith(prefix.toLowerCase());
}

// OpenClaw stores a hook session as agent:<agentId>:<requestedKey>.
// Match either the caller's key or that stored form. Ordinary chats
// (agent:main:main) do not match a hook: prefix.
export function sessionKeyMatchesPrefix(sessionKey, prefix) {
  return logicalSessionKey(sessionKey, prefix) !== null;
}

export function logicalSessionKey(sessionKey, prefix) {
  const key = String(sessionKey ?? "").trim();
  const pre = normalizeSessionPrefix(prefix);
  if (!key || !pre) return null;
  if (startsWithIgnoreCase(key, pre)) return key;
  const scoped = key.match(/^agent:[^:]+:([\s\S]+)$/i);
  if (scoped && startsWithIgnoreCase(scoped[1], pre)) return scoped[1];
  return null;
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const part of content) {
    if (typeof part === "string") parts.push(part);
    else if (part && typeof part.text === "string") parts.push(part.text);
  }
  return parts.join("");
}

export function extractFinalAssistantText(messages) {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || typeof message !== "object") continue;
    const role = String(message.role || message.type || "").toLowerCase();
    if (role !== "assistant") continue;
    const text = textFromContent(message.content) || (typeof message.text === "string" ? message.text : "");
    if (text.trim()) return text;
  }
  return "";
}

export function createRunCorrelator({ waitMs = 3000, maxPending = 50 } = {}) {
  const pending = new Map();
  const waiters = new Map();

  function queueFor(key) {
    let queue = pending.get(key);
    if (!queue) {
      queue = [];
      pending.set(key, queue);
    }
    return queue;
  }

  return {
    noteAdmission({ sessionKey, prefix, httpRunId, requestSessionKey }) {
      const logical = logicalSessionKey(sessionKey, prefix);
      const runId = String(httpRunId ?? "").trim();
      if (!logical || !runId) return false;
      const key = logical.toLowerCase();
      const queue = queueFor(key);
      queue.push({
        httpRunId: runId,
        requestSessionKey: String(requestSessionKey || logical),
      });
      while (queue.length > maxPending) queue.shift();
      const waiting = waiters.get(key);
      if (waiting && waiting.length) {
        const resolve = waiting.shift();
        resolve(queue.shift());
      }
      return true;
    },

    waitForAdmission({ sessionKey, prefix }) {
      const logical = logicalSessionKey(sessionKey, prefix);
      if (!logical) return Promise.resolve(null);
      const key = logical.toLowerCase();
      const queue = pending.get(key);
      if (queue && queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          const list = waiters.get(key) || [];
          const idx = list.indexOf(finish);
          if (idx >= 0) list.splice(idx, 1);
          resolve(null);
        }, waitMs);
        const finish = (value) => {
          clearTimeout(timer);
          resolve(value);
        };
        const list = waiters.get(key) || [];
        list.push(finish);
        waiters.set(key, list);
      });
    },
  };
}

export function callbackBodyFromCompletion({ admission, completion }) {
  const errorText = typeof completion.error === "string" ? completion.error.trim() : "";
  const status = completion.success === false || errorText ? "error" : "ok";
  const body = {
    source: "openclaw",
    runId: admission.httpRunId,
    status,
    reply: typeof completion.reply === "string" ? completion.reply : "",
    agentId: typeof completion.agentId === "string" ? completion.agentId : "",
    sessionKey: admission.requestSessionKey,
  };
  if (errorText) body.error = errorText;
  return body;
}

function bearerMatches(header, token) {
  const match = /^Bearer\s+(\S+)\s*$/.exec(String(header || ""));
  if (!match || !token) return false;
  const supplied = crypto.createHash("sha256").update(match[1]).digest();
  const expected = crypto.createHash("sha256").update(token).digest();
  return crypto.timingSafeEqual(supplied, expected);
}

function readJsonBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

export async function postJsonWithRetry({
  url,
  token,
  body,
  fetchImpl = globalThis.fetch,
  timeoutMs = 4000,
  retryDelaysMs = [250, 1000],
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const attempts = retryDelaysMs.length + 1;
  let lastError = "failed";
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleep(retryDelaysMs[attempt - 1]);
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.ok) return { ok: true, status: response.status };
      lastError = `HTTP ${response.status}`;
    } catch (err) {
      const name = err && err.name;
      lastError = name === "TimeoutError" || name === "AbortError" ? "timeout" : "network";
    }
  }
  return { ok: false, error: lastError };
}

export function createAgentEndHandler({
  prefix,
  bridgeUrl,
  bridgeToken,
  fetchImpl = globalThis.fetch,
} = {}) {
  return (event, ctx) => {
    try {
      const sessionPrefix = normalizeSessionPrefix(prefix);
      if (!sessionPrefix || !bridgeUrl || !bridgeToken) return;
      const sessionKey = ctx?.sessionKey || event?.sessionKey || "";
      if (!sessionKeyMatchesPrefix(sessionKey, sessionPrefix)) return;
      const payload = {
        sessionKey,
        agentId: ctx?.agentId || event?.agentId || "",
        reply: extractFinalAssistantText(event?.messages),
        success: event?.success !== false,
        error: typeof event?.error === "string" ? event.error : "",
      };
      void Promise.resolve(fetchImpl(bridgeUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${bridgeToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      })).catch(() => {});
    } catch {
      // The agent run must not fail because the callback could not be queued.
    }
  };
}

export function gazzaPluginDir() {
  return new URL("./plugins/gazza-callback/", import.meta.url);
}

export function gazzaCallbackSettings(env = process.env) {
  const prefix = normalizeSessionPrefix(env.OPENCLAW_HOOKS_SESSION_PREFIX);
  const callbackUrl = String(env.OPENCLAW_GROK_CALLBACK_URL ?? "").trim();
  const callbackToken = String(env.OPENCLAW_GROK_CALLBACK_TOKEN ?? "").trim();
  let callbackHost = "";
  if (callbackUrl) {
    try {
      const parsed = new URL(callbackUrl);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") callbackHost = parsed.hostname;
    } catch {
      callbackHost = "";
    }
  }
  return {
    prefix,
    callbackUrl: callbackHost ? callbackUrl : "",
    callbackToken,
    callbackHost,
    enabled: Boolean(prefix && callbackHost && callbackToken),
  };
}

export async function startGazzaBridge({
  port = 0,
  host = "127.0.0.1",
  bridgeToken,
  prefix,
  callbackUrl,
  callbackToken,
  correlator,
  fetchImpl,
  timeoutMs,
  retryDelaysMs,
  onWarn = (message) => console.warn(message),
} = {}) {
  if (!bridgeToken) throw new Error("bridge token required");
  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url.split("?")[0] !== "/callback") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not found\n");
      return;
    }
    if (!bearerMatches(req.headers.authorization, bridgeToken)) {
      res.writeHead(401, { "content-type": "text/plain" });
      res.end("Unauthorized\n");
      return;
    }
    readJsonBody(req, 1_000_000).then((completion) => {
      const sessionKey = typeof completion.sessionKey === "string" ? completion.sessionKey : "";
      if (!sessionKeyMatchesPrefix(sessionKey, prefix)) {
        res.writeHead(202, { "content-type": "text/plain" });
        res.end("ignored\n");
        return;
      }
      res.writeHead(202, { "content-type": "text/plain" });
      res.end("accepted\n");
      void correlator.waitForAdmission({ sessionKey, prefix }).then(async (admission) => {
        if (!admission) {
          onWarn("[wrapper] gazza callback dropped: no matching hook run");
          return;
        }
        const body = callbackBodyFromCompletion({ admission, completion });
        const result = await postJsonWithRetry({
          url: callbackUrl,
          token: callbackToken,
          body,
          fetchImpl,
          timeoutMs,
          retryDelaysMs,
        });
        if (!result.ok) onWarn(`[wrapper] gazza callback failed (${result.error})`);
      }).catch(() => {
        onWarn("[wrapper] gazza callback failed");
      });
    }).catch(() => {
      if (!res.headersSent) {
        res.writeHead(400, { "content-type": "text/plain" });
        res.end("Bad request\n");
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  const address = server.address();
  return {
    server,
    port: address.port,
    url: `http://${host}:${address.port}/callback`,
    pluginId: PLUGIN_ID,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

export function planGazzaPluginWrites({ pluginDir, loadPaths, allowList }) {
  const writes = [
    { path: "plugins.entries.gazza-callback.enabled", value: true },
    { path: "plugins.entries.gazza-callback.hooks.allowConversationAccess", value: true },
  ];
  const dir = String(pluginDir);
  if (!loadPaths.found) {
    writes.push({ path: "plugins.load.paths", value: [dir] });
  } else if (Array.isArray(loadPaths.value) && !loadPaths.value.includes(dir)) {
    writes.push({ path: "plugins.load.paths", value: [...loadPaths.value, dir] });
  }
  if (
    allowList.found &&
    Array.isArray(allowList.value) &&
    allowList.value.length > 0 &&
    !allowList.value.includes(PLUGIN_ID)
  ) {
    writes.push({ path: "plugins.allow", value: [...allowList.value, PLUGIN_ID] });
  }
  return writes;
}

export function createBridgeToken() {
  return crypto.randomBytes(32).toString("hex");
}
