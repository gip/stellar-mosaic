import test from "node:test";
import assert from "node:assert/strict";
import { contractErrorCode, transactionErrorMessage } from "../dist/index.js";

test("contractErrorCode parses the Soroban host's contract-error rendering", () => {
  assert.equal(
    contractErrorCode(new Error("transaction simulation failed: HostError: Error(Contract, #27)")),
    27,
  );
  assert.equal(contractErrorCode("HostError: Error(Contract, #13)\nEvent log: ..."), 13);
  assert.equal(contractErrorCode(new Error("stellar rpc: connection reset")), null);
  assert.equal(contractErrorCode(new Error("Error(WasmVm, InvalidAction)")), null);
});

test("transactionErrorMessage maps missing trustline failures to an asset funding message", () => {
  const message = transactionErrorMessage(
    `Simulation failed: "HostError: Error(Contract, #13)
Event log:
  [Failed Diagnostic Event] topics:[error, Error(Contract, #13)], data:["trustline entry is missing for account", GC6RY5...]"
`,
    { contractId: "C", method: "shield", metadata: { symbol: "USDC" }, args: [] },
  );

  assert.equal(
    message,
    "You do not have enough USDC available to complete this transaction. Add or fund USDC in your Stellar wallet, then try again.",
  );
});

test("transactionErrorMessage hides unknown transaction diagnostics behind a generic fallback", () => {
  assert.equal(
    transactionErrorMessage("HostError: Error(Contract, #99)", { contractId: "C", method: "shield", args: [] }),
    "Transaction could not be completed.",
  );
});

test("transactionErrorMessage maps the permissioned-desk NotAllowed error (code 32)", () => {
  assert.equal(
    transactionErrorMessage("Simulation failed: HostError: Error(Contract, #32)", {
      contractId: "C",
      method: "shield",
      args: [],
    }),
    "This desk is permissioned and the address is not on its allowlist. Ask the desk owner to add it.",
  );
});
