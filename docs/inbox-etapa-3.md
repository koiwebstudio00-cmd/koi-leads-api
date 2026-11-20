# Inbox: etapa 3 — conexiones, recepción e historial

Fecha: 20/11/2026. Estado: implementada y validada localmente; activación y prueba con cuentas reales pendientes. No se aplicaron migraciones remotas, no se crearon credenciales y no se desplegaron servicios.

## Qué está implementado

- Pantalla **Configuración → Conexiones de Inbox**, ruta `/configuracion/conexiones`. Permite conectar WhatsApp oficial e Instagram, reconectar una cuenta concreta, consultar su identidad/estado y reintentar procesamiento fallido. Los operadores pueden consultar; las modificaciones requieren administrador.
- Cliente Zernio exclusivamente backend: origen fijo, segmentos escapados, timeout de 15 segundos, rechazo de redirecciones HTTP, validación de respuestas y errores públicos sin cuerpos/tokens del proveedor. Respeta `Retry-After` y reprograma trabajos durables.
- Flujo alojado de Zernio/Meta con `scopes=messaging`; WhatsApp usa `onboarding=api` (Cloud API). El perfil Zernio está vinculado explícitamente al workspace Koi. No hay API keys ni tokens de Meta en el frontend.
- Estado de retorno aleatorio de 256 bits, guardado como hash, ligado a usuario, workspace, canal y cuenta cuando es reconexión. Vence a los 15 minutos. El retorno requiere sesión y vuelve a consultar la cuenta en Zernio; los parámetros del navegador no determinan su perfil ni identidad. Repetir una finalización idéntica es idempotente; reutilizarla para otra cuenta se rechaza.
- Webhook `POST /api/webhooks/zernio`: valida HMAC-SHA256 hexadecimal sobre los bytes originales, comprueba los identificadores de cabecera y persiste antes de responder. Un fallo de persistencia devuelve error y permite el reintento del proveedor. El límite de entrada es 1 MiB.
- Worker **solo de recepción e historial**, separado de campañas, chat EvoAPI y el futuro envío Inbox. Consume hasta cinco eventos y una página histórica por ciclo para que la recepción no impida recuperar historial. No envía mensajes a contactos.
- Cola durable, leases de dos minutos, recuperación después de interrupciones, reintentos con espera creciente y máximo de ocho intentos antes de revisión manual. Solo la lease vigente puede confirmar un trabajo. Un error guarda un código interno, nunca el mensaje SQL ni el cuerpo de error del proveedor.

## Contratos e integridad

Los IDs canónicos se normalizan de acuerdo con Zernio:

| Entidad | Webhook | REST/historial |
| --- | --- | --- |
| Cuenta | `account.accountId` (o `account.id`) | `accountId` / cuenta `_id` |
| Conversación | `conversation.platformConversationId` | conversación `id` |
| Mensaje | `message.platformMessageId` | mensaje `id` |

Los IDs internos de Zernio que también aparecen en el webhook no se usan como clave del historial. Las claves se aíslan por cuenta y workspace; los mismos IDs en dos cuentas no mezclan conversaciones. Una identidad social nunca se combina por nombre o username. Un teléfono explícito y válido de WhatsApp puede vincular un lead existente del mismo workspace. Sin teléfono se crea un contacto social con `phone=null`; no se inventa un número.

Los eventos repetidos y la coexistencia de webhook/historial comparten el mismo upsert. La fecha original del mensaje se conserva. `last_inbound_at` toma el máximo entrante válido, no la fecha de procesamiento ni la del webhook; un timestamp futuro no abre la ventana de respuesta. Los mensajes históricos no alimentan `last_live_inbound_at`, por lo que no crean pendientes nuevos. Recibir después el webhook de un mensaje previamente importado lo convierte en mensaje vivo una sola vez.

Los recibos leídos/entregados no retroceden por eventos atrasados. Un fallo sin una entrega confirmada no cuenta como respuesta enviada. El último saliente válido se calcula con un índice específico. El uso de estos campos en el contador y las lecturas por operador se conecta en la etapa 4; la validación autoritativa del envío de 24 horas corresponde a la etapa 5.

Los cambios de cuenta se verifican contra Zernio, para que un evento viejo de desconexión no prevalezca sobre la conexión actual. La caché dura hasta un minuto y conserva la fecha de comprobación: un resultado cacheado no reemplaza uno posterior. Una cuenta ya vinculada que Zernio devuelve como eliminada ante `account.disconnected` queda desconectada. Plataformas fuera del alcance y eventos de prueba se guardan como ignorados.

## Historial reanudable

