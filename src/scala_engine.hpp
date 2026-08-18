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
#include "scala_identity.hpp"   // event signature verification (authenticity)

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

    // ── roles + permissions (two rules; owner/editor/viewer + Open toggle) ────
    // owner = author of the earliest cal.meta. roleOf grants "editor"/"viewer". Two rules:
    //   1. Owner + Editors may do anything; explicit Viewers are read-only.
    //   2. Everyone else (a "participant" — anyone with the key) may ADD events iff the
    //      calendar is OPEN, and may EDIT/DELETE only the events THEY authored.
    // → "editing someone else's event needs to be an Editor" falls out for free, using the
    // per-event author (creatorId). Authenticity: a privileged (owner/editor) claim is
    // trusted only when the event is signed by that author; unsigned legacy events are still
    // admitted (best-effort author). Single HLC-ordered pass → order-independent, convergent.
    std::map<std::string, std::string> roleOf;    // dev -> "editor"|"viewer"
    std::map<std::string, std::string> creatorOf; // event id -> ORIGINAL author (edit-your-own)
    bool rolesConfigured = false;
    bool openCal = true;                          // cal.meta "open" (LWW): may participants add? default yes

    auto isEditor = [&](const std::string& dev, bool verified) -> bool {
        if (rolesConfigured && !verified) return false;    // privileged claim must be authenticated
        if (dev == owner) return true;
        auto it = roleOf.find(dev);
        return it != roleOf.end() && (it->second == "editor" || it->second == "admin");
    };
    auto isViewer = [&](const std::string& dev) -> bool {
        auto it = roleOf.find(dev);
        return it != roleOf.end() && it->second == "viewer";
    };
    auto canAdd = [&](const std::string& dev, bool verified) -> bool {
        if (isEditor(dev, verified)) return true;
        if (isViewer(dev)) return false;
        return openCal;                                    // participant may add iff Open
    };
    auto canEditExisting = [&](const std::string& dev, const std::string& creator, bool verified) -> bool {
        if (isEditor(dev, verified)) return true;
        if (isViewer(dev)) return false;
        return !creator.empty() && dev == creator;         // else edit only your OWN
    };

    for (const auto& e : ordered) {
        // A present-but-invalid signature means the event was forged/tampered → drop it
        // entirely. An UNSIGNED (legacy) event is admitted but never counts as authenticated.
        const bool signed_ = isSigned(e);
        const bool verified = signed_ && verifyEvent(e);
        if (!verified) continue;   // signatures ALWAYS required — every event is signed via the loam identity; drop unsigned/tampered
        const std::string& author = e.dev;
        if (e.type == ET::CAL_META) {
            bool creating = owner.empty();
            if (creating) owner = author;                  // creator = first cal.meta author
            if (!creating && !isEditor(author, verified)) continue;  // only owner/editors change settings
            if (e.payload.contains("name"))        name        = e.payload.value("name", name);
            if (e.payload.contains("color"))       color       = e.payload.value("color", color);
            if (e.payload.contains("description")) description = e.payload.value("description", description);
            if (e.payload.contains("schema") && e.payload["schema"].is_array()) schema = e.payload["schema"];
            if (e.payload.contains("open"))               openCal     = e.payload.value("open", true);
        } else if (e.type == ET::MEMBER_SET) {
            // A role grant is admitted only from an AUTHENTICATED owner/editor.
            bool authed = verified && (author == owner || (roleOf.count(author) && (roleOf[author] == "editor" || roleOf[author] == "admin")));
            if (owner.empty() || !authed) continue;
            std::string m = e.payload.value("member", std::string());
            std::string r = e.payload.value("role", std::string());
            if (m.empty() || m == owner) continue;         // owner role is fixed
            rolesConfigured = true;
            if (r == "remove") roleOf.erase(m);
            else if (r == "editor" || r == "admin") roleOf[m] = "editor";  // "admin" = legacy alias
            else if (r == "viewer") roleOf[m] = "viewer";
        } else if (e.type == ET::EVENT_PUT) {
            std::string id = e.payload.value("id", std::string());
            if (id.empty() || tombstones.count(id)) continue;   // tombstone terminal
            bool exists = creatorOf.count(id) > 0;
            if (!exists) { if (!canAdd(author, verified)) continue; creatorOf[id] = author; }  // create
            else if (!canEditExisting(author, creatorOf[id], verified)) continue;              // edit
            json ev = e.payload;
            ev["calendarId"] = calId;
            ev["creatorId"] = creatorOf[id];               // ORIGINAL author (not the last editor)
            events[id] = ev;
        } else if (e.type == ET::EVENT_DEL) {
            std::string id = e.payload.value("id", std::string());
            if (id.empty()) continue;
            std::string creator = creatorOf.count(id) ? creatorOf[id] : std::string();
            if (!canEditExisting(author, creator, verified)) continue;
            tombstones.insert(id); events.erase(id);
        }
    }

    json evArr = json::array();
    for (auto& kv : events) evArr.push_back(kv.second);
    json roles = json::object();
    for (auto& kv : roleOf) roles[kv.first] = kv.second;
    return json{{"id", calId}, {"name", name}, {"color", color},
                {"description", description}, {"schema", schema},
                {"owner", owner}, {"roles", roles}, {"rolesConfigured", rolesConfigured},
                {"open", openCal}, {"events", evArr}};
}

} // namespace scala
