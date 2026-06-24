#!/usr/bin/env python3
"""Regenerate the WS4 contract-test fixtures in this directory.

Every witness (note/order Merkle paths, per-note nonces, nullifier-IMT insert witnesses) is produced
by the off-chain path server (tools/indexer's `witness` bin), so the proofs are made against exactly
the tree/accumulator state the contract reaches when tests/ws4.rs replays the same sequence. Two
scenarios:

  A. standalone place_order: shield ONE note (taker), place its order against genesis IMT.
     -> note_tag, lift_vk, place_proof, place_public_inputs   (test: shield_then_place_order_real_proof)

  B. full lifecycle: shield TWO notes (taker+maker), place both, then settle_match.
     -> tk_place_*, mk_place_*, match_*, match_vk             (test: full_flow_shield_place_place_settle_match)
  C. join: shield TWO same-asset notes (150 + 200 a1), consolidate -> 300 (target) + 50 (change).
     -> join_proof, join_pi, join_vk                          (tests/join.rs)
  D. unshield: shield ONE note (100 a1), spend it to UNSHIELD_TO with the recipient bound in-proof.
     -> unshield_proof, unshield_pi, unshield_vk              (tests/integration.rs)

Requires on PATH: the `witness` bin (cargo build -p mosaic-indexer --bin witness), `nargo`
(1.0.0-beta.9), and `bb` (0.87.0). Run:  python3 regen.py

Scenario secrets (also hard-coded in tests/ws4.rs so it can recompute tags off-chain):
  taker: sk 0x11, note rho 0x22 nonce 0x33, out 0x44, cancel 0x55; order give 100 asset1 want >=1500 asset2
  maker: sk 0xAA, note rho 0xBB nonce 0xCC, out 0xDD, cancel 0xEE; order give 1600 asset2 want >=100 asset1
  expiry 1000 (within MAX_ORDER_TTL), match `now` 100.
"""
import subprocess, re, os, shutil

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "../../../../.."))
W = os.path.join(ROOT, "tools/indexer/target/debug/witness")
LIFT = os.path.join(ROOT, "circuits/lift")
MATCH = os.path.join(ROOT, "circuits/match")
JOIN = os.path.join(ROOT, "circuits/join")
UNSHIELD = os.path.join(ROOT, "circuits/unshield")
FX = HERE
# Fixed recipient for the unshield scenario (tests/integration.rs uses the SAME address so the
# contract's sha256-derived recipient field matches the proof-bound one). A CONTRACT address (C...)
# so the test SAC transfer needs no classic-account trustline.
UNSHIELD_TO = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM"
EXP, PART, NOW = "1000", "1", "100"
ZHEX = "[" + ", ".join(['"0x' + "0" * 64 + '"'] * 32) + "]"
ZBITS = "[" + ", ".join(['"0"'] * 32) + "]"


