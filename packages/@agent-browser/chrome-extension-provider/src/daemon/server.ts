import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Duplex } from "node:stream";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { URL } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import {
  BRIDGE_PROTOCOL_VERSION,
  type BridgeCommand,
  type BridgeControlAction,
  type BridgeControlEvent,
  type BridgeDetachReason,
  type BridgeMessage,
  type BridgeResult,
  type BridgeSession,
  type BridgeTab,
  type CdpRequest,
} from "../protocol.js";
import { CHROME_EXTENSION_PROVIDER_VERSION } from "../version.js";
import {
  cdpError,
  isAutomatableUrl,
  parseTargetId,
  sessionIdFor,
  shouldExposeTab,
  targetIdFor,
  targetInfoFor,
} from "./cdp.js";
import { createLogger, type Logger } from "./logger.js";

export type BridgeDaemonOptions = {
  port: number;
  allowedExtensionId?: string;
  controlToken?: string;
  sessionGrantSecret?: string;
  logPath?: string;
  commandTimeoutMs?: number;
  detachedTargetGraceMs?: number;
  statePath?: string;
  legacyStatePaths?: string[];
  sessionRetentionMs?: number;
  supervisedByNexolyra?: boolean;
};

type ProfilePeer = {
  profileId: string;
  extensionId: string;
  extensionVersion?: string;
  chromeVersion?: string;
  ws: WebSocket;
  tabs: Map<number, BridgeTab>;
};

type AttachedSession = {
  sessionId: string;
  bridgeSessionId: string;
  profileId: string;
  tabId: number;
};

type SessionTargetScope = {
  targetIds: Set<string>;
  attachedTargetIds: Set<string>;
};

type DetachedTargetScope = {
  profileUrlHint: string;
  scope: SessionTargetScope;
  cleanupTimer: ReturnType<typeof setTimeout>;
};

type DetachedAttachment = {
  sessionId: string;
  profileId: string;
  tabId: number;
};

type PendingCommand = {
  cdpClient: WebSocket;
  cdpId: number;
  timeout: NodeJS.Timeout;
  method: string;
  bridgeSessionId?: string;
};

type ControlPhase = "agent" | "human" | "detached" | "resuming" | "stopped";

type ControlState = {
  phase: ControlPhase;
  epoch: number;
  updatedAt: string;
};

type OwnerScope = {
  profileUrlHint: string;
  returnOrigin?: string;
};

type SessionGrant = OwnerScope & {
  v: 1;
  grantId: string;
  ownerSessionId: string;
};

type SessionNonce = OwnerScope & {
  ownerSessionId: string;
  expiresAt: number;
};

type PersistedBridgeSession = {
  schemaVersion: 1;
  session: BridgeSession;
  control: ControlState;
  targetIds: string[];
  attachedTargetIds?: string[];
  detachedAttachment?: DetachedAttachment;
  savedAt: string;
};

type PersistedBridgeState = {
  schemaVersion: 1 | 2;
  sessions: PersistedBridgeSession[];
  owners?: Array<{
    ownerSessionId: string;
    control: ControlState;
    scope?: OwnerScope;
  }>;
};

type QueuedControlEvent = {
  sequence: number;
  ownerSessionId: string;
  bridgeSessionId: string;
  action: BridgeControlAction | "detach";
  reason?: BridgeDetachReason;
  tabId: number;
  targetId?: string;
  pendingActionRisk: boolean;
  createdAt: string;
};

export type BridgeReconnectTarget = {
  targetId: string;
  profileId: string;
  active: boolean;
  available: boolean;
  controlled: boolean;
  controlledByOwner: boolean;
  host: string | null;
  path: string | null;
};

const LIVE_SCREENCAST_PARAMS = {
  format: "jpeg",
  quality: 60,
  maxWidth: 640,
  maxHeight: 360,
  // A static page may not produce a second compositor frame. Keep the first frame observable;
  // downstream viewers are responsible for dropping frames under backpressure.
  everyNthFrame: 1,
} as const;

const DEFAULT_SESSION_RETENTION_MS = 30 * 60 * 1_000;
const SESSION_NONCE_TTL_MS = 60_000;
const OWNER_SESSION_ID_PATTERN = /^nex-[a-f0-9]{16}$/;

/** Local CDP shim that keeps browser automation in agent-browser core and forwards page commands to the extension. */
export class BridgeDaemon {
  private readonly options: BridgeDaemonOptions;
  private readonly logger: Logger;
  private readonly server: Server;
  private readonly extensionWss = new WebSocketServer({ noServer: true });
  private readonly cdpWss = new WebSocketServer({ noServer: true });
  private readonly profiles = new Map<string, ProfilePeer>();
  private readonly bridgeSessions = new Map<string, BridgeSession>();
  private readonly sessionTargetScopes = new Map<string, SessionTargetScope>();
  private readonly detachedTargetScopes = new Map<string, DetachedTargetScope>();
  private readonly detachedAttachments = new Map<string, DetachedAttachment>();
  private readonly attachedSessions = new Map<string, AttachedSession>();
  private readonly controlStates = new Map<string, ControlState>();
  private readonly ownerControls = new Map<string, ControlState>();
  private readonly ownerScopes = new Map<string, OwnerScope>();
  private readonly sessionNonces = new Map<string, SessionNonce>();
  private readonly usedSessionGrants = new Set<string>();
  private readonly controlEvents: QueuedControlEvent[] = [];
  private readonly pending = new Map<string, PendingCommand>();
  private readonly cdpClients = new Map<WebSocket, string>();
  private readonly targetDiscoveryClients = new Set<WebSocket>();
  private readonly controlEventStreamId = randomUUID();
  private attachSequence = 1;
  private commandSequence = 1;
  private controlEventSequence = 0;

