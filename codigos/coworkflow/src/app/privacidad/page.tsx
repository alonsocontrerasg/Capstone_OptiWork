import type { Metadata } from "next";

import {
  CONSENTIMIENTO_FECHA,
  CONSENTIMIENTO_VERSION,
  SECCIONES_AVISO,
} from "@/lib/dominio/consentimiento";

export const metadata: Metadata = { title: "Aviso de privacidad" };

/**
 * `/privacidad` — texto completo del aviso de consentimiento (Ley 21.719).
 *
 * Es la fuente que enlaza la tarjeta de consentimiento («Leer el aviso completo»). El texto
 * no se duplica: se renderiza desde `SECCIONES_AVISO` en `src/lib/dominio/consentimiento.ts`,
 * así sigue disponible antes de aceptar y se versiona en un solo lugar.
 */
export default function PaginaPrivacidad() {
  return (
    <div className="flex flex-1 flex-col">
      <main className="mx-auto w-full max-w-2xl flex-1 px-5 py-10 md:px-8">
        <h1 className="text-2xl font-semibold tracking-tight">Aviso de privacidad</h1>
        <p className="mt-1 text-xs text-tenue">
          Versión {CONSENTIMIENTO_VERSION} · {CONSENTIMIENTO_FECHA}
        </p>

        <div className="tarjeta mt-6">
          <dl className="space-y-5">
            {SECCIONES_AVISO.map((seccion) => (
              <div key={seccion.titulo}>
                <dt className="text-sm font-semibold">{seccion.titulo}</dt>
                <dd className="mt-1 text-sm leading-6 text-tenue">
                  {seccion.texto}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </main>
    </div>
  );
}
