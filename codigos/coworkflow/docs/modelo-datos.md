# CoworkFlow — Modelo de datos (Etapa 2)

Esquema SQL implementado en `supabase/migrations/`. Complementa `docs/arquitectura.md`;
la justificación de cada decisión de seguridad está en `docs/decisiones-seguridad.md`.

## Cómo aplicar

No hay Supabase CLI en este proyecto: las migraciones se pegan en el **SQL Editor** de
Supabase, **en orden de nombre de archivo**, y al final se ejecuta `verificacion.sql`.

| # | Archivo | Contenido |
|---|---------|-----------|
| 1 | `20261106000000_enums_y_tablas.sql` | extensiones, enums, tablas, checks, índices y `enable row level security` |
| 2 | `20261106000001_triggers_perfil.sql` | alta de perfil (`auth.users` → `profiles`) y protección de `rol` |
| 3 | `20261106000002_triggers_ocupacion.sql` | contador `ocupacion_actual` + publicación Realtime |
| 4 | `20261106000003_rls_policies.sql` | políticas RLS y privilegios de tabla |
| 5 | `20261106000004_rpc_registrar_scan.sql` | RPC de check-in/check-out con HMAC |
| 6 | `20261106000005_stats.sql` | estadísticas públicas con k-anonimato por personas distintas |
| 7 | `20261106000006_pg_cron_jobs.sql` | snapshots, cierre automático, resumen diario y retención |
| 8 | `20261110000000_consentimiento_y_scan.sql` | Etapa 3: `sin_consentimiento`, RPC `registrar_consentimiento` y `registrar_scan` con gate de consentimiento |
| 9 | `20261111000000_dashboard_agregados.sql` | Etapa 5: agregados del dashboard (`ocupacion_por_franja` y `ocupacion_hoy`) sobre `snapshots_ocupacion`, sin PII |

> ⚠️ La migración 8 empieza con un `alter type ... add value` **aislado**: hay que seleccionarlo y
> ejecutarlo solo, y después el resto del archivo. Postgres no permite usar un valor nuevo de un enum
> dentro de la misma transacción en la que se agrega.

Luego, en el SQL Editor:
1. `supabase/seed.sql` → crea la zona `hub-providencia` (aforo 100, umbrales 40/80).
2. `supabase/verificacion.sql` → confirma RLS, políticas, privilegios, funciones, Realtime y cron.

## Extensiones

- **pgcrypto**: `hmac()`/`digest()`. En Supabase vive en el esquema **`extensions`** (no en
  `public`). Por eso la RPC llama a **`extensions.hmac(...)`**. La migración 1 detecta el
  esquema real y emite un `NOTICE` si no está en `extensions`. No agregamos `extensions` al
  `search_path` de las funciones: se cualifica el nombre, que es más restrictivo.
- **pg_cron**: se habilita desde **Dashboard → Database → Extensions** (no basta con
  `create extension` desde el SQL Editor). Ver "Pasos manuales".

## Enums

| Enum | Valores |
|------|---------|
| `public.rol_usuario` | `usuario`, `admin` |
| `public.tipo_cierre` | `usuario`, `auto` |
| `public.tipo_scan` | `entrada`, `salida` |
| `public.resultado_scan` | `entrada_ok`, `salida_ok`, `sesion_ya_abierta`, `sin_sesion_abierta`, `cooldown`, `demasiados_intentos`, `token_expirado`, `token_invalido`, `no_autenticado`, `fuera_horario`, `zona_inactiva`, `rate_limited`, `sin_consentimiento` |

## Tablas

### `profiles` (1:1 con `auth.users`)
| Columna | Tipo | Notas |
|---------|------|-------|
| `id` | `uuid` PK | `references auth.users(id) on delete cascade` |
| `rol` | `rol_usuario` | `not null default 'usuario'`; protegido por trigger |
| `consentimiento_at` | `timestamptz` | `NULL` = no aceptó. Lo escribe la RPC `registrar_consentimiento` (Etapa 3) |
| `consentimiento_version` | `integer` | versión del aviso aceptado |
| `creado_at` | `timestamptz` | `default now()` |

