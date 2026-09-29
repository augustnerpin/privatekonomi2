// Avanza: ögonblicksbilder (avanza_snapshot) av konton, innehav, kontanter, månadssparande, utdelningar och väntande order.
// Bilden läses av i Avanza (t.ex. av Claude i en Chrome-session) och importeras hit. Den här koden LÄSER bara:
// ingenting här anropar Avanza, och appen kan aldrig handla, föra över pengar eller ändra något där.
//
// I förmögenheten är Avanza fortfarande ETT konto (Avanza ISK). Importen sätter bara dess saldo till summan av
// underkontona; underkontona visas som detaljer. Flyttar mellan underkonton ändrar därför varken summan, sparandet
// (som bara kommer från bankens transaktioner) eller avkastningen.
// Används av MCP (import_avanza_snapshot, get_investments, get_net_worth) och bank-funktionen (appen).
// deno-lint-ignore-file no-explicit-any
import { type Obj, addBankDays } from './finance.ts';
import { valueAt } from './networth.ts';
import { saveMerged, type StateIo } from './merge.ts';

export const ACCOUNT_TYPES = ['ISK', 'KF', 'sparkonto', 'depå'];
export const HOLDING_KINDS = ['aktie', 'fond', 'ETF'];
export const AVANZA_ACCOUNT = 'avanza_isk'; // kontot i appen (invest_settings.avanza_account ändrar)
export const SNAP_NEAR_DAYS = 5; // en bild inom så många dagar från periodgränsen tar bort varningen om avkastningen

const num = { type: 'number' }, numOrNull = { anyOf: [{ type: 'number' }, { type: 'null' }] };
export const SNAPSHOT_SCHEMA: Obj = {
  type: 'object',
  required: ['date', 'total_value', 'accounts'],
  description: 'avanza_snapshot: en avläsning av Avanza. Belopp i kronor.',
  properties: {
    date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}([T ]\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?(Z|[+-]\\d{2}:?\\d{2})?)?$', description: 'Datum och tid för avläsningen, t.ex. 2026-09-29T08:15:00+02:00' },
    total_value: { ...num, description: 'Totalvärdet som Avanza visar (summan av konton som inte är dolda). Används som kontroll.' },
    accounts: {
      type: 'array', minItems: 1,
      items: {
        type: 'object', required: ['name', 'type', 'value'],
        properties: {
          name: { type: 'string' }, type: { type: 'string', enum: ACCOUNT_TYPES },
          value: { ...num, description: 'Kontots värde inklusive kontanter' },
          cash: { ...num, description: 'Kontanter på kontot, inklusive reserverade' },
          reserved_cash: { ...num, description: 'Del av kontanterna som är reserverad för väntande order' },
          since_purchase_kr: { ...numOrNull, description: 'Utveckling sedan köp i kronor (Avanzas siffra)' },
          ytd_pct: { ...numOrNull, description: 'Utveckling i år i procent (Avanzas siffra)' },
          hidden: { type: 'boolean', description: 'Dolt konto i Avanza (räknas inte in i totalvärdet)' },
          funded_by_loan: { type: 'boolean', description: 'Sätts av användaren: kontot är finansierat med lånade pengar' },
        },
      },
    },
    holdings: {
      type: 'array',
      items: {
        type: 'object', required: ['account', 'name', 'kind', 'value'],
        properties: {
          account: { type: 'string', description: 'Kontots namn (samma som i accounts)' }, name: { type: 'string' },
          kind: { type: 'string', enum: HOLDING_KINDS }, quantity: numOrNull, value: num, gain_kr: numOrNull, gain_pct: numOrNull,
        },
      },
    },
    monthly_savings: {
      type: 'array',
      items: {
        type: 'object', required: ['day', 'amount', 'from', 'to_account'],
        properties: {
          day: { type: 'integer', minimum: 1, maximum: 31 }, amount: num,
          from: { type: 'string', description: '"bank" (autogiro från banken) eller namnet på ett Avanza-konto (intern flytt)' },
          to_account: { type: 'string' },
        },
      },
    },
    dividends: { type: 'object', properties: { paid_total: numOrNull, pending: numOrNull, ytd: numOrNull } },
    pending_orders: {
      type: 'array',
      items: { type: 'object', required: ['account', 'name', 'amount'], properties: { account: { type: 'string' }, name: { type: 'string' }, amount: num, expected_date: { anyOf: [{ type: 'string' }, { type: 'null' }] } } },
    },
  },
};

// ── Hjälp ─────────────────────────────────────────────────────────────
const r2 = (n: number) => Math.round(n * 100) / 100;
const r0 = (n: number) => Math.round(n);
const sum = (l: number[]) => r2(l.reduce((s, x) => s + x, 0));
const low = (s: unknown) => String(s ?? '').trim().toLowerCase();
export const kr = (n: number) => new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 0 }).format(Math.round(n)).replace(/[  ]/g, ' ').replace(/−/g, '-') + ' kr';
const signed = (n: number) => (n >= 0 ? '+' : '−') + kr(Math.abs(n));
const pct1 = (n: number) => String(Math.round(n * 10) / 10).replace('.', ',') + ' %';
const dayDiff = (a: string, b: string) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5);
const slug = (s: string) => low(s).replace(/[åä]/g, 'a').replace(/ö/g, 'o').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

// Datum i Sverige för avläsningen (tid med tidszon räknas om; bara datum eller lokal tid används som den är)
export function snapDate(date: string) {
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(date) || date.length <= 10) return date.slice(0, 10);
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm' }).format(new Date(date));
}
function takenAt(date: string) {
  if (date.length <= 10) return date + 'T12:00:00Z';
  const d = new Date(/(Z|[+-]\d{2}:?\d{2})$/.test(date) ? date : date.replace(' ', 'T') + '+02:00');
  return isNaN(+d) ? date.slice(0, 10) + 'T12:00:00Z' : d.toISOString();
}

