import { errorMessage } from "./logging.js";
import type { ContractCall } from "./ports.js";

const GENERIC_TRANSACTION_ERROR = "Transaction could not be completed.";

function metadataString(call: ContractCall | undefined, key: string): string | undefined {
  const value = call?.metadata?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function assetLabel(call: ContractCall | undefined): string {
  return metadataString(call, "symbol") ?? "the selected asset";
}

function normalizedText(error: unknown): string {
  return errorMessage(error).toLowerCase();
}

export function transactionErrorMessage(error: unknown, call?: ContractCall): string {
  const text = normalizedText(error);
  if (
    text.includes("trustline entry is missing") ||
    text.includes("underfunded") ||
    text.includes("insufficient balance") ||
    text.includes("balance is too low") ||
    text.includes("exceeds balance") ||
    text.includes("line is not funded")
  ) {
    const asset = assetLabel(call);
    return `You do not have enough ${asset} available to complete this transaction. Add or fund ${asset} in your Stellar wallet, then try again.`;
  }
  return GENERIC_TRANSACTION_ERROR;
}
