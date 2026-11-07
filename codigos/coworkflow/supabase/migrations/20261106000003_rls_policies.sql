-- ============================================================
-- CoworkFlow · Etapa 2 · Migración 4/7
-- Propósito: helper es_admin(), políticas RLS y privilegios de tabla.
-- Requiere: rol postgres. Idempotente.
-- ============================================================

-- es_admin() es SECURITY DEFINER para evitar recursión de RLS al consultar profiles.
create or replace function public.es_admin()
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
stable
as $$
begin
  return exists (
    select 1 from public.profiles
    where id = auth.uid() and rol = 'admin'
  );
end;
$$;
revoke execute on function public.es_admin() from public, anon, authenticated;
grant execute on function public.es_admin() to authenticated;

-- Re-asegurar RLS (idempotente; ya se activó en la migración 1).
alter table public.profiles            enable row level security;
alter table public.zonas               enable row level security;
alter table public.sesiones            enable row level security;
alter table public.eventos_scan        enable row level security;
alter table public.ocupacion_actual    enable row level security;
alter table public.snapshots_ocupacion enable row level security;
alter table public.resumen_diario      enable row level security;
alter table public.app_secrets         enable row level security;

-- ------------------------------------------------------------
-- profiles: cada usuario ve su fila; admin ve todas. Sin escritura.
-- ------------------------------------------------------------
drop policy if exists profiles_select_propio on public.profiles;
create policy profiles_select_propio on public.profiles
  for select to authenticated
  using (id = auth.uid());

drop policy if exists profiles_select_admin on public.profiles;
create policy profiles_select_admin on public.profiles
  for select to authenticated
  using (public.es_admin());

-- ------------------------------------------------------------
-- zonas: lectura pública (aforo/horario no son datos personales); escritura admin.
-- ------------------------------------------------------------
drop policy if exists zonas_select_publico on public.zonas;
create policy zonas_select_publico on public.zonas
  for select to anon, authenticated
  using (true);

drop policy if exists zonas_insert_admin on public.zonas;
create policy zonas_insert_admin on public.zonas
  for insert to authenticated
  with check (public.es_admin());

drop policy if exists zonas_update_admin on public.zonas;
create policy zonas_update_admin on public.zonas
  for update to authenticated
  using (public.es_admin())
  with check (public.es_admin());

drop policy if exists zonas_delete_admin on public.zonas;
create policy zonas_delete_admin on public.zonas
  for delete to authenticated
  using (public.es_admin());

-- ------------------------------------------------------------
-- sesiones: el usuario solo ve las suyas; admin ve todas. Sin escritura (solo RPC).
-- ------------------------------------------------------------
drop policy if exists sesiones_select_propia on public.sesiones;
create policy sesiones_select_propia on public.sesiones
  for select to authenticated
  using (user_id = auth.uid());

drop policy if exists sesiones_select_admin on public.sesiones;
create policy sesiones_select_admin on public.sesiones
  for select to authenticated
  using (public.es_admin());

-- ------------------------------------------------------------
-- eventos_scan: solo admin. Sin escritura (solo RPC).
-- ------------------------------------------------------------
drop policy if exists eventos_scan_select_admin on public.eventos_scan;
create policy eventos_scan_select_admin on public.eventos_scan
  for select to authenticated
  using (public.es_admin());

-- ------------------------------------------------------------
-- ocupacion_actual: lectura pública (agregado sin datos personales). Sin escritura.
-- ------------------------------------------------------------
drop policy if exists ocupacion_actual_select_publico on public.ocupacion_actual;
create policy ocupacion_actual_select_publico on public.ocupacion_actual
  for select to anon, authenticated
  using (true);

-- ------------------------------------------------------------
-- snapshots_ocupacion / resumen_diario: agregados de lectura pública. Sin escritura.
-- ------------------------------------------------------------
drop policy if exists snapshots_select_publico on public.snapshots_ocupacion;
create policy snapshots_select_publico on public.snapshots_ocupacion
  for select to anon, authenticated
  using (true);

drop policy if exists resumen_select_publico on public.resumen_diario;
create policy resumen_select_publico on public.resumen_diario
  for select to anon, authenticated
  using (true);

-- app_secrets: RLS activa y SIN políticas → deny-by-default.

-- ------------------------------------------------------------
-- Privilegios de tabla (deny-by-default; RLS es la barrera real).
-- Quitamos los grants que Supabase da por defecto a anon/authenticated.
-- ------------------------------------------------------------
revoke all on public.profiles, public.zonas, public.sesiones, public.eventos_scan,
              public.ocupacion_actual, public.snapshots_ocupacion, public.resumen_diario
  from anon, authenticated;
revoke all on public.app_secrets from anon, authenticated;

-- Lecturas permitidas (filtradas luego por RLS)
grant select on public.zonas               to anon, authenticated;
grant select on public.ocupacion_actual    to anon, authenticated;
grant select on public.snapshots_ocupacion to anon, authenticated;
grant select on public.resumen_diario      to anon, authenticated;
grant select on public.profiles            to authenticated;
grant select on public.sesiones            to authenticated;
grant select on public.eventos_scan        to authenticated;

-- Escritura de configuración: solo admin (RLS con es_admin()); nunca a anon.
grant insert, update, delete on public.zonas to authenticated;

