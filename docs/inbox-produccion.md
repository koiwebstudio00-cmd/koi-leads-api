# Inbox: entrega para producción

Actualizado el 20/11/2026. **Inbox de texto está desplegado en producción**, sin depender de procesos locales. Esta guía reemplaza el piloto con worker local de `inbox-webhook-publico.md`. El alcance publicado corresponde a lo implementado hasta etapa 5; la etapa 6 del plan completo sigue pendiente. El usuario hará después la prueba con mensajes reales.

## Alcance y estado real

- API y worker desplegados desde `main`: commit `d3e5f0e3b77e3604b22825b8f79d109f55c84b27` (incluye la implementación `f1dd20e`). Dokploy confirmó ambos despliegues como `Done`.
- Frontend desplegado desde `main`: commit `34efeead80b3579bed2c072ffa14af394b56d699`. Vercel confirmó producción `Ready`, despliegue `2M5oyTYAr2UpBH8rdMUmPhoiaddr`.
- Cuatro migraciones Inbox aplicadas a Supabase Koi; no volver a ejecutarlas ni hacer un `db push` global. Hay diferencias anteriores en el historial documentadas en `inbox-dev.md`.
- Implementado: conexiones WhatsApp/Instagram, historial, bandeja separada, actualizaciones Realtime y respuestas de texto con ventana de 24 horas validada en servidor y worker.
- Pendiente del plan completo: etapa 6 (adjuntos y audio salientes, circuito comercial completo) y cierre de etapa 7 (despliegue y validación real). No presentar esta entrega como el módulo completo terminado.
- Despliegue completo autorizado: API, worker en Dokploy, frontend y envío de texto habilitado. El usuario confirmó conservar los accesos limitados dentro del Supabase existente. La autorización reemplaza el alcance del piloto local.
- Worker creado en Dokploy: `koi-inbox-worker`, ID `xrf_T2pAV3Qrw2Wt3BSjw`, mismo proyecto/entorno que la API. Contenedor verificado en ejecución; recepción y dos ciclos de envío con latidos actualizados.
- Frontend confirmado en Vercel: cuenta `koi-studios-projects`, proyecto `casadey-agent`, dominio `leads.koistudio.com.ar`, repositorio `koiwebstudio00-cmd/casadey-agent`, rama productiva `main`. El nombre histórico no identifica al cliente Casadey actual.
- Archivos privados `.env.inbox-api-production` (6 variables) y `.env.inbox-worker-production` (5 variables) preparados con credenciales existentes, permisos `0600` y envío habilitado. No contienen credenciales administrativas ni requieren copiar un certificado; los Dockerfiles ya lo incorporan. Los archivos están ignorados por Git.
- El usuario cargó y guardó ambos bloques en Dokploy. Se verificaron claves requeridas, envío `true`, coincidencia de perfil/workspace/API key, ausencia de rutas locales y ausencia de claves duplicadas en la API. No se mostraron sus valores.
- API y worker locales detenidos antes de arrancar el servicio remoto. La recepción y el despacho productivos no dependen de la computadora.
- La rama `dev` conserva este registro de cierre posterior al despliegue; no se vuelve a publicar `main` solo por documentación para evitar reiniciar nuevamente los workers.

## Arquitectura final de esta entrega

```text
Zernio → API existente → cola en Supabase → worker Inbox en Dokploy
                                              ↓
                                     mensajes en Supabase
                                              ↓
                                      frontend / Realtime

Respuesta manual → API → cola de salida → mismo worker Inbox → Zernio
```

Se agrega una sola aplicación en Dokploy: `koi-inbox-worker`. La API, frontend, Supabase y workers de EvoAPI existentes se reutilizan. Gateway es el nombre del acceso de la API a PostgreSQL, **no otro servicio**. No se necesita Redis, n8n, una base adicional ni un servidor WebSocket propio. El funcionamiento productivo no debe depender de una computadora encendida.

## Qué son las credenciales y el certificado

