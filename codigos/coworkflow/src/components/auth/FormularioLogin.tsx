"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { crearClienteNavegador } from "@/lib/supabase/browser";

type Modo = "enlace" | "contrasena" | "registro";

type Props = {
  /** Ruta interna a la que volver después de iniciar sesión (ya saneada en el servidor). */
  destino: string;
  mensajeInicial?: string | null;
};

/** Traduce códigos de Supabase Auth a mensajes en español sin filtrar detalles internos. */
function traducirError(codigo: string | undefined): string {
  switch (codigo) {
    case "invalid_credentials":
      return "Correo o contraseña incorrectos.";
    case "email_not_confirmed":
      return "Primero confirma tu correo: revisa el enlace que te enviamos.";
    case "over_email_send_rate_limit":
    case "over_request_rate_limit":
      return "Demasiados intentos seguidos. Espera unos minutos y vuelve a probar.";
    case "user_already_exists":
    case "email_exists":
      return "Ya existe una cuenta con ese correo. Inicia sesión.";
    case "weak_password":
      return "La contraseña es demasiado débil: usa al menos 8 caracteres.";
    case "signup_disabled":
      return "El registro está deshabilitado en este momento.";
    case "validation_failed":
      return "Revisa el correo y la contraseña ingresados.";
    case "same_password":
      return "La nueva contraseña debe ser distinta de la anterior.";
    default:
      return "No pudimos completar la operación. Inténtalo de nuevo en unos segundos.";
  }
}

export function FormularioLogin({ destino, mensajeInicial = null }: Props) {
  const router = useRouter();
  const [modo, setModo] = useState<Modo>("enlace");
  const [correo, setCorreo] = useState("");
  const [contrasena, setContrasena] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(mensajeInicial);
  const [aviso, setAviso] = useState<string | null>(null);

  function urlDeVuelta(): string {
    return `${window.location.origin}/auth/callback?next=${encodeURIComponent(destino)}`;
  }

  async function manejarEnvio(evento: React.FormEvent<HTMLFormElement>) {
    evento.preventDefault();
    setError(null);
    setAviso(null);
    setEnviando(true);

    const supabase = crearClienteNavegador();
    const email = correo.trim();

    try {
      if (modo === "enlace") {
        const { error: errorAuth } = await supabase.auth.signInWithOtp({
          email,
          options: { emailRedirectTo: urlDeVuelta() },
        });
        if (errorAuth) {
          setError(traducirError(errorAuth.code));
          return;
        }
        setAviso(
          "Te enviamos un enlace de acceso. Ábrelo en este mismo dispositivo para entrar.",
        );
        return;
      }

      if (modo === "contrasena") {
        const { error: errorAuth } = await supabase.auth.signInWithPassword({
          email,
          password: contrasena,
        });
        if (errorAuth) {
          setError(traducirError(errorAuth.code));
          return;
        }
        router.replace(destino);
        router.refresh();
        return;
      }

      const { data, error: errorAuth } = await supabase.auth.signUp({
        email,
        password: contrasena,
        options: { emailRedirectTo: urlDeVuelta() },
      });
      if (errorAuth) {
        setError(traducirError(errorAuth.code));
        return;
      }
      if (data.session) {
        router.replace(destino);
        router.refresh();
        return;
      }
      setAviso(
        "Cuenta creada. Revisa tu correo para confirmarla y luego vuelve a entrar.",
      );
    } catch {
      setError("Sin conexión con el servidor. Revisa tu red e inténtalo de nuevo.");
    } finally {
      setEnviando(false);
    }
  }

  const tituloBoton =
    modo === "enlace"
      ? "Enviarme el enlace"
      : modo === "contrasena"
        ? "Entrar"
        : "Crear cuenta";

  return (
    <div className="rounded-2xl border border-zinc-200 p-6 dark:border-zinc-800">
      <div
        role="tablist"
        aria-label="Forma de acceso"
        className="flex flex-wrap gap-2 text-sm"
      >
        {(
          [
            ["enlace", "Enlace mágico"],
            ["contrasena", "Contraseña"],
            ["registro", "Crear cuenta"],
          ] as const
        ).map(([valor, etiqueta]) => (
          <button
            key={valor}
            type="button"
            role="tab"
            aria-selected={modo === valor}
            onClick={() => {
              setModo(valor);
              setError(null);
              setAviso(null);
            }}
            className={`rounded-full px-4 py-1.5 font-medium transition-colors ${
              modo === valor
                ? "bg-zinc-900 text-white dark:bg-white dark:text-zinc-900"
                : "border border-zinc-300 text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
            }`}
          >
            {etiqueta}
          </button>
        ))}
      </div>

      <form onSubmit={manejarEnvio} className="mt-6 space-y-4">
        <div>
          <label htmlFor="correo" className="text-sm font-medium">
            Correo
          </label>
          <input
            id="correo"
            type="email"
            required
            autoComplete="email"
            inputMode="email"
            value={correo}
            onChange={(evento) => setCorreo(evento.target.value)}
            className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:focus:border-zinc-100"
            placeholder="tu@correo.cl"
          />
        </div>

        {modo !== "enlace" && (
          <div>
            <label htmlFor="contrasena" className="text-sm font-medium">
              Contraseña
            </label>
            <input
              id="contrasena"
              type="password"
              required
              minLength={8}
              autoComplete={modo === "registro" ? "new-password" : "current-password"}
              value={contrasena}
              onChange={(evento) => setContrasena(evento.target.value)}
              className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:focus:border-zinc-100"
              placeholder="Mínimo 8 caracteres"
            />
          </div>
        )}

        <button
          type="submit"
          disabled={enviando}
          className="w-full rounded-full bg-zinc-900 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          {enviando ? "Enviando…" : tituloBoton}
        </button>
      </form>

      <p aria-live="polite" className="mt-4 text-sm text-red-600 dark:text-red-400">
        {error}
      </p>
      <p aria-live="polite" className="mt-2 text-sm text-emerald-700 dark:text-emerald-400">
        {aviso}
      </p>

      <p className="mt-6 text-xs leading-5 text-zinc-500 dark:text-zinc-400">
        El enlace mágico es la vía principal; la contraseña existe como alternativa porque
        el correo del plan gratuito de Supabase tiene un límite bajo de envíos.
      </p>
    </div>
  );
}

