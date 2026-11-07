-- ============================================================
-- CoworkFlow · Etapa 2 · Migración 6/7
-- Propósito: funciones de estadísticas públicas con k-anonimato y rango acotado.
--   · Devuelven NULL si hay menos de 5 sesiones en el rango (privacidad).
--   · Solo aceptan rangos de 1..93 días para evitar escaneos masivos.
-- Requiere: rol postgres. Idempotente.
-- ============================================================

-- Permanencia promedio (segundos) de sesiones cerradas en la zona/rango.
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
  v_sesiones integer;
  v_promedio double precision;
begin
  if p_desde is null or p_hasta is null
     or p_hasta <= p_desde
     or (p_hasta - p_desde) < interval '1 day'
     or (p_hasta - p_desde) > interval '93 days' then
    return null;
  end if;

  select count(*)::int,
         avg(extract(epoch from (salida_at - entrada_at)))::double precision
    into v_sesiones, v_promedio
  from public.sesiones
  where zona_id = p_zona_id
    and salida_at is not null
    and entrada_at >= p_desde
    and entrada_at < p_hasta;

  if v_sesiones is null or v_sesiones < 5 then
    return null;  -- k-anonimato: menos de 5 sesiones no se publica
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
  v_sesiones integer;
  v_personas bigint;
begin
  if p_desde is null or p_hasta is null
     or p_hasta <= p_desde
     or (p_hasta - p_desde) < interval '1 day'
     or (p_hasta - p_desde) > interval '93 days' then
    return null;
  end if;

  select count(*)::int,
         count(distinct user_id)
    into v_sesiones, v_personas
  from public.sesiones
  where zona_id = p_zona_id
    and entrada_at >= p_desde
    and entrada_at < p_hasta;

  if v_sesiones is null or v_sesiones < 5 then
    return null;  -- k-anonimato: menos de 5 sesiones no se publica
  end if;

  return v_personas;
end;
$$;
revoke execute on function public.personas_distintas(uuid, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.personas_distintas(uuid, timestamptz, timestamptz) to anon, authenticated;
