#!/usr/bin/env bash
# Seed the Scala hub's registry from an invite link, so the hub joins that
# calendar's channel and ingests its events.
#
#   scala-hub-seed.sh 'scala://join?id=<calId>&key=<b64url(encryptionKey)>&name=<name>'
#
# The invite `key` is the encryptionKey string base64URL-encoded (URL-safe, no
# padding) — the SAME format the desktop parseShareLink decodes — so we decode it
# back to the raw dashed-UUID encryptionKey before writing it to calendars.json.
set -euo pipefail
INVITE="${1:-}"
[[ -n "$INVITE" ]] || { echo "usage: $0 'scala://join?id=..&key=..&name=..'"; exit 1; }
DATA="${SCALA_CORE_DATA:-$HOME/.scala-core-hub}"
mkdir -p "$DATA"

python3 - "$INVITE" "$DATA/calendars.json" <<'PY'
import sys, json, os, base64
from urllib.parse import parse_qs, unquote

invite, path = sys.argv[1], sys.argv[2]
q = invite.split("?", 1)[1] if "?" in invite else ""
p = {k: v[0] for k, v in parse_qs(q, keep_blank_values=True).items()}
cid = p.get("id", "")
key_b64 = p.get("key", "")
name = unquote(p.get("name", "") or "Shared calendar")
if not cid or not key_b64:
    sys.exit("invite missing id or key")

# base64url decode (restore padding) → raw encryptionKey string (dashed UUIDs)
b = key_b64.replace("-", "+").replace("_", "/")
b += "=" * (-len(b) % 4)
key = base64.b64decode(b).decode("utf-8")

reg = []
if os.path.exists(path):
    try:
        reg = json.load(open(path))
    except Exception:
        reg = []
reg = [c for c in reg if c.get("id") != cid]  # replace if already present
reg.append({"id": cid, "key": key, "name": name, "color": ""})
json.dump(reg, open(path, "w"))
print(f"seeded calendar '{name}' id={cid[:8]}… key.len={len(key)} → {path} ({len(reg)} total)")
PY
echo "Now (re)start the hub: systemctl --user restart scala-hub  (or run hub/scala-hub.sh)"
