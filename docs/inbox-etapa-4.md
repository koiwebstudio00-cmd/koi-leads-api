# Inbox: lectura, organización y Realtime — etapa 4

> Actualización de activación: migraciones de etapas 1, 3 y 4 aplicadas en Supabase; código en `dev` y entorno local preparado. Las notas de validación local siguientes describen la entrega original. Estado actual y variables: [Inbox en dev](inbox-dev.md).

Estado al 20/11/2026: implementado y validado **localmente**. No se aplicaron migraciones remotas, no se conectaron cuentas reales y no se realizó commit, push ni despliegue en esta entrega. Depende de las etapas 1–3. El envío sigue reservado para la etapa 5.

## Experiencia disponible

- Pestaña **Inbox** y rutas `/inbox` y `/inbox/:id`, con carga diferida. Conversaciones conserva las rutas y datos de EvoAPI.
- Selector de cuentas con el estilo existente: canal, alias, dirección y cantidad de chats. Permite ver todas las cuentas o una sola; distingue las desconectadas.
- Filtros locales de canal, cuenta, responsable, búsqueda, no leídos, pendientes y archivados. Se cargan todos los resúmenes en lotes de 200 y se muestran 80 filas inicialmente, ampliables al desplazarse. No se descargan todos los historiales al entrar.
- Lista con cuenta/canal por chat; encabezado con identidad del contacto y cuenta desde la que se responderá. Contador propio de Inbox en navegación de escritorio y móvil.
- Historial paginado por fecha e ID, con 50 mensajes por solicitud, conservación de posición al cargar anteriores y actualización del final sin desplazar a quien está leyendo mensajes antiguos.
- Visualización/descarga de múltiples adjuntos por mensaje a través de la API autenticada, reutilizando las vistas de imagen, audio, video y documento existentes.
- Lectura por usuario, marcado manual como no leído, archivado por conversación y panel de contacto compartido: responsable, etapa y enlace a ficha/notas. Responsable y etapa pertenecen al lead CRM; no crean una segunda ficha comercial.
- Borradores de texto en `sessionStorage`, con clave de versión/workspace/usuario/conversación. Se conservan al cambiar de chat o recargar la misma pestaña. Cambiar de chat/cuenta con texto solicita confirmación; si el almacenamiento falla se avisa y se conserva una copia en memoria mientras Inbox permanece montado. No son borradores sincronizados entre dispositivos.
- Ventana de 24 horas informada por el servidor, con actualización visual del vencimiento. El compositor permite preparar texto pero mantiene el envío y los adjuntos salientes deshabilitados; no hay una ruta de envío habilitada en esta etapa.

## Transporte y reconciliación

Un canal Supabase Realtime por workspace se comparte entre la lista y el contador de navegación. Se suscribe exclusivamente a `public.koi_inbox_accounts` y `public.koi_inbox_conversations`, con filtro de workspace y las políticas RLS de etapa 1.

Las tablas de mensajes, lecturas, archivos y eventos siguen privadas. Los cambios de mensajes/lecturas y del lead actualizan el resumen público; el navegador recibe una invalidación y consulta los datos autorizados mediante la API. Los eventos cercanos se agrupan durante 100 ms. Los IDs afectados se reconcilian en lotes de hasta 100.

El índice comparte con EvoAPI la clase genérica `SummaryIndex`; cada bandeja mantiene su propia instancia y transporte. Los cambios recibidos durante una carga completa se procesan después del snapshot. La posición en la lista se calcula por el último mensaje, no por actualizaciones de responsable o lectura.

Al reconectar, volver a una pestaña visible o recuperar red se reconcilian resúmenes e historial activo. Existe respaldo cada 5 segundos cuando Realtime no está conectado y reconciliación completa cada 60 segundos cuando sí lo está; el contador tiene además respaldo cada 30 segundos. Las consultas periódicas se suspenden con la pestaña oculta. Si durante el corte llegaron más de 50 mensajes, el historial recorre páginas hasta encontrar el tramo ya cargado, evitando huecos y duplicados.

Realtime actualiza la interfaz; el worker de recepción/historial de etapa 3 sigue siendo necesario para normalizar y persistir lo que entrega Zernio. No se sustituyen los workers por WebSockets.

## API y base de datos

Migración local creada con Supabase CLI: `20261120115133_koi_inbox_read_model.sql`. Se aplica después de las migraciones de etapas 1 y 3. Añade progreso/revisión de lectura, índices, funciones de consulta, triggers de invalidación y las dos tablas públicas a `supabase_realtime` cuando existe esa publicación.

`public.koi_inbox_query(action,data)` solo puede ejecutarse con `authenticated`; verifica la membresía y deriva el workspace desde `auth.uid()`. Los helpers privados no son ejecutables directamente por el navegador. Los mensajes de un lead eliminado dejan de estar disponibles mediante la API. No se usa `service_role` para las consultas del usuario.

