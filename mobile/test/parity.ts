// JS side of the parity test — folds the shared fixtures with the mobile engine
// (../src/lib/engine.ts) and, separately, proves the CRDT convergence properties.
// stdout = the folded calendar JSON (compared against the C++ engine).
// stderr  = the convergence report (idempotent + order-independent).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { foldCalendar, mergeEvents, eventFromJson, type Event } from "../src/lib/engine.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fx = JSON.parse(readFileSync(join(here, "fixtures.json"), "utf8"));
const calId: string = fx.calId;
const log: Event[] = fx.log.map(eventFromJson);

// 1) Golden fold → stdout (diffed against the C++ engine's dump).
const folded = foldCalendar(calId, log);
process.stdout.write(JSON.stringify(folded) + "\n");

// 2) Convergence: fold many shuffled + duplicated arrival orders; every result
//    must be byte-identical. Deterministic shuffle (seeded) so the test is stable.
function seeded(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0xffffffff);
}
function normalize(o: unknown): string {
  return JSON.stringify(o, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, (v as any)[k]]))
      : v,
  );
}
const gold = normalize(folded);
let trials = 0;
let fails = 0;
const rnd = seeded(42);
for (let t = 0; t < 300; t++) {
  const shuffled = [...log];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  // Inject duplicate redeliveries — merge must be idempotent.
  const withDups = [...shuffled, shuffled[t % shuffled.length], shuffled[(t * 3) % shuffled.length]];
  const got = normalize(foldCalendar(calId, mergeEvents(withDups)));
  trials++;
  if (got !== gold) {
    fails++;
    if (fails <= 2) process.stderr.write(`  DIVERGED on trial ${t}\n    want ${gold}\n    got  ${got}\n`);
  }
}
process.stderr.write(`convergence: ${trials - fails}/${trials} shuffled+duplicated orders identical\n`);
process.exit(fails === 0 ? 0 : 1);
