import pg from "pg";
import { readdir, readFile } from "node:fs/promises";
const url = new URL(process.env.COWORKFLOW_E2E_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres");
if (!["localhost","127.0.0.1","[::1]"].includes(url.hostname)) throw new Error("E2E solo puede preparar una base LOCAL descartable");
const cliente = new pg.Client({ connectionString: url.toString() });
await cliente.connect();
try {
  const carpeta = new URL("../supabase/migrations/", import.meta.url);
  for (const archivo of (await readdir(carpeta)).filter((a) => a.endsWith(".sql")).sort()) {
    const sql = await readFile(new URL(archivo,carpeta),"utf8");
    const marcador = "alter type public.resultado_scan add value if not exists 'sin_consentimiento';";
    if (sql.includes(marcador)) {
      const corte = sql.indexOf(marcador) + marcador.length;
      await cliente.query(sql.slice(0,corte)); await cliente.query(sql.slice(corte));
    } else await cliente.query(sql);
  }
  await cliente.query("insert into public.app_secrets(clave,valor) values ('qr_token_secret',$1),('qr_window_seconds','45') on conflict(clave) do update set valor=excluded.valor",["ab".repeat(32)]);
  await cliente.query(`insert into public.zonas(id,slug,nombre,aforo_max,timezone,hora_apertura,hora_cierre)
    values ('11111111-1111-4111-8111-111111111111','prueba-e2e','Cowork de prueba',100,'UTC','00:00','24:00')
    on conflict(id) do nothing`);
  // Solo el entorno descartable: evita que los jobs interfieran con los tiempos de la prueba.
  const cron = await cliente.query("select to_regclass('cron.job') as tabla");
  if (cron.rows[0].tabla) {
    await cliente.query("select cron.unschedule(jobid) from cron.job where jobname like 'coworkflow_%'");
  }
  await cliente.query("notify pgrst, 'reload schema'");
  console.log("Migraciones y zona E2E preparadas en Supabase local.");
} finally { await cliente.end(); }
