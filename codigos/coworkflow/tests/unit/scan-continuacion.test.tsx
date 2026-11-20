import { isValidElement, type ReactNode } from "react";
import { NextRequest } from "next/server";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { SesionActual } from "@/lib/auth/session";

const estado = vi.hoisted(() => ({
  cookies: new Map<string, string>(),
  registros: new Map<string, { valor: unknown; vence: number }>(),
  sesion: null as SesionActual | null,
  redisCaido: false,
  permitido: true,
  rpc: vi.fn(),
  getdel: vi.fn(),
  signUp: vi.fn(), signInWithOtp: vi.fn(), signInWithPassword: vi.fn(), exchangeCodeForSession: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/env.server", () => ({
  envServidor: { QR_TOKEN_SECRET: "a1".repeat(32), QR_WINDOW_SECONDS: 45 },
  credencialesUpstash: () => ({ url: "https://redis.invalid", token: "solo-test" }),
}));
vi.mock("@/lib/env", () => ({ envPublico: { NEXT_PUBLIC_SITE_URL: "http://localhost" } }));
vi.mock("next/headers", () => ({ cookies: async () => ({
  get: (nombre: string) => estado.cookies.has(nombre) ? { value: estado.cookies.get(nombre) } : undefined,
  set: (nombre: string, valor: string) => estado.cookies.set(nombre, valor),
}) }));
vi.mock("next/navigation", () => ({ redirect: (ruta: string) => { throw new Error(`REDIRECT:${ruta}`); } }));
vi.mock("@/lib/auth/session", () => ({ obtenerSesion: async () => estado.sesion }));
vi.mock("@/lib/supabase/zonas", () => ({ obtenerZonaPorId: async () => null }));
vi.mock("@/lib/supabase/server", () => ({ crearClienteServidor: async () => ({
  rpc: estado.rpc,
  auth: { signUp: estado.signUp, signInWithOtp: estado.signInWithOtp,
    signInWithPassword: estado.signInWithPassword, exchangeCodeForSession: estado.exchangeCodeForSession },
}) }));
vi.mock("@/lib/rate-limit", () => ({
  LIMITE_SCAN_POR_IP: { limite: 60, ventanaSegundos: 60, prefijo: "scan:ip" },
  LIMITE_SCAN_POR_USUARIO: { limite: 10, ventanaSegundos: 60, prefijo: "scan:usuario" },
  limitarPorIp: async () => ({ permitido: estado.permitido }),
  limitarPorUsuario: async () => ({ permitido: estado.permitido }),
}));
vi.mock("@upstash/redis", () => {
  function leer(clave: string) {
    if (estado.redisCaido) throw new Error("redis no disponible");
    const dato = estado.registros.get(clave);
    return dato && dato.vence > Date.now() ? dato.valor : null;
  }
  return { Redis: class {
    async set(clave: string, valor: unknown, opciones: { ex: number }) {
      if (estado.redisCaido) throw new Error("redis no disponible");
      estado.registros.set(clave, { valor, vence: Date.now() + opciones.ex * 1000 });
      return "OK";
    }
    async get(clave: string) { return leer(clave); }
    async getdel(clave: string) {
      estado.getdel(clave);
      const valor = leer(clave);
      estado.registros.delete(clave);
      return valor;
    }
  } };
});

import { GET } from "@/app/auth/scan/route";
import { GET as callback } from "@/app/auth/callback/route";
import { ejecutarAccionAuth } from "@/lib/auth/acciones";
import { POST } from "@/app/api/scan/route";
import PaginaScan from "@/app/scan/page";
import PaginaLogin from "@/app/login/page";
import Home from "@/app/page";
import { FormularioLogin } from "@/components/auth/FormularioLogin";
import { ConfirmacionScan } from "@/components/scan/ConfirmacionScan";
import { crearTokenQr, ventanaActual } from "@/lib/qr/token";
import { verificarQrVigente } from "@/lib/qr/verificar";
import { COOKIE_SCAN_PENDIENTE, obtenerScanPendiente } from "@/lib/scan/pendiente";

