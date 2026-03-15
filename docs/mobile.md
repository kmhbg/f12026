# Mobilapp – guide

## Branch-strategi (best practice)
Vid större nya funktioner (t.ex. native iOS-app) är det **rekommenderat** att använda en **feature-branch**:

- **Huvudprojektet (f12026):** `git checkout -b feature/native-ios-app` – använd denna branch för ändringar i server, webb och dokumentation kopplade till iOS-appen. När allt är klart: merge till `main` via pull request.
- **f1_bet (eget repo):** Om f1_bet ligger i ett eget Git-repo kan du där köra `git checkout -b feature/native-ios-app` (eller liknande) för att hålla utvecklingen av iOS-appen isolerad.

Det ger en stabil `main`, tydlig historik och enkel code review.

---

## Native iOS-app (Swift/SwiftUI) med SweetPad
En **native iOS-app** finns i mappen **`f1_bet/`**. Den använder samma API som webbversionen och följer [Apple Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines/) (HIG).

### Krav
- **macOS** med **Xcode** (för att bygga och köra på simulator eller enhet)
- **SweetPad** (VSCode/Cursor-tillägg) om du vill bygga och köra från Cursor istället för Xcode: [SweetPad](https://sweetpad.hyzyla.dev/) – ger build/run, simulatorhantering och format i editorn

### Bygga och köra
1. Öppna `f1_bet/f1_bet.xcodeproj` i Xcode (eller använd SweetPad i Cursor).
2. Välj simulator eller ansluten iPhone/iPad.
3. Build & Run (⌘R).

### Konfigurera server
- I appen: **Inställningar** → ange serveradress (t.ex. `https://betsel.fortiddns.com` eller `http://localhost:3000` för utveckling).
- Servern måste ha **CORS** aktiverat (redan gjort i `server.js` med `cors()`), så att appen får anropa API:et.

### Funktionalitet
- **Spel:** Välj användare → lägg årsbet (förare/stall) och racebet (top 3 per race).
- **Dashboard:** Översikt över användare, poäng och race-resultat.
- **Rättning:** Visa rättning per avslutat race (resultat, vinnare, pot).
- **Inställningar:** Ändra API-serveradress.

Admin-funktioner (användarhantering, season override, full rättning) finns kvar på webbgränssnittet.

---

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
