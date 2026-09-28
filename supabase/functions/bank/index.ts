// Bankkoppling via Enable Banking (PSD2): BankID-samtycke, hämtning av saldon och transaktioner.
//   POST /bank/start     {aspsp, return_to}  (inloggad)  → {url} till bankens BankID-sida
//   GET  /bank/callback  ?code&state         (från banken) → sparar sessionen, hämtar, skickar tillbaka till appen
//   POST /bank/sync                          (inloggad)  → hämtar nytt för användarens kopplingar
//   POST /bank/cron      x-cron-secret                   → hämtar för alla (nattjobbet)
// Secrets: ENABLEBANKING_APP_ID, ENABLEBANKING_KEY_B64 (appens .pem i base64), ANTHROPIC_API_KEY, CRON_SECRET.
// Driftsätt: npx supabase functions deploy bank --no-verify-jwt   (inloggningen kontrolleras här)
// deno-lint-ignore-file no-explicit-any
import { createClient } from 'npm:@supabase/supabase-js@2';
import { type Obj, CAT_KEY, DEF, numberKind, descNumber, today, addDays, periodForDate, periodRange } from '../_shared/finance.ts';
import { sendPush } from '../_shared/push.ts';
import { buildDigest } from './notify.ts';
import { pickBalance, mapTx, dedupe, overlap, newAppAccount, categorize, toRows, learnRules, fetchFrom, markSavingsWithdrawals, loanUpdates } from './core.ts';

const APP_URL = 'https://augustnerpin.github.io/privatekonomi2/';
const EB = 'https://api.enablebanking.com';
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type' };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...CORS, 'content-type': 'application/json' } });

function secretKey() {
  try { const k = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}'); if (k.default) return k.default as string; } catch { /* äldre projekt */ }
  return Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
}
const db = createClient(Deno.env.get('SUPABASE_URL')!, secretKey(), { auth: { persistSession: false, autoRefreshToken: false } });
async function must<T>(p: PromiseLike<{ data: T; error: any }>): Promise<T> { const { data, error } = await p; if (error) throw new Error('Databasfel: ' + (error.message || error)); return data; }