// ── Validering och normalisering ───────────────────────────────────────
function checkShape(schema: Obj, v: any, path: string, out: string[]) {
  if (v === null || v === undefined) return;
  if (schema.anyOf) { const ok = schema.anyOf.some((s: Obj) => { const e: string[] = []; checkShape(s, v, path, e); return !e.length && (s.type !== 'null' || v === null); }); if (!ok) out.push(`${path}: fel typ`); return; }
  const t = schema.type;
  if (t === 'null') { if (v !== null) out.push(`${path}: ska vara null`); return; }
  if (t === 'object') {
    if (typeof v !== 'object' || Array.isArray(v)) { out.push(`${path}: ska vara ett objekt`); return; }
    for (const k of schema.required || []) if (v[k] === undefined || v[k] === null) out.push(`${path}.${k} saknas`);
    for (const [k, x] of Object.entries(v)) { const p = schema.properties?.[k]; if (!p) out.push(`${path}: okänt fält "${k}"`); else checkShape(p, x, `${path}.${k}`, out); }
    return;
  }
  if (t === 'array') { if (!Array.isArray(v)) { out.push(`${path}: ska vara en lista`); return; } if (schema.minItems && v.length < schema.minItems) out.push(`${path}: minst ${schema.minItems}`); v.forEach((x, i) => checkShape(schema.items, x, `${path}[${i}]`, out)); return; }
  if (t === 'string' && typeof v !== 'string') out.push(`${path}: ska vara text`);
  if (t === 'number' && (typeof v !== 'number' || !isFinite(v))) out.push(`${path}: ska vara ett tal`);
  if (t === 'integer' && !Number.isInteger(v)) out.push(`${path}: ska vara ett heltal`);
  if (t === 'boolean' && typeof v !== 'boolean') out.push(`${path}: ska vara true/false`);
  if (schema.enum && !schema.enum.includes(v)) out.push(`${path}: ska vara en av ${schema.enum.join(', ')}`);
  if (schema.pattern && typeof v === 'string' && !new RegExp(schema.pattern).test(v)) out.push(`${path}: fel format`);
  if (schema.minimum != null && typeof v === 'number' && v < schema.minimum) out.push(`${path}: minst ${schema.minimum}`);
  if (schema.maximum != null && typeof v === 'number' && v > schema.maximum) out.push(`${path}: högst ${schema.maximum}`);
}
// Fel i bilden (tom lista = giltig): schemat plus att namnen hänger ihop och att beloppen är rimliga
export function validateSnapshot(s: any) {
  const out: string[] = [];
  checkShape(SNAPSHOT_SCHEMA, s, 'snapshot', out);
  if (out.length) return out;
  const d = snapDate(s.date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || isNaN(Date.parse(d + 'T00:00:00Z'))) out.push(`Ogiltigt datum "${s.date}"`);
  const names = s.accounts.map((a: Obj) => low(a.name));
  names.forEach((n: string, i: number) => { if (names.indexOf(n) !== i) out.push(`Kontot "${s.accounts[i].name}" finns två gånger`); });
  for (const a of s.accounts) {
    if ((a.reserved_cash || 0) < 0 || (a.cash || 0) < 0) out.push(`${a.name}: kontanter kan inte vara negativa`);
    if ((a.reserved_cash || 0) > (a.cash || 0) + 0.5) out.push(`${a.name}: reserverat (${a.reserved_cash}) är mer än kontanterna (${a.cash || 0})`);
  }
  const has = (n: string) => names.includes(low(n));
  (s.holdings || []).forEach((h: Obj) => { if (!has(h.account)) out.push(`Innehavet "${h.name}" ligger på okänt konto "${h.account}"`); });
  (s.monthly_savings || []).forEach((m: Obj) => { if (!has(m.to_account)) out.push(`Månadssparande till okänt konto "${m.to_account}"`); if (!(m.amount > 0)) out.push(`Månadssparande till ${m.to_account}: beloppet ska vara större än 0`); });
  (s.pending_orders || []).forEach((o: Obj) => { if (!has(o.account)) out.push(`Ordern "${o.name}" ligger på okänt konto "${o.account}"`); });
  return out;
}
// Samma bild ger alltid samma form (och hash): standardvärden, avrundning och sortering
export function normalizeSnapshot(s: Obj): Obj {
  const n = (x: any) => (x == null || x === '' ? null : r2(Number(x)));
  const acc = (name: string) => s.accounts.find((a: Obj) => low(a.name) === low(name))?.name ?? name;
  const by = (...k: string[]) => (a: Obj, b: Obj) => { for (const x of k) { const c = String(a[x] ?? '').localeCompare(String(b[x] ?? ''), 'sv'); if (c) return c; } return 0; };
  const d = s.dividends || {};
  return {
    date: String(s.date), total_value: r2(Number(s.total_value)),
    accounts: s.accounts.map((a: Obj) => ({ name: String(a.name).trim(), type: a.type, value: r2(+a.value), cash: r2(+(a.cash || 0)), reserved_cash: r2(+(a.reserved_cash || 0)),
      since_purchase_kr: n(a.since_purchase_kr), ytd_pct: n(a.ytd_pct), hidden: !!a.hidden, ...(a.funded_by_loan != null ? { funded_by_loan: !!a.funded_by_loan } : {}) })).sort(by('name')),
    holdings: (s.holdings || []).map((h: Obj) => ({ account: acc(h.account), name: String(h.name).trim(), kind: h.kind, quantity: n(h.quantity), value: r2(+h.value), gain_kr: n(h.gain_kr), gain_pct: n(h.gain_pct) })).sort(by('account', 'name')),
    monthly_savings: (s.monthly_savings || []).map((m: Obj) => ({ day: +m.day, amount: r2(+m.amount), from: String(m.from).trim(), to_account: acc(m.to_account) })).sort((a: Obj, b: Obj) => a.day - b.day || by('to_account', 'from')(a, b)),
    dividends: { paid_total: n(d.paid_total), pending: n(d.pending), ytd: n(d.ytd) },
    pending_orders: (s.pending_orders || []).map((o: Obj) => ({ account: acc(o.account), name: String(o.name).trim(), amount: r2(+o.amount), expected_date: o.expected_date || null })).sort(by('account', 'name')),
  };
}
function canon(v: any): string {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  return JSON.stringify(v);
}
export async function snapshotHash(s: Obj) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canon(s)));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

