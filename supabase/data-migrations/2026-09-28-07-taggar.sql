-- Datamigrering v2-7: kategorierna "London" och "Spanien" blir kategorin "Resa" med taggarna "London" respektive "Spanien".
-- Idempotent (efter första körningen finns inga rader kvar i de gamla kategorierna). Backup i backups (v2-7-taggar):
-- alla berörda transaktioner i sin helhet + kategorilista, budget, grupper och regler.
do $$
declare u record; old text; olds text[] := array['London', 'Spanien'];
begin
  for u in select distinct user_id from public.transactions where category = any(olds) and not deleted
           union select distinct user_id from public.user_state where key = 'cats_exp' and value ?| array['London', 'Spanien'] loop
    insert into public.backups (user_id, label, data) select u.user_id, 'v2-7-taggar', jsonb_build_object(
      'transactions', (select coalesce(jsonb_agg(to_jsonb(t)), '[]') from public.transactions t where t.user_id = u.user_id and t.category = any(olds)),
      'state', (select jsonb_object_agg(key, value) from public.user_state where user_id = u.user_id and key in ('cats_exp', 'cat_budgets', 'cat_groups', 'merchant_rules')));
    foreach old in array olds loop
      update public.transactions
         set category = 'Resa',
             extra = jsonb_set(extra, '{tags}', (select to_jsonb(array(select distinct x from jsonb_array_elements_text(coalesce(extra->'tags', '[]') || to_jsonb(array[old])) x))))
       where user_id = u.user_id and category = old;
    end loop;
    -- Kategorilistan: bort med de gamla, se till att Resa finns
    update public.user_state set value = (select coalesce(jsonb_agg(c), '[]') from jsonb_array_elements_text(value) c where c <> all(olds))
      where user_id = u.user_id and key = 'cats_exp' and value ?| olds;
    update public.user_state set value = value || '["Resa"]'::jsonb where user_id = u.user_id and key = 'cats_exp' and not value ? 'Resa';
    -- Budget: lägg ihop på Resa
    update public.user_state set value = (value - 'London' - 'Spanien') || jsonb_build_object('Resa',
        coalesce((value->>'Resa')::numeric, 0) + coalesce((value->>'London')::numeric, 0) + coalesce((value->>'Spanien')::numeric, 0))
      where user_id = u.user_id and key = 'cat_budgets' and value ?| olds;
    -- Grupper: byt namnen mot Resa
    update public.user_state set value = (select coalesce(jsonb_agg(jsonb_set(g, '{cats}', (select coalesce(jsonb_agg(distinct case when c = any(olds) then 'Resa' else c end), '[]') from jsonb_array_elements_text(g->'cats') c))), '[]') from jsonb_array_elements(value) g)
      where user_id = u.user_id and key = 'cat_groups' and jsonb_typeof(value) = 'array' and value::text ~ '"(London|Spanien)"';
    -- Regler: kategori Resa + taggen
    update public.user_state set value = (select jsonb_object_agg(k, case when v->>'cat' = any(olds) then v || jsonb_build_object('cat', 'Resa', 'tags', jsonb_build_array(v->>'cat')) else v end) from jsonb_each(value) e(k, v))
      where user_id = u.user_id and key = 'merchant_rules' and value::text ~ '"cat": "(London|Spanien)"';
  end loop;
end $$;
select extra->'tags' as tags, count(*) as n, sum(amount) as sum from public.transactions where not deleted and extra ? 'tags' group by 1 order by 1;
