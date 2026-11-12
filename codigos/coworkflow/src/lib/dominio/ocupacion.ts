/**
 * Semáforo de ocupación y cálculo del porcentaje de aforo. Módulo PURO (sin React,
 * Supabase ni next/*) para poder probarlo con Vitest en la Etapa 6.
 *
 * Semántica aprobada (Etapa 5):
 * - porcentaje < umbral_bajo → "bajo"
 * - umbral_bajo ≤ porcentaje ≤ umbral_alto → "moderado"
 * - porcentaje > umbral_alto → "lleno"
 * - aforo, umbrales o cantidad inválidos → "desconocido" (nunca se inventa un estado).
 *
 * `cantidad` puede superar `aforo_max` (p. ej. si el aforo se reduce con gente dentro):
 * el estado sigue siendo "lleno" y el porcentaje se muestra sin recortar, pero la barra
 * se limita visualmente a 100 % (`porcentaje_barra`).
 */

export const ESTADOS_OCUPACION = [
  "bajo",
  "moderado",
  "lleno",
  "desconocido",
] as const;

export type EstadoOcupacion = (typeof ESTADOS_OCUPACION)[number];

export type ConfiguracionAforo = {
  aforo_max: number;
  umbral_bajo: number;
  umbral_alto: number;
};

export type ResumenOcupacion = {
  /** Cantidad válida (entero ≥ 0); 0 si el dato de entrada no era válido. */
  cantidad: number;
  /** Porcentaje real (puede superar 100); null si no se pudo calcular. */
  porcentaje: number | null;
  estado: EstadoOcupacion;
  /** Porcentaje para pintar la barra: siempre 0..100. */
  porcentaje_barra: number;
};

export function esCantidadValida(valor: unknown): valor is number {
  return (
    typeof valor === "number" &&
    Number.isFinite(valor) &&
    Number.isInteger(valor) &&
    valor >= 0
  );
}

export function esConfiguracionAforoValida(
  config: ConfiguracionAforo,
): boolean {
  return (
    Number.isFinite(config.aforo_max) &&
    Number.isInteger(config.aforo_max) &&
    config.aforo_max > 0 &&
    Number.isFinite(config.umbral_bajo) &&
    Number.isInteger(config.umbral_bajo) &&
    config.umbral_bajo >= 0 &&
    Number.isFinite(config.umbral_alto) &&
    Number.isInteger(config.umbral_alto) &&
    config.umbral_alto <= 100 &&
    config.umbral_bajo < config.umbral_alto
  );
}

export function calcularPorcentaje(
  cantidad: unknown,
  aforoMax: unknown,
): number | null {
  if (!esCantidadValida(cantidad)) return null;
  if (
    typeof aforoMax !== "number" ||
    !Number.isFinite(aforoMax) ||
    !Number.isInteger(aforoMax) ||
    aforoMax <= 0
  ) {
    return null;
  }

  return (cantidad / aforoMax) * 100;
}

export function calcularEstado(
  porcentaje: number | null,
  config: ConfiguracionAforo,
): EstadoOcupacion {
  if (
    porcentaje === null ||
    !Number.isFinite(porcentaje) ||
    porcentaje < 0
  ) {
    return "desconocido";
  }

  if (!esConfiguracionAforoValida(config)) return "desconocido";

  if (porcentaje < config.umbral_bajo) return "bajo";
  if (porcentaje <= config.umbral_alto) return "moderado";
  return "lleno";
}

export function resumirOcupacion(
  cantidad: unknown,
  config: ConfiguracionAforo,
): ResumenOcupacion {
  const cantidadOk = esCantidadValida(cantidad);
  const porcentaje = cantidadOk
    ? calcularPorcentaje(cantidad, config.aforo_max)
    : null;
  const estado = cantidadOk
    ? calcularEstado(porcentaje, config)
    : "desconocido";

  return {
    cantidad: cantidadOk ? cantidad : 0,
    porcentaje,
    estado,
    porcentaje_barra:
      porcentaje === null ? 0 : Math.min(100, Math.max(0, porcentaje)),
  };
}

const ETIQUETAS_ESTADO: Record<EstadoOcupacion, string> = {
  bajo: "Bajo",
  moderado: "Moderado",
  lleno: "Lleno",
  desconocido: "Sin datos",
};

export function etiquetaEstado(estado: EstadoOcupacion): string {
  return ETIQUETAS_ESTADO[estado];
}

export function formatearPorcentaje(porcentaje: number | null): string {
  if (
    porcentaje === null ||
    !Number.isFinite(porcentaje) ||
    porcentaje < 0
  ) {
    return "—";
  }

  return `${Math.round(porcentaje)}%`;
}