// Summakontroll: kontona som inte är dolda ska bli Avanzas totalvärde (±1 kr)
export function sumCheck(s: Obj) {
  const visible = sum(s.accounts.filter((a: Obj) => !a.hidden).map((a: Obj) => a.value));
  const diff = r2(visible - s.total_value);
  return { ok: Math.abs(diff) < 1, accounts_sum: visible, total_value: s.total_value, diff,
    text: Math.abs(diff) < 1 ? `Summan av kontona (${kr(visible)}) stämmer med totalvärdet` : `Summan av kontona är ${kr(visible)} men totalvärdet ${kr(s.total_value)} – skillnad ${signed(diff)}. Inget sparas.` };
}
// Saldot på Avanza ISK: alla konton som inte är dolda, eller alla om användaren valt att räkna med de dolda
export const countedAccounts = (s: Obj, st: Obj) => s.accounts.filter((a: Obj) => st.include_hidden || !a.hidden);
export const balanceFor = (s: Obj, st: Obj) => sum(countedAccounts(s, st).map((a: Obj) => a.value));
// Lånefinansierat: flaggan i bilden, annars användarens lista över kontonamn (invest_settings.funded_by_loan)
export const fundedByLoan = (a: Obj, st: Obj) => (a.funded_by_loan != null ? !!a.funded_by_loan : (st.funded_by_loan || []).some((n: string) => low(n) === low(a.name)));
// Är sparandet från banken (autogiro) eller en flytt mellan Avanza-konton?
export const isInternal = (m: Obj, s: Obj) => s.accounts.some((a: Obj) => low(a.name) === low(m.from));

// ── Förväntade transaktioner från månadssparandet (autogiro från banken) ──
// Bara `from` = bank blir förväntade banktransaktioner. Posterna märks source: 'avanza' och ersätts vid nästa import;
// användarens egna poster och ett avstängt autogiro (enabled: false) behålls.
export function autogiroExpected(s: Obj, current: Obj[], o: { fromAccount?: string | null; graceBankDays?: number } = {}) {
  const want: Obj[] = [];
  for (const m of s.monthly_savings || []) {
    if (isInternal(m, s)) continue;
    let id = `avz_${slug(m.to_account)}_${m.day}`;
    if (want.some((w) => w.id === id)) id += '_' + r0(m.amount);
    want.push({ id, name: `Autogiro ${kr(m.amount)} till ${m.to_account}`, type: 'savings', types: ['savings', 'transfer'], match: 'avanza', due_day: m.day,
      grace_bank_days: o.graceBankDays ?? 3, amount: m.amount, to_account: m.to_account, ...(o.fromAccount ? { from_account: o.fromAccount } : {}), source: 'avanza', enabled: true });
  }
  const byId = Object.fromEntries(want.map((w) => [w.id, w]));
  const out = (current || []).map((e) => (e?.source !== 'avanza' ? e : byId[e.id] ? { ...byId[e.id], enabled: e.enabled !== false } : null)).filter(Boolean) as Obj[];
  for (const w of want) if (!out.some((e) => e.id === w.id)) out.push(w);
  return out;
}

// ── Investeringsvy ─────────────────────────────────────────────────────
// p.snaps: [{snap_date, taken_at, data}] (vilken ordning som helst). p.txs: sparandetransaktioner {type, category, amount, tx_date}.
export type ViewInput = { snaps: Obj[]; settings: Obj; loans?: Obj[]; accounts?: Obj[]; balances?: Obj[]; txs?: Obj[]; date?: string | null; investCats?: string[] };
const order = (l: Obj[]) => [...l].sort((a, b) => a.snap_date.localeCompare(b.snap_date) || String(a.taken_at).localeCompare(String(b.taken_at)));
export function snapAt(snaps: Obj[], date?: string | null) { const l = order(snaps).filter((x) => !date || x.snap_date <= date); return l[l.length - 1] || null; }
export function investCatsOf(accounts: Obj[] = []) { const c = accounts.filter((a) => a.kind === 'investment' && a.sav_cat).map((a) => a.sav_cat); return c.length ? c : ['Avanza']; }
// Insättningar från banken till Avanza mellan två datum (från, till]: sparande i Avanzas sparkategori (uttag är negativa)
export function depositsBetween(txs: Obj[], cats: string[], from: string, to: string) {
  return r2((txs || []).filter((t) => t.type === 'savings' && cats.includes(t.category ?? t.cat) && (t.tx_date ?? t.date) > from && (t.tx_date ?? t.date) <= to).reduce((x, t) => x + Number(t.amount), 0));
}
// Förändring mellan två bilder: värdeförändring − insättningar = avkastning. Flyttar mellan underkonton tar ut varandra.
export function changeBetween(prev: Obj, cur: Obj, st: Obj, txs: Obj[], cats: string[]) {
  const a = prev.data, b = cur.data;
  const total = r2(balanceFor(b, st) - balanceFor(a, st)), deposits = depositsBetween(txs, cats, prev.snap_date, cur.snap_date);
  const names = [...new Set([...countedAccounts(a, st), ...countedAccounts(b, st)].map((x: Obj) => x.name))];
  const val = (s: Obj, n: string) => countedAccounts(s, st).find((x: Obj) => x.name === n)?.value || 0;
  const sp = (s: Obj) => sum(countedAccounts(s, st).map((x: Obj) => Number(x.since_purchase_kr) || 0));
  return { from: prev.snap_date, to: cur.snap_date, value_change: total, deposits, return: r2(total - deposits), since_purchase_change: r2(sp(b) - sp(a)),
    by_account: names.map((n) => ({ name: n, change: r2(val(b, n) - val(a, n)) })).filter((x) => x.change),
    note: 'Avkastning = värdeförändring − insättningar från banken. Flyttar mellan Avanza-konton påverkar varken sparande eller avkastning. since_purchase_change = Avanzas egen siffra, som kontroll.' };
}

