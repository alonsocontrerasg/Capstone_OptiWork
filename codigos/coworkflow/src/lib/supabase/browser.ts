import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { envPublico } from "@/lib/env";

/**
 * Cliente de Supabase SOLO para Realtime en el navegador.
 *
 * - Sin persistencia de sesión: el dashboard es público y no hay usuario autenticado. Se
 *   desactivan `persistSession`, `autoRefreshToken` y `detectSessionInUrl` para no tocar
 *   cookies/localStorage ni procesar la URL.
 * - PROHIBIDO usar este cliente para REST (`.from()`, `.rpc()`): la anon key es pública y
 *   el navegador podría consultar tablas directamente. Las lecturas del dashboard pasan
 *   por Server Components (`src/lib/supabase/dashboard.ts`) y las escrituras por RPC o
 *   Route Handlers. Aquí solo se abre un canal a `ocupacion_actual`, que no tiene PII.
 * - Se reutiliza una única instancia por pestaña para no abrir un WebSocket por componente.
 */

let cliente: SupabaseClient | null = null;

export function obtenerClienteNavegador(): SupabaseClient {
  if (cliente) return cliente;

  cliente = createClient(
    envPublico.NEXT_PUBLIC_SUPABASE_URL,
    envPublico.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      db: { schema: "public" },
    },
  );

  return cliente;
}

export type CambioOcupacion = {
  cantidad: number;
  updatedAt: string | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizarCambio(valor: unknown): CambioOcupacion | null {
  if (typeof valor !== "object" || valor === null) return null;

  const fila = valor as Record<string, unknown>;
  const cantidad =
    typeof fila.cantidad === "string" ? Number(fila.cantidad) : fila.cantidad;

  if (
    typeof cantidad !== "number" ||
    !Number.isFinite(cantidad) ||
    !Number.isInteger(cantidad) ||
    cantidad < 0
  ) {
    return null;
  }

  return {
    cantidad,
    updatedAt:
      typeof fila.updated_at === "string" ? fila.updated_at : null,
  };
}

/**
 * Abre UN canal de Realtime sobre `ocupacion_actual` para una zona y avisa en cada INSERT o
 * UPDATE (el primero ocurre al crear la zona; después el trigger solo hace UPDATE). El
 * `filter` por `zona_id` evita recibir cambios de otras zonas.
 *
 * Devuelve la función de limpieza: el componente debe llamarla al desmontar
 * (`removeChannel`), o cada navegación dejaría un WebSocket abierto.
 *
 * El `zona_id` se valida como UUID antes de interpolarlo en el filtro: así un valor de la
 * URL no puede inyectar condiciones en la suscripción. Un id inválido no abre canal y la UI
 * conserva el dato inicial del RSC.
 */
export function suscribirseOcupacionActual(
  zonaId: string,
  alCambiar: (cambio: CambioOcupacion) => void,
): () => void {
  if (!UUID.test(zonaId)) {
    console.warn("[realtime] zona_id inválido; no se suscribe a ocupacion_actual");
    return () => {};
  }

  const supabase = obtenerClienteNavegador();
  let canal = supabase.channel(`ocupacion_actual:${zonaId}`);

  for (const evento of ["INSERT", "UPDATE"] as const) {
    canal = canal.on(
      "postgres_changes",
      {
        event: evento,
        schema: "public",
        table: "ocupacion_actual",
        filter: `zona_id=eq.${zonaId}`,
      },
      (payload) => {
        const cambio = normalizarCambio(payload.new);
        if (cambio) alCambiar(cambio);
      },
    );
  }

  canal.subscribe();

  return () => {
    void supabase.removeChannel(canal);
  };
}
