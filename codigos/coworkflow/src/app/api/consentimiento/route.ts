import { NextResponse, type NextRequest } from "next/server";

import { obtenerSesion } from "@/lib/auth/session";
import { peticionDelMismoOrigen } from "@/lib/http/origen";
import { crearClienteServidor } from "@/lib/supabase/server";
import { esquemaCuerpoConsentimiento } from "@/lib/validacion/consentimiento";

const SIN_CACHE = { "Cache-Control": "no-store, max-age=0, must-revalidate" };

/**
 * `POST /api/consentimiento` con `{ version }`.
 *
 * Guarda la aceptación del aviso llamando a la RPC `registrar_consentimiento`. El cliente
 * NO puede escribir `profiles` (no hay política de UPDATE ni GRANT): el único camino es esta
 * función `SECURITY DEFINER`, que toma el `user_id` de `auth.uid()` (S-02, S-25).
 */
export async function POST(request: NextRequest) {
  if (!peticionDelMismoOrigen(request)) {
    return NextResponse.json({ error: "origen_invalido" }, { status: 403, headers: SIN_CACHE });
  }

  const sesion = await obtenerSesion();
  if (!sesion) {
    return NextResponse.json(
      { error: "no_autenticado" },
      { status: 401, headers: SIN_CACHE },
    );
  }

  let cuerpo: unknown;
  try {
    cuerpo = await request.json();
  } catch {
    return NextResponse.json(
      { error: "cuerpo_invalido" },
      { status: 400, headers: SIN_CACHE },
    );
  }

  // `version` debe coincidir con el texto que se mostró: aceptar otra versión registraría
  // un consentimiento que la persona no leyó.
  const validado = esquemaCuerpoConsentimiento.safeParse(cuerpo);
  if (!validado.success) {
    return NextResponse.json(
      { error: "version_no_vigente" },
      { status: 409, headers: SIN_CACHE },
    );
  }

  const supabase = await crearClienteServidor();
  const { data, error } = await supabase.rpc("registrar_consentimiento", {
    p_version: validado.data.version,
  });

  if (error) {
    console.error("[consentimiento] la RPC falló:", error.message);
    return NextResponse.json(
      { error: "no_se_pudo_registrar" },
      { status: 500, headers: SIN_CACHE },
    );
  }

  return NextResponse.json(
    { ok: true, consentimiento_at: data },
    { headers: SIN_CACHE },
  );
}
