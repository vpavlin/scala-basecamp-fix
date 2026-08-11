#!/usr/bin/env bash
# End-to-end interop: seal a message with the MOBILE crypto + double-base64 send
# framing, then open it with the DESKTOP code path (open() + double-depth peel).
# Guards the two cross-platform gremlins at once — the AES key derivation and the
# base64 layer count — that made phone<->desktop sync silently fail.
set -euo pipefail
cd "$(dirname "$0")/.."
gcc -std=c11 test/interop_open.c -o /tmp/scala_interop_open -lssl -lcrypto
KEY="3190cb26-10e8-4dfa-a8f6-20decd5c0931f5bd9779-2e14-44c7-ae29-b9cd1cd2400d"
for PLAIN in '{"v":1,"type":"EVENT","hello":"from the phone"}' 'x' 'a longer payload with, commas and "quotes" and unicode ☕'; do
  OUT=$(node --experimental-strip-types test/interop_seal.mjs "$KEY" "$PLAIN" 2>/dev/null | /tmp/scala_interop_open)
  if [[ "$OUT" == "$PLAIN" ]]; then echo "  ok: $PLAIN"; else echo "  FAIL: got [$OUT] want [$PLAIN]"; exit 1; fi
done
echo "INTEROP OK — mobile-sealed messages open on the desktop (crypto + double-b64)."
