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
    clases: "border-bajo bg-bajo-fondo text-bajo-texto",
    descripcion: "Hay espacio disponible",
  },
  moderado: {
    Icono: TriangleAlert,
    clases: "border-moderado bg-moderado-fondo text-moderado-texto",
    descripcion: "La ocupación está cerca del límite",
  },
  lleno: {
    Icono: CircleX,
    clases: "border-lleno bg-lleno-fondo text-lleno-texto",
    descripcion: "El aforo está completo",
  },
  desconocido: {
    Icono: CircleHelp,
    clases: "border-borde bg-fondo text-tenue",
    descripcion: "No hay una lectura disponible",
  },
};

export function SemaforoOcupacion({ estado }: Props) {
  const { Icono, clases, descripcion } = CONFIGURACION[estado];
  const etiqueta = etiquetaEstado(estado);

  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-semibold ${clases}`}
    >
      <Icono aria-hidden className="size-4 shrink-0" />
      <span className="sr-only">Estado de ocupación: </span>
      <span>{etiqueta}</span>
      <span className="sr-only">. {descripcion}</span>
    </span>
  );
}
