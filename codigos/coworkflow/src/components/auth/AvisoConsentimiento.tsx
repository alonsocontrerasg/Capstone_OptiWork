"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Clock, ShieldCheck, Trash2, Users, type LucideIcon } from "lucide-react";
import { useState } from "react";

import { RESUMEN_AVISO } from "@/lib/dominio/consentimiento";

type Props = {
  version: number;
  fecha: string;
  /** Fecha ISO de una aceptación previa (para mostrar o para avisar de una versión nueva). */
  aceptadoAt: string | null;
  requiereAceptacion: boolean;
};

/** Íconos de los tres puntos resumen, en el mismo orden que `RESUMEN_AVISO`. */
const ICONOS_RESUMEN: readonly LucideIcon[] = [Clock, Users, Trash2];

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
    <div className="tarjeta">
      <h2 className="text-lg font-semibold">
        {actualizacion ? "Actualizamos el aviso" : "Antes de empezar"}
      </h2>
      <p className="mt-1 text-xs text-tenue">
        Versión {version} · {fecha}
      </p>

      {actualizacion && (
        <p className="mt-4 rounded-xl bg-moderado-fondo px-4 py-3 text-sm text-moderado-texto">
          Actualizamos el aviso. Acepta la versión {version} para seguir marcando tu
          asistencia.
        </p>
      )}

      <ul className="mt-5 space-y-3">
        {RESUMEN_AVISO.map((texto, indice) => {
          const Icono = ICONOS_RESUMEN[indice] ?? ShieldCheck;
          return (
            <li key={texto} className="flex items-start gap-3 text-sm leading-6">
              <Icono aria-hidden className="mt-0.5 size-5 shrink-0 text-marca" />
              <span>{texto}</span>
            </li>
          );
        })}
      </ul>

      <Link
        href="/privacidad"
        className="foco-marca mt-4 inline-flex min-h-11 items-center text-sm font-medium text-marca underline underline-offset-4"
      >
        Leer el aviso completo
      </Link>

      {requiereAceptacion ? (
        <div className="mt-6 border-t border-borde pt-5">
          <label className="flex items-start gap-3 text-sm leading-6">
            <input
              type="checkbox"
              checked={marcado}
              onChange={(evento) => setMarcado(evento.target.checked)}
              className="mt-1 size-4 shrink-0 rounded border-borde accent-marca"
            />
            <span>
              He leído el aviso y acepto que se registren mis horas de entrada y salida con
              los fines descritos.
            </span>
          </label>

          <p className="mt-3 text-xs text-tenue">
            Si no aceptas, no podrás marcar entrada ni salida. El panel público sigue
            disponible sin aceptar nada.
          </p>

          <button
            type="button"
            onClick={aceptar}
            disabled={!marcado || enviando}
            className="btn-primario mt-4 w-full disabled:cursor-not-allowed disabled:opacity-40"
          >
            {enviando ? "Registrando…" : "Acepto y continúo"}
          </button>

          <p aria-live="polite" className="mt-3 text-sm text-lleno-texto">
            {error}
          </p>
        </div>
      ) : (
        <p className="mt-5 text-sm text-bajo-texto">
          Consentimiento vigente (versión {version}).
        </p>
      )}
    </div>
  );
}
