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
};

const COLUMNAS =
  "id, slug, nombre, aforo_max, umbral_bajo, umbral_alto, hora_apertura, hora_cierre, timezone, activa";

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
    .select(COLUMNAS)
    .eq("slug", slug)
    .maybeSingle();

  if (error) {
    console.error("[zonas] no se pudo leer la zona:", error.message);
    return null;
  }

  return (data as ZonaPublica | null) ?? null;
}
