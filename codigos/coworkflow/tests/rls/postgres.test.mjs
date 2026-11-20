import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, afterAll, describe, it, expect } from "vitest";
import { crearBasePruebas } from "../helpers/postgres.mjs";

let db;
const a = randomUUID(), b = randomUUID(), admin = randomUUID(), zona = randomUUID();
const sa = randomUUID(), sb = randomUUID(), sad = randomUUID();
const horarios = [{ dia_semana: 1, apertura: "08:30", cierre: "18:00" }];
const configuracion = "select public.actualizar_configuracion_zona($1,'Nuevo',120,35,75,true,$2::jsonb)";

beforeAll(async () => { db = await crearBasePruebas(); });
afterAll(async () => { await db?.cerrar(); });
beforeEach(async () => {
  await db.pool.query("truncate auth.users, public.zonas cascade");
  await db.pool.query("insert into auth.users(id) values ($1),($2),($3)", [a, b, admin]);
  await db.pool.query("insert into auth.sessions(id,user_id) values ($1,$2),($3,$4),($5,$6)", [sa,a,sb,b,sad,admin]);
  await db.pool.query("update public.profiles set rol='admin' where id=$1", [admin]);
  await db.pool.query("insert into public.zonas(id,slug,nombre,aforo_max,timezone) values ($1,'prueba','Prueba',100,'UTC')", [zona]);
  await db.pool.query("insert into public.sesiones(user_id,zona_id) values ($1,$3),($2,$3)", [a,b,zona]);
  await db.pool.query("insert into public.eventos_scan(user_id,zona_id,tipo,resultado) values ($1,$3,'entrada','entrada_ok'),($2,$3,'entrada','entrada_ok')", [a,b,zona]);
});

