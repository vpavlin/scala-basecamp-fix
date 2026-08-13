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
            if (diagPopup.visible) root.diag = root.j(root.core("diagnostics", []), null)
        }
    }

    // ── data ─────────────────────────────────────────────────────────────────
    function refresh() {
        if (!root.ready) return
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
    function eventsOnDay(d) {
        var out = []
        for (var i = 0; i < events.length; i++) {
            if (filterCalId !== "" && events[i].calendarId !== filterCalId) continue
            if (sameDay(new Date(events[i].startTime), d)) out.push(events[i])
        }
        out.sort(function (a, b) { return a.startTime - b.startTime })
        return out
    }
    function dotsOnDay(d) {
        var cols = []
        for (var i = 0; i < events.length && cols.length < 4; i++) {
            if (filterCalId !== "" && events[i].calendarId !== filterCalId) continue
            if (sameDay(new Date(events[i].startTime), d)) cols.push(calColor(events[i].calendarId))
        }
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

    // 3 resizable panes: calendars | month | agenda. Drag the dividers to resize.
    SplitView {
        anchors.fill: parent
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
    property var evHistory: []             // getEventHistory result while editing

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
        editCalId = w[0].id
        evHistory = []
        var start = new Date(selectedDay); start.setHours(9, 0, 0, 0)
        var end = new Date(selectedDay); end.setHours(10, 0, 0, 0)
        evTitle.text = ""; evDate.text = fmtDateInput(start)
        evStart.text = fmtTimeInput(start); evEnd.text = fmtTimeInput(end); evNotes.text = ""
        seedFieldVals(editCalId, null)
        eventPopup.open()
    }
    function openEditEvent(ev) {
        editingEvent = ev
        editCalId = ev.calendarId
        var s = new Date(ev.startTime), e = new Date(ev.endTime)
        evTitle.text = ev.title || ""; evDate.text = fmtDateInput(s)
        evStart.text = fmtTimeInput(s); evEnd.text = fmtTimeInput(e); evNotes.text = ev.description || ""
        seedFieldVals(ev.calendarId, ev)
        evHistory = root.j(core("getEventHistory", [ev.calendarId, ev.id]), [])
        eventPopup.open()
    }
    function saveEvent() {
        var s = parseDateTime(evDate.text, evStart.text)
        var e = parseDateTime(evDate.text, evEnd.text)
        if (e.getTime() <= s.getTime()) e = new Date(s.getTime() + 3600000)
        var hasSchema = schemaFor(editCalId).length > 0
        if (editingEvent) {
            var up = editingEvent
            up.title = evTitle.text.trim(); up.startTime = s.getTime(); up.endTime = e.getTime(); up.description = evNotes.text.trim()
            if (hasSchema) up.fields = collectFieldVals(editCalId)
            core("updateEvent", [JSON.stringify(up)])
        } else {
            var nv = { title: evTitle.text.trim(), startTime: s.getTime(), endTime: e.getTime(), allDay: false, description: evNotes.text.trim() }
            if (hasSchema) nv.fields = collectFieldVals(editCalId)
            core("createEvent", [editCalId, JSON.stringify(nv)])
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
                model: root.writableCalendars()
                textRole: "name"
                currentIndex: {
                    var m = root.writableCalendars()
                    for (var i = 0; i < m.length; i++) if (m[i].id === root.editCalId) return i
                    return -1
                }
                onActivated: function (index) {
                    var m = root.writableCalendars()
                    if (index >= 0 && index < m.length) root.editCalId = m[index].id
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
                        Rectangle { width: 10; height: 10; radius: 5; color: modelData.color || root.calColor(modelData.id); Layout.alignment: Qt.AlignVCenter }
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
            Field { id: evTitle; Layout.fillWidth: true; placeholderText: "Event title" }

            RowLayout {
                Layout.fillWidth: true; spacing: Theme.spacing.small
                ColumnLayout { Layout.fillWidth: true; LogosText { text: "Date"; color: Theme.palette.textTertiary; font.pixelSize: 11 } Field { id: evDate; Layout.fillWidth: true; placeholderText: "YYYY-MM-DD" } }
                ColumnLayout { LogosText { text: "Start"; color: Theme.palette.textTertiary; font.pixelSize: 11 } Field { id: evStart; Layout.preferredWidth: 80; placeholderText: "HH:MM" } }
                ColumnLayout { LogosText { text: "End"; color: Theme.palette.textTertiary; font.pixelSize: 11 } Field { id: evEnd; Layout.preferredWidth: 80; placeholderText: "HH:MM" } }
            }

            LogosText { text: "Notes"; color: Theme.palette.textTertiary; font.pixelSize: 11 }
            Field { id: evNotes; Layout.fillWidth: true; placeholderText: "Optional" }

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

            RowLayout {
                Layout.fillWidth: true; Layout.topMargin: Theme.spacing.small; spacing: Theme.spacing.small
                LogosButton { visible: root.editingEvent !== null; text: "Delete"; onClicked: root.deleteEvent() }
                Item { Layout.fillWidth: true }
                LogosButton { text: "Cancel"; onClicked: eventPopup.close() }
                LogosButton { text: root.editingEvent ? "Save" : "Create"; enabled: evTitle.text.trim().length > 0; onClicked: root.saveEvent() }
            }
        }
    }

    // ── new-calendar popup ───────────────────────────────────────────────────
    property string newCalColor: "#89b4fa"
    readonly property var presetColors: ["#a6e3a1","#89b4fa","#f9e2af","#f38ba8","#cba6f7","#94e2d5","#fab387","#74c7ec"]
    Popup {
        id: newCalPopup
        anchors.centerIn: Overlay.overlay
        width: 500; modal: true; padding: Theme.spacing.large
        background: Rectangle { radius: Theme.spacing.radiusMedium; color: Theme.palette.backgroundElevated; border.width: 1; border.color: Theme.palette.borderHairline }
        onOpened: { newCalName.text = ""; newCalDesc.text = ""; root.newCalColor = root.presetColors[1] }
        function createNow() {
            var id = String(root.core("createCalendar", [newCalName.text.trim(), root.newCalColor]))
            var d = newCalDesc.text.trim()
            if (id !== "" && d !== "") root.core("updateCalendarMeta", [id, JSON.stringify({ description: d })])
            newCalPopup.close(); root.refresh()
        }
        ColumnLayout {
            anchors.fill: parent; spacing: Theme.spacing.small

            LogosText { text: "New calendar"; color: Theme.palette.text; font.pixelSize: 18; font.weight: Theme.typography.weightMedium }

            LogosText { text: "Name"; color: Theme.palette.textTertiary; font.pixelSize: 11 }
            Field { id: newCalName; Layout.fillWidth: true; placeholderText: "Calendar name" }

            LogosText { text: "Description"; color: Theme.palette.textTertiary; font.pixelSize: 11 }
            Field { id: newCalDesc; Layout.fillWidth: true; placeholderText: "Optional description" }

            LogosText { text: "Color"; color: Theme.palette.textTertiary; font.pixelSize: 11 }
            Flow {
                Layout.fillWidth: true; spacing: 8
                Repeater {
                    model: root.presetColors
                    delegate: Rectangle {
                        width: 28; height: 28; radius: 14; color: modelData
                        border.width: root.newCalColor === modelData ? 3 : 0; border.color: Theme.palette.text
                        MouseArea { anchors.fill: parent; onClicked: root.newCalColor = modelData }
                    }
                }
            }
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
    property string setNewRole: "viewer"    // staged role in the add-member row

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
        setNewMember.text = ""; root.setNewRole = "viewer"
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
    function saveCalSettings() {
        var sch = []
        for (var i = 0; i < setSchemaModel.count; i++) {
            var it = setSchemaModel.get(i)
            var e = { key: it.key, label: it.label, type: it.ftype }
            var o = JSON.parse(it.opts || "[]")
            if (it.ftype === "enum") e.options = o
            sch.push(e)
        }
        core("updateCalendarMeta", [setCalId, JSON.stringify({ name: setName.text.trim(), description: setDesc.text.trim(), schema: sch })])
        calSettingsPopup.close(); refresh()
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
        return r[myIdentity] === "admin"
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
                    LogosText {
                        text: "Add someone by their identity (they'll find it in Diagnostics ⚙ → This device id)."
                        color: Theme.palette.textTertiary; font.pixelSize: 11; wrapMode: Text.WordWrap; Layout.fillWidth: true
                    }

                    LogosText {
                        visible: { var c = root.calById(root.setCalId); return !!c && c.rolesConfigured === false }
                        text: "This calendar is currently open — anyone with the invite can edit. Adding a member makes it role-managed."
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
                                model: ["admin", "viewer"]
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
        onOpened: joinLink.text = ""
        ColumnLayout {
            anchors.fill: parent; spacing: Theme.spacing.small
            LogosText { text: "Join a shared calendar"; color: Theme.palette.text; font.pixelSize: 18; font.weight: Theme.typography.weightMedium }
            LogosText { text: "Paste the scala:// invite link"; color: Theme.palette.textTertiary; font.pixelSize: 12 }
            Field { id: joinLink; Layout.fillWidth: true; placeholderText: "scala://join?..." }
            RowLayout {
                Layout.fillWidth: true; Layout.topMargin: Theme.spacing.small
                Item { Layout.fillWidth: true }
                LogosButton { text: "Cancel"; onClicked: joinPopup.close() }
                LogosButton {
                    text: "Join"; enabled: joinLink.text.trim().length > 0
                    onClicked: { root.core("handleShareLink", [joinLink.text.trim()]); joinPopup.close(); root.refresh() }
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
