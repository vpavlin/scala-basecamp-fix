#!/usr/bin/env bash
# Crypto-derivation parity: the mobile AES key derivation (src/lib/crypto-derive.ts)
# MUST match the desktop core's C sscanf("%2hhx") byte-for-byte, or every message
# fails to decrypt cross-platform. Diffs the mobile derivation against real C over a
# set of dashed-UUID keys (the load-bearing case: windows starting on a dash parse
# as SIGNED negatives, e.g. "-a" → 0xf6, not 0).
set -euo pipefail
cd "$(dirname "$0")"

# Keys chosen so dashes land at different 2-char window offsets (even vs odd).
KEYS='3190cb26-10e8-4dfa-a8f6-20decd5c0931f5bd9779-2e14-44c7-ae29-b9cd1cd2400d
00000000-0000-4000-8000-000000000000ffffffff-ffff-4fff-bfff-ffffffffffff
deadbeef-dead-4bee-8dad-beefdeadbeefcafebabe-cafe-4bab-8abe-cafebabecafe
a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d6e7f8a9b-0c1d-4e2f-3a4b-5c6d7e8f9a0b'

echo "== deriving keys with real C (desktop ground truth) =="
gcc -std=c11 -O2 crypto_kd.c -o crypto_kd
CPP_OUT=$(printf '%s\n' "$KEYS" | ./crypto_kd)

echo "== deriving keys with the mobile module (crypto-derive.ts) =="
JS_OUT=$(printf '%s\n' "$KEYS" | node --experimental-strip-types test/../test/crypto-derive.test.ts 2>/dev/null || printf '%s\n' "$KEYS" | node --experimental-strip-types crypto-derive.test.ts)

echo ""
paste -d'\n' <(printf 'C : %s\n' $CPP_OUT) <(printf 'JS: %s\n' $JS_OUT) | sed 'N;s/\n/  /' || true
echo ""
if [[ "$CPP_OUT" == "$JS_OUT" ]]; then
  echo "CRYPTO PARITY OK — mobile derives the same AES key as the desktop for every vector."
else
  echo "CRYPTO PARITY FAIL — derivations diverge:"
  diff <(printf '%s\n' "$CPP_OUT") <(printf '%s\n' "$JS_OUT") || true
  exit 1
fi
