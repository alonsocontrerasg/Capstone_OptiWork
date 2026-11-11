# Arquitectura — CoworkFlow

> Documento de la **Etapa 1**: plan de arquitectura y estructura de carpetas.
> Sistema de monitoreo de ocupación del cowork del Hub Providencia (proyecto universitario,
> presupuesto $0, todo sobre planes gratuitos).
>
> Estado: aprobado para implementación. Las etapas 2–6 completan el detalle.
> Las decisiones de seguridad se justifican por separado en `docs/decisiones-seguridad.md`.

---

## 1. Resumen

CoworkFlow mide cuántas personas hay dentro del cowork en tiempo real. Los usuarios marcan
entrada y salida escaneando un QR rotativo con la cámara nativa del celular; un dashboard
público muestra ocupación, semáforo (Bajo / Moderado / Lleno) y estadísticas históricas.

Tres ideas sostienen toda la arquitectura:

1. **El navegador no escribe datos de negocio.** El cliente solo lee. Toda mutación pasa por
   `POST` → función SQL (`RPC`) o Route Handler. Ver `S-01` y `S-02`.
2. **Una sola fuente de verdad para la ocupación.** `ocupacion_actual` se mantiene por trigger
   dentro de la misma transacción que cada entrada/salida, y se reconcilia periódicamente con
   `COUNT(*)` para corregir cualquier deriva.
3. **El dashboard público nunca ve datos personales.** Realtime publica solo una tabla agregada
   (`ocupacion_actual`); las estadísticas se sirven con funciones que devuelven únicamente
   números. Ver `S-03` y `S-04`.

## 2. Stack y versiones verificadas

Verificado en el `package.json` y en `node_modules` del repositorio (06-11-2026):

| Componente | Versión | Notas |
| --- | --- | --- |
| Next.js | 16.4.5 | App Router; PPR desactivado en la Etapa 3 (`cacheComponents` fuera, por la CSP con nonce — ver S-10) |
| React | 19.3.0 | Server Components + islas cliente |
| TypeScript | 5.x | `strict: true`, alias `@/* → ./src/*` |
| Tailwind CSS | 4.x | vía `@tailwindcss/turbopack`, `@import "tailwindcss"` en `globals.css` |
| `@supabase/supabase-js` | 2.119.0 | Cliente de datos |
| `@supabase/ssr` | 0.12.7 | Sesión en cookies httpOnly (`getAll`/`setAll`) |
| `zod` | 4.6.7 | Validación de inputs y de variables de entorno |
| `recharts` | 3.10.1 | Gráficos del dashboard (Client Components) |
| `qrcode` | 1.5.4 | Generación del QR en el servidor (`type: 'svg'`) |
| Vitest | 5.1.0 | Tests de lógica de negocio y de RLS |
| Node / npm | v26.13.0 / 12.2.2 | Entorno local |

**Dependencias agregadas por etapa.** `server-only` se instaló en la Etapa 3 (junto con `@supabase/ssr`,
que ya estaba) para impedir que `src/lib/env.server.ts` o `src/lib/supabase/admin.ts` terminen en el
bundle del navegador. `@upstash/redis` + `@upstash/ratelimit` se incorporan en la Etapa 4, cuando se
usan.

## 3. Convenciones de Next.js 16 que condicionan el diseño

Estas reglas vienen de la documentación incluida en `node_modules/next/dist/docs/` y son
distintas de versiones anteriores de Next.js. Se respetan en todas las etapas:

1. **`middleware.ts` está deprecado** → se usa `src/proxy.ts` (export `proxy`, o `default`).
   Ahí viven el refresh de sesión de Supabase y los headers de seguridad (`S-09`, `S-10`).
2. **`cacheComponents` (PPR) está desactivado desde la Etapa 3.** Se activó en el andamiaje inicial,
   pero el nonce de la CSP (S-10) es incompatible con documentos prerenderizados: un shell estático
   servido desde caché llega con un nonce ya gastado y el navegador bloquea sus scripts. Por eso:
   - No se usan `'use cache'`, `cacheLife()` ni `cacheTag()`; el build muestra todas las rutas como
     dinámicas (`ƒ`).
   - No se usa `export const dynamic`, `export const revalidate` ni `export const runtime`.
   - Todo lo que lee `cookies()`/DB en request-time puede renderizarse sin `<Suspense>`; cuando el
     streaming mejore la experiencia (Etapa 5), se usa igual.
   - Si en el futuro se quiere PPR, hay que cambiar la estrategia de CSP (SRI o `'unsafe-inline'`), no
     solo volver a activar el flag.
3. **Typed routes activas**: las páginas usan `PageProps<'/dashboard'>` / `LayoutProps<'/'>`,
   y `params` / `searchParams` son `Promise` (se hace `await`).
4. **`GET` Route Handlers siguen el modelo de prerender** (se vuelven request-time al tocar red,
   DB, `cookies()` o `headers()`). Los `POST` nunca se cachean.
