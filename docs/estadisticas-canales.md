# Estadísticas de WhatsApp e Instagram

La pestaña Estadísticas conserva el resumen CRM y agrega dos informes de lectura. El backend consulta Zernio con la integración existente de Inbox. La sesión de Koi, el workspace configurado y el perfil del login de PostgreSQL deben coincidir. Las credenciales y los identificadores de clic permanecen en el backend.

## Anuncios a WhatsApp

Al abrir el informe, Koi descubre los anuncios a partir de la cuenta publicitaria conectada al perfil. Clasifica el destino por los datos del anuncio, el número medido y las referencias entrantes cuando están disponibles. Si Meta usa el WhatsApp predeterminado de una página y Zernio omite el número, el anuncio queda pendiente hasta que una referencia entrante u otro dato verificable confirme el destino. El informe excluye su gasto del total confirmado mientras tanto. El desglose por campaña y anuncio incluye anuncios con inversión y cero consultas. Las monedas se muestran por separado.

Una consulta se asigna al primer origen publicitario identificado de una conversación oficial de WhatsApp. El webhook de mensajes y la sincronización del historial pueden completar el origen en distinto orden. Los mensajes posteriores, la relectura del historial y la repetición del mismo evento conservan el conteo. El informe separa chats sin atribución y referencias con campaña pendiente. Una referencia histórica sin fecha verificable queda fuera del período y se informa por separado.

La fecha de la consulta corresponde al primer mensaje atribuido, o a la fecha de captura que devuelve el historial del proveedor. El período usa días completos de Argentina. Al cotejar la inversión con Ads Manager, seleccionar las mismas campañas, destinos, fechas y moneda, y comprobar la zona horaria de la cuenta publicitaria. El costo por consulta es inversión dividida por consultas del mismo grupo y período. Con cero consultas se muestra un guion.

## Instagram

El informe consulta alcance único del rango, visualizaciones, interacciones, seguidores actuales y cambio de seguidores durante el período. La variación requiere muestras en ambos extremos. Si el proveedor limita el rango, Koi puede sumar visualizaciones e interacciones en tramos disjuntos. El alcance requiere un total único del período completo.

## Activación

1. La migración `20261120203605_koi_channel_statistics` está aplicada en producción (`back_web`). Supabase registró tres tablas privadas y quedaron activos los dos disparadores de captura. Para un entorno nuevo, aplicar esa misma migración antes de publicar la API. Esta migración conserva las referencias históricas disponibles y habilita la captura de las nuevas aun cuando el panel esté cerrado. La inversión se consulta al abrir o actualizar el informe y se conserva para lecturas posteriores.
2. Publicar la versión compatible de la API y luego el frontend. Se reutilizan las variables de Zernio, el workspace vinculado y la conexión restringida del gateway de Inbox.
3. En Estadísticas → Anuncios a WhatsApp, si aparece **Conectar Meta Ads**, ingresar como administrador y autorizar la cuenta publicitaria que paga los anuncios al WhatsApp de Koi. Verificar que el usuario de Meta tenga acceso al rendimiento del activo. La inversión requiere acceso de lectura a Ads (`ads_read`) y un plan de Zernio con acceso al módulo. El consentimiento de la conexión publicitaria de Zernio puede incluir también `ads_management`. El panel usa esa conexión para consultas de lectura. La autorización vincula la cuenta. Los anuncios se descubren automáticamente.
4. Para Instagram se necesita una cuenta profesional con analíticas. Si el panel señala un permiso pendiente, usar Configuración → Conexiones y reconectar la misma cuenta. Koi solicita mensajería y analíticas. El permiso de Meta es `instagram_business_manage_insights` con Instagram Login o `instagram_manage_insights` con Facebook Login.
5. Verificar los filtros de fechas, que se vean las campañas con gasto y que una caída de un proveedor deje operativo el resumen CRM. Un dato sin cobertura aparece como no disponible.

## Prueba después del despliegue

1. Abrir Estadísticas → Anuncios a WhatsApp y elegir un rango que empiece el día de lanzamiento. Comparar la inversión con Ads Manager para todos los anuncios que apunten al número conectado, incluidos los pausados con gasto durante el rango. Si hay varias monedas, hacer la comparación por separado.
2. Desplegar una campaña y comprobar inversión, consultas y costo por anuncio. Si un anuncio gastó y tuvo cero consultas, debe aparecer con ese gasto, cero consultas y un guion en costo por consulta. Una campaña con 15.000 ARS de inversión y cuatro conversaciones atribuidas debe mostrar 3.750 ARS por consulta.
3. Al recibir una conversación originada en publicidad, actualizar el informe después de que Inbox procese el mensaje. Contrastar el anuncio con su referencia en Meta. Un segundo mensaje del mismo contacto en esa conversación debe conservar el conteo. Las consultas orgánicas aparecen en el total sin atribución.
4. Abrir Instagram y elegir un período terminado. Comparar alcance, visualizaciones e interacciones con Insights de la misma cuenta y fechas. Revisar la fecha de la muestra de seguidores. Para comprobar la variación, usar un período con muestras al cierre del día anterior al inicio y al cierre del último día.
5. Ingresar como operador y verificar que se pueda consultar ambos informes. La autorización de Meta Ads se inicia con una sesión de administrador.

La guía de Zernio detalla la [atribución Click-to-WhatsApp](https://docs.zernio.com/platforms/whatsapp/ctwa), los [informes de Meta Ads](https://docs.zernio.com/platforms/meta-ads/analytics) y las [estadísticas de Instagram](https://docs.zernio.com/analytics/get-instagram-account-insights).
