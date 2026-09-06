type LogLevel = "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

function emit(level: LogLevel, fields: LogFields): void {
  const line = JSON.stringify({ timestamp: new Date().toISOString(), level, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger = {
  info: (fields: LogFields) => emit("info", fields),
  warn: (fields: LogFields) => emit("warn", fields),
  error: (fields: LogFields) => emit("error", fields),
};

export type Logger = typeof logger;

export type SerializedError = {
  name?: string;
  message: string;
  code?: string;
  stack?: string;
};

export function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return {
      name: error.name,
      message: error.message,
      ...(typeof code === "string" ? { code } : {}),
      stack: error.stack,
    };
  }
  return { message: String(error) };
}
