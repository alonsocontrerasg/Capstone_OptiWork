import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { ConfirmacionScan } from "@/components/scan/ConfirmacionScan";
import { loginDesdeScan, portadaDesdeScan } from "@/lib/auth/redirects";
import { obtenerSesion } from "@/lib/auth/session";
import { tieneConsentimiento } from "@/lib/dominio/consentimiento";
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

/**
 * Modo según el token firmado (`v1.<zona_uuid>.<modo>.<ventana>.<firma>`).
 *
 * Solo se usa para la etiqueta del botón: la operación real la decide la RPC al verificar
 * la firma, así que un token manipulado puede mostrar "entrada" y aun así ser rechazado.
 * Si el token no tiene la forma esperada se devuelve `null` y la etiqueta queda neutra.
 */
function modoDelToken(token: string): "entrada" | "salida" | null {
  const partes = token.split(".");
  if (partes.length !== 5 || partes[0] !== "v1") return null;
  if (partes[2] === "entrada" || partes[2] === "salida") return partes[2];
  return null;
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
 * `/scan` — confirmación del escaneo del QR (S-15, S-16, S-33).
 *
 * Este GET **no muta nada**: solo valida la sesión, el consentimiento y la forma del
 * token, y muestra el botón de confirmación. La escritura ocurre en `POST /api/scan`, así
 * que seguir el enlace (o que un preview lo abra) no registra asistencia.
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

  return (
    <div className="flex flex-1 flex-col">
      <main className="mx-auto w-full max-w-md flex-1 px-5 py-10 md:px-8">
        {validado.success ? (
          <ConfirmacionScan
            token={validado.data.t}
            modo={modoDelToken(validado.data.t) ?? validado.data.modo ?? null}
          />
        ) : (
          <div className="rounded-2xl border border-dashed border-zinc-300 p-6 dark:border-zinc-700">
            <h1 className="text-lg font-semibold">Código no válido</h1>
            <p className="mt-2 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
              Este enlace no incluye un código QR válido. Vuelve a escanear el QR de la
              entrada con la cámara de tu celular.
            </p>
            <Link
              href="/"
              className="mt-4 inline-flex rounded-full border border-zinc-300 px-4 py-2 text-sm font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
            >
              Volver al inicio
            </Link>
          </div>
        )}
      </main>
    </div>
  );
}
