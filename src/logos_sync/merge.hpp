#pragma once
// logos_sync/merge.hpp — the CRDT merge: union event logs by id, order by HLC.
//
// This is the whole conflict-resolution story. Merge = union-by-id, so no
// concurrent write is ever overwritten; the HLC sort then gives a total order
// identical on every replica. The operation is idempotent (redelivery is a no-op),
// commutative and associative (arrival order is irrelevant) — which is exactly
// what lets offline devices converge with no lost writes (docs/adr/0001).
//
// The app's fold consumes the ORDERED output; edits/deletes/LWW/tombstones are all
// expressed as events the fold interprets, never as mutations here.
//
// Parity: src/merge.ts.
#include "event.hpp"

namespace logos_sync {

// Union by id (first occurrence of an id wins — ids are unique, so this only
// matters for exact-duplicate redelivery), then sort by HLC. Pure; no I/O.
inline std::vector<Event> mergeEvents(const std::vector<Event>& a,
                                      const std::vector<Event>& b = {}) {
    std::map<std::string, Event> byId;
    for (const auto& e : a) if (!e.id.empty()) byId.emplace(e.id, e);
    for (const auto& e : b) if (!e.id.empty()) byId.emplace(e.id, e);
    std::vector<Event> out;
    out.reserve(byId.size());
    for (auto& kv : byId) out.push_back(kv.second);
    std::sort(out.begin(), out.end(),
              [](const Event& x, const Event& y) { return compareHlc(x.hlc, y.hlc) < 0; });
    return out;
}

// Merge one event into an existing (already-merged) log in place. Returns true if
// the event was NEW (so the caller can skip re-persisting / re-broadcasting a
// duplicate). Keeps the log HLC-ordered.
inline bool mergeOne(std::vector<Event>& log, const Event& e) {
    if (e.id.empty()) return false;
    for (const auto& x : log) if (x.id == e.id) return false;  // dedup by id
    // Insert keeping HLC order (logs are small per channel; linear insert is fine).
    auto pos = std::upper_bound(log.begin(), log.end(), e,
                                [](const Event& x, const Event& y) { return compareHlc(x.hlc, y.hlc) < 0; });
    log.insert(pos, e);
    return true;
}

} // namespace logos_sync
