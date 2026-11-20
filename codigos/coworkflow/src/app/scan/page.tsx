import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { QrCode } from "lucide-react";

import { ConfirmacionScan } from "@/components/scan/ConfirmacionScan";
import { loginDesdeScan, portadaDesdeScan } from "@/lib/auth/redirects";
import { obtenerSesion } from "@/lib/auth/session";
import { tieneConsentimiento } from "@/lib/dominio/consentimiento";
import { textoEstadoHorario } from "@/lib/dominio/tiempo";
import { obtenerScanPendiente, TOKEN_SCAN_PENDIENTE } from "@/lib/scan/pendiente";
import { obtenerZonaPorId } from "@/lib/supabase/zonas";
import { esquemaQueryScan } from "@/lib/validacion/scan";

export const metadata: Metadata = {
  title: "Marcar asistencia",
  // Página con un token de vida corta en la URL (ventana de ~90 s, reutilizable dentro de ella): fuera de índices y sin ruta completa en el Referer (el proxy fija un valor global más laxo para el resto del sitio).
  robots: { index: false, follow: false },
  referrer: "strict-origin",
};

type Props = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

type DatosToken = {
  zonaId: string;
  modo: "entrada" | "salida" | null;
};

/**
 * Partes útiles del token firmado (`v1.<zona_uuid>.<modo>.<ventana>.<firma>`).
 *
 * Solo se usan para presentación: `zonaId` elige qué zona mostrar y `modo` la etiqueta del
 * botón. La operación real la decide la RPC al verificar la firma, así que un token
 * manipulado puede mostrar "entrada" y aun así ser rechazado. Si el token no tiene la forma
 * esperada se devuelve `null` y la pantalla queda neutra.
 */
function datosDelToken(token: string): DatosToken | null {
  const partes = token.split(".");
  if (partes.length !== 5 || partes[0] !== "v1") return null;
  const modo =
    partes[2] === "entrada" || partes[2] === "salida" ? partes[2] : null;
  return { zonaId: partes[1], modo };
}

/**
 * Hora local `HH:MM` en la zona (`es-CL`, ciclo h23) para la tarjeta de confirmación.
 * Devuelve `null` si la zona horaria no es válida: la pantalla omite la hora en vez de
 * inventarla.
 */
function horaLocalEnTexto(ahora: Date, timezone: string): string | null {
  try {
    return new Intl.DateTimeFormat("es-CL", {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone: timezone,
    }).format(ahora);
  } catch {
    return null;
  }
}

/**
 * GET solo muestra la confirmación. Sin sesión/consentimiento, un Route Handler conserva
 * un QR válido durante el alta (S-48). Nunca se registra asistencia antes del POST.
 */
export default async function PaginaScan({ searchParams }: Props) {
  const params = await searchParams;

  const error = typeof params.error === "string" ? params.error : null;
  const validado = esquemaQueryScan.safeParse({
    t: params.t,
    modo: params.modo,
  });
  const pendiente = !params.t && !error ? await obtenerScanPendiente() : null;
  const token = !error && validado.success
    ? validado.data.t
    : pendiente ? TOKEN_SCAN_PENDIENTE : null;
  const datos = pendiente ?? (validado.success ? datosDelToken(validado.data.t) : null);
  const sesion = await obtenerSesion();
  if (token) {
    if (validado.success && (!sesion || !tieneConsentimiento(sesion.perfil))) {
      redirect(`/auth/scan?t=${encodeURIComponent(validado.data.t)}`);
    }
    if (!sesion) redirect(datos?.modo ? loginDesdeScan(datos.modo) : "/login");
    if (!tieneConsentimiento(sesion.perfil)) {
      redirect(datos?.modo ? portadaDesdeScan(datos.modo) : "/");
    }
  }

  // Solo para presentación: el marcador "pendiente" nunca permite elegir zona o modo.
  const zona = datos ? await obtenerZonaPorId(datos.zonaId) : null;
  const ahora = new Date();
  const horaLocal = zona ? horaLocalEnTexto(ahora, zona.timezone) : null;
  const textoFueraHorario = zona ? textoEstadoHorario(zona, ahora) : null;

  return (
    <div className="flex flex-1 flex-col">
      <main className="mx-auto w-full max-w-md flex-1 px-5 py-10 md:px-8">
        {token ? (
          <ConfirmacionScan
            token={token}
            modo={datos?.modo ?? null}
            nombreZona={zona?.nombre ?? null}
            horaLocal={horaLocal}
            textoFueraHorario={textoFueraHorario}
          />
        ) : (
          <div className="tarjeta text-center">
            <span className="mx-auto grid size-14 place-items-center rounded-full bg-moderado-fondo text-moderado-texto">
              <QrCode aria-hidden className="size-7" />
            </span>
            <h1 className="mt-4 text-xl font-semibold tracking-tight">
              {error === "servicio" ? "No pudimos conservar el escaneo"
                : error === "limite" ? "Demasiados intentos"
                : "El escaneo no está disponible"}
            </h1>
            <p className="mt-2 text-sm leading-6 text-tenue">
              {error === "servicio" ? "Espera unos segundos y vuelve a escanear el QR."
                : error === "limite" ? "Espera un minuto antes de volver a escanear."
                : "El escaneo pudo haber vencido. Vuelve a escanear el QR de entrada o salida."}
            </p>
            <Link href="/" className="btn-secundario mt-5 w-full">
              Volver al inicio
            </Link>
          </div>
        )}
      </main>
    </div>
  );
}
