import { NextResponse, type NextRequest } from "next/server";

import { loginDesdeScan } from "@/lib/auth/redirects";
import { limitarPorIp, LIMITE_SCAN_POR_IP } from "@/lib/rate-limit";
import {
  COOKIE_SCAN_PENDIENTE,
  DURACION_SCAN_PENDIENTE,
  guardarScanPendiente,
} from "@/lib/scan/pendiente";
import { OPCIONES_COOKIE } from "@/lib/supabase/cookies";
import { esquemaTokenScan } from "@/lib/validacion/scan";

function volver(request: NextRequest, destino: string) {
  const respuesta = NextResponse.redirect(new URL(destino, request.url));
  respuesta.headers.set("Cache-Control", "no-store");
  respuesta.headers.set("Referrer-Policy", "strict-origin");
  return respuesta;
}

/** Guarda una prueba breve del QR para atravesar registro/consentimiento; no marca asistencia. */
export async function GET(request: NextRequest) {
  try {
    const limite = await limitarPorIp(request, {
      ...LIMITE_SCAN_POR_IP,
      prefijo: "scan:pendiente:ip",
    });
    if (!limite.permitido) return volver(request, "/scan?error=limite");
    const validado = esquemaTokenScan.safeParse(request.nextUrl.searchParams.get("t"));
    if (!validado.success) return volver(request, "/scan?error=vencido");
    const id = await guardarScanPendiente(validado.data);
    if (!id) return volver(request, "/scan?error=vencido");
    // El modo se extrae del QR que acaba de verificarse; nunca del query `modo`.
    const modo = validado.data.split(".")[2] as "entrada" | "salida";
    const respuesta = volver(request, loginDesdeScan(modo));
    respuesta.cookies.set(COOKIE_SCAN_PENDIENTE, id, {
      ...OPCIONES_COOKIE,
      maxAge: DURACION_SCAN_PENDIENTE,
    });
    return respuesta;
  } catch {
    // No registrar request, token, cookie ni errores de proveedor.
    console.error("scan: no se pudo conservar el escaneo");
    return volver(request, "/scan?error=servicio");
  }
}
