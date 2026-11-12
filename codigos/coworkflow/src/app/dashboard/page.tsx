import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { ContadorOcupacion } from "@/components/ContadorOcupacion";
import { EstadisticasDashboard } from "@/components/EstadisticasDashboard";
import { etiquetaHora } from "@/lib/dominio/estadisticas";
import { horaDeTexto } from "@/lib/dominio/tiempo";
import { envPublico, datosDemoActivos } from "@/lib/env";
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

// Metadata estática a propósito: `generateMetadata` dinámico se resuelve en paralelo al
// render (metadata en streaming) y no sirve para adelantar el 404 de una zona inexistente.
export const metadata: Metadata = { title: "Dashboard · CoworkFlow" };

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
 * `/dashboard` — dashboard público (RSC, dinámico y sin `'use cache'`).
 *
 * No exige sesión: lee la zona con la clave `anon` y RLS. Solo se renderizan agregados;
 * `user_id` y las filas de `sesiones` nunca cruzan al navegador. El rango es una lista
 * cerrada (7|30) y un valor inválido cae al default sin romper la página.
 *
 * El contador inicial se pinta en el servidor y lo refresca en el navegador la isla
 * `ContadorOcupacion` (Realtime sobre `ocupacion_actual`). Las tarjetas de texto y el mapa de
 * calor también se calculan en el servidor; los gráficos son la única isla de cliente y se
 * cargan con `ssr: false` desde `GraficosDashboardCarga`.
 *
 * `notFound()` se llama ANTES de devolver JSX y antes de cualquier `<Suspense>`: así la
 * respuesta conserva un 404 real (sin `loading.tsx` en este segmento, que abriría el
 * streaming y fijaría un 200; ver la nota de entrega de la Tanda 2).
 */
export default async function PaginaDashboard({ searchParams }: Props) {
  const params = await searchParams;
  const { zona: slugSolicitado, rango } = interpretarQueryDashboard(params);
  const slug = slugSolicitado ?? envPublico.NEXT_PUBLIC_ZONA_POR_DEFECTO;

  const zona = await obtenerZonaPorSlug(slug);
  if (!zona || !zona.activa) notFound();

  const actual = await obtenerOcupacionActual(zona.id);

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
        {datosDemoActivos ? (
          // Labelling obligatorio de la demo: quien mire el dashboard tiene que saber que parte
          // de las cifras es simulada (scripts/simular-ocupacion.ts). Solo clases de Tailwind,
          // sin atributos de estilo inline (la CSP los bloquea).
          <p
            role="note"
            className="mb-5 rounded-xl border border-amber-300 bg-amber-50 px-4 py-2 text-xs leading-5 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
          >
            Datos de demostración: parte de las cifras proviene de una simulación.
          </p>
        ) : null}

        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <p className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
            Ocupación ahora
          </p>
          <p className="max-w-sm text-xs leading-5 text-zinc-500 dark:text-zinc-400">
            Solo cifras agregadas. No mostramos nombres, correos ni horarios
            individuales.
          </p>
        </div>

        <ContadorOcupacion
          key={`${zona.id}-${actual?.updatedAt ?? "x"}`}
          zonaId={zona.id}
          cantidadInicial={actual ? actual.cantidad : null}
          actualizadoInicial={actual?.updatedAt ?? null}
          aforoMax={zona.aforo_max}
          umbralBajo={zona.umbral_bajo}
          umbralAlto={zona.umbral_alto}
          timezone={zona.timezone}
        />

        <Suspense fallback={<EstadisticasCargando />}>
          <EstadisticasDashboard
            zonaId={zona.id}
            timezone={zona.timezone}
            rango={rango}
            aforoMax={zona.aforo_max}
            horaApertura={apertura}
            horaCierre={cierre}
          />
        </Suspense>

        <p className="mt-8 max-w-3xl text-xs leading-5 text-zinc-500 dark:text-zinc-400">
          CoworkFlow publica solo datos agregados. Los registros individuales de
          entrada y salida se eliminan a los 90 días y solo se conservan los
          agregados. La permanencia promedio y la cantidad de personas distintas
          se muestran únicamente si el período incluye al menos 5 personas
          distintas; la hora punta y los gráficos son promedios de ocupación y no
          dependen de esa regla.
        </p>
      </main>
    </div>
  );
}

