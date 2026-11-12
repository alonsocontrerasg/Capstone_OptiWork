# Decisiones de seguridad — CoworkFlow

> Registro acumulativo de las decisiones de seguridad del proyecto, con la amenaza que evita cada
> una y por qué se eligió esa solución. Se usa para justificar el diseño en el informe (Ley 21.719
> y buenas prácticas de aplicaciones web). Se agrega una sección por etapa.

## Cómo está organizado

- Los identificadores son `S-NN` y no se renumeran: si una decisión se reemplaza, se deja la
  original y se agrega la nueva con el motivo del cambio.
- Cada entrada tiene: **decisión**, **amenaza**, **por qué esta solución**, **dónde se implementa**
  y **costo o tradeoff asumido** (para que el informe no parezca que todo es gratis).
- La columna «etapa» indica dónde se materializa en código o SQL.

### Índice

| ID | Decisión | Etapa |
| --- | --- | --- |
| S-01 | RLS deny-by-default; tablas de negocio sin políticas de escritura | 2 |
| S-02 | Escritura solo por RPC `SECURITY DEFINER` con `auth.uid()` obligatorio | 2 |
| S-03 | Realtime publica únicamente `ocupacion_actual` | 2 · 5 |
| S-04 | Estadísticas públicas solo por funciones de agregados | 2 · 5 |
| S-05 | `GET /scan` no muta: el registro ocurre por `POST` | 4 |
| S-06 | Zona y modo vienen firmados en el token, no del query string | 3 · 4 |
| S-07 | `service_role` nunca llega al navegador | 3 |
| S-08 | Defensa en capas contra abuso: rate limit + cooldown + índice único | 2 · 4 |
| S-09 | Sesión en cookies httpOnly con `@supabase/ssr`; refresh en `proxy.ts` | 3 |
| S-10 | CSP con nonce, HSTS y solo HTTPS | 3 |
| S-11 | Minimización de datos, retención de 90 días y agregados | 2 · 6 |
| S-12 | `/scan` sin sesión descarta el token (no se reutiliza) | 4 |
| S-13 | Reconciliación periódica del contador de ocupación | 2 |
| S-14 | Verificación obligatoria de RLS tras aplicar migraciones a mano | 2 · 6 |
| S-15 | Todo input validado y acotado con zod en el borde | 4 |
| S-16 | Verificación HMAC del token dentro de Postgres y secreto en `app_secrets` | 2 |
| S-17 | Límite de intentos inválidos por usuario (10/min) dentro de la RPC | 2 |
| S-18 | k-anonimato en estadísticas públicas (`NULL` si no se alcanza `k = 5`) | 2 · 5 |
| S-19 | `profiles.rol` blindado: sin escritura + trigger `proteger_rol` | 2 |
| S-20 | Privilegios EXECUTE mínimos por función | 2 |
| S-21 | k=5 también en `resumen_diario`: `permanencia_prom_seg` `NULL` con < 5 | 2 · 5 |
| S-22 | Comparación de firmas HMAC por `digest` (bytea de 32 bytes) | 2 |
| S-23 | k-anonimato por **personas distintas**, rango de 1..90 días alineado a medianoche de la zona | 2 · 5 |
| S-24 | Permanencia solo con `cierre = 'usuario'`; `salida_at` del cierre auto acotada a 8 h | 2 · 5 |
| S-25 | Consentimiento informado como condición para registrar entradas y salidas | 3 |
| S-26 | Token QR firmado solo en el servidor y entregado ya renderizado | 3 |
| S-27 | Guards con `getClaims()` + rol leído de `profiles` en cada llamada; `next` saneado | 3 |
| S-28 | `signout` solo por `POST` y verificación de origen en las mutaciones | 3 |
| S-29 | Login en el servidor: errores genéricos (anti-enumeración) y rate limit propio | 3 · 4 |
| S-30 | Rate limit de borde con Upstash (IP y usuario); falla cerrada en producción | 4 |
| S-31 | IP solo de `x-vercel-forwarded-for`, hasheada con HMAC e IPv6 reducida a /64 | 4 |
| S-32 | `Referrer-Policy: strict-origin` en `/scan` y `replaceState` al montar | 4 |
| S-33 | Mapeo exhaustivo `resultado_scan` → HTTP/mensaje, con falla cerrada | 4 |
| S-34 | `camera=()` en `Permissions-Policy` | 4 |
| S-35 | Rate limit en `/auth/login` por IP y hash de correo, sin enumerar | 4 |
| S-36 | `getClaims()` no detecta revocación; `/admin` usará `getUser()` | 4 · 6 |
| S-37 | Estadísticas del dashboard en RSC, sin Upstash y con rangos cerrados solo en la UI | 5 |
| S-38 | Agregados en Postgres y solo agregados al navegador (tope de 1000 filas) | 5 |

---

## Etapa 1 — Arquitectura y diseño

### S-01 · RLS deny-by-default y sin políticas de escritura en tablas de negocio

**Decisión.** Se activa Row Level Security en las siete tablas. `sesiones`, `eventos_scan` y
`ocupacion_actual` **no** tienen políticas de `INSERT`, `UPDATE` ni `DELETE` para `authenticated`:
sin política que lo permita, RLS deniega. El usuario solo puede `SELECT` sus propias sesiones
(`user_id = auth.uid()`); `eventos_scan` y el historial completo son solo para admin.

**Amenaza.** Un usuario con la app abierta en su navegador (DevTools o un script) podría insertar
una sesión falsa, cerrar la sesión de otra persona o editar `ocupacion_actual` para manipular el
aforo. También cubre la enumeración de datos de terceros.

**Por qué esta solución.** RLS es la única barrera que se aplica *siempre*, incluso si el frontend
tiene un bug o alguien usa la `anon key` que es pública por diseño. Un control en el cliente no es
un control. Al no existir políticas de escritura, la base se convierte en la autoridad final y no
depende de que el código de la app se comporte bien.

**Dónde se implementa.** `supabase/migrations/*_rls_policies.sql` (Etapa 2) y los tests
`tests/rls/**` (Etapa 6).

**Tradeoff.** Cada tabla nueva necesita su política explícita y su test; es trabajo repetitivo que
se asume a cambio de que el modo por defecto sea «cerrado».

### S-02 · Escritura solo por RPC `SECURITY DEFINER` con `auth.uid()` obligatorio

**Decisión.** Toda mutación de entrada/salida pasa por `registrar_scan(...)`, una función
`SECURITY DEFINER` con `set search_path = public, pg_temp`, `EXECUTE` revocado de `anon` y
concedido solo a `authenticated`. La función exige un `auth.uid()` no nulo, valida zona activa,
horario, cooldown y estado de la sesión, y escribe en `sesiones` y `eventos_scan` dentro de una
sola transacción.

**Amenaza.** Saltarse las reglas de negocio llamando directamente a las tablas o a una función
demasiado permisiva: registrar entradas sin cooldown, duplicar sesiones o cerrar sesiones ajenas.

**Por qué esta solución.** La lógica queda en el mismo lugar donde están los datos y dentro de una
transacción: o se aplica todo (evento + sesión + contador) o nada. `SECURITY DEFINER` es necesario
porque el usuario no tiene permisos de escritura (S-01); a cambio se fija `search_path` para evitar
que un esquema malicioso secuestre los nombres de tabla, y se valida la identidad dentro de la
función para que no quede como «caja abierta».

**Dónde se implementa.** `..._rpc_registrar_scan.sql` (Etapa 2) y `POST /api/scan` (Etapa 4), que
la invoca con el JWT del usuario (nunca con `service_role`).

**Tradeoff.** `SECURITY DEFINER` es potente: cualquier error en su interior se ejecuta con permisos
del dueño. Se mitiga con `search_path` fijo, permisos mínimos y revisión de la función.

### S-03 · Realtime publica únicamente `ocupacion_actual`

**Decisión.** La publicación `supabase_realtime` contiene una sola tabla: `ocupacion_actual`
(`zona_id`, `cantidad`, `updated_at`). El dashboard se suscribe a esa tabla con la `anon key`. La
tabla se mantiene por trigger, así que el dashboard se entera de cada cambio sin ver jamás
`sesiones` ni `eventos_scan`.

**Amenaza.** Fuga de datos personales en tiempo real: quién entró, quién salió y a qué hora. Sería
vigilancia de personas con nombre y apellido, no un indicador de aforo.

**Por qué esta solución.** Realtime replica **filas completas**, no columnas: no existe forma de
publicar «solo la cantidad» de una tabla que también tiene `user_id`. Publicar `sesiones` con RLS
tampoco basta si en algún momento se abre la lectura al público. La solución estructural es
publicar una tabla agregada que, por diseño, no tiene datos personales. Además reduce mensajes
(uno por scan) y el costo del plan gratuito.

**Dónde se implementa.** `..._triggers_ocupacion.sql` + `alter publication` (Etapa 2); consumidor
en `src/components/dashboard/ProveedorRealtime.tsx` (Etapa 5).

**Tradeoff.** Se agrega un `UPDATE` a `ocupacion_actual` en cada scan y una tabla más que mantener
consistente; se compensa con la reconciliación de S-13.

### S-04 · Estadísticas públicas solo por funciones de agregados

**Decisión.** El dashboard histórico no lee `sesiones` ni `eventos_scan`. Lee `snapshots_ocupacion`
y `resumen_diario` (ya agregados, sin identidades) y llama funciones `SECURITY DEFINER` que
devuelven únicamente números (permanencia promedio, conteos). Ninguna función pública devuelve
`user_id`, email ni filas individuales.

**Amenaza.** Que el público (o un atacante con la `anon key`) reconstruya patrones de presencia
—quién está, cuándo, cuánto tiempo— a partir de vistas aparentemente inocentes.

**Por qué esta solución.** Con vistas hay que elegir entre dos males: `security_invoker = true`
(no ve nada sin RLS, inútil para el público) o una vista `definer` sobre `sesiones`, que expone
filas completas. Las funciones permiten exponer exactamente el contrato de números que el gráfico
necesita, con `search_path` fijo y sin `SELECT *`.

**Dónde se implementa.** `..._stats_y_resumen_diario.sql` (Etapa 2) y las páginas del dashboard
(Etapa 5).

**Tradeoff.** Cada métrica nueva requiere su función y su `GRANT`; a cambio, nada se expone «por
accidente» al agregar una columna a `sesiones`.

### S-05 · `GET /scan` no muta: el registro ocurre por `POST`

**Decisión.** La URL del QR (`GET /scan?modo=…&t=…`) solo renderiza la pantalla de confirmación. El
registro se hace con `POST /api/scan` desde la misma página, con `Origin` verificado.

**Amenaza.** Registros falsos o duplicados sin que la persona escanee: prefetch de Next, previews
de enlaces (WhatsApp, Slack, Telegram), antivirus de correo, o simplemente recargar la página.
También evita que un bot que «visita» URLs genere entradas.

**Por qué esta solución.** Es el principio de que **GET es seguro e idempotente**. Un enlace que
muta el estado no se puede compartir ni previsualizar sin consecuencias, y no hay forma confiable de
distinguir un humano de un prefetch en el servidor. Separar render y mutación elimina la clase de
error completa.

**Dónde se implementa.** `src/app/scan/page.tsx` y `src/app/api/scan/route.ts` (Etapa 4).

**Tradeoff.** Un paso más de UX (confirmar) y un `fetch` extra; se compensa porque el mensaje de
confirmación es más claro que un registro silencioso.

### S-06 · Zona y modo vienen firmados en el token, no del query string

**Decisión.** El token es `v1.<zona_id>.<modo>.<ventana>` firmado con HMAC-SHA256 y se compara en
tiempo constante contra `QR_TOKEN_SECRET`. El servidor toma zona y modo **del token**; `?modo=` y
`?zona=` en la URL son solo para mostrar la pantalla correcta.

**Amenaza.** Manipulación de la petición: cambiar `?modo=entrada` por `?modo=salida` para cerrar la
sesión de alguien, o apuntar a otra zona para falsear cifras; y reutilizar una foto del QR desde
otro lugar (por eso la ventana temporal corta).

**Por qué esta solución.** El token es la única pieza que el usuario no puede fabricar sin el
secreto del servidor: liga zona, modo y tiempo en un solo valor. La comparación en tiempo constante
evita ataques de temporización sobre la firma, y aceptar solo la ventana actual y la anterior acota
la ventana de replay a ~90 s.

**Dónde se implementa.** `src/lib/qr/token.ts` (Etapa 3), `POST /api/scan` (Etapa 4) y sus tests de
unidad.

**Tradeoff.** Una foto del QR sirve hasta 90 s y hay que tolerar relojes desfasados; se mitiga con
rate limit + cooldown (S-08) y, en el futuro, geolocalización opcional.

### S-07 · `service_role` nunca llega al navegador

**Decisión.** La `service_role key` solo se usa en `scripts/` (simulación y seeds, ejecutados en
local) y en `src/lib/supabase/admin.ts`, módulo de servidor que ninguna isla cliente importa. No
lleva prefijo `NEXT_PUBLIC_`, `.env.local` está en `.gitignore` y el repositorio solo versiona
`.env.example` con valores de ejemplo.

**Amenaza.** Exposición de la llave que **ignora RLS**: con ella, cualquiera lee y escribe todo
(sesiones, perfiles, historial) y el modelo de seguridad completo deja de existir.

