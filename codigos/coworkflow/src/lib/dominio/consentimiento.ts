/**
 * Módulo de dominio puro: sin imports de `next/*`, de Supabase ni de React, para que
 * Vitest lo pruebe sin mocks y para que el servidor y el cliente compartan el criterio.
 */

/** Versión vigente del aviso de privacidad (Ley 21.719). */
export const CONSENTIMIENTO_VERSION = 1;

/** Fecha de publicación de esta versión (se muestra en el aviso). */
export const CONSENTIMIENTO_FECHA = "2026-11-10";

export type PerfilConsentimiento = {
  consentimiento_at: string | null;
  consentimiento_version: number | null;
};

export type SeccionAviso = {
  titulo: string;
  texto: string;
};

/**
 * Texto del aviso. Se redacta en el dominio (no en el componente) para que el mismo texto
 * se pueda versionar, testear y citar en el informe.
 */
export const SECCIONES_AVISO: readonly SeccionAviso[] = [
  {
    titulo: "Qué datos se registran",
    texto:
      "Al escanear el QR guardamos la hora de entrada y de salida, la zona del cowork y tu identificador de usuario. No guardamos tu nombre, tu foto, tu RUT, tu dirección IP ni tu ubicación.",
  },
  {
    titulo: "Para qué se usan",
    texto:
      "Solo para calcular cuántas personas hay en el cowork (ocupación en tiempo real) y estadísticas agregadas de uso: hora punta, permanencia promedio y mapa de calor por día y hora.",
  },
  {
    titulo: "Quién puede verlos",
    texto:
      "El dashboard público muestra únicamente cifras agregadas. Tus sesiones solo las puedes ver tú y, para fines de administración del espacio, el equipo administrador del Hub. Las estadísticas se publican solo cuando agrupan al menos 5 personas distintas.",
  },
  {
    titulo: "Cuánto tiempo se conservan",
    texto:
      "Los registros individuales se eliminan a los 90 días. Después de eso quedan solo los totales diarios, que no permiten identificar a nadie.",
  },
  {
    titulo: "Tus derechos",
    texto:
      "Puedes pedir acceso, rectificación, eliminación u oposición al tratamiento escribiendo al equipo del Hub. Si retiras tu consentimiento, no podrás seguir marcando entrada y salida, pero tus datos anteriores se conservan hasta su plazo legal de retención.",
  },
];

/**
 * ¿La persona ya aceptó el aviso?
 *
 * El criterio es el mismo que aplica la RPC `registrar_scan` en Postgres
 * (`consentimiento_at is not null`), para que la interfaz y la base nunca se contradigan
 * (una UI que deja escanear y un servidor que rechaza sería peor que cualquiera de los dos).
 *
 * Si en el futuro cambia el texto, hay que subir `CONSENTIMIENTO_VERSION` **y** agregar
 * la condición de versión en la RPC; hasta entonces, "tener consentimiento" sigue siendo
 * "tener una fecha de aceptación".
 */
export function tieneConsentimiento(
  perfil: PerfilConsentimiento | null | undefined,
): boolean {
  return Boolean(perfil?.consentimiento_at);
}

/** Necesita ver el aviso y aceptarlo antes de usar el sistema. */
export function requiereAvisoConsentimiento(
  perfil: PerfilConsentimiento | null | undefined,
): boolean {
  return !tieneConsentimiento(perfil);
}

/** La versión aceptada está desactualizada respecto del texto publicado. */
export function consentimientoDesactualizado(
  perfil: PerfilConsentimiento | null | undefined,
): boolean {
  if (!tieneConsentimiento(perfil)) return false;
  return perfil?.consentimiento_version !== CONSENTIMIENTO_VERSION;
}
