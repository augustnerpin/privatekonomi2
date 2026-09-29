// Supabase Edge Function: MCP-server för Privatekonomi — allt i en fil, så att den går att
// klistra in direkt i Supabase-panelen. Driftsätt: supabase functions deploy mcp --no-verify-jwt
import { createClient } from 'npm:@supabase/supabase-js@2';
import { goalProgress, avgSavings12, goalPct, resolveGoalStart } from '../_shared/goal.ts';
import { saveMerged, type StateIo } from '../_shared/merge.ts';
import { decompose, debtAt as debtAtStart, manualValues } from '../_shared/networth.ts';
import { SNAPSHOT_SCHEMA, SETTINGS_SCHEMA, importSnapshot, investmentsFor, loadInvest, investView, avanzaStepReturns, mergeSettings, investCatsOf } from '../_shared/avanza.ts';

// Privatekonomi som MCP-server (Model Context Protocol, "Streamable HTTP", tillståndslös).
// Låter Claude och andra AI-appar läsa och ändra din ekonomi i Supabase.
//
// Databasklienten skickas in i createHandler (supabase-js med service role längst ner, en
// låtsasdatabas i testerna). Service role kringgår RLS, så VARJE fråga filtreras på
// user_id här — gå via uq() nedan, aldrig direkt mot db.from().
//
// Konventioner (samma som appen):
//  • utgift (expense) och sparande (savings): positivt belopp = pengar ut, negativt = retur
//  • inkomst (income): positivt = pengar in
//  • överföring (transfer): negativt = flyttat till eget konto/tillgång, räknas inte som utgift
//  • month = löneperiod (t.ex. 2026-09 = lönen i slutet av augusti till dagen före nästa lön)

// deno-lint-ignore-file no-explicit-any
type Db = any;
type Obj = Record<string, any>;
// st = inställningarna som de såg ut när de lästes (värde + updated_at), så att saveState kan slå ihop i stället för att skriva över
type Ctx = { db: Db; uid: string; scope: 'read' | 'write'; st?: Obj };

export const SERVER_NAME = 'privatekonomi';
export const SERVER_VERSION = '2.0.0';
// Appens ikon (icons/icon-512.png, 96 px) — visas av AI-appar som stödjer serverikoner
const APP_URL = 'https://augustnerpin.github.io/privatekonomi2/';
const ICONS = [
  { src: 'data:image/png;base64,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', mimeType: 'image/png', sizes: ['96x96'] },
  { src: APP_URL + 'icons/icon-512.png', mimeType: 'image/png', sizes: ['512x512'] },
];
const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const TYPES = ['expense', 'income', 'savings', 'transfer'];
const TYPE_LABEL: Obj = { expense: 'Utgift', income: 'Inkomst', savings: 'Sparande', transfer: 'Överföring' };
const CARD_PAYMENT = 'Kreditkortsbetalning'; // överföring som inte räknas som flyttade pengar

// ── Standardvärden (samma som i index.html) ───────────────────────────
const DEF: Obj = {
  cats_exp: ['Boende (Lån)', 'Boende (Avgift)', 'Boende (Resterande)', 'Mat (Butik)', 'Mat (Ute)', 'Lunch (Restaurang)', 'Transport/Parkering', 'Gym', 'Fest', 'Kläder', 'Resa', 'Bjuda andra/presenter', 'Prenumerationer', 'Swish (privat)', 'Övrigt', 'Skuld föregående'],
  cats_inc: ['Lön', 'Spelvinst/förlust', 'Övrigt'],
  cats_sav: ['Avanza', 'SEB', 'Annat'],
  cats_trf: ['Kreditkortsbetalning', 'Egen överföring', 'Bostad, lån & tillgångar'],
  cats_nw: [
    { key: 'cash', label: 'Likvidamedel' }, { key: 'stocks', label: 'Aktier/fonder' }, { key: 'apt', label: 'Lägenhet' },
    { key: 'pension', label: 'Pension' }, { key: 'klockor', label: 'Klockor' }, { key: 'ab', label: 'AB' },
    { key: 'kontanter', label: 'Kontanter' }, { key: 'other', label: 'Övrigt' },
  ],
  accounts: [{ id: 'lonekonto', name: 'Lönekonto', kind: 'bank' }, { id: 'amex', name: 'AMEX', kind: 'card' }],
  cat_groups: [], cat_budgets: {}, pay_periods: [], contact_names: {}, merchant_rules: {},
  goal: 700000, goal_date: '', salary: 0, owner_name: '', ai_profile: {}, goal_start: null, planned_savings: 10000, known_inflows: [],
};
// Kontotyper. Appen räknar bank + savings som likvida medel; card = kreditkort (köp brukar vara positiva i exporten).
const KINDS: Obj = { bank: 'Bankkonto', card: 'Kreditkort', savings: 'Sparkonto', investment: 'Investering (ISK/depå)', passage: 'Passagekonto (t.ex. bolånekonto, alltid neutralt)' };
const CAT_KEY: Obj = { expense: 'cats_exp', income: 'cats_inc', savings: 'cats_sav', transfer: 'cats_trf' };

// ── Datum och löneperioder (portat från index.html) ───────────────────
const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const reDate = /^\d{4}-\d{2}-\d{2}$/, reMonth = /^\d{4}-\d{2}$/;
function validDate(s: string) { if (!reDate.test(s)) return false; const [y, m, d] = s.split('-').map(Number); const x = new Date(y, m - 1, d); return x.getMonth() === m - 1 && x.getDate() === d; }
function periodShift(ym: string, n: number) { const [y, m] = ym.split('-').map(Number); const d = new Date(y, m - 1 + n, 1); return d.getFullYear() + '-' + pad(d.getMonth() + 1); }
function easterDate(y: number) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const mm = Math.floor((a + 11 * h + 22 * l) / 451), month = Math.floor((h + l - 7 * mm + 114) / 31), day = ((h + l - 7 * mm + 114) % 31) + 1;
  return new Date(y, month - 1, day);
}
function swedishHolidays(y: number) {
  const e = easterDate(y);
  const off = (n: number) => { const d = new Date(e); d.setDate(d.getDate() + n); return d; };
  const D = (mo: number, da: number) => new Date(y, mo - 1, da);
  const mid = new Date(y, 5, 19); while (mid.getDay() !== 5) mid.setDate(mid.getDate() + 1);
  const allS = new Date(y, 9, 31); while (allS.getDay() !== 6) allS.setDate(allS.getDate() + 1);
  return new Set([D(1, 1), D(1, 6), D(5, 1), D(6, 6), D(12, 24), D(12, 25), D(12, 26), D(12, 31), off(-2), off(1), off(39), mid, allS].map(ymd));
}
// Lönen den 25:e (eller närmaste vardag före) startar nästa månads period
function suggestedPayDate(y: number, m0: number) {
  const hols = swedishHolidays(y); const d = new Date(y, m0, 25);
  while (d.getDay() === 0 || d.getDay() === 6 || hols.has(ymd(d))) d.setDate(d.getDate() - 1);
  return ymd(d);
}
function periodStart(ym: string, payPeriods: Obj[]) {
  const found = payPeriods.find((p) => p.period === ym); if (found) return found.startDate;
  const [y, m] = ym.split('-').map(Number); const pm = m - 2;
  return suggestedPayDate(pm < 0 ? y - 1 : y, pm < 0 ? 11 : pm);
}
export function periodForDate(date: string, payPeriods: Obj[] = []) {
  const [dy, dm] = date.split('-').map(Number); const all = [];
  for (let i = -2; i <= 3; i++) { const p = periodShift(dy + '-' + pad(dm), i); all.push({ period: p, start: periodStart(p, payPeriods) }); }
  all.sort((a, b) => a.start.localeCompare(b.start));
  let r = all[0].period; for (const p of all) { if (date >= p.start) r = p.period; else break; }
  return r;
}
function periodRange(ym: string, payPeriods: Obj[]) {
  const [y, m, d] = periodStart(periodShift(ym, 1), payPeriods).split('-').map(Number);
  return { start: periodStart(ym, payPeriods), end: ymd(new Date(y, m - 1, d - 1)) }; // dagen före nästa periods start
}
// Dagens datum i Sverige (servern kör i UTC)
const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm' }).format(new Date());

// ── Databas: alltid filtrerat på användaren ───────────────────────────
const uq = (c: Ctx, table: string, cols = '*') => c.db.from(table).select(cols).eq('user_id', c.uid);
async function must<T>(p: PromiseLike<{ data: T; error: any }>): Promise<T> { const { data, error } = await p; if (error) throw new Error('Databasfel: ' + (error.message || error)); return data; }
async function fetchAll(make: () => any) {
  const out: Obj[] = []; const PAGE = 1000;
  for (let i = 0; ; i += PAGE) { const rows = await must<Obj[]>(make().range(i, i + PAGE - 1)); out.push(...rows); if (rows.length < PAGE) break; }
  return out;
}

async function loadState(c: Ctx, keys: string[]) {
  const rows = await must<Obj[]>(uq(c, 'user_state', 'key,value,updated_at').eq('deleted', false).in('key', keys));
  c.st ||= {};
  for (const k of keys) { const r = rows.find((x) => x.key === k); c.st[k] = { v: r ? structuredClone(r.value) : undefined, at: r?.updated_at ?? null }; }
  const s: Obj = {};
  for (const k of keys) { const r = rows.find((x) => x.key === k); s[k] = r && r.value != null ? r.value : structuredClone(DEF[k]); }
  if (!Array.isArray(s.accounts) || !s.accounts.length) s.accounts = structuredClone(DEF.accounts);
  if (keys.includes('goal') && !(+s.goal > 0)) s.goal = DEF.goal;
  return s;
}
// Sparar en inställning utan att skriva över ändringar som gjorts sedan den lästes (i appen eller av nattjobbet):
// villkorad skrivning mot updated_at och sammanslagning fält för fält (_shared/merge.ts)
const stateIo = (c: Ctx): StateIo => ({
  async get(key) { return (await must<Obj[]>(uq(c, 'user_state', 'value,updated_at,deleted').eq('key', key)))[0] || null; },
  async update(key, value, at) { return (await must<Obj[]>(c.db.from('user_state').update({ value, deleted: false }).eq('user_id', c.uid).eq('key', key).eq('updated_at', at).select('updated_at')))[0]?.updated_at || null; },
  async insert(key, value) {
    const { data, error } = await c.db.from('user_state').insert({ user_id: c.uid, key, value, deleted: false }).select('updated_at');
    if (error) { if (error.code === '23505') return null; throw new Error('Databasfel: ' + error.message); }
    return data?.[0]?.updated_at || null;
  },
});
async function saveState(c: Ctx, key: string, value: any) {
  // Utan tidigare läsning av nyckeln är värdet en avsiktlig ersättning: serverns rad är grundvärdet (ingen sammanslagning)
  const r = await saveMerged(stateIo(c), key, value, c.st?.[key], () => true);
  (c.st ||= {})[key] = { v: structuredClone(r.value), at: r.at };
  return r.value;
}
const SETTINGS = ['cats_exp', 'cats_inc', 'cats_sav', 'cats_trf', 'cats_nw', 'cat_groups', 'cat_budgets', 'accounts', 'goal', 'goal_date', 'ai_profile', 'salary', 'pay_periods', 'contact_names', 'owner_name'];

const TX_COLS = 'id,type,amount,description,category,tx_date,month,account,source,mkey,extra';
function txQuery(c: Ctx, f: Obj) {
  let q = uq(c, 'transactions', TX_COLS).eq('deleted', false);
  if (f.month) q = q.eq('month', f.month);
  if (f.month_from) q = q.gte('month', f.month_from);
  if (f.month_to) q = q.lte('month', f.month_to);
  if (f.date_from) q = q.gte('tx_date', f.date_from);
  if (f.date_to) q = q.lte('tx_date', f.date_to);
  if (f.type) q = q.in('type', arr(f.type));
  if (f.category) q = q.in('category', arr(f.category));
  if (f.account) q = q.eq('account', f.account);
  return q.order('tx_date', { ascending: false }).order('id', { ascending: false });
}
const arr = (v: any) => (Array.isArray(v) ? v : [v]);
// Kontoflöde: minus = pengar ut från kontot, plus = in. Utgift/sparande lagras med omvänt tecken,
// så flow() är sin egen invers: flow(typ, flow(typ, x)) === x.
const flow = (type: string, amount: number) => (type === 'expense' || type === 'savings' ? -amount : amount);
const ore = (n: number) => Math.round(n * 100);
const kr = (n: number) => new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 2 }).format(n).replace(/\u2212/g, '-').replace(/[\u00a0\u202f]/g, ' ');
// Nya tabeller (account_balances, loans, loan_balances) finns först när schema.sql körts igen
const NEEDS_MIGRATION = 'Tabellen saknas i databasen — kör supabase/schema.sql igen i Supabase (SQL Editor).';
const missingTable = (e: any) => /42P01|PGRST205|does not exist|could not find the table/i.test(`${e?.code || ''} ${e?.message || ''}`);
async function mayMust<T>(p: PromiseLike<{ data: T; error: any }>): Promise<T | null> {
  const { data, error } = await p;
  if (error) { if (missingTable(error)) return null; throw new Error('Databasfel: ' + (error.message || error)); }
  return data;
}
// Skrivning i en ny tabell: fel på svenska om migreringen inte körts
async function mustNew(p: PromiseLike<{ data: any; error: any }>) {
  const { error } = await p;
  if (error) throw missingTable(error) ? new UserError(NEEDS_MIGRATION) : new Error('Databasfel: ' + (error.message || error));
}
// Nya id:n i appens schema (millisekunder), alltid större än befintliga
async function newIds(c: Ctx, n: number) {
  const top = await must<Obj[]>(uq(c, 'transactions', 'id').order('id', { ascending: false }).limit(1));
  const base = Math.max(Date.now(), (top[0] ? Number(top[0].id) : 0) + 1);
  return Array.from({ length: n }, (_, i) => base + i);
}
async function getTx(c: Ctx, id: number) {
  const rows = await must<Obj[]>(uq(c, 'transactions', '*').eq('id', id).eq('deleted', false));
  if (!rows[0]) throw new UserError(`Hittar ingen transaktion med id ${id}`);
  return rows[0];
}
const digits = (s: string) => { const t = String(s || '').trim(); return /^\+?\d[\d\s-]{5,}$/.test(t) ? t.replace(/\D/g, '') : null; };
const round = (n: number) => Math.round(n * 100) / 100;

