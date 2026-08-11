#!/usr/bin/env bash
# Golden-vector parity test: the JS mobile engine (src/lib/engine.ts) and the C++
# desktop engine (src/scala_engine.hpp) MUST fold the same event log to the same
# calendar state — else desktop and phone diverge on the same channel.
set -euo pipefail
cd "$(dirname "$0")"

NLOHMANN=$(find /nix/store -maxdepth 5 -name json.hpp -path '*nlohmann*' 2>/dev/null | head -1)
NLOHMANN_INC=$(dirname "$(dirname "$NLOHMANN")")   # .../include so #include <nlohmann/json.hpp> resolves

echo "== compiling C++ engine harness =="
g++ -std=c++17 -I"$NLOHMANN_INC" fold_cpp.cpp -o fold_cpp

echo "== folding fixtures (C++ desktop engine) =="
CPP_OUT=$(./fold_cpp < fixtures.json)

echo "== folding fixtures (JS mobile engine) + convergence =="
JS_OUT=$(node --experimental-strip-types parity.ts)

# Deep-sort object keys on both so we compare structure, not key order.
norm() { node --input-type=module -e '
  let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
    const sort=o=>o&&typeof o==="object"&&!Array.isArray(o)
      ? Object.fromEntries(Object.keys(o).sort().map(k=>[k,sort(o[k])]))
      : Array.isArray(o)?o.map(sort):o;
    process.stdout.write(JSON.stringify(sort(JSON.parse(s))));
  });'; }

CPP_N=$(printf '%s' "$CPP_OUT" | norm)
JS_N=$(printf '%s' "$JS_OUT" | norm)

echo ""
echo "C++ : $CPP_N"
echo "JS  : $JS_N"
echo ""
if [[ "$CPP_N" == "$JS_N" ]]; then
  echo "PARITY OK — desktop and mobile engines fold identically."
else
  echo "PARITY FAIL — engines diverge:"
  diff <(printf '%s\n' "$CPP_N") <(printf '%s\n' "$JS_N") || true
  exit 1
fi
