// Supabase Edge Function: MCP-server för Privatekonomi — allt i en fil, så att den går att
// klistra in direkt i Supabase-panelen. Driftsätt: supabase functions deploy mcp --no-verify-jwt
import { createClient } from 'npm:@supabase/supabase-js@2';

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
type Ctx = { db: Db; uid: string; scope: 'read' | 'write' };

export const SERVER_NAME = 'privatekonomi';
export const SERVER_VERSION = '1.0.0';
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
  goal: 700000, salary: 0, owner_name: '',
};
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
  return new Set([D(1, 1), D(1, 6), D(5, 1), D(6, 6), D(12, 24), D(12, 25), D(12, 26), D(12, 31), off(-3), off(1), off(39), off(49), off(50), mid, allS].map(ymd));
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
  const rows = await must<Obj[]>(uq(c, 'user_state', 'key,value').eq('deleted', false).in('key', keys));
  const s: Obj = {};
  for (const k of keys) { const r = rows.find((x) => x.key === k); s[k] = r && r.value != null ? r.value : structuredClone(DEF[k]); }
  if (!Array.isArray(s.accounts) || !s.accounts.length) s.accounts = structuredClone(DEF.accounts);
  if (keys.includes('goal') && !(+s.goal > 0)) s.goal = DEF.goal;
  return s;
}
async function saveState(c: Ctx, key: string, value: any) {
  await must(c.db.from('user_state').upsert({ user_id: c.uid, key, value, deleted: false }, { onConflict: 'user_id,key' }));
}
const SETTINGS = ['cats_exp', 'cats_inc', 'cats_sav', 'cats_trf', 'cats_nw', 'cat_groups', 'cat_budgets', 'accounts', 'goal', 'salary', 'pay_periods', 'contact_names', 'owner_name'];

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
const digits = (s: string) => { const t = String(s || '').trim(); return /^\+?\d[\d\s-]{5,}$/.test(t) ? t.replace(/\D/g, '') : null; };
const round = (n: number) => Math.round(n * 100) / 100;

// Hämta transaktioner: filter i databasen, fritext och belopp här (så att Swish-namn också matchar)
async function queryTxs(c: Ctx, f: Obj, s: Obj) {
  if (f.account) f = { ...f, account: accountId(s, f.account) ?? f.account };
  let rows = await fetchAll(() => txQuery(c, f));
  const contacts = s.contact_names || {};
  let txs = rows.map((r) => {
    const t: Obj = { id: Number(r.id), date: r.tx_date, month: r.month, type: r.type, amount: Number(r.amount), category: r.category, description: r.description };
    const n = digits(r.description); if (n && contacts[n]) t.contact = contacts[n];
    if (r.account) t.account = accountName(s, r.account);
    if (r.source) t.source = r.source;
    if (r.extra?.note) t.note = r.extra.note;
    t._mkey = r.mkey || null; t._acc = r.account || null;
    return t;
  });
  if (f.search) {
    const words = String(f.search).toLowerCase().split(/\s+/).filter(Boolean);
    txs = txs.filter((t) => { const h = [t.description, t.contact, t.category, t.note].join(' ').toLowerCase(); return words.every((w) => h.includes(w)); });
  }
  if (f.min_amount != null) txs = txs.filter((t) => t.amount >= f.min_amount);
  if (f.max_amount != null) txs = txs.filter((t) => t.amount <= f.max_amount);
  return txs;
}
const pub = (t: Obj) => { const { _mkey, _acc, ...rest } = t; return rest; };
function accountName(s: Obj, id: string) { return s.accounts.find((a: Obj) => a.id === id)?.name || id; }
function accountId(s: Obj, v: string) {
  const l = String(v).toLowerCase();
  return s.accounts.find((a: Obj) => a.id.toLowerCase() === l || String(a.name).toLowerCase() === l)?.id ?? null;
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
  min_amount: { type: 'number' },
  max_amount: { type: 'number' },
};

type Tool = { name: string; title: string; description: string; inputSchema: Obj; write?: boolean; annotations?: Obj; run: (c: Ctx, a: Obj) => Promise<any> };
const RO = { readOnlyHint: true, openWorldHint: false };

