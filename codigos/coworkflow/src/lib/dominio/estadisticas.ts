import { horaLocalEnZona } from "@/lib/dominio/tiempo";

/**
 * Agregaciones PURAS del dashboard (sin React, Supabase ni next/*) para probarlas con
 * Vitest en la Etapa 6.
 *
 * Contrato con la migración 9:
 * - `FilaFranja` es una fila de `public.ocupacion_por_franja(zona, 7|30)`.
 * - `PuntoSnapshot` es una fila de `public.ocupacion_hoy(zona)`.
 *
 * Reglas:
 * - Una celda sin muestras es `null` («sin dato»), nunca `0`: el cowork cerrado y el
 *   cowork vacío no son lo mismo.
 * - `dow` es ISO 8601 (1 = lunes … 7 = domingo); la matriz se devuelve con índice 0 = lunes.
 * - Al combinar varias filas de la misma hora se pondera por `muestras`, no por día: así un
 *   día con más snapshots no pesa más que otro.
 * - `horaPunta` desempata por la hora más temprana y devuelve `null` si no hay datos.
 */

export type FilaFranja = {
  dow: number;
  hora: number;
  promedio: number | null;
  muestras: number;
};

export type PuntoSnapshot = { ts: string; cantidad: number };

export type HorarioZona = { apertura: number; cierre: number };

export type PuntoHora = { hora: number; promedio: number };

/**
 * Punto que viaja al Client Component del gráfico de barras: SOLO la etiqueta ya formateada,
 * el promedio redondeado a 1 decimal y cuántas muestras lo respaldan. Nada de snapshots.
 */
export type PuntoPromedioHora = {
  etiqueta: string;
  promedio: number;
  muestras: number;
};

/**
 * Punto que viaja al Client Component de la curva de hoy: `cantidad === null` es un hueco
 * (no hubo snapshots en esa hora), nunca un 0 inventado.
 */
export type PuntoHoraHoy = {
  etiqueta: string;
  cantidad: number | null;
};

export const DIAS_SEMANA = [
  "Lunes",
  "Martes",
  "Miércoles",
  "Jueves",
  "Viernes",
  "Sábado",
  "Domingo",
] as const;

const HORAS_POR_DIA = 24;
const DIAS_POR_SEMANA = 7;

type FilaValida = {
  dow: number;
  hora: number;
  promedio: number;
  muestras: number;
};

function normalizarFila(fila: FilaFranja): FilaValida | null {
  if (
    !Number.isInteger(fila.dow) ||
    fila.dow < 1 ||
    fila.dow > DIAS_POR_SEMANA
  ) {
    return null;
  }
  if (
    !Number.isInteger(fila.hora) ||
    fila.hora < 0 ||
    fila.hora >= HORAS_POR_DIA
  ) {
    return null;
  }
  if (!Number.isInteger(fila.muestras) || fila.muestras <= 0) {
    return null;
  }
  if (
    typeof fila.promedio !== "number" ||
    !Number.isFinite(fila.promedio)
  ) {
    return null;
  }

  return {
    dow: fila.dow,
    hora: fila.hora,
    promedio: fila.promedio,
    muestras: fila.muestras,
  };
}

function dentroDelHorario(
  hora: number,
  horario: HorarioZona | null,
): boolean {
  if (!horario) return true;
  return hora >= horario.apertura && hora < horario.cierre;
}

/**
 * Matriz 7×24 (lunes→domingo × 0→23 h) con el promedio de cada celda o `null` si no hay
 * muestras. `horario` permite descartar horas fuera de apertura/cierre por defensa en
 * profundidad (la RPC ya las filtra).
 */
export function construirMatrizCalor(
  filas: readonly FilaFranja[],
  horario: HorarioZona | null = null,
): (number | null)[][] {
  const sumas = Array.from({ length: DIAS_POR_SEMANA }, () =>
    new Array<number>(HORAS_POR_DIA).fill(0),
  );
  const conteos = Array.from({ length: DIAS_POR_SEMANA }, () =>
    new Array<number>(HORAS_POR_DIA).fill(0),
  );

  for (const fila of filas) {
    const normalizada = normalizarFila(fila);
    if (!normalizada || !dentroDelHorario(normalizada.hora, horario)) continue;

    const dia = normalizada.dow - 1;
    sumas[dia][normalizada.hora] +=
      normalizada.promedio * normalizada.muestras;
    conteos[dia][normalizada.hora] += normalizada.muestras;
  }

  return sumas.map((filaSumas, dia) =>
    filaSumas.map((suma, hora) =>
      conteos[dia][hora] > 0 ? suma / conteos[dia][hora] : null,
    ),
  );
}

