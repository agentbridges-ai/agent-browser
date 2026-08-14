import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { PINNED_CHROME_EXTENSION_ID } from "../dist/config.js";
import { BridgeDaemon } from "../dist/daemon/server.js";
import { handlePluginRequest } from "../dist/plugin.js";

const TEST_CONTROL_TOKEN = "a".repeat(64);
const TEST_SESSION_GRANT_SECRET = "b".repeat(64);

function sessionGrant() {
  const iat = Math.floor(Date.now() / 1000);
  const encoded = Buffer.from(
    JSON.stringify({
      v: 2,
      grantId: randomUUID(),
      ownerSessionId: "nex-aaaaaaaaaaaaaaaa",
      profileUrlHint: "/session/674fb240-55e4-427e-a544-60c5b22226f0",
      returnOrigin: "http://127.0.0.1:3458",
      iat,
      exp: iat + 120,
    }),
  ).toString("base64url");
  return `${encoded}.${createHmac("sha256", TEST_SESSION_GRANT_SECRET).update(encoded).digest("base64url")}`;
}

test("plugin manifest declares provider and management capabilities", async () => {
  const response = await handlePluginRequest({
    protocol: "agent-browser.plugin.v1",
    type: "plugin.manifest",
    capability: "plugin.manifest",
    request: {},
  });
  assert.equal(response.success, true);
  assert.equal(response.manifest.name, "chrome-extension");
  assert.deepEqual(response.manifest.capabilities, [
    "browser.provider",
    "command.run",
    "chrome-extension.manage",
  ]);
});

test("plugin executable emits JSON when its filesystem path contains spaces", () => {
  const output = execFileSync(process.execPath, [fileURLToPath(new URL("../dist/plugin.js", import.meta.url))], {
    encoding: "utf8",
    input: JSON.stringify({
      protocol: "agent-browser.plugin.v1",
      type: "plugin.manifest",
      capability: "plugin.manifest",
      request: {},
    }),
  });
  assert.equal(JSON.parse(output).success, true);
});

test("plugin status reports offline daemon without failing", async () => {
  const oldPort = process.env.AGENT_BROWSER_CHROME_BRIDGE_PORT;
  process.env.AGENT_BROWSER_CHROME_BRIDGE_PORT = String(await freePort());
  try {
    const response = await handlePluginRequest({
      protocol: "agent-browser.plugin.v1",
      type: "chrome-extension.status",
      capability: "chrome-extension.manage",
      request: {},
    });
    assert.equal(response.success, true);
    assert.equal(response.data.daemon, "offline");
    assert.equal(typeof response.data.extensionPath, "string");
  } finally {
    restoreEnv("AGENT_BROWSER_CHROME_BRIDGE_PORT", oldPort);
  }
});

