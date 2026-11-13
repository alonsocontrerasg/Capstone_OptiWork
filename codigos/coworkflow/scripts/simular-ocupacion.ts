/**
 * scripts/simular-ocupacion.ts — simulación de ocupación para la demo (SOLO local).
 *
 * Qué hace
 *   1. Crea (o reutiliza) `N` usuarios reales de Auth con correos `sim-NN@simulacion.invalid`.
 *   2. Genera sesiones CERRADAS en `sesiones` para 30 días civiles completos que terminan en la
 *      medianoche local de hoy, dentro del horario de la zona y sin solapar sesiones del mismo
 *      usuario, con un patrón realista: laborables cargados, fines de semana flojos, llegadas
 *      08:00–11:00, duraciones 1–8 h y pico entre 11:00 y 15:00. El pico se calibra a
 *      `--pico` % del aforo (62 % por defecto, dentro de la banda 55–70 % de la demo) y nunca
 *      supera el número de usuarios, porque una persona no puede estar dos veces dentro.
 *   3. Recalcula `snapshots_ocupacion` cada 5 min para todo el período contando TODAS las
 *      sesiones de la zona (reales y simuladas) y las escribe por upsert (PK `zona_id, ts`).
 *   4. Llama a `refrescar_ocupacion(zona)` para dejar `ocupacion_actual` coherente.
 *   5. Con `--limpiar` borra los usuarios `sim-*` y recalcula los snapshots con lo que queda.
 *   6. Con `--dry-run` hace todo el cálculo (sesiones, pico, personas por día y mapa de calor)
 *      y lo imprime SIN escribir nada y SIN crear usuarios: solo lee la zona.
 *
 * Cómo se ejecuta (a mano, en local; la app nunca lo llama):
 *
 *   node --env-file=.env.local scripts/simular-ocupacion.ts --dry-run
 *   node --env-file=.env.local scripts/simular-ocupacion.ts
 *   node --env-file=.env.local scripts/simular-ocupacion.ts --usuarios 90 --reemplazar
 *   node --env-file=.env.local scripts/simular-ocupacion.ts --pico 70
 *   node --env-file=.env.local scripts/simular-ocupacion.ts --limpiar
 *
 * Reglas de seguridad
 *   - Este archivo vive FUERA de `src/`: la `service_role` key nunca entra al bundle del
 *     navegador ni al de Next. Se lee solo de `process.env.SUPABASE_SERVICE_ROLE_KEY` (sin
 *     prefijo `NEXT_PUBLIC_`, que sí se publicaría) y jamás se imprime ni se registra.
 *   - Las contraseñas de los usuarios simulados salen de `randomBytes` (`node:crypto`), sin
 *     semilla: el generador con semilla es reproducible y el repo es público, así que cualquiera
 *     podría recalcularlas e iniciar sesión. Además los usuarios se crean con un baneo de 100
 *     años (`ban_duration`), así que ni con la contraseña correcta pueden autenticarse.
 *   - Antes de escribir nada pide confirmación escrita ("si") y muestra solo el host.
 *   - Es autónomo: únicamente `@supabase/supabase-js` y módulos `node:*`. Sin alias `@/`, sin
 *     `server-only` y sin dependencias nuevas. Node 22+ ejecuta TypeScript directamente
 *     (type stripping), así que no hay que compilar.
 *   - El resumen final no incluye datos personales: solo recuentos.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { argv, env, exit, stdin, stdout } from "node:process";

// ---------------------------------------------------------------- constantes

/** Dominio reservado para pruebas (RFC 2606: `.invalid` no puede recibir correo). */
const DOMINIO_SIMULADO = "@simulacion.invalid";
const PREFIJO_CORREO = "sim-";
/** Días civiles completos que se simulan, terminando en la medianoche local de hoy. */
const DIAS_SIMULADOS = 30;
/** La serie histórica se guarda cada 5 min, igual que el cron `cron_snapshot`. */
const MINUTOS_BUCKET = 5;
const MS_BUCKET = MINUTOS_BUCKET * 60_000;
/**
 * Fracción del aforo que se busca en las horas punta (55–70 % pedido: 62 % queda al centro).
 * Es el valor por defecto de `--pico`; el pico nunca se pasa de la banda porque la calibración
 * del día se hace contra este número, no contra el azar.
 */
const FRACCION_PICO_POR_DEFECTO = 0.62;
/** Rango aceptado de `--pico`, en porcentaje del aforo (por encima de 90 % el mapa se satura). */
const PICO_MINIMO = 20;
const PICO_MAXIMO = 90;
/** Ventana de la hora punta, en minutos desde la medianoche local. */
const PICO_DESDE = 11 * 60;
const PICO_HASTA = 15 * 60;
const DIAS_LABORALES = new Set([1, 2, 3, 4, 5]);
/** Lunes a jueves casi lleno, viernes flojo y fin de semana casi vacío. */
const PROBABILIDAD_ASISTENCIA: Record<number, number> = {
  1: 0.95,
  2: 0.95,
  3: 0.95,
  4: 0.9,
  5: 0.78,
  6: 0.32,
  7: 0.15,
};
const PROBABILIDAD_MAXIMA = 0.95;
const USUARIOS_POR_DEFECTO = 60;
const SEMILLA_POR_DEFECTO = 20261112;
/**
 * Los usuarios simulados no deben poder iniciar sesión nunca: se crean con un baneo de ~100 años.
 * `ban_duration` es una duración de Go; 876000 h ≈ 100 años, muy por debajo del límite de int64.
 */
const DURACION_BANEO = "876000h";
/**
 * Umbrales del mapa de calor del dashboard (`MapaCalorDashboard`): menos de 20 %, 20–39, 40–59,
 * 60–79 y 80 % o más del aforo. Se usan solo para resumir el resultado de `--dry-run`.
 */
const UMBRALES_MAPA_CALOR = [20, 40, 60, 80] as const;

const USO = `Uso: node --env-file=.env.local scripts/simular-ocupacion.ts [opciones]

  --usuarios N    Usuarios simulados a crear o reutilizar (5..1000, por defecto ${USUARIOS_POR_DEFECTO})
  --semilla N     Semilla del generador aleatorio (por defecto ${SEMILLA_POR_DEFECTO})
  --pico PCT      Ocupación de las horas punta, en % del aforo (${PICO_MINIMO}..${PICO_MAXIMO},
                  por defecto ${Math.round(FRACCION_PICO_POR_DEFECTO * 100)})
  --zona SLUG     Slug de la zona (por defecto NEXT_PUBLIC_ZONA_POR_DEFECTO)
  --reemplazar    Borra y reescribe los snapshots existentes del período
  --limpiar       Borra los usuarios sim-* y recalcula los snapshots
  --dry-run       Calcula e imprime el resultado sin escribir nada ni crear usuarios

El pico no puede superar el número de usuarios: con N usuarios y aforo A, el máximo real es
min(N, A·PCT/100). Para ver el nivel más alto del mapa de calor (≥ 80 % del aforo) usa, por
ejemplo, --usuarios 95 --pico 90 en una zona de aforo 100.`;

// ---------------------------------------------------------------- tipos

type Opciones = {
  usuarios: number;
  semilla: number;
  pico: number;
  zona: string | null;
  reemplazar: boolean;
  limpiar: boolean;
  dryRun: boolean;
};

type Configuracion = { url: string; host: string; claveServicio: string };

type Zona = {
  id: string;
  slug: string;
  nombre: string;
  aforo_max: number;
  hora_apertura: string;
  hora_cierre: string;
  timezone: string;
};