5. **`useSearchParams` en Client Component exige `<Suspense>`**; en build de producción falla
   el build si falta. Aplica a `/scan` y al selector de zona/rango de `/dashboard`.
6. **`runtime` está deprecado** (Edge ya no se usa). Todo corre en Node.js por defecto.
7. **Realtime no filtra columnas**: se publica una tabla, con sus columnas. Es la razón por la
   que se publica solo `ocupacion_actual` (`S-03`).

## 4. Arquitectura por capas

```
┌───────────────────────────────────────────────────────────────────────────┐
│ NAVEGADOR                                                                 │
│  · Server Components: lectura y armado de la página                       │
│  · Islas Client: contador Realtime, selector de zona, formularios         │
└──────────────┬────────────────────────────────────────┬───────────────────┘
               │ POST /api/scan  (mismo origen)         │ WebSocket Realtime
               │ GET  /api/qr/token (solo admin)        │ (anon key)
               ▼                                        ▼
┌────────────────────────────────────┐   ┌──────────────────────────────────┐
│ ROUTE HANDLERS · Node.js           │   │ SUPABASE REALTIME                │
│ · Origin + zod + rate limit        │   │ · única tabla publicada:          │
│ · verifica HMAC y ventana del QR   │   │   ocupacion_actual                │
│ · usa el JWT del usuario (no       │   │ · sin user_id, sin PII            │
│   service_role)                    │   └──────────────────────────────────┘
└──────────────┬─────────────────────┘
               │ supabase.rpc('registrar_scan', …)
               ▼
┌───────────────────────────────────────────────────────────────────────────┐
│ POSTGRES (Supabase)                                                       │
│  · RLS deny-by-default en todas las tablas                                │
│  · RPC SECURITY DEFINER = única puerta de escritura                       │
│  · TRIGGER  sesiones → ocupacion_actual (misma transacción)               │
│  · pg_cron: snapshots + reconciliación, cierre automático, resumen, purga  │
│  · Funciones de estadística: solo agregados                               │
└───────────────────────────────────────────────────────────────────────────┘
               ▲
               │ service_role (solo local / tareas admin server-side)
        scripts/simular-datos.ts
```

### Reglas de oro

1. **Lectura** → RSC con cliente `anon`/`authenticated` (RLS aplica) o RPC de agregados.
2. **Escritura** → `POST` Route Handler (borde) → RPC (transacción). Nunca `insert` directo
   desde el cliente, ni desde un Server Component, ni desde un Server Action que escriba tablas
   de negocio.
3. **`service_role`** jamás cruza al bundle del navegador: vive en `src/lib/supabase/admin.ts`
   (server-only) y en `scripts/`.
4. **Un dato personal no se transmite al público.** Si una vista necesita `sesiones`, se
   convierte en función que devuelve agregados.
5. **Todo porcentaje/estado se calcula con una función pura compartida**
   (`src/lib/dominio/ocupacion.ts`) para que la UI, la RPC y los tests no se contradigan.

### Capas y responsabilidades

| Capa | Ubicación | Responsabilidad | Nunca hace |
| --- | --- | --- | --- |
| Presentación | `src/app/**/page.tsx`, `src/components/**` | Render, estados vacío/carga/error, accesibilidad | Escribir datos de negocio |
| Borde HTTP | `src/app/api/**/route.ts`, `src/proxy.ts` | Validación zod, rate limit, Origin, sesión, headers | Lógica de ocupación |
| Dominio | `src/lib/dominio/**` | Umbrales, estados, horarios, formato | I/O |
| Acceso a datos | `src/lib/supabase/**` | Clientes `browser` / `server` / `admin` tipados | Reglas de negocio |
| Base de datos | `supabase/migrations/**` | Esquema, RLS, RPC, triggers, jobs | Lógica de presentación |

## 5. Flujos

### 5.1 Check-in / check-out

1. El usuario escanea con la cámara nativa el QR de la entrada o de la salida. El QR contiene
   `https://<host>/scan?modo=entrada&t=<token>`.
2. `GET /scan` **solo renderiza**: valida sesión, muestra zona y modo y pide confirmación. No
   muta nada (`S-05`).
   - **Sin sesión** → `redirect('/login')` **descartando el token**; al volver, el usuario
     escanea de nuevo (`S-12`). El token no viaja en `?next=`, ni en cookie, ni en
     `sessionStorage`, ni en `localStorage`.
3. El Client Component hace `POST /api/scan` con `{ t }`. El `modo` de la query string es solo
   presentación: el modo real está firmado dentro del token (`S-06`).
4. `/api/scan`: comprueba mismo origen, valida el body con zod (`{ t }`), aplica rate limit
   (usuario + hash de IP) y llama `rpc('registrar_scan', { p_token })` con el JWT del usuario. La
   ruta **no** verifica la firma ni interpreta zona/modo: solo transporta el token.
