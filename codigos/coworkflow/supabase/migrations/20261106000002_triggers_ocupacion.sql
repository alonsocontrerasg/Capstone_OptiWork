-- ============================================================
-- CoworkFlow · Etapa 2 · Migración 3/7
-- Propósito: mantener ocupacion_actual dentro de la misma transacción
--            que cada check-in/check-out, y publicar SOLO
--            ocupacion_actual en Realtime.
-- Requiere: rol postgres. Idempotente.
-- ============================================================

-- Recalcula el contador de una zona desde sesiones abiertas (I6).
create or replace function public.refrescar_ocupacion(p_zona_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cantidad integer;
begin
  select count(*)::int into v_cantidad
  from public.sesiones
  where zona_id = p_zona_id and salida_at is null;

  insert into public.ocupacion_actual (zona_id, cantidad, updated_at)
  values (p_zona_id, v_cantidad, now())
  on conflict (zona_id)
  do update set cantidad = excluded.cantidad, updated_at = excluded.updated_at;
end;
$$;
revoke execute on function public.refrescar_ocupacion(uuid) from public, anon, authenticated;

-- Crea la fila de ocupacion_actual al dar de alta una zona.
create or replace function public.crear_ocupacion_inicial()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.refrescar_ocupacion(new.id);
  return new;
end;
$$;
revoke execute on function public.crear_ocupacion_inicial() from public, anon, authenticated;

drop trigger if exists trg_zonas_crear_ocupacion on public.zonas;
create trigger trg_zonas_crear_ocupacion
  after insert on public.zonas
  for each row execute function public.crear_ocupacion_inicial();

-- Tras cada cambio de sesiones, recalcula el contador de la(s) zona(s) afectada(s).
-- Corre en la misma transacción que el insert/update/delete → el dashboard nunca ve un valor desfasado.
create or replace function public.actualizar_ocupacion()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    perform public.refrescar_ocupacion(old.zona_id);
    return old;
  elsif tg_op = 'UPDATE' then
    if new.zona_id is distinct from old.zona_id then
      perform public.refrescar_ocupacion(old.zona_id);
    end if;
    perform public.refrescar_ocupacion(new.zona_id);
    return new;
  else
    perform public.refrescar_ocupacion(new.zona_id);
    return new;
  end if;
end;
$$;
revoke execute on function public.actualizar_ocupacion() from public, anon, authenticated;

drop trigger if exists trg_sesiones_actualizar_ocupacion on public.sesiones;
create trigger trg_sesiones_actualizar_ocupacion
  after insert or update or delete on public.sesiones
  for each row execute function public.actualizar_ocupacion();

-- ------------------------------------------------------------
-- Realtime: publicar SOLO ocupacion_actual (nunca user_id).
-- Lo hacemos idempotente y tolerante a que pg_cron/realtime no estén configurados.
-- ------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'ocupacion_actual'
    ) then
      execute 'alter publication supabase_realtime add table public.ocupacion_actual';
    end if;
  else
    raise notice 'La publicación supabase_realtime no existe; no se pudo agregar ocupacion_actual.';
  end if;
end $$;
