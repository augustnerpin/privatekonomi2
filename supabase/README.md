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
3. **Anslut appen:** projektets URL och nyckel är redan inlagda i koden. Ett annat projekt kan
   anges under Inställningar → *Databas (Supabase)*.
4. **Skapa konto** med e-post och lösenord, bekräfta via mejlet och logga sedan in.
   Första synken laddar upp all befintlig data från enheten.
5. **På nästa enhet:** logga in med samma konto. All data hämtas ner, och molnets
   inställningar vinner vid första synken.

**Viktigt:** När du har skapat ditt konto, stäng av nya registreringar under
*Authentication* → *Sign In / Providers* → *Allow new users to sign up*.

## Bra att veta

- Gratisnivån pausar projektet efter en tids inaktivitet. Det startas igen från Supabase-panelen.
- Transaktioner utan giltigt datum eller giltig månad hoppas över vid synk. Statusraden i
  inställningarna visar hur många.
- Firebase-synken finns kvar under inställningar som "äldre" och kan tas bort när Supabase fungerar.

## AI på servern

[`functions/ai`](functions/ai) skickar appens AI-anrop vidare till Anthropic. Nyckeln ligger bara i
Supabase och aldrig på telefonen. Funktionen kräver att du är inloggad i appen och att ditt konto finns i `AI_ALLOWED_USERS` (utan listan är AI:n avstängd, så att ingen annan som skapar ett konto kan använda nyckeln). Den släpper bara igenom
appens modeller och cachar den långa kontexten, så att följdfrågor blir billigare. Utan inloggning kan
appen fortfarande använda en egen nyckel under Inställningar → AI-assistent.

Installera (en gång):
```sh
npx supabase secrets set ANTHROPIC_API_KEY=sk-ant-… --project-ref qchasvatuhndtswxlucr
npx supabase secrets set AI_ALLOWED_USERS=<ditt user-id> --project-ref qchasvatuhndtswxlucr
npx supabase functions deploy ai --project-ref qchasvatuhndtswxlucr --no-verify-jwt
```

## Bankkoppling (SEB via Enable Banking)

[`functions/bank`](functions/bank) hämtar saldon och bokförda transaktioner via PSD2. Du kopplar i
appen under Inställningar → Databas → Bankkoppling och godkänner med BankID. Samtycket gäller i 180 dagar.

- Transaktioner hämtas från och med kopplingens startdatum (den 1:a i månaden du kopplar). Äldre rader
  i appen rörs aldrig, och befintliga rader ändras aldrig. Bankdata läggs bara till.
- Dubbletter: en bankrad hoppas över om samma belopp redan finns på kontot inom ±4 dagar, eller om
  bankreferensen redan finns (även på rader du tagit bort).
- Kontoroller (`role` på kontot) gör att flyttar mellan egna konton inte räknas dubbelt: `card_payment`
  (betalar kreditkortsfakturan), `mortgage` (bolånekonto) och `savings` (sparkonto).
- Kategorisering: kontoroll, sedan inlärda regler, automatiska regler, AI och till sist en gissning.
  Osäkra rader får `extra.review`.

Installera (en gång):
1. Skapa en app på enablebanking.com (Production, redirect-URL
   `https://qchasvatuhndtswxlucr.supabase.co/functions/v1/bank/callback`) och koppla dina konton med
   *Activate by linking accounts*.
2. `npx supabase secrets set ENABLEBANKING_APP_ID=<id> ENABLEBANKING_KEY_B64=<.pem i base64> --project-ref qchasvatuhndtswxlucr`
3. Kör `schema.sql` och `npx supabase functions deploy bank --no-verify-jwt`.
4. **Schemalagd hämtning:** skapa en slumpad nyckel, spara den som `CRON_SECRET` (secret) och i databasens valv
   (`bank_cron_secret`), och kör sedan [`cron.sql`](cron.sql). Jobben hämtar kl. 05:00, 12:30 och 18:30
   (sommartid; en timme tidigare på vintern). Bankerna tillåter högst 4 hämtningar per konto och dygn utan att
   du är inloggad; "Hämta nu" i appen räknas inte. Svaren syns i `net._http_response`. Har du kört en äldre
   `cron.sql`: kör den nya igen, så ersätts `bank-nightly` och de två nya jobben läggs till.

