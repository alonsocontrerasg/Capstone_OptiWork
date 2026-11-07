-- ============================================================
-- CoworkFlow · seed.sql — Etapa 2
-- Crea la zona por defecto. NO contiene secretos ni usuarios/admin.
-- Idempotente: se puede re-ejecutar sin duplicar filas.
-- El trigger trg_zonas_crear_ocupacion crea automáticamente la fila
-- correspondiente en ocupacion_actual.
-- ============================================================

insert into public.zonas (
  slug, nombre, aforo_max, umbral_bajo, umbral_alto,
  hora_apertura, hora_cierre, timezone, activa
)
values (
  'hub-providencia', 'Hub Providencia', 100, 40, 80,
  '08:00', '20:00', 'America/Santiago', true
)
on conflict (slug) do nothing;
