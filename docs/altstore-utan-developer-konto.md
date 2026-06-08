# Distribuera F1 Betting via AltStore utan Apple Developer-konto

Du kan distribuera iOS-appen via [AltStore](https://altstore.io/) **utan att betala för Apple Developer Program**. AltStore signerar appen med **användarens eget Apple ID** när de installerar, så du behöver inte ha ett betalt konto.

**Viktigt:** AltStore **PAL** (EU-butiken på altstore.io) kräver notarisering och Developer-konto. Denna guide gäller **klassisk AltStore** med egen "source" – användare installerar AltStore (via AltServer på dator) och lägger till din källa.

---

## Steg 1: Få ut en .ipa-fil (gratis Apple ID)

Du behöver en .ipa-fil att lägga på servern. Två sätt:

### Metod A: Development-export i Xcode (rekommenderat)

1. Öppna **f1_bet/f1_bet.xcodeproj** i Xcode.
2. Logga in med ditt **gratis Apple ID**: Xcode → **Settings** (⌘,) → **Accounts** → **+** → **Apple ID**.
3. Välj målet **f1_bet** och under **Signing & Capabilities** välj ditt Team (det som skapas med gratis Apple ID). Aktivera **Automatically manage signing**.
4. Välj **Any iOS Device (arm64)** som destination (inte simulator).
5. Meny: **Product** → **Archive**.
6. När arkivet är klart öppnas **Organizer**. Välj arkivet → **Distribute App**.
7. Välj **Custom** (eller **Development** om det finns) → **Next**.
8. Välj **Development** (för att använda din gratis signering) → **Next**.
9. Välj ditt team och din utvecklarcertifikat → **Next**.
10. Spara .ipa-filen (t.ex. på skrivbordet). Döp den till **f1_bet.ipa** och lägg den i **public/downloads/** på servern.

Om Xcode inte erbjuder Archive med gratis konto kan du använda Metod B.

### Metod B: Osignerad .ipa (om Development inte fungerar)

1. I Xcode: **Build Settings** för målet f1_bet → sök på "Code Signing" → sätt **Code Signing Identity** till **Don't Code Sign** för Debug/Release (kan kräva att du redigerar project.pbxproj eller använder "All" och sätter till Don't Code Sign).
2. Bygg för **Any iOS Device**: **Product** → **Build** (⌘B).
3. I **Products** i Project Navigator högerklicka på **f1_bet.app** → **Show in Finder**.
4. Skapa en mapp **Payload** och flytta **f1_bet.app** in i den.
5. Komprimera **Payload**-mappen till **Payload.zip**, byt sedan filändelse till **.ipa** (dvs **f1_bet.ipa**).
6. Lägg **f1_bet.ipa** i **public/downloads/** på servern.

AltStore kan signera denna .ipa med användarens Apple ID vid installation.

---

## Steg 2: AltStore source på servern

Projektet innehåller redan en **AltStore source**-fil som gör att användare kan lägga till din app i AltStore:

- **Fil:** `public/altstore-source.json`
- **URL:** `https://betsel.fortiddns.com/altstore-source.json`

När du har lagt **f1_bet.ipa** i **public/downloads/** ska du uppdatera source-filen:

1. Öppna **public/altstore-source.json**.
2. Uppdatera **size** i `versions[0]` till filstorleken i byte (t.ex. `ls -l public/downloads/f1_bet.ipa` eller på Mac: **Get Info** på filen).
3. Sätt **downloadURL** till din publika URL, t.ex. `https://betsel.fortiddns.com/downloads/f1_bet.ipa`.
4. Justera **version** och **date** om du bygger en ny version senare.

---

## Steg 3: Så installerar användare

1. Användaren installerar **AltStore** (klassisk) med [AltServer](https://altstore.io/) på Mac eller PC och kopplar iPhonen.
2. På App-sidan (eller direkt) klickar de på länken **Lägg till F1 Betting i AltStore** – då öppnas AltStore och källan läggs till.
3. I AltStore söker de efter **F1 Betting** och trycker **Install**. AltStore laddar ner .ipa och signerar med användarens Apple ID.
4. Appen måste **förnyas var 7:e dag** (gratis Apple ID): användaren öppnar AltStore och trycker **Refresh**, eller har AltServer igång så att AltStore kan förnya i bakgrunden.

---

## Sammanfattning

| Vad | Krav |
|-----|------|
| Du (utvecklare) | Gratis Apple ID, Xcode, .ipa uppladdad till servern |
| Användare | AltStore + AltServer (eller i EU: AltStore PAL om du senare skaffar Developer-konto) |
| Förnyelse | Var 7:e dag med gratis Apple ID (användaren gör Refresh i AltStore) |

**AltStore PAL** (endast EU, från altstore.io) kräver att du har **betalt Developer-konto** och notariserar appen – se [AltStore PAL – Distribute](https://faq.altstore.io/developers/distribute-with-altstore-pal). Med denna guide når du användare via **klassisk AltStore** utan att betala.
