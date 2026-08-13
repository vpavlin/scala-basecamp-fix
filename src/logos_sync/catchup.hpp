#pragma once
// logos_sync/catchup.hpp — the catch-up (backfill) protocol.
//
// WHY THIS EXISTS. SDS Reliable Channels heal *live* drops (a message you missed
// is re-requested via its successor's causal history and retransmitted). They do
// NOT reconstruct history for a peer that starts cold or was offline past the
// buffer window — and liblogosdelivery exposes no Store query on desktop. So a
// joining/returning peer needs an explicit backfill. The naive version ("re-serve
// the whole log periodically") is O(log) bandwidth forever; this protocol serves
// ONLY the delta (docs/adr/0003, docs/adr/0004).
//
// THE PROTOCOL (v1 — single round, "summarise then serve the complement"):
//   1. On join/reconnect a peer publishes a SYNC_REQ carrying the id-set it holds
//      for the channel (buildRequest).
//   2. Any peer that receives it computes answerRequest():
//        • serve  = the events the requester lacks  → publish just those.
//        • iLack  = ids the requester has that WE lack → we fire our OWN SYNC_REQ.
//      (2) makes a single request converge BOTH peers: the joiner pulls history,
//      and anything the joiner authored offline pulls back to us.
//   3. A fresh peer's id-set is empty → it receives the whole log (once). A peer
//      two minutes behind receives only the handful it missed.
//
// The app owns the trigger (when to send — see examples/scala.md: 0/3/10/25 s after
// the node is ready, so the request lands after the gossip mesh forms) and the
// transport (sealing + publishing). This file is pure functions over event sets.
//
// v2 (future): replace the id-set in the request with RBSR fingerprints
// (reconcile.hpp) so the *upstream* summary is O(log N) instead of O(N). v1 already
// makes the *downstream* transfer minimal, which is the property that matters most.
//
// Parity: src/catchup.ts.
#include "event.hpp"
#include <set>

namespace logos_sync {
namespace catchup {

// The id-set summary a requester publishes: "here is everything I already have on
// this channel; send me the rest." Small (one id per event); a fresh peer sends an
// empty list. Kept well under Waku's 150 KB message cap for realistic logs; for
// very large logs, switch to the v2 fingerprint summary.
inline json buildRequest(const std::vector<Event>& have) {
    json ids = json::array();
    for (const auto& e : have) if (!e.id.empty()) ids.push_back(e.id);
    return json{{"have", ids}};
}

struct Answer {
    std::vector<Event> serve;          // events to publish back (requester lacks these)
    std::vector<std::string> iLack;    // ids the requester has that WE don't → pull them
};

// Compute the response to a SYNC_REQ summary. Pure set arithmetic:
//   serve = myLog \ have      (what to send them)
//   iLack = have \ myLog-ids  (what we should ask for in return)
inline Answer answerRequest(const std::vector<Event>& myLog, const json& req) {
    std::set<std::string> have;
    if (req.contains("have") && req["have"].is_array())
        for (const auto& x : req["have"])
            if (x.is_string()) have.insert(x.get<std::string>());

    std::set<std::string> mine;
    for (const auto& e : myLog) mine.insert(e.id);

    Answer a;
    for (const auto& e : myLog)
        if (!have.count(e.id)) a.serve.push_back(e);       // they lack it → serve
    for (const auto& id : have)
        if (!mine.count(id)) a.iLack.push_back(id);         // we lack it → pull
    return a;
}

} // namespace catchup
} // namespace logos_sync
