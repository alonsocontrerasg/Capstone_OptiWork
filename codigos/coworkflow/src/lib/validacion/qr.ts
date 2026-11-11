import { z } from "zod";

/**
 * Esquemas zod del borde HTTP (S-15). Se validan ANTES de tocar la base y con listas
 * cerradas: nada de strings libres que después lleguen a una consulta.
 */

/** Slugs de zona: kebab-case, igual que el `check` de `zonas.slug`. */
export const esquemaSlugZona = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "slug inválido");

export const esquemaModoQr = z.enum(["entrada", "salida"]);

export type ModoQr = z.infer<typeof esquemaModoQr>;

/** `GET /api/qr/token?zona=<slug>&modo=<entrada|salida>` */
export const esquemaParametrosQr = z.object({
  zona: esquemaSlugZona,
  modo: esquemaModoQr,
});

export type ParametrosQr = z.infer<typeof esquemaParametrosQr>;
