# Inbox multimedia en WhatsApp e Instagram

Esta entrega extiende Inbox oficial. La API y el worker deben usar la misma versión. El frontend consulta las capacidades de la API al abrir el módulo. El estado de entrega solo se confirma cuando lo indica el proveedor.

## Estado al 20 de noviembre de 2026

Las migraciones de esta tabla están aplicadas en `back_web` (`avqhjbrcbgqhelfkcist`), el proyecto de Supabase de Koi Leads. Los archivos locales usan las versiones registradas en el historial remoto.

| Versión aplicada | Migración | Función |
| --- | --- | --- |
| `20261120192229` | `koi_inbox_received_media` | Captura privada de adjuntos recibidos |
| `20261120192350` | `koi_inbox_interactions` | Citas, reacciones y ventana de atención humana |
| `20261120192538` | `koi_inbox_outbound_media` | Cola de envío con archivos y notas de voz |
| `20261120205010` | `koi_inbox_instagram_reel_preview` | Identificador de los reels compartidos en el historial autorizado |

Se verificaron en Supabase el trigger de recepción, la seguridad por fila y los permisos de las cuatro tablas privadas, las funciones de la API y el acceso del worker. La base también reconoció un documento de WhatsApp y una imagen de Instagram en pruebas de validación de formato.

La verificación local incluyó conversión de voz con FFmpeg, pruebas de la API y recorridos en Chrome con un proveedor simulado. Quedan pendientes la construcción de la imagen del worker, el despliegue de esta versión y la prueba de entrega con ambas cuentas de ensayo.

## Activación y pausa

1. En `back_web`, continuar con el despliegue. Para otro entorno, comparar su historial con la tabla anterior y aplicar únicamente las migraciones pendientes en ese orden. Las diferencias históricas del proyecto figuran en [la guía de desarrollo](inbox-dev.md).
2. Publicar API, worker de Inbox y frontend. Mantener la configuración de las cuentas existentes. Incluir `reaction.received` en el webhook firmado de Zernio. Para cuentas de Instagram antiguas verificar que Meta tenga actualizada la suscripción.
3. Configurar `KOI_INBOX_RICH_ENABLED=true` en API y worker para habilitar lectura multimedia por canal y la captura de medios recientes. Para despacho de contenido, citas y reacciones se requiere además `KOI_INBOX_SEND_ENABLED=true` en ambos. El worker necesita el Dockerfile de Inbox de esta entrega para procesar notas de voz.
4. Solo tras verificar el permiso de atención humana en una cuenta de Instagram, un administrador de base puede establecer `inbox_human_agent_enabled=true` en esa fila de `public.koi_inbox_accounts`, identificándola por workspace, ID y canal. Por defecto, las cuentas usan la ventana estándar. El operador puede usar la extensión hasta siete días para texto manual. Medios y reacciones requieren la ventana estándar. WhatsApp conserva el límite de 24 horas.
5. Comprobar el estado de salud del worker y las marcas de actividad de ingest, media, reactions y envío, según las funciones habilitadas. Para pausar todo despacho, deshabilitar el envío en API y worker. Para pausar solo la ampliación, deshabilitar la opción rich en ambos y reiniciar. Un envío ya iniciado puede terminar. Revisar el estado antes de repetir un envío incierto.

## Medios y datos

El envío acepta archivos de hasta 8 MiB con límites inferiores por formato y plataforma. Instagram exige enviar archivo y texto por separado. Los binarios salientes se guardan en la base privada asociados al trabajo para su despacho y lectura posterior. Dimensionar el almacenamiento según el volumen de conversaciones. El worker prepara la carga al proveedor antes de verificar otra vez la ventana y despachar.

