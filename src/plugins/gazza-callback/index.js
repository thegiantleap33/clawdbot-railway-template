"use strict";

// OpenClaw loads plugin entries with require(). This file is CommonJS
// (see package.json "type": "commonjs") and must not use top-level await
// or import an ESM module. The HTTP run id is paired by the wrapper.

function normalizePrefix(value) {
  return String(value || "").trim();
}

function startsWithIgnoreCase(value, prefix) {
  return value.toLowerCase().startsWith(prefix.toLowerCase());
}

function sessionKeyMatchesPrefix(sessionKey, prefix) {
  const key = String(sessionKey || "").trim();
  const pre = normalizePrefix(prefix);
  if (!key || !pre) return false;
  if (startsWithIgnoreCase(key, pre)) return true;
  const scoped = key.match(/^agent:[^:]+:([\s\S]+)$/i);
  return Boolean(scoped && startsWithIgnoreCase(scoped[1], pre));
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

function extractFinalAssistantText(messages) {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || typeof message !== "object") continue;
    const role = String(message.role || message.type || "").toLowerCase();
    if (role !== "assistant") continue;
    const text = textFromContent(message.content) || (typeof message.text === "string" ? message.text : "");
    if (text.trim()) return text;
  }
  return "";
}

function onAgentEnd(event, ctx) {
  try {
    const prefix = normalizePrefix(process.env.OPENCLAW_HOOKS_SESSION_PREFIX);
    const bridgeUrl = process.env.OPENCLAW_GAZZA_BRIDGE_URL;
    const bridgeToken = process.env.OPENCLAW_GAZZA_BRIDGE_TOKEN;
    if (!prefix || !bridgeUrl || !bridgeToken) return;
    const sessionKey = (ctx && ctx.sessionKey) || (event && event.sessionKey) || "";
    if (!sessionKeyMatchesPrefix(sessionKey, prefix)) return;
    const payload = {
      sessionKey: sessionKey,
      agentId: (ctx && ctx.agentId) || (event && event.agentId) || "",
      reply: extractFinalAssistantText(event && event.messages),
      success: !event || event.success !== false,
      error: event && typeof event.error === "string" ? event.error : "",
    };
    const fetchImpl = globalThis.fetch;
    if (typeof fetchImpl !== "function") return;
    Promise.resolve(fetchImpl(bridgeUrl, {
      method: "POST",
      headers: {
        authorization: "Bearer " + bridgeToken,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    })).catch(function () {});
  } catch {
    // The agent run must not fail because the callback could not be queued.
  }
}

const spec = {
  id: "gazza-callback",
  name: "Gazza callback",
  description: "Forwards finished Gazza hook runs to the Railway wrapper.",
  register(api) {
    api.on("agent_end", onAgentEnd);
  },
};

module.exports = spec;
module.exports.default = spec;
