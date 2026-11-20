"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { DIAS_SEMANA } from "@/lib/dominio/estadisticas";
import type { ZonaPublica } from "@/lib/supabase/zonas";
import { esquemaConfiguracionAdmin } from "@/lib/validacion/admin";

const campo = "foco-marca mt-1 min-h-11 w-full rounded-xl border border-borde bg-superficie px-3";

export function ConfiguracionZona({ zona }: { zona: ZonaPublica }) {
  const router = useRouter();
  const [enviando, setEnviando] = useState(false);
  const [mensaje, setMensaje] = useState("");
  const [error, setError] = useState(false);
  const [dias, setDias] = useState(() => DIAS_SEMANA.map((_, i) => {
    const h = zona.horarios_zona?.find((fila) => fila.dia_semana === i + 1);
    return { dia_semana: i + 1, abierto: zona.horarios_zona?.length ? Boolean(h) : true,
      apertura: (h?.apertura ?? zona.hora_apertura).slice(0, 5),
      cierre: (h?.cierre ?? zona.hora_cierre).slice(0, 5) };
  }));

  async function guardar(evento: React.FormEvent<HTMLFormElement>) {
    evento.preventDefault(); setMensaje(""); setError(false);
    const datos = new FormData(evento.currentTarget);
    const configuracion = esquemaConfiguracionAdmin.safeParse({
      zona_id: zona.id, nombre: datos.get("nombre"),
      aforo_max: Number(datos.get("aforo")), umbral_bajo: Number(datos.get("bajo")),
      umbral_alto: Number(datos.get("alto")), activa: datos.get("activa") === "on",
      horarios: dias.filter((d) => d.abierto).map(({ dia_semana, apertura, cierre }) => ({ dia_semana, apertura, cierre })),
    });
    if (!configuracion.success) {
      setError(true); setMensaje("Revisa los valores: umbrales ordenados, apertura anterior al cierre y al menos un día abierto si la zona está activa."); return;
    }
    setEnviando(true);
    try {
      const respuesta = await fetch("/api/admin/configuracion", { method: "POST",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(configuracion.data) });
      if (!respuesta.ok) throw new Error();
      setMensaje("Configuración guardada."); router.refresh();
    } catch { setError(true); setMensaje("No se pudo guardar. Comprueba tu sesión y vuelve a intentarlo."); }
    finally { setEnviando(false); }
  }

  return (
    <form onSubmit={guardar} className="tarjeta space-y-5" aria-label={`Configurar ${zona.nombre}`}>
      <div><h3 className="text-lg font-semibold">{zona.nombre}</h3><p className="text-sm text-tenue">{zona.slug} · Horario en {zona.timezone}</p></div>
      <fieldset disabled={enviando} className="space-y-5">
        <label className="block text-sm font-medium">Nombre
          <input name="nombre" required maxLength={100} defaultValue={zona.nombre} className={campo} />
        </label>
        <div className="grid gap-4 sm:grid-cols-3">
          <label className="text-sm font-medium">Aforo máximo<input name="aforo" type="number" required min={1} max={100000} defaultValue={zona.aforo_max} className={campo} /></label>
          <label className="text-sm font-medium">Umbral bajo (%)<input name="bajo" type="number" required min={0} max={99} defaultValue={zona.umbral_bajo} className={campo} /></label>
          <label className="text-sm font-medium">Umbral alto (%)<input name="alto" type="number" required min={1} max={100} defaultValue={zona.umbral_alto} className={campo} /></label>
        </div>
        <label className="flex min-h-11 items-center gap-3 text-sm"><input name="activa" type="checkbox" defaultChecked={zona.activa} className="size-5" />Zona activa</label>
        <fieldset className="space-y-3"><legend className="mb-3 font-medium">Horario semanal</legend>
          <div aria-hidden className="grid grid-cols-[1fr_6rem_6rem] gap-2 text-xs text-tenue sm:grid-cols-[1fr_8rem_8rem]"><span>Día</span><span>Apertura</span><span>Cierre</span></div>
          {dias.map((dia, i) => <div key={dia.dia_semana} className="grid grid-cols-[1fr_6rem_6rem] items-center gap-2 sm:grid-cols-[1fr_8rem_8rem]">
            <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" className="size-4" checked={dia.abierto}
              onChange={(e) => setDias(dias.map((d, j) => j === i ? { ...d, abierto: e.target.checked } : d))} />{DIAS_SEMANA[i]}</label>
            <input aria-label={`Apertura ${DIAS_SEMANA[i]}`} type="text" placeholder="HH:MM" pattern="([01][0-9]|2[0-3]):[0-5][0-9]" maxLength={5} required={dia.abierto} disabled={!dia.abierto} value={dia.apertura} className={campo}
              onChange={(e) => setDias(dias.map((d, j) => j === i ? { ...d, apertura: e.target.value } : d))} />
            <input aria-label={`Cierre ${DIAS_SEMANA[i]}`} type="text" placeholder="HH:MM" pattern="([01][0-9]|2[0-3]):[0-5][0-9]|24:00" maxLength={5} required={dia.abierto} disabled={!dia.abierto} value={dia.cierre} className={campo}
              onChange={(e) => setDias(dias.map((d, j) => j === i ? { ...d, cierre: e.target.value } : d))} />
          </div>)}
          <p className="text-xs text-tenue">Días desmarcados: cerrado. El cierre acepta 24:00. Cambiar el horario no cierra inmediatamente las estancias abiertas; las revisa el cierre automático.</p>
        </fieldset>
        <button className="btn-primario w-full sm:w-auto" type="submit">{enviando ? "Guardando…" : "Guardar configuración"}</button>
      </fieldset>
      <p role={error ? "alert" : "status"} className={`text-sm ${error ? "text-lleno-texto" : "text-bajo-texto"}`}>{mensaje}</p>
    </form>
  );
}
