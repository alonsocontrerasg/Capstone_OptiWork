import { z } from "zod";

const apertura = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/);
const cierre = z.string().regex(/^(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)$/);
export const esquemaHorarioAdmin = z.object({
  dia_semana: z.number().int().min(1).max(7), apertura, cierre,
}).refine((h) => h.apertura < h.cierre, "La apertura debe ser anterior al cierre");

export const esquemaConfiguracionAdmin = z.object({
  zona_id: z.uuid(), nombre: z.string().trim().min(1).max(100),
  aforo_max: z.number().int().min(1).max(100000),
  umbral_bajo: z.number().int().min(0).max(99),
  umbral_alto: z.number().int().min(1).max(100),
  activa: z.boolean(), horarios: z.array(esquemaHorarioAdmin).max(7),
}).refine((c) => c.umbral_bajo < c.umbral_alto, "Los umbrales deben estar ordenados")
  .refine((c) => !c.activa || c.horarios.length > 0, "Una zona activa necesita al menos un día abierto")
  .refine((c) => new Set(c.horarios.map((h) => h.dia_semana)).size === c.horarios.length,
    "No se puede repetir un día");

export const esquemaFiltrosHistorial = z.object({
  zona: z.preprocess((v) => v === "" ? undefined : v, z.uuid().optional()),
  dias: z.enum(["7", "30", "90"]).default("7"),
  pagina: z.coerce.number().int().min(1).max(10000).default(1),
  hasta: z.iso.datetime().optional(),
});
export type ConfiguracionAdmin = z.infer<typeof esquemaConfiguracionAdmin>;
export type FiltrosHistorial = z.infer<typeof esquemaFiltrosHistorial>;
