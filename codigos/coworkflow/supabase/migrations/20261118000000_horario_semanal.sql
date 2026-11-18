-- ============================================================
-- CoworkFlow · Etapa 6b · Migración 10
-- Propósito: horario semanal por zona (lunes..domingo) con regla de compatibilidad
--            para zonas sin filas (siguen usando el horario único de zonas).
--   · zona_abierta_en(uuid, timestamptz) resuelve por día de la semana local
--     (ISO 8601, igual que extract(isodow)); zona_abierta(uuid) pasa a ser su
--     wrapper con now() y conserva firma, volatilidad y grants.
--   · ocupacion_por_franja compara cada snapshot con el horario de SU día.
--     ocupacion_hoy NO cambia (no filtra por horario; el frontend recorta con
--     horarioDelDia de src/lib/dominio/tiempo.ts).
-- Requiere: migraciones 1..9 aplicadas. Idempotente.
-- ============================================================

-- ------------------------------------------------------------
-- 1) horarios_zona: horario semanal por zona.
--    dia_semana ISO 8601 (1 = lunes … 7 = domingo), igual que extract(isodow).
--    Un día SIN fila = cerrado; una zona SIN NINGUNA fila = horario único de
--    zonas.hora_apertura/hora_cierre (compatibilidad con zonas ya existentes).
-- ------------------------------------------------------------
create table if not exists public.horarios_zona (
  zona_id    uuid not null references public.zonas(id) on delete cascade,
  dia_semana smallint not null check (dia_semana between 1 and 7),
  apertura   time not null,
  cierre     time not null,
  constraint horarios_zona_orden check (apertura < cierre),
  primary key (zona_id, dia_semana)
);

comment on table public.horarios_zona is
  'Horario semanal por zona (dia_semana ISO 8601: 1=lunes..7=domingo). Día sin fila = cerrado; zona sin ninguna fila = horario único de zonas.';

alter table public.horarios_zona enable row level security;

-- Lectura pública (aforo/horario no son datos personales), igual que zonas.
drop policy if exists horarios_zona_select_publico on public.horarios_zona;
create policy horarios_zona_select_publico on public.horarios_zona
  for select to anon, authenticated
  using (true);

-- Escritura solo admin (misma política que zonas).
drop policy if exists horarios_zona_insert_admin on public.horarios_zona;
create policy horarios_zona_insert_admin on public.horarios_zona
  for insert to authenticated
  with check (public.es_admin());

drop policy if exists horarios_zona_update_admin on public.horarios_zona;
create policy horarios_zona_update_admin on public.horarios_zona
  for update to authenticated
  using (public.es_admin())
  with check (public.es_admin());

drop policy if exists horarios_zona_delete_admin on public.horarios_zona;
create policy horarios_zona_delete_admin on public.horarios_zona
  for delete to authenticated
  using (public.es_admin());

-- Privilegios de tabla (mismo patrón que zonas): anon solo lee; authenticated lee
-- y escribe bajo RLS admin; nunca TRUNCATE.
revoke all on public.horarios_zona from anon, authenticated;
grant select on public.horarios_zona to anon, authenticated;
grant insert, update, delete on public.horarios_zona to authenticated;


-- ------------------------------------------------------------
-- 2) zona_abierta_en(p_zona_id, p_instante): cuerpo de la zona_abierta vigente
--    (migración 5) con now() parametrizado + resolución del horario semanal.
--    Sin filas semanales se comporta EXACTAMENTE como hoy (horario único).
--    SECURITY DEFINER + search_path fijo + sin EXECUTE para la API (S-20).
-- ------------------------------------------------------------
create or replace function public.zona_abierta_en(
  p_zona_id uuid,
  p_instante timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
stable
as $$
declare
  z public.zonas%rowtype;
  v_hora_local time;
  v_dow        smallint;
  v_apertura   time;
  v_cierre     time;
begin
  select * into z from public.zonas where id = p_zona_id;
  if not found or not z.activa or p_instante is null then
    return false;
  end if;
  -- zonas_horario_orden garantiza hora_apertura < hora_cierre (no cruza medianoche).
  v_hora_local := (p_instante at time zone z.timezone)::time;

  -- Horario semanal (Etapa 6b): si la zona tiene filas, manda el día ISO local.
  -- Un día sin fila = cerrado. Sin ninguna fila se usa el horario único (compatibilidad).
  if exists (select 1 from public.horarios_zona h where h.zona_id = p_zona_id) then
    v_dow := extract(isodow from (p_instante at time zone z.timezone))::smallint;
    select h.apertura, h.cierre
      into v_apertura, v_cierre
    from public.horarios_zona h
    where h.zona_id = p_zona_id
      and h.dia_semana = v_dow;
    if not found then
      return false;
    end if;
  else
    v_apertura := z.hora_apertura;
    v_cierre   := z.hora_cierre;
  end if;

  return v_hora_local >= v_apertura and v_hora_local < v_cierre;
end;
$$;
revoke execute on function public.zona_abierta_en(uuid, timestamptz)
  from public, anon, authenticated;

-- Indica si la zona está activa y dentro de su horario local (usada por cron y scan).
-- Wrapper: mantiene firma, volatilidad y grants; delega en zona_abierta_en(now()).
create or replace function public.zona_abierta(p_zona_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
stable
as $$
begin
  return public.zona_abierta_en(p_zona_id, now());
end;
$$;
revoke execute on function public.zona_abierta(uuid) from public, anon, authenticated;

-- ------------------------------------------------------------
-- 3) ocupacion_por_franja: cuerpo vigente (migración 9) con un único cambio:
--    el filtro de horario pasa a resolverse por el día ISO de CADA snapshot.
--    Sin filas semanales se comporta EXACTAMENTE como hoy (horario único).
--    Misma firma, mismo tope ≤168 filas, mismos grants (anon+authenticated).
-- ------------------------------------------------------------

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
  v_semanal     boolean;
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

  -- ¿La zona tiene horario semanal? Un día sin fila cuenta como cerrado.
  select exists (
    select 1 from public.horarios_zona h where h.zona_id = p_zona_id
  ) into v_semanal;

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
    -- Solo horas en que la zona está abierta (apertura < cierre, sin cruzar medianoche):
    -- sin horario semanal, el horario único de zonas; con horario semanal, el de SU día
    -- (un día sin fila no tiene snapshots válidos).
    and (
      (not v_semanal
        and (s.ts at time zone v_timezone)::time >= v_apertura
        and (s.ts at time zone v_timezone)::time <  v_cierre)
      or exists (
        select 1 from public.horarios_zona h
        where h.zona_id = p_zona_id
          and h.dia_semana = extract(isodow from (s.ts at time zone v_timezone))::smallint
          and (s.ts at time zone v_timezone)::time >= h.apertura
          and (s.ts at time zone v_timezone)::time <  h.cierre
      )
    )
  group by 1, 2
  order by 1, 2;
end;
$$;

comment on function public.ocupacion_por_franja(uuid, integer) is
  'Agregado público de snapshots por día ISO (1=lunes) y hora local de la zona. p_dias solo 7 o 30. Sin PII.';

-- El dashboard público es anónimo: solo estas dos funciones quedan invocables por la API.
revoke execute on function public.ocupacion_por_franja(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.ocupacion_por_franja(uuid, integer)
  to anon, authenticated;

-- PostgREST debe recargar el esquema para ver public.horarios_zona (embed de zonas).
notify pgrst, 'reload schema';

