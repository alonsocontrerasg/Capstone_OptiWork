import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { envPublico } from "@/lib/env";

/**
 * Cliente de Supabase SOLO para Realtime en el navegador.
 *
 * - Sin persistencia de sesión: el dashboard es público y no hay usuario autenticado. Se
 *   desactivan `persistSession`, `autoRefreshToken` y `detectSessionInUrl` para no tocar
 *   cookies/localStorage ni procesar la URL.
 * - PROHIBIDO usar este cliente para REST (`.from()`, `.rpc()`): la anon key es pública y
 *   el navegador podría consultar tablas directamente. Las lecturas del dashboard pasan
 *   por Server Components (`src/lib/supabase/dashboard.ts`) y las escrituras por RPC o
 *   Route Handlers. Aquí solo se abre un canal a `ocupacion_actual`, que no tiene PII.
 * - Se reutiliza una única instancia por pestaña para no abrir un WebSocket por componente.
 */

let cliente: SupabaseClient | null = null;

export function obtenerClienteNavegador(): SupabaseClient {
  if (cliente) return cliente;

  cliente = createClient(
    envPublico.NEXT_PUBLIC_SUPABASE_URL,
    envPublico.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      db: { schema: "public" },
    },
  );

  return cliente;
}
