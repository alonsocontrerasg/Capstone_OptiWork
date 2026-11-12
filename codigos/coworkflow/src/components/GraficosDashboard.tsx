"use client";

import type { ReactNode } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type {
  PuntoHoraHoy,
  PuntoPromedioHora,
} from "@/lib/dominio/estadisticas";

/**
 * Gráficos del dashboard (isla de cliente, cargada con `ssr: false` desde
 * `GraficosDashboardCarga`).
 *
 * ¿Por qué cliente y con `ssr: false`?
 * Recharts mide el contenedor y escribe estilos por CSSOM al hidratar. La CSP de producción
 * (`style-src` sin `'unsafe-inline'`) bloquea los atributos `style` que lleguen en el HTML del
 * servidor, pero NO bloquea la manipulación del DOM desde JavaScript. Con `ssr: false` el SVG
 * nunca se renderiza en el servidor y no hay `style=` que bloquear.
 *
 * ¿Qué cruza al navegador?
 * Solo arrays agregados y pequeños: como máximo una entrada por hora del horario (≤24) con
 * números ya redondeados a 1 decimal — `{ etiqueta, promedio, muestras }` y
 * `{ etiqueta, cantidad|null }`. Nunca snapshots crudos, `user_id` ni filas de `sesiones`.
 *
 * Accesibilidad:
 * - Cada gráfico es `role="img"` con un `aria-label` que resume el dato, y debajo va la misma
 *   información en una tabla dentro de `<details>` (el color y la forma no son la única vía).
 * - Tooltips y ejes en español; las horas se rotulan con `etiquetaHora` (`08:00`).
 * - Los colores de ejes usan `currentColor` sobre `text-zinc-600 dark:text-zinc-400`, así que
 *   mantienen contraste en tema claro y oscuro sin leer el tema desde JavaScript.
 * - Sin atributos `style` ni `dangerouslySetInnerHTML`.
 */

const FORMATO_DECIMAL = new Intl.NumberFormat("es-CL", {
  maximumFractionDigits: 1,
});

const FORMATO_ENTERO = new Intl.NumberFormat("es-CL");

/** Azul 600: contraste ≥ 4,5:1 sobre fondo blanco y sobre zinc-950. */
const COLOR_SERIE = "#2563eb";

const ESTILO_TICK = { fill: "currentColor", fontSize: 11 } as const;

type TarjetaProps = {
  id: string;
  titulo: string;
  descripcion: string;
  children: ReactNode;
};

function TarjetaGrafico({ id, titulo, descripcion, children }: TarjetaProps) {
  return (
    <article
      aria-labelledby={id}
      className="flex flex-col rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950"
    >
      <h3 id={id} className="text-sm font-semibold">
        {titulo}
      </h3>
      <p className="mt-1 text-xs leading-5 text-zinc-500 dark:text-zinc-400">
        {descripcion}
      </p>
      <div className="mt-3 flex-1">{children}</div>
    </article>
  );
}

function Aviso({ texto, tono }: { texto: string; tono: "error" | "vacio" }) {
  return (
    <p
      className={`rounded-xl border border-dashed p-4 text-sm leading-6 ${
        tono === "error"
          ? "border-red-300 text-red-700 dark:border-red-800 dark:text-red-400"
          : "border-zinc-300 text-zinc-600 dark:border-zinc-700 dark:text-zinc-400"
      }`}
    >
      {texto}
    </p>
  );
}

type ContenidoTooltipProps = {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: unknown }>;
};

function ContenidoTooltipBarra({ active, payload }: ContenidoTooltipProps) {
  const punto = payload?.[0]?.payload as PuntoPromedioHora | undefined;
  if (!active || !punto) return null;

  return (
    <div className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-xs shadow-md dark:border-zinc-700 dark:bg-zinc-900">
      <p className="font-semibold text-zinc-900 dark:text-zinc-50">
        Hora {punto.etiqueta}
      </p>
      <p className="mt-1 text-zinc-700 dark:text-zinc-300">
        {FORMATO_DECIMAL.format(punto.promedio)}{" "}
        {punto.promedio === 1 ? "persona" : "personas"} en promedio
      </p>
      <p className="text-zinc-500 dark:text-zinc-400">
        {FORMATO_ENTERO.format(punto.muestras)} muestras
      </p>
    </div>
  );
}

