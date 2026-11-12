import "server-only";

import {
  DIAS_SEMANA,
  construirMatrizCalor,
  etiquetaHora,
  type FilaFranja,
  type HorarioZona,
} from "@/lib/dominio/estadisticas";

/**
 * Mapa de calor día × hora del dashboard, renderizado en el SERVIDOR (RSC).
 *
 * - No usa Recharts: la rejilla es una `<table>` con filas lunes→domingo (dow ISO 1..7) y
 *   columnas las horas del horario de la zona. Al ser HTML plano no hay atributos `style`
 *   que la CSP de producción pueda bloquear, y funciona sin JavaScript.
 * - La matriz se calcula con `construirMatrizCalor` a partir de las franjas de 30 días: cada
 *   celda es el promedio ponderado por `muestras`, o `null` si no hubo snapshots.
 * - Accesibilidad: `caption` sr-only, `scope="col"`/`scope="row"` en los encabezados y el
 *   número escrito en cada celda (el color nunca es la única señal). Celda sin datos = «—».
 * - Los cinco niveles de color salen de UNA sola gama (azul) y se escriben como clases
 *   Tailwind literales: Tailwind busca cadenas completas en el código, así que armar
 *   `bg-blue-${n}` por interpolación no generaría los estilos.
 * - Si la RPC falló (`filas === null`) solo esta tarjeta muestra su aviso: el resto de la
 *   página sigue funcionando.
 */

type Nivel = 1 | 2 | 3 | 4 | 5;

const CLASES_NIVEL: Record<Nivel, string> = {
  1: "bg-blue-50 text-blue-900 dark:bg-blue-950 dark:text-blue-200",
  2: "bg-blue-100 text-blue-900 dark:bg-blue-900 dark:text-blue-100",
  3: "bg-blue-300 text-blue-950 dark:bg-blue-700 dark:text-white",
  4: "bg-blue-600 text-white dark:bg-blue-400 dark:text-blue-950",
  5: "bg-blue-800 text-white dark:bg-blue-300 dark:text-blue-950",
};

const CLASES_SIN_DATO =
  "bg-zinc-100 text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400";

const NIVELES: { nivel: Nivel; etiqueta: string }[] = [
  { nivel: 1, etiqueta: "menos de 20 % del aforo" },
  { nivel: 2, etiqueta: "20–39 % del aforo" },
  { nivel: 3, etiqueta: "40–59 % del aforo" },
  { nivel: 4, etiqueta: "60–79 % del aforo" },
  { nivel: 5, etiqueta: "80 % o más del aforo" },
];

/** Nivel de color (1 = menos ocupado) según el porcentaje del aforo máximo de la zona. */
function nivelDeOcupacion(valor: number, aforoMax: number): Nivel {
  if (!Number.isFinite(valor) || !Number.isFinite(aforoMax) || aforoMax <= 0) {
    return 1;
  }

  const porcentaje = (Math.max(0, valor) / aforoMax) * 100;
  if (porcentaje < 20) return 1;
  if (porcentaje < 40) return 2;
  if (porcentaje < 60) return 3;
  if (porcentaje < 80) return 4;
  return 5;
}

type Props = {
  /** Franjas de 30 días o `null` si la RPC falló (solo se cae esta tarjeta). */
  filas: FilaFranja[] | null;
  /** Horas del horario de la zona, en orden y sin la hora de cierre. */
  horas: number[];
  aforoMax: number;
  /** Horario de la zona; descarta por defensa en profundidad horas fuera de rango. */
  horario: HorarioZona | null;
};

export function MapaCalorDashboard({ filas, horas, aforoMax, horario }: Props) {
  const matriz = filas === null ? null : construirMatrizCalor(filas, horario);
  const hayDatos =
    matriz !== null &&
    matriz.some((fila) => fila.some((valor) => valor !== null));

  return (
    <article
      aria-labelledby="mapa-calor-titulo"
      className="rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950"
    >
      <h3 id="mapa-calor-titulo" className="text-sm font-semibold">
        Mapa de calor día × hora
      </h3>
      <p className="mt-1 text-xs leading-5 text-zinc-500 dark:text-zinc-400">
        Promedio de personas dentro por día de la semana y hora, sobre los
        últimos 30 días. El color resume el % del aforo ({aforoMax} personas).
      </p>

      {matriz === null ? (
        <p className="mt-4 text-sm font-medium text-red-600 dark:text-red-400">
          No se pudo cargar el mapa de calor.
        </p>
      ) : !hayDatos ? (
        <p className="mt-4 rounded-xl border border-dashed border-zinc-300 p-4 text-sm leading-6 text-zinc-600 dark:border-zinc-700 dark:text-zinc-400">
          Todavía no hay lecturas automáticas suficientes para dibujar el mapa
          de calor. Aparecerá cuando el sistema registre snapshots de
          ocupación.
        </p>
      ) : (
        <>
          <div className="mt-4 overflow-x-auto">
            <table className="w-max border-separate border-spacing-1 text-xs">
              <caption className="sr-only">
                Promedio de ocupación en personas dentro del cowork por día de
                la semana y hora, en los últimos 30 días. Cada celda muestra el
                promedio redondeado; «—» indica que no hubo lecturas en esa
                hora. El color indica el porcentaje del aforo: niveles más
                intensos son mayor ocupación.
              </caption>
              <thead>
                <tr>
                  <th
                    scope="col"
                    className="px-2 py-1.5 text-left font-semibold text-zinc-600 dark:text-zinc-400"
                  >
                    Día
                  </th>
                  {horas.map((hora) => (
                    <th
                      key={hora}
                      scope="col"
                      className="px-2 py-1.5 text-center font-medium text-zinc-600 dark:text-zinc-400"
                    >
                      {etiquetaHora(hora)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {matriz.map((fila, indiceDia) => (
                  <tr key={DIAS_SEMANA[indiceDia]}>
                    <th
                      scope="row"
                      className="whitespace-nowrap px-2 py-1.5 text-left font-medium text-zinc-700 dark:text-zinc-300"
                    >
                      {DIAS_SEMANA[indiceDia]}
                    </th>
                    {horas.map((hora) => {
                      const valor = fila[hora] ?? null;
                      const nivel =
                        valor === null
                          ? null
                          : nivelDeOcupacion(valor, aforoMax);

                      return (
                        <td
                          key={hora}
                          className={`rounded px-2 py-1.5 text-center font-semibold tabular-nums ${
                            nivel === null
                              ? CLASES_SIN_DATO
                              : CLASES_NIVEL[nivel]
                          }`}
                        >
                          {valor === null ? "—" : Math.round(valor)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <ul className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-zinc-600 dark:text-zinc-400">
            {NIVELES.map(({ nivel, etiqueta }) => (
              <li key={nivel} className="flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className={`size-3.5 rounded-sm ring-1 ring-zinc-400/40 ring-inset dark:ring-zinc-600 ${CLASES_NIVEL[nivel]}`}
                />
                {etiqueta}
              </li>
            ))}
            <li className="flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className={`size-3.5 rounded-sm ring-1 ring-zinc-400/40 ring-inset dark:ring-zinc-600 ${CLASES_SIN_DATO}`}
              />
              sin datos
            </li>
          </ul>
        </>
      )}
    </article>
  );
}
