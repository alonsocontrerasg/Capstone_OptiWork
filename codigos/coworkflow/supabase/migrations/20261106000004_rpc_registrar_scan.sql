-- ============================================================
-- CoworkFlow · Etapa 2 · Migración 5/7
-- Propósito: RPC registrar_scan(p_token) con validación HMAC, ventana
--            rotativa, cooldown, límite de intentos inválidos y reglas de
--            negocio. NO lanza excepciones de negocio: devuelve un enum.
-- Requiere: pgcrypto en el esquema `extensions` (ver migración 1).
-- ============================================================

-- Lee el secreto QR desde app_secrets (tabla inaccesible para anon/authenticated).
-- Devuelve NULL si falta: registrar_scan falla cerrado ("token_invalido").
create or replace function public.obtener_secreto_qr()
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_valor text;
begin
  select valor into v_valor from public.app_secrets where clave = 'qr_token_secret';
  return v_valor;
end;
$$;
revoke execute on function public.obtener_secreto_qr() from public, anon, authenticated;

-- Indica si la zona está activa y dentro de su horario local (usada por cron y scan).
create or replace function public.zona_abierta(p_zona_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
stable
as $$
declare
  z public.zonas%rowtype;
  v_hora_local time;
begin
  select * into z from public.zonas where id = p_zona_id;
  if not found or not z.activa then
    return false;
  end if;
  -- zonas_horario_orden garantiza hora_apertura < hora_cierre (no cruza medianoche).
  v_hora_local := (now() at time zone z.timezone)::time;
  return v_hora_local >= z.hora_apertura and v_hora_local < z.hora_cierre;
end;
$$;
revoke execute on function public.zona_abierta(uuid) from public, anon, authenticated;

-- ------------------------------------------------------------
-- registrar_scan(p_token): valida token "v1.<zona>.<modo>.<ventana>.<firma>",
-- aplica cooldown (30 s), reglas de sesión y límite de intentos inválidos.
-- No recibe user_id: se toma de auth.uid() (no se puede suplantar).
-- ------------------------------------------------------------
create or replace function public.registrar_scan(p_token text)
returns public.resultado_scan
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c_cooldown_seg      constant integer := 30;
  c_max_invalidos_min constant integer := 10;
  c_ventana_default   constant integer := 45;

  v_uid        uuid := auth.uid();
  v_token      text := btrim(coalesce(p_token, ''));
  v_secreto    text;
  v_ventana_seg integer := c_ventana_default;
  v_partes     text[];
  v_payload    text;
  v_firma      text;
  v_firma_esp  text;
  v_modo       public.tipo_scan;
  v_zona_id    uuid;
  v_ventana    bigint;
  v_ventana_act bigint;
  v_invalidos  integer;
  v_ultimo_ok  timestamptz;
  v_sesion     public.sesiones%rowtype;
begin
  -- 0) Defensa: aunque EXECUTE solo se concede a authenticated, no confiamos.
  if v_uid is null then
    return 'no_autenticado'::public.resultado_scan;
  end if;

  -- Serializa los intentos del mismo usuario (evita carreras en el 10/min y el cooldown).
  perform pg_advisory_xact_lock(hashtextextended(v_uid::text, 0));

  -- 1) Límite de intentos inválidos: 10/min. Si se supera, NO se inserta fila.
  select count(*)::int into v_invalidos
  from public.eventos_scan
  where user_id = v_uid
    and ts > now() - interval '1 minute'
    and resultado not in ('entrada_ok', 'salida_ok');

  if v_invalidos >= c_max_invalidos_min then
    return 'demasiados_intentos'::public.resultado_scan;
  end if;

  -- 2) Secreto y ventana configurable (app_secrets.qr_window_seconds opcional).
  v_secreto := public.obtener_secreto_qr();
  select case when valor ~ '^[0-9]+$' then valor::int else null end
    into v_ventana_seg
  from public.app_secrets where clave = 'qr_window_seconds';
  if v_ventana_seg is null or v_ventana_seg <= 0 then
    v_ventana_seg := c_ventana_default;
  end if;

  -- 3) Parseo del token: v1.<zona_uuid>.<entrada|salida>.<ventana>.<hmac_hex64>
  v_partes := string_to_array(v_token, '.');
  if v_secreto is null
     or array_length(v_partes, 1) is distinct from 5
     or v_partes[1] <> 'v1' then
    insert into public.eventos_scan (user_id, zona_id, tipo, resultado)
    values (v_uid, null, null, 'token_invalido');
    return 'token_invalido'::public.resultado_scan;
  end if;

  v_payload := v_partes[1] || '.' || v_partes[2] || '.' || v_partes[3] || '.' || v_partes[4];
  v_firma   := lower(v_partes[5]);

  -- 4) Verificación HMAC-SHA256 en la base (pgcrypto vive en el esquema `extensions`).
  v_firma_esp := encode(extensions.hmac(v_payload, v_secreto, 'sha256'), 'hex');
  if v_firma <> v_firma_esp then
    insert into public.eventos_scan (user_id, zona_id, tipo, resultado)
    values (v_uid, null, null, 'token_invalido');
    return 'token_invalido'::public.resultado_scan;
  end if;

  -- 5) Firma válida → el payload es confiable; extraemos zona y modo.
  begin
    v_zona_id := v_partes[2]::uuid;
    v_ventana := v_partes[4]::bigint;
    if v_partes[3] = 'entrada' then
      v_modo := 'entrada';
    elsif v_partes[3] = 'salida' then
      v_modo := 'salida';
    else
      v_modo := null;
    end if;
  exception when others then
    insert into public.eventos_scan (user_id, zona_id, tipo, resultado)
    values (v_uid, null, null, 'token_invalido');
    return 'token_invalido'::public.resultado_scan;
  end;

  if v_modo is null then
    insert into public.eventos_scan (user_id, zona_id, tipo, resultado)
    values (v_uid, v_zona_id, null, 'token_invalido');
    return 'token_invalido'::public.resultado_scan;
  end if;


  -- 6) Ventana rotativa: se acepta la actual y la anterior (tolera el retraso del escaneo).
  v_ventana_act := floor(extract(epoch from clock_timestamp()) / v_ventana_seg)::bigint;
  if v_ventana not in (v_ventana_act, v_ventana_act - 1) then
    insert into public.eventos_scan (user_id, zona_id, tipo, resultado)
    values (v_uid, v_zona_id, v_modo, 'token_expirado');
    return 'token_expirado'::public.resultado_scan;
  end if;

  -- 7) Zona activa y horario.
  if not exists (select 1 from public.zonas where id = v_zona_id and activa) then
    insert into public.eventos_scan (user_id, zona_id, tipo, resultado)
    values (v_uid, v_zona_id, v_modo, 'zona_inactiva');
    return 'zona_inactiva'::public.resultado_scan;
  end if;

  if not public.zona_abierta(v_zona_id) then
    insert into public.eventos_scan (user_id, zona_id, tipo, resultado)
    values (v_uid, v_zona_id, v_modo, 'fuera_horario');
    return 'fuera_horario'::public.resultado_scan;
  end if;

  -- 8) Cooldown: máximo 1 evento exitoso por usuario cada 30 s.
  select max(ts) into v_ultimo_ok
  from public.eventos_scan
  where user_id = v_uid and resultado in ('entrada_ok', 'salida_ok');

  if v_ultimo_ok is not null
     and v_ultimo_ok > now() - make_interval(secs => c_cooldown_seg) then
    insert into public.eventos_scan (user_id, zona_id, tipo, resultado)
    values (v_uid, v_zona_id, v_modo, 'cooldown');
    return 'cooldown'::public.resultado_scan;
  end if;

  -- 9) Reglas de negocio.
  if v_modo = 'entrada' then
    if exists (select 1 from public.sesiones where user_id = v_uid and salida_at is null) then
      insert into public.eventos_scan (user_id, zona_id, tipo, resultado)
      values (v_uid, v_zona_id, v_modo, 'sesion_ya_abierta');
      return 'sesion_ya_abierta'::public.resultado_scan;
    end if;

    begin
      insert into public.sesiones (user_id, zona_id) values (v_uid, v_zona_id);
    exception when unique_violation then
      insert into public.eventos_scan (user_id, zona_id, tipo, resultado)
      values (v_uid, v_zona_id, v_modo, 'sesion_ya_abierta');
      return 'sesion_ya_abierta'::public.resultado_scan;
    end;

    insert into public.eventos_scan (user_id, zona_id, tipo, resultado)
    values (v_uid, v_zona_id, v_modo, 'entrada_ok');
    return 'entrada_ok'::public.resultado_scan;
  else
    select * into v_sesion
    from public.sesiones
    where user_id = v_uid and salida_at is null
    for update;

    if not found then
      insert into public.eventos_scan (user_id, zona_id, tipo, resultado)
      values (v_uid, v_zona_id, v_modo, 'sin_sesion_abierta');
      return 'sin_sesion_abierta'::public.resultado_scan;
    end if;

    update public.sesiones
       set salida_at = now(), cierre = 'usuario'
     where id = v_sesion.id;

    insert into public.eventos_scan (user_id, zona_id, tipo, resultado)
    values (v_uid, v_zona_id, v_modo, 'salida_ok');
    return 'salida_ok'::public.resultado_scan;
  end if;
end;
$$;
revoke execute on function public.registrar_scan(text) from public, anon, authenticated;
grant execute on function public.registrar_scan(text) to authenticated;