test("plugin launch returns a CDP URL after an extension profile connects", async () => {
  const port = await freePort();
  const oldPort = process.env.AGENT_BROWSER_CHROME_BRIDGE_PORT;
  const oldProfileUrlHint = process.env.AGENT_BROWSER_CHROME_BRIDGE_PROFILE_URL_HINT;
  const oldOwnerSessionId = process.env.NEXOLYRA_AGENT_BROWSER_SESSION_ID;
  const oldSessionGrant = process.env.NEXOLYRA_AGENT_BROWSER_SESSION_GRANT;
  process.env.AGENT_BROWSER_CHROME_BRIDGE_PORT = String(port);
  process.env.AGENT_BROWSER_CHROME_BRIDGE_PROFILE_URL_HINT =
    "/session/674fb240-55e4-427e-a544-60c5b22226f0";
  process.env.NEXOLYRA_AGENT_BROWSER_SESSION_ID = "nex-aaaaaaaaaaaaaaaa";
  process.env.NEXOLYRA_AGENT_BROWSER_SESSION_GRANT = sessionGrant();
  const daemon = new BridgeDaemon({
    port,
    commandTimeoutMs: 5000,
    allowedExtensionId: PINNED_CHROME_EXTENSION_ID,
    controlToken: TEST_CONTROL_TOKEN,
    sessionGrantSecret: TEST_SESSION_GRANT_SECRET,
  });
  await daemon.start();
  const extension = new WebSocket(`ws://127.0.0.1:${port}/bridge`, {
    headers: { Origin: `chrome-extension://${PINNED_CHROME_EXTENSION_ID}` },
  });
  await onceOpen(extension);
  extension.send(
    JSON.stringify({
      v: 1,
      kind: "hello",
      profileId: "profile-a",
      extensionId: PINNED_CHROME_EXTENSION_ID,
      tabs: [{ tabId: 1, url: "https://example.com", title: "Example", active: true }],
    }),
  );

  try {
    const response = await handlePluginRequest({
      protocol: "agent-browser.plugin.v1",
      type: "browser.launch",
      capability: "browser.provider",
      request: {},
    });
    assert.equal(response.success, true);
    assert.match(
      response.browser.cdpUrl,
      new RegExp(`^ws://127\\.0\\.0\\.1:${port}/devtools/browser/bridge`),
    );
    assert.equal(response.browser.directPage, false);
    assert.equal(response.browser.cleanup.port, port);
    assert.equal(daemon.status().sessions[0].ownerSessionId, "nex-aaaaaaaaaaaaaaaa");

    const close = await handlePluginRequest({
      protocol: "agent-browser.plugin.v1",
      type: "browser.close",
      capability: "browser.provider",
      request: response.browser.cleanup,
    });
    assert.equal(close.success, true);
  } finally {
    extension.close();
    await daemon.stop();
    restoreEnv("AGENT_BROWSER_CHROME_BRIDGE_PORT", oldPort);
    restoreEnv("AGENT_BROWSER_CHROME_BRIDGE_PROFILE_URL_HINT", oldProfileUrlHint);
    restoreEnv("NEXOLYRA_AGENT_BROWSER_SESSION_ID", oldOwnerSessionId);
    restoreEnv("NEXOLYRA_AGENT_BROWSER_SESSION_GRANT", oldSessionGrant);
  }
});

