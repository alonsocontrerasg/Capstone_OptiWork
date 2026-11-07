-- ============================================================
-- CoworkFlow · Etapa 2 · Migración 1/7
-- Propósito: extensiones, enums, tablas, checks e índices.
-- Requiere: rol postgres (SQL Editor de Supabase). Idempotente.
-- NOTA: se habilita RLS en las 8 tablas AL FINAL de este archivo,
--       para que ninguna quede expuesta entre migraciones.
--       Las políticas se crean en la migración 4.
-- ============================================================

-- pgcrypto aporta hmac()/digest(). En Supabase vive en el esquema `extensions`.
-- Detectamos dónde está; si no está instalada la creamos en `extensions`.
do $$
declare
  v_esquema text;
begin
  select n.nspname into v_esquema
  from pg_extension e join pg_namespace n on n.oid = e.extnamespace
  where e.extname = 'pgcrypto';

  if v_esquema is null then
    execute 'create schema if not exists extensions';
    execute 'create extension pgcrypto with schema extensions';
    v_esquema := 'extensions';
  end if;

  if v_esquema <> 'extensions' then
    raise notice 'AVISO: pgcrypto está en el esquema "%" (no en extensions). La migración 5 llama a extensions.hmac(); reinstala pgcrypto en "extensions" o ajusta esa llamada.', v_esquema;
  end if;
end $$;

-- ------------------------------------------------------------
-- Enums (no existe "create type if not exists", se crean en un DO)
-- ------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
                 where n.nspname = 'public' and t.typname = 'rol_usuario') then
    execute 'create type public.rol_usuario as enum (''usuario'', ''admin'')';
  end if;
  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
                 where n.nspname = 'public' and t.typname = 'tipo_cierre') then
    execute 'create type public.tipo_cierre as enum (''usuario'', ''auto'')';
  end if;
  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
                 where n.nspname = 'public' and t.typname = 'tipo_scan') then
    execute 'create type public.tipo_scan as enum (''entrada'', ''salida'')';
  end if;
  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
                 where n.nspname = 'public' and t.typname = 'resultado_scan') then
    execute $e$create type public.resultado_scan as enum (
      'entrada_ok', 'salida_ok', 'sesion_ya_abierta', 'sin_sesion_abierta',
      'cooldown', 'demasiados_intentos', 'token_expirado', 'token_invalido',
      'no_autenticado', 'fuera_horario', 'zona_inactiva', 'rate_limited')$e$;
  end if;
end $$;

-- ------------------------------------------------------------
-- profiles (1:1 con auth.users; se crea por trigger)
-- ------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  rol public.rol_usuario not null default 'usuario',
  consentimiento_at timestamptz,
  consentimiento_version integer,
  creado_at timestamptz not null default now()
);
comment on table public.profiles is 'Rol y consentimiento, 1:1 con auth.users. Sin políticas de escritura: solo trigger/RPC.';

-- ------------------------------------------------------------
-- app_secrets (secreto QR). Sin acceso para anon/authenticated.
-- ------------------------------------------------------------
create table if not exists public.app_secrets (
  clave text primary key,
  valor text not null,
  actualizado_at timestamptz not null default now()
);
comment on table public.app_secrets is 'Secretos de servidor (p. ej. qr_token_secret). Solo lectura vía funciones SECURITY DEFINER.';

-- ------------------------------------------------------------
-- zonas
-- ------------------------------------------------------------
create table if not exists public.zonas (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  nombre text not null,
  aforo_max integer not null check (aforo_max > 0),
  umbral_bajo integer not null default 40 check (umbral_bajo between 0 and 100),
  umbral_alto integer not null default 80 check (umbral_alto between 0 and 100),
  hora_apertura time not null default '08:00',
  hora_cierre time not null default '20:00',
  timezone text not null default 'America/Santiago',
  activa boolean not null default true,
  creado_at timestamptz not null default now(),
  constraint zonas_umbrales_orden check (umbral_bajo < umbral_alto),
  constraint zonas_horario_orden check (hora_apertura < hora_cierre)
);

