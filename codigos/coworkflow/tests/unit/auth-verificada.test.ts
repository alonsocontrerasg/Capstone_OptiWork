import { beforeEach, expect, it, vi } from "vitest";
const estado=vi.hoisted(()=>({ getUser:vi.fn(),rpc:vi.fn(),perfil:vi.fn() }));
vi.mock("server-only",()=>({}));
vi.mock("@/lib/supabase/server",()=>({crearClienteServidor:async()=>({
  auth:{getUser:estado.getUser},rpc:estado.rpc,
  from:()=>({select:()=>({eq:()=>({maybeSingle:estado.perfil})})}),
})}));
import { obtenerSesionVerificada } from "@/lib/auth/session";
beforeEach(()=>{
  estado.getUser.mockReset().mockResolvedValue({data:{user:{id:"usuario",email:"test@example.invalid"}},error:null});
  estado.rpc.mockReset().mockResolvedValue({data:true,error:null});
  estado.perfil.mockReset().mockResolvedValue({data:{id:"usuario",rol:"admin"},error:null});
});
it("un getUser válido no basta si auth.sessions fue revocada",async()=>{
  estado.rpc.mockResolvedValue({data:false,error:null});expect(await obtenerSesionVerificada()).toBeNull();
  expect(estado.perfil).not.toHaveBeenCalled();
});
it("la falta de migración o una caída de la comprobación falla cerrada",async()=>{
  estado.rpc.mockResolvedValue({data:null,error:{code:"42883"}});expect(await obtenerSesionVerificada()).toBeNull();
});
it("consulta identidad, sesión y rol actual antes de devolver permisos",async()=>{
  expect((await obtenerSesionVerificada())?.perfil?.rol).toBe("admin");
  expect(estado.rpc).toHaveBeenCalledWith("sesion_vigente");
  estado.perfil.mockResolvedValue({data:{id:"usuario",rol:"usuario"},error:null});
  expect((await obtenerSesionVerificada())?.perfil?.rol).toBe("usuario");
});
