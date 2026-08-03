import assert from "node:assert/strict";
import { createServer } from "node:net";
import { test } from "node:test";
import WebSocket from "ws";
import { PINNED_CHROME_EXTENSION_ID } from "../dist/config.js";
import { BridgeDaemon } from "../dist/daemon/server.js";
import { handlePluginRequest } from "../dist/plugin.js";

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
  process.env.AGENT_BROWSER_CHROME_BRIDGE_PORT = String(port);
  process.env.AGENT_BROWSER_CHROME_BRIDGE_PROFILE_URL_HINT =
    "/session/674fb240-55e4-427e-a544-60c5b22226f0";
  process.env.NEXOLYRA_AGENT_BROWSER_SESSION_ID = "nex-aaaaaaaaaaaaaaaa";
  const daemon = new BridgeDaemon({
    port,
    commandTimeoutMs: 5000,
    allowedExtensionId: PINNED_CHROME_EXTENSION_ID,
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
    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    assert.equal(health.sessions[0].ownerSessionId, "nex-aaaaaaaaaaaaaaaa");
    assert.equal("profileUrlHint" in health.sessions[0], false);

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
  }
});

test("plugin refuses to reuse a daemon without the pinned extension boundary", async () => {
  const port = await freePort();
  const oldPort = process.env.AGENT_BROWSER_CHROME_BRIDGE_PORT;
  process.env.AGENT_BROWSER_CHROME_BRIDGE_PORT = String(port);
  const daemon = new BridgeDaemon({ port, commandTimeoutMs: 5000 });
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
