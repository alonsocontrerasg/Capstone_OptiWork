import "server-only";

import { isIP } from "node:net";

import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

import { credencialesUpstash, envServidor } from "@/lib/env.server";
import { firmarHmacHex } from "@/lib/qr/token";

/**
 * Rate limiting de los endpoints de escritura (S-08, S-30).
 *
 * - En producción usa Upstash Redis (obligatorio: en serverless no hay memoria compartida
 *   entre invocaciones). `credencialesUpstash()` se llama al USAR el limitador, no al
 *   importar, para que `next build` no exija el servicio.
 * - En desarrollo, sin credenciales, cae a un contador en memoria y avisa una sola vez.
 *   Ese contador separa las claves por `prefijo`, así `scan:ip` y `login:ip` no comparten
 *   cubo.
 * - Si en producción faltan las credenciales, Redis falla o la comprobación supera el
 *   timeout de Upstash, el error se propaga y las rutas responden 500 genérico (falla
 *   cerrada). Ojo: ante timeout la librería es fail-open (`success: true`,
 *   `reason: "timeout"`), así que `limitar()` lo convierte en error a propósito. El
 *   timeout no se configura aquí: se usa el valor por defecto de la librería (5000 ms).
 * - En Redis solo se guardan claves ya hasheadas (IP y correo), nunca el valor en claro
 *   (S-31). El id de usuario es un UUID seudónimo y se usa tal cual.
 */

export type ConfiguracionLimite = {
  limite: number;
  ventanaSegundos: number;
  prefijo: string;
};

export type ResultadoLimite = {
  permitido: boolean;
  restante: number;
  reinicioMs: number;
};

/** IP fija en desarrollo: no se confía en cabeceras que el cliente puede falsificar. */
const IP_DESARROLLO = "127.0.0.1";

/** Cabecera que la edge de Vercel fija (y sobrescribe si el cliente la envía). */
const CABECERA_IP_VERCEL = "x-vercel-forwarded-for";

// Límites ajustables. Se calibraron pensando en el NAT del cowork: muchos usuarios
// legítimos comparten IP, así que el límite por IP es holgado y el fino es por usuario.
export const LIMITE_SCAN_POR_IP: ConfiguracionLimite = {
  limite: 60,
  ventanaSegundos: 60,
  prefijo: "scan:ip",
};

export const LIMITE_SCAN_POR_USUARIO: ConfiguracionLimite = {
  limite: 10,
  ventanaSegundos: 60,
  prefijo: "scan:usuario",
};

export const LIMITE_LOGIN_POR_IP: ConfiguracionLimite = {
  limite: 30,
  ventanaSegundos: 15 * 60,
  prefijo: "login:ip",
};

export const LIMITE_LOGIN_POR_CORREO: ConfiguracionLimite = {
  limite: 5,
  ventanaSegundos: 15 * 60,
  prefijo: "login:correo",
};

// -----------------------------------------------------------------------------
// IP
// -----------------------------------------------------------------------------

/**
 * Reduce una IPv6 a su prefijo /64 antes de hashear: un mismo cliente puede rotar la parte
 * baja de la dirección y multiplicar buckets sin cambiar de red.
 */
function prefijoIpv6(ip: string): string | null {
  const sinZona = ip.split("%")[0];
  const partes = sinZona.split("::");
  if (partes.length > 2) return null;

  let grupos: string[];
  if (partes.length === 2) {
    const izquierda = partes[0] ? partes[0].split(":") : [];
    const derecha = partes[1] ? partes[1].split(":") : [];
    const relleno = 8 - izquierda.length - derecha.length;
    if (relleno < 0) return null;
    grupos = [
      ...izquierda,
      ...Array.from({ length: relleno }, () => "0"),
      ...derecha,
    ];
  } else {
    grupos = sinZona.split(":");
  }

  if (grupos.length !== 8) return null;

  const primeros: string[] = [];
  for (const grupo of grupos.slice(0, 4)) {
    if (!/^[0-9a-f]{1,4}$/i.test(grupo)) return null;
    primeros.push(grupo.padStart(4, "0").toLowerCase());
  }
  return primeros.join(":");
}

/** Normaliza IPv4/IPv6 a una forma estable; `null` si no se puede interpretar. */
function normalizarIp(entrada: string): string | null {
  const valor = entrada.trim();
  if (!valor) return null;

  const sinCorchetes =
    valor.startsWith("[") && valor.endsWith("]") ? valor.slice(1, -1) : valor;

  const familia = isIP(sinCorchetes);
  if (familia === 4) return sinCorchetes;
  if (familia === 6) {
    const mapeada = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(sinCorchetes);
    if (mapeada) return mapeada[1];
    return prefijoIpv6(sinCorchetes);
  }

  const conPuerto = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(sinCorchetes);
  if (conPuerto && isIP(conPuerto[1]) === 4) return conPuerto[1];

  return null;
}

/**
 * IP del cliente para rate limiting.
 *
 * Solo se confía en `x-vercel-forwarded-for`, que la plataforma fija en el borde; no hay
 * fallback a `x-forwarded-for` ni a otras cabeceras porque el cliente puede falsificarlas.
 * En producción, si falta o no se puede interpretar, devuelve `null` y el llamador debe
 * fallar cerrado.
 */