### `zonas`
| Columna | Tipo | Notas |
|---------|------|-------|
| `id` | `uuid` PK | `default gen_random_uuid()` |
| `slug` | `text` | `unique`, `check` kebab-case |
| `nombre` | `text` | |
| `aforo_max` | `integer` | `check > 0` |
| `umbral_bajo` | `integer` | `default 40`, `check 0..100` |
| `umbral_alto` | `integer` | `default 80`, `check 0..100` |
| `hora_apertura` | `time` | `default '08:00'` |
| `hora_cierre` | `time` | `default '20:00'` |
| `timezone` | `text` | `default 'America/Santiago'`, validado por trigger |
| `activa` | `boolean` | `default true` |

Checks: `zonas_umbrales_orden (umbral_bajo < umbral_alto)` y
`zonas_horario_orden (hora_apertura < hora_cierre)` (el horario no cruza medianoche).

### `sesiones`
| Columna | Tipo | Notas |
|---------|------|-------|
| `id` | `uuid` PK | `default gen_random_uuid()` |
| `user_id` | `uuid` | `references auth.users(id) on delete cascade` |
| `zona_id` | `uuid` | `references zonas(id) on delete restrict` |
| `entrada_at` | `timestamptz` | `default now()` |
| `salida_at` | `timestamptz` | `NULL` = sesión abierta |
| `cierre` | `tipo_cierre` | `NULL` si abierta; `usuario`/`auto` al cerrar |

Índices: `sesiones_una_abierta_por_usuario` (UNIQUE parcial `where salida_at is null`,
garantiza una sola sesión abierta por usuario), `sesiones_zona_abiertas`, `sesiones_zona_entrada`.

### `eventos_scan` (auditoría)
| Columna | Tipo | Notas |
|---------|------|-------|
| `id` | `uuid` PK | |
| `user_id` | `uuid` | `NULL` en intentos sin identidad; `on delete set null` |
| `zona_id` | `uuid` | `NULL` si el token ilegible no permitió extraerla |
| `tipo` | `tipo_scan` | `NULL` si el token ilegible |
| `ts` | `timestamptz` | `default now()` |
| `resultado` | `resultado_scan` | `not null` |

### `ocupacion_actual` (agregado; única tabla en Realtime)
`zona_id` PK `references zonas(id) on delete cascade`, `cantidad integer not null default 0`
(`check >= 0`), `updated_at timestamptz`. Se recalcula en la misma transacción que cada
cambio de `sesiones`.

### `snapshots_ocupacion`
PK `(zona_id, ts)`; `cantidad integer` (`check >= 0`). Una fila cada 5 min por zona.

### `resumen_diario`
PK `(zona_id, fecha)`; `entradas`, `salidas`, `sesiones_cerradas`, `pico` (`integer`) y
`permanencia_prom_seg` (`double precision`, **nullable**). Sobrevive a la purga de 90 días.

`permanencia_prom_seg` se calcula **solo** con sesiones cerradas por el usuario (`cierre = 'usuario'`):
los cierres `auto` son topes administrativos (8 h o fin de horario) y no miden una permanencia real.
Además queda en `NULL` cuando esas sesiones provienen de menos de 5 **personas distintas**
(`count(distinct user_id) < 5`, **k-anonimato**, mismo umbral `k = 5` que `stats.sql`): la tabla la
puede leer `anon`, y un promedio calculado sobre 1–4 personas describiría la jornada de alguien
concreto. El conteo es por persona y no por sesión: varias sesiones del mismo día son la misma
persona. Por eso no se usa `0` como valor por defecto: `NULL` significa «no publicable» y el dashboard
debe mostrarlo como «sin datos».

### Estadísticas públicas (`stats.sql`)

`permanencia_promedio()` y `personas_distintas()` reciben `(zona_id, p_desde, p_hasta)` y:

- alinean ambos extremos a medianoche de la zona:
  `date_trunc('day', x at time zone z.timezone) at time zone z.timezone` (`z.timezone` se lee de
  `zonas`; si la zona no existe, devuelven `NULL`);
- responden **solo** a rangos de 1..90 días completos (la ventana de retención de crudos); fuera de
  eso devuelven `NULL`. El rango es semiabierto `[día(p_desde), día(p_hasta))`: para un solo día hay
  que pasar el límite del día siguiente, y si ambos extremos caen el mismo día calendario el rango
  queda vacío (`NULL`, no una celda de 0 minutos);
