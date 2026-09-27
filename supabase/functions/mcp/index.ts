// Supabase Edge Function: MCP-server för Privatekonomi. Logiken finns i mcp.ts.
// Driftsätt: supabase functions deploy mcp --no-verify-jwt   (se supabase/README.md)
import { createClient } from 'npm:@supabase/supabase-js@2';
import { createHandler } from './mcp.ts';

// Nya projekt har SUPABASE_SECRET_KEYS (JSON), äldre SUPABASE_SERVICE_ROLE_KEY — båda sätts automatiskt
function secretKey() {
  try {
    const keys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}');
    if (keys.default) return keys.default as string;
  } catch { /* äldre projekt */ }
  return Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
}

const db = createClient(Deno.env.get('SUPABASE_URL')!, secretKey(), {
  auth: { persistSession: false, autoRefreshToken: false },
});

Deno.serve(createHandler(db));
