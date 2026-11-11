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
| S-29 | Login en el servidor: errores genéricos (anti-enumeración) y TODO de rate limit | 3 |

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

**Dónde se implementa.** `src/lib/rate-limit.ts` + `POST /api/scan` (Etapa 4), y
`..._rpc_registrar_scan.sql` (Etapa 2).

**Tradeoff.** Upstash tiene cuota gratuita limitada y agrega una dependencia externa; se usa solo en
los dos endpoints que lo necesitan y en local hay una alternativa en memoria con advertencia.

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
`..._pg_cron_jobs.sql` (`cron_resumen_diario`).

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

**Mitigación parcial prevista (Etapa 5).** Limitar en el dashboard las consultas a un conjunto cerrado
de rangos (día, semana, mes alineados) en lugar de aceptar `p_desde`/`p_hasta` libres desde el cliente,
y aplicar rate limit por IP en la ruta que las consume. Con eso el atacante tendría que llamar la RPC
directamente y quedaría sujeto al mismo límite.


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
cambie; cualquier intento cae al destino por defecto. Los guards se ejecutan en la página o el Route
Handler, no en el proxy: así no hay rutas "olvidadas" fuera del matcher y no se depende de un control
que la documentación de Next desaconseja para autorización.

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

### S-29 · Login en el servidor: errores de autenticación genéricos y TODO de rate limit

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

**Rate limit pendiente (Etapa 4).** `POST /auth/login` deja un `TODO` explícito para aplicar rate
limit por IP y por correo reutilizando el limitador de `src/lib/rate-limit.ts` (S-08). Mientras no
exista, hay que tener en cuenta que los límites de Supabase Auth pasan a ser **globales para el
proyecto**: como las peticiones salen del servidor (Vercel), Supabase ve la IP del servidor y no la
del usuario, así que su límite por IP agrupa a todos los usuarios. Por eso el rate limit propio de la
app es imprescindible antes de producción.

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
propio queda pendiente de la Etapa 4 (hasta entonces, el endpoint depende de los límites globales de
Supabase).

---

## Pendientes de documentar en las próximas etapas

| Tema | Etapa |
| --- | --- |
| Tests automáticos de RLS (comportamiento con usuarios reales) | 6 |
| Almacenamiento de secretos en Vercel y rotación de llaves de Supabase | 4 · 6 |
| Seudonimización efectiva en el export CSV | 6 |
| Resultado de los tests de RLS como evidencia para el informe | 6 |
| Rate limiting con Upstash y su verificación en serverless | 4 |

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
