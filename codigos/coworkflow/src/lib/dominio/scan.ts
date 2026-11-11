/**
 * Resultados de `public.registrar_scan(p_token)` y su traducción a HTTP/mensajes.
 *
 * El tipo de retorno real de la RPC es el enum `public.resultado_scan` (ver
 * `supabase/migrations/20261106000000_enums_y_tablas.sql` y
 * `20261110000000_consentimiento_y_scan.sql`), que en JavaScript llega como string.
 *
 * Este módulo es PURO (sin `next/*`, Supabase ni React) para poder probarlo con Vitest en la
 * Etapa 6. MAPA_RESULTADO_SCAN es exhaustivo respecto de RESULTADOS_SCAN: si se agrega un
 * literal a la lista y falta en el mapa, TypeScript no compila. La lista se mantiene a mano:
 * al agregar un valor al enum de la base de datos hay que agregarlo también aquí. Mientras
 * tanto, un valor desconocido hace que esResultadoScan() devuelva false y el llamador
 * responda 500 genérico (falla cerrada) (S-33).
 */

export const RESULTADOS_SCAN = [
  "entrada_ok",
  "salida_ok",
  "sesion_ya_abierta",
  "sin_sesion_abierta",
  "cooldown",
  "demasiados_intentos",
  "token_expirado",
  "token_invalido",
  "no_autenticado",
  "fuera_horario",
  "zona_inactiva",
  "rate_limited",
  "sin_consentimiento",
] as const;

export type ResultadoScan = (typeof RESULTADOS_SCAN)[number];

export type MapeoResultadoScan = {
  /** Código HTTP que devuelve `POST /api/scan`. */
  http: number;
  /** Mensaje en español apto para mostrar al usuario. Nunca incluye datos personales. */
  mensaje: string;
};

/** Mismo texto para ambos casos: no se revela si el token existió alguna vez. */
const MENSAJE_TOKEN_VENCIDO = "El código venció, escanea el QR nuevamente";

export const MAPA_RESULTADO_SCAN: Record<ResultadoScan, MapeoResultadoScan> = {
  entrada_ok: { http: 200, mensaje: "Entrada registrada" },
  salida_ok: { http: 200, mensaje: "Salida registrada" },
  sesion_ya_abierta: { http: 409, mensaje: "Ya tienes una entrada activa" },
  sin_sesion_abierta: { http: 409, mensaje: "No tienes una entrada activa" },
  cooldown: {
    http: 429,
    mensaje: "Espera unos segundos antes de volver a escanear",
  },
  demasiados_intentos: {
    http: 429,
    mensaje:
      "Demasiados intentos seguidos. Espera un minuto y vuelve a intentar.",
  },
  token_expirado: { http: 403, mensaje: MENSAJE_TOKEN_VENCIDO },
  token_invalido: { http: 403, mensaje: MENSAJE_TOKEN_VENCIDO },
  no_autenticado: { http: 401, mensaje: "Inicia sesión y vuelve a escanear" },
  fuera_horario: { http: 409, mensaje: "El cowork está cerrado" },
  zona_inactiva: { http: 409, mensaje: "Esta zona no está habilitada" },
  rate_limited: { http: 429, mensaje: "Demasiados intentos" },
  sin_consentimiento: {
    http: 403,
    mensaje: "Acepta el aviso de privacidad para marcar tu asistencia",
  },
};

const CONJUNTO_RESULTADOS: ReadonlySet<string> = new Set(RESULTADOS_SCAN);

/**
 * Guard para datos que vienen de Supabase (tipados como `unknown`): ¿es un resultado
 * conocido del enum? Si no lo es, el llamador responde 500 genérico (falla cerrada).
 */
export function esResultadoScan(valor: unknown): valor is ResultadoScan {
  return typeof valor === "string" && CONJUNTO_RESULTADOS.has(valor);
}

export function mapearResultadoScan(
  resultado: ResultadoScan,
): MapeoResultadoScan {
  return MAPA_RESULTADO_SCAN[resultado];
}

/** Solo `entrada_ok` y `salida_ok` son éxitos de negocio. */
export function esResultadoExitoso(resultado: ResultadoScan): boolean {
  return resultado === "entrada_ok" || resultado === "salida_ok";
}

/** Mensaje para fallos que no son del dominio (red caída, 500, JSON roto). */
export const MENSAJE_ERROR_SCAN =
  "No pudimos registrar tu asistencia. Intenta de nuevo.";
