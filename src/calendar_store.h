#pragma once

// CalendarStore — direct file-based persistence, modeled on qaku_core's proven
// qaku_persist_std storage (plain files in the data dir, robust no-throw readers).
// The previous implementation layered a Qt KV store + per-namespace key prefixes
// + id-index files; that indirection is what silently lost calendars across a
// restart. This version keeps everything in-memory and mirrors it to three JSON
// files under a STABLE $HOME data dir:
//     <dataDir>/calendars.json   – array of Calendar objects
//     <dataDir>/events.json      – array of CalendarEvent objects
//     <dataDir>/kv.json          – small key/value map (identity, settings)
// Every mutation writes its file atomically (temp + rename). A missing/corrupt
// file loads as empty and never throws — a bad file can't crash the module.
#include "types.h"

#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QMap>
#include <QString>
#include <QStringList>

class CalendarStore {
public:
    CalendarStore();
    ~CalendarStore() = default;

    // ── Calendar CRUD ────────────────────────────────────────────────────────
    QString saveCalendar(const scala::Calendar &cal);
    scala::Calendar getCalendar(const QString &id) const;
    QList<scala::Calendar> listCalendars() const;
    bool deleteCalendar(const QString &id);

    // ── Event CRUD ───────────────────────────────────────────────────────────
    QString saveEvent(const scala::CalendarEvent &ev);
    scala::CalendarEvent getEvent(const QString &id) const;
    QList<scala::CalendarEvent> listEvents(const QString &calendarId) const;
    bool updateEvent(const scala::CalendarEvent &ev);
    bool deleteEvent(const QString &id);

    // KV helpers (identity + settings)
    void kvSet(const QString &key, const QString &value) const;
    QString kvGet(const QString &key) const;
    void kvRemove(const QString &key) const;

    // Where state is persisted (surfaced in diagnostics).
    QString dataDir() const { return m_dataDir; }

    // Kept for API compatibility — a no-op now. Multi-instance isolation is via the
    // SCALA_CORE_DATA env var (a distinct data dir), not a key-prefix namespace.
    void setNamespace(const QString &) {}

private:
    QString m_dataDir;
    // In-memory authoritative state, mirrored to the JSON files on every write.
    QMap<QString, scala::Calendar> m_calendars;
    QMap<QString, scala::CalendarEvent> m_events;
    mutable QMap<QString, QString> m_kv;

    void load();
    void writeCalendars() const;
    void writeEvents() const;
    void writeKv() const;
    // Atomic JSON file write (temp + rename); robust JSON read (empty on missing/bad).
    static void writeJsonFile(const QString &path, const QJsonDocument &doc);
    static QJsonDocument readJsonFile(const QString &path);
};