- exigen `count(distinct user_id) >= 5` sobre el conjunto que agregan (**personas distintas**, no
  sesiones), y `permanencia_promedio()` promedia solo sesiones con `cierre = 'usuario'`.

`NULL` significa «sin datos publicables» (nunca `0`). Límite aceptado y documentado: el k-anonimato no
impide comparar dos rangos solapados y despejar la celda restante (ataque por diferencia); ver
`docs/decisiones-seguridad.md` (S-23).

### Agregados del dashboard (`dashboard_agregados.sql`, migración 9)

El dashboard público **no** lee `snapshots_ocupacion` crudo: PostgREST corta cada respuesta en
1000 filas y 30 días de snapshots cada 5 min son ~8.640, así que la consulta se truncaría en
silencio. La migración 9 agrega en Postgres y devuelve como máximo 168 filas (7 días × 24 horas)
o 288 (un día):

- `ocupacion_por_franja(p_zona_id uuid, p_dias integer)` devuelve
  `(dow integer, hora integer, promedio double precision, muestras bigint)`.
  - `p_dias` solo acepta **7 o 30**; cualquier otro valor (incluido `NULL`) devuelve el conjunto
    vacío, no un error. Es una lista cerrada: el cliente no puede pedir rangos arbitrarios.
  - La ventana son **días civiles completos de la zona**: `p_dias` días que terminan en la
    medianoche local de hoy, rango semiabierto `[desde, hasta)`. Se calcula sobre el reloj local
    (`now() at time zone z.timezone`) y luego se vuelve a `timestamptz`, así que atraviesa los
    cambios de horario de verano sin correrse un día.
  - `dow` es ISO 8601 (`1` = lunes … `7` = domingo) y `hora` es `0..23`, ambos en la zona horaria
    de la zona.
  - Solo se agregan snapshots cuya hora local cae en `[hora_apertura, hora_cierre)`; el mapa de
    calor nunca muestra horas en que el cowork está cerrado. `promedio` es el promedio de las
    muestras existentes de esa celda y `muestras` cuántas hay: una celda sin muestras **no
    aparece** y el dashboard la pinta como «sin dato», nunca como `0`.
  - El resultado va ordenado por `dow, hora` y usa el índice `(zona_id, ts)` de la PK.

- `ocupacion_hoy(p_zona_id uuid)` devuelve `(ts timestamptz, cantidad integer)`: los snapshots del
  día local actual, `[medianoche local, siguiente medianoche local)`, ordenados por `ts` y con
  `limit 288` (24 h × 12 bins de 5 min). Alimenta la curva de «hoy», para que el dashboard no
  quede vacío durante el primer día.

Ambas son `SECURITY DEFINER` con `search_path = public, pg_temp`, `STABLE`, y solo leen
`snapshots_ocupacion` (agregados; no hay `user_id` ni sesiones). `EXECUTE` se revoca a `public`
y se concede únicamente a `anon` y `authenticated`; `verificacion.sql` comprueba además que no
quede el grant implícito a `PUBLIC` y que `p_dias = 5` devuelva 0 filas.

`resumen_diario` **no** se usa en el dashboard: sus `entradas`/`salidas`/`pico` no pasan por
k-anonimato. Las únicas estadísticas de sesiones que se muestran son `permanencia_promedio` y
`personas_distintas`, que exigen `count(distinct user_id) >= 5`.

### `app_secrets`
`clave` PK `text`, `valor` `text not null`, `actualizado_at`. RLS activa, **sin políticas**.
Solo se lee mediante funciones `SECURITY DEFINER`.

| `clave` | `valor` | Uso |
|---------|---------|-----|
| `qr_token_secret` | hex de 64 caracteres (256 bits de entropía) | clave HMAC del token QR; la clave usada es el **texto** del secreto (64 bytes UTF-8), no los 32 bytes que representa el hex (`verificacion.sql` exige ≥ 64 caracteres) |
| `qr_window_seconds` | `45` | duración de la ventana rotativa, en segundos |

