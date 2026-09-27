// AI-proxyns kontroller (functions/ai/request.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest, allowedUser } from '../functions/ai/request.ts';

const msg = [{ role: 'user', content: 'hej' }];
test('buildRequest: modeller, fält, tak och cache', () => {
  const long = 'x'.repeat(5000);
  const r = buildRequest({ model: 'claude-sonnet-5', max_tokens: 999999, messages: msg, system: long, evil: 1, stream: true });
  assert.equal(r.max_tokens, 64000); assert.equal(r.evil, undefined); assert.equal(r.stream, true);
  assert.deepEqual(r.system, [{ type: 'text', text: long, cache_control: { type: 'ephemeral' } }]);
  assert.equal(buildRequest({ model: 'claude-opus-5-5', messages: msg, system: 'kort' }).system, 'kort');
  // Block från appen skickas vidare som de är
  const blocks = [{ type: 'text', text: 'fast', cache_control: { type: 'ephemeral' } }, { type: 'text', text: 'rörligt' }];
  assert.deepEqual(buildRequest({ model: 'claude-opus-5-5', messages: msg, system: blocks }).system, blocks);
  assert.throws(() => buildRequest({ model: 'gpt-5', messages: msg }), /inte tillåten/);
  assert.throws(() => buildRequest({ model: 'claude-sonnet-5', messages: [] }), /messages/);
});

test('buildRequest: bara egna verktyg, inga serververktyg', () => {
  const tools = [{ name: 'search_transactions', input_schema: { type: 'object' } }, { type: 'web_search_20250305', name: 'web_search' }, { type: 'code_execution_20250825', name: 'code' }];
  assert.deepEqual(buildRequest({ model: 'claude-sonnet-5', messages: msg, tools }).tools.map((t) => t.name), ['search_transactions']);
});

test('allowedUser: bara konton i listan, tom lista = avstängt', () => {
  assert.equal(allowedUser('a', 'a, b'), true);
  assert.equal(allowedUser('c', 'a,b'), false);
  assert.equal(allowedUser('a', ''), false);
  assert.equal(allowedUser('a', undefined), false);
});
