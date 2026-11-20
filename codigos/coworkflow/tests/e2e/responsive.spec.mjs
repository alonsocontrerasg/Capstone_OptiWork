import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { createHmac,randomUUID } from "node:crypto";
import { mkdir,writeFile } from "node:fs/promises";
import pg from "pg";
import { medirResponsive,comprobarResponsive } from "./helpers/responsive.mjs";

const base=process.env.NEXT_PUBLIC_SUPABASE_URL;
const dbUrl=process.env.COWORKFLOW_E2E_DATABASE_URL;
if(!base||!dbUrl||!["localhost","127.0.0.1"].includes(new URL(base).hostname)||!["localhost","127.0.0.1"].includes(new URL(dbUrl).hostname)) throw new Error("La auditoría autenticada solo usa Supabase local descartable");
const servicio=createClient(base,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
const zona="11111111-1111-4111-8111-111111111111";
const extra=randomUUID();const nombreLargo="Cowork de trabajo colaborativo "+"ABCDEFGHIJKLMNOPQRSTUVWXYZ".repeat(2);
let db,id,cookies;
const resultados=[];

test.beforeAll(async()=>{
  db=new pg.Client({connectionString:dbUrl});await db.connect();
  const email=`responsive-${randomUUID()}-${"p".repeat(12)}@moviles-de-prueba.example.test`,password="Prueba-local-"+randomUUID();
  const alta=await servicio.auth.admin.createUser({email,password,email_confirm:true});expect(alta.error).toBeNull();id=alta.data.user.id;
  await db.query("update public.profiles set rol='admin',consentimiento_at=now(),consentimiento_version=1 where id=$1",[id]);
  await db.query("update public.zonas set nombre=$1,aforo_max=100000 where id=$2",[nombreLargo,zona]);
  await db.query("insert into public.zonas(id,slug,nombre,aforo_max,timezone) values ($1,$2,$3,100,'UTC')",[extra,"zona-"+"b".repeat(55),nombreLargo]);
  await db.query("insert into public.horarios_zona select $1,d,'00:00'::time,'24:00'::time from generate_series(1,7)d on conflict(zona_id,dia_semana) do update set apertura=excluded.apertura,cierre=excluded.cierre",[zona]);
  await db.query("insert into public.snapshots_ocupacion(zona_id,ts,cantidad) select $1,date_trunc('hour',now())-d*interval '1 day'-h*interval '1 hour',(h*17)%100 from generate_series(0,6)d,generate_series(0,23)h on conflict do nothing",[zona]);
  await db.query("update public.ocupacion_actual set cantidad=100000 where zona_id=$1",[zona]);
  await db.query("insert into public.eventos_scan(user_id,zona_id,tipo,resultado) values ($1,$2,'entrada','sesion_ya_abierta')",[id,zona]);
  cookies=[];
  const cliente=createServerClient(base,process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,{
    cookies:{getAll:()=>[],setAll:(valores)=>cookies.push(...valores)},cookieOptions:{httpOnly:true,sameSite:"lax",path:"/",secure:false},
  });
  expect((await cliente.auth.signInWithPassword({email,password})).error).toBeNull();
});
test.afterAll(async({},testInfo)=>{
  await mkdir("test-results/responsive",{recursive:true});
  await writeFile(`test-results/responsive/${testInfo.project.name}-mediciones.json`,JSON.stringify(resultados,null,2));
  if(id) await servicio.auth.admin.deleteUser(id);
  if(db){await db.query("delete from public.zonas where id=$1",[extra]);await db.query("select public.refrescar_ocupacion($1)",[zona]);await db.end();}
});

for(const [width,height] of [[320,568],[360,640],[390,844],[430,932],[568,320],[844,390],[768,1024],[1366,768]]) {
  test(`responsive ${width}x${height}`,async({page,context},testInfo)=>{
    test.setTimeout(180000);await page.setViewportSize({width,height});
    const datos=[];
    async function revisar(ruta,nombre){
      await page.goto(ruta);await expect(page.locator("main")).toBeVisible();
      if(ruta==="/dashboard") await expect(page.getByText("En vivo",{exact:true})).toBeVisible();
      await expect(page.getByRole("heading",{name:"Algo salió mal",exact:true})).toHaveCount(0);
      if(ruta==="/dashboard/estadisticas"){
        await page.getByTestId("graficos-diferidos").scrollIntoViewIfNeeded();
        await expect(page.locator(".recharts-surface").first()).toBeVisible();
        // Abrir también tablas alternativas y cada día: comprobar contenido expandido.
        for(const resumen of await page.locator("main summary:visible").all()) await resumen.click();
        await page.evaluate(()=>window.scrollTo(0,0));
      }
      const m=await medirResponsive(page);datos.push({ruta,nombre,...m});
      if([320,390,844].includes(width)) await page.screenshot({path:`test-results/responsive/${testInfo.project.name}-${nombre}-${width}.png`,fullPage:true,scale:"css"});
      return m;
    }
    for(const ruta of ["/","/login","/privacidad","/dashboard","/dashboard/estadisticas","/scan","/enlace-inexistente"]){
      await revisar(ruta,ruta==="/"?"inicio":ruta.slice(1).replaceAll("/","-"));
    }
    await context.addCookies(cookies.map(({name,value})=>({name,value,domain:"localhost",path:"/",httpOnly:true,sameSite:"Lax"})));
    await revisar("/","inicio-con-sesion");
    await revisar("/admin","admin");
    await expect(page.getByLabel("Aforo máximo").first()).toBeVisible();
    await revisar("/qr","qr");
    await expect(page.locator('main [role="img"] svg').first()).toBeVisible();
    datos[datos.length-1]= {ruta:"/qr",nombre:"qr",...await medirResponsive(page)};
    if([320,390,844].includes(width)) await page.screenshot({path:`test-results/responsive/${testInfo.project.name}-qr-${width}.png`,fullPage:true,scale:"css"});
    await page.getByRole("button",{name:"Actualizar ahora"}).first().click();
    const payload=`v1.${zona}.entrada.${Math.floor(Date.now()/45000)}`;
    const token=payload+"."+createHmac("sha256","ab".repeat(32)).update(payload).digest("hex");
    await revisar(`/scan?t=${token}`,"confirmacion");
    await expect(page.getByRole("button",{name:"Confirmar entrada",exact:true})).toBeVisible();
    await page.getByRole("link",{name:"Ocupación",exact:true}).click();await expect(page).toHaveURL(/\/dashboard$/);
    // Girar el dispositivo sin recargar: conservar contenido y navegación.
    await page.setViewportSize({width:height,height:width});
    datos.push({ruta:"/dashboard",nombre:"giro-sin-recarga",...await medirResponsive(page)});
    resultados.push({width,height,datos});
    if(process.env.RESPONSIVE_BASELINE!=="1") for(const dato of datos) comprobarResponsive(dato,`${width}x${height} ${dato.nombre}`);
  });
}
