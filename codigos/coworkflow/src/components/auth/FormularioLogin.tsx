"use client";

import { useRouter } from "next/navigation";
import { useState, useSyncExternalStore } from "react";

import { normalizarDestinoInterno } from "@/lib/auth/redirects";
import { PASSWORD_MIN_LENGTH } from "@/lib/dominio/auth";

type Modo = "enlace" | "contrasena" | "registro";

const suscribir = () => () => {};
const enCliente = () => true;
const enServidor = () => false;

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
  // No aceptar escritura antes de hidratar: una conexión móvil lenta podría perderla.
  const listo = useSyncExternalStore(suscribir, enCliente, enServidor);
  const router = useRouter();
  const [modo, setModo] = useState<Modo>("contrasena");
  const [correo, setCorreo] = useState("");
  const [contrasena, setContrasena] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(mensajeInicial);
  const [aviso, setAviso] = useState<string | null>(null);

  /** Cambia la forma de acceso y limpia los mensajes de la anterior. */
  function cambiarModo(nuevo: Modo) {
    setModo(nuevo);
    setError(null);
    setAviso(null);
  }

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
    <div className="tarjeta">
      <form onSubmit={manejarEnvio} className="space-y-4">
        <div>
          <label htmlFor="correo" className="text-sm font-medium">
            Correo
          </label>
          <input
            id="correo"
            disabled={!listo || enviando}
            type="email"
            required
            autoComplete="email"
            inputMode="email"
            value={correo}
            onChange={(evento) => setCorreo(evento.target.value)}
            className="foco-marca mt-1.5 h-12 w-full rounded-xl border border-borde bg-superficie px-3 text-sm text-tinta placeholder:text-tenue/60 focus:border-marca"
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
              disabled={!listo || enviando}
              type="password"
              required
              minLength={PASSWORD_MIN_LENGTH}
              autoComplete={modo === "registro" ? "new-password" : "current-password"}
              value={contrasena}
              onChange={(evento) => setContrasena(evento.target.value)}
              className="foco-marca mt-1.5 h-12 w-full rounded-xl border border-borde bg-superficie px-3 text-sm text-tinta placeholder:text-tenue/60 focus:border-marca"
              placeholder={`Mínimo ${PASSWORD_MIN_LENGTH} caracteres`}
            />
          </div>
        )}

        <button
          type="submit"
          disabled={!listo || enviando}
          className="btn-primario h-12 w-full disabled:cursor-not-allowed disabled:opacity-40"
        >
          {enviando ? "Enviando…" : tituloBoton}
        </button>
      </form>

      <p aria-live="polite" className="mt-4 text-sm text-lleno-texto">
        {error}
      </p>
      <p aria-live="polite" className="mt-2 text-sm text-bajo-texto">
        {aviso}
      </p>

      <div className="mt-4 flex flex-col items-center gap-1 border-t border-borde pt-4">
        {modo !== "registro" ? (
          <button
            type="button"
            onClick={() => cambiarModo("registro")}
            className="enlace-header border-0 bg-transparent"
          >
            ¿Primera vez? Crear cuenta
          </button>
        ) : (
          <button
            type="button"
            onClick={() => cambiarModo("contrasena")}
            className="enlace-header border-0 bg-transparent"
          >
            ¿Ya tienes cuenta? Entra
          </button>
        )}

        {modo !== "enlace" ? (
          <button
            type="button"
            onClick={() => cambiarModo("enlace")}
            className="enlace-header border-0 bg-transparent"
          >
            Prefiero recibir un enlace por correo
          </button>
        ) : (
          <button
            type="button"
            onClick={() => cambiarModo("contrasena")}
            className="enlace-header border-0 bg-transparent"
          >
            Prefiero usar mi contraseña
          </button>
        )}
      </div>

      <p className="mt-4 text-xs leading-5 text-tenue">
        El correo del plan gratuito tiene un límite de envíos; por eso también puedes entrar
        con contraseña.
      </p>
    </div>
  );
}

