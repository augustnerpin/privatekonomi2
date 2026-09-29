-- Datamigrering: Avanza-import (functions/_shared/avanza.ts). Kör schema.sql först (tabellen avanza_snapshots).
-- Lägger in inställningarna invest_settings för användare med kontot avanza_isk, om de saknas. Ändrar ingen befintlig
-- data: saldon, förmögenhetsbilder, transaktioner, sparmodellen och förväntade transaktioner rörs inte (autogirona läggs
-- in först när en Avanza-bild importeras med dry_run: false). Idempotent: finns invest_settings händer ingenting.
-- Backup i backups (label avanza-installningar, det tidigare värdet = null).
--
-- Värdena är data, inte kod, och ändras med set_investment_settings eller i appen:
--  • ISK 2026: statslåneräntan 30 nov 2025 = 2,55 % (+1 procentenhet, lägst 1,25 %), skattefri nivå 300 000 kr, skatt 30 %
--  • ränteavdrag 30 %, varningsgräns 15 % per innehav, 3 bankdagar innan notis om autogirot
--  • lånefinansierade konton: Utökat lån ISK, Utökat lån sparkonto
--  • leverage.since = första transaktionen med texten "Utökat lån" (kontrollera!), annars tomt
--
-- 1) FÖRHANDSGRANSKNING (ändrar inget): vad som skulle läggas in
select u.user_id,
  exists (select 1 from public.user_state s where s.user_id = u.user_id and s.key = 'invest_settings') as har_redan_installningar,
  (select min(tx_date)::text from public.transactions t where t.user_id = u.user_id and not t.deleted and t.description ilike '%utökat lån%') as leverage_since
from (select distinct user_id from public.user_state where key = 'accounts' and value @> '[{"id": "avanza_isk"}]') u;

-- 2) KÖR
do $$
declare u record; since text;
begin
  for u in select distinct a.user_id from public.user_state a where a.key = 'accounts' and a.value @> '[{"id": "avanza_isk"}]'
             and not exists (select 1 from public.user_state s where s.user_id = a.user_id and s.key = 'invest_settings') loop
    insert into public.backups (user_id, label, data) values (u.user_id, 'avanza-installningar', jsonb_build_object('invest_settings', null));
    select min(tx_date)::text into since from public.transactions t where t.user_id = u.user_id and not t.deleted and t.description ilike '%utökat lån%';
    insert into public.user_state (user_id, key, value) values (u.user_id, 'invest_settings', jsonb_build_object(
      'avanza_account', 'avanza_isk', 'include_hidden', false, 'concentration_pct', 15, 'interest_deduction_pct', 30, 'autogiro_grace_bank_days', 3,
      'funded_by_loan', jsonb_build_array('Utökat lån ISK', 'Utökat lån sparkonto'),
      'leverage', jsonb_build_object('since', since, 'borrowed_kr', null, 'loan_id', null, 'app_accounts', jsonb_build_array()),
      'isk', jsonb_build_object('tax_pct', 30, 'extra_pct', 1, 'min_pct', 1.25, 'years', jsonb_build_object('2026', jsonb_build_object('gov_rate_pct', 2.55, 'tax_free', 300000)))))
      on conflict (user_id, key) do nothing;
  end loop;
end $$;

-- 3) KONTROLL
select key, value from public.user_state where key = 'invest_settings';
select count(*) as avanza_bilder from public.avanza_snapshots;