**Por qué esta solución.** Next incrusta en el bundle público toda variable `NEXT_PUBLIC_*`; por eso
la llave sensible se nombra sin prefijo y aparece en un módulo server-only, donde un import
accidental desde el cliente falla en build. Versionar una plantilla sin valores evita la fuga por
copiar/pegar en el repositorio.

**Dónde se implementa.** `.env.example`, `.gitignore`, `src/lib/env.ts` (Etapa 3) y
`src/lib/supabase/admin.ts` (Etapa 3).

**Tradeoff.** Hay que completar variables en cada entorno (local y Vercel); se documenta en el
README y se valida con zod al arrancar para fallar rápido.

### S-08 · Defensa en capas contra el abuso de los endpoints de scan

**Decisión.** Tres capas independientes:

1. **Rate limit en el borde** con Upstash Redis (claves por usuario y por hash de IP), porque en
   serverless la memoria no se comparte entre invocaciones.
2. **Cooldown de 30 s en la base**, dentro de la RPC y con la fila bloqueada.
3. **Índice único parcial** `(user_id) WHERE salida_at IS NULL` como garantía estructural.

**Amenaza.** Ráfagas automatizadas (script que escanea miles de veces), reenvío manual repetido y
condiciones de carrera (doble tap, dos pestañas) que insertarían dos sesiones abiertas.

**Por qué esta solución.** Cada capa ve lo que las otras no: el rate limit corta volumen antes de
tocar la base y no depende del estado del usuario; el cooldown en la base sobrevive a un atacante
que cambia de IP o usa varios dispositivos con la misma cuenta; el índice único no depende de que
la lógica sea correcta, porque es una restricción del motor. Además, el rate limit en memoria se
descartó explícitamente: en Vercel cada invocación es un proceso distinto, así que un contador en
memoria es inútil en producción.

**Dónde se implementa.** `src/lib/rate-limit.ts` + `POST /api/scan` y `POST /auth/login`
(Etapa 4), y `..._rpc_registrar_scan.sql` (Etapa 2).

**Tradeoff.** Upstash tiene cuota gratuita limitada y agrega una dependencia externa; se usa solo en
los endpoints que lo necesitan (`/api/scan` y `/auth/login`, nunca en lecturas) y en local hay una
alternativa en memoria con advertencia.

**Actualización (Etapa 4) — el `TODO` de rate limit quedó resuelto.** El limitador se implementó
completo en `src/lib/rate-limit.ts` y se aplica en `POST /api/scan` y `POST /auth/login`. Los
límites concretos, el orden de las comprobaciones y la falla cerrada se detallan en S-30; el cubo
por correo del login, en S-35.

### S-09 · Sesión en cookies httpOnly con `@supabase/ssr`; refresh en `proxy.ts`

**Decisión.** El token de sesión se guarda en cookies httpOnly gestionadas por `@supabase/ssr`
(método `getAll`/`setAll`), nunca en `localStorage`. El refresco ocurre en `src/proxy.ts` (el
`middleware.ts` de Next 16) y los Server Components leen la sesión con `cookies()` dentro de un
`<Suspense>`.

**Amenaza.** Robo de sesión mediante XSS: si el token está en `localStorage`, cualquier script
inyectado lo lee y se lo lleva. También evita sesiones «eternas» por tokens que no se refrescan.

**Por qué esta solución.** Una cookie httpOnly no es accesible desde JavaScript, así que un XSS
puede hacer acciones en la página pero no exportar la credencial. `@supabase/ssr` es el mecanismo
oficial para App Router: mantiene el par de tokens sincronizado entre servidor y cliente sin
exponerlos al DOM.

**Dónde se implementa.** `src/lib/supabase/server.ts`, `src/lib/supabase/cookies.ts`,
`src/app/auth/login/route.ts` y `src/proxy.ts` (Etapa 3; ver nota de revisión).

**Tradeoff.** Toda lectura de sesión es dinámica (no se puede prerenderizar) y debe vivir detrás de
`<Suspense>`; es una consecuencia aceptada de `cacheComponents`.

**Nota de revisión (Etapa 3) — las cookies no eran realmente httpOnly.** Al inspeccionar la sesión
en DevTools se comprobó que las cookies `sb-*` salían **sin** `HttpOnly`. La causa: el inicio de
sesión se hacía en el navegador con `createBrowserClient`, y `@supabase/ssr` define `httpOnly: false`
por defecto (`DEFAULT_COOKIE_OPTIONS`) porque `document.cookie` no puede escribir cookies httpOnly.
Por tanto, la afirmación original de S-09 **no se cumplía**.

**Corrección.** `signInWithPassword`, `signUp` y `signInWithOtp` pasan a `POST /auth/login`, un Route
Handler que usa `createServerClient`; el `setAll` de `src/lib/supabase/server.ts` y el de
`src/proxy.ts` **fuerzan** `httpOnly: true`, `sameSite: 'lax'`, `path: '/'` y `secure` (solo en
producción). Se retira `createBrowserClient` del flujo de autenticación. El PKCE del enlace mágico
sigue funcionando: el `code_verifier` se guarda en una cookie httpOnly emitida por el servidor y se
canjea en `/auth/callback` con `exchangeCodeForSession`.

**Amenaza que se cierra.** Un XSS ya no puede leer el token de sesión desde `document.cookie` y
exfiltrarlo: es el mismo objetivo de S-09, ahora sí implementado.

**Tradeoff.** El login hace un `fetch` POST adicional al propio servidor (antes iba directo a
Supabase) y el redirect del enlace mágico depende de que `NEXT_PUBLIC_SITE_URL` coincida con el
dominio real.

### S-10 · CSP con nonce, HSTS y solo HTTPS

**Decisión.** `src/proxy.ts` genera un nonce por request y emite `Content-Security-Policy` estricta
(`default-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`, `base-uri 'self'`,
`upgrade-insecure-requests`, `connect-src` limitado al proyecto Supabase y su WebSocket), más
`Strict-Transport-Security`, `Referrer-Policy`, `X-Content-Type-Options: nosniff` y
`Permissions-Policy`. Solo se sirve por HTTPS.

**Amenaza.** XSS (inyección de scripts), clickjacking (iframe sobre `/admin` o `/qr` para inducir
clics), fuga de tokens por cabecera `Referer` y degradación a HTTP en redes abiertas (el caso típico
en un cowork con wifi público).

**Por qué esta solución.** La CSP con nonce es la única variante que realmente bloquea scripts
inyectados sin abrir la puerta con `'unsafe-inline'`; `frame-ancestors 'none'` impide que otro sitio
embeba la app; HSTS fuerza TLS después de la primera visita. Los encabezados en el proxy se aplican
a todas las rutas, incluidos los Route Handlers, así que no depende de recordar ponerlos página por
página.

**Dónde se implementa.** `src/proxy.ts` (Etapa 3), siguiendo la guía oficial de CSP incluida en
`node_modules/next/dist/docs/`.

**Tradeoff.** Un nonce obliga a renderizado dinámico; y una CSP mal calibrada rompe estilos inline de
Tailwind o el WebSocket de Realtime, por lo que se prueba en desarrollo antes de fijarla.

**Nota de revisión (Etapa 3) — nonce vs. PPR.** Al implementarla se confirmó en la guía oficial
(`node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md`) que **el nonce es
incompatible con PPR**: un documento prerenderizado se sirve desde la caché con un nonce ya gastado
(o sin nonce), así que sus scripts quedan bloqueados. Las alternativas eran (a) `'unsafe-inline'` en
`script-src`, que anula la protección anti-XSS que motiva S-10, o (b) SRI experimental, que en Next 16
está atado a los mismos prerenderizados. Se eligió **mantener la CSP estricta y desactivar PPR**:
se quitaron `cacheComponents: true` y `partialPrefetching: true` de `next.config.ts`, y todas las
rutas quedan dinámicas (`ƒ` en el build). El costo es no prerenderizar el shell estático; en esta app
es marginal porque cada ruta lee sesión, ocupación o configuración viva. Además, `not-found.tsx` y
`forbidden.tsx` llaman a `connection()` para no quedar prerenderizados y romper la CSP sin que se
note. En desarrollo se relajan **solo** `'unsafe-eval'` (HMR) y `'unsafe-inline'` en `style-src`
(overlay de errores); producción no tiene ninguna de las dos, y eso se verifica en el build.

**Actualización (Etapa 4) — dos cabeceras dejan de ser uniformes.** `Permissions-Policy` pasa a
`camera=()` en todo el sitio (S-34) y `Referrer-Policy` se elige por ruta: `strict-origin` en
`/scan`, porque su URL lleva el token del QR, y `strict-origin-when-cross-origin` en el resto
(S-32). Ambas se fijan en el proxy, así que siguen aplicándose a todas las rutas y a los Route
Handlers sin depender de la página.

### S-11 · Minimización de datos, retención de 90 días y agregados

**Decisión.** Se guarda lo mínimo: `user_id`, `zona_id`, marcas de tiempo y resultado. No se guardan
IP, user-agent, geolocalización ni nombres. `eventos_scan` y las sesiones cerradas se purgan a los 90
días con `pg_cron`; antes de purgar, `resumen_diario` y `snapshots_ocupacion` conservan los agregados.
En el export CSV el identificador va seudonimizado.

**Amenaza.** Acumulación indefinida de datos personales (trazabilidad de horarios de personas) y
exposición por una brecha futura; incumplimiento de los principios de finalidad y proporcionalidad de
la Ley 21.719.

**Por qué esta solución.** El sistema necesita los datos crudos solo para operar y calcular métricas
recientes. Al separar «dato operativo» (se borra) de «agregado» (se conserva), el producto mantiene
su histórico sin retener información identificable. Un identificador seudónimo en el export permite
soportes sin publicar identidades.

**Dónde se implementa.** `..._pg_cron_jobs.sql` (job de retención, Etapa 2), `/admin/export`
(Etapa 6) y el aviso de consentimiento en `/login` (Etapa 3).

**Tradeoff.** Después de 90 días no se puede reconstruir una sesión individual (por ejemplo, para
una disputa); se acepta porque el objetivo del sistema es el aforo, no la vigilancia.

### S-12 · `/scan` sin sesión descarta el token (no se reutiliza después del login)

**Decisión.** Si alguien abre `/scan` sin sesión, se redirige a `/login` **sin conservar el token**:
no viaja en `?next=`, ni en cookie, ni en `sessionStorage`/`localStorage`. Al volver del login, la
persona debe escanear el QR otra vez. El token tampoco se registra en logs de aplicación y `/scan`
responde con `Referrer-Policy` restrictiva.

**Amenaza.** Replay diferido: guardar un token válido, autenticarse y usarlo minutos u horas después
para registrar una entrada sin volver a estar frente al QR. También el robo del token desde el
historial del navegador o desde una URL de retorno compartida.

**Por qué esta solución.** El token está ligado a una ventana de 45 s y, por diseño, ya no sirve
cuando el usuario termina de autenticarse (el magic link puede tardar). Conservarlo no aporta nada
funcional y sí crea un artefacto reutilizable en un lugar persistente. Descartarlo alinea el flujo
con la garantía que se quiere vender: **el registro requiere presencia física en el momento del
escaneo**.

**Dónde se implementa.** `src/app/scan/page.tsx` (redirect sin token) y el aviso de `/login`
(«Vuelve a escanear el QR»), Etapa 4.

**Tradeoff.** Un pequeño roce de UX para quien no había iniciado sesión; compensado con un mensaje
claro y con la sesión de larga duración del propio login.

### S-13 · Reconciliación periódica del contador de ocupación

**Decisión.** `ocupacion_actual` se actualiza transaccionalmente por trigger en cada cambio de
`sesiones`, pero además el job de los 5 minutos **recalcula la cifra con `COUNT(*)`** sobre las
sesiones abiertas y la reescribe si difiere. El valor nunca se «arrastra» indefinidamente.

**Amenaza.** Deriva del contador: un error a mitad de transacción, un cierre automático interrumpido o
un bug futuro dejan el número por encima o por debajo de la realidad. Un contador inflado produce un
semáforo «Lleno» falso; uno deflactado rompe la confianza en el sistema y podría usarse para ocultar
sobreaforo.

**Por qué esta solución.** Los contadores incrementales son rápidos pero acumulan error; los
recálculos son exactos pero caros si se hacen siempre. Este diseño combina ambos: camino rápido para
la latencia (trigger) y camino exacto periódico (job), con un índice parcial que hace el `COUNT`
barato. Además el snapshot que se guarda y el contador quedan coherentes entre sí.

**Dónde se implementa.** `..._triggers_ocupacion.sql` + `coworkflow_snapshot` (Etapa 2); el job es
la verificación oficial del invariante I6 de `docs/arquitectura.md`.

**Tradeoff.** La cifra puede estar desviada hasta 5 minutos en el peor caso, lo que es irrelevante
para un semáforo de aforo.

### S-14 · Verificación obligatoria de RLS después de aplicar migraciones a mano

**Decisión.** Como no hay Supabase CLI y las migraciones se pegan en el SQL Editor, cada aplicación
termina con un archivo de chequeos (`supabase/verificacion.sql`) que confirma: RLS activo en las
siete tablas, ausencia de políticas de escritura en las tablas de negocio, presencia de las políticas
públicas esperadas, que la publicación de Realtime contiene solo `ocupacion_actual`, que los jobs
existen y que `ocupacion_actual` tiene una fila por zona. Además, los tests de RLS (`tests/rls`)
verifican el comportamiento real con usuarios autenticados y anónimos.

