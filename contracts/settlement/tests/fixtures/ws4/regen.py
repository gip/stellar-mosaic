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
  E. cancel: shield 100 a1 -> place SELL -> cancel (reclaim). The place proof + the cancel proof.
     -> cancel_place_{proof,pi}, cancel_{proof,pi,vk}, cancel_note_tag   (scripts/06 budget)
  F. WORST-CASE settle_match: 1 taker x 3 makers + remainder, with the 4 place proofs that rest it.
     -> wt_place_*, wm{0,1,2}_place_*, wmatch_{proof,pi}, wmatch_*_tag   (scripts/07 worst case)

Requires on PATH: the `witness` bin (cargo build -p mosaic-indexer --bin witness), `nargo`
(1.0.0-beta.9), and `bb` (0.87.0). Run:  python3 regen.py

Scenario secrets (also hard-coded in tests/ws4.rs so it can recompute tags off-chain):
  taker: sk 0x11, note rho 0x22 nonce 0x33, out 0x44, cancel 0x55; order give 100 asset1 want >=1500 asset2
  maker: sk 0xAA, note rho 0xBB nonce 0xCC, out 0xDD, cancel 0xEE; order give 1600 asset2 want >=100 asset1
  expiry 1000 (within MAX_ORDER_TTL), match `now` 100.
