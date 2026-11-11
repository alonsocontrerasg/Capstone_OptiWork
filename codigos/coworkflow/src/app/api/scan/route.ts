import { NextResponse, type NextRequest } from "next/server";

import { obtenerSesion, type SesionActual } from "@/lib/auth/session";
import {
  esResultadoExitoso,
  esResultadoScan,
  mapearResultadoScan,
  type ResultadoScan,
} from "@/lib/dominio/scan";
import { peticionDelMismoOrigen } from "@/lib/http/origen";
import {
  LIMITE_SCAN_POR_IP,
  LIMITE_SCAN_POR_USUARIO,
  limitarPorIp,
  limitarPorUsuario,
  type ResultadoLimite,
} from "@/lib/rate-limit";
import { crearClienteServidor } from "@/lib/supabase/server";
import { esquemaCuerpoScan } from "@/lib/validacion/scan";

/**
 * `POST /api/scan` — registra una entrada o salida a partir del token del QR.
 *
 * El cuerpo es `{ t: "<token>" }` y la ruta **no** verifica la firma ni interpreta zona ni
 * modo: solo transporta el token a la RPC `registrar_scan`, que hace toda la validación en
 * una transacción y devuelve un `public.resultado_scan` (S-16, S-33).
 *
 * Orden de las comprobaciones (de más barata a más cara):
 *   1. mismo origen (S-28) → 2. Content-Type → 3. límite por IP → 4. tamaño y parseo del
 *   cuerpo → 5. sesión → 6. límite por usuario → 7. zod → 8. RPC.
 * El límite por IP va antes de leer el cuerpo porque frena el barrido de tokens incluso sin
 * cookie válida y no gasta memoria/CPU en JSON ajeno; el límite por usuario es el fino (S-30).
 */

/** Todas las respuestas describen asistencia: nunca cachear. */
const CABECERAS_SIN_CACHE = {
  "Cache-Control": "no-store, max-age=0, must-revalidate",
};

/**
 * El cuerpo legítimo es `{"t":"<token>"}` (~135 bytes). 1 KiB deja aire para espacios o
 * claves extra y corta cualquier intento de mandar un cuerpo grande.
 */
const MAX_CUERPO_BYTES = 1024;

function respuestaJson(cuerpo: unknown, estado = 200): NextResponse {
  return NextResponse.json(cuerpo, {
    status: estado,
    headers: CABECERAS_SIN_CACHE,
  });
}

/** Fallo de transporte/forma: solo un código, sin mensajes de validación (S-15). */
function respuestaError(codigo: string, estado: number): NextResponse {
  return respuestaJson({ error: codigo }, estado);
}

/**
 * Respuesta de negocio. `ok` es `true` únicamente en `entrada_ok`/`salida_ok`; el resto son
 * avisos esperados (sesión ya abierta, cooldown, token vencido…) con su HTTP y su mensaje.
 */
function respuestaResultado(resultado: ResultadoScan): NextResponse {
  const { http, mensaje } = mapearResultadoScan(resultado);
  return respuestaJson(
    { ok: esResultadoExitoso(resultado), resultado, mensaje },
    http,
  );
}

/** Registra en el log SOLO el nombre del error: nunca el objeto, el cuerpo ni el token. */
function registrarFalloInesperado(contexto: string, error: unknown): void {
  const nombre = error instanceof Error ? error.name : "ErrorDesconocido";
  console.error(`scan: ${contexto} (${nombre})`);
}

