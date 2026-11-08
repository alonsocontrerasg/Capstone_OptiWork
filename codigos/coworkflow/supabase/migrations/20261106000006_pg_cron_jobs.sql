-- ============================================================
-- CoworkFlow · Etapa 2 · Migración 7/7
-- Propósito: funciones de mantenimiento programado y sus jobs con pg_cron.
-- PRERREQUISITO: habilitar pg_cron en Dashboard > Database > Extensions.
--   Si no está habilitado, esta migración crea igual las funciones y avisa
--   por NOTICE que no se programaron los jobs (se puede repastear luego).
-- ============================================================

-- Cada 5 min: recalcula el contador y guarda un snapshot alineado a 5 min.
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
  for z in select id from public.zonas where activa loop
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

-- Cada 15 min: cierra sesiones abiertas de más de 8 h o fuera del horario (cierre='auto').
-- salida_at = least(now(), entrada_at + 8 h): el tope de 8 h es el valor que se registra cuando
-- la sesión ya lo excedió (no la hora en que corrió el cron, que puede ser horas después), y
-- sigue siendo now() cuando el cierre ocurre por fin de horario. Como la sesión siempre tiene
-- más de 0 s, least() nunca produce una salida anterior a la entrada ni en el futuro.
-- El trigger AFTER UPDATE recalcula ocupacion_actual automáticamente.
create or replace function public.cron_cierre_auto()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.sesiones s
     set salida_at = least(now(), s.entrada_at + interval '8 hours'),
         cierre = 'auto'
    from public.zonas z
   where s.zona_id = z.id
     and s.salida_at is null
     and (
       s.entrada_at < now() - interval '8 hours'
       or not public.zona_abierta(z.id)
     );
end;
$$;
revoke execute on function public.cron_cierre_auto() from public, anon, authenticated;

-- Diario: consolida el día anterior (hora local de cada zona) en resumen_diario.
-- permanencia_prom_seg promedia SOLO sesiones con cierre='usuario' (los cierres 'auto' son
-- topes administrativos: 8 h o fin de horario) y queda en NULL si esas sesiones provienen de
-- menos de 5 personas distintas (k=5), porque la tabla es legible por anon/authenticated.
create or replace function public.cron_resumen_diario()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c_k_anonimato constant integer := 5;  -- mismo umbral que stats.sql (personas distintas)
  z record;
  v_fecha date;
  v_entradas integer;
  v_salidas integer;
  v_cerradas integer;
  v_perm_personas integer;
  v_perm double precision;
  v_pico integer;
begin
  for z in select * from public.zonas loop
    v_fecha := (now() at time zone z.timezone)::date - 1;

    select count(*)::int into v_entradas
    from public.sesiones
    where zona_id = z.id
      and (entrada_at at time zone z.timezone)::date = v_fecha;

    select count(*)::int into v_salidas
    from public.sesiones
    where zona_id = z.id
      and salida_at is not null
      and (salida_at at time zone z.timezone)::date = v_fecha;

    -- Columna sesiones_cerradas: cuenta todos los cierres (usuario + auto).
    select count(*)::int into v_cerradas
    from public.sesiones
    where zona_id = z.id
      and salida_at is not null
      and (entrada_at at time zone z.timezone)::date = v_fecha;

    -- Permanencia: solo cierres 'usuario' y k-anonimato por personas distintas de ese conjunto.
    select count(distinct user_id)::int,
           avg(extract(epoch from (salida_at - entrada_at)))::double precision
      into v_perm_personas, v_perm
    from public.sesiones
    where zona_id = z.id
      and salida_at is not null
      and cierre = 'usuario'
      and (entrada_at at time zone z.timezone)::date = v_fecha;

    -- k-anonimato: con menos de 5 personas distintas no se publica la permanencia (NULL, no 0).
    -- resumen_diario es legible por anon/authenticated, así que un promedio sobre 1..4
    -- personas podría describir la jornada de alguien concreto. Se cuenta por persona, no por
    -- sesión: varias sesiones del mismo día son la misma persona.
    if v_perm_personas is null or v_perm_personas < c_k_anonimato then
      v_perm := null;
    end if;

    select coalesce(max(cantidad), 0)::int into v_pico
    from public.snapshots_ocupacion
    where zona_id = z.id
      and (ts at time zone z.timezone)::date = v_fecha;

    insert into public.resumen_diario
      (zona_id, fecha, entradas, salidas, sesiones_cerradas, permanencia_prom_seg, pico)
    values
      (z.id, v_fecha, v_entradas, v_salidas, v_cerradas, v_perm, v_pico)
    on conflict (zona_id, fecha) do update set
      entradas = excluded.entradas,
      salidas = excluded.salidas,
      sesiones_cerradas = excluded.sesiones_cerradas,
      permanencia_prom_seg = excluded.permanencia_prom_seg,
      pico = excluded.pico;
  end loop;
end;
$$;
revoke execute on function public.cron_resumen_diario() from public, anon, authenticated;

-- Diario: retención de 90 días para datos crudos (Ley 21.719). Los agregados se conservan.
create or replace function public.cron_retencion()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  delete from public.eventos_scan
  where ts < now() - interval '90 days';

  delete from public.sesiones
  where salida_at is not null
    and salida_at < now() - interval '90 days';
end;
$$;
revoke execute on function public.cron_retencion() from public, anon, authenticated;

-- Programación idempotente. Si pg_cron no está habilitado, avisa y no falla.
do $$
begin
  if to_regclass('cron.job') is null then
    raise notice 'pg_cron no está habilitado. Habilítalo en Dashboard > Database > Extensions y vuelve a ejecutar esta migración.';
    return;
  end if;

  perform cron.unschedule(jobid)
  from cron.job
  where jobname in ('coworkflow_snapshot', 'coworkflow_cierre_auto',
                    'coworkflow_resumen_diario', 'coworkflow_retencion');

  perform cron.schedule('coworkflow_snapshot',       '*/5 * * * *',  'select public.cron_snapshot();');
  perform cron.schedule('coworkflow_cierre_auto',    '*/15 * * * *', 'select public.cron_cierre_auto();');
  perform cron.schedule('coworkflow_resumen_diario', '10 5 * * *',   'select public.cron_resumen_diario();');
  perform cron.schedule('coworkflow_retencion',      '0 6 * * *',    'select public.cron_retencion();');
end $$;

