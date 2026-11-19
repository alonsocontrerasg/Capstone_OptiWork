import { describe, expect, it } from "vitest";
import { crearTokenQr, ventanaActual } from "@/lib/qr/token";
import { verificarQrVigente } from "@/lib/qr/verificar";

const secreto = "a1".repeat(32);
const zonaId = "11111111-1111-4111-8111-111111111111";
const ahora = Date.UTC(2026, 10, 19, 15);
const actual = ventanaActual(ahora, 45);

describe("prueba del QR antes del registro", () => {
  it.each([0, -1])("acepta la ventana actual/anterior (%s)", async (desfase) => {
    const token = await crearTokenQr({ zonaId, modo: "entrada", ventana: actual + desfase, secretoHex: secreto });
    expect(verificarQrVigente(token, secreto, 45, ahora)).toEqual({ zonaId, modo: "entrada", ventana: actual + desfase });
  });
  it.each([-2, 1])("rechaza ventanas vencidas/futuras (%s)", async (desfase) => {
    const token = await crearTokenQr({ zonaId, modo: "entrada", ventana: actual + desfase, secretoHex: secreto });
    expect(verificarQrVigente(token, secreto, 45, ahora)).toBeNull();
  });
  it("rechaza cambios de zona, modo, firma y secreto", async () => {
    const token = await crearTokenQr({ zonaId, modo: "entrada", ventana: actual, secretoHex: secreto });
    for (const adulterado of [token.replace(zonaId, "22222222-2222-4222-8222-222222222222"),
      token.replace("entrada", "salida"), token.slice(0, -2) + "00", "pendiente", token + ".extra"]) {
      expect(verificarQrVigente(adulterado, secreto, 45, ahora)).toBeNull();
    }
    expect(verificarQrVigente(token, "b2".repeat(32), 45, ahora)).toBeNull();
  });
});
