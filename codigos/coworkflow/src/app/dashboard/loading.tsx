/**
 * Estado de carga de `/dashboard`.
 *
 * Solo esqueleto visual: no consulta datos ni muestra detalles técnicos. El texto para
 * lectores de pantalla anuncia la carga una vez (`aria-live`), y las cajas decorativas
 * quedan ocultas para tecnologías de asistencia.
 */
export default function CargandoDashboard() {
  return (
    <div className="flex flex-1 flex-col">
      <header className="border-b border-zinc-200 dark:border-zinc-800">
        <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-4 px-6 py-4">
          <div className="space-y-2">
            <div className="h-4 w-32 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
            <div className="h-5 w-48 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
          </div>
          <div className="h-10 w-48 animate-pulse rounded-full bg-zinc-200 dark:bg-zinc-800" />
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-8">
        <p className="sr-only" aria-live="polite">
          Cargando el dashboard…
        </p>

        <div className="space-y-2" aria-hidden="true">
          <div className="h-4 w-28 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
          <div className="h-9 w-64 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
        </div>

        <div
          className="mt-6 rounded-3xl border border-zinc-200 p-6 sm:p-8 dark:border-zinc-800"
          aria-hidden="true"
        >
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-3">
              <div className="h-4 w-32 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
              <div className="h-16 w-40 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
            </div>
            <div className="h-8 w-28 animate-pulse rounded-full bg-zinc-200 dark:bg-zinc-800" />
          </div>
          <div className="mt-8 h-2.5 w-full animate-pulse rounded-full bg-zinc-200 dark:bg-zinc-800" />
          <div className="mt-3 h-3 w-72 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
        </div>

        <div
          className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
          aria-hidden="true"
        >
          {[0, 1, 2].map((indice) => (
            <div
              key={indice}
              className="h-32 animate-pulse rounded-2xl border border-zinc-200 bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900"
            />
          ))}
        </div>
      </main>
    </div>
  );
}
