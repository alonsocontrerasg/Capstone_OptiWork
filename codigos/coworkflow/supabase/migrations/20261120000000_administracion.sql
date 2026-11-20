-- Administración: sesión revocable, rol vigente y actualización atómica del horario.
-- Requiere migraciones 1..11. No modifica sesiones ni eventos existentes.
begin;

create or replace function public.sesion_vigente()
returns boolean language sql stable security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null and exists (
    select 1 from auth.sessions s
    where s.user_id = auth.uid()
      and s.id::text = (auth.jwt() ->> 'session_id')
      and (s.not_after is null or s.not_after > now())
  );
$$;
revoke all on function public.sesion_vigente() from public, anon, authenticated;
grant execute on function public.sesion_vigente() to authenticated;

-- RLS también rechaza el JWT de un administrador cuya sesión fue revocada.
create or replace function public.es_admin()
returns boolean language sql stable security definer
set search_path = public, pg_temp
as $$
  select public.sesion_vigente() and exists (
    select 1 from public.profiles where id = auth.uid() and rol = 'admin'
  );
$$;
revoke all on function public.es_admin() from public, anon, authenticated;
grant execute on function public.es_admin() to authenticated;

create or replace function public.actualizar_configuracion_zona(
  p_zona_id uuid, p_nombre text, p_aforo_max integer,
  p_umbral_bajo integer, p_umbral_alto integer,
  p_activa boolean, p_horarios jsonb
)
returns void language plpgsql security invoker
set search_path = public, pg_temp
as $$
declare
  h jsonb;
  dias integer[] := '{}';
  dia integer;
begin
  if not public.es_admin() then
    raise exception 'Acceso denegado' using errcode = '42501';
  end if;
  if p_nombre is null or length(btrim(p_nombre)) not between 1 and 100
    or p_aforo_max is null or p_aforo_max not between 1 and 100000
    or p_umbral_bajo is null or p_umbral_bajo not between 0 and 99
    or p_umbral_alto is null or p_umbral_alto not between 1 and 100
    or p_umbral_bajo >= p_umbral_alto or p_activa is null
    or p_horarios is null or jsonb_typeof(p_horarios) <> 'array' then
    raise exception 'Configuración inválida' using errcode = '22023';
  end if;
  if jsonb_array_length(p_horarios) > 7
    or (p_activa and jsonb_array_length(p_horarios) = 0) then
    raise exception 'Horario inválido' using errcode = '22023';
  end if;
  for h in select value from jsonb_array_elements(p_horarios) loop
    if jsonb_typeof(h) <> 'object'
      or coalesce(h->>'dia_semana', '') !~ '^[1-7]$'
      or coalesce(h->>'apertura', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
      or coalesce(h->>'cierre', '') !~ '^(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)$' then
      raise exception 'Horario inválido' using errcode = '22023';
    end if;
    dia := (h->>'dia_semana')::integer;
    if dia = any(dias) or (h->>'apertura')::time >= (h->>'cierre')::time then
      raise exception 'Horario inválido' using errcode = '22023';
    end if;
    dias := array_append(dias, dia);
  end loop;
  -- Serializa guardados de la misma zona y mantiene configuración/semana en una transacción.
  perform 1 from public.zonas where id = p_zona_id for update;
  if not found then
    raise exception 'Zona inexistente' using errcode = 'P0002';
  end if;
  update public.zonas set nombre = btrim(p_nombre), aforo_max = p_aforo_max,
    umbral_bajo = p_umbral_bajo, umbral_alto = p_umbral_alto, activa = p_activa
  where id = p_zona_id;
  delete from public.horarios_zona where zona_id = p_zona_id;
  insert into public.horarios_zona(zona_id, dia_semana, apertura, cierre)
    select p_zona_id, (value->>'dia_semana')::smallint,
      (value->>'apertura')::time, (value->>'cierre')::time
    from jsonb_array_elements(p_horarios);
end;
$$;
revoke all on function public.actualizar_configuracion_zona(uuid,text,integer,integer,integer,boolean,jsonb)
  from public, anon, authenticated;
grant execute on function public.actualizar_configuracion_zona(uuid,text,integer,integer,integer,boolean,jsonb)
  to authenticated;

commit;
