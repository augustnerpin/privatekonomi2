// Gemensam testdata och anropshjälp. U = användaren, OTHER = någon annan vars data aldrig får synas.
import { M } from './load.mjs';
import { fakeDb } from './fakedb.mjs';
export { M };
export const U = 'user-1', OTHER = 'user-2';
export const W = 'pkm_' + 'w'.repeat(40), R = 'pkm_' + 'r'.repeat(40);

export const tx = (id, uid, type, amount, category, date, month, o = {}) => ({
  user_id: uid, id, type, amount, description: o.d || 'x', category, tx_date: date, month,
  account: o.account || 'lonekonto', source: o.source || 'import', import_id: o.import_id || null, hash: o.hash || null,
  mkey: o.mkey || null, extra: o.extra || {}, deleted: false,
});

export async function world(extra = {}, opts = {}) {
  const tables = {
    mcp_tokens: [{ id: 't1', user_id: U, scope: 'write', token_hash: await M.sha256hex(W) }, { id: 't2', user_id: U, scope: 'read', token_hash: await M.sha256hex(R) }],
    transactions: [
      tx(1, U, 'income', 40000, 'Lön', '2026-08-25', '2026-09'),
      tx(2, U, 'expense', 1200, 'Mat (Butik)', '2026-08-28', '2026-09', { d: 'ICA NARA', mkey: 'ica nara|ut' }),
      tx(3, U, 'expense', 800, 'Mat (Butik)', '2026-09-03', '2026-09', { d: 'ICA NARA 2', mkey: 'ica nara|ut' }),
      tx(4, U, 'savings', 5000, 'Avanza', '2026-08-26', '2026-09'),
      tx(5, U, 'transfer', -3000, 'Egen överföring', '2026-08-27', '2026-09'),
      tx(6, U, 'expense', 2000, 'Mat (Butik)', '2026-07-30', '2026-08'),
      tx(7, U, 'expense', 450, 'Swish (privat)', '2026-09-01', '2026-09', { d: '0701234567' }),
      tx(99, OTHER, 'expense', 99999, 'Mat (Butik)', '2026-09-01', '2026-09', { d: 'HEMLIG' }),
    ],
    user_state: [
      { user_id: U, key: 'cat_budgets', value: { 'Mat (Butik)': 3000 }, deleted: false },
      { user_id: U, key: 'contact_names', value: { '0701234567': 'Anna' }, deleted: false },
      { user_id: OTHER, key: 'cat_budgets', value: { 'Mat (Butik)': 1 }, deleted: false },
    ],
    net_worth_snapshots: [{ user_id: U, period: '2026-08', total: 100000, amounts: { cash: 100000 }, deleted: false }],
  };
  for (const [k, v] of Object.entries(extra)) tables[k] = [...(tables[k] || []), ...v];
  const db = fakeDb(tables, opts);
  const h = M.createHandler(db);
  let n = 0;
  async function rpc(token, method, params, how = 'path') {
    const url = how === 'path' ? `https://x.supabase.co/mcp/${token}` : 'https://x.supabase.co/mcp';
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    if (how === 'bearer') headers.authorization = 'Bearer ' + token;
    const r = await h(new Request(url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method, params }) }));
    return { status: r.status, body: r.status === 202 ? null : await r.json() };
  }
  // Verktygsanrop: returnerar resultatet, eller { err } vid fel
  async function call(name, args = {}, token = W) {
    const { body } = await rpc(token, 'tools/call', { name, arguments: args });
    const text = body.result.content[0].text;
    return body.result.isError ? { err: text } : JSON.parse(text);
  }
  const txRow = (id) => tables.transactions.find((t) => t.id === id);
  const state = (key, uid = U) => tables.user_state.find((r) => r.user_id === uid && r.key === key)?.value;
  // Kör fn och kräver att databasen inte fick någon skrivning (förutom "senast använd" på nyckeln)
  async function noWrites(fn) {
    const before = JSON.stringify({ ...tables, mcp_tokens: null });
    const out = await fn();
    if (JSON.stringify({ ...tables, mcp_tokens: null }) !== before) throw new Error('dry_run skrev till databasen');
    return out;
  }
  return { tables, db, h, rpc, call, txRow, state, noWrites };
}