// ── Enable Banking: JWT signerad med appens privata nyckel ─────────────
const b64url = (b: Uint8Array | string) => btoa(typeof b === 'string' ? unescape(encodeURIComponent(b)) : String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
let keyP: Promise<CryptoKey> | null = null;
function privateKey() {
  keyP ??= (async () => {
    const pem = atob(Deno.env.get('ENABLEBANKING_KEY_B64') || '');
    const der = Uint8Array.from(atob(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')), (c) => c.charCodeAt(0));
    return crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  })();
  return keyP;
}
async function ebJwt() {
  const now = Math.floor(Date.now() / 1000);
  const data = b64url(JSON.stringify({ typ: 'JWT', alg: 'RS256', kid: Deno.env.get('ENABLEBANKING_APP_ID') })) + '.' +
    b64url(JSON.stringify({ iss: 'enablebanking.com', aud: 'api.enablebanking.com', iat: now, exp: now + 3600 }));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', await privateKey(), new TextEncoder().encode(data));
  return data + '.' + b64url(new Uint8Array(sig));
}
class EbError extends Error { constructor(public status: number, msg: string) { super(msg); } }
async function eb(method: string, path: string, body?: Obj, psu?: { ip?: string; ua?: string }) {
  const headers: Obj = { Authorization: 'Bearer ' + await ebJwt(), 'Content-Type': 'application/json' };
  if (psu?.ip) headers['Psu-Ip-Address'] = psu.ip;
  if (psu?.ua) headers['Psu-User-Agent'] = psu.ua;
  const r = await fetch(EB + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j: any; try { j = JSON.parse(t); } catch { j = { raw: t }; }
  if (!r.ok) throw new EbError(r.status, `Enable Banking ${r.status}: ${j.message || j.detail || j.error || t.slice(0, 200)}`);
  return j;
}

// ── Användarens inställningar ──────────────────────────────────────────
const STATE_KEYS = ['accounts', 'merchant_rules', 'pay_periods', 'owner_name', 'contact_names', 'ai_memory', 'ai_import_notes', 'cat_budgets', ...Object.values(CAT_KEY) as string[]];
async function loadState(uid: string) {
  const rows = await must<Obj[]>(db.from('user_state').select('key,value').eq('user_id', uid).eq('deleted', false).in('key', STATE_KEYS));
  const s: Obj = {};
  for (const k of STATE_KEYS) { const r = rows.find((x) => x.key === k); s[k] = r && r.value != null ? r.value : structuredClone(DEF[k]); }
  if (!Array.isArray(s.accounts) || !s.accounts.length) s.accounts = structuredClone(DEF.accounts);
  return s;
}
const saveState = (uid: string, key: string, value: unknown) => must(db.from('user_state').upsert({ user_id: uid, key, value, deleted: false }, { onConflict: 'user_id,key' }));

async function userFrom(req: Request) {
  const jwt = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!jwt) return null;
  const { data } = await db.auth.getUser(jwt);
  return data?.user?.id || null;
}

// ── AI-kategorisering (samma riktlinjer som importen i appen, kortare) ─
async function aiCategorize(s: Obj, groups: Obj[]) {
  const key = Deno.env.get('ANTHROPIC_API_KEY'); if (!key) return [];
  const TL: Obj = { expense: 'Utgift', income: 'Inkomst', savings: 'Sparande', transfer: 'Överföring' };
  const examples = Object.entries(s.merchant_rules || {}).sort((a: any, b: any) => (b[1].t || 0) - (a[1].t || 0)).slice(0, 60)
    .map(([k, v]: any) => `${k.split('|')[0]} → ${TL[v.type]}: ${v.cat}`).join('\n');
  const notes = (s.ai_import_notes || []).map((n: Obj) => (n.q ? `- Fråga: ${n.q}\n  Svar: ${n.a}` : `- ${n.a}`)).join('\n');
  const system = `Du kategoriserar banktransaktioner för en svensk privatperson. Varje rad är en butik/mottagare. Välj type och cat; cat MÅSTE vara exakt en av kategorierna för vald type:
- expense (konsumtion): ${s.cats_exp.join(' | ')}
- income: ${s.cats_inc.join(' | ')}
- savings (till/från egna spar- och investeringskonton): ${s.cats_sav.join(' | ')}
- transfer (räknas inte): ${s.cats_trf.join(' | ')}
Riktlinjer: kreditkortsfakturan (AMEX, Eurocard) → transfer "Kreditkortsbetalning". Eget namn${s.owner_name ? ` ("${s.owner_name}")` : ''} eller rena kontonummer → transfer "Egen överföring" (conf low för kontonummer). Avanza/Nordnet/ISK/fonder → savings. Lön → "Lön". Mataffärer → "Mat (Butik)"; restauranger/caféer → "Mat (Ute)"; barer/Systembolaget → "Fest". Streaming/appar → "Prenumerationer". Taxi/parkering/drivmedel → "Transport/Parkering". BRF/HSB → "Boende (Avgift)"; bolån → "Boende (Lån)"; el/bredband/försäkring → "Boende (Resterande)". Returer ("in" från butik) → expense i samma kategori. Swish mobilnummer → "${'Swish (privat)'}". conf "low" när du är osäker. Hitta aldrig på kategorier.${notes ? `\nANVÄNDARENS FÖRKLARINGAR (går före riktlinjerna):\n${notes}` : ''}${(s.ai_memory || []).length ? `\nVad du vet om användaren:\n${s.ai_memory.slice(-20).join('\n')}` : ''}${examples ? `\nAnvändarens tidigare val (följ samma stil):\n${examples}` : ''}`;
  const kindLbl: Obj = { mobil: 'mobil', swishforetag: 'swishföretag', konto: 'kontonummer' };
  const lines = groups.map((g, k) => `${k}|${g.dir}|${g.accKind === 'card' ? 'kort' : 'bank'}|${kindLbl[numberKind(descNumber(g.desc)) || ''] || 'text'}|${g.rows.length}st|${Math.round(Math.abs(g.total))} kr|${g.desc}${s.contact_names?.[descNumber(g.desc) || ''] ? ` (= ${s.contact_names[descNumber(g.desc)!]})` : ''}`).join('\n');
  const schema = { type: 'object', additionalProperties: false, required: ['items'], properties: { items: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['k', 'type', 'cat', 'conf'], properties: { k: { type: 'integer' }, type: { type: 'string', enum: ['expense', 'income', 'savings', 'transfer'] }, cat: { type: 'string' }, conf: { type: 'string', enum: ['high', 'low'] } } } } } };
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 8000, output_config: { effort: 'low', format: { type: 'json_schema', schema } }, system, messages: [{ role: 'user', content: `k|riktning|konto|typ|antal|summa|beskrivning\n${lines}` }] }),
  });
  const j = await r.json(); if (!r.ok) throw new Error(j.error?.message || 'HTTP ' + r.status);
  const text = (j.content || []).filter((b: Obj) => b.type === 'text').map((b: Obj) => b.text).join('');
  return JSON.parse(text).items || [];
}

