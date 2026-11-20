import { test, expect } from "@playwright/test";
import { createHmac, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

const zona = "11111111-1111-4111-8111-111111111111";
const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
if (!base || !["127.0.0.1","localhost"].includes(new URL(base).hostname)) {
  throw new Error("Estas pruebas crean usuarios y marcas: solo se permiten servicios Supabase LOCALES");
}
const dbUrl = process.env.COWORKFLOW_E2E_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
if (!["127.0.0.1","localhost"].includes(new URL(dbUrl).hostname)) throw new Error("Base E2E remota prohibida");
const adminCliente = createClient(base, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession:false,autoRefreshToken:false } });
const clave = "Prueba-local-" + randomUUID();
let db;
const creados = [];

function urlQr(modo) {
  const payload = `v1.${zona}.${modo}.${Math.floor(Date.now()/1000/45)}`;
  const firma = createHmac("sha256","ab".repeat(32)).update(payload).digest("hex");
  return `/scan?t=${payload}.${firma}&modo=${modo}`;
}
async function cantidad() { return (await db.query("select cantidad from public.ocupacion_actual where zona_id=$1",[zona])).rows[0].cantidad; }
test.beforeAll(async () => { db = new pg.Client({ connectionString:dbUrl }); await db.connect(); });
test.afterAll(async () => {
  for (const id of creados) await adminCliente.auth.admin.deleteUser(id);
  await db?.end();
});

test("registro con correo, consentimiento, entrada y salida sin repetir el QR inicial", async ({ page, request }) => {
  const email = `qr-${randomUUID()}@example.test`;
  const inicial = await cantidad();
  await page.goto(urlQr("entrada"));
  await expect(page.getByRole("heading",{ name:"Ingresa para marcar tu entrada" })).toBeVisible();
  await page.getByRole("button",{ name:"¿Primera vez? Crear cuenta" }).click();
  await page.getByLabel("Correo",{ exact:true }).fill(email);
  await page.getByLabel("Contraseña",{ exact:true }).fill(clave);
  await page.getByRole("button",{ name:"Crear cuenta",exact:true }).click();
  await expect(page.getByText("Cuenta creada.",{ exact:false })).toBeVisible();
  let confirmacion;
  await expect.poll(async () => {
    const listado = await (await request.get("http://127.0.0.1:54324/api/v1/messages")).json();
    const mensaje = listado.messages?.find((m) => m.To?.some((d) => d.Address === email));
    if (!mensaje) return false;
    const contenido = await (await request.get(`http://127.0.0.1:54324/api/v1/message/${mensaje.ID}`)).json();
    const enlaces = (contenido.HTML ?? "").matchAll(/href=["']([^"']+)["']/g);
    confirmacion = [...enlaces].map((m) => m[1].replaceAll("&amp;","&")).find((h) => h.includes("/auth/v1/verify"));
    return Boolean(confirmacion);
  },{ timeout:20000 }).toBe(true);
  await page.goto(confirmacion);
  await expect(page.getByRole("heading",{ name:"Un paso antes de empezar" })).toBeVisible();
  const usuarios = await adminCliente.auth.admin.listUsers();
  const usuario = usuarios.data.users.find((u) => u.email === email); expect(usuario).toBeTruthy(); creados.push(usuario.id);
  expect(await cantidad()).toBe(inicial);
  await page.getByRole("checkbox").check();
  await page.getByRole("button",{ name:"Acepto y continúo" }).click();
  await expect(page.getByRole("button",{ name:/Confirmar.*entrada/i })).toBeVisible();
  expect(await cantidad()).toBe(inicial);
  await page.getByRole("button",{ name:/Confirmar.*entrada/i }).click();
  await expect(page.getByRole("heading",{ name:"Entrada registrada",exact:true })).toBeVisible();
  expect(await cantidad()).toBe(inicial+1);
  // Solo en la base descartable: adelanta el cooldown sin esperar 30 segundos en CI.
  await db.query("update public.eventos_scan set ts=now()-interval '31 seconds' where user_id=$1",[usuario.id]);
  await page.goto(urlQr("salida"));
  await page.getByRole("button",{ name:/Confirmar.*salida/i }).click();
  await expect(page.getByRole("heading",{ name:"Salida registrada",exact:true })).toBeVisible();
  expect(await cantidad()).toBe(inicial);
});

test("admin guarda horario, exporta y pierde acceso al revocar su sesión", async ({ page, request }) => {
  const email = `admin-${randomUUID()}@example.test`;
  const alta = await adminCliente.auth.admin.createUser({ email,password:clave,email_confirm:true });
  expect(alta.error).toBeNull(); const id = alta.data.user.id; creados.push(id);
  await db.query("update public.profiles set rol='admin' where id=$1",[id]);
  await page.goto("/login"); await page.getByLabel("Correo",{ exact:true }).fill(email);
  await page.getByLabel("Contraseña",{ exact:true }).fill(clave);
  await page.getByRole("button",{ name:"Entrar",exact:true }).click();
  await page.goto("/admin");
  await expect(page.getByRole("heading",{ name:"Administración",exact:true })).toBeVisible();
  await page.getByLabel("Aforo máximo").fill("120");
  await page.getByRole("button",{ name:"Guardar configuración" }).click();
  await expect(page.getByRole("status").filter({ hasText:"Configuración guardada." })).toBeVisible();
  expect((await db.query("select aforo_max from public.zonas where id=$1",[zona])).rows[0].aforo_max).toBe(120);
  const descarga = page.waitForEvent("download"); await page.getByRole("link",{ name:"Exportar CSV" }).click();
  expect((await descarga).suggestedFilename()).toBe("historial-optiwork.csv");
  await db.query("delete from auth.sessions where user_id=$1",[id]);
  const exportar = await page.request.get("/api/admin/exportar"); expect(exportar.status()).toBe(401);
  const publico = await request.get("/api/admin/exportar"); expect(publico.status()).toBe(401);
});
