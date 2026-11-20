import { expect, it, vi } from "vitest";
const navegador=vi.hoisted(()=>new Map<string,string>());
vi.mock("server-only",()=>({}));
vi.mock("@/lib/env.server",()=>({credencialesUpstash:()=>null,envServidor:{QR_TOKEN_SECRET:"ab".repeat(32),QR_WINDOW_SECONDS:45}}));
vi.mock("next/headers",()=>({cookies:async()=>({get:(nombre:string)=>({value:navegador.get(nombre)})})}));
import { crearTokenQr, ventanaActual } from "@/lib/qr/token";

it("conserva la continuación al recargar el módulo entre Route Handler y página en desarrollo",async()=>{
  const ruta=await import("@/lib/scan/pendiente");
  const token=await crearTokenQr({zonaId:"11111111-1111-4111-8111-111111111111",modo:"entrada",ventana:ventanaActual(Date.now(),45),secretoHex:"ab".repeat(32)});
  const id=await ruta.guardarScanPendiente(token);expect(id).toBeTruthy();
  navegador.set(ruta.COOKIE_SCAN_PENDIENTE,id!);
  vi.resetModules();
  const pagina=await import("@/lib/scan/pendiente");
  expect(await pagina.obtenerScanPendiente()).toMatchObject({modo:"entrada"});
  expect(await pagina.consumirScanPendiente()).not.toBeNull();
  expect(await ruta.consumirScanPendiente()).toBeNull();
});
