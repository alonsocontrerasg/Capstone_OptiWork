"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Props = {
  /** Slug de la zona. */
  zona: string;
  modo: "entrada" | "salida";
  nombreZona: string;
};

type RespuestaQr = {
  svg: string;
  token: string;
  ventana: number;
  expiraEnSegundos: number;
  url: string;
};

const ETIQUETA: Record<Props["modo"], string> = {
  entrada: "Entrada",
  salida: "Salida",
};

/**
 * Muestra el QR de un modo (entrada o salida) y lo renueva solo.
 *
 * El cliente pide `GET /api/qr/token` cada vez que la ventana está por vencer; el servidor
 * firma con HMAC y devuelve el SVG. El token nunca se arma en el navegador y la clave HMAC
 * jamás sale del servidor (S-26).
 */
export function QrRotativo({ zona, modo, nombreZona }: Props) {
  const [datos, setDatos] = useState<RespuestaQr | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restante, setRestante] = useState(0);

  const expiraRef = useRef(0);
  const enVueloRef = useRef(false);
  const montadoRef = useRef(true);

  const cargar = useCallback(async () => {
    if (enVueloRef.current) return;
    enVueloRef.current = true;

    try {
      const respuesta = await fetch(
        `/api/qr/token?zona=${encodeURIComponent(zona)}&modo=${modo}`,
        { cache: "no-store" },
      );

      if (!respuesta.ok) {
        if (!montadoRef.current) return;
        setError(
          respuesta.status === 403
            ? "Tu cuenta no tiene permisos de administrador."
            : "No pudimos generar el QR. Reintentando…",
        );
        return;
      }

      const cuerpo = (await respuesta.json()) as RespuestaQr;
      if (!montadoRef.current) return;

      expiraRef.current = Date.now() + cuerpo.expiraEnSegundos * 1000;
      setDatos(cuerpo);
      setRestante(cuerpo.expiraEnSegundos);
      setError(null);
    } catch {
      if (montadoRef.current) setError("Sin conexión. Reintentando…");
    } finally {
      enVueloRef.current = false;
    }
  }, [zona, modo]);

  useEffect(() => {
    montadoRef.current = true;
    // Carga inicial: sincroniza con un sistema externo (la API del QR). Los setState de
    // `cargar` ocurren después del `await fetch`, no de forma síncrona en el efecto.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void cargar();

    const temporizador = window.setInterval(() => {
      if (expiraRef.current === 0) return;
      const faltan = Math.max(
        0,
        Math.ceil((expiraRef.current - Date.now()) / 1000),
      );
      setRestante(faltan);
      // Se renueva un segundo antes de vencer: el servidor acepta la ventana actual y la
      // anterior, así que un pequeño desfase no invalida el QR mostrado.
      if (faltan <= 1) void cargar();
    }, 1000);

    // Al volver a la pestaña (o desbloquear el celular) el token puede estar vencido.
    const alVolver = () => {
      if (document.visibilityState === "visible") void cargar();
    };
    document.addEventListener("visibilitychange", alVolver);

    return () => {
      montadoRef.current = false;
      window.clearInterval(temporizador);
      document.removeEventListener("visibilitychange", alVolver);
    };
  }, [cargar]);

  return (
    <section
      aria-label={`QR de ${ETIQUETA[modo].toLowerCase()} de ${nombreZona}`}
      className="flex flex-col items-center rounded-2xl border border-zinc-200 p-5 dark:border-zinc-800"
    >
      <h2 className="text-base font-semibold">
        {ETIQUETA[modo]} · {nombreZona}
      </h2>

      <div className="mt-4 grid size-64 place-items-center rounded-xl bg-white p-2 sm:size-72">
        {datos ? (
          <div
            role="img"
            aria-label={`Código QR para registrar ${ETIQUETA[modo].toLowerCase()}`}
            className="size-full [&>svg]:size-full"
            dangerouslySetInnerHTML={{ __html: datos.svg }}
          />
        ) : (
          <p className="text-sm text-zinc-500">
            {error ?? "Generando QR…"}
          </p>
        )}
      </div>

      <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400" aria-live="polite">
        {datos
          ? `Se renueva en ${restante} s`
          : "El QR cambia cada pocos segundos"}
      </p>

      {error && datos && (
        <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p>
      )}

      <button
        type="button"
        onClick={() => void cargar()}
        className="mt-3 rounded-full border border-zinc-300 px-4 py-1.5 text-xs font-medium transition-colors hover:bg-zinc-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900 dark:border-zinc-700 dark:hover:bg-zinc-900"
      >
        Actualizar ahora
      </button>
    </section>
  );
}
