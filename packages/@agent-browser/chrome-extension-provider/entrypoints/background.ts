import {
  BRIDGE_PROTOCOL_VERSION,
  type BridgeCommand,
  type BridgeControlAction,
  type BridgeMessage,
  type BridgeTab,
} from "../src/protocol";

declare const __AGENT_BROWSER_BRIDGE_DEFAULT_PORT__: number;

type StoredConfig = {
  bridgeProfileId?: string;
  bridgePort?: number;
  bridgePorts?: number[];
};

const DEFAULT_PORT = __AGENT_BROWSER_BRIDGE_DEFAULT_PORT__;
const CONTROL_BINDING = "__agentBrowserControl";
const CONTROL_WORLD = "__agentBrowserOperatorWorld";
const attachedTabs = new Set<number>();
type ControlOverlay = {
  nonce: string;
  sessionId: string;
  phase: "agent" | "human" | "stopped";
  returnPath?: string;
  returnOrigin?: string;
  frameId?: string;
  executionContextId?: number;
};
const controlOverlays = new Map<number, ControlOverlay>();
const controlBindingTabs = new Set<number>();
const controlOverlaySyncs = new Map<number, Promise<void>>();
let bridge: WebSocket | null = null;
let activePort = DEFAULT_PORT;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let connectInFlight: Promise<void> | undefined;
let profileIdInFlight: Promise<string> | undefined;
let lastBridgeError: string | undefined;

export default defineBackground(() => {
  chrome.runtime.onInstalled.addListener((details) => {
    chrome.alarms.create("agent-browser-bridge-heartbeat", { periodInMinutes: 0.5 });
    void connectBridge();
    if (details.reason === "install") void openOnboarding();
  });
  chrome.runtime.onStartup.addListener(() => {
    void connectBridge();
  });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "agent-browser-bridge-heartbeat") {
      void connectBridge().then(() => sendHeartbeat());
    }
  });
  chrome.action.onClicked.addListener(() => {
    void openOnboarding();
  });
  // The onboarding page asks the worker for live bridge state. On Chrome 147+
  // it can also request a reconnect after its foreground loopback probe has
  // obtained Local Network Access permission for the extension origin.
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const kind = (message as { kind?: unknown } | null)?.kind;
    if (kind === "bridge-status-query") {
      sendResponse({
        connected: bridge !== null && bridge.readyState === WebSocket.OPEN,
        port: activePort,
        error: lastBridgeError,
      });
      return false;
    }
    if (kind === "bridge-reconnect") {
      void connectBridge().then(
        () =>
          sendResponse({
            connected: bridge !== null && bridge.readyState === WebSocket.OPEN,
            port: activePort,
            error: lastBridgeError,
          }),
        (error) =>
          sendResponse({
            connected: false,
            port: activePort,
            error: error instanceof Error ? error.message : String(error),
          }),
      );
      return true;
    }
    return false;
  });
  chrome.tabs.onCreated.addListener(() => scheduleHeartbeat());
  chrome.tabs.onUpdated.addListener(() => scheduleHeartbeat());
  chrome.tabs.onActivated.addListener(() => scheduleHeartbeat());
  chrome.windows.onFocusChanged.addListener(() => scheduleHeartbeat());
  chrome.tabs.onRemoved.addListener((tabId) => {
    const overlay = controlOverlays.get(tabId);
    if (overlay && overlay.phase !== "stopped") {
      void emitDetach(tabId, overlay.sessionId, "tab_closed");
    }
    attachedTabs.delete(tabId);
    controlOverlays.delete(tabId);
    controlBindingTabs.delete(tabId);
    controlOverlaySyncs.delete(tabId);
    scheduleHeartbeat();
  });
  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (!source.tabId) return;
    if (method === "Runtime.bindingCalled" && handleControlBinding(source.tabId, params)) return;
    const overlay = controlOverlays.get(source.tabId);
    if (overlay && method === "Page.frameNavigated") {
      const frame = (params as { frame?: { id?: unknown; parentId?: unknown } } | undefined)?.frame;
      if (typeof frame?.id === "string" && frame.parentId === undefined) {
        overlay.frameId = frame.id;
        overlay.executionContextId = undefined;
      }
    }
    if (overlay && method === "Runtime.executionContextDestroyed") {
      const executionContextId = (
        params as { executionContextId?: unknown; executionContextUniqueId?: unknown } | undefined
      )?.executionContextId;
      if (executionContextId === overlay.executionContextId) overlay.executionContextId = undefined;
    }
    if (overlay && method === "Runtime.executionContextsCleared") {
      overlay.executionContextId = undefined;
    }
    if (overlay && (method === "Page.frameNavigated" || method === "Page.loadEventFired")) {
      setTimeout(() => void syncControlOverlay(source.tabId as number).catch(() => undefined), 25);
    }
    void sendBridgeMessage({
      v: BRIDGE_PROTOCOL_VERSION,
      kind: "cdp-event",
      profileId: "",
      tabId: source.tabId,
      method,
      params: (params ?? {}) as Record<string, unknown>,
    });
  });
  chrome.debugger.onDetach.addListener((source, reason) => {
    if (source.tabId) {
      const overlay = controlOverlays.get(source.tabId);
      if (overlay && overlay.phase !== "stopped") {
        void emitDetach(source.tabId, overlay.sessionId, "debugger_detached");
      }
      attachedTabs.delete(source.tabId);
      controlOverlays.delete(source.tabId);
      controlBindingTabs.delete(source.tabId);
      controlOverlaySyncs.delete(source.tabId);
    }
    if (!source.tabId) return;
    void sendBridgeMessage({
      v: BRIDGE_PROTOCOL_VERSION,
      kind: "cdp-event",
      profileId: "",
      tabId: source.tabId,
      method: "Inspector.detached",
      params: { reason },
    });
  });
  void connectBridge();
});

