import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { EstadisticasDashboard } from "@/components/EstadisticasDashboard";
import { horaDeTexto } from "@/lib/dominio/tiempo";
import { envPublico } from "@/lib/env";
import { obtenerZonaPorSlug } from "@/lib/supabase/zonas";
import {
  RANGOS_DIAS,
  interpretarQueryDashboard,
  type RangoDias,
} from "@/lib/validacion/dashboard";

export const dynamic = "force-dynamic";

type Props = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export const metadata: Metadata = { title: "Estadísticas · OptiWork" };

/**
 * Selector de rango (7 o 30 días) como dos ENLACES renderizados en el servidor.
 *
 * No es un toggle de cliente: cada clic es una navegación que vuelve a resolver el RSC
 * con el `?rango=` validado por zod. `aria-current="page"` marca el activo para lectores
 * de pantalla y el rango es una lista cerrada (`RANGOS_DIAS`), nunca fechas arbitrarias.
 */
function SelectorRango({ slug, rango }: { slug: string; rango: RangoDias }) {
  return (
    <nav aria-label="Rango de días" className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-semibold uppercase tracking-wide text-tenue">
        Rango
      </span>
      {RANGOS_DIAS.map((dias) => {
        const activo = dias === rango;
        return (
          <Link
            key={dias}
            href={`/dashboard/estadisticas?zona=${encodeURIComponent(slug)}&rango=${dias}`}
            aria-current={activo ? "page" : undefined}
            className={`foco-marca inline-flex min-h-11 items-center rounded-full border px-4 text-sm font-semibold transition-colors ${
              activo
                ? "border-marca bg-marca text-white"
                : "border-borde bg-superficie text-tenue hover:border-marca hover:bg-marca-suave hover:text-tinta"
            }`}
          >
            {dias} días
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * `/dashboard/estadisticas` — estadísticas completas de la zona (RSC dinámico).
 *
 * Es la página que antes vivía dentro de la portada. Aquí quedan el selector 7/30, las
 * tarjetas (permanencia, personas distintas y hora punta), los gráficos por hora y el mapa
 * de calor; la portada `/dashboard` solo muestra el contador en vivo y tres resúmenes.
 *
 * Coste de una visita anónima: 6 consultas con `rango=30` y 7 con `rango=7` (zona + las
 * que lanza `EstadisticasDashboard`); ninguna de ellas está limitada por rate limit, ver S-37.
 * `hora_apertura`/`hora_cierre` se parsean con `horaDeTexto` (horas enteras 0..24) porque
 * es el contrato que espera `EstadisticasDashboard`.
 */
export default async function PaginaEstadisticas({ searchParams }: Props) {
  const params = await searchParams;
  const { zona: slugSolicitado, rango } = interpretarQueryDashboard(params);
  const slug = slugSolicitado ?? envPublico.NEXT_PUBLIC_ZONA_POR_DEFECTO;

  const zona = await obtenerZonaPorSlug(slug);
  if (!zona || !zona.activa) notFound();

  const horaApertura = horaDeTexto(zona.hora_apertura);
  const horaCierre = horaDeTexto(zona.hora_cierre);

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
            href={`/dashboard?zona=${encodeURIComponent(zona.slug)}`}
            className="enlace-header gap-1.5"
          >
            <ArrowLeft aria-hidden className="size-4" />
            Volver al panel
          </Link>
        </div>
      </header>

      <main className="contenedor flex-1 py-8">
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight">
              Estadísticas de uso
            </h2>
            <p className="mt-1 text-sm leading-6 text-tenue">
              {zona.nombre} · últimos {rango} días · solo cifras agregadas.
            </p>
          </div>
          <SelectorRango slug={zona.slug} rango={rango} />
        </div>

        <EstadisticasDashboard
          zonaId={zona.id}
          timezone={zona.timezone}
          rango={rango}
          aforoMax={zona.aforo_max}
          horaApertura={horaApertura}
          horaCierre={horaCierre}
        />

        <p className="mt-8 max-w-3xl text-xs leading-5 text-tenue">
          Solo publicamos cifras agregadas: nunca nombres, correos ni horarios
          individuales. El mapa de calor cubre siempre 30 días y una celda «—»
          significa que no hubo lecturas, no que el cowork estuviera vacío. Los
          registros individuales de entrada y salida se eliminan a los 90 días y
          solo se conservan los agregados.
        </p>
      </main>
    </div>
  );
}
