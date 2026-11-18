import type { HorarioSemanalDia } from "@/lib/dominio/tiempo";
import { crearClienteServidor } from "@/lib/supabase/server";
import { esquemaUuidZona } from "@/lib/validacion/scan";

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

/**
 * Zona por id: el `zona_uuid` que viaja dentro del token del QR.
 *
 * La validación con zod ocurre **antes** de la consulta (S-46): si `id` no es un UUID,
 * devuelve `null` sin tocar Supabase, así un token con la forma permitida pero con una zona
 * inventada no provoca el error `22P02` de PostgREST. Se piden las mismas columnas que
 * `obtenerZonaPorSlug` (incluido el horario semanal) porque el aviso «Cerrado · abre…»
 * necesita `horarios_zona`; no hay una consulta extra.
 *
 * Solo es presentación: `GET /scan` usa el nombre y el horario para la pantalla de
 * confirmación, y la escritura sigue en `POST /api/scan` → `registrar_scan` (S-05, S-16).
 */
export async function obtenerZonaPorId(id: string): Promise<ZonaPublica | null> {
  const validado = esquemaUuidZona.safeParse(id);
  if (!validado.success) return null;

  const supabase = await crearClienteServidor();
  const { data, error } = await supabase
    .from("zonas")
    .select(COLUMNAS_CON_HORARIO)
    .eq("id", validado.data)
    .maybeSingle();

  if (error) {
    console.error("[zonas] no se pudo leer la zona por id:", error.message);
    return null;
  }

  return (data as ZonaPublica | null) ?? null;
}
