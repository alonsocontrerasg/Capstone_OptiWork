import "server-only";

import { z } from "zod";

/**
 * Variables de entorno SECRETAS (solo servidor).
 *
 * `import "server-only"` hace que el build falle si algún Client Component importa este
 * módulo por accidente: la `service_role` key y el secreto HMAC jamás pueden llegar al
 * bundle del navegador (S-07). Ver `docs/decisiones-seguridad.md`.
 */

const esquemaServidor = z.object({
  /**
   * ¡SECRETO! Ignora RLS por completo. Solo para tareas administrativas server-side
   * (scripts locales, Etapa 6). Nunca desde un Client Component.
   *
   * Es opcional a propósito: la app que atiende usuarios (login, QR, scan) no la necesita y
   * así un despliegue sin ella no se cae. `crearClienteAdmin()` falla ruidosamente si se usa
   * y falta.
   */
  SUPABASE_SERVICE_ROLE_KEY: z.string().trim().optional(),

  /**
   * Clave HMAC-SHA256 del QR rotativo, en hexadecimal.
   * Debe ser **exactamente** 64 caracteres hex (256 bits) y coincidir con la fila
   * `qr_token_secret` de `public.app_secrets` (la RPC verifica la firma en Postgres).
   * Generar con: `openssl rand -hex 32`.
   */
  QR_TOKEN_SECRET: z
    .string()
    .trim()
    .regex(
      /^[0-9a-fA-F]{64}$/,
      "QR_TOKEN_SECRET debe ser exactamente 64 caracteres hexadecimales (openssl rand -hex 32)",
    ),

  /**
   * Duración de la ventana del QR en segundos. Debe ser igual a `qr_window_seconds`
   * en `app_secrets`; si difieren, todos los escaneos se rechazan como `token_expirado`.
   */
  QR_WINDOW_SECONDS: z.coerce
    .number()
    .int("QR_WINDOW_SECONDS debe ser un entero")
    .min(10, "QR_WINDOW_SECONDS debe ser al menos 10")
    .max(300, "QR_WINDOW_SECONDS no debería superar 300")
    .default(45),

  /** Opcionales en desarrollo; obligatorias en producción (ver `credencialesUpstash`). */
  UPSTASH_REDIS_REST_URL: z.string().trim().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().trim().optional(),
});

const resultado = esquemaServidor.safeParse({
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  QR_TOKEN_SECRET: process.env.QR_TOKEN_SECRET,
  QR_WINDOW_SECONDS: process.env.QR_WINDOW_SECONDS,
  UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
});

if (!resultado.success) {
  const detalle = resultado.error.issues
    .map((problema) => `- ${problema.path.join(".")}: ${problema.message}`)
    .join("\n");
  throw new Error(
    `Variables de entorno de servidor inválidas:\n${detalle}\nRevisa .env.example y tu .env.local.`,
  );
}

export const envServidor = resultado.data;

/**
 * Credenciales de Upstash Redis (rate limiting).
 *
 * En desarrollo se permite no tenerlas (el rate limiter usa un almacén en memoria y avisa
 * por consola). En producción son **obligatorias**: cada invocación serverless es un
 * proceso distinto, así que un contador en memoria no limita nada (S-08).
 *
 * Se valida al usarse y no al importar el módulo, porque `next build` corre con
 * `NODE_ENV=production` y no debería exigir el servicio para compilar.
 */
export function credencialesUpstash(): { url: string; token: string } | null {
  const url = envServidor.UPSTASH_REDIS_REST_URL;
  const token = envServidor.UPSTASH_REDIS_REST_TOKEN;

  if (url && token) {
    return { url, token };
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "UPSTASH_REDIS_REST_URL y UPSTASH_REDIS_REST_TOKEN son obligatorias en producción: en serverless no hay memoria compartida entre invocaciones.",
    );
  }

  return null;
}
