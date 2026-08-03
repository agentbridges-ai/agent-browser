import assert from "node:assert/strict";
import { createServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import WebSocket from "ws";
import { parseExtensionId, readBridgeConfig } from "../dist/config.js";
import { BridgeDaemon } from "../dist/daemon/server.js";

test("extension allowlist configuration accepts only canonical Chrome ids", () => {
  assert.equal(parseExtensionId(undefined), undefined);
  assert.equal(
    parseExtensionId(" pimcamjccpkgapdpecfiadkemnggggbj "),
    "pimcamjccpkgapdpecfiadkemnggggbj",
  );
  assert.throws(() => parseExtensionId("extension-id"), /32-character Chrome extension id/);
});

test("daemon state defaults to the fixed agent-browser user directory", () => {
  const expected = join(
    homedir(),
    ".agent-browser",
    "chrome-extension-provider",
    "19826",
    "sessions.json",
  );
  assert.equal(readBridgeConfig({}).statePath, expected);
  assert.equal(
    readBridgeConfig({ AGENT_BROWSER_CHROME_BRIDGE_LOG: "/tmp/custom-bridge.log" }).statePath,
    expected,
  );
  assert.equal(
    readBridgeConfig({ AGENT_BROWSER_CHROME_BRIDGE_STATE: "/tmp/explicit-state.json" }).statePath,
    "/tmp/explicit-state.json",
  );
  assert.deepEqual(readBridgeConfig({ AGENT_BROWSER_CHROME_BRIDGE_STATE: "/tmp/explicit-state.json" }).legacyStatePaths, []);
  assert.deepEqual(
    readBridgeConfig({ AGENT_BROWSER_CHROME_BRIDGE_LOG: "/tmp/legacy/bridge.log" })
      .legacyStatePaths,
    ["/tmp/legacy/sessions.json"],
  );
  assert.equal(
    readBridgeConfig({ AGENT_BROWSER_CHROME_BRIDGE_PORT: "19827" }).statePath,
    join(homedir(), ".agent-browser", "chrome-extension-provider", "19827", "sessions.json"),
  );
});

test("daemon atomically migrates a valid legacy state file to the fixed state path", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-browser-state-migration-"));
  const legacyStatePath = join(root, "legacy", "sessions.json");
  const statePath = join(root, "fixed", "sessions.json");
  mkdirSync(join(root, "legacy"), { recursive: true });
  writeFileSync(
    legacyStatePath,
    `${JSON.stringify({
      schemaVersion: 1,
      sessions: [
        {
          schemaVersion: 1,
          session: {
            sessionId: "legacy-session",
            token: "legacy-token",
            ownerSessionId: "nex-aaaaaaaaaaaaaaaa",
            createdAt: new Date().toISOString(),
          },
          control: {
            phase: "agent",
            epoch: 2,
            updatedAt: new Date().toISOString(),
          },
          targetIds: [],
          savedAt: new Date().toISOString(),
        },
      ],
    })}\n`,
    { encoding: "utf8" },
  );
  const daemon = new BridgeDaemon({
    port: await freePort(),
    statePath,
    legacyStatePaths: [legacyStatePath],
  });

  try {
    assert.equal(daemon.status().sessions[0].sessionId, "legacy-session");
    assert.equal(daemon.status().sessions[0].control.phase, "detached");
    assert.equal(existsSync(statePath), true);
    assert.equal(existsSync(legacyStatePath), false);
  } finally {
    await daemon.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("daemon validates CDP tokens and routes core CDP traffic through the extension bridge", async () => {
  const port = await freePort();
  const daemon = new BridgeDaemon({
    port,
    commandTimeoutMs: 5000,
    supervisedByNexolyra: true,
  });
  await daemon.start();
  const extension = await connectExtension(port, "profile-a", [
    { tabId: 101, windowId: 1, url: "https://example.com", title: "Example", active: true },
  ]);

  try {
    const health = await fetchJson(port, "/health");
    assert.equal(health.supervisedByNexolyra, true);
    assert.equal(health.processId, process.pid);
    await assertInvalidToken(port);

    const session = await postJson(port, "/sessions", {});
    const cdp = await connectCdp(port, session.sessionId, session.token);

    const targets = await cdpCommand(cdp, {
      id: 1,
      method: "Target.getTargets",
      params: {},
    });
    assert.equal(targets.result.targetInfos.length, 1);
    assert.equal(targets.result.targetInfos[0].url, "https://example.com");

    const created = await cdpCommand(cdp, {
      id: 2,
      method: "Target.createTarget",
      params: { url: "https://example.org" },
    });
    assert.match(created.result.targetId, /^tab:profile-a:/);

    const attached = await cdpCommand(cdp, {
      id: 3,
      method: "Target.attachToTarget",
      params: { targetId: created.result.targetId, flatten: true },
    });
    assert.match(attached.result.sessionId, /^session:/);

    const evaluated = await cdpCommand(cdp, {
      id: 4,
      sessionId: attached.result.sessionId,
      method: "Runtime.evaluate",
      params: { expression: "document.title" },
    });
    assert.equal(evaluated.result.result.value, "ok");

    const captured = await cdpCommand(cdp, {
      id: 5,
      sessionId: attached.result.sessionId,
      method: "Page.captureScreenshot",
      params: {
        format: "jpeg",
        quality: 60,
        captureBeyondViewport: false,
      },
    });
    assert.equal(captured.result.data, "base64-frame");
    assert.ok(
      extension.commands.some(
        (command) =>
          command.method === "Page.captureScreenshot" &&
          command.tabId === 202 &&
          command.params.format === "jpeg" &&
          command.params.quality === 60 &&
          command.params.fromSurface === true,
      ),
    );

    const visibleSurfaceFallback = await cdpCommand(cdp, {
      id: 6,
      sessionId: attached.result.sessionId,
      method: "Page.captureScreenshot",
      params: {
        format: "jpeg",
        quality: 55,
        fromSurface: false,
      },
    });
    assert.equal(visibleSurfaceFallback.result.data, "base64-frame");
    assert.ok(
      extension.commands.some(
        (command) =>
          command.method === "Page.captureScreenshot" &&
          command.params.quality === 55 &&
          command.params.fromSurface === false,
      ),
    );

    const closed = await cdpCommand(cdp, {
      id: 7,
      method: "Browser.close",
      params: {},
    });
    assert.deepEqual(closed.result, {});

    cdp.close();
  } finally {
    extension.close();
    await daemon.stop();
  }
});

test("daemon prevents another bridge session from attaching an already controlled tab", async () => {
  const port = await freePort();
  const daemon = new BridgeDaemon({ port, commandTimeoutMs: 5000 });
  await daemon.start();
  const extension = await connectExtension(port, "profile-a", [
    { tabId: 101, windowId: 1, url: "https://example.com", title: "Example", active: true },
  ]);

  try {
    const ownerSession = await postJson(port, "/sessions", {});
    const otherSession = await postJson(port, "/sessions", {});
    const ownerCdp = await connectCdp(port, ownerSession.sessionId, ownerSession.token);
    const otherCdp = await connectCdp(port, otherSession.sessionId, otherSession.token);

    const ownerAttachment = await cdpCommand(ownerCdp, {
      id: 1,
      method: "Target.attachToTarget",
      params: { targetId: "tab:profile-a:101", flatten: true },
    });
    assert.match(ownerAttachment.result.sessionId, /^session:/);

    const rejected = await cdpCommand(otherCdp, {
      id: 2,
      method: "Target.attachToTarget",
      params: { targetId: "tab:profile-a:101", flatten: true },
    });
    assert.match(rejected.error.message, /already controlled by another session/);

    const implicitRejected = await cdpCommand(otherCdp, {
      id: 20,
      method: "Runtime.evaluate",
      params: { expression: "document.title" },
    });
    assert.match(implicitRejected.error.message, /already controlled by another session/);

    const stolenAttachmentRejected = await cdpCommand(otherCdp, {
      id: 21,
      sessionId: ownerAttachment.result.sessionId,
      method: "Runtime.evaluate",
      params: { expression: "document.title" },
    });
    assert.match(stolenAttachmentRejected.error.message, /belongs to another bridge session/);

    const closeRejected = await cdpCommand(otherCdp, {
      id: 22,
      method: "Target.closeTarget",
      params: { targetId: "tab:profile-a:101" },
    });
    assert.match(closeRejected.error.message, /already controlled by another session/);

    const activateRejected = await cdpCommand(otherCdp, {
      id: 23,
      method: "Target.activateTarget",
      params: { targetId: "tab:profile-a:101" },
    });
    assert.match(activateRejected.error.message, /already controlled by another session/);

    const sameOwnerAttachment = await cdpCommand(ownerCdp, {
      id: 3,
      method: "Target.attachToTarget",
      params: { targetId: "tab:profile-a:101", flatten: true },
    });
    assert.match(sameOwnerAttachment.result.sessionId, /^session:/);
    assert.notEqual(sameOwnerAttachment.result.sessionId, ownerAttachment.result.sessionId);

    ownerCdp.close();
    await new Promise((resolve) => ownerCdp.once("close", resolve));
    const reconnectedOwnerCdp = await connectCdp(
      port,
      ownerSession.sessionId,
      ownerSession.token,
    );
    const retainedAfterTransportReconnect = await cdpCommand(reconnectedOwnerCdp, {
      id: 4,
      sessionId: ownerAttachment.result.sessionId,
      method: "Runtime.evaluate",
      params: { expression: "document.title" },
    });
    assert.equal(retainedAfterTransportReconnect.error, undefined);

    await postJson(port, `/sessions/${ownerSession.sessionId}/detach`, {});
    const releasedAfterLifecycleDetach = await cdpCommand(otherCdp, {
      id: 5,
      method: "Target.attachToTarget",
      params: { targetId: "tab:profile-a:101", flatten: true },
    });
    assert.match(releasedAfterLifecycleDetach.result.sessionId, /^session:/);

    reconnectedOwnerCdp.close();
    otherCdp.close();
  } finally {
    extension.close();
    await daemon.stop();
  }
});

test("daemon accepts only the pinned Chrome extension origin and identity", async () => {
  const extensionId = "pimcamjccpkgapdpecfiadkemnggggbj";
  const port = await freePort();
  const daemon = new BridgeDaemon({
    port,
    commandTimeoutMs: 5000,
    allowedExtensionId: extensionId,
  });
  await daemon.start();

  try {
    const health = await fetchJson(port, "/health");
    assert.equal(health.allowedExtensionId, extensionId);
    const extensionOrigin = `chrome-extension://${extensionId}`;
    const trustedHealth = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { Origin: extensionOrigin },
    });
    assert.equal(trustedHealth.status, 200);
    assert.equal(trustedHealth.headers.get("access-control-allow-origin"), extensionOrigin);
    assert.equal(trustedHealth.headers.get("vary"), "Origin");
    const preflight = await fetch(`http://127.0.0.1:${port}/health`, {
      method: "OPTIONS",
      headers: {
        Origin: extensionOrigin,
        "Access-Control-Request-Private-Network": "true",
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), extensionOrigin);
    assert.equal(preflight.headers.get("access-control-allow-private-network"), "true");
    const untrustedPreflight = await fetch(`http://127.0.0.1:${port}/health`, {
      method: "OPTIONS",
      headers: { Origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    });
    assert.equal(untrustedPreflight.status, 403);
    await assertBridgeUpgradeRejected(port);
    await assertBridgeUpgradeRejected(port, "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

    const wrongIdentity = new WebSocket(`ws://127.0.0.1:${port}/bridge`, {
      headers: { Origin: `chrome-extension://${extensionId}` },
    });
    await onceOpen(wrongIdentity);
    const rejected = onceJsonMessage(wrongIdentity);
    wrongIdentity.send(
      JSON.stringify({
        v: 1,
        kind: "hello",
        profileId: "wrong-profile",
        extensionId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        extensionVersion: "0.31.1",
        chromeVersion: "120.0.0.0",
        tabs: [],
      }),
    );
    assert.match((await rejected).message, /not allowed/i);
    wrongIdentity.close();

    const extension = await connectExtension(port, "profile-a", [], {
      extensionId,
      origin: `chrome-extension://${extensionId}`,
    });
    extension.close();
  } finally {
    await daemon.stop();
  }
});

test("malformed HTTP route encoding cannot terminate the bridge daemon", async () => {
  const port = await freePort();
  const daemon = new BridgeDaemon({ port, commandTimeoutMs: 5000 });
  await daemon.start();

  try {
    for (const path of [
      "/control/sessions/%E0%A4%A",
      "/control/sessions/%E0%A4%A/reconnect",
      "/control/sessions/%E0%A4%A/targets",
      "/sessions/%E0%A4%A/detach",
    ]) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: path.endsWith("/targets") ? "GET" : "POST",
        headers: { "content-type": "application/json" },
        body: path.endsWith("/targets") ? undefined : "{}",
      });
      assert.equal(response.status, 400);
    }

    const health = await fetchJson(port, "/health");
    assert.equal(health.daemon, "ok");
  } finally {
    await daemon.stop();
  }
});

test("daemon rejects browser-origin control requests before they can mutate sessions", async () => {
  const port = await freePort();
  const daemon = new BridgeDaemon({ port, commandTimeoutMs: 5000 });
  await daemon.start();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/sessions`, {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        Origin: "https://hostile.example",
      },
      body: "{}",
    });
    assert.equal(response.status, 403);
    assert.equal((await fetchJson(port, "/health")).sessions.length, 0);
  } finally {
    await daemon.stop();
  }
});

test("daemon requires an explicit profile when multiple extension profiles are connected", async () => {
  const port = await freePort();
  const daemon = new BridgeDaemon({ port, commandTimeoutMs: 5000 });
  await daemon.start();
  const first = await connectExtension(port, "profile-a", [
    { tabId: 1, url: "https://a.example", title: "A", active: true },
  ]);
  const second = await connectExtension(port, "profile-b", [
    { tabId: 2, url: "https://b.example", title: "B", active: true },
  ]);

  try {
    const session = await postJson(port, "/sessions", {});
    const cdp = await connectCdp(port, session.sessionId, session.token);
    const response = await cdpCommand(cdp, {
      id: 1,
      method: "Target.getTargets",
      params: {},
    });
    assert.match(response.error.message, /Multiple Chrome extension profiles/);
    cdp.close();
  } finally {
    first.close();
    second.close();
    await daemon.stop();
  }
});

test("daemon selects the owning profile and isolates a host session in its own task window", async () => {
  const port = await freePort();
  const daemon = new BridgeDaemon({
    port,
    commandTimeoutMs: 5000,
    detachedTargetGraceMs: 50,
  });
  await daemon.start();
  const unrelated = await connectExtension(port, "profile-a", [
    { tabId: 1, url: "https://work.example/session/other", title: "Other", active: true },
  ]);
  const owning = await connectExtension(port, "profile-b", [
    {
      tabId: 2,
      url: "http://127.0.0.1:3458/workspace/it/session/674fb240-55e4-427e-a544-60c5b22226f0/",
      title: "Nexolyra",
      active: true,
    },
  ]);

  try {
    const session = await postJson(port, "/sessions", {
      profileUrlHint: "/session/674fb240-55e4-427e-a544-60c5b22226f0/",
      returnOrigin: "http://127.0.0.1:3458",
      ownerSessionId: "nex-aaaaaaaaaaaaaaaa",
    });
    const cdp = await connectCdp(port, session.sessionId, session.token);
    const response = await cdpCommand(cdp, {
      id: 1,
      method: "Target.getTargets",
      params: {},
    });
    assert.equal(response.error, undefined);
    assert.deepEqual(response.result.targetInfos, []);

    const denied = await cdpCommand(cdp, {
      id: 20,
      method: "Target.attachToTarget",
      params: { targetId: "tab:profile-b:2", flatten: true },
    });
    assert.match(denied.error.message, /outside this Chrome bridge session/);

    const created = await cdpCommand(cdp, {
      id: 2,
      method: "Target.createTarget",
      params: { url: "https://example.com/task" },
    });
    assert.equal(created.error, undefined);
    assert.equal(created.result.targetId, "tab:profile-b:303");
    assert.ok(
      owning.commands.some(
        (command) =>
          command.method === "Bridge.createWindow" &&
          command.params.url === "https://example.com/task" &&
          command.params.focused === false,
      ),
    );

    const attached = await cdpCommand(cdp, {
      id: 3,
      method: "Target.attachToTarget",
      params: { targetId: created.result.targetId, flatten: true },
    });
    assert.match(attached.result.sessionId, /^session:/);
    const agentOverlay = owning.commands.findLast(
      (command) => command.method === "Bridge.setControlOverlay" && command.params.phase === "agent",
    );
    assert.equal(agentOverlay.params.returnPath, undefined);
    assert.equal(agentOverlay.params.returnOrigin, undefined);

    const targets = await cdpCommand(cdp, {
      id: 4,
      method: "Target.getTargets",
      params: {},
    });
    assert.deepEqual(
      targets.result.targetInfos.map((target) => target.url),
      ["https://example.com/task"],
    );
    const health = await fetchJson(port, "/health");
    assert.equal(health.sessions[0].profileId, "profile-b");
    assert.equal("profileUrlHint" in health.sessions[0], false);

    const takeover = await postJson(port, "/control/sessions/nex-aaaaaaaaaaaaaaaa", {
      phase: "human",
    });
    assert.equal(takeover.matched, 1);
    assert.equal(takeover.focusConfirmed, true);
    const humanOverlay = owning.commands.findLast(
      (command) => command.method === "Bridge.setControlOverlay" && command.params.phase === "human",
    );
    assert.equal(humanOverlay.params.returnPath, "/session/674fb240-55e4-427e-a544-60c5b22226f0");
    assert.equal(humanOverlay.params.returnOrigin, "http://127.0.0.1:3458");
    assert.ok(
      owning.commands.some(
        (command) => command.method === "Bridge.activateTab" && command.tabId === 303,
      ),
    );
    assert.equal(
      owning.commands.some(
        (command) => command.method === "Bridge.activateTab" && command.tabId === 2,
      ),
      false,
    );

    const browserClose = await cdpCommand(cdp, {
      id: 5,
      method: "Browser.close",
      params: {},
    });
    assert.equal(browserClose.error, undefined);
    assert.equal(
      owning.commands.some((command) => command.method === "Bridge.closeTab"),
      false,
    );

    await postJson(port, `/sessions/${session.sessionId}/detach`, {});
    assert.equal(
      owning.commands.some((command) => command.method === "Bridge.closeTab"),
      false,
    );

    const replacement = await postJson(port, "/sessions", {
      profileUrlHint: "/session/674fb240-55e4-427e-a544-60c5b22226f0/",
      ownerSessionId: "nex-aaaaaaaaaaaaaaaa",
    });
    const replacementCdp = await connectCdp(port, replacement.sessionId, replacement.token);
    const replacementTargets = await cdpCommand(replacementCdp, {
      id: 6,
      method: "Target.getTargets",
      params: {},
    });
    assert.deepEqual(
      replacementTargets.result.targetInfos.map((target) => target.url),
      ["https://example.com/task"],
    );

    await postJson(port, `/sessions/${replacement.sessionId}/detach`, {});
    await waitFor(() =>
      owning.commands.some(
        (command) => command.method === "Bridge.closeTab" && command.params.tabId === 303,
      ),
    );
    assert.ok(
      owning.commands.some(
        (command) => command.method === "Bridge.closeTab" && command.params.tabId === 303,
      ),
    );
    replacementCdp.close();
    cdp.close();
  } finally {
    unrelated.close();
    owning.close();
    await daemon.stop();
  }
});

test("daemon preserves the multiple-profile error when a route hint is ambiguous", async () => {
  const port = await freePort();
  const daemon = new BridgeDaemon({ port, commandTimeoutMs: 5000 });
  await daemon.start();
  const first = await connectExtension(port, "profile-a", [
    { tabId: 1, url: "https://a.example/session/shared", title: "A", active: true },
  ]);
  const second = await connectExtension(port, "profile-b", [
    { tabId: 2, url: "https://b.example/session/shared", title: "B", active: true },
  ]);

  try {
    const session = await postJson(port, "/sessions", { profileUrlHint: "/session/shared" });
    const cdp = await connectCdp(port, session.sessionId, session.token);
    const response = await cdpCommand(cdp, {
      id: 1,
      method: "Target.getTargets",
      params: {},
    });
    assert.match(response.error.message, /Multiple Chrome extension profiles/);
    cdp.close();
  } finally {
    first.close();
    second.close();
    await daemon.stop();
  }
});

test("page takeover fences queued and future CDP commands and emits a bounded owner event", async () => {
  const port = await freePort();
  const daemon = new BridgeDaemon({ port, commandTimeoutMs: 5000 });
  await daemon.start();
  const extension = await connectExtension(port, "profile-a", [
    { tabId: 101, windowId: 1, url: "https://example.com", title: "Example", active: true },
  ]);

  try {
    const session = await postJson(port, "/sessions", { ownerSessionId: "nex-aaaaaaaaaaaaaaaa" });
    const cdp = await connectCdp(port, session.sessionId, session.token);
    const attached = await cdpCommand(cdp, {
      id: 1,
      method: "Target.attachToTarget",
      params: { targetId: "tab:profile-a:101", flatten: true },
    });

    extension.send(
      JSON.stringify({
        v: 1,
        kind: "control-event",
        profileId: "profile-a",
        tabId: 101,
        sessionId: attached.result.sessionId,
        action: "takeover",
      }),
    );
    await waitFor(async () => {
      const events = await fetchJson(port, "/control/events?after=0");
      return events.events.length === 1;
    });
    const eventStream = await fetchJson(port, "/control/events?after=0");
    assert.match(eventStream.streamId, /^[0-9a-f-]{36}$/);

    const blocked = await cdpCommand(cdp, {
      id: 2,
      sessionId: attached.result.sessionId,
      method: "Runtime.evaluate",
      params: { expression: "document.title" },
    });
    assert.match(blocked.error.message, /held by the user/);

    const observer = await cdpCommand(cdp, {
      id: 20,
      sessionId: attached.result.sessionId,
      method: "Page.startScreencast",
      params: { format: "png", quality: 99, maxWidth: 1280, maxHeight: 720, everyNthFrame: 1 },
    });
    assert.equal(observer.error, undefined);
    assert.deepEqual(
      extension.commands.find((command) => command.method === "Page.startScreencast")?.params,
      {
        format: "jpeg",
        quality: 60,
        maxWidth: 640,
        maxHeight: 360,
        everyNthFrame: 1,
      },
    );
    assert.ok(
      extension.commands.some(
        (command) => command.method === "Bridge.activateTab" && command.tabId === 101,
      ),
      "takeover should focus the controlled Chrome tab",
    );

    const ack = await cdpCommand(cdp, {
      id: 21,
      sessionId: attached.result.sessionId,
      method: "Page.screencastFrameAck",
      params: { sessionId: 1 },
    });
    assert.equal(ack.error, undefined);

    const events = await fetchJson(port, "/control/events?after=0");
    assert.equal(events.events[0].ownerSessionId, "nex-aaaaaaaaaaaaaaaa");
    assert.equal(events.events[0].action, "takeover");
    assert.equal(events.events[0].targetId, "tab:profile-a:101");
    assert.equal(events.events[0].pendingActionRisk, false);

    const resumed = await postJson(port, "/control/sessions/nex-aaaaaaaaaaaaaaaa", {
      phase: "agent",
    });
    assert.equal(resumed.matched, 1);
    const evaluated = await cdpCommand(cdp, {
      id: 3,
      sessionId: attached.result.sessionId,
      method: "Runtime.evaluate",
      params: { expression: "document.title" },
    });
    assert.equal(evaluated.result.result.value, "ok");
    cdp.close();
  } finally {
    extension.close();
    await daemon.stop();
  }
});

test("external tab detachment is recoverable and does not become user Stop", async () => {
  const port = await freePort();
  const daemon = new BridgeDaemon({ port, commandTimeoutMs: 5000 });
  await daemon.start();
  const extension = await connectExtension(port, "profile-a", [
    { tabId: 101, windowId: 1, url: "https://example.com", title: "Example", active: true },
  ]);

  try {
    const session = await postJson(port, "/sessions", {
      ownerSessionId: "nex-aaaaaaaaaaaaaaaa",
    });
    const cdp = await connectCdp(port, session.sessionId, session.token);
    const attached = await cdpCommand(cdp, {
      id: 1,
      method: "Target.attachToTarget",
      params: { targetId: "tab:profile-a:101", flatten: true },
    });

    extension.send(
      JSON.stringify({
        v: 1,
        kind: "detach",
        profileId: "profile-a",
        tabId: 101,
        sessionId: attached.result.sessionId,
        reason: "tab_closed",
      }),
    );
    await waitFor(async () => {
      const events = await fetchJson(port, "/control/events?after=0");
      return events.events.length === 1;
    });

    const events = await fetchJson(port, "/control/events?after=0");
    assert.deepEqual(events.events[0], {
      sequence: 1,
      ownerSessionId: "nex-aaaaaaaaaaaaaaaa",
      bridgeSessionId: session.sessionId,
      action: "detach",
      reason: "tab_closed",
      tabId: 101,
      targetId: "tab:profile-a:101",
      pendingActionRisk: false,
      createdAt: events.events[0].createdAt,
    });
    const health = await fetchJson(port, "/health");
    assert.equal(health.sessions[0].control.phase, "detached");

    const reenabled = await postJson(port, "/control/sessions/nex-aaaaaaaaaaaaaaaa", {
      phase: "agent",
    });
    assert.equal(reenabled.matched, 1);
    const afterReenable = await fetchJson(port, "/health");
    assert.equal(afterReenable.sessions[0].control.phase, "agent");
    cdp.close();
  } finally {
    extension.close();
    await daemon.stop();
  }
});

test("reconnect selects the Nex session tab and preserves the CDP attachment id", async () => {
  const port = await freePort();
  const daemon = new BridgeDaemon({ port, commandTimeoutMs: 5000 });
  await daemon.start();
  const extension = await connectExtension(port, "profile-a", [
    { tabId: 101, windowId: 1, url: "https://example.com", title: "Example", active: true },
  ]);

  try {
    const session = await postJson(port, "/sessions", {
      ownerSessionId: "nex-aaaaaaaaaaaaaaaa",
      profileUrlHint: "/session/session-a",
      returnOrigin: "http://127.0.0.1:3458",
    });
    const cdp = await connectCdp(port, session.sessionId, session.token);
    const attached = await cdpCommand(cdp, {
      id: 1,
      method: "Target.createTarget",
      params: { url: "https://example.com/task" },
    });
    const attachment = await cdpCommand(cdp, {
      id: 2,
      method: "Target.attachToTarget",
      params: { targetId: attached.result.targetId, flatten: true },
    });
    const oldAttachmentId = attachment.result.sessionId;
    extension.send(
      JSON.stringify({
        v: 1,
        kind: "detach",
        profileId: "profile-a",
        tabId: 303,
        sessionId: oldAttachmentId,
        reason: "tab_closed",
      }),
    );
    await waitFor(async () => (await fetchJson(port, "/control/events?after=0")).events.length === 1);

    extension.send(
      JSON.stringify({
        v: 1,
        kind: "heartbeat",
        profileId: "profile-a",
        tabs: [
          {
            tabId: 202,
            windowId: 1,
            url: "http://127.0.0.1:3458/workspace/it/session/session-a",
            title: "Nexolyra",
            active: true,
          },
        ],
      }),
    );
    const reconnected = await postJson(
      port,
      "/control/sessions/nex-aaaaaaaaaaaaaaaa/reconnect",
      {},
    );
    assert.equal(reconnected.attached, true);
    assert.equal(reconnected.targetId, "tab:profile-a:202");
    assert.equal(reconnected.sessionId, oldAttachmentId);
    assert.ok(
      extension.commands.some(
        (command) =>
          command.method === "Bridge.setControlOverlay" &&
          command.tabId === 202 &&
          command.sessionId === oldAttachmentId &&
          command.params.phase === "agent" &&
          command.params.returnPath === undefined &&
          command.params.returnOrigin === undefined,
      ),
    );

    const targets = await cdpCommand(cdp, { id: 2, method: "Target.getTargets", params: {} });
    assert.deepEqual(
      targets.result.targetInfos.map((target) => target.targetId),
      ["tab:profile-a:202"],
    );
    cdp.close();
  } finally {
    extension.close();
    await daemon.stop();
  }
});

test("failed reconnect restores the detached control fence", async () => {
  const port = await freePort();
  const daemon = new BridgeDaemon({ port, commandTimeoutMs: 5000 });
  await daemon.start();
  const extension = await connectExtension(port, "profile-a", [
    { tabId: 101, windowId: 1, url: "https://example.com", title: "Example", active: true },
  ]);

  try {
    const session = await postJson(port, "/sessions", {
      ownerSessionId: "nex-aaaaaaaaaaaaaaaa",
    });
    const cdp = await connectCdp(port, session.sessionId, session.token);
    const attached = await cdpCommand(cdp, {
      id: 1,
      method: "Target.attachToTarget",
      params: { targetId: "tab:profile-a:101", flatten: true },
    });
    extension.send(
      JSON.stringify({
        v: 1,
        kind: "detach",
        profileId: "profile-a",
        tabId: 101,
        sessionId: attached.result.sessionId,
        reason: "debugger_detached",
      }),
    );
    await waitFor(
      async () => (await fetchJson(port, "/health")).sessions[0].control.phase === "detached",
    );

    extension.failMethods.add("Bridge.setControlOverlay");
    const failed = await fetch(
      `http://127.0.0.1:${port}/control/sessions/nex-aaaaaaaaaaaaaaaa/reconnect`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ targetId: "tab:profile-a:101" }),
      },
    );
    assert.equal(failed.status, 409);
    assert.equal((await fetchJson(port, "/health")).sessions[0].control.phase, "detached");

    extension.failMethods.delete("Bridge.setControlOverlay");
    const recovered = await postJson(
      port,
      "/control/sessions/nex-aaaaaaaaaaaaaaaa/reconnect",
      { targetId: "tab:profile-a:101" },
    );
    assert.equal(recovered.attached, true);
    assert.equal(recovered.sessionId, attached.result.sessionId);
    cdp.close();
  } finally {
    extension.close();
    await daemon.stop();
  }
});

