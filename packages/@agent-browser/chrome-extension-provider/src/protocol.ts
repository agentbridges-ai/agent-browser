export const PLUGIN_PROTOCOL = "agent-browser.plugin.v1";
export const BRIDGE_PROTOCOL_VERSION = 1;

export const PLUGIN_NAME = "chrome-extension";
export const CAPABILITY_BROWSER_PROVIDER = "browser.provider";
export const CAPABILITY_COMMAND_RUN = "command.run";
export const CAPABILITY_MANAGE = "chrome-extension.manage";

export type PluginRequest = {
  protocol: string;
  type: string;
  capability: string;
  request?: Record<string, unknown>;
};

export type PluginResponse = {
  protocol: typeof PLUGIN_PROTOCOL;
  success: boolean;
  manifest?: {
    name: string;
    capabilities: string[];
    description: string;
  };
  browser?: {
    cdpUrl: string;
    directPage: false;
    cleanup: Record<string, unknown>;
    metadata: Record<string, unknown>;
  };
  data?: Record<string, unknown>;
  error?: string;
};

export type BridgeTab = {
  tabId: number;
  openerTabId?: number;
  windowId?: number;
  url: string;
  title: string;
  active?: boolean;
};

export type BridgeHello = {
  v: typeof BRIDGE_PROTOCOL_VERSION;
  kind: "hello";
  profileId: string;
  extensionId: string;
  extensionVersion?: string;
  extensionBuildIdentity?: string;
  chromeVersion?: string;
  tabs?: BridgeTab[];
};

export type BridgeHeartbeat = {
  v: typeof BRIDGE_PROTOCOL_VERSION;
  kind: "heartbeat";
  profileId: string;
  tabs?: BridgeTab[];
};

export type BridgeCommand = {
  v: typeof BRIDGE_PROTOCOL_VERSION;
  kind: "cdp-command";
  reqId: string;
  profileId: string;
  tabId?: number;
  sessionId?: string;
  method: string;
  params?: Record<string, unknown>;
};

export type BridgeResult = {
  v: typeof BRIDGE_PROTOCOL_VERSION;
  kind: "cdp-result";
  reqId: string;
  result?: unknown;
  error?: {
    code: number;
    message: string;
  };
};

export type BridgeEvent = {
  v: typeof BRIDGE_PROTOCOL_VERSION;
  kind: "cdp-event";
  profileId: string;
  tabId?: number;
  sessionId?: string;
  method: string;
  params?: Record<string, unknown>;
};

export type BridgeControlAction = "takeover" | "stop";

export type BridgeDetachReason =
  | "tab_closed"
  | "debugger_detached"
  | "extension_disconnected"
  | "browser_closed"
  | "unknown";

/** User intent emitted by the in-page operator boundary. */
export type BridgeControlEvent = {
  v: typeof BRIDGE_PROTOCOL_VERSION;
  kind: "control-event";
  profileId: string;
  tabId: number;
  sessionId: string;
  action: BridgeControlAction;
};

export type BridgeDetach = {
  v: typeof BRIDGE_PROTOCOL_VERSION;
  kind: "detach";
  profileId: string;
  tabId: number;
  sessionId: string;
  reason: BridgeDetachReason;
};

export type BridgeError = {
  v: typeof BRIDGE_PROTOCOL_VERSION;
  kind: "error";
  message: string;
};

export type BridgeMessage =
  | BridgeHello
  | BridgeHeartbeat
  | BridgeCommand
  | BridgeResult
  | BridgeEvent
  | BridgeControlEvent
  | BridgeDetach
  | BridgeError;

export type CdpRequest = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
};

export type CdpError = {
  code: number;
  message: string;
};

export type BridgeSession = {
  sessionId: string;
  token: string;
  profileId?: string;
  profileUrlHint?: string;
  returnOrigin?: string;
  ownerSessionId?: string;
  createdAt: string;
};