Cada cuenta tiene un trabajo de conversaciones y cada conversación descubierta, uno de mensajes. Se usan páginas de 100 y cursores opacos. La página y el siguiente cursor se guardan en una misma transacción; ante un fallo se repite esa página sin duplicar mensajes. Se rechazan cursores repetidos/cíclicos, respuestas de otra cuenta y listados con fallos parciales.

La primera consulta incremental comienza en epoch y recorre el historial que Zernio tiene disponible. Al finalizar un recorrido, se guarda `sync.nextUpdatedSince`; cada cinco minutos se revisan los cambios con `updatedSince`. Se mantiene la ventana de solapamiento que proporciona Zernio. Esto permite incorporar historial que el proveedor termina de recuperar después de la vinculación inicial. Las páginas de mensajes conservan su propio cursor hasta terminar. Si se detecta un cambio mientras una conversación ya está importándose, se guarda una marca de revisión: al terminar, el worker vuelve a consultar la cabecera del historial antes de cerrar el trabajo. El avance incremental no descarta así cambios que coincidieron con una importación en curso.

La atribución recibida en webhooks se conserva en `inbox_attribution`. El contexto comercial de conversaciones históricas queda en `inbox_history_context`, privado. La presentación comercial completa y asociación de anuncios se desarrollan en la etapa 6.

**Límites del proveedor:** la integración recupera lo que Zernio/Meta exponen, no un respaldo completo garantizado. La documentación consultada describe límites de reproducción histórica en Instagram y permisos específicos para el acceso a mensajes. Los números que ya usan otro proveedor pueden necesitar completar pasos de migración en Meta/Zernio; ese estado real todavía no se verificó.

## Base de datos y permisos

Migración local: `20261120135825_koi_inbox_ingestion.sql`, creada con Supabase CLI. Depende de la migración de etapa 1.

- Nuevas tablas privadas: bindings de máquinas, estados de conexión, entregas recibidas, trabajos de sincronización y contexto histórico.
- Estado y fecha de comprobación en cuentas; fechas separadas de entrada viva/salida válida en conversaciones; descriptores de adjuntos en mensajes.
- Roles de grupo `koi_inbox_gateway` y `koi_inbox_ingest`, ambos sin login, superusuario ni bypass RLS. No reciben acceso directo a tablas. Las operaciones pasan por una función privada con `search_path` vacío, revocada a `PUBLIC`, `anon` y `authenticated`.
- Cada login de servicio necesita un binding por `session_user`, workspace, perfil Zernio, administrador responsable y tipo de proceso. El comando valida el binding, membresía del rol y administrador activo. Gateway y worker tienen listas distintas de acciones permitidas.
- No se otorgó acceso a Inbox a los roles existentes de campañas/EvoAPI. Las tablas nuevas tienen RLS y permanecen cerradas al navegador. No se habilitó Realtime en esta etapa.

## API y ejecución

| Método y ruta | Uso |
| --- | --- |
| `GET /api/inbox/connections` | Estado y cuentas del workspace; devuelve `configured=false` si la integración no está habilitada. |
| `POST /api/inbox/connections/connect` | `{channel,reconnectId?}`; devuelve la URL alojada de autorización. |
| `POST /api/inbox/connections/complete` | `{state,accountId}`; verifica y finaliza el retorno autenticado. |
| `POST /api/inbox/connections/refresh` | `{accountId}`; comprueba una cuenta ya vinculada. |
| `POST /api/inbox/connections/retry` | `{}`; vuelve a programar eventos e historial que agotaron los reintentos. |
| `POST /api/webhooks/zernio` | Ingreso firmado, sin sesión de navegador. |

Backend: `src/inbox/provider.ts`, `service.ts`, `webhook.ts`, `machine.ts`, `ingest-cycle.ts` e `ingest-worker.ts`. Frontend: `src/koi/InboxConnections.tsx`.

Comando local: `npm run worker:inbox-ingest`. Despliegue futuro: **`Dockerfile.inbox-ingest`**, que ejecuta el entrypoint específico, usa el usuario Node sin privilegios y comprueba un heartbeat. Permitir 60 segundos de parada para terminar la operación en curso. El healthcheck admite ciclos de hasta cuatro minutos; un proceso que no puede completar ciclos deja de renovar el heartbeat.

## Activación pendiente