test("reconnect accepts an explicit target from another connected Chrome profile", async () => {
  const port = await freePort();
  const daemon = new BridgeDaemon({ port, commandTimeoutMs: 5000 });
  await daemon.start();
  const first = await connectExtension(port, "profile-a", [
    { tabId: 101, windowId: 1, url: "https://a.example", title: "A", active: true },
  ]);
  const second = await connectExtension(port, "profile-b", [
    { tabId: 201, windowId: 2, url: "https://b.example", title: "B", active: true },
  ]);

  try {
    const session = await postJson(port, "/sessions", {
      ownerSessionId: "nex-aaaaaaaaaaaaaaaa",
    });
    const cdp = await connectCdp(port, session.sessionId, session.token);
    const attached = await cdpCommand(cdp, {
      id: 1,
      method: "Target.attachToTarget",
      params: { targetId: "tab:profile-a:101", flatten: true },
    });
    first.send(
      JSON.stringify({
        v: 1,
        kind: "detach",
        profileId: "profile-a",
        tabId: 101,
        sessionId: attached.result.sessionId,
        reason: "browser_closed",
      }),
    );
    await waitFor(async () => (await fetchJson(port, "/control/events?after=0")).events.length === 1);
    second.send(
      JSON.stringify({
        v: 1,
        kind: "heartbeat",
        profileId: "profile-b",
        tabs: [
          { tabId: 303, windowId: 2, url: "https://b.example/replacement", title: "B2", active: true },
        ],
      }),
    );

    const reconnected = await postJson(
      port,
      "/control/sessions/nex-aaaaaaaaaaaaaaaa/reconnect",
      { targetId: "tab:profile-b:303" },
    );
    assert.equal(reconnected.attached, true);
    assert.equal(reconnected.targetId, "tab:profile-b:303");
    assert.equal(reconnected.sessionId, attached.result.sessionId);
    assert.ok(
      second.commands.some(
        (command) => command.method === "Bridge.setControlOverlay" && command.tabId === 303,
      ),
    );
    cdp.close();
  } finally {
    first.close();
    second.close();
    await daemon.stop();
  }
});

