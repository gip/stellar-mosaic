import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openMosaicStore } from "../dist/store.js";

test("sqlite MCP store persists desks, sponsor custody, and sessions across reopen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mosaic-mcp-store-"));
  const url = `sqlite://${join(dir, "mcp.db")}`;
  const first = openMosaicStore(url);
  const desk = {
    id: "desk-1",
    name: "Desk 1",
    contract_id: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    sponsor_pubkey: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    event_start_ledger: 123,
    assets: [],
    pairs: [],
    base_deployment: null,
  };
  await first.insertDesk(desk, "SA_SPONSOR_SECRET");
  const created = await first.createSession("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", "testnet");

  const reopened = openMosaicStore(url);
  assert.equal((await reopened.getDesk("desk-1")).contract_id, desk.contract_id);
  assert.equal(await reopened.sponsorSecret("desk-1"), "SA_SPONSOR_SECRET");
  assert.equal((await reopened.getSession(created.token))?.address, desk.sponsor_pubkey);
});
