// Punkt 7: kategorier
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, tx, U, OTHER, R } from './helpers.mjs';

const setup = () => ({
  transactions: [
    tx(70, U, 'expense', 320, 'Spanien', '2026-07-02', '2026-07'),
    tx(71, U, 'expense', 180, 'Spanien', '2026-07-03', '2026-07'),
    tx(72, U, 'savings', 1000, 'Sparande', '2026-07-03', '2026-07'),
    tx(73, U, 'savings', 2000, 'Sparande Avanza', '2026-07-04', '2026-07'),
    tx(74, U, 'expense', 250, 'Mat (Ute)', '2026-07-05', '2026-07', { mkey: 'pizza|ut' }),
    tx(75, OTHER, 'expense', 1, 'Spanien', '2026-07-05', '2026-07'),
    tx(76, OTHER, 'expense', 1, 'Mat (Ute)', '2026-07-05', '2026-07'),
  ],
  user_state: [
    { user_id: U, key: 'cat_budgets', value: { 'Mat (Ute)': 1500, 'Lunch (Restaurang)': 1000 }, deleted: false },
    { user_id: U, key: 'cat_groups', value: [{ name: 'Mat', cats: ['Mat (Butik)', 'Mat (Ute)'] }], deleted: false },
    { user_id: U, key: 'merchant_rules', value: { 'pizza|ut': { type: 'expense', cat: 'Mat (Ute)', t: 1 }, 'lön|in': { type: 'income', cat: 'Övrigt', t: 1 } }, deleted: false },
  ],
});

test('get_settings listar föräldralösa kategorier', async () => {
  const w = await world(setup());
  const st = await w.call('get_settings', {}, R);
  assert.deepEqual(st.orphan_categories, { expense: [{ name: 'Spanien', count: 2 }], savings: [{ name: 'Sparande', count: 1 }, { name: 'Sparande Avanza', count: 1 }] });
});

test('create_category', async () => {
  const w = await world(setup());
  const r = await w.call('create_category', { type: 'savings', name: '  Buffert ' });
  assert.equal(r.created, 'Buffert'); assert.deepEqual(w.state('cats_sav'), ['Avanza', 'SEB', 'Annat', 'Buffert']);
  assert.match((await w.call('create_category', { type: 'savings', name: 'avanza' })).err, /"Avanza" finns redan för sparande/);
  assert.match((await w.call('create_category', { type: 'expense', name: '  ' })).err, /måste ha ett namn/);
});

test('merge_categories: föräldralös kategori, budget, grupper och regler', async () => {
  const w = await world(setup());
  const pre = await w.noWrites(() => w.call('merge_categories', { type: 'expense', from: ['Spanien'], to: 'Resa', dry_run: true }));
  assert.equal(pre.transactions, 2);
  await w.call('merge_categories', { type: 'expense', from: ['Spanien'], to: 'Resa' });
  assert.equal(w.txRow(70).category, 'Resa'); assert.equal(w.txRow(75).category, 'Spanien', 'annan användare rörs inte');
  // Två utgiftskategorier: transaktioner, budget summeras, grupp och regel följer med, den gamla försvinner
  const m = await w.call('merge_categories', { type: 'expense', from: ['Mat (Ute)'], to: 'Lunch (Restaurang)' });
  assert.equal(m.transactions, 1); assert.deepEqual(m.rules_updated, ['pizza|ut']); assert.equal(m.budget_after, 2500);
  assert.equal(w.txRow(74).category, 'Lunch (Restaurang)'); assert.equal(w.txRow(76).category, 'Mat (Ute)');
  assert.deepEqual(w.state('cat_budgets'), { 'Lunch (Restaurang)': 2500 });
  assert.deepEqual(w.state('cat_groups'), [{ name: 'Mat', cats: ['Mat (Butik)', 'Lunch (Restaurang)'] }]);
  assert.equal(w.state('merchant_rules')['pizza|ut'].cat, 'Lunch (Restaurang)');
  assert.equal(w.state('merchant_rules')['lön|in'].cat, 'Övrigt', 'regler för andra typer rörs inte');
  assert.ok(!w.state('cats_exp').includes('Mat (Ute)'));
  // Två föräldralösa sparkategorier på en gång
  assert.equal((await w.call('merge_categories', { type: 'savings', from: ['Sparande', 'Sparande Avanza'], to: 'Avanza' })).transactions, 2);
  assert.deepEqual((await w.call('get_settings')).orphan_categories, {});
  assert.match((await w.call('merge_categories', { type: 'expense', from: ['Gym'], to: 'Finns inte' })).err, /Målkategorin "Finns inte" finns inte/);
  assert.match((await w.call('merge_categories', { type: 'expense', from: ['Påhittad'], to: 'Gym' })).err, /Okänd kategori "Påhittad"/);
  assert.match((await w.call('merge_categories', { type: 'expense', from: ['Gym'], to: 'Gym' })).err, /med sig själv/);
});

test('rename_category', async () => {
  const w = await world(setup());
  const r = await w.call('rename_category', { type: 'expense', old: 'Mat (Ute)', new: 'Restaurang' });
  assert.equal(r.transactions, 1);
  const cats = w.state('cats_exp');
  assert.equal(cats.indexOf('Restaurang'), 4, 'behåller platsen i listan'); assert.ok(!cats.includes('Mat (Ute)'));
  assert.deepEqual(w.state('cat_budgets'), { Restaurang: 1500, 'Lunch (Restaurang)': 1000 });
  assert.deepEqual(w.state('cat_groups')[0].cats, ['Mat (Butik)', 'Restaurang']);
  assert.equal(w.state('merchant_rules')['pizza|ut'].cat, 'Restaurang');
  // Föräldralös kategori får ett riktigt namn och hamnar i listan
  await w.call('rename_category', { type: 'expense', old: 'Spanien', new: 'Semester' });
  assert.ok(w.state('cats_exp').includes('Semester')); assert.equal(w.txRow(71).category, 'Semester');
  assert.match((await w.call('rename_category', { type: 'expense', old: 'Gym', new: 'resa' })).err, /"Resa" finns redan för utgift — använd merge_categories/);
  await w.noWrites(() => w.call('rename_category', { type: 'expense', old: 'Gym', new: 'Träning', dry_run: true }));
});
