// AI-proxy: appen anropar Claude härifrån i stället för direkt, så att Anthropic-nyckeln bara finns på servern.
// Kräver inloggning (Supabase-sessionens JWT) OCH att kontot finns i AI_ALLOWED_USERS. Svaret skickas vidare
// oförändrat, även strömmat (SSE).
// Secrets: ANTHROPIC_API_KEY=sk-ant-…, AI_ALLOWED_USERS=<ditt user-id> (flera separeras med komma)
import { createClient } from 'npm:@supabase/supabase-js@2';
import { BETAS, buildRequest, allowedUser } from './request.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-anthropic-beta',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'content-type': 'application/json' } });
const fail = (status: number, message: string) => json({ type: 'error', error: { type: 'proxy_error', message } }, status);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return fail(405, 'Method not allowed');

  const key = Deno.env.get('ANTHROPIC_API_KEY');
  if (!key) return fail(500, 'ANTHROPIC_API_KEY saknas på servern');

  const jwt = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!jwt) return fail(401, 'Logga in i appen för att använda AI');
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { auth: { persistSession: false } });
  const { data: user, error: authErr } = await sb.auth.getUser(jwt);
  if (authErr || !user?.user) return fail(401, 'Inloggningen har gått ut — logga in igen');
  if (!allowedUser(user.user.id, Deno.env.get('AI_ALLOWED_USERS'))) return fail(403, 'AI på servern är inte aktiverad för det här kontot');

  let body: Record<string, unknown>;
  try { body = buildRequest(await req.json()); } catch (e) { return fail(400, (e as Error).message); }

  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' };
  const betas = (req.headers.get('x-anthropic-beta') || '').split(',').map((s) => s.trim()).filter((b) => BETAS.has(b));
  if (betas.length) headers['anthropic-beta'] = betas.join(',');

  const res = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers, body: JSON.stringify(body) });
  return new Response(res.body, { status: res.status, headers: { ...CORS, 'content-type': res.headers.get('content-type') || 'application/json' } });
});