**Amenaza.** Error humano en el despliegue: olvidar una política, dejar una tabla sin RLS o publicar
la tabla equivocada en Realtime. En Postgres, una tabla sin RLS no falla: **funciona**, y expone todo.

**Por qué esta solución.** El riesgo real de un despliegue manual no es que el SQL sea incorrecto,
sino que se aplique a medias. Un chequeo ejecutable convierte «creo que quedó bien» en una salida
verificable, y los tests de RLS cubren lo que una consulta al catálogo no puede probar (que un
usuario no lea datos ajenos).

**Dónde se implementa.** `supabase/verificacion.sql` (Etapa 2) y `tests/rls/**` (Etapa 6). El
protocolo está en `docs/arquitectura.md`, sección 8.

**Tradeoff.** Dos pasos extra por despliegue; se documenta como parte del procedimiento, no como
opcional.

### S-15 · Todo input validado y acotado con zod en el borde

**Decisión.** Los Route Handlers validan el cuerpo, los parámetros y los headers con esquemas zod:
tipo y longitud del token, `modo` acotado a un enum, `slug` con patrón, fechas ISO, límite de tamaño
del cuerpo, método HTTP permitido, `Content-Type` esperado y `Origin` de la petición contra
`NEXT_PUBLIC_SITE_URL`. Lo que no valida se rechaza con 400 sin tocar la base. Las variables de
entorno también se validan con zod al arrancar.

**Amenaza.** Entradas malformadas o maliciosas (cadenas gigantes, JSON inesperado, `zona` arbitraria,
CSRF desde otro origen) que provoquen errores 500, consultas costosas o escrituras con datos basura.

**Por qué esta solución.** Un esquema explícito define el contrato en un solo lugar y falla cerrado:
si el formato no está previsto, se rechaza. Verificar `Origin` en los `POST` cubre CSRF sin necesitar
tokens adicionales, porque la sesión viaja en cookie. Validar el entorno al arrancar evita el peor
escenario: arrancar «bien» con una clave vacía y fallar en producción.

**Dónde se implementa.** `src/lib/validacion/**`, `src/lib/env.ts` y los Route Handlers (Etapas 3–6).

**Tradeoff.** Más código de validación y mensajes de error que hay que traducir a lenguaje humano; se
resuelve con un mapeo centralizado de resultados.

---

## Etapa 2 — Esquema SQL, RLS y RPC

Esta etapa materializa en PostgreSQL lo diseñado en la Etapa 1 (8 tablas). Se agregan cinco
decisiones nuevas y la matriz de políticas RLS por tabla/rol.

### Matriz de políticas RLS (por tabla)

| Tabla | `anon` | `authenticated` | `admin` (rol) | `service_role` |
|-------|--------|-----------------|---------------|----------------|
| `profiles` | — | SELECT fila propia | SELECT todas | todo (bypass) |
| `zonas` | SELECT | SELECT | SELECT + INSERT/UPDATE/DELETE | todo |
| `sesiones` | — | SELECT propias (`user_id = auth.uid()`) | SELECT todas | todo |
| `eventos_scan` | — | — | SELECT | todo |
| `ocupacion_actual` | SELECT | SELECT | SELECT | todo |
| `snapshots_ocupacion` | SELECT | SELECT | SELECT | todo |
| `resumen_diario` | SELECT | SELECT | SELECT | todo |
| `app_secrets` | — | — | — | — (solo funciones DEFINER) |

Regla: **ninguna** tabla de negocio expone `INSERT/UPDATE/DELETE` a la API. La única escritura de
configuración permitida desde el cliente autenticado es `zonas`, y solo si `es_admin()`.

### S-16 · Verificación HMAC del token dentro de Postgres y secreto fuera del alcance del cliente

**Decisión.** El token QR `v1.<zona>.<modo>.<ventana>.<hmac>` se verifica con
`extensions.hmac(payload, secreto, 'sha256')` **dentro de** `registrar_scan()`. El secreto vive en
`app_secrets` (RLS activa, sin políticas, `SELECT` revocado a `anon`/`authenticated`) y solo se lee
mediante la función `SECURITY DEFINER` `obtener_secreto_qr()`. Si el secreto falta, la RPC falla
**cerrado** (`token_invalido`).

**Amenaza.** Escanear desde casa con una foto del QR (token de larga vida), o que la `anon key`
pública sirva para leer el secreto y falsificar tokens.

**Por qué esta solución.** La firma en la base garantiza que la validación no dependa de que el borde
tenga el secreto en memoria; aunque un atacante llame la RPC directamente, no puede forjar un token
válido ni leer el secreto. La ventana corta más la aceptación de la ventana actual y la anterior
(~90 s) limita la reutilización sin romper la experiencia.

**Dónde se implementa.** `..._rpc_registrar_scan.sql`, `..._enums_y_tablas.sql` (tabla `app_secrets`).
Se usa `extensions.hmac` porque pgcrypto vive en el esquema `extensions`.

**Tradeoff.** El secreto debe sincronizarse entre `app_secrets` y `QR_TOKEN_SECRET` del servidor; es
un paso manual documentado en `docs/modelo-datos.md`.

> **Actualización (S-22).** La comparación de firmas dentro de la RPC pasó de comparar el texto
> hex a comparar `extensions.digest(..., 'sha256')` de ambos lados. Ver S-22.

> **Actualización (2026-11-11) — cuál es la clave exacta del HMAC.** La clave **no** son los 32 bytes
> que representa el hex, sino el **texto** del secreto tal como está guardado: 64 caracteres ASCII =
> 64 bytes UTF-8. `extensions.hmac(payload, secreto, 'sha256')` recibe `secreto` como `text`, y del
> lado de Node `firmarHmacHex()` hace `new TextEncoder().encode(secretoHex)`. Esto se corrigió al
> detectar que Node decodificaba el hex (32 bytes) y Postgres usaba el texto (64 bytes): con claves
> distintas toda firma válida se rechazaba. La entropía efectiva sigue siendo de 256 bits (64 hex =
> 32 bytes aleatorios), aunque la clave HMAC mida 64 bytes. Detalle en el control de cambios y en S-26.

### S-17 · Límite de intentos inválidos por usuario (10/min) dentro de la RPC

**Decisión.** Antes de procesar el token, `registrar_scan()` cuenta los eventos **no exitosos** del
usuario en el último minuto; si son ≥ 10 devuelve `demasiados_intentos` **sin insertar** una fila
nueva. Además se serializa por usuario con `pg_advisory_xact_lock` para que el conteo y el cooldown
no tengan carreras.

**Amenaza.** Fuerza bruta del token (probar firmas), spam de intentos para inflar `eventos_scan` o
rasgar la base a bajo costo.

**Por qué esta solución.** El límite se aplica dentro de la misma transacción que la escritura, así
que no depende de un almacén externo ni se puede saltar con llamadas concurrentes. Al no insertar
filas cuando ya está bloqueado, el propio límite no se autoalimenta.

**Dónde se implementa.** `..._rpc_registrar_scan.sql`.

**Tradeoff.** Un usuario legítimo que acumule 10 fallos en un minuto espera hasta un minuto; es
aceptable porque el flujo normal es 1–2 escaneos. La capa de borde (Etapa 4, Upstash) agrega un
segundo límite por IP.

### S-18 · k-anonimato en estadísticas públicas

**Decisión.** `permanencia_promedio()` y `personas_distintas()` devuelven `NULL` si el rango tiene
menos de 5 sesiones, y rechazan rangos fuera de 1..93 días. Ambas son `SECURITY DEFINER` y solo
exponen agregados (nunca `user_id`).

**Amenaza.** Re-identificación con muestras pequeñas (p. ej. «en esta franja hubo 1 persona»), y
escaneos costosos sobre el histórico con rangos arbitrariamente grandes.

**Por qué esta solución.** El umbral k=5 evita publicar celdas que describan a una sola persona o a
muy pocas; acotar el rango protege el rendimiento y reduce la superficie de consulta.

**Dónde se implementa.** `..._stats.sql`.

**Tradeoff.** Zonas nuevas o franjas poco concurridas muestran «sin datos»; se prioriza privacidad.

> **Ampliación (S-21).** El mismo umbral k=5 se aplica al agregado `resumen_diario.permanencia_prom_seg`.
> Ver S-21.
>
> **Actualización (S-23).** El umbral ya no se cuenta sobre sesiones sino sobre **personas
> distintas** (`count(distinct user_id)`) del mismo conjunto que se agrega, el rango permitido pasa
> de 1..93 a **1..90 días** y `p_desde`/`p_hasta` se alinean a medianoche de la zona. Ver S-23.

### S-19 · `profiles.rol` blindado contra autopromoción

**Decisión.** `profiles` no tiene políticas de escritura y `rol` no es actualizable por
`authenticated`/`anon`. Un trigger `proteger_rol` bloquea el cambio de `rol` cuando el JWT es
`authenticated`/`anon`; el SQL Editor (sin JWT) y `service_role` sí pueden. El alta de admin es un
comando manual documentado.

**Amenaza.** Un usuario que edita su propio perfil podría autoasignarse `admin` y acceder a
`eventos_scan`, al historial y a `/admin`.

**Por qué esta solución.** Doble barrera (sin `UPDATE` + trigger) tolera que en el futuro se agregue
una política de `UPDATE` a `profiles` sin reabrir la escalada. Bloquear por rol del JWT (no por rol
de base) permite la operación legítima desde el panel SQL sin abrir la puerta a la app.

**Dónde se implementa.** `..._triggers_perfil.sql`, `..._rls_policies.sql`.

**Tradeoff.** Promover un admin exige un paso manual; es infrecuente y queda documentado.

### S-20 · Privilegios EXECUTE mínimos por función

**Decisión.** Tras crear cada función se ejecuta `revoke execute ... from public, anon,
authenticated`; luego se concede solo lo necesario: `registrar_scan` y `es_admin` a `authenticated`;
las dos funciones de estadísticas a `anon` y `authenticated`; **ninguna** función interna (triggers,
cron, `refrescar_ocupacion`, `obtener_secreto_qr`, `zona_abierta`) es invocable por la API.

**Amenaza.** Invocar por RPC funciones internas (`cron_*`, `refrescar_ocupacion`,
`obtener_secreto_qr`) que no validan identidad y podrían alterar el estado o filtrar el secreto.

**Por qué esta solución.** En Postgres, `EXECUTE` se concede a `PUBLIC` por defecto y Supabase además
lo concede a `anon`/`authenticated`; sin revocarlo explícitamente, todas las funciones quedarían
expuestas en `/rest/v1/rpc`. Revocar de `public, anon, authenticated` y conceder caso a caso deja el
mínimo necesario. `verificacion.sql` comprueba la matriz completa.

**Dónde se implementa.** Todas las migraciones (cada `create function`) y `supabase/verificacion.sql`.

**Tradeoff.** Más líneas de `revoke`/`grant`; se automatiza la verificación para no depender de la
memoria.

### S-21 · El umbral k=5 también se aplica a `resumen_diario.permanencia_prom_seg`

**Decisión.** `resumen_diario.permanencia_prom_seg` pasa a ser **nullable** (sin `default 0`) y
`cron_resumen_diario()` la escribe como `NULL` cuando el día tiene `sesiones_cerradas < 5`.
`stats.sql` mantiene el mismo umbral con una constante explícita, `c_k_anonimato = 5`, igual que
la del job. Es la extensión de S-18 a la tabla de agregados.

**Amenaza.** `resumen_diario` es legible por `anon` y `authenticated` (dashboard público). Un día
con 1 a 4 sesiones cerradas publicaba un promedio exacto (p. ej. «7 h 20 min») que, cruzado con
el horario conocido del Hub, permite inferir la jornada de una persona identificable. Peor aún,
el `default 0` convertía «no hay dato suficiente» en un valor que se lee como dato real.

**Por qué esta solución.** El umbral se aplica **donde se calcula el agregado**, así que no
depende del cliente ni de la consulta: si el dato no es publicable, simplemente no se escribe.
`NULL` es la misma convención que ya usan `permanencia_promedio()` y `personas_distintas()`, de
modo que el frontend tiene una sola regla: `NULL` = «sin datos». Además `NULL` no participa en
`avg()` ni en sumas, así que no contamina reportes posteriores; un `0` sí lo haría.

**Dónde se implementa.** `..._enums_y_tablas.sql` (columna nullable + `comment on column`),
`..._pg_cron_jobs.sql` (`cron_resumen_diario`, constante `c_k_anonimato`) y `..._stats.sql`
(misma constante en las dos funciones públicas).

**Tradeoff.** Días con poco movimiento muestran «sin datos» en vez de un promedio, y el dashboard
tiene que tratar `NULL` explícitamente (sin `coalesce(..., 0)`). Se acepta porque un promedio
sobre <5 personas distintas no es estadísticamente útil y sí es re-identificable.

> **Actualización (S-23/S-24).** El umbral se cuenta sobre personas distintas del conjunto promediado
> y el promedio usa solo sesiones con `cierre = 'usuario'`. Ver S-23 y S-24.

### S-22 · Comparación de firmas por `digest` en `registrar_scan`

**Decisión.** La firma recibida en el token y la firma esperada se comparan como
`extensions.digest(<texto>, 'sha256')` (bytea de 32 bytes) con `is distinct from`, en lugar de
comparar el texto hex con `<>`. Refina la verificación de S-16 sin cambiar el formato del token.

