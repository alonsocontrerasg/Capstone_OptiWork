import "server-only";

import type { FilaFranja, PuntoSnapshot } from "@/lib/dominio/estadisticas";
import { crearClienteServidor } from "@/lib/supabase/server";
import { esRangoDias, type RangoDias } from "@/lib/validacion/dashboard";

/**
 * Lecturas del dashboard público con el cliente de servidor (rol `anon`, RLS activa).
 *
 * Convención de errores:
 * - `null` = la consulta FALLÓ (se registra en el log; la UI muestra «error»).
 * - `[]` = la consulta funcionó pero no hay filas (la UI muestra «sin datos»).
 *
 * Nunca se traen snapshots crudos de 30 días: PostgREST corta en 1000 filas y hay ~8.640.
 * `ocupacion_por_franja` agrega en Postgres y devuelve como máximo 168 filas. Los snapshots de
 * `ocupacion_hoy` (≤288) tampoco viajan al cliente: la página los reduce a una serie de 24
 * puntos con `construirSerieHoy` antes de pasarlos a un Client Component.
 */

export type OcupacionActual = {
  cantidad: number;
  updatedAt: string | null;
};

function aEnteroNoNegativo(valor: unknown): number | null {
  const numero = typeof valor === "string" ? Number(valor) : valor;
  if (
    typeof numero !== "number" ||
    !Number.isFinite(numero) ||
    !Number.isInteger(numero) ||
    numero < 0
  ) {
    return null;
  }

  return numero;
}

function normalizarFranja(valor: unknown): FilaFranja | null {
  if (typeof valor !== "object" || valor === null) return null;

  const fila = valor as Record<string, unknown>;
  const dow = aEnteroNoNegativo(fila.dow);
  const hora = aEnteroNoNegativo(fila.hora);
  const muestras = aEnteroNoNegativo(fila.muestras);

  if (dow === null || dow < 1 || dow > 7) return null;
  if (hora === null || hora > 23) return null;
  if (muestras === null || muestras < 1) return null;

  const promedio =
    typeof fila.promedio === "number" && Number.isFinite(fila.promedio)
      ? fila.promedio
      : null;

  return { dow, hora, promedio, muestras };
}

function normalizarSnapshot(valor: unknown): PuntoSnapshot | null {
  if (typeof valor !== "object" || valor === null) return null;

  const fila = valor as Record<string, unknown>;
  const cantidad = aEnteroNoNegativo(fila.cantidad);
  const ts =
    typeof fila.ts === "string" && !Number.isNaN(Date.parse(fila.ts))
      ? fila.ts
      : null;

  if (cantidad === null || ts === null) return null;
  return { ts, cantidad };
}

export async function obtenerOcupacionActual(
  zonaId: string,
): Promise<OcupacionActual | null> {
  const supabase = await crearClienteServidor();
  const { data, error } = await supabase
    .from("ocupacion_actual")
    .select("cantidad, updated_at")
    .eq("zona_id", zonaId)
    .maybeSingle();

  if (error) {
    console.error(
      "[dashboard] no se pudo leer ocupacion_actual:",
      error.message,
    );
    return null;
  }

  if (!data) {
    // La zona existe pero no tiene fila (no debería: el trigger la crea); se muestra 0.
    return { cantidad: 0, updatedAt: null };
  }

  const fila = data as { cantidad?: unknown; updated_at?: unknown };
  const cantidad = aEnteroNoNegativo(fila.cantidad);
  if (cantidad === null) {
    console.error(
      "[dashboard] ocupacion_actual.cantidad inválida:",
      fila.cantidad,
    );
    return null;
  }

  return {
    cantidad,
    updatedAt:
      typeof fila.updated_at === "string" ? fila.updated_at : null,
  };
}

export async function obtenerFranjas(
  zonaId: string,
  dias: RangoDias,
): Promise<FilaFranja[] | null> {
  if (!esRangoDias(dias)) return null;

  const supabase = await crearClienteServidor();
  const { data, error } = await supabase.rpc("ocupacion_por_franja", {
    p_zona_id: zonaId,
    p_dias: dias,
  });

  if (error) {
    console.error(
      "[dashboard] ocupacion_por_franja falló:",
      error.message,
    );
    return null;
  }

  if (!Array.isArray(data)) return [];

  const filas: FilaFranja[] = [];
  for (const valor of data as unknown[]) {
    const fila = normalizarFranja(valor);
    if (fila) filas.push(fila);
  }

  return filas;
}

/**
 * Snapshots del día local actual (máx. 288). Es una lectura de SERVIDOR: quien la use debe
 * agregarla a 24 puntos (`construirSerieHoy`) antes de entregarla a un Client Component.
 */
export async function obtenerOcupacionHoy(
  zonaId: string,
): Promise<PuntoSnapshot[] | null> {
  const supabase = await crearClienteServidor();
  const { data, error } = await supabase.rpc("ocupacion_hoy", {
    p_zona_id: zonaId,
  });

  if (error) {
    console.error("[dashboard] ocupacion_hoy falló:", error.message);
    return null;
  }

  if (!Array.isArray(data)) return [];

  const filas: PuntoSnapshot[] = [];
  for (const valor of data as unknown[]) {
    const fila = normalizarSnapshot(valor);
    if (fila) filas.push(fila);
  }

  return filas;
}

/**
 * Permanencia promedio (segundos) o `null` (sin datos publicables). `desde`/`hasta` deben venir
 * de `limitesRangoDias` (mediodías locales); la RPC los alinea a medianoche de la zona.
 */
export async function obtenerPermanenciaPromedio(
  zonaId: string,
  desde: Date,
  hasta: Date,
): Promise<number | null> {
  if (Number.isNaN(desde.getTime()) || Number.isNaN(hasta.getTime())) {
    return null;
  }

  const supabase = await crearClienteServidor();
  const { data, error } = await supabase.rpc("permanencia_promedio", {
    p_zona_id: zonaId,
    p_desde: desde.toISOString(),
    p_hasta: hasta.toISOString(),
  });

  if (error) {
    console.error(
      "[dashboard] permanencia_promedio falló:",
      error.message,
    );
    return null;
  }

  return typeof data === "number" &&
    Number.isFinite(data) &&
    data >= 0
    ? data
    : null;
}

/**
 * Personas distintas o `null` (k-anonimato o sin datos). Mismo contrato de fechas que
 * `obtenerPermanenciaPromedio`.
 */
export async function obtenerPersonasDistintas(
  zonaId: string,
  desde: Date,
  hasta: Date,
): Promise<number | null> {
  if (Number.isNaN(desde.getTime()) || Number.isNaN(hasta.getTime())) {
    return null;
  }

  const supabase = await crearClienteServidor();
  const { data, error } = await supabase.rpc("personas_distintas", {
    p_zona_id: zonaId,
    p_desde: desde.toISOString(),
    p_hasta: hasta.toISOString(),
  });

  if (error) {
    console.error(
      "[dashboard] personas_distintas falló:",
      error.message,
    );
    return null;
  }

  // bigint puede llegar como number o string; null = k-anonimato (< 5 personas).
  return aEnteroNoNegativo(data);
}
