import type { NextConfig } from "next";

/**
 * Nota de la Etapa 3 (ver `docs/decisiones-seguridad.md`, S-10):
 * `cacheComponents: true` (PPR) es incompatible con la CSP con nonce que necesitamos para
 * bloquear scripts inline, así que se desactiva y la app se renderiza de forma dinámica.
 * Como todas las páginas leen la sesión o datos vivos, el costo real es marginal.
 */
const nextConfig: NextConfig = {
  // Habilita forbidden()/unauthorized() (respuestas 403/401 desde el servidor).
  experimental: {
    authInterrupts: true,
  },
  // No anunciar el framework en cada respuesta.
  poweredByHeader: false,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;

