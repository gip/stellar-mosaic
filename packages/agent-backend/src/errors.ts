// MCP error taxonomy for the agent backend, mirroring packages/mcp/src/errors.ts but keyed off
// AgentBackendError.status — store/auth/handlers keep throwing AgentBackendError and this module
// classifies it at the tool/transport boundary. The body's `status` must reproduce the HTTP status
// the REST API used to return: AgentBackendClient rebuilds AgentBackendClientError.status from it,
// and the runner daemon's re-auth logic keys on 401.

import { randomUUID } from "node:crypto";
import { errorMessage, type MosaicMcpErrorBody } from "@mosaic/sdk";
import { AgentBackendError } from "./store.js";

export type { MosaicMcpErrorBody };

export type AgentMcpErrorCode =
  | "AUTH_EXPIRED"
  | "AUTH_INVALID"
  | "VALIDATION_FAILED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "TIMEOUT"
  | "INTERNAL";

const STATUS: Record<AgentMcpErrorCode, number> = {
  AUTH_EXPIRED: 401,
  AUTH_INVALID: 401,
  VALIDATION_FAILED: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  TIMEOUT: 504,
  INTERNAL: 500,
};

const RETRYABLE = new Set<AgentMcpErrorCode>(["TIMEOUT"]);

export class AgentMcpError extends Error {
  readonly code: AgentMcpErrorCode;
  readonly retryable: boolean;
  readonly status: number;
  readonly correlationId: string;

  constructor(
    code: AgentMcpErrorCode,
    message: string,
    opts: { retryable?: boolean; status?: number; correlationId?: string; cause?: unknown } = {},
  ) {
    super(message, { cause: opts.cause });
    this.name = "AgentMcpError";
    this.code = code;
    this.retryable = opts.retryable ?? RETRYABLE.has(code);
    this.status = opts.status ?? STATUS[code];
    this.correlationId = opts.correlationId ?? randomUUID();
  }

  body(): MosaicMcpErrorBody {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      status: this.status,
      correlation_id: this.correlationId,
    };
  }
}

export function classifyAgentError(error: unknown): AgentMcpError {
  if (error instanceof AgentMcpError) return error;
  if (error instanceof AgentBackendError) {
    const { status, message } = error;
    if (status === 401) {
      // Expired-session 401s are transparently recoverable by re-authenticating; other 401s
      // (bad signature, missing token) are not, but both keep status 401 for the client.
      const code = message.toLowerCase().includes("invalid or expired session") ? "AUTH_EXPIRED" : "AUTH_INVALID";
      return new AgentMcpError(code, message, { cause: error });
    }
    if (status === 403) return new AgentMcpError("AUTH_INVALID", message, { status: 403, cause: error });
    if (status === 400 || status === 413) return new AgentMcpError("VALIDATION_FAILED", message, { status, cause: error });
    if (status === 404) return new AgentMcpError("NOT_FOUND", message, { cause: error });
    if (status === 409) return new AgentMcpError("CONFLICT", message, { cause: error });
    return new AgentMcpError("INTERNAL", message, { status, cause: error });
  }
  const message = errorMessage(error);
  if (message.toLowerCase().includes("timed out")) return new AgentMcpError("TIMEOUT", message, { cause: error });
  return new AgentMcpError("INTERNAL", message, { cause: error });
}

export function agentErrorContent(error: unknown): { error: MosaicMcpErrorBody } {
  return { error: classifyAgentError(error).body() };
}
