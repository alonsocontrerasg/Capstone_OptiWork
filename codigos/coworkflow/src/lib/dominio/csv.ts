/** Escapa CSV y neutraliza fórmulas al abrirlo en una hoja de cálculo. */
export function celdaCsv(valor: string | number | null): string {
  let texto = valor === null ? "" : String(valor);
  if (/^[\s\u0000-\u001f]*[=+@-]/.test(texto) || /^[\t\r\n]/.test(texto)) {
    texto = `'${texto}`;
  }
  return `"${texto.replaceAll('"', '""')}"`;
}

export function generarCsv(filas: readonly (readonly (string | number | null)[])[]): string {
  return "\uFEFF" + filas.map((fila) => fila.map(celdaCsv).join(",")).join("\r\n") + "\r\n";
}
