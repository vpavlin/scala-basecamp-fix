#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "scala_engine.hpp"
#include "scala_identity.hpp"  // per-device secp256k1 signing identity
#include <logos_module_context.h>  // LogosModuleContext base + logos_events: + modules()

// Forward declarations for internal components (ported to std types)
class CalendarStore;
class CalendarSync;

/**
 * ScalaImpl — Universal-pattern core module for the Scala calendar app.
 *
 * Pure C++ class — no Qt, no Q_OBJECT, no Q_PLUGIN_METADATA.
 * All public methods are auto-exposed by logos-cpp-generator.
 * Inter-module calls via modules().kv_module.* (auto-generated typed SDK).
 * Events declared below with logos_events: section.
 */
class ScalaImpl : public LogosModuleContext {
public:
    ScalaImpl();
    ~ScalaImpl() override;

    // ── Namespace API ────────────────────────────────────────────────────────
    void setNamespace(const std::string& ns);

    // ── Identity API ─────────────────────────────────────────────────────────
    std::string getIdentity() const;
    void setIdentity(const std::string& pubkeyHex);

    /// Enrol a physical Keycard as a loam identity (delegates entirely to loam_core; scala holds no
    /// keycard logic). `domain` should be "scala" so one card is one identity across phone + desktop.
    /// Async: returns a ref; progress + completion arrive on keycardStatus (then refresh identities).
    std::string enrollKeycard(const std::string& label, const std::string& domain);

    /// Snapshot of the current/last Keycard op for the poll-based view (mirrors the keycardStatus
    /// event): {active, purpose, phase, ref, calId, error?}. Drives the "hold your Keycard" overlay.
    std::string keycardState();

    // ── Calendar CRUD ────────────────────────────────────────────────────────
    /// Create a new calendar. Returns the calendar ID.
    std::string createCalendar(const std::string& name, const std::string& color, const std::string& identityId = "");

    /// List all calendars. Returns JSON array string.
    std::string listCalendars();

    /// Delete a calendar and all its events.
    bool deleteCalendar(const std::string& id);

    /// #7/#8: edit shared calendar metadata — JSON {name?,color?,description?,schema?}.
    bool updateCalendarMeta(const std::string& calId, const std::string& fieldsJson);

    /// #3: grant/revoke a member — role is "admin"|"viewer"|"remove" (fold enforces owner/admin).
    bool setMemberRole(const std::string& calId, const std::string& member, const std::string& role);

    // ── Event CRUD ───────────────────────────────────────────────────────────
    /// Create an event in a calendar. Returns the event ID.
    std::string createEvent(const std::string& calendarId, const std::string& eventJson);

    /// Create an event from explicit scalar fields (no JSON, no commas) — usable from
    /// the logoscore CLI, which splits args on commas and types numbers as int. start/end
    /// are epoch-ms passed as STRINGS. Lets a headless hub inject a real, visible event.
    std::string createEventAt(const std::string& calendarId, const std::string& title,
                              const std::string& startMs, const std::string& endMs);

    /// Update an existing event. Returns the event ID.
    std::string updateEvent(const std::string& eventJson);

    /// Delete an event.
    bool deleteEvent(const std::string& id);

    /// List all events in a calendar. Returns JSON array string.
    std::string listEvents(const std::string& calendarId);

    /// #4: per-event edit history — [{author,at,action,payload}] from the raw log.
    std::string getEventHistory(const std::string& calId, const std::string& eventId);

    /// Get a single event by ID. Returns JSON object string.
    std::string getEvent(const std::string& id);

    // ── Sync API ─────────────────────────────────────────────────────────────
    /// Share a calendar. Returns the encryption key.
    std::string shareCalendar(const std::string& calendarId);

    /// Join a shared calendar with the provided encryption key.
    bool joinSharedCalendar(const std::string& calendarId, const std::string& encryptionKey);

    /// Get the current sync status for a calendar.
    std::string getSyncStatus(const std::string& calendarId);

    /// Encode text as a REAL QR code matrix (vendored qrcodegen). Returns JSON
    /// {"ok":true,"n":<size>,"cells":[0|1,...row-major],"text":...} for the view
    /// to draw on a Canvas (data: URIs are blocked in the sandbox).
    std::string qrMatrix(const std::string& text);

    /// Connection + events diagnostics for the debug panel. JSON:
    /// {identity, nodeReady, calendarCount, eventCount, calendars:[{id,name,shared,syncing,events,creatorId}]}
    std::string diagnostics();

