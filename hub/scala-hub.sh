#!/usr/bin/env bash
# Reliable Scala headless-hub launcher.
#
# Starts the logoscore daemon with the Scala modules (scala core + delivery_module)
# and loads `scala`. Scala's core pins the logos.test fleet entry nodes + SDS
# channels internally (src/scala_impl.cpp onContextReady), and brings the node up
# eagerly on context-ready (m_sync->bootstrap()) — so unlike the KYM hub it needs
# NO self-drive tick. It subscribes every calendar in its data dir's registry and
# ingests all their events, giving an always-on peer so a phone and a Basecamp that
# are never online at the same moment still converge (SDS reconciles late joiners).
#
# SEED FIRST: the hub only joins calendars present in its registry. Add the shared
# calendar's id+key to $SCALA_CORE_DATA/calendars.json before starting (use
# scala-hub-seed.sh with an invite link), then (re)start this unit.
#
# Overridable via env:
#   LOGOSCORE          path to the logoscore binary
#   SCALA_MODULES_DIR  module search dir (contains scala + delivery_module)
#   SCALA_CORE_DATA    scala core persistence dir (the durable calendar logs)
#   SCALA_DEVICE_ID    author id stamped by the hub (SDS senderId)
set -euo pipefail

LOGOSCORE="${LOGOSCORE:-$HOME/logoscore-new/result/bin/logoscore}"
SCALA_MODULES_DIR="${SCALA_MODULES_DIR:-$HOME/scala-hub/lmods}"
# ISOLATE the daemon: logoscore is ONE global daemon per config dir (socket+token
# live here). Without this, scala shares ~/.logoscore with the kym hub and the two
# clobber each other's single daemon. A dedicated dir gives scala its own daemon,
# coexisting with kym-hub (default dir) and the qaku hub (~/.logoscore-qaku) — the
# proven multi-hub pattern. Its own waku node binds an OS-assigned port, so no clash.
export LOGOSCORE_CONFIG_DIR="${LOGOSCORE_CONFIG_DIR:-$HOME/.logoscore-scala}"
export SCALA_CORE_DATA="${SCALA_CORE_DATA:-$HOME/.scala-core-hub}"
export SCALA_DEVICE_ID="${SCALA_DEVICE_ID:-scala-hub}"
# Cross-thread receive: delivery emits messageReceived off the FFI callback thread;
# marshal it onto the host event-loop thread or QRO silently drops it and the hub
# ingests nothing. Same fix the kym hub uses.
export EMIT_FROM_THREAD="${EMIT_FROM_THREAD:-1}"
export QT_QPA_PLATFORM=offscreen

log() { echo "[scala-hub $(date -u +%H:%M:%SZ)] $*"; }

[[ -x "$LOGOSCORE" ]] || { log "ERROR: logoscore not executable at: $LOGOSCORE"; exit 1; }
[[ -d "$SCALA_MODULES_DIR" ]] || { log "ERROR: modules dir not found: $SCALA_MODULES_DIR"; exit 1; }
mkdir -p "$SCALA_CORE_DATA"

# Tear down any stale daemon so `-D` doesn't fail on "already running".
"$LOGOSCORE" stop >/dev/null 2>&1 || true
sleep 1

log "starting logoscore daemon (modules: $SCALA_MODULES_DIR, data: $SCALA_CORE_DATA)"
# `-D` runs a foreground daemon SUPERVISOR (it does NOT detach). Background it so the
# launcher can drive the daemon by RPC (status/load-module); $DAEMON_PID is the
# supervisor, alive for the daemon's lifetime, so `wait` at the end blocks correctly.
# (The single-global-daemon-per-config-dir is why LOGOSCORE_CONFIG_DIR isolation
# above is load-bearing: without it, kym-hub's daemon and this one clobber each other
# and each restart-loops.)
"$LOGOSCORE" -D -m "$SCALA_MODULES_DIR" &
DAEMON_PID=$!
cleanup() { log "stopping daemon"; "$LOGOSCORE" stop >/dev/null 2>&1 || kill "$DAEMON_PID" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

for _ in $(seq 1 60); do
  "$LOGOSCORE" status >/dev/null 2>&1 && break
  kill -0 "$DAEMON_PID" 2>/dev/null || { log "daemon exited during startup"; exit 1; }
  sleep 1
done
log "daemon up; loading scala"
"$LOGOSCORE" load-module scala || log "load-module scala returned nonzero (likely already loaded)"

CALS=$(python3 -c "import json,sys;print(len(json.load(open('$SCALA_CORE_DATA/calendars.json'))))" 2>/dev/null || echo 0)
log "hub running — scala loaded, $CALS calendar(s) in registry, delivery pinned to logos.test."
[[ "$CALS" == 0 ]] && log "NOTE: registry empty — seed a calendar (scala-hub-seed.sh <invite>) then restart, or the hub joins no channels."

# Stay foreground for the daemon supervisor's lifetime so systemd tracks liveness
# and restarts us if it dies.
wait "$DAEMON_PID"