**Amenaza.** Un canal lateral de temporización: una comparación de cadenas puede filtrar, por el
tiempo de respuesta, cuántos caracteres iniciales del HMAC coinciden, lo que en teoría permite
reconstruir una firma válida carácter a carácter. También los casos de borde del texto recibido:
una firma de longitud arbitraria (o con mayúsculas o basura) que se compara contra un hex de
64 caracteres.

**Por qué esta solución.** Reducir ambos lados a SHA-256 antes de comparar hace que (a) la
comparación opere siempre sobre **32 bytes de longitud fija**, independiente del largo del texto
recibido, de modo que el tiempo ya no depende de cuántos caracteres coinciden al inicio, y
(b) normalice la entrada. `is distinct from` evita que un `NULL` inesperado haga que la condición
se evalúe como `NULL` (que en un `if` de PL/pgSQL no es «verdadero»), o sea, mantiene el
comportamiento de **fallar cerrado**.

**Dónde se implementa.** `..._rpc_registrar_scan.sql`, paso 4 de `registrar_scan()`.

**Tradeoff y límite honesto.** Es una **mitigación**, no una prueba de tiempo constante:
PostgreSQL no expone una comparación de tiempo constante en SQL y el planificador puede reordenar
trabajo. Se acepta como defensa en profundidad porque el riesgo real ya está acotado (se necesita
sesión autenticada, el cooldown de 30 s y el límite de 10 intentos inválidos/min). Si en el futuro
la verificación se mueve al borde (Route Handler), conviene `crypto.timingSafeEqual` de Node, que
sí es de tiempo constante.

### S-23 · k-anonimato por personas distintas, día calendario de la zona y rango de 1..90 días

**Decisión.** Tres ajustes sobre S-18/S-21:

1. **La unidad del umbral es la persona, no la sesión.** `permanencia_promedio()`,
   `personas_distintas()` y `cron_resumen_diario()` exigen `count(distinct user_id) >= 5` sobre
   **el mismo conjunto** que usan para calcular (no `count(*)` de sesiones).
2. **Día calendario de la zona.** `p_desde` y `p_hasta` se alinean a medianoche local:
   `date_trunc('day', x at time zone z.timezone) at time zone z.timezone`, y la zona se lee de
   `zonas.timezone`. El rango es **semiabierto** `[día(p_desde), día(p_hasta))` y se acota a
   **1..90 días** completos (la retención de datos crudos); si los dos extremos caen el mismo día
   calendario el rango queda vacío y se devuelve `NULL`, no una celda de minutos.
3. **Límite declarado.** El k-anonimato **no** elimina los ataques por diferencia entre rangos
   (ver más abajo).

**Amenaza.**

- *Re-identificación por conteo de sesiones:* una sola persona que visita el cowork todos los días
  generaba 20–30 sesiones al mes y por sí sola alcanzaba `k = 5`, de modo que el «promedio» publicado
  era esencialmente su permanencia. El umbral estaba midiendo registros, no personas.
- *Celdas no alineadas:* con extremos libres (por ejemplo `12:00–12:15`) el público podía interrogar
  el sistema con granularidad de minutos y reconstruir horarios de entrada/salida sin salir del rango
  permitido; además el mismo día calendario daba resultados distintos según la hora de la consulta y
  la zona horaria del servidor (UTC).
- *Rangos mayores que la retención:* pedir 93 días ya devolvía datos parciales (los crudos se purgan a
  los 90) sin decirlo, y consultas muy grandes son trabajo gratis para el servidor.

**Por qué esta solución.** La unidad de riesgo es la persona: `count(distinct user_id)` mide
exactamente cuántos individuos distintos hay detrás de una celda, así que 30 sesiones de una persona
siguen siendo `k = 1` y no se publican. Alinear a medianoche local elimina el borde arbitrario (no se
puede «pedir» una franja de 15 minutos) y hace que el rango sea interpretable como días de la zona. El
tope de 90 días coincide con lo que realmente existe en la tabla, de modo que el resultado no depende
de cuándo se purgó, y acota el costo de la consulta.

**Dónde se implementa.** `..._stats.sql` (`permanencia_promedio`, `personas_distintas`),
`..._pg_cron_jobs.sql` (`cron_resumen_diario`) y, desde la Etapa 5, la migración 9
(`ocupacion_por_franja` con lista cerrada `7|30`; ver S-37 y S-38).

**Tradeoff.** Un rango que no empieza ni termina a medianoche se redondea hacia abajo (el usuario
recibe algo distinto de lo que pidió, pero determinista); en particular, un rango intra-día devuelve
`NULL`, así que el dashboard debe enviar límites de día (de la zona, no de UTC) y no «últimas 24 h»
desde la hora actual. Zonas con pocas personas muestran «sin datos» durante más tiempo que antes.

#### Límite: el k-anonimato no elimina los ataques por diferencia entre rangos

**Qué queda abierto.** El umbral protege *cada celda publicada*, no la *diferencia entre dos celdas*.
Como `personas_distintas()` y `permanencia_promedio()` aceptan rangos arbitrarios de 1..90 días, se
puede restar: `f(1–8 nov) − f(1–7 nov)` aislando el valor del 8 de noviembre aunque ese día, solo, no
alcance `k = 5`. Con dos o tres consultas solapadas se puede despejar el conteo o la permanencia de un
día concreto, y la alineación a medianoche no lo impide (solo impide granularidad sub-diaria).

**Por qué se acepta.** Las mitigaciones reales —ruido diferencial calibrado, exigir `k` sobre cada
celda derivada (lo que prohíbe todo rango que contenga una celda pequeña), o un presupuesto de
consultas por usuario— agregan complejidad y coste desproporcionados para un proyecto universitario, y
el dato protegido es la ocupación de un espacio físico, no información sensible por categoría especial
(no hay datos de salud, biometría ni geolocalización). Se documenta porque el informe debe declararlo:
k-anonimato ≠ privacidad diferencial.

**Estado real de la mitigación (Etapa 5).** La UI del dashboard solo ofrece dos ventanas cerradas
(7 y 30 días) y `ocupacion_por_franja` valida esa lista dentro de la RPC; sin embargo,
`permanencia_promedio` y `personas_distintas` siguen siendo invocables directamente con
`p_desde`/`p_hasta` libres (1..90 días) porque la anon key es pública. Tampoco se añadió rate
limit por IP a las lecturas: el dashboard es un RSC (no hay una ruta HTTP propia) y aplicar
Upstash a lecturas consumiría la cuota gratuita de ~10k comandos/día; además su política de falla
cerrada tumbaría el dashboard público ante un fallo de Redis. Queda como **limitación conocida**;
la mitigación futura es exponer funciones de ventana fija (un entero cerrado en vez de fechas) y/o
revocar `EXECUTE` a `anon` de las funciones de rango libre. Ver S-37.


### S-24 · Permanencia solo con `cierre = 'usuario'` y salida del cierre automático acotada a 8 h

**Decisión.** `cron_cierre_auto()` escribe
`salida_at = least(now(), s.entrada_at + interval '8 hours')` y `permanencia_promedio()` /
`resumen_diario.permanencia_prom_seg` promedian **solo** sesiones con `cierre = 'usuario'`.

**Amenaza.** Sesión olvidada: sin tope, el cierre automático grababa `salida_at = now()`, es decir, la
hora en que corrió el job (hasta 15 min después, o a la mañana siguiente si el job falló). Eso
registraba permanencias de 12–15 h que nunca ocurrieron, inflaba el promedio y escondía la rotación
real del espacio. Mezclar esos cierres «administrativos» con cierres reales contamina cualquier
métrica de permanencia y, además, hacía el dato no reproducible (dependía de cuándo corrió el cron).

**Por qué esta solución.** `least(now(), entrada_at + 8 h)` conserva el mejor dato disponible en cada
caso: si el cierre es por **fin de horario** y la sesión lleva menos de 8 h, gana `now()` (la hora real
del cierre); si la sesión **superó el tope**, gana `entrada_at + 8 h`, que es determinista y no depende
del retraso del job. El `check` de coherencia (`salida_at` y `cierre` nulos o ambos no nulos) se sigue
cumpliendo y `least()` nunca produce una salida anterior a la entrada. Filtrar por
`cierre = 'usuario'` en las estadísticas es la otra mitad: un cierre automático es una decisión del
sistema, no una medición, así que no debe entrar en un promedio que se presenta como «permanencia
real». `resumen_diario` sigue contando **todos** los cierres en `sesiones_cerradas` (columna de
volumen), pero el promedio usa solo las sesiones cerradas por la persona.

**Dónde se implementa.** `..._pg_cron_jobs.sql` (`cron_cierre_auto`, `cron_resumen_diario`),
`..._stats.sql` (`permanencia_promedio`).

**Tradeoff.** Quien se queda 10 h aparece con 8 h: el sistema mide ocupación, no asistencia, y no hay
forma de distinguir «se olvidó el check-out» de «se quedó 10 h». Los días en que casi todos los cierres
son automáticos pueden quedar sin permanencia publicable (efecto combinado con S-23: menos personas
distintas con `cierre = 'usuario'`).


### Limitación conocida: el token es reutilizable dentro de su ventana (~90 s)

**Qué queda abierto.** Un token válido puede usarse más de una vez mientras esté dentro de la
ventana aceptada (actual + anterior, hasta ~90 s). No hay nonce de un solo uso por token.

**Por qué se aceptó.** Un nonce por token exigiría almacenar los tokens emitidos y limpiarlos, y
complica el QR rotativo; el costo/beneficio para un proyecto universitario no lo justifica. El daño
está acotado por otras capas: cooldown de 30 s por usuario, límite de 10 intentos inválidos/min,
regla de una sola sesión abierta por usuario y cierre automático.

**Mitigación opcional.** Validación de **geolocalización** (con consentimiento) como fallback: aunque
el token esté vigente, un escaneo fuera del radio del Hub se rechaza. Está prevista como opcional en
`docs/arquitectura.md` (fallback de QR estático + geolocalización).

---

## Etapa 3 — Autenticación y tokens QR

### S-25 · El consentimiento informado es condición para registrar un escaneo

**Decisión.** Se agregó el valor `sin_consentimiento` al enum `resultado_scan` y un gate al principio
de `registrar_scan`: si `profiles.consentimiento_at` es `NULL`, la función devuelve
`sin_consentimiento` **antes de cualquier escritura** (tampoco deja fila en `eventos_scan`). La
aceptación se guarda con una RPC dedicada, `registrar_consentimiento(p_version)`, que toma el
`user_id` de `auth.uid()` y es la única vía de escritura sobre esas columnas.

**Amenaza.** Tratar datos personales (horarios de entrada y salida) sin base legal ni aviso, lo que
la Ley 21.719 sanciona. Además, un gate solo en la interfaz se salta con DevTools o llamando la RPC
directamente: el consentimiento tiene que ser una precondición del servidor.

**Por qué esta solución.** El gate vive en la misma RPC `SECURITY DEFINER` que ya era la única puerta
de escritura, así que no hay forma de registrar una sesión sin consentimiento, ni con la `anon key`.
Devolver un enum en vez de lanzar una excepción mantiene el contrato de la RPC (todos los resultados
son estados de negocio) y permite mostrar un mensaje claro. La interfaz usa **el mismo criterio**
(`consentimiento_at IS NOT NULL`, en `src/lib/dominio/consentimiento.ts`) para no ofrecer un botón que
el servidor va a rechazar. La versión se versiona aparte (`consentimiento_version`) y el borde exige
que coincida con la que se mostró, para no registrar la aceptación de un texto que nadie leyó.

**Dónde se implementa.** `supabase/migrations/20261110000000_consentimiento_y_scan.sql`,
`src/app/api/consentimiento/route.ts`, `src/components/auth/AvisoConsentimiento.tsx`,
`src/lib/dominio/consentimiento.ts`.

**Tradeoff.** Un usuario sin consentimiento queda fuera del sistema (el dashboard público le sigue
funcionando). El `ALTER TYPE ... ADD VALUE` no se puede usar en la misma transacción en la que se
agrega: la migración lo deja en un bloque aislado al inicio y obliga a ejecutarlo primero. Si en el
futuro cambia el texto, hay que subir `CONSENTIMIENTO_VERSION` **y** agregar la comparación de
versión en la RPC; hoy "tener consentimiento" es solo "tener fecha de aceptación".

### S-26 · El token del QR se firma solo en el servidor y se entrega ya renderizado

**Decisión.** `GET /api/qr/token` (solo admin) calcula la ventana, arma `v1.<zona>.<modo>.<ventana>`,
firma con HMAC-SHA256 (Web Crypto) usando `QR_TOKEN_SECRET` y devuelve el **SVG ya generado** con
`qrcode`, además del token y los segundos restantes. El secreto vive en `src/lib/env.server.ts`, que
está marcado `import "server-only"`; `src/lib/qr/token.ts` no lee variables de entorno: recibe el
secreto como argumento.

**Amenaza.** Si la firma ocurriera en el navegador, la clave HMAC tendría que viajar al cliente (o
estar en una variable `NEXT_PUBLIC_`), y cualquiera podría emitir tokens válidos desde su casa: el QR
rotativo dejaría de probar presencia física.

**Por qué esta solución.** Firmar en el servidor mantiene la clave fuera del bundle, y `server-only`
convierte un import accidental desde un Client Component en un error de build en vez de una filtración
silenciosa. Devolver el SVG evita exponer la URL canjeable como texto manipulable en el DOM. La
tolerancia de una ventana anterior (≈90 s en total) es la mínima que absorbe el retraso real de un
escaneo con cámara nativa, y la verificación de la firma sigue ocurriendo en Postgres (S-16), así que
un token fabricado sin el secreto no pasa de la RPC.