test("lists redacted reconnect targets without leaking page content or other ownership", async () => {
  const port = await freePort();
  const daemon = new BridgeDaemon({ port, commandTimeoutMs: 5000 });
  await daemon.start();
  const extension = await connectExtension(port, "profile-a", [
    {
      tabId: 101,
      windowId: 1,
      url: "https://private.example/account?token=secret",
      title: "Private account secret",
      active: true,
    },
    {
      tabId: 202,
      windowId: 1,
      url: "https://other.example/dashboard?password=secret",
      title: "Other secret",
      active: false,
    },
  ]);

  try {
    const first = await postJson(port, "/sessions", {
      ownerSessionId: "nex-aaaaaaaaaaaaaaaa",
    });
    const second = await postJson(port, "/sessions", {
      ownerSessionId: "nex-bbbbbbbbbbbbbbbb",
    });
    const cdp = await connectCdp(port, second.sessionId, second.token);
    const attached = await cdpCommand(cdp, {
      id: 1,
      method: "Target.attachToTarget",
      params: { targetId: "tab:profile-a:202", flatten: true },
    });
    assert.equal(attached.error, undefined);

    const response = await fetchJson(
      port,
      "/control/sessions/nex-aaaaaaaaaaaaaaaa/targets",
    );
    assert.equal(response.targets.length, 2);
    assert.deepEqual(response.targets[0], {
      targetId: "tab:profile-a:101",
      profileId: "profile-a",
      active: true,
      available: true,
      controlled: false,
      controlledByOwner: false,
      host: "private.example",
      path: "/account",
    });
    assert.deepEqual(response.targets[1], {
      targetId: "tab:profile-a:202",
      profileId: "profile-a",
      active: false,
      available: false,
      controlled: true,
      controlledByOwner: false,
      host: "other.example",
      path: "/dashboard",
    });
    assert.equal(JSON.stringify(response).includes("secret"), false);
    assert.equal(JSON.stringify(response).includes("Private account"), false);

    const sameOwner = await fetchJson(
      port,
      "/control/sessions/nex-bbbbbbbbbbbbbbbb/targets",
    );
    assert.equal(sameOwner.targets[1].available, true);
    assert.equal(sameOwner.targets[1].controlledByOwner, true);
    assert.notEqual(first.sessionId, second.sessionId);
    cdp.close();
  } finally {
    extension.close();
    await daemon.stop();
  }
});

