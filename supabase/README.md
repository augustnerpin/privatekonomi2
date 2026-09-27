# Databas i Supabase

Appen sparar allt lokalt på enheten och synkar till Supabase när du är inloggad.
Borttagna rader markeras `deleted = true`, så att andra enheter också tar bort dem.

| Tabell | Innehåll |
|---|---|
| `transactions` | En rad per transaktion (datum, belopp, typ, kategori, konto, butiksnyckel …) |
| `net_worth_snapshots` | Förmögenhet per månad; värden per tillgångskategori i `amounts` |
| `user_state` | Inställningar: kategorier, budget, konton, inlärda regler, löneperioder, AI-minne m.m. |
| `v_transactions` | Vy med bara aktiva transaktioner, för egna frågor i SQL Editor |

Radsäkerhet (RLS) gör att en inloggad användare bara kan läsa och ändra sina egna rader.
Den publika nyckeln (`sb_publishable_…`) får därför ligga i appen. Den hemliga nyckeln
(`sb_secret_…`) ska aldrig in i appen.

## Kom igång

1. **Skapa tabellerna:** Supabase → *SQL Editor* → *New query*. Klistra in hela
   [`schema.sql`](schema.sql) och tryck *Run*. Filen kan köras igen utan att data försvinner.
2. **Ställ in adresserna:** *Authentication* → *URL Configuration*. Sätt *Site URL* till adressen
   där appen ligger (t.ex. `https://augustnerpin.github.io/privatekonomi2/`), så att länken i
   bekräftelsemejlet öppnar appen.
3. **Anslut appen:** Inställningar → *Databas (Supabase)*. Klistra in *Project URL*
   (`https://xxxx.supabase.co`); nyckeln är redan ifylld. Tryck *Spara projekt*.
4. **Skapa konto** med e-post och lösenord, bekräfta via mejlet och logga sedan in.
   Första synken laddar upp all befintlig data från enheten.
5. **På nästa enhet:** logga in med samma konto. All data hämtas ner, och molnets
   inställningar vinner vid första synken.

Tips: När du har skapat ditt konto kan du stänga av nya registreringar under
*Authentication* → *Sign In / Providers* → *Allow new users to sign up*.

## Bra att veta

- Gratisnivån pausar projektet efter en tids inaktivitet. Det startas igen från Supabase-panelen.
- Transaktioner utan giltigt datum eller giltig månad hoppas över vid synk. Statusraden i
  inställningarna visar hur många.
- Firebase-synken finns kvar under inställningar som "äldre" och kan tas bort när Supabase fungerar.
