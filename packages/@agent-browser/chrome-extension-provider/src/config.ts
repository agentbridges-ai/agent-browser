import { fileURLToPath } from "node:url";
import { closeSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_BRIDGE_PORT = 19826;
export const PINNED_CHROME_EXTENSION_ID = "pimcamjccpkgapdpecfiadkemnggggbj";

export type BridgeConfig = {
  port: number;
  profileId?: string;
  profileUrlHint?: string;
  returnOrigin?: string;
  daemonCommand?: string;
  extensionId?: string;
  controlToken?: string;
  controlSecretsFd?: number;
  sessionGrant?: string;
  sessionGrantSecret?: string;
  logPath?: string;
  statePath?: string;
  legacyStatePaths: string[];
  supervisedByNexolyra: boolean;
};

export function readControlSecretsFd(fd: number): {
  controlToken: string;
  sessionGrantSecret: string;
} {
  try {
    const secrets = JSON.parse(readFileSync(fd, "utf8")) as Record<string, unknown>;
    const controlToken = parseControlToken(
      typeof secrets.controlToken === "string" ? secrets.controlToken : undefined,
    );
    const sessionGrantSecret = parseSessionGrantSecret(
      typeof secrets.sessionGrantSecret === "string" ? secrets.sessionGrantSecret : undefined,
    );
    if (!controlToken || !sessionGrantSecret) {
      throw new Error("Control fd did not contain both required Chrome bridge secrets");
    }
    return { controlToken, sessionGrantSecret };
  } finally {
    closeSync(fd);
  }
}

export function readBridgeConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const logPath = nonEmpty(env.AGENT_BROWSER_CHROME_BRIDGE_LOG);
  const explicitStatePath = nonEmpty(env.AGENT_BROWSER_CHROME_BRIDGE_STATE);
  const port = parsePort(env.AGENT_BROWSER_CHROME_BRIDGE_PORT);
  const statePath =
    explicitStatePath ||
    join(
      homedir(),
      ".agent-browser",
      "chrome-extension-provider",
      String(port),
      "sessions.json",
    );
  const legacyStatePath = join(logPath ? dirname(logPath) : process.cwd(), "sessions.json");
  return {
    port,
    profileId: nonEmpty(env.AGENT_BROWSER_CHROME_BRIDGE_PROFILE),
    profileUrlHint: parseProfileUrlHint(env.AGENT_BROWSER_CHROME_BRIDGE_PROFILE_URL_HINT),
    returnOrigin: parseReturnOrigin(env.AGENT_BROWSER_CHROME_BRIDGE_RETURN_ORIGIN),
    daemonCommand: nonEmpty(env.AGENT_BROWSER_CHROME_BRIDGE_DAEMON),
    extensionId:
      parseExtensionId(env.AGENT_BROWSER_CHROME_BRIDGE_EXTENSION_ID) ??
      PINNED_CHROME_EXTENSION_ID,
    controlToken: parseControlToken(env.NEXOLYRA_AGENT_BROWSER_CONTROL_TOKEN),
    controlSecretsFd: parseControlSecretsFd(env.NEXOLYRA_AGENT_BROWSER_CONTROL_FD),
    sessionGrant: parseSessionGrant(env.NEXOLYRA_AGENT_BROWSER_SESSION_GRANT),
    sessionGrantSecret: parseSessionGrantSecret(
      env.NEXOLYRA_AGENT_BROWSER_SESSION_GRANT_SECRET,
    ),
    logPath,
    statePath,
    legacyStatePaths:
      explicitStatePath || legacyStatePath === statePath ? [] : [legacyStatePath],
    supervisedByNexolyra: env.NEXOLYRA_AGENT_BROWSER_DAEMON_SUPERVISED === "1",
  };
}

export function parseControlSecretsFd(value: string | undefined): number | undefined {
  const candidate = nonEmpty(value);
  if (!candidate) return undefined;
  const fd = Number(candidate);
  if (!Number.isSafeInteger(fd) || fd < 3 || fd > 255) {
    throw new Error("NEXOLYRA_AGENT_BROWSER_CONTROL_FD must be an inherited fd from 3 to 255");
  }
  return fd;
}

export function parseSessionGrant(value: string | undefined): string | undefined {
  const grant = nonEmpty(value);
  if (!grant) return undefined;
  if (grant.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(grant)) {
    throw new Error("NEXOLYRA_AGENT_BROWSER_SESSION_GRANT is malformed");
  }
  return grant;
}

export function parseSessionGrantSecret(value: string | undefined): string | undefined {
  const secret = nonEmpty(value);
  if (!secret) return undefined;
  if (!/^[a-f0-9]{64}$/i.test(secret)) {
    throw new Error(
      "NEXOLYRA_AGENT_BROWSER_SESSION_GRANT_SECRET must be a 64-character hexadecimal secret",
    );
  }
  return secret;
}

export function parseControlToken(value: string | undefined): string | undefined {
  const token = nonEmpty(value);
  if (!token) return undefined;
  if (!/^[a-f0-9]{64}$/i.test(token)) {
    throw new Error(
      "NEXOLYRA_AGENT_BROWSER_CONTROL_TOKEN must be a 64-character hexadecimal secret",
    );
  }
  return token;
}

export function parseExtensionId(value: string | undefined): string | undefined {
  const extensionId = nonEmpty(value);
  if (!extensionId) return undefined;
  if (!/^[a-p]{32}$/.test(extensionId)) {
    throw new Error(
      "AGENT_BROWSER_CHROME_BRIDGE_EXTENSION_ID must be a 32-character Chrome extension id",
    );
  }
  return extensionId;
}

export function parsePort(value: string | undefined): number {
  if (!value) return DEFAULT_BRIDGE_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `AGENT_BROWSER_CHROME_BRIDGE_PORT must be an integer from 1 to 65535; got ${value}`,
    );
  }
  return port;
}

export function parseProfileUrlHint(value: string | undefined): string | undefined {
  const hint = nonEmpty(value);
  if (!hint) return undefined;
  if (!hint.startsWith("/") || hint.length > 512 || /[\u0000-\u001f\u007f]/.test(hint)) {
    throw new Error(
      "AGENT_BROWSER_CHROME_BRIDGE_PROFILE_URL_HINT must be a pathname suffix of at most 512 characters",
    );
  }
  return hint.length > 1 ? hint.replace(/\/+$/, "") : hint;
}

export function parseReturnOrigin(value: string | undefined): string | undefined {
  const candidate = nonEmpty(value);
  if (!candidate) return undefined;
  try {
    const parsed = new URL(candidate);
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
      parsed.hash ||
      candidate.length > 256
    ) {
      throw new Error("invalid return origin");
    }
    return parsed.origin;
  } catch {
    throw new Error(
      "AGENT_BROWSER_CHROME_BRIDGE_RETURN_ORIGIN must be an HTTP(S) loopback origin",
    );
  }
}

export function defaultDaemonScriptUrl(): URL {
  return new URL("./daemon/cli.js", import.meta.url);
}

export function defaultDaemonScriptPath(): string {
  return fileURLToPath(defaultDaemonScriptUrl());
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
