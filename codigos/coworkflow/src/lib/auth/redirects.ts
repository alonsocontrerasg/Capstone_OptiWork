/**
 * Destino de redirección seguro (módulo puro, testeable sin mocks).
 *
 * Amenaza: **open redirect**. `/auth/callback?next=https://sitio-malicioso` convertiría el
 * enlace mágico (que el usuario recibió por correo y por tanto confía) en un trampolín hacia
 * otro sitio, con la excusa de "volver a la app" (S-27).
 *
 * Regla: solo se aceptan rutas internas que empiecen con `/`, sin `//` (protocol-relative),
 * sin barra invertida (que algunos navegadores normalizan a `/`) y sin caracteres de control.
 * Cualquier otra cosa cae al destino por defecto.
 */
export const DESTINO_POR_DEFECTO = "/";

const LARGO_MAXIMO = 512;
const CARACTERES_PROHIBIDOS = /[\\\u0000-\u001f\u007f]/;

export function normalizarDestinoInterno(
  valor: string | null | undefined,
): string {
  if (typeof valor !== "string") return DESTINO_POR_DEFECTO;

  const candidato = valor.trim();
  if (candidato.length === 0 || candidato.length > LARGO_MAXIMO) {
    return DESTINO_POR_DEFECTO;
  }

  if (!candidato.startsWith("/")) return DESTINO_POR_DEFECTO;
  if (candidato.startsWith("//")) return DESTINO_POR_DEFECTO;
  if (CARACTERES_PROHIBIDOS.test(candidato)) return DESTINO_POR_DEFECTO;

  try {
    // Base ficticia: si el resultado cambia de origen, era una URL absoluta disfrazada.
    const base = "https://app.invalid";
    const url = new URL(candidato, base);
    if (url.origin !== base) return DESTINO_POR_DEFECTO;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return DESTINO_POR_DEFECTO;
  }
}
