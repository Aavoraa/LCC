// Generates the LCC Stores Android project (Trusted Web Activity) from the live web app manifest.
const path = require("path");
const { TwaManifest, TwaGenerator, ConsoleLog } = require("@bubblewrap/core");

const SITE = "https://lcc-seven-opal.vercel.app";
const OUT = path.resolve(__dirname, "..", "project");

(async () => {
  const log = new ConsoleLog("lcc");
  const m = await TwaManifest.fromWebManifest(`${SITE}/manifest.webmanifest`);
  m.packageId = "com.lakshmicardclothing.stores";
  m.name = "Lakshmi ERP";
  m.launcherName = "LCC Stores";
  m.startUrl = "/scan";
  m.appVersionCode = Number(process.env.VERSION_CODE || 1);
  m.appVersionName = process.env.VERSION_NAME || "1.0.0";
  m.orientation = "portrait";
  m.enableNotifications = false;
  m.fallbackType = "customtabs";
  m.enableSiteSettingsShortcut = true;
  m.minSdkVersion = 24;  // androidbrowserhelper 2.7+ needs Android 7.0
  m.signingKey = { path: "C:/Users/crren/lcc-android/signing/lcc-stores.keystore", alias: "lcc-stores" };
  await new TwaGenerator().createTwaProject(OUT, m, log);
  await m.saveToFile(path.join(OUT, "twa-manifest.json"));
  console.log("Project generated at", OUT, "for", m.host, "package", m.packageId);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