| Ruta | Resultado o entrada |
| --- | --- |
| `GET /api/inbox/accounts` | Cuentas locales autorizadas; no consulta Zernio en cada render. |
| `GET /api/inbox/unread-count` | Cantidad de chats no archivados con no leídos para el usuario. |
| `GET /api/inbox/index?after=…` | `{userId,rows,nextCursor}`; cursor UUID, máximo 200 resúmenes. |
| `GET /api/inbox/index?ids=…` | Refresco específico, de 1 a 100 IDs. No admite `after` simultáneamente. |
| `GET /api/inbox/conversations/:id` | `{conversation,messages,nextCursor}`; `before` es un ID de mensaje del mismo chat, `limit` de 1 a 100. También disponible con sufijo `/messages`. |
| `POST /api/inbox/conversations/:id/actions` | `archive` + `archived`, `assign` + `assignedTo`, `unread`, o `read` + `throughMessageId` + `revision`. |
| `GET /api/inbox/conversations/:id/attachments?messageId=…&index=…` | Archivo autorizado como `{mime,name,base64}`. |

El marcador de lectura es monotónico por secuencia de ingreso. Una lectura solo alcanza el mensaje ancla de la vista consultada; un mensaje ingresado después conserva su no leído. La revisión impide que una lectura atrasada deshaga un marcado manual como no leído. El historial importado no genera no leídos nuevos. Los cursores y los adjuntos deben pertenecer a la conversación y al workspace autorizados.

## Medios y límites de esta entrega

La API resuelve el adjunto en [el endpoint oficial de Zernio](https://docs.zernio.com/messages/get-message-attachment), previa autorización del mensaje. Solo descarga desde HTTPS en los CDN de Meta admitidos o desde el proxy de medios WhatsApp de Zernio. Valida cada redirección; la clave Zernio se usa exclusivamente en su ruta permitida, nunca se reenvía a un CDN y no llega al navegador. El `accountId` se obtiene de la base, no de un parámetro arbitrario del navegador.

Límite de vista: 20 MiB por archivo, con límite durante streaming y tiempo de espera. Los formatos no aptos para vista se entregan como descarga genérica. Un archivo vencido/no disponible muestra un error recuperable. Esta etapa **no copia los medios a Storage** ni garantiza conservar adjuntos que el proveedor ya no pueda recuperar; el almacenamiento permanente y el envío de multimedia corresponden a etapas posteriores.

## Verificación

- Backend: `npm run verify`, **122 pruebas aprobadas**. PGlite ejecuta todas las migraciones y verifica membresía, tablas privadas/publicación, lectura concurrente, aislamiento por usuario, borrado lógico, asignación compartida, historial con fechas iguales, más de 200 resúmenes, límites y orígenes de medios y ausencia de ruta de envío.
- Frontend: `npm run verify`, **95 pruebas aprobadas**, tipos y build correctos. Incluye filtros, claves de borrador, fallos de almacenamiento, transporte compartido, eventos agrupados, reconexión y recuperación de varias páginas de mensajes. Se conservan los avisos previos de Fast Refresh y tamaño/importación de chunks.
- Navegador: **17 recorridos existentes aprobados**, incluido Conversaciones/EvoAPI, y **1 recorrido nuevo de Inbox aprobado** sobre API y PostgreSQL locales. Cubre selector/canal, separación entre cuentas del mismo lead, lecturas, paginado, dos adjuntos, borradores/confirmación/recarga, archivo/no leído, respaldo ante cambios desde otra sesión y ancho móvil. Se revisaron capturas de escritorio y móvil.
- Auth, mensajes, cuentas y medios de navegador son sintéticos. El canal Realtime se simula en pruebas unitarias y se desconecta deliberadamente en el recorrido de navegador para probar el respaldo. No se verificó un WebSocket real de Supabase ni cuentas reales de Zernio; esa prueba queda para la activación.

## Orden de activación futuro

1. Aplicar las tres migraciones Inbox en orden y comprobar la publicación/RLS en el proyecto objetivo.
2. Publicar API/worker de ingreso y configurar las conexiones según [etapa 3](inbox-etapa-3.md).
3. Publicar frontend; vincular las cuentas Koi, verificar recepción, Realtime/reconexión y medios con conversaciones de prueba autorizadas.
4. Habilitar respuestas únicamente después de terminar y validar la etapa 5: outbox, worker independiente, idempotencia, resultados ambiguos y comprobación de la ventana de 24 horas antes de encolar y despachar.

Ver [plan completo](plan-implementacion-inbox-zernio.md) y [componentes compartidos](inbox-etapa-2.md).
