# Gestión de WhatsApp desde Koi

La pantalla **WhatsApp** permite a administradores crear una conexión adicional, vincular mediante QR, reconectar una sesión y desconectarla tras confirmación. Los operadores solo consultan estados.

- `koi-01` es el remitente de campañas y la instancia verificada con Conversaciones en producción.
- Las sesiones adicionales se registran al vincularlas. Para recibir eventos en Conversaciones requieren configurar el webhook en Evolution por instancia. Las campañas siguen usando el remitente principal.
- Los nombres visibles son editables al crear; el identificador Evolution lo genera PostgreSQL a partir de un UUID no elegible por el cliente. La API nunca admite URLs, claves o nombres arbitrarios de instancias.
- El registro persiste en `koi_whatsapp_instances`, aislado por RLS y workspace. Solo admin puede insertar. No hay permisos de actualización o borrado desde Data API. Hasta 10 sesiones adicionales por espacio.
- Un alta interrumpida conserva su registro: **Vincular con QR** comprueba la existencia en Evolution y completa la provisión. La clave de idempotencia evita duplicar el alta ante reintentos idénticos.
- Reconectar usa `POST /instance/restart/:name`; desconectar usa `DELETE /instance/logout/:name`. Vincular usa `GET /instance/connect/:name` en Evolution, expuesto como POST autenticado en Koi porque puede abrir una sesión.
- Para reconectar o desconectar el remitente se exige que no haya campañas activas (incluidas pausadas), reservas/envíos en curso o resultados inciertos. Si otro proceso comienza una campaña simultáneamente, el worker mantiene su comprobación de conexión y pausa ante fallos.
- El QR solo se devuelve como PNG inline, con `Cache-Control: no-store`; se conserva en memoria mientras el diálogo está abierto, se oculta a los 40 segundos y requiere regeneración. No se devuelven tokens, claves ni el objeto completo del proveedor.
- La consulta de estado se repite cada 5 segundos mientras el QR está abierto y se detiene al cerrar o conectar. No se guarda el QR en localStorage.
- No hay eliminación de instancias desde esta versión: desconectar cierra la sesión sin borrar su registro.

## Despliegue

La migración `koi_whatsapp_instances` está aplicada en producción. El health de la API anuncia `whatsapp-instances-v1`. El despliegue de Conversaciones usa las credenciales existentes de Evolution, del worker y del webhook. [Configuración y orden de despliegue](despliegue-campanas.md).

## Marca y tema

Frontend: tema [CliniDS de tweakcn](https://tweakcn.com/r/themes/cmkybzyzr000004l515sz2eox), instalado con shadcn. Roboto se sirve localmente. Símbolo original de [Koi Studio](https://koistudio.com.ar/assets/brand/koi-symbol.png); WhatsApp mediante Simple Icons. Se conserva la distribución del dashboard, importaciones y campañas.

## Conversaciones

- Desde **Conversaciones → Nuevo chat** se puede buscar un lead y elegir una cuenta de WhatsApp. La bandeja permite buscar, filtrar no leídos y archivados, asignar un responsable y consultar el historial disponible en Evolution desde la ficha del chat.
- Se admite texto, imágenes JPG/PNG, PDF y audio OGG, MP3 o MP4 de hasta 4 MiB por archivo. El audio y el texto se envían por separado. La API valida el formato y controla el acceso al adjunto por conversación y espacio.
- La API autenticada de `/api/conversations` consulta y encola mensajes. El worker realiza el envío a Evolution con idempotencia y sin repetir resultados inciertos. Los estados de entrega llegan por el webhook. Aceptado, entregado y leído son estados distintos.
- Supabase Realtime publica cambios de `public.koi_conversations` en `supabase_realtime`. El navegador se suscribe por espacio y vuelve a consultar la API. Si se pierde la suscripción, recurre a consultas periódicas.
- El alcance actual cubre chats individuales de WhatsApp. Agentes de IA, Instagram y TikTok quedan para etapas posteriores.

### Verificación en producción

El 10/11/2026 se aplicaron las tres migraciones de la entrega, se desplegaron API y worker en Dokploy con `6a7b672` y el frontend en Vercel con `090646b`. Se comprobó el latido del worker y se agregó `SEND_MESSAGE` al webhook de `koi-01`.

1. Desde la bandeja se envió un texto a un número propio autorizado. Koi registró la entrega y mostró la respuesta de WhatsApp en vivo, sin recargar. Al volver a abrir el chat, la respuesta seguía visible y figuraba una sola vez.
2. El PDF de prueba pasó por la cola y el worker de producción. Koi registró la entrega, mostró el adjunto tras recargar y permitió abrirlo. El destinatario confirmó que recibió el PDF en su teléfono.
3. El PDF se encoló directamente para la prueba productiva. La selección de archivo desde el navegador se verificó en Playwright local y queda pendiente de comprobar en producción.

## Audio en el chat y recuperación local

Los audios grabados desde el navegador se pueden escuchar antes de enviarlos. La confirmación usa la misma cola que los audios adjuntos. La API acepta Ogg, MP3 o MP4 de hasta 4 MiB. El grabador detiene la captura a los 3 minutos. El chat muestra un reproductor dentro de la burbuja y permite descargar el archivo.

Los adjuntos salientes guardados se leen desde la base. Para los entrantes, la API consulta Evolution. En desarrollo local, `KOI_RELAY_CHAT_MEDIA=true` permite recuperar los adjuntos desde `https://api-leads.koistudio.com.ar` cuando la API local no tiene una conexión directa a Evolution. La API verifica el acceso al chat antes de pedir el adjunto y la API del estudio verifica la misma sesión. La opción requiere que `KOI_APP_ORIGIN` sea local y se lee al iniciar el servidor.

Se verificó el grabador y la cola con un micrófono simulado. En el entorno local se recuperaron dos audios entrantes reales de la bandeja del estudio y se comprobó que ambos cargaban el reproductor.

## Reacciones, stickers y respuestas citadas

Con Evolution 2.3.7 y Baileys, Koi procesa estos formatos a partir de los eventos de mensajes ya configurados. Verificar `MESSAGES_UPSERT` en cada instancia y `SEND_MESSAGE` para registrar mensajes salientes. Las reacciones se asocian al mensaje original dentro del mismo espacio, instancia y chat. Los cambios y retiros se aplican según la marca de tiempo del proveedor. La descarga autenticada de stickers valida el formato WebP y el límite de 4 MiB. Las citas usan la referencia original y muestran el fragmento del proveedor cuando el original no está guardado.

Después del despliegue, desde un contacto de prueba, agregar, cambiar y retirar una reacción, enviar un sticker estático y uno animado, y responder citando un mensaje saliente. Verificar que la reacción se mantenga en la burbuja original, que ambos stickers carguen y que la cita lleve al mensaje si está disponible. Las ediciones de mensajes siguen pendientes de validar con Evolution.

## Despacho manual independiente — 12/11/2026

Los chats manuales quedan fuera de los intervalos, cupos y horarios de campaña. Usan un worker propio con prioridad por número, sin consumir presupuesto de campañas. Requiere una migración nueva y sustituir el worker mixto por dos servicios compatibles. [Configuración, permisos, despliegue y reversión](envio-manual-inmediato.md). Implementado localmente; pendiente de despliegue productivo.
