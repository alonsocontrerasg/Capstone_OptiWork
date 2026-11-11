import "server-only";

import { envPublico } from "@/lib/env";
import { crearClienteServidor } from "@/lib/supabase/server";
import type { AccionAuth } from "@/lib/validacion/auth";

/**
 * Resultado de una acción de autenticación.
 *
 * Los errores se devuelven como códigos GENÉRICOS, nunca como el `code` de Supabase: así el
 * cliente no puede distinguir «correo no registrado» de «contraseña incorrecta» y no hay
 * enumeración de cuentas (S-29).
 */
export type CodigoErrorAuth =
  | "credenciales_invalidas"
  | "limite_intentos"
  | "contrasena_debil"
  | "registro_generico"
  | "correo_sin_confirmar"
  | "generico";

export type ResultadoAuth =
  | { tipo: "ok"; redirigir?: string; aviso?: string }
  | { tipo: "error"; codigo: CodigoErrorAuth };

/** Traduce `AuthError.code` a un código genérico propio. */
function codigoDeError(codigo: string | undefined): CodigoErrorAuth {
  switch (codigo) {
    case "over_email_send_rate_limit":
    case "over_request_rate_limit":
      return "limite_intentos";
    case "weak_password":
      return "contrasena_debil";
    case "invalid_credentials":
      return "credenciales_invalidas";
    case "email_not_confirmed":
      // Solo ocurre con credenciales correctas: no añade enumeración y ayuda al usuario.
      return "correo_sin_confirmar";
    case "user_already_exists":
    case "email_exists":
      return "registro_generico";
    default:
      return "generico";
  }
}

/**
 * URL de retorno del enlace mágico.
 *
 * Se arma con `NEXT_PUBLIC_SITE_URL` (validada en `env.ts`), nunca con `request.url` ni con
 * la cabecera `Host`: un atacante puede falsificar `Host` y desviar el enlace del correo a
 * otro dominio (S-29).
 */
function urlDeVuelta(destino: string): string {
  const url = new URL("/auth/callback", envPublico.NEXT_PUBLIC_SITE_URL);
  url.searchParams.set("next", destino);
  return url.toString();
}

/**
 * Ejecuta la acción de autenticación pedida usando el cliente de servidor.
 *
 * Debe llamarse desde un Route Handler: necesita poder escribir las cookies de sesión
 * (httpOnly) en la respuesta (S-09).
 */
export async function ejecutarAccionAuth(
  accion: AccionAuth,
  destino: string,
): Promise<ResultadoAuth> {
  const supabase = await crearClienteServidor();

  if (accion.accion === "enlace") {
    const { error } = await supabase.auth.signInWithOtp({
      email: accion.email,
      options: { emailRedirectTo: urlDeVuelta(destino) },
    });
    if (error) return { tipo: "error", codigo: codigoDeError(error.code) };
    // Mensaje neutro: no confirma si el correo existía (S-29).
    return {
      tipo: "ok",
      aviso:
        "Si el correo es válido, te enviamos un enlace de acceso. Ábrelo en este mismo dispositivo para entrar.",
    };
  }

  if (accion.accion === "contrasena") {
    const { error } = await supabase.auth.signInWithPassword({
      email: accion.email,
      password: accion.password,
    });
    if (error) return { tipo: "error", codigo: codigoDeError(error.code) };
    return { tipo: "ok", redirigir: destino };
  }

  const { data, error } = await supabase.auth.signUp({
    email: accion.email,
    password: accion.password,
    options: { emailRedirectTo: urlDeVuelta(destino) },
  });
  if (error) return { tipo: "error", codigo: codigoDeError(error.code) };
  // Si el proyecto no exige confirmación por correo, Supabase ya devuelve sesión.
  if (data.session) return { tipo: "ok", redirigir: destino };
  return {
    tipo: "ok",
    aviso: "Cuenta creada. Revisa tu correo para confirmarla y luego vuelve a entrar.",
  };
}
