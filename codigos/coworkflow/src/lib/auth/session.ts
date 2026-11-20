import { crearClienteServidor } from "@/lib/supabase/server";

/**
 * Lectura de la sesión actual en el servidor.
 *
 * Se usa `auth.getClaims()`, NUNCA `auth.getSession()`:
 * - `getSession()` devuelve lo que haya en la cookie sin verificarlo, así que un token
 *   manipulado se tomaría como válido (S-27).
 * - `getClaims()` valida la firma del JWT (con las claves públicas del proyecto o pidiendo
 *   verificación a Auth si la firma es simétrica) y devuelve los claims ya comprobados.
 *
 * Límite importante: `getClaims()` comprueba la firma y la expiración del JWT, pero **no**
 * consulta el estado de la sesión en Auth. Un token revocado (por ejemplo, una sesión
 * cerrada desde otro dispositivo) se sigue aceptando hasta que vence, así que sirve para
 * identificar al usuario en las páginas normales, no para autorizar acciones sensibles. Las
 * acciones sensibles usan `obtenerSesionVerificada()`: getUser y una consulta de la sesión
 * en auth.sessions. GetUser por sí solo tampoco revoca un access token aún vigente.
 */

export type RolUsuario = "usuario" | "admin";

export type UsuarioAutenticado = {
  id: string;
  email: string | null;
};

export type PerfilActual = {
  id: string;
  rol: RolUsuario;
  consentimiento_at: string | null;
  consentimiento_version: number | null;
};

export type SesionActual = {
  usuario: UsuarioAutenticado;
  /** `null` si el trigger de alta no creó la fila (no debería ocurrir). */
  perfil: PerfilActual | null;
};

type FilaPerfil = {
  id: string;
  rol: string | null;
  consentimiento_at: string | null;
  consentimiento_version: number | null;
};

function normalizarPerfil(fila: FilaPerfil | null): PerfilActual | null {
  if (!fila) return null;
  return {
    id: fila.id,
    rol: fila.rol === "admin" ? "admin" : "usuario",
    consentimiento_at: fila.consentimiento_at ?? null,
    consentimiento_version:
      typeof fila.consentimiento_version === "number"
        ? fila.consentimiento_version
        : null,
  };
}

export async function obtenerSesion(): Promise<SesionActual | null> {
  const supabase = await crearClienteServidor();

  const { data, error } = await supabase.auth.getClaims();
  if (error || !data) return null;

  const sub = data.claims.sub;
  if (typeof sub !== "string" || sub.length === 0) return null;

  const email =
    typeof data.claims.email === "string" ? data.claims.email : null;

  const { data: fila, error: errorPerfil } = await supabase
    .from("profiles")
    .select("id, rol, consentimiento_at, consentimiento_version")
    .eq("id", sub)
    .maybeSingle();

  if (errorPerfil) {
    // No se propaga al usuario: el detalle queda solo en el log del servidor.
    console.error("[auth] no se pudo leer el perfil:", errorPerfil.message);
  }

  return {
    usuario: { id: sub, email },
    perfil: normalizarPerfil(fila as FilaPerfil | null),
  };
}

/** Para administración: identidad consultada en Auth, sesión existente y rol actual bajo RLS. */
export async function obtenerSesionVerificada(): Promise<SesionActual | null> {
  const supabase = await crearClienteServidor();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  const vigente = await supabase.rpc("sesion_vigente");
  if (vigente.error || vigente.data !== true) return null;
  const perfil = await supabase.from("profiles")
    .select("id, rol, consentimiento_at, consentimiento_version")
    .eq("id", data.user.id).maybeSingle();
  if (perfil.error) return null;
  return {
    usuario: { id: data.user.id, email: data.user.email ?? null },
    perfil: normalizarPerfil(perfil.data as FilaPerfil | null),
  };
}