| Elemento | Para qué se utiliza | Dónde va |
| --- | --- | --- |
| `KOI_INBOX_GATEWAY_DATABASE_URL` | Conexión a la misma base Supabase usando el login limitado `koi_inbox_api_login`. Permite persistir eventos y operar conexiones mediante funciones delimitadas. | Solo API. |
| `KOI_INBOX_INGEST_DATABASE_URL` | Conexión a la misma base usando `koi_inbox_ingest_login`. Permite procesar eventos, historial y cola de salida. | Solo worker Inbox. |
| `ZERNIO_API_KEY` | Acceso al proveedor para cuentas, historial y mensajes. | API y worker, nunca frontend. |
| `ZERNIO_WEBHOOK_SECRET` | Verifica que el evento recibido fue firmado por Zernio. | API y configuración del webhook en Zernio. |
| `ZERNIO_PROFILE_ID` / `KOI_ZERNIO_WORKSPACE_ID` | Identificadores del perfil Zernio y del espacio Koi. No son contraseñas. | API y worker. |
| `certs/supabase-prod-ca-2021.crt` | Certificado **público**, sin clave privada, para verificar TLS con Supabase. | Ya incluido en las imágenes Docker. |

Los dos logins ya fueron provisionados para Inbox. No son cuentas para miembros del equipo ni usuarios administradores. Sus permisos se limitan a funciones específicas y a un binding del workspace/perfil. La API no tiene permiso para despachar mensajes y ninguno recibe acceso directo general a las tablas privadas.

No reemplazar estos accesos por `postgres`, una credencial administrativa o `service_role`: sería ampliar privilegios. La conexión directa permite procesar las colas privadas sin exponerlas al navegador.

**No hay que pegar certificados en Dokploy.** Ambos Dockerfiles ya definen `KOI_DATABASE_CA_FILE=/app/certs/supabase-prod-ca-2021.crt` y copian el certificado. No cargar rutas locales `/Users/...`; si una variable existente sobrescribe esa ruta, corregirla al valor del contenedor. La verificación TLS permanece activa.

## Configuración de los tres componentes

Los siguientes bloques son referencias **sin secretos**, no archivos listos para pegar con sus placeholders. Reutilizar las credenciales privadas ya existentes; no crear ni rotar otras para este despliegue. No subir archivos privados a Git.

### API existente: koi-api

- Repositorio backend, rama `main`, Dockerfile `Dockerfile`, contexto `.`.
- Dominio y puerto existentes: `api-leads.koistudio.com.ar`, `3001`.
- Conservar variables de Evolution, Supabase y demás configuración actual.
- Origen: `KOI_APP_ORIGIN=https://leads.koistudio.com.ar`.
- No habilitar `KOI_RELAY_CHAT_MEDIA` de desarrollo en producción.
- Agregar las cinco variables de integración y la bandera de envío en **Environment de ejecución**, no en build arguments:

```dotenv
KOI_INBOX_GATEWAY_DATABASE_URL=<credencial existente de la API>
ZERNIO_API_KEY=<clave existente>
ZERNIO_WEBHOOK_SECRET=<secreto existente>
ZERNIO_PROFILE_ID=6a836444c7be73897fe0a1a7
KOI_ZERNIO_WORKSPACE_ID=727df779-b2eb-4485-9670-f1f7eb12e30e
KOI_INBOX_SEND_ENABLED=true
```

El valor productivo vigente es `true` en **API y worker**, con autorización del usuario. Para una instalación futura, se puede comenzar con `false` mientras se verifica la recepción. Cambiar la bandera no modifica la regla de 24 horas.

### Worker nuevo: koi-inbox-worker

- Mismo repositorio backend y mismo commit que la API.
- Build: `Dockerfile.inbox-ingest`, contexto `.`. El nombre histórico del Dockerfile no significa que haga solo recepción: el proceso también despacha texto.
- Una réplica. Sin dominio público, sin puerto publicado y sin sobrescribir el comando del Dockerfile.
- Reinicio automático del proceso al fallar; conservar logs y revisar el estado de salud.