5. La **RPC**, en una sola transacción, parsea el token, verifica el HMAC-SHA256 contra
   `app_secrets.qr_token_secret` (comparando `digest`, `S-22`) y acepta la ventana actual y la
   anterior; luego valida `auth.uid()`, consentimiento (`sin_consentimiento`), límite de 10 intentos
   inválidos/min, zona activa, horario, cooldown de 30 s y estado de la sesión. Escribe en
   `sesiones` y `eventos_scan`; el trigger recalcula `ocupacion_actual`. El servidor de Next **no**
   conoce el secreto HMAC: firma el QR (S-26) y delega la verificación en Postgres (S-16).
6. La respuesta se mapea a un resultado tipado y la pantalla confirma en español.

| `resultado` | HTTP | Mensaje al usuario |
| --- | --- | --- |
| `entrada_ok` | 200 | «Entrada registrada» |
| `salida_ok` | 200 | «Salida registrada» |
| `sesion_ya_abierta` | 409 | «Ya tienes una entrada activa» |
| `sin_sesion_abierta` | 409 | «No tienes una entrada activa» |
| `sin_consentimiento` | 403 | «Acepta el aviso de privacidad para marcar tu asistencia» |
| `cooldown` | 429 | «Espera unos segundos antes de volver a escanear» |
| `token_invalido` / `token_expirado` | 403 | «El código venció, escanea el QR nuevamente» |
| `fuera_horario` | 409 | «El cowork está cerrado» |
| `zona_inactiva` | 409 | «Esta zona no está habilitada» |
| `rate_limited` | 429 | «Demasiados intentos» |
| `no_autenticado` | 401 | «Inicia sesión y vuelve a escanear» |

### 5.2 QR rotativo (`/qr`, solo admin)

- Página protegida por `requireAdmin()` (guard de la propia página, no del proxy): sin sesión →
  `/login?next=/qr`; con sesión pero sin rol → `forbidden()` (403 en `forbidden.tsx`).
- Muestra **dos QR a la vez** (Entrada y Salida) de la zona elegida con `?zona=<slug>`; si hay una
  sola zona activa no aparece selector.
- El cliente pide `GET /api/qr/token?zona=<slug>&modo=<entrada|salida>` al montar y cada vez que la
  ventana está por vencer; recibe `{ token, svg, ventana, expiraEnSegundos, url, zona, modo }` con
  `Cache-Control: no-store`.
- El servidor firma `v1.<zona_id>.<modo>.<ventana>` con HMAC-SHA256 (Web Crypto, sin dependencias
  nuevas) y renderiza el QR con `qrcode` en modo SVG (nítido en pantalla e impresión). El secreto no
  sale del servidor y el navegador recibe el SVG ya armado.
- Ventana de 45 s (`QR_WINDOW_SECONDS`) con tolerancia de una ventana anterior. La página muestra
  cuenta regresiva, se renueva un segundo antes de vencer y se refresca al volver a la pestaña.
- Fallback previsto (fuera del MVP): QR estático impreso + geolocalización opcional con
  consentimiento.

### 5.3 Dashboard público (`/dashboard`)

1. El RSC resuelve `?zona=<slug>` (o `NEXT_PUBLIC_ZONA_POR_DEFECTO`) y entrega en el primer
   render la ocupación, la configuración de la zona y los agregados del rango (7/30 días).
2. Un Client Component se suscribe a `postgres_changes` sobre `ocupacion_actual` filtrado por
   `zona_id`; al recibir un `UPDATE` actualiza contador, barra y semáforo sin recargar.
3. Recharts pinta gráfico por hora, mapa de calor día × hora, hora punta y permanencia promedio.
   Si Realtime se cae, la página conserva el dato inicial y reintenta con backoff.

### 5.4 Admin (`/admin`)

- Editar `aforo_max`, umbrales y horario → `PATCH /api/admin/zonas` (zod + rol admin vía RLS) y
  `updateTag('zonas')` para invalidar la caché de configuración.
- Historial (`/admin/historial`): sesiones y eventos con paginación server-side.
- Exportar CSV → `GET /api/admin/export?zona=…` (`Content-Disposition: attachment`,
  `Cache-Control: no-store`), con ID seudónimo en lugar de `user_id`/email.

### 5.5 Registro, consentimiento y sesión

- `/login`: magic link como vía principal y contraseña como alternativa (el correo gratuito de
  Supabase tiene límite bajo → SMTP propio con Resend si se consigue).
- `/auth/callback` intercambia el código por sesión y guarda cookies httpOnly vía
  `@supabase/ssr`.
- El trigger sobre `auth.users` crea `profiles`. Si `consentimiento_at` es nulo, la app muestra
  el aviso (Ley 21.719) y la versión aceptada se guarda con una RPC dedicada.
- `src/proxy.ts` refresca la sesión en cada navegación y aplica CSP/HSTS.

## 6. Modelo de datos (visión de arquitectura)

El DDL completo, las políticas RLS, las RPC y los jobs se escriben en la **Etapa 2**. Aquí queda
el contrato: qué existe, para qué y qué invariantes debe cumplir.