export async function POST(request: NextRequest) {
  if (!peticionDelMismoOrigen(request)) {
    return respuestaError("origen_invalido", 403);
  }

  const tipoContenido = (request.headers.get("content-type") ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (tipoContenido !== "application/json") {
    return respuestaError("tipo_contenido_invalido", 415);
  }

  // El límite por IP va antes de leer el cuerpo: frena el barrido de tokens y los cuerpos
  // basura sin gastar memoria ni CPU en parsear JSON. Falla cerrada si Upstash no responde
  // (S-08): sin límite no hay servicio, porque el barrido de tokens quedaría abierto (S-30).
  let limiteIp: ResultadoLimite;
  try {
    limiteIp = await limitarPorIp(request, LIMITE_SCAN_POR_IP);
  } catch (error) {
    registrarFalloInesperado("rate limit por IP no disponible", error);
    return respuestaError("error_interno", 500);
  }
  if (!limiteIp.permitido) {
    return respuestaResultado("rate_limited");
  }

  // Tamaño: si el cliente declara un `content-length` excesivo se corta sin leer el cuerpo.
  // Si la cabecera miente (o falta, p. ej. con chunked), se revalida con los bytes reales.
  const declarado = request.headers.get("content-length");
  if (declarado !== null) {
    const bytesDeclarados = Number(declarado);
    if (!Number.isFinite(bytesDeclarados) || bytesDeclarados < 0) {
      return respuestaError("datos_invalidos", 400);
    }
    if (bytesDeclarados > MAX_CUERPO_BYTES) {
      return respuestaError("cuerpo_demasiado_grande", 413);
    }
  }

  let bytesCuerpo: Uint8Array;
  try {
    bytesCuerpo = new Uint8Array(await request.arrayBuffer());
  } catch {
    return respuestaError("datos_invalidos", 400);
  }
  if (bytesCuerpo.byteLength > MAX_CUERPO_BYTES) {
    return respuestaError("cuerpo_demasiado_grande", 413);
  }

  let cuerpo: unknown;
  try {
    // `fatal: true` rechaza bytes que no sean UTF-8 válido; el JSON roto cae en el mismo
    // código que un cuerpo con forma incorrecta, así no se distinguen (S-15).
    const texto = new TextDecoder("utf-8", { fatal: true }).decode(bytesCuerpo);
    cuerpo = JSON.parse(texto);
  } catch {
    return respuestaError("datos_invalidos", 400);
  }

  let sesion: SesionActual | null;
  try {
    sesion = await obtenerSesion();
  } catch (error) {
    registrarFalloInesperado("no se pudo leer la sesión", error);
    return respuestaError("error_interno", 500);
  }
  if (!sesion) {
    return respuestaResultado("no_autenticado");
  }

  let limiteUsuario: ResultadoLimite;
  try {
    limiteUsuario = await limitarPorUsuario(
      sesion.usuario.id,
      LIMITE_SCAN_POR_USUARIO,
    );
  } catch (error) {
    registrarFalloInesperado("rate limit por usuario no disponible", error);
    return respuestaError("error_interno", 500);
  }
  if (!limiteUsuario.permitido) {
    return respuestaResultado("rate_limited");
  }

  // Los mensajes de zod describen el formato esperado y ayudan a construir un token válido,
  // así que NO se devuelven: al cliente solo le llega `datos_invalidos` (S-15).
  const validado = esquemaCuerpoScan.safeParse(cuerpo);
  if (!validado.success) {
    return respuestaError("datos_invalidos", 400);
  }

  try {
    const supabase = await crearClienteServidor();
    const { data, error } = await supabase.rpc("registrar_scan", {
      p_token: validado.data.t,
    });

    if (error) {
      // Solo el código: `message`/`details` pueden arrastrar el token y datos personales.
      console.error(`scan: la RPC devolvió error (${error.code ?? "desconocido"})`);
      return respuestaError("error_interno", 500);
    }

    // `data` llega como string desde PostgREST. Un valor fuera del enum (desincronización,
    // NULL, objeto raro) se trata como fallo del servidor: nunca se inventa un mensaje.
    if (!esResultadoScan(data)) {
      console.error("scan: la RPC devolvió un resultado desconocido");
      return respuestaError("error_interno", 500);
    }

    return respuestaResultado(data);
  } catch (error) {
    registrarFalloInesperado("fallo inesperado al llamar a la RPC", error);
    return respuestaError("error_interno", 500);
  }
}
