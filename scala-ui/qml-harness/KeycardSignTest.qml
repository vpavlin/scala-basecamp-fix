// Harness fixture: instantiate KeycardSign, auto-trigger sign() so the "hold your Keycard" overlay
// renders (mock keycard module returns pending). Verifies KeycardSign.qml loads + renders clean.
import QtQuick
import Logos.Theme
import "../qml"

Rectangle {
    id: rootRect
    width: 1100; height: 760; color: Theme.palette.background
    property string msg: "(signing…)"
    property var ctxLogos: logos // capture the harness context property under a distinct name (no loop)

    Text { anchors.centerIn: parent; text: rootRect.msg; color: Theme.palette.text; font.pixelSize: 14 }

    KeycardSign { id: signer; logos: rootRect.ctxLogos }

    Component.onCompleted: Qt.callLater(function () {
        signer.sign("00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
            function (sig) { rootRect.msg = "signed: " + sig },
            function (err) { rootRect.msg = "failed: " + err })
    })
}