function ContenidoTooltipHoy({ active, payload }: ContenidoTooltipProps) {
  const punto = payload?.[0]?.payload as PuntoHoraHoy | undefined;
  if (!active || !punto) return null;

  const cantidad =
    punto.cantidad === null
      ? "Sin lectura en esta hora"
      : `${FORMATO_DECIMAL.format(punto.cantidad)} ${
          punto.cantidad === 1 ? "persona" : "personas"
        }`;

  return (
    <div className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-xs shadow-md dark:border-zinc-700 dark:bg-zinc-900">
      <p className="font-semibold text-zinc-900 dark:text-zinc-50">
        Hora {punto.etiqueta}
      </p>
      <p className="mt-1 text-zinc-700 dark:text-zinc-300">{cantidad} dentro</p>
    </div>
  );
}

/** Resume el gráfico de barras en una frase para `aria-label`. */
function resumenBarras(puntos: PuntoPromedioHora[], dias: number): string {
  const primero = puntos[0];
  if (!primero) return "Sin datos de ocupación para graficar.";

  let maximo = primero;
  let minimo = primero;
  for (const punto of puntos) {
    if (punto.promedio > maximo.promedio) maximo = punto;
    if (punto.promedio < minimo.promedio) minimo = punto;
  }

  const detalle =
    maximo.etiqueta === minimo.etiqueta
      ? `siempre ${FORMATO_DECIMAL.format(maximo.promedio)} personas a las ${maximo.etiqueta}`
      : `máximo de ${FORMATO_DECIMAL.format(maximo.promedio)} personas a las ${
          maximo.etiqueta
        } y mínimo de ${FORMATO_DECIMAL.format(minimo.promedio)} a las ${
          minimo.etiqueta
        }`;

  return `Gráfico de barras con la ocupación promedio por hora del día en los últimos ${dias} días: ${detalle}. Los mismos valores están en la tabla de datos que sigue.`;
}

/** Puntos de hoy que sí tienen lectura (descarta los huecos). */
type PuntoConLectura = { etiqueta: string; cantidad: number };

function puntosConLectura(puntos: PuntoHoraHoy[]): PuntoConLectura[] {
  const salida: PuntoConLectura[] = [];
  for (const punto of puntos) {
    if (punto.cantidad === null) continue;
    salida.push({ etiqueta: punto.etiqueta, cantidad: punto.cantidad });
  }
  return salida;
}

/** Resume la curva de hoy en una frase para `aria-label`. */
function resumenHoy(puntos: PuntoHoraHoy[]): string {
  const conLectura = puntosConLectura(puntos);
  const primero = conLectura[0];
  const ultimo = conLectura[conLectura.length - 1];
  if (!primero || !ultimo) return "Sin lecturas de ocupación para hoy.";

  let maximo = primero;
  for (const punto of conLectura) {
    if (punto.cantidad > maximo.cantidad) maximo = punto;
  }

  return `Gráfico de área con la ocupación de hoy hora a hora: máximo de ${FORMATO_DECIMAL.format(
    maximo.cantidad,
  )} personas a las ${maximo.etiqueta} y última lectura de ${FORMATO_DECIMAL.format(
    ultimo.cantidad,
  )} personas a las ${ultimo.etiqueta}. Las horas sin lectura quedan como huecos. Los mismos valores están en la tabla de datos que sigue.`;
}

const CLASES_CELDA = "py-1 pr-3 text-left font-semibold text-zinc-600 dark:text-zinc-400";

