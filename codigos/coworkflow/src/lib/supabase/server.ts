import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";

import { envPublico } from "@/lib/env";
import { OPCIONES_COOKIE, conOpcionesSeguras } from "@/lib/supabase/cookies";

/**
 * Cliente de Supabase para Server Components, Route Handlers y Server Actions.
 *
 * Crea una instancia NUEVA por request (nunca compartir una entre requests) y persiste la
 * sesión en cookies httpOnly gestionadas por `@supabase/ssr` (S-09).
 *
 * `cookieOptions` y el `setAll` fuerzan `httpOnly`, `sameSite: 'lax'`, `path: '/'` y
 * `secure` en producción: `@supabase/ssr` propone `httpOnly: false` por defecto
 * (`DEFAULT_COOKIE_OPTIONS`), pensado para su cliente de navegador.
 *
 * En un Server Component no se pueden escribir cookies (`cookies().set()` lanza): en ese
 * caso el `try/catch` deja pasar la lectura y el refresh de la sesión queda a cargo de
 * `src/proxy.ts`, que sí puede escribir la respuesta.
 */
export async function crearClienteServidor() {
  const almacen = await cookies();

  return createServerClient(
    envPublico.NEXT_PUBLIC_SUPABASE_URL,
    envPublico.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookieOptions: OPCIONES_COOKIE,
      cookies: {
        getAll() {
          return almacen.getAll();
        },
        setAll(cookiesAEscribir) {
          try {
            for (const { name, value, options } of cookiesAEscribir) {
              almacen.set(name, value, conOpcionesSeguras(options));
            }
          } catch {
            // Server Component: solo lectura. proxy.ts refresca y escribe las cookies.
          }
        },
      },
    },
  );
}
