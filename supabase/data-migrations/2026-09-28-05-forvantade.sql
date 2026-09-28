-- Datamigrering v2-5: förväntade transaktioner. Idempotent; backup i backups (v2-5-forvantade).
-- Lägger in "Sparande till Avanza" (sparande, kategori Avanza, senast 5 dagar efter lönen) om listan saknas.
do $$
declare u record;
begin
  for u in select distinct user_id from public.user_state where key = 'cats_sav' and not deleted loop
    if exists (select 1 from public.backups where user_id = u.user_id and label = 'v2-5-forvantade') then continue; end if;
    insert into public.backups (user_id, label, data) select u.user_id, 'v2-5-forvantade',
      jsonb_build_object('expected_tx', (select value from public.user_state where user_id = u.user_id and key = 'expected_tx'));
    insert into public.user_state (user_id, key, value) values (u.user_id, 'expected_tx', jsonb_build_array(
      jsonb_build_object('id', 'exp_avanza', 'name', 'Sparande till Avanza', 'type', 'savings', 'cat', 'Avanza', 'days', 5, 'enabled', true)))
      on conflict (user_id, key) do nothing;
  end loop;
end $$;
-- Kontroll: senaste 12 perioderna – lönedatum och om Avanza-sparande kom inom 5 dagar
with sal as (select month, min(tx_date) d from public.transactions where not deleted and type = 'income' and category = 'Lön' group by month),
av as (select month, min(tx_date) d from public.transactions where not deleted and type = 'savings' and category = 'Avanza' group by month)
select s.month, s.d::text as lon, a.d::text as avanza, case when a.d is null then 'uteblev' when a.d > s.d + 5 then 'sent' else 'ok' end as status
from sal s left join av a on a.month = s.month order by s.month desc limit 13;
