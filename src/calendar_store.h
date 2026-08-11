#pragma once
// CalendarStore — CRDT log storage, modeled on qaku_persist_std. A calendar is a
// membership entry (id + key) in the registry; its state lives in an append-only
// EVENT LOG (one channel per calendar). Reads fold the log (scala_engine). Plain
// files under a stable $HOME data dir, robust no-throw:
//     <dataDir>/calendars.json     – registry: [{id,key,name,color}] (membership)
//     <dataDir>/logs/<calId>.json  – that calendar's append-only event log
//     <dataDir>/kv.json            – identity / device id / settings
#include "scala_engine.hpp"
#include <string>
#include <vector>

namespace scala {
struct CalReg { std::string id, key, name, color; };
}

class CalendarStore {
public:
    CalendarStore();

    std::string dataDir() const { return m_dataDir; }

    // ── registry (membership) ────────────────────────────────────────────────
    std::vector<scala::CalReg> calendars() const;
    scala::CalReg calendar(const std::string& id) const;   // empty id if unknown
    void upsertCalendar(const scala::CalReg& r);
    void removeCalendar(const std::string& id);            // + delete its log

    // ── per-calendar event log ──────────────────────────────────────────────
    std::vector<scala::Event> log(const std::string& calId) const;
    // Merge one event into the log (dedup by id), persist. Returns true if NEW.
    bool appendEvent(const std::string& calId, const scala::Event& e);

    // ── kv (identity, device id, settings) ──────────────────────────────────
    std::string kvGet(const std::string& key) const;
    void kvSet(const std::string& key, const std::string& value);

private:
    std::string m_dataDir;
    std::string calFile() const;
    std::string logFile(const std::string& id) const;
    std::string kvFile() const;
    void writeLog(const std::string& calId, const std::vector<scala::Event>& evs) const;
};
