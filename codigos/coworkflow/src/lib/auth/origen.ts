/** El origen procede de configuración del servidor, nunca de Host, Origin ni del cliente. */
export function resolverOrigenAplicacion(siteUrl: string, entorno?: string, dominioPreview?: string): string {
  if (entorno !== "preview" || !dominioPreview) return new URL(siteUrl).origin;
  const preview = new URL(`https://${dominioPreview}`);
  if (!preview.hostname.endsWith(".vercel.app") || preview.username || preview.password ||
      preview.port || preview.pathname !== "/" || preview.search || preview.hash) {
    throw new Error("Dominio de preview inválido");
  }
  return preview.origin;
}
