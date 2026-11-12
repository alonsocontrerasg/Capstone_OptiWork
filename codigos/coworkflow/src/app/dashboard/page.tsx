import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense, cache } from "react";

import { EstadisticasDashboard } from "@/components/EstadisticasDashboard";
import { SemaforoOcupacion } from "@/components/SemaforoOcupacion";
import {
  formatearPorcentaje,
  resumirOcupacion,
  type EstadoOcupacion,
} from "@/lib/dominio/ocupacion";
import { etiquetaHora } from "@/lib/dominio/estadisticas";
import { horaDeTexto } from "@/lib/dominio/tiempo";
import { envPublico } from "@/lib/env";
import { obtenerOcupacionActual } from "@/lib/supabase/dashboard";
import { obtenerZonaPorSlug } from "@/lib/supabase/zonas";
import {
  RANGOS_DIAS,
  interpretarQueryDashboard,
} from "@/lib/validacion/dashboard";

export const dynamic = "force-dynamic";

type Props = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

// `cache` memoiza la resolución por request: generateMetadata y la página comparten la
// misma consulta a `zonas`. Además, resolver la zona antes del render permite devolver un
// 404 real aunque `loading.tsx` haya abierto el streaming.
const resolverZona = cache(async (slug: string) => obtenerZonaPorSlug(slug));

export async function generateMetadata({
  searchParams,
}: Props): Promise<Metadata> {
  const params = await searchParams;
  const { zona: slugSolicitado } = interpretarQueryDashboard(params);
  const slug = slugSolicitado ?? envPublico.NEXT_PUBLIC_ZONA_POR_DEFECTO;
  const zona = await resolverZona(slug);
  if (!zona || !zona.activa) notFound();

  return { title: `Dashboard · ${zona.nombre}` };
}

const SEGMENTOS_AFORO = 20;

const COLOR_SEGMENTO: Record<EstadoOcupacion, string> = {
  bajo: "bg-emerald-500",
  moderado: "bg-amber-500",
  lleno: "bg-red-500",
  desconocido: "bg-zinc-400",
};

function formatearActualizacion(
  iso: string | null,
  timezone: string,
): string | null {
  if (!iso) return null;

  const fecha = new Date(iso);
  if (Number.isNaN(fecha.getTime())) return null;

  try {
    return new Intl.DateTimeFormat("es-CL", {
      dateStyle: "short",
      timeStyle: "short",
      timeZone: timezone,
    }).format(fecha);
  } catch {
    return null;
  }
}

function BarraAforo({
  porcentaje,
  estado,
}: {
  porcentaje: number | null;
  estado: EstadoOcupacion;
}) {
  const valor =
    porcentaje === null
      ? 0
      : Math.min(100, Math.max(0, Math.round(porcentaje)));
  const llenos =
    porcentaje === null
      ? 0
      : Math.ceil((valor / 100) * SEGMENTOS_AFORO);

  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={valor}
      aria-valuetext={
        porcentaje === null ? "Sin datos" : `${valor}% del aforo`
      }
      className="mt-2 flex gap-1"
    >
      {Array.from({ length: SEGMENTOS_AFORO }, (_, indice) => (
        <span
          key={indice}
          aria-hidden="true"
          className={`h-2.5 flex-1 rounded-full ${
            indice < llenos
              ? COLOR_SEGMENTO[estado]
              : "bg-zinc-200 dark:bg-zinc-800"
          }`}
        />
      ))}
    </div>
  );
}

function EstadisticasCargando() {
  return (
    <section
      className="mt-8"
      aria-busy="true"
      aria-label="Cargando estadísticas"
    >
      <div className="h-6 w-48 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2].map((indice) => (
          <div
            key={indice}
            className="h-32 animate-pulse rounded-2xl border border-zinc-200 bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900"
          />
        ))}
      </div>
    </section>
  );
}

/**
 * `/dashboard` — dashboard público (RSC).
 *
 * No exige sesión: lee la zona con la clave `anon` y RLS. Solo se renderizan agregados;
 * `user_id` y las filas de `sesiones` nunca cruzan al navegador. El rango es una lista
 * cerrada (7|30) y un valor inválido cae al default sin romper la página.
 *
 * El contador inicial se pinta en el servidor. La isla de Realtime y los gráficos llegan
 * en tandas posteriores; aquí no hay estado de cliente ni suscripciones.
 */
