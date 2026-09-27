// Gemensam ekonomilogik för edge-funktionerna, portad från index.html (samma regler som appen).
// MCP-servern har egna kopior (functions/mcp är en fil för att kunna klistras in i panelen).
// deno-lint-ignore-file no-explicit-any
export type Obj = Record<string, any>;

// ── Standardvärden (samma som i index.html) ───────────────────────────
export const DEF: Obj = {
  cats_exp: ['Boende (Lån)', 'Boende (Avgift)', 'Boende (Resterande)', 'Mat (Butik)', 'Mat (Ute)', 'Lunch (Restaurang)', 'Transport/Parkering', 'Gym', 'Fest', 'Kläder', 'Resa', 'Bjuda andra/presenter', 'Prenumerationer', 'Swish (privat)', 'Övrigt', 'Skuld föregående'],
  cats_inc: ['Lön', 'Spelvinst/förlust', 'Övrigt'],
  cats_sav: ['Avanza', 'SEB', 'Annat'],
  cats_trf: ['Kreditkortsbetalning', 'Egen överföring', 'Bostad, lån & tillgångar'],
  accounts: [{ id: 'lonekonto', name: 'Lönekonto', kind: 'bank' }, { id: 'amex', name: 'AMEX', kind: 'card' }],
  pay_periods: [], contact_names: {}, merchant_rules: {}, owner_name: '', ai_memory: [], ai_import_notes: [],
};
export const CAT_KEY: Obj = { expense: 'cats_exp', income: 'cats_inc', savings: 'cats_sav', transfer: 'cats_trf' };
export const TYPES = ['expense', 'income', 'savings', 'transfer'];
export const SWISH_CAT = 'Swish (privat)';
export const ASSET_TRF = 'Bostad, lån & tillgångar';

// ── Datum och löneperioder ─────────────────────────────────────────────
const pad = (n: number) => String(n).padStart(2, '0');
export const ymd = (d: Date) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
export const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
export const dayDiff = (a: string, b: string) => Math.abs(Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 864e5;
// Dagens datum i Sverige (servern kör i UTC)
export const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm' }).format(new Date());
function periodShift(ym: string, n: number) { const [y, m] = ym.split('-').map(Number); const d = new Date(y, m - 1 + n, 1); return d.getFullYear() + '-' + pad(d.getMonth() + 1); }
function easterDate(y: number) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const mm = Math.floor((a + 11 * h + 22 * l) / 451), month = Math.floor((h + l - 7 * mm + 114) / 31), day = ((h + l - 7 * mm + 114) % 31) + 1;
  return new Date(y, month - 1, day);
}
// Bankfria dagar: långfredag, annandag påsk, Kristi himmelsfärd, midsommarafton, alla helgons dag + fasta
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
// Löneperiodens första och sista dag
export function periodRange(ym: string, payPeriods: Obj[] = []) {
  const [y, m, d] = periodStart(periodShift(ym, 1), payPeriods).split('-').map(Number);
  return { start: periodStart(ym, payPeriods), end: ymd(new Date(y, m - 1, d - 1)) };
}

// ── Butiksnycklar (samma som appens inlärda regler) ────────────────────
export function descNumber(desc: string) { const s = String(desc || '').trim(); return /^\+?\d[\d\s-]{5,}$/.test(s) ? s.replace(/\D/g, '') : null; }
export function numberKind(n: string | null) {
  if (!n) return null;
  if (/^467\d{8}$/.test(n) || /^07\d{8}$/.test(n)) return 'mobil';
  if (/^123\d{7}$/.test(n)) return 'swishforetag';
  return 'konto';
}
export function merchantBase(desc: string) {
  const num = descNumber(desc);
  if (num) return '#' + num; // behåll numret, annars blir alla Swish-mottagare och konton "samma butik"
  return String(desc || '').toLowerCase()
    .replace(/^k\*/, '') // SEB: "K*BUTIK" = kortköp
    .replace(/\d{2,4}[-./]\d{1,2}([-./]\d{1,4})?/g, ' ')
    .replace(/\b(kortköp|kortk[oö]p|reservation|reserverat|prel|preliminär)\b/g, ' ')
    .replace(/\d+/g, ' ')
    .replace(/[^a-zåäöéüæø&]+/g, ' ')
    .trim().replace(/\s+/g, ' ').slice(0, 40) || 'okänd';
}
export const mkeyFor = (desc: string, amount: number) => merchantBase(desc) + '|' + (amount < 0 ? 'ut' : 'in');

// ── Kategorisering utan AI (som autoCat/fallbackCat i appen) ───────────
// g = { desc, dir: 'ut'|'in', accKind }; returnerar {type,cat,conf} eller null
export function autoCat(s: Obj, g: Obj) {
  const cats = (t: string) => (s[CAT_KEY[t]] || DEF[CAT_KEY[t]]) as string[];
  const pick = (type: string, cat: string) => (cats(type).includes(cat) ? { type, cat, conf: 'high', src: 'auto' } : null);
  const desc = g.desc || ''; const kind = numberKind(descNumber(desc));
  const owner = String(s.owner_name || '').toUpperCase().replace(/\s+/g, ' ').trim();
  const D = desc.toUpperCase().replace(/\s+/g, ' ');
  if (owner.length >= 5 && (D.startsWith(owner.slice(0, Math.min(owner.length, 12))) || (owner.startsWith(D) && D.length >= 8)))
    return pick('transfer', 'Egen överföring') || pick('transfer', cats('transfer')[0]);
  if (g.accKind === 'bank' && g.dir === 'ut' && /AMERICAN EXPRESS|\bAMEX\b|EUROCARD|MASTERCARD FAKTURA/.test(D)) return pick('transfer', 'Kreditkortsbetalning');
  if (kind === 'mobil') return pick('expense', SWISH_CAT);
  return null;
}
export function fallbackCat(s: Obj, g: Obj) {
  const cats = (t: string) => (s[CAT_KEY[t]] || DEF[CAT_KEY[t]]) as string[];
  const first = (t: string, pref: string) => (cats(t).includes(pref) ? pref : cats(t)[0]);
  const d = g.desc || '';
  let r: Obj;
  if (/american express|amex|kortbetalning|betalning mottagen|inbetalning/i.test(d)) r = { type: 'transfer', cat: cats('transfer')[0] };
  else if (numberKind(descNumber(d)) === 'konto') r = { type: 'transfer', cat: first('transfer', 'Egen överföring') };
  else if (/avanza|nordnet/i.test(d) && cats('savings').length) r = { type: 'savings', cat: cats('savings').find((c) => /avanza/i.test(c)) || cats('savings')[0] };
  else if (g.dir === 'in') r = { type: 'income', cat: first('income', 'Övrigt') };
  else r = { type: 'expense', cat: first('expense', 'Övrigt') };
  return { ...r, conf: 'low', src: 'guess' };
}
// Belopp som appen lagrar: utgift/sparande positivt = pengar ut; inkomst/överföring med bankens tecken
export const storedAmount = (type: string, raw: number) => (type === 'income' || type === 'transfer' ? raw : -raw);
