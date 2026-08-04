import type { BridgeTab, CdpError } from "../protocol.js";

export type TargetRef = {
  profileId: string;
  tabId: number;
};

export function targetIdFor(profileId: string, tabId: number): string {
  return `tab:${encodeURIComponent(profileId)}:${tabId}`;
}

export function parseTargetId(targetId: string): TargetRef | null {
  const match = /^tab:([^:]+):(\d+)$/.exec(targetId);
  if (!match) return null;
  return {
    profileId: decodeURIComponent(match[1]),
    tabId: Number(match[2]),
  };
}

export function sessionIdFor(tabId: number, sequence: number): string {
  return `session:${tabId}:${sequence}`;
}

export function shouldExposeTab(tab: BridgeTab): boolean {
  return isAutomatableUrl(tab.url);
}

export function isAutomatableUrl(url: string): boolean {
  if (!url) return true;
  if (url === "about:blank") return true;
  if (/^(https?|file|data|blob):/i.test(url)) return true;
  return false;
}

export function targetInfoFor(profileId: string, tab: BridgeTab, attached: boolean) {
  return {
    targetId: targetIdFor(profileId, tab.tabId),
    type: "page",
    title: tab.title,
    url: tab.url,
    attached,
    ...(typeof tab.openerTabId === "number"
      ? { openerId: targetIdFor(profileId, tab.openerTabId), canAccessOpener: true }
      : { canAccessOpener: false }),
    browserContextId: `profile:${profileId}`,
  };
}

export function cdpError(message: string, code = -32000): CdpError {
  return { code, message };
}