function leverage(s: Obj, st: Obj, loans: Obj[], accounts: Obj[], balances: Obj[], date: string) {
  const lv = st.leverage || {};
  const funded = s.accounts.filter((a: Obj) => fundedByLoan(a, st));
  const app = (lv.app_accounts || []).map((id: string) => accounts.find((a) => a.id === id || low(a.name) === low(id))).filter(Boolean) as Obj[];
  if (!funded.length && !app.length) return null;
  const notes: string[] = [];
  const appRows = app.map((a) => { const b = valueAt(balances.filter((x) => x.account === a.id), date) || a.balance || null; return { name: a.name, value: b ? Number(b.value) : 0 }; });
  const principal = sum([...funded.map((a: Obj) => a.value - (Number(a.since_purchase_kr) || 0)), ...appRows.map((x: Obj) => x.value)]);
  const borrowed = lv.borrowed_kr != null && isFinite(Number(lv.borrowed_kr)) ? Number(lv.borrowed_kr) : principal;
  if (lv.borrowed_kr == null) notes.push('Lånat belopp = insatt kapital på de lånefinansierade kontona (värde − utveckling sedan köp). Ange det exakta lånebeloppet i inställningarna (leverage.borrowed_kr).');
  const gain = sum(funded.map((a: Obj) => Number(a.since_purchase_kr) || 0));
  if (funded.some((a: Obj) => a.since_purchase_kr == null)) notes.push(`Utveckling sedan köp saknas för ${funded.filter((a: Obj) => a.since_purchase_kr == null).map((a: Obj) => a.name).join(', ')} (räknas som 0).`);
  if (appRows.length) notes.push(`${appRows.map((x: Obj) => x.name).join(', ')} räknas som lånat kapital men avkastningen där är okänd (räknas som 0).`);
  // Räntan: lånet i inställningarna (leverage.loan_id), annars skuldviktat snitt av alla lån med räntesats
  const ls = (lv.loan_id ? loans.filter((l) => l.id === lv.loan_id) : loans).filter((l) => l.interest_pct != null);
  const debt = (l: Obj) => { const h = (l.history || []).filter((x: Obj) => x.date <= date); return h.length ? Number(h[h.length - 1].value) : Number(l.history?.[0]?.value) || 0; };
  const w = ls.reduce((x, l) => x + debt(l), 0);
  const rate = ls.length ? r2(w > 0 ? ls.reduce((x, l) => x + debt(l) * Number(l.interest_pct), 0) / w : ls.reduce((x, l) => x + Number(l.interest_pct), 0) / ls.length) : null;
  const ded = st.interest_deduction_pct != null ? Number(st.interest_deduction_pct) : null;
  if (rate == null) notes.push('Ingen räntesats på lånen – ange räntan under Lån & skulder.');
  if (ded == null) notes.push('Ränteavdraget saknas i inställningarna (interest_deduction_pct).');
  const perYear = rate != null && ded != null ? r2(borrowed * rate / 100 * (1 - ded / 100)) : null;
  const days = lv.since ? Math.max(0, dayDiff(lv.since, date)) : null;
  if (!lv.since) notes.push('Ange när lånet investerades (leverage.since) för att räkna kostnaden hittills.');
  const cost = perYear != null && days != null ? r2(perYear * days / 365) : null;
  const net = cost != null ? r2(gain - cost) : null;
  return { accounts: [...funded.map((a: Obj) => ({ name: a.name, value: a.value, since_purchase_kr: a.since_purchase_kr })), ...appRows.map((x: Obj) => ({ ...x, app_account: true }))],
    borrowed_capital: r2(borrowed), borrowed_source: lv.borrowed_kr != null ? 'settings' : 'estimated', return_kr: gain, interest_pct: rate, deduction_pct: ded, since: lv.since || null, days,
    cost_per_year_after_deduction: perYear, cost_after_deduction: cost, net,
    text: cost != null ? `Lånat kapital gav ${signed(gain)}, kostade −${kr(cost)}, netto ${signed(net!)}.` : `Lånat kapital gav ${signed(gain)}${perYear != null ? `; räntan kostar −${kr(perYear)}/år efter avdrag` : ''}.`,
    ...(notes.length ? { notes } : {}) };
}

