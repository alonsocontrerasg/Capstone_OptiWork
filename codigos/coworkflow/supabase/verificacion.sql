-- ============================================================
-- CoworkFlow · verificacion.sql — Etapa 2
-- Ejecutar en el SQL Editor DESPUÉS de aplicar las 8 migraciones y el seed.
-- Corre como postgres. Si todo está bien termina con:
--   NOTICE: Verificación OK ...
-- Si algo falla, lanza una excepción listando los problemas encontrados.
-- ============================================================
do $$
declare
  v_errores  text[] := '{}';
  v_tabla    text;
  v_firma    text;
  v_nombre   text;
  v_oid      oid;
  v_total    bigint;
  v_definer  boolean;
  v_proconfig text[];
  v_anon     boolean;
  v_auth     boolean;
  v_rel      record;
  v_priv     text;
  v_proc     record;
  v_zona     uuid;
  v_acl      aclitem[];
  -- Lista blanca de funciones que pueden tener EXECUTE para anon y/o authenticated.
  -- Quién exactamente (solo authenticated vs anon+authenticated) lo valida el bloque 10).
  v_permitidas oid[] := array[
    to_regprocedure('public.registrar_scan(text)'),
    to_regprocedure('public.registrar_consentimiento(integer)'),
    to_regprocedure('public.es_admin()'),
    to_regprocedure('public.permanencia_promedio(uuid,timestamptz,timestamptz)'),
    to_regprocedure('public.personas_distintas(uuid,timestamptz,timestamptz)'),
    to_regprocedure('public.ocupacion_por_franja(uuid,integer)'),
    to_regprocedure('public.ocupacion_hoy(uuid)')
  ];
