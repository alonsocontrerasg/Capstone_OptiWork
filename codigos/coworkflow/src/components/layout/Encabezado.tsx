import Link from "next/link";

import { obtenerSesion } from "@/lib/auth/session";

export async function Encabezado() {
  const sesion = await obtenerSesion();

  return (
    <header className="border-b border-borde bg-superficie">
      <div className="contenedor flex flex-col items-stretch justify-between gap-2 py-2.5 sm:flex-row sm:items-center">
        <Link href="/" className="foco-marca flex min-h-11 w-fit items-center gap-2.5 rounded-xl">
          <span
            aria-hidden
            className="grid size-9 shrink-0 place-items-center rounded-xl bg-marca text-xs font-semibold text-white"
          >
            OW
          </span>
          <span className="flex flex-col leading-tight">
            <span className="text-sm font-semibold text-tinta">OptiWork</span>
            <span className="hidden text-xs text-tenue sm:block">Hub Providencia</span>
          </span>
        </Link>

        <nav aria-label="Navegación principal" className="grid grid-cols-2 items-center gap-2 sm:flex">
          <Link href="/dashboard" className="enlace-header justify-center">
            Ocupación
          </Link>

          {sesion ? (
            <form action="/auth/signout" method="post">
              <button type="submit" className="btn-secundario w-full">
                Cerrar sesión
              </button>
            </form>
          ) : (
            <Link href="/login" className="btn-primario">
              Ingresar
            </Link>
          )}
        </nav>
      </div>
    </header>
  );
}
