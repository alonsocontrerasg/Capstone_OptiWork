-- ============================================================
-- CoworkFlow · Etapa 3 · Migración 8/8
-- Propósito: (a) nuevo resultado 'sin_consentimiento'; (b) RPC registrar_consentimiento()
--            para guardar la aceptación del aviso (Ley 21.719); (c) registrar_scan()
--            redefinida con un gate de consentimiento antes de cualquier escritura.
-- Requiere: rol postgres (SQL Editor de Supabase).
-- ============================================================

-- ⚠️⚠️  EJECUTAR ESTE BLOQUE SOLO, ANTES QUE EL RESTO DEL ARCHIVO  ⚠️⚠️
--
-- Postgres no permite USAR un valor recién agregado a un enum dentro de la misma
-- transacción en la que se agrega ("unsafe use of new value of enum type"). El SQL
-- Editor puede envolver todo el script en una transacción, así que el orden es:
--
--   1) Selecciona y ejecuta SOLO el statement de abajo (una vez).
--   2) Después ejecuta el resto de este archivo.
--
-- Es idempotente: si ya lo ejecutaste, volver a correrlo no hace nada.
alter type public.resultado_scan add value if not exists 'sin_consentimiento';


-- ------------------------------------------------------------
-- registrar_consentimiento(p_version): guarda la aceptación del aviso de privacidad.
-- No recibe user_id: se toma de auth.uid() (no se puede suplantar).
-- Sobre la fecha: el aviso se versiona (p_version). Si la persona acepta la MISMA
-- versión otra vez, se conserva la fecha original (es la evidencia); si acepta una
-- versión nueva, se reemplaza la fecha porque es un consentimiento distinto.
-- ------------------------------------------------------------
create or replace function public.registrar_consentimiento(p_version integer)
returns timestamptz
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_ts  timestamptz := now();
begin
  if v_uid is null then
    raise exception 'Se requiere una sesión para registrar el consentimiento'
      using errcode = '42501';
  end if;

  -- La versión llega desde el borde (zod); acá se repite el control por defensa.
  if p_version is null or p_version < 1 then
    raise exception 'Versión de consentimiento inválida'
      using errcode = '22023';
  end if;

  update public.profiles
     set consentimiento_at = case
           when consentimiento_version is distinct from p_version then v_ts
           else coalesce(consentimiento_at, v_ts)
         end,
         consentimiento_version = p_version
   where id = v_uid;

  if not found then
    -- No debería ocurrir: el trigger on_auth_user_created crea la fila.
    raise exception 'Perfil inexistente; vuelve a iniciar sesión'
      using errcode = 'P0002';
  end if;

  return v_ts;
end;
$$;
revoke execute on function public.registrar_consentimiento(integer) from public, anon, authenticated;
grant execute on function public.registrar_consentimiento(integer) to authenticated;


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

  -- 0b) Consentimiento (Ley 21.719): nadie sin consentimiento_at registra entrada/salida.
  --     Es un gate pre-scan (igual que no_autenticado): no escribe en eventos_scan.
  if not exists (
    select 1 from public.profiles
    where id = v_uid and consentimiento_at is not null
  ) then
    return 'sin_consentimiento'::public.resultado_scan;
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
  --    Se comparan los DIGEST sha256 de ambas firmas (bytea de 32 bytes, longitud fija) en
  --    lugar del texto hex: la comparación no depende de la longitud del texto recibido ni
  --    hace corto-circuito por tamaño. `is distinct from` mantiene el fallo cerrado ante NULL.
  v_firma_esp := encode(extensions.hmac(v_payload, v_secreto, 'sha256'), 'hex');
  if extensions.digest(v_firma, 'sha256') is distinct from extensions.digest(v_firma_esp, 'sha256') then
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
    -- Solo la sesión abierta DE ESTA zona: un QR de otra zona no puede cerrarla.
    select * into v_sesion
    from public.sesiones
    where user_id = v_uid
      and zona_id = v_zona_id
      and salida_at is null
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