test("a full tab snapshot turns a silently closed browser into a recoverable detach", async () => {
  const port = await freePort();
  const daemon = new BridgeDaemon({ port, commandTimeoutMs: 5000 });
  await daemon.start();
  const extension = await connectExtension(port, "profile-a", [
    { tabId: 101, windowId: 1, url: "https://example.com", title: "Example", active: true },
  ]);

  try {
    const session = await postJson(port, "/sessions", {
      ownerSessionId: "nex-aaaaaaaaaaaaaaaa",
    });
    const cdp = await connectCdp(port, session.sessionId, session.token);
    const attached = await cdpCommand(cdp, {
      id: 1,
      method: "Target.attachToTarget",
      params: { targetId: "tab:profile-a:101", flatten: true },
    });

    extension.send(
      JSON.stringify({
        v: 1,
        kind: "heartbeat",
        profileId: "profile-a",
        tabs: [],
      }),
    );
    await waitFor(async () => (await fetchJson(port, "/control/events?after=0")).events.length === 1);

    const events = await fetchJson(port, "/control/events?after=0");
    assert.equal(events.events[0].action, "detach");
    assert.equal(events.events[0].reason, "browser_closed");
    assert.equal((await fetchJson(port, "/health")).sessions[0].control.phase, "detached");

    extension.send(
      JSON.stringify({
        v: 1,
        kind: "heartbeat",
        profileId: "profile-a",
        tabs: [
          {
            tabId: 202,
            windowId: 1,
            url: "http://127.0.0.1:3458/workspace/it/session/restarted",
            title: "Nexolyra",
            active: true,
          },
        ],
      }),
    );
    const reconnected = await postJson(
      port,
      "/control/sessions/nex-aaaaaaaaaaaaaaaa/reconnect",
      {},
    );
    assert.equal(reconnected.attached, true);
    assert.equal(reconnected.targetId, "tab:profile-a:202");
    assert.equal(reconnected.sessionId, attached.result.sessionId);
    cdp.close();
  } finally {
    extension.close();
    await daemon.stop();
  }
});

