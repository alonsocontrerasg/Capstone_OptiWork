import { NextResponse, type NextRequest } from "next/server";
import { autorizarAdmin, errorAdmin, SIN_CACHE_ADMIN } from "@/lib/admin/http";
import { peticionDelMismoOrigen } from "@/lib/http/origen";
import { limitarPorIp } from "@/lib/rate-limit";
import { crearClienteServidor } from "@/lib/supabase/server";
import { esquemaConfiguracionAdmin } from "@/lib/validacion/admin";

export async function POST(request: NextRequest) {
  if (!peticionDelMismoOrigen(request)) return errorAdmin("origen_invalido", 403);
  if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") {
    return errorAdmin("tipo_contenido_invalido", 415);
  }
  try {
    const limite = await limitarPorIp(request, { prefijo: "admin:ip", limite: 60, ventanaSegundos: 60 });
    if (!limite.permitido) return errorAdmin("demasiados_intentos", 429);
    if (Number(request.headers.get("content-length")) > 8192) return errorAdmin("cuerpo_grande", 413);
    const acceso = await autorizarAdmin("configuracion", 10);
    if (acceso) return acceso;
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength > 8192) return errorAdmin("cuerpo_grande", 413);
    let cuerpo: unknown;
    try { cuerpo = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { return errorAdmin("datos_invalidos", 400); }
    const valido = esquemaConfiguracionAdmin.safeParse(cuerpo);
    if (!valido.success) return errorAdmin("datos_invalidos", 400);
    const c = valido.data;
    const cliente = await crearClienteServidor();
    const { error } = await cliente.rpc("actualizar_configuracion_zona", {
      p_zona_id: c.zona_id, p_nombre: c.nombre, p_aforo_max: c.aforo_max,
      p_umbral_bajo: c.umbral_bajo, p_umbral_alto: c.umbral_alto,
      p_activa: c.activa, p_horarios: c.horarios,
    });
    if (error) return errorAdmin("no_se_pudo_guardar", error.code === "42501" ? 403 : 500);
    return NextResponse.json({ ok: true }, { headers: SIN_CACHE_ADMIN });
  } catch {
    console.error("admin: configuración no disponible");
    return errorAdmin("servicio_no_disponible", 503);
  }
}