type UsuarioSimulado = { id: string; correo: string };

type FechaCivil = { anio: number; mes: number; dia: number };

type PartesLocales = FechaCivil & {
  hora: number;
  minuto: number;
  segundo: number;
};

/** Sesión de un día, en minutos desde la medianoche local (más fácil de calibrar). */
type BloqueDia = { usuario: number; entradaMin: number; salidaMin: number };

/** Sesión ya convertida a instantes absolutos (UTC), lista para insertar. */
type Bloque = { usuario: number; entradaMs: number; salidaMs: number };

type ContextoSimulacion = {
  zona: Zona;
  apertura: number;
  cierre: number;
  usuarios: readonly UsuarioSimulado[];
  generador: () => number;
  objetivoPico: number;
};

type FilaSesion = { entrada_at: string; salida_at: string | null };

/**
 * El proyecto no usa los tipos generados de la base, así que el cliente va sin esquema: `from()`
 * devuelve filas sin tipar y aquí se manejan con las interfaces locales de arriba.
 */
type ClienteSupabase = SupabaseClient;

// ---------------------------------------------------------------- azar

/**
 * Generador pseudoaleatorio con semilla (mulberry32): la misma `--semilla` produce exactamente
 * la misma simulación, así que una demo se puede repetir sin guardar los datos.
 */
