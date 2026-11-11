import "server-only";

import { createClient } from "@supabase/supabase-js";

import { envPublico } from "@/lib/env";
import { envServidor } from "@/lib/env.server";

/**
 * Cliente con `service_role`: IGNORA RLS por completo.
 *
 * Reglas de uso (S-07):
 * - Solo se importa desde código de servidor: `scripts/` (simulación local) y tareas
 *   administrativas puntuales. Nunca desde un Client Component, ni desde una página o
 *   Route Handler que atienda tráfico de usuarios.
 * - `import "server-only"` hace fallar el build si alguien lo importa desde el cliente.
 * - Sin persistencia de sesión: es una credencial de servicio, no un usuario.
 */
export function crearClienteAdmin() {
  const claveServicio = envServidor.SUPABASE_SERVICE_ROLE_KEY;
  if (!claveServicio) {
    throw new Error(
      "Falta SUPABASE_SERVICE_ROLE_KEY. Solo se necesita para tareas administrativas server-side (scripts locales); nunca en el navegador ni en rutas que atienden usuarios.",
    );
  }

  return createClient(envPublico.NEXT_PUBLIC_SUPABASE_URL, claveServicio, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    db: { schema: "public" },
  });
}
