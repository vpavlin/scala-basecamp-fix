#include <set>
#include "calendar_store.h"

#include <fstream>
#include <sstream>
#include <filesystem>
#include <cstdlib>

namespace fs = std::filesystem;
using scala::json;

// Stable, writable data dir — the qaku pattern ($HOME/.qaku-core). Override with
// SCALA_CORE_DATA (multi-instance / tests). NOT QStandardPaths (transient in the
// Basecamp AppImage sandbox).
static std::string computeDataDir() {
    if (const char* e = std::getenv("SCALA_CORE_DATA")) if (*e) return e;
    if (const char* h = std::getenv("HOME")) if (*h) return std::string(h) + "/.scala-core";
    return "/tmp/.scala-core";
}
static bool ensureDir(const std::string& d) {
    if (d.empty()) return false;
    std::error_code ec; fs::create_directories(d, ec); return fs::exists(d, ec);
}
static json readJson(const std::string& path) {
    std::ifstream f(path);
    if (!f) return json();
    std::stringstream ss; ss << f.rdbuf();
    return json::parse(ss.str(), nullptr, false);   // no-throw; returns discarded on error
}
// Atomic write: temp then rename.
static void writeJson(const std::string& path, const json& j) {
    const std::string tmp = path + ".tmp";
    { std::ofstream f(tmp); if (!f) return; f << j.dump(); }
    std::error_code ec; fs::rename(tmp, path, ec);
    if (ec) { fs::remove(tmp, ec); }
}

CalendarStore::CalendarStore() {
    m_dataDir = computeDataDir();
    ensureDir(m_dataDir);
    ensureDir(m_dataDir + "/logs");
}

std::string CalendarStore::calFile() const { return m_dataDir + "/calendars.json"; }
std::string CalendarStore::logFile(const std::string& id) const { return m_dataDir + "/logs/" + id + ".json"; }
std::string CalendarStore::kvFile() const { return m_dataDir + "/kv.json"; }

// ── registry ─────────────────────────────────────────────────────────────────
std::vector<scala::CalReg> CalendarStore::calendars() const {
    std::vector<scala::CalReg> out;
    json arr = readJson(calFile());
    if (!arr.is_array()) return out;
    // Dedup by id (first-wins). upsertCalendar updates every matching row but never removes extras,
    // so a calendars.json that ever picked up duplicate ids (older builds / a write race) would render
    // each calendar N times forever. Collapsing here fixes the display immediately and, because
    // upsert/remove rewrite the file from this list, self-heals calendars.json on the next write.
    std::set<std::string> seen;
    for (auto& j : arr) {
        if (!j.is_object() || !j.contains("id")) continue;
        std::string id = j.value("id", std::string());
        if (id.empty() || !seen.insert(id).second) continue;
        out.push_back({ id, j.value("key", std::string()),
                        j.value("name", std::string()), j.value("color", std::string()) });
    }
    return out;
}
scala::CalReg CalendarStore::calendar(const std::string& id) const {
    for (auto& r : calendars()) if (r.id == id) return r;
    return {};
}
void CalendarStore::upsertCalendar(const scala::CalReg& r) {
    auto cals = calendars();
    bool found = false;
    for (auto& c : cals) if (c.id == r.id) {
        c.key = r.key.empty() ? c.key : r.key;
        if (!r.name.empty()) c.name = r.name;
        if (!r.color.empty()) c.color = r.color;
        found = true;
    }
    if (!found) cals.push_back(r);
    json arr = json::array();
    for (auto& c : cals) arr.push_back({{"id", c.id}, {"key", c.key}, {"name", c.name}, {"color", c.color}});
    writeJson(calFile(), arr);
}
void CalendarStore::removeCalendar(const std::string& id) {
    auto cals = calendars();
    json arr = json::array();
    for (auto& c : cals) if (c.id != id) arr.push_back({{"id", c.id}, {"key", c.key}, {"name", c.name}, {"color", c.color}});
    writeJson(calFile(), arr);
    std::error_code ec; fs::remove(logFile(id), ec);
}

// ── event log ────────────────────────────────────────────────────────────────
std::vector<scala::Event> CalendarStore::log(const std::string& calId) const {
    std::vector<scala::Event> out;
    json arr = readJson(logFile(calId));
    if (!arr.is_array()) return out;
    for (auto& j : arr) {
        try { scala::Event e = scala::eventFromJson(j); if (!e.id.empty()) out.push_back(e); }
        catch (...) { /* skip a bad entry */ }
    }
    return out;
}
void CalendarStore::writeLog(const std::string& calId, const std::vector<scala::Event>& evs) const {
    json arr = json::array();
    for (auto& e : evs) arr.push_back(scala::eventToJson(e));
    writeJson(logFile(calId), arr);
}
bool CalendarStore::appendEvent(const std::string& calId, const scala::Event& e) {
    if (e.id.empty()) return false;
    auto evs = log(calId);
    for (auto& x : evs) if (x.id == e.id) return false;   // dedup by id — idempotent redelivery
    evs.push_back(e);
    writeLog(calId, scala::mergeEvents(evs));              // keep HLC-sorted + unique
    return true;
}

// ── kv ───────────────────────────────────────────────────────────────────────
std::string CalendarStore::kvGet(const std::string& key) const {
    json o = readJson(kvFile());
    if (o.is_object() && o.contains(key) && o[key].is_string()) return o[key].get<std::string>();
    return {};
}
void CalendarStore::kvSet(const std::string& key, const std::string& value) {
    json o = readJson(kvFile());
    if (!o.is_object()) o = json::object();
    o[key] = value;
    writeJson(kvFile(), o);
}