**Nattens notis** ([`bank/notify.ts`](functions/bank/notify.ts), [`bank/watch.ts`](functions/bank/watch.ts)) tar med
möjliga dubbeldragningar (samma butik, konto och belopp, minst 100 kr, inom två dagar), fasta kostnader som blivit
dyrare och nya abonnemang. Det du tryckt *OK* eller *Behåll* på i appen (`sub_seen`) nämns inte igen. När det finns
flera händelser skriver Claude Haiku 4.5 om notisen med det viktigaste först; innehåller texten ett tal som inte
finns i underlaget skickas regeltexten i stället. Stäng av AI-texten med `npx supabase secrets set DIGEST_AI=off`.

## AI-koppling (MCP)

[`functions/mcp`](functions/mcp) är en MCP-server (Model Context Protocol) som körs som en
Supabase Edge Function. Med den kan Claude, ChatGPT, Cursor och andra AI-appar läsa din ekonomi
och, om du vill, lägga till och ändra saker. Ändringarna syns i appen vid nästa synk.

Verktyg markerade ✏️ kräver en nyckel som får ändra. Belopp följer appens teckenkonvention:
utgift och sparande positivt = pengar ut, inkomst positivt = in, överföring negativt = ut.

| Område | Verktyg |
|---|---|
| Översikt | `get_settings` (kategorier, föräldralösa kategorier, konton med saldo, budget, löneperiod), `get_month_summary`, `get_net_worth` (tillgångar, skulder, netto) |
| Transaktioner | `list_transactions`, `summarize_transactions`, ✏️ `add_transaction`, ✏️ `update_transaction`, ✏️ `delete_transaction`, ✏️ `split_transaction`, ✏️ `bulk_update_transactions` |
| Överföringar | ✏️ `match_transfers` (parar ihop båda sidor av en överföring mellan egna konton) |
| Konton | `get_account_balances`, ✏️ `set_account`, ✏️ `set_account_balance` |
| Lån | `get_loans`, ✏️ `set_loan`, ✏️ `set_loan_balance` |
| Budget och förmögenhet | ✏️ `set_budget`, ✏️ `set_net_worth` |
| Regler | `list_rules`, ✏️ `update_rule`, ✏️ `delete_rule` |
| Kategorier | ✏️ `create_category`, ✏️ `rename_category`, ✏️ `merge_categories` |
| Swish-namn | `list_contacts`, ✏️ `set_contact` |
| Mål | `get_goal_progress` (krav per månad, plan mot utfall, scenarier), ✏️ `set_net_worth_goal` |
| Förmögenhet | `list_net_worth_categories`, ✏️ `set_asset_value`, ✏️ `create_net_worth_category`, ✏️ `rename_net_worth_category`, ✏️ `delete_net_worth_category`; `get_net_worth` har uppdelningen (`breakdown`) |
| Taggar | `tag` i filtren, `group_by: "tag"` i `summarize_transactions`, `tags`/`add_tags`/`remove_tags` i `update_transaction` och `bulk_update_transactions` |

Verktyg som ändrar många rader har förhandsgranskning: `bulk_update_transactions` sparar bara med
`dry_run: false` och rätt `expected_count`, och `match_transfers` länkar bara med `confirm: true`.
`split_transaction`, `update_transaction`, `update_rule`, `rename_category` och `merge_categories`
tar emot `dry_run: true`.

### Installera (en gång)

1. **Kör [`schema.sql`](schema.sql) igen** i SQL Editor. Då skapas tabellerna `mcp_tokens`,
   `account_balances`, `loans` och `loan_balances`. Ingen befintlig data ändras. Innan det är gjort
   fungerar alla verktyg utom saldohistorik och lån, som säger till att filen behöver köras.
2. **Driftsätt funktionen**, med Supabase CLI från repots rotmapp:
   ```sh
   npx supabase login
   npx supabase link --project-ref qchasvatuhndtswxlucr
   npx supabase functions deploy mcp --no-verify-jwt
   ```
   Servern använder de delade modulerna i [`functions/_shared`](functions/_shared) (mål och förmögenhet),
   så den driftsätts med CLI:n (inte genom att klistra in en fil i panelen).
   Funktionen hittar själv projektets URL och hemliga nyckel. Du behöver inte lägga in några secrets.
3. **Skapa en nyckel** i appen under Inställningar → *Databas (Supabase)* → *AI-koppling (MCP)*.
   Du får en adress som `https://qchasvatuhndtswxlucr.supabase.co/functions/v1/mcp/pkm_…`.
   Den visas bara en gång.

### Anslut

- **Claude** (webb, desktop, mobil): *Settings* → *Connectors* → *Add custom connector*. Klistra in
  adressen och lämna OAuth-fälten tomma. Kopplingen följer med till mobilappen.
