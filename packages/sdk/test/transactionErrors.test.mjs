import test from "node:test";
import assert from "node:assert/strict";
import { transactionErrorMessage } from "../dist/index.js";

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
