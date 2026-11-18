import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowRight, Flame, Timer, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { ContadorOcupacion } from "@/components/ContadorOcupacion";
import { MejorMomento } from "@/components/MejorMomento";
import {
  construirSeriePorHora,
  etiquetaHora,
  formatearPermanencia,
  formatearPersonas,
  horaPunta,
  horasDelHorarioEnMinutos,
  promedioPorHoraDelDia,
  textoMejorMomento,
  tramosTranquilos,
} from "@/lib/dominio/estadisticas";
import {
  diaSemanaEnZona,
  horarioDelDia,
  limitesRangoDias,
  textoEstadoHorario,
} from "@/lib/dominio/tiempo";
import { datosDemoActivos, envPublico } from "@/lib/env";
import {
  obtenerFranjas,
  obtenerOcupacionActual,
  obtenerPermanenciaPromedio,
  type ResultadoRpc,
} from "@/lib/supabase/dashboard";
import { obtenerZonaPorSlug } from "@/lib/supabase/zonas";
import { interpretarQueryDashboard } from "@/lib/validacion/dashboard";

export const dynamic = "force-dynamic";

type Props = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

// Metadata estática a propósito: `generateMetadata` dinámico se resuelve en paralelo al
// render (metadata en streaming) y no sirve para adelantar el 404 de una zona inexistente.
export const metadata: Metadata = { title: "Dashboard · OptiWork" };

/** Ventana de los agregados de la portada (una sola consulta de franjas). */
const DIAS_AGREGADOS = 30;

function textoPromedioPersonas(promedio: number): string {
  const personas = Math.round(promedio);
  return `Promedio de ${formatearPersonas(personas)} ${
    personas === 1 ? "persona" : "personas"
  }`;
}

type PropsTarjeta = {
  titulo: string;
  Icono: LucideIcon;
  valor: string;
  detalle: ReactNode;
};

function TarjetaResumen({ titulo, Icono, valor, detalle }: PropsTarjeta) {
  return (
    <article className="tarjeta">
      <h2 className="flex items-center gap-2 text-sm font-medium text-tenue">
        <Icono aria-hidden className="size-4 shrink-0" />
        {titulo}
      </h2>
      <p className="mt-3 text-3xl font-semibold tracking-tight tabular-nums">
        {valor}
      </p>
      <p className="mt-1 text-xs leading-5 text-tenue">{detalle}</p>
    </article>
  );
}

/**
 * `/dashboard` — portada pública de la ocupación (RSC, dinámico y sin `'use cache'`).
 *
 * No exige sesión: lee la zona con la clave `anon` y RLS. Solo se renderizan agregados;
 * `user_id` y las filas de `sesiones` nunca cruzan al navegador.
 *
 * Portada = tarjeta principal en vivo + tres resúmenes de los últimos 30 días. La única isla
 * de cliente es `ContadorOcupacion` (Realtime sobre `ocupacion_actual`); todo lo demás es
 * HTML del servidor. Los gráficos completos viven en `/dashboard/estadisticas`.
 *
 * Coste de una visita anónima: 4 consultas (zona, `ocupacion_actual`, franjas de 30 días y
 * `permanencia_promedio`). El `?rango=` de enlaces antiguos se sigue aceptando porque
 * `interpretarQueryDashboard` lo valida, pero la portada lo ignora.
 *
 * `notFound()` se llama ANTES de devolver JSX y sin `<Suspense>`: así una zona inexistente
 * conserva un 404 real (sin `loading.tsx` en este segmento, que abriría el streaming y
 * fijaría un 200; ver la nota de entrega de la Tanda 2).
 */
