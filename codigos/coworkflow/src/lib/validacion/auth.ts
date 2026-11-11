import { z } from "zod";

import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@/lib/dominio/auth";

const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(254, "El correo es demasiado largo.")
  .pipe(z.email({ message: "Ingresa un correo válido." }));

const password = z
  .string()
  .min(
    PASSWORD_MIN_LENGTH,
    `La contraseña debe tener al menos ${PASSWORD_MIN_LENGTH} caracteres.`,
  )
  .max(PASSWORD_MAX_LENGTH, "La contraseña es demasiado larga.");

const destino = z.string().max(512).optional();

/**
 * Cuerpo de `POST /auth/login`: `{ accion, email, password?, destino? }`.
 *
 * La acción distingue los tres flujos, de modo que un mismo endpoint valide todo con zod
 * antes de llamar a Supabase (S-28: la validación ocurre en el borde).
 */
export const esquemaAccionAuth = z.discriminatedUnion("accion", [
  z.object({ accion: z.literal("enlace"), email, destino }),
  z.object({ accion: z.literal("contrasena"), email, password, destino }),
  z.object({ accion: z.literal("registro"), email, password, destino }),
]);

export type AccionAuth = z.infer<typeof esquemaAccionAuth>;
