-- ============================================================
-- CoworkFlow · Etapa 2 · Migración 2/7
-- Propósito: triggers de perfiles.
--   · handle_new_user  → crea profiles al registrarse (AFTER INSERT auth.users)
--   · proteger_rol      → impide que authenticated/anon cambien profiles.rol
-- Requiere: rol postgres. Idempotente.
-- ============================================================

-- Crea la fila de perfil cuando Supabase Auth inserta un usuario.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.profiles (id, rol)
  values (new.id, 'usuario')
  on conflict (id) do nothing;
  return new;
end;
$$;
revoke execute on function public.handle_new_user() from public, anon, authenticated;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Bloquea el cambio de rol SOLO para la app (JWT authenticated/anon).
-- El SQL Editor (postgres, sin JWT) y service_role SÍ pueden cambiarlo.
create or replace function public.proteger_rol()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_jwt_role text := coalesce((nullif(current_setting('request.jwt.claims', true), ''))::jsonb ->> 'role', '');
begin
  if new.rol is distinct from old.rol and v_jwt_role in ('authenticated', 'anon') then
    raise exception 'No está permitido modificar "rol" desde la aplicación'
      using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke execute on function public.proteger_rol() from public, anon, authenticated;

drop trigger if exists trg_proteger_rol on public.profiles;
create trigger trg_proteger_rol
  before update on public.profiles
  for each row execute function public.proteger_rol();
