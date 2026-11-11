import { createBrowserClient } from "@supabase/ssr";

import { envPublico } from "@/lib/env";

/**
 * Cliente de Supabase para el NAVEGADOR.
 *
 * Usa la `anon key`, que es pública por diseño: todo lo que puede leer o escribir lo
 * dictan las políticas RLS. Nunca importar aquí la `service_role` (S-07).
 *
 * `createBrowserClient` reutiliza una sola instancia por URL/clave, así que los eventos
 * de auth se comparten entre componentes.
 */
export function crearClienteNavegador() {
  return createBrowserClient(
    envPublico.NEXT_PUBLIC_SUPABASE_URL,
    envPublico.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
}
