# OptiWork / CoworkFlow

Ocupación del cowork del Hub Providencia: QR rotativo de entrada/salida, consentimiento,
contador en tiempo real, estadísticas y administración. Next.js 16, React, TypeScript y
Supabase (Auth, PostgreSQL, RLS, Realtime y pg_cron).

## Funciones

- `/login`: contraseña, registro y enlace por correo.
- `/scan`: confirmación explícita; conserva un QR válido hasta diez minutos durante el alta,
  en el mismo navegador y dominio, con un solo canje.
- `/dashboard` y `/dashboard/estadisticas`: ocupación y agregados públicos.
- `/qr`: QR rotativo para administradores con sesión vigente.
- `/admin`: nombre, aforo, umbrales, activación y semana de las zonas existentes; historial
  filtrado/paginado y CSV seudonimizado (máximo 10.000 eventos por descarga).
- Jobs de cierre automático, snapshots, reconciliación y retención.

## Desarrollo

Node.js 24 y npm. Desde esta carpeta: `npm ci`, copiar `.env.example` a `.env.local`, completar
los valores y ejecutar `npm run dev`. Abrir http://localhost:3000. No versionar `.env.local`.

| Variable | Uso |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | URL del proyecto Supabase |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Clave pública, siempre bajo RLS |
| `NEXT_PUBLIC_SITE_URL` | Origen de producción/desarrollo; HTTPS en producción |
| `NEXT_PUBLIC_ZONA_POR_DEFECTO` | Slug, p. ej. `hub-providencia` |
| `QR_TOKEN_SECRET` | Secreto hexadecimal de 64 caracteres, solo servidor, idéntico al de la base |
| `QR_WINDOW_SECONDS` | Igual a `app_secrets.qr_window_seconds`, normalmente 45 |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Límites y continuación del QR; obligatorias en producción |
| `SUPABASE_SERVICE_ROLE_KEY` | Solo simulación/pruebas locales; el servidor web no la necesita |

En desarrollo sin Upstash se usa memoria. Producción falla cerrada si Redis no está disponible.
En Preview, QR y correos usan `VERCEL_BRANCH_URL` (o `VERCEL_URL`) del entorno del servidor,
evitando perder las cookies al saltar a producción. Probar el correo del PR requiere permitir
ese origen en Supabase; es opcional si se probará manualmente después del merge.

## Supabase y despliegue

1. Un propietario ejecuta las doce migraciones de `supabase/migrations/` en orden, como `postgres`.
   En `20261110000000_consentimiento_y_scan.sql`, ejecutar primero solo el `ALTER TYPE` y
   después el resto, según su cabecera.
2. En una instalación nueva, revisar y ejecutar `supabase/seed.sql`; hacer coincidir clave QR
   y ventana con Vercel. No sobrescribir secretos/configuración de una instalación existente.
3. Ejecutar `supabase/verificacion.sql` actualizado.
4. Configurar Auth: dominio/callback de producción, confirmación de correo y SMTP para
   destinatarios fuera del equipo. Solo el propietario debe configurar SMTP y DNS.
5. Crear al administrador mediante el registro normal. Un propietario asigna el rol desde
   SQL al UUID previamente identificado; no hay autopromoción desde la app.

La migración 11 del contador ya se aplicó remotamente el 19-11-2026. La 12,
`20261120000000_administracion.sql`, se entrega para revisión y aplicación coordinada antes
de activar el panel. CI nunca aplica migraciones al proyecto remoto ni incorpora el PR a main.

## Pruebas

```sh
npm run lint
npm run test:unit
npm run build
```

Para RLS/concurrencia, usar PostgreSQL local descartable con CREATEDB, CREATEROLE, pgcrypto
y `wal_level=logical`. Las suites crean/eliminan bases propias y rechazan servidores remotos.

```powershell
$env:COWORKFLOW_TEST_DATABASE_URL='postgresql://postgres:clave@127.0.0.1:5432/postgres'
npm run test:rls
npm run test:concurrencia
```

El workflow `.github/workflows/verificaciones.yml` ejecuta calidad, SQL y Playwright móvil con
Supabase local, Auth, PostgREST y Mailpit. Confirma el correo de prueba, marca entrada/salida,
prueba administración y aislamiento entre usuarios reales. No requiere secretos remotos.
Consulta [operación y pruebas](docs/operacion.md) para reproducirlo con Docker.

## Documentación

- [Operación, publicación y recuperación](docs/operacion.md).
- [Revisión móvil: once características, correcciones y mediciones](docs/revision-responsive.md).
- [Arquitectura](docs/arquitectura.md).
- [Modelo de datos](docs/modelo-datos.md).
- [Decisiones de seguridad](docs/decisiones-seguridad.md).
- [Regresión del contador y evidencia SQL remota](tests/integration/README.md).

La prueba manual con correo real y una visita real al cowork se realiza después de publicar;
una compilación correcta no sustituye esa comprobación.
