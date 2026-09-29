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
  // Delar av en uppdelad transaktion (extra.parent_id) jämförs inte: originalet har bankreferensen
  const pool = existing.filter((r) => !r.extra?.bank_ref && !r.deleted && !r.extra?.parent_id).map((r) => ({ raw: Math.round(rawOf(r) * 100), date: r.tx_date, used: false }));
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
    if (rules[g.mkey]?.tags?.length) g.tags = [...rules[g.mkey].tags]; // regler kan sätta taggar (även när kontorollen avgör kategorin)
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
      hash: 'eb:' + r.ref, mkey: g.mkey, extra: { bank_ref: r.ref, ...(g.conf === 'low' ? { review: true } : {}), ...(g.tags?.length ? { tags: g.tags } : {}) }, deleted: false,
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

// Bolånebetalningen delas i ränta (utgift, "Boende (Lån)") och amortering (sparande, "Amortering"), så att
// sparkvoten stämmer. Matchas: pengar till kontot som lånen dras från (loans.extra.pay_account, kontots nummer
// i texten) med ett belopp nära ränta (skuld × ränta / 12) + amortering (±5 %, minst 100 kr).
// Samma modell som MCP-verktyget split_transaction: originalraden markeras borttagen med extra.split_into och
// delarna får extra.parent_id. Räntan = beloppet − amorteringen, så att delarna summerar exakt.
export const AMORT_CAT = 'Amortering';
export function mortgageSplit(amount: number, loans: Obj[]) {
  let interest = 0, amort = 0;
  for (const l of loans) {
    const h = [...(l.history || [])].sort((a, b) => a.date.localeCompare(b.date)); const d = h[h.length - 1];
    if (d && l.interest_pct != null) interest += Math.round((d.value * Number(l.interest_pct)) / 100 / 12);
    amort += Number(l.amortization) || 0;
  }
  const expected = interest + amort;
  if (!(expected > 0) || !(amort > 0) || Math.abs(amount - expected) > Math.max(100, expected * 0.05)) return null;
  return { interest: Math.round((amount - amort) * 100) / 100, amortization: amort, expected };
}
export function splitMortgageRows(s: Obj, rows: Obj[], loans: Obj[], nextId: () => number) {
  const pay = new Map<string, Obj[]>();
  for (const l of loans) if (l.extra?.pay_account) pay.set(l.extra.pay_account, [...(pay.get(l.extra.pay_account) || []), l]);
  if (!pay.size || !(s.cats_sav || DEF.cats_sav).includes(AMORT_CAT)) return { rows, split: 0 };
  const byNumber = new Map<string, string>();
  for (const a of s.accounts || []) if (pay.has(a.id) && a.number) byNumber.set(String(a.number).replace(/\D/g, ''), a.id);
  const out: Obj[] = []; let split = 0;
  for (const r of rows) {
    const target = byNumber.get(descNumber(r.description) || '');
    const amount = r.type === 'expense' ? Number(r.amount) : -Number(r.amount);
    const sp = target && target !== r.account && !r.deleted && !r.extra?.parent_id && amount > 0 ? mortgageSplit(amount, pay.get(target)!) : null;
    if (!sp) { out.push(r); continue; }
    const cats = (s.cats_exp || DEF.cats_exp) as string[];
    const base = { ...r, hash: null, extra: { parent_id: r.id, split_of: 2, ...(r.mkey ? { split_mkey: r.mkey } : {}), via: 'bank' } };
    const a = { ...base, id: nextId(), type: 'expense', category: cats.includes('Boende (Lån)') ? 'Boende (Lån)' : r.category, amount: sp.interest, extra: { ...base.extra, split_index: 1, part: 'ränta' } };
    const b = { ...base, id: nextId(), type: 'savings', category: AMORT_CAT, amount: sp.amortization, extra: { ...base.extra, split_index: 2, part: 'amortering' } };
    out.push({ ...r, deleted: true, extra: { ...(r.extra || {}), split_into: [a.id, b.id], split: { interest: sp.interest, amortization: sp.amortization } } }, a, b);
    split++;
  }
  return { rows: out, split };
}

