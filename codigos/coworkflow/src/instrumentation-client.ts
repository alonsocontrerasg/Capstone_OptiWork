import { z } from "zod";

/**
 * Instrumentación de CLIENTE (Next la ejecuta en el navegador antes de que la app sea
 * interactiva).
 *
 * `z.config({ jitless: true })` apaga el compilador JIT de Zod, que construye validadores con
 * `new Function`. La CSP de producción (`src/proxy.ts`) no incluye `'unsafe-eval'`, así que esa
 * sonda se rechaza: Zod la captura, pero el navegador igual reporta un
 * `securitypolicyviolation` en la consola. Con `jitless` no se intenta `new Function` desde el
 * principio; el resultado de la validación es idéntico y solo cambia el rendimiento.
 *
 * Hace falta porque `src/lib/env.ts` valida los `NEXT_PUBLIC_*` con Zod y ese módulo sí entra
 * al bundle de cliente (vía `src/lib/supabase/browser.ts`, que usa la isla del contador).
 *
 * Este archivo corre SOLO en el navegador: no debe importar `server-only` ni leer secretos.
 */
z.config({ jitless: true });
