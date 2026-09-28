// Bankkoppling: tolkning, dubblettkontroll och kategorisering av transaktioner från Enable Banking.
// Ren logik utan Deno/nätverk, så att den kan testas i Node (supabase/tests/bank.test.mjs).
// deno-lint-ignore-file no-explicit-any
import { type Obj, CAT_KEY, DEF, TYPES, addDays, dayDiff, mkeyFor, periodForDate, autoCat, fallbackCat, storedAmount, today, numberKind, descNumber, PENDING_CARD_CAT } from '../_shared/finance.ts';

// Bokfört saldo i första hand (som i bankens app), annars disponibelt
const BALANCE_ORDER = ['CLBD', 'ITBD', 'XPCD', 'ITAV', 'CLAV', 'OTHR'];
export function pickBalance(balances: Obj[] = []) {
  const sorted = [...balances].sort((a, b) => {
    const ia = BALANCE_ORDER.indexOf(a.balance_type), ib = BALANCE_ORDER.indexOf(b.balance_type);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  const b = sorted[0]; if (!b) return null;
  const value = Number(b.balance_amount?.amount); if (!isFinite(value)) return null;
  return { value, date: b.reference_date || today() };
}

// Bankens transaktion → rad med bankens tecken (ut = negativt), som en rad ur ett kontoutdrag
export function mapTx(t: Obj) {
  const amt = Number(t.transaction_amount?.amount);
  if (!isFinite(amt) || amt === 0) return null;
  const raw = t.credit_debit_indicator === 'DBIT' ? -Math.abs(amt) : Math.abs(amt);
  let date = t.booking_date || t.value_date || t.transaction_date;
  if (!date) return null;
  const party = raw < 0 ? t.creditor?.name : t.debtor?.name;
  let desc = (Array.isArray(t.remittance_information) ? t.remittance_information.join(' ') : String(t.remittance_information || '')) || party || '';
  desc = desc.replace(/\s+/g, ' ').trim();
  // SEB-kortköp: "ICA KVANTUM /24-09-24" — datumet i texten är köpdagen (samma som vid import)
  const m = desc.match(/^(.*?)\s*\/(\d{2})-(\d{2})-(\d{2})$/);
  if (m) { desc = m[1].trim(); const d = `20${m[2]}-${m[3]}-${m[4]}`; if (dayDiff(d, date) <= 10) date = d; }
  // Överföring till konto: "53293315887 224758863226" = kontonummer + referens; kontoutdraget visar bara numret
  const acct = desc.match(/^(\d{6,})\s+\d{6,}$/);
  if (acct) desc = acct[1];
  const ref = String(t.entry_reference || t.transaction_id || `${date}|${raw}|${desc}`);
  return { ref, date, bookingDate: t.booking_date || date, raw, desc };
}

// Bankens tecken för en rad som redan finns i appen
export const rawOf = (r: Obj) => (r.type === 'income' || r.type === 'transfer' ? Number(r.amount) : -Number(r.amount));

// Matchar nya bankrader mot befintliga rader på samma konto: samma bankreferens, eller samma belopp
// inom ±4 dagar (kontoutdrag som importerats för hand har annan text och ibland annat datum).
// Varje befintlig rad används högst en gång, så två likadana köp samma dag blir båda kvar.
// Bankrader som du tagit bort (deleted) räknas också, så att de inte kommer tillbaka vid nästa hämtning.
export function dedupe(fresh: Obj[], existing: Obj[]) {
  const refs = new Set(existing.map((r) => r.extra?.bank_ref).filter(Boolean));
  const pool = existing.filter((r) => !r.extra?.bank_ref && !r.deleted).map((r) => ({ raw: Math.round(rawOf(r) * 100), date: r.tx_date, used: false }));
  const out: Obj[] = []; let dups = 0;
  for (const t of fresh) {
    if (refs.has(t.ref)) { dups++; continue; }
    const cents = Math.round(t.raw * 100);
    const hit = pool.find((p) => !p.used && p.raw === cents && (dayDiff(p.date, t.date) <= 4 || dayDiff(p.date, t.bookingDate) <= 4));
    if (hit) { hit.used = true; dups++; continue; }
    refs.add(t.ref); out.push(t);
  }
  return { fresh: out, dups };
}

// Hur många av bankkontots rader som redan finns på ett konto i appen (för att hitta rätt konto)
export function overlap(fresh: Obj[], existing: Obj[]) {
  return fresh.length - dedupe(fresh, existing).fresh.length;
}

// Nytt konto i appen för ett bankkonto som inte matchar något befintligt. Namnet tas från produkten
// (SEB skickar kontohavarens namn i "name"), t.ex. "Enkla sparkontot (SEB)", med löpnummer vid dubbletter.
export function newAppAccount(a: Obj, existing: Obj[]) {
  const num = String(a.iban || a.other || a.account_id?.iban || a.account_id?.other?.identification || '').replace(/\s/g, '');
  const tail = (num || String(a.uid || '')).replace(/[^0-9a-z]/gi, '').slice(-4).toLowerCase() || Math.random().toString(36).slice(2, 6);
  let id = `${String(a.aspsp || 'bank').toLowerCase().replace(/[^a-z]/g, '')}_${tail}`;
  while (existing.some((x) => x.id === id)) id += 'x';
  const product = a.product || a.name || 'Konto';
  const kind = a.cash_account_type === 'SVGS' || /spar/i.test(product) ? 'savings' : a.cash_account_type === 'CARD' ? 'card' : 'bank';
  const base = `${product} (${a.aspsp || 'bank'})`; let name = base;
  for (let i = 2; existing.some((x) => x.name === name); i++) name = `${product} ${i} (${a.aspsp || 'bank'})`;
  return { id, name, kind, ...(num ? { number: num } : {}) };
}

// Kontots roll bestämmer hur flyttar mellan egna konton räknas, så att inget räknas två gånger:
//  card_payment = konto som betalar kreditkortsfakturan · mortgage = bolånekonto (kostnaden räknas när
//  pengarna sätts in) · savings = sparkonto (sparandet räknas på kontot pengarna kommer från)
export function roleCat(s: Obj, acc: Obj | undefined, g: Obj) {
  const role = acc?.role || (acc?.kind === 'savings' ? 'savings' : null);
  const cats = (t: string) => (s[CAT_KEY[t]] || DEF[CAT_KEY[t]]) as string[];
  const own = cats('transfer').includes('Egen överföring') ? 'Egen överföring' : cats('transfer')[0];
  const set = (type: string, cat: string) => ({ type, cat, conf: 'high', src: 'role' });
  // Pengar till kontot som betalar kreditkortet (…3264) = kortköp som väntar på fakturan
  const num = descNumber(g.desc);
  const dest = num ? (s.accounts || []).find((a: Obj) => a.number && String(a.number).replace(/\D/g, '') === num) : null;
  if (dest?.role === 'card_payment' && dest.id !== acc?.id && g.dir === 'ut' && cats('expense').includes(PENDING_CARD_CAT)) return set('expense', PENDING_CARD_CAT);
  if (role === 'mortgage' || role === 'savings') return set('transfer', own);
  if (role === 'card_payment') {
    if (g.dir === 'in') return set('transfer', own);
    // Fakturan betalas till ett konto-/girnummer eller till AMEX; avgifter m.m. kategoriseras som vanligt
    if (numberKind(descNumber(g.desc)) === 'konto' || /AMERICAN EXPRESS|\bAMEX\b|EUROCARD/i.test(g.desc))
      return set('transfer', cats('transfer').includes('Kreditkortsbetalning') ? 'Kreditkortsbetalning' : own);
  }
  return null;
}

// Uttag från ett sparkonto till ett annat eget konto = minskat sparande (på mottagarsidan, där sparande
// räknas). Kräver att båda sidor finns bland raderna: samma belopp, motsatt tecken, högst 2 dagar isär.
export function markSavingsWithdrawals(s: Obj, rows: Obj[], accOf: (id: string) => Obj | undefined) {
  const isSav = (id: string) => { const a = accOf(id); return a?.role === 'savings' || (!a?.role && a?.kind === 'savings'); };
  const sav = (s.cats_sav || DEF.cats_sav) as string[];
  const cat = sav.find((c) => /seb/i.test(c)) || sav[0];
  const used = new Set<Obj>(); let n = 0;
  for (const r of rows) {
    if (isSav(r.account) || r.type !== 'transfer' || r.amount <= 0 || accOf(r.account)?.role === 'mortgage') continue;
    // Jämför med bankens tecken: sparkontots sida kan vara en överföring eller en väntande kortutgift
    const out = rows.find((o) => !used.has(o) && o !== r && isSav(o.account) && Math.round(rawOf(o) * 100) === -Math.round(r.amount * 100) && dayDiff(o.tx_date, r.tx_date) <= 2);
    if (!out || !cat) continue;
    used.add(out); n++;
    Object.assign(r, { type: 'savings', category: cat, amount: -r.amount }); // negativt sparande = uttag
  }
  return n;
}

// Kategorisering: inlärda regler → automatiska regler → AI (ai = async (groups) => items) → gissning
export async function categorize(s: Obj, rows: Obj[], accOf: (acc: string) => Obj | undefined, ai?: (groups: Obj[]) => Promise<Obj[]>) {
  const cats = (t: string) => (s[CAT_KEY[t]] || DEF[CAT_KEY[t]]) as string[];
  const valid = (type: string, cat: string) => TYPES.includes(type) && cats(type).includes(cat);
  const groups: Obj = {};
  for (const r of rows) {
    const mkey = mkeyFor(r.desc, r.raw);
    const k = r.account + '¦' + mkey;
    (groups[k] ||= { key: k, mkey, desc: r.desc, dir: r.raw < 0 ? 'ut' : 'in', account: r.account, accKind: accOf(r.account)?.kind || 'bank', rows: [], total: 0 });
    groups[k].rows.push(r); groups[k].total += r.raw;
  }
  const list = Object.values(groups) as Obj[];
  const rules = s.merchant_rules || {};
  const todo: Obj[] = [];
  for (const g of list) {
    const byRole = roleCat(s, accOf(g.account), g);
    if (byRole) { Object.assign(g, byRole); continue; }
    const rule = rules[g.mkey];
    if (rule && valid(rule.type, rule.cat)) Object.assign(g, { type: rule.type, cat: rule.cat, conf: 'high', src: 'rule' });
    else { const a = autoCat(s, g); if (a) Object.assign(g, a); else todo.push(g); }
  }
  if (todo.length && ai) {
    try {
      const items = await ai(todo);
      for (const it of items) { const g = todo[it.k]; if (g && valid(it.type, it.cat)) Object.assign(g, { type: it.type, cat: it.cat, conf: it.conf === 'high' ? 'high' : 'low', src: 'ai' }); }
    } catch (e) { console.error('AI-kategorisering misslyckades', e); }
  }
  for (const g of list) if (!g.type) Object.assign(g, fallbackCat(s, g));
  return list;
}

// Rader som ska sparas i transactions (samma form som appens import)
export function toRows(uid: string, groups: Obj[], s: Obj, firstId: number) {
  const out: Obj[] = []; let n = 0;
  for (const g of groups) for (const r of g.rows) {
    out.push({
      user_id: uid, id: firstId + n++, type: g.type, amount: storedAmount(g.type, r.raw), description: r.desc, category: g.cat,
      tx_date: r.date, month: periodForDate(r.date, s.pay_periods || []), account: r.account, source: 'bank', import_id: null,
      hash: 'eb:' + r.ref, mkey: g.mkey, extra: { bank_ref: r.ref, ...(g.conf === 'low' ? { review: true } : {}) }, deleted: false,
    });
  }
  return out;
}

// Säkra regler lärs in, så att samma butik inte behöver AI nästa natt (appen gör likadant vid import)
export function learnRules(s: Obj, groups: Obj[]) {
  const rules = { ...(s.merchant_rules || {}) }; let n = 0;
  for (const g of groups) if (g.src === 'ai' && g.conf === 'high' && !rules[g.mkey]) { rules[g.mkey] = { type: g.type, cat: g.cat, t: Date.now() }; n++; }
  return n ? rules : null;
}

// Från vilket datum transaktioner hämtas: överlapp med förra hämtningen, annars ett år bakåt
export const fetchFrom = (lastDate?: string) => (lastDate ? addDays(lastDate, -7) : addDays(today(), -365));

// Bolånet: dragningar från ett konto med rollen mortgage. "AMORTERING" sänker skulden, "RÄNTA" sparas
// som senaste räntekostnad. Lånet hittas via extra.pay_account (eller det enda lånet). Returnerar
// { balances: [{loan_id, bal_date, value}], interest: {loan_id: {date, amount}} }.
export function loanUpdates(rows: Obj[], loans: Obj[], accOf: (id: string) => Obj | undefined) {
  const balances: Obj[] = []; const interest: Obj = {};
  const last: Obj = {};
  for (const l of loans) { const h = [...(l.history || [])].sort((a, b) => a.date.localeCompare(b.date)); last[l.id] = h[h.length - 1] || null; }
  const sorted = [...rows].sort((a, b) => a.tx_date.localeCompare(b.tx_date));
  for (const r of sorted) {
    if (accOf(r.account)?.role !== 'mortgage' || r.deleted) continue;
    const raw = r.type === 'income' || r.type === 'transfer' ? Number(r.amount) : -Number(r.amount);
    if (!(raw < 0)) continue;
    const desc = String(r.description || '');
    // Lånedelen: lånenumret i texten (SEB: "LÅN 48500366"), annars lånet som dras från kontot eller det enda lånet
    const nums = desc.match(/\d{6,}/g) || [];
    const byRef = loans.find((l) => l.reference && nums.includes(String(l.reference).replace(/\D/g, '')));
    const loan = byRef || loans.find((l) => l.extra?.pay_account === r.account && loans.filter((x) => x.extra?.pay_account === r.account).length === 1) || (loans.length === 1 ? loans[0] : null);
    if (!loan) continue;
    if (byRef && !/amort|r[äa]nt/i.test(desc)) {
      // Ränta + amortering i en dragning: räntan räknas från skulden och räntesatsen, resten är amortering
      const prev = last[loan.id]; if (!prev || prev.date > r.tx_date || loan.interest_pct == null) continue;
      const int = Math.round((prev.value * Number(loan.interest_pct)) / 100 / 12);
      const amort = Math.max(0, -raw - int);
      interest[loan.id] = { date: r.tx_date, amount: Math.min(int, -raw), estimated: true };
      if (amort > 0) { const next = { date: r.tx_date, value: Math.max(0, Math.round((prev.value - amort) * 100) / 100) }; balances.push({ loan_id: loan.id, bal_date: next.date, value: next.value }); last[loan.id] = next; }
      continue;
    }
    if (/amort/i.test(desc)) {
      const prev = last[loan.id]; if (!prev || prev.date > r.tx_date) continue; // ingen känd skuld före dragningen
      const next = { date: r.tx_date, value: Math.max(0, Math.round((prev.value + raw) * 100) / 100) };
      balances.push({ loan_id: loan.id, bal_date: next.date, value: next.value }); last[loan.id] = next;
    } else if (/r[äa]nt/i.test(desc)) interest[loan.id] = { date: r.tx_date, amount: -raw };
  }
  return { balances, interest };
}
