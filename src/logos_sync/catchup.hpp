#pragma once
// logos_sync/catchup.hpp — the catch-up (backfill) protocol, v2: recursive
// Range-Based Set Reconciliation over the wire.
//
// WHY v2. SDS Reliable Channels heal *live* drops but do not reconstruct history
// for a cold-start / long-offline peer, and liblogosdelivery has no Store on
// desktop (logos-transport ADR 0009). So backfill is the app's job. v1 shipped the
// requester's WHOLE id-list in one message — which segments for any non-trivial
// log, and this delivery module fails to encrypt multi-segment channel sends. v2
// fixes that at the root: every message is a *bounded* handful of fingerprints or
// ids, so it is always a single segment, AND the transfer is the id-EXACT delta
// (docs/adr/0003, docs/adr/0004).
//
// THE PROTOCOL. Peers exchange range statements over the sorted id-set; a range
// whose fingerprints agree is done, a large disagreeing range is split into
// sub-ranges (more fingerprints), a small one drops to an exact id list. From an
// id list a peer learns precisely which events to serve and which to pull.
//
//   message "fp"   { t, from, lo, hi, bounds:[id…], fps:[hex…] }
//       range (lo,hi] split by `bounds` into fps.length sub-ranges, a fingerprint
//       each. lo/hi absent = ±infinity. buildInitial() sends one of these over
//       the whole range.
//   message "ids"  { t, from, lo, hi, ids:[id…] }
//       "my exact ids in (lo,hi]" — the base case for a small disagreeing range.
//   message "need" { t, from, ids:[id…] }
//       "serve me exactly these events."
//
// respond(myEvents, msg) is a PURE step of the state machine: given an incoming
// message and my set, it returns the reply messages to publish and the events to
// serve. The app publishes them (sealed, over logos-transport), rate-limited, and
// ignores messages whose `from` is itself. Convergence: fingerprint agreements
// drop ranges, splits shrink them, id/need exchanges transfer the exact missing
// events — the symmetric difference strictly shrinks each round, so it terminates.
//
// Ordering is by id alone (a valid total order — ids are unique), which keeps the
// range bounds to one id each. The fingerprint is order-independent (XOR of
// SHA-256(id)), reused from reconcile.hpp; parity with src/catchup.ts is pinned by
// the golden vectors (docs/adr/0005).
#include "event.hpp"
#include "reconcile.hpp"   // rbsr::fingerprint (SHA-256 XOR), rbsr::Item
#include <set>
#include <map>

