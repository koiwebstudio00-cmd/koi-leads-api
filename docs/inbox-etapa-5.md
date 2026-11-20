# Inbox: respuesta manual de texto — etapa 5

> Actualización de cierre: API y worker ya están desplegados en Dokploy y frontend en Vercel, con texto habilitado y webhook activo. Los procesos locales se detuvieron. El usuario hará después la prueba con mensajes reales. Ver [estado productivo y evidencias](inbox-produccion.md). El contenido siguiente conserva la preparación y validación local previa.

Estado al 20/11/2026: implementado y probado en `dev`, **migración aplicada en Supabase y envío habilitado en API/worker locales**. La aplicación necesitó autorización explícita por los nuevos permisos de despacho; el usuario la otorgó y la migración se completó. No se enviaron mensajes a contactos reales ni se hizo push o despliegue de servicios en producción.

## Arquitectura y alcance

Se conserva la API y un único proceso `worker:inbox-ingest`. Ese proceso tiene un ciclo de recepción/historial y dos ciclos de despacho independientes: las llamadas de historial no bloquean las respuestas manuales. Reutiliza el login `koi_inbox_ingest_login`, su binding y la tabla `koi_private.inbox_outbox` ya creada. No requiere otro servidor, otra base, otra credencial, Redis ni n8n.

Esta etapa habilita **texto** para WhatsApp e Instagram. Los adjuntos y las notas de voz salientes corresponden a etapa 6; siguen deshabilitados. No incluye plantillas, HUMAN_AGENT, campañas ni automatizaciones.

## Comportamiento

- La API autentica al usuario; la función SQL vuelve a comprobar membresía, workspace y conversación. La cuenta y el destinatario se resuelven desde la base. El cliente no puede indicar destinatarios, plantillas, tags ni timestamps.
- La misma función `inbox_reply_window` gobierna lectura, aceptación del envío y comienzo del despacho. Solo permite responder mientras el reloj del servidor esté estrictamente antes del último entrante válido + 24 horas, con una cuenta conectada.
- Antes del despacho se verifica la cuenta actual en Zernio, su perfil, canal y workspace configurado. Se vuelve a verificar la ventana justo antes del POST. Un envío vencido o rechazado queda fallido con su texto recuperable como borrador.
- El guardado del mensaje y la cola son atómicos. El navegador conserva la clave del intento en `sessionStorage`, aislada por usuario/workspace/conversación, para recuperar una respuesta HTTP perdida incluso al recargar. La base rechaza reutilizar una clave con otro contenido.
- La clave enviada a Zernio es el UUID global del trabajo, diferente de la clave elegida por el navegador; no colisiona entre usuarios o workspaces.
- Se conserva el orden por conversación y se permite despachar dos conversaciones en paralelo. No se aplican horarios, cupos ni pausas de campañas. Se respetan los límites reales de Zernio/Meta; un 429 vuelve a la cola con espera y un máximo de cinco intentos.
- Los estados son guardando, en cola, enviando, aceptado, entregado/leído cuando el proveedor lo informa, fallido y sin confirmar. La burbuja optimista no representa entrega real.
- HTTP y webhook se concilian por el identificador externo de mensaje. Si el webhook llega primero, se conserva el ID local, la lectura y el estado de entrega; el frontend elimina la burbuja duplicada al recibir esa confirmación. Nunca se vinculan mensajes solamente por coincidencia de texto.
- Timeout, respuesta ambigua, 409 del proveedor o interrupción después de comenzar el POST dejan el envío `unknown`. No hay reenvío automático: se solicita historial, se bloquean nuevos envíos de esa conversación y se ofrece **Marcar como revisado** después de comprobar el resultado en Zernio. Esa acción no reenvía ni afirma que el mensaje haya salido.
- Un reinicio antes del comienzo del POST permite recuperar la reserva vencida. Una reserva de un POST ya iniciado pasa a `unknown`; un resultado de una reserva vencida no puede cambiar el estado.

