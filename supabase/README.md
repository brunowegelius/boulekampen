# Poängsystemet — koppla databasen

Systemet fungerar direkt i **demoläge**: allt sparas i webbläsaren och syns i
andra flikar på samma dator. Bra för att prova, men inför turneringen måste
det kopplas till en databas så att telefoner, storbild och livesida delar data.

1. Skapa ett nytt projekt på supabase.com (gratisnivån räcker), region Stockholm/EU.
   Använd **inte** Tentaguidens projekt — Boulekampen ska ha ett eget.
2. SQL Editor → klistra in `schema.sql` → Run.
3. Lägg in arrangörerna längst ner i samma editor:
   `insert into admins(email) values ('namn@exempel.se');`
4. Authentication → URL Configuration: lägg till `https://boulekampen.se/admin/` som redirect-URL.
5. Project Settings → API: kopiera Project URL och `anon`-nyckeln till `app/config.js`.
6. Skapa evenemanget i `/admin/` med adressen `boulekampen-2026` — då fylls
   startsidans Tabell- och Resultat-kort i automatiskt när lagen är lottade.

## Sidor

| Sida | För vem |
| --- | --- |
| `/admin/` | Arrangörer. Evenemang, lag, lottning, schema, rättning, röstning, bokningar och offerter. |
| `/domare/?e=…` | Banvärdarna. PIN-skyddad poängföring per bana. Tål dåligt nät. |
| `/live/?e=…` | Deltagare och publik. Mitt lag, tabeller, matcher, slutspel, röstning. |
| `/storbild/?e=…` | Tv/projektor. F = helskärm, ←/→ byter vy, mellanslag pausar. |
| `/delta/?k=KOD` | Företagsdeltagare anmäler sig själva via QR. |

Motorn testas med `node --test tests/`.
