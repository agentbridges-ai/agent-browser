#!/usr/bin/env node
import {
  readControlSecretsFd,
  readBridgeConfig,
} from "../config.js";
import { BridgeDaemon } from "./server.js";

const config = readBridgeConfig();
let controlToken = config.controlToken;
let sessionGrantSecret = config.sessionGrantSecret;
let extensionBuildIdentity: string | undefined;
if (config.controlSecretsFd !== undefined) {
  ({ controlToken, sessionGrantSecret, extensionBuildIdentity } = readControlSecretsFd(
    config.controlSecretsFd,
  ));
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
  allowedExtensionBuildIdentity: extensionBuildIdentity,
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