En recepción, la API exige sesión y acceso al chat. Un proceso independiente intenta conservar una copia privada de los adjuntos entrantes recientes (hasta 8 MiB cada uno, siete días y 128 MiB por workspace). Fuera de esa caché, la API intenta la consulta autorizada al proveedor (hasta 20 MiB). Los archivos históricos dependen de que Zernio/Meta aún los tenga. El historial autorizado devuelve la descripción de cada adjunto y, para un enlace de reel reconocido, su identificador de Instagram. Los parámetros privados del enlace quedan fuera de la respuesta. La clave de Zernio se utiliza en el backend.

WhatsApp admite recepción de stickers. El envío nativo de stickers personalizados de WhatsApp no figura en el contrato público de Zernio. Instagram ofrece el sticker saliente de corazón. Las citas salientes se habilitan solo en WhatsApp. La interfaz de Instagram identifica el contenido compartido según los metadatos disponibles.

## Reels y acciones de contacto

La proyección del historial reconoce enlaces de Instagram con ruta `/reel/<código>/` en adjuntos de tipo original `ig_reel` o `reel`. Funciona también para mensajes anteriores a la migración. El frontend construye la vista previa y el enlace a Instagram a partir del código. La visibilidad del reel depende de los permisos de la publicación.

La ficha utiliza el usuario de Instagram guardado. Si falta, consulta `GET /api/inbox/conversations/{id}/instagram-profile`. El backend comprueba el acceso del operador al chat y la correspondencia de la cuenta con el perfil de Zernio antes de resolver el usuario del participante.

Para WhatsApp, el selector consulta `GET /api/integrations/evolution/instances?senderPhones=1` y los chats del lead en `GET /api/conversations/by-lead/{leadId}`. Muestra las líneas conectadas con su etiqueta y, cuando Evolution lo informa, su teléfono. La combinación de lead e instancia determina qué chat se retoma. Si todavía no existe, se abre un borrador.

En producción, publicar la API antes del frontend para que estén disponibles la consulta de perfiles y los teléfonos de las líneas. La migración de reels ya figura en el historial de `back_web`.

## Prueba de aceptación por cuenta

- Abrir un chat de Instagram con un reel compartido y comprobar la vista previa y el enlace a la publicación. Con varios mensajes salientes leídos, comprobar que aparezca un único «Visto» bajo el último con lectura confirmada.
- Abrir la ficha de un contacto de WhatsApp y probar el selector con una línea que ya tenga chat y otra que todavía no lo tenga. Comprobar el historial o el borrador correspondiente antes de enviar.

- Usar dos cuentas de prueba, una por plataforma. Desde la aplicación oficial enviar texto, sticker, nota de voz, foto, video y un documento compatible. Comprobar identidad de la cuenta, orden, una sola copia y apertura o reproducción desde el chat. Repetir tras recargar.
- Desde Koi responder con grabación, imagen, video y un documento válido. Verificar la recepción real, el tipo de mensaje y la capacidad de reproducirlo o abrirlo. En Instagram probar también el corazón. En WhatsApp comprobar que una grabación aparece como nota de voz.
- En WhatsApp citar un mensaje recibido. Agregar, cambiar y quitar una reacción en las dos plataformas. Desde el teléfono del contacto volver a reaccionar. Comprobar que se actualiza el mensaje correcto, incluso si está en una página antigua del historial.
- Verificar el cierre de ventana, la conservación del borrador, la desconexión del proveedor y el rechazo de acceso a un adjunto desde otro workspace. Comprobar que una cuenta sin extensión humana sigue bloqueada después de 24 horas.
- Probar escritorio y móvil. Registrar resultado por canal, tipo y dirección. Guardar identificadores sanitizados, sin claves, medios personales ni cuerpos de mensajes en los logs.

Los tests automatizados usan un proveedor sintético y PostgreSQL embebido. Para ejecutar los recorridos de navegador, definir KOI_API_REPOSITORY apuntando al repositorio de la API y usar Node 24. El piloto con cuentas reales verifica permisos, webhook registrado, formatos aceptados y entrega efectiva.
