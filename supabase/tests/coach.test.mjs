// AI-coachens förslag i appen (index.html): förhandsgranskning, Spara och Ångra, samt nya abonnemang (detectNewSubs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appFns, fmt } from './app.mjs';

const DEF_EXP = ['Mat', 'Hämtmat', 'Nöje', 'Övrigt'];
function setup(txs) {
  const store = { txs, merchant_rules: {}, cat_budgets: { Mat: 4000 } };
  const ld = (k, d) => (k in store ? structuredClone(store[k]) : structuredClone(d));
  const sv = (k, v) => { store[k] = structuredClone(v); };
  const CAT_CFG = { expense: { key: 'cats_exp', def: DEF_EXP }, income: { key: 'cats_inc', def: ['Lön'] }, savings: { key: 'cats_sav', def: ['Fond'] }, transfer: { key: 'cats_trf', def: ['Egen överföring'] } };
  const g = {
    ld, sv, CAT_CFG, fmt, TYPE_LABEL: { expense: 'Utgift', income: 'Inkomst', savings: 'Sparande', transfer: 'Överföring' },
    getTxs: () => ld('txs', []), svTxs: (v) => sv('txs', v), getBudgets: () => ld('cat_budgets', {}), getExpCats: () => ld('cats_exp', DEF_EXP),
    catsForType: (t) => ld(CAT_CFG[t].key, CAT_CFG[t].def), getRules: () => ld('merchant_rules', {}),
    setRule: (k, type, cat) => { const r = ld('merchant_rules', {}); r[k] = { type, cat }; sv('merchant_rules', r); },
    displayDesc: (d) => d, contactName: () => null, parseTags: (s) => [...new Set(String(s || '').split(',').map((x) => x.trim()).filter(Boolean))],
  };
  const f = appFns(['_coachProps', 'coachCatExists', 'coachAdd', 'coachPropose', 'coachApply', 'coachUndo', 'coachFilter'], g);
  return { f, store };
}
const t = (id, desc, amount, cat, mkey, extra = {}) => ({ id, type: 'expense', desc, amount, cat, mkey, date: '2026-10-0' + (id % 9 + 1), month: '2026-10', account: 'amex', ...extra });

test('change_transactions: förhandsgranskar, sparar ingenting förrän apply, lär in regel och kan ångras', () => {
  const { f, store } = setup([t(1, 'WOLT', 189, 'Mat', 'wolt|ut'), t(2, 'WOLT', 240, 'Mat', 'wolt|ut'), t(3, 'ICA', 500, 'Mat', 'ica|ut')]);
  const r = f.coachPropose('change_transactions', { query: 'wolt', set: { category: 'Hämtmat' }, learn_rule: true });
  assert.equal(r.status, 'förslag_väntar_på_godkännande');
  assert.match(r.details[0], /^2 transaktioner · 429 kr/);
  assert.ok(r.details.some((l) => /Regel för 1 butik/.test(l)));
  assert.equal(store.txs[0].cat, 'Mat', 'inget sparat innan användaren godkänt');
  const u = f.coachApply(f._coachProps[0]);
  assert.deepEqual(store.txs.map((x) => x.cat), ['Hämtmat', 'Hämtmat', 'Mat']);
  assert.deepEqual(store.merchant_rules['wolt|ut'], { type: 'expense', cat: 'Hämtmat' });
  f.coachUndo(u);
  assert.deepEqual(store.txs.map((x) => x.cat), ['Mat', 'Mat', 'Mat']);
  assert.equal(store.merchant_rules['wolt|ut'], undefined);
});

test('change_transactions: kräver filter, okänd kategori avvisas, ny kategori i samma svar godtas', () => {
  const { f, store } = setup([t(1, 'SNUSHYLLAN', 300, 'Övrigt', 'snushyllan|ut')]);
  assert.match(f.coachPropose('change_transactions', { set: { category: 'Mat' } }).error, /filter/);
  assert.match(f.coachPropose('change_transactions', { query: 'snus', set: { category: 'Snus' } }).error, /finns inte/);
  assert.ok(f.coachPropose('create_category', { name: 'Snus', type: 'expense' }).proposal);
  const r = f.coachPropose('change_transactions', { ids: [1], set: { category: 'Snus' } });
  assert.ok(r.proposal, JSON.stringify(r));
  const undo = f._coachProps.map(f.coachApply);
  assert.deepEqual(store.cats_exp, ['Mat', 'Hämtmat', 'Nöje', 'Snus', 'Övrigt'], 'ny utgiftskategori före Övrigt');
  assert.equal(store.txs[0].cat, 'Snus');
  [...undo].reverse().forEach(f.coachUndo);
  assert.equal(store.txs[0].cat, 'Övrigt');
  assert.ok(!store.cats_exp.includes('Snus'));
});

test('change_transactions: taggar, och inga förslag när inget skulle ändras', () => {
  const { f, store } = setup([t(1, 'SJ', 900, 'Nöje', 'sj|ut', { tags: ['resa'] }), t(2, 'SAS', 2400, 'Nöje', 'sas|ut')]);
  assert.match(f.coachPropose('change_transactions', { ids: [1], set: { add_tags: ['resa'] } }).error, /ingen skulle ändras/);
  f.coachPropose('change_transactions', { category: 'Nöje', set: { add_tags: ['Japan 2026'] } });
  const u = f.coachApply(f._coachProps[0]);
  assert.deepEqual(store.txs.map((x) => x.tags), [['resa', 'Japan 2026'], ['Japan 2026']]);
  f.coachUndo(u);
  assert.deepEqual(store.txs.map((x) => x.tags), [['resa'], undefined]);
});

test('set_budget och create_category: validering, spara och ångra', () => {
  const { f, store } = setup([]);
  assert.match(f.coachPropose('set_budget', { category: 'Bilar', amount: 1000 }).error, /finns inte/);
  assert.match(f.coachPropose('set_budget', { category: 'Mat', amount: 4000 }).error, /redan/);
  assert.match(f.coachPropose('create_category', { name: 'mat', type: 'expense' }).error, /finns redan/);
  f.coachPropose('set_budget', { category: 'Nöje', amount: 1500 });
  f.coachPropose('set_budget', { category: 'Mat', amount: 0 });
  const undo = f._coachProps.map(f.coachApply);
  assert.deepEqual(store.cat_budgets, { Nöje: 1500 });
  [...undo].reverse().forEach(f.coachUndo);
  assert.deepEqual(store.cat_budgets, { Mat: 4000 });
});

test('detectNewSubs (appen) följer samma regler som nattens vakt', () => {
  const txs = [t(1, 'K*STORYTEL', 229, 'Böcker', 'k storytel|ut', { month: '2026-09' }), t(2, 'K*STORYTEL', 229, 'Böcker', 'k storytel|ut'),
    t(3, 'DISNEY PLUS', 109, 'Prenumerationer', 'disney plus|ut'), t(4, 'ICA', 300, 'Mat', 'ica|ut', { month: '2026-04' }), t(5, 'ICA', 320, 'Mat', 'ica|ut')];
  const { detectNewSubs } = appFns(['detectNewSubs', 'mkeyBase'], {
    getTxs: () => txs, displayDesc: (d) => d, merchantBase: (d) => d.toLowerCase(),
    periodShift: (ym, n) => { const [y, m] = ym.split('-').map(Number); const d = new Date(y, m - 1 + n, 1); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); },
  });
  assert.deepEqual(detectNewSubs('2026-10').map((x) => [x.name, x.why]), [['K*STORYTEL', 'twice'], ['DISNEY PLUS', 'first']]);
});
