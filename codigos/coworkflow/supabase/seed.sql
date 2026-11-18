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

-- ============================================================
-- Horario semanal de hub-providencia (Etapa 6b, migración 10).
-- Bloque idempotente: se puede ejecutar solo, después de la migración 10.
--   lunes a jueves 08:30-18:00 · viernes 08:30-17:00 · sábado y domingo cerrados
-- Las columnas hora_apertura/hora_cierre quedan como rango unión (08:30-18:00):
-- son el fallback de una zona sin filas semanales y el rango de columnas del
-- mapa de calor del dashboard.
-- ============================================================
update public.zonas
   set hora_apertura = '08:30',
       hora_cierre   = '18:00'
 where slug = 'hub-providencia';

with zona as (
  select id from public.zonas where slug = 'hub-providencia'
)
insert into public.horarios_zona (zona_id, dia_semana, apertura, cierre)
select zona.id, v.dia_semana, v.apertura, v.cierre
from zona
cross join (values
  (1::smallint, '08:30'::time, '18:00'::time),
  (2::smallint, '08:30'::time, '18:00'::time),
  (3::smallint, '08:30'::time, '18:00'::time),
  (4::smallint, '08:30'::time, '18:00'::time),
  (5::smallint, '08:30'::time, '17:00'::time)
) as v(dia_semana, apertura, cierre)
on conflict (zona_id, dia_semana) do update
  set apertura = excluded.apertura,
      cierre   = excluded.cierre;
