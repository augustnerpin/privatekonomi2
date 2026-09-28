// Inställningar skrivs aldrig över från en gammal lokal kopia: trevägssammanslagning + villkorad skrivning mot updated_at
// (mergeState3/saveMerged i functions/_shared/merge.ts och samma i appen: mergeState3/saveMergedApp/sbStateIo/sbApply).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeState3, saveMerged } from '../functions/_shared/merge.ts';
import { fakeDb } from './fakedb.mjs';
import { appFns } from './app.mjs';

const app = appFns(['SB_MERGE_SKIP', 'mergeState3', 'saveMergedApp', 'sbStateIo', 'sbFp']);
const clone = (x) => structuredClone(x);

// Kontolistan före och efter sparmodellens migrering (sav_cat, match, kind, number tillagda på servern)
const OLD = [
  { id: 'lonekonto', name: 'Lönekonto', kind: 'bank' },
  { id: 'seb_1dfa', name: 'Sparkonto (SEB)', kind: 'savings', number: '53293380441' },
  { id: 'klarna', name: 'Klarna', kind: 'savings', manual: true, balance: { value: 210825.03, date: '2026-09-28' } },
];
const NEW = [
  { id: 'lonekonto', name: 'Lönekonto', kind: 'bank', number: '53290207161' },
  { id: 'seb_1dfa', name: 'Sparkonto (SEB)', kind: 'savings', number: '53293380441', sav_cat: 'SEB' },
  { id: 'klarna', name: 'Klarna', kind: 'savings', manual: true, balance: { value: 210825.03, date: '2026-09-28' }, sav_cat: 'Klarna', match: ['KLARNA BANK'] },
];
const withBalance = (list, value, date) => clone(list).map((a) => (a.id === 'klarna' ? { ...a, balance: { value, date } } : a));

for (const [who, merge, save] of [['servern', mergeState3, saveMerged], ['appen', app.mergeState3, app.saveMergedApp]]) {
  test(`${who}: enhet A med gammal kopia utan sparkategori sparar Klarna-saldo – sparkategorierna försvinner inte`, async () => {
    const db = fakeDb({ user_state: [] });
    const io = app.sbStateIo(db, 'u1');
    // Enhet A synkade kontolistan före migreringen
    const t1 = await io.insert('accounts', clone(OLD));
    const baseA = { v: clone(OLD), at: t1 };
    // Migreringen på servern
    const t2 = await io.update('accounts', clone(NEW), t1);
    // Enhet B (uppdaterad) sparar ett nytt Klarna-saldo: ingen sammanslagning behövs
    const b = await save(io, 'accounts', withBalance(NEW, 190300, '2026-09-29'), { v: clone(NEW), at: t2 });
    assert.equal(b.merged, false);
    // Enhet A sparar ett saldo på sin gamla kopia (som appen gjorde 22:04)
    const a = await save(io, 'accounts', withBalance(OLD, 190300, '2026-09-29'), baseA);
    assert.equal(a.merged, true);
    const now = db.tables?.user_state?.[0]?.value ?? (await io.get('accounts')).value;
    const by = Object.fromEntries(now.map((x) => [x.id, x]));
    assert.equal(by.seb_1dfa.sav_cat, 'SEB');
    assert.equal(by.klarna.sav_cat, 'Klarna');
    assert.deepEqual(by.klarna.match, ['KLARNA BANK']);
    assert.equal(by.lonekonto.number, '53290207161');
    assert.deepEqual(by.klarna.balance, { value: 190300, date: '2026-09-29' });
    assert.deepEqual(now, withBalance(NEW, 190300, '2026-09-29'));
    // Bara det ändrade fältet: resultatet är serverns version + A:s saldo
    assert.deepEqual(merge(OLD, withBalance(OLD, 1, 'x'), NEW), withBalance(NEW, 1, 'x'));
  });
}

test('samtidig skrivning mellan läsning och skrivning: villkoret på updated_at gör att det slås ihop igen', async () => {
  const db = fakeDb({ user_state: [] });
  const io = app.sbStateIo(db, 'u1');
  const t1 = await io.insert('cat_budgets', { 'Mat (Butik)': 4000, Fest: 1000 });
  let raced = false, resa = 0;
  // Någon annan (t.ex. MCP) hinner lägga till en budget precis innan vår villkorade skrivning
  const racy = { ...io, async update(k, v, at) { if (!raced) { raced = true; const cur = await io.get(k); await io.update(k, { ...cur.value, Resa: resa }, at); } return io.update(k, v, at); } };
  for (const [i, save] of [saveMerged, app.saveMergedApp].entries()) {
    raced = false; resa = 3000 + i;
    const cur = await io.get('cat_budgets');
    const r = await save(racy, 'cat_budgets', { ...cur.value, 'Mat (Butik)': 4500 + i }, { v: cur.value, at: cur.updated_at });
    assert.equal(r.merged, true);
    assert.deepEqual((await io.get('cat_budgets')).value, { 'Mat (Butik)': 4500 + i, Fest: 1000, Resa: 3000 + i });
  }
  assert.ok(t1);
});