// Hämta transaktioner: filter i databasen, fritext och belopp här (så att Swish-namn också matchar)
async function queryTxs(c: Ctx, f: Obj, s: Obj) {
  if (f.account) f = { ...f, account: accountId(s, f.account) ?? f.account };
  const rows = await fetchAll(() => txQuery(c, f));
  let txs = rows.map((r) => txView(r, s));
  if (f.search) {
    const words = String(f.search).toLowerCase().split(/\s+/).filter(Boolean);
    txs = txs.filter((t) => { const h = [t.description, t.contact, t.category, t.note].join(' ').toLowerCase(); return words.every((w) => h.includes(w)); });
  }
  if (f.tag) { const tg = String(f.tag).toLowerCase(); txs = txs.filter((t) => (t.tags || []).some((x: string) => x.toLowerCase() === tg)); }
  if (f.min_amount != null) txs = txs.filter((t) => t.amount >= f.min_amount);
  if (f.max_amount != null) txs = txs.filter((t) => t.amount <= f.max_amount);
  return txs;
}
function txView(r: Obj, s: Obj) {
  const t: Obj = { id: Number(r.id), date: r.tx_date, month: r.month, type: r.type, amount: Number(r.amount), category: r.category, description: r.description };
  const n = digits(r.description);
  if (n) { t.number = n; if (s.contact_names?.[n]) t.contact = s.contact_names[n]; }
  if (r.account) t.account = accountName(s, r.account);
  if (r.source) t.source = r.source;
  const x = r.extra || {};
  if (x.note) t.note = x.note;
  if (Array.isArray(x.tags) && x.tags.length) t.tags = x.tags;
  if (x.once && r.type === 'income') t.one_off = true; // engångsinkomst: inte i snitt, prognoser, sparkvot
  if (x.parent_id) { t.parent_id = Number(x.parent_id); t.split = `${x.split_index}/${x.split_of}`; }
  if (r.type === 'transfer') {
    // Negativt belopp = pengar ut från radens konto. Motkontot sparas i extra när det är känt.
    const own = r.account ? accountName(s, r.account) : null, amt = Number(r.amount);
    t.from_account = x.from_account ? accountName(s, x.from_account) : amt < 0 ? own : null;
    t.to_account = x.to_account ? accountName(s, x.to_account) : amt > 0 ? own : null;
    if (x.transfer_pair_id) t.pair_id = Number(x.transfer_pair_id);
  }
  t._mkey = r.mkey || null; t._acc = r.account || null; t._extra = x;
  return t;
}
const pub = (t: Obj) => { const { _mkey, _acc, _extra, ...rest } = t; return rest; };
async function balanceRows(c: Ctx) {
  const rows = await mayMust<Obj[]>(uq(c, 'account_balances', 'account,bal_date,value,source,confirmed').eq('deleted', false).order('bal_date', { ascending: true }));
  return { rows: (rows || []).map((r) => ({ account: r.account, date: r.bal_date, value: Number(r.value), source: r.source || null, confirmed: !!r.confirmed })), migrated: rows !== null };
}
// Historik per konto; appens eget saldo (från senaste import) räknas med om det datumet saknas
function balanceHistory(s: Obj, rows: Obj[]) {
  const by: Obj = {};
  for (const r of rows) (by[r.account] ||= []).push({ date: r.date, value: r.value, source: r.source, ...(!['bank', 'import'].includes(r.source) ? { estimated: !r.confirmed } : {}) });
  for (const a of s.accounts) {
    if (!a.balance?.date) continue;
    const h = (by[a.id] ||= []);
    if (!h.some((x: Obj) => x.date === a.balance.date)) h.push({ date: a.balance.date, value: Number(a.balance.value), source: 'app' });
  }
  for (const k in by) by[k].sort((x: Obj, y: Obj) => x.date.localeCompare(y.date));
  return by;
}
function accountView(a: Obj, hist: Obj[] = []) {
  const last = hist[hist.length - 1];
  // class: regular (bank/card), saving (savings/investment) eller passage (bolånekonto, alltid neutralt). Sparande mellan egna
  // konton avgörs av klasserna (regular → saving = +sparande i kontots savings_category, saving → regular = −sparande).
  const cls = a.kind === 'passage' || a.role === 'mortgage' ? 'passage' : a.kind === 'savings' || a.kind === 'investment' ? 'saving' : 'regular';
  return { id: a.id, name: a.name, kind: a.kind || 'bank', class: cls, ...(cls === 'saving' ? { savings_category: a.sav_cat || 'Annat' } : {}), ...(a.role ? { role: a.role } : {}),
    ...(a.match?.length ? { counterparty_text: a.match } : {}), ...(a.manual ? { manual: true } : {}), ...(a.number ? { number: a.number } : {}), ...(last ? { balance: { value: last.value, date: last.date } } : {}) };
}
// Lån och deras skuld per datum (null om tabellerna inte finns ännu)
async function loadLoans(c: Ctx): Promise<Obj[] | null> {
  const loans = await mayMust<Obj[]>(uq(c, 'loans', '*').eq('deleted', false).order('name', { ascending: true }));
  if (loans === null) return null;
  const bal = (await mayMust<Obj[]>(uq(c, 'loan_balances', 'loan_id,bal_date,value').eq('deleted', false).order('bal_date', { ascending: true }))) || [];
  return loans.map((l) => ({ ...l, history: bal.filter((b) => b.loan_id === l.id).map((b) => ({ date: b.bal_date, value: Number(b.value) })) }));
}
// Skulden ett visst datum = senaste kända saldo den dagen eller tidigare
const debtAt = (l: Obj, date: string) => { let v: number | null = null; for (const b of l.history) if (b.date <= date) v = b.value; return v; };
function findLoan(loans: Obj[], v: string) {
  const l = String(v).trim().toLowerCase(), n = l.replace(/[\s-]/g, '');
  return loans.find((x) => x.id.toLowerCase() === l || x.name.toLowerCase() === l || (x.reference && String(x.reference).replace(/[\s-]/g, '').toLowerCase() === n)) || null;
}
function loanView(l: Obj, s: Obj, withHistory = false) {
  const last = l.history[l.history.length - 1];
  const o: Obj = { id: l.id, name: l.name, lender: l.lender || null, reference: l.reference || null,
    interest_pct: l.interest_pct != null ? Number(l.interest_pct) : null, amortization_monthly: l.amortization != null ? Number(l.amortization) : null,
    secured_by: l.secured_by ? { key: l.secured_by, label: s.cats_nw.find((x: Obj) => x.key === l.secured_by)?.label || l.secured_by } : null,
    netted_in_assets: !!l.netted_in_assets, balance: last ? { value: last.value, date: last.date } : null,
    rate_type: l.extra?.rate_type || null, fixed_until: l.extra?.fixed_until || null, rate_change_date: l.extra?.rate_change_date || null,
    pay_account: l.extra?.pay_account || null, ...(l.extra?.last_interest ? { last_interest: l.extra.last_interest } : {}) };
  if (last && o.interest_pct != null) o.interest_monthly_estimate = round((last.value * o.interest_pct) / 100 / 12);
  if (withHistory) o.history = l.history;
  return o;
}
function accountName(s: Obj, id: string) { return s.accounts.find((a: Obj) => a.id === id)?.name || id; }
function accountId(s: Obj, v: string) {
  const l = String(v).toLowerCase();
  const n = String(v).replace(/[\s-]/g, '');
  return s.accounts.find((a: Obj) => a.id.toLowerCase() === l || String(a.name).toLowerCase() === l || (a.number && String(a.number).replace(/[\s-]/g, '') === n))?.id ?? null;
}

// ── Verktyg ───────────────────────────────────────────────────────────
const S = {
  month: { type: 'string', pattern: '^\\d{4}-\\d{2}$', description: 'Löneperiod YYYY-MM' },
  date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
  type: { type: 'string', enum: TYPES },
  strOrList: (d: string) => ({ anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }], description: d }),
};
const FILTERS: Obj = {
  month: { ...S.month, description: 'En löneperiod, t.ex. 2026-09' },
  month_from: { ...S.month, description: 'Från och med löneperiod' },
  month_to: { ...S.month, description: 'Till och med löneperiod' },
  date_from: { ...S.date, description: 'Från och med datum' },
  date_to: { ...S.date, description: 'Till och med datum' },
  type: { anyOf: [S.type, { type: 'array', items: S.type }], description: 'expense | income | savings | transfer (en eller flera)' },
  category: S.strOrList('Kategori(er), exakt namn — se get_settings'),
  account: { type: 'string', description: 'Kontots id eller namn' },
  search: { type: 'string', description: 'Fritext i beskrivning/Swish-namn/kategori, t.ex. "ica" eller "spotify"' },
  tag: { type: 'string', description: 'Tagg, t.ex. "London" (skiftlägesokänsligt)' },
  min_amount: { type: 'number' },
  max_amount: { type: 'number' },
};

const TRF_SIDE = {
  from: { type: 'string', description: 'Bara överföringar: kontot pengarna kommer från (konto i appen eller fritext, t.ex. ett kontonummer). Tom sträng tar bort.' },
  to: { type: 'string', description: 'Bara överföringar: kontot pengarna går till. Tom sträng tar bort.' },
};
type Tool = { name: string; title: string; description: string; inputSchema: Obj; write?: boolean; annotations?: Obj; run: (c: Ctx, a: Obj) => Promise<any> };
const RO = { readOnlyHint: true, openWorldHint: false };

