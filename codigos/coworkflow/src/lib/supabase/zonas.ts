import type { HorarioSemanalDia } from "@/lib/dominio/tiempo";
import { crearClienteServidor } from "@/lib/supabase/server";

/**
 * Acceso a `public.zonas` con el cliente de servidor (RLS: lectura pública de columnas
 * no sensibles). Solo se seleccionan columnas de configuración: nada personal.
 */
export type ZonaPublica = {
  id: string;
  slug: string;
  nombre: string;
  aforo_max: number;
  umbral_bajo: number;
  umbral_alto: number;
  hora_apertura: string;
  hora_cierre: string;
  timezone: string;
  activa: boolean;
  /** Horario semanal (migración 10); ausente en `listarZonasActivas`. */
  horarios_zona?: HorarioSemanalDia[];
};

const COLUMNAS =
  "id, slug, nombre, aforo_max, umbral_bajo, umbral_alto, hora_apertura, hora_cierre, timezone, activa";

/**
 * `COLUMNAS` + el horario semanal embebido. Solo lo usa `obtenerZonaPorSlug`: el dashboard
 * necesita el horario del día para `horarioDelDia`/`textoEstadoHorario`. El listado se queda
 * con `COLUMNAS` para no traer filas de horario que no usa.
 */
const COLUMNAS_CON_HORARIO = `${COLUMNAS}, horarios_zona(dia_semana, apertura, cierre)`;

export async function listarZonasActivas(): Promise<ZonaPublica[]> {
  const supabase = await crearClienteServidor();
  const { data, error } = await supabase
    .from("zonas")
    .select(COLUMNAS)
    .eq("activa", true)
    .order("nombre", { ascending: true });

  if (error) {
    console.error("[zonas] no se pudieron listar las zonas activas:", error.message);
    return [];
  }

  return (data as ZonaPublica[] | null) ?? [];
}

export async function obtenerZonaPorSlug(slug: string): Promise<ZonaPublica | null> {
  const supabase = await crearClienteServidor();
  const { data, error } = await supabase
    .from("zonas")
    .select(COLUMNAS_CON_HORARIO)
    .eq("slug", slug)
    .maybeSingle();

  if (error) {
    console.error("[zonas] no se pudo leer la zona:", error.message);
    return null;
  }

  return (data as ZonaPublica | null) ?? null;
}