| Tabla | Propósito | Columnas clave | Acceso |
| --- | --- | --- | --- |
| `profiles` | Rol y consentimiento, 1:1 con `auth.users` | `id`, `rol` (`usuario`/`admin`), `consentimiento_at`, `consentimiento_version` | El usuario lee/actualiza solo su fila (columnas limitadas) |
| `zonas` | Espacios monitoreables | `id`, **`slug` (único, para URLs)**, `nombre`, `aforo_max`, `umbral_bajo`, `umbral_alto`, `hora_apertura`, `hora_cierre`, `timezone`, `activa` | Lectura pública de las columnas no sensibles; escritura solo admin |
| `sesiones` | Estancia de una persona en una zona | `id`, `user_id`, `zona_id`, `entrada_at`, `salida_at`, `cierre` (`usuario`/`auto`) | El usuario ve **solo** las suyas; escritura solo por RPC |
| `eventos_scan` | Auditoría de cada intento | `id`, `user_id` (nulo si no autenticado), `zona_id`, `tipo`, `ts`, `resultado` | Solo admin; escritura solo por RPC |
| `ocupacion_actual` | Contador en vivo por zona (tabla agregada) | `zona_id` (PK), `cantidad`, `updated_at` | Lectura pública; escritura solo por trigger/jobs |
| `snapshots_ocupacion` | Serie temporal cada 5 min | `zona_id`, `ts`, `cantidad` (PK compuesta) | Lectura pública (sin PII); escritura por job |
| `resumen_diario` | Agregado diario que sobrevive a la purga | `zona_id`, `fecha` (PK compuesta), `entradas`, `salidas`, `sesiones_cerradas`, `permanencia_prom_seg`, `pico` | Lectura pública (sin PII); escritura por job |

Notas de diseño:

- **`zonas.slug` único** permite `/dashboard?zona=hub-providencia` y `/qr?zona=…` legibles, y
  desacopla las URLs del UUID. Agregar una zona nueva es un `INSERT`, sin cambios de esquema.
- **`zonas.timezone`** (por defecto `America/Santiago`): los horarios se comparan en la zona
  local de cada espacio, no en UTC, para que el cierre automático funcione con cambios de hora.
- **`sesiones`** lleva índice único parcial `(user_id) WHERE salida_at IS NULL`: una persona no
  puede tener dos sesiones abiertas ni por carrera. `cierre` queda nulo mientras la sesión está
  abierta.
- **`eventos_scan.resultado`** es un `CHECK` con un vocabulario cerrado (los de la tabla 5.1 más
  `token_expirado`, `rate_limited` y `no_autenticado`) para que la auditoría sea consultable.
- **`resumen_diario`** (aprobado) conserva entradas, salidas, permanencia promedio y pico diario
  cuando las filas crudas ya se purgaron a los 90 días. Sin `user_id`: es un agregado puro.
- **No se guarda IP ni user-agent** en ninguna tabla. El hash de IP del rate limit vive en
  Redis, no en Postgres.

### Invariantes

| # | Invariante | Cómo se garantiza |
| --- | --- | --- |
| I1 | `ocupacion_actual.cantidad` = nº de sesiones abiertas de la zona | Trigger `AFTER INSERT/UPDATE/DELETE` en `sesiones`, en la misma transacción |
| I2 | Un usuario tiene como máximo una sesión abierta | Índice único parcial + validación en la RPC |
| I3 | Cooldown: máx. 1 evento por usuario cada 30 s | `SELECT … FOR UPDATE` sobre la última fila de `eventos_scan` dentro de la RPC |
| I4 | Nadie escribe `sesiones`/`eventos_scan` fuera de la RPC | RLS sin políticas de `INSERT/UPDATE/DELETE` |
| I5 | La ocupación nunca es negativa ni supera el aforo por error de cálculo | `CHECK (cantidad >= 0)` + recálculo por `COUNT` |
| I6 | La deriva del contador se corrige sola | Job de snapshots recalcula `ocupacion_actual` con `COUNT(*)` cada 5 min |

### Jobs programados (`pg_cron`)

Todas las tareas corren dentro de Postgres: no hace falta hardware ni servidor propio, y no
consumen invocaciones de Vercel.

| Job | Frecuencia | Qué hace |
| --- | --- | --- |
| `coworkflow_snapshot` | cada 5 min | Inserta un `snapshot` por zona activa **y recalcula `ocupacion_actual` con `COUNT(*)`** (corrige cualquier deriva; ver I6 y `S-13`) |
| `coworkflow_cierre_auto` | cada 15 min | Cierra sesiones abiertas de más de 8 h o fuera del horario de la zona (`cierre = 'auto'`) |
| `coworkflow_resumen_diario` | diario 00:10 (hora de la zona) | Agrega el día anterior en `resumen_diario` (entradas, salidas, permanencia promedio, pico) |
| `coworkflow_retencion` | diario 03:00 | Purga `eventos_scan` y sesiones cerradas con más de 90 días, una vez agregadas |