```dotenv
KOI_INBOX_INGEST_DATABASE_URL=<credencial existente del worker>
ZERNIO_API_KEY=<misma clave existente>
ZERNIO_PROFILE_ID=6a836444c7be73897fe0a1a7
KOI_ZERNIO_WORKSPACE_ID=727df779-b2eb-4485-9670-f1f7eb12e30e
KOI_INBOX_SEND_ENABLED=true
```

El worker no necesita la contraseña de la API, el secreto del webhook ni una credencial administrativa. La bandera está configurada en `true`, igual que en la API.

### Frontend existente

Publicar el commit `34efeea` o su sucesor validado con estas variables de build:

```dotenv
VITE_KOI_SUPABASE_URL=https://avqhjbrcbgqhelfkcist.supabase.co
VITE_KOI_SUPABASE_PUBLISHABLE_KEY=<clave publicable existente>
VITE_KOI_API_URL=https://api-leads.koistudio.com.ar/api
```

No trasladar contraseñas PostgreSQL, claves Zernio ni secretos del webhook al frontend. La clave publicable de Supabase está diseñada para el cliente y el acceso sigue protegido por sesión y permisos.

## Orden de publicación

1. Alcance autorizado: esta entrega publica Inbox de texto con API, worker remoto, frontend y envío habilitado. El módulo completo del plan conserva etapas pendientes. No volver a pedir autorización por el alcance del piloto anterior.
2. Validar código de ambos repositorios y construir ambas imágenes. Revisar el SHA que se publicará y los servicios que tienen autodeploy sobre `main`; un push puede disparar otros servicios del mismo repositorio. No asumir que solo se desplegará la API.
3. Detener la API y el worker **locales de Inbox** antes de trasladar la operación al servidor. No detener los workers de Evolution. Los logins Inbox tienen límite de cuatro conexiones y cada proceso puede abrir tres: no dejar dos instancias permanentes por login ni hacer un reemplazo con solapamiento prolongado.
4. Cargar configuración de API y worker en Dokploy, inicialmente con envío `false`. Publicar el backend por fast-forward de `dev` hacia `main`, sin force push, conservando el cambio local ajeno en `.env.example`. Desplegar la API existente y el nuevo worker al mismo SHA.
5. Comprobar salud y recepción firmada antes de activar el webhook. `/health` por sí solo no prueba conexión con la base.
6. Registrar el webhook de Koi, ejecutar su prueba técnica y comprobar que se procesa. No reutilizar el webhook desactivado `toki-mvp-agent` de otro proyecto.
7. Publicar el frontend validado. Revisar acceso, cuentas, historial y actualizaciones con una sesión real. Con envío `false`, el compositor debe reflejar esa capacidad.
8. Con la autorización completa ya otorgada, cambiar `KOI_INBOX_SEND_ENABLED=true` en API y worker y redesplegar ambos. Comprobar los ciclos de envío antes del piloto real.
9. Validar recepción y una respuesta a una cuenta de prueba indicada por el usuario en WhatsApp e Instagram. No enviar mensajes a leads para probar. Registrar SHA, resultados y cualquier limitación antes de declarar la entrega operativa.

No es necesario aplicar una nueva migración para trasladar lo implementado a Dokploy. No ejecutar nuevamente `setup:inbox` para crear accesos que ya existen.

## Webhook Zernio

- Nombre: `Koi Leads Inbox`.
- URL: `https://api-leads.koistudio.com.ar/api/webhooks/zernio`.
- Perfil: `6a836444c7be73897fe0a1a7`.
- Secreto: mismo `ZERNIO_WEBHOOK_SECRET` de la API.
- Eventos: `account.connected`, `account.disconnected`, `message.received`, `message.sent`, `message.delivered`, `message.read`, `message.failed`.
- Listar los webhooks antes de crear para evitar duplicados.
- La prueba técnica `webhook.test` debe responder 200, persistirse y terminar como `ignored`. No crea conversaciones ni envía mensajes a contactos.