  constructor(options: BridgeDaemonOptions) {
    this.options = {
      commandTimeoutMs: 30_000,
      detachedTargetGraceMs: 5_000,
      sessionRetentionMs: DEFAULT_SESSION_RETENTION_MS,
      ...options,
    };
    if (!this.options.sessionGrantSecret || !/^[a-f0-9]{64}$/i.test(this.options.sessionGrantSecret)) {
      throw new Error("Chrome bridge session grant secret must be a 64-character hexadecimal secret");
    }
    this.logger = createLogger(options.logPath);
    this.loadPersistedSessions();
    this.server = createServer((req, res) => {
      void this.handleHttp(req, res).catch((error) => {
        this.logger.error("bridge HTTP request failed", {
          method: req.method ?? null,
          path: req.url ?? null,
          error: error instanceof Error ? error.message : String(error),
        });
        if (res.headersSent) {
          res.destroy();
          return;
        }
        this.writeJson(res, 500, { error: "internal bridge error" });
      });
    });
    this.server.on("upgrade", (req, socket, head) => {
      try {
        this.handleUpgrade(req, socket, head);
      } catch (error) {
        this.logger.error("bridge WebSocket upgrade failed", {
          path: req.url ?? null,
          error: error instanceof Error ? error.message : String(error),
        });
        socket.destroy();
      }
    });
    this.extensionWss.on("connection", (ws) => this.handleExtensionConnection(ws));
    this.cdpWss.on("connection", (ws, req) => this.handleCdpConnection(ws, req));
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.server.off("error", onError);
        resolve();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(this.options.port, "127.0.0.1");
    });
  }

  async stop(): Promise<void> {
    await Promise.all(
      [...this.bridgeSessions.values()].map(async (session) => {
        await this.setBridgeControl(session, "stopped").catch(() => undefined);
        if (session.ownerSessionId) this.advanceOwnerControl(session.ownerSessionId, "stopped");
        await this.closeOwnedTargets(session);
      }),
    );
    this.persistSessions();
    await this.closeTransport();
  }

  private async closeTransport(): Promise<void> {
    await Promise.all(
      [...this.detachedTargetScopes.values()].map(async (detached) => {
        clearTimeout(detached.cleanupTimer);
        await this.closeTargetScope(detached.scope, "daemon-shutdown");
      }),
    );
    this.detachedTargetScopes.clear();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
    }
    this.pending.clear();
    for (const client of this.cdpClients.keys()) {
      client.close();
    }
    for (const peer of this.profiles.values()) {
      peer.ws.close();
    }
    await new Promise<void>((resolve) => this.extensionWss.close(() => resolve()));
    await new Promise<void>((resolve) => this.cdpWss.close(() => resolve()));
    await new Promise<void>((resolve) => {
      if (!this.server.listening) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
    });
  }

  /**
   * Stop only the disposable daemon transport. User-owned sessions remain in
   * a recoverable detached phase so a later daemon instance can reconnect to
   * the extension without inventing a new bridge token.
   */
  async shutdown(): Promise<void> {
    for (const session of this.bridgeSessions.values()) {
      const current = this.controlStates.get(session.sessionId);
      if (current?.phase === "stopped") continue;
      const attached = [...this.attachedSessions.values()].filter(
        (entry) => entry.bridgeSessionId === session.sessionId,
      );
      if (attached.length > 0) {
        this.detachedAttachments.set(session.sessionId, attached[attached.length - 1]);
        for (const entry of attached) this.attachedSessions.delete(entry.sessionId);
      }
      const detachedControl = {
        phase: "detached",
        epoch: (current?.epoch ?? 0) + 1,
        updatedAt: new Date().toISOString(),
      } satisfies ControlState;
      this.controlStates.set(session.sessionId, detachedControl);
      if (session.ownerSessionId) this.ownerControls.set(session.ownerSessionId, detachedControl);
    }
    this.persistSessions();
    await this.closeTransport();
  }

  status() {
    return {
      daemon: "ok",
      version: CHROME_EXTENSION_PROVIDER_VERSION,
      bridgeProtocolVersion: BRIDGE_PROTOCOL_VERSION,
      allowedExtensionId: this.options.allowedExtensionId ?? null,
      port: this.options.port,
      processId: process.pid,
      supervisedByNexolyra: this.options.supervisedByNexolyra === true,
      profiles: [...this.profiles.values()].map((peer) => ({
        profileId: peer.profileId,
        extensionId: peer.extensionId,
        extensionVersion: peer.extensionVersion ?? null,
        chromeVersion: peer.chromeVersion ?? null,
        tabCount: peer.tabs.size,
        tabs: [...peer.tabs.values()],
      })),
      sessions: [...this.bridgeSessions.values()].map((session) => ({
        sessionId: session.sessionId,
        profileId: session.profileId ?? null,
        ownerSessionId: session.ownerSessionId ?? null,
        createdAt: session.createdAt,
        control: this.controlStates.get(session.sessionId) ?? null,
      })),
    };
  }

  /** Public onboarding health excludes page and control-plane identities. */
  publicStatus() {
    const status = this.status();
    return {
      daemon: status.daemon,
      version: status.version,
      bridgeProtocolVersion: status.bridgeProtocolVersion,
      allowedExtensionId: status.allowedExtensionId,
      port: status.port,
      processId: status.processId,
      supervisedByNexolyra: status.supervisedByNexolyra,
      profiles: status.profiles.map(({ tabs: _tabs, ...profile }) => profile),
    };
  }

  private verifySessionGrant(value: unknown): SessionGrant | null {
    if (typeof value !== "string" || value.length > 4096) return null;
    const [encoded, signature, extra] = value.split(".");
    if (!encoded || !signature || extra) return null;
    const expected = createHmac("sha256", this.options.sessionGrantSecret!)
      .update(encoded)
      .digest("base64url");
    const providedBuffer = Buffer.from(signature, "utf8");
    const expectedBuffer = Buffer.from(expected, "utf8");
    if (
      providedBuffer.length !== expectedBuffer.length ||
      !timingSafeEqual(providedBuffer, expectedBuffer)
    ) {
      return null;
    }
    try {
      const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<
        string,
        unknown
      >;
      const ownerSessionId =
        typeof parsed.ownerSessionId === "string"
          ? validOwnerSessionId(parsed.ownerSessionId)
          : undefined;
      const profileUrlHint = validProfileUrlHint(parsed.profileUrlHint);
      const returnOrigin = validReturnOrigin(parsed.returnOrigin);
      if (
        parsed.v !== 1 ||
        typeof parsed.grantId !== "string" ||
        parsed.grantId.length < 8 ||
        parsed.grantId.length > 128 ||
        !ownerSessionId ||
        !profileUrlHint ||
        (parsed.returnOrigin !== undefined && !returnOrigin)
      ) {
        return null;
      }
      return {
        v: 1,
        grantId: parsed.grantId,
        ownerSessionId,
        profileUrlHint,
        ...(returnOrigin ? { returnOrigin } : {}),
      };
    } catch {
      return null;
    }
  }

  private issueSessionNonce(grant: SessionGrant): string {
    if (this.usedSessionGrants.has(grant.grantId)) {
      throw new Error("Owner-scoped session grant has already been used");
    }
    const existingScope = this.ownerScopes.get(grant.ownerSessionId);
    if (
      existingScope &&
      (existingScope.profileUrlHint !== grant.profileUrlHint ||
        existingScope.returnOrigin !== grant.returnOrigin)
    ) {
      throw new Error("Owner session scope does not match the signed grant");
    }
    const control = this.ownerControls.get(grant.ownerSessionId);
    if (control?.phase === "stopped") {
      throw new Error("Owner session is stopped");
    }
    this.ownerScopes.set(grant.ownerSessionId, {
      profileUrlHint: grant.profileUrlHint,
      ...(grant.returnOrigin ? { returnOrigin: grant.returnOrigin } : {}),
    });
    if (!control) {
      this.ownerControls.set(grant.ownerSessionId, {
        phase: "agent",
        epoch: 1,
        updatedAt: new Date().toISOString(),
      });
    }
    this.usedSessionGrants.add(grant.grantId);
    const nonce = randomBytes(24).toString("base64url");
    this.sessionNonces.set(nonce, {
      ownerSessionId: grant.ownerSessionId,
      profileUrlHint: grant.profileUrlHint,
      ...(grant.returnOrigin ? { returnOrigin: grant.returnOrigin } : {}),
      expiresAt: Date.now() + SESSION_NONCE_TTL_MS,
    });
    return nonce;
  }

  private consumeSessionNonce(value: unknown): SessionNonce | null {
    if (typeof value !== "string" || value.length < 16 || value.length > 128) return null;
    const nonce = this.sessionNonces.get(value);
    this.sessionNonces.delete(value);
    if (!nonce || nonce.expiresAt < Date.now()) return null;
    const control = this.ownerControls.get(nonce.ownerSessionId);
    if (!control || control.phase === "stopped") return null;
    return nonce;
  }

  private reuseOwnerBridgeSession(
    lease: SessionNonce,
    control: ControlState,
  ): BridgeSession | null {
    const sessions = [...this.bridgeSessions.values()].filter(
      (session) => session.ownerSessionId === lease.ownerSessionId,
    );
    if (sessions.length === 0) return null;
    if (sessions.length !== 1) {
      throw new Error("Owner session has multiple active Chrome bridge sessions");
    }
    const session = sessions[0];
    const sessionControl = this.controlStates.get(session.sessionId);
    if (
      !sessionControl ||
      sessionControl.phase === "stopped" ||
      sessionControl.phase !== control.phase ||
      sessionControl.epoch !== control.epoch ||
      !this.sessionTargetScopes.has(session.sessionId)
    ) {
      throw new Error("Existing Chrome bridge session is not safe to resume");
    }
    if (
      session.profileUrlHint !== lease.profileUrlHint ||
      session.returnOrigin !== lease.returnOrigin
    ) {
      throw new Error("Existing Chrome bridge session scope does not match the signed grant");
    }
    this.logger.debug("owner-scoped Chrome bridge session reused", {
      ownerSessionId: lease.ownerSessionId,
      sessionId: session.sessionId,
      phase: sessionControl.phase,
    });
    return { ...session };
  }

  /** Register one short-lived CDP entrypoint for a browser.provider launch. */
  createBridgeSession(
    profileId?: string,
    ownerSessionId?: string,
    profileUrlHint?: string,
    returnOrigin?: string,
    control: ControlState = {
      phase: "agent",
      epoch: 1,
      updatedAt: new Date().toISOString(),
    },
    initialTargetIds: readonly string[] = [],
  ): BridgeSession {
    const session: BridgeSession = {
      sessionId: randomUUID(),
      token: randomBytes(24).toString("base64url"),
      profileId,
      profileUrlHint,
      returnOrigin,
      ownerSessionId,
      createdAt: new Date().toISOString(),
    };
    this.bridgeSessions.set(session.sessionId, session);
    if (profileUrlHint) {
      const detached = ownerSessionId ? this.detachedTargetScopes.get(ownerSessionId) : undefined;
      if (detached?.profileUrlHint === profileUrlHint) {
        clearTimeout(detached.cleanupTimer);
        this.detachedTargetScopes.delete(ownerSessionId!);
        detached.scope.attachedTargetIds ??= new Set();
        this.sessionTargetScopes.set(session.sessionId, detached.scope);
      } else {
        this.sessionTargetScopes.set(session.sessionId, {
          targetIds: new Set(),
          attachedTargetIds: new Set(),
        });
      }
    } else {
      this.sessionTargetScopes.set(session.sessionId, {
        targetIds: new Set(),
        attachedTargetIds: new Set(initialTargetIds),
      });
    }
    this.controlStates.set(session.sessionId, { ...control });
    this.persistSessions();
    this.logger.debug("Chrome bridge session created", {
      ownerSessionId: ownerSessionId ?? null,
      sessionId: session.sessionId,
      phase: control.phase,
    });
    return session;
  }

  async detachBridgeSession(sessionId: string): Promise<boolean> {
    const session = this.bridgeSessions.get(sessionId);
    this.logger.debug("Chrome bridge session detach requested", {
      ownerSessionId: session?.ownerSessionId ?? null,
      sessionId,
    });
    if (session) {
      await this.setBridgeControl(session, "stopped");
      this.sessionTargetScopes.get(sessionId)?.attachedTargetIds.clear();
      await this.releaseOwnedTargets(session);
    }
    const existed = this.bridgeSessions.delete(sessionId);
    this.controlStates.delete(sessionId);
    this.detachedAttachments.delete(sessionId);
    for (const [attachedSessionId, attached] of this.attachedSessions) {
      if (attached.bridgeSessionId === sessionId) {
        this.attachedSessions.delete(attachedSessionId);
      }
    }
    this.persistSessions();
    return existed;
  }

  private preserveOwnerFenceForTransportRestart(sessionId: string): boolean {
    const session = this.bridgeSessions.get(sessionId);
    const control = this.controlStates.get(sessionId);
    if (
      !session?.ownerSessionId ||
      !control ||
      (control.phase !== "human" &&
        control.phase !== "detached" &&
        control.phase !== "resuming")
    ) {
      return false;
    }
    for (const [client, bridgeSessionId] of this.cdpClients) {
      if (bridgeSessionId !== sessionId) continue;
      this.cdpClients.delete(client);
      this.targetDiscoveryClients.delete(client);
      client.close(1001, "provider transport restarting");
    }
    this.persistSessions();
    this.logger.debug("Chrome bridge owner fence preserved across provider transport restart", {
      ownerSessionId: session.ownerSessionId,
      sessionId,
      phase: control.phase,
    });
    return true;
  }

  private loadPersistedSessions(): void {
    const statePath = this.options.statePath;
    if (!statePath) return;
    const sourcePath = existsSync(statePath)
      ? statePath
      : this.options.legacyStatePaths?.find((candidate) => existsSync(candidate));
    if (!sourcePath) return;
    let persisted: PersistedBridgeState;
    try {
      persisted = JSON.parse(readFileSync(sourcePath, "utf8")) as PersistedBridgeState;
    } catch {
      return;
    }
    if (
      (persisted.schemaVersion !== 1 && persisted.schemaVersion !== 2) ||
      !Array.isArray(persisted.sessions)
    )
      return;
    const now = Date.now();
    if (persisted.schemaVersion === 2 && Array.isArray(persisted.owners)) {
      for (const owner of persisted.owners) {
        const ownerSessionId =
          typeof owner?.ownerSessionId === "string"
            ? validOwnerSessionId(owner.ownerSessionId)
            : undefined;
        const control = owner?.control;
        if (
          !ownerSessionId ||
          !control ||
          !["agent", "human", "detached", "resuming", "stopped"].includes(control.phase) ||
          !Number.isInteger(control.epoch) ||
          typeof control.updatedAt !== "string"
        ) {
          continue;
        }
        this.ownerControls.set(ownerSessionId, { ...control });
        if (owner.scope) {
          const profileUrlHint = validProfileUrlHint(owner.scope.profileUrlHint);
          const returnOrigin = validReturnOrigin(owner.scope.returnOrigin);
          if (profileUrlHint) {
            this.ownerScopes.set(ownerSessionId, {
              profileUrlHint,
              ...(returnOrigin ? { returnOrigin } : {}),
            });
          }
        }
      }
    }
    for (const entry of persisted.sessions) {
      const session = entry?.session;
      const control = entry?.control;
      if (
        entry?.schemaVersion !== 1 ||
        !session ||
        typeof session.sessionId !== "string" ||
        typeof session.token !== "string" ||
        !session.token ||
        typeof session.ownerSessionId !== "string" ||
        !OWNER_SESSION_ID_PATTERN.test(session.ownerSessionId) ||
        !control ||
        control.phase === "stopped" ||
        typeof control.epoch !== "number" ||
        !Number.isInteger(control.epoch) ||
        !Array.isArray(entry.targetIds)
      ) {
        continue;
      }
      const savedAt = Date.parse(entry.savedAt || session.createdAt);
      if (
        !Number.isFinite(savedAt) ||
        now - savedAt > (this.options.sessionRetentionMs ?? DEFAULT_SESSION_RETENTION_MS)
      ) {
        continue;
      }
      const detachedControl: ControlState = {
        phase: "detached",
        epoch: Math.max(1, control.epoch + 1),
        updatedAt: new Date().toISOString(),
      };
      this.bridgeSessions.set(session.sessionId, session);
      this.controlStates.set(session.sessionId, detachedControl);
      if (!this.ownerControls.has(session.ownerSessionId)) {
        this.ownerControls.set(session.ownerSessionId, detachedControl);
      }
      if (session.profileUrlHint) {
        this.ownerScopes.set(session.ownerSessionId, {
          profileUrlHint: session.profileUrlHint,
          ...(session.returnOrigin ? { returnOrigin: session.returnOrigin } : {}),
        });
      }
      this.sessionTargetScopes.set(session.sessionId, {
        targetIds: new Set(entry.targetIds.filter((targetId) => typeof targetId === "string")),
        attachedTargetIds: new Set(
          (entry.attachedTargetIds ?? []).filter(
            (targetId): targetId is string => typeof targetId === "string",
          ),
        ),
      });
      if (
        entry.detachedAttachment &&
        typeof entry.detachedAttachment.sessionId === "string" &&
        typeof entry.detachedAttachment.profileId === "string" &&
        typeof entry.detachedAttachment.tabId === "number"
      ) {
        this.detachedAttachments.set(session.sessionId, entry.detachedAttachment);
      }
      // The previous daemon may have shut down after persisting the session,
      // so its in-memory event queue is gone. Re-emit the lifecycle boundary
      // for Nexolyra before accepting a reconnect; otherwise the provider is
      // detached while the coordinator still believes it is agent-owned.
      this.enqueueControlEvent({
        ownerSessionId: session.ownerSessionId,
        bridgeSessionId: session.sessionId,
        action: "detach",
        reason: "extension_disconnected",
        tabId: entry.detachedAttachment?.tabId ?? 0,
        ...(entry.detachedAttachment
          ? {
              targetId: targetIdFor(
                entry.detachedAttachment.profileId,
                entry.detachedAttachment.tabId,
              ),
            }
          : {}),
        pendingActionRisk: true,
      });
    }
    this.persistSessions();
    if (sourcePath !== statePath) rmSync(sourcePath, { force: true });
  }

  private persistSessions(): void {
    const statePath = this.options.statePath;
    if (!statePath) return;
    const sessions: PersistedBridgeSession[] = [];
    for (const session of this.bridgeSessions.values()) {
      if (!session.ownerSessionId || !OWNER_SESSION_ID_PATTERN.test(session.ownerSessionId))
        continue;
      const control = this.controlStates.get(session.sessionId);
      if (!control || control.phase === "stopped") continue;
      sessions.push({
        schemaVersion: 1,
        session: { ...session },
        control: { ...control },
        targetIds: [...(this.sessionTargetScopes.get(session.sessionId)?.targetIds ?? [])],
        attachedTargetIds: [
          ...(this.sessionTargetScopes.get(session.sessionId)?.attachedTargetIds ?? []),
        ],
        ...(this.detachedAttachments.has(session.sessionId)
          ? { detachedAttachment: this.detachedAttachments.get(session.sessionId) }
          : {}),
        savedAt: new Date().toISOString(),
      });
    }
    const owners = [...this.ownerControls.entries()].map(([ownerSessionId, control]) => ({
      ownerSessionId,
      control: { ...control },
      ...(this.ownerScopes.has(ownerSessionId)
        ? { scope: { ...this.ownerScopes.get(ownerSessionId)! } }
        : {}),
    }));
    if (sessions.length === 0 && owners.length === 0) {
      rmSync(statePath, { force: true });
      return;
    }
    mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
    const staged = `${statePath}.${randomUUID()}.tmp`;
    try {
      writeFileSync(staged, `${JSON.stringify({ schemaVersion: 2, sessions, owners })}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      renameSync(staged, statePath);
    } finally {
      rmSync(staged, { force: true });
    }
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    // Host control requests come from the local Node runtime and therefore do
    // not carry a browser Origin. Reject browser-initiated requests before
    // dispatch so a hostile page cannot create sessions or mutate ownership
    // through a blind loopback CSRF. The extension's onboarding page only
    // needs the separately allowlisted, read-only health route below.
    if (url.pathname !== "/health" && req.headers.origin) {
      this.writeJson(res, 403, { error: "browser-origin requests are not allowed" });
      return;
    }
    if (
      (url.pathname === "/control" || url.pathname.startsWith("/control/")) &&
      !this.hasValidControlToken(req)
    ) {
      this.writeJson(res, 401, { error: "Nexolyra control authentication is required" });
      return;
    }
    if (req.method === "OPTIONS" && url.pathname === "/health") {
      const corsHeaders = this.healthCorsHeaders(req);
      if (!corsHeaders) {
        this.writeJson(res, 403, { error: "extension origin is not allowed" });
        return;
      }
      res.writeHead(204, {
        ...corsHeaders,
        "access-control-allow-methods": "GET, OPTIONS",
        "access-control-allow-headers": "content-type",
        ...(req.headers["access-control-request-private-network"] === "true"
          ? { "access-control-allow-private-network": "true" }
          : {}),
        "access-control-max-age": "600",
      });
      res.end();
      return;
    }
    if (req.method === "GET" && url.pathname === "/health") {
      this.writeJson(res, 200, this.publicStatus(), this.healthCorsHeaders(req) ?? undefined);
      return;
    }
    if (req.method === "GET" && url.pathname === "/control/status") {
      this.writeJson(res, 200, this.status());
      return;
    }
    if (req.method === "POST" && url.pathname === "/session-leases") {
      const body = await readJsonBody(req);
      const grant = this.verifySessionGrant(body.grant);
      if (!grant) {
        this.writeJson(res, 400, { error: "A valid owner-scoped session grant is required" });
        return;
      }
      try {
        this.writeJson(res, 200, {
          nonce: this.issueSessionNonce(grant),
          expiresInMs: SESSION_NONCE_TTL_MS,
        });
      } catch (error) {
        this.writeJson(res, 409, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    if (req.method === "POST" && url.pathname === "/sessions") {
      const body = await readJsonBody(req);
      if (!this.hasValidControlToken(req)) {
        const lease = this.consumeSessionNonce(body.nonce);
        if (!lease) {
          this.writeJson(res, 401, { error: "A fresh owner-scoped session nonce is required" });
          return;
        }
        const control = this.ownerControls.get(lease.ownerSessionId);
        if (!control) {
          this.writeJson(res, 409, { error: "Owner control state is unavailable" });
          return;
        }
        try {
          const session =
            this.reuseOwnerBridgeSession(lease, control) ??
            this.createBridgeSession(
              undefined,
              lease.ownerSessionId,
              lease.profileUrlHint,
              lease.returnOrigin,
              control,
            );
          this.writeJson(res, 200, session);
        } catch (error) {
          this.writeJson(res, 409, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }
      const profileId =
        typeof body.profileId === "string" && body.profileId ? body.profileId : undefined;
      const profileUrlHint = validProfileUrlHint(body.profileUrlHint);
      if (body.profileUrlHint !== undefined && !profileUrlHint) {
        this.writeJson(res, 400, {
          error: "profileUrlHint must be a pathname suffix of at most 512 characters",
        });
        return;
      }
      const returnOrigin = validReturnOrigin(body.returnOrigin);
      if (body.returnOrigin !== undefined && !returnOrigin) {
        this.writeJson(res, 400, {
          error: "returnOrigin must be an HTTP(S) loopback origin",
        });
        return;
      }
      const ownerSessionId =
        typeof body.ownerSessionId === "string" &&
        OWNER_SESSION_ID_PATTERN.test(body.ownerSessionId)
          ? body.ownerSessionId
          : undefined;
      if (!ownerSessionId) {
        this.writeJson(res, 400, { error: "ownerSessionId is required" });
        return;
      }
      const existingControl = this.ownerControls.get(ownerSessionId);
      if (existingControl?.phase === "stopped") {
        this.writeJson(res, 409, { error: "Owner session is stopped" });
        return;
      }
      const control =
        existingControl ??
        ({ phase: "agent", epoch: 1, updatedAt: new Date().toISOString() } satisfies ControlState);
      this.ownerControls.set(ownerSessionId, control);
      if (profileUrlHint) {
        this.ownerScopes.set(ownerSessionId, {
          profileUrlHint,
          ...(returnOrigin ? { returnOrigin } : {}),
        });
      }
      const requestedTargetIds = Array.isArray(body.targetIds)
        ? body.targetIds.filter((value): value is string => typeof value === "string")
        : null;
      if (Array.isArray(body.targetIds) && requestedTargetIds?.length !== body.targetIds.length) {
        this.writeJson(res, 400, { error: "targetIds must contain only target identities" });
        return;
      }
      const initialTargetIds =
        requestedTargetIds ??
        (profileUrlHint
          ? []
          : [...this.profiles.values()]
              .filter((peer) => !profileId || peer.profileId === profileId)
              .flatMap((peer) =>
                [...peer.tabs.values()]
                  .filter(shouldExposeTab)
                  .map((tab) => targetIdFor(peer.profileId, tab.tabId)),
              ));
      const session = this.createBridgeSession(
        profileId,
        ownerSessionId,
        profileUrlHint,
        returnOrigin,
        control,
        initialTargetIds,
      );
      this.writeJson(res, 200, session);
      return;
    }
    if (req.method === "GET" && url.pathname === "/control/events") {
      const after = Math.max(0, Number.parseInt(url.searchParams.get("after") || "0", 10) || 0);
      this.writeJson(res, 200, {
        streamId: this.controlEventStreamId,
        sequence: this.controlEventSequence,
        events: this.controlEvents.filter((event) => event.sequence > after),
      });
      return;
    }
    const controlMatch = /^\/control\/sessions\/([^/]+)$/.exec(url.pathname);
    if (req.method === "POST" && controlMatch) {
      const ownerSessionId = validOwnerSessionId(controlMatch[1]);
      if (!ownerSessionId) {
        this.writeJson(res, 400, { error: "owner session id is invalid" });
        return;
      }
      const body = await readJsonBody(req);
      const phase = body.phase;
      if (
        phase !== "agent" &&
        phase !== "human" &&
        phase !== "resuming" &&
        phase !== "stopped"
      ) {
        this.writeJson(res, 400, {
          error: "phase must be agent, human, resuming, or stopped",
        });
        return;
      }
      try {
        const result = await this.setOwnerControl(ownerSessionId, phase);
        this.writeJson(res, 200, {
          matched: result.matched,
          focusConfirmed: result.focusConfirmed,
        });
      } catch (error) {
        this.writeJson(res, 409, {
          matched: this.bridgeSessionsHasOwner(ownerSessionId) ? 1 : 0,
          focusConfirmed: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    const reconnectMatch = /^\/control\/sessions\/([^/]+)\/reconnect$/.exec(url.pathname);
    if (req.method === "POST" && reconnectMatch) {
      const ownerSessionId = validOwnerSessionId(reconnectMatch[1]);
      if (!ownerSessionId) {
        this.writeJson(res, 400, { error: "owner session id is invalid" });
        return;
      }
      const body = await readJsonBody(req);
      const targetId = typeof body.targetId === "string" ? body.targetId : undefined;
      try {
        this.writeJson(
          res,
          200,
          await this.reconnectOwnerSession(ownerSessionId, targetId),
        );
      } catch (error) {
        this.writeJson(res, 409, {
          matched: this.bridgeSessionsHasOwner(ownerSessionId) ? 1 : 0,
          attached: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    const targetsMatch = /^\/control\/sessions\/([^/]+)\/targets$/.exec(url.pathname);
    if (req.method === "GET" && targetsMatch) {
      const ownerSessionId = validOwnerSessionId(targetsMatch[1]);
      if (!ownerSessionId) {
        this.writeJson(res, 400, { error: "owner session id is invalid" });
        return;
      }
      this.writeJson(res, 200, {
        targets: this.reconnectTargets(ownerSessionId),
        generatedAt: new Date().toISOString(),
      });
      return;
    }
    const detachMatch = /^\/sessions\/([^/]+)\/detach$/.exec(url.pathname);
    if (req.method === "POST" && detachMatch) {
      const sessionId = decodePathSegment(detachMatch[1]);
      if (!sessionId) {
        this.writeJson(res, 400, { error: "bridge session id is invalid" });
        return;
      }
      const hostAuthorized = this.hasValidControlToken(req);
      const sessionAuthorized = this.hasValidSessionToken(req, sessionId);
      if (!hostAuthorized && !sessionAuthorized) {
        this.writeJson(res, 401, { error: "Bridge session authentication is required" });
        return;
      }
      if (!hostAuthorized && this.preserveOwnerFenceForTransportRestart(sessionId)) {
        this.writeJson(res, 200, { detached: false, preserved: true });
        return;
      }
      this.writeJson(res, 200, { detached: await this.detachBridgeSession(sessionId) });
      return;
    }
    this.writeJson(res, 404, { error: "not found" });
  }

  private hasValidControlToken(req: IncomingMessage): boolean {
    if (!this.options.controlToken) return false;
    const authorization = req.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) return false;
    const provided = Buffer.from(authorization.slice("Bearer ".length), "utf8");
    const expected = Buffer.from(this.options.controlToken, "utf8");
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  }

  private hasValidSessionToken(req: IncomingMessage, sessionId: string): boolean {
    const session = this.bridgeSessions.get(sessionId);
    const authorization = req.headers.authorization;
    if (!session || !authorization?.startsWith("Bearer ")) return false;
    const provided = Buffer.from(authorization.slice("Bearer ".length), "utf8");
    const expected = Buffer.from(session.token, "utf8");
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  }

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    if (url.pathname === "/bridge") {
      this.logger.debug("extension upgrade requested", {
        origin: req.headers.origin ?? null,
      });
      if (
        this.options.allowedExtensionId &&
        req.headers.origin !== `chrome-extension://${this.options.allowedExtensionId}`
      ) {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      this.extensionWss.handleUpgrade(req, socket, head, (ws) => {
        this.extensionWss.emit("connection", ws, req);
      });
      return;
    }
    if (url.pathname === "/devtools/browser/bridge") {
      const sessionId = url.searchParams.get("session") ?? "";
      const token = url.searchParams.get("token") ?? "";
      const session = this.bridgeSessions.get(sessionId);
      if (!session || session.token !== token) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      this.cdpWss.handleUpgrade(req, socket, head, (ws) => {
        this.cdpWss.emit("connection", ws, req);
      });
      return;
    }
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
  }

  private handleExtensionConnection(ws: WebSocket) {
    ws.on("message", (raw) => {
      const message = parseBridgeMessage(raw);
      if (!message) {
        ws.send(
          JSON.stringify({
            v: BRIDGE_PROTOCOL_VERSION,
            kind: "error",
            message: "invalid bridge message",
          }),
        );
        return;
      }
      void this.handleBridgeMessage(ws, message).catch((error) => {
        // Extension messages are an external event stream. One rejected focus
        // or stale detach must not become an unhandled rejection that kills
        // the shared daemon and disconnects every browser-control session.
        this.logger.error("extension bridge message failed", {
          kind: message.kind,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });
    ws.on("close", () => {
      for (const [profileId, peer] of this.profiles) {
        if (peer.ws === ws) {
          for (const attached of [...this.attachedSessions.values()]) {
            if (attached.profileId !== profileId) continue;
            void this.handleDetachedTarget(
              profileId,
              attached.tabId,
              attached.sessionId,
              "extension_disconnected",
            );
          }
          this.profiles.delete(profileId);
        }
      }
    });
  }

  private async handleBridgeMessage(ws: WebSocket, message: BridgeMessage) {
    if (message.v !== BRIDGE_PROTOCOL_VERSION) {
      ws.send(
        JSON.stringify({
          v: BRIDGE_PROTOCOL_VERSION,
          kind: "error",
          message: "unsupported bridge protocol version",
        }),
      );
      return;
    }
    if (message.kind === "hello") {
      if (
        this.options.allowedExtensionId &&
        message.extensionId !== this.options.allowedExtensionId
      ) {
        ws.send(
          JSON.stringify({
            v: BRIDGE_PROTOCOL_VERSION,
            kind: "error",
            message: "extension id is not allowed",
          }),
        );
        ws.close();
        return;
      }
      const previousTabs = this.profiles.get(message.profileId)?.tabs ?? new Map<number, BridgeTab>();
      this.profiles.set(message.profileId, {
        profileId: message.profileId,
        extensionId: message.extensionId,
        extensionVersion: message.extensionVersion,
        chromeVersion: message.chromeVersion,
        ws,
        tabs: tabsToMap(message.tabs ?? []),
      });
      this.reconcileOwnedChildTargets(message.profileId, previousTabs);
      await this.reconcileProfileTabs(message.profileId);
      await this.resyncProfileOverlays(message.profileId);
      this.logger.debug("extension profile connected", { profileId: message.profileId });
      return;
    }
    if (message.kind === "heartbeat") {
      const peer = this.profiles.get(message.profileId);
      if (peer && message.tabs) {
        const previousTabs = peer.tabs;
        peer.tabs = tabsToMap(message.tabs);
        this.reconcileOwnedChildTargets(message.profileId, previousTabs);
        await this.reconcileProfileTabs(message.profileId);
      }
      return;
    }
    if (message.kind === "cdp-result") {
      this.resolvePending(message);
      return;
    }
    if (message.kind === "cdp-event") {
      this.forwardCdpEvent(
        message.profileId,
        message.tabId,
        message.sessionId,
        message.method,
        message.params ?? {},
      );
      return;
    }
    if (message.kind === "control-event") {
      await this.handleControlEvent(message);
      return;
    }
    if (message.kind === "detach") {
      await this.handleDetachedTarget(
        message.profileId,
        message.tabId,
        message.sessionId,
        message.reason,
      );
    }
  }

  private handleCdpConnection(ws: WebSocket, req: IncomingMessage) {
    const bridgeSession = this.sessionFromRequest(req);
    if (!bridgeSession) {
      ws.close();
      return;
    }
    this.cdpClients.set(ws, bridgeSession.sessionId);
    ws.on("message", (raw) => {
      const message = parseCdpRequest(raw);
      if (!message) {
        ws.send(JSON.stringify({ error: cdpError("Invalid CDP JSON-RPC message") }));
        return;
      }
      void this.handleCdpRequest(ws, req, message);
    });
    ws.on("close", () => {
      this.cdpClients.delete(ws);
      this.targetDiscoveryClients.delete(ws);
    });
  }

  private async handleCdpRequest(ws: WebSocket, req: IncomingMessage, message: CdpRequest) {
    if (typeof message.id !== "number" || !message.method) {
      return;
    }
    const bridgeSession = this.sessionFromRequest(req);
    if (!bridgeSession) {
      this.sendCdpError(ws, message.id, cdpError("Bridge session is not registered"));
      return;
    }
    try {
      const browserLevel = await this.routeBrowserLevel(ws, bridgeSession, message);
      if (browserLevel.handled) {
        this.sendCdpResult(ws, message.id, browserLevel.result);
        return;
      }
      await this.forwardPageLevel(ws, bridgeSession, message);
    } catch (error) {
      this.sendCdpError(
        ws,
        message.id,
        cdpError(error instanceof Error ? error.message : String(error)),
      );
    }
  }

  private sessionFromRequest(req: IncomingMessage): BridgeSession | undefined {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    const sessionId = url.searchParams.get("session") ?? "";
    return this.bridgeSessions.get(sessionId);
  }

  private async routeBrowserLevel(
    ws: WebSocket,
    bridgeSession: BridgeSession,
    request: CdpRequest,
  ): Promise<{ handled: boolean; result?: unknown }> {
    const method = request.method;
    if (!method) return { handled: false };
    if (method === "Browser.getVersion") {
      const peer = this.trySelectProfile(bridgeSession);
      return {
        handled: true,
        result: {
          protocolVersion: "1.3",
          product: peer?.chromeVersion ? `Chrome/${peer.chromeVersion}` : "Chrome/extension-bridge",
          revision: "",
          userAgent: "agent-browser chrome extension bridge",
          jsVersion: "",
        },
      };
    }
    if (method === "Browser.close") {
      // agent-browser may issue this while recycling its CDP background client.
      // The authenticated provider detach route owns task-tab cleanup.
      return { handled: true, result: {} };
    }
    if (method === "Target.setDiscoverTargets") {
      if (request.params?.discover === true) this.targetDiscoveryClients.add(ws);
      else this.targetDiscoveryClients.delete(ws);
      return { handled: true, result: {} };
    }
    if (method === "Target.setAutoAttach") {
      return { handled: true, result: {} };
    }
    if (method === "Target.getTargets") {
      const peer = this.selectProfile(bridgeSession);
      return {
        handled: true,
        result: {
          targetInfos: this.tabsForSession(bridgeSession, peer)
            .filter(shouldExposeTab)
            .map((tab) =>
              targetInfoFor(
                peer.profileId,
                tab,
                this.hasAttachedSession(peer.profileId, tab.tabId),
              ),
            ),
        },
      };
    }
    if (method === "Target.createTarget") {
      this.assertAgentControl(bridgeSession);
      const peer = this.selectProfile(bridgeSession);
      const url = stringParam(request.params, "url") || "about:blank";
      if (!isAutomatableUrl(url)) {
        throw new Error(`The Chrome extension bridge cannot automate this URL: ${url}`);
      }
      const scoped = this.sessionTargetScopes.has(bridgeSession.sessionId);
      const tab = await this.sendBridgeCommand<BridgeTab>(
        peer,
        scoped
          ? {
              method: "Bridge.createWindow",
              params: { url, focused: false },
            }
          : {
              method: "Bridge.createTab",
              params: { url },
            },
      );
      this.markTabActive(peer, tab);
      peer.tabs.set(tab.tabId, tab);
      const targetId = targetIdFor(peer.profileId, tab.tabId);
      this.sessionTargetScopes.get(bridgeSession.sessionId)?.targetIds.add(targetId);
      return { handled: true, result: { targetId } };
    }
    if (method === "Target.attachToTarget") {
      const targetId = stringParam(request.params, "targetId");
      if (!targetId) throw new Error("Target.attachToTarget requires targetId");
      this.assertTargetAllowed(bridgeSession, targetId);
      const ref = parseTargetId(targetId);
      if (!ref) throw new Error(`Unknown targetId: ${targetId}`);
      const peer = this.profiles.get(ref.profileId);
      if (!peer || !peer.tabs.has(ref.tabId))
        throw new Error(`Target is not available: ${targetId}`);
      const control = this.controlStates.get(bridgeSession.sessionId);
      if (control?.phase === "resuming") {
        const existing = [...this.attachedSessions.values()].find(
          (entry) =>
            entry.bridgeSessionId === bridgeSession.sessionId &&
            entry.profileId === ref.profileId &&
            entry.tabId === ref.tabId,
        );
        if (!existing) {
          this.logger.error("semantic readback target did not match a preserved attachment", {
            bridgeSessionId: bridgeSession.sessionId,
            requestedTargetId: targetId,
            preservedTargetIds: [...this.attachedSessions.values()]
              .filter((entry) => entry.bridgeSessionId === bridgeSession.sessionId)
              .map((entry) => targetIdFor(entry.profileId, entry.tabId)),
          });
          throw new Error("Semantic readback can attach only to the reconnected task tab");
        }
        return { handled: true, result: { sessionId: existing.sessionId } };
      }
      this.assertAgentControl(bridgeSession);
      this.assertTabAvailableToSession(bridgeSession, ref.profileId, ref.tabId);
      const sessionId = sessionIdFor(ref.tabId, this.attachSequence++);
      this.attachedSessions.set(sessionId, {
        sessionId,
        bridgeSessionId: bridgeSession.sessionId,
        profileId: ref.profileId,
        tabId: ref.tabId,
      });
      await this.showControlOverlay(
        bridgeSession,
        this.attachedSessions.get(sessionId) as AttachedSession,
      );
      return { handled: true, result: { sessionId } };
    }
    if (method === "Target.activateTarget") {
      this.assertAgentControl(bridgeSession);
      const targetId = stringParam(request.params, "targetId");
      this.assertTargetAllowed(bridgeSession, targetId);
      const peerAndTab = this.peerAndTabFromTargetId(targetId);
      this.assertTabAvailableToSession(
        bridgeSession,
        peerAndTab.peer.profileId,
        peerAndTab.tab.tabId,
      );
      await this.sendBridgeCommand(peerAndTab.peer, {
        method: "Bridge.activateTab",
        params: { tabId: peerAndTab.tab.tabId },
      });
      this.markTabActive(peerAndTab.peer, peerAndTab.tab);
      return { handled: true, result: {} };
    }
    if (method === "Target.closeTarget") {
      this.assertAgentControl(bridgeSession);
      const targetId = stringParam(request.params, "targetId");
      this.assertTargetAllowed(bridgeSession, targetId);
      const peerAndTab = this.peerAndTabFromTargetId(targetId);
      this.assertTabAvailableToSession(
        bridgeSession,
        peerAndTab.peer.profileId,
        peerAndTab.tab.tabId,
      );
      await this.sendBridgeCommand(peerAndTab.peer, {
        method: "Bridge.closeTab",
        params: { tabId: peerAndTab.tab.tabId },
      });
      peerAndTab.peer.tabs.delete(peerAndTab.tab.tabId);
      if (targetId) {
        this.sessionTargetScopes.get(bridgeSession.sessionId)?.targetIds.delete(targetId);
      }
      this.deleteAttachedSessionsForTab(peerAndTab.peer.profileId, peerAndTab.tab.tabId);
      return { handled: true, result: { success: true } };
    }
    return { handled: false };
  }

  private async forwardPageLevel(ws: WebSocket, bridgeSession: BridgeSession, request: CdpRequest) {
    if (request.method === "Target.setAutoAttach") {
      this.sendCdpResult(ws, request.id as number, {});
      return;
    }
    this.assertControlAllows(bridgeSession, request.method as string, request.params);
    const attached = request.sessionId ? this.attachedSessions.get(request.sessionId) : undefined;
    if (!attached) {
      const peer = this.selectProfile(bridgeSession);
      const tabs = this.tabsForSession(bridgeSession, peer);
      const activeTab =
        tabs.find((tab) => tab.active && shouldExposeTab(tab)) ?? tabs.find(shouldExposeTab);
      if (!activeTab) throw new Error("No automatable tab is available");
      this.assertTabAvailableToSession(bridgeSession, peer.profileId, activeTab.tabId);
      const sessionId = sessionIdFor(activeTab.tabId, this.attachSequence++);
      this.attachedSessions.set(sessionId, {
        sessionId,
        bridgeSessionId: bridgeSession.sessionId,
        profileId: peer.profileId,
        tabId: activeTab.tabId,
      });
      request.sessionId = sessionId;
      await this.showControlOverlay(
        bridgeSession,
        this.attachedSessions.get(sessionId) as AttachedSession,
      );
    }
    const session = this.attachedSessions.get(request.sessionId as string);
    if (!session) throw new Error(`Unknown sessionId: ${request.sessionId}`);
    if (session.bridgeSessionId !== bridgeSession.sessionId) {
      throw new Error("The CDP attachment belongs to another bridge session");
    }
    const peer = this.profiles.get(session.profileId);
    if (!peer) throw new Error(`Profile is offline: ${session.profileId}`);
    const captureParams = request.params ?? {};
    await this.sendBridgeCommand(
      peer,
      {
        method: request.method as string,
        params:
          request.method === "Page.startScreencast"
            ? { ...request.params, ...LIVE_SCREENCAST_PARAMS }
            : request.method === "Page.captureScreenshot"
              ? { fromSurface: true, ...captureParams }
              : captureParams,
        sessionId: session.sessionId,
        tabId: session.tabId,
      },
      ws,
      request.id as number,
      bridgeSession.sessionId,
    );
  }

  private assertAgentControl(session: BridgeSession): void {
    this.assertControlAllows(session, "");
  }

  private assertControlAllows(
    session: BridgeSession,
    method: string,
    params?: Record<string, unknown>,
  ): void {
    const state = this.controlStates.get(session.sessionId);
    if (state?.phase === "human" && !isObserverCdpMethod(method)) {
      throw new Error("Browser control is held by the user");
    }
    if (state?.phase === "resuming" && !isSemanticReadbackCdpRequest(method, params)) {
      throw new Error("Browser control is resuming with semantic readback only");
    }
    if (
      state?.phase === "stopped" &&
      method !== "Page.stopScreencast" &&
      method !== "Page.screencastFrameAck"
    ) {
      throw new Error("Browser control is stopped");
    }
    if (state?.phase === "detached") {
      throw new Error("Browser control is detached from Chrome");
    }
  }

  private async showControlOverlay(
    bridgeSession: BridgeSession,
    attached: AttachedSession,
  ): Promise<void> {
    const peer = this.profiles.get(attached.profileId);
    if (!peer) return;
    const phase = this.controlStates.get(bridgeSession.sessionId)?.phase ?? "agent";
    await this.sendBridgeCommand(peer, {
      method: "Bridge.setControlOverlay",
      sessionId: attached.sessionId,
      tabId: attached.tabId,
      params: {
        phase,
        ...(phase === "human" && bridgeSession.profileUrlHint && bridgeSession.returnOrigin
          ? {
              returnPath: bridgeSession.profileUrlHint,
              returnOrigin: bridgeSession.returnOrigin,
            }
          : {}),
      },
    });
  }

  private async resyncProfileOverlays(profileId: string): Promise<void> {
    for (const attached of this.attachedSessions.values()) {
      if (attached.profileId !== profileId) continue;
      const session = this.bridgeSessions.get(attached.bridgeSessionId);
      if (session) await this.showControlOverlay(session, attached).catch(() => undefined);
    }
  }

  private async handleControlEvent(message: BridgeControlEvent): Promise<void> {
    const attached = this.attachedSessions.get(message.sessionId);
    if (!attached || attached.profileId !== message.profileId || attached.tabId !== message.tabId)
      return;
    const bridgeSession = this.bridgeSessions.get(attached.bridgeSessionId);
    if (!bridgeSession?.ownerSessionId) return;
    const current = this.controlStates.get(bridgeSession.sessionId);
    if (message.action === "takeover" && current?.phase !== "agent") return;
    if (message.action === "stop" && current?.phase === "stopped") return;
    const pendingActionRisk = [...this.pending.values()].some(
      (pending) => pending.bridgeSessionId === bridgeSession.sessionId,
    );
    await this.setBridgeControl(
      bridgeSession,
      message.action === "takeover" ? "human" : "stopped",
      {
        preferredAttached: attached,
        // The operator clicked inside this exact page, so ownership must be
        // fenced even if macOS/Chrome declines a redundant focus request. The
        // host-side takeover route remains strict and reports focus failure.
        tolerateFocusFailure: message.action === "takeover",
      },
    );
    this.advanceOwnerControl(
      bridgeSession.ownerSessionId,
      message.action === "takeover" ? "human" : "stopped",
    );
    this.persistSessions();
    this.enqueueControlEvent({
      ownerSessionId: bridgeSession.ownerSessionId,
      bridgeSessionId: bridgeSession.sessionId,
      action: message.action,
      tabId: message.tabId,
      targetId: targetIdFor(attached.profileId, message.tabId),
      pendingActionRisk,
    });
  }

  private async handleDetachedTarget(
    profileId: string,
    tabId: number,
    sessionId: string,
    reason: BridgeDetachReason,
  ): Promise<void> {
    const attached = this.attachedSessions.get(sessionId);
    if (!attached || attached.profileId !== profileId || attached.tabId !== tabId) return;
    const bridgeSession = this.bridgeSessions.get(attached.bridgeSessionId);
    if (!bridgeSession?.ownerSessionId) return;
    const current = this.controlStates.get(bridgeSession.sessionId);
    if (current?.phase === "stopped") return;
    const pendingActionRisk = [...this.pending.values()].some(
      (pending) => pending.bridgeSessionId === bridgeSession.sessionId,
    );
    this.detachedAttachments.set(bridgeSession.sessionId, {
      sessionId: attached.sessionId,
      profileId: attached.profileId,
      tabId: attached.tabId,
    });
    this.sessionTargetScopes.get(bridgeSession.sessionId)?.attachedTargetIds.delete(
      targetIdFor(attached.profileId, attached.tabId),
    );
    await this.setBridgeControl(bridgeSession, "detached");
    this.advanceOwnerControl(bridgeSession.ownerSessionId, "detached");
    this.attachedSessions.delete(attached.sessionId);
    this.enqueueControlEvent({
      ownerSessionId: bridgeSession.ownerSessionId,
      bridgeSessionId: bridgeSession.sessionId,
      action: "detach",
      reason,
      tabId,
      targetId: targetIdFor(attached.profileId, tabId),
      pendingActionRisk,
    });
    this.persistSessions();
  }

  /**
   * A Chrome restart can kill the extension worker before it has a chance to
   * emit `detach`. Reconcile the daemon's attachment table against each full
   * hello/heartbeat tab snapshot so those sessions enter the same recoverable
   * detached state instead of staying falsely attached forever.
   */
  private async reconcileProfileTabs(profileId: string): Promise<void> {
    const peer = this.profiles.get(profileId);
    if (!peer) return;
    for (const attached of [...this.attachedSessions.values()]) {
      if (attached.profileId !== profileId || peer.tabs.has(attached.tabId)) continue;
      await this.handleDetachedTarget(
        profileId,
        attached.tabId,
        attached.sessionId,
        "browser_closed",
      );
    }
  }

  /**
   * Extend an existing target ownership chain to child tabs created by that
   * target. Chrome reports a child before its final URL is always known, so the
   * full heartbeat snapshot is reconciled on every pass rather than considering
   * only newly seen tab ids.
   */
  private reconcileOwnedChildTargets(
    profileId: string,
    previousTabs: Map<number, BridgeTab>,
  ): void {
    const peer = this.profiles.get(profileId);
    if (!peer) return;
    const claimedTargets = new Set<string>();
    for (const scope of this.sessionTargetScopes.values()) {
      for (const targetId of scope.targetIds) claimedTargets.add(targetId);
      for (const targetId of scope.attachedTargetIds) claimedTargets.add(targetId);
    }

    let changed = false;
    for (const tab of peer.tabs.values()) {
      if (typeof tab.openerTabId !== "number" || !shouldExposeTab(tab)) continue;
      const childTargetId = targetIdFor(profileId, tab.tabId);
      if (claimedTargets.has(childTargetId)) continue;
      const openerTargetId = targetIdFor(profileId, tab.openerTabId);
      const candidates = [...this.sessionTargetScopes.entries()].filter(([sessionId, scope]) => {
        const control = this.controlStates.get(sessionId);
        return (
          control !== undefined &&
          control.phase !== "stopped" &&
          this.bridgeSessions.has(sessionId) &&
          (scope.targetIds.has(openerTargetId) || scope.attachedTargetIds.has(openerTargetId))
        );
      });
      if (candidates.length !== 1) {
        if (candidates.length > 1) {
          this.logger.error("child target ownership is ambiguous", {
            profileId,
            tabId: tab.tabId,
            openerTabId: tab.openerTabId,
            candidateSessionIds: candidates.map(([sessionId]) => sessionId),
          });
        }
        continue;
      }
      const [bridgeSessionId, scope] = candidates[0];
      scope.targetIds.add(childTargetId);
      claimedTargets.add(childTargetId);
      changed = true;
      this.logger.debug("child target adopted by bridge session", {
        profileId,
        tabId: tab.tabId,
        openerTabId: tab.openerTabId,
        bridgeSessionId,
      });
      if (this.controlStates.get(bridgeSessionId)?.phase === "agent") {
        this.broadcastTargetEvent(bridgeSessionId, "Target.targetCreated", {
          targetInfo: targetInfoFor(profileId, tab, false),
        });
      }
    }

    for (const [bridgeSessionId, scope] of this.sessionTargetScopes) {
      const phase = this.controlStates.get(bridgeSessionId)?.phase;
      for (const targetId of [...scope.targetIds]) {
        const ref = parseTargetId(targetId);
        if (ref?.profileId !== profileId) continue;
        const previous = previousTabs.get(ref.tabId);
        const current = peer.tabs.get(ref.tabId);
        if (previous && !current) {
          scope.targetIds.delete(targetId);
          scope.attachedTargetIds.delete(targetId);
          claimedTargets.delete(targetId);
          changed = true;
          if (phase !== "stopped") {
            this.broadcastTargetEvent(bridgeSessionId, "Target.targetDestroyed", { targetId });
          }
          continue;
        }
        if (
          previous &&
          current &&
          phase !== "stopped" &&
          (previous.url !== current.url ||
            previous.title !== current.title ||
            previous.openerTabId !== current.openerTabId)
        ) {
          this.broadcastTargetEvent(bridgeSessionId, "Target.targetInfoChanged", {
            targetInfo: targetInfoFor(profileId, current, this.hasAttachedSession(profileId, ref.tabId)),
          });
        }
      }
    }
    if (changed) this.persistSessions();
  }

  private broadcastTargetEvent(
    bridgeSessionId: string,
    method: string,
    params: Record<string, unknown>,
  ): void {
    const event = JSON.stringify({ method, params });
    for (const [client, clientBridgeSessionId] of this.cdpClients) {
      if (
        clientBridgeSessionId === bridgeSessionId &&
        this.targetDiscoveryClients.has(client) &&
        client.readyState === WebSocket.OPEN
      ) {
        client.send(event);
      }
    }
  }

  private enqueueControlEvent(event: Omit<QueuedControlEvent, "sequence" | "createdAt">): void {
    this.controlEvents.push({
      ...event,
      sequence: ++this.controlEventSequence,
      createdAt: new Date().toISOString(),
    });
    if (this.controlEvents.length > 256)
      this.controlEvents.splice(0, this.controlEvents.length - 256);
  }

  private bridgeSessionsHasOwner(ownerSessionId: string): boolean {
    return [...this.bridgeSessions.values()].some(
      (session) => session.ownerSessionId === ownerSessionId,
    );
  }

  private reconnectTargets(ownerSessionId: string): BridgeReconnectTarget[] {
    return [...this.profiles.values()].flatMap((peer) =>
      [...peer.tabs.values()]
        .filter(shouldExposeTab)
        .map((tab) => {
          const targetId = targetIdFor(peer.profileId, tab.tabId);
          const attached = [...this.attachedSessions.values()].find(
            (entry) => entry.profileId === peer.profileId && entry.tabId === tab.tabId,
          );
          const owner = attached
            ? this.bridgeSessions.get(attached.bridgeSessionId)?.ownerSessionId
            : undefined;
          const identity = redactedTabIdentity(tab.url);
          return {
            targetId,
            profileId: peer.profileId,
            active: tab.active === true,
            available: !attached || owner === ownerSessionId,
            controlled: Boolean(attached),
            controlledByOwner: owner === ownerSessionId,
            ...identity,
          } satisfies BridgeReconnectTarget;
        }),
    );
  }

  private async reconnectOwnerSession(
    ownerSessionId: string,
    requestedTargetId?: string,
  ): Promise<{
    matched: number;
    attached: boolean;
    targetId?: string;
    sessionId?: string;
    profileId?: string;
  }> {
    const sessions = [...this.bridgeSessions.values()].filter(
      (session) => session.ownerSessionId === ownerSessionId,
    );
    if (sessions.length === 0) return { matched: 0, attached: false };
    const session =
      sessions.find((candidate) => this.controlStates.get(candidate.sessionId)?.phase === "detached") ??
      sessions.at(-1)!;
    const control = this.controlStates.get(session.sessionId);
    if (control?.phase === "stopped") throw new Error("Browser control is stopped");
    const existing = [...this.attachedSessions.values()].find(
      (attached) => attached.bridgeSessionId === session.sessionId,
    );
    if (existing) {
      const existingTargetId = targetIdFor(existing.profileId, existing.tabId);
      if (requestedTargetId && requestedTargetId !== existingTargetId) {
        throw new Error(
          "The browser session is already attached to a different reconnect target",
        );
      }
      await this.setBridgeControl(session, "resuming");
      this.advanceOwnerControl(ownerSessionId, "resuming");
      this.persistSessions();
      return {
        matched: sessions.length,
        attached: true,
        targetId: existingTargetId,
        sessionId: existing.sessionId,
        profileId: existing.profileId,
      };
    }
    const target = this.resolveReconnectTarget(requestedTargetId);
    if (this.hasAttachedSession(target.peer.profileId, target.tab.tabId)) {
      throw new Error("The requested Chrome tab is already controlled by another session");
    }
    const previousControl = control ? { ...control } : undefined;
    const previousProfileId = session.profileId;
    const previous = this.detachedAttachments.get(session.sessionId);
    const attachedSessionId =
      previous?.sessionId ?? sessionIdFor(target.tab.tabId, this.attachSequence++);
    try {
      await this.setBridgeControl(session, "resuming");
      this.advanceOwnerControl(ownerSessionId, "resuming");
      this.attachedSessions.set(attachedSessionId, {
        sessionId: attachedSessionId,
        bridgeSessionId: session.sessionId,
        profileId: target.peer.profileId,
        tabId: target.tab.tabId,
      });
      this.sessionTargetScopes.get(session.sessionId)?.attachedTargetIds.add(target.targetId);
      await this.showControlOverlay(
        session,
        this.attachedSessions.get(attachedSessionId) as AttachedSession,
      );
      this.detachedAttachments.delete(session.sessionId);
      session.profileId = target.peer.profileId;
      this.persistSessions();
    } catch (error) {
      this.attachedSessions.delete(attachedSessionId);
      this.sessionTargetScopes.get(session.sessionId)?.attachedTargetIds.delete(target.targetId);
      session.profileId = previousProfileId;
      const current = this.controlStates.get(session.sessionId);
      this.controlStates.set(session.sessionId, {
        phase: previousControl?.phase ?? "detached",
        epoch: Math.max(current?.epoch ?? 0, previousControl?.epoch ?? 0) + 1,
        updatedAt: new Date().toISOString(),
      });
      if (previousControl) this.ownerControls.set(ownerSessionId, { ...previousControl });
      try {
        this.persistSessions();
      } catch {
        // Preserve the reconnect error. The in-memory ownership fence is
        // already restored and a later lifecycle write can repair the file.
      }
      throw error;
    }
    return {
      matched: sessions.length,
      attached: true,
      targetId: target.targetId,
      sessionId: attachedSessionId,
      profileId: target.peer.profileId,
    };
  }

  private resolveReconnectTarget(
    requestedTargetId?: string,
  ): { targetId: string; peer: ProfilePeer; tab: BridgeTab } {
    if (requestedTargetId) {
      const ref = parseTargetId(requestedTargetId);
      if (!ref) throw new Error("Reconnect targetId is invalid");
      const peer = this.profiles.get(ref.profileId);
      const tab = peer?.tabs.get(ref.tabId);
      if (!peer || !tab || !shouldExposeTab(tab)) {
        throw new Error("Reconnect target is not available");
      }
      return { targetId: requestedTargetId, peer, tab };
    }
    throw new Error(
      "Reconnect requires an explicit targetId unless the task tab is already attached",
    );
  }

  private async setOwnerControl(
    ownerSessionId: string,
    phase: ControlPhase,
  ): Promise<{ matched: number; focusConfirmed: boolean }> {
    this.advanceOwnerControl(ownerSessionId, phase);
    const sessions = [...this.bridgeSessions.values()].filter(
      (session) => session.ownerSessionId === ownerSessionId,
    );
    let focusConfirmed = true;
    let focusAttempted = false;
    for (const session of sessions) {
      const hasAttachedTarget = this.hasFocusableTarget(session);
      const focused = await this.setBridgeControl(session, phase);
      this.logger.debug("owner control update", {
        ownerSessionId,
        sessionId: session.sessionId,
        phase,
        hasFocusableTarget: hasAttachedTarget,
        focused,
      });
      if (phase === "human" && hasAttachedTarget) {
        focusAttempted = true;
        focusConfirmed = focusConfirmed && focused;
      }
    }
    this.persistSessions();
    return {
      matched: sessions.length,
      focusConfirmed: phase === "human" ? focusAttempted && focusConfirmed : focusConfirmed,
    };
  }

  private advanceOwnerControl(ownerSessionId: string, phase: ControlPhase): ControlState {
    const current = this.ownerControls.get(ownerSessionId);
    if (current?.phase === phase && phase !== "human") return current;
    const next = {
      phase,
      epoch: (current?.epoch ?? 0) + 1,
      updatedAt: new Date().toISOString(),
    } satisfies ControlState;
    this.ownerControls.set(ownerSessionId, next);
    return next;
  }

  private async setBridgeControl(
    session: BridgeSession,
    phase: ControlPhase,
    options: {
      preferredAttached?: AttachedSession;
      tolerateFocusFailure?: boolean;
    } = {},
  ): Promise<boolean> {
    const current = this.controlStates.get(session.sessionId);
    // Repeating human control is an explicit focus request from the UI. It
    // must re-activate the exact tab/window instead of becoming a no-op.
    if (current?.phase === phase && phase !== "human") return true;
    this.controlStates.set(session.sessionId, {
      phase,
      epoch: (current?.epoch ?? 0) + 1,
      updatedAt: new Date().toISOString(),
    });
    if (phase === "agent" && current?.phase !== "agent") {
      this.replayUnattachedOwnedTargets(session);
    }
    if (phase !== "agent") this.cancelPendingForSession(session.sessionId, phase);
    const attached = [...this.attachedSessions.values()].filter(
      (entry) => entry.bridgeSessionId === session.sessionId,
    );
    if (phase === "detached") {
      for (const entry of attached) this.attachedSessions.delete(entry.sessionId);
      this.persistSessions();
      return true;
    }
    let focusConfirmed = phase !== "human";
    if (phase === "human") {
      const focused =
        attached.find((entry) => entry.sessionId === options.preferredAttached?.sessionId) ??
        attached.find(
          (entry) => this.profiles.get(entry.profileId)?.tabs.get(entry.tabId)?.active,
        ) ?? attached.at(-1);
      let peer = focused ? this.profiles.get(focused.profileId) : undefined;
      let tabId = focused?.tabId;
      // A CLI command may have released its short-lived CDP attachment while
      // the owner session still owns the task tab. The user-facing takeover
      // contract must still focus that scoped tab instead of reporting a
      // false negative merely because no CDP client is currently attached.
      if (!focused) {
        peer = this.trySelectProfile(session);
        const scopedTabs =
          peer && this.sessionTargetScopes.has(session.sessionId)
            ? this.tabsForSession(session, peer).filter(shouldExposeTab)
            : [];
        const fallback = scopedTabs.find((tab) => tab.active) ?? scopedTabs.at(-1);
        tabId = fallback?.tabId;
      }
      if (peer?.ws.readyState === WebSocket.OPEN && typeof tabId === "number") {
        // Human takeover is not acknowledged to the host until Chrome has
        // confirmed that the exact controlled tab and its window were focused.
        try {
          await this.sendBridgeCommand(peer, {
            method: "Bridge.activateTab",
            tabId,
            params: { tabId },
          });
          const activeTab = peer.tabs.get(tabId);
          if (activeTab) this.markTabActive(peer, activeTab);
          focusConfirmed = true;
        } catch (error) {
          if (!options.tolerateFocusFailure) throw error;
          focusConfirmed = false;
        }
      }
    }
    for (const entry of attached) {
      const peer = this.profiles.get(entry.profileId);
      if (!peer || peer.ws.readyState !== WebSocket.OPEN) {
        if (phase === "stopped") this.attachedSessions.delete(entry.sessionId);
        continue;
      }
      this.sendBridgeNotification(peer, {
        method: "Bridge.setControlOverlay",
        sessionId: entry.sessionId,
        tabId: entry.tabId,
        params: {
          phase,
          ...(phase === "human" && session.profileUrlHint && session.returnOrigin
            ? { returnPath: session.profileUrlHint, returnOrigin: session.returnOrigin }
            : {}),
        },
      });
      if (phase === "stopped") {
        this.sendBridgeNotification(peer, {
          method: "Bridge.detachTab",
          sessionId: entry.sessionId,
          tabId: entry.tabId,
        });
        this.attachedSessions.delete(entry.sessionId);
      }
    }
    this.persistSessions();
    return focusConfirmed;
  }

  private replayUnattachedOwnedTargets(session: BridgeSession): void {
    const scope = this.sessionTargetScopes.get(session.sessionId);
    if (!scope) return;
    for (const targetId of scope.targetIds) {
      const ref = parseTargetId(targetId);
      const peer = ref ? this.profiles.get(ref.profileId) : undefined;
      const tab = ref ? peer?.tabs.get(ref.tabId) : undefined;
      if (!ref || !tab || !shouldExposeTab(tab) || this.hasAttachedSession(ref.profileId, ref.tabId)) {
        continue;
      }
      this.broadcastTargetEvent(session.sessionId, "Target.targetCreated", {
        targetInfo: targetInfoFor(ref.profileId, tab, false),
      });
    }
  }

  private hasFocusableTarget(session: BridgeSession): boolean {
    if ([...this.attachedSessions.values()].some((entry) => entry.bridgeSessionId === session.sessionId)) {
      return true;
    }
    if (!this.sessionTargetScopes.has(session.sessionId)) return false;
    const peer = this.trySelectProfile(session);
    return Boolean(peer && this.tabsForSession(session, peer).some(shouldExposeTab));
  }

  private cancelPendingForSession(bridgeSessionId: string, phase: ControlPhase): void {
    for (const [reqId, pending] of this.pending) {
      if (pending.bridgeSessionId !== bridgeSessionId) continue;
      clearTimeout(pending.timeout);
      this.pending.delete(reqId);
      this.sendCdpError(
        pending.cdpClient,
        pending.cdpId,
        cdpError(
            phase === "human"
              ? "Browser control was taken over by the user"
              : phase === "resuming"
                ? "Browser control is resuming with semantic readback only"
              : phase === "detached"
                ? "Browser control was detached from Chrome"
                : "Browser control was stopped",
        ),
      );
    }
  }

  private selectProfile(session: BridgeSession): ProfilePeer {
    const peer = this.trySelectProfile(session);
    if (peer) return peer;
    if (session.profileId) {
      throw new Error(`Chrome extension profile '${session.profileId}' is not connected`);
    }
    if (this.profiles.size === 0) {
      throw new Error(
        "No Chrome extension profile is connected. Load the Agent Browser Bridge extension, then retry.",
      );
    }
    throw new Error(
      "Multiple Chrome extension profiles are connected. Set AGENT_BROWSER_CHROME_BRIDGE_PROFILE or run plugin status to choose one.",
    );
  }

  private trySelectProfile(session: BridgeSession): ProfilePeer | undefined {
    if (session.profileId) return this.profiles.get(session.profileId);
    if (this.profiles.size === 1) return [...this.profiles.values()][0];
    if (session.profileUrlHint) {
      const matching = [...this.profiles.values()].filter((peer) =>
        [...peer.tabs.values()].some((tab) =>
          tabMatchesProfileUrlHint(tab, session.profileUrlHint!),
        ),
      );
      const activeMatching = matching.filter((peer) =>
        [...peer.tabs.values()].some(
          (tab) => tab.active && tabMatchesProfileUrlHint(tab, session.profileUrlHint!),
        ),
      );
      const selected =
        matching.length === 1
          ? matching[0]
          : activeMatching.length === 1
            ? activeMatching[0]
            : undefined;
      if (selected) {
        session.profileId = selected.profileId;
        return selected;
      }
    }
    return undefined;
  }

  private peerAndTabFromTargetId(targetId: string | undefined): {
    peer: ProfilePeer;
    tab: BridgeTab;
  } {
    if (!targetId) throw new Error("targetId is required");
    const ref = parseTargetId(targetId);
    if (!ref) throw new Error(`Unknown targetId: ${targetId}`);
    const peer = this.profiles.get(ref.profileId);
    const tab = peer?.tabs.get(ref.tabId);
    if (!peer || !tab) throw new Error(`Target is not available: ${targetId}`);
    return { peer, tab };
  }

  private tabsForSession(session: BridgeSession, peer: ProfilePeer): BridgeTab[] {
    const scope = this.sessionTargetScopes.get(session.sessionId);
    if (!scope) return [...peer.tabs.values()];
    return [...new Set([...scope.targetIds, ...scope.attachedTargetIds])]
      .map((targetId) => parseTargetId(targetId))
      .filter((ref) => ref?.profileId === peer.profileId)
      .map((ref) => peer.tabs.get(ref!.tabId))
      .filter((tab): tab is BridgeTab => Boolean(tab));
  }

  private assertTargetAllowed(session: BridgeSession, targetId: string | undefined): void {
    const scope = this.sessionTargetScopes.get(session.sessionId);
    if (
      !scope ||
      (targetId && (scope.targetIds.has(targetId) || scope.attachedTargetIds.has(targetId)))
    )
      return;
    throw new Error("Target is outside this Chrome bridge session");
  }

  private async closeOwnedTargets(session: BridgeSession): Promise<void> {
    const scope = this.sessionTargetScopes.get(session.sessionId);
    if (!scope) return;
    await this.closeTargetScope(scope, session.sessionId);
  }

  private async releaseOwnedTargets(session: BridgeSession): Promise<void> {
    const scope = this.sessionTargetScopes.get(session.sessionId);
    if (!scope) return;
    this.sessionTargetScopes.delete(session.sessionId);
    if (
      session.ownerSessionId &&
      session.profileUrlHint &&
      scope.targetIds.size > 0 &&
      (this.options.detachedTargetGraceMs ?? 0) > 0
    ) {
      const ownerSessionId = session.ownerSessionId;
      const previous = this.detachedTargetScopes.get(ownerSessionId);
      if (previous) {
        clearTimeout(previous.cleanupTimer);
        void this.closeTargetScope(previous.scope, `${ownerSessionId}:superseded`);
      }
      const cleanupTimer = setTimeout(() => {
        const detached = this.detachedTargetScopes.get(ownerSessionId);
        if (!detached || detached.scope !== scope) return;
        this.detachedTargetScopes.delete(ownerSessionId);
        void this.closeTargetScope(scope, `${ownerSessionId}:grace-expired`);
      }, this.options.detachedTargetGraceMs);
      cleanupTimer.unref?.();
      this.detachedTargetScopes.set(ownerSessionId, {
        profileUrlHint: session.profileUrlHint,
        scope,
        cleanupTimer,
      });
      return;
    }
    await this.closeTargetScope(scope, session.sessionId);
  }

  private async closeTargetScope(scope: SessionTargetScope, owner: string): Promise<void> {
    for (const targetId of [...scope.targetIds]) {
      const ref = parseTargetId(targetId);
      const peer = ref ? this.profiles.get(ref.profileId) : undefined;
      const tab = ref ? peer?.tabs.get(ref.tabId) : undefined;
      if (ref && peer && tab) {
        await this.sendBridgeCommand(peer, {
          method: "Bridge.closeTab",
          params: { tabId: ref.tabId },
        }).catch((error) => {
          this.logger.error("failed to close session-owned Chrome tab", {
            owner,
            error: error instanceof Error ? error.message : String(error),
          });
        });
        peer.tabs.delete(ref.tabId);
        this.deleteAttachedSessionsForTab(ref.profileId, ref.tabId);
      }
      scope.targetIds.delete(targetId);
    }
  }

  private deleteAttachedSessionsForTab(profileId: string, tabId: number): void {
    for (const [sessionId, attached] of this.attachedSessions) {
      if (attached.profileId === profileId && attached.tabId === tabId) {
        this.sessionTargetScopes.get(attached.bridgeSessionId)?.attachedTargetIds.delete(
          targetIdFor(profileId, tabId),
        );
        this.detachedAttachments.delete(attached.bridgeSessionId);
        this.attachedSessions.delete(sessionId);
      }
    }
  }

  private hasAttachedSession(profileId: string, tabId: number): boolean {
    for (const session of this.attachedSessions.values()) {
      if (session.profileId === profileId && session.tabId === tabId) return true;
    }
    return false;
  }

  private assertTabAvailableToSession(
    bridgeSession: BridgeSession,
    profileId: string,
    tabId: number,
  ): void {
    for (const attached of this.attachedSessions.values()) {
      if (
        attached.profileId === profileId &&
        attached.tabId === tabId &&
        attached.bridgeSessionId !== bridgeSession.sessionId
      ) {
        throw new Error("The requested Chrome tab is already controlled by another session");
      }
    }
  }

  private markTabActive(peer: ProfilePeer, activeTab: BridgeTab): void {
    for (const tab of peer.tabs.values()) {
      if (tab.windowId === activeTab.windowId) tab.active = tab.tabId === activeTab.tabId;
    }
    activeTab.active = true;
  }

  private async sendBridgeCommand<T = unknown>(
    peer: ProfilePeer,
    command: Omit<BridgeCommand, "v" | "kind" | "reqId" | "profileId">,
    cdpClient?: WebSocket,
    cdpId?: number,
    bridgeSessionId?: string,
  ): Promise<T> {
    const reqId = `r_${this.commandSequence++}`;
    const payload: BridgeCommand = {
      v: BRIDGE_PROTOCOL_VERSION,
      kind: "cdp-command",
      reqId,
      profileId: peer.profileId,
      ...command,
    };
    this.logger.debug("Chrome extension command dispatched", {
      reqId,
      method: payload.method,
      profileId: peer.profileId,
    });
    if (cdpClient && typeof cdpId === "number") {
      const timeout = setTimeout(() => {
        this.pending.delete(reqId);
        this.sendCdpError(
          cdpClient,
          cdpId,
          cdpError(`Timed out waiting for extension response to ${payload.method}`),
        );
      }, this.options.commandTimeoutMs);
      this.pending.set(reqId, {
        cdpClient,
        cdpId,
        timeout,
        method: payload.method,
        bridgeSessionId,
      });
      peer.ws.send(JSON.stringify(payload));
      return undefined as T;
    }
    return await new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error(`Timed out waiting for extension response to ${payload.method}`));
      }, this.options.commandTimeoutMs);
      this.pending.set(reqId, {
        cdpClient: resultSocket(resolve, reject),
        cdpId: 0,
        timeout,
        method: payload.method,
      });
      peer.ws.send(JSON.stringify(payload));
    });
  }

  private sendBridgeNotification(
    peer: ProfilePeer,
    command: Omit<BridgeCommand, "v" | "kind" | "reqId" | "profileId">,
  ): void {
    if (peer.ws.readyState !== WebSocket.OPEN) return;
    peer.ws.send(
      JSON.stringify({
        v: BRIDGE_PROTOCOL_VERSION,
        kind: "cdp-command",
        reqId: `n_${this.commandSequence++}`,
        profileId: peer.profileId,
        ...command,
      } satisfies BridgeCommand),
    );
  }

  private resolvePending(message: BridgeResult) {
    const pending = this.pending.get(message.reqId);
    if (!pending) return;
    this.logger.debug("Chrome extension command completed", {
      reqId: message.reqId,
      method: pending.method,
      ok: !message.error,
    });
    clearTimeout(pending.timeout);
    this.pending.delete(message.reqId);
    if (message.error) {
      this.logger.error("Chrome extension command failed", {
        method: pending.method,
        error: message.error.message,
      });
    }
    if (pending.cdpId === 0 && isResultSocket(pending.cdpClient)) {
      if (message.error) {
        pending.cdpClient.reject(new Error(message.error.message));
      } else {
        pending.cdpClient.resolve(message.result);
      }
      return;
    }
    if (message.error) {
      this.sendCdpError(pending.cdpClient, pending.cdpId, message.error);
    } else {
      this.sendCdpResult(pending.cdpClient, pending.cdpId, message.result ?? {});
    }
  }

  private forwardCdpEvent(
    profileId: string,
    tabId: number | undefined,
    sessionId: string | undefined,
    method: string,
    params: Record<string, unknown>,
  ) {
    const attached = sessionId
      ? [this.attachedSessions.get(sessionId)].filter((entry): entry is AttachedSession =>
          Boolean(
            entry &&
            entry.profileId === profileId &&
            (tabId === undefined || entry.tabId === tabId),
          ),
        )
      : tabId === undefined
        ? []
        : [...this.attachedSessions.values()].filter(
            (entry) => entry.profileId === profileId && entry.tabId === tabId,
          );

    for (const entry of attached) {
      const event = JSON.stringify({
        method,
        params,
        sessionId: entry.sessionId,
      });
      for (const [client, bridgeSessionId] of this.cdpClients) {
        if (bridgeSessionId === entry.bridgeSessionId && client.readyState === WebSocket.OPEN) {
          client.send(event);
        }
      }
    }
  }

  private sendCdpResult(ws: WebSocket, id: number, result: unknown) {
    ws.send(JSON.stringify({ id, result }));
  }

  private sendCdpError(ws: WebSocket, id: number, error: { code: number; message: string }) {
    ws.send(JSON.stringify({ id, error }));
  }

  private healthCorsHeaders(req: IncomingMessage): Record<string, string> | undefined {
    const allowedExtensionId = this.options.allowedExtensionId;
    if (!allowedExtensionId) return undefined;
    const allowedOrigin = `chrome-extension://${allowedExtensionId}`;
    if (req.headers.origin !== allowedOrigin) return undefined;
    return {
      "access-control-allow-origin": allowedOrigin,
      vary: "Origin",
    };
  }

  private writeJson(
    res: ServerResponse,
    statusCode: number,
    data: unknown,
    headers: Record<string, string> = {},
  ) {
    const body = JSON.stringify(data);
    res.writeHead(statusCode, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
      ...headers,
    });
    res.end(body);
  }
}

