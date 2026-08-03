#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defaultDaemonScriptPath, readBridgeConfig } from "./config.js";
import {
  BRIDGE_PROTOCOL_VERSION,
  CAPABILITY_BROWSER_PROVIDER,
  CAPABILITY_COMMAND_RUN,
  CAPABILITY_MANAGE,
  PLUGIN_NAME,
  PLUGIN_PROTOCOL,
  type BridgeSession,
  type PluginRequest,
  type PluginResponse,
} from "./protocol.js";
import { CHROME_EXTENSION_PROVIDER_VERSION } from "./version.js";

const LAUNCH_WAIT_MS = 15_000;

async function main() {
  const input = await readPluginRequest();
  const response = await handlePluginRequest(input);
  process.stdout.write(JSON.stringify(response));
}

export async function handlePluginRequest(input: PluginRequest): Promise<PluginResponse> {
  if (input.protocol !== PLUGIN_PROTOCOL) {
    return failure(`unsupported protocol: ${input.protocol}`);
  }
  if (input.type === "plugin.manifest") {
    return {
      protocol: PLUGIN_PROTOCOL,
      success: true,
      manifest: {
        name: PLUGIN_NAME,
        capabilities: [CAPABILITY_BROWSER_PROVIDER, CAPABILITY_COMMAND_RUN, CAPABILITY_MANAGE],
        description:
          "Connect agent-browser to the current desktop Chrome through the Agent Browser Bridge extension",
      },
    };
  }

  if (input.type === "browser.launch") {
    return await launchBrowserProvider();
  }

  if (input.type === "browser.close") {
    return await closeBrowserProvider(input.request ?? {});
  }

  if (input.type === "chrome-extension.status") {
    return await statusResponse();
  }

  return failure(`unsupported request type: ${input.type}`);
}

async function launchBrowserProvider(): Promise<PluginResponse> {
  const config = readBridgeConfig();
  await ensureDaemon(config.port);
  const ready = await waitForProfiles(config.port, LAUNCH_WAIT_MS);
  if (!ready) {
    return failure(
      `no Chrome extension profile connected on port ${config.port}; load the unpacked extension at ${extensionPath()} and retry`,
    );
  }
  const session = await createSession(
    config.port,
    config.profileId,
    config.profileUrlHint,
    config.returnOrigin,
  );
  return {
    protocol: PLUGIN_PROTOCOL,
    success: true,
    browser: {
      cdpUrl: `ws://127.0.0.1:${config.port}/devtools/browser/bridge?session=${encodeURIComponent(session.sessionId)}&token=${encodeURIComponent(session.token)}`,
      directPage: false,
      cleanup: {
        port: config.port,
        sessionId: session.sessionId,
      },
      metadata: {
        bridgeProtocolVersion: BRIDGE_PROTOCOL_VERSION,
        profileId: config.profileId ?? null,
        extensionPath: extensionPath(),
      },
    },
  };
}

async function closeBrowserProvider(request: Record<string, unknown>): Promise<PluginResponse> {
  const port = typeof request.port === "number" ? request.port : readBridgeConfig().port;
  const sessionId = typeof request.sessionId === "string" ? request.sessionId : undefined;
  if (sessionId) {
    await fetchJson(`http://127.0.0.1:${port}/sessions/${encodeURIComponent(sessionId)}/detach`, {
      method: "POST",
    }).catch(() => undefined);
  }
  return {
    protocol: PLUGIN_PROTOCOL,
    success: true,
    data: { detached: true },
  };
}

async function statusResponse(): Promise<PluginResponse> {
  const config = readBridgeConfig();
  const health = await fetchJson(`http://127.0.0.1:${config.port}/health`).catch((error) => ({
    daemon: "offline",
    error: error instanceof Error ? error.message : String(error),
  }));
  return {
    protocol: PLUGIN_PROTOCOL,
    success: true,
    data: {
      version: CHROME_EXTENSION_PROVIDER_VERSION,
      extensionPath: extensionPath(),
      configuredProfileId: config.profileId ?? null,
      configuredExtensionId: config.extensionId ?? null,
      ...health,
    },
  };
}

