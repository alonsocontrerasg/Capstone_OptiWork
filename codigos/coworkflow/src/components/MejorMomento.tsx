import "server-only";

import { Sparkles } from "lucide-react";

import { etiquetaHora } from "@/lib/dominio/estadisticas";

/**
 * Tarjeta «Mejor momento» del dashboard público.
 *
 * Es un Server Component: recibe los promedios día × hora ya agregados y pinta una mini
 * gráfica con HTML/CSS, sin Recharts ni atributos `style` (la CSP de producción solo permite
 * hojas de estilo con nonce). Las barras son decorativas; el resumen accesible va en el
 * `aria-label` del contenedor `role="img"`.
 *
 * Las horas sin datos se pintan como un pilar corto neutro (`bg-borde`), nunca como 0: no
 * hubo lecturas, no es que el cowork estuviera vacío.
 */

/** 8 niveles: altura y color literales para que Tailwind los emita en el build. */
const ALTURAS = [
  "h-1",
  "h-2",
  "h-3",
  "h-4",
  "h-6",
  "h-8",
  "h-12",
  "h-16",
] as const;

const COLORES = [
  "bg-marca-suave",
  "bg-marca/25",
  "bg-marca/40",
  "bg-marca/55",
  "bg-marca/70",
  "bg-marca/85",
  "bg-marca",
  "bg-marca-oscura",
] as const;

const NIVELES = ALTURAS.length;

type Props = {
  /** Texto ya resuelto por `textoMejorMomento` («Antes de las 10:00», …). */
  texto: string;
  /** Promedio por hora (0..23) del día mostrado; `null` = sin datos. */
  promedios: readonly (number | null)[];
  /** Horas del horario de la zona, en orden (0..23). */
  horas: readonly number[];
  aforoMax: number;
};

function nivelDeOcupacion(
  promedio: number | null,
  aforoMax: number,
): number | null {
  if (promedio === null || !Number.isFinite(promedio) || promedio < 0) {
    return null;
  }
  if (!Number.isFinite(aforoMax) || aforoMax <= 0) return 0;

  const porcentaje = (promedio / aforoMax) * 100;
  const nivel = Math.floor(porcentaje / (100 / NIVELES));
  return Math.min(NIVELES - 1, Math.max(0, nivel));
}

function textoPersonas(promedio: number): string {
  const personas = Math.round(promedio);
  return `${personas} ${personas === 1 ? "persona" : "personas"}`;
}

export function MejorMomento({ texto, promedios, horas, aforoMax }: Props) {
  const conDatos = horas.filter((hora) => {
    const promedio = promedios[hora];
    return (
      typeof promedio === "number" &&
      Number.isFinite(promedio) &&
      promedio >= 0
    );
  });

  const descripcion =
    conDatos.length === 0
      ? "Sin datos de ocupación por hora para este día."
      : `Ocupación promedio por hora del día: ${conDatos
          .map(
            (hora) =>
              `${etiquetaHora(hora)} ${textoPersonas(promedios[hora] ?? 0)}`,
          )
          .join("; ")}.`;

  return (
    <article className="tarjeta">
      <h2 className="flex items-center gap-2 text-sm font-medium text-tenue">
        <Sparkles aria-hidden className="size-4 shrink-0" />
        Mejor momento
      </h2>
      <p className="mt-3 text-2xl font-semibold tracking-tight">{texto}</p>
      <div
        role="img"
        aria-label={descripcion}
        className="mt-4 flex h-16 items-end gap-1"
      >
        {horas.map((hora) => {
          const nivel = nivelDeOcupacion(promedios[hora] ?? null, aforoMax);
          return (
            <span
              key={hora}
              aria-hidden="true"
              className={`flex-1 rounded-sm ${
                nivel === null
                  ? "h-1 bg-borde"
                  : `${ALTURAS[nivel]} ${COLORES[nivel]}`
              }`}
            />
          );
        })}
      </div>
      <p className="mt-2 text-xs leading-5 text-tenue">
        Según los últimos 30 días.
      </p>
    </article>
  );
}
