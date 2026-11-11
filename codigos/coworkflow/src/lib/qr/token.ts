/**
 * Formato y firma del token del QR rotativo.
 *
 * Contrato fijo con Postgres (ver `docs/modelo-datos.md`):
 *
 *     v1.<zona_uuid>.<entrada|salida>.<ventana>.<hmac_hex>
 *
 * - `ventana` = `floor(epoch_segundos / QR_WINDOW_SECONDS)`.
 * - `hmac_hex` = HMAC-SHA256(payload, QR_TOKEN_SECRET) en hex minúscula (64 caracteres),
 *   donde `payload` es todo lo anterior (`v1.<zona>.<modo>.<ventana>`).
 *
 * Este módulo es PURO (no lee variables de entorno ni usa `next/*`): recibe el secreto como
 * argumento, así Vitest puede probarlo sin montar la app y el secreto no se filtra por un
 * import accidental. La verificación de la firma ocurre en Postgres (S-16), no aquí: Next
 * solo firma.
 */

export const VERSION_TOKEN_QR = "v1";

export type ModoTokenQr = "entrada" | "salida";

const RE_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RE_SECRETO_HEX = /^[0-9a-fA-F]{64}$/;

export type PartesTokenQr = {
  zonaId: string;
  modo: ModoTokenQr;
  ventana: number;
};

/** `floor(epoch_segundos / ventana_segundos)`; rechaza valores que no tengan sentido. */
export function calcularVentana(
  epochSegundos: number,
  ventanaSegundos: number,
): number {
  if (!Number.isFinite(epochSegundos) || epochSegundos < 0) {
    throw new Error("epoch inválido");
  }
  if (!Number.isInteger(ventanaSegundos) || ventanaSegundos <= 0) {
    throw new Error("La ventana del QR debe ser un entero positivo");
  }
  return Math.floor(epochSegundos / ventanaSegundos);
}

/** Ventana vigente en este instante (milisegundos desde epoch). */
export function ventanaActual(ahoraMs: number, ventanaSegundos: number): number {
  return calcularVentana(Math.floor(ahoraMs / 1000), ventanaSegundos);
}

/** Segundos que le quedan a la ventana en curso (1..ventanaSegundos). */
export function segundosRestantesVentana(
  ahoraMs: number,
  ventanaSegundos: number,
): number {
  if (!Number.isInteger(ventanaSegundos) || ventanaSegundos <= 0) {
    throw new Error("La ventana del QR debe ser un entero positivo");
  }
  const segundos = Math.floor(ahoraMs / 1000);
  return ventanaSegundos - (segundos % ventanaSegundos);
}

/**
 * ¿La ventana firmada sigue siendo aceptable?
 * El servidor acepta la ventana actual y la anterior (tolera el retraso del escaneo),
 * con un máximo de ~2 × QR_WINDOW_SECONDS.
 */
export function ventanaAceptada(ventana: number, actual: number): boolean {
  return ventana === actual || ventana === actual - 1;
}

export function armarPayload({ zonaId, modo, ventana }: PartesTokenQr): string {
  if (!RE_UUID.test(zonaId)) {
    throw new Error("zonaId debe ser un UUID");
  }
  if (modo !== "entrada" && modo !== "salida") {
    throw new Error('modo debe ser "entrada" o "salida"');
  }
  if (!Number.isInteger(ventana) || ventana < 0) {
    throw new Error("ventana inválida");
  }
  return `${VERSION_TOKEN_QR}.${zonaId.toLowerCase()}.${modo}.${ventana}`;
}

/** Convierte un secreto hex de 64 caracteres (32 bytes) a bytes (ArrayBuffer). */
export function hexABytes(hex: string): ArrayBuffer {
  if (!RE_SECRETO_HEX.test(hex)) {
    throw new Error(
      "El secreto HMAC debe tener exactamente 64 caracteres hexadecimales (32 bytes)",
    );
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes.buffer;
}

export function bytesAHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** HMAC-SHA256 en hex minúscula usando Web Crypto (disponible en Node 18+ y en el edge). */
export async function firmarHmacHex(
  payload: string,
  secretoHex: string,
): Promise<string> {
  const clave = await globalThis.crypto.subtle.importKey(
    "raw",
    hexABytes(secretoHex),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const firma = await globalThis.crypto.subtle.sign(
    "HMAC",
    clave,
    new TextEncoder().encode(payload),
  );
  return bytesAHex(new Uint8Array(firma));
}

/** Token completo `payload.firma` para una zona, modo y ventana dados. */
export async function crearTokenQr(
  partes: PartesTokenQr & { secretoHex: string },
): Promise<string> {
  const payload = armarPayload(partes);
  const firma = await firmarHmacHex(payload, partes.secretoHex);
  return `${payload}.${firma}`;
}
