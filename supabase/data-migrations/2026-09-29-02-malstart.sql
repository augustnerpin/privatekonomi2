-- Datamigrering: goal_start pekar på en period ({period}) i stället för en fryst total. Totalen läses från
-- förmögenhetsbilden för perioden varje gång, så rättelser av startbilden slår igenom (resolveGoalStart i goal.ts).
-- Idempotent (efter första körningen finns inget goal_start med total kvar). Backup i backups (malstart).
do $$
declare u record;
begin
  for u in select user_id, value from public.user_state where key = 'goal_start' and not deleted and jsonb_typeof(value) = 'object' and value ? 'total' loop
    insert into public.backups (user_id, label, data) values (u.user_id, 'malstart', jsonb_build_object('goal_start', u.value));
    update public.user_state set value = jsonb_build_object('period', u.value->>'period') where user_id = u.user_id and key = 'goal_start';
  end loop;
end $$;
select g.value as goal_start, s.total as start_total from public.user_state g
  left join public.net_worth_snapshots s on s.user_id = g.user_id and s.period = g.value->>'period' and not s.deleted
 where g.key = 'goal_start';