function crearGenerador(semilla: number): () => number {
  let estado = semilla >>> 0;
  return () => {
    estado = (estado + 0x6d2b79f5) >>> 0;
    let valor = estado;
    valor = Math.imul(valor ^ (valor >>> 15), valor | 1);
    valor ^= valor + Math.imul(valor ^ (valor >>> 7), valor | 61);
    return ((valor ^ (valor >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Entero uniforme en [desde, hasta]. */
function enteroEntre(generador: () => number, desde: number, hasta: number): number {
  return desde + Math.floor(generador() * (hasta - desde + 1));
}

/** `sim-01@simulacion.invalid`, `sim-60@simulacion.invalid`, … */
function correoSimulado(indice: number): string {
  return `${PREFIJO_CORREO}${String(indice).padStart(2, "0")}${DOMINIO_SIMULADO}`;
}

// ---------------------------------------------------------------- fechas en la zona de la tabla

const FORMATOS_POR_ZONA = new Map<string, Intl.DateTimeFormat>();

function formatoDeZona(zona: string): Intl.DateTimeFormat {
  const existente = FORMATOS_POR_ZONA.get(zona);
  if (existente) return existente;
  const formato = new Intl.DateTimeFormat("en-CA", {
    timeZone: zona,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  FORMATOS_POR_ZONA.set(zona, formato);
  return formato;
}

function partesLocales(instanteMs: number, zona: string): PartesLocales {
  const partes = formatoDeZona(zona).formatToParts(new Date(instanteMs));
  const valor = (tipo: string): number =>
    Number(partes.find((parte) => parte.type === tipo)?.value ?? "0");
  return {
    anio: valor("year"),
    mes: valor("month"),
    dia: valor("day"),
    hora: valor("hour"),
    minuto: valor("minute"),
    segundo: valor("second"),
  };
}

/**
 * Desfase de la zona en milisegundos (hora local − UTC) para un instante dado.
 * Se calcula con `Intl`, que conoce las reglas del huso (incluido el horario de verano) sin
 * depender de librerías externas ni de la zona horaria del servidor.
 */
function desfaseMs(instanteMs: number, zona: string): number {
  const partes = partesLocales(instanteMs, zona);
  const comoUtc = Date.UTC(
    partes.anio,
    partes.mes - 1,
    partes.dia,
    partes.hora,
    partes.minuto,
    partes.segundo,
  );
  return comoUtc - Math.floor(instanteMs / 1000) * 1000;
}

/**
 * Instante absoluto de una hora de reloj local de la zona.
 * Se resuelve en dos pasos porque el desfase depende del propio instante: en el cambio de hora
 * los relojes se repiten o se saltan una hora y hay que usar el desfase que corresponde al
 * candidato, no al de la hora "ingenua".
 */
function instanteDeHoraLocal(
  zona: string,
  anio: number,
  mes: number,
  dia: number,
  minutosDelDia: number,
): number {
  const ingenuo = Date.UTC(anio, mes - 1, dia, 0, 0, 0) + minutosDelDia * 60_000;
  const desfase = desfaseMs(ingenuo, zona);
  const candidato = ingenuo - desfase;
  const desfaseDelCandidato = desfaseMs(candidato, zona);
  return desfaseDelCandidato === desfase ? candidato : ingenuo - desfaseDelCandidato;
}

/** Suma días de calendario sobre la fecha civil (aritmética en UTC: no hay DST que la tuerza). */
function sumarDias(fecha: FechaCivil, dias: number): FechaCivil {
  const desplazada = new Date(Date.UTC(fecha.anio, fecha.mes - 1, fecha.dia + dias));
  return {
    anio: desplazada.getUTCFullYear(),
    mes: desplazada.getUTCMonth() + 1,
    dia: desplazada.getUTCDate(),
  };
}

/** Día ISO: 1 = lunes … 7 = domingo. */
function diaIso(fecha: FechaCivil): number {
  const dia = new Date(Date.UTC(fecha.anio, fecha.mes - 1, fecha.dia)).getUTCDay();
  return dia === 0 ? 7 : dia;
}

/** `'08:00:00'` → 480. Acepta `'24:00'` como fin de día. */
function minutosDeHoraTexto(texto: string): number | null {
  const coincidencia = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(texto.trim());
  if (!coincidencia) return null;
  const horas = Number(coincidencia[1]);
  const minutos = Number(coincidencia[2]);
  if (!Number.isInteger(horas) || !Number.isInteger(minutos)) return null;
  if (horas < 0 || horas > 24 || minutos < 0 || minutos > 59) return null;
  const total = horas * 60 + minutos;
  return total <= 1440 ? total : null;
}

function formatearInstante(instanteMs: number, zona: string): string {
  return new Intl.DateTimeFormat("es-CL", {
    timeZone: zona,
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(instanteMs));
}

// ---------------------------------------------------------------- argumentos y entorno

function leerOpciones(argumentos: readonly string[]): Opciones {
  const opciones: Opciones = {
    usuarios: USUARIOS_POR_DEFECTO,
    semilla: SEMILLA_POR_DEFECTO,
    pico: Math.round(FRACCION_PICO_POR_DEFECTO * 100),
    zona: null,
    reemplazar: false,
    limpiar: false,
    dryRun: false,
  };

  for (let indice = 0; indice < argumentos.length; indice += 1) {
    const bandera = argumentos[indice];
    if (bandera === "--reemplazar") {
      opciones.reemplazar = true;
      continue;
    }
    if (bandera === "--limpiar") {
      opciones.limpiar = true;
      continue;
    }
    if (bandera === "--dry-run") {
      opciones.dryRun = true;
      continue;
    }
    if (
      bandera === "--usuarios" ||
      bandera === "--semilla" ||
      bandera === "--pico" ||
      bandera === "--zona"
    ) {
      const valor = argumentos[indice + 1];
      if (valor === undefined) throw new Error(`Falta el valor de ${bandera}.\n\n${USO}`);
      indice += 1;
      if (bandera === "--zona") {
        const slug = valor.trim();
        if (slug.length === 0) throw new Error(`--zona necesita un slug.\n\n${USO}`);
        opciones.zona = slug;
        continue;
      }
      const numero = Number(valor);
      if (!Number.isInteger(numero) || numero <= 0) {
        throw new Error(`${bandera} debe ser un entero positivo.\n\n${USO}`);
      }
      if (bandera === "--usuarios") {
        if (numero < 5 || numero > 1000) {
          throw new Error("--usuarios debe estar entre 5 y 1000.");
        }
        opciones.usuarios = numero;
      } else if (bandera === "--pico") {
        if (numero < PICO_MINIMO || numero > PICO_MAXIMO) {
          throw new Error(`--pico debe estar entre ${PICO_MINIMO} y ${PICO_MAXIMO} (%).`);
        }
        opciones.pico = numero;
      } else {
        opciones.semilla = numero;
      }
      continue;
    }
    throw new Error(`Opción desconocida: ${bandera}.\n\n${USO}`);
  }

  if (opciones.limpiar && opciones.reemplazar) {
    console.log("Aviso: --limpiar ya recalcula los snapshots; --reemplazar no hace falta.");
  }
  if (opciones.dryRun && opciones.limpiar) {
    throw new Error("--dry-run no escribe nada: no se puede combinar con --limpiar.");
  }
  if (opciones.dryRun && opciones.reemplazar) {
    console.log("Aviso: --dry-run no escribe nada; --reemplazar se ignora.");
    opciones.reemplazar = false;
  }
  return opciones;
}

/**
 * Lee la configuración del entorno. Si falta algo, se nombra la VARIABLE (nunca su valor) y se
 * aborta antes de tocar la base.
 */
function leerConfiguracion(): Configuracion {
  const url = env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const claveServicio = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  const faltantes: string[] = [];
  if (!url) faltantes.push("NEXT_PUBLIC_SUPABASE_URL");
  if (!claveServicio) faltantes.push("SUPABASE_SERVICE_ROLE_KEY");

  if (!url || !claveServicio) {
    throw new Error(
      `Falta la variable de entorno ${faltantes.join(", ")}.\n` +
        "Copia .env.example a .env.local y ejecuta el script con --env-file=.env.local " +
        "(la service_role key nunca se imprime).",
    );
  }
  if (env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY no debe existir: cualquier variable NEXT_PUBLIC_ " +
        "termina en el bundle del navegador. Renómbrala a SUPABASE_SERVICE_ROLE_KEY.",
    );
  }

  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL no es una URL válida (revisa .env.local).");
  }
  return { url, host, claveServicio };
}

/** Muestra el destino y exige un "si" escrito: el script no escribe nada sin confirmación. */
async function confirmar(host: string, detalles: readonly string[]): Promise<boolean> {
  console.log(`Proyecto Supabase: ${host}`);
  for (const linea of detalles) console.log(linea);
  const lector = createInterface({ input: stdin, output: stdout });
  try {
    const respuesta = await lector.question('Escribe "si" para continuar: ');
    return respuesta.trim().toLowerCase() === "si";
  } finally {
    lector.close();
  }
}

// ---------------------------------------------------------------- zona y usuarios

async function obtenerZona(supabase: ClienteSupabase, slug: string | null): Promise<Zona> {
  const buscado = slug ?? env.NEXT_PUBLIC_ZONA_POR_DEFECTO?.trim() ?? null;
  const columnas = "id,slug,nombre,aforo_max,hora_apertura,hora_cierre,timezone";

  const consulta = supabase.from("zonas").select(columnas).eq("activa", true);
  const respuesta = buscado
    ? await consulta.eq("slug", buscado).maybeSingle()
    : await consulta.order("creado_at", { ascending: true }).limit(1).maybeSingle();

  if (respuesta.error) {
    throw new Error(`No se pudo leer la zona: ${respuesta.error.message}`);
  }
  if (!respuesta.data) {
    throw new Error(
      buscado
        ? `No existe una zona activa con slug "${buscado}". Revisa --zona o la tabla zonas.`
        : "No hay zonas activas. Crea una zona antes de simular (ver supabase/migrations).",
    );
  }
  return respuesta.data as Zona;
}

async function refrescarOcupacion(supabase: ClienteSupabase, zonaId: string): Promise<void> {
  const { error } = await supabase.rpc("refrescar_ocupacion", { p_zona_id: zonaId });
  if (error) {
    throw new Error(`No se pudo refrescar ocupacion_actual: ${error.message}`);
  }
}

/** Recorre `listUsers` página por página y devuelve solo los correos sim-*. */
async function listarSimulados(supabase: ClienteSupabase): Promise<UsuarioSimulado[]> {
  const simulados: UsuarioSimulado[] = [];
  const porPagina = 1000;
  for (let pagina = 1; ; pagina += 1) {
    const { data, error } = await supabase.auth.admin.listUsers({
      page: pagina,
      perPage: porPagina,
    });
    if (error) throw new Error(`No se pudieron listar los usuarios: ${error.message}`);
    const usuarios = data.users;
    for (const usuario of usuarios) {
      const correo = usuario.email ?? "";
      if (correo.startsWith(PREFIJO_CORREO) && correo.endsWith(DOMINIO_SIMULADO)) {
        simulados.push({ id: usuario.id, correo });
      }
    }
    if (usuarios.length < porPagina) break;
  }
  return simulados;
}

type UsuariosAsegurados = {
  lista: UsuarioSimulado[];
  creados: number;
  reutilizados: number;
};

/**
 * Crea (o reutiliza) los usuarios `sim-*`.
 *
 * Credenciales: la contraseña sale de `randomBytes` (CSPRNG del sistema, sin semilla y 32 bytes)
 * y nunca se imprime ni se registra. Además todos los usuarios quedan con `ban_duration` de
 * ~100 años, así que no pueden iniciar sesión ni conociendo la contraseña: los usuarios
 * simulados existen solo para sostener las sesiones que el dashboard agrega.
 */
async function asegurarUsuarios(
  supabase: ClienteSupabase,
  cantidad: number,
): Promise<UsuariosAsegurados> {
  const existentes = await listarSimulados(supabase);
  const porCorreo = new Map(existentes.map((usuario) => [usuario.correo, usuario]));

  const lista: UsuarioSimulado[] = [];
  let creados = 0;
  let reutilizados = 0;

  for (let indice = 1; indice <= cantidad; indice += 1) {
    const correo = correoSimulado(indice);
    const yaExiste = porCorreo.get(correo);
    if (yaExiste) {
      // Una corrida anterior pudo crear el usuario con la contraseña derivada de la semilla
      // (versión WIP): se le aplica el baneo igual para que no pueda autenticarse.
      const { error } = await supabase.auth.admin.updateUserById(yaExiste.id, {
        ban_duration: DURACION_BANEO,
      });
      if (error) throw new Error(`No se pudo banear un usuario simulado: ${error.message}`);
      lista.push(yaExiste);
      reutilizados += 1;
      continue;
    }
    // Idempotente: si una corrida anterior se cortó, los que ya existen se reutilizan.
    const { data, error } = await supabase.auth.admin.createUser({
      email: correo,
      password: randomBytes(32).toString("base64url"),
      email_confirm: true,
      ban_duration: DURACION_BANEO,
    });
    if (error || !data.user) {
      throw new Error(
        `No se pudo crear el usuario simulado ${indice}: ${error?.message ?? "sin usuario"}`,
      );
    }
    // El trigger `handle_new_user` crea la fila de `profiles`; desde aquí no se toca.
    lista.push({ id: data.user.id, correo });
    creados += 1;
  }

  return { lista, creados, reutilizados };
}

// ---------------------------------------------------------------- generación de sesiones

function crearBloqueDia(
  usuario: number,
  entradaMin: number,
  duracionMin: number,
  cierre: number,
): BloqueDia | null {
  const salidaMin = Math.min(entradaMin + duracionMin, cierre);
  // Una visita de menos de 1 h no es una sesión de cowork; se descarta en vez de inventar un
  // dato raro (pasa cuando la llegada queda pegada al cierre de la zona).
  if (salidaMin - entradaMin < 60) return null;
  return { usuario, entradaMin, salidaMin };
}

/** Personas simultáneas máximas entre 11:00 y 15:00 (donde el patrón debe verse cargado). */
function picoEnVentana(bloques: readonly BloqueDia[]): number {
  const diferencias = new Int32Array(1441);
  for (const bloque of bloques) {
    const desde = Math.max(0, Math.min(1440, Math.round(bloque.entradaMin)));
    const hasta = Math.max(0, Math.min(1440, Math.round(bloque.salidaMin)));
    if (hasta <= desde) continue;
    diferencias[desde] += 1;
    diferencias[hasta] -= 1;
  }

  let presentes = 0;
  let pico = 0;
  for (let minuto = 0; minuto < 1440; minuto += 1) {
    presentes += diferencias[minuto];
    if (minuto >= PICO_DESDE && minuto < PICO_HASTA && presentes > pico) pico = presentes;
  }
  return pico;
}

function primerUsuarioLibre(total: number, ocupados: ReadonlySet<number>): number | null {
  for (let indice = 0; indice < total; indice += 1) {
    if (!ocupados.has(indice)) return indice;
  }
  return null;
}

/**
 * Duración de la visita principal, en horas. En laborables hay mayoría de jornadas largas
 * (4–8 h) y una minoría de visitas cortas (1–3 h): así la ocupación se sostiene entre 10:00 y
 * 14:00 en lugar de hacer un pico de un solo bucket. El fin de semana todo es más corto.
 */
function duracionDelDia(generador: () => number, dow: number): number {
  if (!DIAS_LABORALES.has(dow)) return enteroEntre(generador, 1, 5);
  return generador() < 0.2 ? enteroEntre(generador, 1, 3) : enteroEntre(generador, 4, 8);
}

/**
 * Sesiones de un día civil: llegada 08:00–11:00 (recortada al horario de la zona), duración
 * 1–8 h, y en días laborables una segunda visita por la tarde en ~1 de cada 5 asistentes.
 *
 * La calibración es contra el pico *del día* (11:00–15:00) y contra el número de usuarios:
 *   - la asistencia se sortea con probabilidad `objetivoDia / usuarios`, no con 0,95 fijo; si la
 *     zona tiene más usuarios que plazas, el día no se desborda (antes un aforo chico terminaba
 *     al 83 % aunque se pidiera 62 %);
 *   - se agregan refuerzos largos hasta llegar al objetivo;
 *   - se descartan bloques si el día se pasó del tope (objetivo + 10 %), para no salir de la
 *     banda de 55–70 % que pide la demo.
 */
function generarBloquesDelDia(contexto: ContextoSimulacion, dia: FechaCivil): BloqueDia[] {
  const { generador, usuarios, apertura, cierre } = contexto;
  const dow = diaIso(dia);
  const factor = (PROBABILIDAD_ASISTENCIA[dow] ?? 0.9) / PROBABILIDAD_MAXIMA;
  const objetivoDia = Math.max(2, Math.round(contexto.objetivoPico * factor));
  const topeDia = Math.max(objetivoDia, Math.round(objetivoDia * 1.1));

  const llegadaDesde = Math.max(apertura, 8 * 60);
  const llegadaHasta = Math.max(llegadaDesde + 60, Math.min(llegadaDesde + 180, cierre - 120));

  const probabilidad = Math.min(0.95, objetivoDia / Math.max(1, usuarios.length));

  const delDia: BloqueDia[] = [];
  const ocupados = new Set<number>();

  for (let indice = 0; indice < usuarios.length; indice += 1) {
    if (generador() >= probabilidad) continue;

    // Suma de dos uniformes: llegadas concentradas a media mañana, no uniformes.
    const desfase = Math.round(((generador() + generador()) / 2) * (llegadaHasta - llegadaDesde));
    const duracion = 60 * duracionDelDia(generador, dow);
    const principal = crearBloqueDia(indice, llegadaDesde + desfase, duracion, cierre);
    if (!principal) continue;
    delDia.push(principal);
    ocupados.add(indice);

    if (DIAS_LABORALES.has(dow) && generador() < 0.22) {
      const reingreso = principal.salidaMin + enteroEntre(generador, 60, 150);
      const segunda = crearBloqueDia(indice, reingreso, 60 * enteroEntre(generador, 1, 3), cierre);
      // Sin solapes: la vuelta empieza al menos 30 min después de la salida anterior.
      if (segunda && segunda.entradaMin >= principal.salidaMin + 30) delDia.push(segunda);
    }
  }

  let pico = picoEnVentana(delDia);

  // Faltan personas para llegar al pico objetivo: se suman usuarios que aún no vinieron.
  for (let intento = 0; pico < objetivoDia && intento < usuarios.length; intento += 1) {
    const libre = primerUsuarioLibre(usuarios.length, ocupados);
    if (libre === null) break;
    const desdeRefuerzo = Math.max(llegadaDesde, 9 * 60);
    const entrada =
      desdeRefuerzo + enteroEntre(generador, 0, Math.max(0, llegadaHasta - desdeRefuerzo));
    // Refuerzos largos (5–8 h) para que sostengan la meseta de 11:00 a 15:00, no un pico suelto.
    const bloque = crearBloqueDia(libre, entrada, 60 * enteroEntre(generador, 5, 8), cierre);
    if (!bloque) break;
    delDia.push(bloque);
    ocupados.add(libre);
    pico = picoEnVentana(delDia);
  }

  // Se pasó del tope: se descartan los últimos bloques (refuerzos) hasta volver a la banda.
  // Se conserva al menos una sesión para no dejar un día vacío por una fluctuación.
  while (pico > topeDia && delDia.length > 1) {
    delDia.pop();
    pico = picoEnVentana(delDia);
  }

  return delDia;
}

/** Convierte los bloques de cada día civil a instantes absolutos del huso de la zona. */
function generarSesiones(
  contexto: ContextoSimulacion,
  desdeMs: number,
  hastaMs: number,
): Bloque[] {
  const { zona } = contexto;
  const sesiones: Bloque[] = [];

  // +1 min para que la medianoche local caiga ya dentro del primer día simulado.
  const primerDia = partesLocales(desdeMs + 60_000, zona.timezone);

  for (let desplazamiento = 0; desplazamiento < DIAS_SIMULADOS; desplazamiento += 1) {
    const dia = sumarDias(primerDia, desplazamiento);
    const bloques = generarBloquesDelDia(contexto, dia);

    for (const bloque of bloques) {
      const entradaMs = instanteDeHoraLocal(
        zona.timezone,
        dia.anio,
        dia.mes,
        dia.dia,
        bloque.entradaMin,
      );
      const salidaMs = instanteDeHoraLocal(
        zona.timezone,
        dia.anio,
        dia.mes,
        dia.dia,
        bloque.salidaMin,
      );
      if (entradaMs < desdeMs || entradaMs >= hastaMs) continue;
      if (salidaMs <= entradaMs) continue;
      sesiones.push({ usuario: bloque.usuario, entradaMs, salidaMs });
    }
  }

  return sesiones;
}

async function insertarSesiones(
  supabase: ClienteSupabase,
  zonaId: string,
  usuarios: readonly UsuarioSimulado[],
  sesiones: readonly Bloque[],
): Promise<number> {
  const tamano = 500;
  let insertadas = 0;

  for (let desde = 0; desde < sesiones.length; desde += tamano) {
    const lote = sesiones.slice(desde, desde + tamano).map((sesion) => {
      const usuario = usuarios[sesion.usuario];
      return {
        user_id: usuario.id,
        zona_id: zonaId,
        entrada_at: new Date(sesion.entradaMs).toISOString(),
        salida_at: new Date(sesion.salidaMs).toISOString(),
        // Sesión cerrada y coherente con el check `sesiones_salida_coherente`.
        cierre: "usuario" as const,
      };
    });

    const { error } = await supabase.from("sesiones").insert(lote);
    if (error) throw new Error(`No se pudieron insertar las sesiones: ${error.message}`);
    insertadas += lote.length;
    console.log(`  sesiones: ${insertadas}/${sesiones.length}`);
  }

  return insertadas;
}

// ---------------------------------------------------------------- snapshots cada 5 min

type ConsultaPaginada<T> = (
  desde: number,
  hasta: number,
) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>;

async function traerTodasLasPaginas<T>(
  consulta: ConsultaPaginada<T>,
  descripcion: string,
): Promise<T[]> {
  const porPagina = 1000;
  const filas: T[] = [];
  for (let desde = 0; ; desde += porPagina) {
    const { data, error } = await consulta(desde, desde + porPagina - 1);
    if (error) throw new Error(`No se pudo leer ${descripcion}: ${error.message}`);
    if (!data) break;
    filas.push(...data);
    if (data.length < porPagina) break;
  }
  return filas;
}

/**
 * Todas las sesiones de la zona que se solapan con el período: las abiertas y las cerradas
 * cuya salida cae después del inicio. Los snapshots se recalculan con esto, así que cuentan
 * tanto las sesiones reales como las simuladas.
 */
async function traerSesionesDelRango(
  supabase: ClienteSupabase,
  zonaId: string,
  desdeIso: string,
  hastaIso: string,
): Promise<FilaSesion[]> {
  const columnas = "entrada_at,salida_at";

  const abiertas = await traerTodasLasPaginas<FilaSesion>(
    (desde, hasta) =>
      supabase
        .from("sesiones")
        .select(columnas)
        .eq("zona_id", zonaId)
        .lt("entrada_at", hastaIso)
        .is("salida_at", null)
        .order("entrada_at", { ascending: true })
        .range(desde, hasta),
    "las sesiones abiertas",
  );

  const cerradas = await traerTodasLasPaginas<FilaSesion>(
    (desde, hasta) =>
      supabase
        .from("sesiones")
        .select(columnas)
        .eq("zona_id", zonaId)
        .lt("entrada_at", hastaIso)
        .gt("salida_at", desdeIso)
        .order("entrada_at", { ascending: true })
        .range(desde, hasta),
    "las sesiones cerradas del período",
  );

  return [...abiertas, ...cerradas];
}

/**
 * Cuántas personas había dentro en cada bucket de 5 min, contando las sesiones abiertas en ese
 * instante (`entrada_at <= ts < salida_at`). Se resuelve con un arreglo de diferencias para no
 * recorrer miles de sesiones × 8.640 buckets.
 */
function calcularBuckets(
  sesiones: readonly FilaSesion[],
  desdeMs: number,
  hastaMs: number,
): number[] {
  const total = Math.max(1, Math.ceil((hastaMs - desdeMs) / MS_BUCKET));
  const diferencias = new Int32Array(total + 1);

  for (const sesion of sesiones) {
    const entrada = Date.parse(sesion.entrada_at);
    if (!Number.isFinite(entrada)) continue;
    const salida = sesion.salida_at === null ? hastaMs : Date.parse(sesion.salida_at);
    if (!Number.isFinite(salida)) continue;

    const primero = Math.max(0, Math.ceil((entrada - desdeMs) / MS_BUCKET));
    const ultimo = Math.min(total - 1, Math.ceil((salida - desdeMs) / MS_BUCKET) - 1);
    if (ultimo < primero) continue;

    diferencias[primero] += 1;
    diferencias[ultimo + 1] -= 1;
  }

  const conteos: number[] = new Array(total);
  let acumulado = 0;
  for (let indice = 0; indice < total; indice += 1) {
    acumulado += diferencias[indice];
    conteos[indice] = acumulado;
  }
  return conteos;
}

async function contarSnapshotsExistentes(
  supabase: ClienteSupabase,
  zonaId: string,
  desdeIso: string,
  hastaIso: string,
): Promise<number> {
  const { count, error } = await supabase
    .from("snapshots_ocupacion")
    .select("ts", { count: "exact", head: true })
    .eq("zona_id", zonaId)
    .gte("ts", desdeIso)
    .lt("ts", hastaIso);
  if (error) throw new Error(`No se pudieron contar los snapshots: ${error.message}`);
  return count ?? 0;
}

/**
 * Borra los snapshots de la zona dentro de [desde, hasta) y devuelve cuántos había.
 *
 * Se usa en `--reemplazar` y en `--limpiar` ANTES de reescribir la serie. El upsert solo
 * reemplaza la fila cuyo `ts` coincide exacto con el que genera este script; cualquier snapshot
 * del período con otro `ts` (otra fuente, otra grilla, un cron con reloj desfasado) quedaría
 * vivo y ensuciaría el histórico. Borrar primero deja la ventana exactamente con lo recalculado.
 */
async function borrarSnapshotsDelRango(
  supabase: ClienteSupabase,
  zonaId: string,
  desdeIso: string,
  hastaIso: string,
): Promise<number> {
  const { count, error: errorCuenta } = await supabase
    .from("snapshots_ocupacion")
    .select("ts", { count: "exact", head: true })
    .eq("zona_id", zonaId)
    .gte("ts", desdeIso)
    .lt("ts", hastaIso);
  if (errorCuenta) throw new Error(`No se pudieron contar los snapshots: ${errorCuenta.message}`);

  const { error } = await supabase
    .from("snapshots_ocupacion")
    .delete()
    .eq("zona_id", zonaId)
    .gte("ts", desdeIso)
    .lt("ts", hastaIso);
  if (error) throw new Error(`No se pudieron borrar los snapshots: ${error.message}`);

  return count ?? 0;
}

async function escribirSnapshots(
  supabase: ClienteSupabase,
  zonaId: string,
  desdeMs: number,
  conteos: readonly number[],
): Promise<number> {
  const tamano = 1000;
  let escritos = 0;

  for (let desde = 0; desde < conteos.length; desde += tamano) {
    const filas: { zona_id: string; ts: string; cantidad: number }[] = [];
    const limite = Math.min(desde + tamano, conteos.length);
    for (let indice = desde; indice < limite; indice += 1) {
      filas.push({
        zona_id: zonaId,
        ts: new Date(desdeMs + indice * MS_BUCKET).toISOString(),
        cantidad: conteos[indice],
      });
    }

    // Upsert por la PK (zona_id, ts): reescribe el bucket si ya existía.
    const { error } = await supabase
      .from("snapshots_ocupacion")
      .upsert(filas, { onConflict: "zona_id,ts" });
    if (error) throw new Error(`No se pudieron escribir los snapshots: ${error.message}`);

    escritos += filas.length;
    console.log(`  snapshots: ${escritos}/${conteos.length}`);
  }

  return escritos;
}

/** Divide una lista en lotes: evita URLs gigantes en los filtros `in(...)` de PostgREST. */
function enLotes<T>(elementos: readonly T[], tamano: number): T[][] {
  const lotes: T[][] = [];
  for (let desde = 0; desde < elementos.length; desde += tamano) {
    lotes.push(elementos.slice(desde, desde + tamano));
  }
  return lotes;
}

/** Borra solo las sesiones de los usuarios simulados dentro del período (nunca las reales). */
async function borrarSesionesSimuladas(
  supabase: ClienteSupabase,
  zonaId: string,
  usuarios: readonly UsuarioSimulado[],
  desdeIso: string,
  hastaIso: string,
): Promise<number> {
  if (usuarios.length === 0) return 0;
  const ids = usuarios.map((usuario) => usuario.id);
  let borradas = 0;

  for (const lote of enLotes(ids, 150)) {
    const { count, error: errorCuenta } = await supabase
      .from("sesiones")
      .select("id", { count: "exact", head: true })
      .eq("zona_id", zonaId)
      .in("user_id", lote)
      .gte("entrada_at", desdeIso)
      .lt("entrada_at", hastaIso);
    if (errorCuenta) throw new Error(`No se pudieron contar las sesiones: ${errorCuenta.message}`);

    const { error } = await supabase
      .from("sesiones")
      .delete()
      .eq("zona_id", zonaId)
      .in("user_id", lote)
      .gte("entrada_at", desdeIso)
      .lt("entrada_at", hastaIso);
    if (error) throw new Error(`No se pudieron borrar las sesiones simuladas: ${error.message}`);

    borradas += count ?? 0;
  }

  return borradas;
}

type ContextoRango = {
  supabase: ClienteSupabase;
  zona: Zona;
  desdeMs: number;
  hastaMs: number;
};

/**
 * Recalcula la serie del período con las sesiones que haya hoy en la zona (reales y simuladas) y
 * la escribe por upsert. Con `borrarAntes` borra primero los snapshots del rango, para que no
 * queden filas viejas ajenas a la grilla de 5 min que genera este script.
 */
async function recalcularSnapshotsDelRango(
  contexto: ContextoRango,
  opciones: { borrarAntes?: boolean } = {},
): Promise<{ escritos: number; pico: number; borrados: number }> {
  const desdeIso = new Date(contexto.desdeMs).toISOString();
  const hastaIso = new Date(contexto.hastaMs).toISOString();

  const borrados = opciones.borrarAntes
    ? await borrarSnapshotsDelRango(contexto.supabase, contexto.zona.id, desdeIso, hastaIso)
    : 0;
  if (borrados > 0) console.log(`  snapshots anteriores borrados: ${borrados}`);

  const sesiones = await traerSesionesDelRango(
    contexto.supabase,
    contexto.zona.id,
    desdeIso,
    hastaIso,
  );
  const conteos = calcularBuckets(sesiones, contexto.desdeMs, contexto.hastaMs);
  const escritos = await escribirSnapshots(
    contexto.supabase,
    contexto.zona.id,
    contexto.desdeMs,
    conteos,
  );

  let pico = 0;
  for (const cantidad of conteos) if (cantidad > pico) pico = cantidad;
  return { escritos, pico, borrados };
}

/**
 * `--limpiar`: borra los usuarios `sim-*` (sus sesiones caen por el FK `on delete cascade`) y
 * deja la serie histórica recalculada con lo que queda, para volver al estado real.
 */
async function limpiarSimulacion(contexto: ContextoRango): Promise<void> {
  const { supabase, zona } = contexto;
  const simulados = await listarSimulados(supabase);

  if (simulados.length === 0) {
    console.log("No hay usuarios sim-* que borrar: solo se recalculan los snapshots.");
  }

  let borrados = 0;
  for (const usuario of simulados) {
    const { error } = await supabase.auth.admin.deleteUser(usuario.id);
    if (error) throw new Error(`No se pudo borrar un usuario simulado: ${error.message}`);
    borrados += 1;
  }
  console.log(`Usuarios simulados borrados: ${borrados}`);

  // Verificación explícita del FK: si quedaran sesiones huérfanas, se borran aquí.
  let huerfanas = 0;
  if (simulados.length > 0) {
    const ids = simulados.map((usuario) => usuario.id);
    for (const lote of enLotes(ids, 150)) {
      const { count, error: errorCuenta } = await supabase
        .from("sesiones")
        .select("id", { count: "exact", head: true })
        .in("user_id", lote);
      if (errorCuenta) {
        throw new Error(`No se pudieron verificar las sesiones: ${errorCuenta.message}`);
      }
      const restantes = count ?? 0;
      huerfanas += restantes;

      if (restantes > 0) {
        const { error } = await supabase.from("sesiones").delete().in("user_id", lote);
        if (error) throw new Error(`No se pudieron borrar las sesiones huérfanas: ${error.message}`);
      }
    }
    console.log(
      huerfanas > 0
        ? `Sesiones huérfanas borradas a mano (el FK no estaba en cascada): ${huerfanas}`
        : "El FK borró en cascada las sesiones de los usuarios simulados.",
    );
  }

  const {
    escritos,
    pico,
    borrados: snapshotsBorrados,
  } = await recalcularSnapshotsDelRango(contexto, { borrarAntes: true });
  await refrescarOcupacion(supabase, zona.id);

  console.log("\nResumen de la limpieza");
  console.log(`  Usuarios simulados borrados: ${borrados}`);
  console.log(`  Snapshots borrados y reescritos: ${snapshotsBorrados} → ${escritos}`);
  console.log(`  Pico que queda en el período: ${pico} personas`);
  console.log("  ocupacion_actual refrescada con las sesiones restantes.");
}

// ---------------------------------------------------------------- dry-run (no escribe nada)

/** Nivel del mapa de calor, con la misma escala que `MapaCalorDashboard` (1..5). */
function nivelDeMapaCalor(porcentaje: number): number {
  for (let nivel = 1; nivel <= UMBRALES_MAPA_CALOR.length; nivel += 1) {
    if (porcentaje < UMBRALES_MAPA_CALOR[nivel - 1]) return nivel;
  }
  return UMBRALES_MAPA_CALOR.length + 1;
}

/** Leyendas de los niveles, solo para el resumen de `--dry-run`. */
const ETIQUETAS_NIVEL = ["< 20 %", "20–39 %", "40–59 %", "60–79 %", "≥ 80 %"] as const;

/**
 * Aviso compartido por `--dry-run` y la corrida real: con N usuarios el pico no puede pasar de N
 * personas (nadie está dos veces dentro), así que si se pidió más se explica cómo subirlo.
 */
function avisoPicoLimitado(
  aforoMax: number,
  usuarios: number,
  picoPedido: number,
  objetivoPico: number,
  pico: number,
): string | null {
  if (objetivoPico >= picoPedido) return null;
  return (
    `Aviso: con ${usuarios} usuarios el pico ronda ${objetivoPico} personas ` +
    `(${Math.round((objetivoPico / aforoMax) * 100)} % del aforo) y no el ${pico} % pedido, ` +
    `porque una misma persona no puede estar dos veces dentro. ` +
    `Para llegar al ${pico} % usa --usuarios ${picoPedido}.`
  );
}

/**
 * `--dry-run`: calcula la simulación completa y la imprime SIN escribir nada, SIN crear usuarios
 * y SIN pedir confirmación. Es puro cálculo: la zona la leyó el llamador y no se consulta nada
 * más de la base. Sirve para calibrar `--usuarios` / `--pico` / `--semilla` antes de tocar datos.
 */
function ejecutarDryRun(
  zona: Zona,
  opciones: Opciones,
  desdeMs: number,
  hastaMs: number,
  apertura: number,
  cierre: number,
  rango: string,
): void {
  // Usuarios ficticios: mismo índice que los reales (`sim-01`, `sim-02`, …), sin id de Auth.
  const usuarios: UsuarioSimulado[] = Array.from({ length: opciones.usuarios }, (_, indice) => ({
    id: `simulado-${indice + 1}`,
    correo: correoSimulado(indice + 1),
  }));

  const picoPedido = Math.round((zona.aforo_max * opciones.pico) / 100);
  const objetivoPico = Math.max(3, Math.min(usuarios.length, picoPedido));
  const generador = crearGenerador(opciones.semilla);
  const sesiones = generarSesiones(
    { zona, apertura, cierre, usuarios, generador, objetivoPico },
    desdeMs,
    hastaMs,
  );

  const filas: FilaSesion[] = sesiones.map((sesion) => ({
    entrada_at: new Date(sesion.entradaMs).toISOString(),
    salida_at: new Date(sesion.salidaMs).toISOString(),
  }));
  const conteos = calcularBuckets(filas, desdeMs, hastaMs);

  // Pico absoluto (bucket de 5 min) y su hora local.
  let pico = 0;
  let picoIndice = 0;
  for (let indice = 0; indice < conteos.length; indice += 1) {
    if (conteos[indice] > pico) {
      pico = conteos[indice];
      picoIndice = indice;
    }
  }

  // Permanencia, solapes por usuario y personas distintas de cada día civil.
  let minutos = 0;
  const porUsuario = new Map<number, Bloque[]>();
  const personas = new Map<string, Set<number>>();
  for (const sesion of sesiones) {
    minutos += (sesion.salidaMs - sesion.entradaMs) / 60_000;
    const lista = porUsuario.get(sesion.usuario) ?? [];
    lista.push(sesion);
    porUsuario.set(sesion.usuario, lista);

    const dia = partesLocales(sesion.entradaMs, zona.timezone);
    const claveDia =
      `${dia.anio}-${String(dia.mes).padStart(2, "0")}-${String(dia.dia).padStart(2, "0")}`;
    const conjunto = personas.get(claveDia) ?? new Set<number>();
    conjunto.add(sesion.usuario);
    personas.set(claveDia, conjunto);
  }

  let solapes = 0;
  for (const lista of porUsuario.values()) {
    lista.sort((a, b) => a.entradaMs - b.entradaMs);
    for (let indice = 1; indice < lista.length; indice += 1) {
      if (lista[indice].entradaMs < lista[indice - 1].salidaMs) solapes += 1;
    }
  }

  // Mapa de calor: cada celda es el promedio de los buckets de esa (día de semana, hora local),
  // igual que `construirMatrizCalor` en el dashboard. Solo horas dentro del horario de la zona.
  const acumulado = new Map<string, { suma: number; muestras: number }>();
  for (let indice = 0; indice < conteos.length; indice += 1) {
    const partes = partesLocales(desdeMs + indice * MS_BUCKET, zona.timezone);
    const minutoDelDia = partes.hora * 60 + partes.minuto;
    if (minutoDelDia < apertura || minutoDelDia >= cierre) continue;
    const claveCelda = `${diaIso(partes)}-${partes.hora}`;
    const celda = acumulado.get(claveCelda) ?? { suma: 0, muestras: 0 };
    celda.suma += conteos[indice];
    celda.muestras += 1;
    acumulado.set(claveCelda, celda);
  }

  const celdasPorNivel = [0, 0, 0, 0, 0];
  let celdaMaxima = 0;
  for (const celda of acumulado.values()) {
    const porcentaje = (celda.suma / Math.max(1, celda.muestras) / zona.aforo_max) * 100;
    if (porcentaje > celdaMaxima) celdaMaxima = porcentaje;
    celdasPorNivel[nivelDeMapaCalor(porcentaje) - 1] += 1;
  }

  const dias = [...personas.entries()].sort(([a], [b]) => a.localeCompare(b));
  const cantidades = dias.map(([, conjunto]) => conjunto.size);
  const promedioDias =
    cantidades.length > 0
      ? cantidades.reduce((total, valor) => total + valor, 0) / cantidades.length
      : 0;
  const indiceMinimo = cantidades.indexOf(Math.min(...cantidades));
  const indiceMaximo = cantidades.indexOf(Math.max(...cantidades));
  const diasFlacos = cantidades.filter((cantidad) => cantidad < 5).length;
  const permanencia = sesiones.length > 0 ? minutos / sesiones.length / 60 : 0;
  const porcentajePico = Math.round((pico / zona.aforo_max) * 100);

  console.log("\nDRY-RUN: no se escribe nada y no se crean usuarios (solo se lee la zona).");
  console.log(
    `Zona: ${zona.slug} · aforo ${zona.aforo_max} · horario ${zona.hora_apertura}–` +
      `${zona.hora_cierre} (${zona.timezone})`,
  );
  console.log(`Período: ${rango} (${DIAS_SIMULADOS} días civiles)`);
  console.log(
    `Parámetros: semilla ${opciones.semilla} · ${usuarios.length} usuarios · ` +
      `pico objetivo ${opciones.pico} % del aforo`,
  );
  const aviso = avisoPicoLimitado(
    zona.aforo_max,
    usuarios.length,
    picoPedido,
    objetivoPico,
    opciones.pico,
  );
  if (aviso) console.log(aviso);

  console.log("\nSesiones");
  console.log(`  total: ${sesiones.length}`);
  console.log(`  permanencia promedio: ${permanencia.toFixed(2)} h`);
  console.log(`  solapes entre sesiones del mismo usuario: ${solapes}`);

  console.log("\nPico");
  console.log(`  ${pico} personas ≈ ${porcentajePico} % del aforo`);
  console.log(`  cuándo: ${formatearInstante(desdeMs + picoIndice * MS_BUCKET, zona.timezone)}`);

  console.log("\nPersonas distintas por día");
  if (cantidades.length === 0) {
    console.log("  sin sesiones: no hay días que resumir");
  } else {
    console.log(
      `  promedio ${promedioDias.toFixed(1)} · mínimo ${cantidades[indiceMinimo]} ` +
        `(${dias[indiceMinimo][0]}) · máximo ${cantidades[indiceMaximo]} ` +
        `(${dias[indiceMaximo][0]})`,
    );
    console.log(`  días con menos de 5 personas (las estadísticas los ocultan): ${diasFlacos}`);
    console.log(`  serie (${cantidades.length} días): ${cantidades.join(" ")}`);
  }

  console.log("\nMapa de calor (promedio de los buckets de cada celda día × hora)");
  for (let nivel = 1; nivel <= celdasPorNivel.length; nivel += 1) {
    console.log(
      `  nivel ${nivel} (${ETIQUETAS_NIVEL[nivel - 1]}): ${celdasPorNivel[nivel - 1]} celdas`,
    );
  }
  console.log(
    `  celdas con datos: ${acumulado.size} · celda más alta: ` +
      `${celdaMaxima.toFixed(0)} % del aforo`,
  );
  console.log("\nPara escribir de verdad, vuelve a ejecutar sin --dry-run.");
}

// ---------------------------------------------------------------- programa principal

async function main(): Promise<void> {
  const opciones = leerOpciones(argv.slice(2));
  const configuracion = leerConfiguracion();

  const supabase = createClient(configuracion.url, configuracion.claveServicio, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const zona = await obtenerZona(supabase, opciones.zona);
  const apertura = minutosDeHoraTexto(zona.hora_apertura);
  const cierre = minutosDeHoraTexto(zona.hora_cierre);
  if (apertura === null || cierre === null || cierre <= apertura) {
    throw new Error(
      `La zona "${zona.slug}" tiene un horario inválido (${zona.hora_apertura}–${zona.hora_cierre}).`,
    );
  }

  // Período: 30 días civiles completos que terminan en la medianoche local de hoy. Se resta
  // sobre el calendario local y se vuelve a instantes absolutos, así el DST no corre un día.
  const hoy = partesLocales(Date.now(), zona.timezone);
  const hastaMs = instanteDeHoraLocal(zona.timezone, hoy.anio, hoy.mes, hoy.dia, 0);
  const inicio = sumarDias(hoy, -DIAS_SIMULADOS);
  const desdeMs = instanteDeHoraLocal(zona.timezone, inicio.anio, inicio.mes, inicio.dia, 0);
  const desdeIso = new Date(desdeMs).toISOString();
  const hastaIso = new Date(hastaMs).toISOString();
  const rango =
    `${formatearInstante(desdeMs, zona.timezone)} → ` +
    `${formatearInstante(hastaMs, zona.timezone)}`;

  // `--dry-run` es solo cálculo: no consulta snapshots, no crea usuarios y no pide confirmación.
  if (opciones.dryRun) {
    ejecutarDryRun(zona, opciones, desdeMs, hastaMs, apertura, cierre, rango);
    return;
  }

  // Antes de pedir confirmación (y de escribir nada): si el período ya tiene snapshots, se
  // aborta. Así nadie escribe "si" para recibir un error después. `--limpiar` siempre recalcula,
  // pero los snapshots del período se cuentan igual porque se borran y se reescriben.
  const existentes = await contarSnapshotsExistentes(supabase, zona.id, desdeIso, hastaIso);
  if (existentes > 0 && !opciones.reemplazar && !opciones.limpiar) {
    throw new Error(
      `Ya hay ${existentes} snapshots en el período (${rango}).\n` +
        "Vuelve a ejecutar con --reemplazar para sobrescribirlos, o con --limpiar para borrar " +
        "la simulación anterior. No se escribió nada.",
    );
  }

  const detalles = [
    `Modo: ${opciones.limpiar ? "LIMPIEZA (--limpiar)" : "SIMULACIÓN"}`,
    `Zona: ${zona.slug} · aforo ${zona.aforo_max} · horario ${zona.hora_apertura}–` +
      `${zona.hora_cierre} (${zona.timezone})`,
    `Período: ${rango} (${DIAS_SIMULADOS} días civiles)`,
    opciones.limpiar
      ? "Se borrarán los usuarios sim-* y sus sesiones, y se recalcularán los snapshots."
      : `Usuarios simulados: ${opciones.usuarios} (semilla ${opciones.semilla}) · ` +
        `pico objetivo ${opciones.pico} % del aforo`,
  ];
  detalles.push(
    opciones.limpiar
      ? `Snapshots: se borran los ${existentes} del período y se reescriben con las sesiones ` +
          `que queden`
      : `Snapshots cada ${MINUTOS_BUCKET} min` +
          (existentes > 0
            ? ` (se borran y reescriben los ${existentes} del período)`
            : " (el período está vacío)"),
  );

  if (!(await confirmar(configuracion.host, detalles))) {
    console.log("Cancelado. No se escribió nada.");
    return;
  }

  if (opciones.limpiar) {
    await limpiarSimulacion({ supabase, zona, desdeMs, hastaMs });
    return;
  }

  console.log(`\n1/4 Usuarios simulados`);
  const generador = crearGenerador(opciones.semilla);
  const usuarios = await asegurarUsuarios(supabase, opciones.usuarios);
  console.log(
    `  usuarios: ${usuarios.lista.length} ` +
      `(creados ${usuarios.creados}, reutilizados ${usuarios.reutilizados})`,
  );

  if (opciones.reemplazar) {
    const previas = await borrarSesionesSimuladas(
      supabase,
      zona.id,
      usuarios.lista,
      desdeIso,
      hastaIso,
    );
    if (previas > 0) {
      console.log(`  sesiones de una corrida anterior reemplazadas: ${previas}`);
    }
  }

  // El pico no puede superar el número de usuarios: una persona no puede estar dos veces dentro.
  const picoPedido = Math.round((zona.aforo_max * opciones.pico) / 100);
  const objetivoPico = Math.max(3, Math.min(usuarios.lista.length, picoPedido));
  const avisoPico = avisoPicoLimitado(
    zona.aforo_max,
    usuarios.lista.length,
    picoPedido,
    objetivoPico,
    opciones.pico,
  );
  if (avisoPico) console.log(`  ${avisoPico}`);

  console.log("\n2/4 Sesiones");
  const sesiones = generarSesiones(
    { zona, apertura, cierre, usuarios: usuarios.lista, generador, objetivoPico },
    desdeMs,
    hastaMs,
  );
  const insertadas = await insertarSesiones(supabase, zona.id, usuarios.lista, sesiones);

  console.log(`\n3/4 Snapshots cada ${MINUTOS_BUCKET} min`);
  // Con --reemplazar se borran primero los snapshots del período y luego se reescribe la serie
  // completa: el upsert solo pisa las filas cuyo `ts` coincide exacto con la grilla del script.
  const {
    escritos,
    pico,
    borrados: snapshotsBorrados,
  } = await recalcularSnapshotsDelRango(
    { supabase, zona, desdeMs, hastaMs },
    { borrarAntes: opciones.reemplazar },
  );

  console.log("\n4/4 ocupacion_actual");
  await refrescarOcupacion(supabase, zona.id);

  const porcentaje = Math.round((pico / zona.aforo_max) * 100);
  console.log("\nResumen");
  console.log(
    `  Usuarios simulados: ${usuarios.lista.length} ` +
      `(creados ${usuarios.creados}, reutilizados ${usuarios.reutilizados})`,
  );
  console.log(`  Sesiones insertadas: ${insertadas}`);
  console.log(`  Snapshots escritos: ${escritos} (cada ${MINUTOS_BUCKET} min de ${rango})`);
  if (opciones.reemplazar) {
    console.log(`  Snapshots previos borrados: ${snapshotsBorrados}`);
  }
  console.log(`  Pico del período: ${pico} personas ≈ ${porcentaje} % del aforo`);
  console.log("  ocupacion_actual refrescada.");
  if (porcentaje < 55 || porcentaje > 70) {
    console.log(
      `  Aviso: el pico quedó fuera de la banda 55–70 % que pide la demo. Súbelo con ` +
        `--usuarios (más usuarios = más gente dentro a la vez, hasta el tope de --pico) o ` +
        `cámbialo con --pico.`,
    );
  }
  if (porcentaje < 80) {
    console.log(
      `  El nivel más alto del mapa de calor (≥ 80 %) queda sin usar a propósito: la demo no ` +
        `simula saturación. Para verlo: --usuarios ${Math.ceil(zona.aforo_max * 0.95)} --pico 90.`,
    );
  }
  console.log(
    "\nPara volver al estado real: node --env-file=.env.local scripts/simular-ocupacion.ts --limpiar",
  );
}

main().catch((error: unknown) => {
  const mensaje = error instanceof Error ? error.message : String(error);
  console.error(`\nError: ${mensaje}`);
  exit(1);
});