async function openOnboarding(): Promise<void> {
  const url = chrome.runtime.getURL("onboarding.html");
  const existing = (await tabsQuery({})).find((tab) => tab.url === url);
  if (existing?.id !== undefined) {
    await tabsUpdate(existing.id, { active: true });
    if (existing.windowId !== undefined) await windowsUpdate(existing.windowId, { focused: true });
    return;
  }
  await tabsCreate({ url, active: true });
}

async function connectBridge(): Promise<void> {
  if (bridge && bridge.readyState === WebSocket.OPEN) return;
  if (connectInFlight) return connectInFlight;
  connectInFlight = connectBridgeOnce();
  try {
    await connectInFlight;
  } finally {
    connectInFlight = undefined;
  }
}

async function connectBridgeOnce(): Promise<void> {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
  const ports = await configuredPorts();
  for (const port of ports) {
    try {
      await openBridge(port);
      activePort = port;
      lastBridgeError = undefined;
      void setBridgeBadge(true);
      return;
    } catch (error) {
      bridge = null;
      lastBridgeError = error instanceof Error ? error.message : "bridge connection failed";
    }
  }
  void setBridgeBadge(false);
  reconnectTimer = setTimeout(() => {
    void connectBridge();
  }, 1000);
}

async function openBridge(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge`);
    let settled = false;
    const finish = (result: "resolve" | "reject", error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (result === "resolve") resolve();
      else reject(error ?? new Error("bridge connection failed"));
    };
    const timeout = setTimeout(() => {
      ws.close();
      finish("reject", new Error("bridge connection timed out"));
    }, 3000);
    ws.onopen = () => {
      bridge = ws;
      ws.onmessage = (event) => {
        void handleBridgeMessage(event.data);
      };
      ws.onclose = () => {
        if (!settled) {
          finish("reject", new Error("bridge connection closed before handshake"));
        }
        // A stale socket must not clear a newer connection established while
        // the old close event was still in flight.
        if (bridge !== ws) return;
        bridge = null;
        void setBridgeBadge(false);
        reconnectTimer = setTimeout(() => {
          void connectBridge();
        }, 1000);
      };
      ws.onerror = () => undefined;
      void sendHello().then(
        () => finish("resolve"),
        (error) => finish("reject", error instanceof Error ? error : new Error(String(error))),
      );
    };
    ws.onerror = () => {
      finish("reject", new Error("bridge connection failed"));
    };
    ws.onclose = () => {
      finish("reject", new Error("bridge connection closed before handshake"));
    };
  });
}

async function handleBridgeMessage(raw: string) {
  const message = JSON.parse(raw) as BridgeMessage;
  if (message.v !== BRIDGE_PROTOCOL_VERSION || message.kind !== "cdp-command") return;
  const command = message as BridgeCommand;
  try {
    const result = await executeCommand(command);
    await sendResult(command.reqId, result);
  } catch (error) {
    await sendResult(command.reqId, undefined, {
      code: -32000,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function executeCommand(command: BridgeCommand): Promise<unknown> {
  if (command.method === "Bridge.createTab") {
    const url = typeof command.params?.url === "string" ? command.params.url : "about:blank";
    const tab = await tabsCreate({ url, active: true });
    return tabToBridgeTab(tab);
  }
  if (command.method === "Bridge.createWindow") {
    const url = typeof command.params?.url === "string" ? command.params.url : "about:blank";
    const focused = command.params?.focused === true;
    const window = await windowsCreate({ url, focused });
    const tab =
      window.tabs?.[0] ??
      (window.id === undefined ? undefined : (await tabsQuery({ windowId: window.id }))[0]);
    if (!tab) throw new Error("Chrome did not create a task tab");
    return tabToBridgeTab(tab);
  }
  if (command.method === "Bridge.activateTab") {
    const tabId = numberParam(command, "tabId");
    await activateTabAndWindow(tabId);
    return {};
  }
  if (command.method === "Bridge.closeTab") {
    const tabId = numberParam(command, "tabId");
    // Invalidate the operator-boundary nonce before Chrome starts tearing the
    // page down. Runtime.bindingCalled events can arrive late while a tab is
    // closing; without this guard, a stale overlay event may be mistaken for
    // an explicit user Stop and terminate the whole owner session.
    const overlay = controlOverlays.get(tabId);
    const wasAttached = attachedTabs.has(tabId);
    controlOverlays.delete(tabId);
    attachedTabs.delete(tabId);
    try {
      await tabsRemove(tabId);
    } catch (error) {
      if (overlay) controlOverlays.set(tabId, overlay);
      if (wasAttached) attachedTabs.add(tabId);
      throw error;
    }
    return { success: true };
  }
  if (command.method === "Bridge.setControlOverlay") {
    const tabId = command.tabId ?? numberParam(command, "tabId");
    const sessionId = command.sessionId;
    const phase = command.params?.phase;
    if (!sessionId) throw new Error("Bridge.setControlOverlay requires sessionId");
    if (phase !== "agent" && phase !== "human" && phase !== "stopped") {
      throw new Error("Bridge.setControlOverlay requires a valid phase");
    }
    const returnPath =
      typeof command.params?.returnPath === "string" && command.params.returnPath.startsWith("/")
        ? command.params.returnPath.slice(0, 512)
        : undefined;
    const returnOrigin = normalizeLoopbackOrigin(command.params?.returnOrigin);
    await ensureDebuggerAttached(tabId);
    const current = controlOverlays.get(tabId);
    const overlay = {
      nonce: current?.sessionId === sessionId ? current.nonce : crypto.randomUUID(),
      sessionId,
      phase,
      frameId: current?.frameId,
      executionContextId: current?.executionContextId,
      ...(phase === "human" && returnPath && returnOrigin
        ? { returnPath, returnOrigin }
        : {}),
    };
    controlOverlays.set(tabId, overlay);
    await syncControlOverlay(tabId);
    return { visible: true, phase };
  }
  if (command.method === "Bridge.detachTab") {
    const tabId = command.tabId ?? numberParam(command, "tabId");
    const overlay = controlOverlays.get(tabId);
    if (overlay) {
      overlay.phase = "stopped";
      await syncControlOverlay(tabId).catch(() => undefined);
    }
    if (attachedTabs.has(tabId)) {
      await debuggerDetach({ tabId }).catch(() => undefined);
    }
    attachedTabs.delete(tabId);
    controlOverlays.delete(tabId);
    controlBindingTabs.delete(tabId);
    controlOverlaySyncs.delete(tabId);
    return { detached: true };
  }
  const tabId = command.tabId;
  if (typeof tabId !== "number") {
    throw new Error(`CDP command ${command.method} is missing tabId`);
  }
  await ensureDebuggerAttached(tabId);
  if (shouldActivateForInput(command)) {
    await activateTabInWindow(tabId);
  }
  // Overlay synchronization is event-driven: initial/phase changes are handled
  // by Bridge.setControlOverlay and document replacement is handled by the
  // Page navigation listeners. Re-injecting here would rebuild the closed
  // shadow tree for every CDP command (including every screencast ACK), making
  // accessibility handles stale and turning Live into a high-frequency DOM
  // mutation loop.
  return await debuggerSendCommand({ tabId }, command.method, command.params ?? {});
}

function shouldActivateForInput(command: BridgeCommand): boolean {
  if (command.method === "Input.insertText") return true;
  const eventType = command.params?.type;
  if (typeof eventType !== "string") return false;
  if (command.method === "Input.dispatchMouseEvent") {
    return eventType === "mouseMoved" || eventType === "mousePressed" || eventType === "mouseWheel";
  }
  if (command.method === "Input.dispatchKeyEvent") {
    return eventType === "keyDown" || eventType === "rawKeyDown" || eventType === "char";
  }
  if (command.method === "Input.dispatchTouchEvent") return eventType === "touchStart";
  return false;
}

async function activateTabAndWindow(
  tabId: number,
  knownWindowId?: number,
): Promise<chrome.tabs.Tab> {
  const tab = await activateTabInWindow(tabId, knownWindowId);
  const windowId = tab.windowId ?? knownWindowId;
  if (windowId === undefined) throw new Error(`Chrome task window is unavailable: ${tabId}`);
  await windowsUpdate(windowId, { focused: true });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const [activeTab] = await tabsQuery({ active: true, windowId });
    const focusedWindow = await windowsGet(windowId);
    if (activeTab?.id === tabId && focusedWindow.focused === true) return tab;
    if (attempt === 5 || attempt === 12) {
      await tabsUpdate(tabId, { active: true });
      await windowsUpdate(windowId, { focused: true });
    }
    await delay(50);
  }
  throw new Error("Chrome did not focus the exact controlled task tab");
}

async function activateTabInWindow(
  tabId: number,
  knownWindowId?: number,
): Promise<chrome.tabs.Tab> {
  let tab = await tabsUpdate(tabId, { active: true });
  const windowId = tab.windowId ?? knownWindowId;
  if (windowId === undefined) throw new Error(`Chrome task window is unavailable: ${tabId}`);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const [activeTab] = await tabsQuery({ active: true, windowId });
    if (activeTab?.id === tabId) return tab;
    if (attempt === 4) tab = await tabsUpdate(tabId, { active: true });
    await delay(25);
  }
  throw new Error("Chrome did not activate the exact controlled task tab");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureDebuggerAttached(tabId: number) {
  if (attachedTabs.has(tabId)) return;
  await debuggerAttach({ tabId }, "1.3");
  attachedTabs.add(tabId);
}

function handleControlBinding(tabId: number, params: unknown): boolean {
  if (!params || typeof params !== "object") return false;
  const value = params as { name?: unknown; payload?: unknown; executionContextId?: unknown };
  if (value.name !== CONTROL_BINDING || typeof value.payload !== "string") return false;
  const overlay = controlOverlays.get(tabId);
  if (!overlay) return true;
  if (
    typeof value.executionContextId !== "number" ||
    value.executionContextId !== overlay.executionContextId
  ) {
    return true;
  }
  try {
    const payload = JSON.parse(value.payload) as { nonce?: unknown; action?: unknown };
    if (payload.nonce !== overlay.nonce) return true;
    if (payload.action !== "takeover" && payload.action !== "stop" && payload.action !== "return")
      return true;
    if (payload.action === "return") {
      if (overlay.phase !== "human" || !overlay.returnPath || !overlay.returnOrigin) return true;
      void activateNexolyraTab(overlay.returnOrigin, overlay.returnPath, tabId).catch((error) => {
        console.warn("Unable to return to Nexolyra", error);
      });
      return true;
    }
    if (overlay.phase !== "agent" && payload.action === "takeover") return true;
    void emitControlEvent(tabId, overlay.sessionId, payload.action as BridgeControlAction);
  } catch {
    // The page can call Runtime bindings; malformed or stale payloads are ignored.
  }
  return true;
}

async function emitControlEvent(
  tabId: number,
  sessionId: string,
  action: BridgeControlAction,
): Promise<void> {
  await sendBridgeMessage({
    v: BRIDGE_PROTOCOL_VERSION,
    kind: "control-event",
    profileId: "",
    tabId,
    sessionId,
    action,
  });
}

async function emitDetach(
  tabId: number,
  sessionId: string,
  reason: "tab_closed" | "debugger_detached" | "extension_disconnected" | "browser_closed" | "unknown",
): Promise<void> {
  await sendBridgeMessage({
    v: BRIDGE_PROTOCOL_VERSION,
    kind: "detach",
    profileId: "",
    tabId,
    sessionId,
    reason,
  });
}

async function syncControlOverlay(tabId: number): Promise<void> {
  const previous = controlOverlaySyncs.get(tabId);
  const current = (previous ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => injectCurrentControlOverlay(tabId));
  controlOverlaySyncs.set(tabId, current);
  try {
    await current;
  } finally {
    if (controlOverlaySyncs.get(tabId) === current) controlOverlaySyncs.delete(tabId);
  }
}

async function injectCurrentControlOverlay(tabId: number): Promise<void> {
  const overlay = controlOverlays.get(tabId);
  if (!overlay) return;
  await debuggerSendCommand({ tabId }, "Runtime.enable", {});
  const frameTree = (await debuggerSendCommand({ tabId }, "Page.getFrameTree", {})) as {
    frameTree?: { frame?: { id?: unknown } };
  };
  const frameId = frameTree.frameTree?.frame?.id;
  if (typeof frameId !== "string" || !frameId) {
    throw new Error("Chrome did not expose the controlled page frame");
  }
  if (!controlBindingTabs.has(tabId)) {
    await debuggerSendCommand({ tabId }, "Runtime.addBinding", {
      name: CONTROL_BINDING,
      executionContextName: CONTROL_WORLD,
    });
    controlBindingTabs.add(tabId);
  }
  if (overlay.frameId !== frameId || typeof overlay.executionContextId !== "number") {
    const isolatedWorld = (await debuggerSendCommand({ tabId }, "Page.createIsolatedWorld", {
      frameId,
      worldName: CONTROL_WORLD,
    })) as { executionContextId?: unknown };
    if (typeof isolatedWorld.executionContextId !== "number") {
      throw new Error("Chrome did not create the operator control world");
    }
    overlay.frameId = frameId;
    overlay.executionContextId = isolatedWorld.executionContextId;
  }
  const config = JSON.stringify({
    binding: CONTROL_BINDING,
    nonce: overlay.nonce,
    phase: overlay.phase,
    showReturn: overlay.phase === "human" && Boolean(overlay.returnOrigin && overlay.returnPath),
  });
  const expression = `(() => {
    const config = ${config};
    const id = "__agent_browser_operator_boundary__";
    document.getElementById(id)?.remove();
    const host = document.createElement("div");
    host.id = id;
    host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;box-shadow:inset 0 0 0 3px #2563eb,inset 0 0 28px rgba(37,99,235,.38);font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif";
    const shadow = host.attachShadow({ mode: "closed" });
    const binding = globalThis[config.binding];
    const bar = document.createElement("div");
    bar.style.cssText = "position:fixed;left:50%;bottom:18px;transform:translateX(-50%);display:flex;gap:8px;align-items:center;padding:8px 10px;border-radius:999px;background:#111827;color:#fff;box-shadow:0 8px 28px rgba(0,0,0,.35);pointer-events:auto;font:600 13px/1.2 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif";
    const label = document.createElement("span");
    label.textContent = config.phase === "agent" ? "Agent is browsing…" : config.phase === "human" ? "You’re in control · Resume in Nexolyra" : "Browser control stopped";
    label.style.cssText = "padding:0 6px;white-space:nowrap";
    bar.append(label);
    const button = (text, action, primary) => {
      const node = document.createElement("button");
      node.textContent = text;
      node.type = "button";
      node.style.cssText = "all:unset;cursor:pointer;border-radius:999px;padding:7px 11px;background:" + (primary ? "#2563eb" : "#374151") + ";color:#fff;font-weight:700";
      node.addEventListener("click", (event) => {
        if (!event.isTrusted) return;
        if (typeof binding === "function") binding(JSON.stringify({ nonce: config.nonce, action }));
      });
      return node;
    };
    if (config.phase === "agent") bar.append(button("Take over", "takeover", true));
    if (config.phase === "human" && config.showReturn) {
      bar.append(button("Return to Nexolyra", "return", true));
    }
    if (config.phase !== "stopped") bar.append(button("Stop", "stop", false));
    shadow.append(bar);
    (document.documentElement || document.body)?.append(host);
  })()`;
  await debuggerSendCommand({ tabId }, "Runtime.evaluate", {
    expression,
    contextId: overlay.executionContextId,
    awaitPromise: false,
    returnByValue: true,
  });
}

async function activateNexolyraTab(
  returnOrigin: string,
  returnPath: string,
  controlledTabId: number,
): Promise<void> {
  const trustedOrigin = normalizeLoopbackOrigin(returnOrigin);
  if (!trustedOrigin) throw new Error("Nexolyra return origin is not trusted");
  const trustedOriginKey = canonicalLoopbackOrigin(new URL(trustedOrigin));
  const normalized = returnPath.endsWith("/") ? returnPath : `${returnPath}/`;
  const tabs = await tabsQuery({});
  const target = tabs.find((tab) => {
    if (
      typeof tab.id !== "number" ||
      tab.id === controlledTabId ||
      typeof tab.windowId !== "number" ||
      !tab.url
    ) {
      return false;
    }
    try {
      const parsed = new URL(tab.url);
      const pathname = parsed.pathname;
      return (
        canonicalLoopbackOrigin(parsed) === trustedOriginKey &&
        (pathname === returnPath || pathname === normalized || pathname.endsWith(returnPath))
      );
    } catch {
      return false;
    }
  });
  if (!target?.id || target.windowId === undefined) {
    // The Nexolyra tab may have been closed during human control; reopen the
    // session instead of leaving the Return action silently dead. The origin
    // is the daemon-validated loopback origin, never page-supplied input.
    const created = await tabsCreate({ url: `${trustedOrigin}${returnPath}`, active: true });
    if (created.windowId !== undefined) {
      await windowsUpdate(created.windowId, { focused: true });
    }
    return;
  }
  await tabsUpdate(target.id, { active: true });
  await windowsUpdate(target.windowId, { focused: true });
}

function normalizeLoopbackOrigin(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 256) return undefined;
  try {
    const parsed = new URL(value);
    const loopback =
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "localhost" ||
      parsed.hostname === "[::1]";
    if (
      !loopback ||
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      return undefined;
    }
    return parsed.origin;
  } catch {
    return undefined;
  }
}

// localhost, 127.0.0.1, and [::1] are equivalent for matching existing tabs.
// Keep the configured origin unchanged when opening a tab so an HTTPS
// certificate issued only for localhost is never rewritten to an IP address.
function canonicalLoopbackOrigin(parsed: URL): string {
  const host =
    parsed.hostname === "localhost" || parsed.hostname === "[::1]"
      ? "127.0.0.1"
      : parsed.hostname;
  return `${parsed.protocol}//${host}${parsed.port ? `:${parsed.port}` : ""}`;
}

