import { z } from "zod";

/**
 * Token del QR rotativo tal como viaja en la URL (`/scan?t=...`) o en el cuerpo del POST.
 *
 * Solo se acota el tipo y el largo (S-15): la verificación de la firma, la zona y la ventana
 * ocurre en Postgres (S-16). 256 caracteres es holgado: el token real mide ~124.
 */
export const esquemaTokenScan = z
  .string()
  .trim()
  .min(1, "Falta el código QR.")
  .max(256, "El código QR es demasiado largo.")
  .regex(/^[A-Za-z0-9._-]+$/, "El código QR tiene un formato inválido.");

/**
 * `zona_uuid` que viaja dentro del token (`v1.<zona_uuid>.<modo>.<ventana>.<firma>`).
 *
 * `GET /scan` lo usa solo para mostrar el nombre de la zona y su horario, y lo valida con zod
 * **antes** de consultar `zonas` (S-46): un token con la forma permitida pero con una «zona»
 * que no es un UUID no llega a PostgREST (evita el error `22P02`). No autoriza nada: la firma,
 * la ventana y la zona real se verifican en Postgres al confirmar (S-16).
 */
export const esquemaUuidZona = z.uuid();

export const esquemaModoScan = z.enum(["entrada", "salida"]);

/**
 * Query de `GET /scan`. `modo` es solo presentación (el POST manda únicamente el token), así
 * que si viene manipulado se descarta en vez de bloquear el escaneo; `t` sí es obligatorio.
 */
export const esquemaQueryScan = z.object({
  t: esquemaTokenScan,
  modo: esquemaModoScan.optional().catch(undefined),
});

/**
 * Indicador de transición `desde=scan&modo=entrada|salida` (sin token).
 *
 * Solo alimenta los mensajes de "vuelve a escanear"; no autoriza nada. `desde` y `modo` son
 * enums cerrados y, si falta uno o llega otro valor, el indicador completo se ignora.
 */
export const esquemaIndicadorScan = z.object({
  desde: z.enum(["scan"]).optional(),
  modo: esquemaModoScan.optional(),
});

/** Modo del indicador si `desde=scan` y `modo` es válido; en cualquier otro caso, `null`. */
export function modoDesdeIndicadorScan(
  desde: string | string[] | undefined,
  modo: string | string[] | undefined,
): "entrada" | "salida" | null {
  const parseado = esquemaIndicadorScan.safeParse({
    desde: typeof desde === "string" ? desde : undefined,
    modo: typeof modo === "string" ? modo : undefined,
  });
  if (!parseado.success) return null;
  if (parseado.data.desde !== "scan" || parseado.data.modo === undefined) {
    return null;
  }
  return parseado.data.modo;
}

/** Cuerpo de `POST /api/scan`: `{ t }`. Los campos extra se descartan. */
export const esquemaCuerpoScan = z.object({ t: esquemaTokenScan });

export type QueryScan = z.infer<typeof esquemaQueryScan>;
export type CuerpoScan = z.infer<typeof esquemaCuerpoScan>;