begin
  -- 1) RLS activa en las 8 tablas
  foreach v_tabla in array array[
    'profiles','zonas','sesiones','eventos_scan',
    'ocupacion_actual','snapshots_ocupacion','resumen_diario','app_secrets'
  ] loop
    if not exists (
      select 1 from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = v_tabla and c.relrowsecurity
    ) then
      v_errores := v_errores || format('RLS no activa en public.%s', v_tabla);
    end if;
  end loop;

  -- 2) Sin políticas de escritura en tablas que solo escriben RPC/trigger
  select count(*) into v_total
  from pg_policies
  where schemaname = 'public'
    and tablename in ('profiles','sesiones','eventos_scan','ocupacion_actual',
                      'snapshots_ocupacion','resumen_diario','app_secrets')
    and cmd in ('INSERT','UPDATE','DELETE','ALL');
  if v_total > 0 then
    v_errores := v_errores || format('%s políticas de escritura inesperadas (solo zonas debe tener)', v_total);
  end if;

  -- 3) Políticas de lectura esperadas presentes
  foreach v_tabla in array array[
    'profiles','zonas','sesiones','eventos_scan',
    'ocupacion_actual','snapshots_ocupacion','resumen_diario'
  ] loop
    if not exists (select 1 from pg_policies
                   where schemaname = 'public' and tablename = v_tabla and cmd = 'SELECT') then
      v_errores := v_errores || format('Falta política SELECT en public.%s', v_tabla);
    end if;
  end loop;

  -- 4) zonas sí debe tener política de escritura (admin)
  if not exists (select 1 from pg_policies
                 where schemaname = 'public' and tablename = 'zonas' and cmd = 'INSERT') then
    v_errores := v_errores || 'Falta política INSERT (admin) en zonas'::text;
  end if;

  -- 5) profiles: sin privilegio UPDATE sobre "rol" para anon/authenticated
  if has_column_privilege('anon', 'public.profiles', 'rol', 'UPDATE') then
    v_errores := v_errores || 'anon tiene UPDATE sobre profiles.rol'::text;
  end if;
  if has_column_privilege('authenticated', 'public.profiles', 'rol', 'UPDATE') then
    v_errores := v_errores || 'authenticated tiene UPDATE sobre profiles.rol'::text;
  end if;

  -- 5b) Privilegios de escritura de tabla: anon no escribe NUNCA (ni TRUNCATE) y
  --     authenticated solo escribe en zonas (insert/update/delete), nunca TRUNCATE.
  --     Se recorren todas las tablas reales de public para que también cubra tablas futuras.
  for v_rel in
    select c.oid, c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p', 'm', 'f')
    order by c.relname
  loop
    foreach v_priv in array array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] loop
      if has_table_privilege('anon', v_rel.oid, v_priv) then
        v_errores := v_errores || format('anon tiene %s sobre public.%s', v_priv, v_rel.relname);
      end if;
      if v_priv <> 'TRUNCATE'
         and v_rel.relname <> 'zonas'
         and has_table_privilege('authenticated', v_rel.oid, v_priv) then
        v_errores := v_errores || format('authenticated tiene %s sobre public.%s (solo zonas admite escritura)', v_priv, v_rel.relname);
      end if;
    end loop;

    if has_table_privilege('authenticated', v_rel.oid, 'TRUNCATE') then
      v_errores := v_errores || format('authenticated tiene TRUNCATE sobre public.%s', v_rel.relname);
    end if;
  end loop;

  -- 6) Triggers clave presentes
  if not exists (
    select 1 from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'profiles'
      and t.tgname = 'trg_proteger_rol' and not t.tgisinternal
  ) then
    v_errores := v_errores || 'Falta el trigger trg_proteger_rol en profiles'::text;
  end if;
  if not exists (
    select 1 from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'zonas'
      and t.tgname = 'trg_validar_timezone_zona' and not t.tgisinternal
  ) then
    v_errores := v_errores || 'Falta el trigger trg_validar_timezone_zona en zonas'::text;
  end if;

  -- Alta de perfil al registrarse: sin este trigger nadie tendría fila en profiles.
  if not exists (
    select 1 from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'auth' and c.relname = 'users'
      and t.tgname = 'on_auth_user_created' and not t.tgisinternal
  ) then
    v_errores := v_errores || 'Falta el trigger on_auth_user_created en auth.users'::text;
  end if;

  -- Contador de ocupación: se mantiene en la misma transacción que cada check-in/check-out.
  if not exists (
    select 1 from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'sesiones'
      and t.tgname = 'trg_sesiones_actualizar_ocupacion' and not t.tgisinternal
  ) then
    v_errores := v_errores || 'Falta el trigger trg_sesiones_actualizar_ocupacion en sesiones'::text;
  end if;

  -- Toda zona nueva debe nacer con su fila en ocupacion_actual.
  if not exists (
    select 1 from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'zonas'
      and t.tgname = 'trg_zonas_crear_ocupacion' and not t.tgisinternal
  ) then
    v_errores := v_errores || 'Falta el trigger trg_zonas_crear_ocupacion en zonas'::text;
  end if;

  -- 7) pgcrypto en el esquema extensions
  if not exists (
    select 1 from pg_extension e join pg_namespace n on n.oid = e.extnamespace
    where e.extname = 'pgcrypto' and n.nspname = 'extensions'
  ) then
    v_errores := v_errores || 'pgcrypto no está instalado en el esquema extensions'::text;
  end if;

  -- 8) app_secrets inaccesible para anon/authenticated
  if has_table_privilege('anon', 'public.app_secrets', 'SELECT') then
    v_errores := v_errores || 'anon puede leer app_secrets'::text;
  end if;
  if has_table_privilege('authenticated', 'public.app_secrets', 'SELECT') then
    v_errores := v_errores || 'authenticated puede leer app_secrets'::text;
  end if;

  -- 9) Secreto qr_token_secret >= 64 caracteres (openssl rand -hex 32 = 32 bytes)
  select length(valor) into v_total from public.app_secrets where clave = 'qr_token_secret';
  if v_total is null then
    raise notice 'AVISO: falta insertar qr_token_secret en app_secrets (ver docs/modelo-datos.md).';
  elsif v_total < 64 then
    v_errores := v_errores || format('qr_token_secret tiene %s caracteres; usa al menos 64 (openssl rand -hex 32)', v_total);
  end if;

  -- 9b) El enum resultado_scan incluye 'sin_consentimiento' (gate de la Etapa 3).
  --     Si falta, registrar_scan() no compila o el gate no se puede devolver.
  if not exists (
    select 1
    from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typname = 'resultado_scan'
      and e.enumlabel = 'sin_consentimiento'
  ) then
    v_errores := v_errores || 'El enum resultado_scan no tiene el valor sin_consentimiento (falta la migración 8)'::text;
  end if;

  -- 10) Funciones: SECURITY DEFINER, search_path fijo y grants correctos
  foreach v_firma in array array[
    'public.handle_new_user()',
    'public.proteger_rol()',
    'public.validar_timezone_zona()',
    'public.refrescar_ocupacion(uuid)',
    'public.crear_ocupacion_inicial()',
    'public.actualizar_ocupacion()',
    'public.es_admin()',
    'public.obtener_secreto_qr()',
    'public.zona_abierta(uuid)',
    'public.registrar_scan(text)',
    'public.registrar_consentimiento(integer)',
    'public.permanencia_promedio(uuid,timestamptz,timestamptz)',
    'public.personas_distintas(uuid,timestamptz,timestamptz)',
    'public.ocupacion_por_franja(uuid,integer)',
    'public.ocupacion_hoy(uuid)',
    'public.cron_snapshot()',
    'public.cron_cierre_auto()',
    'public.cron_resumen_diario()',
    'public.cron_retencion()'
  ] loop
    v_oid := to_regprocedure(v_firma);
    if v_oid is null then
      v_errores := v_errores || format('Falta la función %s', v_firma);
      continue;
    end if;

    select p.prosecdef, p.proconfig, p.proacl
      into v_definer, v_proconfig, v_acl
    from pg_proc p where p.oid = v_oid;

    if not v_definer then
      v_errores := v_errores || format('%s no es SECURITY DEFINER', v_firma);
    end if;
    if v_proconfig is null
       or not exists (select 1 from unnest(v_proconfig) c where c like 'search_path=%') then
      v_errores := v_errores || format('%s no fija search_path', v_firma);
    end if;

    v_nombre := split_part(v_firma, '(', 1);
    v_anon := has_function_privilege('anon', v_oid, 'EXECUTE');
    v_auth := has_function_privilege('authenticated', v_oid, 'EXECUTE');

    if v_nombre in ('public.permanencia_promedio', 'public.personas_distintas',
                    'public.ocupacion_por_franja', 'public.ocupacion_hoy') then
      if not v_anon or not v_auth then
        v_errores := v_errores || format('%s debe ser ejecutable por anon y authenticated', v_firma);
      end if;

      -- Los agregados del dashboard no deben conservar el EXECUTE implícito de PUBLIC:
      -- se revoca explícitamente y solo anon/authenticated lo reciben.
      if v_nombre in ('public.ocupacion_por_franja', 'public.ocupacion_hoy') then
        if v_acl is null
           or exists (select 1 from aclexplode(v_acl) a
                      where a.grantee = 0 and a.privilege_type = 'EXECUTE') then
          v_errores := v_errores || format('%s conserva EXECUTE para PUBLIC', v_firma);
        end if;
      end if;
    elsif v_nombre in ('public.registrar_scan', 'public.registrar_consentimiento', 'public.es_admin') then
      if v_anon then
        v_errores := v_errores || format('%s NO debe ser ejecutable por anon', v_firma);
      end if;
      if not v_auth then
        v_errores := v_errores || format('%s debe ser ejecutable por authenticated', v_firma);
      end if;
    else
      if v_anon or v_auth then
        v_errores := v_errores || format('%s no debe ser invocable vía API', v_firma);
      end if;
    end if;
  end loop;

  -- 10b) Barrido de pg_proc: ninguna OTRA función de public debe tener EXECUTE para
  --      anon o authenticated (incluye grants por PUBLIC y funciones creadas a futuro).
  for v_proc in
    select p.oid, p.oid::regprocedure::text as firma
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind = 'f'
    order by 2
  loop
    if (has_function_privilege('anon', v_proc.oid, 'EXECUTE')
        or has_function_privilege('authenticated', v_proc.oid, 'EXECUTE'))
       and not (v_proc.oid = any (v_permitidas)) then
      v_errores := v_errores || format('%s no está en la lista permitida y es invocable vía API', v_proc.firma);
    end if;
  end loop;

  -- 11) Realtime publica SOLO ocupacion_actual
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    select count(*) into v_total
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename <> 'ocupacion_actual';
    if v_total > 0 then
      v_errores := v_errores || 'La publicación supabase_realtime incluye tablas públicas distintas de ocupacion_actual'::text;
    end if;
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime'
                     and schemaname = 'public' and tablename = 'ocupacion_actual') then
      v_errores := v_errores || 'ocupacion_actual no está en la publicación supabase_realtime'::text;
    end if;
  else
    raise notice 'AVISO: no existe la publicación supabase_realtime (se omite el chequeo de Realtime).';
  end if;

  -- 12) 4 jobs de pg_cron activos (si pg_cron está habilitado)
  if to_regclass('cron.job') is not null then
    select count(*) into v_total
    from cron.job
    where jobname in ('coworkflow_snapshot', 'coworkflow_cierre_auto',
                      'coworkflow_resumen_diario', 'coworkflow_retencion')
      and active;
    if v_total <> 4 then
      v_errores := v_errores || format('Se esperaban 4 jobs de pg_cron activos, hay %s', v_total);
    end if;
  else
    raise notice 'AVISO: pg_cron no habilitado; se omiten los chequeos de jobs.';
  end if;

  -- 13) Una fila de ocupacion_actual por cada zona activa
  select count(*) into v_total
  from public.zonas z
  left join public.ocupacion_actual oa on oa.zona_id = z.id
  where z.activa and oa.zona_id is null;
  if v_total > 0 then
    v_errores := v_errores || format('%s zonas activas sin fila en ocupacion_actual', v_total);
  end if;

  -- 14) Agregados del dashboard: solo 7/30 días y la curva de hoy no supera 288 filas.
  select z.id into v_zona from public.zonas z order by z.slug limit 1;
  if v_zona is null then
    raise notice 'AVISO: no hay zonas; se omite la prueba de ocupacion_por_franja/ocupacion_hoy.';
  else
    select count(*) into v_total from public.ocupacion_por_franja(v_zona, 5);
    if v_total <> 0 then
      v_errores := v_errores || format('ocupacion_por_franja con p_dias=5 devolvió %s filas (debe ser 0)', v_total);
    end if;

    select count(*) into v_total from public.ocupacion_hoy(v_zona);
    if v_total > 288 then
      v_errores := v_errores || format('ocupacion_hoy devolvió %s filas (máximo 288)', v_total);
    end if;
  end if;

  -- Resultado
  if array_length(v_errores, 1) > 0 then
    raise exception 'Verificación FALLÓ (% problemas):%  %',
      array_length(v_errores, 1), E'\n - ', array_to_string(v_errores, E'\n - ');
  end if;

  raise notice 'Verificación OK: RLS, políticas, privilegios, funciones, agregados del dashboard, Realtime y cron correctos.';
end $$;

