-- Datamigrering v2-3: målet mot plan. Idempotent: sätter bara nycklar som saknas; backup i backups (v2-3-mal).
--  • goal_start = senaste förmögenhetsbilden (planlinjen börjar där)
--  • planned_savings = 10 000 kr/mån
--  • known_inflows = tjänstepension 2 000 kr/mån (pension) och klumpsumma 25 000 kr runt årsskiftet (2027-01, likvida medel)
do $$
declare u record; snap record;
begin
  for u in select distinct user_id from public.user_state where key = 'goal' and not deleted loop
    if exists (select 1 from public.backups where user_id = u.user_id and label = 'v2-3-mal') then continue; end if;
    insert into public.backups (user_id, label, data) select u.user_id, 'v2-3-mal',
      coalesce((select jsonb_object_agg(key, value) from public.user_state where user_id = u.user_id and key in ('goal', 'goal_date', 'goal_start', 'planned_savings', 'known_inflows')), '{}');
    select period, total into snap from public.net_worth_snapshots where user_id = u.user_id and not deleted order by period desc limit 1;
    if snap.period is not null then
      insert into public.user_state (user_id, key, value) values (u.user_id, 'goal_start', jsonb_build_object('period', snap.period, 'total', round(snap.total)))
        on conflict (user_id, key) do nothing;
    end if;
    insert into public.user_state (user_id, key, value) values (u.user_id, 'planned_savings', '10000'::jsonb) on conflict (user_id, key) do nothing;
    insert into public.user_state (user_id, key, value) values (u.user_id, 'known_inflows', jsonb_build_array(
      jsonb_build_object('id', 'inf_pension', 'name', 'Tjänstepension', 'amount', 2000, 'monthly', true, 'nw_cat', 'pension'),
      jsonb_build_object('id', 'inf_klump', 'name', 'Klumpsumma', 'amount', 25000, 'monthly', false, 'date', '2027-01', 'nw_cat', 'cash')))
      on conflict (user_id, key) do nothing;
  end loop;
end $$;
select key, value from public.user_state where key in ('goal', 'goal_date', 'goal_start', 'planned_savings', 'known_inflows') order by key;
