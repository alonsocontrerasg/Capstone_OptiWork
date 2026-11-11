import Link from "next/link";
import { redirect } from "next/navigation";

import { FormularioLogin } from "@/components/auth/FormularioLogin";
import { normalizarDestinoInterno } from "@/lib/auth/redirects";
import { obtenerSesion } from "@/lib/auth/session";

type Props = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function mensajeDeError(codigo: string | null): string | null {
  switch (codigo) {
    case "acceso":
      return "Ese enlace ya se usó o venció. Pide uno nuevo.";
    case "codigo":
      return "El enlace llegó incompleto. Pide uno nuevo desde aquí.";
    case "enlace":
      return "No pudimos validar el enlace. Inténtalo otra vez.";
    default:
      return null;
  }
}

export default async function PaginaLogin({ searchParams }: Props) {
  const sesion = await obtenerSesion();
  // Con sesión activa no hay nada que hacer aquí: la portada muestra el estado y el aviso.
  if (sesion) redirect("/");

  const params = await searchParams;
  const destino = normalizarDestinoInterno(
    typeof params.next === "string" ? params.next : null,
  );
  const mensaje = mensajeDeError(
    typeof params.error === "string" ? params.error : null,
  );

  return (
    <div className="flex flex-1 flex-col">
      <header className="border-b border-zinc-200 dark:border-zinc-800">
        <div className="mx-auto flex w-full max-w-4xl items-center justify-between gap-4 px-6 py-4">
          <Link href="/" className="text-sm font-semibold">
            ← CoworkFlow
          </Link>
          <span className="text-xs text-zinc-500 dark:text-zinc-400">
            Hub Providencia
          </span>
        </div>
      </header>

      <main className="mx-auto w-full max-w-md flex-1 px-6 py-10">
        <h1 className="text-2xl font-semibold tracking-tight">Iniciar sesión</h1>
        <p className="mt-2 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
          Entra para marcar tu entrada y salida. Si es tu primera vez, en la portada verás el
          aviso de privacidad y podrás aceptarlo.
        </p>

        <div className="mt-6">
          <FormularioLogin destino={destino} mensajeInicial={mensaje} />
        </div>
      </main>
    </div>
  );
}
