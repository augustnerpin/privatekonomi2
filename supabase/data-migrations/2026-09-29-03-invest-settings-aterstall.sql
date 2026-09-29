-- Datamigrering: återställ invest_settings, som appens synk satte deleted = true 2026-09-29 08:10:48 (appen hämtade in
-- serverns nyckel i synkskuggan och tolkade den sedan som "borttagen lokalt"; rättat i appen och skyddat med triggern
-- user_state_protect_server i schema.sql). Värdet fanns kvar i raden, och det är samma som 2026-09-29-02-avanza.sql lade in.
-- Dessutom: sparkontot för lånet heter "Utökat lån" hos Avanza (inte "Utökat lån sparkonto"), så det namnet läggs till
-- bland de lånefinansierade kontona. Idempotent (andra körningen ändrar inget). Backup i backups (invest-settings-aterstall).
--
-- 1) FÖRHANDSGRANSKNING (ändrar inget)
select user_id, deleted, updated_at, value->'funded_by_loan' as funded_by_loan, value->'leverage' as leverage, value->'isk' as isk,
  deleted or not (value->'funded_by_loan') ? 'Utökat lån' as skulle_andras
from public.user_state where key = 'invest_settings';

-- 2) KÖR
do $$
declare u record;
begin
  for u in select user_id, value, deleted from public.user_state
           where key = 'invest_settings' and (deleted or not (value->'funded_by_loan') ? 'Utökat lån') loop
    insert into public.backups (user_id, label, data) values (u.user_id, 'invest-settings-aterstall', jsonb_build_object('invest_settings', u.value, 'deleted', u.deleted));
    update public.user_state set deleted = false,
      value = case when (value->'funded_by_loan') ? 'Utökat lån' then value
                   else jsonb_set(value, '{funded_by_loan}', coalesce(value->'funded_by_loan', '[]'::jsonb) || '["Utökat lån"]'::jsonb) end
      where user_id = u.user_id and key = 'invest_settings';
  end loop;
end $$;

-- 3) KONTROLL
select user_id, deleted, updated_at, value from public.user_state where key = 'invest_settings';
