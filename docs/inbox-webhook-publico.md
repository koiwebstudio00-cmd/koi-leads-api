# Activar el webhook público de Inbox

Preparación del 20/11/2026. Las cuatro migraciones Inbox están aplicadas. El envío y la recepción por historial funcionan en local; el webhook público todavía no está registrado.

## Alcance inmediato

Actualizar la aplicación existente **koi-api** para recibir eventos en:

`https://api-leads.koistudio.com.ar/api/webhooks/zernio`

Mantener el worker local de Inbox durante este piloto. No crear otro servicio ni modificar los workers de campañas/Conversaciones EvoAPI. El frontend local recibe los cambios de la misma base mediante Realtime. No se requiere publicar el frontend para comprobar la recepción.

La recepción depende de que el worker local permanezca encendido. Si se detiene, la API persiste los eventos en la cola y se procesan cuando vuelve a arrancar. Para operación permanente, trasladar posteriormente ese único proceso de Inbox a Dokploy.

## Situación comprobada

- Dokploy: proyecto `evolution api`, entorno `production`, aplicación `koi-api`, ID `6LlIjpE8qinkrPYXXNNdA`.
- Fuente GitHub: `koiwebstudio00-cmd/koi-leads-api`, rama `main`, autodeploy `On Push`, `Dockerfile` en la raíz.
- El POST público sin firma devuelve el error de sesión genérico. La versión desplegada todavía no tiene la ruta de Zernio; un GET al endpoint no permite determinarlo porque el webhook solo acepta POST.
- Zernio tiene un webhook `toki-mvp-agent` desactivado que apunta a otro proyecto. No modificarlo ni reutilizarlo.
- Perfil Koi: `Default`, ID `6a836444c7be73897fe0a1a7`.

## Configuración preparada

El archivo privado `.env.inbox-api-production`, ignorado por Git y con permisos `0600`, contiene únicamente los valores que se agregan a la API existente:

| Variable | Configuración |
| --- | --- |
| `KOI_INBOX_GATEWAY_DATABASE_URL` | Login gateway limitado ya provisionado. |
| `ZERNIO_API_KEY` | Clave existente; nunca usar una variable pública del frontend. |
| `ZERNIO_WEBHOOK_SECRET` | Secreto existente, idéntico al que se registrará en Zernio. |
| `ZERNIO_PROFILE_ID` | Perfil Default de Koi. |
| `KOI_ZERNIO_WORKSPACE_ID` | Workspace Estudio Koi. |
| `KOI_DATABASE_CA_FILE` | `/app/certs/supabase-prod-ca-2021.crt` dentro del contenedor. |
| `KOI_INBOX_SEND_ENABLED` | `false` en la API pública durante este piloto; los envíos siguen habilitados en la API/worker locales. |

Conservar las variables actuales de Supabase, puerto, origen de producción y Evolution. No reemplazar todo el entorno de Dokploy con el archivo local. No cargar la credencial administrativa ni la del worker en la API. Este archivo contiene secretos y no debe pegarse en documentación, commits o el chat.

## Publicación y verificación

1. Confirmar la autorización para actualizar la API de producción, agregarle las credenciales y activar el webhook de Zernio. La autorización anterior cubría migración y activación **locales**; el autodeploy de `main` afecta el servicio público.
2. Cargar las variables preparadas en `koi-api`, conservando las existentes. Publicar el commit revisado del backend en `main` y verificar que Dokploy despliegue ese SHA. No publicar el frontend ni desplegar workers EvoAPI como parte de esta entrega.
3. Comprobar `/health`, rechazo de firma inválida y un `webhook.test` firmado. La API debe confirmar JSON `{received:true}` después de persistirlo y el worker debe marcarlo `ignored`, sin crear chats ni envíos.
4. Listar nuevamente los webhooks de Zernio antes de crear uno. Si ya existe el mismo destino, inspeccionar perfil, eventos y secreto antes de reutilizarlo; no crear duplicados.
5. Crear `Koi Leads Inbox` con el destino anterior, secreto existente, `profileIds: ["6a836444c7be73897fe0a1a7"]`, `isActive: true` y estos eventos:
   - `account.connected`, `account.disconnected`
   - `message.received`, `message.sent`, `message.delivered`, `message.read`, `message.failed`
6. Ejecutar el test oficial de Zernio con el ID del webhook y verificar recepción/persistencia/procesamiento. Este test no envía mensajes a contactos.
7. Validar un mensaje entrante real de una cuenta de prueba que indique el usuario. Comprobar que aparece una sola vez, abre la ventana según su fecha original y actualiza Inbox. No enviar respuestas a contactos sin autorización concreta.

## Reversión

Desactivar solamente el webhook nuevo de Koi y volver al último SHA operativo de la API si fuera necesario. Conservar eventos y migraciones. No borrar datos, modificar el webhook de Toki ni tocar los workers EvoAPI. Si el worker local se pausa, los eventos válidos permanecen en la cola.

Referencias oficiales: [configuración, firma y prueba de webhooks](https://docs.zernio.com/webhooks), [creación y filtros por perfil](https://docs.zernio.com/webhooks/create-webhook-settings).