describe("RLS con roles reales de PostgreSQL", () => {
  it("cada usuario solo ve sus sesiones y su perfil; no ve auditoría", async () => {
    for (const [id,sid] of [[a,sa],[b,sb]]) {
      expect((await db.como("authenticated",id,sid,"select user_id from public.sesiones")).rows).toEqual([{ user_id: id }]);
      expect((await db.como("authenticated",id,sid,"select id from public.profiles")).rows).toEqual([{ id }]);
      expect((await db.como("authenticated",id,sid,"select * from public.eventos_scan")).rowCount).toBe(0);
    }
  });
  it("el público solo puede consultar datos agregados/configuración", async () => {
    for (const tabla of ["profiles", "sesiones", "eventos_scan", "app_secrets"]) {
      await expect(db.como("anon",null,null,`select * from public.${tabla}`)).rejects.toMatchObject({ code: "42501" });
    }
    expect((await db.como("anon",null,null,"select cantidad from public.ocupacion_actual")).rows[0].cantidad).toBe(2);
  });
  it("nadie inserta directamente sesiones/eventos ni se convierte en admin", async () => {
    for (const [id,sid] of [[a,sa],[admin,sad]]) {
      await expect(db.como("authenticated",id,sid,"insert into public.sesiones(user_id,zona_id) values ($1,$2)",[b,zona])).rejects.toMatchObject({ code: "42501" });
      await expect(db.como("authenticated",id,sid,"insert into public.eventos_scan(resultado) values ('entrada_ok')")).rejects.toMatchObject({ code: "42501" });
    }
    await expect(db.como("authenticated",a,sa,"update public.profiles set rol='admin' where id=$1",[a])).rejects.toMatchObject({ code: "42501" });
  });
  it("un usuario no cambia configuración y no ejecuta funciones internas", async () => {
    await expect(db.como("authenticated",a,sa,configuracion,[zona,JSON.stringify(horarios)])).rejects.toMatchObject({ code: "42501" });
    await expect(db.como("authenticated",a,sa,"select public.refrescar_ocupacion($1)",[zona])).rejects.toMatchObject({ code: "42501" });
    await expect(db.como("anon",null,null,"select public.registrar_scan('invalido')")).rejects.toMatchObject({ code: "42501" });
  });
  it("admin vigente ve el historial y puede guardar zona y semana juntos", async () => {
    expect((await db.como("authenticated",admin,sad,"select * from public.eventos_scan")).rowCount).toBe(2);
    // La consulta como() revierte al terminar; verificar dentro de la misma transacción.
    const cliente = await db.pool.connect();
    try {
      await cliente.query("begin"); await cliente.query("set local role authenticated");
      await cliente.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({ sub:admin,session_id:sad,role:"authenticated" })]);
      await cliente.query(configuracion,[zona,JSON.stringify(horarios)]);
      expect((await cliente.query("select aforo_max from public.zonas")).rows[0].aforo_max).toBe(120);
      expect((await cliente.query("select dia_semana from public.horarios_zona")).rows).toEqual([{ dia_semana: 1 }]);
    } finally { await cliente.query("rollback"); cliente.release(); }
  });
  it("revocar sesión o retirar rol cierra acceso incluso con el mismo JWT", async () => {
    await db.pool.query("delete from auth.sessions where id=$1",[sad]);
    expect((await db.como("authenticated",admin,sad,"select public.es_admin() as permitido")).rows[0].permitido).toBe(false);
    expect((await db.como("authenticated",admin,sad,"select * from public.eventos_scan")).rowCount).toBe(0);
    await expect(db.como("authenticated",admin,sad,configuracion,[zona,JSON.stringify(horarios)])).rejects.toMatchObject({ code: "42501" });
    await db.pool.query("insert into auth.sessions(id,user_id) values ($1,$2)",[sad,admin]);
    await db.pool.query("update public.profiles set rol='usuario' where id=$1",[admin]);
    expect((await db.como("authenticated",admin,sad,"select public.es_admin() as permitido")).rows[0].permitido).toBe(false);
  });
  it("rechaza una sesión ajena, ausente o vencida", async () => {
    for (const sid of [sa,null,randomUUID()]) expect((await db.como("authenticated",admin,sid,"select public.sesion_vigente() as v")).rows[0].v).toBe(false);
    await db.pool.query("update auth.sessions set not_after=now()-interval '1 minute' where id=$1",[sad]);
    expect((await db.como("authenticated",admin,sad,"select public.sesion_vigente() as v")).rows[0].v).toBe(false);
  });
  it("configuración inválida no deja un guardado parcial", async () => {
    for (const h of [[...horarios,...horarios],[{ dia_semana:1, apertura:"18:00", cierre:"08:00" }],[]]) {
      await expect(db.como("authenticated",admin,sad,configuracion,[zona,JSON.stringify(h)])).rejects.toMatchObject({ code: "22023" });
      expect((await db.pool.query("select nombre,aforo_max from public.zonas")).rows).toEqual([{ nombre:"Prueba",aforo_max:100 }]);
    }
  });
  it("horario SQL conserva los bordes y cierra días sin fila", async () => {
    await db.pool.query("update public.zonas set timezone='America/Santiago'");
    await db.pool.query("insert into public.horarios_zona values ($1,1,'08:30','18:00')",[zona]);
    for (const [instante,abierta] of [["2026-11-16T11:29:00Z",false],["2026-11-16T11:30:00Z",true],["2026-11-16T21:00:00Z",false],["2026-11-21T12:00:00Z",false]]) {
      expect((await db.pool.query("select public.zona_abierta_en($1,$2) as v",[zona,instante])).rows[0].v).toBe(abierta);
    }
  });
  it("k-anonimato cuenta personas distintas, no visitas repetidas", async () => {
    const ids = Array.from({ length:5 },randomUUID);
    await db.pool.query("insert into auth.users(id) select unnest($1::uuid[])",[ids]);
    async function visita(id) { await db.pool.query("insert into public.sesiones(user_id,zona_id,entrada_at,salida_at,cierre) values ($1,$2,date_trunc('day',now())-interval '12 hours',date_trunc('day',now())-interval '11 hours','usuario')",[id,zona]); }
    for (const id of ids.slice(0,4)) await visita(id);
    await visita(ids[0]);
    const consulta = "select public.personas_distintas($1,now()-interval '1 day',now()) as personas, public.permanencia_promedio($1,now()-interval '1 day',now()) as permanencia";
    expect((await db.como("anon",null,null,consulta,[zona])).rows[0]).toEqual({ personas:null,permanencia:null });
    await visita(ids[4]);
    const resultado = (await db.como("anon",null,null,consulta,[zona])).rows[0];
    expect(Number(resultado.personas)).toBe(5); expect(Number(resultado.permanencia)).toBe(3600);
  });
});