test("plugin obtains a fresh owner grant from the helper for every launch", async () => {
  const port = await freePort();
  const root = mkdtempSync(join(tmpdir(), "agent-browser-grant-helper-"));
  const helper = join(root, "grant-helper");
  const counter = join(root, "counter");
  const oldPort = process.env.AGENT_BROWSER_CHROME_BRIDGE_PORT;
  const oldProfileUrlHint = process.env.AGENT_BROWSER_CHROME_BRIDGE_PROFILE_URL_HINT;
  const oldOwnerSessionId = process.env.NEXOLYRA_AGENT_BROWSER_SESSION_ID;
  const oldSessionGrant = process.env.NEXOLYRA_AGENT_BROWSER_SESSION_GRANT;
  const oldSessionGrantHelper = process.env.NEXOLYRA_AGENT_BROWSER_SESSION_GRANT_HELPER;
  writeFileSync(
    helper,
    `#!/usr/bin/env node\nconst { readFileSync, writeFileSync } = require("node:fs");\nconst path = ${JSON.stringify(counter)};\nconst count = Number(readFileSync(path, "utf8")) + 1;\nwriteFileSync(path, String(count));\nprocess.stdout.write(process.env.TEST_SESSION_GRANT || "");\n`,
    { mode: 0o700 },
  );
  writeFileSync(counter, "0");
  process.env.AGENT_BROWSER_CHROME_BRIDGE_PORT = String(port);
  process.env.AGENT_BROWSER_CHROME_BRIDGE_PROFILE_URL_HINT =
    "/session/674fb240-55e4-427e-a544-60c5b22226f0";
  process.env.NEXOLYRA_AGENT_BROWSER_SESSION_ID = "nex-aaaaaaaaaaaaaaaa";
  delete process.env.NEXOLYRA_AGENT_BROWSER_SESSION_GRANT;
  process.env.NEXOLYRA_AGENT_BROWSER_SESSION_GRANT_HELPER = helper;
  process.env.TEST_SESSION_GRANT = sessionGrant();
  const daemon = new BridgeDaemon({
    port,
    commandTimeoutMs: 5000,
    allowedExtensionId: PINNED_CHROME_EXTENSION_ID,
    controlToken: TEST_CONTROL_TOKEN,
    sessionGrantSecret: TEST_SESSION_GRANT_SECRET,
  });
  await daemon.start();
  const extension = new WebSocket(`ws://127.0.0.1:${port}/bridge`, {
    headers: { Origin: `chrome-extension://${PINNED_CHROME_EXTENSION_ID}` },
  });
  await onceOpen(extension);
  extension.send(
    JSON.stringify({
      v: 1,
      kind: "hello",
      profileId: "profile-a",
      extensionId: PINNED_CHROME_EXTENSION_ID,
      tabs: [{ tabId: 1, url: "https://example.com", title: "Example", active: true }],
    }),
  );

  try {
    const first = await handlePluginRequest({
      protocol: "agent-browser.plugin.v1",
      type: "browser.launch",
      capability: "browser.provider",
      request: {},
    });
    assert.equal(first.success, true);
    await handlePluginRequest({
      protocol: "agent-browser.plugin.v1",
      type: "browser.close",
      capability: "browser.provider",
      request: first.browser.cleanup,
    });
    process.env.TEST_SESSION_GRANT = sessionGrant();
    const second = await handlePluginRequest({
      protocol: "agent-browser.plugin.v1",
      type: "browser.launch",
      capability: "browser.provider",
      request: {},
    });
    assert.equal(second.success, true);
    assert.equal(readFileSync(counter, "utf8"), "2");
    process.env.NEXOLYRA_AGENT_BROWSER_SESSION_GRANT = sessionGrant();
    writeFileSync(helper, "#!/usr/bin/env node\nprocess.exit(1);\n");
    await assert.rejects(
      handlePluginRequest({
        protocol: "agent-browser.plugin.v1",
        type: "browser.launch",
        capability: "browser.provider",
        request: {},
      }),
      /session grant helper failed/,
    );
  } finally {
    extension.close();
    await daemon.stop();
    rmSync(root, { recursive: true, force: true });
    restoreEnv("AGENT_BROWSER_CHROME_BRIDGE_PORT", oldPort);
    restoreEnv("AGENT_BROWSER_CHROME_BRIDGE_PROFILE_URL_HINT", oldProfileUrlHint);
    restoreEnv("NEXOLYRA_AGENT_BROWSER_SESSION_ID", oldOwnerSessionId);
    restoreEnv("NEXOLYRA_AGENT_BROWSER_SESSION_GRANT", oldSessionGrant);
    restoreEnv("NEXOLYRA_AGENT_BROWSER_SESSION_GRANT_HELPER", oldSessionGrantHelper);
    delete process.env.TEST_SESSION_GRANT;
  }
});

test("plugin refuses to reuse a daemon without the pinned extension boundary", async () => {
  const port = await freePort();
  const oldPort = process.env.AGENT_BROWSER_CHROME_BRIDGE_PORT;
  process.env.AGENT_BROWSER_CHROME_BRIDGE_PORT = String(port);
  const daemon = new BridgeDaemon({
    port,
    commandTimeoutMs: 5000,
    controlToken: TEST_CONTROL_TOKEN,
    sessionGrantSecret: TEST_SESSION_GRANT_SECRET,
  });
  await daemon.start();

  try {
    await assert.rejects(
      handlePluginRequest({
        protocol: "agent-browser.plugin.v1",
        type: "browser.launch",
        capability: "browser.provider",
        request: {},
      }),
      /not pinned to extension/,
    );
    assert.equal((await (await fetch(`http://127.0.0.1:${port}/health`)).json()).daemon, "ok");
  } finally {
    await daemon.stop();
    restoreEnv("AGENT_BROWSER_CHROME_BRIDGE_PORT", oldPort);
  }
});

async function onceOpen(ws) {
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

function restoreEnv(name, oldValue) {
  if (oldValue === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = oldValue;
  }
}
