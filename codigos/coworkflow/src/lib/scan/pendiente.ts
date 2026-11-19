import "server-only";

import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { Redis } from "@upstash/redis";
import { z } from "zod";

import { credencialesUpstash, envServidor } from "@/lib/env.server";
import { crearTokenQr, ventanaActual } from "@/lib/qr/token";
import { verificarQrVigente } from "@/lib/qr/verificar";

export const COOKIE_SCAN_PENDIENTE = "ow_scan_pendiente";
export const DURACION_SCAN_PENDIENTE = 10 * 60;
/** Marcador sin autoridad propia: requiere la cookie opaca y su registro en Redis. */
export const TOKEN_SCAN_PENDIENTE = "pendiente";

const esquemaPendiente = z.object({
  zonaId: z.uuid(),
  modo: z.enum(["entrada", "salida"]),
  venceAt: z.number().int(),
});
type ScanPendiente = z.infer<typeof esquemaPendiente>;
const memoria = new Map<string, ScanPendiente>();
let redis: Redis | undefined;

function clienteRedis(): Redis | null {
  const credenciales = credencialesUpstash(); // En producción nunca usa memoria local.
  if (!credenciales) return null;
  return redis ??= new Redis({
    ...credenciales,
    signal: () => AbortSignal.timeout(5000),
    retry: false,
  });
}

function clave(id: string): string {
  return `scan:pendiente:${id}`;
}

/** Valida firma y vigencia ANTES de guardar. No almacena el QR, usuario, correo ni IP. */
export async function guardarScanPendiente(token: string): Promise<string | null> {
  const datos = verificarQrVigente(
    token, envServidor.QR_TOKEN_SECRET, envServidor.QR_WINDOW_SECONDS,
  );
  if (!datos) return null;
  const ahora = Date.now();
  const pendiente: ScanPendiente = {
    zonaId: datos.zonaId,
    modo: datos.modo,
    venceAt: ahora + DURACION_SCAN_PENDIENTE * 1000,
  };
  const id = randomBytes(32).toString("hex");
  const cliente = clienteRedis();
  if (cliente) {
    await cliente.set(clave(id), pendiente, { ex: DURACION_SCAN_PENDIENTE });
  } else {
    for (const [anterior, valor] of memoria) {
      if (valor.venceAt <= ahora) memoria.delete(anterior);
    }
    memoria.set(id, pendiente);
  }
  return id;
}

async function leer(consumir: boolean): Promise<ScanPendiente | null> {
  const id = (await cookies()).get(COOKIE_SCAN_PENDIENTE)?.value;
  if (!id || !/^[0-9a-f]{64}$/.test(id)) return null;
  const cliente = clienteRedis();
  let valor: unknown;
  if (cliente) {
    // GETDEL es atómico: dos POST simultáneos no pueden canjear el mismo escaneo.
    valor = consumir ? await cliente.getdel(clave(id)) : await cliente.get(clave(id));
  } else {
    valor = memoria.get(id);
    if (consumir) memoria.delete(id);
  }
  const datos = esquemaPendiente.safeParse(valor);
  if (!datos.success || datos.data.venceAt <= Date.now()) return null;
  return datos.data;
}

/** Consultar la continuación nunca renueva su plazo ni registra asistencia. */
export async function obtenerScanPendiente() {
  return leer(false);
}

/** Solo llamar desde POST después de verificar sesión, consentimiento y límites. */
export async function consumirScanPendiente(): Promise<string | null> {
  const datos = await leer(true);
  if (!datos) return null;
  return crearTokenQr({
    zonaId: datos.zonaId,
    modo: datos.modo,
    ventana: ventanaActual(Date.now(), envServidor.QR_WINDOW_SECONDS),
    secretoHex: envServidor.QR_TOKEN_SECRET,
  });
}
