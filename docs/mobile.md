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

### Felsök: /api/metadata fungerar på localhost men inte på betsel.fortiddns.com
Om du når `http://localhost:3000/api/metadata` men inte `https://betsel.fortiddns.com/api/metadata` betyder det att den **publika servern** inte skickar trafik till Node-appen. Kontrollera på **servern** som betsel.fortiddns.com pekar på:

1. **Kör Node-appen**  
   `systemctl status f1-betting` (eller vad tjänsten heter). Om den inte kör: starta med `deploy/deploy.sh` eller `node server.js` i projektmappen. Appen måste lyssna på port 3000.

2. **Port 80/443 måste gå till Node**  
   När någon anropar `betsel.fortiddns.com/api/metadata` måste webbservern (Caddy, nginx, Apache) **skicka vidare** till `localhost:3000`. Om du bara har en vanlig webbhotell/statisk server utan reverse proxy kommer `/api/*` inte att nå Node.

3. **Caddy med din domän**  
   Om du använder Caddy: lägg in ett block för din domän i Caddyfile och skicka all trafik till Node:
   ```caddy
   betsel.fortiddns.com {
       reverse_proxy localhost:3000
   }
   ```
   Kör sedan `sudo systemctl reload caddy`. Se även `deploy/Caddyfile` och `deploy/Caddyfile.betsel.example`.

4. **Nginx**  
   Om du använder nginx behöver du en `location /` (eller `location /api`) som `proxy_pass http://127.0.0.1:3000;`.

5. **Testa på servern**  
   SSH:a in på maskinen och kör:  
   `curl -s http://localhost:3000/api/metadata`  
   Får du JSON tillbaka kör Node och Caddy/nginx bara inte vidare från utsidan – då är det punkt 2–4. Får du inget svar kör inte Node eller lyssnar inte på 3000.

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

### Webb / PWA
I `public/icons/` finns:
- **icon-192.png**, **icon-512.png** – PWA-/appikoner (F1-röd, racing-stil)
- **splash.png** – startskärm (porträtt, 1170×2532), används t.ex. i Capacitor

PWA:n använder redan ikonerna via `manifest.webmanifest` och `apple-touch-icon` på sidorna.

### Native iOS-app (f1_bet)
- **App-ikon:** `f1_bet/f1_bet/Assets.xcassets/AppIcon.appiconset/` – byt ut **AppIcon.png** (1024×1024 px, PNG, ej genomskinlig). Xcode använder den för alla storlekar. Enligt [Apple HIG](https://developer.apple.com/design/human-interface-guidelines/app-icons): konstverket ska gå ända till kanterna (full-bleed), ingen vit ram eller inre kant; systemet lägger själv på rundade hörn.
- **Splash / launch screen:** Konfigurerad i **Info.plist** (`UILaunchScreen`) med bakgrundsfärgen **LaunchBackground** och bilden **F1Logo** från Assets. För att ändra: redigera `LaunchBackground.colorset` eller byt bild i Asset Catalog; för egen splash-bild lägg till en bildasset och sätt `UIImageName` i Info.plist till dess namn.

---

## Dela native iOS-appen med vänner (EU / sideloading)

I EU tillåter Apple från iOS 17.4+ installation av appar utanför App Store (tredjepartsbutiker, webbdistribution, sideloading). Så här kan du dela f1_bet med vänner:

### 1. TestFlight (enklast om du har Apple Developer-konto)

- Kräver **Apple Developer Program** (99 USD/år).
- I Xcode: **Product → Archive** → **Distribute App** → **App Store Connect** → **Upload**.
- I [App Store Connect](https://appstoreconnect.apple.com): skapa appen (om den inte finns), gå till **TestFlight** → **External Testing** och lägg till en grupp med vännernas e-postadresser.
- Vännerna får inbjudan, laddar ner **TestFlight** från App Store och installerar din app därifrån. Bygget gäller 90 dagar, därefter laddar du upp en ny version.
- Max 10 000 externa testare, ingen sideload – allt via Apple.

### 2. Web Distribution (EU, officiellt från Apple)

- För användare **i EU** med **iOS 17.5+** eller iPadOS 18+.
- Du behöver: **Apple Developer Program**, godkänd [Alternative Terms Addendum for Apps in the EU](https://developer.apple.com/contact/request/alternative-eu-terms-addendum/), och [ansökan om Web Distribution](https://developer.apple.com/contact/request/web-distribution-eu/).
- Appen måste **notariseras** av Apple (säkerhetsgenomsökning, inte full App Review). Du laddar upp bygget i App Store Connect, notariserar, laddar ner den signerade IPA:n och lägger den på din egen webbplats (domän du registrerar i App Store Connect).
- Användare öppnar din webbplats i Safari, godkänner dig som utvecklare i **Inställningar** (en gång) och installerar appen.
- [Apple:s guide: Getting started with Web Distribution in the EU](https://developer.apple.com/support/web-distribution-eu/). Core Technology Fee (€0,50 per första årliga install) gäller bara över 1 miljon installs/år.

### 3. AltStore / AltStore PAL (sideload utan egen webbdistribution)

- **AltStore PAL** (endast **EU**): Kräver att du har **betalt Apple Developer-konto** och notariserar appen. Vännerna installerar [AltStore PAL](https://altstore.io/) från altstore.io. Se [AltStore PAL – Distribute](https://faq.altstore.io/developers/distribute-with-altstore-pal).
- **AltStore (klassisk, utan Developer-konto)**: Du behöver **inte** betala. Bygg en .ipa med **gratis Apple ID** (Development-export eller osignerad .ipa) och lägg den på servern. Användare installerar [AltStore](https://altstore.io/) via AltServer (Mac/PC), lägger till din "source" (t.ex. `https://betsel.fortiddns.com/altstore-source.json`) och installerar appen – AltStore signerar med deras eget Apple ID. Appen förnyas var 7:e dag. **Fullständig guide:** [docs/altstore-utan-developer-konto.md](altstore-utan-developer-konto.md).

**Bygga en IPA utan Developer-konto:** Se **[altstore-utan-developer-konto.md](altstore-utan-developer-konto.md)** för steg-för-steg (Development-export eller osignerad .ipa). Med betalt konto: **Product → Archive → Distribute App** → Ad Hoc eller Development.

### Kort jämförelse

| Metod            | Krav (dig)           | Krav (vänner)     | EU?      |
|------------------|----------------------|-------------------|----------|
| TestFlight       | Developer-konto      | TestFlight-app    | Överallt |
| Web Distribution | Developer + EU-ansökan | iOS 17.5+, EU   | Endast EU |
| AltStore PAL     | Bygg & dela IPA      | AltStore PAL, EU  | Endast EU |
| AltStore         | Bygg & dela IPA      | Dator + AltServer | Överallt |

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
