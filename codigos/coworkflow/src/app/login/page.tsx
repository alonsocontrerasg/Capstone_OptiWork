import { redirect } from "next/navigation";

import { FormularioLogin } from "@/components/auth/FormularioLogin";
import { normalizarDestinoInterno, portadaDesdeScan } from "@/lib/auth/redirects";
import { obtenerSesion } from "@/lib/auth/session";
import { obtenerScanPendiente } from "@/lib/scan/pendiente";
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
  const pendiente = await obtenerScanPendiente();
  const modoScan = pendiente?.modo ?? modoDesdeIndicadorScan(params.desde, params.modo);

  const sesion = await obtenerSesion();
  if (sesion) {
    redirect(pendiente ? "/scan" : modoScan ? portadaDesdeScan(modoScan) : "/");
  }

  const destino = pendiente
    ? "/scan"
    : modoScan
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
            {pendiente
              ? "Crea tu cuenta o inicia sesión para continuar con este escaneo. Lo conservamos por 10 minutos; abre el correo de confirmación en este mismo navegador."
              : "El escaneo ya no está disponible. Después de ingresar, vuelve a escanear el QR."}
          </p>
        )}

        <div className="mt-6">
          <FormularioLogin destino={destino} mensajeInicial={mensaje} />
        </div>
      </main>
    </div>
  );
}