// Schablonskatt på ISK (och KF) för bildens år. Alla nivåer från invest_settings.isk: {tax_pct, extra_pct, min_pct,
// years: {'2026': {gov_rate_pct, tax_free}}}. Kapitalunderlag = (värdet vid varje kvartals början + insättningar under året) / 4.
export function iskTax(snaps: Obj[], st: Obj, cur: Obj, balances: Obj[], txs: Obj[], cats: string[], avanzaId: string) {
  const isk = st.isk || {}, year = cur.snap_date.slice(0, 4), y = (isk.years || {})[year] || {};
  const need = ['gov_rate_pct', 'tax_free'].filter((k) => y[k] == null), need2 = ['tax_pct', 'extra_pct'].filter((k) => isk[k] == null);
  const note = 'Uppskattning, inte ett besked från Skatteverket. Den skattefria nivån gäller ISK, KF och PPS tillsammans per person; KF-skatten dras av försäkringsbolaget. Flyttar inom Avanza till ett ISK räknas som insättning men syns inte här.';
  if (need.length || need2.length) return { year, missing: [...need.map((k) => `isk.years.${year}.${k}`), ...need2.map((k) => `isk.${k}`)], note: 'Inställningar saknas för ISK-skatten. ' + note };
  const iskVal = (s: Obj) => sum(s.accounts.filter((a: Obj) => a.type === 'ISK' || a.type === 'KF').map((a: Obj) => a.value));
  const share = balanceFor(cur.data, st) ? iskVal(cur.data) / balanceFor(cur.data, st) : 1;
  const quarters = ['01-01', '04-01', '07-01', '10-01'].map((q) => {
    const d = `${year}-${q}`;
    const near = order(snaps).filter((x) => Math.abs(dayDiff(x.snap_date, d)) <= 7).sort((a, b) => Math.abs(dayDiff(a.snap_date, d)) - Math.abs(dayDiff(b.snap_date, d)))[0];
    if (near) return { date: d, value: iskVal(near.data), source: 'bild ' + near.snap_date };
    if (d > cur.snap_date) return { date: d, value: iskVal(cur.data), source: 'prognos (senaste bilden)' };
    const b = valueAt(balances.filter((x) => x.account === avanzaId), d);
    return b ? { date: d, value: r2(b.value * share), source: `Avanza ISK-saldo ${b.date} × ISK-andel`, estimated: true } : { date: d, value: iskVal(cur.data), source: 'saknas – senaste bilden', estimated: true };
  });
  const done = depositsBetween(txs, cats, `${Number(year) - 1}-12-31`, cur.snap_date);
  // Kvarvarande autogiron till ISK/KF i år (prognos)
  const iskNames = cur.data.accounts.filter((a: Obj) => a.type === 'ISK' || a.type === 'KF').map((a: Obj) => a.name);
  let planned = 0; const [, cm, cd] = cur.snap_date.split('-').map(Number);
  for (const m of cur.data.monthly_savings || []) if (!isInternal(m, cur.data) && iskNames.includes(m.to_account)) for (let mo = cm; mo <= 12; mo++) if (mo > cm || m.day > cd) planned += m.amount;
  const underlag = r2((quarters.reduce((x, q) => x + q.value, 0) + Math.max(0, done) + planned) / 4);
  const taxable = Math.max(0, r2(underlag - Number(y.tax_free)));
  const rate = Math.max(Number(y.gov_rate_pct) + Number(isk.extra_pct), Number(isk.min_pct ?? 0));
  const income = r2(taxable * rate / 100), tax = r0(income * Number(isk.tax_pct) / 100);
  return { year, quarters, deposits_so_far: done, deposits_planned: r2(planned), capital_base: underlag, tax_free: Number(y.tax_free), taxable, schablon_pct: r2(rate), schablon_income: income, tax, estimated: true, note };
}

export function investView(p: ViewInput) {
  const st = p.settings || {}, cur = snapAt(p.snaps || [], p.date);
  if (!cur) return null;
  const s = cur.data, date = cur.snap_date, accs = countedAccounts(s, st);
  const txs = p.txs || [], cats = p.investCats || investCatsOf(p.accounts), loans = p.loans || [], balances = p.balances || [];
  const portfolio = balanceFor(s, st);
  const counted = new Set(accs.map((a: Obj) => a.name));
  const hold = (s.holdings || []).filter((h: Obj) => counted.has(h.account));
  const share = (v: number) => (portfolio ? r2(v / portfolio * 100) : 0);
  const available = (a: Obj) => r2((a.cash || 0) - (a.reserved_cash || 0));
  const warnings: Obj[] = [];
  const accounts = s.accounts.map((a: Obj) => {
    const hs = (s.holdings || []).filter((h: Obj) => h.account === a.name).sort((x: Obj, y: Obj) => y.value - x.value);
    const diff = hs.length ? r2(sum(hs.map((h: Obj) => h.value)) + (a.cash || 0) - a.value) : 0;
    if (Math.abs(diff) >= 1) warnings.push({ kind: 'account_sum', account: a.name, diff, text: `${a.name}: innehav + kontanter skiljer sig ${signed(diff)} från kontots värde` });
    return { name: a.name, type: a.type, value: a.value, cash: a.cash, available_cash: available(a), reserved_cash: a.reserved_cash, since_purchase_kr: a.since_purchase_kr, ytd_pct: a.ytd_pct,
      hidden: a.hidden, counted: counted.has(a.name), funded_by_loan: fundedByLoan(a, st), holdings: hs.map((h: Obj) => ({ ...h, share_pct: share(h.value) })) };
  });
  // Samma värdepapper på flera konton räknas ihop
  const agg: Obj = {};
  for (const h of hold) { const k = low(h.name) + '|' + h.kind; (agg[k] ||= { name: h.name, kind: h.kind, value: 0, accounts: [] }); agg[k].value = r2(agg[k].value + h.value); agg[k].accounts.push(h.account); }
  const all = Object.values(agg).map((h: any) => ({ ...h, share_pct: share(h.value) })).sort((a: Obj, b: Obj) => b.value - a.value);
  const limit = st.concentration_pct != null ? Number(st.concentration_pct) : 15;
  for (const h of all) if (h.share_pct > limit) warnings.push({ kind: 'concentration', name: h.name, share_pct: h.share_pct, limit_pct: limit, text: `${h.name} är ${pct1(h.share_pct)} av portföljen (gräns ${pct1(limit)})` });
  const cash = sum(accs.map(available)), reserved = sum(accs.map((a: Obj) => a.reserved_cash || 0));
  const byKind = (k: string) => sum(hold.filter((h: Obj) => h.kind === k).map((h: Obj) => h.value));
  const alloc = [['fond', 'Fonder'], ['aktie', 'Aktier'], ['ETF', 'ETF']].map(([k, label]) => ({ key: k, label, value: byKind(k) }));
  alloc.push({ key: 'reserverat', label: 'Reserverat för order', value: reserved }, { key: 'kontanter', label: 'Kontanter', value: cash });
  const known = sum(alloc.map((x) => x.value)), rest = r2(portfolio - known);
  if (Math.abs(rest) >= 1) alloc.push({ key: 'ovrigt', label: 'Utan innehavslista', value: rest });
  const orders = (s.pending_orders || []).filter((o: Obj) => counted.has(o.account)), ordersSum = sum(orders.map((o: Obj) => o.amount));
  if (ordersSum > reserved + 1) warnings.push({ kind: 'orders', text: `Väntande order (${kr(ordersSum)}) är mer än reserverade kontanter (${kr(reserved)})` });
  const sc = sumCheck(s); if (!sc.ok) warnings.push({ kind: 'sum', text: sc.text });
  // Utdelningar per år: den senaste bilden varje år (ytd)
  const perYear: Obj = {};
  for (const x of order(p.snaps)) if (x.snap_date <= date && x.data.dividends?.ytd != null) perYear[x.snap_date.slice(0, 4)] = { year: x.snap_date.slice(0, 4), ytd: x.data.dividends.ytd, as_of: x.snap_date };
  // Tillgängligt direkt: bank- och sparkonton (utom passagekonton), Klarna och Avanzas kontanter som inte är reserverade
  const liq: Obj[] = [];
  for (const a of p.accounts || []) {
    if (!['bank', 'savings'].includes(a.kind || 'bank') || a.role === 'mortgage') continue;
    const b = valueAt(balances.filter((x) => x.account === a.id), date) || (a.balance && a.balance.date <= date ? a.balance : null);
    if (b && Number(b.value)) liq.push({ name: a.name, value: r2(Number(b.value)), date: b.date });
  }
  for (const a of accs) if (available(a) > 0) liq.push({ name: `Avanza ${a.name} (kontanter)`, value: available(a), date });
  const prev = order(p.snaps).filter((x) => x.snap_date < date || (x.snap_date === date && x.taken_at < cur.taken_at)).pop();
  return {
    date, taken_at: cur.taken_at, snapshot_dates: order(p.snaps).map((x) => x.snap_date),
    total_value: s.total_value, portfolio_value: portfolio, include_hidden: !!st.include_hidden, sum_check: sc,
    invested_capital: r2(portfolio - cash), invested_note: 'Investerat kapital = allt utom kontanter som inte är reserverade. Reserverade kontanter och väntande order räknas som investerat.',
    accounts, holdings: all, top5: all.slice(0, 5), allocation: alloc.map((x) => ({ ...x, pct: share(x.value) })),
    pending_orders: orders, pending_orders_total: ordersSum, monthly_savings: (s.monthly_savings || []).map((m: Obj) => ({ ...m, internal: isInternal(m, s) })),
    dividends: { ...s.dividends, per_year: Object.values(perYear) },
    since_purchase_kr: sum(accs.map((a: Obj) => Number(a.since_purchase_kr) || 0)),
    change_since_previous: prev ? changeBetween(prev, cur, st, txs, cats) : null,
    leverage: leverage(s, st, loans, p.accounts || [], balances, date),
    isk_tax: iskTax(p.snaps, st, cur, balances, txs, cats, st.avanza_account || AVANZA_ACCOUNT),
    liquidity: { available_now: sum(liq.map((x) => x.value)), items: liq, note: 'Tillgängligt direkt: bankkonton, Klarna och kontanter hos Avanza som inte är reserverade. Visas separat; förmögenhetskategorierna är oförändrade.' },
    warnings, concentration_limit_pct: limit,
    note: 'Bara fakta från Avanza – inga köp- eller säljrekommendationer. Appen kan inte handla eller flytta pengar hos Avanza.',
  };
}

