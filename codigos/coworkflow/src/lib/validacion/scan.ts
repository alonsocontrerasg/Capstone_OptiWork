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

export const esquemaModoScan = z.enum(["entrada", "salida"]);

/**
 * Query de `GET /scan`. `modo` es solo presentación (el POST manda únicamente el token), así
 * que si viene manipulado se descarta en vez de bloquear el escaneo; `t` sí es obligatorio.
 */
export const esquemaQueryScan = z.object({
  t: esquemaTokenScan,
  modo: esquemaModoScan.optional().catch(undefined),
});

/** Cuerpo de `POST /api/scan`: `{ t }`. Los campos extra se descartan. */
export const esquemaCuerpoScan = z.object({ t: esquemaTokenScan });

export type QueryScan = z.infer<typeof esquemaQueryScan>;
export type CuerpoScan = z.infer<typeof esquemaCuerpoScan>;
