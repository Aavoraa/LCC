# LCC Stores — Android app (APK)

The Android app is a **Trusted Web Activity**: it opens the live web app
(`https://lcc-seven-opal.vercel.app`, starting on **Scan**) full-screen with the LCC Stores icon.
Every change pushed to the website shows up in the app without reinstalling; a new APK is needed
only to change the app itself (name, icon, start page, domain).

- Package: `com.lakshmicardclothing.stores`
- Minimum Android: 7.0 (SDK 24)
- Download for phones: `https://lcc-seven-opal.vercel.app/downloads/LCC-Stores.apk`
  (also linked on the sign-in page)
- Digital Asset Links: `web/public/.well-known/assetlinks.json` holds the signing key's SHA-256
  fingerprint. Without it Android shows a browser address bar at the top of the app.

## Signing key — keep it safe

`C:\Users\crren\lcc-android\signing\lcc-stores.keystore` (alias `lcc-stores`) with its password in
`keystore-password.txt` beside it. **Back both up** (e.g. to a USB drive or a password manager).
Every update of the app must be signed with this same key; if it is lost, phones must uninstall the
app and install a new one with a new fingerprint in `assetlinks.json`. Never commit the keystore.

## Rebuilding the APK on this PC

Tools live in `C:\Users\crren\lcc-android` (Java 17, Android SDK, Gradle), outside OneDrive.

1. Generate the project from the live manifest (bump the version for each release):

   ```
   cd C:\Users\crren\lcc-android\twa-gen
   set VERSION_CODE=2
   set VERSION_NAME=1.0.1
   node generate.js          (same file as android/generate.js in this repo)
   ```

   Then in `project\`: set `minSdkVersion 24` if needed, write `local.properties`
   (`sdk.dir=C\:\\Users\\crren\\lcc-android\\sdk`) and point
   `gradle\wrapper\gradle-wrapper.properties` at the downloaded Gradle zip
   (`distributionUrl=file:///C:/Users/crren/lcc-android/downloads/gradle-8.11.1-bin.zip`) —
   Java on this network cannot follow Gradle's download redirect.

2. Build (PowerShell):

   ```
   $env:JAVA_HOME = "C:\Users\crren\lcc-android\jdk17"
   $env:ANDROID_HOME = "C:\Users\crren\lcc-android\sdk"
   $env:GRADLE_USER_HOME = "C:\Users\crren\lcc-android\gradle-home"
   $env:JAVA_TOOL_OPTIONS = "-Djava.net.preferIPv4Stack=true"
   cd C:\Users\crren\lcc-android\project
   .\gradlew.bat assembleRelease --no-daemon
   ```

3. Align and sign with build-tools 36 (`zipalign -p -f 4`, then
   `apksigner sign --ks ..\signing\lcc-stores.keystore --ks-key-alias lcc-stores`), copy the result
   to `web/public/downloads/LCC-Stores.apk`, and push.
