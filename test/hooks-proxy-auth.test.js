import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function freePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function httpRequest({ port, method = "GET", path: reqPath = "/", headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method, path: reqPath, headers },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("error", reject);
    if (body != null) req.write(body);
    req.end();
  });
}

function wsUpgrade(port, reqPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: reqPath,
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": crypto.randomBytes(16).toString("base64"),
        ...headers,
      },
    });
    req.on("upgrade", (res, socket) => {
      socket.destroy();
      resolve({ status: 101, headers: res.headers });
    });
    req.on("response", (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

async function readCliLogBeforeGateway(cliLogPath) {
  const deadline = Date.now() + 2000;
  let cliLog = "";
  while (Date.now() < deadline) {
    try {
      cliLog = fs.readFileSync(cliLogPath, "utf8");
    } catch {
      cliLog = "";
    }
    if (cliLog.includes("gateway run")) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const gatewayAt = cliLog.indexOf("gateway run");
  return {
    cliLog,
    beforeGateway: gatewayAt >= 0 ? cliLog.slice(0, gatewayAt) : cliLog,
  };
}

function cookieHeader(res) {
  const raw = res.headers["set-cookie"];
  return Array.isArray(raw) ? raw.join("\n") : String(raw || "");
}

function fakeOpenClawSource() {
  return [
    "const fs = require('node:fs');",
    "const args = process.argv.slice(2);",
    "if (process.env.FAKE_OPENCLAW_LOG) {",
    "  fs.appendFileSync(process.env.FAKE_OPENCLAW_LOG, args.join(' ') + '\\n');",
    "}",
    "if (args[0] === 'config' && args[1] === 'get') {",
    "  let map = {};",
    "  try { map = JSON.parse(process.env.FAKE_OPENCLAW_GET || '{}'); } catch {}",
    "  const key = args[2];",
    "  if (Object.prototype.hasOwnProperty.call(map, key)) {",
    "    process.stdout.write(JSON.stringify(map[key]));",
    "    process.exit(0);",
    "  }",
    "  process.exit(1);",
    "}",
    "if (args[0] === 'gateway' && args.includes('run')) {",
    "  setInterval(() => {}, 60 * 60 * 1000);",
    "} else {",
    "  process.exit(0);",
    "}",
    "",
  ].join("\n");
}

// Boots the wrapper against a fake gateway and resolves once hooks config has been
// written and the gateway process has started. Caller must invoke stop().
async function bootWrapper(extraEnv = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-wrapper-"));
  const entryPath = path.join(stateDir, "fake-openclaw.cjs");
  const cliLogPath = path.join(stateDir, "cli.log");
  fs.writeFileSync(path.join(stateDir, "openclaw.json"), "{}\n");
  fs.writeFileSync(entryPath, fakeOpenClawSource());

  const hits = [];
  const mock = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      hits.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body,
        upgrade: false,
      });
      if (req.method === "POST" && req.url === "/hooks/agent") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, runId: "run-from-hooks" }));
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
  });
  mock.on("upgrade", (req, socket) => {
    hits.push({ method: req.method, url: req.url, headers: req.headers, body: "", upgrade: true });
    const key = String(req.headers["sec-websocket-key"] || "");
    const accept = crypto
      .createHash("sha1")
      .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.end();
  });

  const gatewayPort = await freePort();
  await new Promise((resolve) => mock.listen(gatewayPort, "127.0.0.1", resolve));
  const publicPort = await freePort();
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(publicPort),
      SETUP_PASSWORD: "test-password",
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_WORKSPACE_DIR: path.join(stateDir, "workspace"),
      OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
      INTERNAL_GATEWAY_HOST: "127.0.0.1",
      INTERNAL_GATEWAY_PORT: String(gatewayPort),
      OPENCLAW_GATEWAY_TOKEN: "gateway-secret",
      OPENCLAW_HOOKS_TOKEN: "hook-env-token",
      OPENCLAW_HOOKS_ENABLED: "",
      OPENCLAW_HOOKS_SESSION_PREFIX: "",
      OPENCLAW_GROK_CALLBACK_URL: "",
      OPENCLAW_GROK_CALLBACK_TOKEN: "",
      OPENCLAW_GAZZA_BRIDGE_PORT: "",
      OPENCLAW_GAZZA_BRIDGE_TOKEN: "",
      OPENCLAW_GAZZA_BRIDGE_URL: "",
      FAKE_OPENCLAW_LOG: cliLogPath,
      OPENCLAW_ENTRY: entryPath,
      OPENCLAW_NODE: process.execPath,
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let logs = "";
  child.stdout.on("data", (chunk) => {
    logs += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    logs += chunk.toString();
  });

  const stop = async () => {
    if (child.exitCode === null && !child.killed) {
      const exited = new Promise((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 2000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      child.kill("SIGTERM");
      await exited;
    }
    await new Promise((resolve) => mock.close(resolve));
    fs.rmSync(stateDir, { recursive: true, force: true });
  };

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (logs.includes("gateway failed to start")) break;
    try {
      const probe = await httpRequest({ port: publicPort, path: "/healthz" });
      if (probe.status === 200 && logs.includes("gateway ready")) {
        const recorded = await readCliLogBeforeGateway(cliLogPath);
        return {
          port: publicPort,
          hits,
          logs,
          getLogs: () => logs,
          cliLog: recorded.cliLog,
          beforeGateway: recorded.beforeGateway,
          stop,
        };
      }
    } catch {
      // still binding
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const detail = logs;
  await stop();
  throw new Error(`wrapper did not become ready\n${detail}`);
}

test("hooks keep caller auth and unauthenticated websocket upgrades are rejected", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-wrapper-"));
  const entryPath = path.join(stateDir, "fake-openclaw.cjs");
  const cliLogPath = path.join(stateDir, "cli.log");
  fs.writeFileSync(path.join(stateDir, "openclaw.json"), "{}\n");
  fs.writeFileSync(
    entryPath,
    [
      "const fs = require('node:fs');",
      "const args = process.argv.slice(2);",
      "if (process.env.FAKE_OPENCLAW_LOG) {",
      "  fs.appendFileSync(process.env.FAKE_OPENCLAW_LOG, args.join(' ') + '\\n');",
      "}",
      "if (args[0] === 'gateway' && args.includes('run')) {",
      "  setInterval(() => {}, 60 * 60 * 1000);",
      "} else {",
      "  process.exit(0);",
      "}",
      "",
    ].join("\n"),
  );

  const hits = [];
  const mock = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      hits.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
        upgrade: false,
      });
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
  });
  mock.on("upgrade", (req, socket) => {
    hits.push({
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: "",
      upgrade: true,
    });
    const key = String(req.headers["sec-websocket-key"] || "");
    const accept = crypto
      .createHash("sha1")
      .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n` +
        "\r\n",
    );
    socket.end();
  });

  const gatewayPort = await freePort();
  await new Promise((resolve) => mock.listen(gatewayPort, "127.0.0.1", resolve));
  const publicPort = await freePort();

  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(publicPort),
      SETUP_PASSWORD: "test-password",
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_WORKSPACE_DIR: path.join(stateDir, "workspace"),
      OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
      INTERNAL_GATEWAY_HOST: "127.0.0.1",
      INTERNAL_GATEWAY_PORT: String(gatewayPort),
      OPENCLAW_GATEWAY_TOKEN: "gateway-secret",
      OPENCLAW_HOOKS_TOKEN: "hook-env-token",
      OPENCLAW_HOOKS_ENABLED: "",
      OPENCLAW_HOOKS_SESSION_PREFIX: "",
      OPENCLAW_GROK_CALLBACK_URL: "",
      OPENCLAW_GROK_CALLBACK_TOKEN: "",
      FAKE_OPENCLAW_LOG: cliLogPath,
      OPENCLAW_ENTRY: entryPath,
      OPENCLAW_NODE: process.execPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let logs = "";
  child.stdout.on("data", (chunk) => {
    logs += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    logs += chunk.toString();
  });

  const stopChild = () =>
    new Promise((resolve) => {
      if (child.exitCode !== null || child.killed) return resolve();
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 2000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill("SIGTERM");
    });

  try {
    const readyDeadline = Date.now() + 15_000;
    let ready = false;
    let lastStatus = 0;
    while (Date.now() < readyDeadline) {
      if (logs.includes("gateway failed to start")) break;
      try {
        const probe = await httpRequest({ port: publicPort, path: "/healthz" });
        lastStatus = probe.status;
        if (probe.status === 200 && logs.includes("gateway ready")) {
          ready = true;
          break;
        }
      } catch {
        // wrapper still binding
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(ready, `wrapper did not become ready (last status ${lastStatus})\n${logs}`);

    const recorded = await readCliLogBeforeGateway(cliLogPath);
    const cliLog = recorded.cliLog;
    const beforeGateway = recorded.beforeGateway;
    assert.match(beforeGateway, /config set --json hooks\.token "hook-env-token"/);
    assert.match(beforeGateway, /config set --json hooks\.enabled true/);
    assert.match(beforeGateway, /config set --json hooks\.path "\/hooks"/);
    assert.match(beforeGateway, /config set --json hooks\.allowedAgentIds \["main"\]/);
    assert.match(beforeGateway, /config set --json hooks\.allowRequestSessionKey false/);
    assert.equal(logs.includes("hook-env-token"), false);

    const payload = JSON.stringify({ message: "hello from hook", name: "Email" });
    const hookRes = await httpRequest({
      port: publicPort,
      method: "POST",
      path: "/hooks/agent",
      headers: {
        Authorization: "Bearer hook-secret",
        "x-openclaw-token": "hook-secret",
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
      body: payload,
    });
    assert.equal(hookRes.status, 200, hookRes.body);
    const hookHit = hits.find((hit) => hit.method === "POST" && hit.url === "/hooks/agent");
    assert.ok(hookHit, "gateway did not receive POST /hooks/agent");
    assert.equal(hookHit.headers.authorization, "Bearer hook-secret");
    assert.equal(hookHit.headers["x-openclaw-token"], "hook-secret");
    assert.equal(hookHit.body, payload);
    assert.notEqual(hookHit.headers.authorization, "Bearer gateway-secret");

    const headerOnly = JSON.stringify({ message: "header only" });
    const headerOnlyRes = await httpRequest({
      port: publicPort,
      method: "POST",
      path: "/hooks/wake",
      headers: {
        "x-openclaw-token": "only-header-token",
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(headerOnly),
      },
      body: headerOnly,
    });
    assert.equal(headerOnlyRes.status, 200, headerOnlyRes.body);
    const wakeHit = hits.find((hit) => hit.method === "POST" && hit.url === "/hooks/wake");
    assert.ok(wakeHit);
    assert.equal(wakeHit.headers["x-openclaw-token"], "only-header-token");
    assert.equal(wakeHit.headers.authorization, undefined);
    assert.equal(wakeHit.body, headerOnly);

    const notHooks = await httpRequest({ port: publicPort, path: "/hooksfoo" });
    assert.equal(notHooks.status, 401);
    assert.equal(hits.some((hit) => hit.url === "/hooksfoo"), false);

    const denied = await httpRequest({ port: publicPort, path: "/openclaw" });
    assert.equal(denied.status, 401);
    assert.match(denied.headers["www-authenticate"] || "", /Basic/);

    const basic = Buffer.from("anyone:test-password").toString("base64");
    const authed = await httpRequest({
      port: publicPort,
      path: "/openclaw",
      headers: { Authorization: `Basic ${basic}` },
    });
    assert.equal(authed.status, 200, authed.body);
    const sessionCookie = cookieHeader(authed);
    assert.match(sessionCookie, /openclaw_dashboard_session=([a-f0-9]{64})/);
    assert.doesNotMatch(sessionCookie, /;\s*Secure/i);
    const session = sessionCookie.match(/openclaw_dashboard_session=([a-f0-9]{64})/)[1];

    // Boot probes the gateway directly, so the proxied request is the latest hit.
    const dashboardHit = hits.findLast((hit) => hit.method === "GET" && hit.url === "/openclaw");
    assert.ok(dashboardHit);
    assert.equal(dashboardHit.headers.authorization, "Bearer gateway-secret");

    const secureLogin = await httpRequest({
      port: publicPort,
      path: "/openclaw/",
      headers: {
        Authorization: `Basic ${basic}`,
        "X-Forwarded-Proto": "https",
      },
    });
    assert.match(cookieHeader(secureLogin), /;\s*Secure/i);

    const viaCookie = await httpRequest({
      port: publicPort,
      path: "/openclaw/assets/app.js",
      headers: { Cookie: `openclaw_dashboard_session=${session}` },
    });
    assert.equal(viaCookie.status, 200, viaCookie.body);
    const assetHit = hits.find((hit) => hit.url === "/openclaw/assets/app.js");
    assert.ok(assetHit);
    assert.equal(assetHit.headers.authorization, "Bearer gateway-secret");

    const upgradesBefore = hits.filter((hit) => hit.upgrade).length;
    const unauthWs = await wsUpgrade(publicPort, "/openclaw");
    assert.equal(unauthWs.status, 401);
    assert.match(unauthWs.body, /Authentication required/);
    assert.equal(hits.filter((hit) => hit.upgrade).length, upgradesBefore);

    const cookieWs = await wsUpgrade(publicPort, "/openclaw", {
      Cookie: `openclaw_dashboard_session=${session}`,
    });
    assert.equal(cookieWs.status, 101);
    const cookieUpgrade = hits.find((hit) => hit.upgrade && hit.url === "/openclaw");
    assert.ok(cookieUpgrade);
    assert.equal(cookieUpgrade.headers.authorization, "Bearer gateway-secret");

    const basicWs = await wsUpgrade(publicPort, "/ws", {
      Authorization: `Basic ${basic}`,
    });
    assert.equal(basicWs.status, 101);
    const basicUpgrade = hits.find((hit) => hit.upgrade && hit.url === "/ws");
    assert.ok(basicUpgrade);
    assert.equal(basicUpgrade.headers.authorization, "Bearer gateway-secret");

    const hookWs = await wsUpgrade(publicPort, "/hooks/agent", {
      Authorization: "Bearer hook-secret",
      "x-openclaw-token": "hook-secret",
    });
    assert.equal(hookWs.status, 101);
    const hookUpgrade = hits.find((hit) => hit.upgrade && hit.url === "/hooks/agent");
    assert.ok(hookUpgrade);
    assert.equal(hookUpgrade.headers.authorization, "Bearer hook-secret");
    assert.equal(hookUpgrade.headers["x-openclaw-token"], "hook-secret");
  } finally {
    await stopChild();
    await new Promise((resolve) => mock.close(resolve));
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("startup keeps a custom hooks path and an existing agent allowlist", async () => {
  const booted = await bootWrapper({
    FAKE_OPENCLAW_GET: JSON.stringify({
      "hooks.path": "/custom",
      "hooks.allowedAgentIds": ["ops"],
    }),
  });
  try {
    assert.match(booted.beforeGateway, /config set --json hooks\.enabled true/);
    assert.match(booted.beforeGateway, /config set --json hooks\.allowRequestSessionKey false/);
    assert.match(booted.beforeGateway, /config set --json hooks\.token "hook-env-token"/);
    assert.doesNotMatch(booted.beforeGateway, /config set --json hooks\.path/);
    assert.doesNotMatch(booted.beforeGateway, /config set --json hooks\.allowedAgentIds/);
    assert.equal(booted.logs.includes("hook-env-token"), false);
  } finally {
    await booted.stop();
  }
});

test("OPENCLAW_HOOKS_ENABLED=false stores the token and leaves hooks disabled", async () => {
  const booted = await bootWrapper({ OPENCLAW_HOOKS_ENABLED: "false" });
  try {
    assert.match(booted.beforeGateway, /config set --json hooks\.token "hook-env-token"/);
    assert.match(booted.beforeGateway, /config set --json hooks\.enabled false/);
    assert.doesNotMatch(booted.beforeGateway, /config set --json hooks\.path/);
    assert.doesNotMatch(booted.beforeGateway, /config set --json hooks\.allowedAgentIds/);
    assert.doesNotMatch(booted.beforeGateway, /config set --json hooks\.allowRequestSessionKey/);
    assert.equal(booted.logs.includes("hook-env-token"), false);
  } finally {
    await booted.stop();
  }
});

test("gazza callback uses the /hooks/agent runId and the final reply", async () => {
  const received = [];
  const callback = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      received.push({
        auth: req.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      });
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
  });
  const callbackPort = await freePort();
  await new Promise((resolve) => callback.listen(callbackPort, "127.0.0.1", resolve));
  const bridgePort = await freePort();
  const booted = await bootWrapper({
    OPENCLAW_HOOKS_SESSION_PREFIX: "hook:gazza:",
    OPENCLAW_GROK_CALLBACK_URL: `http://127.0.0.1:${callbackPort}/done`,
    OPENCLAW_GROK_CALLBACK_TOKEN: "grok-callback-secret",
    OPENCLAW_GAZZA_BRIDGE_PORT: String(bridgePort),
    OPENCLAW_GAZZA_BRIDGE_TOKEN: "bridge-test-token",
  });
  try {
    assert.match(booted.beforeGateway, /config set --json hooks\.allowRequestSessionKey true/);
    assert.match(booted.beforeGateway, /config set --json hooks\.allowedSessionKeyPrefixes \["hook:gazza:"\]/);
    assert.match(booted.beforeGateway, /plugins\.entries\.gazza-callback\.enabled true/);
    assert.equal(booted.getLogs().includes("grok-callback-secret"), false);
    assert.equal(booted.getLogs().includes("bridge-test-token"), false);

    const payload = JSON.stringify({
      message: "ping",
      sessionMode: "persistent",
      sessionKey: "hook:gazza:main",
    });
    const hookRes = await httpRequest({
      port: booted.port,
      method: "POST",
      path: "/hooks/agent",
      headers: {
        Authorization: "Bearer hook-secret",
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
      body: payload,
    });
    assert.equal(hookRes.status, 200, hookRes.body);
    assert.equal(JSON.parse(hookRes.body).runId, "run-from-hooks");
    const gatewayHit = booted.hits.find((hit) => hit.method === "POST" && hit.url === "/hooks/agent");
    assert.ok(gatewayHit);
    assert.equal(gatewayHit.body, payload);

    const completion = JSON.stringify({
      sessionKey: "agent:main:hook:gazza:main",
      agentId: "main",
      reply: "The final Gazza reply",
      success: true,
    });
    const bridgeRes = await httpRequest({
      port: bridgePort,
      method: "POST",
      path: "/callback",
      headers: {
        Authorization: "Bearer bridge-test-token",
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(completion),
      },
      body: completion,
    });
    assert.equal(bridgeRes.status, 202, bridgeRes.body);

    const deadline = Date.now() + 3000;
    while (received.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(received.length, 1);
    assert.equal(received[0].auth, "Bearer grok-callback-secret");
    assert.deepEqual(received[0].body, {
      source: "openclaw",
      runId: "run-from-hooks",
      status: "ok",
      reply: "The final Gazza reply",
      agentId: "main",
      sessionKey: "hook:gazza:main",
    });
    assert.equal(booted.getLogs().includes("The final Gazza reply"), false);
    assert.equal(booted.getLogs().includes("grok-callback-secret"), false);

    const ordinary = JSON.stringify({
      sessionKey: "agent:main:main",
      agentId: "main",
      reply: "ordinary chat",
      success: true,
    });
    const ignored = await httpRequest({
      port: bridgePort,
      method: "POST",
      path: "/callback",
      headers: {
        Authorization: "Bearer bridge-test-token",
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(ordinary),
      },
      body: ordinary,
    });
    assert.equal(ignored.status, 202);
    assert.match(ignored.body, /ignored/);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(received.length, 1);
  } finally {
    await booted.stop();
    await new Promise((resolve) => callback.close(resolve));
  }
});
