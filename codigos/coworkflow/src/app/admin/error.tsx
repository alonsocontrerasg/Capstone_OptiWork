"use client";
export default function ErrorAdmin({ reset }: { reset: () => void }) {
  return <main className="contenedor py-12"><div className="tarjeta mx-auto max-w-md"><h1 className="text-xl font-semibold">No pudimos cargar la administración</h1><p className="mt-3 text-sm text-tenue">Comprueba tu conexión e inténtalo de nuevo.</p><button className="btn-primario mt-5" onClick={reset}>Reintentar</button></div></main>;
}
