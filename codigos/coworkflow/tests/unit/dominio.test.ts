import { describe, expect, it } from "vitest";
import { resumirOcupacion } from "@/lib/dominio/ocupacion";
import { limitesRangoDias, horarioDelDia, textoEstadoHorario } from "@/lib/dominio/tiempo";
import { construirMatrizCalor, construirSeriePorHora, construirSerieHoy, horaPunta, formatearPermanencia } from "@/lib/dominio/estadisticas";
import { celdaCsv, generarCsv } from "@/lib/dominio/csv";
import { esquemaConfiguracionAdmin, esquemaFiltrosHistorial } from "@/lib/validacion/admin";

describe("ocupación y estadísticas", () => {
  const config = { aforo_max: 100, umbral_bajo: 40, umbral_alto: 80 };
  it.each([[39, "bajo"], [40, "moderado"], [80, "moderado"], [81, "lleno"]])("respeta el borde %s", (cantidad, estado) => {
    expect(resumirOcupacion(cantidad, config).estado).toBe(estado);
  });
  it("representa sobreaforo y datos inválidos sin inventar lecturas", () => {
    expect(resumirOcupacion(125, config)).toMatchObject({ porcentaje: 125, porcentaje_barra: 100, estado: "lleno" });
    for (const valor of [-1, 1.2, NaN, null, "2"]) expect(resumirOcupacion(valor, config).estado).toBe("desconocido");
    expect(resumirOcupacion(2, { ...config, aforo_max: 0 }).estado).toBe("desconocido");
  });
  it("pondera las muestras, conserva huecos y desempata la hora punta", () => {
    const filas = [{ dow: 1, hora: 8, promedio: 10, muestras: 1 }, { dow: 1, hora: 8, promedio: 30, muestras: 3 },
      { dow: 9, hora: 8, promedio: 999, muestras: 99 }];
    expect(construirMatrizCalor(filas)[0][8]).toBe(25);
    expect(construirSeriePorHora(filas)[8]).toBe(25);
    expect(construirSeriePorHora(filas)[9]).toBeNull();
    expect(horaPunta([null, 10, 10])).toEqual({ hora: 1, promedio: 10 });
    expect(horaPunta([null, NaN])).toBeNull();
    expect(construirSerieHoy([{ ts: "2026-11-19T12:00:00Z", cantidad: 5 }], "America/Santiago")[9]).toBe(5);
    expect(formatearPermanencia(null)).toBe("Sin datos");
    expect(formatearPermanencia(30)).toBe("< 1 min");
  });
});

describe("horarios y cambios de hora de Chile", () => {
  it.each([
    ["2026-09-06T12:00:00Z", "2026-08-30T16:00:00.000Z", "2026-09-06T15:00:00.000Z"],
    ["2026-04-05T12:00:00Z", "2026-03-29T15:00:00.000Z", "2026-04-05T16:00:00.000Z"],
  ])("conserva siete días civiles alrededor de %s", (ahora, desde, hasta) => {
    const limites = limitesRangoDias(new Date(ahora), "America/Santiago", 7)!;
    expect(limites.desde.toISOString()).toBe(desde); expect(limites.hasta.toISOString()).toBe(hasta);
  });
  it("respeta días cerrados y los minutos de apertura", () => {
    const zona = { timezone: "America/Santiago", hora_apertura: "08:00", hora_cierre: "20:00",
      horarios_zona: [{ dia_semana: 1, apertura: "08:30", cierre: "18:00" }] };
    expect(horarioDelDia(zona, new Date("2026-11-16T12:00:00Z"))).toEqual({ apertura: 510, cierre: 1080 });
    expect(horarioDelDia(zona, new Date("2026-11-21T12:00:00Z"))).toBeNull();
    expect(textoEstadoHorario(zona, new Date("2026-11-16T11:29:00Z"))).toContain("08:30");
    expect(textoEstadoHorario(zona, new Date("2026-11-16T11:30:00Z"))).toContain("Abierto");
    expect(limitesRangoDias(new Date(), "Inventada", 7)).toBeNull();
  });
});

describe("configuración y exportación", () => {
  const valida = { zona_id: "11111111-1111-4111-8111-111111111111", nombre: "Cowork", aforo_max: 100,
    umbral_bajo: 40, umbral_alto: 80, activa: true, horarios: [{ dia_semana: 1, apertura: "08:30", cierre: "18:00" }] };
  it("rechaza días repetidos, horarios invertidos, umbrales incoherentes y zona activa sin días", () => {
    expect(esquemaConfiguracionAdmin.safeParse(valida).success).toBe(true);
    for (const mala of [{ ...valida, horarios: [] }, { ...valida, umbral_bajo: 80 },
      { ...valida, horarios: [valida.horarios[0], valida.horarios[0]] },
      { ...valida, horarios: [{ dia_semana: 1, apertura: "18:00", cierre: "08:30" }] }]) {
      expect(esquemaConfiguracionAdmin.safeParse(mala).success).toBe(false);
    }
    expect(esquemaFiltrosHistorial.parse({ zona: "" }).zona).toBeUndefined();
    expect(esquemaFiltrosHistorial.safeParse({ dias: "365" }).success).toBe(false);
  });
  it.each(["=1+1", "+SUM(A1)", "-1+1", "@SUM(A1)", "  =1+1", "\tmalicioso"])("neutraliza fórmulas CSV: %s", (valor) => {
    expect(celdaCsv(valor).startsWith('"\'')).toBe(true);
  });
  it("conserva Unicode, comas, comillas y saltos de línea en CSV", () => {
    expect(generarCsv([["Zona Ñ", 'a,"b"', "línea\nnueva", null]])).toBe('\uFEFF"Zona Ñ","a,""b""","línea\nnueva",""\r\n');
  });
});
