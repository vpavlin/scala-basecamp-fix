// Offscreen render harness for CalendarView.qml. Injects a mock `logos` context object
// (callModule returns canned JSON) so the view renders without the Basecamp host. Prints
// every QML runtime message to stderr, then screenshots the main view + the new-calendar
// popup + an event editor (with a custom-field schema) so we can SEE what the user sees.
//   usage: harness <CalendarView.qml> <outDir>
#include <QGuiApplication>
#include <QQuickView>
#include <QQmlContext>
#include <QQmlEngine>
#include <QQmlExpression>
#include <QQuickItem>
#include <QObject>
#include <QVariant>
#include <QTimer>
#include <QImage>
#include <QDateTime>
#include <QDebug>

static QString CAL_MS, EV_START, EV_END;

class MockLogos : public QObject {
    Q_OBJECT
public:
    explicit MockLogos(QObject *p = nullptr) : QObject(p) {}
    bool kcPending = false;   // flips true once enrollKeycard is called → keycardState reports pending
    // NOTE: defined OUT OF LINE below — moc's parser chokes on raw string literals inside
    // an inline class body, so keep the class declaration clean.
    Q_INVOKABLE QString callModule(const QString &mod, const QString &method, const QVariant &args);
};

QString MockLogos::callModule(const QString &mod, const QString &method, const QVariant &args) {
    Q_UNUSED(mod);
    // Log every WRITE call with its args, so we can see exactly what the view sends the core.
    if (method != "listCalendars" && method != "listEvents" && method != "getIdentity" && method != "diagnostics") {
        const QVariantList a = args.toList();
        QStringList parts;
        for (const auto &v : a) parts << v.toString();
        fprintf(stderr, "[CALL] %s(%s)\n", qPrintable(method), qPrintable(parts.join(" | ")));
    }
    if (method == "listCalendars")
        return QString(R"([{"id":"c1","name":"Team","color":"#89b4fa","encryptionKey":"k","creatorId":"0xowner","owner":"0xowner","roles":{},"rolesConfigured":false,"open":true,"schema":[]}])");
    if (method == "listEvents")
        return QString(R"([{"id":"e1","calendarId":"c1","title":"Their event","startTime":%1,"endTime":%2,"creatorId":"0xowner"}])")
            .arg(EV_START).arg(EV_END);
    if (method == "createCalendar") return "\"cNEW\""; // JSON-encoded id (like the real core) — must be j()-unwrapped
    // Mock Alisher's keycard module (ADR 0016): requestSign → pending signId; checkSignStatus stays
    // pending (so the "hold your Keycard" overlay renders for the screenshot).
    if (method == "requestSign") return QString(R"({"signId":"sig-1","status":"pending"})");
    if (method == "checkSignStatus") return QString(R"({"signId":"sig-1","status":"pending"})");
    // Keycard authoring (scala ADR 0016): enrollKeycard flips a pending state that keycardState()
    // reports, so the "hold your Keycard" overlay renders. removeKeycardIdentity is a no-op.
    if (method == "enrollKeycard") { kcPending = true; return "\"enroll:scala:mock\""; }
    if (method == "keycardState")
        return kcPending ? QString(R"({"active":true,"purpose":"enroll","phase":"pending","ref":"enroll:scala:mock"})")
                         : QString(R"({"active":false})");
    // Mock loam_core's identity service (loam ADR 0004) for the Identities panel. Includes a keycard
    // identity so the 💳 badge + removal render.
    if (method == "listIdentities")
        return QString(R"([{"id":"device","kind":"device","label":"This device","address":"0xme00000000000000000000000000000000000000","pubHex":"02aa"},{"id":"soft-1","kind":"soft","label":"Work","address":"0xwork1111111111111111111111111111111111","pubHex":"03bb"},{"id":"keycard-1","kind":"keycard","label":"My Keycard","domain":"scala","address":"0xcard2222222222222222222222222222222222","pubHex":"02cc"}])");
    if (method == "getDefaultIdentityId") return QString(R"("device")");
    if (method == "identityForContainer") return QString(R"({"id":"device","kind":"device","label":"This device","address":"0xme00000000000000000000000000000000000000","pubHex":"02aa"})");
    if (method == "getIdentity") return "\"0xme00000000000000000000000000000000000000\"";
    if (method == "diagnostics")
        return QString(R"({"deliveryStatus":"Connected","ctxReady":true,"calendarCount":1,"eventCount":1,"identity":"0xme00000000000000000000000000000000000000","dataDir":"/tmp/scala","calendars":[]})");
    return ""; // createCalendar/updateCalendarMeta/createEvent/etc → success no-op
}

static void grab(QQuickView *v, const QString &path) {
    QImage img = v->grabWindow();
    if (!img.isNull()) { img.save(path); fprintf(stderr, "[shot] %s (%dx%d)\n", qPrintable(path), img.width(), img.height()); }
    else fprintf(stderr, "[shot] NULL image for %s\n", qPrintable(path));
}
static void runJs(QQuickView *v, const QString &js) {
    // Evaluate in the ROOT OBJECT's context so document-scoped ids (newCalPopup, …) resolve.
    QQmlContext *ctx = QQmlEngine::contextForObject(v->rootObject());
    QQmlExpression e(ctx, v->rootObject(), js);
    e.evaluate();
    if (e.hasError()) fprintf(stderr, "[js-err] %s :: %s\n", qPrintable(js), qPrintable(e.error().toString()));
}

int main(int argc, char **argv) {
    qInstallMessageHandler([](QtMsgType t, const QMessageLogContext &, const QString &m) {
        fprintf(stderr, "[qml:%d] %s\n", t, qPrintable(m)); fflush(stderr);
    });
    QGuiApplication app(argc, argv);
    if (argc < 3) { qWarning() << "usage: harness <CalendarView.qml> <outDir>"; return 2; }
    const QString qml = argv[1], out = argv[2];
    qint64 now = QDateTime::currentMSecsSinceEpoch();
    EV_START = QString::number(now + 3600000); EV_END = QString::number(now + 7200000);

    auto *logos = new MockLogos(&app);
    QQuickView view;
    view.rootContext()->setContextProperty("logos", logos);
    view.setResizeMode(QQuickView::SizeRootObjectToView);
    view.resize(1100, 760);
    view.setSource(QUrl::fromLocalFile(qml));
    if (view.status() == QQuickView::Error) {
        for (const auto &e : view.errors()) fprintf(stderr, "[load-err] %s\n", qPrintable(e.toString()));
        return 3;
    }
    view.show();

    // Let the 3s poll + first frame settle, then screenshot each surface in turn.
    QTimer::singleShot(1200, [&] { grab(&view, out + "/01-main.png"); });
    // New-calendar dialog now has the custom-fields editor (matches settings).
    QTimer::singleShot(1600, [&] { runJs(&view, "openEditEvent(events[0])"); });
    QTimer::singleShot(2000, [&] { grab(&view, out + "/01-edit-others.png"); runJs(&view, "eventPopup.close()"); });
    QTimer::singleShot(2400, [&] { runJs(&view, "openNewEvent()"); });
    QTimer::singleShot(2800, [&] { grab(&view, out + "/02-new-own.png"); runJs(&view, "eventPopup.close()"); });
    QTimer::singleShot(3100, [&] { runJs(&view, "newCalPopup.open()"); });
    QTimer::singleShot(3300, [&] { runJs(&view, "newCalIdentity = 'soft-1'"); }); // simulate picking "Work"
    QTimer::singleShot(3500, [&] { grab(&view, out + "/03-newcal.png"); runJs(&view, "newCalPopup.close()"); });
    QTimer::singleShot(3800, [&] { runJs(&view, "openCalSettings(calById(\"c1\"))"); });
    QTimer::singleShot(4200, [&] { grab(&view, out + "/04-settings.png"); runJs(&view, "calSettingsPopup.close()"); });
    QTimer::singleShot(4500, [&] { runJs(&view, "refreshIdentities(); identitiesPopup.open()"); });
    QTimer::singleShot(4900, [&] { grab(&view, out + "/05-identities.png"); });
    // Keycard overlay: trigger enrol → keycardState() reports pending → the 700ms poll opens it.
    QTimer::singleShot(5100, [&] { runJs(&view, "core('enrollKeycard', ['My Keycard','scala']); identitiesPopup.close()"); });
    QTimer::singleShot(6100, [&] { grab(&view, out + "/06-keycard-overlay.png"); });
    QTimer::singleShot(6500, [&] { app.quit(); });
    return app.exec();
}
#include "harness.moc"
