import "server-only";
import { createHmac } from "node:crypto";
import { envServidor } from "@/lib/env.server";
import { crearClienteServidor } from "@/lib/supabase/server";
import type { ZonaPublica } from "@/lib/supabase/zonas";
import type { FiltrosHistorial } from "@/lib/validacion/admin";

export const TAMANO_PAGINA = 50;
export const MAX_EXPORTACION = 10000;
export class ExportacionDemasiadoGrande extends Error {}

type EventoFila = {
  ts: string; tipo: string | null; resultado: string; user_id: string | null;
  zonas: { nombre: string } | null;
};
export type EventoAdmin = {
  ts: string; tipo: string | null; resultado: string; usuario: string; zona: string;
};

/** Identificador estable de 96 bits, separado por propósito; nunca exportar el UUID original. */
export function seudonimoUsuario(id: string | null): string {
  return id ? createHmac("sha256", envServidor.QR_TOKEN_SECRET)
    .update(`historial:v1:${id}`).digest("hex").slice(0, 24) : "sin-usuario";
}

export async function listarZonasAdmin(): Promise<ZonaPublica[]> {
  const cliente = await crearClienteServidor();
  const { data, error } = await cliente.from("zonas")
    .select("id, slug, nombre, aforo_max, umbral_bajo, umbral_alto, hora_apertura, hora_cierre, timezone, activa, horarios_zona(dia_semana, apertura, cierre)")
    .order("nombre");
  if (error) throw new Error("No se pudo cargar la configuración");
  return (data ?? []) as ZonaPublica[];
}

function normalizar(filas: EventoFila[]): EventoAdmin[] {
  return filas.map((f) => ({ ts: f.ts, tipo: f.tipo, resultado: f.resultado,
    usuario: seudonimoUsuario(f.user_id), zona: f.zonas?.nombre ?? "Sin zona" }));
}

async function leerLote(filtros: FiltrosHistorial, inicio: number, cantidad: number) {
  const cliente = await crearClienteServidor();
  const hasta = new Date(filtros.hasta ?? Date.now());
  const desde = new Date(hasta.getTime() - Number(filtros.dias) * 86400000);
  let consulta = cliente.from("eventos_scan")
    .select("ts, tipo, resultado, user_id, zonas(nombre)")
    .gte("ts", desde.toISOString()).lte("ts", hasta.toISOString())
    .order("ts", { ascending: false }).order("id", { ascending: false });
  if (filtros.zona) consulta = consulta.eq("zona_id", filtros.zona);
  const { data, error } = await consulta.range(inicio, inicio + cantidad - 1);
  if (error) throw new Error("No se pudo cargar el historial");
  return (data ?? []) as unknown as EventoFila[];
}

export async function leerHistorial(filtros: FiltrosHistorial) {
  const filas = await leerLote(filtros, (filtros.pagina - 1) * TAMANO_PAGINA, TAMANO_PAGINA + 1);
  return { eventos: normalizar(filas.slice(0, TAMANO_PAGINA)), siguiente: filas.length > TAMANO_PAGINA };
}

/** Lotes por debajo del límite de PostgREST. Nunca truncar silenciosamente un CSV. */
export async function leerExportacion(filtros: FiltrosHistorial): Promise<EventoAdmin[]> {
  const anclados = { ...filtros, hasta: filtros.hasta ?? new Date().toISOString() };
  const filas: EventoFila[] = [];
  for (let inicio = 0; inicio <= MAX_EXPORTACION; inicio += 500) {
    const lote = await leerLote(anclados, inicio, 500);
    filas.push(...lote);
    if (filas.length > MAX_EXPORTACION) throw new ExportacionDemasiadoGrande();
    if (lote.length < 500) break;
  }
  return normalizar(filas);
}