**Dónde se implementa.** `src/app/api/qr/token/route.ts`, `src/lib/qr/token.ts`, `src/lib/qr/imagen.ts`,
`src/components/qr/QrRotativo.tsx`, `src/lib/env.server.ts`.

**Tradeoff.** El admin que abre `/qr` recibe tokens válidos en su navegador (tiene el rol, es de
confianza). Rotar `QR_TOKEN_SECRET` invalida todos los QR emitidos al instante, así que hay que rotarlo
también en `app_secrets`; si solo se rota uno de los dos, todos los escaneos fallan con
`token_expirado` (falla cerrado, pero rompe el check-in).

**Nota (2026-11-11) — la clave de firma y un vector de prueba.** El secreto se pasa a Web Crypto como
**texto UTF-8** (`new TextEncoder().encode(secretoHex)`), no como los 32 bytes decodificados del hex,
para que coincida con `extensions.hmac(text, text, 'sha256')` de Postgres (S-16). Vector fijado para
el test de Vitest de la Etapa 6: `firmarHmacHex("v1.00000000-0000-4000-8000-000000000000.entrada.123",
"ab".repeat(32))` debe devolver `fd5034f93e12180c2b8169e2cac20f53a0de3848fb6b046186bfc1138fa5bdef`.
Comprobado con `node:crypto` usando el texto del secreto como clave.

### S-27 · Autorización con `getClaims()` y rol leído de `profiles`; `next` saneado

**Decisión.** `src/lib/auth/guards.ts` expone `requireUser`, `requireConsentimiento` y `requireAdmin`.
Todos usan `supabase.auth.getClaims()` (nunca `getSession()`) y `requireAdmin` consulta
`profiles.rol` **en cada llamada**, sin cachear el rol entre peticiones. Sin sesión → `redirect` a
`/login?next=…`; con sesión sin permiso → `forbidden()` (403). El parámetro `next` de
`/auth/callback` pasa por `normalizarDestinoInterno`, que solo acepta rutas internas.

**Amenaza.** (a) Sesión falsificada: `getSession()` devuelve el contenido de la cookie sin verificar la
firma, así que un token manipulado a mano se tomaría como usuario válido. (b) Escalada de privilegios:
un JWT con `role: admin` o un rol que el usuario ya no tiene. (c) *Open redirect*: un enlace de correo
legítimo con `?next=https://otro-sitio` usado para phishing.

**Por qué esta solución.** `getClaims()` valida la firma del JWT (o la delega a Auth si el proyecto
usa firma simétrica); `getUser()` daría la misma garantía con una llamada de red más por request.
Leer el rol de `profiles` en cada llamada hace que quitar permisos tenga efecto inmediato y que el
`role` del token sea irrelevante (el token no decide nada). Para `next` se exige que empiece con `/`,
que no sea `//` ni contenga `\` o caracteres de control, y se verifica con `new URL()` que el origen no
cambie **y que el resultado siga siendo una ruta interna** (ver hallazgo); cualquier intento cae al
destino por defecto. Los guards se ejecutan en la página o el Route
Handler, no en el proxy: así no hay rutas "olvidadas" fuera del matcher y no se depende de un control
que la documentación de Next desaconseja para autorización.

**Hallazgo (2026-11-10) — se validaba la entrada, no el resultado.** `normalizarDestinoInterno`
comprobaba `//`, la barra invertida y el origen **antes** de parsear, pero el parser colapsa los
segmentos `.` y `..`: `/..//evil.com`, `/.//evil.com` y `/a/..//evil.com` pasan los filtros de entrada,
conservan `origin === base` y aun así normalizan a `//evil.com`. Ese valor se devolvía tal cual, y el
navegador lo interpreta como URL protocol-relative, de modo que el «anti open-redirect» quedaba anulado
(`router.replace("//evil.com")` saca al usuario del sitio). La corrección valida también el
**resultado** de `new URL()`: si empieza con `//` o contiene `\`, cae a `DESTINO_POR_DEFECTO`. Los casos
—`/..//evil.com`, `/.//evil.com`, `/a/..//evil.com`, `//evil.com`, `/\evil.com`, `https://evil.com`
deben caer; `/qr`, `/scan?modo=entrada`, `/dashboard#x` deben pasar— quedan listados junto a la función
para convertirlos en tests de Vitest en la Etapa 6.

**Dónde se implementa.** `src/lib/auth/session.ts`, `src/lib/auth/guards.ts`,
`src/lib/auth/redirects.ts`, `src/app/qr/page.tsx`, `src/app/api/qr/token/route.ts`,
`src/app/auth/callback/route.ts`.

**Tradeoff.** Una consulta extra a `profiles` por render protegido (barata, con índice por PK) y una
redirección visible a `/login` en lugar de un 401 elegante. La página `/qr` y su API repiten el guard,
que es intencional: la API no confía en que solo la página la llame.

### S-28 · `signout` solo por `POST` y verificación de origen en las mutaciones

**Decisión.** `/auth/signout` acepta únicamente `POST` y responde `303` a `/login`. Tanto esa ruta
como `POST /api/consentimiento` empiezan con `peticionDelMismoOrigen(request)`: si viene `Origin`, se
compara con el origen de la petición; si no, se exige `Sec-Fetch-Site: same-origin|none`. Un GET a
`/auth/signout` devuelve 405.

**Amenaza.** *CSRF de logout*: cualquier página puede incrustar `<img src="https://app/auth/signout">`
y desconectar al usuario (o forzarlo a repetir el ingreso). *CSRF en mutaciones*: los Route Handlers
no tienen la protección que Next aplica a las Server Actions, así que un formulario en otro sitio
podría enviar `{version: 1}` en nombre del usuario y registrar un consentimiento que no otorgó.

**Por qué esta solución.** Cambiar el verbo quita la superficie más barata (una imagen o un enlace
precargado ya no dispara la acción) y la comprobación de origen bloquea el POST cross-site incluso si
el navegador envía las cookies de sesión, que es justo lo que `SameSite=Lax` no cubre en todos los
casos. Se implementó como helper compartido para que la Etapa 4 lo reutilice en `/api/scan` sin
reinventarlo.

**Dónde se implementa.** `src/app/auth/signout/route.ts`, `src/app/api/consentimiento/route.ts`,
`src/lib/http/origen.ts`.

**Tradeoff.** Los clientes que no envían `Origin` ni `Sec-Fetch-Site` (curl, scripts) reciben 403; es
aceptable porque esas rutas son para el navegador. La comprobación depende de que el despliegue no
reescriba el host (`NEXT_PUBLIC_SITE_URL` y el dominio real deben coincidir).

### S-29 · Login en el servidor: errores de autenticación genéricos y rate limit propio (S-35)

**Decisión.** `POST /auth/login` devuelve códigos de error genéricos que **no** revelan si un correo
está registrado: el registro fallido responde siempre «No se pudo completar el registro. Si ya tienes
cuenta, inicia sesión o pide un enlace por correo», y el login con contraseña usa
`credenciales_invalidas` para correo o contraseña erróneos (no distingue cuál falló). El endpoint exige
`Content-Type: application/json` además de la verificación de mismo origen (S-28) y valida el cuerpo
con zod (S-15). El mínimo de contraseña en zod es **10**, igual que el configurado en Supabase Auth, y
`weak_password` tiene su propio mensaje. El `emailRedirectTo` del enlace mágico se arma con
`NEXT_PUBLIC_SITE_URL` (validada al arrancar), nunca con `request.url` ni la cabecera `Host`.

**Amenaza.** *Enumeración de cuentas*: si el registro respondiera «ese correo ya existe», un atacante
podría averiguar qué personas tienen cuenta probando correos, lo que ya es un dato personal y facilita
ataques dirigidos (phishing, credential stuffing). *Envenenamiento de `Host`*: construir el redirect
del correo desde la cabecera `Host` permitiría desviar el enlace mágico a un dominio controlado por el
atacante.

**Por qué esta solución.** Al mover la autenticación al servidor, los mensajes se generan en un solo
punto y no dependen de que el navegador traduzca bien los códigos de Supabase. Los códigos propios
(no los de Supabase) evitan que un cambio de la librería filtre un mensaje distinto para «cuenta
inexistente» o «contraseña incorrecta». El `emailRedirectTo` se calcula con la URL pública validada,
así que una cabecera falsificada no cambia el destino del correo.

**Rate limit (resuelto en la Etapa 4).** El `TODO` se cerró con dos cubos antes de tocar Supabase:
30 intentos/15 min por IP y 5/15 min por hash de correo (S-35), reutilizando `src/lib/rate-limit.ts`
(S-08). Sigue siendo cierto que los límites de Supabase Auth son **globales para el proyecto**: como
las peticiones salen del servidor (Vercel), Supabase ve la IP del servidor y no la del usuario, así
que su límite por IP agrupa a todos los usuarios. Por eso el rate limit propio de la app es
imprescindible antes de producción, y ahora es la primera barrera que se aplica.

**Alcance real de la anti-enumeración (limitación conocida en desarrollo).** La igualdad de respuestas
solo es completa con **«Confirm email» activado** en Supabase Auth. Con la confirmación **desactivada**,
`signUp` devuelve sesión de inmediato cuando el correo es nuevo, mientras que con un correo ya
registrado no devuelve sesión y el endpoint responde con el mensaje genérico de registro: esa
diferencia (hay sesión / no la hay) **revela qué correos tienen cuenta**. Es una limitación conocida y
aceptada **en desarrollo**, donde la confirmación se apaga para no gastar los envíos limitados del plan
gratuito; antes de producción hay que activar «Confirm email» o dejar de distinguir los dos casos
(responder siempre con el aviso neutro del enlace mágico, sin iniciar sesión desde el registro).

**Errores inesperados y logs.** La llamada a `ejecutarAccionAuth` va dentro de `try/catch`: si lanza
(Supabase 5xx, red, bug de la librería) el endpoint responde `500` con `{ ok: false, codigo: "generico" }`
y `Cache-Control: no-store`, y registra **solo `error.name`**. Nunca se registra el correo, la contraseña
ni el objeto de error completo: el cuerpo de la petición contiene credenciales y los errores de las
librerías suelen arrastrar el payload en `details`/`cause`, así que escribirlos en los logs de Vercel
sería una fuga de credenciales y de datos personales (Ley 21.719). Por la misma razón el cliente
(`FormularioLogin`) tolera cualquier respuesta que no sea un JSON con `ok` booleano —incluidos 400,
403, 415 y 500— y muestra el mensaje genérico, sin reflejar el texto del servidor.

**Dónde se implementa.** `src/app/auth/login/route.ts`, `src/lib/auth/acciones.ts`,
`src/lib/validacion/auth.ts`, `src/lib/dominio/auth.ts`, `src/lib/supabase/cookies.ts`.

**Tradeoff.** Los mensajes genéricos empeoran ligeramente la experiencia de registro, y el rate limit
propio (S-35) agrega un eje de indisponibilidad: si Upstash no responde, el login falla **cerrado**
(500 `generico`) en lugar de degradarse a «sin límite», así que una caída de Upstash deja fuera a
todos, no solo al atacante.

---

## Etapa 4 — Scan en el borde

### S-30 · Rate limit de borde con Upstash: dos cubos por endpoint y falla cerrada

**Decisión.** `src/lib/rate-limit.ts` expone `limitarPorIp()` y `limitarPorUsuario()` sobre Upstash
Redis (`@upstash/ratelimit`, ventana deslizante y un `prefix` de Redis por cubo) y aplica cuatro cupos:

| Endpoint | Cubo | Límite | Clave que se consume |
| --- | --- | --- | --- |
| `POST /api/scan` | IP | 60/min | `hashIp(ip)` (S-31) |
| `POST /api/scan` | usuario | 10/min | `usuario:<uuid>` |
| `POST /auth/login` | IP | 30/15 min | `hashIp(ip)` |
| `POST /auth/login` | correo | 5/15 min | `hashCorreo(correo)` (S-35) |

Los valores viven en constantes (`LIMITE_SCAN_POR_IP`, `LIMITE_SCAN_POR_USUARIO`,
`LIMITE_LOGIN_POR_IP`, `LIMITE_LOGIN_POR_CORREO`) para poder calibrarlos sin tocar las rutas. El cupo
por IP de `/api/scan` es holgado a propósito: en el NAT del cowork muchas personas comparten IP, así
que el límite fino es el de usuario.

**Orden de las comprobaciones (de lo más barato a lo más caro).**

- `/api/scan`: mismo origen (S-28) → `Content-Type: application/json` → **límite por IP** → tamaño
  (1 KiB) y parseo del cuerpo → sesión → **límite por usuario** → zod → RPC.
- `/auth/login`: mismo origen (S-28) → `Content-Type` → **límite por IP** → parseo y zod →
  **límite por correo** → acción de Auth.

El límite por IP va antes de leer el cuerpo porque frena el barrido de tokens incluso sin cookie
válida y no gasta memoria ni CPU en JSON ajeno; el de usuario, que es el fino, solo se puede aplicar
cuando ya hay una sesión verificada. En el login, el cupo por correo se consume después de zod porque
necesita un correo ya normalizado (mayúsculas y espacios caen en el mismo cubo) y antes de llamar a
Supabase, para no gastar envíos del plan gratuito.