`qr_window_seconds` **debe ser igual a `QR_WINDOW_SECONDS` del `.env` (45)**; ver «Formato del
token QR». Si la fila no existe, la RPC usa `c_ventana_default = 45`
(`..._rpc_registrar_scan.sql`), que es el valor de `.env.example`, así que por defecto ambos
lados ya coinciden.

## Triggers

| Trigger | Tabla | Función | Efecto |
|---------|-------|---------|--------|
| `on_auth_user_created` | `auth.users` (AFTER INSERT) | `handle_new_user()` | crea la fila en `profiles` con rol `usuario` |
| `trg_proteger_rol` | `profiles` (BEFORE UPDATE) | `proteger_rol()` | bloquea cambiar `rol` si el JWT es `authenticated`/`anon` |
| `trg_validar_timezone_zona` | `zonas` (BEFORE INSERT/UPDATE) | `validar_timezone_zona()` | rechaza `timezone` que no exista en `pg_timezone_names` |
| `trg_zonas_crear_ocupacion` | `zonas` (AFTER INSERT) | `crear_ocupacion_inicial()` | crea la fila de `ocupacion_actual` |
| `trg_sesiones_actualizar_ocupacion` | `sesiones` (AFTER INSERT/UPDATE/DELETE) | `actualizar_ocupacion()` | recalcula `ocupacion_actual` en la misma transacción |

## Funciones y privilegios EXECUTE

Todas son `SECURITY DEFINER` con `search_path` fijo. Se revoca `EXECUTE` a
`public`, `anon` y `authenticated` salvo lo indicado.

| Función | `anon` | `authenticated` | Uso |
|---------|:------:|:---------------:|-----|
| `registrar_scan(text)` | ✗ | ✓ | RPC de check-in/check-out (exige consentimiento) |
| `registrar_consentimiento(integer)` | ✗ | ✓ | registra la aceptación del aviso (Ley 21.719) |
| `es_admin()` | ✗ | ✓ | helper RLS |
| `permanencia_promedio(...)` | ✓ | ✓ | estadística pública (solo `cierre = 'usuario'`) |
| `personas_distintas(...)` | ✓ | ✓ | estadística pública (`count(distinct user_id)`) |
| `ocupacion_por_franja(uuid, integer)` | ✓ | ✓ | agregado público día ISO × hora (solo snapshots, 7 o 30 días) |
| `ocupacion_hoy(uuid)` | ✓ | ✓ | snapshots del día local actual (máx. 288, solo agregados) |
| `handle_new_user`, `proteger_rol`, `validar_timezone_zona`, `refrescar_ocupacion`, `crear_ocupacion_inicial`, `actualizar_ocupacion`, `obtener_secreto_qr`, `zona_abierta`, `cron_*` | ✗ | ✗ | solo trigger/cron/RPC interno |

## Jobs de pg_cron

| Job | Cron (UTC) | Función | Qué hace |
|-----|-----------|---------|----------|
| `coworkflow_snapshot` | `*/5 * * * *` | `cron_snapshot()` | recalcula y guarda snapshot alineado a 5 min |
| `coworkflow_cierre_auto` | `*/15 * * * *` | `cron_cierre_auto()` | cierra sesiones > 8 h o fuera de horario (`cierre='auto'`, `salida_at = least(now(), entrada_at + 8 h)`) |
| `coworkflow_resumen_diario` | `10 5 * * *` | `cron_resumen_diario()` | consolida el día anterior (hora local de cada zona) |
| `coworkflow_retencion` | `0 6 * * *` | `cron_retencion()` | purga crudos > 90 días (conserva agregados) |

Los horarios son en UTC; `10 5 * * *` cae después de medianoche en Chile (UTC-3/-4),
así el resumen del día anterior ya está completo.

## Reglas de `registrar_scan`

Orden de verificación dentro de la RPC (todo en una transacción):

1. `auth.uid()` presente → si no, `no_autenticado` (no escribe nada).
2. **Consentimiento**: si `profiles.consentimiento_at` es `NULL` → `sin_consentimiento` (no escribe
   nada, ni siquiera en `eventos_scan`). Es un gate previo, no un resultado de intento.
3. Límite de 10 intentos inválidos por minuto → `demasiados_intentos`. Cuenta las filas de
   `eventos_scan` del usuario con `ts > now() - interval '1 minute'` y `resultado not in
   ('entrada_ok', 'salida_ok')`; cuando ya hay 10, el intento siguiente se rechaza **sin insertar fila**
   (si no, el contador nunca bajaría).
