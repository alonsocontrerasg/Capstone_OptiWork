import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { QrCode } from "lucide-react";

import { ConfirmacionScan } from "@/components/scan/ConfirmacionScan";
import { loginDesdeScan, portadaDesdeScan } from "@/lib/auth/redirects";
import { obtenerSesion } from "@/lib/auth/session";
import { tieneConsentimiento } from "@/lib/dominio/consentimiento";
import { textoEstadoHorario } from "@/lib/dominio/tiempo";
import { obtenerZonaPorId } from "@/lib/supabase/zonas";
import { esquemaModoScan, esquemaQueryScan } from "@/lib/validacion/scan";

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

/** Modo de `?modo=` validado con el enum cerrado; si no es un string válido, `null`. */
function modoDeParametro(
  valor: string | string[] | undefined,
): "entrada" | "salida" | null {
  if (typeof valor !== "string") return null;
  const parseado = esquemaModoScan.safeParse(valor);
  return parseado.success ? parseado.data : null;
}

/**
 * `/scan` — confirmación del escaneo del QR (S-15, S-16, S-33, S-46).
 *
 * Este GET **no muta nada**: valida la sesión, el consentimiento y la forma del token, y
 * muestra la confirmación. La escritura ocurre en `POST /api/scan`, así que seguir el enlace
 * (o que un preview lo abra) no registra asistencia.
 *
 * Para la presentación se hace **una** lectura pública de `zonas` con el `zona_uuid` del
 * token (nombre, hora local y estado del horario): el id se valida como UUID antes de
 * consultar y el resultado no autoriza nada (S-46).
 *
 * Sin sesión se redirige a `/login?desde=scan&modo=<entrada|salida>` (o a `/login` si el
 * modo no es válido) **sin el token**: la URL de login no debe llevar el token en el
 * historial ni en los logs del servidor. Lo mismo al volver a la portada por falta de
 * consentimiento. El indicador solo alimenta los mensajes de "vuelve a escanear".
 */
export default async function PaginaScan({ searchParams }: Props) {
  const params = await searchParams;

  // Solo `?modo=` (enum cerrado) alimenta el indicador de transición: en estas ramas no se
  // lee `params.t`. Si falta o es inválido, los redirects quedan exactamente como antes.
  const modoTransicion = modoDeParametro(params.modo);

  const sesion = await obtenerSesion();
  if (!sesion) {
    redirect(modoTransicion ? loginDesdeScan(modoTransicion) : "/login");
  }
  if (!tieneConsentimiento(sesion.perfil)) {
    redirect(modoTransicion ? portadaDesdeScan(modoTransicion) : "/");
  }

  const validado = esquemaQueryScan.safeParse({
    t: params.t,
    modo: params.modo,
  });

  // La zona solo se consulta con el `zona_uuid` de un token con forma esperada.
  // `obtenerZonaPorId` vuelve a validar que sea UUID antes de consultar (S-46): si no lo es,
  // devuelve `null` sin tocar Supabase.
  const datos = validado.success ? datosDelToken(validado.data.t) : null;
  const zona = datos ? await obtenerZonaPorId(datos.zonaId) : null;
  const ahora = new Date();
  const horaLocal = zona ? horaLocalEnTexto(ahora, zona.timezone) : null;
  const textoFueraHorario = zona ? textoEstadoHorario(zona, ahora) : null;

  return (
    <div className="flex flex-1 flex-col">
      <main className="mx-auto w-full max-w-md flex-1 px-5 py-10 md:px-8">
        {validado.success ? (
          <ConfirmacionScan
            token={validado.data.t}
            modo={datos?.modo ?? validado.data.modo ?? null}
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
              Este enlace no incluye un QR
            </h1>
            <p className="mt-2 text-sm leading-6 text-tenue">
              Vuelve a escanear el QR de entrada o salida con la cámara de tu celular.
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
