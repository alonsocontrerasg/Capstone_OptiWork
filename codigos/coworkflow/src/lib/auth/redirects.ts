/**
 * Destino de redirección seguro (módulo puro, testeable sin mocks).
 *
 * Amenaza: **open redirect**. `/auth/callback?next=https://sitio-malicioso` convertiría el
 * enlace mágico (que el usuario recibió por correo y por tanto confía) en un trampolín hacia
 * otro sitio, con la excusa de "volver a la app" (S-27).
 *
 * Regla: solo se aceptan rutas internas que empiecen con `/`, sin `//` (protocol-relative),
 * sin barra invertida (que algunos navegadores normalizan a `/`) y sin caracteres de control.
 * La regla se comprueba dos veces: sobre la entrada y sobre el **resultado** de `new URL()`,
 * porque el parser colapsa los segmentos `.`/`..` y una ruta aparentemente interna puede acabar
 * siendo `//otro-dominio`. Cualquier otra cosa cae al destino por defecto.
 */
export const DESTINO_POR_DEFECTO = "/";

const LARGO_MAXIMO = 512;
const CARACTERES_PROHIBIDOS = /[\\\u0000-\u001f\u007f]/;

/**
 * Casos para los tests de la Etapa 6 (`tests/unit/redirects.test.ts`).
 *
 * Caen a `DESTINO_POR_DEFECTO`:
 * - `/..//evil.com`
 * - `/.//evil.com`
 * - `/a/..//evil.com`
 * - `//evil.com`
 * - `/\evil.com`
 * - `https://evil.com`
 *
 * Pasan intactos:
 * - `/qr`
 * - `/scan?modo=entrada`
 * - `/dashboard#x`
 */
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

    const resultado = `${url.pathname}${url.search}${url.hash}`;

    // Se valida el RESULTADO, no solo la entrada: el parser colapsa los segmentos `.` y `..`,
    // así que `/..//evil.com`, `/.//evil.com` y `/a/..//evil.com` pasan los filtros de entrada
    // y conservan el origen, pero normalizan a `//evil.com`. Devolverlo tal cual sería un open
    // redirect: el navegador lo interpreta como URL protocol-relative y navega a otro dominio.
    if (resultado.startsWith("//") || resultado.includes("\\")) {
      return DESTINO_POR_DEFECTO;
    }

    return resultado;
  } catch {
    return DESTINO_POR_DEFECTO;
  }
}
