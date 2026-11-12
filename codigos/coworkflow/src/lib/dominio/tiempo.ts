/**
 * Utilidades de fecha/hora en la zona horaria de una zona. Módulo PURO (sin React,
 * Supabase ni next/*) para poder probarlo con Vitest en la Etapa 6.
 *
 * API pública mínima, la que realmente usa el dashboard:
 * - `horaLocalEnZona` → hora 0..23 de cada snapshot (curva de hoy, construida en el servidor).
 * - `horaDeTexto` → convierte `zonas.hora_apertura` / `hora_cierre` (`time` de Postgres).
 * - `limitesRangoDias` → límites representativos para `permanencia_promedio` y
 *   `personas_distintas`. Los helpers de cálculo quedan privados.
 *
 * ¿Por qué no se calcula la medianoche local en JS?
 * `permanencia_promedio` y `personas_distintas` ya alinean p_desde/p_hasta a la medianoche
 * local de la zona dentro de Postgres. En America/Santiago la medianoche puede no existir
 * (septiembre: 00:00 → 01:00) o ser ambigua (abril: 00:00 → 23:00 del día anterior), y
 * replicar esa regla en JS es fuente de errores. Por eso este módulo devuelve instantes
 * representativos del MEDIODÍA local: el mediodía nunca cae en un hueco/ambigüedad de DST
 * y Postgres hace la alineación canónica a medianoche.
 */

type FechaCivil = { anio: number; mes: number; dia: number };

type PartesZona = FechaCivil & {
  hora: number;
  minuto: number;
  segundo: number;
};

const FORMATOS = new Map<string, Intl.DateTimeFormat | null>();

function obtenerFormato(timezone: string): Intl.DateTimeFormat | null {
  if (FORMATOS.has(timezone)) {
    return FORMATOS.get(timezone) ?? null;
  }

  try {
    const formato = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    FORMATOS.set(timezone, formato);
    return formato;
  } catch {
    // Zona inexistente o motor sin datos de tz: se falla cerrado.
    FORMATOS.set(timezone, null);
    return null;
  }
}

function partesEnZona(instante: Date, timezone: string): PartesZona | null {
  if (!(instante instanceof Date) || Number.isNaN(instante.getTime())) {
    return null;
  }

  const formato = obtenerFormato(timezone);
  if (!formato) return null;

  const valores: Record<string, string> = {};
  for (const parte of formato.formatToParts(instante)) {
    if (parte.type !== "literal") valores[parte.type] = parte.value;
  }

  const anio = Number(valores.year);
  const mes = Number(valores.month);
  const dia = Number(valores.day);
  const hora = Number(valores.hour);
  const minuto = Number(valores.minute);
  const segundo = Number(valores.second);

  if (
    !Number.isInteger(anio) ||
    !Number.isInteger(mes) ||
    !Number.isInteger(dia) ||
    !Number.isInteger(hora) ||
    !Number.isInteger(minuto) ||
    !Number.isInteger(segundo) ||
    mes < 1 ||
    mes > 12 ||
    dia < 1 ||
    dia > 31 ||
    hora < 0 ||
    hora > 23 ||
    minuto < 0 ||
    minuto > 59 ||
    segundo < 0 ||
    segundo > 59
  ) {
    return null;
  }

  return { anio, mes, dia, hora, minuto, segundo };
}

/** Fecha civil (año/mes/día) de un instante en la zona. */
function fechaCivilEnZona(
  instante: Date,
  timezone: string,
): FechaCivil | null {
  const partes = partesEnZona(instante, timezone);
  return partes
    ? { anio: partes.anio, mes: partes.mes, dia: partes.dia }
    : null;
}

/** Resta días de calendario a una fecha civil (sin pasar por zonas horarias). */
function restarDiasCiviles(fecha: FechaCivil, dias: number): FechaCivil {
  const desplazamiento = Number.isInteger(dias) ? dias : 0;
  const base = new Date(Date.UTC(fecha.anio, fecha.mes - 1, fecha.dia));
  base.setUTCDate(base.getUTCDate() - desplazamiento);
  return {
    anio: base.getUTCFullYear(),
    mes: base.getUTCMonth() + 1,
    dia: base.getUTCDate(),
  };
}

