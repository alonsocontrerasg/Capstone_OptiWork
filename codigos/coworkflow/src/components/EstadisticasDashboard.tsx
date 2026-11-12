import "server-only";

import type { ReactNode } from "react";
import {
  CalendarDays,
  Flame,
  Timer,
  Users,
  type LucideIcon,
} from "lucide-react";

import {
  construirSeriePorHora,
  etiquetaHora,
  formatearPermanencia,
  formatearPersonas,
  horaPunta,
  type FilaFranja,
} from "@/lib/dominio/estadisticas";
import { limitesRangoDias } from "@/lib/dominio/tiempo";
import {
  obtenerFranjas,
  obtenerPermanenciaPromedio,
  obtenerPersonasDistintas,
  type ResultadoRpc,
} from "@/lib/supabase/dashboard";
import type { RangoDias } from "@/lib/validacion/dashboard";

/**
 * Estadísticas de texto del dashboard, renderizadas en el servidor.
 *
 * Las tres lecturas se lanzan en paralelo. Cada tarjeta conserva su propio estado: una RPC
 * caída muestra «No se pudo cargar» solo en esa tarjeta, mientras las demás siguen visibles.
 * `valor === null` (k-anonimato de la RPC) no es un error: se muestra «Sin datos suficientes».
 * Ese k-anonimato aplica a permanencia y personas distintas, que describen a individuos; la
 * hora punta es un promedio de ocupación y no depende de esa regla.
 *
 * Solo viajan agregados: esta función no se importa desde ningún Client Component. Los
 * gráficos y el mapa de calor llegan en la Tanda 4.
 */
type Props = {
  zonaId: string;
  timezone: string;
  rango: RangoDias;
};

type Tono = "normal" | "vacio" | "error";

type Texto = {
  texto: string;
  tono: Tono;
};

type PropsTarjeta = {
  titulo: string;
  Icono: LucideIcon;
  children: ReactNode;
  detalle?: string;
};

function TarjetaEstadistica({
  titulo,
  Icono,
  children,
  detalle,
}: PropsTarjeta) {
  return (
    <div className="rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
      <dt className="flex items-center gap-2 text-sm font-medium text-zinc-600 dark:text-zinc-400">
        <span className="grid size-8 place-items-center rounded-lg bg-zinc-100 text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
          <Icono aria-hidden className="size-4" />
        </span>
        {titulo}
      </dt>
      <dd className="mt-3">
        {children}
        {detalle ? (
          <span className="mt-1 block text-xs leading-5 text-zinc-500 dark:text-zinc-400">
            {detalle}
          </span>
        ) : null}
      </dd>
    </div>
  );
}

function clasesValor(tono: Tono): string {
  if (tono === "error") {
    return "text-base font-medium text-red-600 dark:text-red-400";
  }
  if (tono === "vacio") {
    return "text-base font-medium text-zinc-500 dark:text-zinc-400";
  }
  return "text-2xl font-semibold tracking-tight tabular-nums";
}

function textoPermanencia(
  resultado: ResultadoRpc<number | null>,
): Texto {
  if (!resultado.ok) {
    return { texto: "No se pudo cargar", tono: "error" };
  }
  if (resultado.valor === null) {
    return { texto: "Sin datos suficientes", tono: "vacio" };
  }
  return {
    texto: formatearPermanencia(resultado.valor),
    tono: "normal",
  };
}

function textoPersonas(resultado: ResultadoRpc<number | null>): Texto {
  if (!resultado.ok) {
    return { texto: "No se pudo cargar", tono: "error" };
  }
  if (resultado.valor === null) {
    return { texto: "Sin datos suficientes", tono: "vacio" };
  }
  return {
    texto: `${formatearPersonas(resultado.valor)} ${
      resultado.valor === 1 ? "persona" : "personas"
    }`,
    tono: "normal",
  };
}

