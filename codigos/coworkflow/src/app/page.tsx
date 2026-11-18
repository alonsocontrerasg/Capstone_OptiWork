import Link from "next/link";
import { LayoutDashboard, QrCode } from "lucide-react";

import { AvisoConsentimiento } from "@/components/auth/AvisoConsentimiento";
import { obtenerSesion } from "@/lib/auth/session";
import {
  CONSENTIMIENTO_FECHA,
  CONSENTIMIENTO_VERSION,
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
        {!sesion && (
          <>
            <h1 className="text-3xl font-semibold tracking-tight">
              Ocupación del cowork en tiempo real
            </h1>
            <p className="mt-3 max-w-2xl text-base leading-7 text-tenue">
              Escanea el QR de entrada o salida con la cámara de tu celular. El panel
              público muestra solo cifras agregadas: nunca tu nombre ni tus horarios.
            </p>

            <section className="mx-auto mt-8 max-w-md">
              <div className="tarjeta">
                <span className="grid size-12 place-items-center rounded-2xl bg-marca-suave text-marca">
                  <QrCode aria-hidden className="size-6" />
                </span>
                <h2 className="mt-4 text-lg font-semibold">
                  Entra para marcar tu asistencia
                </h2>
                <p className="mt-1 text-sm leading-6 text-tenue">
                  Usa tu contraseña o un enlace por correo. La primera vez verás el aviso
                  de privacidad (Ley 21.719).
                </p>
                <Link href="/login" className="btn-primario mt-5 w-full">
                  Iniciar sesión
                </Link>
                <Link href="/dashboard" className="btn-secundario mt-2 w-full">
                  Ver la ocupación
                </Link>
              </div>
            </section>
          </>
        )}

        {sesion && !conConsentimiento && (
          <>
            <h1 className="text-2xl font-semibold tracking-tight">
              Un paso antes de empezar
            </h1>
            <p className="mt-1 text-sm text-tenue">
              Necesitamos tu consentimiento para registrar entradas y salidas.
            </p>
            <section className="mx-auto mt-6 max-w-md">
              <AvisoConsentimiento
                version={CONSENTIMIENTO_VERSION}
                fecha={CONSENTIMIENTO_FECHA}
                aceptadoAt={null}
                requiereAceptacion
              />
            </section>
          </>
        )}

        {sesion && conConsentimiento && (
          <>
            <h1 className="text-2xl font-semibold tracking-tight">Hola</h1>
            <p className="mt-1 text-sm text-tenue">
              {sesion.usuario.email ?? "Sesión iniciada"}
            </p>

            <section className="mx-auto mt-6 max-w-md space-y-4">
              {!desactualizado && modoScan && (
                <div role="status" className="rounded-3xl bg-marca p-6 text-white">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs font-semibold uppercase tracking-wide text-white/80">
                      Último paso
                    </span>
                    <span className="flex items-center gap-2">
                      <span aria-hidden className="flex gap-1">
                        <span className="h-1.5 w-6 rounded-full bg-white" />
                        <span className="h-1.5 w-6 rounded-full bg-white" />
                      </span>
                      <span className="text-xs font-medium text-white/80">
                        Paso 2 de 2
                      </span>
                    </span>
                  </div>

                  <QrCode aria-hidden className="mt-5 size-16" />
                  <h2 className="mt-4 text-xl font-semibold tracking-tight">
                    Escanea de nuevo el QR de{" "}
                    {modoScan === "entrada" ? "ENTRADA" : "SALIDA"}
                  </h2>
                  <p className="mt-2 text-sm leading-6 text-white/90">
                    Está en la pantalla del acceso.
                  </p>
                  <p className="mt-4 text-xs text-white/80">Solo la primera vez.</p>
                </div>
              )}

              <div className="tarjeta">
                <h2 className="text-base font-semibold">Accesos rápidos</h2>
                <div className="mt-4 space-y-2">
                  <Link href="/dashboard" className="btn-primario w-full">
                    <LayoutDashboard aria-hidden className="mr-2 size-4" />
                    Ver la ocupación
                  </Link>
                  {sesion.perfil?.rol === "admin" && (
                    <Link href="/qr" className="btn-secundario w-full">
                      <QrCode aria-hidden className="mr-2 size-4" />
                      Abrir el QR rotativo
                    </Link>
                  )}
                </div>
                <p className="mt-4 text-xs leading-5 text-tenue">
                  Para marcar tu asistencia, escanea el QR del acceso con la cámara del
                  celular.
                </p>
              </div>

              {desactualizado ? (
                <AvisoConsentimiento
                  version={CONSENTIMIENTO_VERSION}
                  fecha={CONSENTIMIENTO_FECHA}
                  aceptadoAt={sesion.perfil?.consentimiento_at ?? null}
                  requiereAceptacion
                />
              ) : (
                <p className="text-xs leading-5 text-tenue">
                  Consentimiento versión{" "}
                  {sesion.perfil?.consentimiento_version ?? "—"} aceptado el{" "}
                  {formatearFecha(sesion.perfil?.consentimiento_at ?? null) ?? "—"}.{" "}
                  <Link
                    href="/privacidad"
                    className="font-medium text-marca underline underline-offset-4"
                  >
                    Ver el aviso
                  </Link>
                </p>
              )}
            </section>
          </>
        )}
      </main>
    </div>
  );
}

