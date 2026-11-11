import Link from "next/link";
import { connection } from "next/server";

export default async function Forbidden() {
  // Render dinámico: la CSP usa un nonce por request (ver S-10) y una página prerenderizada
  // no tendría nonce en sus scripts.
  await connection();

  return (
    <main className="mx-auto flex w-full max-w-lg flex-1 flex-col justify-center px-6 py-16">
      <p className="text-sm font-semibold text-red-600 dark:text-red-400">403</p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">
        No tienes permiso para ver esta página
      </h1>
      <p className="mt-3 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
        Tu cuenta está autenticada, pero esta sección es solo para administradores del Hub.
        Si crees que es un error, pide que te asignen el rol.
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
