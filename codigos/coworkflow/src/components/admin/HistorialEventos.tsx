import type { EventoAdmin } from "@/lib/admin/datos";

const fecha = new Intl.DateTimeFormat("es-CL", {
  dateStyle: "short", timeStyle: "medium", timeZone: "America/Santiago",
});

/** Las tarjetas móviles conservan todos los datos de la tabla, sin desplazamiento lateral. */
export function HistorialEventos({ eventos }: { eventos: EventoAdmin[] }) {
  if (!eventos.length) return <p className="tarjeta text-center text-tenue">No hay eventos para estos filtros.</p>;
  return <>
    <ol aria-label="Historial de eventos de asistencia" className="space-y-3 md:hidden">
      {eventos.map((e,i)=><li key={`${e.ts}-${i}`} className="tarjeta">
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
          <dt className="font-semibold">Fecha</dt><dd>{fecha.format(new Date(e.ts))}</dd>
          <dt className="font-semibold">Zona</dt><dd>{e.zona}</dd>
          <dt className="font-semibold">Usuario</dt><dd className="font-mono">{e.usuario}</dd>
          <dt className="font-semibold">Tipo</dt><dd>{e.tipo ?? "—"}</dd>
          <dt className="font-semibold">Resultado</dt><dd>{e.resultado.replaceAll("_"," ")}</dd>
        </dl>
      </li>)}
    </ol>
    <div className="hidden rounded-2xl border border-borde bg-superficie md:block">
      <table className="w-full table-fixed text-left text-sm">
        <caption className="sr-only">Historial de eventos de asistencia</caption>
        <thead><tr>{["Fecha","Zona","Usuario","Tipo","Resultado"].map((t)=><th key={t} scope="col" className="p-3">{t}</th>)}</tr></thead>
        <tbody>{eventos.map((e,i)=><tr key={`${e.ts}-${i}`} className="border-t border-borde">
          <td className="p-3">{fecha.format(new Date(e.ts))}</td><td className="p-3">{e.zona}</td>
          <td className="p-3 font-mono">{e.usuario}</td><td className="p-3">{e.tipo ?? "—"}</td><td className="p-3">{e.resultado.replaceAll("_"," ")}</td>
        </tr>)}</tbody>
      </table>
    </div>
  </>;
}