export const TOOLS: Tool[] = [
  {
    name: 'get_settings',
    title: 'Inställningar och kategorier',
    description: 'Hämtar kategorier per typ, budget per kategori, konton (typ, kontonummer och senaste saldo), kategorigrupper, förmögenhetsmål, lön, förmögenhetskategorier och aktuell löneperiod. orphan_categories = kategorier som används i transaktioner men saknas i inställningarna (städa med merge_categories eller rename_category). Anropa först för att få exakta kategorinamn och konton.',
    inputSchema: { type: 'object', properties: {} },
    annotations: RO,
    async run(c) {
      const s = await loadState(c, SETTINGS);
      const cur = periodForDate(today(), s.pay_periods);
      const hist = balanceHistory(s, (await balanceRows(c)).rows);
      return {
        current_period: { month: cur, ...periodRange(cur, s.pay_periods) },
        categories: { expense: s.cats_exp, income: s.cats_inc, savings: s.cats_sav, transfer: s.cats_trf },
        orphan_categories: orphans(s, await categoryUsage(c)),
        category_groups: s.cat_groups,
        budgets: s.cat_budgets,
        accounts: s.accounts.map((a: Obj) => accountView(a, hist[a.id])),
        account_kinds: KINDS,
        net_worth_categories: s.cats_nw,
        net_worth_goal: +s.goal, net_worth_goal_date: s.goal_date || null,
        profile: s.ai_profile && Object.keys(s.ai_profile).length ? s.ai_profile : null,
        salary: +s.salary || 0,
        owner_name: s.owner_name || undefined,
        conventions: 'expense/savings: positivt = pengar ut (negativt = retur). income: positivt = in. transfer: negativt = flyttat till eget konto, räknas inte som utgift. month = löneperiod.',
      };
    },
  },
  {
    name: 'list_transactions',
    title: 'Lista transaktioner',
    description: 'Söker transaktioner med filter (löneperiod, datum, typ, kategori, konto, fritext, belopp). Returnerar antal, summa och raderna (nyast först som standard). Belopp: utgift/sparande positivt = pengar ut, inkomst positivt = in, överföring negativt = ut. Är beskrivningen ett Swish-/kontonummer finns numret i number och namnet (om det är satt med set_contact) i contact; fritextsökning träffar båda. Överföringar har from_account/to_account (och pair_id om de är länkade), uppdelade rader parent_id och split.',
    inputSchema: {
      type: 'object',
      properties: {
        ...FILTERS,
        sort: { type: 'string', enum: ['date_desc', 'date_asc', 'amount_desc', 'amount_asc'], default: 'date_desc' },
        limit: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
        offset: { type: 'integer', minimum: 0, default: 0 },
      },
    },
    annotations: RO,
    async run(c, a) {
      const s = await loadState(c, ['accounts', 'contact_names']);
      const txs = await queryTxs(c, a, s);
      const sort = a.sort || 'date_desc';
      if (sort === 'date_asc') txs.reverse();
      if (sort === 'amount_desc') txs.sort((x, y) => y.amount - x.amount);
      if (sort === 'amount_asc') txs.sort((x, y) => x.amount - y.amount);
      const off = a.offset || 0, lim = Math.min(a.limit || 50, 500);
      const page = txs.slice(off, off + lim).map(pub);
      return { count: txs.length, total_amount: round(txs.reduce((x, t) => x + t.amount, 0)), offset: off, returned: page.length, has_more: off + page.length < txs.length, transactions: page };
    },
  },
  {
    name: 'summarize_transactions',
    title: 'Summera transaktioner',
    description: 'Summerar transaktioner grupperat per kategori, löneperiod, butik/mottagare, konto eller typ — t.ex. "vad har jag lagt på mat per månad i år" eller "största butikerna senaste 3 månaderna". Standard är bara utgifter.',
    inputSchema: {
      type: 'object',
      properties: {
        ...FILTERS,
        type: { ...FILTERS.type, description: FILTERS.type.description + '. Standard: expense' },
        group_by: { type: 'string', enum: ['category', 'month', 'merchant', 'account', 'type', 'category_month', 'tag'], default: 'category', description: 'tag: en rad per tagg (en transaktion med flera taggar räknas i varje)' },
        limit: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
      },
    },
    annotations: RO,
    async run(c, a) {
      const s = await loadState(c, ['accounts', 'contact_names']);
      const txs = await queryTxs(c, { ...a, type: a.type || 'expense' }, s);
      const by = a.group_by || 'category';
      const key = (t: Obj) =>
        by === 'month' ? t.month : by === 'account' ? t.account || '—' : by === 'type' ? t.type :
        by === 'merchant' ? t.contact || (t._mkey ? t._mkey.split('|')[0] : t.description.toLowerCase()) :
        by === 'category_month' ? t.category + ' | ' + t.month : t.category;
      const g = new Map<string, Obj>();
      for (const t of txs) for (const k of by === 'tag' ? (t.tags?.length ? t.tags : ['(ingen tagg)']) : [key(t)]) {
        const o = g.get(k) || { key: k, sum: 0, count: 0 };
        if (by === 'merchant' && !o.example) { o.example = t.contact || t.description; if (t.number) o.number = t.number; }
        o.sum += t.amount; o.count++; g.set(k, o);
      }
      const total = txs.reduce((x, t) => x + t.amount, 0);
      let groups: Obj[] = [...g.values()].map((o) => ({ ...o, sum: round(o.sum), avg: round(o.sum / o.count), share_pct: total ? Math.round((o.sum / total) * 1000) / 10 : 0 }));
      groups.sort(by === 'month' || by === 'category_month' ? (x, y) => x.key.localeCompare(y.key) : (x, y) => y.sum - x.sum);
      const months = new Set(txs.map((t) => t.month)).size;
      groups = groups.slice(0, Math.min(a.limit || 50, 500));
      // Snittet per månad räknas utan engångsinkomster (one_off)
      const oneOff = txs.filter((t) => t.one_off), regular = total - oneOff.reduce((x, t) => x + t.amount, 0);
      return { group_by: by, transactions: txs.length, months, total: round(total), avg_per_month: months ? round(regular / months) : 0,
        ...(oneOff.length ? { one_off_income: { sum: round(total - regular), count: oneOff.length, note: 'Ingår i total och groups men inte i avg_per_month.' } } : {}), groups };
    },
  },
  {
    name: 'get_month_summary',
    title: 'Månadssammanställning',
    description: 'Sammanställning för en löneperiod som i appen: inkomst, utgifter, sparande, över/underskott, sparkvot, flyttat till egna konton, utgift per kategori mot budget och snitt för de 3 senaste perioderna, samt största utgifterna.',
    inputSchema: { type: 'object', properties: { month: { ...S.month, description: 'Löneperiod YYYY-MM. Standard: pågående period' } } },
    annotations: RO,
    async run(c, a) {
      const s = await loadState(c, ['accounts', 'contact_names', 'cat_budgets', 'pay_periods', 'cat_groups']);
      const month = a.month || periodForDate(today(), s.pay_periods);
      const txs = await queryTxs(c, { month_from: periodShift(month, -12), month_to: month }, s);
      const cur = txs.filter((t) => t.month === month);
      const sum = (ty: string) => cur.filter((t) => t.type === ty).reduce((x, t) => x + t.amount, 0);
      const income = sum('income'), expense = sum('expense'), savings = sum('savings');
      const oneOff = cur.filter((t) => t.one_off).reduce((x, t) => x + t.amount, 0), incomeR = income - oneOff;
      const moved = -cur.filter((t) => t.type === 'transfer' && t.category !== CARD_PAYMENT).reduce((x, t) => x + t.amount, 0);
      // Snitt per kategori för de 3 senaste perioderna före med data (som catAverages i appen)
      const prev: Obj[][] = [];
      for (let i = 1; i <= 12 && prev.length < 3; i++) { const p = periodShift(month, -i); const pt = txs.filter((t) => t.month === p && t.type === 'expense'); if (pt.length) prev.push(pt); }
      const avg: Obj = {}; prev.forEach((pt) => pt.forEach((t) => (avg[t.category] = (avg[t.category] || 0) + t.amount / prev.length)));
      const byCat: Obj = {}; cur.filter((t) => t.type === 'expense').forEach((t) => (byCat[t.category] = (byCat[t.category] || 0) + t.amount));
      const B = s.cat_budgets || {};
      const cats = [...new Set([...Object.keys(byCat), ...Object.keys(avg), ...Object.keys(B)])];
      const categories = cats.map((k) => {
        const o: Obj = { category: k, spent: round(byCat[k] || 0), avg_3: round(avg[k] || 0) };
        if (B[k]) { o.budget = +B[k]; o.left = round(B[k] - (byCat[k] || 0)); }
        return o;
      }).sort((x, y) => y.spent - x.spent || y.avg_3 - x.avg_3);
      const bsum = Object.values(B).reduce((x: number, v: any) => x + (+v || 0), 0);
      const range = periodRange(month, s.pay_periods);
      // AMEX (väntande): betalningar till AMEX-kontot som räknas som utgift tills kortutdraget för perioden importeras
      const pend = cur.filter((t) => t.type === 'expense' && t.category === 'AMEX (väntande)');
      return {
        month, ...range, in_progress: today() <= range.end && today() >= range.start,
        income: round(income), expense: round(expense), savings: round(savings),
        balance: round(income - expense - savings), savings_rate_pct: incomeR > 0 ? Math.round((savings / incomeR) * 100) : 0,
        ...(oneOff ? { one_off_income: round(oneOff), one_off_note: 'Engångsinkomster ingår i income och balance men inte i savings_rate_pct, snitt eller prognoser.' } : {}),
        moved_to_own_accounts: round(moved), balance_incl_moved: round(income - expense - savings + moved),
        ...(pend.length ? { pending_card: { amount: round(pend.reduce((x, t) => x + t.amount, 0)), count: pend.length, note: 'Ingår i expense. Ersätts av kortköpen när AMEX-utdraget för perioden importeras.' } } : {}),
        budget_total: bsum || undefined, compared_months: prev.length,
        categories, category_groups: s.cat_groups?.length ? s.cat_groups : undefined,
        largest_expenses: cur.filter((t) => t.type === 'expense').sort((x, y) => y.amount - x.amount).slice(0, 10).map(pub),
        transactions: cur.length,
      };
    },
  },
  {
    name: 'get_net_worth',
    title: 'Förmögenhet',
    description: 'Förmögenhet per månad (snapshots) uppdelat per tillgångskategori, med förändring mot föregående och framsteg mot målet. total/assets = summan av förmögenhetsvärdena som de är inmatade. Finns lån (get_loans) visas även liabilities (skuld vid månadens slut), net (= assets minus skulder som inte redan är avdragna) och gross_assets (= assets plus skulder som redan är avdragna i ett tillgångsvärde, t.ex. Lägenhet angiven netto). Förändring och målet räknas på total som i appen.',
    inputSchema: { type: 'object', properties: { month_from: FILTERS.month_from, month_to: FILTERS.month_to } },
    annotations: RO,
    async run(c, a) {
      const s = await loadState(c, ['cats_nw', 'goal', 'goal_start', 'pay_periods']);
      let q = uq(c, 'net_worth_snapshots', 'period,total,amounts').eq('deleted', false);
      if (a.month_from) q = q.gte('period', a.month_from);
      if (a.month_to) q = q.lte('period', a.month_to);
      const rows = await must<Obj[]>(q.order('period', { ascending: true }));
      const label = (k: string) => s.cats_nw.find((x: Obj) => x.key === k)?.label || k;
      const snaps = rows.map((r, i) => {
        const o: Obj = { period: r.period, total: Number(r.total), by_category: Object.fromEntries(Object.entries(r.amounts || {}).filter(([, v]) => +(v as number)).map(([k, v]) => [label(k), v])) };
        if (i) o.change = round(o.total - Number(rows[i - 1].total));
        return o;
      });
      const last = snaps[snaps.length - 1];
      const loans = await loadLoans(c);
      const extra: Obj = {};
      // Vad förändringen består av: sparande, amortering, avkastning, omvärdering, övrigt (per steg och totalt)
      if (rows.length > 1) {
        const st = await loadState(c, ['accounts', 'pay_periods', 'known_inflows']);
        const sav = await fetchAll(() => uq(c, 'transactions', 'month,type,category,amount').eq('deleted', false).eq('type', 'savings').order('id', { ascending: true }));
        const starts = Object.fromEntries(rows.map((r) => [r.period, periodStart(r.period, st.pay_periods)]));
        const investCats = st.accounts.filter((x: Obj) => x.kind === 'investment' && x.sav_cat).map((x: Obj) => x.sav_cat);
        const pension = (st.known_inflows || []).filter((x: Obj) => x.monthly && x.nw_cat === 'pension').reduce((x: number, y: Obj) => x + (Number(y.amount) || 0), 0);
        // Datum då aktier/fonder och pension har kända värden (varning om inget ligger nära periodgränsen)
        const nwOf = (x: Obj) => (x.nw_cat !== undefined ? x.nw_cat : x.kind === 'investment' ? 'stocks' : x.kind === 'card' ? null : 'cash');
        const bal = (await mayMust<Obj[]>(uq(c, 'account_balances', 'account,bal_date').eq('deleted', false))) || [];
        const av = (await mayMust<Obj[]>(uq(c, 'asset_values', 'asset,val_date').eq('deleted', false))) || [];
        const valueDates: Obj = {};
        for (const k of ['stocks', 'pension']) { const ids = st.accounts.filter((x: Obj) => nwOf(x) === k).map((x: Obj) => x.id); valueDates[k] = [...bal.filter((b) => ids.includes(b.account)).map((b) => b.bal_date), ...av.filter((x) => x.asset === k).map((x) => x.val_date)]; }
        // En Avanza-bild är också ett känt värde på aktier/fonder (varningen försvinner när en bild ligger inom 5 dagar)
        const inv = await loadInvest(c.db, c.uid);
        valueDates.stocks.push(...inv.snaps.map((x: Obj) => x.snap_date));
        extra.breakdown = decompose({ snaps: rows.map((r) => ({ period: r.period, total: Number(r.total), amounts: r.amounts || {} })), txs: sav, loans: loans || [], starts, investCats, pensionPerMonth: pension, valueDates });
        const ar = avanzaStepReturns(extra.breakdown.steps, starts, inv.snaps, inv.settings, inv.txs, investCatsOf(inv.accounts));
        if (ar.length) { extra.avanza_returns = ar; extra.avanza_returns_note = 'Avkastning på Avanza enligt ögonblicksbilderna närmast periodgränserna: värdeförändring − insättningar från banken (since_purchase_change = Avanzas egen siffra som kontroll).'; }
        extra.breakdown_explanation = 'Förmögenhetsbilden för P = läget när P börjar. warnings = aktier/pension saknar värde inom 5 dagar från periodgränsen (avkastningen kan då vara missvisande). Skulden före första kända lånesaldot räknas bakåt med amorteringen. sparande = sparandetransaktioner utom Amortering; amortering = minskad skuld (eller kategorin Amortering); avkastning = aktier/fonder + pension minus insättningar; omvärdering = övriga tillgångar minus amortering (engångsposter); övrigt = resten.';
      }
      if (loans?.length) {
        // Skulder vid periodens start (samma som breakdown): senaste saldo på/före startdatumet, före första kända
        // saldot bakåträknat med amorteringen. Lån markerade netted_in_assets är redan avdragna i tillgången.
        for (const o of snaps) {
          const start = periodStart(o.period, s.pay_periods || []);
          let all = 0, netted = 0, estimated = false; const by: Obj = {};
          for (const l of loans) { const d = debtAtStart(l, start); if (!d) continue; all += d.value; if (l.netted_in_assets) netted += d.value; by[l.name] = round(d.value); if (d.estimated) estimated = true; }
          Object.assign(o, { assets: o.total, liabilities: round(all), liabilities_already_in_assets: round(netted), net: round(o.total - (all - netted)), gross_assets: round(o.total + netted), liabilities_by_loan: by,
            liabilities_date: start, ...(estimated ? { liabilities_estimated: true } : {}) });
        }
        extra.loans = loans.map((l) => loanView(l, s));
        extra.explanation = 'assets = inmatade förmögenhetsvärden (samma som total). liabilities = lånens skuld när perioden börjar (liabilities_date; liabilities_estimated = bakåträknad med amorteringen före första kända saldot). Lån med netted_in_assets är redan avdragna i tillgången de hör till (secured_by) och dras inte av igen: net = assets − (liabilities − liabilities_already_in_assets). gross_assets = assets + liabilities_already_in_assets.';
      } else if (loans === null) extra.loans_note = 'Lån visas när schema.sql körts igen.';
      // Framsteg från förmögenheten när målet sattes (goal_start), inte från 0 kr; utan goal_start från första förmögenhetsbilden
      // goal_start pekar på en period; totalen läses från den bilden (rättelser slår igenom)
      const startSnap = s.goal_start?.period ? await must<Obj[]>(uq(c, 'net_worth_snapshots', 'period,total').eq('deleted', false).eq('period', s.goal_start.period)) : [];
      const gstart = resolveGoalStart(s.goal_start, startSnap) || (await must<Obj[]>(uq(c, 'net_worth_snapshots', 'period,total').eq('deleted', false).order('period', { ascending: true }).limit(1)))[0];
      const gp = last ? goalPct(Number(s.goal), gstart, last.total) : null;
      // Manuella saldon och värden: uppskattat tills användaren bekräftat, senast uppdaterad, äldre än 6 månader
      const ms = await loadState(c, ['accounts', 'cats_nw']);
      const mb = (await mayMust<Obj[]>(uq(c, 'account_balances', 'account,bal_date,value,source,confirmed').eq('deleted', false))) || [];
      const ma = (await mayMust<Obj[]>(uq(c, 'asset_values', 'asset,val_date,value,confirmed').eq('deleted', false))) || [];
      const mv = manualValues({ accounts: ms.accounts, balances: mb, assets: ma, cats: ms.cats_nw, today: today() });
      if (mv.length) {
        extra.manual_values = mv;
        extra.manual_values_note = 'Manuellt inmatade saldon/värden (inte från banken). estimated = uppskattat, inte bekräftat av användaren; updated = senast uppdaterad; stale = äldre än 6 månader. Säg det när du använder dem, t.ex. "Klarna 190 300 kr (uppskattat, 2026-09-29)".';
      }
      const latest = last ? { period: last.period, total: last.total, ...(mv.some((x) => x.estimated || x.stale) ? { contains_estimates: mv.filter((x) => x.estimated || x.stale).map((x) => x.name) } : {}), goal_progress_pct: gp?.progress_pct ?? null, goal_start: gp?.start ?? null, moved_since_goal_start: gp?.moved_since_start ?? null,
        goal_progress_note: 'goal_progress_pct = andel av vägen från goal_start.total (förmögenhetsbilden för goal_start.period, som den ser ut nu) till målet (0 % under startvärdet), inte total/mål.', left_to_goal: round(s.goal - last.total),
        ...(last.net != null ? { assets: last.assets, liabilities: last.liabilities, liabilities_already_in_assets: last.liabilities_already_in_assets, net: last.net, gross_assets: last.gross_assets } : {}) } : null;
      // Avanza ISK är ett konto i förmögenheten; underkontona, lånat kapital och hävstångsnettot från senaste bilden
      const iv = await investmentsFor(c.db, c.uid).catch(() => null);
      if (iv && (iv as Obj).accounts) {
        const v = iv as Obj;
        extra.avanza = { date: v.date, total_value: v.total_value, balance_in_net_worth: v.portfolio_value, sum_check: v.sum_check.text,
          accounts: v.accounts.map((a: Obj) => ({ name: a.name, type: a.type, value: a.value, available_cash: a.available_cash, reserved_cash: a.reserved_cash, hidden: a.hidden, counted: a.counted, funded_by_loan: a.funded_by_loan })),
          borrowed_capital: v.leverage?.borrowed_capital ?? null, leverage_net: v.leverage?.net ?? null, leverage: v.leverage?.text ?? null, available_now: v.liquidity.available_now,
          note: 'Avanza ISK är ett konto i förmögenheten (stocks); underkontona är detaljer och summan stämmer med saldot. Flyttar mellan underkonton är neutrala. Mer i get_investments.' };
      }
      return { goal: +s.goal, latest, categories: s.cats_nw, snapshots: snaps, ...extra };
    },
  },
  {
    name: 'get_investments',
    title: 'Investeringar (Avanza)',
    description: 'Senaste Avanza-bilden (eller den senaste på/före date): konton, innehav per konto och totalt, fördelning (fonder, aktier, ETF, reserverat, kontanter), fem största innehaven som andel av portföljen, varningar (t.ex. ett innehav över koncentrationsgränsen), utdelningar per år, förändring sedan förra bilden, hävstångsvyn (lånat kapital, avkastning, räntekostnad efter avdrag, netto), prognos för ISK-skatten (uppskattning) och likviditet "tillgängligt direkt". Bara fakta – ge inga köp- eller säljrekommendationer.',
    inputSchema: { type: 'object', properties: { date: { ...S.date, description: 'Bilden på eller före datumet (standard: senaste)' } } },
    annotations: RO,
    async run(c, a) { return await investmentsFor(c.db, c.uid, a.date || null); },
  },

  // ── Skrivande verktyg (kräver en nyckel med behörigheten "läsa och ändra") ──
  {
    name: 'import_avanza_snapshot',
    title: 'Importera Avanza-bild',
    description: 'Importerar en ögonblicksbild av Avanza (avanza_snapshot), t.ex. avläst i en Chrome-session: konton, innehav, kontanter, månadssparande, utdelningar och väntande order. Läser bara – appen kan aldrig handla eller flytta pengar hos Avanza. dry_run är standard (true): returnerar en förhandsgranskning (totalvärde, saldot som sätts på Avanza ISK, förändring sedan förra bilden, summakontroll, varningar och vad som ändras) utan att spara. Visa den för användaren och kör med dry_run: false först när hen godkänt. Summakontroll: konton som inte är dolda måste bli total_value (±1 kr), annars sparas inget. Samma bild två gånger ändrar ingenting. Sparar bilden med historik, sätter saldot på Avanza ISK till summan av kontona (dolda räknas med om inställningen include_hidden är på) och gör månadssparande från banken till förväntade transaktioner (notis om autogirot inte dragits inom 3 bankdagar). Flyttar mellan Avanza-konton blir inga förväntade banktransaktioner.',
    write: true,
    inputSchema: { type: 'object', required: ['snapshot'], properties: { snapshot: SNAPSHOT_SCHEMA, dry_run: { type: 'boolean', default: true, description: 'true (standard) = bara förhandsgranskning; false = spara' } } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async run(c, a) {
      const r: Obj = await importSnapshot(c.db, c.uid, a.snapshot, { dryRun: a.dry_run !== false, source: 'mcp' });
      if (r.valid === false) throw new UserError('Bilden följer inte schemat: ' + r.errors.join('; '));
      if (r.errors?.length) throw new UserError(r.errors.join('; '));
      return r;
    },
  },
  {
    name: 'set_investment_settings',
    title: 'Inställningar för investeringar',
    description: 'Ändrar inställningarna för Avanza-vyn (bara angivna fält; null tar bort): include_hidden, concentration_pct (varningsgräns, standard 15), interest_deduction_pct (ränteavdrag), funded_by_loan (namn på lånefinansierade Avanza-konton), autogiro_grace_bank_days, leverage {since, borrowed_kr, loan_id, app_accounts}, isk {tax_pct, extra_pct, min_pct, years: {"2026": {gov_rate_pct, tax_free}}}. Ändrar inget hos Avanza.',
    write: true,
    inputSchema: SETTINGS_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async run(c, a) {
      const s = await loadState(c, ['invest_settings']);
      const next = mergeSettings(s.invest_settings || {}, a);
      await saveState(c, 'invest_settings', next);
      return { settings: next };
    },
  },
  {
    name: 'add_transaction',
    title: 'Lägg till transaktion',
    description: 'Lägger till en transaktion. Löneperioden räknas ut från datumet. Kategorin måste finnas för typen (se get_settings). Belopp: utgift/sparande positivt = pengar ut; inkomst positivt = in; överföring negativt = flyttat ut från account. För överföringar kan from_account/to_account anges (konto i appen eller fritext som ett kontonummer).',
    write: true,
    inputSchema: {
      type: 'object',
      required: ['amount', 'type', 'category'],
      properties: {
        amount: { type: 'number', description: 'Belopp i kronor (se tecken ovan)' },
        type: S.type,
        category: { type: 'string' },
        description: { type: 'string', description: 'T.ex. butik eller mottagare' },
        date: { ...S.date, description: 'Datum, standard idag' },
        account: { type: 'string', description: 'Kontots id eller namn, standard första kontot' },
        from_account: TRF_SIDE.from, to_account: TRF_SIDE.to,
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async run(c, a) {
      const s = await loadState(c, ['accounts', 'pay_periods', 'contact_names', ...Object.values(CAT_KEY)]);
      const date = a.date || today();
      checkTx(s, { ...a, date });
      const acc = a.account ? accountId(s, a.account) : s.accounts[0].id;
      if (!acc) throw new UserError(`Okänt konto "${a.account}". Finns: ${s.accounts.map((x: Obj) => x.name).join(', ')}`);
      const [id] = await newIds(c, 1);
      const row = {
        user_id: c.uid, id, type: a.type, amount: a.amount, description: String(a.description || '').trim(), category: a.category,
        tx_date: date, month: periodForDate(date, s.pay_periods), account: acc, source: 'manual', extra: trfSides(s, a, { via: 'mcp' }), deleted: false,
      };
      await must(c.db.from('transactions').insert(row));
      return { created: pub(txView(row, s)), note: 'Syns i appen vid nästa synk.' };
    },
  },
  {
    name: 'update_transaction',
    title: 'Ändra transaktion',
    description: 'Ändrar en transaktion (id från list_transactions). Ändras typ/kategori på en importerad rad lärs regeln in för butiken, som i appen; svaret har då rule_id och previous_rule så att det kan ångras med update_rule/delete_rule (se undo). apply_to_same_merchant ändrar även övriga rader från samma butik. dry_run: true visar exakt vad som skulle ändras (raden, regeln och övriga rader) utan att spara. Belopp följer teckenkonventionen: utgift/sparande positivt = pengar ut, inkomst positivt = in, överföring negativt = ut.',
    write: true,
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'integer' },
        type: S.type, category: { type: 'string' }, amount: { type: 'number' },
        description: { type: 'string' }, date: S.date, account: { type: 'string' },
        from_account: TRF_SIDE.from, to_account: TRF_SIDE.to,
        tags: { type: 'array', items: { type: 'string' }, description: 'Ersätter taggarna ([] tar bort alla)' },
        add_tags: { type: 'array', items: { type: 'string' } }, remove_tags: { type: 'array', items: { type: 'string' } },
        one_off: { type: 'boolean', description: 'Bara inkomster: true = engångsinkomst (t.ex. skatteåterbäring, gåva) som inte räknas i snitt, prognoser, sparkvot eller kvar per dag; false = vanlig inkomst' },
        apply_to_same_merchant: { type: 'boolean', default: false },
        dry_run: { type: 'boolean', default: false, description: 'true = visa ändringarna utan att spara' },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    async run(c, a) {
      const s = await loadState(c, ['accounts', 'pay_periods', 'merchant_rules', ...Object.values(CAT_KEY)]);
      const rows = await must<Obj[]>(uq(c, 'transactions', TX_COLS).eq('id', a.id).eq('deleted', false));
      const r = rows[0]; if (!r) throw new UserError(`Hittar ingen transaktion med id ${a.id}`);
      const next: Obj = { type: a.type ?? r.type, category: a.category ?? r.category, amount: a.amount ?? Number(r.amount), date: a.date ?? r.tx_date };
      if (a.type && !a.category && a.type !== r.type) throw new UserError('Ange även category när du byter typ');
      // Oförändrad kategori godtas även om den tagits bort ur listan (som i appen)
      checkTx(s, next, next.type === r.type && next.category === r.category);
      const patch: Obj = { type: next.type, category: next.category, amount: next.amount, tx_date: next.date };
      if (a.date) patch.month = periodForDate(a.date, s.pay_periods);
      if (a.description != null) patch.description = String(a.description).trim();
      if (a.account) { const acc = accountId(s, a.account); if (!acc) throw new UserError(`Okänt konto "${a.account}"`); patch.account = acc; }
      let unpair: number | null = null;
      if (a.from_account != null || a.to_account != null) {
        if (next.type !== 'transfer') throw new UserError('from_account/to_account gäller bara överföringar (type: transfer)');
        patch.extra = trfSides(s, a, { ...(r.extra || {}) });
      } else if (next.type !== 'transfer' && r.type === 'transfer') {
        const { from_account, to_account, transfer_pair_id, ...rest } = r.extra || {};
        if (from_account || to_account || transfer_pair_id) patch.extra = rest;
        if (transfer_pair_id) unpair = Number(transfer_pair_id);
      }
      if (a.tags || a.add_tags || a.remove_tags) {
        const base = patch.extra || { ...(r.extra || {}) };
        const tags = nextTags(base.tags, a);
        if (tags.length) base.tags = tags; else delete base.tags;
        patch.extra = base;
      }
      if (a.one_off != null || (r.extra?.once && next.type !== 'income')) {
        if (a.one_off && next.type !== 'income') throw new UserError('one_off gäller bara inkomster (type: income)');
        const base = patch.extra || { ...(r.extra || {}) };
        if (a.one_off && next.type === 'income') base.once = true; else delete base.once;
        patch.extra = base;
      }
      const changedCat = next.category !== r.category || next.type !== r.type;
      const learn = !!r.mkey && changedCat;
      const prevRule = learn ? s.merchant_rules[r.mkey] ?? null : null;
      if (a.dry_run) {
        const same = learn && a.apply_to_same_merchant
          ? (await must<Obj[]>(uq(c, 'transactions', TX_COLS).eq('mkey', r.mkey).eq('deleted', false).neq('id', a.id))).filter((x) => x.type !== next.type || x.category !== next.category)
          : [];
        return {
          dry_run: true, would_update: { id: a.id, ...rowDiff(r, patch) },
          would_learn_rule: learn ? { rule_id: r.mkey, before: ruleView(r.mkey, prevRule), after: { type: next.type, category: next.category } } : null,
          would_also_update: same.map((x) => ({ id: Number(x.id), date: x.tx_date, description: x.description, amount: Number(x.amount), before: { type: x.type, category: x.category }, after: { type: next.type, category: next.category } })),
          note: 'Inget sparat. Kör igen utan dry_run för att spara.',
        };
      }
      await must(c.db.from('transactions').update(patch).eq('user_id', c.uid).eq('id', a.id));
      if (unpair) await unlinkPair(c, unpair);
      const out: Obj = { updated: { id: a.id, ...patch } };
      if (learn) {
        s.merchant_rules[r.mkey] = { ...(prevRule?.created ? { created: prevRule.created } : prevRule ? {} : { created: Date.now() }), type: next.type, cat: next.category, t: Date.now() };
        await saveState(c, 'merchant_rules', s.merchant_rules);
        out.learned_rule = r.mkey;
        out.rule_id = r.mkey;
        out.previous_rule = prevRule ? ruleView(r.mkey, prevRule) : null;
        out.undo = prevRule
          ? { tool: 'update_rule', arguments: { id: r.mkey, type: prevRule.type, category: prevRule.cat } }
          : { tool: 'delete_rule', arguments: { id: r.mkey } };
        if (a.apply_to_same_merchant) {
          const same = await must<Obj[]>(c.db.from('transactions').update({ type: next.type, category: next.category })
            .eq('user_id', c.uid).eq('mkey', r.mkey).eq('deleted', false).neq('id', a.id).select('id'));
          out.also_updated = same.length;
        }
      }
      return out;
    },
  },
  {
    name: 'delete_transaction',
    title: 'Ta bort transaktion',
    description: 'Tar bort en eller flera transaktioner (id från list_transactions). Raderna försvinner även på dina andra enheter.',
    write: true,
    inputSchema: { type: 'object', required: ['ids'], properties: { ids: { type: 'array', items: { type: 'integer' }, minItems: 1, maxItems: 200 } } },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    async run(c, a) {
      const before = await must<Obj[]>(uq(c, 'transactions', 'id,extra').eq('deleted', false).in('id', a.ids));
      const done = await must<Obj[]>(c.db.from('transactions').update({ deleted: true }).eq('user_id', c.uid).eq('deleted', false).in('id', a.ids).select('id'));
      // Länkade överföringar: motparten ska inte peka på en borttagen rad (då går den aldrig att länka om)
      for (const r of before) { const p = Number(r.extra?.transfer_pair_id); if (p && !a.ids.includes(p)) await unlinkPair(c, p); }
      return { deleted: done.map((r) => Number(r.id)), not_found: a.ids.filter((id: number) => !done.some((r) => Number(r.id) === id)) };
    },
  },
  {
    name: 'set_budget',
    title: 'Sätt budget',
    description: 'Sätter månadsbudget för en utgiftskategori. amount 0 tar bort budgeten.',
    write: true,
    inputSchema: { type: 'object', required: ['category', 'amount'], properties: { category: { type: 'string' }, amount: { type: 'number', minimum: 0 } } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async run(c, a) {
      const s = await loadState(c, ['cat_budgets', 'cats_exp']);
      if (!s.cats_exp.includes(a.category)) throw new UserError(`Okänd utgiftskategori "${a.category}". Finns: ${s.cats_exp.join(', ')}`);
      const B = s.cat_budgets || {};
      if (a.amount > 0) B[a.category] = Math.round(a.amount); else delete B[a.category];
      await saveState(c, 'cat_budgets', B);
      return { budgets: B };
    },
  },
  {
    name: 'set_net_worth',
    title: 'Spara förmögenhet',
    description: 'Sparar förmögenheten för en månad. values är belopp per förmögenhetskategori (nyckel eller namn, se get_settings). Kategorier som inte anges behåller sitt tidigare värde för månaden. Totalen räknas om.',
    write: true,
    inputSchema: {
      type: 'object', required: ['period', 'values'],
      properties: { period: { ...S.month, description: 'Månad YYYY-MM' }, values: { type: 'object', additionalProperties: { type: 'number' }, description: 'T.ex. {"cash": 65000, "Aktier/fonder": 240000}' } },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async run(c, a) {
      const s = await loadState(c, ['cats_nw']);
      const old = (await must<Obj[]>(uq(c, 'net_worth_snapshots', 'amounts').eq('period', a.period).eq('deleted', false)))[0];
      const amounts: Obj = { ...(old?.amounts || {}) }; for (const cat of s.cats_nw) amounts[cat.key] = +(amounts[cat.key] || 0);
      for (const [k, v] of Object.entries(a.values)) {
        const cat = s.cats_nw.find((x: Obj) => x.key === k || x.label.toLowerCase() === k.toLowerCase());
        if (!cat) throw new UserError(`Okänd förmögenhetskategori "${k}". Finns: ${s.cats_nw.map((x: Obj) => `${x.key} (${x.label})`).join(', ')}`);
        if (typeof v !== 'number' || !isFinite(v)) throw new UserError(`Ogiltigt belopp för "${k}"`);
        amounts[cat.key] = v;
      }
      // Bara nuvarande kategorier räknas (som saveNW i appen); borttagna kategorier kan ligga kvar i gamla månader
      const total = s.cats_nw.reduce((x: number, cat: Obj) => x + (+amounts[cat.key] || 0), 0);
      await must(c.db.from('net_worth_snapshots').upsert({ user_id: c.uid, period: a.period, total, amounts, deleted: false }, { onConflict: 'user_id,period' }));
      return { period: a.period, total, amounts };
    },
  },

  // ── Målet, manuella värden och förmögenhetskategorier ─────────────────
  {
    name: 'set_net_worth_goal',
    title: 'Sätt förmögenhetsmål',
    description: 'Sätter förmögenhetsmålet (amount, kr) och när det ska vara nått (target_date, YYYY-MM = löneperiod; målet gäller vid periodens slut). Nytt mål eller datum: planen och framsteget börjar om från senaste förmögenhetsbilden. Startpunkten (goal_start) pekar på en period och läser bildens aktuella total, så rättelser av startbilden slår igenom. start_period sätter om startpunkten till en viss period (utan att ändra målet); reset_start: true = till senaste bilden. Valfritt: planned_savings (kr/mån).',
    write: true,
    inputSchema: { type: 'object', properties: { amount: { type: 'number', minimum: 1 }, target_date: { ...S.month, description: 'YYYY-MM' }, planned_savings: { type: 'number', minimum: 0 },
      start_period: { ...S.month, description: 'Sätt om startpunkten till förmögenhetsbilden för denna period (YYYY-MM, måste finnas)' },
      reset_start: { type: 'boolean', description: 'true = nollställ startpunkten till senaste förmögenhetsbilden' } } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async run(c, a) {
      if (a.amount == null && a.target_date == null && a.planned_savings == null && !a.start_period && !a.reset_start) throw new UserError('Ange amount, target_date, planned_savings, start_period eller reset_start');
      if (a.amount != null) await saveState(c, 'goal', Math.round(a.amount));
      if (a.target_date) await saveState(c, 'goal_date', a.target_date);
      if (a.planned_savings != null) await saveState(c, 'planned_savings', Math.round(a.planned_savings));
      // Startpunkten: vald period, annars senaste bilden när målet/datumet ändras eller reset_start
      let start: Obj | null = null;
      if (a.start_period) {
        start = (await must<Obj[]>(uq(c, 'net_worth_snapshots', 'period,total').eq('deleted', false).eq('period', a.start_period)))[0];
        if (!start) throw new UserError(`Det finns ingen förmögenhetsbild för ${a.start_period}`);
      } else if (a.reset_start || a.amount != null || a.target_date) {
        start = (await must<Obj[]>(uq(c, 'net_worth_snapshots', 'period,total').eq('deleted', false).order('period', { ascending: false }).limit(1)))[0] || null;
      }
      if (start) await saveState(c, 'goal_start', { period: start.period });
      const s = await loadState(c, ['goal', 'goal_date']);
      return { goal: Number(s.goal), goal_date: s.goal_date || null, plan_starts_at: start ? { period: start.period, total: Number(start.total), note: 'Totalen läses från bilden varje gång (rättelser slår igenom).' } : 'oförändrad', note: 'Syns i appen vid nästa synk.' };
    },
  },
  {
    name: 'get_goal_progress',
    title: 'Målet mot plan',
    description: 'Förmögenhetsmålet mot plan: krav per månad ((mål − nu) / månader kvar), planlinjen från när målet sattes och status (vs_plan > 0 = före plan), samt prognos vid måldatumet i tre scenarier: svagt (snittsparande senaste 12 perioderna, 0 %), plan (planerat sparande, 6 %/år på aktier/fonder + pension) och bra (9 %). Alla scenarier räknar med amortering och kända inbetalningar.',
    inputSchema: { type: 'object', properties: { include_paths: { type: 'boolean', default: false, description: 'Ta med planlinjen och scenariernas bana månad för månad' } } },
    annotations: RO,
    async run(c, a) {
      const s = await loadState(c, ['goal', 'goal_date', 'goal_start', 'planned_savings', 'known_inflows']);
      if (!s.goal_date) throw new UserError('Inget måldatum satt — använd set_net_worth_goal med target_date');
      const snaps = await must<Obj[]>(uq(c, 'net_worth_snapshots', 'period,total,amounts').eq('deleted', false).order('period', { ascending: true }));
      const latest = snaps[snaps.length - 1]; if (!latest) throw new UserError('Ingen förmögenhetsbild registrerad än');
      const sav = await fetchAll(() => uq(c, 'transactions', 'month,type,category,amount').eq('deleted', false).eq('type', 'savings').order('id', { ascending: true }));
      const loans = (await loadLoans(c)) || [];
      const g = goalProgress({ goal: Number(s.goal), goalDate: s.goal_date, start: resolveGoalStart(s.goal_start, snaps), latest: { period: latest.period, total: Number(latest.total), amounts: latest.amounts },
        plannedSavings: Number(s.planned_savings ?? 10000), inflows: s.known_inflows || [], savingsLast12: avgSavings12(sav, latest.period), amortMonthly: loans.reduce((x, l) => x + (Number(l.amortization) || 0), 0) });
      if (!g) throw new UserError('Kunde inte räkna ut planen');
      if (!a.include_paths) { g.plan = { ...g.plan, line: undefined }; g.scenarios = g.scenarios.map((x: Obj) => ({ ...x, path: undefined })); }
      return { ...g, known_inflows: s.known_inflows || [] };
    },
  },
  {
    name: 'set_asset_value',
    title: 'Sätt värde på tillgång',
    description: 'Sparar värdet på en tillgång med manuellt värde per datum, t.ex. lägenheten (bruttovärde; lån som hör till tillgången dras av automatiskt när förmögenheten räknas ut), klockor, AB eller pension. asset = förmögenhetskategorins nyckel eller namn (se list_net_worth_categories).',
    write: true,
    inputSchema: { type: 'object', required: ['asset', 'value'], properties: { asset: { type: 'string' }, value: { type: 'number' }, date: S.date, note: { type: 'string' },
      confirmed: { type: 'boolean', default: false, description: 'true bara när användaren sagt att värdet är exakt/bekräftat. Annars visas det som uppskattat.' } } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async run(c, a) {
      const s = await loadState(c, ['cats_nw']);
      const v = String(a.asset).trim().toLowerCase();
      const cat = s.cats_nw.find((x: Obj) => x.key.toLowerCase() === v || x.label.toLowerCase() === v);
      if (!cat) throw new UserError(`Okänd förmögenhetskategori "${a.asset}". Finns: ${s.cats_nw.map((x: Obj) => `${x.key} (${x.label})`).join(', ')}`);
      const date = a.date || today();
      if (!validDate(date)) throw new UserError(`Ogiltigt datum "${date}"`);
      await mustNew(c.db.from('asset_values').upsert({ user_id: c.uid, asset: cat.key, val_date: date, value: a.value, note: a.note ?? null, confirmed: !!a.confirmed, deleted: false }, { onConflict: 'user_id,asset,val_date' }));
      return { asset: cat.key, label: cat.label, value: a.value, date, estimated: !a.confirmed, note: 'Används när förmögenheten räknas ut (appen: Beräkna från saldon, nattjobbet vid ny löneperiod).' };
    },
  },
  {
    name: 'list_net_worth_categories',
    title: 'Förmögenhetskategorier',
    description: 'Listar förmögenhetskategorierna (nyckel och namn) med senaste värde i förmögenhetsbilden och senaste manuella värde.',
    inputSchema: { type: 'object', properties: {} },
    annotations: RO,
    async run(c) {
      const s = await loadState(c, ['cats_nw', 'accounts']);
      const last = (await must<Obj[]>(uq(c, 'net_worth_snapshots', 'period,amounts').eq('deleted', false).order('period', { ascending: false }).limit(1)))[0];
      const vals = (await mayMust<Obj[]>(uq(c, 'asset_values', 'asset,val_date,value').eq('deleted', false).order('val_date', { ascending: true }))) || [];
      return { categories: s.cats_nw.map((x: Obj) => {
        const v = vals.filter((r) => r.asset === x.key).pop();
        const accs = s.accounts.filter((acc: Obj) => (acc.nw_cat !== undefined ? acc.nw_cat : acc.kind === 'investment' ? 'stocks' : acc.kind === 'card' ? null : 'cash') === x.key).map((acc: Obj) => acc.name);
        return { key: x.key, label: x.label, latest: last ? Number(last.amounts?.[x.key] || 0) : null, manual_value: v ? { value: Number(v.value), date: v.val_date } : null, accounts: accs };
      }), latest_period: last?.period ?? null };
    },
  },
  {
    name: 'create_net_worth_category',
    title: 'Skapa förmögenhetskategori',
    description: 'Skapar en förmögenhetskategori (label = namn, key = valfri nyckel; skapas annars från namnet).',
    write: true,
    inputSchema: { type: 'object', required: ['label'], properties: { label: { type: 'string' }, key: { type: 'string', pattern: '^[a-z0-9_]{1,30}$' } } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async run(c, a) {
      const s = await loadState(c, ['cats_nw']);
      const label = String(a.label).trim(); if (!label) throw new UserError('Ange ett namn');
      const key = a.key || label.toLowerCase().replace(/[åä]/g, 'a').replace(/ö/g, 'o').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30) || 'cat_' + Date.now().toString(36);
      if (s.cats_nw.some((x: Obj) => x.key === key || x.label.toLowerCase() === label.toLowerCase())) throw new UserError(`Kategorin "${label}" (${key}) finns redan`);
      const cats = [...s.cats_nw, { key, label }];
      await saveState(c, 'cats_nw', cats);
      return { created: { key, label }, categories: cats };
    },
  },
  {
    name: 'rename_net_worth_category',
    title: 'Byt namn på förmögenhetskategori',
    description: 'Byter namn på en förmögenhetskategori. Nyckeln (och därmed historiken) behålls.',
    write: true,
    inputSchema: { type: 'object', required: ['category', 'label'], properties: { category: { type: 'string', description: 'Nyckel eller nuvarande namn' }, label: { type: 'string' } } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async run(c, a) {
      const s = await loadState(c, ['cats_nw']);
      const v = String(a.category).trim().toLowerCase(); const label = String(a.label).trim(); if (!label) throw new UserError('Ange ett namn');
      const cat = s.cats_nw.find((x: Obj) => x.key.toLowerCase() === v || x.label.toLowerCase() === v);
      if (!cat) throw new UserError(`Okänd förmögenhetskategori "${a.category}"`);
      const cats = s.cats_nw.map((x: Obj) => (x.key === cat.key ? { ...x, label } : x));
      await saveState(c, 'cats_nw', cats);
      return { renamed: { key: cat.key, from: cat.label, to: label } };
    },
  },
  {
    name: 'delete_net_worth_category',
    title: 'Ta bort förmögenhetskategori',
    description: 'Tar bort en förmögenhetskategori ur listan. Gamla förmögenhetsbilder behåller sina värden (historiken ändras inte), men kategorin räknas inte i nya. Kräver confirm: true om kategorin har ett värde i senaste bilden.',
    write: true,
    inputSchema: { type: 'object', required: ['category'], properties: { category: { type: 'string' }, confirm: { type: 'boolean', default: false } } },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    async run(c, a) {
      const s = await loadState(c, ['cats_nw']);
      const v = String(a.category).trim().toLowerCase();
      const cat = s.cats_nw.find((x: Obj) => x.key.toLowerCase() === v || x.label.toLowerCase() === v);
      if (!cat) throw new UserError(`Okänd förmögenhetskategori "${a.category}"`);
      const last = (await must<Obj[]>(uq(c, 'net_worth_snapshots', 'period,amounts').eq('deleted', false).order('period', { ascending: false }).limit(1)))[0];
      const val = Number(last?.amounts?.[cat.key] || 0);
      if (val && !a.confirm) throw new UserError(`${cat.label} har ${round(val)} kr i förmögenhetsbilden ${last.period}. Kör igen med confirm: true för att ta bort ändå (historiken behålls).`);
      await saveState(c, 'cats_nw', s.cats_nw.filter((x: Obj) => x.key !== cat.key));
      return { deleted: { key: cat.key, label: cat.label }, note: 'Gamla förmögenhetsbilder är oförändrade.' };
    },
  },

  // ── Konton och saldon ───────────────────────────────────────────────
  {
    name: 'get_account_balances',
    title: 'Kontosaldon över tid',
    description: 'Saldo per konto och datum (saldohistorik), t.ex. för att följa sparkontot eller se lönekontots saldo vid en viss tidpunkt. Saldot är det banken visar (för kreditkort oftast skulden som negativt tal). Utan account returneras alla konton. Senaste saldot per konto finns också i get_settings.',
    inputSchema: { type: 'object', properties: { account: { type: 'string', description: 'Kontots id eller namn' }, date_from: FILTERS.date_from, date_to: FILTERS.date_to } },
    annotations: RO,
    async run(c, a) {
      const s = await loadState(c, ['accounts']);
      let accs = s.accounts;
      if (a.account) { const id = accountId(s, a.account); if (!id) throw new UserError(unknownAccount(s, a.account)); accs = accs.filter((x: Obj) => x.id === id); }
      const { rows, migrated } = await balanceRows(c);
      const hist = balanceHistory(s, rows);
      return {
        accounts: accs.map((x: Obj) => {
          const h = (hist[x.id] || []).filter((b: Obj) => (!a.date_from || b.date >= a.date_from) && (!a.date_to || b.date <= a.date_to));
          return { ...accountView(x, hist[x.id]), history: h };
        }),
        ...(migrated ? {} : { note: 'Bara appens senaste saldo visas. ' + NEEDS_MIGRATION }),
      };
    },
  },
  {
    name: 'set_account',
    title: 'Skapa eller ändra konto',
    description: 'Skapar ett konto eller ändrar namn, typ eller kontonummer. Utan account skapas ett nytt konto (name och kind krävs). kind: bank = vanligt bank-/lönekonto, card = kreditkort, savings = sparkonto (t.ex. SEB sparkonto), investment = ISK/depå (t.ex. Avanza). Kontot syns i appen efter nästa synk.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: 'Befintligt kontos id eller namn. Utelämna för att skapa nytt.' },
        name: { type: 'string' }, kind: { type: 'string', enum: Object.keys(KINDS) },
        number: { type: 'string', description: 'Kontonummer, t.ex. 53293380441. Tom sträng tar bort det.' },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async run(c, a) {
      const s = await loadState(c, ['accounts']);
      const name = a.name != null ? String(a.name).trim() : undefined;
      if (name === '') throw new UserError('Kontot måste ha ett namn');
      let acc: Obj;
      if (a.account) {
        const id = accountId(s, a.account); if (!id) throw new UserError(unknownAccount(s, a.account));
        acc = s.accounts.find((x: Obj) => x.id === id);
      } else {
        if (!name || !a.kind) throw new UserError('Ange name och kind för att skapa ett konto (eller account för att ändra ett befintligt)');
        acc = { id: 'acc_' + Date.now().toString(36), name, kind: a.kind };
        s.accounts.push(acc);
      }
      if (name && s.accounts.some((x: Obj) => x !== acc && x.name.toLowerCase() === name.toLowerCase())) throw new UserError(`Det finns redan ett konto som heter "${name}"`);
      if (name) acc.name = name;
      if (a.kind) acc.kind = a.kind;
      if (a.number != null) { const n = String(a.number).trim(); if (n) acc.number = n; else delete acc.number; }
      await saveState(c, 'accounts', s.accounts);
      return { account: accountView(acc), created: !a.account };
    },
  },
  {
    name: 'set_account_balance',
    title: 'Spara kontosaldo',
    description: 'Sparar ett kontos saldo ett visst datum (som banken visar det; för kreditkort oftast negativt = skuld). Ett senare datum än det appen har blir kontots aktuella saldo även i appen. Samma konto och datum skrivs över.',
    write: true,
    inputSchema: {
      type: 'object', required: ['account', 'value'],
      properties: { account: { type: 'string', description: 'Kontots id eller namn' }, value: { type: 'number' }, date: { ...S.date, description: 'Datum, standard idag' },
        confirmed: { type: 'boolean', default: false, description: 'true bara när användaren sagt att saldot är exakt (t.ex. avläst i bankens app). Annars visas det som uppskattat.' } },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async run(c, a) {
      const s = await loadState(c, ['accounts']);
      const id = accountId(s, a.account); if (!id) throw new UserError(unknownAccount(s, a.account));
      const date = a.date || today();
      await mustNew(c.db.from('account_balances').upsert({ user_id: c.uid, account: id, bal_date: date, value: a.value, source: 'mcp', confirmed: !!a.confirmed, deleted: false }, { onConflict: 'user_id,account,bal_date' }));
      const acc = s.accounts.find((x: Obj) => x.id === id);
      const current = !acc.balance?.date || date >= acc.balance.date;
      if (current) { acc.balance = { value: a.value, date }; await saveState(c, 'accounts', s.accounts); }
      return { account: acc.name, date, value: a.value, is_latest: current, estimated: !a.confirmed };
    },
  },

  // ── Överföringar ────────────────────────────────────────────────────
  {
    name: 'match_transfers',
    title: 'Para ihop överföringar',
    description: 'Hittar överföringar mellan två av dina konton i appen där båda sidor finns som egna rader: samma belopp med motsatt tecken (−5 000 på det ena kontot, +5 000 på det andra), olika konton och högst 3 dagar mellan datumen. Utan confirm föreslås bara paren (inget sparas); med confirm: true länkas de (pair_id, from_account, to_account på båda raderna). Tvetydiga fall (flera lika bra kandidater) länkas aldrig automatiskt — välj själv och skicka dem i link tillsammans med confirm: true. Länkningen ändrar inga belopp eller summeringar.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        month: { ...S.month, description: 'Löneperiod att leta i (motparten får ligga upp till 3 dagar utanför). Standard: alla.' },
        confirm: { type: 'boolean', default: false, description: 'true = länka de föreslagna paren' },
        link: { type: 'array', maxItems: 200, items: { type: 'object', required: ['out_id', 'in_id'], properties: { out_id: { type: 'integer' }, in_id: { type: 'integer' } } }, description: 'Bara dessa par (t.ex. valda bland tvetydiga). Kräver confirm: true.' },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async run(c, a) {
      const s = await loadState(c, ['accounts', 'pay_periods', 'contact_names']);
      if (a.link && !a.confirm) throw new UserError('link kräver confirm: true');
      const f: Obj = { type: 'transfer' };
      let inScope = (_r: Obj) => true;
      if (a.month) { const pr = periodRange(a.month, s.pay_periods); f.date_from = addDays(pr.start, -3); f.date_to = addDays(pr.end, 3); inScope = (r) => r.month === a.month; }
      const rows = await fetchAll(() => txQuery(c, f));
      const byId = new Map(rows.map((r) => [Number(r.id), r]));
      const free = rows.filter((r) => !r.extra?.transfer_pair_id && r.account);
      const ok = (o: Obj, i: Obj) => Number(o.amount) < 0 && ore(Number(o.amount)) === -ore(Number(i.amount)) && o.account !== i.account && dayDiff(o.tx_date, i.tx_date) <= 3;
      const view = (r: Obj) => ({ id: Number(r.id), date: r.tx_date, account: accountName(s, r.account), amount: Number(r.amount), category: r.category, description: r.description });
      let pairs: Obj[] = [];
      const ambiguous: Obj[] = [];
      if (a.link) {
        for (const l of a.link) {
          const o = byId.get(l.out_id), i = byId.get(l.in_id);
          if (!o || !i) throw new UserError(`Hittar ingen olänkad överföring med id ${!o ? l.out_id : l.in_id}${a.month ? ' i perioden' : ''}`);
          if (o.extra?.transfer_pair_id || i.extra?.transfer_pair_id) throw new UserError(`${o.extra?.transfer_pair_id ? l.out_id : l.in_id} är redan länkad`);
          if (!ok(o, i)) throw new UserError(`${l.out_id} och ${l.in_id} passar inte ihop: out_id ska vara negativ, in_id samma belopp positivt, olika konton, högst 3 dagar isär`);
          pairs.push({ o, i, d: dayDiff(o.tx_date, i.tx_date) });
        }
      } else {
        const edges: Obj[] = [];
        for (const o of free) for (const i of free) if (ok(o, i) && (inScope(o) || inScope(i))) edges.push({ o, i, d: dayDiff(o.tx_date, i.tx_date) });
        edges.sort((x, y) => x.d - y.d || x.o.tx_date.localeCompare(y.o.tx_date));
        const used = new Set<number>();
        for (const e of edges) {
          const oid = Number(e.o.id), iid = Number(e.i.id);
          if (used.has(oid) || used.has(iid)) continue;
          // Tvetydigt: en annan lika nära kandidat för någon av sidorna
          const rivals = edges.filter((x) => x !== e && x.d === e.d && (x.o === e.o || x.i === e.i) && !used.has(Number(x.o.id)) && !used.has(Number(x.i.id)));
          if (rivals.length) {
            ambiguous.push({ out: view(e.o), candidates: [e, ...rivals].map((x) => ({ ...view(x.o === e.o ? x.i : x.o), days_apart: x.d })) });
            for (const x of [e, ...rivals]) { used.add(Number(x.o.id)); used.add(Number(x.i.id)); }
            continue;
          }
          pairs.push(e); used.add(oid); used.add(iid);
        }
      }
      const inPairs = new Set(pairs.flatMap((p) => [Number(p.o.id), Number(p.i.id)]));
      const inAmb = new Set(ambiguous.flatMap((x) => [x.out.id, ...x.candidates.map((y: Obj) => y.id)]));
      const unmatched = free.filter((r) => inScope(r) && !inPairs.has(Number(r.id)) && !inAmb.has(Number(r.id)));
      const res: Obj = {
        pairs: pairs.map((p) => ({ from: view(p.o), to: view(p.i), days_apart: p.d })),
        ambiguous, already_linked_rows: rows.filter((r) => r.extra?.transfer_pair_id && inScope(r)).length,
        unmatched: { count: unmatched.length, note: 'Motparten saknas i appen (t.ex. ett konto som inte importeras) eller beloppen skiljer sig.', examples: unmatched.slice(0, 20).map(view) },
      };
      if (!a.confirm) return { dry_run: true, ...res, next: pairs.length ? 'Kör igen med confirm: true för att länka paren.' : undefined };
      for (const p of pairs) {
        const sides = { from_account: p.o.account, to_account: p.i.account };
        await must(c.db.from('transactions').update({ extra: { ...(p.o.extra || {}), ...sides, transfer_pair_id: Number(p.i.id) } }).eq('user_id', c.uid).eq('id', p.o.id));
        await must(c.db.from('transactions').update({ extra: { ...(p.i.extra || {}), ...sides, transfer_pair_id: Number(p.o.id) } }).eq('user_id', c.uid).eq('id', p.i.id));
      }
      return { linked: pairs.length, ...res };
    },
  },

  // ── Lån ─────────────────────────────────────────────────────────────
  {
    name: 'get_loans',
    title: 'Lån',
    description: 'Listar lån (t.ex. bolån) med långivare, lånenummer, ränta, amortering per månad, aktuell skuld (positivt tal) och vilken förmögenhetskategori lånet hör till. netted_in_assets = skulden är redan avdragen i den tillgången (t.ex. Lägenhet angiven netto) och dras därför inte av igen i get_net_worth.',
    inputSchema: { type: 'object', properties: { include_history: { type: 'boolean', default: false, description: 'Ta med skulden per datum' } } },
    annotations: RO,
    async run(c, a) {
      const s = await loadState(c, ['cats_nw']);
      const loans = await loadLoans(c);
      if (loans === null) return { loans: [], note: NEEDS_MIGRATION };
      const view = loans.map((l) => loanView(l, s, a.include_history));
      return { loans: view, total_debt: round(view.reduce((x, l) => x + (l.balance?.value || 0), 0)),
        total_amortization_monthly: round(view.reduce((x, l) => x + (l.amortization_monthly || 0), 0)),
        total_interest_monthly_estimate: round(view.reduce((x, l) => x + (l.interest_monthly_estimate || 0), 0)) };
    },
  },
  {
    name: 'set_loan',
    title: 'Skapa eller ändra lån',
    description: 'Skapar ett lån eller ändrar ett befintligt (loan = id, namn eller lånenummer). Utan loan skapas nytt lån (name krävs). secured_by = förmögenhetskategorin lånet hör till (nyckel eller namn, t.ex. "apt" eller "Lägenhet"). netted_in_assets: true om tillgångens värde redan anges minus lånet (netto). balance sparar aktuell skuld som positivt tal (datum balance_date, standard idag).',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        loan: { type: 'string', description: 'Befintligt lån. Utelämna för att skapa nytt.' },
        name: { type: 'string' }, lender: { type: 'string' }, reference: { type: 'string', description: 'Lånenummer/kontonummer, t.ex. 53293315887' },
        interest_pct: { type: 'number', minimum: 0, maximum: 100, description: 'Ränta i procent, t.ex. 3.85' },
        amortization: { type: 'number', minimum: 0, description: 'Amortering i kr per månad' },
        secured_by: { type: 'string', description: 'Förmögenhetskategori (nyckel eller namn). Tom sträng tar bort kopplingen.' },
        netted_in_assets: { type: 'boolean' },
        balance: { type: 'number', minimum: 0, description: 'Aktuell skuld i kr' }, balance_date: S.date,
        rate_type: { type: 'string', enum: ['rörlig', 'bunden'], description: 'Rörlig eller bunden ränta' },
        fixed_until: { ...S.date, description: 'Bunden ränta till (YYYY-MM-DD)' },
        rate_change_date: { ...S.date, description: 'Villkorsändringsdag / nästa ränteändring (YYYY-MM-DD)' },
        pay_account: { type: 'string', description: 'Kontot som lånet dras från (namn eller id), t.ex. Bolånekonto' },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async run(c, a) {
      const s = await loadState(c, ['cats_nw', 'accounts']);
      const loans = await loadLoans(c);
      if (loans === null) throw new UserError(NEEDS_MIGRATION);
      let l: Obj;
      if (a.loan) {
        const f = findLoan(loans, a.loan);
        if (!f) throw new UserError(`Okänt lån "${a.loan}". Finns: ${loans.map((x) => x.name).join(', ') || 'inga lån än'}`);
        const { history, updated_at, ...rest } = f; l = rest;
      } else {
        if (!a.name?.trim()) throw new UserError('Ange name för att skapa ett lån (eller loan för att ändra ett befintligt)');
        l = { user_id: c.uid, id: 'loan_' + Date.now().toString(36), netted_in_assets: false, extra: {}, deleted: false };
      }
      if (a.name != null) {
        const name = String(a.name).trim(); if (!name) throw new UserError('Lånet måste ha ett namn');
        if (loans.some((x) => x.id !== l.id && x.name.toLowerCase() === name.toLowerCase())) throw new UserError(`Det finns redan ett lån som heter "${name}"`);
        l.name = name;
      }
      for (const k of ['lender', 'reference']) if (a[k] != null) l[k] = String(a[k]).trim() || null;
      if (a.interest_pct != null) l.interest_pct = a.interest_pct;
      if (a.amortization != null) l.amortization = a.amortization;
      if (a.netted_in_assets != null) l.netted_in_assets = a.netted_in_assets;
      // Villkor i extra (samma fält som appens lånevy och nattens påminnelser använder)
      for (const k of ['rate_type', 'fixed_until', 'rate_change_date']) if (a[k] != null) l.extra = { ...(l.extra || {}), [k]: a[k] || null };
      if (a.pay_account != null) {
        const v = String(a.pay_account).trim(); const id = v ? accountId(s, v) : null;
        if (v && !id) throw new UserError(unknownAccount(s, v));
        l.extra = { ...(l.extra || {}), pay_account: id };
      }
      if (a.secured_by != null) {
        const v = String(a.secured_by).trim().toLowerCase();
        const cat = v ? s.cats_nw.find((x: Obj) => x.key.toLowerCase() === v || x.label.toLowerCase() === v) : null;
        if (v && !cat) throw new UserError(`Okänd förmögenhetskategori "${a.secured_by}". Finns: ${s.cats_nw.map((x: Obj) => `${x.key} (${x.label})`).join(', ')}`);
        l.secured_by = cat ? cat.key : null;
      }
      await mustNew(c.db.from('loans').upsert(l, { onConflict: 'user_id,id' }));
      const history = loans.find((x) => x.id === l.id)?.history || [];
      if (a.balance != null) {
        const date = a.balance_date || today();
        await mustNew(c.db.from('loan_balances').upsert({ user_id: c.uid, loan_id: l.id, bal_date: date, value: a.balance, deleted: false }, { onConflict: 'user_id,loan_id,bal_date' }));
        history.push({ date, value: a.balance }); history.sort((x: Obj, y: Obj) => x.date.localeCompare(y.date));
      }
      return { loan: loanView({ ...l, history }, s), created: !a.loan };
    },
  },
  {
    name: 'set_loan_balance',
    title: 'Spara lånets skuld',
    description: 'Sparar ett låns skuld ett visst datum som positivt tal (t.ex. 2 150 000). Samma lån och datum skrivs över. Används av get_net_worth för skulden vid varje månads slut.',
    write: true,
    inputSchema: { type: 'object', required: ['loan', 'value'], properties: { loan: { type: 'string', description: 'Lånets id, namn eller lånenummer' }, value: { type: 'number', minimum: 0 }, date: { ...S.date, description: 'Datum, standard idag' } } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async run(c, a) {
      const loans = await loadLoans(c);
      if (loans === null) throw new UserError(NEEDS_MIGRATION);
      const l = findLoan(loans, a.loan);
      if (!l) throw new UserError(`Okänt lån "${a.loan}". Finns: ${loans.map((x) => x.name).join(', ') || 'inga lån än — skapa med set_loan'}`);
      const date = a.date || today();
      await mustNew(c.db.from('loan_balances').upsert({ user_id: c.uid, loan_id: l.id, bal_date: date, value: a.value, deleted: false }, { onConflict: 'user_id,loan_id,bal_date' }));
      const prev = debtAt(l, addDays(date, -1));
      return { loan: l.name, date, value: a.value, ...(prev != null ? { change_since_previous: round(a.value - prev) } : {}) };
    },
  },

  // ── Batch ───────────────────────────────────────────────────────────
  {
    name: 'bulk_update_transactions',
    title: 'Ändra många transaktioner',
    description: 'Ändrar typ, kategori, konto och/eller beskrivning på många transaktioner på en gång — valda med ids ELLER filter (samma filter som list_transactions, t.ex. {search: "spotify"} eller {category: "Spanien"}). Arbetsgång: 1) anropa med dry_run: true (standard) — inget sparas, du får exakt vilka rader som ändras med före/efter och expected_count; 2) visa för användaren; 3) anropa igen med samma urval, dry_run: false och expected_count. Om antalet inte stämmer (datan har ändrats) sparas inget. Högst 2 000 rader. Belopp och datum ändras inte här (använd update_transaction). Inga regler lärs in.',
    write: true,
    inputSchema: {
      type: 'object', required: ['changes'],
      properties: {
        ids: { type: 'array', items: { type: 'integer' }, minItems: 1, maxItems: 2000 },
        filter: { type: 'object', properties: FILTERS, description: 'Samma filter som list_transactions. Minst ett villkor.' },
        changes: { type: 'object', properties: { type: S.type, category: { type: 'string' }, account: { type: 'string', description: 'Kontots id, namn eller nummer' }, description: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Ersätter taggarna' }, add_tags: { type: 'array', items: { type: 'string' } }, remove_tags: { type: 'array', items: { type: 'string' } } } },
        dry_run: { type: 'boolean', default: true, description: 'Standard true. Bara false sparar.' },
        expected_count: { type: 'integer', minimum: 0, description: 'would_update från dry_run. Krävs när dry_run är false.' },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    async run(c, a) {
      const ch = a.changes;
      if (!!a.ids === !!a.filter) throw new UserError('Ange antingen ids eller filter (inte båda)');
      if (!Object.keys(ch).length) throw new UserError('changes är tomt — ange type, category, account och/eller description');
      if (a.filter && !Object.values(a.filter).some((v) => v != null && v !== '')) throw new UserError('filter får inte vara tomt — ange minst ett villkor (annars skulle alla rader ändras)');
      const s = await loadState(c, ['accounts', 'contact_names', ...Object.values(CAT_KEY)]);
      const acc = ch.account != null ? accountId(s, ch.account) : undefined;
      if (acc === null) throw new UserError(unknownAccount(s, ch.account));
      let txs: Obj[]; let notFound: number[] = [];
      if (a.ids) {
        const raw: Obj[] = [];
        for (let i = 0; i < a.ids.length; i += 200) raw.push(...await must<Obj[]>(uq(c, 'transactions', TX_COLS).eq('deleted', false).in('id', a.ids.slice(i, i + 200))));
        txs = raw.map((r) => txView(r, s));
        notFound = a.ids.filter((id: number) => !txs.some((t) => t.id === id));
      } else txs = await queryTxs(c, a.filter, s);
      if (txs.length > 2000) throw new UserError(`Urvalet träffar ${txs.length} rader — högst 2 000 per anrop. Smalna av filtret (t.ex. med month_from/month_to).`);
      // Kategorin kontrolleras bara när typ eller kategori ändras (rader i borttagna kategorier går att ändra i övrigt)
      const bad = ch.type != null || ch.category != null ? txs.filter((t) => !s[CAT_KEY[ch.type ?? t.type]].includes(ch.category ?? t.category)) : [];
      if (bad.length) {
        const ex = bad.slice(0, 5).map((t) => `${t.id} (${TYPE_LABEL[ch.type ?? t.type].toLowerCase()} "${ch.category ?? t.category}")`).join(', ');
        throw new UserError(`${bad.length} rader skulle få en kategori som inte finns för sin typ: ${ex}. Ange en category som finns för typen (se get_settings).`);
      }
      const desc = ch.description != null ? String(ch.description).trim() : undefined;
      const items = txs.map((t) => {
        const before: Obj = {}, after: Obj = {};
        if (ch.type && ch.type !== t.type) { before.type = t.type; after.type = ch.type; }
        if (ch.category && ch.category !== t.category) { before.category = t.category; after.category = ch.category; }
        if (acc && acc !== t._acc) { before.account = t.account ?? null; after.account = accountName(s, acc); }
        if (desc != null && desc !== t.description) { before.description = t.description; after.description = desc; }
        if (ch.tags || ch.add_tags || ch.remove_tags) { const nt = nextTags(t.tags, ch); if (JSON.stringify(nt) !== JSON.stringify(t.tags || [])) { before.tags = t.tags || []; after.tags = nt; } }
        return { t, view: { id: t.id, date: t.date, description: t.description, amount: t.amount, before, after } };
      }).filter((x) => Object.keys(x.view.after).length);
      const res = { matched: txs.length, would_update: items.length, unchanged: txs.length - items.length, ...(notFound.length ? { not_found: notFound } : {}) };
      if (a.dry_run !== false) {
        return { dry_run: true, ...res, expected_count: items.length, shown: Math.min(items.length, 200), changes: items.slice(0, 200).map((x) => x.view),
          next: items.length ? `Inget sparat. Kör igen med samma urval, dry_run: false och expected_count: ${items.length}.` : 'Inget att ändra.' };
      }
      if (a.expected_count == null) throw new UserError(`Ange expected_count (${items.length} enligt urvalet nu) — kör dry_run först och kontrollera ändringarna.`);
      if (a.expected_count !== items.length) throw new UserError(`Antalet rader som skulle ändras är nu ${items.length}, inte ${a.expected_count}. Datan har ändrats sedan förhandsgranskningen — kör dry_run igen. Inget sparat.`);
      const patch: Obj = {};
      if (ch.type) patch.type = ch.type;
      if (ch.category) patch.category = ch.category;
      if (acc) patch.account = acc;
      if (desc != null) patch.description = desc;
      const ids = items.map((x) => x.t.id);
      if (Object.keys(patch).length) for (let i = 0; i < ids.length; i += 200) await must(c.db.from('transactions').update(patch).eq('user_id', c.uid).eq('deleted', false).in('id', ids.slice(i, i + 200)));
      // Taggar ligger i extra: skrivs per rad
      for (const { t, view } of items) if (view.after.tags) {
        const extra = { ...t._extra }; if (view.after.tags.length) extra.tags = view.after.tags; else delete extra.tags;
        await must(c.db.from('transactions').update({ extra }).eq('user_id', c.uid).eq('id', t.id)); t._extra = extra;
      }
      // En överföring som blir något annat tappar sina sidor och sin motpart (som i update_transaction)
      if (ch.type && ch.type !== 'transfer') {
        for (const { t } of items) {
          const { from_account, to_account, transfer_pair_id, ...rest } = t._extra;
          if (t.type !== 'transfer' || !(from_account || to_account || transfer_pair_id)) continue;
          await must(c.db.from('transactions').update({ extra: rest }).eq('user_id', c.uid).eq('id', t.id));
          if (transfer_pair_id) await unlinkPair(c, Number(transfer_pair_id));
        }
      }
      return { updated: items.length, ...(notFound.length ? { not_found: notFound } : {}), note: 'Ändringarna syns på alla enheter vid nästa synk.' };
    },
  },

  // ── Inlärda regler ──────────────────────────────────────────────────
  {
    name: 'list_rules',
    title: 'Inlärda regler',
    description: 'Listar reglerna appen lärt sig för butiker/mottagare: vid import får rader med samma butiksnyckel automatiskt regelns typ och kategori. id = butiksnyckeln "mönster|riktning" (ut = pengar ut, in = pengar in), t.ex. "#51960273264|ut" för ett kontonummer eller "ica nara|ut". hits = antal transaktioner med den nyckeln. active: false betyder att kategorin inte längre finns för typen, så regeln används inte vid import.',
    inputSchema: { type: 'object', properties: { search: { type: 'string', description: 'Del av mönstret eller kategorin' }, type: S.type, category: { type: 'string' } } },
    annotations: RO,
    async run(c, a) {
      const s = await loadState(c, ['merchant_rules', 'contact_names', ...Object.values(CAT_KEY)]);
      const hits = await mkeyHits(c);
      const q = a.search ? String(a.search).toLowerCase() : null;
      let rules = Object.entries(s.merchant_rules as Obj).map(([id, v]) => {
        const o: Obj = { ...ruleView(id, v), hits: hits[id] || 0, active: !!s[CAT_KEY[v.type]]?.includes(v.cat) };
        const n = digits(o.pattern.replace(/^#/, '')); if (n && s.contact_names[n]) o.contact = s.contact_names[n];
        return o;
      });
      if (a.type) rules = rules.filter((r) => r.type === a.type);
      if (a.category) rules = rules.filter((r) => r.category === a.category);
      if (q) rules = rules.filter((r) => [r.pattern, r.category, r.contact].join(' ').toLowerCase().includes(q));
      rules.sort((x, y) => y.hits - x.hits || x.id.localeCompare(y.id));
      return { count: rules.length, inactive: rules.filter((r) => !r.active).length, rules };
    },
  },
  {
    name: 'update_rule',
    title: 'Ändra regel',
    description: 'Ändrar typ och/eller kategori för en inlärd regel (id från list_rules eller rule_id från update_transaction). Finns regeln inte skapas den (type och category krävs) — så kan en borttagen regel återställas. apply_to_existing: true ändrar även befintliga transaktioner med samma butiksnyckel. dry_run: true visar ändringen utan att spara.',
    write: true,
    inputSchema: {
      type: 'object', required: ['id'],
      properties: { id: { type: 'string' }, type: S.type, category: { type: 'string' }, apply_to_existing: { type: 'boolean', default: false }, dry_run: { type: 'boolean', default: false } },
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    async run(c, a) {
      const s = await loadState(c, ['merchant_rules', ...Object.values(CAT_KEY)]);
      const id = findRule(s.merchant_rules, a.id, false) ?? a.id;
      const old = s.merchant_rules[id] ?? null;
      if (!old && (!a.type || !a.category)) throw new UserError(`Hittar ingen regel "${a.id}". Ange type och category för att skapa den, eller se list_rules.`);
      if (!old && !/\|(ut|in)$/.test(id)) throw new UserError('En ny regel behöver ett id på formen mönster|ut eller mönster|in');
      if (!a.type && !a.category) throw new UserError('Ange type och/eller category');
      const type = a.type ?? old.type, cat = a.category ?? old.cat;
      if (a.type && !a.category && a.type !== old?.type && !s[CAT_KEY[type]].includes(cat)) throw new UserError('Ange även category när du byter typ');
      if (!s[CAT_KEY[type]].includes(cat)) throw new UserError(`Kategorin "${cat}" finns inte för ${TYPE_LABEL[type].toLowerCase()}. Finns: ${s[CAT_KEY[type]].join(', ')}`);
      const rows = a.apply_to_existing ? (await must<Obj[]>(uq(c, 'transactions', TX_COLS).eq('mkey', id).eq('deleted', false))).filter((r) => r.type !== type || r.category !== cat) : [];
      const res: Obj = { rule_id: id, before: old ? ruleView(id, old) : null, after: ruleView(id, { ...old, type, cat }), created: !old };
      if (a.apply_to_existing) res.transactions = rows.map((r) => ({ id: Number(r.id), date: r.tx_date, description: r.description, amount: Number(r.amount), before: { type: r.type, category: r.category }, after: { type, category: cat } }));
      if (a.dry_run) return { dry_run: true, ...res, note: 'Inget sparat.' };
      s.merchant_rules[id] = { ...(old || { created: Date.now() }), type, cat, t: Date.now() };
      await saveState(c, 'merchant_rules', s.merchant_rules);
      if (rows.length) await must(c.db.from('transactions').update({ type, category: cat }).eq('user_id', c.uid).eq('mkey', id).eq('deleted', false).in('id', rows.map((r) => r.id)));
      res.after = ruleView(id, s.merchant_rules[id]);
      if (rows.length) res.updated_transactions = rows.length;
      return res;
    },
  },
  {
    name: 'delete_rule',
    title: 'Ta bort regel',
    description: 'Tar bort en inlärd regel (id från list_rules). Befintliga transaktioner ändras inte; nya importer från butiken kategoriseras på nytt. Svaret innehåller undo för att återställa regeln med update_rule.',
    write: true,
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    async run(c, a) {
      const s = await loadState(c, ['merchant_rules']);
      const id = findRule(s.merchant_rules, a.id) as string;
      const old = s.merchant_rules[id];
      delete s.merchant_rules[id];
      await saveState(c, 'merchant_rules', s.merchant_rules);
      return { deleted: ruleView(id, old), undo: { tool: 'update_rule', arguments: { id, type: old.type, category: old.cat } } };
    },
  },

  // ── Kategorier ──────────────────────────────────────────────────────
  {
    name: 'create_category',
    title: 'Skapa kategori',
    description: 'Skapar en kategori för en typ (expense, income, savings eller transfer). Namnet måste vara unikt inom typen.',
    write: true,
    inputSchema: { type: 'object', required: ['type', 'name'], properties: { type: S.type, name: { type: 'string' } } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async run(c, a) {
      const key = CAT_KEY[a.type], name = catName(a.name);
      const s = await loadState(c, [key]);
      const dup = s[key].find((x: string) => x.toLowerCase() === name.toLowerCase());
      if (dup) throw new UserError(`Kategorin "${dup}" finns redan för ${TYPE_LABEL[a.type].toLowerCase()}`);
      await saveState(c, key, [...s[key], name]);
      return { type: a.type, created: name, categories: [...s[key], name] };
    },
  },
  {
    name: 'rename_category',
    title: 'Byt namn på kategori',
    description: 'Byter namn på en kategori inom en typ. Alla transaktioner, budgeten, kategorigrupper och inlärda regler följer med. Fungerar även för föräldralösa kategorier (orphan_categories i get_settings) — de läggs då till i inställningarna under det nya namnet. Finns det nya namnet redan: använd merge_categories. dry_run: true visar vad som skulle ändras.',
    write: true,
    inputSchema: { type: 'object', required: ['type', 'old', 'new'], properties: { type: S.type, old: { type: 'string' }, new: { type: 'string' }, dry_run: { type: 'boolean', default: false } } },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    async run(c, a) {
      const key = CAT_KEY[a.type], to = catName(a.new);
      const s = await loadState(c, [key]);
      if (a.old === to) throw new UserError('Det nya namnet är samma som det gamla');
      const dup = s[key].find((x: string) => x.toLowerCase() === to.toLowerCase() && x !== a.old);
      if (dup) throw new UserError(`Kategorin "${dup}" finns redan för ${TYPE_LABEL[a.type].toLowerCase()} — använd merge_categories för att slå ihop "${a.old}" med den`);
      return moveCategories(c, a.type, [a.old], to, true, !!a.dry_run);
    },
  },
  {
    name: 'merge_categories',
    title: 'Slå ihop kategorier',
    description: 'Slår ihop en eller flera kategorier (from) till en befintlig kategori (to) inom samma typ: alla transaktioner flyttas, budgetarna läggs ihop på to, kategorigrupper och inlärda regler uppdateras och de gamla kategorierna tas bort ur inställningarna. from får innehålla föräldralösa kategorier, t.ex. from: ["Spanien"], to: "Resa". dry_run: true visar vad som skulle ändras.',
    write: true,
    inputSchema: {
      type: 'object', required: ['type', 'from', 'to'],
      properties: { type: S.type, from: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 50 }, to: { type: 'string' }, dry_run: { type: 'boolean', default: false } },
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    async run(c, a) {
      const key = CAT_KEY[a.type];
      const s = await loadState(c, [key]);
      if (!s[key].includes(a.to)) throw new UserError(`Målkategorin "${a.to}" finns inte för ${TYPE_LABEL[a.type].toLowerCase()}. Finns: ${s[key].join(', ')}. Skapa den först med create_category eller använd rename_category.`);
      const from = [...new Set(a.from as string[])];
      if (from.includes(a.to)) throw new UserError(`"${a.to}" kan inte slås ihop med sig själv`);
      return moveCategories(c, a.type, from, a.to, false, !!a.dry_run);
    },
  },

  // ── Namn på Swish-/kontonummer ─────────────────────────────────────
  {
    name: 'list_contacts',
    title: 'Namn på Swish-mottagare',
    description: 'Listar namn som satts på telefon-/kontonummer (Swish och överföringar där banken bara visar numret) med antal transaktioner och summa pengar ut/in. unnamed = de vanligaste numren som saknar namn — bra att fråga användaren om och sätta med set_contact.',
    inputSchema: { type: 'object', properties: { include_unnamed: { type: 'boolean', default: true }, limit: { type: 'integer', minimum: 1, maximum: 200, default: 30, description: 'Max antal namnlösa nummer' } } },
    annotations: RO,
    async run(c, a) {
      const s = await loadState(c, ['contact_names']);
      const use = await numberUsage(c);
      const stat = (n: string) => { const u = use[n] || { transactions: 0, out: 0, in: 0 }; return { transactions: u.transactions, total_out: round(u.out), total_in: round(u.in) }; };
      const contacts = Object.entries(s.contact_names as Obj).map(([number, name]) => ({ number, name, kind: numberKind(number), ...stat(number) }))
        .sort((x, y) => y.transactions - x.transactions || x.name.localeCompare(y.name, 'sv'));
      const res: Obj = { count: contacts.length, contacts };
      if (a.include_unnamed !== false) {
        res.unnamed = Object.keys(use).filter((n) => !s.contact_names[n] && !numberVariants(n).some((v) => s.contact_names[v]))
          .map((number) => ({ number, kind: numberKind(number), ...stat(number) }))
          .sort((x, y) => y.transactions - x.transactions || y.total_out - x.total_out).slice(0, a.limit || 30);
      }
      return res;
    },
  },
  {
    name: 'set_contact',
    title: 'Sätt namn på nummer',
    description: 'Sätter ett namn på ett telefon- eller kontonummer, t.ex. phone: "070-123 45 67", name: "Anna". Namnet visas sedan i appen och i list_transactions/summarize_transactions (contact), och sökning på namnet träffar raderna. Mobilnummer matchas både som 07… och 467…. Tomt name tar bort namnet.',
    write: true,
    inputSchema: { type: 'object', required: ['phone', 'name'], properties: { phone: { type: 'string', description: 'Telefon- eller kontonummer, mellanslag och bindestreck går bra' }, name: { type: 'string' } } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async run(c, a) {
      const n = String(a.phone).replace(/[\s()+-]/g, '');
      if (!/^\d{6,}$/.test(n)) throw new UserError(`"${a.phone}" ser inte ut som ett telefon- eller kontonummer (minst 6 siffror)`);
      const name = String(a.name).trim();
      if (name.length > 60) throw new UserError('Namnet får vara högst 60 tecken');
      const s = await loadState(c, ['contact_names']);
      const use = await numberUsage(c);
      const variants = numberVariants(n);
      // Spara under det format som finns i transaktionerna (appen jämför exakt), annars som angivet
      const keys = variants.filter((v) => use[v]);
      if (!keys.length) keys.push(n);
      const C = { ...s.contact_names };
      for (const v of variants) delete C[v];
      if (name) for (const k of keys) C[k] = name;
      await saveState(c, 'contact_names', C);
      const tx = keys.reduce((x, k) => x + (use[k]?.transactions || 0), 0);
      return name ? { number: keys.join(', '), name, kind: numberKind(keys[0]), matched_transactions: tx } : { removed: variants.filter((v) => s.contact_names[v]), number: n };
    },
  },

  // ── Dela upp ────────────────────────────────────────────────────────
  {
    name: 'split_transaction',
    title: 'Dela upp transaktion',
    description: 'Delar upp en transaktion i flera delar med egen typ och kategori. Exempel: bolånebetalning 6 030 kr (utgift) → {amount: 1500, type: "expense", category: "Boende (Lån)"} (ränta) + {amount: -4530, type: "transfer", category: "Bostad, lån & tillgångar"} (amortering). Varje del anges med samma teckenkonvention som annars: utgift/sparande positivt = pengar ut, inkomst positivt = in, överföring negativt = pengar ut. Delarnas pengar in/ut måste summera exakt (på öret) till originalets, annars fel. Originalet ersätts och försvinner på alla enheter; delarna får parent_id = originalets id och ärver datum, löneperiod, konto och källa. En del kan inte delas igen. dry_run: true visar resultatet utan att spara.',
    write: true,
    inputSchema: {
      type: 'object',
      required: ['id', 'parts'],
      properties: {
        id: { type: 'integer', description: 'Transaktionens id (från list_transactions)' },
        parts: {
          type: 'array', minItems: 2, maxItems: 20,
          items: {
            type: 'object', required: ['amount', 'type', 'category'],
            properties: {
              amount: { type: 'number', description: 'Belopp med teckenkonventionen för delens typ' },
              type: S.type, category: { type: 'string' },
              description: { type: 'string', description: 'Standard: originalets beskrivning' },
            },
          },
        },
        dry_run: { type: 'boolean', default: false },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    async run(c, a) {
      const s = await loadState(c, ['accounts', 'contact_names', ...Object.values(CAT_KEY)]);
      const r = await getTx(c, a.id);
      if (r.extra?.parent_id) throw new UserError(`Transaktion ${a.id} är redan en del av en uppdelning (av ${r.extra.parent_id}) och kan inte delas igen`);
      a.parts.forEach((p: Obj, i: number) => {
        try { checkTx(s, { ...p, date: r.tx_date }); } catch (e: any) { throw new UserError(`Del ${i + 1}: ${e.message}`); }
      });
      // Jämför i kontoflöde (in/ut) och på öret, så att t.ex. utgift 1 500 + överföring −4 530 = utgift 6 030
      const want = ore(flow(r.type, Number(r.amount)));
      const got = a.parts.reduce((x: number, p: Obj) => x + ore(flow(p.type, p.amount)), 0);
      if (got !== want) {
        const each = a.parts.map((p: Obj) => `${kr(p.amount)} (${TYPE_LABEL[p.type].toLowerCase()})`).join(' + ');
        throw new UserError(`Delarnas summa (${kr(flow(r.type, got / 100))}) matchar inte originalbeloppet (${kr(Number(r.amount))}), räknat som ${TYPE_LABEL[r.type].toLowerCase()}. ` +
          `Skillnad: ${kr(Math.abs(want - got) / 100)} kr. Delar: ${each}. Tecken: utgift/sparande positivt = pengar ut, överföring negativt = pengar ut, inkomst positivt = in.`);
      }
      const ids = await newIds(c, a.parts.length);
      const base: Obj = { ...(r.extra || {}) };
      for (const k of ['split_into', 'transfer_pair_id', 'from_account', 'to_account']) delete base[k];
      const parts = a.parts.map((p: Obj, i: number) => ({
        user_id: c.uid, id: ids[i], type: p.type, amount: p.amount, category: p.category,
        description: p.description != null ? String(p.description).trim() : r.description,
        tx_date: r.tx_date, month: r.month, account: r.account, source: r.source,
        // hash och import_id följer med: då räknas originalet som redan importerat, och "Ångra import" tar även delarna
        import_id: r.import_id ?? null, hash: r.hash ?? null,
        // Ingen butiksnyckel på delarna — annars skulle regler och "samma butik" skriva över deras kategorier
        mkey: null,
        extra: { ...base, parent_id: Number(r.id), split_index: i + 1, split_of: a.parts.length, ...(r.mkey ? { split_mkey: r.mkey } : {}), via: 'mcp' },
        deleted: false,
      }));
      const out = { original: pub(txView(r, s)), parts: parts.map((p: Obj) => pub(txView(p, s))) };
      if (a.dry_run) return { dry_run: true, ...out, note: 'Inget sparat. Kör igen utan dry_run för att dela upp.' };
      await must(c.db.from('transactions').insert(parts));
      await must(c.db.from('transactions').update({ deleted: true, extra: { ...(r.extra || {}), split_into: ids } }).eq('user_id', c.uid).eq('id', r.id));
      // En länkad överföring tappar sin motpart när originalet försvinner
      if (r.extra?.transfer_pair_id) await unlinkPair(c, Number(r.extra.transfer_pair_id));
      return { ...out, note: 'Originalet tas bort och delarna läggs till på alla enheter vid nästa synk.' };
    },
  },
];

class UserError extends Error {}
// Svenska mobilnummer förekommer både som 07… och 467…; Swish företag 123…; övrigt räknas som kontonummer
const numberKind = (n: string) => (/^(467\d{8}|07\d{8})$/.test(n) ? 'mobil' : /^123\d{7}$/.test(n) ? 'swish_foretag' : 'konto');
function numberVariants(n: string) {
  const v = new Set([n]);
  if (/^467\d{8}$/.test(n)) v.add('0' + n.slice(2));
  if (/^07\d{8}$/.test(n)) v.add('46' + n.slice(1));
  return [...v];
}
// Nummer i transaktionernas beskrivningar med antal och summor (pengar ut/in)
async function numberUsage(c: Ctx) {
  const rows = await fetchAll(() => uq(c, 'transactions', 'type,amount,description').eq('deleted', false).order('id', { ascending: true }));
  const by: Obj = {};
  for (const r of rows) {
    const n = digits(r.description); if (!n) continue;
    const o = (by[n] ||= { transactions: 0, out: 0, in: 0 }); const f = flow(r.type, Number(r.amount));
    o.transactions++; if (f < 0) o.out -= f; else o.in += f;
  }
  return by;
}
// Antal transaktioner per typ och kategori
async function categoryUsage(c: Ctx) {
  const rows = await fetchAll(() => uq(c, 'transactions', 'type,category').eq('deleted', false).order('id', { ascending: true }));
  const n: Obj = {}; for (const r of rows) { const t = (n[r.type] ||= {}); t[r.category] = (t[r.category] || 0) + 1; }
  return n;
}
// Kategorier som används i transaktioner men saknas i inställningarna
function orphans(s: Obj, usage: Obj) {
  const out: Obj = {};
  for (const [type, key] of Object.entries(CAT_KEY)) {
    const list: Obj[] = Object.entries(usage[type] || {}).filter(([name]) => !s[key as string].includes(name)).map(([name, count]) => ({ name, count }));
    if (list.length) out[type] = list.sort((x, y) => y.count - x.count || x.name.localeCompare(y.name, 'sv'));
  }
  return out;
}
function catName(v: any) {
  const n = String(v ?? '').trim();
  if (!n) throw new UserError('Kategorin måste ha ett namn');
  if (n.length > 60) throw new UserError('Kategorinamnet får vara högst 60 tecken');
  return n;
}
// Flytta kategorier till en annan: transaktioner, budget och grupper (utgifter) samt inlärda regler.
// rename = målet är ett nytt namn som tar den gamlas plats i listan; annars (merge) tas de gamla bort.
async function moveCategories(c: Ctx, type: string, from: string[], to: string, rename: boolean, dry: boolean) {
  const key = CAT_KEY[type];
  const s = await loadState(c, [key, 'cat_budgets', 'cat_groups', 'merchant_rules']);
  const usage = (await categoryUsage(c))[type] || {};
  for (const f of from) if (!s[key].includes(f) && !usage[f]) throw new UserError(`Okänd kategori "${f}" för ${TYPE_LABEL[type].toLowerCase()} — den finns varken i inställningarna eller i några transaktioner`);
  const txCount = from.reduce((x, f) => x + (usage[f] || 0), 0);
  const cats = rename
    ? (s[key].includes(from[0]) ? s[key].map((x: string) => (x === from[0] ? to : x)) : [...s[key], to])
    : s[key].filter((x: string) => !from.includes(x));
  const B = { ...(s.cat_budgets || {}) }, budgetMoved: Obj = {};
  let groups = s.cat_groups;
  if (type === 'expense') {
    for (const f of from) if (B[f] != null) { budgetMoved[f] = +B[f]; B[to] = (+B[to] || 0) + +B[f]; delete B[f]; }
    groups = (s.cat_groups || []).map((g: Obj) => ({ ...g, cats: [...new Set((g.cats || []).map((x: string) => (from.includes(x) ? to : x)))] }));
  }
  const rules = { ...s.merchant_rules }, ruleIds: string[] = [];
  for (const [id, v] of Object.entries(rules as Obj)) if (v.type === type && from.includes(v.cat)) { rules[id] = { ...v, cat: to, t: Date.now() }; ruleIds.push(id); }
  const res: Obj = { type, from, to, transactions: txCount, budgets_moved: budgetMoved, rules_updated: ruleIds, categories_after: cats };
  if (type === 'expense' && Object.keys(budgetMoved).length) res.budget_after = B[to];
  if (dry) return { dry_run: true, ...res, note: 'Inget sparat.' };
  if (txCount) await must(c.db.from('transactions').update({ category: to }).eq('user_id', c.uid).eq('type', type).eq('deleted', false).in('category', from));
  await saveState(c, key, cats);
  if (Object.keys(budgetMoved).length) await saveState(c, 'cat_budgets', B);
  if (type === 'expense' && JSON.stringify(groups) !== JSON.stringify(s.cat_groups)) await saveState(c, 'cat_groups', groups);
  if (ruleIds.length) await saveState(c, 'merchant_rules', rules);
  return { ...res, note: 'Ändringarna syns på alla enheter vid nästa synk.' };
}
// Regel-id = butiksnyckeln "mönster|riktning". Utan riktning godtas mönstret om det bara finns en regel för det.
function findRule(rules: Obj, id: string, mustExist = true) {
  if (rules[id]) return id;
  const cand = Object.keys(rules).filter((k) => k.split('|')[0] === id);
  if (cand.length === 1) return cand[0];
  if (cand.length > 1) throw new UserError(`"${id}" matchar flera regler: ${cand.join(', ')}. Ange hela id:t.`);
  if (mustExist) throw new UserError(`Hittar ingen regel "${id}". Regel-id har formen mönster|ut eller mönster|in, t.ex. "#51960273264|ut" — se list_rules.`);
  return null;
}
async function mkeyHits(c: Ctx) {
  const rows = await fetchAll(() => uq(c, 'transactions', 'mkey').eq('deleted', false).order('id', { ascending: true }));
  const n: Obj = {}; for (const r of rows) if (r.mkey) n[r.mkey] = (n[r.mkey] || 0) + 1;
  return n;
}
// Före/efter för de fält som ändras (databaskolumner med appens namn)
const FIELD: Obj = { tx_date: 'date' };
function rowDiff(r: Obj, patch: Obj) {
  const before: Obj = {}, after: Obj = {};
  for (const [k, v] of Object.entries(patch)) {
    const old = k === 'amount' ? Number(r[k]) : r[k];
    if (JSON.stringify(old) === JSON.stringify(v)) continue;
    before[FIELD[k] || k] = old; after[FIELD[k] || k] = v;
  }
  return { before, after };
}
// Regel som den visas för AI:n; id = butiksnyckeln (mönster|riktning)
function ruleView(id: string, v: Obj) {
  const [pattern, dir] = id.split('|');
  return { id, pattern, direction: dir === 'in' ? 'in' : 'ut', type: v?.type ?? null, category: v?.cat ?? null,
    ...(v?.created ? { created: new Date(v.created).toISOString() } : {}), ...(v?.t ? { updated: new Date(v.t).toISOString() } : {}) };
}
// from_account/to_account: konto i appen sparas som dess id, annat (t.ex. ett kontonummer) som fritext
function trfSides(s: Obj, a: Obj, extra: Obj) {
  if ((a.from_account != null || a.to_account != null) && a.type && a.type !== 'transfer') throw new UserError('from_account/to_account gäller bara överföringar (type: transfer)');
  for (const k of ['from_account', 'to_account']) {
    if (a[k] == null) continue;
    const v = String(a[k]).trim();
    if (v) extra[k] = accountId(s, v) ?? v; else delete extra[k];
  }
  return extra;
}
const dayDiff = (a: string, b: string) => Math.abs(Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 864e5;
const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const unknownAccount = (s: Obj, v: string) => `Okänt konto "${v}". Finns: ${s.accounts.map((x: Obj) => x.name).join(', ')}`;
async function unlinkPair(c: Ctx, id: number) {
  const rows = await must<Obj[]>(uq(c, 'transactions', 'id,extra').eq('id', id));
  if (!rows[0]?.extra?.transfer_pair_id) return;
  const { transfer_pair_id, ...extra } = rows[0].extra;
  await must(c.db.from('transactions').update({ extra }).eq('user_id', c.uid).eq('id', id));
}
// Taggar: tags ersätter, add_tags/remove_tags ändrar (unika, i ordning)
function nextTags(cur: any, a: Obj) {
  const clean = (l: any) => (Array.isArray(l) ? l : []).map((x: any) => String(x).trim()).filter(Boolean);
  let t = a.tags ? clean(a.tags) : clean(cur);
  for (const x of clean(a.add_tags)) if (!t.some((y: string) => y.toLowerCase() === x.toLowerCase())) t.push(x);
  const rm = clean(a.remove_tags).map((x: string) => x.toLowerCase());
  return [...new Set(t.filter((x: string) => !rm.includes(x.toLowerCase())))];
}
function checkTx(s: Obj, t: Obj, keepCat = false) {
  if (!TYPES.includes(t.type)) throw new UserError(`Ogiltig typ "${t.type}"`);
  if (typeof t.amount !== 'number' || !isFinite(t.amount) || t.amount === 0) throw new UserError('Ange ett belopp skilt från 0');
  if (!validDate(t.date)) throw new UserError(`Ogiltigt datum "${t.date}" (YYYY-MM-DD)`);
  const cats = s[CAT_KEY[t.type]];
  if (!keepCat && !cats.includes(t.category)) throw new UserError(`Kategorin "${t.category}" finns inte för ${TYPE_LABEL[t.type].toLowerCase()}. Finns: ${cats.join(', ')}`);
}

// Enkel kontroll av argument mot schemat (typer, enum, mönster, obligatoriska fält)
function validate(schema: Obj, v: any, path = 'argument'): string | null {
  if (schema.anyOf) return schema.anyOf.some((s: Obj) => !validate(s, v, path)) ? null : `${path}: fel typ`;
  const t = schema.type;
  if (t === 'object') {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return `${path}: ska vara ett objekt`;
    for (const k of schema.required || []) if (v[k] === undefined) return `${k} saknas`;
    for (const [k, x] of Object.entries(v)) {
      const p = schema.properties?.[k] || (typeof schema.additionalProperties === 'object' ? schema.additionalProperties : null);
      if (!p) { if (schema.properties && x !== undefined) return `okänt fält "${k}"`; continue; }
      if (x === null || x === undefined) continue;
      const e = validate(p, x, k); if (e) return e;
    }
    return null;
  }
  if (t === 'array') {
    if (!Array.isArray(v)) return `${path}: ska vara en lista`;
    if (schema.minItems && v.length < schema.minItems) return `${path}: minst ${schema.minItems}`;
    if (schema.maxItems && v.length > schema.maxItems) return `${path}: högst ${schema.maxItems}`;
    for (const x of v) { const e = validate(schema.items || {}, x, path); if (e) return e; }
    return null;
  }
  if (t === 'string' && typeof v !== 'string') return `${path}: ska vara text`;
  if (t === 'number' && (typeof v !== 'number' || !isFinite(v))) return `${path}: ska vara ett tal`;
  if (t === 'integer' && !Number.isInteger(v)) return `${path}: ska vara ett heltal`;
  if (t === 'boolean' && typeof v !== 'boolean') return `${path}: ska vara true/false`;
  if (schema.enum && !schema.enum.includes(v)) return `${path}: ska vara en av ${schema.enum.join(', ')}`;
  if (schema.pattern && !new RegExp(schema.pattern).test(v)) return `${path}: fel format (${schema.description || schema.pattern})`;
  if (schema.minimum != null && v < schema.minimum) return `${path}: minst ${schema.minimum}`;
  if (schema.maximum != null && v > schema.maximum) return `${path}: högst ${schema.maximum}`;
  if (schema.pattern === S.date.pattern && !validDate(v)) return `${path}: ogiltigt datum`;
  return null;
}

// ── MCP / JSON-RPC ────────────────────────────────────────────────────
const INSTRUCTIONS = `Privatekonomi: användarens egna transaktioner, budget och förmögenhet (svenska kronor).
- Anropa get_settings först för kategorier, konton och aktuell löneperiod.
- "month" är en löneperiod (lön runt den 25:e startar nästa månads period), inte kalendermånad.
- Utgift/sparande: positivt belopp = pengar ut. Inkomst: positivt = in. Överföring (transfer) räknas inte som utgift; negativt = flyttat till eget konto.
- Använd summarize_transactions och get_month_summary för analys i stället för att hämta alla rader.
- Förmögenhet: get_net_worth visar tillgångar, skulder (lån) och netto. Lån med netted_in_assets är redan avdragna i en tillgång.
- Avanza: läs av Avanza och importera med import_avanza_snapshot (dry_run först, spara efter godkännande). get_investments visar innehav, risk, hävstång och ISK-skatt. Bara fakta, inga köp- eller säljråd. Servern kan inte handla eller flytta pengar hos Avanza.
- Städning: get_settings visar orphan_categories; slå ihop med merge_categories. Namnlösa Swish-nummer finns i list_contacts. Överföringar mellan egna konton paras med match_transfers.
- Förhandsgranska innan du ändrar: bulk_update_transactions (dry_run är standard), update_transaction/split_transaction/update_rule/merge_categories/rename_category med dry_run: true, match_transfers utan confirm. Visa resultatet och fråga användaren innan du sparar.
- Ändringar av regler går att ångra: update_transaction och delete_rule returnerar undo.`;

const rpcErr = (id: any, code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });

export async function handleRpc(msg: Obj, ctx: Ctx): Promise<Obj | null> {
  const id = msg?.id;
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return rpcErr(id ?? null, -32600, 'Invalid Request');
  if (id === undefined) return null; // notis (t.ex. notifications/initialized) — inget svar
  const tools = TOOLS.filter((t) => !t.write || ctx.scope === 'write');
  switch (msg.method) {
    case 'initialize': {
      const v = msg.params?.protocolVersion;
      return {
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: PROTOCOLS.includes(v) ? v : PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, title: 'Privatekonomi', version: SERVER_VERSION, icons: ICONS, websiteUrl: APP_URL },
          instructions: INSTRUCTIONS + (ctx.scope === 'read' ? '\n- Nyckeln har bara läsbehörighet.' : ''),
        },
      };
    }
    case 'ping': return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: tools.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations })) } };
    case 'tools/call': {
      const name = msg.params?.name, args = msg.params?.arguments ?? {};
      const tool = tools.find((t) => t.name === name);
      if (!tool) {
        if (TOOLS.some((t) => t.name === name)) return toolText(id, 'Den här nyckeln får bara läsa. Skapa en nyckel med "läsa och ändra" i appen.', true);
        return rpcErr(id, -32602, `Okänt verktyg: ${name}`);
      }
      const bad = validate(tool.inputSchema, args);
      if (bad) return toolText(id, 'Ogiltiga argument: ' + bad, true);
      try {
        const out = await tool.run(ctx, { ...args });
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(out) }] } };
      } catch (e: any) {
        if (!(e instanceof UserError)) console.error(`[mcp] ${name}:`, e);
        return toolText(id, e instanceof UserError ? e.message : 'Fel: ' + (e?.message || e), true);
      }
    }
    case 'resources/list': return { jsonrpc: '2.0', id, result: { resources: [] } };
    case 'prompts/list': return { jsonrpc: '2.0', id, result: { prompts: [] } };
    default: return rpcErr(id, -32601, `Okänd metod: ${msg.method}`);
  }
}
const toolText = (id: any, text: string, isError = false) => ({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError } });

// ── HTTP ──────────────────────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type, mcp-session-id, mcp-protocol-version, x-client-info, apikey',
  'Access-Control-Expose-Headers': 'mcp-session-id',
};
const json = (body: any, status = 200, extra: Obj = {}) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json', ...extra } });

export async function sha256hex(s: string) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
// Nyckeln kan skickas som "Authorization: Bearer pkm_…", i adressen (…/mcp/pkm_…) eller som ?key=pkm_…
// (Claude.ai:s egna anslutningar kan inte sätta egna headers, därför adressvarianten.)
export function tokenFrom(req: Request) {
  const re = /(pkm_[A-Za-z0-9_-]{30,})/;
  const auth = req.headers.get('authorization') || '';
  const url = new URL(req.url);
  return auth.match(re)?.[1] || url.pathname.match(re)?.[1] || url.searchParams.get('key')?.match(re)?.[1] || null;
}

export function createHandler(db: Db) {
  return async (req: Request): Promise<Response> => {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const token = tokenFrom(req);
    if (!token) return json({ error: 'Ange din MCP-nyckel (skapas i appen under Inställningar → AI-koppling)' }, 401);
    const hash = await sha256hex(token);
    const { data: rows, error } = await db.from('mcp_tokens').select('id,user_id,scope,expires_at').eq('token_hash', hash).limit(1);
    if (error) { console.error('[mcp] token lookup', error); return json({ error: 'Databasfel' }, 500); }
    const tok = rows?.[0];
    if (!tok) return json({ error: 'Ogiltig eller återkallad MCP-nyckel' }, 401);
    if (tok.expires_at && Date.parse(tok.expires_at) < Date.now()) return json({ error: 'MCP-nyckeln har gått ut – skapa en ny i appen (Inställningar → AI-koppling)' }, 401);
    if (req.method === 'GET') {
      // Ingen server-initierad ström; en webbläsare får en liten statussida
      if ((req.headers.get('accept') || '').includes('text/event-stream')) return new Response(null, { status: 405, headers: { ...CORS, Allow: 'POST' } });
      return json({ ok: true, server: SERVER_NAME, version: SERVER_VERSION, scope: tok.scope });
    }
    if (req.method === 'DELETE') return new Response(null, { status: 405, headers: { ...CORS, Allow: 'POST' } });
    if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

    let body: any;
    try { body = await req.json(); } catch { return json(rpcErr(null, -32700, 'Parse error'), 400); }
    const touch = Promise.resolve(db.from('mcp_tokens').update({ last_used_at: new Date().toISOString() }).eq('id', tok.id)).catch(() => {});
    const ctx: Ctx = { db, uid: tok.user_id, scope: tok.scope === 'write' ? 'write' : 'read' };
    if (Array.isArray(body) && !body.length) return json(rpcErr(null, -32600, 'Invalid Request'), 400);
    const msgs = Array.isArray(body) ? body : [body];
    const out = (await Promise.all(msgs.map((m) => handleRpc(m, ctx)))).filter(Boolean);
    await touch;
    if (!out.length) return new Response(null, { status: 202, headers: CORS });
    return json(Array.isArray(body) ? out : out[0]);
  };
}

// ── Start (Supabase Edge Function) ────────────────────────────────────
// Nya projekt har SUPABASE_SECRET_KEYS (JSON), äldre SUPABASE_SERVICE_ROLE_KEY — båda sätts automatiskt
function secretKey() {
  try {
    const keys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}');
    if (keys.default) return keys.default as string;
  } catch { /* äldre projekt */ }
  return Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
}

Deno.serve(createHandler(createClient(Deno.env.get('SUPABASE_URL')!, secretKey(), {
  auth: { persistSession: false, autoRefreshToken: false },
})));
