// Golden-vector + determinism tests for the derivation core. The frozen constants below pin the
// domain strings, canonical message, and label formats: if any of them change, these tests fail —
// which is the point, because a change re-keys every existing agent.

import test from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { SecretKeySigner } from "@mosaic/sdk";
import {
  agentMasterMessage,
  deriveAgentRoot,
  agentIdentityFromRoot,
  normalizeEthSignature,
  signAgentMasterStellar,
  signAgentMasterEth,
  ethMessageSignerFromKey,
  toHex,
} from "../dist/portable.js";

const NETWORK = "Test SDF Network ; September 2015";
const FIXED_SIG = new Uint8Array(64).map((_, i) => (i * 7 + 3) & 0xff);
const FIXED_REF = {
  chain: "stellar",
  address: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
  networkPassphrase: NETWORK,
};

// Frozen 2026-07-06. Any diff here means the derivation scheme changed — do not "fix" the
// expectations without understanding that existing agents would be re-keyed.
const GOLDEN = {
  0: {
    agentRoot: "64a40ad669f24095f12656eda0871b8a88ef6bbd50df7fc34dcb27e1e6a0331e",
    stellar: "GADN2XXCLPGQ6LWXKZHN57T5BBBEHQPFWBY5AACWMOLWEGTQJDW3UK4K",
    eth: "0x80fB10C77504678aa4578de16Ba98d7a2Fc7acAF",
    dataKey: "1b275730a6dec0870cf25d575efd69a9aea987bfe090b851f02c89c14283a39a",
    xmtpDbKey: "0x05b9d76a73180d22f665f3380372d03678b19766852dc4fbc0418df4901d8b1f",
  },
  1: {
    agentRoot: "172495bd828b213a988a5d05dfc685ac37ecdfab015f81089330dd79b0210878",
    stellar: "GAGDUHG2BD3TQ7Q33SEKLY3QEV4TSKG5YZKRFENHVCL5J4E5HL3RUSMV",
    eth: "0xe5D265e5CE4377f93b8917324f46451c18725729",
    dataKey: "edf4c3dade05cb672703415c50e8cd0e1f0e79b77a3c10eac2107a3ae8c912b3",
    xmtpDbKey: "0x0f1c3bbc93d5e840e93aa5e12b82c1502aee1f3bc3e1c7598e739393ee66bf4f",
  },
};

test("canonical master message is frozen", () => {
  assert.equal(
    agentMasterMessage(FIXED_REF),
    [
      "Stellar Mosaic Agent Master Key",
      "Version: 1",
      "Chain: stellar",
      `Address: ${FIXED_REF.address}`,
      `Network: ${NETWORK}`,
      "Purpose: derive deterministic Stellar Mosaic agent identities.",
      "WARNING: Only sign this exact message inside a trusted Stellar Mosaic application.",
    ].join("\n"),
  );
});

test("golden vectors: fixed signature derives exact keys", async () => {
  const root = await deriveAgentRoot(FIXED_SIG, FIXED_REF);
  for (const index of [0, 1]) {
    const expected = GOLDEN[index];
    const id = await root.deriveIdentity(index);
    assert.equal(toHex(await root.agentRootBytes(index)), expected.agentRoot);
    assert.equal(id.stellarPublicKey, expected.stellar);
    assert.equal(id.ethAddress, expected.eth);
    assert.equal(toHex(id.dataKey), expected.dataKey);
    assert.equal(id.xmtpDbKey, expected.xmtpDbKey);
    // The secrets really control the public keys.
    assert.equal(Keypair.fromSecret(id.stellarSecret).publicKey(), expected.stellar);
    assert.equal(privateKeyToAccount(id.ethKey).address, expected.eth);
  }
});

test("identity rebuilt from a bare agent root matches the signature-derived one", async () => {
  const root = await deriveAgentRoot(FIXED_SIG, FIXED_REF);
  const full = await root.deriveIdentity(0);
  const rebuilt = await agentIdentityFromRoot(full.root);
  assert.equal(rebuilt.stellarSecret, full.stellarSecret);
  assert.equal(rebuilt.ethKey, full.ethKey);
  assert.equal(toHex(rebuilt.dataKey), toHex(full.dataKey));
  assert.equal(rebuilt.xmtpDbKey, full.xmtpDbKey);
  assert.throws(() => rebuilt.descriptor(), /needs index \+ master/);
});