4. Firma HMAC y formato del token → `token_invalido`.
5. Ventana actual o anterior → `token_expirado`.
6. Zona activa / horario → `zona_inactiva`, `fuera_horario`.
7. Cooldown de 30 s → `cooldown`.
8. Reglas de sesión → `sesion_ya_abierta`, `sin_sesion_abierta`, o `entrada_ok` / `salida_ok`.

`rate_limited` **no** lo emite la RPC: es un resultado sintético del borde. `POST /api/scan` responde
`rate_limited` (429) cuando Upstash niega el intento —60/min por IP o 10/min por usuario— sin llegar a
llamar a `registrar_scan` (ver `docs/decisiones-seguridad.md`, S-30). La RPC solo puede devolver valores
de `public.resultado_scan`, y `demasiados_intentos` sí viene de ella (paso 3).

La versión 2 de la RPC (`20261110000000_consentimiento_y_scan.sql`) es una copia exacta de la
migración 5 con **una sola** adición: el paso 2. Se mantuvo todo lo demás igual (incluido el orden y
los comentarios) para que el diff sea auditable.

## Formato del token QR (contrato con Etapa 3)

```
v1.<zona_uuid>.<entrada|salida>.<ventana>.<hmac_hex>
```

- `v1` = versión del formato.
- `zona_uuid` = `zonas.id` en formato UUID.
- `entrada|salida` = modo.
- `ventana` = `floor(epoch / QR_WINDOW_SECONDS)` (por defecto 45 s).
- `hmac_hex` = `HMAC-SHA256(payload, secreto)` en hex minúscula (64 caracteres), donde
  `payload = "v1.<zona_uuid>.<modo>.<ventana>"`. La **clave** es el **texto** del secreto
  (`qr_token_secret` / `QR_TOKEN_SECRET`) tal cual: 64 caracteres ASCII = 64 bytes UTF-8, igual que
  `extensions.hmac(text, text, 'sha256')` en Postgres. **No** son los 32 bytes que representa el hex;
  por eso el servidor firma con `new TextEncoder().encode(secretoHex)`. Vector de prueba (para el test
  de Vitest): `HMAC-SHA256("v1.00000000-0000-4000-8000-000000000000.entrada.123", clave = "ab" × 32)` =
  `fd5034f93e12180c2b8169e2cac20f53a0de3848fb6b046186bfc1138fa5bdef`.

El servidor acepta la **ventana actual y la anterior** (hasta ~90 s de margen).

### Coincidencia obligatoria de la ventana: 45 s

`qr_window_seconds` (`app_secrets`) y `QR_WINDOW_SECONDS` (`.env.local` / Vercel) **deben tener
el mismo valor: `45`**. El servidor firma la ventana calculada con `QR_WINDOW_SECONDS` y la RPC
la valida con `qr_window_seconds`; si los valores difieren, la ventana firmada nunca cae en
«actual o anterior» y **todos** los escaneos se rechazan con `token_expirado` (falla cerrado:
no abre un hueco de seguridad, pero rompe el check-in). Si cambias uno, cambia el otro y
re-despliega; el QR vigente se invalida solo.

| Dónde | Nombre | Valor |
|-------|--------|-------|
| `.env.local` / Vercel | `QR_WINDOW_SECONDS` | `45` |
| `app_secrets` (SQL) | fila con `clave = 'qr_window_seconds'` | `45` |
| RPC, si falta la fila | `c_ventana_default` en `..._rpc_registrar_scan.sql` | `45` |

## Pasos manuales (una sola vez)

### 1. Habilitar pg_cron
Dashboard → **Database → Extensions** → habilitar **pg_cron**. Luego re-pega la migración 7
(o vuelve a ejecutarla) para programar los 4 jobs.

### 2. Definir el secreto QR
El secreto **no** está en ninguna migración ni en el seed. Genéralo y guárdalo en dos lugares
con el **mismo** valor: `app_secrets` (para la RPC) y `QR_TOKEN_SECRET` en `.env.local`
(para firmar en la Etapa 3).

