import { createHmac, timingSafeEqual } from "node:crypto";

import { ventanaAceptada, ventanaActual, type PartesTokenQr } from "./token";

/** Solo autoriza guardar un escaneo pendiente; la asistencia sigue validándose en la RPC. */
export function verificarQrVigente(
  token: string,
  secreto: string,
  ventanaSegundos: number,
  ahoraMs = Date.now(),
): PartesTokenQr | null {
  const partes = /^v1\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(entrada|salida)\.(0|[1-9][0-9]{0,15})\.([0-9a-f]{64})$/.exec(token);
  if (!partes) return null;
  const [, zonaId, modo, numero, firma] = partes;
  const ventana = Number(numero);
  if (
    !Number.isSafeInteger(ventana) ||
    !ventanaAceptada(ventana, ventanaActual(ahoraMs, ventanaSegundos))
  ) return null;
  const payload = token.slice(0, token.lastIndexOf("."));
  const esperada = createHmac("sha256", secreto).update(payload).digest();
  if (!timingSafeEqual(esperada, Buffer.from(firma, "hex"))) return null;
  return { zonaId, modo: modo as PartesTokenQr["modo"], ventana };
}
