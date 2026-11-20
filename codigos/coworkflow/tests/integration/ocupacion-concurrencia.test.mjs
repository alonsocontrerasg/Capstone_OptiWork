/* Pruebas de PostgreSQL real: dos conexiones y esperas verificadas en pg_stat_activity.
 * node:test permite ejecutarlas sin arrancar Next ni cargar sus variables de entorno.
 * Solo crea/elimina una base temporal propia, en un servidor LOCAL con CREATEDB.
 */
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { setTimeout as esperar } from "node:timers/promises";
import { before, after, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Client, Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const conexion = process.env.COWORKFLOW_TEST_DATABASE_URL;
if (!conexion) throw new Error("Define COWORKFLOW_TEST_DATABASE_URL con un PostgreSQL local de pruebas.");
const url = new URL(conexion);
if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
  throw new Error("Las pruebas solo permiten PostgreSQL en loopback; no uses la base de producción.");
}
const nombre = `coworkflow_counter_${randomUUID().replaceAll("-", "")}`;
const urlPruebas = new URL(url);
urlPruebas.pathname = `/${nombre}`;
const carpetaSql = path.resolve(__dirname, "../../supabase/migrations");
const migracion = "20261119000000_ocupacion_concurrente.sql";
const zonaA = "00000000-0000-4000-8000-000000000001";
const zonaB = "00000000-0000-4000-8000-000000000002";
const secreto = "ab".repeat(32); // exclusivo de esta base efímera
let administrador;
let pool;
let baseCreada = false;
const rolesCreados = [];

async function comprobarContadores() {
  const { rows } = await pool.query(`
    select z.id, oa.cantidad, count(s.id)::integer as esperado
    from public.zonas z
    left join public.ocupacion_actual oa on oa.zona_id = z.id
    left join public.sesiones s on s.zona_id = z.id and s.salida_at is null
    group by z.id, oa.cantidad order by z.id
  `);
  for (const fila of rows) {
    assert.equal(fila.cantidad, fila.esperado, `Contador incorrecto en zona ${fila.id}`);
  }
}

async function usuarios(cantidad) {
  const ids = Array.from({ length: cantidad }, () => randomUUID());
  await pool.query("insert into auth.users(id) select unnest($1::uuid[])", [ids]);
  await pool.query("update public.profiles set consentimiento_at = now(), consentimiento_version = 1");
  return ids;
}

async function entrada(usuario, zona = zonaA, instante = new Date()) {
  await pool.query("insert into public.sesiones(user_id, zona_id, entrada_at) values ($1, $2, $3)", [usuario, zona, instante]);
}

async function esperarBloqueo(cliente, bloqueador) {
  const limite = Date.now() + 4000;
  while (Date.now() < limite) {
    const { rows } = await pool.query("select $2::integer = any(pg_blocking_pids($1)) as bloqueado", [cliente.processID, bloqueador.processID]);
    if (rows[0].bloqueado) return;
    await esperar(10);
  }
  throw new Error("No se observó el solapamiento esperado entre las dos conexiones.");
}

// A mantiene una escritura sin confirmar; B debe esperar el contador de A.
// Al confirmar A, B debe contar con una instantánea nueva, no con la anterior.
async function solapar(sqlA, parametrosA, sqlB, parametrosB, confirmar = true) {
  const a = await pool.connect();
  const b = await pool.connect();
  let pendiente;
  try {
    await a.query("begin");
    await a.query(sqlA, parametrosA);
    pendiente = b.query(sqlB, parametrosB).then(
      (valor) => ({ valor }), (error) => ({ error }),
    );
    await esperarBloqueo(b, a);
    await a.query(confirmar ? "commit" : "rollback");
    const resultado = await pendiente;
    if (resultado.error) throw resultado.error;
  } finally {
    await a.query("rollback");
    if (pendiente) await pendiente;
    a.release();
    b.release();
  }
  await comprobarContadores();
}

