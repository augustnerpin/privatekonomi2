-- Nattjobb: hämtar nytt från banken varje natt (supabase/functions/bank → /cron).
-- Kör i SQL Editor efter schema.sql. Kan köras flera gånger.
--
-- Nyckeln som skyddar /bank/cron måste finnas på två ställen (samma värde):
--   1. Funktionens secret:  npx supabase secrets set CRON_SECRET=<slumpad nyckel>
--   2. Databasens valv:     select vault.create_secret('<samma nyckel>', 'bank_cron_secret');
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule(jobid) from cron.job where jobname = 'bank-nightly';
-- 03:00 UTC = 05:00 svensk sommartid (04:00 vintertid). Bankerna tillåter ungefär 4 hämtningar
-- per dygn utan att du är inloggad, så en gång per natt lämnar gott om plats för "Hämta nu".
select cron.schedule('bank-nightly', '0 3 * * *', $job$
  select net.http_post(
    url := 'https://qchasvatuhndtswxlucr.supabase.co/functions/v1/bank/cron',
    headers := jsonb_build_object('content-type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'bank_cron_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000);
$job$);
