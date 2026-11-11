"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { normalizarDestinoInterno } from "@/lib/auth/redirects";
import { PASSWORD_MIN_LENGTH } from "@/lib/dominio/auth";

type Modo = "enlace" | "contrasena" | "registro";

/** Códigos genéricos que devuelve `POST /auth/login` (no exponen detalles de Supabase). */
type CodigoErrorAuth =
  | "credenciales_invalidas"
  | "limite_intentos"
  | "contrasena_debil"
  | "registro_generico"
  | "correo_sin_confirmar"
  | "generico";

/** Respuesta de `POST /auth/login`. */
type RespuestaAuth = {
  ok: boolean;
  codigo?: CodigoErrorAuth;
  redirigir?: string;
  aviso?: string;
};

const MENSAJE_GENERICO =
  "No pudimos completar la operación. Inténtalo de nuevo en unos segundos.";

type Props = {
  /** Ruta interna a la que volver después de iniciar sesión (ya saneada en el servidor). */
  destino: string;
  mensajeInicial?: string | null;
};

/** Traduce los códigos genéricos del servidor a mensajes en español. */
function mensajeDeCodigo(codigo: CodigoErrorAuth): string {
  switch (codigo) {
    case "credenciales_invalidas":
      return "Correo o contraseña incorrectos.";
    case "limite_intentos":
      return "Demasiados intentos seguidos. Espera unos minutos y vuelve a probar.";
    case "contrasena_debil":
      return `La contraseña es demasiado débil: usa al menos ${PASSWORD_MIN_LENGTH} caracteres.`;
    case "correo_sin_confirmar":
      return "Primero confirma tu correo: revisa el enlace que te enviamos.";
    case "registro_generico":
      return "No se pudo completar el registro. Si ya tienes cuenta, inicia sesión o pide un enlace por correo.";
    default:
      return MENSAJE_GENERICO;
  }
}

/**
 * Lee la respuesta de `POST /auth/login` sin confiar en su forma.
 *
 * No todo lo que llega es el JSON del handler: una guarda responde `{ error: ... }`, un proxy
 * devuelve HTML, un 500 puede traer un cuerpo truncado. Solo se acepta un objeto JSON con `ok`
 * booleano; en cualquier otro caso se devuelve `null` y el llamador muestra el mensaje genérico.
 */
async function leerRespuesta(respuesta: Response): Promise<RespuestaAuth | null> {
  let cuerpo: unknown;
  try {
    cuerpo = await respuesta.json();
  } catch {
    return null;
  }

  if (typeof cuerpo !== "object" || cuerpo === null) return null;

  const datos = cuerpo as Record<string, unknown>;
  if (typeof datos.ok !== "boolean") return null;

  return {
    ok: datos.ok,
    codigo:
      typeof datos.codigo === "string" ? (datos.codigo as CodigoErrorAuth) : undefined,
    redirigir: typeof datos.redirigir === "string" ? datos.redirigir : undefined,
    aviso: typeof datos.aviso === "string" ? datos.aviso : undefined,
  };
}

export function FormularioLogin({ destino, mensajeInicial = null }: Props) {
  const router = useRouter();
  const [modo, setModo] = useState<Modo>("enlace");
  const [correo, setCorreo] = useState("");
  const [contrasena, setContrasena] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(mensajeInicial);
  const [aviso, setAviso] = useState<string | null>(null);

  async function manejarEnvio(evento: React.FormEvent<HTMLFormElement>) {
    evento.preventDefault();
    setError(null);
    setAviso(null);
    setEnviando(true);

    const cuerpo: Record<string, string> = {
      accion: modo,
      email: correo.trim(),
      destino,
    };
    if (modo !== "enlace") cuerpo.password = contrasena;

    try {
      const respuesta = await fetch("/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cuerpo),
        credentials: "same-origin",
      });

      const datos = await leerRespuesta(respuesta);

      // 400/403/415/500, HTML de un proxy caído o un cuerpo sin `ok`: todo se degrada al
      // mensaje genérico; el usuario nunca ve detalles internos ni códigos de Supabase.
      if (!datos || !respuesta.ok || datos.ok !== true) {
        setError(datos?.codigo ? mensajeDeCodigo(datos.codigo) : MENSAJE_GENERICO);
        return;
      }

      if (datos.redirigir) {
        // Defensa en profundidad: el servidor ya saneó el destino (S-27).
        router.replace(normalizarDestinoInterno(datos.redirigir));
        router.refresh();
        return;
      }

      if (datos.aviso) setAviso(datos.aviso);
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
              minLength={PASSWORD_MIN_LENGTH}
              autoComplete={modo === "registro" ? "new-password" : "current-password"}
              value={contrasena}
              onChange={(evento) => setContrasena(evento.target.value)}
              className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:focus:border-zinc-100"
              placeholder={`Mínimo ${PASSWORD_MIN_LENGTH} caracteres`}
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