/**
 * Serie por hora del día (24 posiciones, `null` donde no hay datos) a partir de las
 * franjas de 7 o 30 días. Cada hora combina los días ponderando por `muestras`.
 */
export function construirSeriePorHora(
  filas: readonly FilaFranja[],
): (number | null)[] {
  const sumas = new Array<number>(HORAS_POR_DIA).fill(0);
  const conteos = new Array<number>(HORAS_POR_DIA).fill(0);

  for (const fila of filas) {
    const normalizada = normalizarFila(fila);
    if (!normalizada) continue;
    sumas[normalizada.hora] +=
      normalizada.promedio * normalizada.muestras;
    conteos[normalizada.hora] += normalizada.muestras;
  }

  return sumas.map((suma, hora) =>
    conteos[hora] > 0 ? suma / conteos[hora] : null,
  );
}

/**
 * Serie por hora de HOY (24 posiciones) a partir de los snapshots del día local. Si se
 * pasa `horario`, las horas fuera de apertura/cierre quedan en `null` para alinear la curva
 * con el gráfico histórico.
 */
export function construirSerieHoy(
  filas: readonly PuntoSnapshot[],
  timezone: string,
  horario: HorarioZona | null = null,
): (number | null)[] {
  const sumas = new Array<number>(HORAS_POR_DIA).fill(0);
  const conteos = new Array<number>(HORAS_POR_DIA).fill(0);

  for (const fila of filas) {
    if (!Number.isInteger(fila.cantidad) || fila.cantidad < 0) continue;

    const hora = horaLocalEnZona(fila.ts, timezone);
    if (hora === null || !dentroDelHorario(hora, horario)) continue;

    sumas[hora] += fila.cantidad;
    conteos[hora] += 1;
  }

  return sumas.map((suma, hora) =>
    conteos[hora] > 0 ? suma / conteos[hora] : null,
  );
}

/** Hora con mayor promedio; empate → la más temprana; sin datos → null. */
export function horaPunta(
  serie: readonly (number | null)[],
): PuntoHora | null {
  let mejor: PuntoHora | null = null;

  for (let hora = 0; hora < serie.length; hora += 1) {
    const valor = serie[hora];
    if (valor === null || !Number.isFinite(valor)) continue;

    // Solo se reemplaza con un promedio ESTRICTAMENTE mayor: así el empate conserva la
    // hora más temprana.
    if (mejor === null || valor > mejor.promedio) {
      mejor = { hora, promedio: valor };
    }
  }

  return mejor;
}

/**
 * Permanencia legible; `null` (k-anonimato o sin datos) → «Sin datos».
 *
 * El corte de «< 1 min» se hace sobre SEGUNDOS, no sobre minutos redondeados: 30 s son
 * 0,5 min y `Math.round` los convertiría en «1 min», que es un dato falso. Cualquier valor
 * menor que 60 s se muestra como «< 1 min».
 */
export function formatearPermanencia(segundos: number | null): string {
  if (segundos === null || !Number.isFinite(segundos) || segundos < 0) {
    return "Sin datos";
  }

  if (segundos < 60) return "< 1 min";

  const minutos = Math.round(segundos / 60);
  const horas = Math.floor(minutos / 60);
  const resto = minutos % 60;

  if (horas === 0) return `${resto} min`;
  if (resto === 0) return `${horas} h`;
  return `${horas} h ${resto} min`;
}

const FORMATO_PERSONAS = new Intl.NumberFormat("es-CL");

/** Personas distintas legibles; `null` (k-anonimato o sin datos) → «Sin datos». */
export function formatearPersonas(valor: number | null): string {
  if (valor === null || !Number.isFinite(valor) || valor < 0) {
    return "Sin datos";
  }

  return FORMATO_PERSONAS.format(Math.round(valor));
}

/** Etiqueta de hora para ejes y tooltips: `8` → `"08:00"`; `24` → `"24:00"` (cierre). */
export function etiquetaHora(hora: number): string {
  if (!Number.isInteger(hora) || hora < 0 || hora > 24) return "—";
  return `${String(hora).padStart(2, "0")}:00`;
}