    // ── Share link API ───────────────────────────────────────────────────────
    /// Generate a scala:// share link for a calendar.
    std::string generateShareLink(const std::string& calendarId);

    /// Parse a scala:// share link. Returns JSON with calendar info.
    std::string parseShareLink(const std::string& link);

    /// Handle a scala:// share link (join the calendar).
    bool handleShareLink(const std::string& link, const std::string& identityId = "");

    // ── Search API ───────────────────────────────────────────────────────────
    /// Search events across all calendars by title/description/location. Returns JSON array string.
    std::string searchEvents(const std::string& query);

    // ── Reminders API ────────────────────────────────────────────────────────
    /// Get events with pending reminders. Returns JSON array string.
    std::string getPendingReminders();

    // ── Settings API ─────────────────────────────────────────────────────────
    void setSetting(const std::string& key, const std::string& value);
    std::string getSetting(const std::string& key, const std::string& defaultValue);

    // ── Context lifecycle ────────────────────────────────────────────────────
    /// Called when the module context is fully initialized (deps are live).
    void onContextReady() override;

    // ── Events — emitted to subscribers via the host's eventResponse channel ─
logos_events:
    /// Emitted when a calendar's sync status changes.
    void syncStatusChanged(const std::string& calendarId, const std::string& status);

    /// Emitted when the module identity changes.
    void identityChanged();

    /// Progress of an async Keycard authoring/enrol op (scala ADR 0016). statusJson =
    /// {purpose:"event"|"enroll", phase:"pending"|"done"|"failed", error?}. The view shows a
    /// "hold your Keycard" overlay on pending and clears it on done/failed. calId is "" for enrol.
    void keycardStatus(const std::string& calId, const std::string& ref, const std::string& statusJson);

private:
    CalendarStore* m_store = nullptr;
    CalendarSync* m_sync = nullptr;
    std::string m_identity;      // == m_signId.address (the "0x…" author id)
    scala::SignId m_signId;      // secp256k1 keypair; private key persisted in the kv store
    std::string m_namespace;
    bool m_ctxReady = false;              // onContextReady() actually fired
    std::string m_deliveryStatus;         // last transport status (Connecting/Connected/error)

    // ── event-log CRDT helpers ───────────────────────────────────────────────
    long long m_wall = 0;                 // HLC clock
    long long m_ctr = 0;
    scala::HLC nextHlc();
    scala::Event mkEvent(const std::string& type, const scala::json& payload, const std::string& calId = "");
    void publishAndApply(const std::string& calId, const scala::Event& e);  // append locally + broadcast
    // Author a user write: if the calendar is bound to a KEYCARD identity, sign async via loam_core
    // (card tap) and publish on completion; otherwise sign + publish synchronously. SYNC_REQ never
    // routes here (no card tap for reconciliation). (scala ADR 0016)
    void authorAndPublish(const std::string& type, const scala::json& payload, const std::string& calId);
    bool authorEvent(const std::string& type, const scala::json& payload, const std::string& calId);  // true = handled async (keycard)
    void emitKcStatus(const std::string& calId, const std::string& ref, const char* purpose, const char* phase, const std::string& error);
    struct PendingKc { std::string calId; scala::Event event; };
    std::map<std::string, PendingKc> m_pendingKc;   // events awaiting a card signature, keyed by event id (== ref)
    std::string m_kcState = "{\"active\":false}";   // last keycard op snapshot, polled by keycardState()
    void applyIncoming(const std::string& calId, const std::string& eventJson);  // merge a received event
    // ── catch-up (qaku SYNC_REQ + seed) ──────────────────────────────────────
    void onSyncReq(const std::string& calId, const nlohmann::json& req);  // serve ONLY the delta a peer lacks (logos_sync catch-up)
    void sendSyncReq(const std::string& calId);   // publish our id-summary so peers serve our gap (on join/connect + retries)
    std::map<std::string, long long> m_lastServe; // per-calendar rate-limit for the SYNC_REQ response
    // Idempotently (re)attempt the delivery bootstrap. Called from onContextReady
    // AND lazily from the polled read methods (kym self-drive pattern) so the node
    // comes up even if the lifecycle hook is flaky / there were no shared calendars
    // at startup.
    void ensureDelivery();

    // Handle incoming sync messages from CalendarSync
    void onSyncMessageReceived(const std::string& calendarId, const std::string& msgJson);
};
