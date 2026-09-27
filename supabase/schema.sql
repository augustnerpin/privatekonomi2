-- Privatekonomi: databasschema för Supabase
-- Kör hela filen i Supabase → SQL Editor → New query → Run. Kan köras flera gånger.
--
-- Upplägg: appen fungerar lokalt först (localStorage) och synkar hit.
--  • transactions        — en rad per transaktion
--  • net_worth_snapshots — en rad per månad (förmögenhet per tillgångskategori)
--  • user_state          — inställningar, kategorier, budget, regler m.m. (nyckel → JSON)
-- Borttagna rader markeras deleted=true, så att andra enheter också tar bort dem.
-- Radsäkerhet (RLS): varje inloggad användare ser och ändrar bara sina egna rader.

-- ── Tidsstämpel som sätts av servern vid varje ändring ────────────
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end $$;

-- ── Transaktioner ─────────────────────────────────────────────────
create table if not exists public.transactions (
  user_id     uuid        not null default auth.uid() references auth.users(id) on delete cascade,
  id          bigint      not null,                 -- appens id (millisekunder + löpnummer)
  type        text        not null check (type in ('expense','income','savings','transfer')),
  amount      numeric(14,2) not null,               -- utgift/sparande positivt = pengar ut
  description text        not null default '',
  category    text        not null default '',
  tx_date     date        not null,
  month       text        not null check (month ~ '^\d{4}-\d{2}$'),  -- löneperiod, t.ex. 2026-09
  account     text,
  source      text,                                 -- 'import' | 'manual'
  import_id   text,
  hash        text,                                 -- dubblettkontroll vid import
  mkey        text,                                 -- butiksnyckel för inlärda regler
  extra       jsonb       not null default '{}'::jsonb,  -- övriga fält, så att inget går förlorat
  deleted     boolean     not null default false,
  updated_at  timestamptz not null default clock_timestamp(),
  primary key (user_id, id)
);
create index if not exists transactions_sync_idx  on public.transactions (user_id, updated_at);
create index if not exists transactions_month_idx on public.transactions (user_id, month) where not deleted;
create index if not exists transactions_date_idx  on public.transactions (user_id, tx_date) where not deleted;
create index if not exists transactions_cat_idx   on public.transactions (user_id, category) where not deleted;

drop trigger if exists transactions_touch on public.transactions;
create trigger transactions_touch before insert or update on public.transactions
  for each row execute function public.touch_updated_at();

-- ── Förmögenhet per månad ─────────────────────────────────────────
create table if not exists public.net_worth_snapshots (
  user_id    uuid        not null default auth.uid() references auth.users(id) on delete cascade,
  period     text        not null check (period ~ '^\d{4}-\d{2}$'),
  total      numeric(16,2) not null default 0,
  amounts    jsonb       not null default '{}'::jsonb,   -- {"cash":65000,"stocks":240000,...}
  deleted    boolean     not null default false,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (user_id, period)
);
create index if not exists nws_sync_idx on public.net_worth_snapshots (user_id, updated_at);

drop trigger if exists nws_touch on public.net_worth_snapshots;
create trigger nws_touch before insert or update on public.net_worth_snapshots
  for each row execute function public.touch_updated_at();

-- ── Inställningar och övrigt (nyckel → JSON) ──────────────────────
create table if not exists public.user_state (
  user_id    uuid        not null default auth.uid() references auth.users(id) on delete cascade,
  key        text        not null,
  value      jsonb,
  deleted    boolean     not null default false,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (user_id, key)
);
create index if not exists user_state_sync_idx on public.user_state (user_id, updated_at);

drop trigger if exists user_state_touch on public.user_state;
create trigger user_state_touch before insert or update on public.user_state
  for each row execute function public.touch_updated_at();

-- ── Radsäkerhet ───────────────────────────────────────────────────
alter table public.transactions        enable row level security;
alter table public.net_worth_snapshots enable row level security;
alter table public.user_state          enable row level security;

do $$
declare t text;
begin
  foreach t in array array['transactions','net_worth_snapshots','user_state'] loop
    execute format('drop policy if exists "own rows" on public.%I', t);
    execute format(
      'create policy "own rows" on public.%I for all to authenticated
         using ((select auth.uid()) = user_id)
         with check ((select auth.uid()) = user_id)', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end $$;

-- ── Bekväm vy för egna frågor i SQL Editor (bara aktiva rader) ────
create or replace view public.v_transactions with (security_invoker = true) as
  select id, tx_date, month, type, amount, category, description, account, source, mkey
  from public.transactions where not deleted;
revoke all on public.v_transactions from anon;
grant select on public.v_transactions to authenticated;

-- Exempel:
--   select month, sum(amount) from v_transactions where type='expense' group by month order by month;
--   select description, sum(amount) from v_transactions where type='expense' and tx_date >= '2026-01-01'
--     group by description order by 2 desc limit 20;

-- ── Nycklar för AI-kopplingen (MCP) ───────────────────────────────
-- Skapas under Inställningar → AI-koppling (MCP). Bara SHA-256-hashen sparas; själva nyckeln
-- visas en gång i appen. Edge-funktionen supabase/functions/mcp slår upp hashen och läser/skriver
-- sedan bara den användarens rader. scope: 'read' = bara läsa, 'write' = läsa och ändra.
create table if not exists public.mcp_tokens (
  id           uuid        primary key default gen_random_uuid(),
  user_id      uuid        not null default auth.uid() references auth.users(id) on delete cascade,
  name         text        not null default 'MCP',
  token_hash   text        not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  scope        text        not null default 'read' check (scope in ('read','write')),
  created_at   timestamptz not null default now(),
  last_used_at timestamptz
);
create index if not exists mcp_tokens_user_idx on public.mcp_tokens (user_id);
alter table public.mcp_tokens enable row level security;
drop policy if exists "own rows" on public.mcp_tokens;
create policy "own rows" on public.mcp_tokens for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
revoke all on public.mcp_tokens from anon;
grant select, insert, delete on public.mcp_tokens to authenticated;