def witness(cmds):
    r = subprocess.run([W], input=cmds, capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit("witness: " + r.stderr)
    return r.stdout


def one(cmds):
    return [l.strip() for l in witness(cmds).splitlines() if l.strip().startswith("0x")][0]


def arrs(doc, key):
    return re.findall(rf'^{key} = (\[.*?\])\s*$', doc, re.M)


def scals(doc, key):
    return re.findall(rf'^{key} = "(.*?)"', doc, re.M)


def imt_get(b):
    return dict(
        rin=scals(b, "nullifier_root_in")[0], rout=scals(b, "nullifier_root_out")[0],
        lv=scals(b, "low_value")[0], lnv=scals(b, "low_next_value")[0], lni=scals(b, "low_next_index")[0],
        lp=arrs(b, "low_path")[0], lb=arrs(b, "low_index_bits")[0],
        np=arrs(b, "new_path")[0], nb=arrs(b, "new_index_bits")[0])


def a3(x, z):
    return "[" + x + ", " + z + ", " + z + "]"


def prove(dirp, jsonname, proofbase, want_vk=None):
    subprocess.run(["nargo", "execute"], cwd=dirp, check=True, capture_output=True)
    gz = jsonname.replace(".json", ".gz")
    for cmd in (["bb", "prove", "-b", f"target/{jsonname}", "-w", f"target/{gz}", "-o", "target/bb",
                 "--scheme", "ultra_honk", "--oracle_hash", "keccak", "--output_format", "bytes_and_fields"],
                ["bb", "write_vk", "-b", f"target/{jsonname}", "-o", "target/bb",
                 "--scheme", "ultra_honk", "--oracle_hash", "keccak", "--output_format", "bytes_and_fields"]):
        subprocess.run(cmd, cwd=dirp, check=True, capture_output=True)
    shutil.copy(f"{dirp}/target/bb/proof", f"{FX}/{proofbase}_proof")
    shutil.copy(f"{dirp}/target/bb/public_inputs", f"{FX}/{proofbase}_pi")
    if want_vk:
        shutil.copy(f"{dirp}/target/bb/vk", f"{FX}/{want_vk}")


def lift_pt(note_root, rho, sk, nonce, npath, nbit, I, nf, ain, amt, aout, mout, otag, ctag, oleaf):
    return "\n".join([
        f'rho_in = "{rho}"', f'sk_o = "{sk}"', f'nonce_in = "{nonce}"',
        f'path = {npath}', f'index_bits = {nbit}',
        f'low_value = "{I["lv"]}"', f'low_next_value = "{I["lnv"]}"', f'low_next_index = "{I["lni"]}"',
        f'low_path = {I["lp"]}', f'low_index_bits = {I["lb"]}',
        f'new_path = {I["np"]}', f'new_index_bits = {I["nb"]}',
        'domain = "1"', f'note_root = "{note_root}"',
        f'nullifier_root_in = "{I["rin"]}"', f'nullifier_root_out = "{I["rout"]}"',
        f'nullifier_in = "{nf}"', f'asset_in = "{ain}"', f'amount_in = "{amt}"',
        f'asset_out = "{aout}"', f'min_out = "{mout}"',
        f'output_owner_tag_pub = "{otag}"', f'cancel_owner_tag = "{ctag}"',
        f'expiry = "{EXP}"', f'partial_allowed = "{PART}"', f'order_leaf = "{oleaf}"',
    ]) + "\n"


# --- stateless crypto (shared by both scenarios) ---
t_note_tag = one("notetagn 0x11 0x22 0x33"); nf_note_t = one("notenull 0x11 0x22 0x33")
m_note_tag = one("notetagn 0xAA 0xBB 0xCC"); nf_note_m = one("notenull 0xAA 0xBB 0xCC")
t_out = one("notetag 0x11 0x44"); t_can = one("notetag 0x11 0x55")
m_out = one("notetag 0xAA 0xDD"); m_can = one("notetag 0xAA 0xEE")
t_leaf = one(f"orderleaf 1 100 2 1500 {t_out} {t_can} {EXP} {PART}")
m_leaf = one(f"orderleaf 2 1600 1 100 {m_out} {m_can} {EXP} {PART}")
nf_ord_t = one(f"ordernull {t_leaf}"); nf_ord_m = one(f"ordernull {m_leaf}")
p0_tag = one(f"compress {t_out} {one(f'compress {t_leaf} 0')}")
p1_tag = one(f"compress {m_out} {one(f'compress {t_leaf} 1')}")

# --- Scenario A: standalone place_order (single shield, genesis IMT) ---
SA = witness("\n".join([f"shield 1 100 {t_note_tag}", "path 0", f"imtwitness {nf_note_t}"]))
nrA = scals(SA, "root")[0]
IA = imt_get(SA.split("# --- IMT insert witness ---")[1])
open(f"{LIFT}/Prover.toml", "w").write(lift_pt(nrA, "0x22", "0x11", "0x33", arrs(SA, "path")[0],
    arrs(SA, "index_bits")[0], IA, nf_note_t, 1, 100, 2, 1500, t_out, t_can, t_leaf))
prove(LIFT, "lift.json", "place", want_vk="lift_vk")
shutil.move(f"{FX}/place_pi", f"{FX}/place_public_inputs")
open(f"{FX}/note_tag", "wb").write(bytes.fromhex(t_note_tag[2:]))

# --- Scenario B: full lifecycle (two shields, two places, settle_match) ---
SB = witness("\n".join([
    f"shield 1 100 {t_note_tag}", f"shield 2 1600 {m_note_tag}",
    "root", "path 0", "path 1",
    f"imtwitness {nf_note_t}", f"nfspent {nf_note_t}",
    f"imtwitness {nf_note_m}", f"nfspent {nf_note_m}",
    f"orderins 1 100 2 1500 {t_out} {t_can} {EXP} {PART}",
    f"orderins 2 1600 1 100 {m_out} {m_can} {EXP} {PART}",
    "orderroot", "orderpath 0", "orderpath 1",
    f"imtwitness {nf_ord_t}", f"nfspent {nf_ord_t}", f"imtwitness {nf_ord_m}",
]))
note_root = scals(SB, "root")[0]; order_root = scals(SB, "order_root")[0]
npaths, nbits = arrs(SB, "path"), arrs(SB, "index_bits")
opaths, obits = arrs(SB, "order_path"), arrs(SB, "order_index_bits")
TI, MI, MTI, MMI = (imt_get(b) for b in SB.split("# --- IMT insert witness ---")[1:5])

open(f"{LIFT}/Prover.toml", "w").write(lift_pt(note_root, "0x22", "0x11", "0x33", npaths[0], nbits[0],
    TI, nf_note_t, 1, 100, 2, 1500, t_out, t_can, t_leaf))
prove(LIFT, "lift.json", "tk_place")
open(f"{LIFT}/Prover.toml", "w").write(lift_pt(note_root, "0xBB", "0xAA", "0xCC", npaths[1], nbits[1],
    MI, nf_note_m, 2, 1600, 1, 100, m_out, m_can, m_leaf))
prove(LIFT, "lift.json", "mk_place")

match_lines = [
    't_asset_in = "1"', 't_amount_in = "100"', 't_asset_out = "2"', 't_min_out = "1500"',
    f't_out_tag = "{t_out}"', f't_cancel_tag = "{t_can}"', f't_expiry = "{EXP}"', f't_partial = "{PART}"',
    f't_path = {opaths[0]}', f't_index_bits = {obits[0]}',
    f't_low_value = "{MTI["lv"]}"', f't_low_next_value = "{MTI["lnv"]}"', f't_low_next_index = "{MTI["lni"]}"',
    f't_low_path = {MTI["lp"]}', f't_low_index_bits = {MTI["lb"]}',
    f't_new_path = {MTI["np"]}', f't_new_index_bits = {MTI["nb"]}',
    'm_asset_in = ["2", "0", "0"]', 'm_amount_in = ["1600", "0", "0"]',
    'm_asset_out = ["1", "0", "0"]', 'm_min_out = ["100", "0", "0"]',
    f'm_out_tag = ["{m_out}", "0", "0"]', f'm_cancel_tag = ["{m_can}", "0", "0"]',
    f'm_expiry = ["{EXP}", "0", "0"]', f'm_partial = ["{PART}", "0", "0"]',
    f'm_path = {a3(opaths[1], ZHEX)}', f'm_index_bits = {a3(obits[1], ZBITS)}',
    f'm_low_value = ["{MMI["lv"]}", "0", "0"]', f'm_low_next_value = ["{MMI["lnv"]}", "0", "0"]',
    f'm_low_next_index = ["{MMI["lni"]}", "0", "0"]',
    f'm_low_path = {a3(MMI["lp"], ZHEX)}', f'm_low_index_bits = {a3(MMI["lb"], ZBITS)}',
    f'm_new_path = {a3(MMI["np"], ZHEX)}', f'm_new_index_bits = {a3(MMI["nb"], ZBITS)}',
    'domain = "5"', f'order_root = "{order_root}"',
    f'nullifier_root_in = "{MTI["rin"]}"', f'nullifier_root_out = "{MMI["rout"]}"', f'now = "{NOW}"',
    f'nf_taker = "{nf_ord_t}"', f'nf_maker0 = "{nf_ord_m}"', 'nf_maker1 = "0"', 'nf_maker2 = "0"',
    'p0_live = "1"', 'p0_asset = "2"', 'p0_amount = "1600"', f'p0_tag = "{p0_tag}"',
    'p1_live = "1"', 'p1_asset = "1"', 'p1_amount = "100"', f'p1_tag = "{p1_tag}"',
    'p2_live = "0"', 'p2_asset = "0"', 'p2_amount = "0"', 'p2_tag = "0"',
    'p3_live = "0"', 'p3_asset = "0"', 'p3_amount = "0"', 'p3_tag = "0"',
    'remainder_live = "0"', 'rem_asset_in = "0"', 'rem_amount_in = "0"', 'rem_asset_out = "0"',
    'rem_min_out = "0"', 'rem_output_owner_tag = "0"', 'rem_cancel_owner_tag = "0"',
    'rem_expiry = "0"', 'rem_partial_allowed = "0"', 'remainder_order_leaf = "0"',
]
open(f"{MATCH}/Prover.toml", "w").write("\n".join(match_lines) + "\n")
prove(MATCH, "matching.json", "match", want_vk="match_vk")


# --- Scenario C: join (consolidate two same-asset notes) ---
# shield A=150 a1 (leaf 0) + B=200 a1 (leaf 1); join -> out_1 = 300 (target) + out_2 = 50 (change).
j1_tag = one("notetagn 0x31 0x32 0x0"); j1_nf = one("notenull 0x31 0x32 0x0")
j2_tag = one("notetagn 0x41 0x42 0x0"); j2_nf = one("notenull 0x41 0x42 0x0")
j_out1 = one("notetagn 0x51 0x52 0x0"); j_out2 = one("notetagn 0x61 0x62 0x0")
SC = witness("\n".join([
    f"shield 1 150 {j1_tag}", f"shield 1 200 {j2_tag}", "root", "path 0", "path 1",
    f"imtwitness {j1_nf}", f"nfspent {j1_nf}", f"imtwitness {j2_nf}",
]))
jnr = scals(SC, "root")[0]
jpaths, jbits = arrs(SC, "path"), arrs(SC, "index_bits")
J1, J2 = (imt_get(b) for b in SC.split("# --- IMT insert witness ---")[1:3])
join_lines = [
    'sk_1 = "0x31"', 'rho_1 = "0x32"', 'nonce_1 = "0x0"', 'amount_1 = "150"',
    f'path_1 = {jpaths[0]}', f'index_bits_1 = {jbits[0]}',
    f'low1_value = "{J1["lv"]}"', f'low1_next_value = "{J1["lnv"]}"', f'low1_next_index = "{J1["lni"]}"',
    f'low1_path = {J1["lp"]}', f'low1_index_bits = {J1["lb"]}',
    f'new1_path = {J1["np"]}', f'new1_index_bits = {J1["nb"]}',
    'sk_2 = "0x41"', 'rho_2 = "0x42"', 'nonce_2 = "0x0"', 'amount_2 = "200"',
    f'path_2 = {jpaths[1]}', f'index_bits_2 = {jbits[1]}',
    f'low2_value = "{J2["lv"]}"', f'low2_next_value = "{J2["lnv"]}"', f'low2_next_index = "{J2["lni"]}"',
    f'low2_path = {J2["lp"]}', f'low2_index_bits = {J2["lb"]}',
    f'new2_path = {J2["np"]}', f'new2_index_bits = {J2["nb"]}',
    'domain = "4"', f'note_root = "{jnr}"',
    f'nullifier_root_in = "{J1["rin"]}"', f'nullifier_root_out = "{J2["rout"]}"',
    f'nullifier_1 = "{j1_nf}"', f'nullifier_2 = "{j2_nf}"', 'asset = "1"',
    f'out_tag_1 = "{j_out1}"', 'out_amount_1 = "300"',
    f'out_tag_2 = "{j_out2}"', 'out_amount_2 = "50"',
]
open(f"{JOIN}/Prover.toml", "w").write("\n".join(join_lines) + "\n")
prove(JOIN, "join.json", "join", want_vk="join_vk")


# --- Scenario D: unshield (spend one note to a bound recipient) ---
# shield U=100 a1 (leaf 0); unshield to UNSHIELD_TO.
u_tag = one("notetagn 0x71 0x72 0x0"); u_nf = one("notenull 0x71 0x72 0x0")
u_rcpt = one(f"recipient {UNSHIELD_TO}")
SD = witness("\n".join([f"shield 1 100 {u_tag}", "root", "path 0", f"imtwitness {u_nf}"]))
unr = scals(SD, "root")[0]
UI = imt_get(SD.split("# --- IMT insert witness ---")[1])
unshield_lines = [
    'rho_in = "0x72"', 'sk_o = "0x71"', 'nonce_in = "0x0"',
    f'path = {arrs(SD, "path")[0]}', f'index_bits = {arrs(SD, "index_bits")[0]}',
    f'low_value = "{UI["lv"]}"', f'low_next_value = "{UI["lnv"]}"', f'low_next_index = "{UI["lni"]}"',
    f'low_path = {UI["lp"]}', f'low_index_bits = {UI["lb"]}',
    f'new_path = {UI["np"]}', f'new_index_bits = {UI["nb"]}',
    'domain = "2"', f'note_root = "{unr}"',
    f'nullifier_root_in = "{UI["rin"]}"', f'nullifier_root_out = "{UI["rout"]}"',
    f'nullifier = "{u_nf}"', 'asset = "1"', 'amount = "100"', f'recipient = "{u_rcpt}"',
]
open(f"{UNSHIELD}/Prover.toml", "w").write("\n".join(unshield_lines) + "\n")
prove(UNSHIELD, "unshield.json", "unshield", want_vk="unshield_vk")

print("regenerated WS4 fixtures in", FX)
