// KeycardSign.qml — desktop Keycard signing flow (ADR 0016). Reusable + render-verified via the
// qml-harness with a MOCKED `keycard` module; not yet wired into authoring (that needs the core's
// beginKeycardEvent / attachAndPublishKeycardEvent + a real card + PC/SC reader).
//
// Drives Alisher's keycard Basecamp module: requestSign → poll checkSignStatus → callbacks. Shows a
// "hold your Keycard" overlay while pending; friendly error on reject/timeout (the module leaves
// wrong-PIN/lockout at `pending`, so WE own the timeout). All crypto stays in the core; this only
// shuttles the digest out and the signature back.
import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Logos.Theme
import Logos.Controls

Item {
    id: kc
    // The Basecamp context object exposing callModule(mod, method, args) → JSON string.
    property var logos
    property int pollMs: 800
    property int timeoutMs: 60000
    property bool busy: false

    property string _signId: ""
    property var _onDone: null
    property var _onFail: null
    property int _elapsed: 0

    function _j(raw, fb) { try { return JSON.parse(raw) } catch (e) { return fb } }
    // SOFT dependency: keycard is optional (ADR 0016). callModule to a module that isn't installed
    // may throw / return null — treat any failure as "unavailable" so scala keeps working without it.
    function _call(method, args) { try { return logos.callModule("keycard", method, args) } catch (e) { return "" } }
    // Feature-detect: is the keycard module present + a card usable? (cheap, no tap). Gate the UI on this.
    function available() { var r = _j(_call("checkSignStatus", ["__probe__"]), null); return r !== null }

    // Sign a 32-byte digest (hex) on the card. onDone(sigHex) / onFail(msg).
    function sign(digestHex, onDone, onFail) {
        _onDone = onDone; _onFail = onFail; _elapsed = 0
        var r = _j(_call("requestSign", [JSON.stringify({
            domain: "scala", payloadHash: digestHex, caller: "scala", scheme: "ecdsa" })]), {})
        if (!r.signId) { _fail(r.error || "Keycard unavailable — is the module installed and a reader connected?"); return }
        _signId = r.signId; busy = true; tapOverlay.open(); poll.restart()
    }
    function cancel() { _fail("Cancelled.") }
    function _fail(msg) { poll.stop(); busy = false; tapOverlay.close(); if (_onFail) _onFail(msg) }
    function _ok(sig) { poll.stop(); busy = false; tapOverlay.close(); if (_onDone) _onDone(sig) }

    Timer {
        id: poll; interval: kc.pollMs; repeat: true
        onTriggered: {
            kc._elapsed += kc.pollMs
            if (kc._elapsed > kc.timeoutMs) { kc._fail("Timed out waiting for the card. Try again."); return }
            var s = kc._j(kc._call("checkSignStatus", [kc._signId]), {})
            if (s.status === "complete" && s.signature) kc._ok(s.signature)
            else if (s.status === "rejected") kc._fail("Signing was declined on the card.")
            else if (s.error) kc._fail(s.error)
            // else pending → keep polling (wrong-PIN/lockout also stay pending → our timeout catches it)
        }
    }

    Popup {
        id: tapOverlay
        anchors.centerIn: Overlay.overlay
        modal: true; closePolicy: Popup.NoAutoClose
        padding: Theme.spacing.large
        background: Rectangle { radius: Theme.spacing.radiusMedium; color: Theme.palette.backgroundElevated; border.width: 1; border.color: Theme.palette.borderHairline }
        ColumnLayout {
            spacing: Theme.spacing.medium
            LogosText { text: "🔑"; font.pixelSize: 40; Layout.alignment: Qt.AlignHCenter }
            LogosText { text: "Hold your Keycard to the reader…"; color: Theme.palette.text; font.pixelSize: 15; Layout.alignment: Qt.AlignHCenter }
            LogosText { text: "Enter your PIN on the card when prompted, then keep it on the reader until it's signed."
                color: Theme.palette.textSecondary; font.pixelSize: 12; wrapMode: Text.WordWrap; horizontalAlignment: Text.AlignHCenter
                Layout.maximumWidth: 300; Layout.alignment: Qt.AlignHCenter }
            LogosButton { text: "Cancel"; Layout.alignment: Qt.AlignHCenter; onClicked: kc.cancel() }
        }
    }
}