"""
import subprocess, re, os, shutil, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "../../../../.."))
W = os.path.join(ROOT, "tools/indexer/target/debug/witness")
LIFT = os.path.join(ROOT, "circuits/lift")
MATCH = os.path.join(ROOT, "circuits/match")
JOIN = os.path.join(ROOT, "circuits/join")
UNSHIELD = os.path.join(ROOT, "circuits/unshield")
CANCEL = os.path.join(ROOT, "circuits/cancel")
# Output dir for proof/pi fixtures (default: this dir = the committed contract-test fixtures).
# Budget scripts override WS4_FX to a temp dir so a live-timestamp run never clobbers the committed
# (expiry=1000/now=100) fixtures the contract tests pin.
FX = os.environ.get("WS4_FX", HERE)
os.makedirs(FX, exist_ok=True)
# Fixed recipient for the unshield scenario (tests/integration.rs uses the SAME address so the
# contract's sha256-derived recipient field matches the proof-bound one). A CONTRACT address (C...)
# so the test SAC transfer needs no classic-account trustline.
UNSHIELD_TO = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM"
# Order expiry + match `now`, overridable for a TESTNET budget run (where the contract bounds both to
# the live ledger clock: place_order needs now <= expiry <= now+7d; settle_match needs now within
# 300s of ledger time). Defaults reproduce the committed contract-test fixtures.
EXP = os.environ.get("WS4_EXP", "1000")
NOW = os.environ.get("WS4_NOW", "100")
PART = "1"
# Proof targets to (re)generate, by proofbase name (e.g. "match", "wmatch", "tk_place"); empty = all.
# Witness MODELING always runs (cheap); only bb proving is gated, so a single target regenerates fast.
TARGETS = set(sys.argv[1:])


def should(name):
    return not TARGETS or name in TARGETS
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


def t3(a, b, c):
    # A length-3 array literal of three (already-quoted scalar or bracketed array) elements.
    return "[" + a + ", " + b + ", " + c + "]"


def prove(dirp, jsonname, proofbase, want_vk=None):
    if not should(proofbase):
        return
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
if should("place"):
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
# owner tags scripts/06 shields the typical scenario under (taker + maker).
open(f"{FX}/tk_note_tag", "wb").write(bytes.fromhex(t_note_tag[2:]))
open(f"{FX}/mk_note_tag", "wb").write(bytes.fromhex(m_note_tag[2:]))


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


# --- Scenario E: cancel (reclaim a resting order) ---
# shield 100 a1, place SELL 100 a1 @want 1500 a2, then cancel it (returns the locked 100 a1).
c_note_tag = one("notetagn 0x81 0x82 0x0"); c_nf_note = one("notenull 0x81 0x82 0x0")
c_out = one("notetag 0x81 0x83"); c_can = one("notetag 0x81 0x84")
c_leaf = one(f"orderleaf 1 100 2 1500 {c_out} {c_can} {EXP} {PART}")
c_ord_nf = one(f"ordernull {c_leaf}")
c_return = one("notetagn 0x81 0x85 0x0")
# Model shield -> place (note path + note-spend witness feed the place proof) -> cancel (order path +
# order-consumption witness feed the cancel proof).
SE = witness("\n".join([
    f"shield 1 100 {c_note_tag}", "root", "path 0",
    f"imtwitness {c_nf_note}", f"nfspent {c_nf_note}",
    f"orderins 1 100 2 1500 {c_out} {c_can} {EXP} {PART}",
    "orderroot", "orderpath 0", f"imtwitness {c_ord_nf}",
]))
c_note_root = scals(SE, "root")[0]
c_order_root = scals(SE, "order_root")[0]
ENI, EI = (imt_get(b) for b in SE.split("# --- IMT insert witness ---")[1:3])
# The place_order proof that rests the order the cancel below reclaims.
open(f"{LIFT}/Prover.toml", "w").write(lift_pt(
    c_note_root, "0x82", "0x81", "0x0", arrs(SE, "path")[0], arrs(SE, "index_bits")[0], ENI,
    c_nf_note, 1, 100, 2, 1500, c_out, c_can, c_leaf))
prove(LIFT, "lift.json", "cancel_place")
cancel_lines = [
    'sk_o = "0x81"', 'rho_ord = "0x84"', 'asset_out = "2"', 'min_out = "1500"',
    f'out_owner_tag = "{c_out}"', f'expiry = "{EXP}"', f'partial_allowed = "{PART}"',
    f'order_path = {arrs(SE, "order_path")[0]}', f'order_index_bits = {arrs(SE, "order_index_bits")[0]}',
    f'low_value = "{EI["lv"]}"', f'low_next_value = "{EI["lnv"]}"', f'low_next_index = "{EI["lni"]}"',
    f'low_path = {EI["lp"]}', f'low_index_bits = {EI["lb"]}',
    f'new_path = {EI["np"]}', f'new_index_bits = {EI["nb"]}',
    'domain = "3"', f'order_root = "{c_order_root}"',
    f'nullifier_root_in = "{EI["rin"]}"', f'nullifier_root_out = "{EI["rout"]}"',
    f'order_nullifier = "{c_ord_nf}"', 'asset_in = "1"', 'amount_in = "100"',
    f'return_owner_tag = "{c_return}"',
]
open(f"{CANCEL}/Prover.toml", "w").write("\n".join(cancel_lines) + "\n")
prove(CANCEL, "cancel.json", "cancel", want_vk="cancel_vk")
# owner tags scripts/06 shields the cancel scenario under.
open(f"{FX}/cancel_note_tag", "wb").write(bytes.fromhex(c_note_tag[2:]))


# --- Scenario F: WORST-CASE settle_match (1 taker x 3 makers + remainder) ---
# taker give 300 a1 want >=4500 a2 (ratio 15). Three makers fully filled:
#   m0,m1: 1600 a2 for 100 a1 each; m2: 800 a2 for 50 a1. taker pays 250 a1, receives 4000 a2,
#   re-rests remainder 50 a1 @ 750 a2 (exact ratio 4500*50 == 750*300). This is the most expensive
#   WS4 tx: one verify, 4 order memberships, 4 sequential IMT inserts, 4 proceeds + 1 re-rest.
WT = {"sk": "0xF0", "rho": "0xF1", "nonce": "0xF2", "out": "0xF3", "can": "0xF4"}
WM = [
    {"sk": "0xA0", "rho": "0xA1", "nonce": "0xA2", "out": "0xA3", "can": "0xA4", "give": 1600, "want": 100},
    {"sk": "0xB0", "rho": "0xB1", "nonce": "0xB2", "out": "0xB3", "can": "0xB4", "give": 1600, "want": 100},
    {"sk": "0xC0", "rho": "0xC1", "nonce": "0xC2", "out": "0xC3", "can": "0xC4", "give": 800, "want": 50},
]
wt_tag = one(f'notetagn {WT["sk"]} {WT["rho"]} {WT["nonce"]}')
wt_nf = one(f'notenull {WT["sk"]} {WT["rho"]} {WT["nonce"]}')
wt_out = one(f'notetag {WT["sk"]} {WT["out"]}'); wt_can = one(f'notetag {WT["sk"]} {WT["can"]}')
wt_leaf = one(f"orderleaf 1 300 2 4500 {wt_out} {wt_can} {EXP} {PART}")
wt_ord_nf = one(f"ordernull {wt_leaf}")
for m in WM:
    m["tag"] = one(f'notetagn {m["sk"]} {m["rho"]} {m["nonce"]}')
    m["nf_note"] = one(f'notenull {m["sk"]} {m["rho"]} {m["nonce"]}')
    m["out_t"] = one(f'notetag {m["sk"]} {m["out"]}'); m["can_t"] = one(f'notetag {m["sk"]} {m["can"]}')
    m["leaf"] = one(f'orderleaf 2 {m["give"]} 1 {m["want"]} {m["out_t"]} {m["can_t"]} {EXP} {PART}')
    m["ord_nf"] = one(f'ordernull {m["leaf"]}')
# Model the full on-chain sequence script 07 reproduces: shield 4 notes, place 4 orders (each
# consumes its note-spend nullifier; the IMT witnesses below feed the 4 place proofs), then the
# match (4 order-consumption witnesses feed the wmatch proof). 8 sequential IMT inserts total.
SF = witness("\n".join(
    [f"shield 1 300 {wt_tag}"] + [f'shield 2 {m["give"]} {m["tag"]}' for m in WM]
    + ["root", "path 0", "path 1", "path 2", "path 3"]
    + [f"imtwitness {wt_nf}", f"nfspent {wt_nf}"]
    + sum([[f'imtwitness {m["nf_note"]}', f'nfspent {m["nf_note"]}'] for m in WM], [])
    + [f"orderins 1 300 2 4500 {wt_out} {wt_can} {EXP} {PART}"]
    + [f'orderins 2 {m["give"]} 1 {m["want"]} {m["out_t"]} {m["can_t"]} {EXP} {PART}' for m in WM]
    + ["orderroot", "orderpath 0", "orderpath 1", "orderpath 2", "orderpath 3"]
    + [f"imtwitness {wt_ord_nf}", f"nfspent {wt_ord_nf}"]
    + [f'imtwitness {m["ord_nf"]}' + ("\nnfspent " + m["ord_nf"] if i < len(WM) - 1 else "")
       for i, m in enumerate(WM)]
))
w_note_root = scals(SF, "root")[0]
w_order_root = scals(SF, "order_root")[0]
wnpaths, wnbits = arrs(SF, "path"), arrs(SF, "index_bits")
wopaths, wobits = arrs(SF, "order_path"), arrs(SF, "order_index_bits")
blocks = [imt_get(b) for b in SF.split("# --- IMT insert witness ---")[1:9]]
NTI, NM = blocks[0], blocks[1:4]  # note-spend witnesses (taker, makers): feed the 4 place proofs
WTI, WM0, WM1, WM2 = blocks[4:8]  # order-consumption witnesses: feed the wmatch proof
mimt = [WM0, WM1, WM2]

# 4 place_order proofs (so script 07 can rest the worst-case book before the match).
open(f"{LIFT}/Prover.toml", "w").write(lift_pt(
    w_note_root, WT["rho"], WT["sk"], WT["nonce"], wnpaths[0], wnbits[0], NTI,
    wt_nf, 1, 300, 2, 4500, wt_out, wt_can, wt_leaf))
prove(LIFT, "lift.json", "wt_place")
for i, m in enumerate(WM):
    open(f"{LIFT}/Prover.toml", "w").write(lift_pt(
        w_note_root, m["rho"], m["sk"], m["nonce"], wnpaths[i + 1], wnbits[i + 1], NM[i],
        m["nf_note"], 2, m["give"], 1, m["want"], m["out_t"], m["can_t"], m["leaf"]))
    prove(LIFT, "lift.json", f"wm{i}_place")
# proceeds tags (per-note nonce compress(taker_leaf, slot)).
wp0 = one(f"compress {wt_out} {one(f'compress {wt_leaf} 0')}")
wp = [one(f'compress {m["out_t"]} {one(f"compress {wt_leaf} {i + 1}")}') for i, m in enumerate(WM)]
rem_leaf = one(f"orderleaf 1 50 2 750 {wt_out} {wt_can} {EXP} {PART}")
wmatch_lines = [
    't_asset_in = "1"', 't_amount_in = "300"', 't_asset_out = "2"', 't_min_out = "4500"',
    f't_out_tag = "{wt_out}"', f't_cancel_tag = "{wt_can}"', f't_expiry = "{EXP}"', f't_partial = "{PART}"',
    f't_path = {wopaths[0]}', f't_index_bits = {wobits[0]}',
    f't_low_value = "{WTI["lv"]}"', f't_low_next_value = "{WTI["lnv"]}"', f't_low_next_index = "{WTI["lni"]}"',
    f't_low_path = {WTI["lp"]}', f't_low_index_bits = {WTI["lb"]}',
    f't_new_path = {WTI["np"]}', f't_new_index_bits = {WTI["nb"]}',
    f'm_asset_in = {t3("2", "2", "2")}',
    f'm_amount_in = {t3(*[str(m["give"]) for m in WM])}',
    f'm_asset_out = {t3("1", "1", "1")}',
    f'm_min_out = {t3(*[str(m["want"]) for m in WM])}',
    f'm_out_tag = {t3(*[chr(34) + m["out_t"] + chr(34) for m in WM])}',
    f'm_cancel_tag = {t3(*[chr(34) + m["can_t"] + chr(34) for m in WM])}',
    f'm_expiry = {t3(*[chr(34) + EXP + chr(34)] * 3)}',
    f'm_partial = {t3(*[chr(34) + PART + chr(34)] * 3)}',
    f'm_path = {t3(wopaths[1], wopaths[2], wopaths[3])}',
    f'm_index_bits = {t3(wobits[1], wobits[2], wobits[3])}',
    f'm_low_value = {t3(*[chr(34) + I["lv"] + chr(34) for I in mimt])}',
    f'm_low_next_value = {t3(*[chr(34) + I["lnv"] + chr(34) for I in mimt])}',
    f'm_low_next_index = {t3(*[chr(34) + I["lni"] + chr(34) for I in mimt])}',
    f'm_low_path = {t3(*[I["lp"] for I in mimt])}',
    f'm_low_index_bits = {t3(*[I["lb"] for I in mimt])}',
    f'm_new_path = {t3(*[I["np"] for I in mimt])}',
    f'm_new_index_bits = {t3(*[I["nb"] for I in mimt])}',
    'domain = "5"', f'order_root = "{w_order_root}"',
    f'nullifier_root_in = "{WTI["rin"]}"', f'nullifier_root_out = "{WM2["rout"]}"', f'now = "{NOW}"',
    f'nf_taker = "{wt_ord_nf}"',
    f'nf_maker0 = "{WM[0]["ord_nf"]}"', f'nf_maker1 = "{WM[1]["ord_nf"]}"', f'nf_maker2 = "{WM[2]["ord_nf"]}"',
    'p0_live = "1"', 'p0_asset = "2"', 'p0_amount = "4000"', f'p0_tag = "{wp0}"',
    'p1_live = "1"', 'p1_asset = "1"', f'p1_amount = "{WM[0]["want"]}"', f'p1_tag = "{wp[0]}"',
    'p2_live = "1"', 'p2_asset = "1"', f'p2_amount = "{WM[1]["want"]}"', f'p2_tag = "{wp[1]}"',
    'p3_live = "1"', 'p3_asset = "1"', f'p3_amount = "{WM[2]["want"]}"', f'p3_tag = "{wp[2]}"',
    'remainder_live = "1"', 'rem_asset_in = "1"', 'rem_amount_in = "50"', 'rem_asset_out = "2"',
    'rem_min_out = "750"', f'rem_output_owner_tag = "{wt_out}"', f'rem_cancel_owner_tag = "{wt_can}"',
    f'rem_expiry = "{EXP}"', f'rem_partial_allowed = "{PART}"', f'remainder_order_leaf = "{rem_leaf}"',
]
open(f"{MATCH}/Prover.toml", "w").write("\n".join(wmatch_lines) + "\n")
prove(MATCH, "matching.json", "wmatch")
# owner tags scripts/07 shields the worst-case scenario under (taker + 3 makers).
open(f"{FX}/wmatch_t_tag", "wb").write(bytes.fromhex(wt_tag[2:]))
for i, m in enumerate(WM):
    open(f"{FX}/wmatch_m{i}_tag", "wb").write(bytes.fromhex(m["tag"][2:]))

print("regenerated WS4 fixtures in", FX)
