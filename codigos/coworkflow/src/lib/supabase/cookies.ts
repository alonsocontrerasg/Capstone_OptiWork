import type { CookieOptions } from "@supabase/ssr";

/**
 * Opciones de las cookies de sesión emitidas por el SERVIDOR (S-09, S-29).
 *
 * `@supabase/ssr` trae `httpOnly: false` por defecto (`DEFAULT_COOKIE_OPTIONS`) porque su
 * cliente de navegador escribe con `document.cookie`, que no puede crear cookies httpOnly.
 * Aquí la sesión solo la escribe el servidor (Route Handler `/auth/login` y `src/proxy.ts`),
 * así que podemos —y debemos— marcar `httpOnly` para que un XSS no pueda leer el token.
 *
 * `secure` solo en producción: en `next dev` la app va por http://localhost y una cookie
 * `Secure` no se guardaría.
 */
export const OPCIONES_COOKIE: CookieOptions = {
  httpOnly: true,
  sameSite: "lax",
  path: "/",
  secure: process.env.NODE_ENV === "production",
};

/**
 * Fuerza las opciones seguras sobre las que proponga `@supabase/ssr` o quien llame.
 *
 * Se usa en cada `setAll` para que ninguna cookie `sb-*` salga sin `httpOnly`, incluso si
 * una versión futura de la librería cambia sus valores por defecto.
 */
export function conOpcionesSeguras(options: CookieOptions = {}): CookieOptions {
  return { ...options, ...OPCIONES_COOKIE };
}
