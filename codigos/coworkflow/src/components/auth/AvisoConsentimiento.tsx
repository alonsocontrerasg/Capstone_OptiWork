"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import type { SeccionAviso } from "@/lib/dominio/consentimiento";

type Props = {
  version: number;
  fecha: string;
  secciones: readonly SeccionAviso[];
  /** Fecha ISO de una aceptación previa (para mostrar o para avisar de una versión nueva). */
  aceptadoAt: string | null;
  requiereAceptacion: boolean;
};

/**
 * Aviso de consentimiento (Ley 21.719).
 *
 * La aceptación viaja a `POST /api/consentimiento`, que llama a la RPC
 * `registrar_consentimiento`. No se escribe `profiles` desde el cliente (RLS lo impediría:
 * la tabla no tiene política de UPDATE): S-01 y S-25.
 */
export function AvisoConsentimiento({
  version,
  fecha,
  secciones,
  aceptadoAt,
  requiereAceptacion,
}: Props) {
  const router = useRouter();
  const [marcado, setMarcado] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const actualizacion = Boolean(aceptadoAt) && requiereAceptacion;

  async function aceptar() {
    setError(null);
    setEnviando(true);
    try {
      const respuesta = await fetch("/api/consentimiento", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version }),
      });

      if (!respuesta.ok) {
        setError(
          "No pudimos registrar tu aceptación. Recarga la página e inténtalo otra vez.",
        );
        return;
      }

      // El servidor ya guardó el consentimiento: se vuelve a pedir la página para que el
      // Server Component lea el perfil actualizado.
      router.refresh();
    } catch {
      setError("Sin conexión. Revisa tu red e inténtalo de nuevo.");
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div className="rounded-2xl border border-zinc-200 p-6 dark:border-zinc-800">
      <h2 className="text-lg font-semibold">Aviso de privacidad</h2>
      <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
        Versión {version} · {fecha}
      </p>

      {actualizacion && (
        <p className="mt-4 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          Actualizamos el aviso. Acepta la versión {version} para seguir marcando tu
          asistencia.
        </p>
      )}

      <dl className="mt-5 space-y-4">
        {secciones.map((seccion) => (
          <div key={seccion.titulo}>
            <dt className="text-sm font-medium">{seccion.titulo}</dt>
            <dd className="mt-1 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
              {seccion.texto}
            </dd>
          </div>
        ))}
      </dl>

      {requiereAceptacion ? (
        <div className="mt-6 border-t border-zinc-200 pt-5 dark:border-zinc-800">
          <label className="flex items-start gap-3 text-sm leading-6">
            <input
              type="checkbox"
              checked={marcado}
              onChange={(evento) => setMarcado(evento.target.checked)}
              className="mt-1 size-4 shrink-0 rounded border-zinc-400"
            />
            <span>
              He leído el aviso y acepto que se registren mis horas de entrada y salida con
              los fines descritos.
            </span>
          </label>

          <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
            Si no aceptas, no podrás marcar entrada ni salida. El dashboard público sigue
            disponible sin aceptar nada.
          </p>

          <button
            type="button"
            onClick={aceptar}
            disabled={!marcado || enviando}
            className="mt-4 rounded-full bg-zinc-900 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            {enviando ? "Registrando…" : "Acepto y continúo"}
          </button>

          <p aria-live="polite" className="mt-3 text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        </div>
      ) : (
        <p className="mt-5 text-sm text-emerald-700 dark:text-emerald-400">
          Consentimiento vigente (versión {version}).
        </p>
      )}
    </div>
  );
}