test('borttagningar och tillägg slås ihop: kategorier (lista), regler (objekt), konton (lista med id)', () => {
  for (const m of [mergeState3, app.mergeState3]) {
    // Lokalt: tog bort "Fest", la till "Resa". Servern: la till "Gym".
    assert.deepEqual(m(['Mat', 'Fest'], ['Mat', 'Resa'], ['Mat', 'Fest', 'Gym']), ['Mat', 'Gym', 'Resa']);
    // Regler: lokalt borttagen regel och ändrad regel; servern la till en regel
    assert.deepEqual(m({ a: { cat: 'X' }, b: { cat: 'Y' } }, { b: { cat: 'Z' } }, { a: { cat: 'X' }, b: { cat: 'Y' }, c: { cat: 'W' } }), { b: { cat: 'Z' }, c: { cat: 'W' } });
    // Konto borttaget lokalt, nytt konto på servern (t.ex. från bankkopplingen), nytt lokalt
    assert.deepEqual(m([{ id: 1 }, { id: 2 }], [{ id: 1 }, { id: 3 }], [{ id: 1 }, { id: 2 }, { id: 4 }]).map((x) => x.id), [1, 4, 3]);
    // Samma fält ändrat på båda håll: den senaste skrivningen (lokalt) gäller
    assert.deepEqual(m({ goal: 900000 }, { goal: 950000 }, { goal: 1000000 }), { goal: 950000 });
    // Inget ändrat lokalt: serverns version, oavsett hur gammal kopian är
    assert.deepEqual(m(OLD, OLD, NEW), NEW);
  }
});

test('appen utan sparat grundvärde (första synken efter uppdateringen): borttagning ångras inte', async () => {
  const db = fakeDb({ user_state: [] });
  const io = app.sbStateIo(db, 'u1');
  await io.insert('cats_exp', ['Mat', 'Fest', 'Resa']);
  const fpSynced = app.sbFp({ key: 'cats_exp', value: ['Mat', 'Fest', 'Resa'] });
  const r = await app.saveMergedApp(io, 'cats_exp', ['Mat', 'Resa'], undefined, (row) => app.sbFp({ key: 'cats_exp', value: row.value }) === fpSynced);
  assert.deepEqual(r.value, ['Mat', 'Resa']);
  assert.deepEqual((await io.get('cats_exp')).value, ['Mat', 'Resa']);
});

test('appen: hämtning när det finns osynkade lokala ändringar slår ihop i stället för att hoppa över', () => {
  const store = new Map(), localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  const ld = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
  const A = appFns(['SB_MERGE_SKIP', 'mergeState3', 'sbFp', 'sbApply'], { localStorage, ld, reloadAiHistory: () => {} });
  const T = { applyState: true, fromRow: (r) => ({ key: r.key, value: r.value }) };
  // Enhet A synkade OLD, har sedan bytt namn på Lönekontot lokalt (inte skickat än)
  const sh = { st: { accounts: A.sbFp({ key: 'accounts', value: OLD }) }, base: { accounts: { v: clone(OLD), at: 't1' } } };
  const local = clone(OLD); local[0].name = 'Lön (SEB)';
  localStorage.setItem('accounts', JSON.stringify(local));
  assert.equal(A.sbApply(T, [{ key: 'accounts', value: clone(NEW), updated_at: 't2', deleted: false }], sh), 1);
  const merged = JSON.parse(localStorage.getItem('accounts'));
  assert.equal(merged[0].name, 'Lön (SEB)');                 // den lokala ändringen finns kvar
  assert.equal(merged[0].number, '53290207161');             // serverns ändringar kom in
  assert.equal(merged[2].sav_cat, 'Klarna');
  assert.deepEqual(sh.base.accounts, { v: NEW, at: 't2' });   // nästa push skriver mot serverns version
  assert.notEqual(sh.st.accounts, A.sbFp({ key: 'accounts', value: merged })); // räknas som ändrad → skickas
});
