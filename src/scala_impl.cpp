#include "scala_impl.h"
#include "qrcodegen.hpp"

// Generated umbrella: modules() + typed dependency wrappers (delivery_module)
#include "logos_sdk.h"

#include "calendar_store.h"
#include "calendar_sync.h"

#include <nlohmann/json.hpp>
#include "logos_transport.hpp"
#include "logos_sync/catchup.hpp"   // delta catch-up (buildRequest / answerRequest)
#include <QTimer>                    // catch-up retry timers (mesh forms ~10s after start)

#include <chrono>
#include <random>
#include <cstdlib>
#include <cstdio>
#include <ctime>
#include <fstream>
#include <sstream>
#include <vector>
#include <cctype>
#include <cstring>

using scala::json;

// ── small helpers ────────────────────────────────────────────────────────────
// RFC-4122-ish v4 UUID. MUST use a properly-seeded high-quality RNG: std::rand()
// is deterministic when unseeded (replays the same sequence from seed 1 every
// process launch), so unseeded it hands the FIRST calendar/event after each
// restart an IDENTICAL id → colliding calendars (shared log/key/color) and, worse,
// re-used event ids that appendEvent's dedup-by-id silently DROPS. Seed once from
// random_device; nonce hex nibbles from a persistent 64-bit Mersenne Twister.
static std::string generateUuid() {
    static std::mt19937_64 rng(std::random_device{}());
    static std::uniform_int_distribution<int> hex(0, 15);
    std::ostringstream oss;
    oss << std::hex;
    for (int i = 0; i < 32; i++) {
        int r = hex(rng);
        if (i == 8 || i == 12 || i == 16 || i == 20) oss << '-';
        if (i == 12) oss << '4';
        else if (i == 16) oss << (8 + (r & 3));
        else oss << r;
    }
    return oss.str();
}
static long long nowMs() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
               std::chrono::system_clock::now().time_since_epoch()).count();
}
static std::string stableIdentity() {
    std::ifstream f("/etc/machine-id");
    std::string id; if (f) std::getline(f, id);
    if (id.empty()) id = "scala-" + std::to_string(nowMs());
    return "scala-" + id.substr(0, 16);
}
// base64url (RFC 4648, no padding) — matches the mobile invite key encoding.
static const char* kB64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
static std::string b64urlEncode(const std::string& in) {
    std::string out; int val = 0, bits = -6;
    for (unsigned char c : in) { val = (val << 8) + c; bits += 8;
        while (bits >= 0) { out.push_back(kB64[(val >> bits) & 0x3F]); bits -= 6; } }
    if (bits > -6) out.push_back(kB64[((val << 8) >> (bits + 8)) & 0x3F]);
    return out;
}
static std::string b64urlDecode(const std::string& in) {
    std::vector<int> T(256, -1); for (int i = 0; i < 64; i++) T[(unsigned char)kB64[i]] = i;
    std::string out; int val = 0, bits = -8;
    for (unsigned char c : in) { if (T[c] == -1) continue; val = (val << 6) + T[c]; bits += 6;
        if (bits >= 0) { out.push_back(char((val >> bits) & 0xFF)); bits -= 8; } }
    return out;
}
static std::string urlEncode(const std::string& s) {
    static const char* hex = "0123456789ABCDEF"; std::string o;
    for (unsigned char c : s) {
        if (isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~') o.push_back(c);
        else { o.push_back('%'); o.push_back(hex[c >> 4]); o.push_back(hex[c & 15]); }
    }
    return o;
}
static std::string urlDecode(const std::string& s) {
    std::string o;
    for (size_t i = 0; i < s.size(); i++) {
        if (s[i] == '%' && i + 2 < s.size()) { o.push_back((char)std::strtol(s.substr(i + 1, 2).c_str(), nullptr, 16)); i += 2; }
        else if (s[i] == '+') o.push_back(' ');
        else o.push_back(s[i]);
    }
    return o;
}
static std::map<std::string, std::string> parseQuery(const std::string& link) {
    std::map<std::string, std::string> q;
    auto pos = link.find('?'); if (pos == std::string::npos) return q;
    std::string qs = link.substr(pos + 1); std::stringstream ss(qs); std::string pair;
    while (std::getline(ss, pair, '&')) {
        auto eq = pair.find('=');
        if (eq == std::string::npos) continue;
        q[urlDecode(pair.substr(0, eq))] = urlDecode(pair.substr(eq + 1));
    }
    return q;
}

// ── construction ─────────────────────────────────────────────────────────────
ScalaImpl::ScalaImpl() {
    m_store = new CalendarStore();
    m_sync = new CalendarSync();
    // CRDT path: a received event's raw JSON is merged into that calendar's log.
    m_sync->setEventHandler([this](const std::string& calId, const std::string& eventJson) {
        applyIncoming(calId, eventJson);
    });
    m_sync->setStatusHandler([this](const std::string& calId, const std::string& status) {
        syncStatusChanged(calId, status);
    });
}
ScalaImpl::~ScalaImpl() { delete m_sync; delete m_store; }

// ── HLC + event helpers ──────────────────────────────────────────────────────
scala::HLC ScalaImpl::nextHlc() {
    long long t = nowMs();
    if (t > m_wall) { m_wall = t; m_ctr = 0; } else { m_ctr += 1; }
    return scala::HLC{ m_wall, m_ctr, m_identity };
}
scala::Event ScalaImpl::mkEvent(const std::string& type, const json& payload, const std::string& calId) {
    scala::Event e; e.v = 1; e.id = generateUuid(); e.type = type; e.payload = payload;
    // Author through loam_core's identity service (loam ADR 0004): the container's bound identity
    // signs; keys never leave loam. This is why the calendar owner is a loam identity, not scala's
    // old device key. Falls back to the local key so scala keeps working if loam_core can't sign.
    if (!calId.empty()) {
        std::string signer, sigHex, pubHex;
        try {
            std::string ir = modules().loam_core.identityForContainer(calId); // sync caller → JSON string
            if (!ir.empty()) {
                json meta = json::parse(ir, nullptr, false);
                if (meta.is_object()) signer = meta.value("address", std::string());
            }
        } catch (...) {}
        if (!signer.empty()) {
            e.dev = signer; e.hlc = nextHlc(); e.hlc.dev = signer;
            std::string digestHex = scala::toHexS(scala::sha256b(scala::strBytes(scala::canonicalMessage(e))).data(), 32);
            try {
                std::string sr = modules().loam_core.signDigest(calId, digestHex); // sync caller → JSON string
                if (!sr.empty()) {
                    json sres = json::parse(sr, nullptr, false);
                    std::string sg = sres.is_object() ? sres.value("sig", std::string()) : std::string();
                    std::string pk = sres.is_object() ? sres.value("pub", std::string()) : std::string();
                    if (!sg.empty() && !pk.empty()) {
                        e.pub = pk; e.sig = sg;
                        return e; // signed by the loam identity
                    }
                }
            } catch (...) {}
        }
    }
    // Fallback: local device key (original behaviour) — keeps authoring working without loam_core.
    e.hlc = nextHlc(); e.dev = m_identity;
    if (m_signId.valid) scala::signEvent(m_signId, e);
    return e;
}
void ScalaImpl::publishAndApply(const std::string& calId, const scala::Event& e) {
    m_store->appendEvent(calId, e);                        // persist locally first
    m_sync->sendEvent(calId, scala::eventToJson(e).dump()); // then broadcast (no-op if not syncing)
}

// ── keycard-aware authoring (scala ADR 0016) ─────────────────────────────────
void ScalaImpl::emitKcStatus(const std::string& calId, const std::string& ref,
                             const char* purpose, const char* phase, const std::string& error) {
    json s{{"purpose", purpose}, {"phase", phase}, {"ref", ref}, {"calId", calId},
           {"active", std::string(phase) == "pending"}};
    if (!error.empty()) s["error"] = error;
    m_kcState = s.dump();               // poll snapshot for the view (basecamp 0.2.0 is poll-based)
    keycardStatus(calId, ref, s.dump()); // + the event, for event-capable hosts
}

std::string ScalaImpl::keycardState() { return m_kcState; }

// If calId is bound to a KEYCARD identity, build the unsigned event, request an on-card signature
// via loam_core (async), park it keyed by its id, and return true. The signature arrives on
// onKeycardSignResult, which attaches it and publishes. Returns false for device/soft identities.
bool ScalaImpl::authorEvent(const std::string& type, const json& payload, const std::string& calId) {
    if (calId.empty()) return false;
    std::string kind, signer, domain;
    try {
        json meta = json::parse(modules().loam_core.identityForContainer(calId), nullptr, false);
        if (meta.is_object()) { kind = meta.value("kind", std::string()); signer = meta.value("address", std::string()); }
    } catch (...) {}
    if (kind != "keycard" || signer.empty()) return false;

    scala::Event e; e.v = 1; e.id = generateUuid(); e.type = type; e.payload = payload;
    e.dev = signer; e.hlc = nextHlc(); e.hlc.dev = signer;   // author = the card's address (same as fold sees)
    std::string digestHex = scala::toHexS(scala::sha256b(scala::strBytes(scala::canonicalMessage(e))).data(), 32);
    const std::string ref = e.id;
    m_pendingKc[ref] = PendingKc{calId, e};
    emitKcStatus(calId, ref, "event", "pending", "");
    try { modules().loam_core.keycardSign(calId, digestHex, ref); }
    catch (...) { m_pendingKc.erase(ref); emitKcStatus(calId, ref, "event", "failed", "keycard call failed"); }
    return true;
}

void ScalaImpl::authorAndPublish(const std::string& type, const json& payload, const std::string& calId) {
    if (authorEvent(type, payload, calId)) return;             // keycard: async, publishes on the tap
    publishAndApply(calId, mkEvent(type, payload, calId));     // device/soft: sign + publish now
}

std::string ScalaImpl::enrollKeycard(const std::string& label, const std::string& domain) {
    const std::string dom = domain.empty() ? std::string("scala") : domain;
    const std::string ref = "enroll:" + dom + ":" + generateUuid();
    emitKcStatus("", ref, "enroll", "pending", "");
    try { modules().loam_core.enrollKeycard(label.empty() ? dom : label, dom, ref); }
    catch (...) { emitKcStatus("", ref, "enroll", "failed", "enroll call failed"); }
    return ref;
}
void ScalaImpl::applyIncoming(const std::string& calId, const std::string& eventJson) {
    json j = json::parse(eventJson, nullptr, false);
    if (j.is_discarded() || !j.is_object()) return;
    scala::Event e = scala::eventFromJson(j);
    if (e.id.empty()) return;
    // CATCH-UP: a peer publishing the ids it holds (SYNC_REQ) — serve only the
    // delta, don't store the request itself.
    if (e.type == scala::ET::SYNC_REQ) { onSyncReq(calId, e.payload); return; }
    m_store->appendEvent(calId, e);   // idempotent (dedup by id); the view's poll refolds
}

// Step the catch-up state machine for one incoming SYNC_REQ. `msg` is a single
// RBSR range statement (fp/ids/need); respond() self-ignores our own `from` and
// returns the exact events to serve plus the reply messages to publish. Recursive
// Range-Based Set Reconciliation (logos-sync ADR 0004): only the id-exact delta is
// transferred and every message is single-segment, so there's no whole-log serve
// and no flood throttle to add — the exchange self-terminates on convergence.
void ScalaImpl::onSyncReq(const std::string& calId, const json& msg) {
    auto step = logos_sync::catchup::respond(m_store->log(calId), msg, m_identity);
    for (const auto& ev : step.serve)                              // the missing events, exactly
        m_sync->sendEvent(calId, scala::eventToJson(ev).dump());
    for (const auto& r : step.replies)                            // fp/ids/need range replies
        m_sync->sendEvent(calId, scala::eventToJson(mkEvent(scala::ET::SYNC_REQ, r)).dump());
}

// Kick off catch-up: publish the initial reconciliation message (a bounded set of
// range fingerprints over what we hold). A fresh calendar sends an empty-set
// fingerprint and recurses down to receive everything; a slightly-behind one
// converges on just the changed range.
void ScalaImpl::sendSyncReq(const std::string& calId) {
    json m = logos_sync::catchup::buildInitial(m_store->log(calId), m_identity);
    m_sync->sendEvent(calId, scala::eventToJson(mkEvent(scala::ET::SYNC_REQ, m)).dump());
}

// ── context lifecycle ────────────────────────────────────────────────────────
void ScalaImpl::onContextReady() {
    // Identity (SDS senderId + event author) — persisted so it's stable.
    // Signing identity: load the persisted secp256k1 private key, or generate one on
    // first run. m_identity is the derived address ("0x…") — the verifiable author id.
    {
        std::string privHex = m_store->kvGet("sign_key");
        if (!privHex.empty()) m_signId = scala::identityFromPriv(scala::fromHexB(privHex));
        if (!m_signId.valid) {
            m_signId = scala::generateIdentity();
            if (m_signId.valid) m_store->kvSet("sign_key", scala::toHexS(m_signId.priv.data(), 32));
        }
        m_identity = m_signId.valid ? m_signId.address : m_store->kvGet("identity");
        if (m_identity.empty()) { m_identity = stableIdentity(); }
        m_store->kvSet("identity", m_identity);
    }

    using LogosMap = nlohmann::json;
    using Tx = logos_transport::Transport<LogosMap>;

    // Route the Transport through the loam_core FACADE instead of delivery_module directly (ADR
    // 0015). loam_core.start() does createNode+start together and returns EARLY, so node readiness
    // arrives via statusChanged("Connected") — we latch the createNode cb on the first Connected.
    // The double-b64 wire is byte-identical to the direct-delivery path (loam_core's delivery
    // bearer re-applies the same framing), so scala<->scala and scala<->mobile interop hold; and
    // every write also fans onto the ble_mesh bearer, deduped by frameId. (loam_core methods
    // return a status string, so these callbacks take std::string, not StdLogosResult.)
    Tx::Ops ops;
    ops.createNode = [this](const std::string& cfg, Tx::Cb cb) {
        modules().loam_core.setSenderIdAsync(m_identity.empty() ? std::string("scala-default") : m_identity,
                                             [](std::string) {});
        auto fired = std::make_shared<bool>(false);
        modules().loam_core.onStatusChanged([cb, fired](const std::string& s) {
            if (s == "Connected" && !*fired) { *fired = true; cb(true, ""); }
        });
        modules().loam_core.startAsync(cfg, [](std::string err) {
            if (!err.empty()) fprintf(stderr, "[scala] loam_core.start: %s\n", err.c_str());
        });
    };
    ops.start = [this](Tx::Cb cb) { cb(true, ""); };   // loam_core.start already did createNode+start
    ops.subscribe = [this](const std::string& t, Tx::Cb cb) {
        modules().loam_core.joinAsync(t, [cb](std::string) { cb(true, ""); });
    };
    ops.channelCreate = [this](const std::string&, const std::string&, const std::string&, Tx::Cb cb) {
        cb(true, "");   // loam_core.join() already subscribes + creates the SDS channel with our senderId
    };
    ops.channelSend = [this](const std::string& id, const LogosMap& payload, Tx::Cb cb) {
        // `payload` is bytesPayload(b64) — a byte-ARRAY LogosMap of the b64 string (or a string in
        // the string repr). Recover the b64 and hand it to loam_core.sendSealed, which re-applies
        // the same double-b64 wire and fans to every bearer.
        std::string b64;
        if (payload.is_string()) b64 = payload.get<std::string>();
        else if (payload.is_array()) { for (const auto& c : payload) if (c.is_number_integer()) b64.push_back((char)c.get<int>()); }
        modules().loam_core.sendSealedAsync(id, b64, [cb](std::string) { cb(true, ""); });
    };
    ops.onMessage = [this](Tx::RecvCb handler) {
        // loam_core hands payloadB64 = b64(<what we sent>); wrap it as a JSON STRING LogosMap so the
        // Transport's toWire() returns it and decodes once — identical to the delivery path.
        modules().loam_core.onReceived(
            [handler](const std::string& topic, const std::string&, const std::string& payloadB64, int64_t) {
                handler(topic, LogosMap(payloadB64));
            });
    };
    ops.onChannelMessage = [this](Tx::RecvCb) { /* loam_core.onReceived covers both — avoid double-deliver */ };

    Tx tx(std::move(ops),
          Tx::Config{
              .logLevel = "INFO",
              .preset = "logos.test",   // logos.dev migrated to cluster 3; logos.test = cluster 2
              .entryNodes = {
                  "/dns4/node-01.do-ams3.logos.test.status.im/tcp/30303/p2p/16Uiu2HAmQ9X2xDfPG3uL77V9piYDhjq14JhKCtcmNYsTMKNqrKCj",
                  "/dns4/node-02.do-ams3.logos.test.status.im/tcp/30303/p2p/16Uiu2HAmB8NYprrfQrgWVzsJtYWkfjsXbmJEGNMG6othXsQ53BwG",
                  "/dns4/node-01.gc-us-central1-a.logos.test.status.im/tcp/30303/p2p/16Uiu2HAmF8WtwGPmeGHgYAX2277jHgy5cW9F7zsB8EqUjBZQAZQ3",
                  "/dns4/node-02.gc-us-central1-a.logos.test.status.im/tcp/30303/p2p/16Uiu2HAmUuXhUW9bdJpzN1kfDziFiUZo4bszTk66cvr7uuyCHXR7",
                  "/dns4/node-01.ac-cn-hongkong-c.logos.test.status.im/tcp/30303/p2p/16Uiu2HAmL3oU95jh1BZHozn3uNhx8HEneirgr8M1jEAapzXGDqRF",
                  "/dns4/node-02.ac-cn-hongkong-c.logos.test.status.im/tcp/30303/p2p/16Uiu2HAm28CoBZjpyxsanC8tQpbvZ7bZJnVYuB1EgFzb571qpWsV",
              },
              .useChannels = true,
              .hubMode = false,
              .deviceId = m_identity.empty() ? std::string("scala-default") : m_identity,
          },
          // topics: every calendar in the registry has a channel.
          [this]{ std::vector<std::string> topics;
                  for (const auto& c : m_store->calendars())
                      topics.push_back(CalendarSync::topicForCalendar(c.id));
                  return topics; },
          [this](const std::string& topic, const std::string& sealedOnceDecoded) {
              m_sync->handleReceive(topic, sealedOnceDecoded);
          },
          /*onReady*/ [this]{
              // Node connected: ask peers what we're missing. No blind whole-log
              // seed anymore — peers pull the delta via SYNC_REQ (logos-sync ADR 0003).
              for (const auto& c : m_store->calendars()) sendSyncReq(c.id);
          },
          /*setStatus*/ [this](const std::string& s) { m_deliveryStatus = s; });

    m_sync->setTransport(std::move(tx));
    m_ctxReady = true;

    // Register each calendar's key so seal/open + channel joins work after a restart.
    for (const auto& c : m_store->calendars())
        if (!c.key.empty()) m_sync->startSync(c.id, c.key);

    m_sync->bootstrap();

    // Catch-up retry: start() finishes BEFORE the gossip mesh has peers (~10s to
    // form) and before the async subscribe/channel-join land, so a single SYNC_REQ
    // at onReady races into the void (this was the "history never arrives" bug).
    // Re-request at 3/10/25s (logos-sync ADR 0004). QTimers created here fire on the
    // module's event-loop thread; sendSyncReq is a no-op until the node is ready.
    for (int ms : {3000, 10000, 25000})
        QTimer::singleShot(ms, [this]{
            if (m_sync && m_sync->ready())
                for (const auto& c : m_store->calendars()) sendSyncReq(c.id);
        });

    // Keycard authoring (scala ADR 0016): loam_core signs a keycard-owned write asynchronously (card
    // tap in keycard-ui) and delivers the result here, matched by ref. For a parked EVENT we attach
    // {sig,pub} and publish; an ENROL ref (no parked event) just surfaces its status to the view.
    modules().loam_core.onKeycardSignResult([this](const std::string& ref, const std::string& resultJson) {
        json r = json::parse(resultJson, nullptr, false);
        const bool err = !r.is_object() || r.contains("error");
        const std::string emsg = r.is_object() ? r.value("error", std::string()) : std::string("bad result");
        auto it = m_pendingKc.find(ref);
        if (it == m_pendingKc.end()) {   // enrol (or an already-resolved ref)
            emitKcStatus("", ref, "enroll", err ? "failed" : "done", emsg);
            return;
        }
        PendingKc pk = it->second; m_pendingKc.erase(it);
        // A keycard write that never got signed: if the calendar has NO applied events, it's an empty
        // orphan from a create whose first cal.meta never landed (cancelled/failed tap). Remove it so a
        // failed keycard create leaves nothing behind, instead of a name-only ghost calendar. (Only
        // keycard calendars can be event-less; device/soft author cal.meta synchronously at create.)
        auto cleanupOrphan = [this, &pk] { if (m_store->log(pk.calId).empty()) { m_sync->stopSync(pk.calId); m_store->removeCalendar(pk.calId); } };
        if (err) { cleanupOrphan(); emitKcStatus(pk.calId, ref, "event", "failed", emsg); return; }
        pk.event.pub = r.value("pub", std::string());
        pk.event.sig = r.value("sig", std::string());
        if (pk.event.pub.empty() || pk.event.sig.empty()) { cleanupOrphan(); emitKcStatus(pk.calId, ref, "event", "failed", "empty signature"); return; }
        publishAndApply(pk.calId, pk.event);          // now it's a fully-signed event
        emitKcStatus(pk.calId, ref, "event", "done", "");
    });
}

void ScalaImpl::ensureDelivery() { if (m_sync) m_sync->bootstrap(); }

// ── identity ─────────────────────────────────────────────────────────────────
// Keep in sync with metadata.json "version". The view compares this to the minimum it needs and
// shows an "update the scala core" banner if the core is older (or lacks this method entirely).
std::string ScalaImpl::coreVersion() const { return "0.9.3"; }
std::string ScalaImpl::getIdentity() const { return m_identity; }
void ScalaImpl::setIdentity(const std::string& pubkeyHex) {
    if (m_identity != pubkeyHex) { m_identity = pubkeyHex; m_store->kvSet("identity", m_identity); identityChanged(); }
}
void ScalaImpl::setNamespace(const std::string&) { /* isolation is via SCALA_CORE_DATA now */ }

// ── calendars ────────────────────────────────────────────────────────────────
std::string ScalaImpl::createCalendar(const std::string& name, const std::string& color, const std::string& identityId) {
    // Guard against ever reusing a calendar id. With the seeded RNG a collision is
    // ~2^-122 (never), but a duplicate id would silently share a log/key with an
    // existing calendar — regenerate until unambiguously fresh.
    std::string id;
    do { id = generateUuid(); } while (!m_store->calendar(id).id.empty());
    std::string key = generateUuid() + generateUuid();   // 72-char dashed, same as mobile
    m_store->upsertCalendar({ id, key, name, color });
    m_sync->startSync(id, key);
    // Bind the chosen identity in loam_core BEFORE authoring cal.meta, so the OWNER (the first
    // cal.meta's author) IS that identity (loam ADR 0004). Empty → the default identity.
    if (!identityId.empty()) { try { modules().loam_core.bindContainer(id, identityId); } catch (...) {} }
    authorAndPublish(scala::ET::CAL_META, json{{"name", name}, {"color", color}}, id);
    return id;
}
// #7/#8: edit shared calendar metadata — {name?,color?,description?,schema?,open?} (LWW cal.meta).
bool ScalaImpl::updateCalendarMeta(const std::string& calId, const std::string& fieldsJson) {
    json in = json::parse(fieldsJson, nullptr, false);
    if (in.is_discarded() || !in.is_object()) return false;
    json p = json::object();
    for (const char* k : {"name", "color", "description"})
        if (in.contains(k) && in[k].is_string()) p[k] = in[k];
    if (in.contains("schema") && in["schema"].is_array()) p["schema"] = in["schema"];
    if (in.contains("open") && in["open"].is_boolean()) p["open"] = in["open"];  // Open/Restricted toggle (two-rule perms)
    if (p.empty()) return false;
    authorAndPublish(scala::ET::CAL_META, p, calId);
    return true;
}
// #3: grant/revoke a member by identity — role is "admin"|"viewer"|"remove". The fold
// admits this only if WE are owner/admin, so a viewer calling it is a no-op everywhere.
bool ScalaImpl::setMemberRole(const std::string& calId, const std::string& member, const std::string& role) {
    if (member.empty()) return false;
    authorAndPublish(scala::ET::MEMBER_SET, json{{"member", member}, {"role", role}}, calId);
    return true;
}
// #4: per-event edit history — every event.put/del touching this id, in log order,
// as [{author,at,action,payload}]. Reads the raw log (not the fold) so nothing collapses.
std::string ScalaImpl::getEventHistory(const std::string& calId, const std::string& eventId) {
    json out = json::array();
    for (const auto& e : m_store->log(calId)) {
        if (!e.payload.is_object() || e.payload.value("id", std::string()) != eventId) continue;
        std::string action = e.type == scala::ET::EVENT_DEL ? "deleted"
                           : (out.empty() ? "created" : "edited");
        out.push_back(json{{"author", e.dev}, {"at", e.hlc.wall}, {"action", action}, {"payload", e.payload}});
    }
    return out.dump();
}
std::string ScalaImpl::listCalendars() {
    ensureDelivery();   // kym self-drive
    json arr = json::array();
    for (const auto& c : m_store->calendars()) {
        json f = scala::foldCalendar(c.id, m_store->log(c.id));
        std::string nm = f.value("name", std::string()); if (nm.empty()) nm = c.name;
        std::string col = f.value("color", std::string()); if (col.empty()) col = c.color;
        arr.push_back(json{{"id", c.id}, {"name", nm}, {"color", col},
                           {"isShared", true}, {"encryptionKey", c.key}, {"creatorId", m_identity},
                           // #7/#8/#3: surface description, custom-field schema and roles to the view.
                           {"description", f.value("description", std::string())},
                           {"schema", f.value("schema", json::array())},
                           {"owner", f.value("owner", std::string())},
                           {"roles", f.value("roles", json::object())},
                           {"rolesConfigured", f.value("rolesConfigured", false)},
                           // Surface the Open/Restricted flag so the view's toggle + canAddTo see it
                           // (without this it reads `undefined` → always "open", and the toggle snaps back).
                           {"open", f.value("open", true)}});
    }
    return arr.dump();
}
bool ScalaImpl::deleteCalendar(const std::string& id) {
    m_sync->stopSync(id); m_store->removeCalendar(id); return true;
}

// ── events ───────────────────────────────────────────────────────────────────
std::string ScalaImpl::createEvent(const std::string& calendarId, const std::string& eventJson) {
    json p = json::parse(eventJson, nullptr, false);
    if (p.is_discarded() || !p.is_object()) return "";
    p["id"] = generateUuid();
    p.erase("calendarId"); p.erase("creatorId");   // set by the fold
    authorAndPublish(scala::ET::EVENT_PUT, p, calendarId);
    return p["id"].get<std::string>();
}
std::string ScalaImpl::createEventAt(const std::string& calendarId, const std::string& title,
                                     const std::string& startMs, const std::string& endMs) {
    long long start = 0, end = 0;
    try { start = std::stoll(startMs); } catch (...) { return ""; }
    try { end = endMs.empty() ? start + 3600000 : std::stoll(endMs); } catch (...) { end = start + 3600000; }
    json p;
    p["id"] = generateUuid();
    p["title"] = title;
    p["startTime"] = start;
    p["endTime"] = end;
    authorAndPublish(scala::ET::EVENT_PUT, p, calendarId);
    return p["id"].get<std::string>();
}
std::string ScalaImpl::updateEvent(const std::string& eventJson) {
    json p = json::parse(eventJson, nullptr, false);
    if (p.is_discarded() || !p.is_object() || !p.contains("id")) return "";
    std::string calId = p.value("calendarId", std::string());
    if (calId.empty()) return "";
    std::string id = p["id"].get<std::string>();
    p.erase("calendarId"); p.erase("creatorId");
    authorAndPublish(scala::ET::EVENT_PUT, p, calId);
    return id;
}
bool ScalaImpl::deleteEvent(const std::string& id) {
    // find which calendar owns the event (fold each calendar).
    for (const auto& c : m_store->calendars()) {
        json f = scala::foldCalendar(c.id, m_store->log(c.id));
        for (const auto& ev : f["events"])
            if (ev.value("id", std::string()) == id) {
                authorAndPublish(scala::ET::EVENT_DEL, json{{"id", id}}, c.id);
                return true;
            }
    }
    return false;
}
std::string ScalaImpl::listEvents(const std::string& calendarId) {
    ensureDelivery();
    json f = scala::foldCalendar(calendarId, m_store->log(calendarId));
    return f["events"].dump();
}
std::string ScalaImpl::getEvent(const std::string& id) {
    for (const auto& c : m_store->calendars()) {
        json f = scala::foldCalendar(c.id, m_store->log(c.id));
        for (const auto& ev : f["events"]) if (ev.value("id", std::string()) == id) return ev.dump();
    }
    return "{}";
}
std::string ScalaImpl::searchEvents(const std::string& query) {
    json out = json::array();
    std::string q = query; for (auto& ch : q) ch = tolower(ch);
    for (const auto& c : m_store->calendars()) {
        json f = scala::foldCalendar(c.id, m_store->log(c.id));
        for (const auto& ev : f["events"]) {
            std::string hay = ev.value("title", std::string()) + " " + ev.value("description", std::string()) + " " + ev.value("location", std::string());
            for (auto& ch : hay) ch = tolower(ch);
            if (hay.find(q) != std::string::npos) out.push_back(ev);
        }
    }
    return out.dump();
}
std::string ScalaImpl::getPendingReminders() { return "[]"; }

// ── sharing ──────────────────────────────────────────────────────────────────
std::string ScalaImpl::shareCalendar(const std::string& calendarId) {
    return m_store->calendar(calendarId).key;
}
bool ScalaImpl::joinSharedCalendar(const std::string& calendarId, const std::string& encryptionKey) {
    m_store->upsertCalendar({ calendarId, encryptionKey, "", "" });
    m_sync->startSync(calendarId, encryptionKey);
    sendSyncReq(calendarId);   // just joined an existing calendar → pull its history
    return true;
}
std::string ScalaImpl::getSyncStatus(const std::string& calendarId) {
    if (m_store->calendar(calendarId).id.empty()) return "not_shared";
    return m_sync->isSyncing(calendarId) ? "syncing" : "offline";
}
std::string ScalaImpl::generateShareLink(const std::string& calendarId) {
    scala::CalReg c = m_store->calendar(calendarId);
    if (c.id.empty() || c.key.empty()) return "";
    json f = scala::foldCalendar(c.id, m_store->log(c.id));
    std::string nm = f.value("name", std::string()); if (nm.empty()) nm = c.name;
    return "scala://join?id=" + urlEncode(c.id) + "&key=" + b64urlEncode(c.key) + "&name=" + urlEncode(nm);
}
std::string ScalaImpl::parseShareLink(const std::string& link) {
    if (link.rfind("scala://join", 0) != 0) return "";
    auto q = parseQuery(link);
    std::string id = q["id"], key = b64urlDecode(q["key"]), name = q["name"];
    if (id.empty() || key.empty()) return "";
    return json{{"id", id}, {"key", key}, {"name", name}}.dump();
}
bool ScalaImpl::handleShareLink(const std::string& link, const std::string& identityId) {
    std::string parsed = parseShareLink(link);
    if (parsed.empty()) return false;
    json j = json::parse(parsed, nullptr, false);
    std::string id = j.value("id", std::string()), key = j.value("key", std::string()), name = j.value("name", std::string());
    if (id.empty() || key.empty()) return false;
    m_store->upsertCalendar({ id, key, name, "" });
    m_sync->startSync(id, key);
    // Bind the chosen identity (loam ADR 0004) so YOUR events on this calendar are authored by it.
    // (The owner is the inviter; this only sets who signs the joiner's writes.) Empty → default.
    if (!identityId.empty()) { try { modules().loam_core.bindContainer(id, identityId); } catch (...) {} }
    sendSyncReq(id);   // just joined → pull history
    return true;
}

// ── settings ─────────────────────────────────────────────────────────────────
void ScalaImpl::setSetting(const std::string& key, const std::string& value) { m_store->kvSet("set:" + key, value); }
std::string ScalaImpl::getSetting(const std::string& key, const std::string& def) {
    std::string v = m_store->kvGet("set:" + key); return v.empty() ? def : v;
}

// ── QR (vendored qrcodegen → matrix; data: URIs are sandbox-blocked) ─────────
std::string ScalaImpl::qrMatrix(const std::string& text) {
    json out;
    if (text.empty()) { out["ok"] = false; out["error"] = "empty"; return out.dump(); }
    try {
        const qrcodegen::QrCode qr = qrcodegen::QrCode::encodeText(text.c_str(), qrcodegen::QrCode::Ecc::MEDIUM);
        const int n = qr.getSize();
        json cells = json::array();
        for (int y = 0; y < n; ++y) for (int x = 0; x < n; ++x) cells.push_back(qr.getModule(x, y) ? 1 : 0);
        out["ok"] = true; out["n"] = n; out["cells"] = std::move(cells);
    } catch (const std::exception& e) { out["ok"] = false; out["error"] = std::string("qr: ") + e.what(); }
    return out.dump();
}

// ── diagnostics ──────────────────────────────────────────────────────────────
std::string ScalaImpl::diagnostics() {
    ensureDelivery();
    json out;
    out["identity"] = m_identity;
    out["ctxReady"] = m_ctxReady;
    out["deliveryStatus"] = m_deliveryStatus;
    out["nodeReady"] = m_sync ? m_sync->ready() : false;
    out["dataDir"] = m_store ? m_store->dataDir() : std::string();
    json cals = json::array();
    int totalEvents = 0;
    for (const auto& c : m_store->calendars()) {
        json f = scala::foldCalendar(c.id, m_store->log(c.id));
        int n = (int)f["events"].size(); totalEvents += n;
        std::string nm = f.value("name", std::string()); if (nm.empty()) nm = c.name;
        cals.push_back(json{{"id", c.id}, {"name", nm}, {"shared", true},
                            {"syncing", m_sync ? m_sync->isSyncing(c.id) : false}, {"events", n}});
    }
    out["calendars"] = cals;
    out["calendarCount"] = (int)m_store->calendars().size();
    out["eventCount"] = totalEvents;
    return out.dump();
}

// unused legacy hook (kept to satisfy the header declaration).
void ScalaImpl::onSyncMessageReceived(const std::string&, const std::string&) {}
