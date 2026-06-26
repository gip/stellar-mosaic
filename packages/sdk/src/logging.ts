export type MosaicLogLevel = "debug" | "info" | "warn" | "error";
export type MosaicLogContext = Record<string, unknown>;

export interface MosaicLogger {
  debug(message: string, context?: MosaicLogContext): void;
  info(message: string, context?: MosaicLogContext): void;
  warn(message: string, context?: MosaicLogContext): void;
  error(message: string, context?: MosaicLogContext): void;
}

const ORDER: Record<MosaicLogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function field(value: unknown, name: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  return (value as Record<string, unknown>)[name];
}

function safeStringify(value: unknown): string | null {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (_key, current) => {
      if (typeof current === "bigint") return current.toString();
      if (current instanceof Error) return serializeError(current);
      if (current instanceof Uint8Array) return { type: "Uint8Array", length: current.byteLength };
      if (current && typeof current === "object") {
        if (seen.has(current)) return "[Circular]";
        seen.add(current);
      }
      return current;
    });
  } catch {
    return null;
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  const candidates = [
    field(error, "message"),
    field(error, "shortMessage"),
    field(error, "details"),
    field(error, "error"),
    field(field(error, "data"), "message"),
    field(field(error, "data"), "originalError"),
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate;
    if (candidate && typeof candidate === "object") {
      const nested = errorMessage(candidate);
      if (nested && nested !== "[object Object]") return nested;
    }
  }
  return safeStringify(error) ?? String(error);
}

export function serializeError(error: unknown): unknown {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      cause: error.cause ? serializeError(error.cause) : undefined,
    };
  }
  if (!error || typeof error !== "object") return error;
  const json = safeStringify(error);
  if (!json) return errorMessage(error);
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return errorMessage(error);
  }
}

function contextWithSerializedErrors(context?: MosaicLogContext): MosaicLogContext | undefined {
  if (!context) return undefined;
  return Object.fromEntries(
    Object.entries(context).map(([key, value]) => [
      key,
      key === "error" || key === "cause" ? serializeError(value) : value,
    ]),
  );
}

export function createConsoleLogger(opts: { minLevel?: MosaicLogLevel } = {}): MosaicLogger {
  const min = ORDER[opts.minLevel ?? "info"];
  const write = (level: MosaicLogLevel, message: string, context?: MosaicLogContext) => {
    if (ORDER[level] < min) return;
    const method = level === "debug" ? console.debug : level === "info" ? console.info : level === "warn" ? console.warn : console.error;
    const formatted = `[mosaic:${level}] ${message}`;
    const normalized = contextWithSerializedErrors(context);
    if (normalized) method(formatted, normalized);
    else method(formatted);
  };
  return {
    debug: (message, context) => write("debug", message, context),
    info: (message, context) => write("info", message, context),
    warn: (message, context) => write("warn", message, context),
    error: (message, context) => write("error", message, context),
  };
}

let activeLogger: MosaicLogger = createConsoleLogger();

export function setMosaicLogger(logger: MosaicLogger): void {
  activeLogger = logger;
}

export function getMosaicLogger(): MosaicLogger {
  return activeLogger;
}
