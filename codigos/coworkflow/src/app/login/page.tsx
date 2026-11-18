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

  const titulo = modoScan ? `Ingresa para marcar tu ${modoScan}` : "Ingresar";

  return (
    <div className="flex flex-1 flex-col">
      <main className="mx-auto w-full max-w-md flex-1 px-5 py-10 md:px-8">
        <div className="flex items-center justify-center gap-2.5">
          <span
            aria-hidden
            className="grid size-10 place-items-center rounded-xl bg-marca text-xs font-semibold text-white"
          >
            OW
          </span>
          <span className="text-lg font-semibold tracking-tight">OptiWork</span>
        </div>

        {modoScan && (
          <div className="mt-8 flex items-center justify-center gap-3">
            <span aria-hidden className="flex gap-1">
              <span className="h-1.5 w-6 rounded-full bg-marca" />
              <span className="h-1.5 w-6 rounded-full bg-borde" />
            </span>
            <span className="text-xs font-medium text-tenue">Paso 1 de 2</span>
          </div>
        )}

        <h1
          className={`text-center text-2xl font-semibold tracking-tight ${
            modoScan ? "mt-4" : "mt-10"
          }`}
        >
          {titulo}
        </h1>

        {modoScan && (
          <p className="mt-2 text-center text-sm leading-6 text-tenue">
            Después vuelve a escanear el QR.
          </p>
        )}

        <div className="mt-6">
          <FormularioLogin destino={destino} mensajeInicial={mensaje} />
        </div>
      </main>
    </div>
  );
}