// Avkastning enligt Avanza per steg i förändringsuppdelningen: när en bild finns inom 5 dagar från båda periodgränserna
export function avanzaStepReturns(steps: Obj[], starts: Obj, snaps: Obj[], st: Obj, txs: Obj[], cats: string[]) {
  const near = (d: string) => order(snaps).filter((x) => Math.abs(dayDiff(x.snap_date, d)) <= SNAP_NEAR_DAYS).sort((a, b) => Math.abs(dayDiff(a.snap_date, d)) - Math.abs(dayDiff(b.snap_date, d)))[0];
  const out: Obj[] = [];
  for (const s of steps) {
    const a = starts[s.from] && near(starts[s.from]), b = starts[s.to] && near(starts[s.to]);
    if (a && b && a !== b) out.push({ from: s.from, to: s.to, ...changeBetween(a, b, st, txs, cats) });
  }
  return out;
}

// ── Databas (service role: varje fråga filtreras på user_id) ─────────
const missingTable = (e: any) => /42P01|PGRST205|does not exist|could not find the table/i.test(`${e?.code || ''} ${e?.message || ''}`);
async function q<T>(p: PromiseLike<{ data: T; error: any }>, optional = false): Promise<T> {
  const { data, error } = await p;
  if (error) { if (optional && missingTable(error)) return null as T; throw new Error('Databasfel: ' + (error.message || error)); }
  return data;
}
async function pages(make: () => any) { const out: Obj[] = []; for (let i = 0; ; i += 1000) { const r = (await q<Obj[]>(make().range(i, i + 999), true)) || []; out.push(...r); if (r.length < 1000) break; } return out; }
export const NEEDS_TABLE = 'Tabellen avanza_snapshots saknas — kör supabase/schema.sql i Supabase (SQL Editor).';

// Inställningar sparas villkorat och slås ihop fält för fält med det som finns nu (_shared/merge.ts), så att importen
// aldrig skriver över en ändring som appen eller nattjobbet hunnit göra
const stateIo = (db: any, uid: string): StateIo => ({
  async get(key) { return (await q<Obj[]>(db.from('user_state').select('value,updated_at,deleted').eq('user_id', uid).eq('key', key)))[0] || null; },
  async update(key, value, at) { return (await q<Obj[]>(db.from('user_state').update({ value, deleted: false }).eq('user_id', uid).eq('key', key).eq('updated_at', at).select('updated_at')))[0]?.updated_at || null; },
  async insert(key, value) {
    const { data, error } = await db.from('user_state').insert({ user_id: uid, key, value, deleted: false }).select('updated_at');
    if (error) { if (error.code === '23505') return null; throw new Error('Databasfel: ' + error.message); }
    return data?.[0]?.updated_at || null;
  },
});