function TablaBarras({ puntos }: { puntos: PuntoPromedioHora[] }) {
  return (
    <details className="mt-3 text-xs">
      <summary className="cursor-pointer font-medium text-zinc-600 dark:text-zinc-400">
        Ver tabla de datos
      </summary>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full border-collapse text-left">
          <caption className="sr-only">
            Ocupación promedio por hora del día, con la cantidad de muestras que
            respaldan cada promedio.
          </caption>
          <thead>
            <tr className="border-b border-zinc-200 dark:border-zinc-800">
              <th scope="col" className={CLASES_CELDA}>
                Hora
              </th>
              <th scope="col" className={CLASES_CELDA}>
                Promedio de personas
              </th>
              <th scope="col" className={CLASES_CELDA}>
                Muestras
              </th>
            </tr>
          </thead>
          <tbody>
            {puntos.map((punto) => (
              <tr
                key={punto.etiqueta}
                className="border-b border-zinc-100 last:border-0 dark:border-zinc-900"
              >
                <th
                  scope="row"
                  className="py-1 pr-3 text-left font-normal tabular-nums text-zinc-700 dark:text-zinc-300"
                >
                  {punto.etiqueta}
                </th>
                <td className="py-1 pr-3 tabular-nums">
                  {FORMATO_DECIMAL.format(punto.promedio)}
                </td>
                <td className="py-1 tabular-nums">
                  {FORMATO_ENTERO.format(punto.muestras)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function TablaHoy({ puntos }: { puntos: PuntoHoraHoy[] }) {
  return (
    <details className="mt-3 text-xs">
      <summary className="cursor-pointer font-medium text-zinc-600 dark:text-zinc-400">
        Ver tabla de datos
      </summary>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full border-collapse text-left">
          <caption className="sr-only">
            Ocupación de hoy por hora. «—» indica que no hubo lectura en esa
            hora.
          </caption>
          <thead>
            <tr className="border-b border-zinc-200 dark:border-zinc-800">
              <th scope="col" className={CLASES_CELDA}>
                Hora
              </th>
              <th scope="col" className={CLASES_CELDA}>
                Personas dentro
              </th>
            </tr>
          </thead>
          <tbody>
            {puntos.map((punto) => (
              <tr
                key={punto.etiqueta}
                className="border-b border-zinc-100 last:border-0 dark:border-zinc-900"
              >
                <th
                  scope="row"
                  className="py-1 pr-3 text-left font-normal tabular-nums text-zinc-700 dark:text-zinc-300"
                >
                  {punto.etiqueta}
                </th>
                <td className="py-1 tabular-nums">
                  {punto.cantidad === null
                    ? "—"
                    : FORMATO_DECIMAL.format(punto.cantidad)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}



/**
 * Barras del promedio por hora del día.
 *
 * `accessibilityLayer={false}`: la capa accesible de Recharts hace enfocables los elementos
 * del SVG y exige navegación por teclado; aquí el dato accesible es el `role="img"` con
 * `aria-label` más la tabla de datos, que funciona igual sin JavaScript.
 */
function GraficoBarras({
  puntos,
  dias,
}: {
  puntos: PuntoPromedioHora[];
  dias: number;
}) {
  return (
    <>
      <div
        role="img"
        aria-label={resumenBarras(puntos, dias)}
        className="h-64 w-full text-zinc-600 dark:text-zinc-400"
      >
        <ResponsiveContainer width="100%" height="100%" debounce={50}>
          <BarChart
            data={puntos}
            accessibilityLayer={false}
            margin={{ top: 8, right: 8, bottom: 0, left: -8 }}
          >
            <CartesianGrid
              stroke="currentColor"
              strokeOpacity={0.15}
              vertical={false}
            />
            <XAxis
              dataKey="etiqueta"
              tick={ESTILO_TICK}
              tickLine={false}
              axisLine={{ stroke: "currentColor", strokeOpacity: 0.3 }}
              interval="preserveStartEnd"
            />
            <YAxis width={36} tick={ESTILO_TICK} tickLine={false} axisLine={false} />
            <Tooltip
              cursor={{ fill: "currentColor", fillOpacity: 0.08 }}
              content={(props) => (
                <ContenidoTooltipBarra
                  active={props.active}
                  payload={props.payload}
                />
              )}
            />
            <Bar
              dataKey="promedio"
              name="Promedio de personas"
              fill={COLOR_SERIE}
              radius={[4, 4, 0, 0]}
              isAnimationActive={false}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <TablaBarras puntos={puntos} />
      <p className="mt-2 text-[11px] leading-5 text-zinc-500 dark:text-zinc-400">
        Cada barra es el promedio de las lecturas automáticas de esa hora;
        «muestras» indica cuántas lecturas la respaldan.
      </p>
    </>
  );
}

/**
 * Área de la ocupación de hoy.
 *
 * `connectNulls={false}` deja un hueco cuando no hubo snapshot en una hora: dibujar una línea
 * continua ahí inventaría datos. `dot={false}` porque con ≤24 puntos el área ya se lee bien.
 */
function GraficoHoy({ puntos }: { puntos: PuntoHoraHoy[] }) {
  return (
    <>
      <div
        role="img"
        aria-label={resumenHoy(puntos)}
        className="h-64 w-full text-zinc-600 dark:text-zinc-400"
      >
        <ResponsiveContainer width="100%" height="100%" debounce={50}>
          <AreaChart
            data={puntos}
            accessibilityLayer={false}
            margin={{ top: 8, right: 8, bottom: 0, left: -8 }}
          >
            <defs>
              <linearGradient id="relleno-hoy" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={COLOR_SERIE} stopOpacity={0.45} />
                <stop offset="100%" stopColor={COLOR_SERIE} stopOpacity={0.05} />
              </linearGradient>
            </defs>
            <CartesianGrid
              stroke="currentColor"
              strokeOpacity={0.15}
              vertical={false}
            />
            <XAxis
              dataKey="etiqueta"
              tick={ESTILO_TICK}
              tickLine={false}
              axisLine={{ stroke: "currentColor", strokeOpacity: 0.3 }}
              interval="preserveStartEnd"
            />
            <YAxis
              width={36}
              tick={ESTILO_TICK}
              tickLine={false}
              axisLine={false}
              allowDecimals={false}
              domain={[0, "auto"]}
            />
            <Tooltip
              cursor={{ stroke: "currentColor", strokeOpacity: 0.3 }}
              content={(props) => (
                <ContenidoTooltipHoy
                  active={props.active}
                  payload={props.payload}
                />
              )}
            />
            <Area
              type="monotone"
              dataKey="cantidad"
              name="Personas dentro"
              stroke={COLOR_SERIE}
              strokeWidth={2}
              fill="url(#relleno-hoy)"
              connectNulls={false}
              dot={false}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <TablaHoy puntos={puntos} />
      <p className="mt-2 text-[11px] leading-5 text-zinc-500 dark:text-zinc-400">
        Un hueco en la curva significa que no hubo lectura en esa hora.
      </p>
    </>
  );
}


type Props = {
  /** Promedio por hora del período elegido, o `null` si la RPC falló. */
  porHora: PuntoPromedioHora[] | null;
  /** Ocupación de hoy hora a hora (con huecos `null`), o `null` si falló. */
  hoy: PuntoHoraHoy[] | null;
  /** 7 o 30: sólo se usa para redactar la tarjeta. */
  dias: number;
};

export function GraficosDashboard({ porHora, hoy, dias }: Props) {
  const hayLecturasHoy =
    hoy !== null && hoy.some((punto) => punto.cantidad !== null);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <TarjetaGrafico
        id="grafico-promedio-hora"
        titulo="Ocupación promedio por hora del día"
        descripcion={`Promedio de personas dentro por hora del día en los últimos ${dias} días, contando solo las lecturas dentro del horario de la zona.`}
      >
        {porHora === null ? (
          <Aviso
            tono="error"
            texto="No se pudo cargar el promedio por hora. Recarga la página para reintentar."
          />
        ) : porHora.length === 0 ? (
          <Aviso
            tono="vacio"
            texto="Todavía no hay lecturas de ocupación en el período. El gráfico aparecerá cuando el sistema registre snapshots."
          />
        ) : (
          <GraficoBarras puntos={porHora} dias={dias} />
        )}
      </TarjetaGrafico>

      <TarjetaGrafico
        id="grafico-ocupacion-hoy"
        titulo="Ocupación de hoy"
        descripcion="Personas dentro del cowork en cada hora de hoy, en la zona horaria del cowork."
      >
        {hoy === null ? (
          <Aviso
            tono="error"
            texto="No se pudo cargar la ocupación de hoy. Recarga la página para reintentar."
          />
        ) : !hayLecturasHoy ? (
          <Aviso tono="vacio" texto="Todavía no hay lecturas de hoy." />
        ) : (
          <GraficoHoy puntos={hoy} />
        )}
      </TarjetaGrafico>
    </div>
  );
}