La [documentación de envío de Zernio](https://docs.zernio.com/messages/send-inbox-message) indica que su idempotencia conserva respuestas exitosas durante 24 horas, pero un fallo después de aceptación puede liberar la clave. Por eso no se reintentan ciegamente los resultados ambiguos ni se interpreta un historial vacío como prueba de que el mensaje no salió.

## API y permisos

| Ruta | Contrato |
| --- | --- |
| `GET /api/inbox/capabilities` | `{sendText:boolean}`; requiere sesión. |
| `POST /api/inbox/conversations/:id/messages` | `{text:string}` y cabecera `Idempotency-Key` UUID. Devuelve el mensaje persistido, normalmente en cola. |
| `POST /api/inbox/conversations/:id/resolve-send` | `{messageId:uuid}`; solo cierra un envío `unknown` de esa conversación y workspace. |

La migración `20261120123733_koi_inbox_manual_send.sql` agrega `dispatched_at`, un índice de orden, campos de correlación al read model y dos funciones. Su nombre local se alineó con la versión asignada por Supabase; la versión de creación local era `20261120152501` y el contenido SQL no cambió al renombrarla.

- `public.koi_inbox_send`: ejecutable por `authenticated`, comprueba `auth.uid()` y membresía antes de acceder a datos. `anon` no tiene permiso.
- `koi_private.inbox_dispatch`: ejecutable solo por `koi_inbox_ingest`; exige el login/binding real mediante `session_user` y un administrador vigente. El gateway no recibe permiso de despacho.

Ambas fijan `search_path` vacío. No se abre SELECT/INSERT directo de las tablas privadas. RLS y la publicación Realtime existente permanecen intactos. El [aviso de advisor para funciones SECURITY DEFINER autenticadas](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable) fue revisado: corresponde a la nueva RPC autenticada con comprobación explícita de membresía. Se comprobaron remotamente los permisos de `anon`, `authenticated`, gateway y worker; no se concedieron permisos amplios para silenciarlo. Los demás avisos de seguridad son anteriores a esta entrega.

## Activación y operación

1. Migración aplicada y permisos/advisors revisados. No volver a ejecutarla ni hacer un `db push` global.
2. `KOI_INBOX_SEND_ENABLED=true` ya está configurado en la API y en el mismo worker local: `.env` y `.env.inbox-worker`. En una instalación nueva el valor predeterminado es `false`.
3. API y worker ya fueron reiniciados. Refrescar el frontend. Para pausar, establecer ambos flags en `false` y reiniciar: se conservan mensajes, eventos y cola. Los trabajos ya iniciados pueden terminar; no asumir que cambiar una variable cancela un POST en curso.
4. Publicar el webhook HTTPS y validar eventos reales. Sigue pendiente desde etapa 3; el historial periódico no sustituye la recepción inmediata.
5. Probar una respuesta expresamente autorizada en cada canal con una conversación que tenga la ventana abierta. No se hizo esa prueba real en esta entrega.

El script `setup:inbox` conserva el flag existente del worker al regenerar su archivo privado. No activa envíos por sí solo. El comando y `Dockerfile.inbox-ingest` conservan su nombre para evitar otro despliegue separado. Los latidos de despacho son `/tmp/koi-inbox-send-1-heartbeat` y `/tmp/koi-inbox-send-2-heartbeat`; los errores registran códigos sanitizados, nunca tokens o cuerpos del proveedor.

## Validación

- Backend: 134 pruebas y TypeScript. Base PostgreSQL embebida con todas las migraciones; aislamiento, idempotencia, límites de ventana, orden/concurrencia, recuperación, autorización, webhook previo a HTTP y fallos ambiguos.
- Frontend: 97 pruebas, lint, tipos y build. Persistencia de claves y reconciliación de mensajes locales/HTTP/webhook. Persisten los avisos anteriores de Fast Refresh y chunks.
- Navegador: recorrido Inbox con API y base reales de prueba y proveedor sintético; texto en ambos canales, revisión de incertidumbre, ventana cerrada y borradores. Regresión de Conversaciones/EvoAPI aprobada.
- Activación real: API `/health` 200; flags habilitados; latidos de recepción y ambos ciclos de despacho actualizados; login real del worker puede consultar la cola vacía. Inbox revisado con la sesión real, mostrando el chat, la cuenta y la ventana de respuesta. No se efectuó un POST de mensajes a Zernio real. El piloto de respuesta y el webhook público siguen pendientes.