/** Diferencia (local - UTC) de la zona en ese instante, en milisegundos. */
function offsetZonaMs(instante: Date, timezone: string): number | null {
  const partes = partesEnZona(instante, timezone);
  if (!partes) return null;

  const comoUtc = Date.UTC(
    partes.anio,
    partes.mes - 1,
    partes.dia,
    partes.hora,
    partes.minuto,
    partes.segundo,
  );
  const segundos = Math.floor(instante.getTime() / 1000) * 1000;
  const offset = comoUtc - segundos;
  return Number.isFinite(offset) ? offset : null;
}

/**
 * Instante UTC que corresponde al mediodía local de `fecha` en `timezone`.
 * El mediodía no cae en los huecos/ambigüedades de DST de America/Santiago.
 */
function instanteMediodiaEnZona(
  fecha: FechaCivil,
  timezone: string,
): Date | null {
  const utcSupuesto = Date.UTC(fecha.anio, fecha.mes - 1, fecha.dia, 12, 0, 0);
  if (!Number.isFinite(utcSupuesto)) return null;

  const primerOffset = offsetZonaMs(new Date(utcSupuesto), timezone);
  if (primerOffset === null) return null;

  let instante = utcSupuesto - primerOffset;
  const segundoOffset = offsetZonaMs(new Date(instante), timezone);
  if (segundoOffset !== null && segundoOffset !== primerOffset) {
    // Corrección si el offset cambió al pasar al mediodía local.
    instante = utcSupuesto - segundoOffset;
  }

  return new Date(instante);
}

/**
 * Límites representativos de los últimos `dias` días civiles de la zona, terminando en el
 * día local de `ahora`. Devuelve instantes del mediodía local; las RPC los alinean a
 * medianoche, por lo que el rango efectivo es [medianoche(hoy - dias), medianoche(hoy)).
 *
 * Verificación DST (America/Santiago, 2026): el 2026-04-05 la medianoche es ambigua (00:00
 * vuelve a 23:00 del 04-04) y el 2026-09-06 no existe (00:00 salta a 01:00). Como los
 * extremos devueltos son mediodías locales, `date_trunc('day', x at time zone tz) at time
 * zone tz` en Postgres produce la medianoche correcta sin tocar el hueco/ambigüedad.
 * Comprobado el 2026-11-11 con Postgres 18 y Node 26: para `2026-09-06T12:00Z` el mediodía
 * local es `2026-09-06T15:00Z` (día -7: `2026-08-30T16:00Z`) y para `2026-04-05T12:00Z` es
 * `2026-04-05T16:00Z` (día -7: `2026-03-29T15:00Z`), igual en ambos motores.
 */
export function limitesRangoDias(
  ahora: Date,
  timezone: string,
  dias: number,
): { desde: Date; hasta: Date } | null {
  if (!Number.isInteger(dias) || dias < 1 || dias > 90) return null;

  const hoy = fechaCivilEnZona(ahora, timezone);
  if (!hoy) return null;

  const desde = instanteMediodiaEnZona(restarDiasCiviles(hoy, dias), timezone);
  const hasta = instanteMediodiaEnZona(hoy, timezone);
  if (!desde || !hasta || desde.getTime() >= hasta.getTime()) return null;

  return { desde, hasta };
}

/** Hora local (0..23) de un instante ISO o Date en la zona. */
export function horaLocalEnZona(
  instante: Date | string,
  timezone: string,
): number | null {
  const fecha = typeof instante === "string" ? new Date(instante) : instante;
  const partes = partesEnZona(fecha, timezone);
  return partes ? partes.hora : null;
}

/**
 * Interpreta un `time` de Postgres ("08:00", "08:00:00" o el cierre "24:00") y devuelve la
 * hora (0..23, o 24 solo para `24:00`).
 */
export function horaDeTexto(valor: string): number | null {
  if (typeof valor !== "string") return null;

  const coincidencia = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/.exec(
    valor.trim(),
  );
  if (!coincidencia) return null;

  const hora = Number(coincidencia[1]);
  const minuto = Number(coincidencia[2]);
  const segundo =
    coincidencia[3] === undefined ? 0 : Number(coincidencia[3]);

  if (
    !Number.isInteger(hora) ||
    hora < 0 ||
    hora > 24 ||
    !Number.isInteger(minuto) ||
    minuto < 0 ||
    minuto > 59 ||
    !Number.isInteger(segundo) ||
    segundo < 0 ||
    segundo > 59
  ) {
    return null;
  }

  // `24:00` es el único valor con hora 24 que admite Postgres (`time`).
  if (hora === 24 && (minuto !== 0 || segundo !== 0)) return null;

  return hora;
}