## 7. Estadísticas y privacidad

- **Gráfico por hora del día, mapa de calor día × hora, hora punta** → se construyen desde
  `snapshots_ocupacion` (ya agregado, sin identidades), con `COUNT` por hora y promedio por
  franja en las últimas 4–8 semanas.
- **Permanencia promedio y conteo de personas distintas** → función `SECURITY DEFINER` que lee
  `sesiones` y devuelve únicamente números (promedio en segundos, cantidad). Nunca devuelve
  `user_id` ni permite `SELECT` libre sobre la tabla.
- **Supervivencia del histórico** → `resumen_diario` guarda el agregado del día antes de que la
  purga elimine las filas crudas.
- **Contrato de salida de las funciones públicas**: `zona_id`, `slug`, `nombre`, `cantidad`,
  `aforo_max`, `umbral_bajo`, `umbral_alto`, fechas y números. Nada más. El estado
  (Bajo/Moderado/Lleno) se calcula en la app con la función pura, no en la base.
- **Minimización**: no se guardan IP, user-agent, geolocalización ni nombres. El email vive solo
  en `auth.users`, que el dashboard público no puede leer.

## 8. Workflow de migraciones (sin CLI de Supabase)

No hay Supabase CLI instalada y no se va a instalar: **el SQL se pega en el SQL Editor del
dashboard**. Eso obliga a un protocolo explícito para que el repositorio siga siendo la fuente
de verdad.

1. **Ubicación y nombres**: cada migración es un archivo en `supabase/migrations/` con timestamp
   creciente `YYYYMMDDHHMMSS_descripcion.sql` (p. ej.
   `20260110120000_rls_policies.sql`). El orden alfabético es el orden de aplicación.
2. **Un archivo por preocupación**, con un encabezado que diga etapa, propósito y si requiere
   `service_role` o `postgres`. Separar esquema, RLS, RPC, triggers y jobs permite reaplicar una
   parte sin tocar el resto.
3. **Idempotencia donde sea razonable**: `create table if not exists`, `create or replace
   function`, `drop policy if exists … ; create policy …`, `create index if not exists`. Así
   pegar dos veces no rompe nada y se puede recuperar de un error a mitad de archivo.
4. **Nunca se edita una migración ya aplicada**: cualquier corrección es un archivo nuevo. El
   historial del repo debe reflejar lo que realmente se pegó.
5. **Nada de cambios ad-hoc** en el SQL Editor sin su archivo correspondiente. Si se improvisa
   una consulta, se convierte en migración antes de seguir.
6. **Verificación obligatoria después de cada pegado** (`S-14`). El archivo de chequeos vive en
   `supabase/verificacion.sql` (Etapa 2) y comprueba, como mínimo:
   - `relrowsecurity = true` en las siete tablas;
   - que `sesiones`, `eventos_scan` y `ocupacion_actual` **no** tengan políticas de escritura
     para `authenticated`;
   - que existan las políticas de lectura pública esperadas;
   - que la publicación `supabase_realtime` contenga solo `ocupacion_actual`;
   - que los cuatro jobs existan en `cron.job` y estén activos;
   - que `ocupacion_actual` tenga exactamente una fila por zona activa.
7. **Registro de aplicación**: en `docs/modelo-datos.md` (Etapa 2) se anota qué migración se
   aplicó y cuándo, para poder comparar repositorio vs. base de datos antes de una demo.
8. **Semilla**: `supabase/seed.sql` crea la zona `hub-providencia` y nada más. La simulación de
   datos es un script aparte (Etapa 6) que **también** rellena `snapshots_ocupacion` y
   `resumen_diario`, no solo `sesiones`, para que el dashboard tenga histórico coherente desde
   el primer arranque.

## 9. Variables de entorno

Contrato completo en `.env.example` (versionado, sin valores reales). `.env.local` está ignorado
por git.

| Variable | Alcance | Uso |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Pública | Endpoint del proyecto Supabase |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Pública | Cliente de navegador; su poder lo limita RLS |
| `SUPABASE_SERVICE_ROLE_KEY` | **Secreta, solo servidor** | Scripts locales y tareas admin; ignora RLS |
| `NEXT_PUBLIC_SITE_URL` | Pública | Redirect del magic link y URLs impresas en los QR |
| `QR_TOKEN_SECRET` | **Secreta, solo servidor** | Firma HMAC de los tokens de QR: **exactamente 64 hex** (32 bytes, `openssl rand -hex 32`) y el mismo valor que `app_secrets.qr_token_secret` |
| `QR_WINDOW_SECONDS` | Config | Duración de la ventana del QR (45 por defecto); debe coincidir con `app_secrets.qr_window_seconds` |
| `NEXT_PUBLIC_ZONA_POR_DEFECTO` | Pública | Slug usado cuando la URL no trae `?zona=` |
| `UPSTASH_REDIS_REST_URL` / `…_TOKEN` | **Secretas** | Rate limiting (Etapa 4); opcionales en local, **obligatorias en producción** |

