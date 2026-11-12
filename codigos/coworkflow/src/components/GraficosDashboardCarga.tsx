"use client";

import dynamic from "next/dynamic";

import type {
  PuntoHoraHoy,
  PuntoPromedioHora,
} from "@/lib/dominio/estadisticas";

/**
 * Envoltorio de cliente que carga `GraficosDashboard` con `ssr: false`.
 *
 * ¿Por qué un archivo aparte? `ssr: false` NO se permite dentro de un Server Component, y
 * `EstadisticasDashboard` lo es (importa `server-only`). Este módulo sí es de cliente, así que
 * puede usar `next/dynamic` con `ssr: false`: Recharts queda fuera del HTML del servidor y de
 * la hidratación inicial, y sus estilos inline por CSSOM nunca chocan con la CSP.
 *
 * Mientras llega el chunk se muestra un esqueleto con las mismas dimensiones para que no haya
 * salto de layout (CLS). El `aria-busy` avisa a los lectores de pantalla.
 */

type Props = {
  porHora: PuntoPromedioHora[] | null;
  hoy: PuntoHoraHoy[] | null;
  dias: number;
};

function EsqueletoGraficos() {
  return (
    <div
      aria-busy="true"
      aria-label="Cargando gráficos de ocupación"
      className="grid gap-4 lg:grid-cols-2"
    >
      {[0, 1].map((indice) => (
        <div
          key={indice}
          className="h-72 animate-pulse rounded-2xl border border-zinc-200 bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900"
        />
      ))}
    </div>
  );
}

const GraficosDiferidos = dynamic(
  () => import("./GraficosDashboard").then((modulo) => modulo.GraficosDashboard),
  {
    ssr: false,
    loading: () => <EsqueletoGraficos />,
  },
);

export function GraficosDashboardCarga({ porHora, hoy, dias }: Props) {
  return <GraficosDiferidos porHora={porHora} hoy={hoy} dias={dias} />;
}
