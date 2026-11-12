import { z } from "zod";

import { esquemaSlugZona } from "@/lib/validacion/qr";

/**
 * Query de `/dashboard`: `?zona=<slug>&rango=7|30`.
 *
 * El rango es una LISTA CERRADA de días (7 o 30) y por defecto 7. No se aceptan fechas
 * arbitrarias: el servidor nunca recibe `p_desde`/`p_hasta` del cliente, solo este entero,
 * y la RPC `ocupacion_por_franja` vuelve a validar la lista. Un valor inválido se descarta
 * y cae en el valor por defecto en vez de romper el dashboard público.
 *
 * `zona` inválida (formato) también se descarta: la página usa la zona por defecto. Un slug
 * VÁLIDO pero inexistente o inactivo se resuelve más adelante y se muestra como estado
 * «zona no disponible».
 */

export const RANGOS_DIAS = [7, 30] as const;

export type RangoDias = (typeof RANGOS_DIAS)[number];

export function esRangoDias(valor: unknown): valor is RangoDias {
  return valor === 7 || valor === 30;
}

const esquemaRangoTexto = z.enum(["7", "30"]).catch("7");

export const esquemaQueryDashboard = z.object({
  zona: esquemaSlugZona.optional().catch(undefined),
  rango: esquemaRangoTexto,
});

export type QueryDashboard = z.infer<typeof esquemaQueryDashboard>;

export type ParametrosDashboard = {
  /** Slug validado o `null` si no vino / venía mal formado. */
  zona: string | null;
  rango: RangoDias;
};

export function interpretarQueryDashboard(
  valor: Record<string, string | string[] | undefined>,
): ParametrosDashboard {
  const resultado = esquemaQueryDashboard.safeParse(valor);
  if (!resultado.success) {
    return { zona: null, rango: 7 };
  }

  const rango = Number(resultado.data.rango);
  return {
    zona: resultado.data.zona ?? null,
    rango: esRangoDias(rango) ? rango : 7,
  };
}
