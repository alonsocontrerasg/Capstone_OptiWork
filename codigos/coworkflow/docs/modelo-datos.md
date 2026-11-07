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
| 6 | `20261106000005_stats.sql` | estadísticas públicas con k-anonimato |
| 7 | `20261106000006_pg_cron_jobs.sql` | snapshots, cierre automático, resumen diario y retención |

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
| `public.resultado_scan` | `entrada_ok`, `salida_ok`, `sesion_ya_abierta`, `sin_sesion_abierta`, `cooldown`, `demasiados_intentos`, `token_expirado`, `token_invalido`, `no_autenticado`, `fuera_horario`, `zona_inactiva`, `rate_limited` |

## Tablas

### `profiles` (1:1 con `auth.users`)
| Columna | Tipo | Notas |
|---------|------|-------|
| `id` | `uuid` PK | `references auth.users(id) on delete cascade` |
| `rol` | `rol_usuario` | `not null default 'usuario'`; protegido por trigger |
| `consentimiento_at` | `timestamptz` | se llenará en Etapa 3 (RPC de consentimiento) |
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
`permanencia_prom_seg` (`double precision`). Sobrevive a la purga de 90 días.

### `app_secrets`
`clave` PK `text`, `valor` `text not null`, `actualizado_at`. RLS activa, **sin políticas**.
Solo se lee mediante funciones `SECURITY DEFINER`.

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
| `registrar_scan(text)` | ✗ | ✓ | RPC de check-in/check-out |
| `es_admin()` | ✗ | ✓ | helper RLS |
| `permanencia_promedio(...)` | ✓ | ✓ | estadística pública |
| `personas_distintas(...)` | ✓ | ✓ | estadística pública |
| `handle_new_user`, `proteger_rol`, `validar_timezone_zona`, `refrescar_ocupacion`, `crear_ocupacion_inicial`, `actualizar_ocupacion`, `obtener_secreto_qr`, `zona_abierta`, `cron_*` | ✗ | ✗ | solo trigger/cron/RPC interno |

## Jobs de pg_cron

| Job | Cron (UTC) | Función | Qué hace |
|-----|-----------|---------|----------|
| `coworkflow_snapshot` | `*/5 * * * *` | `cron_snapshot()` | recalcula y guarda snapshot alineado a 5 min |
| `coworkflow_cierre_auto` | `*/15 * * * *` | `cron_cierre_auto()` | cierra sesiones > 8 h o fuera de horario (`cierre='auto'`) |
| `coworkflow_resumen_diario` | `10 5 * * *` | `cron_resumen_diario()` | consolida el día anterior (hora local de cada zona) |
| `coworkflow_retencion` | `0 6 * * *` | `cron_retencion()` | purga crudos > 90 días (conserva agregados) |

Los horarios son en UTC; `10 5 * * *` cae después de medianoche en Chile (UTC-3/-4),
así el resumen del día anterior ya está completo.

## Formato del token QR (contrato con Etapa 3)

```
v1.<zona_uuid>.<entrada|salida>.<ventana>.<hmac_hex>
```

- `v1` = versión del formato.
- `zona_uuid` = `zonas.id` en formato UUID.
- `entrada|salida` = modo.
- `ventana` = `floor(epoch / QR_WINDOW_SECONDS)` (por defecto 45 s).
- `hmac_hex` = `HMAC-SHA256(payload, secreto)` en hex minúscula (64 caracteres), donde
  `payload = "v1.<zona_uuid>.<modo>.<ventana>"`.

El servidor acepta la **ventana actual y la anterior** (hasta ~90 s de margen). Si necesitas
cambiar la duración, inserta `qr_window_seconds` en `app_secrets` **y** ajusta
`QR_WINDOW_SECONDS` en el cliente servidor para que coincidan.

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

(`openssl rand -hex 32` produce 64 caracteres hex = 32 bytes ≥ mínimo exigido.)

### 3. Promover un administrador
El seed **no** crea admins. Tras registrar tu usuario, ejecuta en el SQL Editor:

```sql
update public.profiles
set rol = 'admin'
where id = (select id from auth.users where email = 'tu@email.com');
```

Esto funciona porque `proteger_rol` solo bloquea JWT `authenticated`/`anon`; el SQL Editor
corre sin JWT y por tanto puede cambiar el rol.

### 4. Verificar
Ejecuta `supabase/verificacion.sql`. Debe terminar con `NOTICE: Verificación OK ...`.

## Escalabilidad a otras zonas

El esquema ya es multi-zona: `zonas` tiene su propio `aforo_max`, umbrales, horario, timezone
y fila en `ocupacion_actual`; el QR está firmado por `zona_id`; los triggers y jobs iteran
sobre todas las zonas. Para sumar un espacio del Hub basta con `insert into zonas (...)`.

