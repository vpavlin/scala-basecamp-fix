#pragma once
// Scala calendar engine — the pure, deterministic fold from a merged event log to
// calendar state. Modeled directly on qaku_engine.hpp (event-log CRDT): every
// change is an immutable event; current state = fold over the merged log. Merge is
// union-by-id + HLC sort, so it is idempotent (redelivery is a no-op), commutative
// and associative (arrival order is irrelevant) — offline devices converge with no
// lost writes.
//
// One channel == one calendar; its log holds that calendar's events. The JS mobile
// app mirrors this fold byte-for-byte (see mobile/src/lib/engine.ts).
#include <string>
#include <vector>
#include <map>
#include <set>
#include <algorithm>
#include <nlohmann/json.hpp>

namespace scala {
using json = nlohmann::json;

// ── HLC (hybrid logical clock): total order wall → ctr → dev ─────────────────
struct HLC { long long wall = 0; long long ctr = 0; std::string dev; };
inline int compareHlc(const HLC& a, const HLC& b) {
    if (a.wall != b.wall) return a.wall < b.wall ? -1 : 1;
    if (a.ctr  != b.ctr)  return a.ctr  < b.ctr  ? -1 : 1;
    if (a.dev  != b.dev)  return a.dev  < b.dev  ? -1 : 1;
    return 0;
}

// ── Event: the immutable unit. id (UUIDv4) is the idempotency/dedup key ──────
struct Event { int v = 1; std::string id; std::string type; HLC hlc; std::string dev; json payload; };

// Event type constants — keep in lockstep with mobile/src/lib/engine.ts.
namespace ET {
    constexpr const char* CAL_META  = "cal.meta";    // {name,color}          — calendar metadata (LWW)
    constexpr const char* EVENT_PUT = "event.put";   // {id,title,startTime,…}— create/edit an event (LWW upsert by id)
    constexpr const char* EVENT_DEL = "event.del";   // {id}                  — tombstone an event (terminal)
}

inline json eventToJson(const Event& e) {
    return json{{"v", e.v}, {"id", e.id}, {"type", e.type},
                {"hlc", {{"wall", e.hlc.wall}, {"ctr", e.hlc.ctr}, {"dev", e.hlc.dev}}},
                {"dev", e.dev}, {"payload", e.payload}};
}
inline Event eventFromJson(const json& j) {
    Event e;
    e.v = j.value("v", 1);
    e.id = j.value("id", std::string());
    e.type = j.value("type", std::string());
    if (j.contains("hlc") && j["hlc"].is_object()) {
        e.hlc.wall = j["hlc"].value("wall", 0LL);
        e.hlc.ctr  = j["hlc"].value("ctr", 0LL);
        e.hlc.dev  = j["hlc"].value("dev", std::string());
    }
    e.dev = j.value("dev", std::string());
    e.payload = j.contains("payload") ? j["payload"] : json::object();
    return e;
}

// Union by id, sort by HLC. Idempotent — redelivery is a no-op. Pure.
inline std::vector<Event> mergeEvents(const std::vector<Event>& a, const std::vector<Event>& b = {}) {
    std::map<std::string, Event> byId;
    for (const auto& e : a) if (!e.id.empty()) byId.emplace(e.id, e);
    for (const auto& e : b) if (!e.id.empty()) byId.emplace(e.id, e);
    std::vector<Event> out; out.reserve(byId.size());
    for (auto& kv : byId) out.push_back(kv.second);
    std::sort(out.begin(), out.end(), [](const Event& x, const Event& y){ return compareHlc(x.hlc, y.hlc) < 0; });
    return out;
}

// ── fold: merged log → calendar state ────────────────────────────────────────
// Returns {name, color, events:[…]}. cal.meta is LWW (last by HLC wins). Events are
// LWW upsert by event id; a tombstone is TERMINAL (a later edit can't resurrect it).
inline json foldCalendar(const std::string& calId, const std::vector<Event>& log) {
    auto ordered = mergeEvents(log);
    std::string name, color;
    std::map<std::string, json> events;   // event id -> event payload
    std::set<std::string> tombstones;

    for (const auto& e : ordered) {
        if (e.type == ET::CAL_META) {
            if (e.payload.contains("name"))  name  = e.payload.value("name", name);
            if (e.payload.contains("color")) color = e.payload.value("color", color);
        } else if (e.type == ET::EVENT_PUT) {
            std::string id = e.payload.value("id", std::string());
            if (id.empty() || tombstones.count(id)) continue;   // tombstone terminal
            json ev = e.payload;
            ev["calendarId"] = calId;
            ev["creatorId"] = e.dev;
            events[id] = ev;
        } else if (e.type == ET::EVENT_DEL) {
            std::string id = e.payload.value("id", std::string());
            if (!id.empty()) { tombstones.insert(id); events.erase(id); }
        }
    }

    json evArr = json::array();
    for (auto& kv : events) evArr.push_back(kv.second);
    return json{{"id", calId}, {"name", name}, {"color", color}, {"events", evArr}};
}

} // namespace scala
