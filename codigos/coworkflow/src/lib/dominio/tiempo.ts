/**
 * Utilidades de fecha/hora en la zona horaria de una zona. Módulo PURO (sin React,
 * Supabase ni next/*) para poder probarlo con Vitest en la Etapa 6.
 *
 * API pública mínima, la que realmente usa el dashboard:
 * - `horaLocalEnZona` → hora 0..23 de cada snapshot (curva de hoy, construida en el servidor).
 * - `horaDeTexto` → convierte `zonas.hora_apertura` / `hora_cierre` (`time` de Postgres).
 * - `horarioDelDia` → horario del día en minutos locales (o `null` si ese día no abre). Con
 *   `horarios_zona` usa la fila del día ISO y devuelve `null` si ese día no tiene fila; sin filas
 *   semanales cae al horario único `hora_apertura`/`hora_cierre`. Es la ÚNICA entrada de horario
 *   para `textoEstadoHorario` y para el «mejor momento».
 * - `textoEstadoHorario` → «Abierto hasta las HH:MM» / «Cerrado · abre …», con minutos.
 * - `diaSemanaEnZona` → día ISO 1..7, la misma convención que `ocupacion_por_franja`.
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

/** Horas de un día civil; el cierre `24:00` llega a 24. */
const HORAS_POR_DIA = 24;

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

const FORMATOS_FECHA_HORA = new Map<string, Intl.DateTimeFormat | null>();

/**
 * Fecha y hora legibles de un instante ISO en la zona (`es-CL`, formato corto).
 *
 * Se usa en la isla de Realtime para mostrar el `updated_at` de `ocupacion_actual` cuando
 * llega un cambio en vivo. Devuelve `null` si el instante o la zona no son válidos: la UI
 * simplemente omite la marca de tiempo en vez de inventar una fecha.
 */
