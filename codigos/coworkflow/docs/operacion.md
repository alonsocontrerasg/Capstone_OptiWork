# Operación y despliegue

## Estado del PR

El PR #1 contiene contador concurrente, continuación del QR, administración, sesión revocable,
CSV y pruebas. Permanece abierto para revisión. La migración 11 está aplicada en Supabase;
la 12 se entrega para aplicación coordinada con el nuevo guard. No modifica sesiones/eventos.
La prueba manual de correo en producción queda para después del merge, por decisión del usuario.

Se revisó la consola remota: el dominio `https://capstone-opti-work-a-39e4.vercel.app` está
autorizado, no hay SMTP propio y la cuenta actual no puede editar Auth. No se cambiaron
permisos, URLs ni credenciales durante esta revisión.

## Antes de publicar

1. Revisar el diff, `calidad-y-sql`, `navegador-y-supabase` y la compilación de Vercel.
2. El propietario respalda la base/configuración y ejecuta completa
   `supabase/migrations/20261120000000_administracion.sql`. Es transaccional y compatible con
   la app anterior. Actualiza `es_admin()` para consultar la sesión en `auth.sessions`.
3. Ejecutar `supabase/verificacion.sql`. No repetir el seed en producción sin revisar sus cambios.
4. Verificar variables **Production** y **Preview** en Vercel, igualdad de clave/ventana QR y
   credenciales de Upstash. El servidor web no requiere `service_role`.
5. Revisar Auth: dominio/callback, confirmación de correo, SMTP/remitente y DNS del proveedor.
6. Incorporar el PR a `main` solamente cuando el usuario lo autorice y comprobar el despliegue.

La migración debe preceder al nuevo guard; sin `sesion_vigente()` o ante un fallo de Auth los
accesos administrativos fallan cerrados. No se despliega SQL remoto desde GitHub Actions.

## Prueba funcional de producción

Hacerla con una visita real, una cuenta controlada por el equipo y durante el horario del
cowork; no cambiar horarios ni inyectar estancias ficticias para pasar una prueba:

- Escanear sin sesión, crear cuenta y confirmar el correo en el mismo navegador/dominio antes
  de diez minutos. Aceptar el consentimiento y llegar a la confirmación sin otro escaneo.
- El contador no cambia antes de confirmar. Después aumenta una vez; repetir no duplica estancia.
- Al terminar la visita, escanear salida y comprobar el decremento, respetando el cooldown.
- Un administrador revisa historial/CSV. Las ediciones de prueba se hacen en el entorno local.
- Revocar/cerrar la sesión administrativa y comprobar el rechazo de los accesos protegidos.

Probar correos en Preview requiere permitir el dominio estable de esa rama con `/**`; es
opcional si la prueba manual se hará tras el merge. Nunca permitir cualquier proyecto de Vercel.
El origen se toma del entorno del servidor, no de las cabeceras enviadas por el cliente.

## Pruebas de navegador

Requiere Docker, Supabase CLI 3.2.0, Node 24 y `npm ci`. Desde la app:

```sh
supabase start --workdir tests/e2e
supabase status --workdir tests/e2e -o env
npx playwright install chromium webkit
```

Usar los valores **locales** de `API_URL`, `ANON_KEY`, `SERVICE_ROLE_KEY`, `DB_URL` para definir
`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` y
`COWORKFLOW_E2E_DATABASE_URL`. Definir también:

```text
NEXT_PUBLIC_SITE_URL=http://localhost:3000
NEXT_PUBLIC_ZONA_POR_DEFECTO=prueba-e2e
QR_TOKEN_SECRET=abababababababababababababababababababababababababababababababab
```

Este secreto es público y exclusivo del entorno descartable. No usarlo en producción ni
conectar estas pruebas a Upstash de producción. El navegador usa Next en desarrollo.

```sh
node scripts/preparar-e2e.mjs
npm run test:e2e
npm run build
npx playwright test --config playwright.performance.config.ts
supabase stop --workdir tests/e2e --no-backup
```

El script aplica las migraciones y una zona de prueba y desprograma los jobs solo en la base
local. Las pruebas crean usuarios descartables y los eliminan al terminar. Mailpit captura
el correo sin enviarlo externamente. Se usan Chromium y WebKit, ocho ventanas y giros sin
recarga; esto no equivale a probar todas las cámaras físicas ni clientes de correo.
Los scripts rechazan bases remotas. La suite de rendimiento inicia el build de producción,
simula red/CPU móvil y registra métricas públicas sin enviar formularios.

Consultar [revisión responsive](revision-responsive.md) para los once criterios, límites y
prioridades. CI conserva capturas, JSON de mediciones y el informe HTML en
`navegador-informe`. Al reproducirlo localmente, ejecutar en orden y mantener Supabase activo
hasta terminar la medición de producción; Playwright detiene sus servidores Next al salir.

## Administración e historial

El panel configura zonas existentes; no crea/elimina zonas ni administra cuentas/roles.
El propietario puede agregar zonas mediante SQL y el seed revisado. Una zona activa necesita
un día abierto. Los días desmarcados cierran; el cierre admite `24:00`, sin turnos que crucen
medianoche. Se conserva la zona horaria. Cada guardado reemplaza la semana completa en una
transacción; si dos administradores editan, prevalece el último guardado.

Cambiar el aforo no modifica estancias. Desactivar/cerrar una zona impide nuevas marcas según
la RPC; el job revisa estancias cada 15 minutos. La edición no fuerza una salida inmediata.

El historial muestra 50 eventos por página y conserva el instante de corte al paginar.
CSV aplica zona y últimos 7/30/90 días, con fechas UTC, en lotes de 500 por PostgREST. Si hay
más de 10.000 eventos devuelve 413 para reducir filtros, nunca un CSV silenciosamente truncado.
Los errores de descarga son JSON genérico; las respuestas administrativas no se cachean.

Los usuarios se representan con un HMAC de 96 bits separado por propósito, sin correo ni UUID.
Esto es seudonimización: los horarios individuales siguen siendo información de acceso
administrativo. Rotar la clave QR cambia los seudónimos. El CSV neutraliza fórmulas y escapa
comas, comillas y saltos de línea.

## Recuperación

| Síntoma | Acción |
| --- | --- |
| Build falla por variables | Completar el entorno afectado y redesplegar |
| Login/scan devuelve 500/503 | Revisar Redis; no desactivar límites como solución |
| Admin dice sesión inválida | Reautenticarse y comprobar migración 12 y Auth |
| El correo abre otro dominio | Revisar origen/allowlist y usar el mismo navegador |
| QR nuevo rechazado | Comprobar igualdad de clave/ventana sin mostrar secretos |
| Contador incoherente | Comparar sesiones abiertas, verificar y reconciliar con autorización |
| CSV devuelve 413 | Reducir período o filtrar una zona |

Ante un fallo del frontend, volver al despliegue anterior de Vercel. No borrar estancias ni
revertir la corrección concurrente. Una reversión SQL requiere revisión y otra migración.
No registrar cuerpos de login/scan, tokens, cookies, claves ni correos en diagnóstico.

## Fuentes

- [Sesiones y revocación de Supabase](https://supabase.com/docs/guides/auth/sessions).
- [Configuración CLI y SMTP local](https://supabase.com/docs/guides/local-development/cli/config).
- [Pruebas de autenticación local](https://supabase.com/docs/guides/auth/testing-auth-flows).
