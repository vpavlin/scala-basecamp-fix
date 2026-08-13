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
    Q_UNUSED(mod); Q_UNUSED(args);
    if (method == "listCalendars")
        return QString(R"([{"id":"c1","name":"Freequencies","color":"#89b4fa","description":"Lisbon nightlife planner","encryptionKey":"k","creatorId":"0xme","owner":"0xme","roles":{},"rolesConfigured":false,"schema":[{"key":"venue","label":"Venue","type":"text"},{"key":"lineup","label":"Lineup","type":"longtext"},{"key":"vip","label":"VIP","type":"bool"},{"key":"status","label":"Status","type":"enum","options":["confirmed","tentative"]}]}])");
    if (method == "listEvents")
        return QString(R"([{"id":"e1","calendarId":"c1","title":"Opening night","startTime":%1,"endTime":%2,"fields":{"venue":"Club X","vip":true,"status":"confirmed"}}])")
            .arg(EV_START).arg(EV_END);
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
    QTimer::singleShot(1600, [&] { runJs(&view, "newCalPopup.open()"); });
    QTimer::singleShot(2100, [&] { grab(&view, out + "/02-newcal.png"); runJs(&view, "newCalPopup.close()"); });
    QTimer::singleShot(2500, [&] { runJs(&view, "openCalSettings(calendars[0])"); });
    QTimer::singleShot(3000, [&] { grab(&view, out + "/03-calsettings.png"); runJs(&view, "calSettingsPopup.close()"); });
    QTimer::singleShot(3400, [&] { runJs(&view, "openNewEvent()"); });
    QTimer::singleShot(3900, [&] { grab(&view, out + "/04-newevent.png"); });
    QTimer::singleShot(4300, [&] { app.quit(); });
    return app.exec();
}
#include "harness.moc"
