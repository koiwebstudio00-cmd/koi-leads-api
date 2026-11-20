# Inbox: etapa 2 — componentes compartidos de chat

Fecha: 20/11/2026. Estado: implementada y validada localmente. Pendiente de commit, push y publicación.

Conversaciones utiliza ahora componentes compartidos para presentar la bandeja y el chat. Las consultas, la selección de cuentas EvoAPI, la sincronización del historial y las acciones del servidor permanecen en su contenedor. Esta separación permite montar Inbox con la misma UI y un adaptador Zernio en las etapas siguientes.

## Componentes del frontend

Todos los componentes están en `src/koi/chat/` del repositorio `koi-leads-web`.

| Archivo | Responsabilidad |
| --- | --- |
| `types.ts` | Contratos de presentación: mensajes, filas, cuentas, borradores, capacidades y transporte inyectable. |
| `ChatLayout.tsx` | Layout adaptable, encabezado con identidad/cuenta de respuesta y estado vacío. |
| `ChatSidebar.tsx` | Selector de cuentas, contadores, búsqueda, filtros, responsable y lista progresiva. |
| `ChatAvatar.tsx`, `format.ts` | Iniciales y fechas en el formato actual. |
| `ChatTimeline.tsx` | Burbujas, fechas, citas, reacciones, mensajes anteriores y acceso al final. |
| `ChatMessageStatus.tsx` | Guardando, sin confirmar, cola, aceptado, entregado, leído y errores. |
| `ChatAttachment.tsx` | Carga cancelable, imágenes, stickers, audio, video y descarga; libera las URLs temporales. |
| `ChatComposer.tsx` | Borrador, texto, adjuntos, grabación, mensajes guardados y estados de envío. |
| `ChatContactPanel.tsx` | Ficha lateral, responsable, etapa y acceso al lead; permite insertar acciones específicas del proveedor. |

Se conserva `conversations.css` y el comportamiento móvil. `ChatRowMenu`, `AssigneeSelect`, `SavedMessagePicker`, `VoicePreview` y el hook de grabación existentes se reutilizan. No se agregó una segunda copia de la pantalla.

## Límites entre UI y proveedor

- `Conversations.tsx` conserva sus rutas `/conversations`, selección y filtros locales, suscripción al índice, polling de respaldo, lecturas, paginación del historial, archivo y revisión de envíos. El hook `useInboxIndex` sigue siendo exclusivo de la bandeja EvoAPI.
- `evolution-chat-adapter.ts` contiene la serialización/base64 de los envíos, la carga de adjuntos, el endpoint y la clasificación de rechazos EvoAPI. Los componentes compartidos no conocen esas rutas.
- El compositor recibe `prepareMessage`, que devuelve una representación estable del contenido y una función `send`. Se conserva la misma clave de idempotencia al reintentar el mismo contenido, incluso al volver a adjuntar un archivo idéntico. La preparación no hace solicitudes HTTP. Un error al preparar el archivo no cambia el estado de una burbuja de un intento anterior.
- La capa de datos sigue siendo responsable de combinar mensajes confirmados y optimistas, deduplicar, reconciliar y actualizar el índice. El historial recibe callbacks para desplazamiento, carga anterior y citas.
- Encabezados y filas reciben identidades, etiquetas y rutas ya resueltas. Pueden representar `@usuario` sin teléfono y enlazar a `/inbox`. El canal se pasa explícitamente a adjuntos y estados, sin textos fijos de WhatsApp.
- Los contadores se calculan en el contenedor por cuenta; el componente lateral no consulta ni combina los datos de ambas bandejas. La nueva pantalla deberá proporcionar exclusivamente su índice Inbox.

## Capacidades y ventana de respuesta

El compositor recibe límite de texto, MIME aceptados, tamaño máximo y disponibilidad de grabación. Para EvoAPI se mantienen 4.000 caracteres, archivos de hasta 4 MiB y los formatos existentes. La grabación conserva el hook actual; aún no hay conversión de audio para Instagram.

`disabled` y `unavailable` permiten mostrar el motivo y bloquear la edición/envío cuando la conversación no puede responderse. Eso prepara la UI de la ventana de 24 horas, pero **no implementa ni sustituye su validación en la API y el worker de Inbox**. La conexión de esa política se realizará en la etapa 5. Las capacidades Zernio definitivas y la conversión multimedia se conectarán con el adaptador y la etapa 6; hasta entonces no habilitar formatos o grabación que no pueda enviar el canal.

El selector permite insertar el filtro de canal y omitir la acción de nuevo chat. Inbox utilizará esta opción porque la primera versión responde a conversaciones entrantes.

## Validación

- `npm run verify` en el frontend: lint, tipos, **90 pruebas** y build aprobados. Se conservan avisos preexistentes de Fast Refresh, tamaño de bundle e importación mixta de `Statistics`.
- Ocho pruebas nuevas verifican preparación/envío, huella del contenido, errores de archivo, rechazos frente a resultados ambiguos, cancelación/carga de medios, identidad de Instagram, compositor bloqueado y diferencia entre aceptación y entrega/lectura.
- `KOI_API_REPOSITORY=/Users/dev0/koi/koi-leads-api npm run test:e2e -- e2e/koi.spec.ts e2e/conversations.spec.ts`: **14 pruebas Chrome aprobadas**.
- El recorrido integral de conversaciones usa la API local y PGlite con datos sintéticos: recepción duplicada sin duplicar burbujas, PDF con confirmación demorada, persistencia, cambio de etapa, filtros, audio adjunto/grabado, biblioteca, citas, reacciones y stickers. Las pruebas restantes usan respuestas simuladas, incluyendo el selector con varias cuentas, borradores y contactos sin teléfono.
- Se inspeccionaron las capturas de escritorio y móvil del chat. No se probaron conexiones ni entregas reales con Evolution o Zernio y no se midió latencia de producción.
- No se cambiaron endpoints, workers ni migraciones en esta etapa. La validación backend de 99 pruebas corresponde a la etapa 1.

## Publicación y siguiente entrega

Esta etapa no agrega todavía la ruta ni la navegación de Inbox. Se montarán en la etapa 4, sobre las conexiones, ingestión e historial de la etapa 3. Tampoco conecta cuentas, aplica la migración de etapa 1 ni despliega servicios.

Continuación: la base de conexiones, recepción e historial está implementada localmente en [etapa 3](inbox-etapa-3.md). La siguiente entrega es Inbox de lectura y Realtime (etapa 4), siguiendo el [plan completo](plan-implementacion-inbox-zernio.md). La base de datos y sus límites están documentados en [etapa 1](inbox-etapa-1.md).
