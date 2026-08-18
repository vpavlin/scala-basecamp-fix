// Scala calendar — pure-QML view over the `scala` core module.
//
// Rewritten from scratch to render correctly on the Logos design system that
// Basecamp bundles (Perun's view is the reference): only LogosText + LogosButton
// (the safe component baseline), Theme.palette.* / Theme.spacing.* tokens, and
// NUMERIC font.pixelSize (Theme.typography.<size> tokens don't exist on the
// bundled DS — that was the old view's invisible text). Inputs use plain
// TextField styled with tokens. Feature parity with the Android app: month grid,
// per-day events, event create/edit/delete, calendar create/join/share.
//
// The core is reached with a synchronous logos.callModule shim; returns come back
// DOUBLE-JSON-encoded, so `j()` unwraps up to twice.
import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

import Logos.Theme
import Logos.Controls

Item {
    id: root
    width: 900
    height: 640

    // ── core bridge ──────────────────────────────────────────────────────────
    property bool ready: false
    function core(method, args) {
        if (typeof logos === "undefined" || !logos.callModule) return ""
        var r = logos.callModule("scala", method, args || [])
        return (r === undefined || r === null) ? "" : (typeof r === "string" ? r : r)
    }
    function j(raw, fallback) {
        var v = raw
        for (var i = 0; i < 3 && typeof v === "string"; i++) {
            var t = v.trim()
            if (t === "") return fallback
            try { v = JSON.parse(t) } catch (e) { return (i === 0 ? fallback : v) }
        }
        return (v === undefined || v === null) ? fallback : v
    }
    // Identity SERVICE lives in loam_core (loam ADR 0004) — the panel talks to it directly.
    function loamCore(method, args) {
        if (typeof logos === "undefined" || !logos.callModule) return ""
        try { var r = logos.callModule("loam_core", method, args || []); return (r === undefined || r === null) ? "" : r } catch (e) { return "" }
    }

    // ── identities (loam_core service; UI is ours) ─────────────────────────────
    property var identities: []            // [{id,kind,label,address,pubHex}]
    property string defaultIdentityId: "device"
    function refreshIdentities() {
        identities = root.j(loamCore("listIdentities", []), [])
        defaultIdentityId = root.j(loamCore("getDefaultIdentityId", []), "device")
    }
    function identityLabel(id) {
        for (var i = 0; i < identities.length; i++) if (identities[i].id === id) return identities[i].label
        return id
    }
    function calendarIdentityId(calId) {
        var m = root.j(loamCore("identityForContainer", [calId]), null)
        return m && m.id ? m.id : root.defaultIdentityId
    }

    // ── state ────────────────────────────────────────────────────────────────
    property var calendars: []          // [{id,name,color,encryptionKey,...}]
    property var events: []             // flat list across all calendars
    property date viewMonth: new Date()   // any date in the shown month
    property date selectedDay: new Date()
    property string filterCalId: ""      // "" = all calendars
    property string myIdentity: ""       // this device's identity (event author id)

    readonly property var fieldTypes: ["text","longtext","number","date","datetime","bool","url","enum","color"]

    readonly property var monthNames: ["January","February","March","April","May","June","July","August","September","October","November","December"]
    readonly property var weekDays: ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"]

    Component.onCompleted: Qt.callLater(function () {
        root.ready = (typeof logos !== "undefined" && !!logos.callModule)
        if (root.ready) { root.myIdentity = String(root.j(root.core("getIdentity", []), "")); refresh() }
    })

    // Poll like kym's view does: listCalendars() self-drives the delivery bootstrap
    // in the core, so this keeps the node coming up + refreshes data. Also refreshes
    // the diagnostics while the Debug panel is open.
    Timer {
        interval: 3000; running: true; repeat: true
        onTriggered: {
            if (!root.ready) return
            root.refresh()
            root.computeSoon()
            if (diagPopup.visible) root.diag = root.j(root.core("diagnostics", []), null)
        }
    }

    // ── data ─────────────────────────────────────────────────────────────────
    function refresh() {
        if (!root.ready) return
        refreshIdentities()
        calendars = j(core("listCalendars", []), [])
        var all = []
        for (var i = 0; i < calendars.length; i++) {
            var evs = j(core("listEvents", [calendars[i].id]), [])
            for (var k = 0; k < evs.length; k++) all.push(evs[k])
        }
        events = all
    }
    // Deterministic color derived from the calendar id — SAME on desktop + mobile,
    // so a calendar looks consistent across devices regardless of a stored color.
    readonly property var calPalette: ["#a6e3a1","#89b4fa","#f9e2af","#f38ba8","#cba6f7","#94e2d5","#fab387","#74c7ec","#eba0ac","#b4befe"]
    function calColor(calId) {
        if (!calId) return Theme.palette.primary
        var h = 0
        for (var i = 0; i < calId.length; i++) h = (h * 31 + calId.charCodeAt(i)) >>> 0
        return root.calPalette[h % root.calPalette.length]
    }
    function calName(calId) {
        for (var i = 0; i < calendars.length; i++) if (calendars[i].id === calId) return calendars[i].name
        return ""
    }
    function writableCalendars() {
        var out = []
        for (var i = 0; i < calendars.length; i++) if (calendars[i].encryptionKey || calendars[i].creatorId !== undefined) out.push(calendars[i])
        return out.length ? out : calendars
    }
    function calById(id) {
        for (var i = 0; i < calendars.length; i++) if (calendars[i].id === id) return calendars[i]
        return null
    }
    // Schema for a calendar, always an array (missing/empty → []).
    function schemaFor(calId) {
        var c = calById(calId)
        return (c && c.schema && c.schema.length) ? c.schema : []
    }
    // Short, human-friendly form of an identity string for history/roles lines.
    function shortAuthor(a) {
        if (!a) return "?"
        var s = String(a)
        if (s.indexOf("scala-") === 0) s = s.substring(6)
        return s.substring(0, 6)
    }
    function sameDay(a, b) {
        return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
    }
    // Events filtered by the active calendar filter (null-safe on old events).
    function eventsFiltered() {
        if (filterCalId === "") return events
        var out = []
        for (var i = 0; i < events.length; i++) if (events[i].calendarId === filterCalId) out.push(events[i])
        return out
    }
    // Look up a master event by id (recurrence edits operate on the master).
    function eventById(id) {
        for (var i = 0; i < events.length; i++) if (events[i].id === id) return events[i]
        return null
    }

    // ── recurrence expansion (identical algorithm to the mobile app) ───────────
    function expandEvent(ev, winStart, winEnd) {
        var dur = Math.max(0, (ev.endTime || ev.startTime) - ev.startTime);
        var r = ev.recur;
        function mk(s){ var o={}; for (var k in ev) o[k]=ev[k]; o.startTime=s; o.endTime=s+dur; o.seriesId=ev.id; o.occ=s; return o; }
        if (!r || !r.freq) return (ev.startTime+dur>=winStart && ev.startTime<=winEnd) ? [mk(ev.startTime)] : [];
        var interval = Math.max(1, Math.floor(r.interval||1));
        var hardUntil = (typeof r.until === "number") ? r.until : Infinity;
        var out=[]; var cur=new Date(ev.startTime);
        for (var i=0;i<500;i++){
            var s=cur.getTime();
            if (s>hardUntil || s>winEnd) break;
            if (s+dur>=winStart) out.push(mk(s));
            if (r.freq==="daily") cur.setDate(cur.getDate()+interval);
            else if (r.freq==="weekly") cur.setDate(cur.getDate()+7*interval);
            else if (r.freq==="monthly") cur.setMonth(cur.getMonth()+interval);
            else if (r.freq==="yearly") cur.setFullYear(cur.getFullYear()+interval);
            else break;
        }
        return out;
    }
    function expandEvents(events, winStart, winEnd) {
        var out=[]; for (var i=0;i<events.length;i++){ var xs=expandEvent(events[i], winStart, winEnd); for (var k=0;k<xs.length;k++) out.push(xs[k]); }
        out.sort(function(a,b){return a.startTime-b.startTime;}); return out;
    }
    function recurLabel(r){ if(!r||!r.freq) return "Does not repeat"; var n=Math.max(1,Math.floor(r.interval||1)); var u={daily:"day",weekly:"week",monthly:"month",yearly:"year"}[r.freq]; var b=(n===1?("Every "+u):("Every "+n+" "+u+"s")); return r.until?(b+", until "+new Date(r.until).toLocaleDateString()):b; }

    // Cached expansion covering the whole visible 6×7 grid; re-evaluates when the
    // month, event set, or calendar filter changes.
    property var monthOccurrences: root.computeMonthOccurrences(root.viewMonth, root.events, root.filterCalId)
    function computeMonthOccurrences(vm, evs, fcal) {
        var first = new Date(vm.getFullYear(), vm.getMonth(), 1)
        var offset = (first.getDay() + 6) % 7
        var firstCell = new Date(first.getFullYear(), first.getMonth(), 1 - offset)
        var ws = new Date(firstCell.getFullYear(), firstCell.getMonth(), firstCell.getDate(), 0, 0, 0, 0).getTime()
        var we = ws + 42 * 24 * 3600 * 1000 - 1
        var src = evs
        if (fcal !== "") { src = []; for (var i = 0; i < evs.length; i++) if (evs[i].calendarId === fcal) src.push(evs[i]) }
        return root.expandEvents(src, ws, we)
    }

    function eventsOnDay(d) {
        var ds = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime()
        var de = ds + 24 * 3600 * 1000 - 1
        var occ = expandEvents(eventsFiltered(), ds, de)
        var out = []
        for (var i = 0; i < occ.length; i++) if (sameDay(new Date(occ[i].startTime), d)) out.push(occ[i])
        return out
    }
    function dotsOnDay(d) {
        var cols = []
        var occ = root.monthOccurrences
        for (var i = 0; i < occ.length && cols.length < 4; i++)
            if (sameDay(new Date(occ[i].startTime), d)) cols.push(calColor(occ[i].calendarId))
        return cols
    }
    function fmtTime(ms) { return Qt.formatTime(new Date(ms), "hh:mm") }
    function pad(n) { return (n < 10 ? "0" : "") + n }
    function fmtDateInput(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) }
    function fmtTimeInput(d) { return pad(d.getHours()) + ":" + pad(d.getMinutes()) }
    function parseDateTime(dateStr, timeStr) {
        var dp = dateStr.split("-"), tp = timeStr.split(":")
        var d = new Date()
        if (dp.length === 3) d = new Date(parseInt(dp[0]), parseInt(dp[1]) - 1, parseInt(dp[2]))
        d.setHours(tp.length >= 1 ? parseInt(tp[0]) || 0 : 0, tp.length >= 2 ? parseInt(tp[1]) || 0 : 0, 0, 0)
        return d
    }

    // ── layout ───────────────────────────────────────────────────────────────
    Rectangle { anchors.fill: parent; color: Theme.palette.background }

    // ── "starting soon" banner (in-app substitute for desktop notifications) ──
    property var soonOcc: null          // the imminent occurrence, or null
    property string soonText: ""        // "<title> starts in <N> min"
    property bool soonVisible: false
    property real dismissedOcc: -1      // occ timestamp the user dismissed
    function computeSoon() {
        var now = Date.now()
        var occ = root.expandEvents(root.events, now, now + 15 * 60000)
        var best = null
        for (var i = 0; i < occ.length; i++) { if (occ[i].startTime >= now) { best = occ[i]; break } }
        if (best && best.occ !== root.dismissedOcc) {
            var mins = Math.max(0, Math.round((best.startTime - now) / 60000))
            root.soonText = (best.title || "(untitled)") + " starts in " + mins + " min"
            root.soonOcc = best
            root.soonVisible = true
        } else {
            root.soonOcc = best
            root.soonVisible = false
        }
    }

    Rectangle {
        id: soonBanner
        anchors.top: parent.top; anchors.left: parent.left; anchors.right: parent.right
        height: (root.soonVisible && root.soonText.length > 0) ? 40 : 0
        visible: height > 0
        clip: true
        color: Theme.palette.primary
        RowLayout {
            anchors.fill: parent
            anchors.leftMargin: Theme.spacing.medium; anchors.rightMargin: Theme.spacing.small
            spacing: Theme.spacing.small
            Rectangle { width: 8; height: 8; radius: 4; color: Theme.palette.background; Layout.alignment: Qt.AlignVCenter }
            LogosText {
                text: root.soonText; color: Theme.palette.background
                font.pixelSize: 13; font.weight: Theme.typography.weightMedium
                Layout.fillWidth: true; elide: Text.ElideRight; Layout.alignment: Qt.AlignVCenter
            }
            LogosText {
                text: "✕"; color: Theme.palette.background; font.pixelSize: 14; Layout.alignment: Qt.AlignVCenter
                MouseArea {
                    anchors.fill: parent; anchors.margins: -6
                    onClicked: {
                        if (root.soonOcc) root.dismissedOcc = root.soonOcc.occ
                        root.soonVisible = false
                    }
                }
            }
        }
    }

    // 3 resizable panes: calendars | month | agenda. Drag the dividers to resize.
    SplitView {
        anchors.top: soonBanner.bottom; anchors.left: parent.left
        anchors.right: parent.right; anchors.bottom: parent.bottom
        orientation: Qt.Horizontal

        // ── pane 1: calendars sidebar ──────────────────────────────────────
        Rectangle {
            SplitView.preferredWidth: 240
            SplitView.minimumWidth: 170
            color: Theme.palette.backgroundInset
            ColumnLayout {
                anchors.fill: parent
                anchors.margins: Theme.spacing.medium
                spacing: Theme.spacing.small

                LogosText { text: "Calendars"; color: Theme.palette.text; font.pixelSize: 18; font.weight: Theme.typography.weightMedium }

                Rectangle {
                    Layout.fillWidth: true; height: 34; radius: Theme.spacing.radiusSmall
                    color: root.filterCalId === "" ? Theme.palette.backgroundSecondary : "transparent"
                    RowLayout {
                        anchors.fill: parent; anchors.leftMargin: Theme.spacing.small; anchors.rightMargin: Theme.spacing.small; spacing: Theme.spacing.small
                        Rectangle { width: 12; height: 12; radius: 6; color: Theme.palette.textTertiary }
                        LogosText { text: "All calendars"; color: Theme.palette.text; font.pixelSize: 14; Layout.fillWidth: true; elide: Text.ElideRight }
                    }
                    MouseArea { anchors.fill: parent; onClicked: root.filterCalId = "" }
                }

                ListView {
                    Layout.fillWidth: true; Layout.fillHeight: true; clip: true
                    model: root.calendars
                    spacing: 2
                    delegate: Rectangle {
                        width: ListView.view.width
                        height: (modelData.description && modelData.description.length > 0) ? 48 : 34
                        radius: Theme.spacing.radiusSmall
                        color: root.filterCalId === modelData.id ? Theme.palette.backgroundSecondary : "transparent"
                        RowLayout {
                            anchors.fill: parent; anchors.leftMargin: Theme.spacing.small; anchors.rightMargin: Theme.spacing.small; spacing: Theme.spacing.small
                            Rectangle { width: 12; height: 12; radius: 6; color: root.calColor(modelData.id); Layout.alignment: Qt.AlignVCenter }
                            ColumnLayout {
                                Layout.fillWidth: true; Layout.alignment: Qt.AlignVCenter; spacing: 1
                                LogosText { text: modelData.name || "(unnamed)"; color: Theme.palette.text; font.pixelSize: 14; Layout.fillWidth: true; elide: Text.ElideRight }
                                LogosText {
                                    visible: !!modelData.description && modelData.description.length > 0
                                    text: modelData.description || ""
                                    color: Theme.palette.textTertiary; font.pixelSize: 11; Layout.fillWidth: true; elide: Text.ElideRight
                                }
                            }
                            LogosText {
                                text: "⚙"; color: Theme.palette.textSecondary; font.pixelSize: 14; Layout.alignment: Qt.AlignVCenter
                                MouseArea { anchors.fill: parent; anchors.margins: -4; onClicked: root.openCalSettings(modelData) }
                            }
                            LogosText {
                                text: "share"; color: Theme.palette.primary; font.pixelSize: 12; Layout.alignment: Qt.AlignVCenter
                                MouseArea { anchors.fill: parent; onClicked: root.openShare(modelData) }
                            }
                            LogosText {
                                text: "✕"; color: Theme.palette.textTertiary; font.pixelSize: 14; Layout.alignment: Qt.AlignVCenter
                                MouseArea {
                                    anchors.fill: parent; anchors.margins: -4
                                    onClicked: root.confirmDeleteCalendar(modelData)
                                }
                            }
                        }
                        MouseArea { anchors.fill: parent; z: -1; onClicked: root.filterCalId = modelData.id }
                    }
                }

                LogosButton { Layout.fillWidth: true; text: "+ New calendar"; onClicked: newCalPopup.open() }
                LogosButton { Layout.fillWidth: true; text: "Join calendar"; onClicked: joinPopup.open() }
                LogosButton { Layout.fillWidth: true; text: "👤 Identities"; onClicked: { root.refreshIdentities(); identitiesPopup.open() } }
            }
        }

        // ── pane 2: month ──────────────────────────────────────────────────
        ColumnLayout {
            SplitView.fillWidth: true
            SplitView.minimumWidth: 380
            spacing: 0

            RowLayout {
                Layout.fillWidth: true
                Layout.margins: Theme.spacing.medium
                spacing: Theme.spacing.small
                LogosButton { text: "‹"; onClicked: root.viewMonth = new Date(root.viewMonth.getFullYear(), root.viewMonth.getMonth() - 1, 1) }
                LogosText {
                    text: root.monthNames[root.viewMonth.getMonth()] + " " + root.viewMonth.getFullYear()
                    color: Theme.palette.text; font.pixelSize: 20; font.weight: Theme.typography.weightMedium
                    Layout.minimumWidth: 160
                }
                LogosButton { text: "›"; onClicked: root.viewMonth = new Date(root.viewMonth.getFullYear(), root.viewMonth.getMonth() + 1, 1) }
                LogosButton { text: "Today"; onClicked: { var n = new Date(); root.viewMonth = n; root.selectedDay = n } }
                Item { Layout.fillWidth: true }
                LogosButton { text: "Debug"; onClicked: root.openDiag() }
                LogosButton { text: "+ Event"; onClicked: root.openNewEvent() }
            }

            RowLayout {
                Layout.fillWidth: true; Layout.leftMargin: Theme.spacing.medium; Layout.rightMargin: Theme.spacing.medium; spacing: 2
                Repeater {
                    model: root.weekDays
                    LogosText { text: modelData; color: Theme.palette.textTertiary; font.pixelSize: 11; horizontalAlignment: Text.AlignHCenter; Layout.fillWidth: true }
                }
            }

            GridLayout {
                id: grid
                Layout.fillWidth: true; Layout.fillHeight: true   // month fills the pane now
                Layout.leftMargin: Theme.spacing.medium; Layout.rightMargin: Theme.spacing.medium
                Layout.topMargin: 4; Layout.bottomMargin: Theme.spacing.medium
                columns: 7; rowSpacing: 2; columnSpacing: 2

                Repeater {
                    model: 42
                    delegate: Rectangle {
                        id: cell
                        Layout.fillWidth: true; Layout.fillHeight: true
                        radius: Theme.spacing.radiusSmall
                        property date cellDate: {
                            var first = new Date(root.viewMonth.getFullYear(), root.viewMonth.getMonth(), 1)
                            var offset = (first.getDay() + 6) % 7
                            return new Date(first.getFullYear(), first.getMonth(), 1 - offset + index)
                        }
                        property bool inMonth: cellDate.getMonth() === root.viewMonth.getMonth()
                        property bool isToday: root.sameDay(cellDate, new Date())
                        property bool isSel: root.sameDay(cellDate, root.selectedDay)
                        color: isSel ? Theme.palette.backgroundSecondary : Theme.palette.backgroundInset
                        border.width: isSel ? 1 : 0
                        border.color: Theme.palette.primary

                        Column {
                            anchors.left: parent.left; anchors.top: parent.top; anchors.margins: 5; spacing: 3
                            LogosText {
                                text: cell.cellDate.getDate()
                                color: cell.isToday ? Theme.palette.primary : (cell.inMonth ? Theme.palette.text : Theme.palette.textTertiary)
                                font.pixelSize: 13
                                font.weight: cell.isToday ? Theme.typography.weightMedium : Font.Normal
                            }
                            Row {
                                spacing: 2
                                Repeater {
                                    model: root.dotsOnDay(cell.cellDate)
                                    Rectangle { width: 6; height: 6; radius: 3; color: modelData }
                                }
                            }
                        }
                        MouseArea { anchors.fill: parent; onClicked: root.selectedDay = cell.cellDate }
                    }
                }
            }
        }

        // ── pane 3: agenda (resizable) ─────────────────────────────────────
        Rectangle {
            SplitView.preferredWidth: 320
            SplitView.minimumWidth: 220
            color: Theme.palette.backgroundInset
            ColumnLayout {
                anchors.fill: parent
                anchors.margins: Theme.spacing.medium
                spacing: Theme.spacing.small

                LogosText {
                    text: Qt.formatDate(root.selectedDay, "dddd")
                    color: Theme.palette.text; font.pixelSize: 18; font.weight: Theme.typography.weightMedium
                }
                LogosText {
                    text: Qt.formatDate(root.selectedDay, "MMMM d, yyyy")
                    color: Theme.palette.textSecondary; font.pixelSize: 13
                }
                Rectangle { Layout.fillWidth: true; height: 1; color: Theme.palette.borderHairline }

                Item {
                    Layout.fillWidth: true; Layout.fillHeight: true
                    ListView {
                        id: dayList
                        anchors.fill: parent; clip: true
                        model: root.eventsOnDay(root.selectedDay)
                        spacing: Theme.spacing.small
                        delegate: Rectangle {
                            width: dayList.width; height: 62; radius: Theme.spacing.radiusMedium
                            color: Theme.palette.backgroundSecondary
                            RowLayout {
                                anchors.fill: parent; anchors.margins: Theme.spacing.small; spacing: Theme.spacing.small
                                Rectangle { width: 5; height: 42; radius: 3; color: root.calColor(modelData.calendarId); Layout.alignment: Qt.AlignVCenter }
                                ColumnLayout {
                                    Layout.fillWidth: true; spacing: 2
                                    LogosText { text: modelData.title || "(untitled)"; color: Theme.palette.text; font.pixelSize: 14; font.weight: Theme.typography.weightMedium; elide: Text.ElideRight; Layout.fillWidth: true }
                                    LogosText {
                                        text: root.fmtTime(modelData.startTime) + " – " + root.fmtTime(modelData.endTime)
                                        color: Theme.palette.textSecondary; font.pixelSize: 12; elide: Text.ElideRight; Layout.fillWidth: true
                                    }
                                    LogosText {
                                        text: root.calName(modelData.calendarId); visible: text.length > 0
                                        color: root.calColor(modelData.calendarId); font.pixelSize: 11; elide: Text.ElideRight; Layout.fillWidth: true
                                    }
                                }
                            }
                            MouseArea { anchors.fill: parent; onClicked: root.openEditEvent(modelData) }
                        }
                    }
                    LogosText {
                        anchors.centerIn: parent; width: parent.width - 20
                        visible: dayList.count === 0
                        text: "No events on this day.\nClick “+ Event” to add one."
                        horizontalAlignment: Text.AlignHCenter; wrapMode: Text.WordWrap
                        color: Theme.palette.textTertiary; font.pixelSize: 13
                    }
                }
            }
        }
    }

    // ── event editor popup ─────────────────────────────────────────────────
    property var editingEvent: null       // null = creating
    property string editCalId: ""
    property string lastCalId: ""           // remember last calendar an event was created in → preselect it
    property var evCals: []                 // cached writable-calendar list for the event modal's picker (stable → currentIndex resolves)
    // Two-rule permissions (mirror the fold): owner/editors do anything; viewers read-only;
    // everyone else may ADD iff Open, and edit/delete only the events they authored.
    function isEditorMe(c) { if (!c) return true; if (c.owner === myIdentity) return true; var r = c.roles || {}; return r[myIdentity] === "editor" || r[myIdentity] === "admin" }
    function isViewerMe(c) { return !!c && (c.roles || {})[myIdentity] === "viewer" }
    function canAddTo(c) { if (isEditorMe(c)) return true; if (isViewerMe(c)) return false; return !c || c.open !== false }
    function canEditEvent(c, ev) { if (isEditorMe(c)) return true; if (isViewerMe(c)) return false; return !!ev && ev.creatorId === myIdentity }
    // Event editor read-only: a NEW event needs add rights; an EXISTING event needs edit
    // rights on THAT event (yours, or you're an editor). Reactive to editCalId/editingEvent.
    readonly property bool eventReadOnly: editingEvent ? !canEditEvent(calById(editCalId), editingEvent) : !canAddTo(calById(editCalId))
    // Human "why can't I edit this" (ADR 0013). Desktop is single-identity, so the signing address
    // is myIdentity; when desktop gains per-calendar identities, resolve the bound one here.
    function readonlyReason(c, ev) {
        if (!c) return ""
        var a = myIdentity
        if (isViewerMe(c)) return "You're a viewer on \"" + c.name + "\" — read-only."
        if (ev && ev.creatorId && !isEditorMe(c) && ev.creatorId !== a)
            return "Only the author can edit this event (created by " + shortAuthor(ev.creatorId) + "). You're signing as " + shortAuthor(a) + "."
        if (c.owner && a !== c.owner && !isEditorMe(c))
            return "This calendar is owned by " + shortAuthor(c.owner) + ", but you're signing as " + shortAuthor(a) + ". If that owner was a Keycard re-enrolled at a new path, its address changed and this calendar is orphaned — make a new one, or bind an identity that owns/edits it."
        if (c.open === false && !isEditorMe(c))
            return "\"" + c.name + "\" is closed — only its owner/editors can add events. You're signing as " + shortAuthor(a) + "."
        return "You can't write to \"" + c.name + "\" as " + shortAuthor(a) + "."
    }
    // Inline validation — empty string == valid. Bound to the Save button + an error line.
    function eventError() {
        if (evTitle.text.trim() === "") return "Title is required."
        if (!/^\d{4}-\d{2}-\d{2}$/.test(evDate.text.trim())) return "Date must be YYYY-MM-DD."
        if (!root.evAllDay) {
            if (!/^\d{1,2}:\d{2}$/.test(evStart.text.trim())) return "Start time must be HH:MM."
            if (!/^\d{1,2}:\d{2}$/.test(evEnd.text.trim())) return "End time must be HH:MM."
        }
        return ""
    }
    property var evHistory: []             // getEventHistory result while editing

    // ── richer-editor state (null-safe: absent on old events) ──
    property bool evAllDay: false
    property int evReminder: 10           // minutes before; 0 = none
    property string evRecurFreq: ""       // "" = does not repeat | daily/weekly/monthly/yearly
    readonly property var reminderOpts: [{ l: "None", v: 0 }, { l: "10 min", v: 10 }, { l: "30 min", v: 30 }, { l: "1 hour", v: 60 }, { l: "1 day", v: 1440 }]
    readonly property var recurOpts: [{ l: "Does not repeat", v: "" }, { l: "Daily", v: "daily" }, { l: "Weekly", v: "weekly" }, { l: "Monthly", v: "monthly" }, { l: "Yearly", v: "yearly" }]
    // Build the recur object from the current editor controls (null when "Does not repeat").
    function buildRecur() {
        if (!root.evRecurFreq) return null
        var n = Math.max(1, Math.floor(parseInt(evRecurInterval.text) || 1))
        var o = { freq: root.evRecurFreq, interval: n }
        var u = evRecurUntil.text.trim()
        if (u !== "") { var t = Date.parse(u); if (!isNaN(t)) o.until = t }
        return o
    }
    // True when the event being edited is (part of) a recurring series.
    function editingRecurring() {
        return root.editingEvent && root.editingEvent.recur && root.editingEvent.recur.freq
    }

    // Populate evFieldsModel (declared in the event popup) from the calendar's schema,
    // seeding each row from the event's stored `fields`. Clearing+refilling recreates
    // the Repeater delegates, so every open gets fresh reactive bindings.
    function seedFieldVals(calId, ev) {
        evFieldsModel.clear()
        var sch = schemaFor(calId)
        var src = (ev && ev.fields) ? ev.fields : {}
        for (var i = 0; i < sch.length; i++) {
            var f = sch[i], k = f.key
            var has = (src[k] !== undefined && src[k] !== null)
            evFieldsModel.append({
                key: k,
                label: f.label || k,
                ftype: f.type || "text",
                opts: JSON.stringify(f.options || []),
                sval: (has && f.type !== "bool") ? String(src[k]) : "",
                bval: (f.type === "bool") ? (has ? !!src[k] : false) : false
            })
        }
    }
    // Collect custom-field values into a typed object (only meaningful when schema non-empty).
    function collectFieldVals(calId) {
        var sch = schemaFor(calId)
        var byKey = {}
        for (var j = 0; j < evFieldsModel.count; j++) {
            var it = evFieldsModel.get(j)
            byKey[it.key] = { sval: it.sval, bval: it.bval }
        }
        var out = {}
        for (var i = 0; i < sch.length; i++) {
            var f = sch[i], row = byKey[f.key] || { sval: "", bval: false }
            if (f.type === "number") out[f.key] = (row.sval === "") ? 0 : parseFloat(row.sval)
            else if (f.type === "bool") out[f.key] = !!row.bval
            else out[f.key] = String(row.sval || "")
        }
        return out
    }
    function openNewEvent() {
        var w = writableCalendars()
        if (w.length === 0) { newCalPopup.open(); return }
        editingEvent = null
        root.evCals = w
        // Preselect the calendar you last added an event to (if still writable), else the first.
        var pre = w[0].id
        if (root.lastCalId !== "") { for (var k = 0; k < w.length; k++) if (w[k].id === root.lastCalId) { pre = root.lastCalId; break } }
        editCalId = pre
        evHistory = []
        var start = new Date(selectedDay); start.setHours(9, 0, 0, 0)
        var end = new Date(selectedDay); end.setHours(10, 0, 0, 0)
        evTitle.text = ""; evDate.text = fmtDateInput(start)
        evStart.text = fmtTimeInput(start); evEnd.text = fmtTimeInput(end); evNotes.text = ""
        evAllDay = false; evReminder = 10; evRecurFreq = ""
        evLocation.text = ""; evUrl.text = ""; evRecurInterval.text = "1"; evRecurUntil.text = ""
        seedFieldVals(editCalId, null)
        eventPopup.open()
    }
    // `occ` may be an expanded occurrence — series edits operate on the MASTER, so
    // load the real event (with its recurrence rule + true start date) by seriesId.
    function openEditEvent(occ) {
        var ev = occ
        root.evCals = writableCalendars()
        if (occ && occ.seriesId) { var m = root.eventById(occ.seriesId); if (m) ev = m }
        editingEvent = ev
        editCalId = ev.calendarId
        var s = new Date(ev.startTime), e = new Date(ev.endTime)
        evTitle.text = ev.title || ""; evDate.text = fmtDateInput(s)
        evStart.text = fmtTimeInput(s); evEnd.text = fmtTimeInput(e); evNotes.text = ev.description || ""
        evAllDay = !!ev.allDay
        evReminder = (ev.reminderMin !== undefined && ev.reminderMin !== null) ? ev.reminderMin : 10
        evLocation.text = ev.location || ""
        evUrl.text = ev.url || ""
        var r = ev.recur
        evRecurFreq = (r && r.freq) ? r.freq : ""
        evRecurInterval.text = (r && r.interval) ? String(r.interval) : "1"
        evRecurUntil.text = (r && typeof r.until === "number") ? fmtDateInput(new Date(r.until)) : ""
        seedFieldVals(ev.calendarId, ev)
        evHistory = root.j(core("getEventHistory", [ev.calendarId, ev.id]), [])
        eventPopup.open()
    }
    function saveEvent() {
        var s = parseDateTime(evDate.text, evStart.text)
        var e = parseDateTime(evDate.text, evEnd.text)
        if (root.evAllDay) {
            // all-day → clamp to the day's bounds so downstream code still has valid times
            s = new Date(s.getFullYear(), s.getMonth(), s.getDate(), 0, 0, 0, 0)
            e = new Date(s.getFullYear(), s.getMonth(), s.getDate(), 23, 59, 0, 0)
        } else if (e.getTime() <= s.getTime()) {
            e = new Date(s.getTime() + 3600000)
        }
        var hasSchema = schemaFor(editCalId).length > 0
        var recur = root.buildRecur()
        if (editingEvent) {
            var up = editingEvent
            delete up.seriesId; delete up.occ    // never persist expanded-occurrence markers
            up.title = evTitle.text.trim(); up.startTime = s.getTime(); up.endTime = e.getTime(); up.description = evNotes.text.trim()
            up.allDay = root.evAllDay
            up.location = evLocation.text.trim()
            up.url = evUrl.text.trim()
            up.reminderMin = root.evReminder
            up.recur = recur    // null clears a previous recurrence
            if (hasSchema) up.fields = collectFieldVals(editCalId)
            core("updateEvent", [JSON.stringify(up)])
        } else {
            var nv = {
                title: evTitle.text.trim(), startTime: s.getTime(), endTime: e.getTime(),
                allDay: root.evAllDay, description: evNotes.text.trim(),
                location: evLocation.text.trim(), url: evUrl.text.trim(), reminderMin: root.evReminder
            }
            if (recur) nv.recur = recur
            if (hasSchema) nv.fields = collectFieldVals(editCalId)
            core("createEvent", [editCalId, JSON.stringify(nv)])
            root.lastCalId = editCalId       // preselect this calendar next time

        }
        eventPopup.close(); refresh()
    }
    function deleteEvent() {
        if (editingEvent) core("deleteEvent", [editingEvent.id])
        eventPopup.close(); refresh()
    }


    Popup {
        id: eventPopup
        anchors.centerIn: Overlay.overlay
        width: 420; modal: true; padding: Theme.spacing.large
        background: Rectangle { radius: Theme.spacing.radiusMedium; color: Theme.palette.backgroundElevated; border.width: 1; border.color: Theme.palette.borderHairline }
        ColumnLayout {
            anchors.fill: parent; spacing: Theme.spacing.small
            LogosText { text: root.editingEvent ? "Edit event" : "New event"; color: Theme.palette.text; font.pixelSize: 18; font.weight: Theme.typography.weightMedium }

            LogosText { text: "Calendar"; color: Theme.palette.textTertiary; font.pixelSize: 11 }
            ComboBox {
                id: evCalSelect
                Layout.fillWidth: true
                enabled: !root.editingEvent        // can't move an event to another calendar
                opacity: enabled ? 1 : 0.6
                model: root.evCals
                textRole: "name"
                currentIndex: {
                    var m = root.evCals
                    for (var i = 0; i < m.length; i++) if (m[i].id === root.editCalId) return i
                    return -1
                }
                onActivated: function (index) {
                    var m = root.evCals
                    if (index >= 0 && index < m.length) {
                        root.editCalId = m[index].id
                        // Re-seed custom fields for the newly-picked calendar — its schema
                        // differs, so the inputs must rebuild (else fields never show unless
                        // the target calendar happened to be the one seeded on open).
                        seedFieldVals(root.editCalId, editingEvent)
                    }
                }
                contentItem: LogosText {
                    leftPadding: 10; rightPadding: 28
                    text: evCalSelect.displayText || "(calendar)"
                    color: Theme.palette.text; font.pixelSize: 14
                    verticalAlignment: Text.AlignVCenter; elide: Text.ElideRight
                }
                background: Rectangle {
                    implicitHeight: 34; radius: Theme.spacing.radiusSmall; color: Theme.palette.background
                    border.width: 1; border.color: Theme.palette.borderHairline
                }
                delegate: ItemDelegate {
                    width: evCalSelect.width
                    highlighted: evCalSelect.highlightedIndex === index
                    contentItem: RowLayout {
                        spacing: 6
                        Rectangle { width: 10; height: 10; radius: 5; color: root.calColor(modelData.id); Layout.alignment: Qt.AlignVCenter }
                        LogosText { text: modelData.name || "(cal)"; color: Theme.palette.text; font.pixelSize: 14; elide: Text.ElideRight; Layout.fillWidth: true }
                    }
                    background: Rectangle { color: highlighted ? Theme.palette.backgroundSecondary : Theme.palette.backgroundElevated }
                }
                popup: Popup {
                    y: evCalSelect.height
                    width: evCalSelect.width
                    implicitHeight: Math.min(contentItem.implicitHeight + 2, 260)
                    padding: 1
                    background: Rectangle { radius: Theme.spacing.radiusSmall; color: Theme.palette.backgroundElevated; border.width: 1; border.color: Theme.palette.borderHairline }
                    contentItem: ListView {
                        clip: true
                        implicitHeight: contentHeight
                        model: evCalSelect.popup.visible ? evCalSelect.delegateModel : null
                        currentIndex: evCalSelect.highlightedIndex
                        ScrollIndicator.vertical: ScrollIndicator {}
                    }
                }
            }

            LogosText { text: "Title"; color: Theme.palette.textTertiary; font.pixelSize: 11 }
            Field { id: evTitle; readOnly: root.eventReadOnly; Layout.fillWidth: true; placeholderText: "Event title" }

            // all-day toggle — hides the time inputs when on
            Row {
                spacing: 8
                Rectangle {
                    width: 22; height: 22; radius: 5
                    color: root.evAllDay ? Theme.palette.primary : Theme.palette.background
                    border.width: 1; border.color: Theme.palette.borderHairline
                    LogosText { anchors.centerIn: parent; visible: root.evAllDay; text: "✓"; color: Theme.palette.background; font.pixelSize: 14 }
                    MouseArea { anchors.fill: parent; onClicked: root.evAllDay = !root.evAllDay }
                }
                LogosText { text: "All-day"; color: Theme.palette.text; font.pixelSize: 13; anchors.verticalCenter: parent.verticalCenter }
            }

            RowLayout {
                Layout.fillWidth: true; spacing: Theme.spacing.small
                ColumnLayout { Layout.fillWidth: true; LogosText { text: "Date"; color: Theme.palette.textTertiary; font.pixelSize: 11 }
                    Field { id: evDate; readOnly: true; Layout.fillWidth: true; placeholderText: "YYYY-MM-DD"
                        MouseArea { anchors.fill: parent; enabled: !root.eventReadOnly; cursorShape: Qt.PointingHandCursor; onClicked: datePicker.openFor(evDate, evDate.text) } } }
                ColumnLayout { visible: !root.evAllDay; LogosText { text: "Start"; color: Theme.palette.textTertiary; font.pixelSize: 11 }
                    Field { id: evStart; readOnly: true; Layout.preferredWidth: 80; placeholderText: "HH:MM"
                        MouseArea { anchors.fill: parent; enabled: !root.eventReadOnly; cursorShape: Qt.PointingHandCursor; onClicked: timePicker.openFor(evStart, evStart.text) } } }
                ColumnLayout { visible: !root.evAllDay; LogosText { text: "End"; color: Theme.palette.textTertiary; font.pixelSize: 11 }
                    Field { id: evEnd; readOnly: true; Layout.preferredWidth: 80; placeholderText: "HH:MM"
                        MouseArea { anchors.fill: parent; enabled: !root.eventReadOnly; cursorShape: Qt.PointingHandCursor; onClicked: timePicker.openFor(evEnd, evEnd.text) } } }
            }

            LogosText { text: "Notes"; color: Theme.palette.textTertiary; font.pixelSize: 11 }
            Field { id: evNotes; readOnly: root.eventReadOnly; Layout.fillWidth: true; placeholderText: "Optional" }

            LogosText { text: "Location"; color: Theme.palette.textTertiary; font.pixelSize: 11 }
            Field { id: evLocation; readOnly: root.eventReadOnly; Layout.fillWidth: true; placeholderText: "Where" }

            LogosText { text: "Meeting link"; color: Theme.palette.textTertiary; font.pixelSize: 11 }
            Field {
                id: evUrl; readOnly: root.eventReadOnly; Layout.fillWidth: true; placeholderText: "https://…"
                inputMethodHints: Qt.ImhNoAutoUppercase | Qt.ImhUrlCharactersOnly
            }

            // reminder chips
            LogosText { text: "Reminder"; color: Theme.palette.textTertiary; font.pixelSize: 11 }
            Flow {
                Layout.fillWidth: true; spacing: 6
                Repeater {
                    model: root.reminderOpts
                    delegate: Rectangle {
                        height: 28; radius: 14; width: remLbl.width + 20
                        color: root.evReminder === modelData.v ? Theme.palette.backgroundSecondary : Theme.palette.background
                        border.width: 1
                        border.color: root.evReminder === modelData.v ? Theme.palette.primary : Theme.palette.borderHairline
                        LogosText { id: remLbl; anchors.centerIn: parent; text: modelData.l; color: Theme.palette.text; font.pixelSize: 13 }
                        MouseArea { anchors.fill: parent; onClicked: root.evReminder = modelData.v }
                    }
                }
            }

            // recurrence
            LogosText { text: "Repeat"; color: Theme.palette.textTertiary; font.pixelSize: 11 }
            Flow {
                Layout.fillWidth: true; spacing: 6
                Repeater {
                    model: root.recurOpts
                    delegate: Rectangle {
                        height: 28; radius: 14; width: recLbl.width + 20
                        color: root.evRecurFreq === modelData.v ? Theme.palette.backgroundSecondary : Theme.palette.background
                        border.width: 1
                        border.color: root.evRecurFreq === modelData.v ? Theme.palette.primary : Theme.palette.borderHairline
                        LogosText { id: recLbl; anchors.centerIn: parent; text: modelData.l; color: Theme.palette.text; font.pixelSize: 13 }
                        MouseArea { anchors.fill: parent; onClicked: root.evRecurFreq = modelData.v }
                    }
                }
            }
            RowLayout {
                visible: root.evRecurFreq !== ""
                Layout.fillWidth: true; spacing: Theme.spacing.small
                ColumnLayout { LogosText { text: "Every N"; color: Theme.palette.textTertiary; font.pixelSize: 11 } Field { id: evRecurInterval; Layout.preferredWidth: 70; text: "1"; inputMethodHints: Qt.ImhFormattedNumbersOnly; placeholderText: "1" } }
                ColumnLayout { Layout.fillWidth: true; LogosText { text: "Until (optional)"; color: Theme.palette.textTertiary; font.pixelSize: 11 } Field { id: evRecurUntil; Layout.fillWidth: true; placeholderText: "YYYY-MM-DD" } }
            }
            LogosText {
                visible: root.evRecurFreq !== ""
                text: root.recurLabel(root.buildRecur())
                color: Theme.palette.textSecondary; font.pixelSize: 12
            }

            // note when editing a recurring series
            LogosText {
                visible: !!root.editingRecurring()
                text: "Part of a repeating event — changes apply to the whole series."
                color: Theme.palette.textTertiary; font.pixelSize: 11; wrapMode: Text.WordWrap; Layout.fillWidth: true
            }

            // ── custom fields (schema-driven) — nothing rendered for a plain calendar ──
            ListModel { id: evFieldsModel }
            Repeater {
                model: evFieldsModel
                delegate: ColumnLayout {
                    id: fieldRow
                    Layout.fillWidth: true; Layout.topMargin: 2; spacing: 3
                    property int rowIndex: index
                    property string curVal: model.sval        // reactive: updates on setProperty
                    property bool curBool: model.bval
                    property string optsJson: model.opts
                    LogosText {
                        text: (model.label || model.key) + (model.ftype === "number" ? " (number)" : (model.ftype === "url" ? " (url)" : ""))
                        color: Theme.palette.textTertiary; font.pixelSize: 11
                    }
                    // bool → checkbox toggle
                    Row {
                        visible: model.ftype === "bool"
                        spacing: 8
                        Rectangle {
                            width: 22; height: 22; radius: 5
                            color: fieldRow.curBool ? Theme.palette.primary : Theme.palette.background
                            border.width: 1; border.color: Theme.palette.borderHairline
                            LogosText { anchors.centerIn: parent; visible: fieldRow.curBool; text: "✓"; color: Theme.palette.background; font.pixelSize: 14 }
                            MouseArea { anchors.fill: parent; onClicked: evFieldsModel.setProperty(fieldRow.rowIndex, "bval", !fieldRow.curBool) }
                        }
                        LogosText { text: fieldRow.curBool ? "Yes" : "No"; color: Theme.palette.text; font.pixelSize: 13; anchors.verticalCenter: parent.verticalCenter }
                    }
                    // enum → selectable chips from options
                    Flow {
                        visible: model.ftype === "enum"
                        Layout.fillWidth: true; spacing: 6
                        Repeater {
                            model: JSON.parse(fieldRow.optsJson || "[]")
                            delegate: Rectangle {
                                height: 28; radius: 14; width: chipLbl.width + 20
                                color: fieldRow.curVal === modelData ? Theme.palette.backgroundSecondary : Theme.palette.background
                                border.width: 1
                                border.color: fieldRow.curVal === modelData ? Theme.palette.primary : Theme.palette.borderHairline
                                LogosText { id: chipLbl; anchors.centerIn: parent; text: modelData; color: Theme.palette.text; font.pixelSize: 13 }
                                MouseArea { anchors.fill: parent; onClicked: evFieldsModel.setProperty(fieldRow.rowIndex, "sval", modelData) }
                            }
                        }
                    }
                    // everything else → a Field (numeric for number, no autocapitalize for url)
                    Field {
                        visible: model.ftype !== "bool" && model.ftype !== "enum"
                        Layout.fillWidth: true
                        text: model.sval
                        inputMethodHints: model.ftype === "number" ? Qt.ImhFormattedNumbersOnly
                                          : (model.ftype === "url" ? (Qt.ImhNoAutoUppercase | Qt.ImhUrlCharactersOnly) : Qt.ImhNone)
                        placeholderText: model.ftype === "date" ? "YYYY-MM-DD"
                                         : (model.ftype === "datetime" ? "YYYY-MM-DD HH:MM"
                                         : (model.ftype === "color" ? "#rrggbb"
                                         : (model.ftype === "url" ? "https://…" : "")))
                        onTextChanged: evFieldsModel.setProperty(fieldRow.rowIndex, "sval", text)
                    }
                }
            }

            // ── edit history (only when editing an existing event) ──
            ColumnLayout {
                visible: root.editingEvent !== null && root.evHistory && root.evHistory.length > 0
                Layout.fillWidth: true; Layout.topMargin: Theme.spacing.small; spacing: 2
                LogosText { text: "History"; color: Theme.palette.textTertiary; font.pixelSize: 11 }
                Repeater {
                    model: root.evHistory || []
                    delegate: LogosText {
                        Layout.fillWidth: true
                        text: "· " + (modelData.action || "changed") + " by " + root.shortAuthor(modelData.author)
                              + " — " + Qt.formatDateTime(new Date(modelData.at), "MMM d, hh:mm")
                        color: Theme.palette.textSecondary; font.pixelSize: 11; elide: Text.ElideRight
                    }
                }
            }

            // Inline validation error (only while editable).
            LogosText {
                visible: !root.eventReadOnly && root.eventError() !== ""
                text: root.eventError()
                color: Theme.palette.warning; font.pixelSize: 12; wrapMode: Text.WordWrap; Layout.fillWidth: true
            }
            // Read-only reason (ADR 0013): say WHY you can't edit instead of a silent locked form.
            Rectangle {
                visible: root.eventReadOnly
                Layout.fillWidth: true; radius: Theme.spacing.radiusSmall
                color: Qt.rgba(0.98, 0.89, 0.55, 0.10); border.width: 1; border.color: Theme.palette.warning
                implicitHeight: roLabel.implicitHeight + 2 * Theme.spacing.small
                ColumnLayout {
                    anchors.fill: parent; anchors.margins: Theme.spacing.small; spacing: 2
                    LogosText { text: "🔒 Read-only"; color: Theme.palette.warning; font.pixelSize: 12; font.weight: Theme.typography.weightMedium }
                    LogosText {
                        id: roLabel
                        text: root.readonlyReason(root.calById(root.editCalId), root.editingEvent)
                        color: Theme.palette.warning; font.pixelSize: 11; wrapMode: Text.WordWrap; Layout.fillWidth: true
                    }
                }
            }
            RowLayout {
                Layout.fillWidth: true; Layout.topMargin: Theme.spacing.small; spacing: Theme.spacing.small
                LogosButton { visible: root.editingEvent !== null && !root.eventReadOnly; text: "Delete"; onClicked: root.deleteEvent() }
                Item { Layout.fillWidth: true }
                LogosButton { text: "Cancel"; onClicked: eventPopup.close() }
                LogosButton { visible: !root.eventReadOnly; text: root.editingEvent ? "Save" : "Create"; enabled: root.eventError() === ""; onClicked: root.saveEvent() }
            }
        }
    }

    // ── date picker (month grid) — writes YYYY-MM-DD into a target Field ───────
    Popup {
        id: datePicker
        property var targetField: null
        property date pickMonth: new Date()
        function openFor(field, curText) {
            targetField = field
            var d = /^\d{4}-\d{2}-\d{2}$/.test((curText || "").trim()) ? new Date(curText.trim() + "T00:00:00") : new Date()
            pickMonth = new Date(d.getFullYear(), d.getMonth(), 1)
            open()
        }
        anchors.centerIn: Overlay.overlay
        width: 300; modal: true; padding: Theme.spacing.large
        background: Rectangle { radius: Theme.spacing.radiusMedium; color: Theme.palette.backgroundElevated; border.width: 1; border.color: Theme.palette.borderHairline }
        ColumnLayout {
            anchors.fill: parent; spacing: Theme.spacing.small
            RowLayout {
                Layout.fillWidth: true
                LogosButton { text: "‹"; onClicked: datePicker.pickMonth = new Date(datePicker.pickMonth.getFullYear(), datePicker.pickMonth.getMonth() - 1, 1) }
                LogosText { Layout.fillWidth: true; horizontalAlignment: Text.AlignHCenter; text: root.monthNames[datePicker.pickMonth.getMonth()] + " " + datePicker.pickMonth.getFullYear(); color: Theme.palette.text; font.pixelSize: 15 }
                LogosButton { text: "›"; onClicked: datePicker.pickMonth = new Date(datePicker.pickMonth.getFullYear(), datePicker.pickMonth.getMonth() + 1, 1) }
            }
            Row {
                Layout.alignment: Qt.AlignHCenter
                Repeater { model: root.weekDays; delegate: LogosText { width: 38; horizontalAlignment: Text.AlignHCenter; text: modelData.substring(0, 1); color: Theme.palette.textTertiary; font.pixelSize: 10 } }
            }
            Grid {
                columns: 7; Layout.alignment: Qt.AlignHCenter; rowSpacing: 2; columnSpacing: 2
                Repeater {
                    model: 42
                    delegate: Rectangle {
                        width: 38; height: 32; radius: 6
                        property date cd: {
                            var first = new Date(datePicker.pickMonth.getFullYear(), datePicker.pickMonth.getMonth(), 1)
                            var offset = (first.getDay() + 6) % 7
                            return new Date(first.getFullYear(), first.getMonth(), 1 - offset + index)
                        }
                        property bool inMonth: cd.getMonth() === datePicker.pickMonth.getMonth()
                        property bool today: root.sameDay(cd, new Date())
                        color: today ? Theme.palette.backgroundSecondary : "transparent"
                        border.width: today ? 1 : 0; border.color: Theme.palette.primary
                        LogosText { anchors.centerIn: parent; text: cd.getDate(); color: inMonth ? Theme.palette.text : Theme.palette.textTertiary; font.pixelSize: 12 }
                        MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: { if (datePicker.targetField) datePicker.targetField.text = root.fmtDateInput(cd); datePicker.close() } }
                    }
                }
            }
            LogosButton { Layout.alignment: Qt.AlignRight; text: "Cancel"; onClicked: datePicker.close() }
        }
    }

    // ── time picker (hour + minute columns) — writes HH:MM into a target Field ─
    Popup {
        id: timePicker
        property var targetField: null
        property int selHour: 9
        property int selMin: 0
        function openFor(field, curText) {
            targetField = field
            var m = /^(\d{1,2}):(\d{2})$/.exec((curText || "").trim())
            selHour = m ? Math.max(0, Math.min(23, parseInt(m[1]))) : 9
            selMin = m ? Math.max(0, Math.min(59, parseInt(m[2]))) : 0
            open()
        }
        anchors.centerIn: Overlay.overlay
        width: 260; height: 340; modal: true; padding: Theme.spacing.large
        background: Rectangle { radius: Theme.spacing.radiusMedium; color: Theme.palette.backgroundElevated; border.width: 1; border.color: Theme.palette.borderHairline }
        ColumnLayout {
            anchors.fill: parent; spacing: Theme.spacing.small
            LogosText { text: "Pick time"; color: Theme.palette.text; font.pixelSize: 15; font.weight: Theme.typography.weightMedium }
            RowLayout {
                Layout.fillWidth: true; Layout.fillHeight: true; spacing: Theme.spacing.small
                ListView {
                    id: hourList; Layout.fillWidth: true; Layout.fillHeight: true; clip: true
                    model: 24; currentIndex: timePicker.selHour
                    ScrollBar.vertical: ScrollBar {}
                    delegate: Rectangle {
                        width: ListView.view.width; height: 30; radius: 5
                        color: timePicker.selHour === index ? Theme.palette.primary : "transparent"
                        LogosText { anchors.centerIn: parent; text: root.pad(index); color: timePicker.selHour === index ? Theme.palette.background : Theme.palette.text; font.pixelSize: 13 }
                        MouseArea { anchors.fill: parent; onClicked: timePicker.selHour = index }
                    }
                }
                LogosText { text: ":"; color: Theme.palette.text; font.pixelSize: 18 }
                ListView {
                    id: minList; Layout.fillWidth: true; Layout.fillHeight: true; clip: true
                    model: 12; currentIndex: Math.round(timePicker.selMin / 5)
                    ScrollBar.vertical: ScrollBar {}
                    delegate: Rectangle {
                        width: ListView.view.width; height: 30; radius: 5
                        property int mv: index * 5
                        color: timePicker.selMin === mv ? Theme.palette.primary : "transparent"
                        LogosText { anchors.centerIn: parent; text: root.pad(index * 5); color: timePicker.selMin === mv ? Theme.palette.background : Theme.palette.text; font.pixelSize: 13 }
                        MouseArea { anchors.fill: parent; onClicked: timePicker.selMin = mv }
                    }
                }
            }
            RowLayout {
                Layout.fillWidth: true
                Item { Layout.fillWidth: true }
                LogosButton { text: "Cancel"; onClicked: timePicker.close() }
                LogosButton { text: "Set"; onClicked: { if (timePicker.targetField) timePicker.targetField.text = root.pad(timePicker.selHour) + ":" + root.pad(timePicker.selMin); timePicker.close() } }
            }
        }
    }

    // ── identities popup (loam ADR 0004: service in loam_core, UI here) ────────
    property string newIdentityLabel: ""
    Popup {
        id: identitiesPopup
        anchors.centerIn: Overlay.overlay
        width: 460; modal: true; padding: Theme.spacing.large
        background: Rectangle { radius: Theme.spacing.radiusMedium; color: Theme.palette.backgroundElevated; border.width: 1; border.color: Theme.palette.borderHairline }
        ColumnLayout {
            width: parent.width; spacing: Theme.spacing.medium
            LogosText { text: "Identities"; color: Theme.palette.text; font.pixelSize: 18; font.weight: Theme.typography.weightMedium }
            LogosText { text: "Keys live in loam_core and never leave it. ★ = default for new calendars — tap an identity to make it the default."
                color: Theme.palette.textTertiary; font.pixelSize: 11; wrapMode: Text.WordWrap; Layout.fillWidth: true }
            Repeater {
                model: root.identities
                RowLayout {
                    Layout.fillWidth: true; spacing: Theme.spacing.small
                    MouseArea {
                        Layout.fillWidth: true; implicitHeight: idCol.implicitHeight; cursorShape: Qt.PointingHandCursor
                        onClicked: { root.loamCore("setDefaultIdentityId", [modelData.id]); root.refreshIdentities() }
                        ColumnLayout {
                            id: idCol; width: parent.width; spacing: 0
                            LogosText {
                                text: (modelData.id === root.defaultIdentityId ? "★ " : "  ") + modelData.label + "  ·  " + modelData.kind
                                color: Theme.palette.text; font.pixelSize: 13
                            }
                            LogosText { text: (modelData.address || "").substring(0, 14) + "…" + (modelData.address || "").slice(-4); color: Theme.palette.textTertiary; font.pixelSize: 10; font.family: "monospace" }
                        }
                    }
                    LogosButton {
                        visible: modelData.kind === "soft"; text: "✕"
                        onClicked: { root.loamCore("removeSoftIdentity", [modelData.id]); root.refreshIdentities() }
                    }
                }
            }
            RowLayout {
                Layout.fillWidth: true; Layout.topMargin: Theme.spacing.small; spacing: Theme.spacing.small
                LogosTextField { id: newIdField; Layout.fillWidth: true; placeholderText: "new software identity name"; text: root.newIdentityLabel; onTextChanged: root.newIdentityLabel = text }
                LogosButton {
                    text: "+ Add"
                    onClicked: { root.loamCore("addSoftIdentity", [newIdField.text.trim() || "Identity"]); newIdField.text = ""; root.refreshIdentities() }
                }
            }
            RowLayout {
                Layout.fillWidth: true; Layout.topMargin: Theme.spacing.small
                Item { Layout.fillWidth: true }
                LogosButton { text: "Close"; onClicked: identitiesPopup.close() }
            }
        }
    }

    // ── new-calendar popup ───────────────────────────────────────────────────
    property bool newCalOpen: false         // default CLOSED — opening a calendar up is a deliberate choice
    property string newCalIdentity: ""      // "author as" (loam identity) — "" = default
    property string joinIdentity: ""         // "author as" for a joined calendar
    property string ncNewType: "text"   // staged field type in the new-calendar add-row
    // Add a custom field to the NEW-calendar schema (mirrors addSchemaField).
    function addNcField() {
        var k = ncNewKey.text.trim()
        if (k === "") return
        var opts = []
        if (root.ncNewType === "enum") {
            var parts = ncNewOptions.text.split(",")
            for (var i = 0; i < parts.length; i++) { var p = parts[i].trim(); if (p.length) opts.push(p) }
        }
        newCalSchemaModel.append({ key: k, label: ncNewLabel.text.trim() || k, ftype: root.ncNewType, opts: JSON.stringify(opts) })
        ncNewKey.text = ""; ncNewLabel.text = ""; ncNewOptions.text = ""; root.ncNewType = "text"
    }
    Popup {
        id: newCalPopup
        anchors.centerIn: Overlay.overlay
        width: 500; modal: true; padding: Theme.spacing.large
        background: Rectangle { radius: Theme.spacing.radiusMedium; color: Theme.palette.backgroundElevated; border.width: 1; border.color: Theme.palette.borderHairline }
        onOpened: {
            newCalName.text = ""; newCalDesc.text = ""; root.newCalOpen = false; root.newCalIdentity = ""
            newCalSchemaModel.clear(); ncNewKey.text = ""; ncNewLabel.text = ""; ncNewOptions.text = ""; root.ncNewType = "text"
        }
        function createNow() {
            // core returns are double-JSON-encoded — unwrap with j() (like getIdentity/
            // listCalendars) or the id comes back quoted and updateCalendarMeta targets the
            // WRONG calendar, so description/custom-fields silently never save on create.
            // Color is DERIVED from the calendar id (calColor), never chosen — pass "".
            var id = String(root.j(root.core("createCalendar", [newCalName.text.trim(), "", root.newCalIdentity]), ""))
            if (id === "") { newCalPopup.close(); root.refresh(); return }
            var sch = []
            for (var i = 0; i < newCalSchemaModel.count; i++) {
                var it = newCalSchemaModel.get(i)
                var e = { key: it.key, label: it.label, type: it.ftype }
                var o = JSON.parse(it.opts || "[]")
                if (it.ftype === "enum") e.options = o
                sch.push(e)
            }
            var d = newCalDesc.text.trim()
            // Fold up the create-time meta in one cal.meta write. `open` only needs writing
            // when Restricted (open defaults to true in the fold).
            var meta = {}
            if (d !== "") meta.description = d
            if (sch.length > 0) meta.schema = sch
            if (!root.newCalOpen) meta.open = false
            if (Object.keys(meta).length > 0) root.core("updateCalendarMeta", [id, JSON.stringify(meta)])
            newCalPopup.close(); root.refresh()
        }
        ColumnLayout {
            anchors.fill: parent; spacing: Theme.spacing.small

            LogosText { text: "New calendar"; color: Theme.palette.text; font.pixelSize: 18; font.weight: Theme.typography.weightMedium }

            Flickable {
                Layout.fillWidth: true
                Layout.preferredHeight: Math.min(contentHeight, 520)
                contentWidth: width; contentHeight: newCalBody.implicitHeight
                clip: true
                ScrollBar.vertical: ScrollBar {}
                ColumnLayout {
                    id: newCalBody
                    width: parent.width; spacing: Theme.spacing.small

                    LogosText { text: "Name"; color: Theme.palette.textTertiary; font.pixelSize: 11 }
                    Field { id: newCalName; Layout.fillWidth: true; placeholderText: "Calendar name" }

                    LogosText { text: "Description"; color: Theme.palette.textTertiary; font.pixelSize: 11 }
                    Field { id: newCalDesc; Layout.fillWidth: true; placeholderText: "Optional description" }

                    // Author as — which loam identity OWNS + signs this calendar (loam ADR 0004).
                    LogosText { text: "Author as"; color: Theme.palette.textTertiary; font.pixelSize: 11 }
                    Flow {
                        Layout.fillWidth: true; spacing: Theme.spacing.small
                        Repeater {
                            model: root.identities
                            Rectangle {
                                // selected = explicitly picked, or (nothing picked yet) the default. Inlined
                                // like the working field-type chips so the binding re-evaluates on click.
                                radius: Theme.spacing.radiusSmall
                                color: (root.newCalIdentity === modelData.id || (root.newCalIdentity === "" && modelData.id === root.defaultIdentityId)) ? Theme.palette.primary : Theme.palette.backgroundSecondary
                                border.width: 1
                                border.color: (root.newCalIdentity === modelData.id || (root.newCalIdentity === "" && modelData.id === root.defaultIdentityId)) ? Theme.palette.primary : Theme.palette.borderHairline
                                implicitHeight: chipT.implicitHeight + 10; implicitWidth: chipT.implicitWidth + 22
                                LogosText { id: chipT; anchors.centerIn: parent; text: modelData.label; font.pixelSize: 12; color: Theme.palette.text }
                                MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: root.newCalIdentity = modelData.id }
                            }
                        }
                    }
                    LogosText { text: "This identity owns the calendar and signs its events."; color: Theme.palette.textTertiary; font.pixelSize: 10; wrapMode: Text.WordWrap; Layout.fillWidth: true }

                    Rectangle { Layout.fillWidth: true; height: 1; color: Theme.palette.borderHairline; Layout.topMargin: 4 }

                    // ── custom fields editor (same as Calendar settings) ──
                    LogosText { text: "Custom fields"; color: Theme.palette.text; font.pixelSize: 14; font.weight: Theme.typography.weightMedium }
                    LogosText {
                        visible: newCalSchemaModel.count === 0
                        text: "Optional. Add typed fields to collect extra info on each event (venue, lineup…). You can also edit these later in the calendar's ⚙ settings."
                        color: Theme.palette.textTertiary; font.pixelSize: 11; wrapMode: Text.WordWrap; Layout.fillWidth: true
                    }
                    Repeater {
                        model: newCalSchemaModel
                        delegate: Rectangle {
                            Layout.fillWidth: true; implicitHeight: 34; radius: Theme.spacing.radiusSmall; color: Theme.palette.backgroundInset
                            RowLayout {
                                anchors.fill: parent; anchors.leftMargin: Theme.spacing.small; anchors.rightMargin: Theme.spacing.small; spacing: Theme.spacing.small
                                LogosText { text: (model.label || model.key); color: Theme.palette.text; font.pixelSize: 13; Layout.fillWidth: true; elide: Text.ElideRight }
                                LogosText { text: model.ftype; color: Theme.palette.textSecondary; font.pixelSize: 12 }
                                LogosText {
                                    text: "✕"; color: Theme.palette.textTertiary; font.pixelSize: 14
                                    MouseArea { anchors.fill: parent; anchors.margins: -4; onClicked: newCalSchemaModel.remove(index) }
                                }
                            }
                        }
                    }
                    RowLayout {
                        Layout.fillWidth: true; spacing: Theme.spacing.small
                        Field { id: ncNewKey; Layout.fillWidth: true; placeholderText: "key" }
                        Field { id: ncNewLabel; Layout.fillWidth: true; placeholderText: "label" }
                    }
                    Flow {
                        Layout.fillWidth: true; spacing: 6
                        Repeater {
                            model: root.fieldTypes
                            delegate: Rectangle {
                                height: 26; radius: 13; width: ncTLbl.width + 18
                                color: root.ncNewType === modelData ? Theme.palette.backgroundSecondary : Theme.palette.background
                                border.width: 1; border.color: root.ncNewType === modelData ? Theme.palette.primary : Theme.palette.borderHairline
                                LogosText { id: ncTLbl; anchors.centerIn: parent; text: modelData; color: Theme.palette.text; font.pixelSize: 12 }
                                MouseArea { anchors.fill: parent; onClicked: root.ncNewType = modelData }
                            }
                        }
                    }
                    Field {
                        id: ncNewOptions
                        visible: root.ncNewType === "enum"
                        Layout.fillWidth: true; placeholderText: "enum options (comma-separated)"
                    }
                    LogosButton { text: "+ Add field"; enabled: ncNewKey.text.trim().length > 0; onClicked: root.addNcField() }

                    ListModel { id: newCalSchemaModel }
                }
            }

            // Open vs Restricted — who may ADD events (editors always can; everyone can edit
            // only their own). Default Open; flip before Create for a locked-down calendar.
            RowLayout {
                Layout.fillWidth: true; Layout.topMargin: Theme.spacing.small
                ColumnLayout {
                    Layout.fillWidth: true; spacing: 0
                    LogosText { text: "Open — anyone can add events"; color: Theme.palette.text; font.pixelSize: 13 }
                    LogosText {
                        text: root.newCalOpen ? "Anyone you invite can add events." : "Only editors can add; others edit only their own."
                        color: Theme.palette.textSecondary; font.pixelSize: 11; Layout.fillWidth: true; wrapMode: Text.WordWrap
                    }
                }
                Switch { checked: root.newCalOpen; onToggled: root.newCalOpen = checked }
            }

            // Signatures-required — the fold DROPS any unsigned event (ADR 0015). The core enforces

            RowLayout {
                Layout.fillWidth: true; Layout.topMargin: Theme.spacing.small
                Item { Layout.fillWidth: true }
                LogosButton { text: "Cancel"; onClicked: newCalPopup.close() }
                LogosButton {
                    text: "Create"; enabled: newCalName.text.trim().length > 0
                    onClicked: newCalPopup.createNow()
                }
            }
        }
    }

    // ── per-calendar settings popup (name/description, schema, roles) ──────────
    property string setCalId: ""
    property string setNewType: "text"      // staged field type in the add-row
    property string setNewRole: "editor"    // staged role in the add-member row

    function openCalSettings(cal) {
        setCalId = cal.id
        setName.text = cal.name || ""
        setDesc.text = cal.description || ""
        setSchemaModel.clear()
        var sch = (cal.schema && cal.schema.length) ? cal.schema : []
        for (var i = 0; i < sch.length; i++) {
            setSchemaModel.append({
                key: sch[i].key, label: sch[i].label || sch[i].key,
                ftype: sch[i].type || "text", opts: JSON.stringify(sch[i].options || [])
            })
        }
        setNewKey.text = ""; setNewLabel.text = ""; setNewOptions.text = ""; root.setNewType = "text"
        setNewMember.text = ""; root.setNewRole = "editor"
        root.setSaveError = ""
        calSettingsPopup.open()
    }
    function addSchemaField() {
        var k = setNewKey.text.trim()
        if (k === "") return
        var opts = []
        if (root.setNewType === "enum") {
            var parts = setNewOptions.text.split(",")
            for (var i = 0; i < parts.length; i++) { var p = parts[i].trim(); if (p.length) opts.push(p) }
        }
        setSchemaModel.append({
            key: k, label: setNewLabel.text.trim() || k,
            ftype: root.setNewType, opts: JSON.stringify(opts)
        })
        setNewKey.text = ""; setNewLabel.text = ""; setNewOptions.text = ""; root.setNewType = "text"
    }
    property string setSaveError: ""
    function saveCalSettings() {
        root.setSaveError = ""
        var sch = []
        for (var i = 0; i < setSchemaModel.count; i++) {
            var it = setSchemaModel.get(i)
            var e = { key: it.key, label: it.label, type: it.ftype }
            var o = JSON.parse(it.opts || "[]")
            if (it.ftype === "enum") e.options = o
            sch.push(e)
        }
        var wantKeys = []
        for (var k = 0; k < sch.length; k++) wantKeys.push(sch[k].key)
        wantKeys.sort()
        core("updateCalendarMeta", [setCalId, JSON.stringify({ name: setName.text.trim(), description: setDesc.text.trim(), schema: sch })])
        refresh()
        // VERIFY the core actually persisted it. An out-of-date core silently no-ops
        // updateCalendarMeta (added in scala 0.7.0), so a save would appear to succeed but
        // vanish — surface that instead of failing quietly.
        var now = root.calById(setCalId)
        var gotKeys = []
        if (now && now.schema) for (var g = 0; g < now.schema.length; g++) gotKeys.push(now.schema[g].key)
        gotKeys.sort()
        if (JSON.stringify(gotKeys) !== JSON.stringify(wantKeys)) {
            root.setSaveError = "Couldn't save — your Scala core module looks out of date. Update 'scala' to 0.8.0 in the package manager (custom fields need core 0.7.0+), then try again."
            return // keep the popup open so the message is seen
        }
        calSettingsPopup.close()
    }
    // Members = owner (not removable) + each roles entry.
    function membersFor(calId) {
        var c = calById(calId); if (!c) return []
        var out = []
        if (c.owner) out.push({ id: c.owner, role: "owner", removable: false })
        var r = c.roles || {}
        for (var key in r) { if (key === c.owner) continue; out.push({ id: key, role: r[key], removable: true }) }
        return out
    }
    function canManage(calId) {
        var c = calById(calId); if (!c) return false
        if (c.owner && c.owner === myIdentity) return true
        var r = c.roles || {}
        return r[myIdentity] === "editor" || r[myIdentity] === "admin"
    }
    function addMember() {
        var id = setNewMember.text.trim(); if (id === "") return
        core("setMemberRole", [setCalId, id, root.setNewRole])
        setNewMember.text = ""; refresh()
    }
    function removeMember(id) { core("setMemberRole", [setCalId, id, "remove"]); refresh() }

    Popup {
        id: calSettingsPopup
        anchors.centerIn: Overlay.overlay
        width: 500; modal: true; padding: Theme.spacing.large
        background: Rectangle { radius: Theme.spacing.radiusMedium; color: Theme.palette.backgroundElevated; border.width: 1; border.color: Theme.palette.borderHairline }
        ColumnLayout {
            anchors.fill: parent; spacing: Theme.spacing.small

            LogosText { text: "Calendar settings"; color: Theme.palette.text; font.pixelSize: 18; font.weight: Theme.typography.weightMedium }

            // scrollable body — this popup can get tall
            Flickable {
                Layout.fillWidth: true
                Layout.preferredHeight: Math.min(contentHeight, 520)
                contentWidth: width; contentHeight: settingsBody.implicitHeight
                clip: true
                ScrollBar.vertical: ScrollBar {}
                ColumnLayout {
                    id: settingsBody
                    width: parent.width; spacing: Theme.spacing.small

                    LogosText { text: "Name"; color: Theme.palette.textTertiary; font.pixelSize: 11 }
                    Field { id: setName; Layout.fillWidth: true; placeholderText: "Calendar name" }

                    LogosText { text: "Description"; color: Theme.palette.textTertiary; font.pixelSize: 11 }
                    Field { id: setDesc; Layout.fillWidth: true; placeholderText: "Optional description" }

                    Rectangle { Layout.fillWidth: true; height: 1; color: Theme.palette.borderHairline; Layout.topMargin: 4 }

                    // ── custom fields editor ──
                    LogosText { text: "Custom fields"; color: Theme.palette.text; font.pixelSize: 14; font.weight: Theme.typography.weightMedium }
                    LogosText {
                        visible: setSchemaModel.count === 0
                        text: "No custom fields yet. Add one below to collect extra info on each event."
                        color: Theme.palette.textTertiary; font.pixelSize: 11; wrapMode: Text.WordWrap; Layout.fillWidth: true
                    }
                    Repeater {
                        model: setSchemaModel
                        delegate: Rectangle {
                            Layout.fillWidth: true; implicitHeight: 34; radius: Theme.spacing.radiusSmall; color: Theme.palette.backgroundInset
                            RowLayout {
                                anchors.fill: parent; anchors.leftMargin: Theme.spacing.small; anchors.rightMargin: Theme.spacing.small; spacing: Theme.spacing.small
                                LogosText { text: (model.label || model.key); color: Theme.palette.text; font.pixelSize: 13; Layout.fillWidth: true; elide: Text.ElideRight }
                                LogosText { text: model.ftype; color: Theme.palette.textSecondary; font.pixelSize: 12 }
                                LogosText {
                                    text: "✕"; color: Theme.palette.textTertiary; font.pixelSize: 14
                                    MouseArea { anchors.fill: parent; anchors.margins: -4; onClicked: setSchemaModel.remove(index) }
                                }
                            }
                        }
                    }

                    // add-field row
                    RowLayout {
                        Layout.fillWidth: true; spacing: Theme.spacing.small
                        Field { id: setNewKey; Layout.fillWidth: true; placeholderText: "key" }
                        Field { id: setNewLabel; Layout.fillWidth: true; placeholderText: "label" }
                    }
                    Flow {
                        Layout.fillWidth: true; spacing: 6
                        Repeater {
                            model: root.fieldTypes
                            delegate: Rectangle {
                                height: 26; radius: 13; width: tLbl.width + 18
                                color: root.setNewType === modelData ? Theme.palette.backgroundSecondary : Theme.palette.background
                                border.width: 1; border.color: root.setNewType === modelData ? Theme.palette.primary : Theme.palette.borderHairline
                                LogosText { id: tLbl; anchors.centerIn: parent; text: modelData; color: Theme.palette.text; font.pixelSize: 12 }
                                MouseArea { anchors.fill: parent; onClicked: root.setNewType = modelData }
                            }
                        }
                    }
                    Field {
                        id: setNewOptions
                        visible: root.setNewType === "enum"
                        Layout.fillWidth: true; placeholderText: "enum options (comma-separated)"
                    }
                    LogosButton { text: "+ Add field"; enabled: setNewKey.text.trim().length > 0; onClicked: root.addSchemaField() }

                    Rectangle { Layout.fillWidth: true; height: 1; color: Theme.palette.borderHairline; Layout.topMargin: 4 }

                    // ── sharing & roles ──
                    LogosText { text: "Sharing & roles"; color: Theme.palette.text; font.pixelSize: 14; font.weight: Theme.typography.weightMedium }
                    // Open toggle: may anyone with the invite ADD events? Everyone can still edit
                    // only the events they created; editors edit anyone's. Owner/editor only.
                    RowLayout {
                        visible: root.canManage(root.setCalId)
                        Layout.fillWidth: true; spacing: Theme.spacing.small
                        ColumnLayout {
                            Layout.fillWidth: true
                            LogosText { text: "Open — anyone can add events"; color: Theme.palette.text; font.pixelSize: 13 }
                            LogosText { text: "Off = only editors can add. Everyone edits only events they created; editors edit anyone's."; color: Theme.palette.textTertiary; font.pixelSize: 11; wrapMode: Text.WordWrap; Layout.fillWidth: true }
                        }
                        Switch {
                            checked: { var c = root.calById(root.setCalId); return !c || c.open !== false }
                            onToggled: { root.core("updateCalendarMeta", [root.setCalId, JSON.stringify({ open: checked })]); root.refresh() }
                        }
                    }
                    LogosText {
                        text: "Add someone by their identity (they'll find it in Diagnostics ⚙ → This device id). Editors can edit any event; viewers are read-only."
                        color: Theme.palette.textTertiary; font.pixelSize: 11; wrapMode: Text.WordWrap; Layout.fillWidth: true
                    }

                    LogosText {
                        visible: { var c = root.calById(root.setCalId); return !!c && c.rolesConfigured === false }
                        text: "No members yet — anyone with the invite can add events (and edit their own). Add an editor to let someone edit everyone's; add a viewer for read-only."
                        color: Theme.palette.warning; font.pixelSize: 11; wrapMode: Text.WordWrap; Layout.fillWidth: true
                    }

                    Repeater {
                        model: root.membersFor(root.setCalId)
                        delegate: Rectangle {
                            Layout.fillWidth: true; implicitHeight: 34; radius: Theme.spacing.radiusSmall; color: Theme.palette.backgroundInset
                            RowLayout {
                                anchors.fill: parent; anchors.leftMargin: Theme.spacing.small; anchors.rightMargin: Theme.spacing.small; spacing: Theme.spacing.small
                                LogosText { text: root.shortAuthor(modelData.id); color: Theme.palette.text; font.pixelSize: 13; Layout.fillWidth: true; elide: Text.ElideRight }
                                LogosText { text: modelData.role; color: Theme.palette.textSecondary; font.pixelSize: 12 }
                                LogosText {
                                    visible: modelData.removable && root.canManage(root.setCalId)
                                    text: "✕"; color: Theme.palette.textTertiary; font.pixelSize: 14
                                    MouseArea { anchors.fill: parent; anchors.margins: -4; onClicked: root.removeMember(modelData.id) }
                                }
                            }
                        }
                    }

                    // add-member row (owner/admin only)
                    ColumnLayout {
                        visible: root.canManage(root.setCalId)
                        Layout.fillWidth: true; spacing: Theme.spacing.small
                        Field { id: setNewMember; Layout.fillWidth: true; placeholderText: "paste an identity to add" }
                        RowLayout {
                            Layout.fillWidth: true; spacing: 6
                            Repeater {
                                model: ["editor", "viewer"]
                                delegate: Rectangle {
                                    height: 26; radius: 13; width: rLbl.width + 18
                                    color: root.setNewRole === modelData ? Theme.palette.backgroundSecondary : Theme.palette.background
                                    border.width: 1; border.color: root.setNewRole === modelData ? Theme.palette.primary : Theme.palette.borderHairline
                                    LogosText { id: rLbl; anchors.centerIn: parent; text: modelData; color: Theme.palette.text; font.pixelSize: 12 }
                                    MouseArea { anchors.fill: parent; onClicked: root.setNewRole = modelData }
                                }
                            }
                            Item { Layout.fillWidth: true }
                            LogosButton { text: "Add member"; enabled: setNewMember.text.trim().length > 0; onClicked: root.addMember() }
                        }
                    }
                }
            }

            ListModel { id: setSchemaModel }

            LogosText {
                visible: root.setSaveError !== ""
                text: root.setSaveError
                color: Theme.palette.warning; font.pixelSize: 12; wrapMode: Text.WordWrap
                Layout.fillWidth: true; Layout.topMargin: Theme.spacing.small
            }
            RowLayout {
                Layout.fillWidth: true; Layout.topMargin: Theme.spacing.small; spacing: Theme.spacing.small
                Item { Layout.fillWidth: true }
                LogosButton { text: "Cancel"; onClicked: calSettingsPopup.close() }
                LogosButton { text: "Save"; onClicked: root.saveCalSettings() }
            }
        }
    }

    // ── join popup ─────────────────────────────────────────────────────────
    Popup {
        id: joinPopup
        anchors.centerIn: Overlay.overlay
        width: 420; modal: true; padding: Theme.spacing.large
        background: Rectangle { radius: Theme.spacing.radiusMedium; color: Theme.palette.backgroundElevated; border.width: 1; border.color: Theme.palette.borderHairline }
        onOpened: { joinLink.text = ""; root.joinIdentity = "" }
        ColumnLayout {
            anchors.fill: parent; spacing: Theme.spacing.small
            LogosText { text: "Join a shared calendar"; color: Theme.palette.text; font.pixelSize: 18; font.weight: Theme.typography.weightMedium }
            LogosText { text: "Paste the scala:// invite link"; color: Theme.palette.textTertiary; font.pixelSize: 12 }
            Field { id: joinLink; Layout.fillWidth: true; placeholderText: "scala://join?..." }
            // Author as — which identity signs YOUR events on this calendar (owner stays the inviter).
            LogosText { text: "Author as"; color: Theme.palette.textTertiary; font.pixelSize: 11; Layout.topMargin: Theme.spacing.small }
            Flow {
                Layout.fillWidth: true; spacing: Theme.spacing.small
                Repeater {
                    model: root.identities
                    Rectangle {
                        radius: Theme.spacing.radiusSmall
                        color: (root.joinIdentity === modelData.id || (root.joinIdentity === "" && modelData.id === root.defaultIdentityId)) ? Theme.palette.primary : Theme.palette.backgroundSecondary
                        border.width: 1
                        border.color: (root.joinIdentity === modelData.id || (root.joinIdentity === "" && modelData.id === root.defaultIdentityId)) ? Theme.palette.primary : Theme.palette.borderHairline
                        implicitHeight: jChipT.implicitHeight + 10; implicitWidth: jChipT.implicitWidth + 22
                        LogosText { id: jChipT; anchors.centerIn: parent; text: modelData.label; font.pixelSize: 12; color: Theme.palette.text }
                        MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: root.joinIdentity = modelData.id }
                    }
                }
            }
            RowLayout {
                Layout.fillWidth: true; Layout.topMargin: Theme.spacing.small
                Item { Layout.fillWidth: true }
                LogosButton { text: "Cancel"; onClicked: joinPopup.close() }
                LogosButton {
                    text: "Join"; enabled: joinLink.text.trim().length > 0
                    onClicked: { root.core("handleShareLink", [joinLink.text.trim(), root.joinIdentity]); joinPopup.close(); root.refresh() }
                }
            }
        }
    }

    // ── share popup (link + a real QR the phone can scan) ─────────────────────
    property var qrData: null    // { n, cells } from core qrMatrix
    function openShare(cal) {
        var link = core("generateShareLink", [cal.id])
        link = root.j(link, link)   // unwrap if the bridge quoted it
        shareLink.text = (typeof link === "string" ? link : "")
        shareTitle.text = cal.name || "calendar"
        // Build a scannable QR matrix from the core (drawn on a Canvas; data: URIs
        // are blocked in the sandbox, so we render cells ourselves).
        root.qrData = null
        var m = root.j(core("qrMatrix", [shareLink.text]), null)
        if (m && m.ok && m.n && m.cells && m.cells.length >= m.n * m.n) root.qrData = { n: m.n, cells: m.cells }
        qrCanvas.requestPaint()
        sharePopup.open()
    }
    Popup {
        id: sharePopup
        anchors.centerIn: Overlay.overlay
        width: 460; modal: true; padding: Theme.spacing.large
        background: Rectangle { radius: Theme.spacing.radiusMedium; color: Theme.palette.backgroundElevated; border.width: 1; border.color: Theme.palette.borderHairline }
        onOpened: qrCanvas.requestPaint()
        ColumnLayout {
            anchors.fill: parent; spacing: Theme.spacing.small
            LogosText { id: shareTitle; text: ""; color: Theme.palette.text; font.pixelSize: 18; font.weight: Theme.typography.weightMedium }
            LogosText { text: "Scan this on the phone, or copy the link:"; color: Theme.palette.textTertiary; font.pixelSize: 12 }
            Rectangle {
                Layout.alignment: Qt.AlignHCenter
                width: 220; height: 220; radius: Theme.spacing.radiusSmall; color: "#ffffff"
                visible: root.qrData !== null
                Canvas {
                    id: qrCanvas; anchors.fill: parent; anchors.margins: 10
                    onPaint: {
                        var ctx = getContext("2d"); ctx.reset()
                        ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, width, height)
                        var d = root.qrData; if (!d || !d.n) return
                        var cell = width / d.n; ctx.fillStyle = "#000000"
                        for (var y = 0; y < d.n; y++)
                            for (var x = 0; x < d.n; x++)
                                if (d.cells[y * d.n + x])
                                    ctx.fillRect(Math.floor(x * cell), Math.floor(y * cell), Math.ceil(cell), Math.ceil(cell))
                    }
                }
            }
            Field { id: shareLink; Layout.fillWidth: true; readOnly: true; selectByMouse: true }
            RowLayout {
                Layout.fillWidth: true; Layout.topMargin: Theme.spacing.small
                Item { Layout.fillWidth: true }
                LogosButton { text: "Copy"; onClicked: { shareLink.selectAll(); shareLink.copy() } }
                LogosButton { text: "Close"; onClicked: sharePopup.close() }
            }
        }
    }

    // ── delete calendar (with confirm) ─────────────────────────────────────────
    property var pendingDeleteCal: null
    function confirmDeleteCalendar(cal) { pendingDeleteCal = cal; deletePopup.open() }
    function deleteCalendar() {
        if (!pendingDeleteCal) return
        var id = pendingDeleteCal.id
        core("deleteCalendar", [id])
        if (filterCalId === id) filterCalId = ""
        pendingDeleteCal = null
        deletePopup.close()
        refresh()
    }
    Popup {
        id: deletePopup
        anchors.centerIn: Overlay.overlay
        width: 380; modal: true; padding: Theme.spacing.large
        background: Rectangle { radius: Theme.spacing.radiusMedium; color: Theme.palette.backgroundElevated; border.width: 1; border.color: Theme.palette.borderHairline }
        ColumnLayout {
            anchors.fill: parent; spacing: Theme.spacing.small
            LogosText { text: "Delete calendar?"; color: Theme.palette.text; font.pixelSize: 18; font.weight: Theme.typography.weightMedium }
            LogosText {
                text: "Remove \"" + (root.pendingDeleteCal ? (root.pendingDeleteCal.name || "calendar") : "") + "\" from this device. Its local events are deleted. Peers who joined keep their own copy."
                color: Theme.palette.textTertiary; font.pixelSize: 12; wrapMode: Text.WordWrap; Layout.fillWidth: true
            }
            RowLayout {
                Layout.fillWidth: true; Layout.topMargin: Theme.spacing.small
                Item { Layout.fillWidth: true }
                LogosButton { text: "Cancel"; onClicked: { root.pendingDeleteCal = null; deletePopup.close() } }
                LogosButton { text: "Delete"; onClicked: root.deleteCalendar() }
            }
        }
    }

    // ── diagnostics popup (connection + events) ──────────────────────────────
    property var diag: null
    function openDiag() { root.diag = root.j(core("diagnostics", []), null); diagPopup.open() }
    Popup {
        id: diagPopup
        anchors.centerIn: Overlay.overlay
        width: 460; height: 460; modal: true; padding: Theme.spacing.large
        background: Rectangle { radius: Theme.spacing.radiusMedium; color: Theme.palette.backgroundElevated; border.width: 1; border.color: Theme.palette.borderHairline }
        onOpened: root.diag = root.j(root.core("diagnostics", []), null)
        ColumnLayout {
            anchors.fill: parent; spacing: Theme.spacing.small
            LogosText { text: "Diagnostics"; color: Theme.palette.text; font.pixelSize: 18; font.weight: Theme.typography.weightMedium }

            RowLayout {
                Layout.fillWidth: true; spacing: Theme.spacing.medium
                Rectangle { width: 10; height: 10; radius: 5; color: (root.diag && root.diag.nodeReady) ? Theme.palette.success : Theme.palette.warning; Layout.alignment: Qt.AlignVCenter }
                LogosText { text: (root.diag && root.diag.nodeReady) ? "Delivery node connected" : "Node not ready"; color: Theme.palette.text; font.pixelSize: 14 }
                Item { Layout.fillWidth: true }
                LogosButton { text: "Refresh"; onClicked: root.diag = root.j(root.core("diagnostics", []), null) }
            }
            LogosText {
                text: root.diag ? ("delivery: " + (root.diag.deliveryStatus || "(none)") + "   ·   context ready: " + (root.diag.ctxReady ? "yes" : "NO")) : "—"
                color: Theme.palette.textSecondary; font.pixelSize: 12
            }
            LogosText {
                text: root.diag ? (root.diag.calendarCount + " calendar(s) · " + root.diag.eventCount + " event(s) total") : "—"
                color: Theme.palette.textSecondary; font.pixelSize: 12
            }
            LogosText {
                text: root.diag ? ("data: " + (root.diag.dataDir || "?")) : ""
                color: Theme.palette.textTertiary; font.pixelSize: 11; elide: Text.ElideMiddle; Layout.fillWidth: true
            }
            LogosText { text: "Your identity (share this to be added to a calendar)"; color: Theme.palette.textTertiary; font.pixelSize: 11 }
            RowLayout {
                Layout.fillWidth: true; spacing: Theme.spacing.small
                Field { id: diagIdField; text: root.diag ? (root.diag.identity || root.myIdentity || "(none)") : root.myIdentity; Layout.fillWidth: true; readOnly: true; selectByMouse: true }
                LogosButton { text: "Copy"; onClicked: { diagIdField.selectAll(); diagIdField.copy() } }
            }

            LogosText { text: "Per-calendar sync"; color: Theme.palette.textTertiary; font.pixelSize: 11; Layout.topMargin: Theme.spacing.small }
            ListView {
                Layout.fillWidth: true; Layout.fillHeight: true; clip: true
                model: (root.diag && root.diag.calendars) ? root.diag.calendars : []
                spacing: 4
                delegate: Rectangle {
                    width: ListView.view.width; height: 40; radius: Theme.spacing.radiusSmall; color: Theme.palette.backgroundInset
                    RowLayout {
                        anchors.fill: parent; anchors.leftMargin: Theme.spacing.small; anchors.rightMargin: Theme.spacing.small; spacing: Theme.spacing.small
                        Rectangle { width: 8; height: 8; radius: 4; color: modelData.syncing ? Theme.palette.success : Theme.palette.textTertiary }
                        LogosText { text: modelData.name || modelData.id; color: Theme.palette.text; font.pixelSize: 13; Layout.fillWidth: true; elide: Text.ElideRight }
                        LogosText { text: (modelData.events || 0) + " ev"; color: Theme.palette.textTertiary; font.pixelSize: 12 }
                        LogosText { text: modelData.shared ? (modelData.syncing ? "syncing" : "offline") : "local"; color: modelData.syncing ? Theme.palette.success : Theme.palette.textTertiary; font.pixelSize: 12 }
                    }
                }
            }
            RowLayout { Layout.fillWidth: true; Item { Layout.fillWidth: true } LogosButton { text: "Close"; onClicked: diagPopup.close() } }
        }
    }
}