async function ensureDaemon(port: number): Promise<void> {
  const config = readBridgeConfig();
  const existing = await readHealth(port);
  if (existing?.daemon === "ok") {
    assertCompatibleDaemon(existing, config.extensionId);
    return;
  }
  const env = {
    ...process.env,
    AGENT_BROWSER_CHROME_BRIDGE_PORT: String(port),
    ...(config.extensionId
      ? { AGENT_BROWSER_CHROME_BRIDGE_EXTENSION_ID: config.extensionId }
      : {}),
  };
  if (config.daemonCommand) {
    const child = spawn(config.daemonCommand, [], {
      detached: true,
      env,
      stdio: "ignore",
    });
    child.unref();
  } else {
    const child = spawn(process.execPath, [defaultDaemonScriptPath()], {
      detached: true,
      env,
      stdio: "ignore",
    });
    child.unref();
  }
  const ready = await waitUntil(async () => {
    const health = await readHealth(port);
    if (health?.daemon !== "ok") return false;
    assertCompatibleDaemon(health, config.extensionId);
    return true;
  }, 10_000);
  if (!ready) throw new Error(`Chrome extension bridge daemon did not start on port ${port}`);
}

async function waitForProfiles(port: number, timeoutMs: number): Promise<boolean> {
  const expectedExtensionId = readBridgeConfig().extensionId;
  return await waitUntil(async () => {
    const health = await fetchJson(`http://127.0.0.1:${port}/health`).catch(() => null);
    if (health?.daemon === "ok") assertCompatibleDaemon(health, expectedExtensionId);
    return Array.isArray(health?.profiles) && health.profiles.length > 0;
  }, timeoutMs);
}

async function createSession(
  port: number,
  profileId: string | undefined,
  profileUrlHint: string | undefined,
  returnOrigin: string | undefined,
): Promise<BridgeSession> {
  const ownerSessionId = process.env.NEXOLYRA_AGENT_BROWSER_SESSION_ID;
  return (await fetchJson(`http://127.0.0.1:${port}/sessions`, {
    method: "POST",
    body: JSON.stringify({ profileId, profileUrlHint, returnOrigin, ownerSessionId }),
    headers: { "content-type": "application/json" },
  })) as BridgeSession;
}

async function readHealth(port: number): Promise<Record<string, unknown> | null> {
  return await fetchJson(`http://127.0.0.1:${port}/health`).catch(() => null);
}

function assertCompatibleDaemon(
  health: Record<string, unknown>,
  expectedExtensionId: string | undefined,
): void {
  if (health.bridgeProtocolVersion !== BRIDGE_PROTOCOL_VERSION) {
    throw new Error(
      `Chrome extension bridge protocol mismatch: expected ${BRIDGE_PROTOCOL_VERSION}, got ${String(health.bridgeProtocolVersion ?? "unknown")}`,
    );
  }
  if (expectedExtensionId && health.allowedExtensionId !== expectedExtensionId) {
    throw new Error(
      `Chrome extension bridge daemon is not pinned to extension ${expectedExtensionId}`,
    );
  }
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function fetchJson(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return (await response.json()) as Record<string, unknown>;
}

async function readPluginRequest(): Promise<PluginRequest> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as PluginRequest;
}

function failure(error: string): PluginResponse {
  return {
    protocol: PLUGIN_PROTOCOL,
    success: false,
    error,
  };
}

function extensionPath(): string {
  const distPath = fileURLToPath(new URL("../.output/chrome-mv3", import.meta.url));
  if (existsSync(distPath)) return distPath;
  return fileURLToPath(new URL("../entrypoints", import.meta.url));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stdout.write(
      JSON.stringify(failure(error instanceof Error ? error.message : String(error))),
    );
  });
}
