-- Datamigrering v2-6: sparkategorin "Amortering" för bolånets amorteringsdel. Idempotent; backup i backups (v2-6-amortering).
-- Själva uppdelningen bakåt görs i appen (Förmögenhet → Lån & skulder → "Dela upp bolånedragningar bakåt") med förhandsgranskning.
do $$
declare u record;
begin
  for u in select distinct user_id from public.user_state where key = 'cats_sav' and not deleted loop
    if exists (select 1 from public.backups where user_id = u.user_id and label = 'v2-6-amortering') then continue; end if;
    insert into public.backups (user_id, label, data) select u.user_id, 'v2-6-amortering',
      jsonb_build_object('cats_sav', (select value from public.user_state where user_id = u.user_id and key = 'cats_sav'));
    update public.user_state set value = value || '["Amortering"]'::jsonb
      where user_id = u.user_id and key = 'cats_sav' and jsonb_typeof(value) = 'array' and not value ? 'Amortering';
  end loop;
end $$;
select key, value from public.user_state where key = 'cats_sav';
