import type { EstadoOcupacion } from "@/lib/dominio/ocupacion";

/**
 * Barra segmentada del porcentaje de aforo.
 *
 * Es presentacional: recibe el porcentaje y el estado ya calculados y no consulta datos.
 * Vive en su propio archivo porque la isla de Realtime (`ContadorOcupacion`, Client
 * Component) también la pinta; por eso este módulo no importa nada de `server-only` ni
 * `next/*`.
 *
 * Sin atributos `style` ni `<style>` inline: la CSP de producción solo permite hojas de
 * estilo con nonce, así que el avance se representa intercambiando clases de color por
 * segmento (20 segmentos = 5 % cada uno).
 */

const SEGMENTOS_AFORO = 20;

const COLOR_SEGMENTO: Record<EstadoOcupacion, string> = {
  bajo: "bg-emerald-500",
  moderado: "bg-amber-500",
  lleno: "bg-red-500",
  desconocido: "bg-zinc-400",
};

type Props = {
  porcentaje: number | null;
  estado: EstadoOcupacion;
};

export function BarraAforo({ porcentaje, estado }: Props) {
  const valor =
    porcentaje === null
      ? 0
      : Math.min(100, Math.max(0, Math.round(porcentaje)));
  const llenos =
    porcentaje === null
      ? 0
      : Math.ceil((valor / 100) * SEGMENTOS_AFORO);

  return (
    <div
      role="progressbar"
      aria-label="Aforo utilizado"
      aria-valuemin={0}
      aria-valuemax={100}
      // Sin lectura (`porcentaje === null`) la barra es indeterminada: se omite
      // `aria-valuenow` en vez de anunciar un 0% que no hemos medido.
      aria-valuenow={porcentaje === null ? undefined : valor}
      aria-valuetext={porcentaje === null ? "Sin datos" : `${valor}% del aforo`}
      className="mt-2 flex gap-1"
    >
      {Array.from({ length: SEGMENTOS_AFORO }, (_, indice) => (
        <span
          key={indice}
          aria-hidden="true"
          className={`h-2.5 flex-1 rounded-full ${
            indice < llenos
              ? COLOR_SEGMENTO[estado]
              : "bg-zinc-200 dark:bg-zinc-800"
          }`}
        />
      ))}
    </div>
  );
}