Reglas: ninguna variable secreta lleva prefijo `NEXT_PUBLIC_` (Next las incrusta en el bundle del
navegador en build-time); `src/lib/env.ts` valida las públicas y `src/lib/env.server.ts` las secretas
con zod al arrancar, y falla ruidosamente si falta una clave o si `QR_TOKEN_SECRET` no tiene 64
caracteres hex. `env.server.ts` está marcado `server-only`: un import desde un Client Component rompe
el build en vez de filtrar la clave. La falta de Upstash se valida **al usar el rate limiter** (no al
importar), para no exigir el servicio durante `next build`; en producción lanza y el endpoint falla
cerrado.

## 10. Estructura de carpetas

```
OptiWork/
├─ AGENTS.md                          # especificación del proyecto (no tocar el bloque de Next)
├─ README.md
├─ docs/
│  ├─ arquitectura.md                 # este documento (Etapa 1)
│  ├─ decisiones-seguridad.md         # justificación de cada decisión (Etapa 1 +)
│  └─ modelo-datos.md                 # Etapa 2: DDL documentado + registro de migraciones
├─ supabase/
│  ├─ migrations/                     # Etapa 2: SQL numerado, se pega en el SQL Editor
│  ├─ verificacion.sql                # Etapa 2: chequeos RLS/jobs/publicación
│  └─ seed.sql                        # Etapa 2: zona hub-providencia
├─ scripts/
│  ├─ simular-datos.ts                # Etapa 6: entradas/salidas + snapshots + resumen_diario
│  └─ generar-tipos.sh                # tipos TS desde el esquema
├─ src/
│  ├─ proxy.ts                        # Etapa 3: refresh de sesión + CSP/HSTS
│  ├─ app/
│  │  ├─ layout.tsx  page.tsx  globals.css  error.tsx  not-found.tsx  forbidden.tsx
│  │  ├─ login/page.tsx               # Etapa 3
│  │  ├─ auth/callback/route.ts       # Etapa 3: magic link → cookies
│  │  ├─ auth/signout/route.ts        # Etapa 3
│  │  ├─ scan/page.tsx                # Etapa 4
│  │  ├─ dashboard/page.tsx           # Etapa 5
│  │  ├─ dashboard/loading.tsx        # Etapa 5
│  │  ├─ qr/page.tsx                  # Etapa 3 (admin): QR de entrada y salida
│  │  ├─ admin/layout.tsx             # Etapa 6: guard de rol
│  │  ├─ admin/page.tsx               # Etapa 6: configuración de zonas
│  │  ├─ admin/historial/page.tsx     # Etapa 6
│  │  └─ api/
│  │     ├─ scan/route.ts             # Etapa 4: POST
│  │     ├─ consentimiento/route.ts   # Etapa 3: POST (RPC registrar_consentimiento)
│  │     ├─ qr/token/route.ts         # Etapa 3: GET (admin)
│  │     ├─ admin/zonas/route.ts      # Etapa 6: PATCH
│  │     └─ admin/export/route.ts     # Etapa 6: GET CSV
│  ├─ components/
│  │  ├─ ui/                          # Card, Button, Badge, Skeleton, EmptyState
│  │  ├─ dashboard/                   # ContadorOcupacion, BarraAforo, Semaforo,
│  │  │                               # GraficoPorHora, MapaCalor, ResumenStats,
│  │  │                               # SelectorZona, ProveedorRealtime
│  │  ├─ scan/ConfirmacionScan.tsx
│  │  ├─ admin/                       # FormularioZona, TablaHistorial, BotonExportCSV
│  │  ├─ qr/QrRotativo.tsx            # Etapa 3: QR que se renueva solo
│  │  └─ auth/                        # FormularioLogin, AvisoConsentimiento
│  ├─ lib/
│  │  ├─ supabase/browser.ts          # createBrowserClient
│  │  ├─ supabase/server.ts           # createServerClient con cookies()
│  │  ├─ supabase/admin.ts            # service_role (server-only)
│  │  ├─ supabase/zonas.ts            # lectura de zonas (RLS)
│  │  ├─ auth/session.ts guards.ts redirects.ts  # getClaims, requireUser/Admin, anti open-redirect
│  │  ├─ qr/token.ts                  # formato + firma HMAC (puro, testeable)
│  │  ├─ qr/imagen.ts                 # SVG del QR (servidor)
│  │  ├─ dominio/ocupacion.ts         # calcularEstado + porcentaje (puro, testeado)
│  │  ├─ dominio/horarios.ts          # apertura/cierre por zona y timezone
│  │  ├─ dominio/consentimiento.ts    # versión vigente del aviso
│  │  ├─ validacion/qr.ts consentimiento.ts scan.ts zona.ts # esquemas zod de entrada
│  │  ├─ http/origen.ts               # comprobación de mismo origen (CSRF)
│  │  ├─ env.ts  env.server.ts        # validación zod de variables de entorno
│  │  ├─ rate-limit.ts                # Upstash (+ fallback local en dev)
│  │  └─ csv.ts  cn.ts                # exportación y clases
│  └─ types/
│     ├─ database.types.ts            # generado desde el esquema
│     └─ dominio.ts                   # Zona, Sesion, ResultadoScan, EstadoOcupacion
├─ tests/
│  ├─ setup.ts
│  ├─ unit/ocupacion.test.ts          # umbrales, bordes 40/80, porcentaje
│  ├─ unit/qr-token.test.ts           # ventana actual/anterior, firma inválida, timing-safe
│  └─ rls/                            # sesiones, eventos_scan, anon
├─ .env.example
├─ vitest.config.mts                  # Etapa 6
└─ (next.config.ts, tsconfig.json, eslint.config.mjs, package.json ya existen)
```

