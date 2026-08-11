/**
 * withLogosDelivery — re-applies the native Logos Delivery (embedded Waku node)
 * integration on every `expo prebuild`.
 *
 * Expo CNG regenerates android/ from scratch, so NOTHING hand-added there
 * survives. Everything this integration needs lives in native/logosdelivery/
 * (outside android/) and is copied back in here:
 *
 *   native/logosdelivery/arm64-v8a/*.so        -> app/src/main/jniLibs/arm64-v8a/
 *   native/logosdelivery/android/java/**.kt    -> app/src/main/java/**
 *
 * plus: register the RN package (it is a hand-written JNI module, so Expo
 * autolinking can't see it), add gson, and force legacy jniLibs packaging.
 *
 * The .so set is arm64-only (no public x86_64 build of liblogosdelivery), which
 * is why the Kotlin module loads its libs lazily — see LogosMessagingModule.kt.
 */
const {
  withDangerousMod,
  withAppBuildGradle,
  withMainApplication,
  withGradleProperties,
} = require("@expo/config-plugins");
const fs = require("fs");
const path = require("path");

const ABI = "arm64-v8a";
const SOS = [
  "libc++_shared.so",
  "librln.so",
  "liblogosdelivery.so",
  "liblogos_messaging_jni.so",
];
const PACKAGE_IMPORT = "com.receiverandroid.LogosMessagingPackage";

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

// 1) copy the prebuilt .so + the Kotlin bridge back into the generated project
const withNativeFiles = (config) =>
  withDangerousMod(config, [
    "android",
    async (cfg) => {
      const root = cfg.modRequest.projectRoot;
      const androidRoot = cfg.modRequest.platformProjectRoot;
      const stage = path.join(root, "native", "logosdelivery");

      const soSrc = path.join(stage, ABI);
      const soDst = path.join(androidRoot, "app/src/main/jniLibs", ABI);
      fs.mkdirSync(soDst, { recursive: true });
      for (const so of SOS) {
        const s = path.join(soSrc, so);
        if (!fs.existsSync(s)) {
          throw new Error(
            `withLogosDelivery: missing ${s}. The native Delivery libs are required; ` +
              `rebuild the JNI bridge with native/logosdelivery/jni (ndk-build).`
          );
        }
        fs.copyFileSync(s, path.join(soDst, so));
      }

      const javaSrc = path.join(stage, "android", "java");
      if (fs.existsSync(javaSrc)) {
        copyDir(javaSrc, path.join(androidRoot, "app/src/main/java"));
      }
      return cfg;
    },
  ]);

// 2) register the package — hand-written JNI module, not autolinkable
const withPackageRegistered = (config) =>
  withMainApplication(config, (cfg) => {
    let src = cfg.modResults.contents;
    if (!src.includes(PACKAGE_IMPORT)) {
      src = src.replace(
        /PackageList\(this\)\.packages\.apply\s*\{/,
        `PackageList(this).packages.apply {\n          // Native Logos Delivery (embedded Waku node) — manual JNI, not autolinkable.\n          add(${PACKAGE_IMPORT}())`
      );
      cfg.modResults.contents = src;
    }
    return cfg;
  });

// 3) gson — used by LogosMessagingModule to serialize the node config
const withGson = (config) =>
  withAppBuildGradle(config, (cfg) => {
    const dep = `implementation("com.google.code.gson:gson:2.10.1")`;
    if (!cfg.modResults.contents.includes("com.google.code.gson:gson")) {
      cfg.modResults.contents = cfg.modResults.contents.replace(
        /implementation\("com\.facebook\.react:react-android"\)/,
        `implementation("com.facebook.react:react-android")\n\n    // Native Logos Delivery module config serialization\n    ${dep}`
      );
    }
    return cfg;
  });

// 4) liblogosdelivery.so is dlopened via System.loadLibrary — it must be a real
//    file on disk, so don't leave it compressed inside the APK.
const withLegacyJniPackaging = (config) =>
  withGradleProperties(config, (cfg) => {
    const key = "expo.useLegacyPackaging";
    const existing = cfg.modResults.find((i) => i.type === "property" && i.key === key);
    if (existing) existing.value = "true";
    else cfg.modResults.push({ type: "property", key, value: "true" });
    return cfg;
  });

module.exports = (config) =>
  withLegacyJniPackaging(withGson(withPackageRegistered(withNativeFiles(config))));
