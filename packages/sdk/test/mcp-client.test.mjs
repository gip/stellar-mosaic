import test from "node:test";
import assert from "node:assert/strict";
import { MosaicMcpClientError } from "../dist/mcp-client.js";

test("MosaicMcpClientError preserves structured MCP error metadata", () => {
  const error = new MosaicMcpClientError("get_desk", {
    code: "NOT_FOUND",
    message: "desk missing",
    retryable: false,
    status: 404,
    details: { id: "missing" },
    correlation_id: "corr-1",
  });
  assert.equal(error.name, "MosaicMcpClientError");
  assert.equal(error.code, "NOT_FOUND");
  assert.equal(error.retryable, false);
  assert.equal(error.status, 404);
  assert.deepEqual(error.details, { id: "missing" });
  assert.equal(error.correlationId, "corr-1");
});
