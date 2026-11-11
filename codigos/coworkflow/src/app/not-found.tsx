import Link from "next/link";
import { connection } from "next/server";

export default async function NoEncontrado() {
  // Dinámico por la misma razón que forbidden.tsx: la CSP usa nonce por request (S-10).
  await connection();

  return (
    <main className="mx-auto flex w-full max-w-lg flex-1 flex-col justify-center px-6 py-16">
      <p className="text-sm font-semibold text-zinc-500 dark:text-zinc-400">404</p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">
        No encontramos esta página
      </h1>
      <p className="mt-3 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
        Puede que el enlace esté mal escrito o que la página todavía no exista (el QR de
        entrada y salida apunta a <code className="font-mono">/scan</code>, que llega en la
        Etapa 4).
      </p>
      <Link
        href="/"
        className="mt-6 inline-flex w-fit rounded-full bg-zinc-900 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-zinc-700 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
      >
        Volver al inicio
      </Link>
    </main>
  );
}
