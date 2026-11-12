import { notFound } from "next/navigation";

/**
 * Destino interno del proxy cuando `/dashboard?zona=<slug>` apunta a una zona inexistente
 * o inactiva.
 *
 * `notFound()` se ejecuta antes de cualquier `await` o frontera de Suspense, así que la
 * respuesta conserva un 404 real. La página visible es el `not-found.tsx` raíz; esta ruta
 * no se enlaza desde ninguna parte y no expone datos.
 */
export default function ZonaNoEncontrada() {
  notFound();
}