Criterios de organización:

- **Rutas planas, sin route groups innecesarios.** Solo `/admin` tiene `layout.tsx` propio porque
  necesita el guard de rol. Si más adelante se separa el área autenticada, se agrupa con
  `(app)` sin cambiar URLs.
- **`src/lib/dominio` es puro**: sin imports de `next/*` ni de Supabase, para que Vitest lo pruebe
  sin mocks.
- **Un solo lugar por responsabilidad**: token QR en `lib/qr`, sesión en `lib/auth`, esquemas zod
  en `lib/validacion`. Ningún componente arma un token o valida un body a mano.
- **Tests fuera de `src`**: se ejecutan contra el código público, no contra internals.

## 11. Escalabilidad: del Hub a otros espacios

### 11.1 Agregar una zona nueva (hoy)

1. `INSERT` en `zonas` con `slug`, aforo, umbrales y horario (`activa = true`).
2. El trigger de alta crea su fila en `ocupacion_actual` con `cantidad = 0`.
3. `/qr?zona=<slug>` ya permite imprimir/generar el QR de esa zona.
4. `/dashboard?zona=<slug>` ya muestra su ocupación e históricos.
5. Los jobs iteran sobre `zonas where activa`, sin configuración adicional.

No hay cambios de esquema, de código ni de variables de entorno: la zona es un dato.

### 11.2 Escalar a otros espacios del Hub (sedes)

El modelo es plano (`zonas`), suficiente mientras todos los espacios dependan de una
administración. Cuando el Hub sume sedes con administradores distintos:

1. Agregar `sedes(id, nombre, timezone)` y `zonas.sede_id`.
2. Reemplazar `profiles.rol` por una tabla `admin_sedes(user_id, sede_id)` (RLS por sede).
3. Filtrar `/admin`, `/qr` y el export por las sedes del admin autenticado.
4. `timezone` se hereda de la sede, salvo override en la zona.

Ninguna de estas migraciones toca `sesiones`, `eventos_scan` ni el dashboard público: son
aditivas.

### 11.3 Volumen y límites gratuitos

| Recurso | Plan gratuito | Qué implica | Mitigación en el diseño |
| --- | --- | --- | --- |
| Supabase: conexiones Realtime | ~200 concurrentes | Alcanza para el cowork y varias pantallas | Un canal por zona; cerrarlo al desmontar (`removeChannel`) |
| Supabase: mensajes Realtime | millones/mes | Un `UPDATE` por scan, no por segundo | Solo `ocupacion_actual` se publica |
| Supabase: base de datos | 500 MB | `snapshots` = 288 filas/día/zona | Particionar por mes o purgar snapshots > 24 meses |
| Upstash Redis | ~10k comandos/día | ~3 scans/día/usuario con 3 comandos cada uno | Rate limit solo en `/api/scan` y `/api/qr/token`, no en lecturas |
| Vercel Hobby | 100 GB de banda, invocaciones limitadas | RSC + `use cache` reducen invocaciones | Config de zona cacheada; dashboard con dato inicial estático |
| Correo Supabase | ~2–4 emails/hora | Magic link se agota rápido | Contraseña como alternativa + SMTP propio (Resend) |

### 11.4 Camino de crecimiento técnico

- **Costo del contador**: hoy el trigger hace `COUNT(*)` con índice parcial, trivial hasta miles
  de sesiones simultáneas. Si el volumen crece, se cambia a incremento atómico
  (`cantidad = cantidad ± 1`) y la reconciliación de los 5 min sigue corrigiendo la deriva: el
  sistema no depende de que el incremento sea perfecto.
- **Estadísticas**: pasan de calcularse en vivo a leerse de `resumen_diario` + snapshots
  preagregados; el dashboard no cambia.
- **Rate limiting**: claves por `usuario:<id>`, `ip:<hash>` y `zona:<id>` permiten ajustar cupos
  por espacio sin tocar código.
- **Observabilidad**: `eventos_scan.resultado` ya es una métrica operativa lista para graficar
  (cuántos `cooldown`, `token_expirado`, `fuera_horario`).

