#!/bin/sh
# Capacitor 8 kräver Java 21 för Android-bygget. AGP kräver minst Java 17.
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT" || exit 1

is_java_version() {
  _j="$1"
  _v="$2"
  [ -n "$_j" ] && [ -x "$_j/bin/java" ] && "$_j/bin/java" -version 2>&1 | grep -q "\"$_v"
}

find_java() {
  _want="$1"
  _j=""
  # Homebrew Apple Silicon
  for _p in "/opt/homebrew/opt/openjdk@${_want}/libexec/openjdk.jdk/Contents/Home" "/opt/homebrew/opt/openjdk@${_want}"; do
    if [ -d "$_p" ] || [ -f "$_p/bin/java" ]; then
      [ -d "$_p" ] || _p="$(dirname "$_p/.")"
      if is_java_version "$_p" "$_want"; then _j="$_p"; break; fi
    fi
  done
  # Homebrew Intel
  if [ -z "$_j" ]; then
    for _p in "/usr/local/opt/openjdk@${_want}/libexec/openjdk.jdk/Contents/Home" "/usr/local/opt/openjdk@${_want}"; do
      if [ -d "$_p" ] || [ -f "$_p/bin/java" ]; then
        [ -d "$_p" ] || _p="$(dirname "$_p/.")"
        if is_java_version "$_p" "$_want"; then _j="$_p"; break; fi
      fi
    done
  fi
  # macOS java_home
  if [ -z "$_j" ] && [ -x "/usr/libexec/java_home" ]; then
    _cand=$(/usr/libexec/java_home -v "$_want" 2>/dev/null)
    if [ -n "$_cand" ] && is_java_version "$_cand" "$_want"; then _j="$_cand"; fi
  fi
  echo "$_j"
}

JAVA_HOME_JAVA=""
# Först Java 21 (krävs av Capacitor 8)
JAVA_HOME_JAVA=$(find_java 21)
# Annars Java 17
if [ -z "$JAVA_HOME_JAVA" ]; then
  JAVA_HOME_JAVA=$(find_java 17)
fi

if [ -z "$JAVA_HOME_JAVA" ]; then
  echo "Java 21 eller 17 krävs. Installera t.ex.: brew install openjdk@21"
  echo "Eller: export JAVA_HOME=/sökväg/till/jdk21"
  exit 1
fi

export JAVA_HOME="$JAVA_HOME_JAVA"
echo "Använder: $JAVA_HOME"

node scripts/write-local-properties.js || exit 1
cap sync || exit 1
cd android && ./gradlew assembleDebug || exit 1
cp app/build/outputs/apk/debug/app-debug.apk ../public/downloads/f1tting.apk || exit 1
echo "APK kopierad till public/downloads/f1tting.apk"
cd ..