export default async function PaginaDashboard({ searchParams }: Props) {
  const params = await searchParams;
  const { zona: slugSolicitado, rango } = interpretarQueryDashboard(params);
  const slug = slugSolicitado ?? envPublico.NEXT_PUBLIC_ZONA_POR_DEFECTO;

  const zona = await resolverZona(slug);
  if (!zona || !zona.activa) notFound();

  const actual = await obtenerOcupacionActual(zona.id);
  const configuracion = {
    aforo_max: zona.aforo_max,
    umbral_bajo: zona.umbral_bajo,
    umbral_alto: zona.umbral_alto,
  };
  const resumen = actual
    ? resumirOcupacion(actual.cantidad, configuracion)
    : null;
  const estado = resumen?.estado ?? "desconocido";
  const actualizado = formatearActualizacion(
    actual?.updatedAt ?? null,
    zona.timezone,
  );

  const apertura = horaDeTexto(zona.hora_apertura);
  const cierre = horaDeTexto(zona.hora_cierre);
  const horario =
    apertura !== null && cierre !== null
      ? `${etiquetaHora(apertura)}–${etiquetaHora(cierre)}`
      : null;

  return (
    <div className="flex flex-1 flex-col">
      <header className="border-b border-zinc-200 dark:border-zinc-800">
        <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-4 px-6 py-4">
          <div>
            <Link href="/" className="text-sm font-semibold">
              ← CoworkFlow
            </Link>
            <h1 className="mt-1 text-lg font-semibold">{zona.nombre}</h1>
            {horario ? (
              <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                Horario {horario}
              </p>
            ) : null}
          </div>

          <nav
            aria-label="Rango de estadísticas"
            className="flex items-center gap-1 rounded-full border border-zinc-200 p-1 dark:border-zinc-800"
          >
            {RANGOS_DIAS.map((dias) => {
              const activo = rango === dias;
              return (
                <Link
                  key={dias}
                  href={`/dashboard?zona=${encodeURIComponent(
                    zona.slug,
                  )}&rango=${dias}`}
                  aria-current={activo ? "page" : undefined}
                  className={`rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
                    activo
                      ? "bg-zinc-900 text-white dark:bg-white dark:text-zinc-900"
                      : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-900"
                  }`}
                >
                  {dias} días
                </Link>
              );
            })}
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
              Ocupación ahora
            </p>
            <h2 className="mt-1 text-3xl font-semibold tracking-tight">
              Dashboard público
            </h2>
          </div>
          <p className="max-w-sm text-xs leading-5 text-zinc-500 dark:text-zinc-400">
            Solo cifras agregadas. No mostramos nombres, correos ni horarios
            individuales.
          </p>
        </div>


        <section
          aria-labelledby="ocupacion-titulo"
          className="mt-6 rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm sm:p-8 dark:border-zinc-800 dark:bg-zinc-950"
        >
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2
                id="ocupacion-titulo"
                className="text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400"
              >
                Personas dentro
              </h2>
              <div className="mt-2 flex flex-wrap items-baseline gap-2">
                <p className="text-7xl font-semibold leading-none tracking-tight tabular-nums">
                  {actual ? (resumen?.cantidad ?? 0) : "—"}
                </p>
                <p className="text-lg text-zinc-500 dark:text-zinc-400">
                  de {zona.aforo_max}
                </p>
              </div>
            </div>
            <SemaforoOcupacion estado={estado} />
          </div>

          <div className="mt-7">
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="font-medium">Aforo utilizado</span>
              <span className="font-semibold tabular-nums">
                {actual
                  ? formatearPorcentaje(resumen?.porcentaje ?? null)
                  : "—"}
              </span>
            </div>
            <BarraAforo
              porcentaje={actual ? (resumen?.porcentaje ?? null) : null}
              estado={estado}
            />
            <p className="mt-2 text-xs leading-5 text-zinc-500 dark:text-zinc-400">
              Semáforo: bajo &lt; {zona.umbral_bajo}% · moderado{" "}
              {zona.umbral_bajo}–{zona.umbral_alto}% · lleno &gt;{" "}
              {zona.umbral_alto}% del aforo.
            </p>
          </div>

          <div className="mt-6 flex flex-wrap items-center justify-between gap-2 border-t border-zinc-200 pt-4 text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
            <span>
              {actual
                ? "Última lectura del servidor"
                : "No pudimos leer la ocupación en este momento."}
            </span>
            {actualizado && actual?.updatedAt ? (
              <time dateTime={actual.updatedAt}>
                Actualizado: {actualizado}
              </time>
            ) : null}
          </div>
        </section>

        <Suspense fallback={<EstadisticasCargando />}>
          <EstadisticasDashboard
            zonaId={zona.id}
            timezone={zona.timezone}
            rango={rango}
          />
        </Suspense>

        <p className="mt-8 max-w-3xl text-xs leading-5 text-zinc-500 dark:text-zinc-400">
          CoworkFlow publica solo datos agregados. Los registros individuales se
          eliminan a los 90 días y las estadísticas requieren al menos 5
          personas distintas para mostrarse.
        </p>
      </main>
    </div>
  );
}