**Falla cerrada.** Sin credenciales de Upstash en producción, `credencialesUpstash()` lanza y la ruta
responde `500 error_interno` (en `/auth/login`, `500 generico`); en desarrollo (`NODE_ENV !==
"production"`) se usa un contador en memoria que avisa una sola vez por consola y separa los cubos por
`prefijo`, de modo que `scan:ip` y `login:ip` no se mezclan. La falta de credenciales se valida **al
usar** el limitador, no al importar, para no exigir el servicio durante `next build`.

**El timeout de Upstash es fail-open y aquí se convierte en error.** Ante una llamada lenta,
`@upstash/ratelimit` (2.2.0) devuelve `{ success: true, reason: "timeout" }`: deja pasar la petición.
`limitar()` detecta `reason === "timeout"` (5 000 ms por defecto; no se configura un valor propio) y
**lanza**, así que el endpoint responde 500 en vez de aceptar tráfico sin límite justo cuando la
infraestructura está degradada, que es cuando un atacante insistiría.

**Amenaza.** Ráfagas automatizadas y barrido de tokens contra `/api/scan`; fuerza bruta de contraseñas
y spam de enlaces mágicos contra `/auth/login`; agotar las cuotas gratuitas de Upstash, de Supabase
Auth y de correo. Y, en general, cualquier contador en memoria: en serverless cada invocación es un
proceso distinto, así que un contador local no limita nada en producción.

**Por qué esta solución.** La ventana deslizante evita el agujero clásico de la ventana fija (donde 2×
el límite cabe en un instante a caballo del cambio de ventana) y Upstash es el estado compartido que el
diseño serverless exige; el plan gratuito alcanza porque solo se consume en dos endpoints de escritura,
nunca en las lecturas del dashboard. Dos cubos por endpoint cubren dos atacantes distintos: el que
rota cuentas desde una IP (lo frena el de IP) y el que tiene una cuenta y abusa de ella (lo frena el de
usuario).

**Dónde se implementa.** `src/lib/rate-limit.ts`, `src/app/api/scan/route.ts`,
`src/app/auth/login/route.ts`, `src/lib/env.server.ts` (`credencialesUpstash`).

**Tradeoff.** La IP es una **cuota compartida** en el NAT del cowork: un solo usuario con un script
puede agotar los 60/min de la IP y dejar sin cupo a las demás personas de la red hasta que la ventana
avance (se recupera solo, pero el efecto es real; la alternativa —solo cupo por usuario— dejaría
abierto el barrido anónimo). Además, Upstash es una dependencia externa: si se cae o se agota la
cuota, scan y login fallan cerrados en vez de degradarse.

### S-31 · IP solo de `x-vercel-forwarded-for`, hasheada con HMAC y sin valor en claro

**Decisión.** `obtenerIp()` lee **únicamente** la cabecera `x-vercel-forwarded-for`, toma el primer
valor y lo normaliza: quita corchetes, puerto y zona (`%eth0`); una IPv4 mapeada (`::ffff:a.b.c.d`) se
trata como IPv4; una IPv6 se reduce a su prefijo **/64**. Si en producción la cabecera falta o no se
puede interpretar, devuelve `null` y `limitarPorIp()` responde «no permitido» sin consultar Redis:
**falla cerrado**. No hay fallback a `x-forwarded-for`, `x-real-ip` ni a ninguna otra cabecera. El
valor nunca se guarda en claro: la clave que se consume es `hashIp(ip)` = HMAC-SHA256 **hex completo de
64 caracteres** (sin truncar) sobre `rate-limit:ip:v1:<ip>`.

**Amenaza.** Que el propio atacante elija su cubo de rate limit enviando la cabecera que el código lea:
si se aceptara una cabecera reenviada sin depurar, bastaría rotar un valor falso en cada petición para
tener cupo infinito y, de paso, envenenar el cubo de otra persona. Y que Redis termine guardando IPs en
claro, que son datos personales (Ley 21.719) y permitirían perfilar quién pasó por el cowork.

**Por qué esta solución.** Según la documentación de Vercel, la plataforma **sobrescribe
`X-Forwarded-For`** y no reenvía IPs externas, así que dentro de Vercel esa cabecera no la controla el
cliente; el riesgo aparece **fuera** de Vercel (otro hosting, un proxy propio mal configurado o un
`next start` local), donde una cabecera «forwarded» sí puede contener lo que mande el cliente. Por eso
se elige la cabecera que fija la edge de Vercel y se cierra cualquier otra vía de entrada, sin depender
de cómo esté configurado el despliegue. El hasheo con HMAC (y no un hash simple) evita el ataque de
diccionario: el espacio de IPv4 es pequeño y un SHA-256 sin clave se revierte probando las 2^32
direcciones; sin el secreto, un volcado de Redis no permite reconstruir la IP. El prefijo de dominio
separa este uso del de los tokens QR. Reducir IPv6 a /64 refleja cómo asigna direcciones la red: la
parte baja suele rotar por privacidad y, sin el recorte, un cliente tendría miles de millones de cubos.

**Por qué la IP fija en desarrollo.** Con `NODE_ENV=development` se usa `127.0.0.1` y no se leen
cabeceras: así una prueba local no puede «elegir» su cupo y el comportamiento es igual en cualquier
máquina. La contrapartida es que todos los escaneos y logins locales comparten ese cubo, y cuando se
agota hay que reiniciar el servidor de desarrollo.

**Dónde se implementa.** `src/lib/rate-limit.ts` (`obtenerIp`, `normalizarIp`, `prefijoIpv6`, `hashIp`,
`limitarPorIp`).

**Tradeoff.** Se reutiliza `QR_TOKEN_SECRET` como clave HMAC con prefijos de dominio
(`rate-limit:ip:v1:`, `rate-limit:email:v1:`) en lugar de crear otro secreto que habría que guardar,
validar y rotar; el costo es que rotar `QR_TOKEN_SECRET` cambia todos los hashes y, de hecho, reinicia
los cubos en curso, y que un mismo secreto protege dos cosas. Además, `next start` local corre con
`NODE_ENV=production` y sin `x-vercel-forwarded-for`: `obtenerIp()` devuelve `null` y `limitarPorIp()`
responde «no permitido» sin consultar Redis ni tocar las credenciales de Upstash, así que allí
`/api/scan` y `/auth/login` devuelven **siempre** 429 `rate_limited`. No hay 500 por Upstash en ese caso
porque el limitador ni se invoca; la verificación local se hace con `npm run dev`.

### S-32 · `Referrer-Policy: strict-origin` en `/scan` y `replaceState` al montar

**Decisión.** Tres medidas sobre la URL que lleva el token (`/scan?modo=…&t=…`):

1. El proxy emite `Referrer-Policy: strict-origin` para `/scan` y
   `strict-origin-when-cross-origin` para el resto. `esRutaScan()` compara solo el `pathname`, así que
   la query string no puede alterar la decisión.
2. La página declara además `referrer: "strict-origin"` en su metadata, que Next renderiza como
   `<meta name="referrer">`: defensa en profundidad si el documento se sirve sin pasar por el proxy.
3. Al montar, `ConfirmacionScan` hace `window.history.replaceState(null, "", "/scan")` dentro de un
   `try/catch`: borra `?modo` y `?t` de la barra de direcciones y de la entrada actual del historial.
   El token queda en las props del componente, así que el `POST /api/scan` y los reintentos siguen
   funcionando.

**Amenaza.** Fuga del token por `Referer` (al cargar un recurso de terceros o al seguir un enlace
saliente) y que la URL quede a la vista o en el historial para que la copie otra persona; con un token
vigente, eso habilita un replay dentro de su ventana.

**Por qué `strict-origin` y no `no-referrer`.** `no-referrer` parece más seguro, pero rompe el flujo:
con esa política el navegador puede omitir la cabecera `Origin` o enviarla serializada como `null`, y
`POST /api/scan` exige que `Origin` coincida con el origen de la app (S-28), usando `Sec-Fetch-Site` solo
como respaldo cuando `Origin` no viene. Un `Origin: null` no coincide con el origen propio: el endpoint
respondería 403 `origen_invalido` y el escaneo nunca se registraría. `strict-origin` envía solo el
origen (esquema + host + puerto), sin ruta ni query, al navegar a otro sitio, y conserva un `Origin`
utilizable para las peticiones del mismo origen.

**Limitaciones honestas.** (1) El token sigue viajando en la URL del primer `GET /scan`, y es posible
que los logs de la plataforma registren la query string; no se verificó en este proyecto y no se
controla desde la app (la mitigación real es la ventana de 45 s y no reenviar el token al login, S-12).
(2) El token es **reutilizable dentro de su ventana** (~90 s): no es de un solo uso (ver «Limitación
conocida» al final de la Etapa 2). (3) `replaceState` limpia la entrada actual, no el historial completo
del navegador ni ninguna captura que hayan hecho el sistema operativo o la app de la cámara; y si el
JavaScript no se ejecuta, la URL conserva el token (las medidas 1 y 2 siguen protegiendo el `Referer`).

**Dónde se implementa.** `src/proxy.ts` (`aplicarCabecerasDeSeguridad` + `esRutaScan`),
`src/app/scan/page.tsx` (metadata), `src/components/scan/ConfirmacionScan.tsx` (`useEffect` de montaje).

**Tradeoff.** `strict-origin` no envía la ruta al navegar fuera, así que se pierde analítica de rutas
desde `/scan` (irrelevante: es una página con token y sin contenido que indexar). Y `replaceState`
cambia la URL después del montaje: recargar ya no reenvía el token, que es exactamente lo que se busca
(hay que volver a escanear).

### S-33 · Mapeo exhaustivo `resultado_scan` → HTTP/mensaje, con falla cerrada

**Decisión.** `src/lib/dominio/scan.ts` (módulo puro: sin `next/*`, Supabase ni React) define
`RESULTADOS_SCAN` como lista `as const`, el tipo `ResultadoScan` y
`MAPA_RESULTADO_SCAN: Record<ResultadoScan, { http; mensaje }>`. `POST /api/scan` valida con
`esResultadoScan()` lo que devuelve PostgREST antes de mapearlo, y `esResultadoExitoso()` decide el `ok`
(solo `entrada_ok` y `salida_ok`):

| `resultado` | HTTP | Mensaje |
| --- | --- | --- |
| `entrada_ok` / `salida_ok` | 200 | «Entrada registrada» / «Salida registrada» |
| `sesion_ya_abierta` | 409 | «Ya tienes una entrada activa» |
| `sin_sesion_abierta` | 409 | «No tienes una entrada activa» |
| `sin_consentimiento` | 403 | «Acepta el aviso de privacidad para marcar tu asistencia» |
| `cooldown` | 429 | «Espera unos segundos antes de volver a escanear» |
| `demasiados_intentos` | 429 | «Demasiados intentos seguidos. Espera un minuto y vuelve a intentar.» |
| `rate_limited` | 429 | «Demasiados intentos» |
| `token_invalido` / `token_expirado` | 403 | «El código venció, escanea el QR nuevamente» |
| `fuera_horario` | 409 | «El cowork está cerrado» |
| `zona_inactiva` | 409 | «Esta zona no está habilitada» |
| `no_autenticado` | 401 | «Inicia sesión y vuelve a escanear» |

**Precisión sobre la exhaustividad.** La garantía de TypeScript existe entre `RESULTADOS_SCAN` y
`MAPA_RESULTADO_SCAN`: si se agrega un literal a la lista y falta en el mapa, `tsc` no compila. **No**
hay garantía contra el enum de la base: `public.resultado_scan` vive en Postgres y TypeScript no lo ve.
Si una migración agrega un valor y se olvida aquí, el proyecto compila y, en ejecución, ese string es
desconocido → `esResultadoScan()` devuelve `false` → 500 `error_interno`, sin inventar un mensaje ni
caer en un 200 por defecto (**falla cerrada**). La lista se mantiene a mano porque el proyecto aplica
migraciones sin CLI y no tiene tipos generados (no existe `database.types.ts` ni un script
`supabase gen types`, y `crearClienteServidor()` crea el cliente sin el genérico `Database`); un test de
contrato en la Etapa 6 debería comparar la lista con `pg_enum` para cerrar ese hueco.

**Amenaza.** Que un resultado nuevo o inesperado (`null`, un objeto, un valor de otra versión de la RPC)
se traduzca por defecto en un 200 o en un mensaje crudo de Postgres (que puede arrastrar detalles
internos), y que la pantalla afirme algo distinto de lo que ocurrió.

**Por qué esta solución.** El mapa explícito hace visible la decisión de producto de cada resultado (401
vs 403 vs 409 vs 429) y concentra los textos en español, sin datos personales, en un módulo puro que se
puede probar con Vitest sin arrancar Next. `token_invalido` y `token_expirado` comparten mensaje a
propósito (no se revela si el token existió), y `demasiados_intentos` (RPC) y `rate_limited` (borde)
comparten HTTP 429.

**Dónde se implementa.** `src/lib/dominio/scan.ts`, `src/app/api/scan/route.ts`.

**Tradeoff.** Hay que mantener la lista a mano. Además, `demasiados_intentos` y `rate_limited` usan 429
con mensajes distintos, lo que revela en qué capa se frenó a la persona; se acepta porque no es
información sensible y le dice si debe esperar un minuto o unos segundos.

### S-34 · `camera=()` en `Permissions-Policy`

**Decisión.** El proxy envía `Permissions-Policy: camera=(), geolocation=(self), microphone=(),
payment=()` en todas las respuestas. `camera=()` es una lista de orígenes permitidos **vacía**: la cámara
queda denegada para todos, incluido el propio sitio.

