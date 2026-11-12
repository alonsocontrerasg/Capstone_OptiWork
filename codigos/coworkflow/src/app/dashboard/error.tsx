"use client";

import Link from "next/link";
import { RefreshCw, TriangleAlert } from "lucide-react";

/**
 * Frontera de error de `/dashboard`.
 *
 * No muestra `error.message`, stacks ni identificadores técnicos: en producción esos
 * detalles se quedan en los logs del servidor. La persona solo ve un mensaje genérico y
 * dos acciones seguras (reintentar o volver al inicio).
 */
type Props = {
  error: unknown;
  retry: () => void;
};

export default function ErrorDashboard({ retry }: Props) {
  return (
    <main className="mx-auto flex w-full max-w-lg flex-1 flex-col justify-center px-6 py-16">
      <p className="flex items-center gap-2 text-sm font-semibold text-red-600 dark:text-red-400">
        <TriangleAlert aria-hidden className="size-4" />
        No pudimos mostrar el dashboard
      </p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">
        Algo salió mal
      </h1>
      <p className="mt-3 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
        Vuelve a intentarlo en unos segundos. Si el problema continúa, avisa al
        equipo del Hub.
      </p>

      <div className="mt-6 flex flex-wrap gap-3">
        <button
          type="button"
          onClick={() => retry()}
          className="inline-flex items-center gap-2 rounded-full bg-zinc-900 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-zinc-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          <RefreshCw aria-hidden className="size-4" />
          Reintentar
        </button>
        <Link
          href="/"
          className="inline-flex items-center rounded-full border border-zinc-300 px-5 py-2.5 text-sm font-medium transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
        >
          Volver al inicio
        </Link>
      </div>
    </main>
  );
}
