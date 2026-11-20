# Regresión del contador de ocupación

Estas pruebas ejecutan las migraciones reales en PostgreSQL y solapan conexiones independientes.
No basta con simular promesas o ejecutar escrituras una después de otra: la suite consulta
`pg_blocking_pids` para comprobar que existe una espera antes de liberar la primera transacción.

Requisitos: Node.js 22 o superior, `npm ci` y PostgreSQL local con `pgcrypto`. La cuenta de prueba
debe poder crear bases y roles (normalmente `postgres`). No hace falta ejecutar Next, configurar
Upstash ni proporcionar claves de Supabase. El adaptador mínimo de Auth es exclusivo de la base
temporal; no verifica la emisión de JWT ni el servidor HTTP de Supabase.

Desde `codigos/coworkflow`, en PowerShell:

```powershell
$env:COWORKFLOW_TEST_DATABASE_URL = 'postgresql://postgres:TU_PASSWORD_LOCAL@127.0.0.1:5432/postgres'
npm run test:concurrencia
```

El runner solo admite hosts loopback, crea una base `coworkflow_counter_<uuid>`, aplica las
migraciones y la elimina al terminar. Los roles de compatibilidad se reutilizan si existen;
los que crea la suite se eliminan después de borrar su base. Usar un servidor local dedicado a
pruebas y no ejecutar dos suites simultáneas sobre el mismo clúster. Si el proceso se interrumpe
por fuerza, puede quedar la base temporal para borrarla manualmente.

Para demostrar que la primera prueba detecta el fallo anterior:

```powershell
$env:COWORKFLOW_TEST_BASELINE = '1'
node --test '--test-name-pattern=conserva ambas entradas simultáneas' tests/integration/ocupacion-concurrencia.test.mjs
Remove-Item Env:COWORKFLOW_TEST_BASELINE
```

La ejecución anterior DEBE fallar con contador `1` y sesiones abiertas `2`. Sin esa variable, la
suite aplica la migración `20261119000000_ocupacion_concurrente.sql` y las pruebas deben pasar.

## Estado del despliegue (2026-11-19)

**Aplicada y verificada en Supabase.** El 19 de noviembre de 2026 se ejecutó la migración completa
desde el SQL Editor del proyecto `coworkflow`, rama `main` (producción), con el rol `postgres`.
La ejecución terminó con `Success. No rows returned`.

Las comprobaciones de `supabase/verificacion.sql`, ejecutadas en formato compacto con los mismos
controles y mensajes abreviados, terminaron correctamente. El informe final devolvió `OK` a las
22:57:59 UTC (19:57:59 de Chile): 3 triggers del contador, 4 jobs activos y secreto QR configurado.
Se comprobaron RLS, políticas, privilegios, funciones, horario semanal, agregados, Realtime y
consistencia entre el contador y las sesiones abiertas. No se mostraron los valores de secretos.

La base no tiene `supabase_migrations.schema_migrations`; se conservó el flujo manual existente
del proyecto, sin crear ni alterar el historial de migraciones. Las pruebas de concurrencia con
usuarios simulados se ejecutaron en PostgreSQL local; no se inyectaron sesiones de prueba en
producción. La validación funcional del login/escaneo en el despliegue web es una prueba aparte.

Para desplegar la corrección, ejecutar el archivo completo de esa migración en el SQL Editor de
Supabase, después de las diez anteriores, y luego ejecutar `supabase/verificacion.sql` actualizado.
La migración incluye BEGIN/COMMIT, reemplaza funciones/triggers y reconcilia los contadores; puede
esperar escrituras activas y bloquea brevemente nuevas escrituras de sesiones. Conviene aplicarla
en una ventana de poca actividad. Repetir pruebas en staging antes de usar el SQL en producción.
No se necesita modificar el frontend ni reprogramar los jobs de pg_cron.