**Amenaza.** Que un script inyectado o una dependencia comprometida abra la cámara con
`getUserMedia()` y capture sin que la persona lo note; además reduce la superficie si algún día se
embebe un widget de terceros (mapas, soporte, analítica) en el dashboard.

**Por qué esta solución.** El producto escanea con la **cámara nativa** del teléfono (la app del sistema
que abre el enlace), no con la Web API, así que ninguna pantalla necesita `getUserMedia`. Negar la
capacidad por política hace que ni siquiera aparezca el prompt: el navegador rechaza la petición del
script. Se mantiene `geolocation=(self)` porque el fallback opcional (QR estático + validación de
ubicación con consentimiento) sí usa la Web API desde el propio origen; el resto de las capacidades se
niega por defecto (`microphone=()`, `payment=()`).

**Dónde se implementa.** `src/proxy.ts` (`aplicarCabecerasDeSeguridad`).

**Tradeoff.** Si en el futuro se implementa escaneo in-browser (`BarcodeDetector` + `getUserMedia`),
habrá que cambiar a `camera=(self)`. La cabecera no sustituye al prompt del usuario: lo hace
inalcanzable, que es más fuerte.

### S-35 · Rate limit en `/auth/login`: dos cubos, respuesta idéntica y solo hashes en Redis

**Decisión.** `POST /auth/login` consume, antes de tocar Supabase, un cupo por IP (30/15 min) y otro por
correo (5/15 min) con `hashCorreo()`. El orden es: mismo origen (S-28) → `Content-Type` → límite por IP →
parseo y zod (S-15) → límite por correo → acción de Auth. Si cualquiera de los dos niega, la respuesta es
la misma `429 { ok: false, codigo: "limite_intentos" }`, sin distinguir si el correo existe, si la
contraseña era correcta ni qué flujo se intentó. Los tres flujos del endpoint (enlace mágico, contraseña
y registro) comparten el cubo por correo. A Redis solo llega
`HMAC-SHA256("rate-limit:email:v1:" + correo normalizado)`; el correo en claro no se guarda ni se escribe
en los logs (solo `error.name`).

**Amenaza.** Fuerza bruta y *credential stuffing* contra una cuenta; enumeración de correos usando el
propio limitador como oráculo; spam de enlaces mágicos para agotar la cuota de correo de Supabase; y, en
particular, que el límite de Supabase Auth sea **global**: como las peticiones salen del servidor de
Vercel, Supabase ve la IP del servidor y su límite por IP agrupa a todo el proyecto, así que sin límite
propio un atacante puede dejar sin login a todos.

**Por qué esta solución.** El cubo por IP frena el barrido desde una red y se consume antes de leer el
cuerpo; el cubo por correo frena el ataque distribuido (muchas IPs, un solo objetivo) y, como se evalúa
sin consultar Supabase, el 429 no revela si la cuenta existe. Normalizar el correo (trim + minúsculas)
antes de hashear evita multiplicar cubos con variantes triviales. La respuesta es idéntica en todos los
casos, en línea con la anti-enumeración de S-29, y el cliente (`FormularioLogin`) ya traduce
`limite_intentos` a un mensaje en español.

**Dónde se implementa.** `src/app/auth/login/route.ts` (`limitarPorIp` + `LIMITE_LOGIN_POR_IP`,
`hashCorreo` + `limitar` + `LIMITE_LOGIN_POR_CORREO`), `src/lib/rate-limit.ts`,
`src/lib/validacion/auth.ts`.

**Tradeoff.** Con 5 intentos/15 min por correo, alguien que conozca el correo de una persona puede
bloquear su login —y su registro y su enlace mágico— durante 15 minutos con cinco peticiones: es un
**DoS dirigido** de impacto temporal, aceptado porque no hay forma de distinguir al dueño de la cuenta
antes de autenticarlo. El cupo por IP (30/15 min) acota a unos pocos correos distintos por atacante en
esa ventana, y el valor está en una constante (`LIMITE_LOGIN_POR_CORREO`) por si en el cowork resulta
demasiado estrecho. Efecto secundario esperado: quien se equivoca cinco veces con la contraseña y luego
pide el enlace mágico debe esperar.

### S-36 · `getClaims()` no detecta revocación; `/admin` usará `getUser()`

**Decisión.** `obtenerSesion()` (y por tanto los guards de lectura) usa `supabase.auth.getClaims()`, que
valida firma y expiración del JWT, y lee el rol de `profiles` en cada llamada (S-27). Las acciones
sensibles de `/admin` (Etapa 6: guardar aforo, umbrales y horario, exportar CSV, historial con datos
personales) usarán `supabase.auth.getUser()`, que consulta al servidor de Auth. La distinción queda
escrita en el JSDoc de `getClaims()` para que no se «optimice» al revés.

**Amenaza.** Que un token todavía no expirado pero ya **revocado** (logout en otro dispositivo, «cerrar
todas las sesiones», contraseña cambiada, usuario baneado, sesión eliminada por el admin) siga sirviendo
para operar la app; en `/admin`, para cambiar la configuración del cowork o descargar datos personales.

**Por qué esta solución.** Un JWT es *stateless*: Supabase no puede invalidarlo antes de su `exp`, así
que la única forma de enterarse de una revocación es preguntar a Auth. Para pintar el dashboard o decir
«tu entrada está activa», el costo de una llamada de red por request no se justifica y el daño está
acotado. Con `getClaims()` el daño **no** lo acota una detección de la revocación, sino el resto del
diseño: PostgREST valida **solo** firma y expiración del JWT, igual que `getClaims()`, así que un token
revocado y aún no vencido **sí** puede llamar a `registrar_scan` y marcar entrada o salida como ese
usuario durante la vida del token (1 h por defecto). Lo que acota ese uso son las reglas de la propia
RPC —consentimiento vigente, cooldown de 30 s, límite de intentos por minuto, zona activa, horario y no
duplicar una sesión ya abierta— y RLS, que impide leer sesiones ajenas. En `/admin`, en cambio, una
llamada extra por acción es barata frente al impacto de una escritura privilegiada hecha con una sesión
robada.

**Dónde se implementa.** `src/lib/auth/session.ts` (`obtenerSesion`), `src/lib/auth/guards.ts`
(`requireAdmin`); las acciones de `/admin` se implementan en la Etapa 6.

**Tradeoff.** Existe una ventana igual a la vida del access token (1 h por defecto) en la que un token
revocado sigue sirviendo: lee lo que RLS le permite (sus propias sesiones, `ocupacion_actual` y los
agregados públicos) y además **escribe** asistencia, porque ni PostgREST ni `registrar_scan` comprueban
la revocación. El efecto es acotado pero no nulo: con ese token alguien podría marcar una entrada que no
ocurrió (falseando la ocupación) o una salida antes de tiempo, y nada más: no puede leer datos de otras
personas ni saltarse el consentimiento, el cooldown ni los límites. Se puede acortar bajando el *access
token TTL* en Supabase Auth o usando `getUser()` en más sitios (por ejemplo en `/api/scan` antes de
invocar la RPC, a costa de una llamada a Auth por escaneo).

**Limitación conocida (estado actual).** Hoy `/qr` y `/api/qr/token` usan `requireAdmin()`, que se apoya
en `getClaims()`: una sesión de admin **revocada pero no vencida** puede seguir generando tokens QR
válidos hasta que expire su JWT (hasta 1 h). Pesa más que el resto de la ventana porque esos tokens son
la prueba de presencia física que el sistema acepta: quien conserve esa cookie puede emitir un QR
escaneable desde cualquier lugar. Mitigación prevista en la Etapa 6: que `requireAdmin()` use
`getUser()` —una llamada a Auth por render de `/qr` y por petición a `/api/qr/token`— para que la
revocación surta efecto de inmediato en la ruta que emite tokens.

### S-37 · Estadísticas del dashboard en RSC, sin Upstash y con rangos cerrados solo en la UI

**Decisión.** El dashboard público es un Server Component: resuelve la zona y los agregados en el
servidor con el cliente `anon` (sujeto a RLS) y no expone una ruta HTTP propia para estadísticas.
La UI solo ofrece `7` y `30` días (toggle en el cliente con ambas series precalculadas), pero el
contrato de lectura no se considera cerrado: `ocupacion_por_franja` valida 7/30 dentro de la RPC,
mientras `permanencia_promedio` y `personas_distintas` siguen aceptando `p_desde`/`p_hasta` libres
(1..90 días) y son ejecutables por `anon`, que es una clave pública. No se usa Upstash en lecturas.

**Amenaza.** (1) Coste/abuso: un tercero puede llamar las RPC directamente y consumir CPU o
interrogar rangos solapados para intentar el ataque por diferencia de S-23. (2) Disponibilidad:
poner rate limit en las lecturas con la política de falla cerrada de S-30 haría que un fallo o
agotamiento de Upstash dejara sin dashboard a todo el público. (3) Cuota: el plan gratuito de
Upstash (~10k comandos/día) ya se comparte con `/api/scan` y `/auth/login`; las lecturas del
dashboard son las más frecuentes y las consumirían primero.

**Por qué esta solución.** El dato es público por diseño (ocupación de un espacio físico), ya está
agregado y no contiene PII; la prioridad es que el dashboard se vea siempre, incluso en la demo y
con la cuota gratuita. El coste se acota en la base (funciones con índice y salida ≤168 puntos) y
con el render del RSC, no con un limitador que puede fallar. La decisión de producto del toggle
7/30 (que se había numerado como S-41) no es una decisión de seguridad: se documenta aquí como
contexto y no se registra aparte.

**Limitación conocida y mitigación futura.** Quien tenga la anon key puede llamar
`permanencia_promedio`/`personas_distintas` con rangos libres; el k-anonimato (S-18/S-23) y el
tope de 90 días siguen aplicando, pero no hay límite de consultas. Mitigación futura: funciones de
ventana fija (recibir un `p_dias` cerrado, como `ocupacion_por_franja`, en vez de fechas) y
revocar `EXECUTE` a `anon` de las variantes de rango libre, dejando solo wrappers cerrados. Si el
tráfico lo justifica, un cubo de Upstash separado y **fail-open** para lecturas.

**Dónde se implementa.** `src/lib/validacion/dashboard.ts` (lista `7|30`),
`src/lib/supabase/dashboard.ts` (RSC con `anon`), migración 9 (`p_dias` validado) y
`src/app/dashboard/page.tsx` (Tanda 3).

**Tradeoff.** La UI ofrece solo dos ventanas (menos flexibilidad para el informe), la limitación
queda declarada en vez de resuelta y no hay rate limit por IP en lecturas.

### S-38 · Agregados en Postgres y solo agregados al navegador (tope de 1000 filas)

**Decisión.** Las estadísticas se calculan con `ocupacion_por_franja(zona, 7|30)` y
`ocupacion_hoy(zona)`: funciones `SECURITY DEFINER`, `search_path = public, pg_temp`, `STABLE`, que
solo leen `snapshots_ocupacion` y devuelven agregados o la serie de conteos del día, sin
identidades. `EXECUTE` se revoca de `PUBLIC` y se concede solo a `anon` y `authenticated`. La
página no consulta `snapshots_ocupacion` directamente. Al navegador viajan como máximo 24 puntos
(curva de hoy) y una matriz 7×24 (mapa de calor); las filas crudas nunca cruzan a un Client
Component. Realtime sigue publicando solo `ocupacion_actual` (S-03).

**Amenaza.** (1) Truncamiento silencioso: PostgREST limita cada respuesta a 1000 filas por defecto
y `.limit(9000)` no lo salta; 30 días de snapshots son ~8.640 filas, así que el dashboard mostraría
solo una parte y las estadísticas quedarían sesgadas sin ningún error. (2) Sobreexposición y
coste: traer filas crudas multiplica la superficie y la banda aunque no tengan PII. (3) Grants
implícitos: una función nueva nace con `EXECUTE` para `PUBLIC`, así que sin `REVOKE` explícito
quedaría invocable por cualquiera.

**Por qué esta solución.** Agregar en Postgres usa el índice `(zona_id, ts)` y hace que el límite
de 1000 deje de importar: el resultado está acotado por construcción (7 días × 24 horas = 168
celdas; un día normal = 288 snapshots y el de 25 h por DST = 300). El contrato de salida es
numérico y estable, y el cliente no puede
pedir filas individuales ni rangos arbitrarios en `ocupacion_por_franja`. `REVOKE` + `GRANT` deja el
privilegio mínimo verificado en `verificacion.sql`.

**Dónde se implementa.** Migración 9, `src/lib/supabase/dashboard.ts`,
`src/lib/dominio/estadisticas.ts` y `supabase/verificacion.sql` (existencia, EXECUTE, `p_dias=5`
vacío, `p_dias=30` ≤168 y `ocupacion_hoy` ≤300).

**Tradeoff.** El mapa de calor siempre pide 30 días (una consulta más, aunque acotada). El tope de
300 de `ocupacion_hoy` cubre el día de 25 h por DST sin recortar la serie. `service_role` ya tiene
`EXECUTE` en `refrescar_ocupacion(uuid)` por los privilegios por defecto de Supabase (verificado
con `has_function_privilege` el 2026-11-11); la migración 9 no lo modifica. La simulación local la
usa para reconciliar `ocupacion_actual`; no es una exposición nueva, porque `service_role` nunca
llega al navegador (S-07) y sigue sin estar disponible para `anon`/`authenticated`.

---

## Etapa 5 — Dashboard en tiempo real (Tanda 2: gráficos y mapa de calor)

