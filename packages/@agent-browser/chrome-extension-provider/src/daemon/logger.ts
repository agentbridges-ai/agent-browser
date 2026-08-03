import { appendFile } from "node:fs/promises";

export type Logger = {
  debug(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
};

export function createLogger(logPath?: string): Logger {
  async function write(level: string, message: string, data?: unknown) {
    if (!logPath) return;
    const line = JSON.stringify({
      time: new Date().toISOString(),
      level,
      message,
      data,
    });
    await appendFile(logPath, `${line}\n`, "utf8").catch(() => {});
  }

  return {
    debug(message, data) {
      void write("debug", message, data);
    },
    error(message, data) {
      void write("error", message, data);
    },
  };
}