export async function loadInvest(db: any, uid: string) {
  const st = (await q<Obj[]>(db.from('user_state').select('key,value,updated_at').eq('user_id', uid).eq('deleted', false).in('key', ['accounts', 'invest_settings', 'expected_tx']))) || [];
  const base = (k: string) => { const r = st.find((x) => x.key === k); return { v: r ? structuredClone(r.value) : undefined, at: r?.updated_at ?? null }; };
  const key = (k: string) => st.find((r) => r.key === k)?.value;
  const snapRows = await q<Obj[]>(db.from('avanza_snapshots').select('id,taken_at,snap_date,total,hash,data').eq('user_id', uid).eq('deleted', false).order('snap_date', { ascending: true }), true);
  const balances = await pages(() => db.from('account_balances').select('account,bal_date,value,source').eq('user_id', uid).eq('deleted', false).order('bal_date', { ascending: true }));
  const loans = (await q<Obj[]>(db.from('loans').select('*').eq('user_id', uid).eq('deleted', false), true)) || [];
  const lb = (await q<Obj[]>(db.from('loan_balances').select('loan_id,bal_date,value').eq('user_id', uid).eq('deleted', false).order('bal_date', { ascending: true }), true)) || [];
  const txs = await pages(() => db.from('transactions').select('type,category,amount,tx_date,description,account,source').eq('user_id', uid).eq('deleted', false).eq('type', 'savings').order('id', { ascending: true }));
  const accounts = Array.isArray(key('accounts')) ? key('accounts') : [];
  return {
    migrated: snapRows !== null, settings: key('invest_settings') || {}, base: { accounts: base('accounts'), expected_tx: base('expected_tx') }, accounts, expected: Array.isArray(key('expected_tx')) ? key('expected_tx') : [],
    snaps: (snapRows || []).map((r) => ({ id: r.id, taken_at: new Date(r.taken_at).toISOString(), snap_date: String(r.snap_date).slice(0, 10), hash: r.hash, data: r.data })),
    balances: balances.map((b) => ({ ...b, bal_date: String(b.bal_date).slice(0, 10), value: Number(b.value) })),
    loans: loans.map((l) => ({ ...l, history: lb.filter((b) => b.loan_id === l.id).map((b) => ({ date: String(b.bal_date).slice(0, 10), value: Number(b.value) })) })),
    txs,
  };
}
export async function investmentsFor(db: any, uid: string, date?: string | null) {
  const d = await loadInvest(db, uid);
  if (!d.migrated) return { note: NEEDS_TABLE };
  const v = investView({ snaps: d.snaps, settings: d.settings, loans: d.loans, accounts: d.accounts, balances: d.balances, txs: d.txs, date });
  return v ? { ...v, settings: d.settings } : { note: 'Ingen Avanza-bild importerad ännu (import_avanza_snapshot).', settings: d.settings };
}

// Import: dryRun (standard) = bara förhandsgranskning, inget sparas. Samma bild två gånger ändrar ingenting.
// Sparar: bilden (historik), saldot på Avanza ISK den dagen (source 'import'), kontots aktuella saldo i appen och
// autogirona som förväntade transaktioner. Innan befintlig data ändras sparas en backup (backups, avanza-import-…).
export async function importSnapshot(db: any, uid: string, input: any, o: { dryRun?: boolean; source?: string } = {}) {
  const dryRun = o.dryRun !== false;
  const errors = validateSnapshot(input);
  if (errors.length) return { saved: false, dry_run: dryRun, valid: false, errors };
  const s = normalizeSnapshot(input), hash = await snapshotHash(s);
  const d = await loadInvest(db, uid);
  if (!d.migrated) return { saved: false, dry_run: dryRun, valid: true, errors: [NEEDS_TABLE] };
  const st = d.settings, avId = st.avanza_account || AVANZA_ACCOUNT;
  const acc = d.accounts.find((a: Obj) => a.id === avId);
  if (!acc) return { saved: false, dry_run: dryRun, valid: true, errors: [`Kontot ${avId} (Avanza ISK) finns inte i appen`] };
  const sc = sumCheck(s), date = snapDate(s.date), taken = takenAt(s.date), balance = balanceFor(s, st);
  const dup = d.snaps.find((x) => x.hash === hash);
  const row = { taken_at: taken, snap_date: date, data: s };
  const snaps = dup ? d.snaps : [...d.snaps, row];
  const prevSnap = order(d.snaps).filter((x) => x !== dup && (x.snap_date < date || (x.snap_date === date && x.taken_at < taken))).pop() || null;
  const latest = !order(d.snaps).some((x) => x !== dup && (x.snap_date > date || (x.snap_date === date && x.taken_at > taken)));
  const sameDayLater = d.snaps.some((x) => x !== dup && x.snap_date === date && x.taken_at > taken);
  // Vad som skulle ändras
  const changes: Obj[] = [];
  const oldRow = d.balances.filter((b) => b.account === avId && b.bal_date === date)[0] || null;
  const oldBal = valueAt(d.balances.filter((b) => b.account === avId), date) || (acc.balance?.date <= date ? acc.balance : null);
  let newExpected: Obj[] | null = null;
  if (!dup) {
    changes.push({ what: 'snapshot', text: `Ny Avanza-bild ${date} (${s.accounts.length} konton, ${s.holdings.length} innehav)` });
    if (!sameDayLater && (!oldRow || Math.abs(Number(oldRow.value) - balance) >= 0.005 || oldRow.source !== 'import'))
      changes.push({ what: 'balance', account: acc.name, date, from: oldRow ? Number(oldRow.value) : null, to: balance, text: `Saldo på ${acc.name} ${date}: ${oldRow ? kr(Number(oldRow.value)) + ' → ' : ''}${kr(balance)}` });
    if (latest && (!acc.balance?.date || acc.balance.date <= date) && (acc.balance?.date !== date || Math.abs(Number(acc.balance?.value) - balance) >= 0.005))
      changes.push({ what: 'account', account: acc.name, text: `Aktuellt saldo i appen: ${kr(balance)} (${date})` });
    if (latest) {
      const bankAcc = [...d.txs].reverse().find((t) => /avanza/i.test(t.description || '') && t.source === 'bank' && t.account)?.account
        || d.accounts.find((a: Obj) => a.id === 'lonekonto')?.id || d.accounts.find((a: Obj) => (a.kind || 'bank') === 'bank')?.id || null;
      const next = autogiroExpected(s, d.expected, { fromAccount: bankAcc, graceBankDays: st.autogiro_grace_bank_days != null ? Number(st.autogiro_grace_bank_days) : 3 });
      if (canon(next) !== canon(d.expected)) {
        newExpected = next;
        const ids = (l: Obj[]) => new Set(l.filter((e) => e?.source === 'avanza').map((e) => e.id));
        const before = ids(d.expected), after = ids(next);
        const added = next.filter((e) => e.source === 'avanza' && !before.has(e.id)).map((e) => e.name), removed = d.expected.filter((e) => e?.source === 'avanza' && !after.has(e.id)).map((e) => e.name);
        changes.push({ what: 'expected_tx', added, removed, text: `Förväntade autogiron: ${[...added.map((x) => '+ ' + x), ...removed.map((x) => '− ' + x)].join(', ') || 'uppdaterade'}` });
      }
    }
  }
  const view = investView({ snaps, settings: st, loans: d.loans, accounts: d.accounts, balances: d.balances, txs: d.txs, date });
  const preview = {
    date, taken_at: taken, total_value: s.total_value, balance_to_set: balance, account: acc.name, current_balance: oldBal ? { value: Number(oldBal.value), date: oldBal.date } : null,
    previous_snapshot: prevSnap ? { date: prevSnap.snap_date, total_value: prevSnap.data.total_value } : null,
    change_since_previous: prevSnap ? changeBetween(prevSnap, row, st, d.txs, investCatsOf(d.accounts)) : null,
    sum_check: sc, warnings: view?.warnings || [], leverage: view?.leverage?.text || null,
    internal_savings_ignored: s.monthly_savings.filter((m: Obj) => isInternal(m, s)).map((m: Obj) => `${kr(m.amount)} den ${m.day}:e från ${m.from} till ${m.to_account} (intern flytt, ingen förväntad banktransaktion)`),
  };
  if (dup) return { saved: false, dry_run: dryRun, valid: true, duplicate: true, changed: false, hash, preview, changes: [], note: `Samma bild är redan importerad (${dup.snap_date}). Inget ändras.` };
  if (!sc.ok) return { saved: false, dry_run: dryRun, valid: true, blocked: sc.text, hash, preview, changes };
  if (dryRun) return { saved: false, dry_run: true, valid: true, hash, preview, changes, note: 'Förhandsgranskning – inget sparat. Kör igen med dry_run: false när användaren godkänt.' };
  // Backup av det som skrivs över, sedan skrivningarna
  const touched = changes.filter((c) => c.what !== 'snapshot');
  if (touched.length) await q(db.from('backups').insert({ user_id: uid, label: 'avanza-import-' + hash.slice(0, 12), data: {
    account_balance: oldRow, account: acc.balance ?? null, ...(newExpected ? { expected_tx: d.expected } : {}) } }));
  await q(db.from('avanza_snapshots').insert({ user_id: uid, taken_at: taken, snap_date: date, total: s.total_value, hash, data: s, source: o.source || 'mcp', deleted: false }));
  if (changes.some((c) => c.what === 'balance'))
    await q(db.from('account_balances').upsert({ user_id: uid, account: avId, bal_date: date, value: balance, source: 'import', deleted: false }, { onConflict: 'user_id,account,bal_date' }));
  // Bara importens egna ändringar läggs på det som finns nu: saldot på Avanza ISK och autogironas poster
  if (changes.some((c) => c.what === 'account'))
    await saveMerged(stateIo(db, uid), 'accounts', d.accounts.map((a: Obj) => (a.id === avId ? { ...a, balance: { value: balance, date } } : a)), d.base.accounts);
  if (newExpected) await saveMerged(stateIo(db, uid), 'expected_tx', newExpected, d.base.expected_tx);
  return { saved: true, dry_run: false, valid: true, changed: true, hash, preview, changes };
}

