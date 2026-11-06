<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# CoworkFlow: especificación del proyecto

Actúa como arquitecto y desarrollador full-stack senior. Construimos "CoworkFlow", un sistema web de monitoreo de ocupación del cowork del Hub Providencia (proyecto universitario, presupuesto $0, todo en planes gratuitos).

El proyecto Next.js ya está creado en esta carpeta: no lo inicialices de nuevo y respeta las instrucciones que ya existen en este archivo. Todo el SQL va como migraciones en `supabase/migrations/`.

## Objetivo
Los usuarios hacen check-in y check-out escaneando un QR con la cámara de su celular. Un dashboard calcula la ocupación en tiempo real y muestra un indicador Bajo / Moderado / Lleno según un aforo máximo configurable (ej. 100 personas), más estadísticas históricas de uso.

## Stack (no cambiarlo sin justificar)
- Next.js (App Router) + TypeScript + Tailwind CSS
- Supabase: PostgreSQL, Auth (con @supabase/ssr), Realtime, Row Level Security, pg_cron
- Recharts, zod, librería "qrcode"
- Deploy en Vercel. Tests con Vitest.

## Flujo de uso
1. El usuario se registra o inicia sesión (magic link por email; contraseña como alternativa, porque el correo gratis de Supabase tiene un límite bajo de envíos. Configurar SMTP propio, p. ej. Resend, si es posible).
2. Escanea con la cámara nativa del celular el QR de "Entrada" o "Salida", que abre `/scan?modo=entrada&t=<token>`.
3. El servidor valida el token y registra el evento. La pantalla confirma: "Entrada registrada" o "Salida registrada".
4. El dashboard se actualiza solo en tiempo real.

## Modelo de datos
- profiles(id, rol: 'usuario'|'admin', consentimiento_at, consentimiento_version). Se crea con un trigger sobre auth.users al registrarse.
- zonas(id, nombre, aforo_max, umbral_bajo=40, umbral_alto=80, hora_apertura, hora_cierre, activa)
- sesiones(id, user_id, zona_id, entrada_at, salida_at, cierre: 'usuario'|'auto')
- eventos_scan(id, user_id, zona_id, tipo, ts, resultado): log de auditoría
- ocupacion_actual(zona_id, cantidad, updated_at): se actualiza dentro de la misma transacción que cada check-in/check-out. Es lo único a lo que se suscribe el dashboard público (así Realtime nunca expone user_id).
- snapshots_ocupacion(zona_id, ts, cantidad): se guarda cada 5 min para el histórico

## Lógica de negocio
- Ocupación = sesiones con salida_at NULL.
- Porcentaje = ocupación / aforo_max. Estado: Bajo (<40%), Moderado (40–80%), Lleno (>80%), con umbrales configurables por zona.
- Check-in con sesión ya abierta: no duplicar, avisar al usuario.
- Check-out sin sesión abierta: ignorar y avisar.
- Cooldown: máximo 1 evento por usuario cada 30 s, aplicado dentro del RPC.
- Cierre automático: pg_cron cada 15 min cierra sesiones abiertas de más de 8 h o fuera del horario de la zona (cierre='auto') y actualiza ocupacion_actual.
- Toda escritura pasa por una función SQL (RPC) o Route Handler. Nunca por inserts directos del cliente.

## Seguridad
- QR rotativo: página `/qr` (solo admin) que muestra un QR que cambia cada 30–60 s. El token es un HMAC/JWT firmado en el servidor con expiración corta, ligado a zona y modo. El servidor acepta la ventana actual y la anterior, para tolerar el retraso del escaneo. Esto evita escanear desde casa con una foto. Fallback: QR estático impreso + validación de geolocalización (opcional, con consentimiento).
- Row Level Security en todas las tablas: el usuario solo ve sus propias sesiones. El dashboard público lee solo ocupacion_actual y vistas agregadas (sin datos personales). El admin ve el historial.
- La service_role key nunca va al cliente. Secretos en variables de entorno; `.env.local` fuera de git.
- Validar todo input con zod. Rate limiting en los endpoints de scan con un almacén externo (Upstash Redis plan gratis), no en memoria, porque en serverless cada invocación es independiente.
- Headers de seguridad (CSP, HSTS), solo HTTPS, cookies httpOnly.
- Privacidad (Ley 21.719): minimizar datos, ID seudónimo en estadísticas, aviso de consentimiento en el registro, retención de eventos crudos limitada (ej. 90 días) y conservar solo agregados.

## Páginas
- `/login`
- `/scan`: confirmación del evento
- `/dashboard`: contador grande, barra de % de aforo, semáforo Bajo/Moderado/Lleno, gráfico por hora del día, mapa de calor día x hora, hora punta, permanencia promedio
- `/qr`: QR rotativo (admin)
- `/admin`: configurar aforo, umbrales y horario, ver historial, exportar CSV

## Escalabilidad
El diseño debe soportar múltiples zonas (cada una con su aforo, horario y QR) sin cambios de esquema. Incluye una sección que explique cómo escalar a otros espacios del Hub.

## Demo sin hardware
Script de simulación (corre solo en local, usa service_role) que genere usuarios falsos y un flujo realista de entradas y salidas durante varios días, para poblar las estadísticas históricas.

## Tests
Vitest para la lógica de negocio. Además, tests que comprueben las políticas RLS: un usuario no puede leer sesiones ajenas, ni insertar directamente en sesiones o eventos_scan, y el público no puede leer datos personales.

## Forma de trabajo
Trabaja por etapas. Al terminar cada una, detente y espera mi confirmación explícita.
1. Plan de arquitectura y estructura de carpetas.
2. Esquema SQL con RLS, funciones, triggers y pg_cron.
3. Autenticación y lógica de tokens QR.
4. Endpoint/RPC de scan con todas las validaciones.
5. Dashboard en tiempo real.
6. Admin, simulación de datos y tests.

Al terminar cada etapa, agrega a `docs/decisiones-seguridad.md` una explicación breve de cada decisión de seguridad tomada (qué amenaza evita y por qué esa solución). Lo usaré para justificarlas en el informe.
