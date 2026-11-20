# Revisión móvil del PR #1

Alcance: presentación, navegación y rendimiento móvil. El PR sigue abierto; esta revisión no incorpora cambios a `main` ni ejecuta migraciones en Supabase remoto.

## Cómo se comprueba

- Chromium (perfil Pixel 7) y WebKit (perfil iPhone SE), con ventanas de 320×568, 360×640, 390×844, 430×932, 568×320, 844×390, 768×1024 y 1366×768. También se intercambian ancho/alto sin recargar.
- Inicio anónimo y autenticado, acceso, privacidad, ocupación, estadísticas, error de escaneo, 404, administración, QR y confirmación de entrada. Las tablas alternativas de gráficos y los días del mapa se prueban expandidos.
- Supabase local descartable con Auth/PostgREST reales, dos zonas, nombres largos, una cadena sin espacios, usuario administrador y un contador de seis cifras. No se crean usuarios ni marcas en producción.
- Aserciones sobre viewport, ancho del documento, elementos fuera de pantalla, scroll interno móvil, texto truncado, texto secundario menor a 14 px, campos menores a 16 px y objetivos táctiles menores a 44×44 px. Para casillas se mide su etiqueta asociada, que también activa el control.
- Capturas y mediciones JSON disponibles en el artefacto `navegador-informe` de GitHub Actions; el job `calidad-y-sql` conserva los controles existentes de dominio, RLS y concurrencia.
- Rendimiento público medido aparte con `next build` + `next start`: Chromium móvil, caché fría, CPU ralentizada cuatro veces, latencia 150 ms, descarga 1,6 Mb/s y subida 0,75 Mb/s. Se registran LCP, cambios de layout, JavaScript transferido, fuentes e imágenes. Los tiempos no son los de `next dev`.

## Características y correcciones

| Característica | Hallazgo anterior | Solución incluida |
| --- | --- | --- |
| 1. Viewport | Next ya genera `width=device-width, initial-scale=1`. | Se conserva el ajuste al dispositivo y el zoom del usuario; la prueba rechaza configuraciones que lo bloqueen. |
| 2. Desbordamiento | El QR rígido, las filas de horario y los selectores con nombres largos podían superar el ancho disponible. El historial y el mapa exigían desplazamiento lateral. | `min-width:0`, ajuste de palabras largas, QR flexible, filtros apilados, historial como tarjetas y mapa por días en móvil. No se ocultan errores con `overflow-x:hidden`. |
| 3. Texto | Textos auxiliares de 11–12 px, campos de acceso de 14 px y nombre de zona truncado en la confirmación. | Texto secundario de al menos 14 px, campos de 16 px, ejes legibles y nombre completo con salto de línea. El contador ajusta su tipografía al espacio disponible. |
| 4. Áreas táctiles | Renovar/cambiar QR, desplegar tablas y el enlace del aviso tenían zonas de interacción pequeñas. | Acciones y desplegables de al menos 44 px de alto; controles separados con `gap` y etiquetas de casillas utilizables como objetivo táctil. |
| 5. Imágenes y videos | El QR era cuadrado de ancho fijo; no hay videos ni fotografías de contenido en las rutas revisadas. | QR de ancho máximo y proporción cuadrada; imágenes/videos con `max-width:100%` y alto automático. Se conserva el margen blanco del QR. |
| 6. Navegación | La cabecera concentraba marca y dos acciones en una sola fila móvil. | Marca en su propia fila y dos acciones visibles en columnas iguales; en pantallas mayores se conserva la fila. Se comprueba la navegación a Ocupación y la renovación del QR. |
| 7. Layout | Horarios en tres columnas rígidas y tablas anchas poco cómodas en móvil. | Día seguido de apertura/cierre; formularios y filtros apilados; historial en tarjetas con todos sus campos; mapa en desplegables de día y horas en rejilla. Las tablas de los gráficos caben en su tarjeta. |
| 8. Espaciado | El padding de tarjetas y contenedores restaba espacio útil al ancho de 320 px. | Padding fluido de 16–24 px en tarjetas y 16–32 px en el contenedor; separación explícita entre acciones, campos y días. |
| 9. Medidas fijas | QR de 256/288 px, columnas de horario de 96/128 px y contador de 72 px incluso en ventanas estrechas. | Anchos máximos, proporción cuadrada, columnas flexibles y tipografía con `clamp`. Las alturas de gráficos siguen siendo acotadas para reservar espacio, dentro de un ancho adaptable. |
| 10. Orientación | Los mismos anchos rígidos comprometían ventanas estrechas y horizontales bajas. | Sin bloqueo de orientación ni contenedores a altura completa rígida; se prueban ventanas verticales/horizontales y el giro sin recarga. El contenido largo permite scroll vertical. |
| 11. Rendimiento | Se precargaba Space Grotesk sin utilizarse; los gráficos se descargaban al entrar aunque quedaran lejos de la vista. | Una sola familia tipográfica, Inter; Recharts se monta al acercarse a la vista mediante `IntersectionObserver`, con esqueleto durante la espera. Se conserva la división de código y se añade medición del build de producción. |

## Prioridad de los problemas detectados

1. Corregir el ancho del QR, los horarios y las tablas móviles: impedían usar funciones esenciales sin desplazarse lateralmente.
2. Mejorar lectura y precisión táctil: campos de 16 px, texto auxiliar de 14 px y acciones de 44 px; conservar nombres completos.
3. Reducir las descargas iniciales y verificar regresiones: eliminar la fuente sin uso y diferir gráficos, manteniendo controles automáticos.

## Límites de la revisión

La emulación comprueba motores y tamaños, pero no sustituye una prueba física con el teclado de iOS/Android ni la lectura de los QR con cámaras reales. La Preview de Vercel exige autenticación; las mediciones autenticadas se ejecutan sobre el mismo código con Supabase local, no sobre la pantalla de acceso de Vercel.

La medición de laboratorio orienta sobre carga y estabilidad; no certifica Core Web Vitals para usuarios reales. Como referencia, los objetivos de campo son LCP ≤2,5 s, CLS ≤0,1 e INP ≤200 ms en el percentil 75: [Web Vitals](https://web.dev/articles/vitals). Esta suite no mide INP de campo. Conviene repetir la prueba sobre el dominio de producción después del merge autorizado.

Los cambios de presentación no sustituyen los pendientes ya documentados de despliegue: migración de administración, permisos/SMTP de Supabase y prueba manual de correo real.