export default async function PaginaDashboard({ searchParams }: Props) {
  const params = await searchParams;
  const { zona: slugSolicitado } = interpretarQueryDashboard(params);
  const slug = slugSolicitado ?? envPublico.NEXT_PUBLIC_ZONA_POR_DEFECTO;

  const zona = await obtenerZonaPorSlug(slug);
  if (!zona || !zona.activa) notFound();

  const ahora = new Date();
  const limites = limitesRangoDias(ahora, zona.timezone, DIAS_AGREGADOS);
  const permanenciaPromesa: Promise<ResultadoRpc<number | null>> = limites
    ? obtenerPermanenciaPromedio(zona.id, limites.desde, limites.hasta)
    : Promise.resolve({ ok: true, valor: null });

  const [actual, franjasResultado, permanenciaResultado] = await Promise.all([
    obtenerOcupacionActual(zona.id),
    obtenerFranjas(zona.id, DIAS_AGREGADOS),
    permanenciaPromesa,
  ]);

  const filas = franjasResultado.ok ? franjasResultado.valor : [];
  const punta = horaPunta(construirSeriePorHora(filas));

  const horario = horarioDelDia(zona, ahora);
  const horarioTexto = textoEstadoHorario(zona, ahora);
  const dow = diaSemanaEnZona(ahora, zona.timezone);
  const tramos =
    dow === null
      ? []
      : tramosTranquilos(
          filas,
          dow,
          {
            aforo_max: zona.aforo_max,
            umbral_bajo: zona.umbral_bajo,
            umbral_alto: zona.umbral_alto,
          },
          horario,
        );
  const textoDescanso = textoMejorMomento(tramos, horario);
  const promediosDia = dow === null ? [] : promedioPorHoraDelDia(filas, dow);
  const permanencia = permanenciaResultado.ok
    ? permanenciaResultado.valor
    : null;

  return (
    <div className="flex flex-1 flex-col">
      <header className="border-b border-borde bg-superficie">
        <div className="contenedor flex flex-wrap items-center justify-between gap-4 py-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-marca">
              OptiWork
            </p>
            <h1 className="text-lg font-semibold">{zona.nombre}</h1>
          </div>
          <Link
            href={`/dashboard/estadisticas?zona=${encodeURIComponent(zona.slug)}`}
            className="enlace-header"
          >
            Estadísticas
          </Link>
        </div>
      </header>

      <main className="contenedor flex-1 py-8">
        {datosDemoActivos ? (
          // Labelling obligatorio de la demo: quien mire el dashboard tiene que saber que parte
          // de las cifras es simulada (scripts/simular-ocupacion.ts). Solo clases de Tailwind,
          // sin atributos de estilo inline (la CSP los bloquea).
          <p
            role="note"
            className="mb-5 inline-flex flex-wrap items-center gap-2 rounded-full border border-moderado/30 bg-moderado-fondo px-4 py-1.5 text-xs leading-5 text-moderado-texto"
          >
            Datos de demostración: parte de las cifras proviene de una simulación.
          </p>
        ) : null}

        <ContadorOcupacion
          key={`${zona.id}-${actual?.updatedAt ?? "x"}`}
          zonaId={zona.id}
          cantidadInicial={actual ? actual.cantidad : null}
          actualizadoInicial={actual?.updatedAt ?? null}
          aforoMax={zona.aforo_max}
          umbralBajo={zona.umbral_bajo}
          umbralAlto={zona.umbral_alto}
          timezone={zona.timezone}
          horarioTexto={horarioTexto}
        />

        <div
          className={`mt-4 grid gap-4 ${
            textoDescanso ? "sm:grid-cols-2 lg:grid-cols-3" : "sm:grid-cols-2"
          }`}
        >
          {textoDescanso ? (
            <MejorMomento
              texto={textoDescanso}
              horas={horasDelHorarioEnMinutos(horario)}
              promedios={promediosDia}
              aforoMax={zona.aforo_max}
            />
          ) : null}

          <TarjetaResumen
            titulo="Hora más llena"
            Icono={Flame}
            valor={punta ? etiquetaHora(punta.hora) : "—"}
            detalle={
              punta
                ? `${textoPromedioPersonas(
                    punta.promedio,
                  )} según los últimos 30 días.`
                : "Sin datos suficientes todavía."
            }
          />

          <TarjetaResumen
            titulo="Estadía promedio"
            Icono={Timer}
            valor={formatearPermanencia(permanencia)}
            detalle="Últimos 30 días; se oculta con menos de 5 personas distintas."
          />
        </div>

        <Link
          href={`/dashboard/estadisticas?zona=${encodeURIComponent(zona.slug)}`}
          className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-3xl border border-borde bg-superficie p-6 transition-colors hover:border-marca hover:bg-marca-suave"
        >
          <span>
            <span className="block text-base font-semibold">
              Ver estadísticas completas
            </span>
            <span className="mt-1 block text-sm leading-6 text-tenue">
              Ocupación por hora, mapa de calor día × hora y promedios de los
              últimos 7 o 30 días.
            </span>
          </span>
          <ArrowRight aria-hidden className="size-5 shrink-0 text-marca" />
        </Link>

        <p className="mt-8 max-w-3xl text-xs leading-5 text-tenue">
          Solo publicamos cifras agregadas: nunca nombres, correos ni horarios
          individuales. Los registros de entrada y salida se eliminan a los 90
          días y solo se conservan los agregados.
        </p>
      </main>
    </div>
  );
}