const zonaId = "11111111-1111-4111-8111-111111111111";
const secreto = "a1".repeat(32);
const sesion: SesionActual = {
  usuario: { id: "usuario-1", email: "test@example.invalid" },
  perfil: { id: "usuario-1", rol: "usuario", consentimiento_at: "2026-11-19T10:00:00Z", consentimiento_version: 1 },
};
function propsDe(nodo: ReactNode, tipo: unknown): Record<string, unknown> | null {
  if (Array.isArray(nodo)) {
    for (const hijo of nodo) { const encontrado = propsDe(hijo, tipo); if (encontrado) return encontrado; }
  }
  if (!isValidElement<{ children?: ReactNode }>(nodo)) return null;
  if (nodo.type === tipo) return nodo.props;
  return propsDe(nodo.props.children, tipo);
}
async function token(modo: "entrada" | "salida" = "entrada", desfase = 0) {
  return crearTokenQr({ zonaId, modo, ventana: ventanaActual(Date.now(), 45) + desfase, secretoHex: secreto });
}
async function preparar(modo: "entrada" | "salida" = "entrada") {
  const respuesta = await GET(new NextRequest(`http://localhost/auth/scan?t=${await token(modo)}`));
  const cookie = respuesta.cookies.get(COOKIE_SCAN_PENDIENTE);
  expect(cookie?.value).toMatch(/^[0-9a-f]{64}$/);
  estado.cookies.set(COOKIE_SCAN_PENDIENTE, cookie!.value);
  return respuesta;
}
function confirmar(t = "pendiente", origin = "http://localhost") {
  return POST(new NextRequest("http://localhost/api/scan", {
    method: "POST", headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ t }),
  }));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.UTC(2026, 10, 19, 15));
  estado.cookies.clear(); estado.registros.clear(); estado.sesion = null;
  estado.redisCaido = false; estado.permitido = true;
  estado.rpc.mockReset().mockResolvedValue({ data: "entrada_ok", error: null });
  estado.getdel.mockClear();
  estado.signUp.mockReset().mockResolvedValue({ data: { session: null }, error: null });
  estado.signInWithOtp.mockReset().mockResolvedValue({ error: null });
  estado.signInWithPassword.mockReset().mockResolvedValue({ error: null });
  estado.exchangeCodeForSession.mockReset().mockResolvedValue({ error: null });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("continuar el QR durante el alta", () => {
  it("el correo de registro y su callback vuelven a /scan sin incluir el QR", async () => {
    await preparar();
    const login = await PaginaLogin({ searchParams: Promise.resolve({}) });
    const destino = propsDe(login, FormularioLogin)!.destino as string;
    await ejecutarAccionAuth({ accion: "registro", email: "test@example.invalid", password: "una-clave-de-prueba" }, destino);
    const regreso = new URL(estado.signUp.mock.calls[0][0].options.emailRedirectTo);
    expect(regreso.pathname).toBe("/auth/callback");
    expect([...regreso.searchParams]).toEqual([["next", "/scan"]]);
    regreso.searchParams.set("code", "codigo-de-prueba");
    const respuesta = await callback(new NextRequest(regreso));
    expect(respuesta.headers.get("location")).toBe("http://localhost/scan");
    expect(await obtenerScanPendiente()).toMatchObject({ zonaId, modo: "entrada" });
    expect(estado.rpc).not.toHaveBeenCalled();
  });

  it("registro sin confirmación e ingreso con contraseña conservan el destino", async () => {
    await preparar();
    estado.signUp.mockResolvedValue({ data: { session: {} }, error: null });
    for (const accion of ["registro", "contrasena"] as const) {
      expect(await ejecutarAccionAuth({ accion, email: "test@example.invalid", password: "una-clave-de-prueba" }, "/scan"))
        .toEqual({ tipo: "ok", redirigir: "/scan" });
    }
    await ejecutarAccionAuth({ accion: "enlace", email: "test@example.invalid" }, "/scan");
    expect(new URL(estado.signInWithOtp.mock.calls[0][0].options.emailRedirectTo).searchParams.get("next"))
      .toBe("/scan");
  });

  it.each(["entrada", "salida"] as const)("reanuda %s tras login/registro y consentimiento sin otro QR", async (modo) => {
    const qr = await token(modo);
    await expect(PaginaScan({ searchParams: Promise.resolve({ t: qr }) }))
      .rejects.toThrow(`REDIRECT:/auth/scan?t=${encodeURIComponent(qr)}`);
    const respuesta = await preparar(modo);
    expect(respuesta.headers.get("location")).toBe(`http://localhost/login?desde=scan&modo=${modo}`);
    expect(respuesta.headers.get("location")).not.toContain(qr);
    expect(respuesta.cookies.get(COOKIE_SCAN_PENDIENTE)).toMatchObject({ httpOnly: true, sameSite: "lax", maxAge: 600 });
    const login = await PaginaLogin({ searchParams: Promise.resolve({ desde: "scan", modo }) });
    expect(propsDe(login, FormularioLogin)?.destino).toBe("/scan");
    // Simula el alta o el callback por correo en el mismo navegador, luego el consentimiento.
    estado.sesion = { ...sesion, perfil: { ...sesion.perfil!, consentimiento_at: null } };
    await expect(PaginaScan({ searchParams: Promise.resolve({}) }))
      .rejects.toThrow(`REDIRECT:/?desde=scan&modo=${modo}`);
    const home = await Home({ searchParams: Promise.resolve({ desde: "scan", modo }) });
    expect(home).toBeTruthy();
    expect(estado.rpc).not.toHaveBeenCalled();
    estado.sesion = sesion;
    await expect(Home({ searchParams: Promise.resolve({ desde: "scan", modo }) })).rejects.toThrow("REDIRECT:/scan");
    vi.setSystemTime(Date.now() + 3 * 60 * 1000); // El QR original ya venció.
    expect(verificarQrVigente(qr, secreto, 45)).toBeNull();
    const confirmacion = await PaginaScan({ searchParams: Promise.resolve({}) });
    expect(propsDe(confirmacion, ConfirmacionScan)).toMatchObject({ token: "pendiente", modo });
    expect(estado.rpc).not.toHaveBeenCalled();
    expect((await confirmar()).status).toBe(200);
    const enviado = estado.rpc.mock.calls[0][1].p_token;
    expect(verificarQrVigente(enviado, secreto, 45)).toMatchObject({ zonaId, modo });
    expect(estado.cookies.get(COOKIE_SCAN_PENDIENTE)).toBe("");
  });

  it("no consume antes de iniciar sesión ni antes del consentimiento", async () => {
    await preparar();
    expect((await (await confirmar()).json()).resultado).toBe("no_autenticado");
    estado.sesion = { ...sesion, perfil: { ...sesion.perfil!, consentimiento_at: null } };
    expect((await (await confirmar()).json()).resultado).toBe("sin_consentimiento");
    expect(estado.getdel).not.toHaveBeenCalled();
    expect(await obtenerScanPendiente()).not.toBeNull();
    expect(estado.rpc).not.toHaveBeenCalled();
  });

  it("dos confirmaciones simultáneas canjean una sola continuación", async () => {
    await preparar(); estado.sesion = sesion;
    const original = estado.cookies.get(COOKIE_SCAN_PENDIENTE)!;
    const respuestas = await Promise.all([confirmar(), confirmar()]);
    expect(respuestas.map((r) => r.status).sort()).toEqual([200, 403]);
    expect(estado.getdel).toHaveBeenCalledTimes(2);
    expect(estado.rpc).toHaveBeenCalledTimes(1);
    estado.cookies.set(COOKIE_SCAN_PENDIENTE, original); // Replay con una copia de la cookie.
    expect((await confirmar()).status).toBe(403);
    expect(estado.rpc).toHaveBeenCalledTimes(1);
  });

  it("las lecturas no renuevan el plazo de diez minutos", async () => {
    await preparar(); estado.sesion = sesion;
    vi.setSystemTime(Date.now() + 9 * 60 * 1000);
    expect(await obtenerScanPendiente()).not.toBeNull();
    vi.setSystemTime(Date.now() + 60 * 1000);
    expect(await obtenerScanPendiente()).toBeNull();
    expect((await confirmar()).status).toBe(403);
    expect(estado.rpc).not.toHaveBeenCalled();
  });

  it("rechaza cookies inventadas y marcadores sin cookie", async () => {
    estado.sesion = sesion;
    for (const cookie of ["", "x", "a".repeat(64)]) {
      estado.cookies.set(COOKIE_SCAN_PENDIENTE, cookie);
      expect((await confirmar()).status).toBe(403);
    }
    expect(estado.rpc).not.toHaveBeenCalled();
  });

  it("no conserva un QR vencido o manipulado", async () => {
    const qr = await token();
    for (const invalido of [await token("entrada", -2), qr.replace("entrada", "salida"), "pendiente"]) {
      const respuesta = await GET(new NextRequest(`http://localhost/auth/scan?t=${invalido}`));
      expect(respuesta.headers.get("location")).toBe("http://localhost/scan?error=vencido");
      expect(respuesta.cookies.has(COOKIE_SCAN_PENDIENTE)).toBe(false);
    }
    expect(estado.registros.size).toBe(0);
  });

  it("rate limit y origen inválido no consumen el escaneo", async () => {
    await preparar(); estado.sesion = sesion;
    expect((await confirmar("pendiente", "https://otro.invalid")).status).toBe(403);
    estado.permitido = false;
    expect((await confirmar()).status).toBe(429);
    const inicio = await GET(new NextRequest(`http://localhost/auth/scan?t=${await token()}`));
    expect(inicio.headers.get("location")).toContain("error=limite");
    expect(estado.getdel).not.toHaveBeenCalled();
  });

  it("Redis caído falla cerrado sin invocar la RPC", async () => {
    await preparar(); estado.sesion = sesion; estado.redisCaido = true;
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await confirmar()).status).toBe(500);
    expect(estado.rpc).not.toHaveBeenCalled();
  });

  it("mantiene intacto el flujo de un QR normal", async () => {
    estado.sesion = sesion;
    const qr = await token();
    expect((await confirmar(qr)).status).toBe(200);
    expect(estado.rpc).toHaveBeenCalledWith("registrar_scan", { p_token: qr });
    expect(estado.getdel).not.toHaveBeenCalled();
  });
});
