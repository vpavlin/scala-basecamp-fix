#pragma once
// logos_sync/event.hpp — the immutable event envelope + hybrid logical clock.
//
// This is the ONE unit every logos-sync app agrees on. An app's data is never
// stored as mutable rows; every change is an append-only Event, and current state
// is a pure fold over the merged log (the fold itself is the app's job — see
// docs/adr/0001). Because the envelope is identical across apps, a calendar event,
// a Q&A upvote and a budget delta all reconcile with the exact same machinery.
//
// Parity: the TypeScript mirror is src/event.ts. The JSON shape here is the wire
// contract — keep the two byte-identical (docs/adr/0005, docs/PARITY.md).
#include <string>
#include <vector>
#include <map>
#include <algorithm>
#include <nlohmann/json.hpp>

namespace logos_sync {
using json = nlohmann::json;

// ── HLC: hybrid logical clock. Total order is wall → ctr → dev. ───────────────
// wall is a millisecond timestamp used FOR ORDERING ONLY — never for quantities
// or money (a lagging clock must never change an amount). ctr breaks same-wall
// ties causally; dev (the author's stable device id) breaks the remaining ties so
// the order is total and identical on every replica.
struct HLC {
    long long wall = 0;
    long long ctr = 0;
    std::string dev;
};

inline int compareHlc(const HLC& a, const HLC& b) {
    if (a.wall != b.wall) return a.wall < b.wall ? -1 : 1;
    if (a.ctr  != b.ctr)  return a.ctr  < b.ctr  ? -1 : 1;
    if (a.dev  != b.dev)  return a.dev  < b.dev  ? -1 : 1;
    return 0;
}

// ── Event: the immutable unit. `id` (a UUIDv4) is the idempotency/dedup key, so
// redelivering an event is always a no-op. `type` + `payload` are the app's; the
// engine never looks inside `payload`. ──────────────────────────────────────────
struct Event {
    int v = 1;
    std::string id;
    std::string type;
    HLC hlc;
    std::string dev;       // author device id (== hlc.dev; kept for convenience)
    json payload;
    // Optional authenticity layer (scala_identity): pub = author's 33B secp256k1 public
    // key (hex), sig = 64B ECDSA over the canonical event. Empty on legacy/unsigned events.
    std::string pub;
    std::string sig;
};

inline json eventToJson(const Event& e) {
    json j{
        {"v", e.v}, {"id", e.id}, {"type", e.type},
        {"hlc", {{"wall", e.hlc.wall}, {"ctr", e.hlc.ctr}, {"dev", e.hlc.dev}}},
        {"dev", e.dev}, {"payload", e.payload}};
    if (!e.pub.empty()) j["pub"] = e.pub;
    if (!e.sig.empty()) j["sig"] = e.sig;
    return j;
}

inline Event eventFromJson(const json& j) {
    Event e;
    e.v    = j.value("v", 1);
    e.id   = j.value("id", std::string());
    e.type = j.value("type", std::string());
    if (j.contains("hlc") && j["hlc"].is_object()) {
        e.hlc.wall = j["hlc"].value("wall", 0LL);
        e.hlc.ctr  = j["hlc"].value("ctr", 0LL);
        e.hlc.dev  = j["hlc"].value("dev", std::string());
    }
    e.dev     = j.value("dev", std::string());
    e.payload = j.contains("payload") ? j["payload"] : json::object();
    e.pub     = j.value("pub", std::string());
    e.sig     = j.value("sig", std::string());
    return e;
}

// ── Clock: stamps locally-authored events and advances past ingested ones.
// Call receive() for EVERY event you ingest, and prime the clock from your whole
// log on load — otherwise a device can author events that sort before a cause it
// has already seen (docs/adr/0002). ──────────────────────────────────────────────
class Clock {
public:
    explicit Clock(std::string dev) : m_dev(std::move(dev)) {}

    // Stamp a new local event: monotonic wall, ctr increments within the same ms.
    HLC send(long long nowMs) {
        if (nowMs > m_wall) { m_wall = nowMs; m_ctr = 0; }
        else                { m_ctr += 1; }
        return HLC{m_wall, m_ctr, m_dev};
    }

    // Advance past an event we ingested so our next send() sorts after its cause.
    void receive(const HLC& h) {
        if (h.wall > m_wall)      { m_wall = h.wall; m_ctr = h.ctr; }
        else if (h.wall == m_wall) { m_ctr = std::max(m_ctr, h.ctr); }
    }

private:
    std::string m_dev;
    long long m_wall = 0;
    long long m_ctr = 0;
};

} // namespace logos_sync