function textoHoraPunta(
  resultado: ResultadoRpc<FilaFranja[]>,
): { valor: Texto; detalle?: string } {
  if (!resultado.ok) {
    return {
      valor: { texto: "No se pudo cargar", tono: "error" },
    };
  }

  const punta = horaPunta(construirSeriePorHora(resultado.valor));
  if (!punta) {
    // Sin franjas publicables: no es un problema de k-anonimato (la tarjeta solo muestra un
    // promedio de ocupación), simplemente no hay snapshots en el rango.
    return {
      valor: { texto: "Sin datos", tono: "vacio" },
    };
  }

  if (punta.promedio <= 0) {
    // Hay franjas pero ninguna registró gente dentro: se evita destacar «00:00 · 0 personas»
    // como si fuera la hora de mayor uso.
    return {
      valor: { texto: "Sin actividad registrada", tono: "vacio" },
    };
  }

  const promedio = Math.round(punta.promedio);
  return {
    valor: {
      texto: etiquetaHora(punta.hora),
      tono: "normal",
    },
    detalle: `${formatearPersonas(promedio)} ${
      promedio === 1 ? "persona" : "personas"
    } en promedio`,
  };
}

export async function EstadisticasDashboard({
  zonaId,
  timezone,
  rango,
}: Props) {
  const limites = limitesRangoDias(new Date(), timezone, rango);
  if (!limites) {
    console.error(
      "[dashboard] no se pudieron calcular los límites del rango para la zona:",
      zonaId,
    );
  }

  const [franjas, permanencia, personas] = await Promise.all([
    obtenerFranjas(zonaId, rango),
    limites
      ? obtenerPermanenciaPromedio(zonaId, limites.desde, limites.hasta)
      : Promise.resolve<ResultadoRpc<number | null>>({ ok: false }),
    limites
      ? obtenerPersonasDistintas(zonaId, limites.desde, limites.hasta)
      : Promise.resolve<ResultadoRpc<number | null>>({ ok: false }),
  ]);

  const permanenciaTexto = textoPermanencia(permanencia);
  const personasTexto = textoPersonas(personas);
  const punta = textoHoraPunta(franjas);

  return (
    <section aria-labelledby="estadisticas-titulo" className="mt-8">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2
            id="estadisticas-titulo"
            className="text-xl font-semibold tracking-tight"
          >
            Estadísticas de uso
          </h2>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            Últimos {rango} días · solo cifras agregadas.
          </p>
        </div>
        {!franjas.ok || !permanencia.ok || !personas.ok ? (
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Algunas tarjetas no están disponibles en este momento.
          </p>
        ) : null}
      </div>

      <dl className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <TarjetaEstadistica titulo="Permanencia promedio" Icono={Timer}>
          <span className={clasesValor(permanenciaTexto.tono)}>
            {permanenciaTexto.texto}
          </span>
        </TarjetaEstadistica>

        <TarjetaEstadistica titulo="Personas distintas" Icono={Users}>
          <span className={clasesValor(personasTexto.tono)}>
            {personasTexto.texto}
          </span>
        </TarjetaEstadistica>

        <TarjetaEstadistica
          titulo="Hora punta"
          Icono={Flame}
          detalle={punta.detalle}
        >
          <span className={clasesValor(punta.valor.tono)}>
            {punta.valor.texto}
          </span>
        </TarjetaEstadistica>
      </dl>

      <div className="mt-6 rounded-2xl border border-dashed border-zinc-300 p-5 dark:border-zinc-700">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <CalendarDays aria-hidden className="size-4" />
            Gráficos de ocupación
          </h3>
          <span className="rounded-full bg-zinc-100 px-2.5 py-1 text-xs font-medium text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400">
            Tanda 4
          </span>
        </div>
        <p className="mt-2 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
          Aquí irán el gráfico por hora del día y el mapa de calor día × hora. En esta
          tanda solo se muestran los agregados de texto.
        </p>
      </div>
    </section>
  );
}