async function sendHello() {
  await sendBridgeMessage({
    v: BRIDGE_PROTOCOL_VERSION,
    kind: "hello",
    profileId: await getProfileId(),
    extensionId: chrome.runtime.id,
    extensionVersion: chrome.runtime.getManifest().version,
    chromeVersion: chromeVersion(),
    tabs: await allTabs(),
  });
}

async function sendHeartbeat() {
  await sendBridgeMessage({
    v: BRIDGE_PROTOCOL_VERSION,
    kind: "heartbeat",
    profileId: await getProfileId(),
    tabs: await allTabs(),
  });
}

async function sendResult(
  reqId: string,
  result?: unknown,
  error?: { code: number; message: string },
) {
  await sendBridgeMessage({
    v: BRIDGE_PROTOCOL_VERSION,
    kind: "cdp-result",
    reqId,
    result,
    error,
  });
}

async function sendBridgeMessage(message: BridgeMessage) {
  if ("profileId" in message && !message.profileId) {
    message.profileId = await getProfileId();
  }
  if (!bridge || bridge.readyState !== WebSocket.OPEN) return;
  bridge.send(JSON.stringify(message));
}

async function configuredPorts(): Promise<number[]> {
  const stored = await storageGet<StoredConfig>(["bridgePort", "bridgePorts"]);
  const ports = [
    ...(Array.isArray(stored.bridgePorts) ? stored.bridgePorts : []),
    typeof stored.bridgePort === "number" ? stored.bridgePort : DEFAULT_PORT,
    DEFAULT_PORT,
  ];
  return [...new Set(ports.filter((port) => Number.isInteger(port) && port > 0 && port <= 65535))];
}

