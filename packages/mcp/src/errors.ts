import { randomUUID } from "node:crypto";
import { errorMessage } from "@mosaic/sdk";

export type MosaicMcpErrorCode =
  | "AUTH_EXPIRED"
  | "AUTH_INVALID"
  | "LEASE_EXPIRED"
  | "VALIDATION_FAILED"
  | "RELAY_REJECTED"
  | "CLI_TIMEOUT"
  | "PROVE_UNAVAILABLE"
  | "BASE_RPC_UNAVAILABLE"
  | "FINALITY_UNAVAILABLE"
  | "ALREADY_PROCESSED"
  | "CONFLICT"
  | "NOT_FOUND"
  | "TIMEOUT"
  | "UNAVAILABLE"
  | "INTERNAL";

export interface MosaicMcpErrorBody {
  code: MosaicMcpErrorCode;
  message: string;
  retryable: boolean;
  status: number;
  details?: unknown;
  correlation_id: string;
}

const STATUS: Record<MosaicMcpErrorCode, number> = {
  AUTH_EXPIRED: 401,
  AUTH_INVALID: 401,
  LEASE_EXPIRED: 409,
  VALIDATION_FAILED: 400,
  RELAY_REJECTED: 422,
  CLI_TIMEOUT: 504,
  PROVE_UNAVAILABLE: 503,
  BASE_RPC_UNAVAILABLE: 503,
  FINALITY_UNAVAILABLE: 503,
  ALREADY_PROCESSED: 409,
  CONFLICT: 409,
  NOT_FOUND: 404,
  TIMEOUT: 504,
  UNAVAILABLE: 503,
  INTERNAL: 500,
};

const RETRYABLE = new Set<MosaicMcpErrorCode>([
  "CLI_TIMEOUT",
  "PROVE_UNAVAILABLE",
  "BASE_RPC_UNAVAILABLE",
  "FINALITY_UNAVAILABLE",
  "TIMEOUT",
  "UNAVAILABLE",
]);

export class MosaicMcpError extends Error {
  readonly code: MosaicMcpErrorCode;
  readonly retryable: boolean;
  readonly status: number;
  readonly details?: unknown;
  readonly correlationId: string;

  constructor(
    code: MosaicMcpErrorCode,
    message: string,
    opts: { retryable?: boolean; status?: number; details?: unknown; correlationId?: string; cause?: unknown } = {},
  ) {
    super(message, { cause: opts.cause });
    this.name = "MosaicMcpError";
    this.code = code;
    this.retryable = opts.retryable ?? RETRYABLE.has(code);
    this.status = opts.status ?? STATUS[code];
    this.details = opts.details;
    this.correlationId = opts.correlationId ?? randomUUID();
  }

  body(): MosaicMcpErrorBody {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      status: this.status,
      ...(this.details === undefined ? {} : { details: this.details }),
      correlation_id: this.correlationId,
    };
  }
}

export function classifyMcpError(error: unknown): MosaicMcpError {
  if (error instanceof MosaicMcpError) return error;
  const message = errorMessage(error);
  const lower = message.toLowerCase();
  if (lower.includes("invalid or expired session") || lower.includes("session expired")) {
    return new MosaicMcpError("AUTH_EXPIRED", message, { cause: error });
  }
  if (lower.includes("signature verification") || lower.includes("unknown or mismatched challenge")) {
    return new MosaicMcpError("AUTH_INVALID", message, { cause: error });
  }
  if (lower.includes("invalid or expired client action lease")) {
    return new MosaicMcpError("LEASE_EXPIRED", message, { cause: error });
  }
  if (lower.includes("not found") || lower.includes("no configured base bridge")) {
    return new MosaicMcpError("NOT_FOUND", message, { cause: error });
  }
  if (lower.includes("conflict") || lower.includes("mismatch") || lower.includes("already leased")) {
    return new MosaicMcpError("CONFLICT", message, { cause: error });
  }
  if (lower.includes("relay validation failed") || lower.includes("relay") || lower.includes("contract invoke failed")) {
    return new MosaicMcpError("RELAY_REJECTED", message, { cause: error });
  }
  if (lower.includes("timed out") || lower.includes("timeout")) {
    return new MosaicMcpError("TIMEOUT", message, { cause: error });
  }
  if (lower.includes("prove")) {
    return new MosaicMcpError("PROVE_UNAVAILABLE", message, { cause: error });
  }
  if (lower.includes("base rpc")) {
    return new MosaicMcpError("BASE_RPC_UNAVAILABLE", message, { cause: error });
  }
  if (lower.includes("finality") || lower.includes("finalized")) {
    return new MosaicMcpError("FINALITY_UNAVAILABLE", message, { cause: error });
  }
  if (lower.includes("already processed")) {
    return new MosaicMcpError("ALREADY_PROCESSED", message, { retryable: false, cause: error });
  }
  return new MosaicMcpError("INTERNAL", message, { cause: error });
}

export function mcpErrorContent(error: unknown): { error: MosaicMcpErrorBody } {
  return { error: classifyMcpError(error).body() };
}
