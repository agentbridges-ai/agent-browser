import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLogger } from "../dist/daemon/logger.js";

async function waitForLine(path) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const content = await readFile(path, "utf8").catch(() => "");
    if (content.includes("private log entry")) return content;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("logger did not flush the expected line");
}

test("daemon logger hardens an existing log file to owner-only permissions", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-browser-logger-"));
  const logPath = join(root, "bridge.log");
  try {
    await writeFile(logPath, "", { mode: 0o666 });
    await chmod(logPath, 0o666);
    const logger = createLogger(logPath);

    logger.debug("private log entry", { token: "test-only" });

    const content = await waitForLine(logPath);
    assert.match(content, /private log entry/);
    assert.equal((await stat(logPath)).mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("daemon logger does not follow a symlinked log path", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-browser-logger-symlink-"));
  const targetPath = join(root, "target.log");
  const logPath = join(root, "bridge.log");
  try {
    await writeFile(targetPath, "do not touch\n", { mode: 0o644 });
    await chmod(targetPath, 0o644);
    await symlink(targetPath, logPath);
    const logger = createLogger(logPath);

    logger.error("must be dropped");
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(await readFile(targetPath, "utf8"), "do not touch\n");
    assert.equal((await stat(targetPath)).mode & 0o777, 0o644);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
