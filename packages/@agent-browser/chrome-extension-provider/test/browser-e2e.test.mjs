import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import WebSocket from "ws";

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const rootDir = resolve(packageDir, "../../..");
const extensionDir = join(packageDir, ".output", "chrome-mv3");
const daemonScript = join(packageDir, "dist", "daemon", "cli.js");
const agentBrowserCli = join(rootDir, "bin", "agent-browser.js");
const pinnedExtensionId = "pimcamjccpkgapdpecfiadkemnggggbj";

test("Chrome extension bridge drives a real Chrome for Testing profile", async (t) => {
  const chromePath = findChromeForTesting();
  if (!chromePath) {
    t.skip("Chrome for Testing or Chromium not found. Run `agent-browser install` or set AGENT_BROWSER_E2E_CHROME.");
    return;
  }
  assert.equal(existsSync(join(extensionDir, "manifest.json")), true, "extension build is missing; run package build first");

  const tmp = await mkdtemp(join("/tmp", "abce-"));
  const profileDir = join(tmp, "chrome-profile");
  const socketDir = join(tmp, "s");
  const screenshotPath = join(tmp, "bridge-e2e.png");
  mkdirSync(profileDir);
  mkdirSync(socketDir);

  const bridgePort = Number(process.env.AGENT_BROWSER_E2E_BRIDGE_PORT ?? 19826);
  assert.equal(await isPortOpen(bridgePort), false, `bridge e2e port ${bridgePort} is already in use`);
  const fixture = await startFixtureServer();
  const pageUrls = fixture.urls;
  const session = "ce";
  const commonEnv = {
    ...process.env,
    AGENT_BROWSER_CHROME_BRIDGE_PORT: String(bridgePort),
    AGENT_BROWSER_CHROME_BRIDGE_EXTENSION_ID: pinnedExtensionId,
    AGENT_BROWSER_PLUGINS: JSON.stringify([
      {
        name: "chrome-extension",
        command: process.execPath,
        args: [join(packageDir, "dist", "plugin.js")],
        capabilities: ["browser.provider", "command.run", "chrome-extension.manage"],
      },
    ]),
    AGENT_BROWSER_SOCKET_DIR: socketDir,
    // Real extension round-trips can cross the native daemon's one-second
    // idle boundary between independent CLI invocations. Keep the session
    // alive for the full scenario; the explicit close/finally block owns
    // deterministic cleanup.
    AGENT_BROWSER_IDLE_TIMEOUT_MS: "30000",
  };

  const daemon = spawn(process.execPath, [daemonScript], {
    env: commonEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const chrome = spawn(chromePath, chromeArgs(profileDir), {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let opened = false;
  let mockBridge;
  let daemonStderr = "";
  let chromeStderr = "";

  try {
    daemon.stderr.on("data", (chunk) => {
      daemonStderr += chunk;
      process.stderr.write(chunk);
    });
    chrome.stderr.on("data", (chunk) => {
      chromeStderr += chunk;
      if (process.env.AGENT_BROWSER_E2E_CHROME_LOG) process.stderr.write(chunk);
    });

    await waitFor(async () => {
      const health = await fetchJson(`http://127.0.0.1:${bridgePort}/health`).catch(() => null);
      return health?.daemon === "ok";
    }, "bridge daemon to start");

    const requireRealExtension = process.env.AGENT_BROWSER_E2E_REQUIRE_REAL_EXTENSION === "1";
    const extensionWaitMs = Number(
      process.env.AGENT_BROWSER_E2E_EXTENSION_WAIT_MS ?? (requireRealExtension ? 60_000 : 5_000),
    );
    const realExtensionConnected = await waitForMaybe(async () => {
      const health = await fetchJson(`http://127.0.0.1:${bridgePort}/health`).catch(() => null);
      return Array.isArray(health?.profiles) && health.profiles.length === 1;
    }, extensionWaitMs);

    if (!realExtensionConnected) {
      if (requireRealExtension) {
        throw new Error(
          "The built Chrome extension did not connect; refusing the mock fallback because AGENT_BROWSER_E2E_REQUIRE_REAL_EXTENSION=1",
        );
      }
      const devtoolsPort = await waitForDevToolsPort(profileDir);
      mockBridge = await MockExtensionBridge.connect({ bridgePort, devtoolsPort });
      commonEnv.AGENT_BROWSER_CHROME_BRIDGE_PROFILE = mockBridge.profileId;
      t.diagnostic("built extension unavailable; exercising the bridge against real Chrome through the explicit mock fallback");
    } else {
      t.diagnostic("built extension connected to the bridge daemon");
    }

    await waitFor(
      async () => {
        const health = await fetchJson(`http://127.0.0.1:${bridgePort}/health`).catch(() => null);
        return Array.isArray(health?.profiles) && health.profiles.length >= 1;
      },
      "extension profile to connect",
      () => `daemon stderr:\n${daemonStderr}\nchrome stderr:\n${chromeStderr}`,
    );

    const status = await runAgentBrowser(["--json", "plugin", "run", "chrome-extension", "chrome-extension.status"], commonEnv);
    assert.equal(status.success, true);
    assert.equal(status.data.daemon, "ok");
    assert.equal(status.data.profiles.length >= 1, true);

    const pageUrl = pageUrls.main;
    let open;
    try {
      open = await runAgentBrowser(["--json", "--session", session, "--provider", "chrome-extension", "open", pageUrl], commonEnv);
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}
mock bridge commands:
${mockBridge?.commandLog.join("\n") ?? "(real extension)"}`);
    }
    assert.equal(open.success, true);
    opened = true;

    const snapshot = await runAgentBrowser(["--json", "--session", session, "--provider", "chrome-extension", "snapshot", "-i"], commonEnv);
    assert.equal(snapshot.success, true);
    assert.match(JSON.stringify(snapshot.data), /Bridge E2E/);
    assert.match(JSON.stringify(snapshot.data), /Save/);

    const fill = await runAgentBrowser(["--json", "--session", session, "--provider", "chrome-extension", "fill", "#name", "Ada"], commonEnv);
    assert.equal(fill.success, true);

    const filledValue = await runAgentBrowser([
      "--json",
      "--session",
      session,
      "--provider",
      "chrome-extension",
      "eval",
      "document.getElementById('name').value",
    ], commonEnv);
    assert.equal(filledValue.success, true);
    assert.match(JSON.stringify(filledValue.data), /Ada/);

    const hitTest = await runAgentBrowser([
      "--json",
      "--session",
      session,
      "--provider",
      "chrome-extension",
      "eval",
      "(() => { const e = document.getElementById('save'); const r = e.getBoundingClientRect(); return { rect: { x: r.x, y: r.y, width: r.width, height: r.height }, hitId: document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.id }; })()",
    ], commonEnv);
    assert.equal(hitTest.success, true);
    assert.match(JSON.stringify(hitTest.data), /save/);

    const click = await runAgentBrowser(["--json", "--session", session, "--provider", "chrome-extension", "click", "#save"], commonEnv);
    assert.equal(click.success, true);

    const clickEvents = await runAgentBrowser([
      "--json",
      "--session",
      session,
      "--provider",
      "chrome-extension",
      "eval",
      "window.__bridgeE2eMouseEvents",
    ], commonEnv);
    assert.equal(clickEvents.success, true);
    assert.match(JSON.stringify(clickEvents.data), /click/);

    const settled = await runAgentBrowser([
      "--json",
      "--session",
      session,
      "--provider",
      "chrome-extension",
      "wait",
      "--text",
      "saved Ada",
    ], commonEnv);
    assert.equal(settled.success, true);

    const result = await runAgentBrowser([
      "--json",
      "--session",
      session,
      "--provider",
      "chrome-extension",
      "eval",
      "document.getElementById('result').textContent",
    ], commonEnv);
    assert.equal(result.success, true);
    assert.match(JSON.stringify(result.data), /saved Ada/);

    const screenshot = await runAgentBrowser(["--json", "--session", session, "--provider", "chrome-extension", "screenshot", screenshotPath], commonEnv);
    assert.equal(screenshot.success, true);
    assert.equal(statSync(screenshotPath).size > 1000, true);

    const tab = await runAgentBrowser(["--json", "--session", session, "--provider", "chrome-extension", "tab", "new", pageUrls.second], commonEnv);
    assert.equal(tab.success, true);

    const title = await runAgentBrowser(["--json", "--session", session, "--provider", "chrome-extension", "get", "title"], commonEnv);
    assert.equal(title.success, true);
    assert.match(JSON.stringify(title.data), /Second Page/);
  } finally {
    if (opened) {
      await runAgentBrowser(["--json", "--session", session, "--provider", "chrome-extension", "close"], commonEnv).catch(() => undefined);
    }
    await mockBridge?.close();
    await terminateChild(chrome);
    await terminateChild(daemon);
    await fixture.close();
    rmSync(tmp, { force: true, recursive: true });
  }
});

function chromeArgs(profileDir) {
  const args = [
    `--user-data-dir=${profileDir}`,
    "--remote-debugging-port=0",
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-default-apps",
    "--disable-popup-blocking",
    "--no-proxy-server",
    "--proxy-bypass-list=*",
    "about:blank",
  ];
  if (process.env.AGENT_BROWSER_E2E_HEADLESS === "1") {
    args.unshift("--headless=new");
  }
  return args;
}

class MockExtensionBridge {
  constructor({ bridgePort, devtoolsPort, bridge, profileId }) {
    this.bridgePort = bridgePort;
    this.devtoolsPort = devtoolsPort;
    this.bridge = bridge;
    this.profileId = profileId;
    this.targetClients = new Map();
    this.targetIdsByTabId = new Map();
    this.tabIdsByTargetId = new Map();
    this.sessionIdsByTabId = new Map();
    this.commandLog = [];
    this.nextTabId = 1;
    this.activeTargetId = undefined;
  }

  static async connect({ bridgePort, devtoolsPort }) {
    const bridge = new WebSocket(`ws://127.0.0.1:${bridgePort}/bridge`, {
      headers: { Origin: `chrome-extension://${pinnedExtensionId}` },
    });
    await waitForWebSocketOpen(bridge);
    const instance = new MockExtensionBridge({
      bridgePort,
      devtoolsPort,
      bridge,
      profileId: `browser-e2e-mock-${process.pid}-${Date.now()}`,
    });
    bridge.on("message", (raw) => {
      void instance.handleBridgeMessage(raw);
    });
    const version = await instance.browserVersion();
    await instance.refreshTabs();
    instance.bridge.send(JSON.stringify({
      v: 1,
      kind: "hello",
      profileId: instance.profileId,
      extensionId: pinnedExtensionId,
      chromeVersion: version,
      tabs: await instance.tabs(),
    }));
    instance.heartbeatTimer = setInterval(() => {
      void instance.sendHeartbeat();
    }, 500);
    return instance;
  }

  async close() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    for (const client of this.targetClients.values()) {
      client.close();
    }
    if (this.bridge.readyState === WebSocket.OPEN || this.bridge.readyState === WebSocket.CONNECTING) {
      this.bridge.close();
    }
  }

  async handleBridgeMessage(raw) {
    const message = JSON.parse(raw.toString());
    if (message.v !== 1 || message.kind !== "cdp-command") return;
    this.commandLog.push(`${message.reqId} ${message.method} tab=${message.tabId ?? ""}`);
    try {
      const result = await this.executeCommand(message);
      this.bridge.send(JSON.stringify({ v: 1, kind: "cdp-result", reqId: message.reqId, result }));
    } catch (error) {
      this.bridge.send(JSON.stringify({
        v: 1,
        kind: "cdp-result",
        reqId: message.reqId,
        error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
      }));
    } finally {
      await this.sendHeartbeat();
    }
  }

  async executeCommand(command) {
    if (command.method === "Bridge.createTab" || command.method === "Bridge.createWindow") {
      const url = typeof command.params?.url === "string" ? command.params.url : "about:blank";
      const target = await this.devtoolsJson(`/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
      this.activeTargetId = target.id;
      await this.refreshTabs();
      return this.tabForTarget(target);
    }
    if (command.method === "Bridge.activateTab") {
      const targetId = this.targetIdsByTabId.get(command.params?.tabId);
      if (!targetId) throw new Error(`Unknown tab id: ${command.params?.tabId}`);
      await this.devtoolsText(`/json/activate/${targetId}`);
      this.activeTargetId = targetId;
      await this.refreshTabs();
      return {};
    }
    if (command.method === "Bridge.closeTab") {
      const targetId = this.targetIdsByTabId.get(command.params?.tabId);
      if (!targetId) return { success: true };
      await this.devtoolsText(`/json/close/${targetId}`);
      this.targetClients.get(targetId)?.close();
      this.targetClients.delete(targetId);
      this.targetIdsByTabId.delete(command.params?.tabId);
      this.tabIdsByTargetId.delete(targetId);
      await this.refreshTabs();
      return { success: true };
    }
    if (command.method === "Bridge.setControlOverlay") {
      const tabId = command.tabId ?? command.params?.tabId;
      if (typeof tabId !== "number") throw new Error("Bridge.setControlOverlay is missing tabId");
      if (command.sessionId) this.sessionIdsByTabId.set(tabId, command.sessionId);
      return { visible: true, phase: command.params?.phase };
    }
    if (command.method === "Bridge.detachTab") {
      const tabId = command.tabId ?? command.params?.tabId;
      if (typeof tabId !== "number") throw new Error("Bridge.detachTab is missing tabId");
      const targetId = this.targetIdsByTabId.get(tabId);
      if (targetId) {
        this.targetClients.get(targetId)?.close();
        this.targetClients.delete(targetId);
      }
      this.sessionIdsByTabId.delete(tabId);
      return { detached: true };
    }
    if (typeof command.tabId !== "number") {
      throw new Error(`${command.method} is missing tabId`);
    }
    if (command.sessionId) {
      this.sessionIdsByTabId.set(command.tabId, command.sessionId);
    }
    const targetId = this.targetIdsByTabId.get(command.tabId);
    if (!targetId) throw new Error(`Unknown tab id: ${command.tabId}`);
    const target = await this.targetById(targetId);
    const client = await this.clientForTarget(target);
    const result = await client.call(command.method, command.params ?? {});
    if (command.method === "Page.navigate" && typeof command.params?.url === "string") {
      await waitForMaybe(async () => {
        const navigated = await this.targetById(targetId).catch(() => null);
        return navigated?.url === command.params.url;
      }, 5_000);
      this.forwardEvent(command.tabId, "Page.domContentEventFired", { timestamp: Date.now() / 1000 });
      this.forwardEvent(command.tabId, "Page.loadEventFired", { timestamp: Date.now() / 1000 });
      await this.sendHeartbeat();
    }
    return result;
  }

  async browserVersion() {
    const version = await this.devtoolsJson("/json/version");
    const product = typeof version.Browser === "string" ? version.Browser : "";
    return product.split("/")[1];
  }

  async sendHeartbeat() {
    if (this.bridge.readyState !== WebSocket.OPEN) return;
    this.bridge.send(JSON.stringify({
      v: 1,
      kind: "heartbeat",
      profileId: this.profileId,
      tabs: await this.tabs(),
    }));
  }

  async tabs() {
    const targets = await this.refreshTabs();
    return targets.map((target) => this.tabForTarget(target));
  }

  async refreshTabs() {
    const targets = (await this.devtoolsJson("/json/list")).filter((target) => target.type === "page");
    for (const target of targets) {
      this.tabIdForTarget(target);
    }
    if (!this.activeTargetId || !targets.some((target) => target.id === this.activeTargetId)) {
      this.activeTargetId = targets[0]?.id;
    }
    return targets;
  }

  tabForTarget(target) {
    return {
      tabId: this.tabIdForTarget(target),
      windowId: 1,
      url: target.url ?? "",
      title: target.title ?? "",
      active: target.id === this.activeTargetId,
    };
  }

  tabIdForTarget(target) {
    const existing = this.tabIdsByTargetId.get(target.id);
    if (existing) return existing;
    const tabId = this.nextTabId++;
    this.tabIdsByTargetId.set(target.id, tabId);
    this.targetIdsByTabId.set(tabId, target.id);
    return tabId;
  }

  async targetById(targetId) {
    const targets = await this.refreshTabs();
    const target = targets.find((candidate) => candidate.id === targetId);
    if (!target) throw new Error(`Target is not available: ${targetId}`);
    return target;
  }

  async clientForTarget(target) {
    const existing = this.targetClients.get(target.id);
    if (existing) return existing;
    const tabId = this.tabIdForTarget(target);
    const client = await DevtoolsTargetClient.connect(target.webSocketDebuggerUrl, (method, params) => {
      this.forwardEvent(tabId, method, params);
    });
    this.targetClients.set(target.id, client);
    return client;
  }

  forwardEvent(tabId, method, params) {
    if (this.bridge.readyState !== WebSocket.OPEN) return;
    this.bridge.send(JSON.stringify({
      v: 1,
      kind: "cdp-event",
      profileId: this.profileId,
      tabId,
      sessionId: this.sessionIdsByTabId.get(tabId),
      method,
      params,
    }));
  }

  async devtoolsJson(path, options) {
    const response = await fetch(`http://127.0.0.1:${this.devtoolsPort}${path}`, options);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return await response.json();
  }

  async devtoolsText(path, options) {
    const response = await fetch(`http://127.0.0.1:${this.devtoolsPort}${path}`, options);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return await response.text();
  }
}

class DevtoolsTargetClient {
  constructor(ws, onEvent) {
    this.ws = ws;
    this.onEvent = onEvent;
    this.nextId = 1;
    this.pending = new Map();
    ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (typeof message.id !== "number") {
        if (message.method) this.onEvent?.(message.method, message.params ?? {});
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      } else {
        pending.resolve(message.result ?? {});
      }
    });
    ws.on("close", () => {
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timeout);
        pending.reject(new Error("DevTools target closed"));
        this.pending.delete(id);
      }
    });
  }

  static async connect(url, onEvent) {
    const ws = new WebSocket(url);
    await waitForWebSocketOpen(ws);
    return new DevtoolsTargetClient(ws, onEvent);
  }

  call(method, params) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for DevTools response to ${method}`));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timeout });
    });
  }

  close() {
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.close();
    }
  }
}

function findChromeForTesting() {
  if (process.env.AGENT_BROWSER_E2E_CHROME && existsSync(process.env.AGENT_BROWSER_E2E_CHROME)) {
    return process.env.AGENT_BROWSER_E2E_CHROME;
  }
  const candidates = [];
  if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    );
  }
  if (process.platform === "linux") {
    candidates.push("/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome-for-testing");
  }
  if (process.platform === "win32") {
    candidates.push(
      "C:\\Program Files\\Google\\Chrome for Testing\\Application\\chrome.exe",
      "C:\\Program Files\\Chromium\\Application\\chrome.exe",
    );
  }
  candidates.push(...installedAgentBrowserChromes());
  return candidates.find((candidate) => existsSync(candidate));
}

function installedAgentBrowserChromes() {
  const browsersDir = join(homedir(), ".agent-browser", "browsers");
  if (!existsSync(browsersDir)) return [];
  return readdirSync(browsersDir)
    .filter((name) => name.startsWith("chrome-"))
    .sort()
    .reverse()
    .flatMap((name) => {
      const versionDir = join(browsersDir, name);
      if (process.platform === "darwin") {
        return [
          join(versionDir, "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"),
          join(versionDir, "chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"),
          join(versionDir, "chrome-mac-x64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"),
        ];
      }
      if (process.platform === "linux") {
        return [join(versionDir, "chrome-linux64", "chrome")];
      }
      if (process.platform === "win32") {
        return [join(versionDir, "chrome-win64", "chrome.exe")];
      }
      return [];
    });
}

async function runAgentBrowser(args, env) {
  const { stdout, stderr } = await execFilePromise(process.execPath, [agentBrowserCli, ...args], {
    cwd: rootDir,
    env,
    timeout: 30_000,
  });
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`agent-browser returned non-JSON output\nstdout:\n${stdout}\nstderr:\n${stderr}\n${String(error)}`);
  }
}

function execFilePromise(file, args, options) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`command failed: ${file} ${args.join(" ")}
exit code: ${error.code ?? "unknown"}
signal: ${error.signal ?? "none"}
killed: ${error.killed ? "true" : "false"}
stdout:
${stdout}
stderr:
${stderr}
message:
${error.message}`));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

async function startFixtureServer() {
  const pages = new Map([
    ["/", `<!doctype html>
      <title>Bridge E2E</title>
      <script>
        window.__bridgeE2eMouseEvents = [];
        for (const type of ["mousemove", "mousedown", "mouseup", "click"]) {
          document.addEventListener(type, (event) => {
            window.__bridgeE2eMouseEvents.push({ type, target: event.target.id, x: event.clientX, y: event.clientY });
          }, true);
        }
      </script>
      <main>
        <h1>Bridge E2E</h1>
        <label>Name <input id="name" /></label>
        <button id="save" onclick="document.getElementById('result').textContent = 'saved ' + document.getElementById('name').value">Save</button>
        <p id="result" aria-live="polite">pending</p>
      </main>`],
    ["/second", "<!doctype html><title>Second Page</title><h1>Second Page</h1>"],
  ]);
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const page = pages.get(path);
    if (!page) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("not found");
      return;
    }
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": "text/html; charset=utf-8",
    });
    response.end(page);
  });
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.notEqual(address, null);
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    urls: { main: `${origin}/`, second: `${origin}/second` },
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

async function isPortOpen(port) {
  const server = createServer();
  return await new Promise((resolve) => {
    server.once("error", () => resolve(true));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(false));
    });
  });
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return await response.json();
}

async function waitForMaybe(check, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return true;
    await delay(250);
  }
  return false;
}

async function waitForDevToolsPort(profileDir) {
  const started = Date.now();
  while (Date.now() - started < 20_000) {
    const path = join(profileDir, "DevToolsActivePort");
    if (existsSync(path)) {
      const port = Number(readFileSync(path, "utf8").split("\n")[0]);
      if (Number.isInteger(port) && port > 0) return port;
    }
    await delay(250);
  }
  throw new Error("timed out waiting for Chrome DevTools port");
}

async function waitForWebSocketOpen(ws) {
  if (ws.readyState === WebSocket.OPEN) return;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for WebSocket to open")), 10_000);
    ws.once("open", () => {
      clearTimeout(timeout);
      resolve();
    });
    ws.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function waitFor(check, label, details) {
  const started = Date.now();
  while (Date.now() - started < 20_000) {
    if (await check()) return;
    await delay(250);
  }
  throw new Error(`timed out waiting for ${label}${details ? `\n${details()}` : ""}`);
}

async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function terminateChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const closed = await Promise.race([
    new Promise((resolve) => child.once("close", resolve)).then(() => true),
    delay(2000).then(() => false),
  ]);
  if (!closed) {
    child.kill("SIGKILL");
    await Promise.race([
      new Promise((resolve) => child.once("close", resolve)),
      delay(2000),
    ]);
  }
  child.stdout?.destroy();
  child.stderr?.destroy();
}
