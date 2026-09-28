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

-- ── Saldohistorik, lån och skulder (används av MCP-servern) ──────────
-- Samma mönster som tabellerna ovan: user_id, deleted-flagga, updated_at som servern sätter, RLS.
-- Konton finns kvar i user_state.accounts (kind: bank | card | savings | investment); här sparas
-- saldot per datum. Lånets skuld sparas som positivt tal per datum i loan_balances.
create table if not exists public.account_balances (
  user_id    uuid          not null default auth.uid() references auth.users(id) on delete cascade,
  account    text          not null,                 -- id i user_state.accounts
  bal_date   date          not null,
  value      numeric(16,2) not null,                 -- saldo som banken visar det
  source     text,                                   -- 'manual' | 'import' | 'mcp'
  deleted    boolean       not null default false,
  updated_at timestamptz   not null default clock_timestamp(),
  primary key (user_id, account, bal_date)
);
create table if not exists public.loans (
  user_id          uuid          not null default auth.uid() references auth.users(id) on delete cascade,
  id               text          not null,           -- t.ex. 'loan_mr3k1x'
  name             text          not null,
  lender           text,
  reference        text,                             -- lånenummer/kontonummer, t.ex. 53293315887
  interest_pct     numeric(6,3),
  amortization     numeric(14,2),                    -- kr per månad
  secured_by       text,                             -- förmögenhetskategori (cats_nw.key), t.ex. 'apt'
  netted_in_assets boolean       not null default false, -- skulden är redan avdragen i tillgångsvärdet
  extra            jsonb         not null default '{}'::jsonb,
  deleted          boolean       not null default false,
  updated_at       timestamptz   not null default clock_timestamp(),
  primary key (user_id, id)
);
create table if not exists public.loan_balances (
  user_id    uuid          not null default auth.uid() references auth.users(id) on delete cascade,
  loan_id    text          not null,
  bal_date   date          not null,
  value      numeric(16,2) not null check (value >= 0),
  deleted    boolean       not null default false,
  updated_at timestamptz   not null default clock_timestamp(),
  primary key (user_id, loan_id, bal_date)
);
create index if not exists account_balances_sync_idx on public.account_balances (user_id, updated_at);
create index if not exists loans_sync_idx            on public.loans (user_id, updated_at);
create index if not exists loan_balances_sync_idx    on public.loan_balances (user_id, updated_at);
-- Uppdelade transaktioner och länkade överföringar (fälten ligger i transactions.extra)
create index if not exists transactions_parent_idx on public.transactions ((extra->>'parent_id')) where extra ? 'parent_id';
create index if not exists transactions_pair_idx   on public.transactions ((extra->>'transfer_pair_id')) where extra ? 'transfer_pair_id';

