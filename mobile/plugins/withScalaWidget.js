/**
 * withScalaWidget — re-applies the home-screen agenda widget on every `expo prebuild`.
 *
 * Expo CNG regenerates android/ from scratch, so the widget's native sources live outside it
 * (native/scalawidget/…) and are copied back in here, exactly like withLogosDelivery:
 *
 *   native/scalawidget/android/java/**.kt   -> app/src/main/java/**
 *   native/scalawidget/android/res/**       -> app/src/main/res/**
 *
 * plus: register the RN package (ScalaWidgetModule, hand-written — not autolinkable) and declare
 * the AppWidget <receiver> + the RemoteViewsService <service> in the manifest.
 *
 * The widget is fed purely by the app (src/lib/widget.ts pushes the agenda JSON to
 * SharedPreferences), so it needs no permissions and works offline.
 */
const { withDangerousMod, withMainApplication, withAndroidManifest } = require("@expo/config-plugins");
const fs = require("fs");
const path = require("path");

const PACKAGE_IMPORT = "xyz.vpavlin.scala.widget.ScalaWidgetPackage";
const RECEIVER = "xyz.vpavlin.scala.widget.ScalaAgendaWidget";
const SERVICE = "xyz.vpavlin.scala.widget.ScalaAgendaService";

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

// 1) copy the Kotlin + res back into the generated project
const withNativeFiles = (config) =>
  withDangerousMod(config, [
    "android",
    async (cfg) => {
      const root = cfg.modRequest.projectRoot;
      const androidRoot = cfg.modRequest.platformProjectRoot;
      const stage = path.join(root, "native", "scalawidget", "android");
      const javaSrc = path.join(stage, "java");
      const resSrc = path.join(stage, "res");
      if (fs.existsSync(javaSrc)) copyDir(javaSrc, path.join(androidRoot, "app/src/main/java"));
      if (fs.existsSync(resSrc)) copyDir(resSrc, path.join(androidRoot, "app/src/main/res"));
      return cfg;
    },
  ]);

// 2) register the RN package (feeds the widget) — manual module, not autolinkable
const withPackageRegistered = (config) =>
  withMainApplication(config, (cfg) => {
    let src = cfg.modResults.contents;
    if (!src.includes(PACKAGE_IMPORT)) {
      src = src.replace(
        /PackageList\(this\)\.packages\.apply\s*\{/,
        `PackageList(this).packages.apply {\n          // Home-screen agenda widget feed — manual RN module.\n          add(${PACKAGE_IMPORT}())`
      );
      cfg.modResults.contents = src;
    }
    return cfg;
  });

// 3) declare the AppWidget receiver + the RemoteViewsService
const withWidgetManifest = (config) =>
  withAndroidManifest(config, (cfg) => {
    const app = cfg.modResults.manifest.application[0];
    app.receiver = app.receiver || [];
    if (!app.receiver.some((r) => r.$?.["android:name"] === RECEIVER)) {
      app.receiver.push({
        $: { "android:name": RECEIVER, "android:exported": "false" },
        "intent-filter": [{ action: [{ $: { "android:name": "android.appwidget.action.APPWIDGET_UPDATE" } }] }],
        "meta-data": [{ $: { "android:name": "android.appwidget.provider", "android:resource": "@xml/scala_widget_info" } }],
      });
    }
    app.service = app.service || [];
    if (!app.service.some((s) => s.$?.["android:name"] === SERVICE)) {
      app.service.push({
        $: {
          "android:name": SERVICE,
          "android:permission": "android.permission.BIND_REMOTEVIEWS",
          "android:exported": "false",
        },
      });
    }
    return cfg;
  });

module.exports = (config) => withWidgetManifest(withPackageRegistered(withNativeFiles(config)));
