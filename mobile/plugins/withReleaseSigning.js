/**
 * withReleaseSigning — sign release builds with the real Perun key.
 *
 * Expo's template signs BOTH debug and release with the checked-in debug
 * keystore. That key is the well-known Android debug key: not secret, and
 * shared — anyone could sign an APK your phone would accept as an update to
 * Perun. It's also a one-way door: Android identifies an app by its signing
 * certificate, so switching keys after publishing forces every user to
 * uninstall/reinstall.
 *
 * Credentials are NOT in this repo (it's public, and losing the key means the
 * app can never be updated again). They live in the user-global
 * ~/.gradle/gradle.properties:
 *
 *   PERUN_STORE_FILE=/home/vpavlin/keystores/perun-release.jks
 *   PERUN_STORE_PASSWORD=…   PERUN_KEY_ALIAS=perun   PERUN_KEY_PASSWORD=…
 *
 * If those properties are absent (e.g. a fresh clone / CI without secrets) the
 * build falls back to the debug key rather than failing.
 */
const { withAppBuildGradle } = require("@expo/config-plugins");

const RELEASE_SIGNING_CONFIG = `
        release {
            // Credentials come from ~/.gradle/gradle.properties (outside this repo).
            if (project.hasProperty('PERUN_STORE_FILE')) {
                storeFile file(project.property('PERUN_STORE_FILE'))
                storePassword project.property('PERUN_STORE_PASSWORD')
                keyAlias project.property('PERUN_KEY_ALIAS')
                keyPassword project.property('PERUN_KEY_PASSWORD')
            }
        }`;

module.exports = (config) =>
  withAppBuildGradle(config, (cfg) => {
    let s = cfg.modResults.contents;

    if (!s.includes("PERUN_STORE_FILE")) {
      // 1) add a `release` signing config alongside the template's `debug` one
      const before = s;
      s = s.replace(/(signingConfigs\s*\{)/, `$1${RELEASE_SIGNING_CONFIG}`);
      if (s === before) throw new Error("withReleaseSigning: signingConfigs block not found");

      // 2) point the release buildType at it, falling back to debug when unsigned.
      //    Anchored on the template's caution comment so we only hit the release
      //    buildType (the string `signingConfig signingConfigs.debug` appears twice).
      const anchor =
        /(\/\/ Caution! In production[^\n]*\n\s*\/\/ see [^\n]*\n\s*)signingConfig signingConfigs\.debug/;
      if (!anchor.test(s)) throw new Error("withReleaseSigning: release buildType anchor not found");
      s = s.replace(
        anchor,
        `$1signingConfig project.hasProperty('PERUN_STORE_FILE') ? signingConfigs.release : signingConfigs.debug`
      );

      cfg.modResults.contents = s;
    }
    return cfg;
  });
