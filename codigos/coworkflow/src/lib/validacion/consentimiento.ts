import { z } from "zod";

import { CONSENTIMIENTO_VERSION } from "@/lib/dominio/consentimiento";

/**
 * `POST /api/consentimiento` con `{ version }`.
 *
 * La versión se compara con la vigente en el dominio: aceptar una versión distinta a la
 * que se mostró en pantalla registraría un consentimiento que la persona no leyó.
 */
export const esquemaCuerpoConsentimiento = z.object({
  version: z.literal(CONSENTIMIENTO_VERSION),
});

export type CuerpoConsentimiento = z.infer<typeof esquemaCuerpoConsentimiento>;