export function obtenerIp(request: Request): string | null {
  if (process.env.NODE_ENV === "development") {
    return IP_DESARROLLO;
  }

  const cabecera = request.headers.get(CABECERA_IP_VERCEL);
  if (!cabecera) return null;

  return normalizarIp(cabecera.split(",")[0] ?? "");
}

/** HMAC-SHA256 hex completo (64 caracteres) de la IP normalizada, con prefijo de dominio. */
export function hashIp(ip: string): Promise<string> {
  return firmarHmacHex(`rate-limit:ip:v1:${ip}`, envServidor.QR_TOKEN_SECRET);
}

/** HMAC-SHA256 hex completo del correo normalizado (trim + minúsculas). */
export function hashCorreo(correo: string): Promise<string> {
  return firmarHmacHex(
    `rate-limit:email:v1:${correo.trim().toLowerCase()}`,
    envServidor.QR_TOKEN_SECRET,
  );
}

// -----------------------------------------------------------------------------
// Almacenes
// -----------------------------------------------------------------------------

let clienteRedis: Redis | null = null;
const limitadores = new Map<string, Ratelimit>();

function obtenerLimitador(
  config: ConfiguracionLimite,
  credenciales: { url: string; token: string },
): Ratelimit {
  const llave = `${config.prefijo}:${config.limite}:${config.ventanaSegundos}`;
  const existente = limitadores.get(llave);
  if (existente) return existente;

  if (!clienteRedis) {
    clienteRedis = new Redis({
      url: credenciales.url,
      token: credenciales.token,
    });
  }
  const redis = clienteRedis;

  const limitador = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(
      config.limite,
      `${config.ventanaSegundos} s`,
    ),
    prefix: `cw:rl:${config.prefijo}`,
  });

  limitadores.set(llave, limitador);
  return limitador;
}

const contadoresMemoria = new Map<string, number[]>();
let avisoMemoriaEmitido = false;

function limitarEnMemoria(
  clave: string,
  config: ConfiguracionLimite,
): ResultadoLimite {
  const ahora = Date.now();
  const ventanaMs = config.ventanaSegundos * 1000;
  const desde = ahora - ventanaMs;
  const llave = `${config.prefijo}:${clave}`;

  const previos = (contadoresMemoria.get(llave) ?? []).filter(
    (ts) => ts > desde,
  );
  const permitido = previos.length < config.limite;
  if (permitido) previos.push(ahora);
  contadoresMemoria.set(llave, previos);

  // Limpieza oportunista para que el Map no crezca sin control en un `next dev` largo.
  if (contadoresMemoria.size > 5000) {
    for (const [claveContador, marcas] of contadoresMemoria) {
      if (marcas.every((ts) => ts <= desde)) {
        contadoresMemoria.delete(claveContador);
      }
    }
  }

  return {
    permitido,
    restante: Math.max(0, config.limite - previos.length),
    reinicioMs: previos.length > 0 ? previos[0] + ventanaMs : ahora,
  };
}

// -----------------------------------------------------------------------------
// API pública
// -----------------------------------------------------------------------------

/**
 * Consume un intento de la clave indicada. La clave debe venir ya hasheada si es un dato
 * personal (IP, correo). Lanza si en producción falta Upstash o si Redis falla: el llamador
 * responde 500 genérico (falla cerrada).
 */
export async function limitar(
  clave: string,
  config: ConfiguracionLimite,
): Promise<ResultadoLimite> {
  const credenciales = credencialesUpstash();

  if (!credenciales) {
    if (!avisoMemoriaEmitido) {
      avisoMemoriaEmitido = true;
      console.warn(
        "[rate-limit] Upstash no configurado: contador en memoria (solo válido en desarrollo local).",
      );
    }
    return limitarEnMemoria(clave, config);
  }

  const { success, remaining, reset, reason } = await obtenerLimitador(
    config,
    credenciales,
  ).limit(clave);

  // La librería es fail-open ante timeout: devuelve success: true con reason: "timeout"
  // (index.mjs:910-917 de @upstash/ratelimit@2.2.0). Se trata como fallo para no dejar
  // pasar tráfico sin límite; la ruta responde 500 genérico (falla cerrada).
  if (reason === "timeout") {
    throw new Error("Rate limit no disponible: timeout de Upstash");
  }

  return { permitido: success, restante: remaining, reinicioMs: reset };
}

/** Limita por IP del cliente. Sin IP confiable en producción, falla cerrado. */
export async function limitarPorIp(
  request: Request,
  config: ConfiguracionLimite,
): Promise<ResultadoLimite> {
  const ip = obtenerIp(request);
  if (ip === null) {
    return {
      permitido: false,
      restante: 0,
      reinicioMs: Date.now() + config.ventanaSegundos * 1000,
    };
  }

  return limitar(await hashIp(ip), config);
}

/** Limita por usuario autenticado (UUID seudónimo). */
export function limitarPorUsuario(
  usuarioId: string,
  config: ConfiguracionLimite,
): Promise<ResultadoLimite> {
  return limitar(`usuario:${usuarioId}`, config);
}