describe("ocupación concurrente en PostgreSQL", { concurrency: false }, () => {
  before(async () => {
    administrador = new Client({ connectionString: url.toString() });
    await administrador.connect();
    for (const rol of ["anon", "authenticated", "service_role"]) {
      const { rowCount } = await administrador.query("select 1 from pg_roles where rolname = $1", [rol]);
      if (!rowCount) {
        await administrador.query(`create role ${rol} nologin`);
        rolesCreados.push(rol);
      }
    }
    await administrador.query(`create database "${nombre}"`);
    baseCreada = true;
    pool = new Pool({
      connectionString: urlPruebas.toString(), max: 16,
      options: "-c statement_timeout=10000 -c lock_timeout=7000",
    });
    // Adaptador mínimo de Supabase Auth. Se usan las migraciones reales del repo.
    await pool.query(`
      create schema auth;
      create table auth.users (id uuid primary key);
      create table auth.sessions(id uuid primary key, user_id uuid references auth.users, not_after timestamptz);
      create function auth.jwt() returns jsonb language sql stable as
      $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
      create function auth.uid() returns uuid language sql stable as
      $$ select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid $$;
      grant usage on schema auth to anon, authenticated, service_role;
      alter default privileges in schema public grant execute on functions to service_role;
      create publication supabase_realtime;
    `);
    for (const archivo of (await readdir(carpetaSql)).filter((f) => f.endsWith(".sql") && f < migracion).sort()) {
      const sql = await readFile(path.join(carpetaSql, archivo), "utf8");
      const enumNuevo = "alter type public.resultado_scan add value if not exists 'sin_consentimiento';";
      if (sql.includes(enumNuevo)) {
        const corte = sql.indexOf(enumNuevo) + enumNuevo.length;
        await pool.query(sql.slice(0, corte));
        await pool.query(sql.slice(corte));
      } else await pool.query(sql);
    }
    if (process.env.COWORKFLOW_TEST_BASELINE !== "1") {
      await pool.query(await readFile(path.join(carpetaSql, migracion), "utf8"));
      for (const posterior of (await readdir(carpetaSql)).filter((f) => f.endsWith(".sql") && f > migracion).sort()) {
        await pool.query(await readFile(path.join(carpetaSql, posterior), "utf8"));
      }
    }
    await pool.query("insert into public.app_secrets(clave, valor) values ('qr_token_secret', $1)", [secreto]);
  }, { timeout: 60000 });

  after(async () => {
    await pool?.end();
    if (administrador) {
      try {
        if (baseCreada) {
          for (let intento=0;intento<100;intento++) {
            const conexiones=await administrador.query("select 1 from pg_stat_activity where datname=$1",[nombre]);
            if (!conexiones.rowCount) break;
            await esperar(20);
          }
          await administrador.query(`drop database "${nombre}"`);
        }
        for (const rol of rolesCreados.reverse()) await administrador.query(`drop role ${rol}`);
      } finally { await administrador.end(); }
    }
  });

  beforeEach(async () => {
    await pool.query("truncate public.zonas, auth.users cascade");
    await pool.query(`
      insert into public.zonas(id, slug, nombre, aforo_max, hora_apertura, hora_cierre, timezone)
      values ($1, 'prueba-a', 'Prueba A', 100, '00:00', '24:00', 'UTC'),
             ($2, 'prueba-b', 'Prueba B', 100, '00:00', '24:00', 'UTC')
    `, [zonaA, zonaB]);
  });

  it("conserva ambas entradas simultáneas de usuarios diferentes", async () => {
    const [uno, dos] = await usuarios(2);
    await solapar(
      "insert into public.sesiones(user_id, zona_id) values ($1, $2)", [uno, zonaA],
      "insert into public.sesiones(user_id, zona_id) values ($1, $2)", [dos, zonaA],
    );
  });

  it("conserva ambas salidas simultáneas", async () => {
    const ids = await usuarios(2);
    for (const id of ids) await entrada(id);
    const sql = "update public.sesiones set salida_at = now(), cierre = 'usuario' where user_id = $1";
    await solapar(sql, [ids[0]], sql, [ids[1]]);
  });

  it("combina una entrada y una salida simultáneas", async () => {
    const [sale, entra] = await usuarios(2);
    await entrada(sale);
    await solapar(
      "insert into public.sesiones(user_id, zona_id) values ($1, $2)", [entra, zonaA],
      "update public.sesiones set salida_at = now(), cierre = 'usuario' where user_id = $1", [sale],
    );
  });

  it("el cron espera una entrada y guarda un snapshot coherente", async () => {
    const [id] = await usuarios(1);
    await solapar(
      "insert into public.sesiones(user_id, zona_id) values ($1, $2)", [id, zonaA],
      "select public.cron_snapshot()", [],
    );
    const { rows } = await pool.query("select cantidad from public.snapshots_ocupacion where zona_id = $1", [zonaA]);
    assert.deepEqual(rows.map((f) => f.cantidad), [1]);
  });

  it("un rollback no deja una entrada fantasma", async () => {
    const [uno, dos] = await usuarios(2);
    const sql = "insert into public.sesiones(user_id, zona_id) values ($1, $2)";
    await solapar(sql, [uno, zonaA], sql, [dos, zonaA], false);
    assert.equal((await pool.query("select count(*)::integer as n from public.sesiones")).rows[0].n, 1);
  });

  it("una zona no bloquea las entradas de otra", async () => {
    const [uno, dos] = await usuarios(2);
    const a = await pool.connect();
    try {
      await a.query("begin");
      await a.query("insert into public.sesiones(user_id, zona_id) values ($1, $2)", [uno, zonaA]);
      await entrada(dos, zonaB); // termina antes de liberar A
    } finally {
      await a.query("rollback");
      a.release();
    }
    await comprobarContadores();
  });

  it("recalcula origen y destino al mover sesiones entre zonas", async () => {
    const ids = await usuarios(4);
    for (const id of ids) await entrada(id);
    await pool.query("update public.sesiones set zona_id = $1", [zonaB]);
    await comprobarContadores();
    assert.equal((await pool.query("select cantidad from public.ocupacion_actual where zona_id = $1", [zonaA])).rows[0].cantidad, 0);
    await pool.query("delete from public.sesiones where user_id = any($1::uuid[])", [ids.slice(0, 2)]);
    await comprobarContadores();
  });

  it("coordina el cierre automático de un lote con una salida de usuario", async () => {
    const ids = await usuarios(40);
    await pool.query(`insert into public.sesiones(user_id, zona_id, entrada_at)
      select unnest($1::uuid[]), $2, now() - interval '9 hours'`, [ids, zonaA]);
    await solapar(
      "update public.sesiones set salida_at = now(), cierre = 'usuario' where user_id = $1", [ids[0]],
      "select public.cron_cierre_auto()", [],
    );
    const { rows } = await pool.query("select cierre, count(*)::integer as n from public.sesiones group by cierre order by cierre::text");
    assert.deepEqual(rows, [{ cierre: "auto", n: 39 }, { cierre: "usuario", n: 1 }]);
  });

  it("registra 12 entradas y 12 salidas concurrentes mediante la RPC autenticada real", async () => {
    const ids = await usuarios(12);
    for (const modo of ["entrada", "salida"]) {
      const ventana = Math.floor(Date.now() / 45000);
      const payload = `v1.${zonaA}.${modo}.${ventana}`;
      const token = `${payload}.${createHmac("sha256", secreto).update(payload).digest("hex")}`;
      const resultados = await Promise.all(ids.map(async (id) => {
        const cliente = await pool.connect();
        try {
          await cliente.query("begin");
          await cliente.query("set local role authenticated");
          await cliente.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: id, role: "authenticated" })]);
          const { rows } = await cliente.query("select public.registrar_scan($1) as resultado", [token]);
          await cliente.query("commit");
          return rows[0].resultado;
        } finally {
          await cliente.query("rollback");
          cliente.release();
        }
      }));
      assert.deepEqual(resultados, ids.map(() => `${modo}_ok`));
      await comprobarContadores();
      // Adelanta el cooldown en los datos de prueba para probar la salida sin esperar 30 s.
      await pool.query("update public.eventos_scan set ts = now() - interval '1 minute'");
    }
  });

  it("la migración se puede reaplicar y repara una deriva anterior", async () => {
    const [id] = await usuarios(1);
    await entrada(id);
    await pool.query("update public.ocupacion_actual set cantidad = 99 where zona_id = $1", [zonaA]);
    const sql = await readFile(path.join(carpetaSql, migracion), "utf8");
    await pool.query(sql);
    await pool.query(sql);
    await comprobarContadores();
  });

  it("mantiene los permisos internos y la verificación del esquema", async () => {
    for (const funcion of ["refrescar_ocupacion(uuid)", "actualizar_ocupacion()", "cron_snapshot()"]) {
      const { rows } = await pool.query(`select
        has_function_privilege('anon', $1, 'execute') as anon,
        has_function_privilege('authenticated', $1, 'execute') as usuario,
        has_function_privilege('service_role', $1, 'execute') as servicio`, [`public.${funcion}`]);
      assert.deepEqual(rows[0], { anon: false, usuario: false, servicio: true });
    }
    await pool.query(await readFile(path.resolve(carpetaSql, "../verificacion.sql"), "utf8"));
  });
});
