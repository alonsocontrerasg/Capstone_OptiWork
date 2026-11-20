import type { NextRequest } from "next/server";
import { autorizarAdmin, errorAdmin, SIN_CACHE_ADMIN } from "@/lib/admin/http";
import { ExportacionDemasiadoGrande, leerExportacion } from "@/lib/admin/datos";
import { generarCsv } from "@/lib/dominio/csv";
import { esquemaFiltrosHistorial } from "@/lib/validacion/admin";

export async function GET(request: NextRequest) {
  try {
    const acceso = await autorizarAdmin("exportar", 3);
    if (acceso) return acceso;
    const filtros = esquemaFiltrosHistorial.safeParse(Object.fromEntries(request.nextUrl.searchParams));
    if (!filtros.success) return errorAdmin("filtros_invalidos", 400);
    const filas = await leerExportacion(filtros.data);
    const csv = generarCsv([
      ["fecha_utc", "zona", "usuario_seudonimo", "tipo", "resultado"],
      ...filas.map((f) => [f.ts, f.zona, f.usuario, f.tipo, f.resultado]),
    ]);
    return new Response(csv, { headers: {
      ...SIN_CACHE_ADMIN, "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="historial-optiwork.csv"',
      "X-Content-Type-Options": "nosniff",
    } });
  } catch (error) {
    if (error instanceof ExportacionDemasiadoGrande) return errorAdmin("reduce_el_periodo_o_filtra_una_zona", 413);
    console.error("admin: exportación no disponible");
    return errorAdmin("servicio_no_disponible", 503);
  }
}
