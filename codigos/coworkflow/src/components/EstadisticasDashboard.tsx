import "server-only";

import type { ReactNode } from "react";
import {
  CalendarDays,
  Flame,
  Timer,
  Users,
  type LucideIcon,
} from "lucide-react";

import { GraficosDashboardCarga } from "@/components/GraficosDashboardCarga";
import { MapaCalorDashboard } from "@/components/MapaCalorDashboard";
import {
  construirPuntosHoy,
  construirPuntosPorHora,
  construirSeriePorHora,
  etiquetaHora,
  formatearPermanencia,
  formatearPersonas,
  horaPunta,
  horasDelHorario,
  type FilaFranja,
  type HorarioZona,
} from "@/lib/dominio/estadisticas";
import { limitesRangoDias } from "@/lib/dominio/tiempo";
import {
  obtenerFranjas,
  obtenerOcupacionHoy,
  obtenerPermanenciaPromedio,
  obtenerPersonasDistintas,
  type ResultadoRpc,
} from "@/lib/supabase/dashboard";
import type { RangoDias } from "@/lib/validacion/dashboard";


/**
 * Estadísticas del dashboard, renderizadas en el servidor.
 *
 * Las lecturas se lanzan en paralelo. Cada bloque conserva su propio estado: una RPC caída
 * muestra «No se pudo cargar» solo en su tarjeta, mientras el resto sigue visible.
 * `valor === null` (k-anonimato de la RPC) no es un error: se muestra «Sin datos suficientes».
 * Ese k-anonimato aplica a permanencia y personas distintas, que describen a individuos; la
 * hora punta, los gráficos y el mapa de calor son promedios de ocupación y no dependen de esa
 * regla.
 *
 * Solo viajan agregados: esta función no se importa desde ningún Client Component. Lo único
 * que cruza al navegador son puntos ya reducidos (`construirPuntosPorHora`) y la matriz del
 * mapa de calor, que se pinta como HTML en el servidor.
 *
 * Se piden tres juegos de franjas: las del rango elegido (tarjetas y gráfico por hora), las de
 * los últimos 30 días (mapa de calor, que necesita la muestra más amplia) y los snapshots de
 * hoy. Cuando `rango === 30` se reutiliza la misma promesa y no se duplica la consulta.
 */

/** El mapa de calor usa siempre 30 días: 7 daría muy pocas muestras por celda (día × hora). */
const DIAS_MAPA_CALOR: RangoDias = 30;

type Props = {
  zonaId: string;
  timezone: string;
  rango: RangoDias;
  /** Aforo máximo de la zona: base del color del mapa de calor. */
  aforoMax: number;
  /** Hora de apertura ya parseada (`null` si la zona no la declara). */
  horaApertura: number | null;
  /** Hora de cierre ya parseada; `24` es válido (medianoche). */
  horaCierre: number | null;
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
  aforoMax,
  horaApertura,
  horaCierre,
}: Props) {
  const limites = limitesRangoDias(new Date(), timezone, rango);
  if (!limites) {
    console.error(
      "[dashboard] no se pudieron calcular los límites del rango para la zona:",
      zonaId,
    );
  }

  const peticionFranjas = obtenerFranjas(zonaId, rango);
  const peticionFranjasMapa =
    rango === DIAS_MAPA_CALOR
      ? peticionFranjas
      : obtenerFranjas(zonaId, DIAS_MAPA_CALOR);

  const [franjas, franjasMapa, snapshotsHoy, permanencia, personas] =
    await Promise.all([
      peticionFranjas,
      peticionFranjasMapa,
      obtenerOcupacionHoy(zonaId),
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

  // Horario sólo si la zona lo declara de forma coherente; si no, `horasDelHorario` devuelve
  // el día completo y la matriz/curva siguen siendo válidas.
  const horario: HorarioZona | null =
    horaApertura !== null && horaCierre !== null && horaCierre > horaApertura
      ? { apertura: horaApertura, cierre: horaCierre }
      : null;

  const horas = horasDelHorario(horario);

  // `null` = la RPC falló (el bloque muestra su propio aviso) y `[]` = no hay datos.
  const puntosPorHora = franjas.ok
    ? construirPuntosPorHora(franjas.valor, horas)
    : null;
  const puntosHoy =
    snapshotsHoy === null
      ? null
      : construirPuntosHoy(snapshotsHoy, timezone, horas, horario);
  const filasMapaCalor = franjasMapa.ok ? franjasMapa.valor : null;


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
        {!franjas.ok ||
        !permanencia.ok ||
        !personas.ok ||
        snapshotsHoy === null ? (
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Algunas secciones no están disponibles en este momento.
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

      <div className="mt-6 space-y-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <CalendarDays aria-hidden className="size-4" />
          Ocupación por hora y por día
        </h3>

        <GraficosDashboardCarga
          porHora={puntosPorHora}
          hoy={puntosHoy}
          dias={rango}
        />

        <MapaCalorDashboard
          filas={filasMapaCalor}
          horas={horas}
          aforoMax={aforoMax}
          horario={horario}
        />
      </div>
    </section>
  );
}

