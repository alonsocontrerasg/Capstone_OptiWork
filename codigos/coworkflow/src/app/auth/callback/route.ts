import { NextResponse, type NextRequest } from "next/server";

import { normalizarDestinoInterno } from "@/lib/auth/redirects";
import { crearClienteServidor } from "@/lib/supabase/server";

/**
 * `GET /auth/callback?code=...&next=...`
 *
 * Canjea el `code` del enlace mágico / confirmación de correo por una sesión y la guarda en
 * cookies httpOnly vía `@supabase/ssr` (S-09).
 *
 * `next` se sanea SIEMPRE con `normalizarDestinoInterno`: sin ese control, un enlace
 * `/auth/callback?next=https://sitio-malicioso` convertiría un correo legítimo del proyecto
 * en un redirector abierto (S-27).
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const destino = normalizarDestinoInterno(url.searchParams.get("next"));
  const codigo = url.searchParams.get("code");
  const errorProveedor = url.searchParams.get("error");

  const volverALogin = (motivo: "acceso" | "codigo" | "enlace") => {
    const destinoError = new URL("/login", url.origin);
    destinoError.searchParams.set("error", motivo);
    if (destino !== "/") destinoError.searchParams.set("next", destino);
    return NextResponse.redirect(destinoError, {
      headers: { "Cache-Control": "no-store" },
    });
  };

  // Supabase agrega ?error=access_denied cuando el enlace venció o ya se usó.
  if (errorProveedor) return volverALogin("acceso");
  if (!codigo) return volverALogin("codigo");

  const supabase = await crearClienteServidor();
  const { error } = await supabase.auth.exchangeCodeForSession(codigo);
  if (error) return volverALogin("enlace");

  return NextResponse.redirect(new URL(destino, url.origin), {
    headers: { "Cache-Control": "no-store" },
  });
}
