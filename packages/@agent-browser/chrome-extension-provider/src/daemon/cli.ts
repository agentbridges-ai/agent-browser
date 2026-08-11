#!/usr/bin/env node
import { readFileSync } from "node:fs";
import {
  parseControlToken,
  parseSessionGrantSecret,
  readBridgeConfig,
} from "../config.js";
import { BridgeDaemon } from "./server.js";

const config = readBridgeConfig();
let controlToken = config.controlToken;
let sessionGrantSecret = config.sessionGrantSecret;
if (config.controlSecretsFd !== undefined) {
  const secrets = JSON.parse(readFileSync(config.controlSecretsFd, "utf8")) as Record<
    string,
    unknown
  >;
  controlToken = parseControlToken(
    typeof secrets.controlToken === "string" ? secrets.controlToken : undefined,
  );
  sessionGrantSecret = parseSessionGrantSecret(
    typeof secrets.sessionGrantSecret === "string" ? secrets.sessionGrantSecret : undefined,
  );
}
if (config.supervisedByNexolyra && config.controlSecretsFd === undefined) {
  throw new Error("A supervised Chrome bridge daemon requires a private inherited control fd");
}
if (!controlToken || !sessionGrantSecret) {
  throw new Error(
    "Chrome bridge control and session-grant secrets are required to start the daemon",
  );
}
const daemon = new BridgeDaemon({
  port: config.port,
  allowedExtensionId: config.extensionId,
  controlToken,
  sessionGrantSecret,
  logPath: config.logPath,
  statePath: config.statePath,
  legacyStatePaths: config.legacyStatePaths,
  supervisedByNexolyra: config.supervisedByNexolyra,
});

const shutdown = async () => {
  await daemon.shutdown();
  process.exit(0);
};

process.on("SIGINT", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});

daemon.start().catch((error) => {
  if (config.logPath) {
    process.stderr.write(`agent-browser chrome bridge daemon failed: ${String(error)}\n`);
  }
  process.exit(1);
});
