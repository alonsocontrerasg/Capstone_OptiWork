-- ============================================================
-- CoworkFlow · Etapa 5 · Migración 9
-- Propósito: agregados de ocupación para el dashboard público.
--   · ocupacion_por_franja(zona, 7|30) → promedio por día de la semana × hora local,
--     sobre días civiles completos y solo horas dentro del horario de la zona.
--   · ocupacion_hoy(zona) → snapshots del día local actual (máx. 300 filas: 25 h × 12 bins).
--   · Devuelven SOLO datos de snapshots_ocupacion (conteos ya agregados a 5 min): ni
--     user_id ni sesiones.
--   · SECURITY DEFINER + search_path fijo; EXECUTE solo anon/authenticated.
-- Requiere: rol postgres y roles anon/authenticated/service_role (Supabase). Idempotente.
-- ============================================================

-- Promedio de ocupación por (día de la semana ISO, hora local) en la zona.
-- p_dias solo admite 7 o 30; cualquier otro valor devuelve el conjunto vacío.
create or replace function public.ocupacion_por_franja(
  p_zona_id uuid,
  p_dias integer
)
returns table (
  dow integer,            -- ISO 8601: 1 = lunes … 7 = domingo (hora local de la zona)
  hora integer,           -- 0..23, hora local de la zona
  promedio double precision,
  muestras bigint
)
language plpgsql
security definer
set search_path = public, pg_temp
stable
as $$
declare
  c_dias_permitidos constant integer[] := array[7, 30];
  v_timezone    text;
  v_apertura    time;
  v_cierre      time;
  v_ahora_local timestamp;
  v_desde       timestamptz;
  v_hasta       timestamptz;
begin
  -- Lista cerrada de ventanas: el dashboard no puede pedir rangos arbitrarios.
  if p_zona_id is null or p_dias is null or not (p_dias = any (c_dias_permitidos)) then
    return;
  end if;

  select z.timezone, z.hora_apertura, z.hora_cierre
    into v_timezone, v_apertura, v_cierre
  from public.zonas z
  where z.id = p_zona_id;

  if v_timezone is null then
    return;  -- zona inexistente
  end if;

  -- Días civiles completos de la zona, terminando en la medianoche local de hoy.
  -- Se resta sobre el reloj local (timestamp) y recién después se vuelve a timestamptz:
  -- así el cálculo atraviesa los cambios de horario de verano sin correrse un día.
  v_ahora_local := now() at time zone v_timezone;
  v_hasta := date_trunc('day', v_ahora_local) at time zone v_timezone;
  v_desde := date_trunc('day', v_ahora_local - make_interval(days => p_dias))
             at time zone v_timezone;

  return query
  select
    extract(isodow from (s.ts at time zone v_timezone))::integer,
    extract(hour   from (s.ts at time zone v_timezone))::integer,
    avg(s.cantidad)::double precision,
    count(*)::bigint
  from public.snapshots_ocupacion s
  where s.zona_id = p_zona_id
    and s.ts >= v_desde
    and s.ts < v_hasta
    -- Solo horas en que la zona está abierta (zonas_horario_orden: apertura < cierre).
    and (s.ts at time zone v_timezone)::time >= v_apertura
    and (s.ts at time zone v_timezone)::time <  v_cierre
  group by 1, 2
  order by 1, 2;
end;
$$;

comment on function public.ocupacion_por_franja(uuid, integer) is
  'Agregado público de snapshots por día ISO (1=lunes) y hora local de la zona. p_dias solo 7 o 30. Sin PII.';

-- Snapshots del día local actual (máx. 300 = 25 h × 12 bins de 5 min). Un día normal tiene
-- 288; el día de 25 h por DST necesita 300, así que el tope cubre ambos sin recortar.
create or replace function public.ocupacion_hoy(p_zona_id uuid)
returns table (
  ts timestamptz,
  cantidad integer
)
language plpgsql
security definer
set search_path = public, pg_temp
stable
as $$
declare
  v_timezone text;
  v_desde    timestamptz;
  v_hasta    timestamptz;
begin
  if p_zona_id is null then
    return;
  end if;

  select z.timezone into v_timezone from public.zonas z where z.id = p_zona_id;
  if v_timezone is null then
    return;
  end if;

  -- [medianoche local de hoy, medianoche local del día siguiente). El límite superior se
  -- calcula sobre el reloj local para que los días de 23/25 h por DST queden completos.
  v_desde := date_trunc('day', now() at time zone v_timezone) at time zone v_timezone;
  v_hasta := date_trunc('day', (now() at time zone v_timezone) + interval '1 day')
             at time zone v_timezone;

  return query
  select s.ts, s.cantidad
  from public.snapshots_ocupacion s
  where s.zona_id = p_zona_id
    and s.ts >= v_desde
    and s.ts < v_hasta
  order by s.ts
  limit 300;
end;
$$;

comment on function public.ocupacion_hoy(uuid) is
  'Serie de snapshots del día local actual de la zona (máx. 300 filas, día de 25 h por DST). Sin PII.';

-- El dashboard público es anónimo: solo estas dos funciones quedan invocables por la API.
revoke execute on function public.ocupacion_por_franja(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.ocupacion_por_franja(uuid, integer)
  to anon, authenticated;

revoke execute on function public.ocupacion_hoy(uuid)
  from public, anon, authenticated;
grant execute on function public.ocupacion_hoy(uuid)
  to anon, authenticated;

-- ------------------------------------------------------------
-- Simulación local (Etapa 6) — reconciliación del contador
-- ------------------------------------------------------------
-- `refrescar_ocupacion(uuid)` se revocó de PUBLIC/anon/authenticated en la migración 3.
-- service_role ya tiene EXECUTE por privilegios por defecto de Supabase; verificado con
-- has_function_privilege el 2026-11-11. Esta migración no modifica ese privilegio.
-- La simulación corre solo en local con service_role (S-07) y necesita reconciliar
-- `ocupacion_actual` después de insertar sesiones históricas; el trigger de `sesiones` ya
-- la recalcula, pero llamarla explícitamente deja el contador determinista al final.
-- No se concede a anon/authenticated: la API pública no puede invocarla.
