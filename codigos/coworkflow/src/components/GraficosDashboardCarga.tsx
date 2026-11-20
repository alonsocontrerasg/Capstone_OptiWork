"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";

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
 * Mientras llega el chunk se reserva espacio con un esqueleto. El CLS se mide en la suite
 * de producción; la altura final puede variar según el texto. `aria-busy` anuncia la espera.
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
          className="h-72 animate-pulse rounded-[20px] border border-borde bg-superficie"
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
  const contenedor = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!contenedor.current) return;
    if (!("IntersectionObserver" in window)) {
      void Promise.resolve().then(() => setVisible(true));
      return;
    }
    const observador = new IntersectionObserver(([entrada]) => {
      if (entrada.isIntersecting) { setVisible(true); observador.disconnect(); }
    }, { rootMargin: "200px" });
    observador.observe(contenedor.current);
    return () => observador.disconnect();
  }, []);
  return <div ref={contenedor} data-testid="graficos-diferidos" className="min-w-0">
    {visible ? <GraficosDiferidos porHora={porHora} hoy={hoy} dias={dias} /> : <EsqueletoGraficos />}
  </div>;
}