function tabsToMap(tabs: BridgeTab[]): Map<number, BridgeTab> {
  return new Map(tabs.map((tab) => [tab.tabId, tab]));
}

function validProfileUrlHint(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const hint = value.trim();
  if (!hint.startsWith("/") || hint.length > 512 || /[\u0000-\u001f\u007f]/.test(hint)) {
    return undefined;
  }
  return hint.length > 1 ? hint.replace(/\/+$/, "") : hint;
}

function decodePathSegment(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function validOwnerSessionId(value: string): string | undefined {
  const decoded = decodePathSegment(value);
  return decoded && OWNER_SESSION_ID_PATTERN.test(decoded) ? decoded : undefined;
}

function validReturnOrigin(value: unknown): string | undefined {
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

function tabMatchesProfileUrlHint(tab: BridgeTab, hint: string): boolean {
  try {
    const pathname = new URL(tab.url).pathname.replace(/\/+$/, "") || "/";
    return pathname.endsWith(hint);
  } catch {
    return false;
  }
}

function redactedTabIdentity(url: string): Pick<BridgeReconnectTarget, "host" | "path"> {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname || "/";
    return {
      host: parsed.host || null,
      path: pathname.length > 160 ? `${pathname.slice(0, 157)}...` : pathname,
    };
  } catch {
    return { host: null, path: null };
  }
}

function parseBridgeMessage(raw: WebSocket.RawData): BridgeMessage | null {
  try {
    return JSON.parse(raw.toString()) as BridgeMessage;
  } catch {
    return null;
  }
}

function parseCdpRequest(raw: WebSocket.RawData): CdpRequest | null {
  try {
    return JSON.parse(raw.toString()) as CdpRequest;
  } catch {
    return null;
  }
}

function stringParam(params: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = params?.[key];
  return typeof value === "string" ? value : undefined;
}

function isObserverCdpMethod(method: string): boolean {
  return (
    method === "Page.startScreencast" ||
    method === "Page.stopScreencast" ||
    method === "Page.screencastFrameAck" ||
    method === "Page.captureScreenshot"
  );
}

/**
 * Provider-side fence for the handoff measurement window. The native
 * `snapshot --readback-only` path intentionally uses only this small set.
 * In particular, general Runtime.evaluate remains blocked; the lone `1`
 * expression is the browser manager's bounded renderer-liveness probe.
 */
function isSemanticReadbackCdpRequest(
  method: string,
  params?: Record<string, unknown>,
): boolean {
  if (isObserverCdpMethod(method)) return true;
  if (
    method === "Page.enable" ||
    method === "Runtime.enable" ||
    method === "Runtime.runIfWaitingForDebugger" ||
    method === "Network.enable" ||
    method === "DOM.enable" ||
    method === "Accessibility.enable" ||
    method === "Accessibility.getFullAXTree" ||
    method === "DOM.describeNode"
  ) {
    return true;
  }
  return method === "Runtime.evaluate" && params?.expression === "1";
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

type ResultSocket<T = unknown> = WebSocket & {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
};

function resultSocket<T>(
  resolve: (value: T) => void,
  reject: (error: Error) => void,
): ResultSocket<T> {
  return { resolve, reject } as ResultSocket<T>;
}

function isResultSocket(ws: WebSocket): ws is ResultSocket {
  return "resolve" in ws && "reject" in ws;
}