-- Valida que timezone sea una zona horaria real de PostgreSQL (evita valores basura).
create or replace function public.validar_timezone_zona()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (select 1 from pg_timezone_names where name = new.timezone) then
    raise exception 'Zona horaria inválida: "%"', new.timezone using errcode = '22023';
  end if;
  return new;
end;
$$;
revoke execute on function public.validar_timezone_zona() from public, anon, authenticated;

drop trigger if exists trg_validar_timezone_zona on public.zonas;
create trigger trg_validar_timezone_zona
  before insert or update on public.zonas
  for each row execute function public.validar_timezone_zona();

-- ------------------------------------------------------------
-- sesiones (estancia abierta/cerrada)
-- ------------------------------------------------------------
create table if not exists public.sesiones (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  zona_id uuid not null references public.zonas(id) on delete restrict,
  entrada_at timestamptz not null default now(),
  salida_at timestamptz,
  cierre public.tipo_cierre,
  constraint sesiones_salida_coherente check (
    (salida_at is null and cierre is null) or (salida_at is not null and cierre is not null)
  )
);
create unique index if not exists sesiones_una_abierta_por_usuario
  on public.sesiones (user_id) where salida_at is null;
create index if not exists sesiones_zona_abiertas
  on public.sesiones (zona_id) where salida_at is null;
create index if not exists sesiones_zona_entrada
  on public.sesiones (zona_id, entrada_at);

-- ------------------------------------------------------------
-- eventos_scan (auditoría de cada intento; zona/tipo nulos si el token no se pudo leer)
-- ------------------------------------------------------------
create table if not exists public.eventos_scan (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  zona_id uuid references public.zonas(id) on delete set null,
  tipo public.tipo_scan,
  ts timestamptz not null default now(),
  resultado public.resultado_scan not null
);
create index if not exists eventos_scan_user_ts on public.eventos_scan (user_id, ts desc);
create index if not exists eventos_scan_zona_ts on public.eventos_scan (zona_id, ts desc);

-- ------------------------------------------------------------
-- ocupacion_actual (tabla agregada; única publicada en Realtime)
-- ------------------------------------------------------------
create table if not exists public.ocupacion_actual (
  zona_id uuid primary key references public.zonas(id) on delete cascade,
  cantidad integer not null default 0 check (cantidad >= 0),
  updated_at timestamptz not null default now()
);

-- ------------------------------------------------------------
-- snapshots_ocupacion (serie cada 5 min)
-- ------------------------------------------------------------
create table if not exists public.snapshots_ocupacion (
  zona_id uuid not null references public.zonas(id) on delete cascade,
  ts timestamptz not null,
  cantidad integer not null check (cantidad >= 0),
  primary key (zona_id, ts)
);

-- ------------------------------------------------------------
-- resumen_diario (agregado que sobrevive a la purga de 90 días)
-- ------------------------------------------------------------
create table if not exists public.resumen_diario (
  zona_id uuid not null references public.zonas(id) on delete cascade,
  fecha date not null,
  entradas integer not null default 0,
  salidas integer not null default 0,
  sesiones_cerradas integer not null default 0,
  permanencia_prom_seg double precision not null default 0,
  pico integer not null default 0,
  primary key (zona_id, fecha)
);

-- ------------------------------------------------------------
-- RLS activada YA (deny-by-default). Las políticas llegan en la migración 4.
-- Así ninguna tabla queda expuesta entre migraciones (defensa en profundidad).
-- ------------------------------------------------------------
alter table public.profiles            enable row level security;
alter table public.zonas               enable row level security;
alter table public.sesiones            enable row level security;
alter table public.eventos_scan        enable row level security;
alter table public.ocupacion_actual    enable row level security;
alter table public.snapshots_ocupacion enable row level security;
alter table public.resumen_diario      enable row level security;
alter table public.app_secrets         enable row level security;

