#!/bin/bash
# Build Sky Window's projector app (a fullscreen WebView) without Gradle.
#   ./build.sh            -> out/skywindow.apk
# Needs: a JDK, plus Android build-tools 34 and platform 28 (see README-kalimpong.md).
set -eu
cd "$(dirname "$0")"
SDK="${ANDROID_SDK:-$HOME/Library/Android/sdk}"
BT="$SDK/build-tools/34.0.0"
JAR="$SDK/platforms/android-28/android.jar"
JAVA_BIN="${JAVA_BIN:-/opt/homebrew/opt/openjdk@17/bin}"
export PATH="$JAVA_BIN:$PATH"
KS="debug.keystore"

mkdir -p out/classes out/dex
"$BT/aapt2" compile --dir res -o out/res.zip
"$BT/aapt2" link -o out/base.apk -I "$JAR" --manifest AndroidManifest.xml out/res.zip
javac -nowarn --release 11 -cp "$JAR" -d out/classes src/com/skylight/wall/MainActivity.java
"$BT/d8" --min-api 21 --lib "$JAR" --output out/dex $(find out/classes -name '*.class')
cp out/base.apk out/unsigned.apk
(cd out/dex && zip -q -j ../unsigned.apk classes.dex)
"$BT/zipalign" -f 4 out/unsigned.apk out/aligned.apk
if [[ ! -f "$KS" ]]; then
  keytool -genkeypair -keystore "$KS" -storepass android -keypass android -alias wall \
    -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Sky Window local build"
fi
"$BT/apksigner" sign --ks "$KS" --ks-pass pass:android --key-pass pass:android --out out/skywindow.apk out/aligned.apk
"$BT/apksigner" verify out/skywindow.apk && echo "built $(pwd)/out/skywindow.apk"
