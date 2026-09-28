-- Datamigrering v2-1: automatisk förmögenhet. Kan köras flera gånger (hoppar över användare som redan migrerats).
-- Tar först en JSON-backup (tabellen backups, label v2-1-formogenhet) av kontolistan och saldon/värden.
--  • Konton får förmögenhetskategori (nw_cat): bank/sparkonto → cash, investering → stocks, kort → ingen
--  • Aktier/fonder i senaste förmögenhetsbilden → manuellt konto "Avanza ISK" (investering, sparkategori Avanza)
--  • Likvida medel utöver bankkontonas saldon → manuellt konto "Klarna"
--  • Lägenhet (+ skulden på lån som hör till den), pension, klockor, AB, kontanter → manuella värden (asset_values)
do $$
declare
  u record; accs jsonb; snap record; bank_cash numeric; debt numeric; d date := (now() at time zone 'Europe/Stockholm')::date;
begin
  for u in select distinct user_id from public.user_state where key = 'accounts' and not deleted loop
    if exists (select 1 from public.backups where user_id = u.user_id and label = 'v2-1-formogenhet') then continue; end if;
    insert into public.backups (user_id, label, data) select u.user_id, 'v2-1-formogenhet', jsonb_build_object(
      'accounts', (select value from public.user_state where user_id = u.user_id and key = 'accounts'),
      'account_balances', (select coalesce(jsonb_agg(to_jsonb(b)), '[]') from public.account_balances b where b.user_id = u.user_id),
      'asset_values', (select coalesce(jsonb_agg(to_jsonb(a)), '[]') from public.asset_values a where a.user_id = u.user_id),
      'latest_snapshot', (select to_jsonb(s) from public.net_worth_snapshots s where s.user_id = u.user_id and not deleted order by period desc limit 1));

    select value into accs from public.user_state where user_id = u.user_id and key = 'accounts';
    accs := (select jsonb_agg(case when a ? 'nw_cat' then a
                                   when a->>'kind' = 'card' then a || '{"nw_cat": null}'
                                   when a->>'kind' = 'investment' then a || '{"nw_cat": "stocks"}'
                                   else a || '{"nw_cat": "cash"}' end order by o)
             from jsonb_array_elements(accs) with ordinality x(a, o));
    select period, amounts into snap from public.net_worth_snapshots where user_id = u.user_id and not deleted order by period desc limit 1;

    if snap.period is not null then
      if not exists (select 1 from jsonb_array_elements(accs) a where a->>'kind' = 'investment') and coalesce((snap.amounts->>'stocks')::numeric, 0) > 0 then
        accs := accs || jsonb_build_array(jsonb_build_object('id', 'avanza_isk', 'name', 'Avanza ISK', 'kind', 'investment', 'nw_cat', 'stocks', 'sav_cat', 'Avanza', 'manual', true,
          'balance', jsonb_build_object('value', (snap.amounts->>'stocks')::numeric, 'date', d)));
        insert into public.account_balances (user_id, account, bal_date, value, source) values (u.user_id, 'avanza_isk', d, (snap.amounts->>'stocks')::numeric, 'manual') on conflict do nothing;
      end if;
      bank_cash := coalesce((select sum((a->'balance'->>'value')::numeric) from jsonb_array_elements(accs) a where a->>'nw_cat' = 'cash' and a ? 'balance'), 0);
      if not exists (select 1 from jsonb_array_elements(accs) a where a->>'id' = 'klarna') and coalesce((snap.amounts->>'cash')::numeric, 0) - bank_cash > 1 then
        accs := accs || jsonb_build_array(jsonb_build_object('id', 'klarna', 'name', 'Klarna', 'kind', 'savings', 'nw_cat', 'cash', 'manual', true,
          'balance', jsonb_build_object('value', round((snap.amounts->>'cash')::numeric - bank_cash, 2), 'date', d)));
        insert into public.account_balances (user_id, account, bal_date, value, source) values (u.user_id, 'klarna', d, round((snap.amounts->>'cash')::numeric - bank_cash, 2), 'manual') on conflict do nothing;
      end if;
      debt := coalesce((select sum(v.value) from public.loans l
        join lateral (select value from public.loan_balances b where b.user_id = l.user_id and b.loan_id = l.id and not b.deleted order by bal_date desc limit 1) v on true
        where l.user_id = u.user_id and not l.deleted and l.secured_by = 'apt'), 0);
      insert into public.asset_values (user_id, asset, val_date, value, note)
        select u.user_id, k, d, case when k = 'apt' then (snap.amounts->>k)::numeric + debt else (snap.amounts->>k)::numeric end, 'Från förmögenhetsbilden ' || snap.period
        from unnest(array['apt', 'pension', 'klockor', 'ab', 'kontanter']) k
        where snap.amounts ? k and (snap.amounts->>k)::numeric <> 0
        on conflict do nothing;
    end if;
    update public.user_state set value = accs where user_id = u.user_id and key = 'accounts';
  end loop;
end $$;

select a->>'id' as id, a->>'name' as name, a->>'nw_cat' as nw_cat, a->'balance'->>'value' as balance from public.user_state, jsonb_array_elements(value) a where key = 'accounts';
select asset, val_date, value from public.asset_values where not deleted order by asset;
