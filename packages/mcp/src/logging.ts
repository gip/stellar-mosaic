import { setMosaicLogger, type MosaicLogLevel, type MosaicLogger } from "@mosaic/sdk";

type McpLogLevel = MosaicLogLevel | "silent";

const ORDER: Record<MosaicLogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const noopLogger: MosaicLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function parseLogLevel(raw: string | undefined): McpLogLevel {
  switch (raw?.trim().toLowerCase()) {
    case "debug":
    case "info":
    case "warn":
    case "error":
      return raw.trim().toLowerCase() as MosaicLogLevel;
    case "0":
    case "false":
    case "off":
    case "quiet":
    case "silent":
      return "silent";
    default:
      return "warn";
  }
}

function normalize(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
      cause: value.cause ? normalize(value.cause) : undefined,
    };
  }
  if (value instanceof Uint8Array) return { type: "Uint8Array", length: value.byteLength };
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(normalize);
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, normalize(item)]));
}

export function createStderrLogger(opts: { minLevel?: McpLogLevel } = {}): MosaicLogger {
  const minLevel = opts.minLevel ?? "warn";
  if (minLevel === "silent") return noopLogger;
  const min = ORDER[minLevel];
  const write = (level: MosaicLogLevel, message: string, context?: Record<string, unknown>) => {
    if (ORDER[level] < min) return;
    const entry = {
      ts: new Date().toISOString(),
      level,
      message,
      ...(context ? { context: normalize(context) } : {}),
    };
    process.stderr.write(`${JSON.stringify(entry)}\n`);
  };
  return {
    debug: (message, context) => write("debug", message, context),
    info: (message, context) => write("info", message, context),
    warn: (message, context) => write("warn", message, context),
    error: (message, context) => write("error", message, context),
  };
}

export function configureMcpLogging(env: NodeJS.ProcessEnv = process.env): MosaicLogger {
  const logger = createStderrLogger({ minLevel: parseLogLevel(env.MOSAIC_LOG_LEVEL ?? env.MOSAIC_LOG) });
  setMosaicLogger(logger);
  return logger;
}
