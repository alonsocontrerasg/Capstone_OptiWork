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

**Dónde se implementa.** `src/lib/supabase/{browser,server}.ts` y `src/proxy.ts` (Etapa 3).

**Tradeoff.** Toda lectura de sesión es dinámica (no se puede prerenderizar) y debe vivir detrás de
`<Suspense>`; es una consecuencia aceptada de `cacheComponents`.

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

## Pendientes de documentar en las próximas etapas

| Tema | Etapa |
| --- | --- |
| Políticas RLS concretas por tabla y rol, con su test | 2 · 6 |
| Autorización de `/qr` y `/admin` (guard de rol, respuesta 403 sin filtrar datos) | 3 · 6 |
| Gestión del consentimiento y su versión (Ley 21.719) | 3 |
| Rotación de `QR_TOKEN_SECRET` y su efecto en QR activos | 3 |
| Almacenamiento de secretos en Vercel y rotación de llaves de Supabase | 3 |
| Seudonimización efectiva en el export CSV | 6 |
| Resultado de los tests de RLS como evidencia para el informe | 6 |

## Control de cambios

| Fecha | Cambio |
| --- | --- |
| 2026-11-06 | Creación del documento con las decisiones de la Etapa 1 (S-01 a S-15) |
