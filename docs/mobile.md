# Mobilapp – guide

## Sidan "App-installation"
Användare kan gå till **App** i menyn (eller `/app-installation.html`) för att:
- **Android:** ladda ner APK-filen och installera (om du har lagt en byggd APK på servern).
- **iOS:** följa stegen för "Lägg till på hemskärmen" (PWA) – ingen nedladdningsfil, bara instruktioner.

APK:n serveras från `/downloads/f1tting.apk`. Om filen inte finns visar sidan ett meddelande istället för nedladdningsknappen.

---

## Ikoner och splash
I `public/icons/` finns:
- **icon-192.png**, **icon-512.png** – PWA-/appikoner (F1-röd, racing-stil)
- **splash.png** – startskärm (porträtt, 1170×2532), används t.ex. i Capacitor

PWA:n använder redan ikonerna via `manifest.webmanifest` och `apple-touch-icon` på sidorna.

---

## iOS (gratis) – PWA
1. Öppna `https://betsel.fortiddns.com` i Safari.
2. Tryck på delningsikonen → "Lägg till på hemskärmen".
3. Appen installeras som PWA (ingen App Store).

---

## Android – APK (nedladdningsbar från sidan)
Appen byggs med Capacitor och laddar sedan sidan från `https://betsel.fortiddns.com` (konfigurerat i `capacitor.config.json`).

### Första gången (på en dator med Node, **Java 21** (rekommenderat) eller Java 17 och Android Studio / Android SDK):
```bash
npm install -D @capacitor/cli
npm install @capacitor/core @capacitor/android
npx cap add android
npx cap sync
npx cap open android
```

I Android Studio: **Build → Build Bundle(s) / APK(s) → Build APK(s)**. För signerad release-APK: **Build → Generate Signed Bundle / APK → APK**.

**Bygg från terminal (kräver Java 21 eller 17):**

Capacitor 8 kräver Java 21 för Android-bygget. Skriptet letar först efter Java 21, sedan Java 17.

- **macOS med Homebrew:** installera Java 21 och kör:
  ```bash
  brew install openjdk@21   # om du inte har Java 21
  npm run build:apk
  ```
- **Eller** sätt JAVA_HOME till din JDK 21 (eller 17) innan du kör.
- **Eller** redigera `android/gradle.properties` och sätt `org.gradle.java.home` till din Java 21-sökväg.

Det bygger en **debug-APK** (kräver ingen signering) och kopierar den till `public/downloads/f1tting.apk`. För signerad release använd `npm run build:apk:release` (då måste signering vara konfigurerad i Android-projektet).

APK-filen hamnar t.ex. i:
`android/app/build/outputs/apk/release/app-release.apk`  
eller (debug):  
`android/app/build/outputs/apk/debug/app-debug.apk`.

### Göra APK tillgänglig på webbplatsen
Om du kör `npm run build:apk` kopieras APK redan till `public/downloads/f1tting.apk`. Annars kopiera manuellt:

```bash
cp android/app/build/outputs/apk/debug/app-debug.apk public/downloads/f1tting.apk
```
(För release: `app/build/outputs/apk/release/app-release.apk`.)

Deploya sedan som vanligt – då kan användare ladda ner från sidan **App-installation**.

Filen `public/downloads/*.apk` är i `.gitignore` – du behöver alltså bygga och lägga APK på servern (eller i din deploy-pipeline) efter varje ny version om du vill att nedladdning ska fungera.

---

## iOS (betald, riktig native)
Kräver Apple Developer Program. När ni har konto:

```bash
npm install @capacitor/ios
npx cap add ios
npx cap sync
npx cap open ios
```

I Xcode: välj team, signera och bygg.
