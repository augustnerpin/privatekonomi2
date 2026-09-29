// Nycklar i user_state som bara servern skriver (invest_settings) får aldrig raderas eller skrivas över av appens synk.
// 2026-09-29: appen hämtade in invest_settings i synkskuggan, och nästa push tolkade nyckeln som "borttagen lokalt"
// (den finns inte bland appens egna nycklar) och satte deleted = true. Här återskapas det förloppet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appFns } from './app.mjs';

function app() {
  const store = new Map();
  const localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  const ld = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
  const f = appFns(['SYNC_KEYS', 'SB_STATE_KEYS', 'sbOwnsState', 'sbFp', 'SB_MERGE_SKIP', 'mergeState3', 'sbGone', 'sbApply'], { localStorage, ld, reloadAiHistory: () => {} });
  const T = { name: 'user_state', sk: 'st', owns: f.sbOwnsState, applyState: true, fromRow: (r) => ({ key: r.key, value: r.value }) };
  return { ...f, T, store, localStorage };
}
const SETTINGS = { concentration_pct: 15, interest_deduction_pct: 30, leverage: { since: '2026-06-25' } };

test('appen hämtar inte in serverns nycklar, och raderar dem aldrig vid push', () => {
  const a = app();
  const sh = { st: {}, base: {} };
  a.sbApply(a.T, [{ key: 'invest_settings', value: SETTINGS, updated_at: '2026-09-29T08:10:18Z', deleted: false },
    { key: 'expected_tx', value: [{ id: 'x' }], updated_at: '2026-09-29T08:10:19Z', deleted: false }], sh);
  assert.equal(a.localStorage.getItem('invest_settings'), null);
  assert.equal('invest_settings' in sh.st, false);
  assert.ok('expected_tx' in sh.st); // appens egna nycklar synkas som förut
  // Skugga från en äldre version av appen som redan hade hämtat in nyckeln: push raderar den inte, och den rensas bort
  sh.st.invest_settings = 'gammal'; sh.base.invest_settings = { v: SETTINGS, at: 'x' };
  const gone = a.sbGone(a.T, sh, new Set(['expected_tx']));
  assert.deepEqual(gone, []);
  assert.equal('invest_settings' in sh.st, false); assert.equal('invest_settings' in sh.base, false);
  // En egen nyckel som tagits bort lokalt raderas fortfarande
  sh.st.fixed_costs = 'fp';
  assert.deepEqual(a.sbGone(a.T, sh, new Set(['expected_tx'])), ['fixed_costs']);
  // Serverns nycklar finns inte bland appens synknycklar (annars skulle appen kunna skriva över dem)
  assert.equal(a.SB_STATE_KEYS.includes('invest_settings'), false);
});
