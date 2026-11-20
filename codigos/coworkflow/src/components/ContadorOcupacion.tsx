"use client";

import {
  CircleCheck,
  CircleHelp,
  CircleX,
  CloudOff,
  LoaderCircle,
  Radio,
  TriangleAlert,
  Users,
  type LucideIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { BarraAforo } from "@/components/BarraAforo";
import { SemaforoOcupacion } from "@/components/SemaforoOcupacion";
import {
  esCantidadValida,
  formatearPorcentaje,
  fraseEstado,
  resumirOcupacion,
  type EstadoOcupacion,
} from "@/lib/dominio/ocupacion";
import { formatearFechaHoraLocal } from "@/lib/dominio/tiempo";
import { suscribirseOcupacionActual } from "@/lib/supabase/browser";

/**
 * Contador de ocupación con actualización en vivo (isla de cliente del dashboard).
 *
 * Propiedades: SOLO primitivos públicos (zona, cifra agregada, aforo y zona horaria). Ni
 * `user_id` ni filas de `sesiones` cruzan al navegador: el dashboard público es anónimo.
 *
 * - El server entrega la primera lectura (`cantidadInicial`); el cliente la refresca con un
 *   canal de Realtime sobre `ocupacion_actual`, filtrado por zona y limitado a INSERT/UPDATE.
 * - Cada evento se revalida en el cliente (`esCantidadValida`); un valor inválido se ignora
 *   y el contador conserva la última cifra buena.
 * - Sin polling: si el canal se cae, se avisa con el indicador de conexión y, al volver a
 *   `SUBSCRIBED`, se pide un `router.refresh()` para resincronizar con el RSC.
 * - «Reconectando…» es también el estado inicial: hasta el primer `SUBSCRIBED` no hay dato
 *   en vivo, así que no se anuncia «En vivo» antes de tiempo.
 * - Un único `aria-live="polite"` (sr-only) anuncia el resumen; el indicador de conexión NO
 *   es una región viva, para no interrumpir con cada reconexión.
 * - Sin atributos `style` inline (CSP de producción) y sin `dangerouslySetInnerHTML`.
 */

type Props = {
  zonaId: string;
  cantidadInicial: number | null;
  /** Instante ISO de la última lectura del servidor (o null si no hubo). */
  actualizadoInicial: string | null;
  aforoMax: number;
  umbralBajo: number;
  umbralAlto: number;
  timezone: string;
  /**
   * Línea de horario ya resuelta en el servidor («Abierto hasta las 18:00»). `null` si la
   * zona no declara un horario legible: la tarjeta omite la línea.
   */
  horarioTexto: string | null;
};

type Lectura = {
  cantidad: number | null;
  updatedAt: string | null;
};

type EstadoConexion = "reconectando" | "en_vivo" | "sin_conexion";

type Indicador = {
  texto: string;
  Icono: LucideIcon;
  clases: string;
  girar: boolean;
};

const INDICADORES: Record<EstadoConexion, Indicador> = {
  en_vivo: {
    texto: "En vivo",
    Icono: Radio,
    clases: "text-bajo-texto",
    girar: false,
  },
  reconectando: {
    texto: "Reconectando…",
    Icono: LoaderCircle,
    clases: "text-moderado-texto",
    girar: true,
  },
  sin_conexion: {
    texto: "Sin conexión en vivo: el valor puede estar desactualizado",
    Icono: CloudOff,
    clases: "text-lleno-texto",
    girar: false,
  },
};

type EstadoVisual = {
  Icono: LucideIcon;
  clases: string;
};

/**
 * Icono + color de texto de cada estado. El texto de la frase (`fraseEstado`) es la señal
 * principal: el color es un refuerzo, nunca la única diferencia (WCAG 1.4.1).
 */
const ESTADO_VISUAL: Record<EstadoOcupacion, EstadoVisual> = {
  bajo: { Icono: CircleCheck, clases: "text-bajo-texto" },
  moderado: { Icono: TriangleAlert, clases: "text-moderado-texto" },
  lleno: { Icono: CircleX, clases: "text-lleno-texto" },
  desconocido: { Icono: CircleHelp, clases: "text-tenue" },
};

export function ContadorOcupacion({
  zonaId,
  cantidadInicial,
  actualizadoInicial,
  aforoMax,
  umbralBajo,
  umbralAlto,
  timezone,
  horarioTexto,
}: Props) {
  const router = useRouter();
  const [lectura, setLectura] = useState<Lectura>(() => ({
    cantidad: esCantidadValida(cantidadInicial) ? cantidadInicial : null,
    updatedAt: actualizadoInicial,
  }));
  const [conexion, setConexion] = useState<EstadoConexion>("reconectando");
  const huboCorte = useRef(false);

  useEffect(() => {
    // El cleanup marca la suscripción como vencida: en React Strict Mode el efecto se monta
    // dos veces y los callbacks del primer canal no deben tocar el estado del segundo.
    let vigente = true;

    const detener = suscribirseOcupacionActual(
      zonaId,
      (cambio) => {
        if (!vigente || !esCantidadValida(cambio.cantidad)) return;
        setLectura((previa) => ({
          cantidad: cambio.cantidad,
          updatedAt: cambio.updatedAt ?? previa.updatedAt,
        }));
      },
      (estado) => {
        if (!vigente) return;

        if (estado === "SUBSCRIBED") {
          setConexion("en_vivo");
          if (huboCorte.current) {
            huboCorte.current = false;
            // Durante el corte se pudieron perder eventos: el RSC vuelve a ser la verdad.
            router.refresh();
          }
          return;
        }

        huboCorte.current = true;
        setConexion(estado === "CLOSED" ? "sin_conexion" : "reconectando");
      },
    );

    return () => {
      vigente = false;
      detener();
    };
  }, [zonaId, router]);

  const resumen = resumirOcupacion(lectura.cantidad, {
    aforo_max: aforoMax,
    umbral_bajo: umbralBajo,
    umbral_alto: umbralAlto,
  });
  const actualizado = formatearFechaHoraLocal(lectura.updatedAt, timezone);
  const indicador = INDICADORES[conexion];
  const { Icono } = indicador;
  const estadoVisual = ESTADO_VISUAL[resumen.estado];
  const IconoEstado = estadoVisual.Icono;

  const textoAccesible =
    lectura.cantidad === null
      ? "Sin lectura de ocupación disponible."
      : `${lectura.cantidad} ${
          lectura.cantidad === 1 ? "persona" : "personas"
        } dentro${
          resumen.porcentaje === null
            ? ""
            : `, ${formatearPorcentaje(resumen.porcentaje)}`
        }`;

  return (
    <section
      aria-labelledby="ocupacion-titulo"
      className="mt-6 rounded-3xl border border-borde bg-superficie p-6 shadow-sm sm:p-8"
    >
      <p className="sr-only" aria-live="polite">
        {textoAccesible}
      </p>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2
            id="ocupacion-titulo"
            className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-tenue"
          >
            <Users aria-hidden className="size-4 shrink-0" />
            Ahora en el cowork
          </h2>
          <p
            className={`mt-3 flex items-center gap-1.5 text-sm font-semibold ${estadoVisual.clases}`}
          >
            <IconoEstado aria-hidden className="size-4 shrink-0" />
            <span>{fraseEstado(resumen.estado)}</span>
          </p>
          <div className="mt-2 flex flex-wrap items-baseline gap-2">
            <p className="text-[clamp(2.25rem,12vw,4.5rem)] font-semibold leading-none tracking-tight tabular-nums">
              {lectura.cantidad === null ? "—" : resumen.cantidad}
            </p>
            <p className="text-lg text-tenue">de {aforoMax} personas</p>
          </div>
        </div>
        <SemaforoOcupacion estado={resumen.estado} />
      </div>

      <div className="mt-7">
        <div className="flex items-center justify-between gap-3 text-sm">
          <span className="font-medium">Aforo utilizado</span>
          <span className="font-semibold tabular-nums">
            {formatearPorcentaje(resumen.porcentaje)}
          </span>
        </div>
        <BarraAforo porcentaje={resumen.porcentaje} estado={resumen.estado} />
        <p className="mt-2 text-xs leading-5 text-tenue">
          Semáforo: bajo &lt; {umbralBajo}% · moderado {umbralBajo}–{umbralAlto}%
          · lleno &gt;{umbralAlto}% del aforo.
        </p>
      </div>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-borde pt-4 text-xs text-tenue">
        <span
          className={`flex items-center gap-1.5 font-medium ${indicador.clases}`}
        >
          <Icono
            aria-hidden
            className={`size-3.5 shrink-0 ${
              indicador.girar ? "animate-spin" : ""
            }`}
          />
          <span>{indicador.texto}</span>
        </span>
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {horarioTexto ? (
            <span className="font-medium text-tinta">{horarioTexto}</span>
          ) : null}
          <span>
            {lectura.cantidad === null
              ? "No pudimos leer la ocupación en este momento."
              : "Última lectura del servidor"}
          </span>
          {actualizado && lectura.updatedAt ? (
            <time dateTime={lectura.updatedAt}>
              Actualizado: {actualizado}
            </time>
          ) : null}
        </span>
      </div>
    </section>
  );
}

