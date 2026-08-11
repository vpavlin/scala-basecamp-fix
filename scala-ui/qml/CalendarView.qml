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

    readonly property var monthNames: ["January","February","March","April","May","June","July","August","September","October","November","December"]
    readonly property var weekDays: ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"]

    Component.onCompleted: Qt.callLater(function () {
        root.ready = (typeof logos !== "undefined" && !!logos.callModule)
        if (root.ready) refresh()
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

    RowLayout {
        anchors.fill: parent
        spacing: 0

        // ── sidebar: calendars ─────────────────────────────────────────────
        Rectangle {
            Layout.preferredWidth: 240
            Layout.fillHeight: true
            color: Theme.palette.backgroundInset
            ColumnLayout {
                anchors.fill: parent
                anchors.margins: Theme.spacing.medium
                spacing: Theme.spacing.small

                LogosText { text: "Calendars"; color: Theme.palette.text; font.pixelSize: 18; font.weight: Theme.typography.weightMedium }

                // "All calendars" row
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
                        width: ListView.view.width; height: 34; radius: Theme.spacing.radiusSmall
                        color: root.filterCalId === modelData.id ? Theme.palette.backgroundSecondary : "transparent"
                        RowLayout {
                            anchors.fill: parent; anchors.leftMargin: Theme.spacing.small; anchors.rightMargin: Theme.spacing.small; spacing: Theme.spacing.small
                            Rectangle { width: 12; height: 12; radius: 6; color: root.calColor(modelData.id) }
                            LogosText { text: modelData.name || "(unnamed)"; color: Theme.palette.text; font.pixelSize: 14; Layout.fillWidth: true; elide: Text.ElideRight }
                            LogosText {
                                text: "share"; color: Theme.palette.primary; font.pixelSize: 12
                                visible: !!modelData.encryptionKey || true
                                MouseArea { anchors.fill: parent; onClicked: root.openShare(modelData) }
                            }
                        }
                        MouseArea { anchors.fill: parent; z: -1; onClicked: root.filterCalId = modelData.id }
                    }
                }

                LogosButton { Layout.fillWidth: true; text: "+ New calendar"; onClicked: newCalPopup.open() }
                LogosButton { Layout.fillWidth: true; text: "Join calendar"; onClicked: joinPopup.open() }
            }
        }

        // ── main: month + day detail ───────────────────────────────────────
        ColumnLayout {
            Layout.fillWidth: true; Layout.fillHeight: true
            spacing: 0

            // header
            RowLayout {
                Layout.fillWidth: true
                Layout.margins: Theme.spacing.medium
                spacing: Theme.spacing.small
                LogosButton { text: "‹"; onClicked: root.viewMonth = new Date(root.viewMonth.getFullYear(), root.viewMonth.getMonth() - 1, 1) }
                LogosText {
                    text: root.monthNames[root.viewMonth.getMonth()] + " " + root.viewMonth.getFullYear()
                    color: Theme.palette.text; font.pixelSize: 20; font.weight: Theme.typography.weightMedium
                    Layout.minimumWidth: 180
                }
                LogosButton { text: "›"; onClicked: root.viewMonth = new Date(root.viewMonth.getFullYear(), root.viewMonth.getMonth() + 1, 1) }
                LogosButton { text: "Today"; onClicked: { var n = new Date(); root.viewMonth = n; root.selectedDay = n } }
                Item { Layout.fillWidth: true }
                LogosText { text: root.ready ? (root.calendars.length + " calendar(s)") : "connecting…"; color: Theme.palette.textTertiary; font.pixelSize: 12 }
                LogosButton { text: "Debug"; onClicked: root.openDiag() }
                LogosButton { text: "+ New event"; onClicked: root.openNewEvent() }
            }

            // weekday header
            RowLayout {
                Layout.fillWidth: true; Layout.leftMargin: Theme.spacing.medium; Layout.rightMargin: Theme.spacing.medium; spacing: 2
                Repeater {
                    model: root.weekDays
                    LogosText { text: modelData; color: Theme.palette.textTertiary; font.pixelSize: 11; horizontalAlignment: Text.AlignHCenter; Layout.fillWidth: true }
                }
            }

            // month grid
            GridLayout {
                id: grid
                Layout.fillWidth: true
                Layout.preferredHeight: 300
                Layout.leftMargin: Theme.spacing.medium; Layout.rightMargin: Theme.spacing.medium; Layout.topMargin: 4
                columns: 7; rowSpacing: 2; columnSpacing: 2

                Repeater {
                    model: 42
                    delegate: Rectangle {
                        id: cell
                        Layout.fillWidth: true; Layout.fillHeight: true
                        radius: Theme.spacing.radiusSmall
                        // first cell = Monday on/before the 1st of viewMonth
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

            Rectangle { Layout.fillWidth: true; height: 1; color: Theme.palette.borderHairline; Layout.topMargin: Theme.spacing.small }

            // day detail
            LogosText {
                text: Qt.formatDate(root.selectedDay, "dddd, MMMM d")
                color: Theme.palette.text; font.pixelSize: 16; font.weight: Theme.typography.weightMedium
                Layout.margins: Theme.spacing.medium
            }
            // Wrap the list in an Item so the ColumnLayout gives it a real height
            // (a bare ListView with Layout.fillHeight can collapse to 0). The empty
            // state is a sibling of the ListView inside this Item, so it shows even
            // when the list is empty.
            Item {
                Layout.fillWidth: true; Layout.fillHeight: true
                Layout.leftMargin: Theme.spacing.medium; Layout.rightMargin: Theme.spacing.medium
                Layout.bottomMargin: Theme.spacing.medium

                ListView {
                    id: dayList
                    anchors.fill: parent; clip: true
                    model: root.eventsOnDay(root.selectedDay)
                    spacing: Theme.spacing.small
                    delegate: Rectangle {
                        width: dayList.width; height: 56; radius: Theme.spacing.radiusMedium
                        color: Theme.palette.backgroundInset
                        RowLayout {
                            anchors.fill: parent; anchors.leftMargin: Theme.spacing.medium; anchors.rightMargin: Theme.spacing.medium; spacing: Theme.spacing.medium
                            Rectangle { width: 6; height: 36; radius: 3; color: root.calColor(modelData.calendarId); Layout.alignment: Qt.AlignVCenter }
                            ColumnLayout {
                                Layout.fillWidth: true; spacing: 2
                                LogosText { text: modelData.title || "(untitled)"; color: Theme.palette.text; font.pixelSize: 15; font.weight: Theme.typography.weightMedium; elide: Text.ElideRight; Layout.fillWidth: true }
                                LogosText {
                                    text: root.fmtTime(modelData.startTime) + " – " + root.fmtTime(modelData.endTime)
                                          + "   " + root.calName(modelData.calendarId)
                                    color: Theme.palette.textSecondary; font.pixelSize: 12; elide: Text.ElideRight; Layout.fillWidth: true
                                }
                            }
                        }
                        MouseArea { anchors.fill: parent; onClicked: root.openEditEvent(modelData) }
                    }
                }
                LogosText {
                    anchors.centerIn: parent
                    visible: dayList.count === 0
                    text: "No events on this day. Click “+ New event”."
                    color: Theme.palette.textTertiary; font.pixelSize: 13
                }
            }
        }
    }

    // ── event editor popup ─────────────────────────────────────────────────
    property var editingEvent: null       // null = creating
    property string editCalId: ""
    function openNewEvent() {
        var w = writableCalendars()
        if (w.length === 0) { newCalPopup.open(); return }
        editingEvent = null
        editCalId = w[0].id
        var start = new Date(selectedDay); start.setHours(9, 0, 0, 0)
        var end = new Date(selectedDay); end.setHours(10, 0, 0, 0)
        evTitle.text = ""; evDate.text = fmtDateInput(start)
        evStart.text = fmtTimeInput(start); evEnd.text = fmtTimeInput(end); evNotes.text = ""
        eventPopup.open()
    }
    function openEditEvent(ev) {
        editingEvent = ev
        editCalId = ev.calendarId
        var s = new Date(ev.startTime), e = new Date(ev.endTime)
        evTitle.text = ev.title || ""; evDate.text = fmtDateInput(s)
        evStart.text = fmtTimeInput(s); evEnd.text = fmtTimeInput(e); evNotes.text = ev.description || ""
        eventPopup.open()
    }
    function saveEvent() {
        var s = parseDateTime(evDate.text, evStart.text)
        var e = parseDateTime(evDate.text, evEnd.text)
        if (e.getTime() <= s.getTime()) e = new Date(s.getTime() + 3600000)
        if (editingEvent) {
            var up = editingEvent
            up.title = evTitle.text.trim(); up.startTime = s.getTime(); up.endTime = e.getTime(); up.description = evNotes.text.trim()
            core("updateEvent", [JSON.stringify(up)])
        } else {
            var nv = { title: evTitle.text.trim(), startTime: s.getTime(), endTime: e.getTime(), allDay: false, description: evNotes.text.trim() }
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
            Flow {
                Layout.fillWidth: true; spacing: 6
                Repeater {
                    model: root.writableCalendars()
                    delegate: Rectangle {
                        height: 30; radius: 15; width: chipRow.width + 20
                        color: root.editCalId === modelData.id ? Theme.palette.backgroundSecondary : Theme.palette.background
                        border.width: 1; border.color: root.editCalId === modelData.id ? Theme.palette.primary : Theme.palette.borderHairline
                        Row { id: chipRow; anchors.centerIn: parent; spacing: 6
                            Rectangle { width: 10; height: 10; radius: 5; color: modelData.color || Theme.palette.primary; anchors.verticalCenter: parent.verticalCenter }
                            LogosText { text: modelData.name || "(cal)"; color: Theme.palette.text; font.pixelSize: 13 }
                        }
                        MouseArea { anchors.fill: parent; enabled: !root.editingEvent; onClicked: root.editCalId = modelData.id }
                        opacity: (root.editingEvent && root.editCalId !== modelData.id) ? 0.4 : 1
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
        width: 360; modal: true; padding: Theme.spacing.large
        background: Rectangle { radius: Theme.spacing.radiusMedium; color: Theme.palette.backgroundElevated; border.width: 1; border.color: Theme.palette.borderHairline }
        onOpened: { newCalName.text = ""; root.newCalColor = root.presetColors[1] }
        ColumnLayout {
            anchors.fill: parent; spacing: Theme.spacing.small
            LogosText { text: "New calendar"; color: Theme.palette.text; font.pixelSize: 18; font.weight: Theme.typography.weightMedium }
            Field { id: newCalName; Layout.fillWidth: true; placeholderText: "Calendar name" }
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
                    onClicked: { root.core("createCalendar", [newCalName.text.trim(), root.newCalColor]); newCalPopup.close(); root.refresh() }
                }
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
            LogosText { text: "This device id"; color: Theme.palette.textTertiary; font.pixelSize: 11 }
            Field { text: root.diag ? (root.diag.identity || "(none)") : ""; Layout.fillWidth: true; readOnly: true; selectByMouse: true }

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
