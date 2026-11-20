import pg from "pg";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/** Base efímera local: prohibido conectar estas pruebas destructivas a una base remota. */
export async function crearBasePruebas() {
  const conexion = process.env.COWORKFLOW_TEST_DATABASE_URL;
  if (!conexion) throw new Error("Define COWORKFLOW_TEST_DATABASE_URL (PostgreSQL local con CREATEDB)");
  const url = new URL(conexion);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("Solo se permiten pruebas en loopback");
  const administrador = new pg.Client({ connectionString: conexion });
  await administrador.connect();
  const nombre = `coworkflow_rls_${randomUUID().replaceAll("-", "")}`;
  const roles = [];
  let pool;
  let creada = false;
  async function cerrar() {
    await pool?.end();
    try {
      if (creada) await administrador.query(`drop database "${nombre}" with (force)`);
      for (const rol of roles.reverse()) await administrador.query(`drop role ${rol}`);
    } finally { await administrador.end(); }
  }
  try {
    for (const rol of ["anon", "authenticated", "service_role"]) {
      if (!(await administrador.query("select 1 from pg_roles where rolname=$1", [rol])).rowCount) {
        await administrador.query(`create role ${rol} nologin`); roles.push(rol);
      }
    }
    await administrador.query(`create database "${nombre}"`); creada = true;
    url.pathname = `/${nombre}`;
    pool = new pg.Pool({ connectionString: url.toString(), options: "-c statement_timeout=10000", max: 5 });
    await pool.query(`create schema auth;
      create table auth.users(id uuid primary key);
      create table auth.sessions(id uuid primary key, user_id uuid references auth.users, not_after timestamptz);
      create function auth.jwt() returns jsonb language sql stable as
        $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
      create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
      grant usage on schema auth to anon, authenticated, service_role;
      alter default privileges in schema public grant execute on functions to service_role;
      create publication supabase_realtime;`);
    const carpeta = new URL("../../supabase/migrations/", import.meta.url);
    for (const archivo of (await readdir(carpeta)).filter((a) => a.endsWith(".sql")).sort()) {
      const sql = await readFile(new URL(archivo, carpeta), "utf8");
      const marcador = "alter type public.resultado_scan add value if not exists 'sin_consentimiento';";
      if (sql.includes(marcador)) {
        const corte = sql.indexOf(marcador) + marcador.length;
        await pool.query(sql.slice(0, corte)); await pool.query(sql.slice(corte));
      } else await pool.query(sql);
    }
    return { pool, cerrar, nombre, origen: fileURLToPath(carpeta),
      async como(rol, uid, sid, sql, parametros = []) {
        if (!["anon", "authenticated"].includes(rol)) throw new Error("Rol inválido");
        const cliente = await pool.connect();
        try {
          await cliente.query("begin"); await cliente.query(`set local role ${rol}`);
          await cliente.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ role: rol, sub: uid, session_id: sid })]);
          return await cliente.query(sql, parametros);
        } finally { await cliente.query("rollback"); cliente.release(); }
      },
    };
  } catch (error) { await cerrar(); throw error; }
}
