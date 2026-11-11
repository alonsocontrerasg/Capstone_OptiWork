import { NextResponse, type NextRequest } from "next/server";

import { peticionDelMismoOrigen } from "@/lib/http/origen";
import { crearClienteServidor } from "@/lib/supabase/server";

/**
 * `POST /auth/signout` — cierra la sesión y redirige con 303 a `/login`.
 *
 * Solo POST: un `GET /auth/signout` podría dispararse desde un `<img src>` de otro sitio y
 * desconectar al usuario (CSRF de logout). Además se exige mismo origen (S-28).
 */
export async function POST(request: NextRequest) {
  if (!peticionDelMismoOrigen(request)) {
    return NextResponse.json({ error: "origen_invalido" }, { status: 403 });
  }

  const supabase = await crearClienteServidor();
  const { error } = await supabase.auth.signOut();

  if (error) {
    // Aun si Auth falla, se sigue: el objetivo es que el navegador pierda la sesión.
    console.error("[auth] signOut devolvió error:", error.message);
  }

  // 303 fuerza GET en el destino (evita reenviar el POST al recargar).
  return NextResponse.redirect(new URL("/login", request.url), {
    status: 303,
    headers: { "Cache-Control": "no-store" },
  });
}