/** Nombre del día ISO: `1` → `"Lunes"`. */
export function nombreDia(dow: number): string {
  if (!Number.isInteger(dow) || dow < 1 || dow > DIAS_POR_SEMANA) return "—";
  return DIAS_SEMANA[dow - 1];
}

/**
 * Horas (0..23) que cubre el horario de la zona, EN ORDEN: `{8, 20}` → `[8 … 19]`.
 *
 * Las columnas del mapa de calor y las etiquetas de los gráficos se derivan de aquí y no de
 * la lista de filas recibidas: así el eje es estable aunque falten horas sin snapshots. El
 * cierre `24:00` de Postgres se recorta a 23 (la hora 24 no existe como columna).
 * Un horario ausente o incoherente devuelve el día completo: es preferible mostrar 24
 * columnas vacías a inventar un horario que la zona no declaró.
 */
export function horasDelHorario(horario: HorarioZona | null): number[] {
  const valido =
    horario !== null &&
    Number.isInteger(horario.apertura) &&
    Number.isInteger(horario.cierre) &&
    horario.apertura >= 0 &&
    horario.apertura < HORAS_POR_DIA &&
    horario.cierre > horario.apertura;

  const apertura = valido ? horario.apertura : 0;
  const cierre = valido ? Math.min(horario.cierre, HORAS_POR_DIA) : HORAS_POR_DIA;

  const horas: number[] = [];
  for (let hora = apertura; hora < cierre; hora += 1) horas.push(hora);
  return horas;
}

/** Redondeo a 1 decimal: el payload del cliente no lleva precisión de `double precision`. */
function redondearAUnDecimal(valor: number): number {
  return Math.round(valor * 10) / 10;
}

/**
 * Puntos del gráfico «promedio por hora del día» para las `horas` pedidas.
 *
 * - Reutiliza `construirSeriePorHora`, así el promedio sigue ponderado por `muestras`.
 * - Omite las horas sin datos en el rango (una barra ausente es más honesta que una barra
 *   en 0, que sugeriría «cero personas» cuando en realidad no hubo snapshots).
 * - `muestras` es la suma de snapshots de esa hora en todos los días del rango.
 * - El resultado tiene como máximo 24 elementos, con números ya redondeados a 1 decimal.
 */
export function construirPuntosPorHora(
  filas: readonly FilaFranja[],
  horas: readonly number[],
): PuntoPromedioHora[] {
  const serie = construirSeriePorHora(filas);
  const muestras = new Array<number>(HORAS_POR_DIA).fill(0);
  const permitidas = new Set(horas);

  for (const fila of filas) {
    const normalizada = normalizarFila(fila);
    if (!normalizada || !permitidas.has(normalizada.hora)) continue;
    muestras[normalizada.hora] += normalizada.muestras;
  }

  const puntos: PuntoPromedioHora[] = [];
  for (const hora of horas) {
    if (!Number.isInteger(hora) || hora < 0 || hora >= HORAS_POR_DIA) continue;

    const promedio = serie[hora];
    if (promedio === null || !Number.isFinite(promedio)) continue;

    puntos.push({
      etiqueta: etiquetaHora(hora),
      promedio: redondearAUnDecimal(promedio),
      muestras: muestras[hora],
    });
  }

  return puntos;
}

/**
 * Puntos de la curva de HOY para las `horas` pedidas. Conserva los huecos (`cantidad:
 * null`) porque en una serie temporal un tramo sin snapshots no es un 0: dibujar 0 haría
 * parecer que el cowork quedó vacío cuando en realidad no hay lecturas.
 */
export function construirPuntosHoy(
  filas: readonly PuntoSnapshot[],
  timezone: string,
  horas: readonly number[],
  horario: HorarioZona | null = null,
): PuntoHoraHoy[] {
  const serie = construirSerieHoy(filas, timezone, horario);

  const puntos: PuntoHoraHoy[] = [];
  for (const hora of horas) {
    if (!Number.isInteger(hora) || hora < 0 || hora >= HORAS_POR_DIA) continue;

    const cantidad = serie[hora];
    puntos.push({
      etiqueta: etiquetaHora(hora),
      cantidad:
        cantidad === null || !Number.isFinite(cantidad)
          ? null
          : redondearAUnDecimal(cantidad),
    });
  }

  return puntos;
}

