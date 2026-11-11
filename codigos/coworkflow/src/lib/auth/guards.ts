import { forbidden, redirect } from "next/navigation";

import { DESTINO_POR_DEFECTO } from "@/lib/auth/redirects";
import { obtenerSesion, type SesionActual } from "@/lib/auth/session";
import { tieneConsentimiento } from "@/lib/dominio/consentimiento";

/**
 * Guards de autorización para el servidor (S-27).
 *
 * Reglas:
 * - Se ejecutan en cada render/request: no se cachean roles entre peticiones. `requireAdmin`
 *   consulta `profiles` en cada llamada, así que quitar el rol a alguien tiene efecto
 *   inmediato y un JWT viejo con `role` manipulado no sirve.
 * - Sin sesión → `redirect('/login?next=<destino>')`.
 * - Con sesión pero sin permiso → `forbidden()` (403 con `forbidden.tsx`), sin filtrar si el
 *   recurso existe.
 */

function rutaLogin(destino: string): string {
  if (destino === DESTINO_POR_DEFECTO) return "/login";
  return `/login?next=${encodeURIComponent(destino)}`;
}

/** Exige sesión. `destino` se usa solo para volver ahí después del login. */
export async function requireUser(
  destino: string = DESTINO_POR_DEFECTO,
): Promise<SesionActual> {
  const sesion = await obtenerSesion();
  if (!sesion) redirect(rutaLogin(destino));
  return sesion;
}

/**
 * Exige sesión + consentimiento informado vigente. Si falta, se vuelve a la portada, que
 * muestra el aviso y permite aceptarlo.
 */
export async function requireConsentimiento(
  destino: string = DESTINO_POR_DEFECTO,
): Promise<SesionActual> {
  const sesion = await requireUser(destino);
  if (!tieneConsentimiento(sesion.perfil)) redirect("/");
  return sesion;
}

/**
 * Exige rol `admin` (leído de `profiles`, no del JWT). Se usa en `/qr` y en
 * `/api/qr/token`; en la Etapa 6 lo reutilizará `/admin`.
 */
export async function requireAdmin(
  destino: string = DESTINO_POR_DEFECTO,
): Promise<SesionActual> {
  const sesion = await requireUser(destino);
  if (sesion.perfil?.rol !== "admin") forbidden();
  return sesion;
}
