import QRCode from "qrcode";

/**
 * Render del QR como SVG en el servidor.
 *
 * Se genera en el servidor para que el token nunca se construya en el navegador y para que
 * el SVG se vea nítido en pantalla y al imprimir (vectorial, sin `<canvas>`).
 * `errorCorrectionLevel: "M"` tolera ~15 % de daño: suficiente para un celular a 30 cm y
 * permite un QR no demasiado denso (la URL con el token ronda los 120 caracteres).
 */
export async function generarQrSvg(
  texto: string,
  opciones: { anchoPx?: number } = {},
): Promise<string> {
  const contenido = texto.trim();
  if (contenido.length === 0) {
    throw new Error("El texto del QR no puede estar vacío");
  }

  return QRCode.toString(contenido, {
    type: "svg",
    errorCorrectionLevel: "M",
    margin: 1,
    width: opciones.anchoPx ?? 480,
    color: { dark: "#18181b", light: "#ffffff" },
  });
}
