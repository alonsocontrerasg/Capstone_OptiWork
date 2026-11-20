import Link from "next/link";
import { requireAdmin } from "@/lib/auth/guards";
import { listarZonasAdmin, leerHistorial } from "@/lib/admin/datos";
import { ConfiguracionZona } from "@/components/admin/ConfiguracionZona";
import { HistorialEventos } from "@/components/admin/HistorialEventos";
import { esquemaFiltrosHistorial } from "@/lib/validacion/admin";

export const metadata = { title: "Administración", robots: { index: false, follow: false } };

export default async function Admin({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdmin("/admin");
  const params = await searchParams;
  const validados = esquemaFiltrosHistorial.safeParse(params);
  if (!validados.success) return <main className="contenedor py-10"><h1 className="text-2xl font-semibold">Filtros inválidos</h1><Link className="btn-secundario mt-4" href="/admin">Restablecer filtros</Link></main>;
  const filtros = { ...validados.data, hasta: validados.data.hasta ?? new Date().toISOString() };
  const [zonas, historial] = await Promise.all([listarZonasAdmin(), leerHistorial(filtros)]);
  function enlace(pagina: number, ruta = "/admin") {
    const query = new URLSearchParams({ dias: filtros.dias, pagina: String(pagina), hasta: filtros.hasta });
    if (filtros.zona) query.set("zona", filtros.zona);
    return `${ruta}?${query}`;
  }
  return <main className="contenedor space-y-10 py-8">
    <div className="flex flex-wrap items-center justify-between gap-4"><div><h1 className="text-3xl font-semibold">Administración</h1><p className="mt-2 text-tenue">Configuración por zona e historial de marcas.</p></div><Link href="/qr" className="btn-secundario">Abrir QR</Link></div>
    <section aria-labelledby="configuracion"><h2 id="configuracion" className="mb-4 text-xl font-semibold">Zonas y horarios</h2>
      <div className="grid items-start gap-6 lg:grid-cols-2">{zonas.map((z) => <ConfiguracionZona key={z.id} zona={z} />)}</div>
      {zonas.length === 0 && <p className="tarjeta">Todavía no hay zonas. Crea la primera con el seed indicado en la guía de instalación.</p>}
    </section>
    <section aria-labelledby="historial"><h2 id="historial" className="text-xl font-semibold">Historial de escaneos</h2>
      <p className="mt-2 text-sm text-tenue">Incluye marcas e intentos rechazados. Horas de Chile continental. Los usuarios se muestran con un identificador seudónimo.</p>
      <form className="my-4 grid gap-3 sm:flex sm:flex-wrap sm:items-end" method="get">
        <label className="flex min-w-0 flex-col gap-1 text-sm sm:max-w-80">Zona<select name="zona" defaultValue={filtros.zona ?? ""} className="min-h-11 w-full rounded-xl border border-borde bg-superficie px-2"><option value="">Todas</option>{zonas.map((z) => <option key={z.id} value={z.id}>{z.nombre}</option>)}</select></label>
        <label className="flex min-w-0 flex-col gap-1 text-sm">Período<select name="dias" defaultValue={filtros.dias} className="min-h-11 w-full rounded-xl border border-borde bg-superficie px-2">{[7, 30, 90].map((d) => <option key={d} value={d}>Últimos {d} días</option>)}</select></label>
        <button className="btn-primario">Filtrar y actualizar</button>
        <a href={enlace(1, "/api/admin/exportar")} className="btn-secundario">Exportar CSV</a>
      </form>
      <p className="mb-3 text-xs text-tenue">CSV: fechas UTC, hasta 10.000 registros por descarga. Si se supera, reduce el período o filtra una zona.</p>
      <HistorialEventos eventos={historial.eventos} />
      <nav aria-label="Páginas del historial" className="mt-4 flex flex-wrap items-center gap-4">
        {filtros.pagina > 1 && <Link className="btn-secundario" href={enlace(filtros.pagina - 1)}>Anterior</Link>}
        <span className="text-sm">Página {filtros.pagina}</span>
        {historial.siguiente && <Link className="btn-secundario" href={enlace(filtros.pagina + 1)}>Siguiente</Link>}
      </nav>
    </section>
  </main>;
}