> S-37 y S-38 (Tanda 1: agregados en Postgres y estadísticas por RSC) quedaron documentadas en la
> sección de la Etapa 4 por continuidad del archivo; estas tres son de la Tanda 2.

### S-39 · Recharts como isla de cliente con `ssr: false`, sin relajar la CSP

**Decisión.** Los dos gráficos (promedio por hora del día y curva de hoy) viven en
`src/components/GraficosDashboard.tsx` (`"use client"`) y se cargan desde
`GraficosDashboardCarga.tsx` con `next/dynamic(..., { ssr: false })`. La CSP de producción
(`src/proxy.ts`) se mantiene igual: `script-src` sin `'unsafe-eval'` y `style-src` sin
`'unsafe-inline'`.

**Amenaza.** (1) XSS por estilos: Recharts escribe estilos por CSSOM y los emite como atributos
`style` en el SVG; si se renderizara en el servidor, ese HTML llegaría con `style=` y la única
forma de que el navegador lo aplicara sería añadiendo `'unsafe-inline'` a `style-src`, lo que
reabriría la inyección de CSS/atributos en toda la app. (2) Superficie de hidratación: cuanto
menos HTML del servidor dependa de JavaScript de terceros para verse bien, menos formas hay de
romper la página con un error de render.

**Por qué esta solución.** Con `ssr: false` el SVG nunca viaja en el HTML: lo construye el propio
JavaScript ya autorizado por el nonce, y la CSP no bloquea la manipulación del DOM desde
JavaScript. Así no hay que debilitar ninguna directiva. `ssr: false` no está permitido dentro de
un Server Component, y `EstadisticasDashboard` lo es (importa `server-only`); por eso el
envoltorio de cliente separado. Como efecto secundario, Recharts sale del HTML inicial y la
página pesa menos en el primer byte.

**Dónde se implementa.** `src/components/GraficosDashboard.tsx`,
`src/components/GraficosDashboardCarga.tsx` y `src/app/dashboard/page.tsx` (Tanda 2 de la Etapa 5).

**Tradeoff.** El gráfico aparece tras hidratar (se muestra un esqueleto con las mismas
dimensiones para no mover el layout) y las tablas de datos accesibles también llegan con el
JavaScript. Por eso el mapa de calor, que sí es crítico, se renderiza en el servidor (S-40).

### S-40 · El mapa de calor se pinta en el servidor como tabla HTML con datos ya agregados

**Decisión.** `MapaCalorDashboard` es un Server Component (`import "server-only"`) que recibe las
franjas de 30 días ya agregadas y arma una `<table>` de 7 filas (lunes→domingo) × las horas del
horario de la zona. No usa Recharts ni estilos inline: los cinco niveles de color son clases
Tailwind literales de una sola gama. Cada celda imprime el número (`Math.round`) y `—` cuando no
hubo muestras; la leyenda no depende solo del color.

**Amenaza.** (1) Dependencia de JavaScript: si el mapa de calor fuera una isla de cliente, quedaría
vacío sin JS o con un chunk bloqueado, y es el gráfico que más se mira. (2) Fuga de datos: una
rejilla día × hora es el gráfico con más riesgo de re-identificación si se alimentara de sesiones
individuales. (3) XSS: cualquier color calculado en línea obligaría a `style=`, incompatible con la
CSP (S-39).

**Por qué esta solución.** La matriz se calcula con `construirMatrizCalor`, que solo promedia
ocupación (promedio ponderado por `muestras`), no personas: sigue el mismo criterio que S-18/S-23
—los gráficos son promedios de ocupación y no dependen del k-anonimato de los datos individuales—.
Al ser `<table>` semántica (con `caption` sr-only y `scope` en los encabezados) funciona sin
JavaScript, con lector de pantalla y con contraste en tema claro y oscuro, y el HTML que sale del
servidor no necesita ninguna excepción de CSP.

**Dónde se implementa.** `src/components/MapaCalorDashboard.tsx` (recibe `filas`, `horas`,
`aforoMax` y `horario`), `construirMatrizCalor`/`horasDelHorario` en
`src/lib/dominio/estadisticas.ts` y el cableado en `src/components/EstadisticasDashboard.tsx`.

**Tradeoff.** Siempre se consulta el rango de 30 días para el mapa (una RPC más, acotada a ≤168
filas), y con `rango=7` las tarjetas y el mapa cubren ventanas distintas: se explica en el texto de
la tarjeta para que no se lea como inconsistencia.

### S-41 · `z.config({ jitless: true })` en el cliente para no necesitar `'unsafe-eval'`

**Decisión.** `src/instrumentation-client.ts` (se ejecuta en el navegador antes de que la app sea
interactiva) apaga el compilador JIT de Zod con `jitless`. La CSP no gana `'unsafe-eval'`.

**Amenaza.** (1) Ruido y falsos positivos: Zod 4 compila validadores con `new Function`, y bajo
`script-src` sin `'unsafe-eval'` el navegador rechaza la sonda y reporta un
`securitypolicyviolation` en la consola en cada carga, lo que en una demo parece un fallo de
seguridad. (2) La tentación de "arreglarlo" añadiendo `'unsafe-eval'` a la CSP, que habilitaría
ejecutar cadenas como código y multiplicaría el impacto de cualquier XSS.

**Por qué esta solución.** Zod sí llega al bundle de cliente: `src/lib/env.ts` valida los
`NEXT_PUBLIC_*` con Zod y `src/lib/supabase/browser.ts` lo importa desde la isla del contador. Con
`jitless` la validación es idéntica en resultado y solo algo más lenta (irrelevante para 4 variables
de entorno). Ponerlo en `instrumentation-client.ts` —y no dentro de `env.ts`— garantiza que el
ajuste se aplique antes de cualquier otro módulo y que nunca afecte al servidor, donde el JIT sí
conviene.

**Dónde se implementa.** `src/instrumentation-client.ts`; CSP en `src/proxy.ts` (sin cambios).

**Tradeoff.** Si en el futuro un Client Component usa Zod de forma intensiva (por ejemplo, validar
un formulario grande), perderá el JIT también en el navegador; se acepta porque el rendimiento no es
el cuello de botella y la alternativa era debilitar la CSP.

---

## Pendientes de documentar en las próximas etapas

| Tema | Etapa |
| --- | --- |
| Tests automáticos de RLS (comportamiento con usuarios reales) | 6 |
| Almacenamiento de secretos en Vercel y rotación de llaves de Supabase | 4 · 6 |
| Seudonimización efectiva en el export CSV | 6 |
| Resultado de los tests de RLS como evidencia para el informe | 6 |
| `getUser()` en las acciones de `/admin` (S-36) | 6 |
| `requireAdmin()` con `getUser()` para `/qr` y `/api/qr/token` (S-36, limitación conocida) | 6 |
| Vector HMAC `fd5034f9…bdef` como test de Vitest (S-16 · S-26) | 6 |
| Test de contrato entre `RESULTADOS_SCAN` y el enum `resultado_scan` (S-33) | 6 |
| Ventana fija o revocación de `EXECUTE` a `anon` para `permanencia_promedio`/`personas_distintas` (S-37, limitación conocida) | 6 |

## Control de cambios

| Fecha | Cambio |
| --- | --- |
| 2026-11-06 | Creación del documento con las decisiones de la Etapa 1 (S-01 a S-15) |
| 2026-11-06 | Etapa 2: esquema SQL, políticas RLS, RPC y docs (S-16 a S-20 + matriz RLS) |
| 2026-11-08 | Revisión de las migraciones antes de aplicarlas: k=5 también en `resumen_diario` (S-21), comparación de firmas por `digest` (S-22), cierre de sesión filtrado por zona y alineación de `qr_window_seconds` con `QR_WINDOW_SECONDS` |
| 2026-11-08 | Segunda revisión: k-anonimato por personas distintas, rango 1..90 días alineado a medianoche de la zona y límite por diferencia entre rangos (S-23); permanencia solo con `cierre = 'usuario'` y salida del cierre auto acotada a 8 h (S-24); `verificacion.sql` ampliado (privilegios de escritura de tabla, triggers y barrido de `pg_proc`) |
| 2026-11-10 | Etapa 3: consentimiento como precondición del scan (S-25), firma del QR solo en el servidor (S-26), guards con `getClaims()` y anti open-redirect (S-27), signout por POST y mismo origen (S-28). Revisión de S-10: se desactiva PPR (`cacheComponents`) porque el nonce es incompatible con los documentos prerenderizados |
| 2026-11-10 | Revisión de S-09: el login se mueve al servidor para que las cookies `sb-*` sean realmente httpOnly; S-29 añadido (errores de auth genéricos, anti-enumeración y TODO de rate limit) |
| 2026-11-10 | Endurecimiento de S-29: `try/catch` en `/auth/login` que responde `generico` y registra solo `error.name`, cliente tolerante a respuestas no JSON, y se documenta que la anti-enumeración solo es completa con «Confirm email» activado |
| 2026-11-10 | Hallazgo en S-27: `normalizarDestinoInterno` validaba la entrada pero no el resultado de `new URL()`, así que `/..//evil.com` (y variantes con `.`/`..`) normalizaban a `//evil.com` y anulaban el anti open-redirect. Ahora se valida también el resultado |
| 2026-11-11 | Etapa 4: rate limit de borde con Upstash y falla cerrada (S-30), IP solo de `x-vercel-forwarded-for` hasheada con HMAC (S-31), `Referrer-Policy: strict-origin` en `/scan` + `replaceState` al montar (S-32), mapeo exhaustivo de `resultado_scan` con falla cerrada ante valores desconocidos (S-33), `camera=()` en `Permissions-Policy` (S-34), rate limit del login por IP y hash de correo (S-35) y límite de `getClaims()` frente a revocación (S-36). Se cierran el `TODO` de S-29 y el pendiente de S-08, y se actualiza S-10 (cabeceras por ruta) |
| 2026-11-11 | Hallazgo: las firmas de Node y de Postgres no coincidían porque `firmarHmacHex` decodificaba el hex (clave de 32 bytes) mientras `extensions.hmac(text, text, 'sha256')` usa el **texto** del secreto (64 bytes UTF-8). Se corrigió con `new TextEncoder().encode(secretoHex)` en `src/lib/qr/token.ts`, **sin tocar migraciones**: `app_secrets.qr_token_secret` ya guardaba el valor correcto. Queda documentado en S-16 y S-26 con el vector `fd5034f9…bdef` para el test de Vitest |
| 2026-11-11 | Se actualizan `docs/arquitectura.md` (§5.1 con `demasiados_intentos`, §9 con los usos reales de Upstash y de la clave HMAC, §11.3 y §14) y `docs/modelo-datos.md` (clave HMAC como texto, vector de prueba y nota de que `rate_limited` no lo emite la RPC) |
| 2026-11-11 | Corrección de redacción en la Etapa 4: S-36 aclara que PostgREST solo valida firma y expiración (un token revocado pero vigente **sí** llama a `registrar_scan`) y añade la limitación conocida de `requireAdmin()` con `getClaims()` en `/qr` y `/api/qr/token`; S-31 corrige `next start` (sin `x-vercel-forwarded-for` el resultado es siempre 429, nunca 500); S-33 precisa por qué no hay tipos generados |
| 2026-11-11 | Verificación contra `supabase/migrations/20261110000000_consentimiento_y_scan.sql`: el umbral es `c_max_invalidos_min := 10` sobre `eventos_scan` con `ts > now() - interval '1 minute'` y `resultado not in ('entrada_ok','salida_ok')`, y corta con `v_invalidos >= 10` (bloque `-- 1)` de la migración, paso 3 de la lista de `modelo-datos.md`). Se precisa la semántica del umbral en ambos documentos y `arquitectura.md` §5.2 remite a S-36 por la limitación de `requireAdmin()` con `getClaims()` |
| 2026-11-11 | Etapa 5 (Tanda 1): agregados del dashboard en Postgres y solo agregados al navegador, por el tope de 1000 filas de PostgREST (S-38); estadísticas por RSC sin Upstash, con rangos cerrados solo en la UI y la limitación de las RPC de rango libre declarada (S-37). Se corrige S-23 para no atribuirse una mitigación que no se implementó y la decisión de UI del toggle 7/30 se funde en S-37 |
| 2026-11-11 | Verificación DST de `tiempo.ts` contra un Postgres 18 temporal (`America/Santiago`): los mediodías locales de `2026-09-06` y `2026-04-05` y sus ventanas de 7 días coinciden al milisegundo con `date_trunc('day', … at time zone …) at time zone …` y con el redondeo a medianoche de la migración 9. También se probó la migración 9 en ese Postgres: `p_dias=5` → 0 filas, `p_dias=30` ≤168, `ocupacion_hoy` solo el día local, `anon`/`authenticated` con EXECUTE, `PUBLIC` sin él; `service_role` con EXECUTE en `refrescar_ocupacion`, confirmado también en Supabase el 2026-11-11 |
| 2026-11-12 | Etapa 5 (Tanda 2): Recharts como isla de cliente con `ssr: false` para no relajar la CSP (S-39), mapa de calor día × hora renderizado en el servidor como tabla HTML con datos agregados (S-40) y `z.config({ jitless: true })` en `src/instrumentation-client.ts` para que Zod no use `new Function` (S-41). Se cablean `aforoMax`, `hora_apertura` y `hora_cierre` de la zona en `EstadisticasDashboard` y se añaden `construirPuntosPorHora`, `construirPuntosHoy` y `horasDelHorario` en `src/lib/dominio/estadisticas.ts` |