// ── Sparande utifrån kontotyp (ersätter regler för flyttar mellan egna konton) ──────────────────────
// Kontoklass: vanligt (bank, card), sparkonto (savings, investment) eller passage (kind "passage" eller
// rollen mortgage: bolånekontot, alltid neutralt). Motparten avgörs av (i ordning): uttryckligt motkonto
// (extra.from_account / to_account), paret (extra.transfer_pair_id eller samma belopp med motsatt tecken inom
// 3 dagar), kontonumret i texten (accounts[].number) och motpartstext (accounts[].match, t.ex. "AVANZA BANK").
//   vanligt → sparkonto = +sparande (sparkontots sav_cat)     sparkonto → vanligt = −sparande
//   sparkonto → sparkonto = neutral                           vanligt → vanligt = neutral
// Sparandet räknas på det vanliga kontots sida; saknas den i datan räknas det på sparkontots sida.
// Undantag som behålls: pengar till kontot som betalar kreditkortet (utgift "AMEX (väntande)"), pengar till
// bolånekontot (utgift/uppdelning ränta + Amortering), delar av uppdelade rader och kategorin Amortering.
// Rader utan motpart (t.ex. äldre sparrader utan text) ändras inte.
export const OWN_TRF = 'Egen överföring';
export function accClass(a: Obj | null | undefined) {
  if (!a) return null;
  if (a.kind === 'passage' || a.role === 'mortgage') return 'passage';
  return a.kind === 'savings' || a.kind === 'investment' ? 'saving' : 'regular';
}
const digitsOf = (v: any) => String(v || '').replace(/\D/g, '');
function transferLike(r: Obj, owner: string) {
  if (r.deleted || r.extra?.parent_id || r.extra?.split_into) return false;
  if (r.type === 'transfer' || r.type === 'savings') return true;
  const d = String(r.description || '').toUpperCase();
  return !!descNumber(r.description) || (owner.length >= 5 && d.startsWith(owner.slice(0, Math.min(owner.length, 12))));
}
// Par av egna överföringar: befintliga transfer_pair_id först, sedan samma belopp (motsatt tecken) på olika konton inom 3 dagar.
// Kontot som betalar kortet (role card_payment, AMEX-kontot) får bara pengar från egna konton: en insättning där paras
// även med en utgående rad som inte ser ut som en överföring (eget meddelande, t.ex. "VIN FARMOR"), om den är ensam om beloppet.
export function pairTransfers(rows: Obj[], owner = '', accounts: Obj[] = []) {
  const pair = new Map<number, Obj>();
  const byId = new Map(rows.map((r) => [Number(r.id), r]));
  for (const r of rows) { const p = byId.get(Number(r.extra?.transfer_pair_id)); if (p && !r.deleted && !p.deleted) { pair.set(Number(r.id), p); pair.set(Number(p.id), r); } }
  const cand = rows.filter((r) => !pair.has(Number(r.id)) && transferLike(r, owner)).sort((a, b) => a.tx_date.localeCompare(b.tx_date) || Number(a.id) - Number(b.id));
  for (const r of cand) {
    if (pair.has(Number(r.id))) continue;
    const c = Math.round(rawOf(r) * 100);
    const hits = cand.filter((o) => o !== r && !pair.has(Number(o.id)) && o.account !== r.account && Math.round(rawOf(o) * 100) === -c && dayDiff(o.tx_date, r.tx_date) <= 3);
    if (hits.length === 1) { pair.set(Number(r.id), hits[0]); pair.set(Number(hits[0].id), r); }
  }
  const cardPay = new Set(accounts.filter((a) => a.role === 'card_payment').map((a) => a.id));
  const free = (r: Obj) => !pair.has(Number(r.id)) && !r.deleted && !r.extra?.parent_id && !r.extra?.split_into;
  for (const r of rows.filter((x) => free(x) && cardPay.has(x.account) && rawOf(x) > 0 && transferLike(x, owner))) {
    const c = Math.round(rawOf(r) * 100);
    const hits = rows.filter((o) => o !== r && free(o) && o.account !== r.account && !cardPay.has(o.account) && Math.round(rawOf(o) * 100) === -c && dayDiff(o.tx_date, r.tx_date) <= 3);
    if (hits.length === 1) { pair.set(Number(r.id), hits[0]); pair.set(Number(hits[0].id), r); }
  }
  return pair;
}
export function counterpartyOf(r: Obj, accounts: Obj[], partner?: Obj | null) {
  const x = r.extra || {}, raw = rawOf(r);
  const explicit = raw < 0 ? x.to_account : x.from_account;
  if (explicit) return accounts.find((a) => a.id === explicit) || null;
  if (partner) return accounts.find((a) => a.id === partner.account) || null;
  const num = descNumber(r.description);
  if (num) { const a = accounts.find((a) => a.id !== r.account && a.number && digitsOf(a.number) === num); if (a) return a; }
  const d = String(r.description || '').toUpperCase();
  return accounts.find((a) => a.id !== r.account && (a.match || []).some((p: string) => p && d.includes(String(p).toUpperCase()) && !d.startsWith('K*'))) || null;
}
// Returnerar ändringar [{id, before, after, why}] och vilka par som ska länkas. Muterar inte rows.
export function applySavingsModel(rows: Obj[], s: Obj) {
  const accounts: Obj[] = s.accounts || [];
  const owner = String(s.owner_name || '').toUpperCase().replace(/\s+/g, ' ').trim();
  const accOf = (id: string) => accounts.find((a) => a.id === id);
  const sav = (s.cats_sav || DEF.cats_sav) as string[];
  const savCat = (a: Obj) => (a.sav_cat && sav.includes(a.sav_cat) ? a.sav_cat : sav.includes('Annat') ? 'Annat' : sav[0]);
  const pair = pairTransfers(rows, owner, accounts);
  const changes: Obj[] = [];
  for (const r of rows) {
    if (r.deleted || r.extra?.parent_id || r.extra?.split_into || (r.type === 'savings' && r.category === 'Amortering')) continue;
    const X = accOf(r.account), partner = pair.get(Number(r.id)) || null, Y = counterpartyOf(r, accounts, partner);
    if (!X || !Y) continue;
    const raw = rawOf(r), cx = accClass(X), cy = accClass(Y);
    let after: Obj | null = null, why = '';
    const neutral = { type: 'transfer', category: OWN_TRF, amount: raw };
    if (cx === 'passage') { after = neutral; why = `${X.name} är ett passagekonto (alltid neutralt)`; }
    else if (cy === 'passage') continue;                                          // bolånebetalning: utgift/uppdelning som idag
    else if (raw < 0 && Y.role === 'card_payment') {
      // Pengar till kontot som betalar kortet (AMEX-kontot) = kortköp som väntar på fakturan: AMEX (väntande), oavsett
      // vad meddelandet säger (motparten avgörs av paret eller kontonumret). Redan avräknade (Kreditkortsbetalning) rörs inte.
      if (X.role === 'card_payment' || (r.type === 'transfer' && r.category === 'Kreditkortsbetalning')) continue;
      if (!((s.cats_exp || DEF.cats_exp) as string[]).includes(PENDING_CARD_CAT)) continue;
      after = { type: 'expense', category: PENDING_CARD_CAT, amount: -raw }; why = `till ${Y.name}: kortköp som väntar på fakturan`;
    }
    else if (cx === 'regular' && cy === 'saving') { after = { type: 'savings', category: savCat(Y), amount: -raw }; why = `${raw < 0 ? 'till' : 'från'} sparkontot ${Y.name}`; }
    else if (cx === 'saving' && cy === 'regular') {
      const regularLegInData = partner && partner.account === Y.id;
      if (regularLegInData) { after = neutral; why = `räknas på ${Y.name}s sida`; }
      else { after = { type: 'savings', category: savCat(X), amount: raw }; why = `${raw < 0 ? 'uttag' : 'insättning'} (${Y.name}s sida saknas i datan)`; }
    } else { after = neutral; why = cx === 'saving' ? 'mellan två sparkonton' : 'mellan två vanliga konton'; }
    const pid = partner ? Number(partner.id) : null;
    const same = after.type === r.type && after.category === r.category && Math.round(Number(after.amount) * 100) === Math.round(Number(r.amount) * 100);
    const needPair = pid != null && Number(r.extra?.transfer_pair_id) !== pid;
    if (same && !needPair) continue;
    changes.push({ id: Number(r.id), month: r.month, tx_date: r.tx_date, account: r.account, description: r.description,
      before: { type: r.type, category: r.category, amount: Number(r.amount) }, after: same ? { type: r.type, category: r.category, amount: Number(r.amount) } : after,
      ...(needPair ? { pair_id: pid } : {}), ...(!same && r.extra?.review ? { clear_review: true } : {}), counterparty: Y.id, why });
  }
  return changes;
}
// Sparande per löneperiod före och efter ändringarna (för förhandsgranskningen)
export function savingsByPeriod(rows: Obj[], changes: Obj[]) {
  const ch = new Map(changes.map((c) => [c.id, c]));
  const out: Obj = {};
  for (const r of rows) {
    if (r.deleted) continue;
    const c = ch.get(Number(r.id));
    const b = r.type === 'savings' ? Number(r.amount) : 0, a = c ? (c.after.type === 'savings' ? Number(c.after.amount) : 0) : b;
    if (!b && !a) continue;
    const o = (out[r.month] ||= { period: r.month, before: 0, after: 0 });
    o.before += b; o.after += a;
  }
  return Object.values(out).map((o: Obj) => ({ ...o, before: Math.round(o.before), after: Math.round(o.after), diff: Math.round(o.after - o.before) })).sort((x: Obj, y: Obj) => x.period.localeCompare(y.period));
}
