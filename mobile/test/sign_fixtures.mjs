// Signs the (unsigned) fixtures.src.json with deterministic per-author test keys → fixtures.json.
// The fold now requires signatures (always-verify), so fixtures must be signed to exercise it.
// Uses the REAL mobile signer (identity.ts) — the C++ engine verifies the same sigs.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { signEvent, identityFromPriv, fromHex } from "../src/lib/identity.ts";

const here = dirname(fileURLToPath(import.meta.url));
const src = JSON.parse(readFileSync(join(here, "fixtures.src.json"), "utf8"));
const PRIV = { A: "01", B: "02", C: "03" };            // small valid secp256k1 scalars
const idOf = {};
for (const n of Object.keys(PRIV)) idOf[n] = identityFromPriv(fromHex("00".repeat(31) + PRIV[n]));
const addr = (n) => (idOf[n] ? idOf[n].address : n);
for (const e of src.log) {
  if (e.type === "member.set" && e.payload && idOf[e.payload.member]) e.payload.member = addr(e.payload.member);
  const author = e.dev;                                 // symbolic (A/B/C)
  if (!idOf[author]) throw new Error("no test key for author " + author);
  signEvent(idOf[author], e);                           // sets e.dev/e.hlc.dev=address, e.pub, e.sig
}
writeFileSync(join(here, "fixtures.json"), JSON.stringify(src, null, 2) + "\n");
console.error(`signed ${src.log.length} fixture events (A=${addr("A").slice(0,10)}…)`);
