"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { MENSAJE_ERROR_SCAN } from "@/lib/dominio/scan";

type Modo = "entrada" | "salida" | null;

type Props = {
  /** Token recibido por props desde el servidor: nunca se lee de `window.location`. */
  token: string;
  /** Modo leído del token firmado; `null` si no se pudo interpretar. Solo afecta etiquetas. */
  modo: Modo;
};

type Interpretacion = {
  ok: boolean;
  mensaje: string;
  requiereLogin: boolean;
};

/** Códigos que devuelve `POST /api/scan` cuando el fallo ocurre antes del dominio. */
function mensajeDeError(codigo: string): string {
  switch (codigo) {
    case "no_autenticado":
      return "Tu sesión venció. Inicia sesión y escanea el código otra vez.";
    case "datos_invalidos":
      return "El código QR no es válido. Escanéalo otra vez.";
    default:
      return MENSAJE_ERROR_SCAN;
  }
}

/**
 * Interpreta la respuesta sin confiar en su forma: una guarda, un proxy o un 500 pueden
 * devolver HTML o un JSON distinto. Solo se acepta `{ ok: boolean, mensaje: string }` o
 * `{ error: string }`; cualquier otra cosa cae al mensaje genérico.
 */
async function interpretarRespuesta(
  respuesta: Response,
): Promise<Interpretacion> {
  let cuerpo: unknown;
  try {
    cuerpo = await respuesta.json();
  } catch {
    return { ok: false, mensaje: MENSAJE_ERROR_SCAN, requiereLogin: false };
  }
  if (typeof cuerpo !== "object" || cuerpo === null) {
    return { ok: false, mensaje: MENSAJE_ERROR_SCAN, requiereLogin: false };
  }

  const datos = cuerpo as Record<string, unknown>;
  if (typeof datos.ok === "boolean" && typeof datos.mensaje === "string") {
    return {
      ok: datos.ok,
      mensaje: datos.mensaje,
      requiereLogin: datos.resultado === "no_autenticado",
    };
  }
  if (typeof datos.error === "string") {
    return {
      ok: false,
      mensaje: mensajeDeError(datos.error),
      requiereLogin: datos.error === "no_autenticado",
    };
  }
  return { ok: false, mensaje: MENSAJE_ERROR_SCAN, requiereLogin: false };
}

function etiquetaBoton(modo: Modo): string {
  if (modo === "entrada") return "Confirmar entrada";
  if (modo === "salida") return "Confirmar salida";
  return "Confirmar asistencia";
}

/**
 * Confirmación explícita del escaneo.
 *
 * El POST no se dispara al cargar la página: cualquiera puede abrir el enlace (o un
 * antivirus/preview seguirlo), así que la escritura ocurre solo cuando la persona toca el
 * botón. Lo único que se hace al montar es quitar el token de la barra de direcciones, para
 * que no quede en el historial ni se reenvíe al recargar. La operación registrada la decide
 * el token firmado, no esta pantalla.
 */
export function ConfirmacionScan({ token, modo }: Props) {
  const [enviando, setEnviando] = useState(false);
  const [resultado, setResultado] = useState<Interpretacion | null>(null);

  // Al montar: la URL pasa a ser `/scan` sin el token. Las props conservan el token para
  // reintentar el POST, así que limpiar la barra de direcciones no rompe nada. El token sigue
  // siendo válido hasta que venza su ventana; el cooldown de la RPC evita duplicados.
  useEffect(() => {
    try {
      window.history.replaceState(null, "", "/scan");
    } catch {
      // Algunos navegadores/modos restringen `replaceState`; la ventana corta del QR limita
      // la exposición si no se puede limpiar la URL.
    }
  }, []);

  async function confirmar() {
    if (enviando || resultado?.ok) return;
    setEnviando(true);
    setResultado(null);

    let respuesta: Response;
    try {
      respuesta = await fetch("/api/scan", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ t: token }),
      });
    } catch {
      setEnviando(false);
      setResultado({ ok: false, mensaje: MENSAJE_ERROR_SCAN, requiereLogin: false });
      return;
    }

    const interpretado = await interpretarRespuesta(respuesta);
    setEnviando(false);
    setResultado(interpretado);
  }

  const listo = resultado?.ok === true;

  return (
    <div className="rounded-2xl border border-zinc-200 p-6 dark:border-zinc-800">
      <h1 className="text-xl font-semibold">
        {listo ? "Listo" : "Confirma tu asistencia"}
      </h1>
      <p className="mt-2 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
        {listo
          ? "Puedes cerrar esta pantalla."
          : "Revisa que estás en el cowork y confirma. No se registra nada hasta que toques el botón."}
      </p>

      {!listo && (
        <button
          type="button"
          onClick={confirmar}
          disabled={enviando}
          className="mt-5 w-full rounded-full bg-zinc-900 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          {enviando ? "Registrando…" : etiquetaBoton(modo)}
        </button>
      )}

      <p
        aria-live="polite"
        className={`mt-4 text-sm ${
          resultado
            ? resultado.ok
              ? "text-emerald-700 dark:text-emerald-400"
              : "text-red-600 dark:text-red-400"
            : "text-zinc-500 dark:text-zinc-400"
        }`}
      >
        {resultado?.mensaje ?? ""}
      </p>

      {listo && (
        <Link
          href="/"
          className="mt-2 inline-flex rounded-full border border-zinc-300 px-4 py-2 text-sm font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
        >
          Volver al inicio
        </Link>
      )}

      {resultado?.requiereLogin && !listo && (
        <Link
          href="/login"
          className="mt-2 inline-block text-sm font-medium underline"
        >
          Iniciar sesión
        </Link>
      )}
    </div>
  );
}
