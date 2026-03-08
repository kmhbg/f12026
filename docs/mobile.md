# Mobilapp – guide

## Ikoner och splash
I `public/icons/` finns:
- **icon-192.png**, **icon-512.png** – PWA-/appikoner (F1-röd, racing-stil)
- **splash.png** – startskärm (porträtt, 1170×2532), används t.ex. i Capacitor

PWA:n använder redan ikonerna via `manifest.webmanifest` och `apple-touch-icon` på sidorna.

## iOS (gratis) – PWA
1. Öppna `https://betsel.fortiddns.com` i Safari.
2. Tryck på delningsikonen → "Lägg till på hemskärmen".
3. Appen installeras som PWA (ingen App Store).

## Android – APK (rekommenderad väg)
Använd Capacitor (webb i native container).

```bash
npm install -D @capacitor/cli
npm install @capacitor/core @capacitor/android
npx cap init f1tting com.f1tting.app --web-dir public
npx cap add android
npx cap sync
npx cap open android
```

I Android Studio: Build → Generate Signed Bundle/APK → APK.

## iOS (betald, riktig native)
Kräver Apple Developer Program. När ni har konto:

```bash
npm install @capacitor/ios
npx cap add ios
npx cap sync
npx cap open ios
```

I Xcode: välj team, signera och bygg.
