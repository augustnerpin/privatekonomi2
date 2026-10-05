-- Bankjobb: hämtar nytt från banken tre gånger per dygn (supabase/functions/bank → /cron).
-- Kör i SQL Editor efter schema.sql. Kan köras flera gånger.
--
-- Nyckeln som skyddar /bank/cron måste finnas på två ställen (samma värde):
--   1. Funktionens secret:  npx supabase secrets set CRON_SECRET=<slumpad nyckel>
--   2. Databasens valv:     select vault.create_secret('<samma nyckel>', 'bank_cron_secret');
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule(jobid) from cron.job where jobname in ('bank-nightly', 'bank-midday', 'bank-evening');
-- Tre hämtningar per dygn (UTC; svensk sommartid +2 h, vintertid +1 h):
--   bank-nightly  03:00 UTC = 05:00  hämtning, notis, bokslut (dag 2 i perioden), veckobrev (söndagar)
--   bank-midday   10:30 UTC = 12:30  hämtning och notis om det finns något nytt
--   bank-evening  16:30 UTC = 18:30  hämtning och notis om det finns något nytt
-- Bankerna (PSD2) tillåter högst 4 hämtningar per konto och dygn utan att du är inloggad. "Hämta nu" i appen
-- räknas inte dit, eftersom du är inloggad då. Bokslut, veckobrev, förmögenhetsbild och notiser görs bara en gång
-- (de som redan finns/skickats hoppas över), så samma jobb kan köras flera gånger per dag.
do $do$
declare j record;
begin
  for j in select * from (values ('bank-nightly', '0 3 * * *'), ('bank-midday', '30 10 * * *'), ('bank-evening', '30 16 * * *')) as t(name, sched) loop
    perform cron.schedule(j.name, j.sched, $job$
      select net.http_post(
        url := 'https://qchasvatuhndtswxlucr.supabase.co/functions/v1/bank/cron',
        headers := jsonb_build_object('content-type', 'application/json',
          'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'bank_cron_secret')),
        body := '{}'::jsonb,
        timeout_milliseconds := 150000);
    $job$);
  end loop;
end
$do$;
