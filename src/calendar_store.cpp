#include "calendar_store.h"

#include <QDir>
#include <QFile>
#include <QSaveFile>
#include <QByteArray>

// Stable, writable data dir — the qaku pattern ($HOME/.qaku-core). NOT
// QStandardPaths::AppDataLocation (which resolves under the transient AppImage
// mount in the Basecamp sandbox — a different path every launch). Override with
// SCALA_CORE_DATA for multi-instance / tests.
static QString computeDataDir() {
    QByteArray env = qgetenv("SCALA_CORE_DATA");
    if (!env.isEmpty())
        return QString::fromUtf8(env);
    QByteArray home = qgetenv("HOME");
    return (home.isEmpty() ? QStringLiteral("/tmp") : QString::fromUtf8(home)) + QStringLiteral("/.scala-core");
}

CalendarStore::CalendarStore() {
    m_dataDir = computeDataDir();
    QDir().mkpath(m_dataDir);
    load();
}

// ── robust JSON file I/O (never throws) ──────────────────────────────────────
void CalendarStore::writeJsonFile(const QString &path, const QJsonDocument &doc) {
    QSaveFile f(path);                       // QSaveFile = atomic (temp + commit)
    if (!f.open(QIODevice::WriteOnly))
        return;
    f.write(doc.toJson(QJsonDocument::Compact));
    f.commit();
}

QJsonDocument CalendarStore::readJsonFile(const QString &path) {
    QFile f(path);
    if (!f.exists() || !f.open(QIODevice::ReadOnly))
        return {};
    const QByteArray raw = f.readAll();
    f.close();
    QJsonParseError err{};
    QJsonDocument doc = QJsonDocument::fromJson(raw, &err);   // no-throw
    if (err.error != QJsonParseError::NoError)
        return {};
    return doc;
}

void CalendarStore::load() {
    // calendars.json
    QJsonDocument cd = readJsonFile(m_dataDir + QStringLiteral("/calendars.json"));
    if (cd.isArray()) {
        for (const QJsonValue &v : cd.array()) {
            if (!v.isObject()) continue;
            scala::Calendar c = scala::Calendar::fromJson(v.toObject());
            if (!c.id.isEmpty()) m_calendars.insert(c.id, c);
        }
    }
    // events.json
    QJsonDocument ed = readJsonFile(m_dataDir + QStringLiteral("/events.json"));
    if (ed.isArray()) {
        for (const QJsonValue &v : ed.array()) {
            if (!v.isObject()) continue;
            scala::CalendarEvent e = scala::CalendarEvent::fromJson(v.toObject());
            if (!e.id.isEmpty()) m_events.insert(e.id, e);
        }
    }
    // kv.json
    QJsonDocument kd = readJsonFile(m_dataDir + QStringLiteral("/kv.json"));
    if (kd.isObject()) {
        const QJsonObject o = kd.object();
        for (auto it = o.constBegin(); it != o.constEnd(); ++it)
            m_kv.insert(it.key(), it.value().toString());
    }
}

void CalendarStore::writeCalendars() const {
    QJsonArray arr;
    for (const scala::Calendar &c : m_calendars) arr.append(c.toJson());
    writeJsonFile(m_dataDir + QStringLiteral("/calendars.json"), QJsonDocument(arr));
}
void CalendarStore::writeEvents() const {
    QJsonArray arr;
    for (const scala::CalendarEvent &e : m_events) arr.append(e.toJson());
    writeJsonFile(m_dataDir + QStringLiteral("/events.json"), QJsonDocument(arr));
}
void CalendarStore::writeKv() const {
    QJsonObject o;
    for (auto it = m_kv.constBegin(); it != m_kv.constEnd(); ++it) o.insert(it.key(), it.value());
    writeJsonFile(m_dataDir + QStringLiteral("/kv.json"), QJsonDocument(o));
}

// ── Calendar CRUD ────────────────────────────────────────────────────────────
QString CalendarStore::saveCalendar(const scala::Calendar &cal) {
    m_calendars.insert(cal.id, cal);
    writeCalendars();
    return cal.id;
}
scala::Calendar CalendarStore::getCalendar(const QString &id) const {
    return m_calendars.value(id);   // default-constructed (empty id) if missing
}
QList<scala::Calendar> CalendarStore::listCalendars() const {
    return m_calendars.values();
}
bool CalendarStore::deleteCalendar(const QString &id) {
    if (!m_calendars.contains(id)) return false;
    m_calendars.remove(id);
    // drop its events too
    for (auto it = m_events.begin(); it != m_events.end();) {
        if (it.value().calendarId == id) it = m_events.erase(it);
        else ++it;
    }
    writeCalendars();
    writeEvents();
    return true;
}

// ── Event CRUD ─────────────────────────────────────────────────────────────
QString CalendarStore::saveEvent(const scala::CalendarEvent &ev) {
    m_events.insert(ev.id, ev);
    writeEvents();
    return ev.id;
}
scala::CalendarEvent CalendarStore::getEvent(const QString &id) const {
    return m_events.value(id);
}
QList<scala::CalendarEvent> CalendarStore::listEvents(const QString &calendarId) const {
    QList<scala::CalendarEvent> out;
    for (const scala::CalendarEvent &e : m_events)
        if (e.calendarId == calendarId) out.append(e);
    return out;
}
bool CalendarStore::updateEvent(const scala::CalendarEvent &ev) {
    m_events.insert(ev.id, ev);
    writeEvents();
    return true;
}
bool CalendarStore::deleteEvent(const QString &id) {
    if (!m_events.contains(id)) return false;
    m_events.remove(id);
    writeEvents();
    return true;
}

// ── KV (identity + settings) ─────────────────────────────────────────────────
void CalendarStore::kvSet(const QString &key, const QString &value) const {
    m_kv.insert(key, value);
    writeKv();
}
QString CalendarStore::kvGet(const QString &key) const {
    return m_kv.value(key);
}
void CalendarStore::kvRemove(const QString &key) const {
    m_kv.remove(key);
    writeKv();
}