async function setBridgeBadge(connected: boolean): Promise<void> {
  if (connected) {
    await chromeCall<void>((done) => chrome.action.setBadgeText({ text: "" }, done)).catch(
      () => undefined,
    );
    return;
  }
  await chromeCall<void>((done) =>
    chrome.action.setBadgeBackgroundColor({ color: "#dc2626" }, done),
  ).catch(() => undefined);
  await chromeCall<void>((done) => chrome.action.setBadgeText({ text: "OFF" }, done)).catch(
    () => undefined,
  );
}

async function getProfileId(): Promise<string> {
  if (profileIdInFlight) return profileIdInFlight;
  profileIdInFlight = (async () => {
    const stored = await storageGet<StoredConfig>(["bridgeProfileId"]);
    if (stored.bridgeProfileId) return stored.bridgeProfileId;
    const bridgeProfileId = crypto.randomUUID();
    await storageSet({ bridgeProfileId });
    return bridgeProfileId;
  })();
  try {
    return await profileIdInFlight;
  } finally {
    profileIdInFlight = undefined;
  }
}

async function allTabs(): Promise<BridgeTab[]> {
  const tabs = await tabsQuery({});
  return tabs.map(tabToBridgeTab).filter((tab) => tab.tabId > 0);
}

function tabToBridgeTab(tab: chrome.tabs.Tab): BridgeTab {
  return {
    tabId: tab.id ?? -1,
    openerTabId: tab.openerTabId,
    windowId: tab.windowId,
    url: tab.url ?? "",
    title: tab.title ?? "",
    active: tab.active,
  };
}

