#pragma once
// logos_sync/reconcile.hpp — Range-Based Set Reconciliation over the event-id set.
//
// The bandwidth-efficient answer to "which events is this peer missing?". Two
// peers exchange small fingerprints over sorted ranges of their id-set and split
// only where the fingerprints disagree, until each side learns the EXACT set of
// ids it lacks. Only those events are then transferred — never the whole log
// (docs/adr/0003). A fresh peer's set is empty, so it needs everything; a peer
// that dropped offline for two minutes needs only the handful it missed.
//
// This file is the ALGORITHM only — pure functions of two id-sets, testable with
// no transport. How the fingerprints/summaries travel over Delivery is the
// catch-up protocol (catchup.hpp), which rides the app's normal send/receive.
//
// Lifted verbatim (byte-for-byte fingerprints) from KYM's proven, convergence-
// tested mirror. Parity: src/reconcile.ts (docs/PARITY.md, docs/adr/0005).
#include "event.hpp"
#include <set>
#include <cstdint>
#include <cmath>
#include <openssl/sha.h>

namespace logos_sync {
namespace rbsr {

// A reconciliation item: the ordering key of an event. Ordered by (wall, id) —
// the same (timestamp, id) tuple Negentropy/RBSR orders on; id (a UUID) breaks
// wall-clock ties so the order is total and identical on every device.
struct Item { int64_t wall; std::string id; };

inline int keyCmp(const Item& a, const Item& b) {
    if (a.wall != b.wall) return a.wall < b.wall ? -1 : 1;
    return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
}

// Project events into the canonical reconciliation order.
inline std::vector<Item> toItems(const std::vector<Event>& events) {
    std::vector<Item> items;
    items.reserve(events.size());
    for (const auto& e : events) items.push_back(Item{e.hlc.wall, e.id});
    std::sort(items.begin(), items.end(),
              [](const Item& x, const Item& y) { return keyCmp(x, y) < 0; });
    return items;
}

struct Bound { bool set = false; Item key; };

inline std::vector<Item> inRange(const std::vector<Item>& items, const Bound& lo, const Bound& hi) {
    std::vector<Item> out;
    for (const auto& it : items) {
        if (lo.set && keyCmp(it, lo.key) < 0) continue;
        if (hi.set && keyCmp(it, hi.key) >= 0) continue;
        out.push_back(it);
    }
    return out;
}

inline std::string toHex(const unsigned char* b, size_t n) {
    static const char* h = "0123456789abcdef";
    std::string s; s.reserve(n * 2);
    for (size_t i = 0; i < n; i++) { s.push_back(h[b[i] >> 4]); s.push_back(h[b[i] & 0xf]); }
    return s;
}

// Order-independent fingerprint of a set of ids: XOR of SHA-256(id) over 32 bytes,
// then SHA-256(acc ‖ uint32_be(count))[0..16]. Order never matters (XOR), so two
// peers holding the same id-set in a range always produce the same 16-byte hex.
// This byte layout is the parity contract with src/reconcile.ts — do not change it.
inline std::string fingerprint(const std::vector<Item>& items) {
    unsigned char acc[32] = {0};
    for (const auto& it : items) {
        unsigned char h[32];
        SHA256(reinterpret_cast<const unsigned char*>(it.id.data()), it.id.size(), h);
        for (int i = 0; i < 32; i++) acc[i] ^= h[i];
    }
    unsigned char buf[36];
    for (int i = 0; i < 32; i++) buf[i] = acc[i];
    uint32_t c = (uint32_t)items.size();
    buf[32] = (c >> 24) & 0xff; buf[33] = (c >> 16) & 0xff; buf[34] = (c >> 8) & 0xff; buf[35] = c & 0xff;
    unsigned char fp[32];
    SHA256(buf, 36, fp);
    return toHex(fp, 16);
}

struct Diff { std::vector<std::string> aNeeds, bNeeds; };

// Reconcile two id-sets → exact symmetric difference. aNeeds = ids A lacks (B has);
// bNeeds = ids B lacks (A has). Breadth-first range splitting: a range whose
// fingerprints agree is done; a small disagreeing range exchanges id lists; a
// large one splits into `buckets` sub-ranges keyed by the larger side's items.
inline Diff reconcile(std::vector<Item> A, std::vector<Item> B, int threshold = 8, int buckets = 16) {
    std::sort(A.begin(), A.end(), [](const Item& x, const Item& y) { return keyCmp(x, y) < 0; });
    std::sort(B.begin(), B.end(), [](const Item& x, const Item& y) { return keyCmp(x, y) < 0; });
    std::set<std::string> aNeeds, bNeeds;

    std::vector<std::pair<Bound, Bound>> frontier{{Bound{}, Bound{}}};
    while (!frontier.empty()) {
        std::vector<std::pair<Bound, Bound>> next;
        for (const auto& fr : frontier) {
            const Bound& lo = fr.first;
            const Bound& hi = fr.second;
            std::vector<Item> ia = inRange(A, lo, hi), ib = inRange(B, lo, hi);
            if (fingerprint(ia) == fingerprint(ib)) continue;

            const std::vector<Item>& larger = ia.size() >= ib.size() ? ia : ib;
            if ((int)larger.size() <= threshold) {
                std::set<std::string> aSet, bSet;
                for (auto& x : ia) aSet.insert(x.id);
                for (auto& x : ib) bSet.insert(x.id);
                for (auto& x : ib) if (!aSet.count(x.id)) aNeeds.insert(x.id);
                for (auto& x : ia) if (!bSet.count(x.id)) bNeeds.insert(x.id);
                continue;
            }
            int step = (int)std::ceil((double)larger.size() / buckets);
            Bound subLo = lo;
            for (size_t i = 0; i < larger.size(); i += step) {
                Bound subHi;
                if (i + step < larger.size()) { subHi.set = true; subHi.key = larger[i + step]; }
                else subHi = hi;
                next.push_back({subLo, subHi});
                subLo = subHi;
            }
        }
        frontier.swap(next);
    }
    return Diff{std::vector<std::string>(aNeeds.begin(), aNeeds.end()),
                std::vector<std::string>(bNeeds.begin(), bNeeds.end())};
}

} // namespace rbsr
} // namespace logos_sync
