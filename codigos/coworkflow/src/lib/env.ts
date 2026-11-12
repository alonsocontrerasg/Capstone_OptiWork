import { z } from "zod";

/**
 * Variables de entorno PÚBLICAS (prefijo `NEXT_PUBLIC_`).
 *
 * Este módulo puede importarse desde Client Components: `next build` reemplaza cada
 * `process.env.NEXT_PUBLIC_*` por su valor en el bundle, por eso el acceso se escribe
 * **literal** (nunca `process.env[nombre]`), que es la única forma en que Next lo inlinea.
 *
 * Los secretos viven en `src/lib/env.server.ts` (marcado `server-only`). Si un secreto se
 * agrega aquí, termina en el JavaScript del navegador (ver S-07 en
 * `docs/decisiones-seguridad.md`).
 */

const obligatorio = (mensaje: string) => z.string().trim().min(1, mensaje);

/**
 * Bandera OPCIONAL de demostración (`NEXT_PUBLIC_DATOS_DEMO`).
 *
 * No es obligatoria a propósito: la app tiene que arrancar igual sin ella. Se usa `.catch` en
 * vez de `.default` para que un valor inesperado (`"True"`, `"1"`, vacío) no tumbe el arranque:
 * simplemente se interpreta como `false`, que es el estado seguro (no rotular como demo lo que
 * no lo es).
 */
const banderaOpcional = z.enum(["true", "false"]).catch("false");

const esquemaPublico = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z
    .string()
    .trim()
    .url({
      message:
        "NEXT_PUBLIC_SUPABASE_URL debe ser una URL absoluta (https://<ref>.supabase.co)",
    }),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: obligatorio(
    "Falta NEXT_PUBLIC_SUPABASE_ANON_KEY (Project Settings → API → anon key)",
  ),
  NEXT_PUBLIC_SITE_URL: z
    .string()
    .trim()
    .url({
      message:
        "NEXT_PUBLIC_SITE_URL debe ser una URL absoluta, p. ej. https://coworkflow.vercel.app",
    }),
  NEXT_PUBLIC_ZONA_POR_DEFECTO: obligatorio(
    "Falta NEXT_PUBLIC_ZONA_POR_DEFECTO (slug de la zona, p. ej. hub-providencia)",
  ).regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    "NEXT_PUBLIC_ZONA_POR_DEFECTO debe ser un slug en kebab-case",
  ),
  NEXT_PUBLIC_DATOS_DEMO: banderaOpcional,
});

const resultado = esquemaPublico.safeParse({
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
  NEXT_PUBLIC_ZONA_POR_DEFECTO: process.env.NEXT_PUBLIC_ZONA_POR_DEFECTO,
  NEXT_PUBLIC_DATOS_DEMO: process.env.NEXT_PUBLIC_DATOS_DEMO,
});

if (!resultado.success) {
  const detalle = resultado.error.issues
    .map((problema) => `- ${problema.path.join(".")}: ${problema.message}`)
    .join("\n");
  // Falla cerrado y al arrancar: es preferible un error claro a una app a medio configurar.
  throw new Error(
    `Variables de entorno públicas inválidas:\n${detalle}\nRevisa .env.example y tu .env.local.`,
  );
}

export const envPublico = resultado.data;

/**
 * `true` solo cuando `NEXT_PUBLIC_DATOS_DEMO="true"`.
 *
 * Se exporta ya resuelto para que las páginas no repitan la comparación con el string. Cualquier
 * otro valor (o la ausencia de la variable) deja la app como siempre, sin franja de demo.
 */
export const datosDemoActivos = envPublico.NEXT_PUBLIC_DATOS_DEMO === "true";

/** Origen del proyecto Supabase, útil para armar la CSP (`connect-src`). */
export function origenSupabase(url: string = envPublico.NEXT_PUBLIC_SUPABASE_URL): {
  https: string;
  wss: string;
} | null {
  try {
    const { origin, host } = new URL(url);
    return { https: origin, wss: `wss://${host}` };
  } catch {
    return null;
  }
}