test("descriptor carries the public registration payload only", async () => {
  const root = await deriveAgentRoot(FIXED_SIG, FIXED_REF);
  const id = await root.deriveIdentity(3);
  const d = id.descriptor("scout", { note: "x" });
  assert.deepEqual(d, {
    derivation_version: 1,
    master_chain: "stellar",
    master_address: FIXED_REF.address,
    network_passphrase: NETWORK,
    index: 3,
    stellar_public_key: id.stellarPublicKey,
    eth_address: id.ethAddress,
    name: "scout",
    metadata: { note: "x" },
  });
  const json = JSON.stringify(d);
  assert.ok(!json.includes(id.stellarSecret));
  assert.ok(!json.includes(id.ethKey.slice(2)));
});

test("indices, networks, and chains are cryptographically separated", async () => {
  const root = await deriveAgentRoot(FIXED_SIG, FIXED_REF);
  const a = await root.deriveIdentity(0);
  const b = await root.deriveIdentity(1);
  assert.notEqual(a.stellarPublicKey, b.stellarPublicKey);

  const otherNetwork = await deriveAgentRoot(FIXED_SIG, { ...FIXED_REF, networkPassphrase: "Public Global Stellar Network ; September 2015" });
  assert.notEqual((await otherNetwork.deriveIdentity(0)).stellarPublicKey, a.stellarPublicKey);

  const otherChain = await deriveAgentRoot(FIXED_SIG, { ...FIXED_REF, chain: "ethereum" });
  assert.notEqual((await otherChain.deriveIdentity(0)).stellarPublicKey, a.stellarPublicKey);
});

test("normalizeEthSignature maps a high-s signature to its low-s twin", () => {
  const N = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");
  const r = new Uint8Array(32).fill(9);
  const sLow = 12345678901234567890n;
  const low = new Uint8Array(65);
  low.set(r, 0);
  low.set(bigTo32(sLow), 32);
  low[64] = 27;
  const high = new Uint8Array(65);
  high.set(r, 0);
  high.set(bigTo32(N - sLow), 32);
  high[64] = 28;
  assert.deepEqual(normalizeEthSignature(high), normalizeEthSignature(low));
  // v given as 0/1 canonicalizes to 27/28
  const v0 = Uint8Array.from(low);
  v0[64] = 0;
  assert.equal(normalizeEthSignature(v0)[64], 27);
  assert.throws(() => normalizeEthSignature(new Uint8Array(64)), /65-byte/);
});

test("stellar master: double-sign roundtrip is deterministic end to end", async () => {
  const signer = new SecretKeySigner(Keypair.random().secret());
  const one = await signAgentMasterStellar(signer, NETWORK);
  const two = await signAgentMasterStellar(signer, NETWORK);
  assert.equal(toHex(one.signature), toHex(two.signature));
  const idOne = await (await deriveAgentRoot(one.signature, one.ref)).deriveIdentity(0);
  const idTwo = await (await deriveAgentRoot(two.signature, two.ref)).deriveIdentity(0);
  assert.equal(idOne.stellarSecret, idTwo.stellarSecret);
});

test("ethereum master: double-sign roundtrip is deterministic end to end", async () => {
  const signer = ethMessageSignerFromKey(generatePrivateKey());
  const one = await signAgentMasterEth(signer, NETWORK);
  const two = await signAgentMasterEth(signer, NETWORK);
  assert.equal(toHex(one.signature), toHex(two.signature));
  assert.equal(one.ref.chain, "ethereum");
  const idOne = await (await deriveAgentRoot(one.signature, one.ref)).deriveIdentity(0);
  const idTwo = await (await deriveAgentRoot(two.signature, two.ref)).deriveIdentity(0);
  assert.equal(idOne.ethKey, idTwo.ethKey);
});

test("ethereum master: a signer answering for the wrong address is rejected", async () => {
  const honest = ethMessageSignerFromKey(generatePrivateKey());
  const liar = {
    address: async () => privateKeyToAccount(generatePrivateKey()).address,
    personalSign: (m) => honest.personalSign(m),
  };
  await assert.rejects(signAgentMasterEth(liar, NETWORK), /does not recover/);
});

function bigTo32(n) {
  const hex = n.toString(16).padStart(64, "0");
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