namespace logos_sync {
namespace catchup {

// ── helpers: id-ordered items + range fingerprint ─────────────────────────────
inline std::vector<std::string> sortedIds(const std::vector<Event>& evs) {
    std::vector<std::string> ids;
    ids.reserve(evs.size());
    for (const auto& e : evs) if (!e.id.empty()) ids.push_back(e.id);
    std::sort(ids.begin(), ids.end());
    return ids;
}

// ids in the half-open range (lo, hi] by string order; empty bound = ±infinity.
inline std::vector<std::string> idsInRange(const std::vector<std::string>& ids,
                                           const std::string& lo, bool hasLo,
                                           const std::string& hi, bool hasHi) {
    std::vector<std::string> out;
    for (const auto& id : ids) {
        if (hasLo && !(id > lo)) continue;   // id must be > lo
        if (hasHi && !(id <= hi)) continue;  // id must be <= hi
        out.push_back(id);
    }
    return out;
}

inline std::string fpOf(const std::vector<std::string>& ids) {
    std::vector<rbsr::Item> items;
    items.reserve(ids.size());
    for (const auto& id : ids) items.push_back(rbsr::Item{0, id});
    return rbsr::fingerprint(items);
}

// Build an "fp" message: split `ids` (already the subset in (lo,hi]) into `buckets`
// sub-ranges by id order, one fingerprint each. Bounds are the interior split ids.
inline json buildFp(const std::string& from, const std::vector<std::string>& ids,
                    const std::string& lo, bool hasLo, const std::string& hi, bool hasHi,
                    int buckets) {
    json msg{{"v", 2}, {"t", "fp"}, {"from", from}};
    if (hasLo) msg["lo"] = lo;
    if (hasHi) msg["hi"] = hi;
    json bounds = json::array(), fps = json::array();
    int n = (int)ids.size();
    int k = std::max(1, std::min(buckets, n == 0 ? 1 : n));
    int step = (n + k - 1) / std::max(1, k);
    if (step < 1) step = 1;
    std::string subLo = lo; bool subHasLo = hasLo;
    for (int i = 0; i < n || (n == 0 && i == 0); i += step) {
        int end = std::min(n, i + step);
        bool last = (end >= n);
        std::string subHi = last ? hi : ids[end - 1];
        bool subHasHi = last ? hasHi : true;
        std::vector<std::string> sub(ids.begin() + std::min(i, n), ids.begin() + end);
        fps.push_back(fpOf(sub));
        if (!last) bounds.push_back(subHi);   // interior boundary
        subLo = subHi; subHasLo = subHasHi;
        if (n == 0) break;
    }
    msg["bounds"] = bounds;
    msg["fps"] = fps;
    return msg;
}

// The initial message a joining/reconnecting peer publishes (fp over the whole
// range). `from` is the peer's device id, used by respond() for self-ignore.
inline json buildInitial(const std::vector<Event>& myEvents, const std::string& from, int buckets = 8) {
    return buildFp(from, sortedIds(myEvents), "", false, "", false, buckets);
}

struct Step {
    std::vector<json> replies;    // ranges/need messages to publish (each single-segment)
    std::vector<Event> serve;     // events to publish (the peer lacks these)
};

// Pure state-machine step: process one incoming message against my set.
inline Step respond(const std::vector<Event>& myEvents, const json& msg,
                    const std::string& me, int threshold = 8, int buckets = 8) {
    Step step;
    if (!msg.is_object()) return step;
    if (msg.value("from", std::string()) == me) return step;   // ignore our own echo
    const std::string t = msg.value("t", std::string());

    std::map<std::string, const Event*> byId;
    for (const auto& e : myEvents) byId[e.id] = &e;
    std::vector<std::string> mine = sortedIds(myEvents);

    if (t == "fp") {
        bool hasLo = msg.contains("lo"), hasHi = msg.contains("hi");
        std::string lo = hasLo ? msg.value("lo", std::string()) : std::string();
        std::string hi = hasHi ? msg.value("hi", std::string()) : std::string();
        const auto& bounds = msg["bounds"];
        const auto& fps = msg["fps"];
        int k = (int)fps.size();
        for (int i = 0; i < k; i++) {
            std::string subLo = (i == 0) ? lo : bounds[i - 1].get<std::string>();
            bool subHasLo = (i == 0) ? hasLo : true;
            std::string subHi = (i == k - 1) ? hi : bounds[i].get<std::string>();
            bool subHasHi = (i == k - 1) ? hasHi : true;
            auto myItems = idsInRange(mine, subLo, subHasLo, subHi, subHasHi);
            if (fpOf(myItems) == fps[i].get<std::string>()) continue;   // range agrees
            if ((int)myItems.size() <= threshold) {
                json m{{"v", 2}, {"t", "ids"}, {"from", me}};
                if (subHasLo) m["lo"] = subLo;
                if (subHasHi) m["hi"] = subHi;
                m["ids"] = myItems;
                step.replies.push_back(m);
            } else {
                step.replies.push_back(buildFp(me, myItems, subLo, subHasLo, subHi, subHasHi, buckets));
            }
        }
    } else if (t == "ids") {
        bool hasLo = msg.contains("lo"), hasHi = msg.contains("hi");
        std::string lo = hasLo ? msg.value("lo", std::string()) : std::string();
        std::string hi = hasHi ? msg.value("hi", std::string()) : std::string();
        std::set<std::string> peer;
        for (const auto& x : msg["ids"]) peer.insert(x.get<std::string>());
        auto myItems = idsInRange(mine, lo, hasLo, hi, hasHi);
        std::set<std::string> mineSet(myItems.begin(), myItems.end());
        // serve events the peer lacks
        for (const auto& id : myItems)
            if (!peer.count(id)) { auto it = byId.find(id); if (it != byId.end()) step.serve.push_back(*it->second); }
        // pull events I lack
        json need = json::array();
        for (const auto& id : peer) if (!mineSet.count(id)) need.push_back(id);
        if (!need.empty()) step.replies.push_back(json{{"v", 2}, {"t", "need"}, {"from", me}, {"ids", need}});
    } else if (t == "need") {
        for (const auto& x : msg["ids"]) {
            std::string id = x.get<std::string>();
            auto it = byId.find(id);
            if (it != byId.end()) step.serve.push_back(*it->second);
        }
    }
    return step;
}

} // namespace catchup
} // namespace logos_sync
