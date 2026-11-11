import { NextResponse, type NextRequest } from "next/server";

import { requireAdmin } from "@/lib/auth/guards";
import { envPublico } from "@/lib/env";
import { envServidor } from "@/lib/env.server";
import { generarQrSvg } from "@/lib/qr/imagen";
import {
  crearTokenQr,
  segundosRestantesVentana,
  ventanaActual,
} from "@/lib/qr/token";
import { obtenerZonaPorSlug } from "@/lib/supabase/zonas";
import { esquemaParametrosQr } from "@/lib/validacion/qr";

const SIN_CACHE = { "Cache-Control": "no-store, max-age=0, must-revalidate" };

/**
 * `GET /api/qr/token?zona=<slug>&modo=<entrada|salida>` (solo admin).
 *
 * Firma un token de corta vida y devuelve el SVG ya renderizado. El secreto HMAC y la
 * construcción del token viven solo en el servidor: el navegador del admin recibe el
 * resultado, nunca la clave (S-07, S-26). La verificación de la firma, en cambio, ocurre en
 * Postgres dentro de `registrar_scan` (S-16).
 */
export async function GET(request: NextRequest) {
  // Sin sesión → redirect a /login; con sesión pero sin rol → forbidden() (403).
  await requireAdmin("/qr");

  const url = new URL(request.url);
  const parametros = esquemaParametrosQr.safeParse({
    zona: url.searchParams.get("zona") ?? "",
    modo: url.searchParams.get("modo") ?? "",
  });

  if (!parametros.success) {
    return NextResponse.json(
      { error: "parametros_invalidos" },
      { status: 400, headers: SIN_CACHE },
    );
  }

  const zona = await obtenerZonaPorSlug(parametros.data.zona);
  if (!zona) {
    return NextResponse.json(
      { error: "zona_inexistente" },
      { status: 404, headers: SIN_CACHE },
    );
  }
  if (!zona.activa) {
    return NextResponse.json(
      { error: "zona_inactiva" },
      { status: 409, headers: SIN_CACHE },
    );
  }

  const ahoraMs = Date.now();
  const ventana = ventanaActual(ahoraMs, envServidor.QR_WINDOW_SECONDS);
  const token = await crearTokenQr({
    zonaId: zona.id,
    modo: parametros.data.modo,
    ventana,
    secretoHex: envServidor.QR_TOKEN_SECRET,
  });

  // Lo que se codifica en el QR es la URL que abre la cámara nativa del celular.
  const destino = new URL("/scan", envPublico.NEXT_PUBLIC_SITE_URL);
  destino.searchParams.set("modo", parametros.data.modo);
  destino.searchParams.set("t", token);

  const svg = await generarQrSvg(destino.toString(), { anchoPx: 512 });

  return NextResponse.json(
    {
      token,
      svg,
      ventana,
      modo: parametros.data.modo,
      zona: { slug: zona.slug, nombre: zona.nombre },
      expiraEnSegundos: segundosRestantesVentana(
        ahoraMs,
        envServidor.QR_WINDOW_SECONDS,
      ),
      url: destino.toString(),
    },
    { headers: SIN_CACHE },
  );
}
