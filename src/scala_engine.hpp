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

// The event envelope, HLC and CRDT merge now come from the shared logos-sync
// library (vendored under logos_sync/) — they were already byte-identical to
// scala's hand-written copies, so this is a pure de-duplication. What stays
// scala's: the ET:: event types and foldCalendar below (logos-sync ADR 0007).
#include "logos_sync/event.hpp"
#include "logos_sync/merge.hpp"

namespace scala {
using json = nlohmann::json;

// Adopt the shared spine into the scala:: namespace so the rest of the module
// (CalendarSync, ScalaImpl) keeps compiling unchanged against scala::Event etc.
using logos_sync::HLC;
using logos_sync::compareHlc;
using logos_sync::Event;
using logos_sync::eventToJson;
using logos_sync::eventFromJson;
using logos_sync::mergeEvents;

// Event type constants — keep in lockstep with mobile/src/lib/engine.ts.
namespace ET {
    constexpr const char* CAL_META  = "cal.meta";    // {name,color}          — calendar metadata (LWW)
    constexpr const char* EVENT_PUT = "event.put";   // {id,title,startTime,…}— create/edit an event (LWW upsert by id)
    constexpr const char* EVENT_DEL = "event.del";   // {id}                  — tombstone an event (terminal)
    constexpr const char* MEMBER_SET = "member.set"; // {member,role}         — roles (#3): owner/admin grants admin|viewer|remove. Opt-in: no member.set = open calendar.
    constexpr const char* SYNC_REQ  = "sync.req";    // {have:[id…], from} — CATCH-UP: a joining peer publishes the ids it already holds; peers serve ONLY the delta (logos_sync::catchup). NOT stored, NOT folded (foldCalendar ignores unknown types); handled in the receive path → onSyncReq().
}

// eventToJson / eventFromJson / mergeEvents now come from logos_sync (aliased
// above) — they were byte-identical to the copies that used to live here.

// ── fold: merged log → calendar state ────────────────────────────────────────
// Returns {name, color, events:[…]}. cal.meta is LWW (last by HLC wins). Events are
// LWW upsert by event id; a tombstone is TERMINAL (a later edit can't resurrect it).
inline json foldCalendar(const std::string& calId, const std::vector<Event>& log) {
    auto ordered = mergeEvents(log);
    std::string name, color, description, owner;
    json schema = json::array();          // OPTIONAL custom-field definitions; empty by
                                          // default so a plain calendar shows nothing extra.
    std::map<std::string, json> events;   // event id -> event payload
    std::set<std::string> tombstones;

    // ── roles (#3), opt-in + default-open ────────────────────────────────────
    // owner = author of the earliest cal.meta (deterministic from the log). Until an
    // owner/admin publishes the FIRST member.set the calendar is OPEN — anyone with
    // the key writes (backward-compatible, and keeps "anyone can plan" true). Once
    // roles are configured, only owner/admins may write; a viewer's writes fold away.
    // Single HLC-ordered pass, roles built incrementally → order-independent + convergent.
    std::map<std::string, std::string> roleOf;   // dev -> "admin"|"viewer"
    bool rolesConfigured = false;
    auto canWrite = [&](const std::string& dev) -> bool {
        if (!rolesConfigured) return true;                 // open calendar
        if (dev == owner) return true;
        auto it = roleOf.find(dev);
        return it != roleOf.end() && it->second == "admin";
    };

    for (const auto& e : ordered) {
        const std::string& author = e.dev;
        if (e.type == ET::CAL_META) {
            if (owner.empty()) owner = author;             // creator = first cal.meta author
            if (!canWrite(author)) continue;               // only admins edit meta once role-managed
            if (e.payload.contains("name"))        name        = e.payload.value("name", name);
            if (e.payload.contains("color"))       color       = e.payload.value("color", color);
            if (e.payload.contains("description")) description = e.payload.value("description", description);
            if (e.payload.contains("schema") && e.payload["schema"].is_array()) schema = e.payload["schema"];
        } else if (e.type == ET::MEMBER_SET) {
            // a role grant admitted only if the author administers (owner or admin).
            if (owner.empty() || !(author == owner || (roleOf.count(author) && roleOf[author] == "admin"))) continue;
            std::string m = e.payload.value("member", std::string());
            std::string r = e.payload.value("role", std::string());
            if (m.empty() || m == owner) continue;         // owner role is fixed
            rolesConfigured = true;
            if (r == "remove") roleOf.erase(m);
            else if (r == "admin" || r == "viewer") roleOf[m] = r;
        } else if (e.type == ET::EVENT_PUT) {
            if (!canWrite(author)) continue;               // viewer edits dropped
            std::string id = e.payload.value("id", std::string());
            if (id.empty() || tombstones.count(id)) continue;   // tombstone terminal
            json ev = e.payload;
            ev["calendarId"] = calId;
            ev["creatorId"] = e.dev;
            events[id] = ev;
        } else if (e.type == ET::EVENT_DEL) {
            if (!canWrite(author)) continue;
            std::string id = e.payload.value("id", std::string());
            if (!id.empty()) { tombstones.insert(id); events.erase(id); }
        }
    }

    json evArr = json::array();
    for (auto& kv : events) evArr.push_back(kv.second);
    json roles = json::object();
    for (auto& kv : roleOf) roles[kv.first] = kv.second;
    return json{{"id", calId}, {"name", name}, {"color", color},
                {"description", description}, {"schema", schema},
                {"owner", owner}, {"roles", roles}, {"rolesConfigured", rolesConfigured},
                {"events", evArr}};
}

} // namespace scala