## Comprobaciones de cierre

- API saludable; webhook con firma inválida rechazado con 401 y firma válida aceptado después de persistir.
- Evento técnico procesado por el worker del servidor con el worker local detenido.
- Docker HEALTHCHECK actual comprueba el latido de **recepción**. No certifica por sí solo los ciclos de envío: con envío habilitado comprobar también que `/tmp/koi-inbox-send-1-heartbeat` y `/tmp/koi-inbox-send-2-heartbeat` se actualizan, además de `/tmp/koi-inbox-ingest-heartbeat`.
- Mensaje real entrante visible una sola vez y en la cuenta correcta; respuesta de prueba aceptada por el proveedor; fuera de ventana, envío bloqueado.
- Estados de entrega/lectura solo cuando el proveedor los informa. Timeout incierto no debe provocar reenvío automático.
- Reconexión del navegador recupera datos; reinicio del worker recupera trabajos sin duplicar envíos.
- Conversaciones EvoAPI y campañas siguen operativas.

## Resultado comprobado del despliegue

- 134 pruebas backend y 97 frontend aprobadas; tipos, lint y build frontend completados. Docker local estaba apagado; las imágenes se construyeron y desplegaron correctamente en Dokploy.
- API `/health` 200; webhook sin firma 401 con error específico de firma; evento técnico firmado 200 con `{received:true}`.
- Evento firmado `f4f004d6-8c8e-416c-b3c6-5c0c36062566`: persistido y procesado por el worker remoto en aproximadamente 770 ms, estado `ignored`, un intento.
- Webhook Zernio **`6b00a926968754b2787c0597`**, nombre `Koi Leads Inbox`, activo y restringido al perfil Koi. El webhook Toki anterior sigue sin modificarse.
- Prueba oficial de Zernio: HTTP 200, `success:true`; evento `71690640-ba9a-47fe-a385-dad8f70d33af`, procesado en aproximadamente 867 ms, `ignored`, un intento. Son pruebas técnicas sin mensajes a contactos.
- Worker remoto: contenedor `36dc57c0e961` en ejecución al verificar; `KOI_INBOX_SEND_ENABLED=true`; latidos de `ingest`, `send-1` y `send-2` con edad redondeada de 0 segundos. El identificador del contenedor cambiará con futuros despliegues.
- Supabase: WhatsApp e Instagram conectados; cero eventos pendientes/fallidos y cero sincronizaciones fallidas; cola de salida vacía.
- Navegador productivo autenticado: Inbox muestra 76 chats, actualizaciones en vivo e historial; una conversación con ventana abierta habilita el compositor de texto. No se escribió ni envió una respuesta de prueba.
- Regresión productiva: Conversaciones abre y carga 90 chats de la bandeja Número de campañas. Dokploy muestra API, worker Inbox, ambos workers EvoAPI y Evolution activos.
- Se comprobó la ausencia de los procesos locales de API/worker de Inbox después de detenerlos.
- **Pendiente exclusivamente de prueba real:** el usuario indicó “Lo pruebo yo después”. No se verificó todavía una recepción real seguida de una respuesta real en ambos canales; los tests técnicos y la habilitación del compositor no equivalen a una entrega real a WhatsApp/Instagram.

No se agregaron servicios externos, otra base, Redis ni n8n; se usó Supabase existente, API existente, un worker Inbox en el Dokploy existente y frontend existente en Vercel.

## Pausa y reversión

Para pausar nuevos envíos, poner la bandera en `false` en API y worker y reiniciar ambos; un POST ya iniciado puede terminar. Mantener recepción habilitada si funciona. Para detener eventos externos, desactivar solo el webhook Koi nuevo. Revertir código al SHA previo operativo si fuera necesario, conservando datos y migraciones. No borrar colas ni reintentar manualmente mensajes inciertos sin comprobar su resultado.