## 12. Estrategia de pruebas

| Tipo | Herramienta | Alcance | Cuándo |
| --- | --- | --- | --- |
| Unidad (dominio) | Vitest, `environment: 'node'` | `calcularEstado` (bordes 39/40/80/81), porcentaje y redondeo, horarios con DST, formato de permanencia | Etapas 4–6 |
| Unidad (seguridad) | Vitest + Web Crypto | Token: ventana actual válida, anterior válida, dos ventanas atrás inválida, firma alterada, payload alterado, comparación en tiempo constante | Etapa 3 |
| Contrato del borde | Vitest | Esquemas zod de `scan` y `zonas` (rechazan cuerpo vacío, `modo` inválido, token gigante) | Etapa 4 |
| RLS (integración) | Vitest + `@supabase/supabase-js` contra la base real | Usuario A no lee sesiones de B; nadie inserta en `sesiones` ni `eventos_scan`; `anon` no lee `profiles`/`sesiones`/`eventos_scan`; `anon` sí lee `ocupacion_actual` y las funciones de agregados; `anon` no ejecuta `registrar_scan`. Los tests se **saltan** si faltan variables de entorno (`describe.skipIf`), para no romper CI sin credenciales | Etapa 6 |

Detalles de configuración previstos (`vitest.config.mts`):

- `test.environment = 'node'`, `test.include = ['tests/**/*.test.ts']`.
- Alias `@/` resuelto con `resolve.alias` de Node (`node:path`), sin agregar
  `vite-tsconfig-paths`.
- Sin `jsdom` ni Testing Library: el spec pide lógica de negocio y RLS, no tests de componentes.
- Los tests de RLS crean dos usuarios de prueba con `service_role` (solo local) y los eliminan al
  terminar; dependen de la base ya migrada.

## 13. Roadmap por etapas

| Etapa | Entregable | Se detiene para confirmación |
| --- | --- | --- |
| **1. Arquitectura** | `docs/arquitectura.md`, `docs/decisiones-seguridad.md`, `.env.example`, esqueleto de carpetas | ✅ |
| 2. SQL | Migraciones de esquema, RLS, RPC, triggers, jobs, `verificacion.sql`, `seed.sql`, `docs/modelo-datos.md` | Sí |
| 3. Auth y QR | `proxy.ts`, clientes Supabase, `/login`, `/auth/callback`, firma/verificación de token, `/qr` | Sí |
| 4. Scan | `/scan`, `POST /api/scan`, zod, rate limit, cooldown, mapeo de resultados | Sí |
| 5. Dashboard | Contador Realtime, barra, semáforo, gráfico por hora, mapa de calor, hora punta, permanencia | Sí |
| 6. Admin, simulación y tests | `/admin`, export CSV, `scripts/simular-datos.ts`, Vitest (unidad + RLS) | Sí |

En cada etapa se agregan las decisiones nuevas a `docs/decisiones-seguridad.md`, con el mismo
formato, para que el informe final se arme por acumulación.

## 14. Riesgos y limitaciones conocidas

| Riesgo | Impacto | Mitigación |
| --- | --- | --- |
| Migraciones aplicadas a mano en el SQL Editor | Drift entre repo y base | Numeración estricta, idempotencia, `supabase/verificacion.sql` después de cada pegado, registro en `docs/modelo-datos.md` |
| El token del QR viaja en la URL y queda en logs/historial del celular | Replay dentro de la ventana | Ventanas de 45 s, tolerancia de una sola ventana anterior, rate limit + cooldown, `Referrer-Policy` restrictiva en `/scan`, y no reenviar el token al login (`S-12`) |
| Foto del QR tomada dentro del cowork y usada a distancia | Entrada sin presencia física | Ventana corta + cooldown; el fallback definitivo sería geolocalización con consentimiento (fuera del MVP) |
| Límite de correos del plan gratuito de Supabase | Usuarios sin poder entrar | Contraseña como alternativa y, si se consigue, SMTP propio con Resend |
| Cierre automático por horario en feriados | Sesiones cerradas antes de tiempo | La fecha se evalúa en `America/Santiago`; el usuario puede volver a marcar entrada; el histórico no se corrompe |
| Deriva del contador por fallos a mitad de transacción | Dashboard con cifra incorrecta | Trigger transaccional + reconciliación por `COUNT` cada 5 min (`I6`, `S-13`) |
| Recharts en Client Components aumenta el JS del dashboard | Carga más lenta en 3G | Carga diferida del bloque de gráficos con `dynamic`/lazy y datos ya agregados desde el servidor |
| Realtime no disponible (red del cowork) | Contador congelado | Dato inicial del RSC + reintento con backoff + botón de recarga manual |

---

**Siguiente etapa (2):** esquema SQL completo con RLS, funciones, triggers y `pg_cron`, más
`supabase/verificacion.sql`, `supabase/seed.sql` y `docs/modelo-datos.md`. No se escribe nada de
eso hasta la confirmación explícita de la Etapa 1.
