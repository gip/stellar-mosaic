// recipientField must produce the exact field the unshield circuit + contract bind. Golden value
// from the canonical Rust witness bin (`recipient <strkey>`) for a deterministic address.
import test from "node:test";
import assert from "node:assert/strict";
import { recipientField } from "../dist/index.js";

// Keypair.fromRawEd25519Seed(Buffer.alloc(32,7)).publicKey()
const ADDR = "GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57";
const GOLDEN = "0x00625b2dc0bca464a0bf16cb6292e9237538c607f814b0721bc113e5d205504f";

test("recipientField matches the witness-bin recipient binding", async () => {
  assert.equal(await recipientField(ADDR), GOLDEN);
});
