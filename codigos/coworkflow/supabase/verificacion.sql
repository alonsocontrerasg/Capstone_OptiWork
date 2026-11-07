-- ============================================================
-- CoworkFlow · verificacion.sql — Etapa 2
-- Ejecutar en el SQL Editor DESPUÉS de aplicar las 7 migraciones y el seed.
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
    v_errores := v_errores || 'Falta política INSERT (admin) en zonas';
  end if;

  -- 5) profiles: sin privilegio UPDATE sobre "rol" para anon/authenticated
  if has_column_privilege('anon', 'public.profiles', 'rol', 'UPDATE') then
    v_errores := v_errores || 'anon tiene UPDATE sobre profiles.rol';
  end if;
  if has_column_privilege('authenticated', 'public.profiles', 'rol', 'UPDATE') then
    v_errores := v_errores || 'authenticated tiene UPDATE sobre profiles.rol';
  end if;

  -- 6) Triggers clave presentes
  if not exists (
    select 1 from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'profiles'
      and t.tgname = 'trg_proteger_rol' and not t.tgisinternal
  ) then
    v_errores := v_errores || 'Falta el trigger trg_proteger_rol en profiles';
  end if;
  if not exists (
    select 1 from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'zonas'
      and t.tgname = 'trg_validar_timezone_zona' and not t.tgisinternal
  ) then
    v_errores := v_errores || 'Falta el trigger trg_validar_timezone_zona en zonas';
  end if;

  -- 7) pgcrypto en el esquema extensions
  if not exists (
    select 1 from pg_extension e join pg_namespace n on n.oid = e.extnamespace
    where e.extname = 'pgcrypto' and n.nspname = 'extensions'
  ) then
    v_errores := v_errores || 'pgcrypto no está instalado en el esquema extensions';
  end if;

  -- 8) app_secrets inaccesible para anon/authenticated
  if has_table_privilege('anon', 'public.app_secrets', 'SELECT') then
    v_errores := v_errores || 'anon puede leer app_secrets';
  end if;
  if has_table_privilege('authenticated', 'public.app_secrets', 'SELECT') then
    v_errores := v_errores || 'authenticated puede leer app_secrets';
  end if;

  -- 9) Secreto qr_token_secret >= 32 bytes (si falta, es solo un aviso)
  select length(valor) into v_total from public.app_secrets where clave = 'qr_token_secret';
  if v_total is null then
    raise notice 'AVISO: falta insertar qr_token_secret en app_secrets (ver docs/modelo-datos.md).';
  elsif v_total < 32 then
    v_errores := v_errores || format('qr_token_secret tiene %s bytes; usa al menos 32', v_total);
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
    'public.permanencia_promedio(uuid,timestamptz,timestamptz)',
    'public.personas_distintas(uuid,timestamptz,timestamptz)',
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

    select p.prosecdef, p.proconfig into v_definer, v_proconfig
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

    if v_nombre in ('public.permanencia_promedio', 'public.personas_distintas') then
      if not v_anon or not v_auth then
        v_errores := v_errores || format('%s debe ser ejecutable por anon y authenticated', v_firma);
      end if;
    elsif v_nombre in ('public.registrar_scan', 'public.es_admin') then
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

  -- 11) Realtime publica SOLO ocupacion_actual
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    select count(*) into v_total
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename <> 'ocupacion_actual';
    if v_total > 0 then
      v_errores := v_errores || 'La publicación supabase_realtime incluye tablas públicas distintas de ocupacion_actual';
    end if;
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime'
                     and schemaname = 'public' and tablename = 'ocupacion_actual') then
      v_errores := v_errores || 'ocupacion_actual no está en la publicación supabase_realtime';
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

  -- Resultado
  if array_length(v_errores, 1) > 0 then
    raise exception 'Verificación FALLÓ (% problemas):%  %',
      array_length(v_errores, 1), E'\n - ', array_to_string(v_errores, E'\n - ');
  end if;

  raise notice 'Verificación OK: RLS, políticas, privilegios, funciones, Realtime y cron correctos.';
end $$;

