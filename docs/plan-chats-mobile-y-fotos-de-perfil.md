# Plan de implementación · Chats móviles y fotos de perfil

**Koi Leads · Propuesta del 21 de noviembre de 2026**

En la captura de referencia, la cuenta seleccionada tiene cinco chats. Entran tres conversaciones completas porque el selector de cuenta, los filtros y los estados ocupan gran parte del alto disponible. La meta de diseño es ver las cinco filas completas al abrir esa misma bandeja, manteniendo el tamaño de texto, áreas táctiles cómodas y la navegación inferior. El rediseño se puede entregar en la web antes de integrar las fotos de perfil.

## Entrega 1 · Lista móvil y conversación abierta

Aplicar el diseño a Conversaciones (líneas de WhatsApp por Evolution) e Inbox (WhatsApp oficial e Instagram por Zernio). Ambos usan `ChatSidebar` y `ChatLayout` en `koi-leads-web/src/koi/chat`. Reutilizar la selección de cuenta, la búsqueda y las consultas que ya gestionan `Conversations.tsx` e `Inbox.tsx`.

| Superficie | Cambio propuesto | Cómo comprobarlo |
| --- | --- | --- |
| Cabecera de la lista | Usar la cuenta activa como título desplegable, por ejemplo «WhatsApp · Toki ▾», «@koistudio.ai ▾» o «Todas las cuentas ▾». Mostrar el número completo y las demás cuentas al abrir el selector. Conservar el acceso a nuevo chat donde esté disponible. | Con dos líneas de nombre similar, el operador puede identificar y elegir la correcta. Un nombre largo cabe sin tapar los botones. |
| Búsqueda y filtros | Una línea para «Buscar un chat» y «Filtros». Debajo, accesos a Todos, No leídos y Pendientes. Mover Archivados, responsable y canal a un panel inferior con selección actual y opción de limpiar. Mostrar un indicador en Filtros cuando haya una restricción activa en ese panel. | Se puede recuperar un chat archivado, filtrar por responsable y volver a la vista anterior. Cerrar el panel devuelve el foco al botón. |
| Filas | Avatar circular, nombre y hora en la primera línea. Último mensaje y contador de no leídos en la segunda. Truncar la vista previa larga. En una cuenta única omitir la etiqueta repetida de la línea. En «Todas las cuentas», identificar canal y cuenta con una marca breve que permita distinguir al mismo contacto en dos líneas. | Las cinco filas caben en la pantalla de referencia. Un audio, adjunto o sticker tiene una vista previa comprensible. Los no leídos se reconocen también al usar lector de pantalla. |
| Estados de la lista | Retirar el pie con la cuenta repetida y el resumen permanente «5 chats · En esta bandeja». Mostrar la conexión cuando exista una incidencia. Mantener errores, reintento, estados vacíos y carga de más resultados. | Un fallo de conexión queda visible y una búsqueda sin resultados se distingue de una bandeja vacía. |
| Hilo abierto | Cabecera compacta con volver, avatar, nombre y una indicación breve de la cuenta emisora. Al tocar el contacto se abre la ficha completa. El historial y el compositor aprovechan el alto disponible, incluido al abrir el teclado. | Al volver se conservan cuenta, filtros y posición de la lista. La navegación inferior de Koi no tapa el compositor. Se mantienen los indicadores de envío y la protección de borradores de la [etapa de mensajería](implementacion-mensajeria-manual-y-campanas.md). |

**Validación visual.** Tomar capturas antes y después con los mismos cinco chats, tamaño de texto y área visible del navegador. Medir el alto de la cabecera y contar filas completas. Comprobar también un teléfono más angosto, ambas orientaciones, texto ampliado y escritorio. Con texto ampliado, priorizar legibilidad y desplazamiento sobre la meta de cinco filas. El espacio de las barras del navegador forma parte de la comparación en el dispositivo real.

## Entrega 2 · Disponibilidad y contrato de fotos

Antes de cambiar persistencia, ejecutar una comprobación de solo lectura sobre una muestra autorizada de cada canal. Registrar cuántos contactos tienen foto disponible y cuántos devuelven vacío o error. Verificar que la imagen corresponde al interlocutor. La muestra permitirá estimar cobertura real sin copiar nombres, teléfonos ni URLs privadas al informe.

| Integración | Fuente y decisión |
| --- | --- |
| Evolution · WhatsApp | El backend puede solicitar la foto de un contacto en la instancia que sostiene ese chat mediante [Fetch Profile Picture URL](https://docs.evoapicloud.com/api-reference/chat-controller/fetch-profilepic-url). Verificar compatibilidad de la versión desplegada y contemplar contactos sin foto visible. |
| Zernio · Instagram | Incorporar el campo nullable `participantPicture` de la [lista de conversaciones](https://docs.zernio.com/messages/list-inbox-conversations) al contrato del proveedor. Hoy la sincronización recoge nombre e identidad del participante. Aprovechar esa misma respuesta para la foto. |
| Zernio · WhatsApp oficial | El canal comparte el contrato de conversaciones. La cobertura en las cuentas de Koi queda pendiente de la muestra. Si devuelve vacío, mostrar iniciales. Mantener separadas las identidades de cada cuenta y proveedor. |

**Contrato propuesto.** Añadir un campo opcional `avatarUrl` al resumen y al detalle de conversación de la API. La web debe aceptar tanto su ausencia como un valor nulo, para permitir despliegues independientes y chats históricos. Asociar la foto al workspace, proveedor, cuenta o instancia e identidad del interlocutor. En la web, extender `ChatAvatar` para usar la misma imagen en lista y cabecera, reservando el espacio desde el primer render y mostrando las iniciales mientras carga o si falla.

## Entrega 3 · Carga, caché y publicación

1. **Zernio.** Incorporar el dato en `src/inbox/provider.ts`, en el mapeo de `src/inbox/ingest-cycle.ts` y en las lecturas de lista y detalle. Si hace falta persistencia nueva, agregar una migración compatible con filas existentes. Distinguir un evento que omite el campo de una respuesta que confirma que el contacto ya no tiene foto. Recuperar fotos de chats anteriores progresivamente desde la sincronización.
2. **Evolution.** Resolver las fotos visibles en segundo plano mediante la API autenticada de Koi. Reutilizar la caché por cuenta y contacto, deduplicar solicitudes concurrentes y limitar concurrencia. Guardar temporalmente también el resultado «sin foto». La clave de Evolution permanece en el backend.
3. **Rendimiento.** Mostrar lista y buscador aun cuando el proveedor de imágenes esté lento. Cargar imágenes visibles bajo demanda y recuperar una URL vencida de forma acotada. Al volver a abrir una lista con caché vigente, verificar que no se repita la consulta al proveedor por contacto.
4. **Pruebas y salida.** Usar fotos sintéticas para los recorridos de navegador. Cubrir foto disponible, nula, vencida y fallida, cambio entre cuentas y aislamiento entre espacios. Probar una bandeja larga con red lenta y confirmar que abrirla no desencadena una consulta por cada conversación. Ejecutar lint, tipos, pruebas y build de la web; para el contrato de fotos, ejecutar también las pruebas de la API. Publicar primero la vista compacta con iniciales. Cuando se valide cada proveedor, habilitar su entrega de fotos y comparar tiempos de apertura, solicitudes y errores con la primera entrega.

La entrega visual se acepta por la densidad y usabilidad comprobadas en el teléfono. La de avatares se acepta por canal, según disponibilidad real, aislamiento de cuentas y desempeño de la lista.