do $$
declare t text;
begin
  foreach t in array array['account_balances','loans','loan_balances'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_touch', t);
    execute format('create trigger %I before insert or update on public.%I for each row execute function public.touch_updated_at()', t || '_touch', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "own rows" on public.%I', t);
    execute format(
      'create policy "own rows" on public.%I for all to authenticated
         using ((select auth.uid()) = user_id)
         with check ((select auth.uid()) = user_id)', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end $$;

-- ── Bankkoppling (Enable Banking, PSD2) — se supabase/functions/bank ──
-- bank_connections: en rad per BankID-samtycke. accounts = bankens konton och vilket konto i appen
-- de hör till ([{uid,name,iban,app_account,...}]). Appen får läsa (visa status), bara servern skriver.
create table if not exists public.bank_connections (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null references auth.users(id) on delete cascade,
  aspsp       text        not null,                  -- t.ex. 'SEB'
  country     text        not null default 'SE',
  session_id  text        not null,
  valid_until timestamptz not null,                  -- samtycket måste förnyas med BankID efter detta
  accounts    jsonb       not null default '[]'::jsonb,
  status      text        not null default 'active', -- 'active' | 'expired' | 'error'
  last_sync   timestamptz,
  last_error  text,
  created_at  timestamptz not null default now()
);
create index if not exists bank_connections_user_idx on public.bank_connections (user_id);
alter table public.bank_connections enable row level security;
drop policy if exists "own rows read" on public.bank_connections;
create policy "own rows read" on public.bank_connections for select to authenticated
  using ((select auth.uid()) = user_id);
revoke all on public.bank_connections from anon, authenticated;
-- start_date: transaktioner före detta datum hämtas aldrig (äldre data i appen rörs inte)
alter table public.bank_connections add column if not exists start_date date;
grant select (id, aspsp, country, valid_until, accounts, status, last_sync, last_error, created_at, user_id, start_date)
  on public.bank_connections to authenticated;

-- Pågående BankID-inloggningar (state → användare). Bara servern läser och skriver.
create table if not exists public.bank_auth_states (
  state      uuid        primary key,
  user_id    uuid        not null references auth.users(id) on delete cascade,
  aspsp      text        not null,
  return_to  text        not null,
  created_at timestamptz not null default now()
);
alter table public.bank_auth_states enable row level security;
revoke all on public.bank_auth_states from anon, authenticated;

-- ── Notiser (Web Push) — se supabase/functions/_shared/push.ts ──────
-- push_subscriptions: en rad per enhet som slagit på notiser (appen sparar, servern skickar).
create table if not exists public.push_subscriptions (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        not null default auth.uid() references auth.users(id) on delete cascade,
  endpoint   text        not null unique,
  p256dh     text        not null,
  auth       text        not null,
  device     text,
  created_at timestamptz not null default now(),
  last_ok    timestamptz
);
create index if not exists push_subscriptions_user_idx on public.push_subscriptions (user_id);
alter table public.push_subscriptions enable row level security;
drop policy if exists "own rows" on public.push_subscriptions;
create policy "own rows" on public.push_subscriptions for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
revoke all on public.push_subscriptions from anon;
grant select, insert, update, delete on public.push_subscriptions to authenticated;

-- notifications: skickade notiser. key gör att samma händelse bara skickas en gång.
create table if not exists public.notifications (
  user_id uuid        not null references auth.users(id) on delete cascade,
  key     text        not null,
  title   text,
  body    text,
  sent_at timestamptz not null default now(),
  primary key (user_id, key)
);
alter table public.notifications enable row level security;
drop policy if exists "own rows read" on public.notifications;
create policy "own rows read" on public.notifications for select to authenticated using ((select auth.uid()) = user_id);
revoke all on public.notifications from anon, authenticated;
grant select on public.notifications to authenticated;

-- Spärr så att två bankhämtningar för samma användare inte körs samtidigt (nattjobb + "Hämta nu").
-- bank_try_lock tar spärren om den är ledig eller har gått ut; bank_unlock släpper den. Bara servern.
create table if not exists public.bank_sync_locks (
  user_id uuid        primary key references auth.users(id) on delete cascade,
  until   timestamptz not null
);
alter table public.bank_sync_locks enable row level security;
revoke all on public.bank_sync_locks from anon, authenticated;
create or replace function public.bank_try_lock(p_user uuid, p_secs int) returns boolean
language plpgsql security definer set search_path = public as $$
declare ok boolean;
begin
  insert into bank_sync_locks (user_id, until) values (p_user, now() + make_interval(secs => p_secs))
  on conflict (user_id) do update set until = excluded.until where bank_sync_locks.until < now()
  returning true into ok;
  return coalesce(ok, false);
end $$;
create or replace function public.bank_unlock(p_user uuid) returns void
language sql security definer set search_path = public as $$ delete from bank_sync_locks where user_id = p_user $$;
revoke all on function public.bank_try_lock(uuid, int) from public, anon, authenticated;
revoke all on function public.bank_unlock(uuid) from public, anon, authenticated;
grant execute on function public.bank_try_lock(uuid, int) to service_role;
grant execute on function public.bank_unlock(uuid) to service_role;

-- ── Backups före migreringar ─────────────────────────────────────────
-- Varje migrering sparar först en JSON-kopia av det den ändrar (label = migreringens namn).
create table if not exists public.backups (
  id         bigserial   primary key,
  user_id    uuid        not null references auth.users(id) on delete cascade,
  label      text        not null,
  data       jsonb       not null,
  created_at timestamptz not null default now()
);
create index if not exists backups_user_idx on public.backups (user_id, label);
alter table public.backups enable row level security;
drop policy if exists "own rows read" on public.backups;
create policy "own rows read" on public.backups for select to authenticated using ((select auth.uid()) = user_id);
revoke all on public.backups from anon, authenticated;
grant select on public.backups to authenticated;

-- ── Tillgångar med manuellt värde per datum (lägenhet, klockor, AB, pension …) ──
-- asset = förmögenhetskategorins nyckel (cats_nw.key). Lån som "hör till" tillgången (loans.secured_by)
-- dras av när förmögenheten räknas ut, så värdet här är bruttovärdet.
create table if not exists public.asset_values (
  user_id    uuid          not null default auth.uid() references auth.users(id) on delete cascade,
  asset      text          not null,
  val_date   date          not null,
  value      numeric(16,2) not null,
  note       text,
  deleted    boolean       not null default false,
  updated_at timestamptz   not null default clock_timestamp(),
  primary key (user_id, asset, val_date)
);
create index if not exists asset_values_sync_idx on public.asset_values (user_id, updated_at);
drop trigger if exists asset_values_touch on public.asset_values;
create trigger asset_values_touch before insert or update on public.asset_values for each row execute function public.touch_updated_at();
alter table public.asset_values enable row level security;
drop policy if exists "own rows" on public.asset_values;
create policy "own rows" on public.asset_values for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
revoke all on public.asset_values from anon;
grant select, insert, update, delete on public.asset_values to authenticated;

-- Automatiskt skapade förmögenhetsbilder (nattjobbet) markeras; manuellt registrerade skrivs aldrig över
alter table public.net_worth_snapshots add column if not exists auto boolean not null default false;

-- MCP-nycklar kan ha ett utgångsdatum (valfritt; null = gäller tills den återkallas). Servern nekar utgångna nycklar.
alter table public.mcp_tokens add column if not exists expires_at timestamptz;
