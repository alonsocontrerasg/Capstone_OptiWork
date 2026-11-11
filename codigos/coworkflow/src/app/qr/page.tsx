import Link from "next/link";

import { QrRotativo } from "@/components/qr/QrRotativo";
import { requireAdmin } from "@/lib/auth/guards";
import { envPublico } from "@/lib/env";
import { listarZonasActivas } from "@/lib/supabase/zonas";

export const metadata = { title: "QR rotativo" };

type Props = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * `/qr` — QR rotativo para mostrar en una pantalla en la entrada del cowork (solo admin).
 *
 * El guard se ejecuta en la propia página (no en el proxy): `/login` si no hay sesión y
 * `forbidden()` (403) si hay sesión sin rol `admin` (S-27).
 */
export default async function PaginaQr({ searchParams }: Props) {
  await requireAdmin("/qr");

  const zonas = await listarZonasActivas();
  const params = await searchParams;
  const solicitada =
    typeof params.zona === "string"
      ? params.zona
      : envPublico.NEXT_PUBLIC_ZONA_POR_DEFECTO;
  const zona = zonas.find((item) => item.slug === solicitada) ?? zonas[0] ?? null;

  return (
    <div className="flex flex-1 flex-col">
      <header className="border-b border-zinc-200 dark:border-zinc-800">
        <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-4 px-6 py-4">
          <div>
            <Link href="/" className="text-sm font-semibold">
              ← CoworkFlow
            </Link>
            <h1 className="mt-1 text-lg font-semibold">QR rotativo</h1>
          </div>

          {zonas.length > 1 && (
            <form method="get" className="flex items-end gap-2">
              <label htmlFor="zona" className="text-xs text-zinc-500 dark:text-zinc-400">
                Zona
                <select
                  id="zona"
                  name="zona"
                  defaultValue={zona?.slug ?? ""}
                  className="mt-1 block rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
                >
                  {zonas.map((item) => (
                    <option key={item.id} value={item.slug}>
                      {item.nombre}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="submit"
                className="rounded-full border border-zinc-300 px-4 py-2 text-xs font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
              >
                Cambiar
              </button>
            </form>
          )}
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-8">
        {zona ? (
          <>
            <p className="max-w-2xl text-sm leading-6 text-zinc-600 dark:text-zinc-400">
              Deja esta pantalla visible en la entrada. El código cambia cada 45 segundos
              (<code className="font-mono">QR_WINDOW_SECONDS</code>, configurable) y el
              servidor acepta también la ventana anterior, para tolerar el tiempo que tarda
              alguien en escanear.
            </p>

            <div className="mt-6 grid gap-5 sm:grid-cols-2">
              <QrRotativo zona={zona.slug} modo="entrada" nombreZona={zona.nombre} />
              <QrRotativo zona={zona.slug} modo="salida" nombreZona={zona.nombre} />
            </div>

            <p className="mt-6 text-xs leading-5 text-zinc-500 dark:text-zinc-400">
              El QR apunta a <code className="font-mono">/scan</code> e incluye un token
              firmado con la zona y el modo: cambiar <code className="font-mono">?modo=</code>{" "}
              en la URL no altera la operación registrada. Una foto del QR deja de servir en
              cuanto vence la ventana.
            </p>
          </>
        ) : (
          <p className="rounded-2xl border border-dashed border-zinc-300 p-6 text-sm text-zinc-600 dark:border-zinc-700 dark:text-zinc-400">
            No hay zonas activas. Ejecuta <code className="font-mono">supabase/seed.sql</code>{" "}
            o activa una zona desde el panel de administración.
          </p>
        )}
      </main>
    </div>
  );
}
