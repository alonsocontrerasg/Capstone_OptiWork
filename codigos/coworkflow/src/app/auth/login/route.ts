import { NextResponse, type NextRequest } from "next/server";

import { ejecutarAccionAuth, type ResultadoAuth } from "@/lib/auth/acciones";
import { normalizarDestinoInterno } from "@/lib/auth/redirects";
import { peticionDelMismoOrigen } from "@/lib/http/origen";
import { esquemaAccionAuth } from "@/lib/validacion/auth";

/** Respuestas de autenticación: nunca cachear (llevan `Set-Cookie` de sesión). */
const CABECERAS_SIN_CACHE = {
  "Cache-Control": "no-store, max-age=0, must-revalidate",
};

function respuestaJson(cuerpo: unknown, estado = 200): NextResponse {
  return NextResponse.json(cuerpo, {
    status: estado,
    headers: CABECERAS_SIN_CACHE,
  });
}

/**
 * `POST /auth/login` — inicia sesión, registra o envía el magic link.
 *
 * Cuerpo: `{ accion: "enlace" | "contrasena" | "registro", email, password?, destino? }`.
 *
 * Por qué un Route Handler y no el navegador: el cliente de navegador de `@supabase/ssr`
 * escribe las cookies con `document.cookie` y `httpOnly: false`, así que la sesión quedaba
 * legible por JavaScript. Al ejecutar la autenticación aquí, las cookies `sb-*` las emite
 * el servidor con `httpOnly: true` (S-09, S-29).
 *
 * Protecciones: mismo origen (S-28), `Content-Type: application/json`, validación con zod
 * y mensajes de error genéricos (anti-enumeración). Un `try/catch` degrada cualquier fallo
 * inesperado a `codigo: "generico"`, sin filtrar detalles al cliente ni a los logs.
 */
export async function POST(request: NextRequest) {
  if (!peticionDelMismoOrigen(request)) {
    return respuestaJson({ error: "origen_invalido" }, 403);
  }

  const tipoContenido = (request.headers.get("content-type") ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (tipoContenido !== "application/json") {
    return respuestaJson({ error: "tipo_contenido_invalido" }, 415);
  }

  let cuerpo: unknown;
  try {
    cuerpo = await request.json();
  } catch {
    return respuestaJson({ error: "cuerpo_invalido" }, 400);
  }

  const validado = esquemaAccionAuth.safeParse(cuerpo);
  if (!validado.success) {
    return respuestaJson({ error: "datos_invalidos" }, 400);
  }

  const destino = normalizarDestinoInterno(validado.data.destino);

  // TODO(Etapa 4): rate limit por IP y por correo reutilizando el limitador de /api/scan.
  // Mientras no exista, los límites de Supabase Auth son globales porque las peticiones
  // salen del servidor (S-29).

  let resultado: ResultadoAuth;
  try {
    resultado = await ejecutarAccionAuth(validado.data, destino);
  } catch (error) {
    // Fallo inesperado (Supabase 5xx, red caída, bug de la librería). Se responde con un
    // código genérico para que el cliente muestre su mensaje. En el log va SOLO el nombre
    // del error: el cuerpo de la petición lleva correo y contraseña, y los errores de las
    // librerías suelen arrastrar el payload en `details`/`cause`, así que registrar el objeto
    // completo sería una fuga de credenciales y de datos personales (S-29).
    const nombreError = error instanceof Error ? error.name : "ErrorDesconocido";
    console.error(`auth/login: fallo inesperado (${nombreError})`);
    // 500, no 200: es un fallo del servidor y no unas credenciales rechazadas, así las métricas
    // y la monitorización no lo confunden con un login fallido. El cliente muestra el mismo
    // mensaje genérico, porque tolera cualquier respuesta sin `ok: true` (S-29).
    return respuestaJson({ ok: false, codigo: "generico" }, 500);
  }

  if (resultado.tipo === "error") {
    // 200 con `ok:false`: el fallo es de negocio, no de transporte, y el cliente ya
    // muestra un mensaje propio.
    return respuestaJson({ ok: false, codigo: resultado.codigo });
  }

  return respuestaJson({
    ok: true,
    redirigir: resultado.redirigir,
    aviso: resultado.aviso,
  });
}
