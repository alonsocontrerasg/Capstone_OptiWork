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
 * - Los cinco niveles de color salen de UNA sola gama (la marca del sitio) y se escriben
 *   como clases Tailwind literales: Tailwind busca cadenas completas en el código, así que
 *   armar `bg-marca/${n}` por interpolación no generaría los estilos.
 * - Si la RPC falló (`filas === null`) solo esta tarjeta muestra su aviso: el resto de la
 *   página sigue funcionando.
 */

type Nivel = 1 | 2 | 3 | 4 | 5;

const CLASES_NIVEL: Record<Nivel, string> = {
  1: "bg-marca-suave text-marca-oscura",
  2: "bg-marca/20 text-tinta",
  3: "bg-marca/45 text-tinta",
  4: "bg-marca text-white",
  5: "bg-marca-oscura text-white",
};

const CLASES_SIN_DATO = "bg-fondo text-tenue";

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
    <article aria-labelledby="mapa-calor-titulo" className="tarjeta">
      <h3 id="mapa-calor-titulo" className="text-sm font-semibold">
        Mapa de calor día × hora
      </h3>
      <p className="mt-1 text-xs leading-5 text-tenue">
        Promedio de personas dentro por día de la semana y hora, sobre los
        últimos 30 días. El color resume el % del aforo ({aforoMax} personas).
      </p>

      {matriz === null ? (
        <p className="mt-4 text-sm font-medium text-lleno-texto">
          No se pudo cargar el mapa de calor.
        </p>
      ) : !hayDatos ? (
        <p className="mt-4 rounded-xl border border-dashed border-borde p-4 text-sm leading-6 text-tenue">
          Todavía no hay lecturas automáticas suficientes para dibujar el mapa
          de calor. Aparecerá cuando el sistema registre snapshots de
          ocupación.
        </p>
      ) : (
        <>
          <div className="mt-4 space-y-2 lg:hidden">
            <p className="text-sm text-tenue">Abre un día para consultar todas sus horas.</p>
            {matriz.map((fila,indiceDia)=><details key={DIAS_SEMANA[indiceDia]} className="rounded-xl border border-borde">
              <summary className="min-h-11 cursor-pointer px-3 py-3 text-sm font-semibold">{DIAS_SEMANA[indiceDia]}</summary>
              <ul className="grid grid-cols-3 gap-2 px-3 pb-3 sm:grid-cols-6">
                {horas.map((hora)=>{
                  const valor=fila[hora]??null;
                  return <li key={hora} className={`min-w-0 rounded-lg p-2 text-center ${valor===null?CLASES_SIN_DATO:CLASES_NIVEL[nivelDeOcupacion(valor,aforoMax)]}`}>
                    <span className="block text-sm">{etiquetaHora(hora)}</span>
                    <span className="block text-base font-semibold">{valor===null?"—":Math.round(valor)}</span>
                  </li>;
                })}
              </ul>
            </details>)}
          </div>
          <div className="mt-4 hidden overflow-x-auto lg:block">
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
                    className="px-2 py-1.5 text-left font-semibold text-tenue"
                  >
                    Día
                  </th>
                  {horas.map((hora) => (
                    <th
                      key={hora}
                      scope="col"
                      className="px-2 py-1.5 text-center font-medium text-tenue"
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
                      className="whitespace-nowrap px-2 py-1.5 text-left font-medium text-tinta"
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

          <ul className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-tenue">
            {NIVELES.map(({ nivel, etiqueta }) => (
              <li key={nivel} className="flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className={`size-3.5 rounded-sm ring-1 ring-borde ring-inset ${CLASES_NIVEL[nivel]}`}
                />
                {etiqueta}
              </li>
            ))}
            <li className="flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className={`size-3.5 rounded-sm ring-1 ring-borde ring-inset ${CLASES_SIN_DATO}`}
              />
              sin datos
            </li>
          </ul>
        </>
      )}
    </article>
  );
}
