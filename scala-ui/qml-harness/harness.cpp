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
        return QString(R"([{"id":"c1","name":"Plain","color":"#a6e3a1","encryptionKey":"k","creatorId":"0xme","owner":"0xme","roles":{},"rolesConfigured":false,"schema":[]},{"id":"c2","name":"Freequencies","color":"#89b4fa","description":"nightlife","encryptionKey":"k","creatorId":"0xowner","owner":"0xowner","roles":{"0xme00000000000000000000000000000000000000":"viewer"},"rolesConfigured":true,"schema":[{"key":"venue","label":"Venue","type":"text"}]}])");
    if (method == "listEvents")
        return QString(R"([{"id":"e1","calendarId":"c1","title":"Opening night","startTime":%1,"endTime":%2,"fields":{"venue":"Club X","vip":true,"status":"confirmed"}}])")
            .arg(EV_START).arg(EV_END);
    if (method == "createCalendar") return "\"cNEW\""; // JSON-encoded id (like the real core) — must be j()-unwrapped
    if (method == "getIdentity") return "0xme00000000000000000000000000000000000000";
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
    QTimer::singleShot(1600, [&] { runJs(&view, "openNewEvent()"); });
    QTimer::singleShot(2000, [&] { grab(&view, out + "/01-newevent-plain.png"); fprintf(stderr, "--- switch to c2 (schema calendar) ---\n"); runJs(&view, "evCalSelect.activated(1)"); });
    QTimer::singleShot(2500, [&] { grab(&view, out + "/02-newevent-schema.png"); });
    QTimer::singleShot(2900, [&] { app.quit(); });
    return app.exec();
}
#include "harness.moc"
