import { redirect } from "next/navigation";

import { FormularioLogin } from "@/components/auth/FormularioLogin";
import { normalizarDestinoInterno, portadaDesdeScan } from "@/lib/auth/redirects";
import { obtenerSesion } from "@/lib/auth/session";
import { modoDesdeIndicadorScan } from "@/lib/validacion/scan";

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
  const params = await searchParams;
  // Indicador cerrado `desde=scan&modo=...`: solo cambia los mensajes y el destino de
  // vuelta. Si no viene o no es válido, todo sigue exactamente como antes.
  const modoScan = modoDesdeIndicadorScan(params.desde, params.modo);

  const sesion = await obtenerSesion();
  // Con sesión activa no hay nada que hacer aquí: la portada muestra el estado y el aviso.
  // Si venimos de un escaneo, la portada conserva el indicador para mostrar el paso 2.
  if (sesion) redirect(modoScan ? portadaDesdeScan(modoScan) : "/");

  const destino = modoScan
    ? portadaDesdeScan(modoScan)
    : normalizarDestinoInterno(
        typeof params.next === "string" ? params.next : null,
      );
  const mensaje = mensajeDeError(
    typeof params.error === "string" ? params.error : null,
  );

  return (
    <div className="flex flex-1 flex-col">
      <main className="mx-auto w-full max-w-md flex-1 px-5 py-10 md:px-8">
        <h1 className="text-2xl font-semibold tracking-tight">Iniciar sesión</h1>
        <p className="mt-2 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
          Entra para marcar tu entrada y salida. Si es tu primera vez, en la portada verás el
          aviso de privacidad y podrás aceptarlo.
        </p>

        {modoScan && (
          <p
            role="status"
            className="mt-4 rounded-xl bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
          >
            Paso 1 de 2: inicia sesión o crea tu cuenta. Después vuelve a escanear el QR de{" "}
            {modoScan === "entrada" ? "entrada" : "salida"}.
          </p>
        )}

        <div className="mt-6">
          <FormularioLogin destino={destino} mensajeInicial={mensaje} />
        </div>
      </main>
    </div>
  );
}
