import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { SesionActual } from "@/lib/auth/session";
const estado = vi.hoisted(() => ({ sesion: null as SesionActual | null, permitido: true, rpc: vi.fn(), exportar: vi.fn() }));
vi.mock("server-only",()=>({}));
vi.mock("@/lib/auth/session",()=>({ obtenerSesionVerificada:async()=>estado.sesion }));
vi.mock("@/lib/rate-limit",()=>({ limitarPorIp:async()=>({permitido:estado.permitido}),limitarPorUsuario:async()=>({permitido:estado.permitido}) }));
vi.mock("@/lib/supabase/server",()=>({ crearClienteServidor:async()=>({rpc:estado.rpc}) }));
vi.mock("@/lib/admin/datos",()=>({ leerExportacion:estado.exportar, ExportacionDemasiadoGrande:class extends Error {} }));
import { POST } from "@/app/api/admin/configuracion/route";
import { GET } from "@/app/api/admin/exportar/route";
const admin: SesionActual = { usuario:{id:"test",email:null},perfil:{id:"test",rol:"admin",consentimiento_at:null,consentimiento_version:null} };
const datos = { zona_id:"11111111-1111-4111-8111-111111111111",nombre:"Cowork",aforo_max:100,umbral_bajo:40,umbral_alto:80,activa:true,horarios:[{dia_semana:1,apertura:"08:30",cierre:"18:00"}] };
function guardar(cuerpo: unknown=datos, origen="http://localhost") {
  return POST(new NextRequest("http://localhost/api/admin/configuracion",{method:"POST",headers:{origin:origen,"content-type":"application/json"},body:JSON.stringify(cuerpo)}));
}
beforeEach(()=>{estado.sesion=admin;estado.permitido=true;estado.rpc.mockReset().mockResolvedValue({error:null});estado.exportar.mockReset().mockResolvedValue([{ts:"2026-11-19T12:00:00Z",zona:"=SUM(A1)",usuario:"seudonimo",tipo:"entrada",resultado:"entrada_ok"}]);});
describe("administración HTTP",()=>{
  it("rechaza usuarios anónimos, sesiones revocadas y roles comunes antes de leer/escribir",async()=>{
    for(const sesion of [null,{...admin,perfil:{...admin.perfil!,rol:"usuario" as const}}]){
      estado.sesion=sesion;
      expect((await guardar()).status).toBe(sesion?403:401);
      expect((await GET(new NextRequest("http://localhost/api/admin/exportar"))).status).toBe(sesion?403:401);
    }
    expect(estado.rpc).not.toHaveBeenCalled();expect(estado.exportar).not.toHaveBeenCalled();
  });
  it("solo guarda una configuración válida y del mismo origen",async()=>{
    expect((await guardar(datos,"https://ajeno.invalid")).status).toBe(403);
    expect((await guardar({...datos,horarios:[]})).status).toBe(400);
    expect(estado.rpc).not.toHaveBeenCalled();
    expect((await guardar()).status).toBe(200);
    expect(estado.rpc).toHaveBeenCalledWith("actualizar_configuracion_zona",expect.objectContaining({p_horarios:datos.horarios,p_zona_id:datos.zona_id}));
  });
  it("límite y cuerpo excesivo no escriben",async()=>{
    estado.permitido=false;expect((await guardar()).status).toBe(429);
    estado.permitido=true;expect((await guardar({relleno:"x".repeat(9000)})).status).toBe(413);
    expect(estado.rpc).not.toHaveBeenCalled();
  });
  it("exporta sin caché ni UUID original y neutraliza fórmulas",async()=>{
    const respuesta=await GET(new NextRequest("http://localhost/api/admin/exportar?dias=7"));
    expect(respuesta.status).toBe(200);expect(respuesta.headers.get("cache-control")).toContain("no-store");
    expect(respuesta.headers.get("content-disposition")).toContain("attachment");
    expect(await respuesta.text()).toContain('"\'=SUM(A1)"');
  });
});