export function formatearFechaHoraLocal(
  instante: string | null,
  timezone: string,
): string | null {
  if (typeof instante !== "string" || instante.length === 0) return null;

  const fecha = new Date(instante);
  if (Number.isNaN(fecha.getTime())) return null;

  let formato = FORMATOS_FECHA_HORA.get(timezone);
  if (formato === undefined) {
    try {
      formato = new Intl.DateTimeFormat("es-CL", {
        dateStyle: "short",
        timeStyle: "short",
        timeZone: timezone,
      });
    } catch {
      // Zona inexistente o motor sin datos de tz: se falla cerrado.
      formato = null;
    }
    FORMATOS_FECHA_HORA.set(timezone, formato);
  }

  if (!formato) return null;

  return formato.format(fecha);
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

/**
 * Minutos locales desde medianoche de un `time` de Postgres (`"09:30"`, `"09:30:00"` o el
 * cierre `"24:00"`). `24:00` devuelve 1440. Es la versión con minutos de `horaDeTexto`, que
 * se conserva porque el dashboard histórico trabaja en horas enteras.
 */
function minutosDeHoraTexto(valor: string): number | null {
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

  if (hora === 24 && (minuto !== 0 || segundo !== 0)) return null;

  return hora * 60 + minuto;
}

/** Formatea minutos desde medianoche como `HH:MM`; `1440` → `"24:00"`. */
export function formatearHoraEnMinutos(minutos: number): string | null {
  if (
    !Number.isInteger(minutos) ||
    minutos < 0 ||
    minutos > HORAS_POR_DIA * 60
  ) {
    return null;
  }

  const hora = Math.floor(minutos / 60);
  const resto = minutos % 60;
  return `${String(hora).padStart(2, "0")}:${String(resto).padStart(2, "0")}`;
}

/**
 * Día de la semana ISO 8601 (1 = lunes … 7 = domingo) de un instante en la zona.
 *
 * Misma convención que `public.ocupacion_por_franja` (`extract(isodow from …)` en la
 * migración 9), no la de `Date.getDay()` (0 = domingo). Así `dow` sirve directamente para
 * filtrar `FilaFranja`.
 */
export function diaSemanaEnZona(
  instante: Date,
  timezone: string,
): number | null {
  const fecha = fechaCivilEnZona(instante, timezone);
  if (!fecha) return null;

  const diaUtc = new Date(
    Date.UTC(fecha.anio, fecha.mes - 1, fecha.dia),
  ).getUTCDay();

  // getUTCDay(): 0 = domingo … 6 = sábado → ISO: 1 = lunes … 7 = domingo.
  return diaUtc === 0 ? 7 : diaUtc;
}

/** Horario de un día en minutos locales desde medianoche (0..1440). */
export type HorarioDia = { apertura: number; cierre: number };

/** Fila de `public.horarios_zona`: `dia_semana` ISO 8601 (1 = lunes … 7 = domingo). */
export type HorarioSemanalDia = {
  dia_semana: number;
  apertura: string;
  cierre: string;
};

/** Datos mínimos de una zona para resolver su horario. */
export type ZonaHorario = {
  hora_apertura: string;
  hora_cierre: string;
  timezone: string;
  /** Horario semanal (migración 10); sin filas se usa el horario único de la zona. */
  horarios_zona?: readonly HorarioSemanalDia[];
};

/** Valida un par `apertura`/`cierre` y lo convierte a minutos locales. */
function horarioDesdeTextos(
  aperturaTexto: string,
  cierreTexto: string,
): HorarioDia | null {
  const apertura = minutosDeHoraTexto(aperturaTexto);
  const cierre = minutosDeHoraTexto(cierreTexto);
  if (apertura === null || cierre === null) return null;
  if (apertura < 0 || apertura >= cierre || cierre > HORAS_POR_DIA * 60) {
    return null;
  }

  return { apertura, cierre };
}

/**
 * Horario de la zona para el día de `instante`, en minutos locales, o `null` si ese día está
 * cerrado.
 *
 * Con horario semanal (`horarios_zona`) manda la fila del día ISO local —la misma convención
 * `isodow` 1 = lunes que `diaSemanaEnZona` y `ocupacion_por_franja`— y un día sin fila está
 * cerrado. Una zona sin filas conserva el horario único `hora_apertura`/`hora_cierre`
 * (compatibilidad con zonas anteriores a la migración 10).
 */
export function horarioDelDia(
  zona: ZonaHorario,
  instante: Date,
): HorarioDia | null {
  // Falla cerrado si la zona horaria o el instante no son válidos.
  if (!fechaCivilEnZona(instante, zona.timezone)) return null;

  const semanal = zona.horarios_zona;
  if (semanal && semanal.length > 0) {
    const dia = diaSemanaEnZona(instante, zona.timezone);
    if (dia === null) return null;

    const fila = semanal.find((horario) => horario.dia_semana === dia);
    return fila ? horarioDesdeTextos(fila.apertura, fila.cierre) : null;
  }

  return horarioDesdeTextos(zona.hora_apertura, zona.hora_cierre);
}

/** «Lunes», «Martes»… de un instante en la zona; `null` si el motor no resuelve la zona. */
const FORMATOS_DIA = new Map<string, Intl.DateTimeFormat | null>();

function nombreDiaEnZona(instante: Date, timezone: string): string | null {
  let formato = FORMATOS_DIA.get(timezone);
  if (formato === undefined) {
    try {
      formato = new Intl.DateTimeFormat("es-CL", {
        weekday: "long",
        timeZone: timezone,
      });
    } catch {
      formato = null;
    }
    FORMATOS_DIA.set(timezone, formato);
  }

  if (!formato) return null;

  const nombre = formato.format(instante);
  if (!nombre) return null;
  return nombre.charAt(0).toUpperCase() + nombre.slice(1);
}

/** Días que se buscan hacia adelante para encontrar el próximo día abierto. */
const MAX_DIAS_PROXIMA_APERTURA = 7;

/**
 * Estado del horario en lenguaje natural, con minutos: «Abierto hasta las 18:00»,
 * «Cerrado · abre a las 08:30», «Cerrado · abre mañana a las 08:30» o
 * «Cerrado · abre el lunes a las 08:30».
 *
 * - Usa SOLO `horarioDelDia` (nunca `hora_apertura`/`hora_cierre` directamente): el horario
 *   semanal de la migración 10 se resuelve ahí, sin tocar esta función.
 * - Si hoy ya cerró o el día está cerrado, busca el próximo día abierto como máximo 7 días
 *   hacia adelante; si ninguno abre, devuelve `null` y la UI omite la línea. A más de un día de
 *   distancia se nombra el día («el lunes»); al día siguiente, «mañana».
 * - Un horario inválido o una zona horaria desconocida también devuelven `null` (falla
 *   cerrado: mejor no mostrar nada que afirmar un horario que no se pudo leer).
 */
export function textoEstadoHorario(
  zona: ZonaHorario,
  ahora: Date,
): string | null {
  const partes = partesEnZona(ahora, zona.timezone);
  const hoy = fechaCivilEnZona(ahora, zona.timezone);
  if (!partes || !hoy) return null;

  const minutosAhora = partes.hora * 60 + partes.minuto;
  const horarioHoy = horarioDelDia(zona, ahora);

  if (horarioHoy) {
    if (
      minutosAhora >= horarioHoy.apertura &&
      minutosAhora < horarioHoy.cierre
    ) {
      const hasta = formatearHoraEnMinutos(horarioHoy.cierre);
      return hasta ? `Abierto hasta las ${hasta}` : null;
    }

    if (minutosAhora < horarioHoy.apertura) {
      const desde = formatearHoraEnMinutos(horarioHoy.apertura);
      return desde ? `Cerrado · abre a las ${desde}` : null;
    }
  }

  // Ya cerró (o hoy no abre): se busca el próximo día abierto, desde mañana.
  for (let salto = 1; salto <= MAX_DIAS_PROXIMA_APERTURA; salto += 1) {
    const fecha = restarDiasCiviles(hoy, -salto);
    // Mediodía local: nunca cae en el hueco/ambigüedad de DST.
    const mediodia = instanteMediodiaEnZona(fecha, zona.timezone);
    if (!mediodia) return null;

    const horario = horarioDelDia(zona, mediodia);
    if (!horario) continue;

    const apertura = formatearHoraEnMinutos(horario.apertura);
    if (!apertura) return null;

    const cuando =
      salto === 1
        ? "mañana"
        : nombreDiaEnZona(mediodia, zona.timezone)?.toLowerCase();
    if (!cuando) return null;

    return salto === 1
      ? `Cerrado · abre mañana a las ${apertura}`
      : `Cerrado · abre el ${cuando} a las ${apertura}`;
  }

  return null;
}

