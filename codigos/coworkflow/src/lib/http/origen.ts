/**
 * Comprobación de origen para mutaciones (POST) hechas con `fetch` desde la propia app.
 *
 * Los Route Handlers **no** tienen la protección CSRF que Next aplica a las Server Actions,
 * así que cada POST que cambia estado debe confirmar que la petición nace en nuestro origen
 * (S-28). Se usa `Origin` y, como respaldo, `Sec-Fetch-Site` (lo mandan los navegadores
 * actuales incluso en formularios cross-site).
 */
export function peticionDelMismoOrigen(request: Request): boolean {
  const origen = request.headers.get("origin");

  if (origen) {
    try {
      return new URL(origen).origin === new URL(request.url).origin;
    } catch {
      return false;
    }
  }

  const sitio = request.headers.get("sec-fetch-site");
  return sitio === "same-origin" || sitio === "none";
}
