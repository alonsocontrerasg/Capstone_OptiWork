-- CoworkFlow · Corrección de concurrencia del contador (S-47).
-- Aplicar DESPUÉS de las migraciones 1..10, en una sola transacción.
-- No requiere cambios en el frontend, en registrar_scan ni en los jobs programados.
begin;

-- Impide que una escritura use una mezcla de los triggers viejos y nuevos.
lock table public.sesiones in share row exclusive mode;

create or replace function public.refrescar_ocupacion(p_zona_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
volatile
as $$
declare
  v_cantidad integer;
begin
  -- También cubre la creación de zonas y la reparación de una fila ausente.
  insert into public.ocupacion_actual (zona_id, cantidad)
  values (p_zona_id, 0)
  on conflict (zona_id) do nothing;

  -- TODOS los recálculos (trigger, cron y simulación) usan el mismo bloqueo.
  -- Debe adquirirse ANTES de contar. El COUNT es otra sentencia para obtener
  -- una instantánea nueva en READ COMMITTED, después de cualquier espera.
  perform 1 from public.ocupacion_actual
  where zona_id = p_zona_id
  for update;

  select count(*)::integer into v_cantidad
  from public.sesiones
  where zona_id = p_zona_id and salida_at is null;

  update public.ocupacion_actual
  set cantidad = v_cantidad, updated_at = clock_timestamp()
  where zona_id = p_zona_id;
end;
$$;
revoke execute on function public.refrescar_ocupacion(uuid) from public, anon, authenticated;

-- Las tablas de transición permiten recalcular una vez por zona y sentencia,
-- DESPUÉS de modificar todas las sesiones del lote. Así no se repite COUNT por
-- cada fila, y todas las zonas del lote se bloquean en un orden estable.
create or replace function public.actualizar_ocupacion()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_zona_id uuid;
begin
  if tg_op = 'INSERT' then
    for v_zona_id in
      select distinct zona_id from sesiones_nuevas order by zona_id
    loop
      perform public.refrescar_ocupacion(v_zona_id);
    end loop;
  elsif tg_op = 'DELETE' then
    for v_zona_id in
      select distinct zona_id from sesiones_anteriores order by zona_id
    loop
      perform public.refrescar_ocupacion(v_zona_id);
    end loop;
  else
    -- Una reasignación de zona actualiza tanto el origen como el destino.
    for v_zona_id in
      select zona_id from sesiones_anteriores
      union
      select zona_id from sesiones_nuevas
      order by zona_id
    loop
      perform public.refrescar_ocupacion(v_zona_id);
    end loop;
  end if;
  return null; -- los triggers son AFTER ... FOR EACH STATEMENT
end;
$$;
revoke execute on function public.actualizar_ocupacion() from public, anon, authenticated;

drop trigger if exists trg_sesiones_actualizar_ocupacion on public.sesiones;
drop trigger if exists trg_sesiones_actualizar_ocupacion_update on public.sesiones;
drop trigger if exists trg_sesiones_actualizar_ocupacion_delete on public.sesiones;

create trigger trg_sesiones_actualizar_ocupacion
  after insert on public.sesiones
  referencing new table as sesiones_nuevas
  for each statement execute function public.actualizar_ocupacion();

create trigger trg_sesiones_actualizar_ocupacion_update
  after update on public.sesiones
  referencing old table as sesiones_anteriores new table as sesiones_nuevas
  for each statement execute function public.actualizar_ocupacion();

create trigger trg_sesiones_actualizar_ocupacion_delete
  after delete on public.sesiones
  referencing old table as sesiones_anteriores
  for each statement execute function public.actualizar_ocupacion();

-- Mismo orden de bloqueo que el trigger cuando se afectan varias zonas.
-- La firma y el nombre del job no cambian: no hay que reprogramar pg_cron.
create or replace function public.cron_snapshot()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  z record;
  v_ts timestamptz := date_bin(interval '5 minutes', now(), timestamptz '2000-01-01 00:00:00+00');
begin
  for z in select id from public.zonas where activa order by id loop
    perform public.refrescar_ocupacion(z.id);
    insert into public.snapshots_ocupacion (zona_id, ts, cantidad)
    select z.id, v_ts, oa.cantidad
    from public.ocupacion_actual oa
    where oa.zona_id = z.id
    on conflict (zona_id, ts) do update set cantidad = excluded.cantidad;
  end loop;
end;
$$;
revoke execute on function public.cron_snapshot() from public, anon, authenticated;

-- Repara cualquier deriva previa. Las escrituras de sesiones siguen bloqueadas
-- hasta COMMIT; los lectores continúan viendo el último estado confirmado.
do $$
declare
  v_zona_id uuid;
begin
  for v_zona_id in select id from public.zonas order by id loop
    perform public.refrescar_ocupacion(v_zona_id);
  end loop;
end;
$$;

commit;
