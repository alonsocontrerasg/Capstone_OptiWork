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

/** Contador para que cada suscripción use un topic de canal distinto (ver más abajo). */
let suscripciones = 0;

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

/** Estados que puede reportar el canal de Realtime (enum `REALTIME_SUBSCRIBE_STATES`). */
export type EstadoSuscripcion =
  | "SUBSCRIBED"
  | "CHANNEL_ERROR"
  | "TIMED_OUT"
  | "CLOSED";

const ESTADOS_SUSCRIPCION: readonly EstadoSuscripcion[] = [
  "SUBSCRIBED",
  "CHANNEL_ERROR",
  "TIMED_OUT",
  "CLOSED",
];

function esEstadoSuscripcion(valor: string): valor is EstadoSuscripcion {
  return (ESTADOS_SUSCRIPCION as readonly string[]).includes(valor);
}

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
 * `alCambiarEstado` es opcional y solo informa el ciclo de vida del canal (para pintar
 * «En vivo» / «Reconectando…»). No cambia el comportamiento anterior: sin ese callback el
 * canal se abre igual.
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
  alCambiarEstado?: (estado: EstadoSuscripcion) => void,
): () => void {
  if (!UUID.test(zonaId)) {
    console.warn("[realtime] zona_id inválido; no se suscribe a ocupacion_actual");
    return () => {};
  }

  const supabase = obtenerClienteNavegador();

  // Nombre de canal único por suscripción. `supabase.channel()` devuelve el canal EXISTENTE
  // si el topic ya está en uso: con el doble montaje de React Strict Mode eso reengancharía
  // el canal anterior (que todavía se está cerrando) y el componente nuevo nunca recibiría
  // eventos. El sufijo solo evita esa colisión interna; lo que limita los datos sigue siendo
  // el `filter` por `zona_id`. Todas las suscripciones comparten un único WebSocket.
  suscripciones += 1;
  let canal = supabase.channel(`ocupacion_actual:${zonaId}:${suscripciones}`);

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

  canal.subscribe((estado) => {
    if (!alCambiarEstado || !esEstadoSuscripcion(estado)) return;
    alCambiarEstado(estado);
  });

  return () => {
    void supabase.removeChannel(canal);
  };
}
