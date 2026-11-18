import Link from "next/link";

export function Pie() {
  return (
    <footer className="border-t border-borde bg-superficie">
      <div className="contenedor flex flex-wrap items-center justify-between gap-2 py-4 text-xs text-tenue">
        <span>Solo mostramos totales, nunca nombres.</span>
        <Link
          href="/privacidad"
          className="foco-marca inline-flex min-h-11 items-center rounded-xl px-2 font-medium text-tenue transition-colors hover:text-tinta"
        >
          Privacidad
        </Link>
      </div>
    </footer>
  );
}
