-- ============================================================
-- CoworkFlow · Etapa 2 · Migración 6/7
-- Propósito: funciones de estadísticas públicas con k-anonimato por personas distintas
--            y rango acotado en días calendario de la zona.
--   · p_desde/p_hasta se alinean a medianoche en la zona horaria de la zona:
--       date_trunc('day', x at time zone z.timezone) at time zone z.timezone
--     Así «un día» es el día calendario de la zona y no depende de la hora de la llamada.
--   · Solo aceptan rangos alineados de 1..90 días (misma ventana que la retención de crudos).
--     El rango es semiabierto [día(p_desde), día(p_hasta)): para consultar un solo día hay que
--     pasar el límite del día siguiente; si ambos extremos caen el mismo día calendario el
--     rango queda vacío y la función devuelve NULL (no una celda de 0 minutos).
--   · k-anonimato: se exige count(distinct user_id) >= 5 sobre el MISMO conjunto que se usa
--     para el cálculo (personas distintas, no sesiones). Una sola persona con muchas sesiones
--     no debe «desbloquear» una celda.
--   · El umbral k=5 es el mismo que usa cron_resumen_diario() para
--     resumen_diario.permanencia_prom_seg (constante c_k_anonimato en ambos archivos).
--   · Límite conocido: el k-anonimato no elimina los ataques por diferencia entre rangos
--     superpuestos (ver docs/decisiones-seguridad.md, S-23).
-- Requiere: rol postgres. Idempotente.
-- ============================================================

-- Permanencia promedio (segundos) de sesiones cerradas por el usuario en la zona/rango.
-- Solo cierre = 'usuario': un cierre 'auto' fija salida_at a un valor administrativo
-- (tope de 8 h o fin de horario), así que no representa una permanencia real.
create or replace function public.permanencia_promedio(
  p_zona_id uuid,
  p_desde timestamptz,
  p_hasta timestamptz
)
returns double precision
language plpgsql
security definer
set search_path = public, pg_temp
stable
as $$
declare
  c_k_anonimato constant integer := 5;   -- personas distintas mínimas (mismo umbral que el cron)
  c_dias_max    constant integer := 90;  -- ventana de retención de datos crudos
  v_timezone text;
  v_desde    timestamptz;
  v_hasta    timestamptz;
  v_personas integer;
  v_promedio double precision;
begin
  if p_zona_id is null or p_desde is null or p_hasta is null then
    return null;
  end if;

  select z.timezone into v_timezone from public.zonas z where z.id = p_zona_id;
  if v_timezone is null then
    return null;  -- zona inexistente: no hay nada que promediar
  end if;

  -- Alineación a medianoche local de la zona (día calendario, no UTC).
  v_desde := date_trunc('day', p_desde at time zone v_timezone) at time zone v_timezone;
  v_hasta := date_trunc('day', p_hasta at time zone v_timezone) at time zone v_timezone;

  -- Rango permitido: 1..90 días completos. Nada fuera de eso se responde.
  if v_hasta <= v_desde
     or (v_hasta - v_desde) > make_interval(days => c_dias_max) then
    return null;
  end if;

  select count(distinct s.user_id)::int,
         avg(extract(epoch from (s.salida_at - s.entrada_at)))::double precision
    into v_personas, v_promedio
  from public.sesiones s
  where s.zona_id = p_zona_id
    and s.salida_at is not null
    and s.cierre = 'usuario'
    and s.entrada_at >= v_desde
    and s.entrada_at < v_hasta;

  -- k-anonimato sobre las personas distintas del conjunto promediado, no sobre el
  -- número de sesiones: 20 sesiones de una misma persona siguen describiendo a una persona.
  if v_personas is null or v_personas < c_k_anonimato then
    return null;
  end if;

  return v_promedio;
end;
$$;
revoke execute on function public.permanencia_promedio(uuid, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.permanencia_promedio(uuid, timestamptz, timestamptz) to anon, authenticated;

-- Cantidad de personas distintas (user_id seudónimo) con sesiones en la zona/rango.
create or replace function public.personas_distintas(
  p_zona_id uuid,
  p_desde timestamptz,
  p_hasta timestamptz
)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
stable
as $$
declare
  c_k_anonimato constant integer := 5;   -- personas distintas mínimas (mismo umbral que el cron)
  c_dias_max    constant integer := 90;  -- ventana de retención de datos crudos
  v_timezone text;
  v_desde    timestamptz;
  v_hasta    timestamptz;
  v_personas bigint;
begin
  if p_zona_id is null or p_desde is null or p_hasta is null then
    return null;
  end if;

  select z.timezone into v_timezone from public.zonas z where z.id = p_zona_id;
  if v_timezone is null then
    return null;
  end if;

  -- Alineación a medianoche local de la zona (día calendario, no UTC).
  v_desde := date_trunc('day', p_desde at time zone v_timezone) at time zone v_timezone;
  v_hasta := date_trunc('day', p_hasta at time zone v_timezone) at time zone v_timezone;

  -- Rango permitido: 1..90 días completos.
  if v_hasta <= v_desde
     or (v_hasta - v_desde) > make_interval(days => c_dias_max) then
    return null;
  end if;

  select count(distinct s.user_id)
    into v_personas
  from public.sesiones s
  where s.zona_id = p_zona_id
    and s.entrada_at >= v_desde
    and s.entrada_at < v_hasta;

  -- El valor que se devuelve ES el conteo de personas: si no llega a k, no se publica.
  if v_personas is null or v_personas < c_k_anonimato then
    return null;  -- k-anonimato: menos de 5 personas distintas no se publica
  end if;

  return v_personas;
end;
$$;
revoke execute on function public.personas_distintas(uuid, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.personas_distintas(uuid, timestamptz, timestamptz) to anon, authenticated;
