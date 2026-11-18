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
import { modoDesdeIndicadorScan } from "@/lib/validacion/scan";

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

type Props = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function Home({ searchParams }: Props) {
  const sesion = await obtenerSesion();
  const conConsentimiento = tieneConsentimiento(sesion?.perfil);
  const desactualizado = consentimientoDesactualizado(sesion?.perfil);
  const params = await searchParams;
  const modoScan = modoDesdeIndicadorScan(params.desde, params.modo);

  return (
    <div className="flex flex-1 flex-col">
      <main className="contenedor flex-1 py-10">
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
            {!desactualizado && modoScan && (
              <div
                role="status"
                className="rounded-2xl border border-emerald-200 bg-emerald-50 px-5 py-4 text-sm leading-6 text-emerald-900 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-200"
              >
                ¡Listo! Último paso: escanea de nuevo el QR de{" "}
                <strong>{modoScan === "entrada" ? "entrada" : "salida"}</strong> para
                marcar tu asistencia.
              </div>
            )}
            <div className="rounded-2xl border border-zinc-200 p-6 dark:border-zinc-800">
              <h2 className="text-lg font-semibold">
                Hola{sesion.usuario.email ? `, ${sesion.usuario.email}` : ""}
              </h2>
              <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
                Sesión iniciada. Rol:{" "}
                <span className="font-medium text-tinta">
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
    </div>
  );
}

