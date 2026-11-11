import { NextResponse, type NextRequest } from "next/server";

import { ejecutarAccionAuth, type ResultadoAuth } from "@/lib/auth/acciones";
import { normalizarDestinoInterno } from "@/lib/auth/redirects";
import { peticionDelMismoOrigen } from "@/lib/http/origen";
import {
  LIMITE_LOGIN_POR_CORREO,
  LIMITE_LOGIN_POR_IP,
  hashCorreo,
  limitar,
  limitarPorIp,
  type ResultadoLimite,
} from "@/lib/rate-limit";
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
 * Registra en el log SOLO el nombre del error. El cuerpo de la petición lleva correo y
 * contraseña, y los errores de las librerías suelen arrastrar el payload en
 * `details`/`cause`: registrar el objeto completo sería una fuga de credenciales y de datos
 * personales (S-29).
 */
function registrarFalloInesperado(contexto: string, error: unknown): void {
  const nombre = error instanceof Error ? error.name : "ErrorDesconocido";
  console.error(`auth/login: ${contexto} (${nombre})`);
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
 * Orden: mismo origen → `Content-Type` → límite por IP → parseo y zod → límite por correo →
 * acción de Auth. El límite por IP va antes de leer el cuerpo porque frena el barrido de
 * correos sin gastar CPU; el límite por correo (clave = hash del correo, nunca en claro) es
 * el fino y se aplica antes de llamar a Supabase, así que responde igual exista o no la
 * cuenta.
 *
 * Protecciones: mismo origen (S-28), `Content-Type: application/json`, rate limit en dos
 * cubos (S-30/S-31), validación con zod y mensajes de error genéricos (anti-enumeración).
 * Un `try/catch` degrada cualquier fallo inesperado a `codigo: "generico"`, sin filtrar
 * detalles al cliente ni a los logs.
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

  // Límite por IP antes de leer el cuerpo y de tocar Supabase: frena el barrido de correos
  // (enumeración) y el spam de magic links sin gastar memoria ni CPU (S-30). Falla cerrada
  // si Upstash no responde: sin límite, el endpoint queda abierto a fuerza bruta (S-08).
  let limiteIp: ResultadoLimite;
  try {
    limiteIp = await limitarPorIp(request, LIMITE_LOGIN_POR_IP);
  } catch (error) {
    registrarFalloInesperado("rate limit por IP no disponible", error);
    return respuestaJson({ ok: false, codigo: "generico" }, 500);
  }
  if (!limiteIp.permitido) {
    return respuestaJson({ ok: false, codigo: "limite_intentos" }, 429);
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

  // Límite por correo: la clave es el HMAC del correo normalizado (trim + minúsculas), nunca
  // el correo en claro, así que Redis no guarda datos personales (S-31). Se responde lo mismo
  // exista o no la cuenta y sin consultar Supabase, así que el 429 no permite enumerar.
  let limiteCorreo: ResultadoLimite;
  try {
    limiteCorreo = await limitar(
      await hashCorreo(validado.data.email),
      LIMITE_LOGIN_POR_CORREO,
    );
  } catch (error) {
    registrarFalloInesperado("rate limit por correo no disponible", error);
    return respuestaJson({ ok: false, codigo: "generico" }, 500);
  }
  if (!limiteCorreo.permitido) {
    return respuestaJson({ ok: false, codigo: "limite_intentos" }, 429);
  }

  const destino = normalizarDestinoInterno(validado.data.destino);

  let resultado: ResultadoAuth;
  try {
    resultado = await ejecutarAccionAuth(validado.data, destino);
  } catch (error) {
    // Fallo inesperado (Supabase 5xx, red caída, bug de la librería). Se responde con un
    // código genérico para que el cliente muestre su mensaje; en el log va solo el nombre
    // del error (ver `registrarFalloInesperado`, S-29).
    registrarFalloInesperado("fallo inesperado en la acción de auth", error);
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
