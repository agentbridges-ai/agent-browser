type StoredConfig = {
  bridgePort?: number;
  bridgePorts?: number[];
};

type BridgeStatus = {
  connected?: boolean;
  port?: number;
  error?: string;
};

declare const __AGENT_BROWSER_BRIDGE_DEFAULT_PORT__: number;

const DEFAULT_PORT = __AGENT_BROWSER_BRIDGE_DEFAULT_PORT__;
const POLL_INTERVAL_MS = 2000;
const RECONNECT_WAIT_MS = 6000;

type LoopbackPermissionState = PermissionState | "unsupported" | "unknown";

const copy = {
  zh: {
    checking: "正在检查连接…",
    connected: (port: number) => `已连接到 daemon(端口 ${port})`,
    disconnected: "未连接到 daemon",
    connecting: "正在连接本地 bridge…",
    portLine: "daemon 应监听的端口:",
    permissionRequired: "Chrome 需要你允许本扩展连接本机服务。不会访问局域网中的其他设备。",
    permissionGranted: "本机连接权限已允许。",
    permissionDenied: "本机连接权限已被拒绝。请在 Chrome 网站设置中恢复权限后重试。",
    permissionUnsupported: "当前 Chrome 不需要单独授权本机连接。",
    allow: "允许本机连接",
    retry: "重新连接",
    waiting: "等待 Chrome 授权…",
    guidance:
      "本扩展只连接 127.0.0.1 上由 Nexolyra 托管的 bridge。若已授权但仍离线,请先启动 Nexolyra。",
  },
  en: {
    checking: "Checking connection…",
    connected: (port: number) => `Connected to the daemon (port ${port})`,
    disconnected: "Not connected to the daemon",
    connecting: "Connecting to the local bridge…",
    portLine: "The daemon should be listening on:",
    permissionRequired:
      "Chrome needs your approval before this extension can connect to a service on this device. It does not scan other devices on your network.",
    permissionGranted: "Access to the local bridge is allowed.",
    permissionDenied:
      "Access to the local bridge was denied. Restore it in Chrome site settings, then try again.",
    permissionUnsupported: "This Chrome version does not require a separate local-access grant.",
    allow: "Allow local connection",
    retry: "Reconnect",
    waiting: "Waiting for Chrome approval…",
    guidance:
      "This extension only connects to the Nexolyra-managed bridge on 127.0.0.1. If access is allowed but it remains offline, start Nexolyra first.",
  },
} as const;

const language = navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
const text = copy[language];
document.documentElement.lang = language;

const statusElement = document.getElementById("status") as HTMLElement;
const statusText = document.getElementById("status-text") as HTMLElement;
const portText = document.getElementById("port-text") as HTMLElement;
const permissionText = document.getElementById("permission-text") as HTMLElement;
const errorText = document.getElementById("error-text") as HTMLElement;
const actionButton = document.getElementById("action-button") as HTMLButtonElement;
const guidanceText = document.getElementById("guidance-text") as HTMLElement;

const manifest = chrome.runtime.getManifest();
document.title = manifest.name;
(document.getElementById("extension-name") as HTMLElement).textContent = manifest.name;
(document.getElementById("extension-version") as HTMLElement).textContent = `v${manifest.version}`;
guidanceText.textContent = text.guidance;

// Same port resolution as entrypoints/background.ts configuredPorts(): explicit
// bridgePorts first, then bridgePort, then the default, deduped and validated.
async function configuredPorts(): Promise<number[]> {
  const stored = await chrome.storage.local.get(["bridgePort", "bridgePorts"]);
  const config = stored as StoredConfig;
  const ports = [
    ...(Array.isArray(config.bridgePorts) ? config.bridgePorts : []),
    typeof config.bridgePort === "number" ? config.bridgePort : DEFAULT_PORT,
    DEFAULT_PORT,
  ];
  return [...new Set(ports.filter((port) => Number.isInteger(port) && port > 0 && port <= 65535))];
}

async function queryBridgeStatus(): Promise<BridgeStatus | undefined> {
  try {
    return (await chrome.runtime.sendMessage({ kind: "bridge-status-query" })) as BridgeStatus;
  } catch {
    return undefined;
  }
}

async function queryLoopbackPermission(): Promise<LoopbackPermissionState> {
  if (!navigator.permissions?.query) return "unsupported";
  for (const name of ["loopback-network", "local-network-access"] as const) {
    try {
      const result = await navigator.permissions.query({ name } as PermissionDescriptor);
      return result.state;
    } catch {
      // Chrome before the corresponding LNA generation rejects the descriptor.
    }
  }
  return "unsupported";
}

async function probeLoopback(ports: number[]): Promise<boolean> {
  let reachedDaemon = false;
  for (const port of ports) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        cache: "no-store",
        signal: AbortSignal.timeout(60_000),
      });
      if (response.ok) reachedDaemon = true;
    } catch {
      // The permission can still have been granted when no daemon is listening.
    }
    if (reachedDaemon) break;
  }
  return reachedDaemon;
}

async function requestBridgeReconnect(): Promise<BridgeStatus | undefined> {
  try {
    return (await chrome.runtime.sendMessage({ kind: "bridge-reconnect" })) as BridgeStatus;
  } catch {
    return undefined;
  }
}

async function waitForBridge(): Promise<BridgeStatus | undefined> {
  const deadline = Date.now() + RECONNECT_WAIT_MS;
  let status: BridgeStatus | undefined;
  do {
    status = await queryBridgeStatus();
    if (status?.connected) return status;
    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  return status;
}

let refreshInFlight = false;
let actionInFlight = false;

async function refresh(): Promise<void> {
  if (refreshInFlight || actionInFlight) return;
  refreshInFlight = true;
  statusText.textContent = text.checking;
  try {
    const ports = await configuredPorts();
    portText.textContent = "";
    portText.append(text.portLine, " ");
    const portCode = document.createElement("code");
    portCode.textContent = ports.map((port) => `http://127.0.0.1:${port}/health`).join(", ");
    portText.append(portCode);
    const [status, permission] = await Promise.all([
      queryBridgeStatus(),
      queryLoopbackPermission(),
    ]);
    const connectedPort = status?.connected === true ? status.port : undefined;
    statusElement.dataset.connected = connectedPort === undefined ? "false" : "true";
    statusText.textContent =
      connectedPort === undefined ? text.disconnected : text.connected(connectedPort);
    permissionText.textContent =
      permission === "prompt" || permission === "unknown"
        ? text.permissionRequired
        : permission === "denied"
          ? text.permissionDenied
          : permission === "granted"
            ? text.permissionGranted
            : text.permissionUnsupported;
    errorText.hidden = !status?.error || connectedPort !== undefined;
    errorText.textContent = errorText.hidden ? "" : status?.error ?? "";
    actionButton.hidden = connectedPort !== undefined;
    actionButton.textContent =
      permission === "prompt" || permission === "unknown" ? text.allow : text.retry;
  } finally {
    refreshInFlight = false;
  }
}

async function grantAndReconnect(): Promise<void> {
  if (actionInFlight) return;
  actionInFlight = true;
  actionButton.disabled = true;
  actionButton.textContent = text.waiting;
  statusText.textContent = text.connecting;
  try {
    const ports = await configuredPorts();
    await probeLoopback(ports);
    await requestBridgeReconnect();
    await waitForBridge();
  } finally {
    actionInFlight = false;
    actionButton.disabled = false;
    await refresh();
  }
}

actionButton.addEventListener("click", () => void grantAndReconnect());
setInterval(() => void refresh(), POLL_INTERVAL_MS);
void refresh();
