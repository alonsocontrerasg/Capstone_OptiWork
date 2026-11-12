import Link from "next/link";

import { AvisoConsentimiento } from "@/components/auth/AvisoConsentimiento";
import { obtenerSesion } from "@/lib/auth/session";
import {
  CONSENTIMIENTO_FECHA,
  CONSENTIMIENTO_VERSION,
  SECCIONES_AVISO,
  consentimientoDesactualizado,
  tieneConsentimiento,
} from "@/lib/dominio/consentimiento";

const formatoFecha = new Intl.DateTimeFormat("es-CL", {
  dateStyle: "long",
  timeStyle: "short",
  timeZone: "America/Santiago",
});

function formatearFecha(iso: string | null): string | null {
  if (!iso) return null;
  const fecha = new Date(iso);
  return Number.isNaN(fecha.getTime()) ? null : formatoFecha.format(fecha);
}

export default async function Home() {
  const sesion = await obtenerSesion();
  const conConsentimiento = tieneConsentimiento(sesion?.perfil);
  const desactualizado = consentimientoDesactualizado(sesion?.perfil);

  return (
    <div className="flex flex-1 flex-col">
      <header className="border-b border-zinc-200 dark:border-zinc-800">
        <div className="mx-auto flex w-full max-w-4xl items-center justify-between gap-4 px-6 py-4">
          <div className="flex items-center gap-3">
            <span
              aria-hidden
              className="grid size-9 place-items-center rounded-lg bg-zinc-900 text-sm font-semibold text-white dark:bg-white dark:text-zinc-900"
            >
              CF
            </span>
            <div>
              <p className="text-sm font-semibold leading-tight">CoworkFlow</p>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                Hub Providencia
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Link
              href="/dashboard"
              className="rounded-full px-3 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-900"
            >
              Dashboard
            </Link>

            {sesion ? (
              <form action="/auth/signout" method="post">
                <button
                  type="submit"
                  className="rounded-full border border-zinc-300 px-4 py-2 text-sm font-medium transition-colors hover:bg-zinc-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900 dark:border-zinc-700 dark:hover:bg-zinc-900"
                >
                  Cerrar sesión
                </button>
              </form>
            ) : (
              <Link
                href="/login"
                className="rounded-full bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
              >
                Iniciar sesión
              </Link>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-10">
        <h1 className="text-3xl font-semibold tracking-tight">
          Ocupación del cowork en tiempo real
        </h1>
        <p className="mt-3 max-w-2xl text-base leading-7 text-zinc-600 dark:text-zinc-400">
          Escanea el QR de entrada o salida con la cámara de tu celular y el contador se
          actualiza solo. El dashboard público muestra únicamente cifras agregadas: nunca
          tu nombre ni tus horarios.
        </p>

        {!sesion && (
          <section className="mt-8 rounded-2xl border border-zinc-200 p-6 dark:border-zinc-800">
            <h2 className="text-lg font-semibold">Entra para marcar tu asistencia</h2>
            <p className="mt-2 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
              Usa un enlace mágico por correo o tu contraseña. En la primera sesión verás
              el aviso de privacidad (Ley 21.719) y podrás aceptarlo o rechazarlo.
            </p>
            <Link
              href="/login"
              className="mt-4 inline-flex rounded-full bg-zinc-900 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-zinc-700 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
            >
              Ir a iniciar sesión
            </Link>
          </section>
        )}

        {sesion && !conConsentimiento && (
          <section className="mt-8">
            <AvisoConsentimiento
              version={CONSENTIMIENTO_VERSION}
              fecha={CONSENTIMIENTO_FECHA}
              secciones={SECCIONES_AVISO}
              aceptadoAt={null}
              requiereAceptacion
            />
          </section>
        )}

        {sesion && conConsentimiento && (
          <section className="mt-8 space-y-4">
            <div className="rounded-2xl border border-zinc-200 p-6 dark:border-zinc-800">
              <h2 className="text-lg font-semibold">
                Hola{sesion.usuario.email ? `, ${sesion.usuario.email}` : ""}
              </h2>
              <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
                Sesión iniciada. Rol:{" "}
                <span className="font-medium text-foreground">
                  {sesion.perfil?.rol ?? "usuario"}
                </span>
                .
              </p>

              <div className="mt-4 flex flex-wrap gap-3">
                {sesion.perfil?.rol === "admin" && (
                  <Link
                    href="/qr"
                    className="rounded-full bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
                  >
                    Abrir QR rotativo
                  </Link>
                )}
                <Link
                  href="/dashboard"
                  className="rounded-full border border-zinc-300 px-4 py-2 text-sm font-medium transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
                >
                  Ver dashboard
                </Link>
              </div>
            </div>

            {desactualizado ? (
              <AvisoConsentimiento
                version={CONSENTIMIENTO_VERSION}
                fecha={CONSENTIMIENTO_FECHA}
                secciones={SECCIONES_AVISO}
                aceptadoAt={sesion.perfil?.consentimiento_at ?? null}
                requiereAceptacion
              />
            ) : (
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                Consentimiento aceptado el{" "}
                {formatearFecha(sesion.perfil?.consentimiento_at ?? null) ?? "—"}{" "}
                (versión {sesion.perfil?.consentimiento_version ?? "—"}). Solo tú y el
                equipo administrador pueden ver tus sesiones.
              </p>
            )}
          </section>
        )}
      </main>

      <footer className="border-t border-zinc-200 px-6 py-6 text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
        CoworkFlow · proyecto académico · los registros individuales se eliminan a los 90
        días y las estadísticas se publican solo con k ≥ 5 personas.
      </footer>
    </div>
  );
}

