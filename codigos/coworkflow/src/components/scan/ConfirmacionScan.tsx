"use client";

import Link from "next/link";
import {
  AlertTriangle,
  CheckCircle2,
  LayoutDashboard,
  LogIn,
  LogOut,
  MapPin,
  QrCode,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

import {
  esResultadoScan,
  MENSAJE_ERROR_SCAN,
  PRESENTACION_RESULTADO_SCAN,
  type PresentacionResultadoScan,
  type ResultadoScan,
  type TonoResultadoScan,
} from "@/lib/dominio/scan";

type Modo = "entrada" | "salida" | null;

type Props = {
  /** Token recibido por props desde el servidor: nunca se lee de `window.location`. */
  token: string;
  /** Modo leído del token firmado; `null` si no se pudo interpretar. Solo afecta etiquetas. */
  modo: Modo;
  /** Nombre de la zona leído del `zona_uuid` del token (solo presentación, S-46). */
  nombreZona: string | null;
  /** Hora local `HH:MM` en la zona; `null` si no se pudo resolver. */
  horaLocal: string | null;
  /** Estado del horario (`textoEstadoHorario`): «Abierto hasta…» o «Cerrado · abre…». */
  textoFueraHorario: string | null;
};

type Interpretacion = {
  ok: boolean;
  mensaje: string;
  /** Resultado del enum cuando el fallo viene del dominio; `null` en fallos de transporte. */
  resultado: ResultadoScan | null;
  requiereLogin: boolean;
};

/** Códigos que devuelve `POST /api/scan` cuando el fallo ocurre antes del dominio. */
function mensajeDeError(codigo: string): string {
  switch (codigo) {
    case "no_autenticado":
      return "Tu sesión venció. Inicia sesión y escanea el código otra vez.";
    case "datos_invalidos":
      return "El código QR no es válido. Escanéalo otra vez.";
    default:
      return MENSAJE_ERROR_SCAN;
  }
}

/**
 * Interpreta la respuesta sin confiar en su forma: una guarda, un proxy o un 500 pueden
 * devolver HTML o un JSON distinto. Solo se acepta `{ ok: boolean, mensaje: string,
 * resultado? }` o `{ error: string }`; cualquier otra cosa cae al mensaje genérico.
 * `resultado` se valida con el guard del enum (S-33): un código desconocido se trata como
 * fallo de transporte y no se inventa un texto.
 */
async function interpretarRespuesta(
  respuesta: Response,
): Promise<Interpretacion> {
  let cuerpo: unknown;
  try {
    cuerpo = await respuesta.json();
  } catch {
    return {
      ok: false,
      mensaje: MENSAJE_ERROR_SCAN,
      resultado: null,
      requiereLogin: false,
    };
  }
  if (typeof cuerpo !== "object" || cuerpo === null) {
    return {
      ok: false,
      mensaje: MENSAJE_ERROR_SCAN,
      resultado: null,
      requiereLogin: false,
    };
  }

  const datos = cuerpo as Record<string, unknown>;
  if (typeof datos.ok === "boolean" && typeof datos.mensaje === "string") {
    const resultado = esResultadoScan(datos.resultado)
      ? datos.resultado
      : null;
    return {
      ok: datos.ok,
      mensaje: datos.mensaje,
      resultado,
      requiereLogin: resultado === "no_autenticado",
    };
  }
  if (typeof datos.error === "string") {
    return {
      ok: false,
      mensaje: mensajeDeError(datos.error),
      resultado: null,
      requiereLogin: datos.error === "no_autenticado",
    };
  }
  return {
    ok: false,
    mensaje: MENSAJE_ERROR_SCAN,
    resultado: null,
    requiereLogin: false,
  };
}

function tituloConfirmacion(modo: Modo): string {
  if (modo === "entrada") return "Confirma tu entrada";
  if (modo === "salida") return "Confirma tu salida";
  return "Confirma tu asistencia";
}

function etiquetaBoton(modo: Modo): string {
  if (modo === "entrada") return "Confirmar entrada";
  if (modo === "salida") return "Confirmar salida";
  return "Confirmar asistencia";
}

/** Ícono del modo; `QrCode` cuando el token no permitió deducirlo. */
function IconoDelModo({ modo }: { modo: Modo }) {
  if (modo === "entrada") return <LogIn aria-hidden className="size-6" />;
  if (modo === "salida") return <LogOut aria-hidden className="size-6" />;
  return <QrCode aria-hidden className="size-6" />;
}

/**
 * Tonos de la pantalla de resultado. Las clases se escriben completas para que Tailwind las
 * detecte; no se construyen con plantillas.
 */
const ESTILO_TONO: Record<
  TonoResultadoScan,
  { fondo: string; texto: string; Icono: LucideIcon }
> = {
  exito: {
    fondo: "bg-bajo-fondo",
    texto: "text-bajo-texto",
    Icono: CheckCircle2,
  },
  aviso: {
    fondo: "bg-moderado-fondo",
    texto: "text-moderado-texto",
    Icono: AlertTriangle,
  },
};

/**
 * Texto de la pantalla de resultado. Si la respuesta trae un `resultado` del enum se usa su
 * presentación; si el API respondiera `{ ok: true }` sin código (no debería), se usa el éxito
 * del modo para no mostrar un error falso; los fallos de transporte usan su mensaje.
 */
function presentacionDe(
  interpretacion: Interpretacion,
  modo: Modo,
): PresentacionResultadoScan {
  if (interpretacion.resultado) {
    return PRESENTACION_RESULTADO_SCAN[interpretacion.resultado];
  }
  if (interpretacion.ok) {
    return PRESENTACION_RESULTADO_SCAN[
      modo === "salida" ? "salida_ok" : "entrada_ok"
    ];
  }
  return {
    titulo: "No pudimos registrar",
    detalle: interpretacion.mensaje,
    tono: "aviso",
  };
}

function VistaResultado({
  presentacion,
  resultado,
}: {
  presentacion: PresentacionResultadoScan;
  resultado: Interpretacion;
}) {
  const estilo = ESTILO_TONO[presentacion.tono];
  const Icono = estilo.Icono;

  return (
    <div className="tarjeta text-center">
      <span
        className={`mx-auto grid size-16 place-items-center rounded-full ${estilo.fondo} ${estilo.texto}`}
      >
        <Icono aria-hidden className="size-8" />
      </span>
      <h1 className="mt-5 text-2xl font-semibold tracking-tight">
        {presentacion.titulo}
      </h1>
      <p className="mt-2 text-sm leading-6 text-tenue">
        {presentacion.detalle}
      </p>

      <div className="mt-6 space-y-2">
        {resultado.ok ? (
          <Link href="/dashboard" className="btn-primario w-full">
            <LayoutDashboard aria-hidden className="mr-2 size-4" />
            Ver la ocupación
          </Link>
        ) : resultado.requiereLogin ? (
          <Link href="/login" className="btn-primario w-full">
            Iniciar sesión
          </Link>
        ) : null}
        <Link href="/" className="btn-secundario w-full">
          Volver al inicio
        </Link>
      </div>
    </div>
  );
}

function VistaConfirmacion({
  modo,
  nombreZona,
  horaLocal,
  textoFueraHorario,
  enviando,
  error,
  onConfirmar,
}: {
  modo: Modo;
  nombreZona: string | null;
  horaLocal: string | null;
  textoFueraHorario: string | null;
  enviando: boolean;
  error: string | null;
  onConfirmar: () => void;
}) {
  const cerrado = textoFueraHorario?.startsWith("Cerrado") ?? false;

  return (
    <div className="tarjeta">
      {nombreZona && (
        <div
          className={`flex items-start gap-3 rounded-2xl px-4 py-3 ${
            cerrado ? "bg-moderado-fondo" : "bg-marca-suave"
          }`}
        >
          <MapPin
            aria-hidden
            className={`mt-0.5 size-5 shrink-0 ${
              cerrado ? "text-moderado-texto" : "text-marca"
            }`}
          />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-tinta">
              {nombreZona}
            </p>
            <p
              className={`mt-0.5 text-xs leading-5 ${
                cerrado ? "text-moderado-texto" : "text-tenue"
              }`}
            >
              {horaLocal
                ? `Hora local ${horaLocal}`
                : "Hora local no disponible"}
              {textoFueraHorario ? ` · ${textoFueraHorario}` : ""}
            </p>
          </div>
        </div>
      )}

      <span className="mt-5 grid size-12 place-items-center rounded-2xl bg-marca-suave text-marca">
        <IconoDelModo modo={modo} />
      </span>
      <h1 className="mt-4 text-2xl font-semibold tracking-tight">
        {tituloConfirmacion(modo)}
      </h1>
      <p className="mt-2 text-sm leading-6 text-tenue">
        Revisa que estás en el cowork. No se registra nada hasta que toques el
        botón.
      </p>

      <button
        type="button"
        onClick={onConfirmar}
        disabled={enviando}
        className="btn-primario mt-5 w-full disabled:cursor-not-allowed disabled:opacity-40"
      >
        {enviando ? "Registrando…" : etiquetaBoton(modo)}
      </button>
      <Link href="/" className="btn-secundario mt-2 w-full">
        Cancelar
      </Link>

      {error && (
        <p
          role="alert"
          className="mt-3 rounded-xl bg-lleno-fondo px-4 py-3 text-sm text-lleno-texto"
        >
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Confirmación explícita del escaneo.
 *
 * El POST no se dispara al cargar la página: cualquiera puede abrir el enlace (o un
 * antivirus/preview seguirlo), así que la escritura ocurre solo cuando la persona toca el
 * botón. Lo único que se hace al montar es quitar el token de la barra de direcciones, para
 * que no quede en el historial ni se reenvíe al recargar. La operación registrada la decide
 * el token firmado, no esta pantalla.
 */
export function ConfirmacionScan({
  token,
  modo,
  nombreZona,
  horaLocal,
  textoFueraHorario,
}: Props) {
  const [enviando, setEnviando] = useState(false);
  const [resultado, setResultado] = useState<Interpretacion | null>(null);

  // Al montar: la URL pasa a ser `/scan` sin el token. Las props conservan el token para
  // reintentar el POST, así que limpiar la barra de direcciones no rompe nada. El token sigue
  // siendo válido hasta que venza su ventana; el cooldown de la RPC evita duplicados.
  useEffect(() => {
    try {
      window.history.replaceState(null, "", "/scan");
    } catch {
      // Algunos navegadores/modos restringen `replaceState`; la ventana corta del QR limita
      // la exposición si no se puede limpiar la URL.
    }
  }, []);

  async function confirmar() {
    if (enviando || resultado?.ok) return;
    setEnviando(true);
    setResultado(null);

    let respuesta: Response;
    try {
      respuesta = await fetch("/api/scan", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ t: token }),
      });
    } catch {
      setEnviando(false);
      setResultado({
        ok: false,
        mensaje: MENSAJE_ERROR_SCAN,
        resultado: null,
        requiereLogin: false,
      });
      return;
    }

    const interpretado = await interpretarRespuesta(respuesta);
    setEnviando(false);
    setResultado(interpretado);
  }

  const presentacion = resultado ? presentacionDe(resultado, modo) : null;
  const mostrarResultado = Boolean(
    resultado && (resultado.ok || resultado.resultado !== null),
  );
  const errorTransitorio =
    resultado && !resultado.ok && resultado.resultado === null
      ? resultado.mensaje
      : null;
  const anuncio =
    mostrarResultado && presentacion
      ? `${presentacion.titulo}. ${presentacion.detalle}`
      : "";

  return (
    <div>
      <p aria-live="polite" className="sr-only">
        {anuncio}
      </p>

      {mostrarResultado && presentacion && resultado ? (
        <VistaResultado presentacion={presentacion} resultado={resultado} />
      ) : (
        <VistaConfirmacion
          modo={modo}
          nombreZona={nombreZona}
          horaLocal={horaLocal}
          textoFueraHorario={textoFueraHorario}
          enviando={enviando}
          error={errorTransitorio}
          onConfirmar={confirmar}
        />
      )}
    </div>
  );
}