test("daemon restart rehydrates an owner session and preserves its bridge token", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-browser-bridge-state-"));
  const statePath = join(root, "sessions.json");
  const firstPort = await freePort();
  const firstDaemon = new BridgeDaemon({
    port: firstPort,
    commandTimeoutMs: 5000,
    statePath,
  });
  await firstDaemon.start();
  const firstExtension = await connectExtension(firstPort, "profile-a", [
    { tabId: 101, windowId: 1, url: "https://example.com", title: "Example", active: true },
  ]);

  try {
    const session = await postJson(firstPort, "/sessions", {
      ownerSessionId: "nex-aaaaaaaaaaaaaaaa",
    });
    const cdp = await connectCdp(firstPort, session.sessionId, session.token);
    const attached = await cdpCommand(cdp, {
      id: 1,
      method: "Target.attachToTarget",
      params: { targetId: "tab:profile-a:101", flatten: true },
    });
    const attachmentId = attached.result.sessionId;
    await firstDaemon.shutdown();
    firstExtension.close();
    cdp.close();

    const secondPort = await freePort();
    const secondDaemon = new BridgeDaemon({
      port: secondPort,
      commandTimeoutMs: 5000,
      statePath,
    });
    await secondDaemon.start();
    const secondExtension = await connectExtension(secondPort, "profile-a", [
      { tabId: 101, windowId: 1, url: "https://example.com/restarted", title: "Example", active: true },
    ]);
    try {
      const health = await fetchJson(secondPort, "/health");
      assert.equal(health.sessions[0].sessionId, session.sessionId);
      assert.equal(health.sessions[0].control.phase, "detached");
      const recoveredEvents = await fetchJson(secondPort, "/control/events?after=0");
      assert.equal(recoveredEvents.events.length, 1);
      assert.deepEqual(recoveredEvents.events[0], {
        sequence: 1,
        ownerSessionId: "nex-aaaaaaaaaaaaaaaa",
        bridgeSessionId: session.sessionId,
        action: "detach",
        reason: "extension_disconnected",
        tabId: 101,
        targetId: "tab:profile-a:101",
        pendingActionRisk: true,
        createdAt: recoveredEvents.events[0].createdAt,
      });
      const reconnected = await postJson(
        secondPort,
        "/control/sessions/nex-aaaaaaaaaaaaaaaa/reconnect",
        {},
      );
      assert.equal(reconnected.attached, true);
      assert.equal(reconnected.sessionId, attachmentId);
      assert.equal(reconnected.targetId, "tab:profile-a:101");
      const rehydratedCdp = await connectCdp(secondPort, session.sessionId, session.token);
      const evaluated = await cdpCommand(rehydratedCdp, {
        id: 2,
        sessionId: attachmentId,
        method: "Runtime.evaluate",
        params: { expression: "document.title" },
      });
      assert.equal(evaluated.result.result.value, "ok");
      rehydratedCdp.close();
    } finally {
      secondExtension.close();
      await secondDaemon.stop();
    }
  } finally {
    firstExtension.close();
    await firstDaemon.stop().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("session creation rejects non-loopback return origins", async () => {
  const port = await freePort();
  const daemon = new BridgeDaemon({ port, commandTimeoutMs: 5000 });
  await daemon.start();
  try {
    for (const returnOrigin of [
      "https://evil.example",
      "http://127.0.0.1:3458/extra",
      "http://user:pass@127.0.0.1:3458",
    ]) {
      const response = await fetch(`http://127.0.0.1:${port}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ returnOrigin }),
      });
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /returnOrigin/);
    }
    const accepted = await postJson(port, "/sessions", {
      returnOrigin: "http://localhost:3458",
    });
    assert.equal(accepted.returnOrigin, "http://localhost:3458");
  } finally {
    await daemon.stop();
  }
});

test("human control never focuses an arbitrary unscoped browser tab", async () => {
  const port = await freePort();
  const daemon = new BridgeDaemon({ port, commandTimeoutMs: 5000 });
  await daemon.start();
  const extension = await connectExtension(port, "profile-a", [
    { tabId: 101, windowId: 1, url: "https://unrelated.example", title: "Unrelated", active: true },
  ]);
  try {
    await postJson(port, "/sessions", { ownerSessionId: "nex-aaaaaaaaaaaaaaaa" });
    const takeover = await postJson(port, "/control/sessions/nex-aaaaaaaaaaaaaaaa", {
      phase: "human",
    });
    assert.equal(takeover.focusConfirmed, false);
    assert.equal(
      extension.commands.some((command) => command.method === "Bridge.activateTab"),
      false,
    );
  } finally {
    extension.close();
    await daemon.stop();
  }
});

test("control HTTP reports provider focus rejection instead of hanging the request", async () => {
  const port = await freePort();
  const daemon = new BridgeDaemon({ port, commandTimeoutMs: 5000 });
  await daemon.start();
  const extension = await connectExtension(port, "profile-a", [
    { tabId: 101, windowId: 1, url: "https://example.com", title: "Example", active: true },
  ]);
  try {
    const session = await postJson(port, "/sessions", {
      ownerSessionId: "nex-aaaaaaaaaaaaaaaa",
    });
    const cdp = await connectCdp(port, session.sessionId, session.token);
    await cdpCommand(cdp, {
      id: 1,
      method: "Target.attachToTarget",
      params: { targetId: "tab:profile-a:101", flatten: true },
    });
    extension.failMethods.add("Bridge.activateTab");
    const response = await fetch(
      `http://127.0.0.1:${port}/control/sessions/nex-aaaaaaaaaaaaaaaa`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phase: "human" }),
        signal: AbortSignal.timeout(1_000),
      },
    );
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /focus rejected/);
    cdp.close();
  } finally {
    extension.close();
    await daemon.stop();
  }
});

test("daemon routes CDP events only to the owning bridge session", async () => {
  const port = await freePort();
  const daemon = new BridgeDaemon({ port, commandTimeoutMs: 5000 });
  await daemon.start();
  const extension = await connectExtension(port, "profile-a", [
    { tabId: 101, windowId: 1, url: "https://a.example", title: "A", active: true },
    { tabId: 202, windowId: 1, url: "https://b.example", title: "B", active: false },
  ]);

  try {
    const firstSession = await postJson(port, "/sessions", {
      ownerSessionId: "nex-aaaaaaaaaaaaaaaa",
    });
    const secondSession = await postJson(port, "/sessions", {
      ownerSessionId: "nex-bbbbbbbbbbbbbbbb",
    });
    const first = await connectCdp(port, firstSession.sessionId, firstSession.token);
    const second = await connectCdp(port, secondSession.sessionId, secondSession.token);
    const firstAttached = await cdpCommand(first, {
      id: 1,
      method: "Target.attachToTarget",
      params: { targetId: "tab:profile-a:101", flatten: true },
    });
    const secondAttached = await cdpCommand(second, {
      id: 2,
      method: "Target.attachToTarget",
      params: { targetId: "tab:profile-a:202", flatten: true },
    });
    const firstEvents = [];
    const secondEvents = [];
    first.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      if (message.method) firstEvents.push(message);
    });
    second.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      if (message.method) secondEvents.push(message);
    });

    extension.send(
      JSON.stringify({
        v: 1,
        kind: "cdp-event",
        profileId: "profile-a",
        tabId: 101,
        sessionId: firstAttached.result.sessionId,
        method: "Page.screencastFrame",
        params: { sessionId: 1, data: "first" },
      }),
    );
    await waitFor(() => firstEvents.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(secondEvents.length, 0);
    assert.equal(firstEvents[0].sessionId, firstAttached.result.sessionId);

    extension.send(
      JSON.stringify({
        v: 1,
        kind: "cdp-event",
        profileId: "profile-a",
        tabId: 202,
        sessionId: secondAttached.result.sessionId,
        method: "Page.screencastFrame",
        params: { sessionId: 2, data: "second" },
      }),
    );
    await waitFor(() => secondEvents.length === 1);
    assert.equal(firstEvents.length, 1);
    assert.equal(secondEvents[0].sessionId, secondAttached.result.sessionId);

    first.close();
    second.close();
  } finally {
    extension.close();
    await daemon.stop();
  }
});

