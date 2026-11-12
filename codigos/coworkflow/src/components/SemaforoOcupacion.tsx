import {
  CircleCheck,
  CircleHelp,
  CircleX,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";

import {
  etiquetaEstado,
  type EstadoOcupacion,
} from "@/lib/dominio/ocupacion";

/**
 * Insignia del semáforo de ocupación.
 *
 * Es presentacional: recibe el estado ya calculado y no consulta datos. El color nunca es
 * la única señal (WCAG 1.4.1): cada estado lleva texto e icono propios. Sin atributos de
 * estilo inline, porque la CSP de producción solo permite hojas de estilo con nonce.
 */
type Props = {
  estado: EstadoOcupacion;
};

type ConfiguracionEstado = {
  Icono: LucideIcon;
  clases: string;
  descripcion: string;
};

const CONFIGURACION: Record<EstadoOcupacion, ConfiguracionEstado> = {
  bajo: {
    Icono: CircleCheck,
    clases:
      "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-100",
    descripcion: "Hay espacio disponible",
  },
  moderado: {
    Icono: TriangleAlert,
    clases:
      "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-100",
    descripcion: "La ocupación está cerca del límite",
  },
  lleno: {
    Icono: CircleX,
    clases:
      "border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950/50 dark:text-red-100",
    descripcion: "El aforo está completo",
  },
  desconocido: {
    Icono: CircleHelp,
    clases:
      "border-zinc-300 bg-zinc-50 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300",
    descripcion: "No hay una lectura disponible",
  },
};

export function SemaforoOcupacion({ estado }: Props) {
  const { Icono, clases, descripcion } = CONFIGURACION[estado];
  const etiqueta = etiquetaEstado(estado);

  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-semibold ${clases}`}
      aria-label={`Estado de ocupación: ${etiqueta}. ${descripcion}.`}
    >
      <Icono aria-hidden className="size-4 shrink-0" />
      <span>{etiqueta}</span>
      <span className="sr-only">. {descripcion}</span>
    </span>
  );
}
