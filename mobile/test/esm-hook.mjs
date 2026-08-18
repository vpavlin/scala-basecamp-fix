// node --import ./register.mjs : resolve extensionless relative TS imports (./x → ./x.ts) and
// redirect the Expo modules to the node stub, so the real mobile engine loads under node.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
const STUB = new URL("./expo-stub.mjs", import.meta.url).href;
const EXPO = new Set(["expo-secure-store", "expo-crypto"]);
export async function resolve(spec, ctx, next) {
  if (EXPO.has(spec)) return { url: STUB, shortCircuit: true };
  if ((spec.startsWith("./") || spec.startsWith("../")) && !/\.[a-z]+$/i.test(spec)) {
    const cand = new URL(spec + ".ts", ctx.parentURL);
    if (existsSync(fileURLToPath(cand))) return next(spec + ".ts", ctx);
  }
  return next(spec, ctx);
}