1. Reconciliar el historial de migraciones de Supabase y aplicar las migraciones pendientes de Inbox en orden. Esta entrega solo las ejecutó en PGlite.
2. Crear dos logins PostgreSQL de servicio, sin privilegios globales: uno miembro de `koi_inbox_gateway`, otro de `koi_inbox_ingest`. Sus passwords van en el gestor de secretos del despliegue. No reutilizar logins de EvoAPI ni `service_role`.
3. Insertar un binding en `koi_private.inbox_bindings` para cada **nombre real de login PostgreSQL** (no el nombre del grupo): `role_name`, `workspace_id`, `profile_id`, `actor_id` y `kind` (`gateway` o `ingest`). El administrador indicado por `actor_id` debe pertenecer a ese workspace.
4. Configurar en la API las cinco variables juntas: `KOI_INBOX_GATEWAY_DATABASE_URL`, `ZERNIO_API_KEY`, `ZERNIO_WEBHOOK_SECRET`, `ZERNIO_PROFILE_ID`, `KOI_ZERNIO_WORKSPACE_ID`. El secreto del webhook debe tener al menos 32 caracteres. Usar un perfil exclusivo de Koi y una clave con acceso a sus conexiones/cuentas y mensajes.
5. Configurar el worker con `KOI_INBOX_INGEST_DATABASE_URL`, `ZERNIO_API_KEY`, `ZERNIO_PROFILE_ID`, `KOI_ZERNIO_WORKSPACE_ID` y el CA correspondiente. El Dockerfile conserva el certificado usado por el backend. Los dos bindings y las variables deben coincidir.
6. Publicar API/worker/frontend y crear en Zernio un webhook dirigido a `https://<host-api>/api/webhooks/zernio`, con el mismo secreto y filtrado al perfil de Koi. Suscribir `account.connected`, `account.disconnected`, `message.received`, `message.sent`, `message.delivered`, `message.read` y `message.failed`. La creación de este webhook no se automatizó para no duplicar configuraciones externas.
7. Vincular las cuentas desde Configuración y completar las autorizaciones de Meta con el administrador del negocio. Verificar permisos de mensajes, identidad y estado real. Hacer una prueba autorizada por cada canal y comprobar historial/reconexión antes de habilitar uso diario.

No habilitar la captación habitual antes de resolver el almacenamiento de medios de la etapa 6: los enlaces de medios recibidos pueden vencer. Esta etapa guarda el evento original privado y descriptores, pero **no descarga ni conserva los bytes de imágenes, videos o audios**. Tampoco crea plantillas, abre conversaciones salientes, envía respuestas ni incorpora la nueva pestaña de chats Inbox.

Si hay que detener la integración, apagar este worker y deshabilitar el webhook Zernio; conservar los eventos y tablas. No modificar los workers de EvoAPI ni borrar datos para revertir. La retención/limpieza de eventos, monitoreo y alertas de producción se completarán en la etapa 7.

## Validación y límites

- Backend: `npm run verify`, **115 pruebas** aprobadas. Incluye pruebas SQL/PGlite de roles, estado de autorización, duplicados entre historia/webhook, cuentas independientes, asociación al CRM, recibos, timestamps futuros, leases, rollback del cursor con una página fallida y cambios intercalados durante una importación paginada. También pruebas HTTP de firma sobre bytes originales, límite de tamaño y ausencia de ACK si falla la persistencia.
- Frontend: `npm run verify`, **90 pruebas**, tipos, lint y build aprobados. Se conservan avisos previos de Fast Refresh y bundles.
- Chrome: **17 recorridos** aprobados con `KOI_API_REPOSITORY=/Users/dev0/koi/koi-leads-api npm run test:e2e -- e2e/koi.spec.ts e2e/conversations.spec.ts`. Incluyen la nueva gestión en escritorio/móvil, retorno de autorización simulado, permisos y regresiones de chats EvoAPI. Se revisaron las capturas de ambas vistas.
- No se construyó ni desplegó la imagen Docker; las pruebas ejecutaron Node localmente. No hubo OAuth real, recepción de Zernio real, conexión a PostgreSQL remoto ni prueba de carga concurrente en PostgreSQL real. Estos controles siguen pendientes de activación.

## Fuentes verificadas y continuidad

Contratos consultados: [conexión OAuth](https://docs.zernio.com/connect/get-connect-url), [WhatsApp Cloud API](https://docs.zernio.com/platforms/whatsapp/connect), [firmas y entregas](https://docs.zernio.com/webhooks), [conversaciones e incremental](https://docs.zernio.com/messages/list-inbox-conversations), [historial de mensajes](https://docs.zernio.com/messages/get-inbox-conversation-messages), [evento entrante](https://docs.zernio.com/webhooks/inbox/message-received) y [tipos del SDK oficial](https://github.com/zernio-dev/zernio-node/blob/main/src/generated/types.gen.ts).

La **[etapa 4, Inbox de lectura y Realtime](inbox-etapa-4.md)** ya está implementada localmente, reutilizando los componentes de [etapa 2](inbox-etapa-2.md) y manteniendo separado el índice de EvoAPI. Ver el [plan completo](plan-implementacion-inbox-zernio.md).