async function connectExtension(port, profileId, tabs, options = {}) {
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/bridge`,
    options.origin ? { headers: { Origin: options.origin } } : undefined,
  );
  ws.commands = [];
  ws.failMethods = new Set();
  await onceOpen(ws);
  ws.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    if (message.kind !== "cdp-command") return;
    ws.commands.push(message);
    if (ws.failMethods.has(message.method)) {
      ws.send(
        JSON.stringify({
          v: 1,
          kind: "cdp-result",
          reqId: message.reqId,
          error: { code: -32000, message: "focus rejected" },
        }),
      );
      return;
    }
    if (message.method === "Bridge.createTab") {
      const tab = {
        tabId: 202,
        windowId: 1,
        url: message.params.url,
        title: "Created",
        active: true,
      };
      ws.send(
        JSON.stringify({
          v: 1,
          kind: "cdp-result",
          reqId: message.reqId,
          result: tab,
        }),
      );
      return;
    }
    if (message.method === "Bridge.createWindow") {
      const tab = {
        tabId: 303,
        windowId: 99,
        url: message.params.url,
        title: "Task",
        active: true,
      };
      ws.send(
        JSON.stringify({
          v: 1,
          kind: "cdp-result",
          reqId: message.reqId,
          result: tab,
        }),
      );
      return;
    }
    if (message.method === "Page.captureScreenshot") {
      ws.send(
        JSON.stringify({
          v: 1,
          kind: "cdp-result",
          reqId: message.reqId,
          result: { data: "base64-frame" },
        }),
      );
      return;
    }
    ws.send(
      JSON.stringify({
        v: 1,
        kind: "cdp-result",
        reqId: message.reqId,
        result: {
          result: { type: "string", value: "ok" },
        },
      }),
    );
  });
  ws.send(
    JSON.stringify({
      v: 1,
      kind: "hello",
      profileId,
      extensionId: options.extensionId ?? "extension-id",
      extensionVersion: "0.31.1",
      chromeVersion: "120.0.0.0",
      tabs,
    }),
  );
  await waitFor(async () => {
    const health = await fetchJson(port, "/health");
    return health.profiles.some((profile) => profile.profileId === profileId);
  });
  return ws;
}

async function assertBridgeUpgradeRejected(port, origin) {
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/bridge`,
      origin ? { headers: { Origin: origin } } : undefined,
    );
    ws.on("unexpected-response", (_request, response) => {
      assert.equal(response.statusCode, 403);
      resolve();
    });
    ws.on("open", () => reject(new Error("untrusted extension origin unexpectedly connected")));
    ws.on("error", () => undefined);
  });
}