// Inställningar (invest_settings). Bara kända fält; null tar bort.
export const SETTINGS_SCHEMA: Obj = {
  type: 'object',
  properties: {
    include_hidden: { type: 'boolean', description: 'Räkna med dolda Avanza-konton i saldot på Avanza ISK' },
    concentration_pct: { type: 'number', minimum: 1, maximum: 100, description: 'Varning när ett innehav är mer än så många procent av portföljen (standard 15)' },
    interest_deduction_pct: { type: 'number', minimum: 0, maximum: 100, description: 'Ränteavdrag i procent (30)' },
    funded_by_loan: { type: 'array', items: { type: 'string' }, description: 'Namn på Avanza-konton som är finansierade med lån' },
    autogiro_grace_bank_days: { type: 'integer', minimum: 0, maximum: 10, description: 'Bankdagar efter autogirodagen innan notis' },
    leverage: { type: 'object', properties: {
      since: { anyOf: [{ type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, { type: 'null' }], description: 'Datum då det lånade kapitalet investerades' },
      borrowed_kr: { anyOf: [{ type: 'number' }, { type: 'null' }], description: 'Lånat belopp (utökningen av bolånet)' },
      loan_id: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'Lånet vars ränta används (annars snittet av alla lån)' },
      app_accounts: { type: 'array', items: { type: 'string' }, description: 'Konton i appen (t.ex. klarna) som också räknas som lånat kapital' } } },
    isk: { type: 'object', properties: {
      tax_pct: { type: 'number' }, extra_pct: { type: 'number' }, min_pct: { type: 'number' },
      years: { type: 'object', description: '{"2026": {"gov_rate_pct": 2.55, "tax_free": 300000}}' } } },
  },
};
export function mergeSettings(cur: Obj, patch: Obj): Obj {
  const out: Obj = structuredClone(cur || {});
  for (const [k, v] of Object.entries(patch || {})) {
    if (v === null) delete out[k];
    else if (v && typeof v === 'object' && !Array.isArray(v) && k !== 'years') out[k] = mergeSettings(out[k] || {}, v as Obj);
    else if (k === 'years') { out.years = { ...(out.years || {}) }; for (const [y, x] of Object.entries(v as Obj)) out.years[y] = x === null ? undefined : { ...(out.years[y] || {}), ...(x as Obj) }; out.years = JSON.parse(JSON.stringify(out.years)); }
    else out[k] = v;
  }
  return out;
}