export const TOOLS: Tool[] = [
  {
    name: 'get_settings',
    title: 'Inställningar och kategorier',
    description: 'Hämtar kategorier per typ, budget per kategori, konton, kategorigrupper, förmögenhetsmål, lön, förmögenhetskategorier och aktuell löneperiod. Anropa först för att få exakta kategorinamn.',
    inputSchema: { type: 'object', properties: {} },
    annotations: RO,
    async run(c) {
      const s = await loadState(c, SETTINGS);
      const cur = periodForDate(today(), s.pay_periods);
      return {
        current_period: { month: cur, ...periodRange(cur, s.pay_periods) },
        categories: { expense: s.cats_exp, income: s.cats_inc, savings: s.cats_sav, transfer: s.cats_trf },
        category_groups: s.cat_groups,
        budgets: s.cat_budgets,
        accounts: s.accounts.map((a: Obj) => ({ id: a.id, name: a.name, kind: a.kind, ...(a.balance ? { balance: a.balance } : {}) })),
        net_worth_categories: s.cats_nw,
        net_worth_goal: +s.goal,
        salary: +s.salary || 0,
        owner_name: s.owner_name || undefined,
        conventions: 'expense/savings: positivt = pengar ut (negativt = retur). income: positivt = in. transfer: negativt = flyttat till eget konto, räknas inte som utgift. month = löneperiod.',
      };
    },
  },
  {
    name: 'list_transactions',
    title: 'Lista transaktioner',
    description: 'Söker transaktioner med filter (löneperiod, datum, typ, kategori, konto, fritext, belopp). Returnerar antal, summa och raderna (nyast först som standard).',
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
        group_by: { type: 'string', enum: ['category', 'month', 'merchant', 'account', 'type', 'category_month'], default: 'category' },
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
      for (const t of txs) {
        const k = key(t); const o = g.get(k) || { key: k, sum: 0, count: 0 };
        if (by === 'merchant' && !o.example) o.example = t.contact || t.description;
        o.sum += t.amount; o.count++; g.set(k, o);
      }
      const total = txs.reduce((x, t) => x + t.amount, 0);
      let groups: Obj[] = [...g.values()].map((o) => ({ ...o, sum: round(o.sum), avg: round(o.sum / o.count), share_pct: total ? Math.round((o.sum / total) * 1000) / 10 : 0 }));
      groups.sort(by === 'month' || by === 'category_month' ? (x, y) => x.key.localeCompare(y.key) : (x, y) => y.sum - x.sum);
      const months = new Set(txs.map((t) => t.month)).size;
      groups = groups.slice(0, Math.min(a.limit || 50, 500));
      return { group_by: by, transactions: txs.length, months, total: round(total), avg_per_month: months ? round(total / months) : 0, groups };
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
      return {
        month, ...range, in_progress: today() <= range.end && today() >= range.start,
        income: round(income), expense: round(expense), savings: round(savings),
        balance: round(income - expense - savings), savings_rate_pct: income > 0 ? Math.round((savings / income) * 100) : 0,
        moved_to_own_accounts: round(moved), balance_incl_moved: round(income - expense - savings + moved),
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
    description: 'Förmögenhet per månad (snapshots) uppdelat per tillgångskategori, med förändring mot föregående och framsteg mot målet.',
    inputSchema: { type: 'object', properties: { month_from: FILTERS.month_from, month_to: FILTERS.month_to } },
    annotations: RO,
    async run(c, a) {
      const s = await loadState(c, ['cats_nw', 'goal']);
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
      return { goal: +s.goal, latest: last ? { period: last.period, total: last.total, goal_progress_pct: Math.round((last.total / s.goal) * 1000) / 10, left_to_goal: round(s.goal - last.total) } : null, categories: s.cats_nw, snapshots: snaps };
    },
  },

  // ── Skrivande verktyg (kräver en nyckel med behörigheten "läsa och ändra") ──
  {
    name: 'add_transaction',
    title: 'Lägg till transaktion',
    description: 'Lägger till en transaktion. Löneperioden räknas ut från datumet. Kategorin måste finnas för typen (se get_settings). Belopp: utgift/sparande positivt = pengar ut; inkomst positivt = in; överföring negativt = flyttat ut.',
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
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async run(c, a) {
      const s = await loadState(c, ['accounts', 'pay_periods', ...Object.values(CAT_KEY)]);
      const date = a.date || today();
      checkTx(s, { ...a, date });
      const acc = a.account ? accountId(s, a.account) : s.accounts[0].id;
      if (!acc) throw new UserError(`Okänt konto "${a.account}". Finns: ${s.accounts.map((x: Obj) => x.name).join(', ')}`);
      // Samma id-schema som appen (millisekunder), alltid större än befintliga
      const top = await must<Obj[]>(uq(c, 'transactions', 'id').order('id', { ascending: false }).limit(1));
      const id = Math.max(Date.now(), (top[0] ? Number(top[0].id) : 0) + 1);
      const row = {
        user_id: c.uid, id, type: a.type, amount: a.amount, description: String(a.description || '').trim(), category: a.category,
        tx_date: date, month: periodForDate(date, s.pay_periods), account: acc, source: 'manual', extra: { via: 'mcp' }, deleted: false,
      };
      await must(c.db.from('transactions').insert(row));
      return { created: { id, date, month: row.month, type: row.type, amount: row.amount, category: row.category, description: row.description, account: accountName(s, acc) }, note: 'Syns i appen vid nästa synk.' };
    },
  },
  {
    name: 'update_transaction',
    title: 'Ändra transaktion',
    description: 'Ändrar en transaktion (id från list_transactions). Ändras typ/kategori på en importerad rad lärs regeln in för butiken, som i appen. apply_to_same_merchant ändrar även övriga rader från samma butik.',
    write: true,
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'integer' },
        type: S.type, category: { type: 'string' }, amount: { type: 'number' },
        description: { type: 'string' }, date: S.date, account: { type: 'string' },
        apply_to_same_merchant: { type: 'boolean', default: false },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    async run(c, a) {
      const s = await loadState(c, ['accounts', 'pay_periods', 'merchant_rules', ...Object.values(CAT_KEY)]);
      const rows = await must<Obj[]>(uq(c, 'transactions', TX_COLS).eq('id', a.id).eq('deleted', false));
      const r = rows[0]; if (!r) throw new UserError(`Hittar ingen transaktion med id ${a.id}`);
      const next: Obj = { type: a.type ?? r.type, category: a.category ?? r.category, amount: a.amount ?? Number(r.amount), date: a.date ?? r.tx_date };
      if (a.type && !a.category && a.type !== r.type) throw new UserError('Ange även category när du byter typ');
      checkTx(s, next);
      const patch: Obj = { type: next.type, category: next.category, amount: next.amount, tx_date: next.date };
      if (a.date) patch.month = periodForDate(a.date, s.pay_periods);
      if (a.description != null) patch.description = String(a.description).trim();
      if (a.account) { const acc = accountId(s, a.account); if (!acc) throw new UserError(`Okänt konto "${a.account}"`); patch.account = acc; }
      await must(c.db.from('transactions').update(patch).eq('user_id', c.uid).eq('id', a.id));
      const out: Obj = { updated: { id: a.id, ...patch } };
      const changedCat = next.category !== r.category || next.type !== r.type;
      if (r.mkey && changedCat) {
        s.merchant_rules[r.mkey] = { type: next.type, cat: next.category, t: Date.now() };
        await saveState(c, 'merchant_rules', s.merchant_rules);
        out.learned_rule = r.mkey;
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
      const done = await must<Obj[]>(c.db.from('transactions').update({ deleted: true }).eq('user_id', c.uid).eq('deleted', false).in('id', a.ids).select('id'));
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
      const total = Object.values(amounts).reduce((x: number, v: any) => x + (+v || 0), 0);
      await must(c.db.from('net_worth_snapshots').upsert({ user_id: c.uid, period: a.period, total, amounts, deleted: false }, { onConflict: 'user_id,period' }));
      return { period: a.period, total, amounts };
    },
  },
];

class UserError extends Error {}
function checkTx(s: Obj, t: Obj) {
  if (!TYPES.includes(t.type)) throw new UserError(`Ogiltig typ "${t.type}"`);
  if (typeof t.amount !== 'number' || !isFinite(t.amount) || t.amount === 0) throw new UserError('Ange ett belopp skilt från 0');
  if (!validDate(t.date)) throw new UserError(`Ogiltigt datum "${t.date}" (YYYY-MM-DD)`);
  const cats = s[CAT_KEY[t.type]];
  if (!cats.includes(t.category)) throw new UserError(`Kategorin "${t.category}" finns inte för ${TYPE_LABEL[t.type].toLowerCase()}. Finns: ${cats.join(', ')}`);
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
- Fråga användaren innan du ändrar eller tar bort något.`;

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
    const { data: rows, error } = await db.from('mcp_tokens').select('id,user_id,scope').eq('token_hash', hash).limit(1);
    if (error) { console.error('[mcp] token lookup', error); return json({ error: 'Databasfel' }, 500); }
    const tok = rows?.[0];
    if (!tok) return json({ error: 'Ogiltig eller återkallad MCP-nyckel' }, 401);
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
