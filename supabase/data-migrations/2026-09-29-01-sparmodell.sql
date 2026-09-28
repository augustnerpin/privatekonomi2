-- Datamigrering: sparande utifrån kontotyp (applySavingsModel i functions/bank/core.ts).
-- Kontoinställningar: Bolånekontot blir passagekonto, sparkategori på Sparkonto/Avanza/Klarna, motpartstext för de manuella
-- kontona, Lönekontots nummer. "Klarna" läggs till bland sparkategorierna. Reglerna som krockar med kontotyperna tas bort.
-- Idempotent (andra körningen hittar inget att ändra). Backup i backups (sparmodell-installningar): konton, sparkategorier, regler.
-- Historiken räknas om separat med POST /bank/savings-model (eget backup, label sparmodell).
do $$
declare u record; rules text[] := array['#53293380441|ut', 'avanza bank|ut', 'avanza bank|in', 'august nerpi|in'];
  patch jsonb := '{
    "seb_8f8e":   {"kind": "passage"},
    "seb_1dfa":   {"sav_cat": "SEB"},
    "avanza_isk": {"sav_cat": "Avanza", "match": ["AVANZA BANK", "AVANZA"]},
    "klarna":     {"kind": "savings", "sav_cat": "Klarna", "match": ["KLARNA BANK"]},
    "lonekonto":  {"number": "53290207161"}
  }';
begin
  for u in select a.user_id from public.user_state a where a.key = 'accounts'
             and (exists (select 1 from jsonb_array_elements(a.value) x where patch ? (x->>'id') and not x @> (patch->(x->>'id')))
               or exists (select 1 from public.user_state c where c.user_id = a.user_id and c.key = 'cats_sav' and not c.value ? 'Klarna')
               or exists (select 1 from public.user_state r where r.user_id = a.user_id and r.key = 'merchant_rules' and r.value ?| rules)) loop
    insert into public.backups (user_id, label, data) select u.user_id, 'sparmodell-installningar',
      (select jsonb_object_agg(key, value) from public.user_state where user_id = u.user_id and key in ('accounts', 'cats_sav', 'merchant_rules'));
    update public.user_state set value = (select jsonb_agg(case when patch ? (x->>'id') then x || (patch->(x->>'id')) else x end order by n)
        from jsonb_array_elements(value) with ordinality e(x, n))
      where user_id = u.user_id and key = 'accounts';
    update public.user_state set value = value || '["Klarna"]'::jsonb where user_id = u.user_id and key = 'cats_sav' and not value ? 'Klarna';
    update public.user_state set value = value - rules where user_id = u.user_id and key = 'merchant_rules' and value ?| rules;
  end loop;
end $$;
select key, case when key = 'accounts' then (select jsonb_agg(jsonb_build_object('id', x->>'id', 'kind', x->>'kind', 'sav_cat', x->>'sav_cat', 'number', x->>'number', 'match', x->'match')) from jsonb_array_elements(value) x)
  when key = 'merchant_rules' then to_jsonb(array(select k from jsonb_object_keys(value) k where k ~* 'avanza|53293380441|august nerpi')) else value end as value
from public.user_state where key in ('accounts', 'cats_sav', 'merchant_rules');
