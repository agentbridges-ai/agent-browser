#!/usr/bin/env node
import { readBridgeConfig } from "../config.js";
import { BridgeDaemon } from "./server.js";

const config = readBridgeConfig();
if (!config.controlToken) {
  throw new Error(
    "NEXOLYRA_AGENT_BROWSER_CONTROL_TOKEN is required to start the Chrome bridge daemon",
  );
}
const daemon = new BridgeDaemon({
  port: config.port,
  allowedExtensionId: config.extensionId,
  controlToken: config.controlToken,
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
