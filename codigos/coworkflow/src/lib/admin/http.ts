import "server-only";
import { NextResponse } from "next/server";
import { obtenerSesionVerificada } from "@/lib/auth/session";
import { limitarPorUsuario } from "@/lib/rate-limit";

export const SIN_CACHE_ADMIN = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" };
export function errorAdmin(error: string, status: number) {
  return NextResponse.json({ error }, { status, headers: SIN_CACHE_ADMIN });
}

/** Las APIs responden JSON (401/403), sin convertir un error de permisos en una página HTML. */
export async function autorizarAdmin(prefijo: string, limite = 20) {
  const sesion = await obtenerSesionVerificada();
  if (!sesion) return errorAdmin("sesion_invalida", 401);
  if (sesion.perfil?.rol !== "admin") return errorAdmin("acceso_denegado", 403);
  const resultado = await limitarPorUsuario(sesion.usuario.id, {
    prefijo: `admin:${prefijo}`, limite, ventanaSegundos: 60,
  });
  return resultado.permitido ? null : errorAdmin("demasiados_intentos", 429);
}