```bash
openssl rand -hex 32
```

```sql
insert into public.app_secrets (clave, valor)
values ('qr_token_secret', 'PEGA_AQUI_EL_HEX_DE_64_CARACTERES')
on conflict (clave) do update set valor = excluded.valor, actualizado_at = now();
```

(`openssl rand -hex 32` produce 64 caracteres hex = **256 bits** de entropía; como clave HMAC se usa el
**texto** de 64 caracteres, o sea 64 bytes UTF-8. `verificacion.sql` exige **al menos 64 caracteres**,
así que un valor hex de 64 es el mínimo aceptado.)

### 2b. Fijar la ventana del QR (45 s)
La ventana vive en dos lugares que **deben coincidir**: `qr_window_seconds` en `app_secrets`
(validación en la RPC) y `QR_WINDOW_SECONDS` en `.env.local` / Vercel (firma en el servidor).
Ambos van en `45`. Si la fila falta, la RPC usa `45` por defecto y coincide con `.env.example`,
pero es mejor dejarla explícita para que se vea en la base:

```sql
insert into public.app_secrets (clave, valor)
values ('qr_window_seconds', '45')
on conflict (clave) do update set valor = excluded.valor, actualizado_at = now();
```

Si cambias este valor, cambia también `QR_WINDOW_SECONDS` (y al revés): con valores distintos
la RPC rechaza todos los tokens como `token_expirado`.

### 3. Promover un administrador
El seed **no** crea admins. Tras registrar tu usuario, ejecuta en el SQL Editor:

```sql
update public.profiles
set rol = 'admin'
where id = (select id from auth.users where email = 'tu@email.com');
```

Esto funciona porque `proteger_rol` solo bloquea JWT `authenticated`/`anon`; el SQL Editor
corre sin JWT y por tanto puede cambiar el rol.

### 3b. Aplicar la migración 8 (Etapa 3)

1. Abre `20261110000000_consentimiento_y_scan.sql`, selecciona **solo** el
   `alter type public.resultado_scan add value if not exists 'sin_consentimiento';` y ejecútalo.
2. Ejecuta el resto del archivo (la RPC `registrar_consentimiento` y la nueva versión de
   `registrar_scan`).
3. Verifica que el enum quedó con el valor nuevo:

```sql
select unnest(enum_range(null::public.resultado_scan))::text as valor;
```

Si se ejecuta todo junto, Postgres responde `unsafe use of new value of enum type` y hay que repetir
el paso 1 por separado. Es idempotente: volver a ejecutarlo no cambia nada.

Usuarios que ya existían quedan con `consentimiento_at = NULL`, así que la app les pedirá aceptar el
aviso antes de marcar entrada/salida (`sin_consentimiento` hasta entonces).

### 3c. Configurar Auth en Supabase (Etapa 3)

En **Authentication → URL Configuration**:

- **Site URL**: `http://localhost:3000` en local, o el dominio de Vercel en producción.
- **Redirect URLs**: agrega `http://localhost:3000/auth/callback` y
  `https://<tu-dominio>/auth/callback`. Si faltan, Supabase rechaza el `emailRedirectTo` y el
  enlace mágico vuelve a la Site URL sin canjear el código.

En **Authentication → Providers → Email**:

- El **enlace mágico** funciona con el correo de Supabase, pero su plan gratuito limita los envíos
  por hora; para la demo conviene configurar SMTP propio (Resend) o usar la vía de contraseña.
- Con contraseña, deja **Confirm email** activo: así el registro no crea sesión hasta confirmar.

Rutas que expone la app en esta etapa: `/login`, `/auth/callback`, `/auth/signout` (solo `POST`),
`/api/consentimiento` (`POST`), `/qr` y `/api/qr/token` (`GET`, solo admin).

### 4. Verificar
Ejecuta `supabase/verificacion.sql`. Debe terminar con `NOTICE: Verificación OK ...`.

## Escalabilidad a otras zonas

El esquema ya es multi-zona: `zonas` tiene su propio `aforo_max`, umbrales, horario, timezone
y fila en `ocupacion_actual`; el QR está firmado por `zona_id`; los triggers y jobs iteran
sobre todas las zonas. Para sumar un espacio del Hub basta con `insert into zonas (...)`.