function scheduleHeartbeat() {
  setTimeout(() => {
    void sendHeartbeat();
  }, 50);
}

function chromeVersion(): string | undefined {
  const match = /Chrome\/([^ ]+)/.exec(navigator.userAgent);
  return match?.[1];
}

function numberParam(command: BridgeCommand, key: string): number {
  const value = command.params?.[key];
  if (typeof value !== "number") throw new Error(`${command.method} requires numeric ${key}`);
  return value;
}

function storageGet<T>(keys: string[]): Promise<T> {
  return chromeCall<T>((done) => chrome.storage.local.get(keys, done));
}

function storageSet(value: Record<string, unknown>): Promise<void> {
  return chromeCall<void>((done) => chrome.storage.local.set(value, done));
}

function tabsQuery(queryInfo: chrome.tabs.QueryInfo): Promise<chrome.tabs.Tab[]> {
  return chromeCall((done) => chrome.tabs.query(queryInfo, done));
}

function tabsCreate(createProperties: chrome.tabs.CreateProperties): Promise<chrome.tabs.Tab> {
  return chromeCall((done) => chrome.tabs.create(createProperties, done));
}

function tabsUpdate(
  tabId: number,
  updateProperties: chrome.tabs.UpdateProperties,
): Promise<chrome.tabs.Tab> {
  return chromeCall((done) => chrome.tabs.update(tabId, updateProperties, done));
}

function tabsRemove(tabId: number): Promise<void> {
  return chromeCall((done) => chrome.tabs.remove(tabId, done));
}

function windowsUpdate(
  windowId: number,
  updateInfo: chrome.windows.UpdateInfo,
): Promise<chrome.windows.Window> {
  return chromeCall((done) => chrome.windows.update(windowId, updateInfo, done));
}

function windowsGet(windowId: number): Promise<chrome.windows.Window> {
  return chromeCall((done) => chrome.windows.get(windowId, done));
}

function windowsCreate(createData: chrome.windows.CreateData): Promise<chrome.windows.Window> {
  return chromeCall((done) => chrome.windows.create(createData, done));
}

function debuggerAttach(target: chrome.debugger.Debuggee, version: string): Promise<void> {
  return chrome.debugger.attach(target, version);
}

function debuggerDetach(target: chrome.debugger.Debuggee): Promise<void> {
  return chrome.debugger.detach(target);
}

function debuggerSendCommand(
  target: chrome.debugger.Debuggee,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  return chrome.debugger.sendCommand(target, method, params);
}

function chromeCall<T>(fn: (done: (value: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    fn((value) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
      } else {
        resolve(value);
      }
    });
  });
}