async function onceJsonMessage(ws) {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for bridge response")), 5000);
    ws.once("message", (raw) => {
      clearTimeout(timer);
      resolve(JSON.parse(String(raw)));
    });
    ws.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function assertInvalidToken(port) {
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/devtools/browser/bridge?session=missing&token=bad`,
    );
    ws.on("unexpected-response", (_request, response) => {
      assert.equal(response.statusCode, 401);
      resolve();
    });
    ws.on("open", () => reject(new Error("invalid token unexpectedly connected")));
    ws.on("error", () => undefined);
  });
}

async function connectCdp(port, sessionId, token) {
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/devtools/browser/bridge?session=${sessionId}&token=${token}`,
  );
  await onceOpen(ws);
  return ws;
}

async function cdpCommand(ws, command) {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", onMessage);
      reject(new Error(`timed out waiting for ${command.method}`));
    }, 5000);
    const onMessage = (raw) => {
      const message = JSON.parse(String(raw));
      if (message.id !== command.id) return;
      ws.off("message", onMessage);
      clearTimeout(timer);
      resolve(message);
    };
    ws.on("message", onMessage);
    ws.send(JSON.stringify(command));
  });
}

async function postJson(port, path, body) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
  assert.equal(response.ok, true);
  return await response.json();
}

async function fetchJson(port, path) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  assert.equal(response.ok, true);
  return await response.json();
}

async function onceOpen(ws) {
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
}

async function waitFor(check) {
  const started = Date.now();
  while (Date.now() - started < 5000) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("wait timed out");
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}