- **Claude Code:** `claude mcp add --transport http privatekonomi <adressen>`
- **ChatGPT:** *Settings* → *Apps & Connectors* → *Advanced* → *Developer mode* → *Create*.
  Klistra in adressen och välj *No authentication*.
- **Cursor och andra som kan sätta headers:** använd adressen utan nyckeln
  (`…/functions/v1/mcp`) och skicka `Authorization: Bearer pkm_…`.

Prova sedan till exempel: *"Hur gick september jämfört med snittet?"*, *"Vad har jag lagt på
Mat (Ute) per månad i år?"* eller *"Lägg till 129 kr på Gym idag"*.

### Så sparas det

- Uppdelningar, överföringarnas motkonton och länkar ligger i `transactions.extra` (`parent_id`,
  `split_into`, `from_account`, `to_account`, `transfer_pair_id`). Appen behåller fälten vid synk.
- Konton (med typ och kontonummer), regler, kategorier och Swish-namn ligger i `user_state` som förut.
- Saldohistorik och lån ligger i egna tabeller som appen inte läser än.
- Alla ändringar synkar till appens enheter som vanligt. Ett ändrat saldo, en ändrad regel och
  liknande skrivs per nyckel, och den senaste ändringen vinner. Har en telefon osynkade ändringar i
  samma inställning skriver den över ändringen vid nästa synk.

### Tester

```sh
node --test 'supabase/tests/*.test.mjs'
```

Testerna kör `functions/mcp/index.ts` i Node 22.18 eller senare mot en låtsasdatabas. De kontrollerar
bland annat teckenkonventionerna, summakontrollen i `split_transaction`, att `dry_run` aldrig skriver
och att en användare aldrig kan läsa eller ändra någon annans data.

### Säkerhet

- Nyckeln ger åtkomst till din ekonomi. Hantera den som ett lösenord och återkalla den i appen om
  den kommer i fel händer. Välj *bara läsa* om AI:n inte behöver ändra något.
- Databasen sparar bara SHA-256-hashen av nyckeln.
- Funktionen använder projektets hemliga nyckel på servern, som kringgår RLS. Varje fråga i
  `index.ts` filtreras därför på nyckelns `user_id`. Den hemliga nyckeln lämnar aldrig Supabase.

## Avanza (ögonblicksbilder, bara läsning)

Avanza har inget API för privatpersoner. I stället läser Claude av Avanza, t.ex. i en Chrome-session, och
importerar en ögonblicksbild (`avanza_snapshot`) med MCP-verktyget `import_avanza_snapshot`. Ingenting här kan
handla, föra över pengar eller ändra något hos Avanza. Logiken finns i
[`functions/_shared/avanza.ts`](functions/_shared/avanza.ts).

- **Förhandsgranska först:** `dry_run` är `true` som standard och visar totalvärdet, saldot som sätts på Avanza ISK,
  förändringen sedan förra bilden, summakontrollen och varningarna. Bara `dry_run: false` sparar, och det kräver en
  nyckel med skrivbehörighet.
- **Summakontroll:** kontona som inte är dolda måste bli `total_value` (±1 kr). Stämmer det inte sparas ingenting.
- **Samma bild två gånger** (samma hash) ändrar ingenting.
- **I förmögenheten** är Avanza ISK fortfarande ett konto. Saldot blir summan av underkontona (dolda konton räknas
  med bara om `include_hidden` är på). Flyttar mellan underkonton är neutrala.
- **Autogiro:** månadssparande från banken blir en förväntad transaktion (`source: 'avanza'`). Syns ingen
  dragning med samma belopp och texten AVANZA inom 3 bankdagar skickar nattjobbet en notis. Interna flyttar
  blir inga förväntade transaktioner.
- `get_investments` visar innehav, fördelning, fem största, koncentrationsvarning, utdelningar, hävstång
  (lånat kapital, avkastning, räntekostnad efter avdrag, netto), en ISK-skatteprognos (uppskattning) och
  "tillgängligt direkt". `set_investment_settings` ändrar inställningarna (`user_state.invest_settings`).
- **I appen:** Förmögenhet → Investeringar (hämtas via `bank/investments`). Inklistring av text (`bank/avanza-parse`,
  tolkas med AI) är en reserv, och sparas först när du trycker Spara efter förhandsgranskningen.

Installera: kör `schema.sql` (tabellen `avanza_snapshots`), sedan
[`data-migrations/2026-09-29-02-avanza.sql`](data-migrations/2026-09-29-02-avanza.sql) (inställningarna), och
driftsätt `mcp` och `bank`.
