import { constants } from "node:fs";
import { open } from "node:fs/promises";

export type Logger = {
  debug(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
};

export function createLogger(logPath?: string): Logger {
  let pending: Promise<void> = Promise.resolve();

  async function write(level: string, message: string, data?: unknown) {
    if (!logPath) return;
    const line = JSON.stringify({
      time: new Date().toISOString(),
      level,
      message,
      data,
    });
    const handle = await open(
      logPath,
      constants.O_APPEND |
        constants.O_CREAT |
        constants.O_WRONLY |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      await handle.chmod(0o600);
      await handle.appendFile(`${line}\n`, "utf8");
    } finally {
      await handle.close();
    }
  }

  function enqueue(level: string, message: string, data?: unknown): void {
    pending = pending.then(
      () => write(level, message, data),
      () => write(level, message, data),
    );
    // Logging is diagnostic-only. Preserve ordering and permissions, but do
    // not let an unavailable log path crash the hosted daemon.
    void pending.catch(() => undefined);
  }

  return {
    debug(message, data) {
      enqueue("debug", message, data);
    },
    error(message, data) {
      enqueue("error", message, data);
    },
  };
}