// ── Hämtning för en användare ──────────────────────────────────────────
// psu = användarens IP och webbläsare när hen själv startar hämtningen ("Hämta nu", BankID-retur).
// Då räknas anropen inte mot bankens gräns på ungefär 4 hämtningar per dygn utan användaren.
type Psu = { ip?: string; ua?: string } | undefined;
export const psuFrom = (req: Request): Psu => ({ ip: (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || undefined, ua: req.headers.get('user-agent') || undefined });
async function fetchAllTx(uid: string, from: string, psu: Psu) {
  const out: Obj[] = []; let ck: string | undefined;
  for (let page = 0; page < 50; page++) {
    const q = new URLSearchParams({ date_from: from, transaction_status: 'BOOK' }); if (ck) q.set('continuation_key', ck);
    const j = await eb('GET', `/accounts/${uid}/transactions?${q}`, undefined, psu);
    out.push(...(j.transactions || [])); ck = j.continuation_key; if (!ck) break;
  }
  return out;
}
async function pages(make: () => any) {
  const out: Obj[] = [];
  for (let i = 0; ; i += 1000) { const rows = await must<Obj[]>(make().range(i, i + 999)); out.push(...rows); if (rows.length < 1000) break; }
  return out;
}
// Befintliga rader att jämföra med: allt på kontot från 15 dagar före from (köpdatum kan ligga upp till
// 10 dagar före bokföringen, dubblettkontrollen tillåter ±4) och kontots alla bankreferenser oavsett datum,
// även borttagna, så att bankrader du tagit bort inte läggs in igen.
async function existingRows(uid: string, account: string, fromDate: string) {
  const near = await pages(() => db.from('transactions').select('id,type,amount,tx_date,extra,deleted').eq('user_id', uid).eq('account', account).gte('tx_date', addDays(fromDate, -15)).order('id'));
  const refs = await pages(() => db.from('transactions').select('id,extra,deleted').eq('user_id', uid).eq('account', account).like('hash', 'eb:%').order('id'));
  return [...near, ...refs];
}
async function loadKey(uid: string, key: string) {
  const r = await must<Obj[]>(db.from('user_state').select('value').eq('user_id', uid).eq('key', key).eq('deleted', false));
  return r[0]?.value ?? null;
}
// Lån med skuldhistorik (tabellerna loans + loan_balances, samma som appen och MCP-servern)
async function loadLoansFor(uid: string) {
  const loans = await must<Obj[]>(db.from('loans').select('*').eq('user_id', uid).eq('deleted', false));
  if (!loans.length) return [];
  const bal = await pages(() => db.from('loan_balances').select('loan_id,bal_date,value').eq('user_id', uid).eq('deleted', false).order('bal_date'));
  return loans.map((l) => ({ ...l, history: bal.filter((b) => b.loan_id === l.id).map((b) => ({ date: b.bal_date, value: Number(b.value) })) }));
}
// Amortering från bolånekontot sänker skulden; räntedragningen sparas som senaste räntekostnad
async function applyLoanUpdates(uid: string, rows: Obj[], s: Obj) {
  const loans = await loadLoansFor(uid); if (!loans.length) return;
  const u = loanUpdates(rows, loans, (id) => s.accounts.find((x: Obj) => x.id === id));
  if (u.balances.length) await must(db.from('loan_balances').upsert(u.balances.map((b) => ({ ...b, user_id: uid, deleted: false })), { onConflict: 'user_id,loan_id,bal_date' }));
  for (const [id, last_interest] of Object.entries(u.interest)) {
    const l = loans.find((x) => x.id === id);
    await must(db.from('loans').update({ extra: { ...(l?.extra || {}), last_interest } }).eq('user_id', uid).eq('id', id));
  }
}
// En hämtning i taget per användare (nattjobb och "Hämta nu" kan annars lägga in samma rader två gånger)
const lock = async (uid: string) => (await db.rpc('bank_try_lock', { p_user: uid, p_secs: 300 })).data === true;
const unlock = (uid: string) => db.rpc('bank_unlock', { p_user: uid });

export async function syncUser(uid: string, psu?: Psu) {
  if (!(await lock(uid))) return { busy: true, added: 0, review: 0, accounts: [], rows: [], state: null };
  try { return await syncLocked(uid, psu); } finally { await unlock(uid); }
}
async function syncLocked(uid: string, psu: Psu) {
  const conns = await must<Obj[]>(db.from('bank_connections').select('*').eq('user_id', uid).eq('status', 'active'));
  const s = await loadState(uid);
  const summary: Obj[] = []; const newRows: Obj[] = []; const connUpdates: Obj[] = [];
  const newAccounts: Obj[] = []; const balances: Obj = {};
  for (const c of conns) {
    if (Date.parse(c.valid_until) < Date.now()) { connUpdates.push({ id: c.id, patch: { status: 'expired' } }); summary.push({ bank: c.aspsp, expired: true }); continue; }
    try {
      for (const a of c.accounts as Obj[]) {
        // Aldrig före kopplingens startdatum: äldre transaktioner i appen (manuella och importerade) rörs inte
        const from = a.last_date ? fetchFrom(a.last_date) : (c.start_date || fetchFrom());
        const fetched = ((await fetchAllTx(a.uid, from, psu)).map(mapTx).filter(Boolean) as Obj[]).filter((t) => !c.start_date || t.date >= c.start_date);
        // Första gången: vilket konto i appen hör bankkontot till? Det med flest redan importerade rader.
        if (!a.app_account) {
          let best: Obj | null = null;
          for (const acc of s.accounts.filter((x: Obj) => x.kind !== 'card' && !(c.accounts as Obj[]).some((y) => y.app_account === x.id))) {
            const n = overlap(fetched, await existingRows(uid, acc.id, from));
            if (n >= 3 && (!best || n > best.n)) best = { id: acc.id, n };
          }
          if (best) a.app_account = best.id;
          else { const na = newAppAccount({ ...a, aspsp: c.aspsp }, s.accounts); s.accounts.push(na); newAccounts.push(na); a.app_account = na.id; }
        }
        const acc = s.accounts.find((x: Obj) => x.id === a.app_account);
        const { fresh, dups } = dedupe(fetched, await existingRows(uid, a.app_account, from));
        fresh.forEach((t) => (t.account = a.app_account));
        newRows.push(...fresh);
        const bal = pickBalance((await eb('GET', `/accounts/${a.uid}/balances`, undefined, psu)).balances);
        if (bal) balances[a.app_account] = bal;
        const dates = fetched.map((t) => t.bookingDate).sort();
        if (dates.length) a.last_date = dates[dates.length - 1];
        summary.push({ bank: c.aspsp, account: acc?.name || a.app_account, fetched: fetched.length, new: fresh.length, duplicates: dups, balance: bal?.value ?? null });
      }
      connUpdates.push({ id: c.id, patch: { accounts: c.accounts, last_sync: new Date().toISOString(), last_error: null } });
    } catch (e) {
      const expired = e instanceof EbError && (e.status === 401 || e.status === 403);
      // Kontona som hann hämtas sparas ändå (deras rader läggs in nedan); övriga försöker igen nästa gång
      connUpdates.push({ id: c.id, patch: { accounts: c.accounts, last_error: String((e as Error).message).slice(0, 500), ...(expired ? { status: 'expired' } : {}) } });
      summary.push({ bank: c.aspsp, error: (e as Error).message, expired });
    }
  }
  // 1. Nya rader. Går något fel här sparas inget av nedanstående, så nästa hämtning tar samma rader igen.
  let added = 0, review = 0, saved: Obj[] = [], learned: Obj | null = null;
  if (newRows.length) {
    const accOf = (id: string) => s.accounts.find((x: Obj) => x.id === id);
    const groups = await categorize(s, newRows, accOf, (g) => aiCategorize(s, g));
    const top = await must<Obj[]>(db.from('transactions').select('id').eq('user_id', uid).order('id', { ascending: false }).limit(1));
    const rows = toRows(uid, groups, s, Math.max((top[0]?.id || 0) + 1, Date.now()));
    markSavingsWithdrawals(s, rows, accOf);
    for (let i = 0; i < rows.length; i += 500) await must(db.from('transactions').insert(rows.slice(i, i + 500)));
    added = rows.length; review = rows.filter((r) => r.extra.review).length; saved = rows;
    learned = learnRules(s, groups);
    await applyLoanUpdates(uid, rows, s).catch((e) => console.error('Lån:', e));
  }
  // 2. Kontolista och regler: läses om och slås ihop, så att ändringar gjorda i appen under tiden inte skrivs över
  if (newAccounts.length || Object.keys(balances).length) {
    const fresh: Obj[] = Array.isArray(await loadKey(uid, 'accounts')) ? await loadKey(uid, 'accounts') : structuredClone(s.accounts);
    for (const na of newAccounts) if (!fresh.some((x) => x.id === na.id)) fresh.push(na);
    let changed = newAccounts.length > 0;
    for (const [id, bal] of Object.entries(balances) as [string, Obj][]) {
      await must(db.from('account_balances').upsert({ user_id: uid, account: id, bal_date: bal.date, value: bal.value, source: 'bank', deleted: false }, { onConflict: 'user_id,account,bal_date' }));
      const f = fresh.find((x) => x.id === id);
      if (f && (!f.balance || f.balance.date < bal.date || (f.balance.date === bal.date && f.balance.value !== bal.value))) { f.balance = { value: bal.value, date: bal.date }; changed = true; }
    }
    if (changed) await saveState(uid, 'accounts', fresh);
    s.accounts = fresh;
  }
  if (learned) {
    const fresh = (await loadKey(uid, 'merchant_rules')) || {};
    let n = 0; for (const [k, v] of Object.entries(learned)) if (!fresh[k]) { fresh[k] = v; n++; }
    if (n) await saveState(uid, 'merchant_rules', fresh);
  }
  // 3. Sist: var hämtningen kom (last_date). Sparas först när raderna ovan är sparade.
  for (const u of connUpdates) await must(db.from('bank_connections').update(u.patch).eq('id', u.id));
  return { added, review, accounts: summary, rows: saved, state: s };
}
const pub = (r: Obj) => ({ added: r.added, review: r.review, accounts: r.accounts });

// ── Notiser (Web Push) ─────────────────────────────────────────────────
function vapid() {
  const jwk = Deno.env.get('VAPID_PRIVATE_JWK'), pub = Deno.env.get('VAPID_PUBLIC');
  return jwk && pub ? { jwk: JSON.parse(jwk), pub, subject: APP_URL } : null;
}
// Skickar till användarens enheter; borttagna prenumerationer (404/410) rensas
async function pushTo(uid: string, msg: Obj) {
  const v = vapid(); if (!v) return { sent: 0, error: 'VAPID-nycklar saknas på servern' };
  const subs = await must<Obj[]>(db.from('push_subscriptions').select('*').eq('user_id', uid));
  let sent = 0; const errors: string[] = [];
  for (const sub of subs) {
    try {
      const r = await sendPush(sub, msg, v);
      if (r.status === 404 || r.status === 410) await must(db.from('push_subscriptions').delete().eq('id', sub.id));
      else if (r.status >= 200 && r.status < 300) { sent++; await must(db.from('push_subscriptions').update({ last_ok: new Date().toISOString() }).eq('id', sub.id)); }
      else errors.push(`${r.status} ${r.text}`);
    } catch (e) { errors.push((e as Error).message); }
  }
  return { sent, devices: subs.length, ...(errors.length ? { error: errors.join('; ') } : {}) };
}
// Nattens sammanfattning efter hämtningen
async function notify(uid: string, r: Obj) {
  const s = r.state, day = today();
  const pid = periodForDate(day, s.pay_periods || []), range = periodRange(pid, s.pay_periods || []);
  const exp: Obj[] = [];
  for (let i = 0; ; i += 1000) {
    const part = await must<Obj[]>(db.from('transactions').select('category,amount').eq('user_id', uid).eq('month', pid).eq('type', 'expense').eq('deleted', false).range(i, i + 999));
    exp.push(...part); if (part.length < 1000) break;
  }
  const spent: Obj = {}; for (const x of exp) spent[x.category] = (spent[x.category] || 0) + Number(x.amount);
  const conns = await must<Obj[]>(db.from('bank_connections').select('id,aspsp,valid_until,status').eq('user_id', uid).in('status', ['active', 'expired']));
  // Vilka av nattens händelser har redan skickats? (bara de aktuella nycklarna, så att listan aldrig kapas)
  const loans = await loadLoansFor(uid).catch(() => []);
  // Förmögenhetsmålet med måldatum (goal, goal_date) mot snittökningen i snapshotten
  let goal: Obj | undefined;
  const gdate = await loadKey(uid, 'goal_date');
  if (gdate) {
    const nws = await must<Obj[]>(db.from('net_worth_snapshots').select('period,total').eq('user_id', uid).eq('deleted', false).order('period'));
    const target = Number(await loadKey(uid, 'goal')) || 700000;
    if (nws.length) goal = { target, date: gdate, latest: nws[nws.length - 1], avg: nws.length > 1 ? (Number(nws[nws.length - 1].total) - Number(nws[0].total)) / (nws.length - 1) : null };
  }
  const input = { newRows: r.rows || [], spent, budgets: s.cat_budgets || {}, period: { id: pid, ...range }, today: day, conns, loans, goal };
  const all = buildDigest({ ...input, sent: new Set<string>() }); if (!all) return { sent: 0 };
  const sent = new Set((await must<Obj[]>(db.from('notifications').select('key').eq('user_id', uid).in('key', all.keys))).map((x) => x.key));
  const d = buildDigest({ ...input, sent });
  if (!d) return { sent: 0 };
  const out = await pushTo(uid, { title: d.title, body: d.body, url: APP_URL, tag: 'digest-' + day });
  if (out.sent) await must(db.from('notifications').upsert(d.keys.map((key) => ({ user_id: uid, key, title: d.title, body: d.body })), { onConflict: 'user_id,key' }));
  return out;
}

// ── Rutter ─────────────────────────────────────────────────────────────
const safeReturn = (u: unknown) => (typeof u === 'string' && (/^https:\/\/augustnerpin\.github\.io\//.test(u) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(u)) ? u : APP_URL);
const back = (to: string, params: Obj) => { const u = new URL(to); for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v)); return Response.redirect(u.toString(), 302); };

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const url = new URL(req.url); const route = url.pathname.split('/').filter(Boolean).pop();
  try {
    if (route === 'callback' && req.method === 'GET') {
      const state = url.searchParams.get('state') || '';
      const rows = /^[0-9a-f-]{36}$/i.test(state) ? await must<Obj[]>(db.from('bank_auth_states').select('*').eq('state', state)) : [];
      const st = rows[0];
      if (st) await must(db.from('bank_auth_states').delete().eq('state', state));
      if (!st || Date.now() - Date.parse(st.created_at) > 30 * 60e3) return back(APP_URL, { bank: 'error', msg: 'Inloggningen gick ut, försök igen' });
      const code = url.searchParams.get('code');
      if (!code) return back(st.return_to, { bank: 'error', msg: url.searchParams.get('error_description') || url.searchParams.get('error') || 'Avbrutet' });
      const ses = await eb('POST', '/sessions', { code });
      const accounts = (ses.accounts || []).map((a: Obj) => ({ uid: a.uid, name: a.name || null, product: a.product || null, iban: a.account_id?.iban || null, other: a.account_id?.other?.identification || null, currency: a.currency, cash_account_type: a.cash_account_type || null, hash: a.identification_hash || null, app_account: null }));
      // Behåll kontomappningen från en tidigare koppling till samma konton
      const prev = await must<Obj[]>(db.from('bank_connections').select('id,accounts,start_date').eq('user_id', st.user_id).eq('aspsp', st.aspsp));
      for (const a of accounts) { const old = prev.flatMap((p) => p.accounts).find((x: Obj) => x.hash && x.hash === a.hash); if (old) { a.app_account = old.app_account; a.last_date = old.last_date; } }
      if (prev.length) await must(db.from('bank_connections').update({ status: 'replaced' }).in('id', prev.map((p) => p.id)));
      // Hämta från den 1:a i innevarande månad (eller från samma dag som en tidigare koppling)
      const start_date = prev.map((p) => p.start_date).filter(Boolean).sort()[0] || today().slice(0, 8) + '01';
      await must(db.from('bank_connections').insert({ user_id: st.user_id, aspsp: st.aspsp, session_id: ses.session_id, start_date, valid_until: ses.access?.valid_until || new Date(Date.now() + 90 * 864e5).toISOString(), accounts }));
      const r = await syncUser(st.user_id, psuFrom(req));
      return back(st.return_to, { bank: 'ok', added: r.added });
    }
    if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    if (route === 'cron') {
      const secret = Deno.env.get('CRON_SECRET');
      if (!secret || req.headers.get('x-cron-secret') !== secret) return json({ error: 'Unauthorized' }, 401);
      const users = [...new Set((await must<Obj[]>(db.from('bank_connections').select('user_id').eq('status', 'active'))).map((r) => r.user_id))];
      const out: Obj = {};
      for (const u of users) {
        try {
          const r = await syncUser(u);
          out[u] = r.busy ? { busy: true } : { ...pub(r), push: await notify(u, r).catch((e) => ({ error: (e as Error).message })) };
        }
        catch (e) { out[u] = { error: (e as Error).message }; }
      }
      return json({ users: users.length, results: out });
    }
    const uid = await userFrom(req);
    if (!uid) return json({ error: 'Logga in i appen först' }, 401);
    if (route === 'start') {
      const body = await req.json().catch(() => ({}));
      const aspsp = String(body.aspsp || 'SEB');
      const list = (await eb('GET', '/aspsps?country=SE&psu_type=personal')).aspsps || [];
      const bank = list.find((a: Obj) => a.name.toLowerCase() === aspsp.toLowerCase());
      if (!bank) return json({ error: `Hittar inte ${aspsp}. Finns: ${list.map((a: Obj) => a.name).join(', ')}` }, 400);
      const secs = Math.min(bank.maximum_consent_validity || 90 * 86400, 180 * 86400);
      const state = crypto.randomUUID();
      await must(db.from('bank_auth_states').insert({ state, user_id: uid, aspsp: bank.name, return_to: safeReturn(body.return_to) }));
      const r = await eb('POST', '/auth', { access: { valid_until: new Date(Date.now() + secs * 1000 - 60e3).toISOString() }, aspsp: { name: bank.name, country: 'SE' }, state, redirect_url: Deno.env.get('SUPABASE_URL') + '/functions/v1/bank/callback', psu_type: 'personal' });
      return json({ url: r.url });
    }
    if (route === 'sync') {
      const r = await syncUser(uid, psuFrom(req));
      return r.busy ? json({ error: 'En hämtning pågår redan – försök igen om en stund' }, 409) : json(pub(r));
    }
    if (route === 'push-test') return json(await pushTo(uid, { title: 'Notiser är på ✓', body: 'Här hör appen av sig när lönen kommit, vid stora köp och när budgeten börjar ta slut.', url: APP_URL, tag: 'test' }));
    return json({ error: 'Okänd väg' }, 404);
  } catch (e) {
    console.error(e);
    if (route === 'callback') return back(APP_URL, { bank: 'error', msg: (e as Error).message.slice(0, 200) });
    return json({ error: (e as Error).message }, 500);
  }
});
