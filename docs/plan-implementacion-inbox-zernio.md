# Plan de implementación — Inbox con Zernio

Fecha: 20 de noviembre de 2026.
Estado: bases de las etapas 1–3 implementadas y validadas localmente; etapas 4–7 y activación/prueba con cuentas reales pendientes.
Repositorios: `koi-leads-api` (backend) y `koi-leads-web` (frontend).

## 1. Objetivo

Completar el CRM comercial con una nueva pestaña **Inbox** para gestionar conversaciones entrantes de WhatsApp oficial e Instagram mediante Zernio, inicialmente solo para las cuentas de Koi.

La bandeja **Conversaciones** seguirá gestionando los números de EvoAPI. Inbox tendrá sus propias cuentas, consultas, contadores y mensajes, compartiendo el CRM y reutilizando al máximo la interfaz y el layout existentes.

En esta primera versión se podrá responder desde la plataforma únicamente durante las **24 horas posteriores al último mensaje entrante válido del contacto**. Esta política se aplicará a WhatsApp e Instagram sin excepciones por plantillas ni extensiones de atención humana.

La separación de bandejas depende de la cuenta conectada y su integración, no de que exista atribución publicitaria. Inbox también debe recibir consultas orgánicas o cuyo origen no pueda identificarse. Un mismo contacto puede tener conversaciones en ambas bandejas, siempre con historiales separados por cuenta.

## 2. Alcance de la primera versión

### Incluido

- Nueva navegación y rutas `/inbox` y `/inbox/:id`.
- Cuentas de WhatsApp oficial e Instagram de Koi conectadas por Zernio.
- Conexión, estado, reconexión y diagnóstico de permisos de las cuentas.
- Recepción de mensajes y recuperación del historial disponible.
- Respuesta manual dentro de la ventana estricta de 24 horas.
- Texto y adjuntos compatibles con cada canal: imágenes, videos, documentos y audio.
- Grabación de audio reutilizando la experiencia actual y adaptando el formato cuando corresponda.
- Responsables, búsqueda, filtros, no leídos, pendientes y archivado.
- Borradores independientes por conversación.
- Estados de envío y actualización en tiempo real.
- Contactos sin teléfono, identidades por canal y vinculación controlada con el CRM.
- Notas, etiquetas, pipeline y seguimientos desde Inbox.
- Registro del origen publicitario cuando el proveedor lo informe.
- Pruebas de aislamiento, confiabilidad y regresión de EvoAPI.
- Documentación operativa y activación gradual.

### Fuera de esta versión

- Cuentas de clientes del estudio.
- Iniciar conversaciones sin un mensaje entrante habilitante.
- Envío de plantillas para abrir o extender conversaciones.
- Extensión `HUMAN_AGENT` de Instagram u otras excepciones a las 24 horas.
- Respuestas automáticas, campañas o broadcasts desde Inbox.
- Administración de anuncios, presupuestos o campañas publicitarias.
- Gestión de comentarios públicos, publicaciones y contenido social.
- Mensajes interactivos avanzados.
- Chat web: se contempla en el modelo, pero no se implementa su transporte ni widget.
- Migración de módulos del ERP Backoffice.

## 3. Decisiones de arquitectura

### Dos bandejas, un CRM

- **Conversaciones:** EvoAPI, conservando `/conversaciones/:id?` y sus reglas actuales.
- **Inbox:** Zernio, con `/inbox/:id?`, exclusivamente WhatsApp e Instagram en esta entrega.
- **CRM:** ficha comercial compartida, sin duplicar pipeline, notas o seguimientos.
- **Conexiones:** distinguir proveedor, canal, cuenta y bandeja asignada.

La API y las suscripciones deben delimitar cada bandeja. Un filtro visual no constituye aislamiento. Una conversación EvoAPI no debe poder consultarse ni modificarse mediante endpoints de Inbox.

### Persistencia y procesamiento

Incorporar tablas propias de Inbox mediante migraciones aditivas, conservando el esquema operativo de EvoAPI. Compartir las entidades comerciales y los componentes de presentación.

Mantener API Node, Supabase y frontend React. Crear una cola durable y un worker de Inbox independientes de las campañas y del envío de EvoAPI. El procesamiento de eventos debe ser breve y no bloquear las respuestas manuales. La importación extensa de historial y el procesamiento pesado de archivos necesitan trabajos separados del despacho inmediato.

Flujo entrante: `Zernio → webhook de API → evento persistido → procesamiento → base de datos → Realtime → Inbox`.

Flujo saliente: `Inbox → API → cola durable → worker de Inbox → Zernio → eventos de confirmación`.

El navegador consulta nuestra base mediante la API; no consulta Zernio en cada apertura o actualización de un chat. Los WebSockets notifican cambios; el worker conserva la responsabilidad del envío durable.

## 4. Regla de respuesta de 24 horas

La ventana pertenece a una conversación de una cuenta concreta. No se comparte entre canales ni entre números del mismo contacto.

1. Calcular el vencimiento a partir de la fecha original del último mensaje entrante válido del contacto, usando tiempo del servidor y persistencia en UTC.
2. Permitir el envío solo cuando `ahora < ultimo_mensaje_entrante + 24 horas`.
3. Los mensajes salientes, estados de entrega, lecturas, reacciones y eventos duplicados no reinician la ventana.
4. Los mensajes históricos conservan su fecha original; importar un mensaje antiguo no abre una ventana nueva.
5. Procesar eventos fuera de orden sin retroceder el último mensaje entrante. Validar timestamps anómalos antes de utilizarlos para autorizar respuestas.
6. La API verifica la ventana al aceptar el envío. El worker vuelve a verificarla inmediatamente antes de llamar al proveedor, incluyendo cualquier reintento.
7. Si vence durante la espera en cola o el procesamiento del adjunto, no enviar y registrar el motivo visible para el usuario.
8. Un nuevo mensaje del contacto habilita nuevamente el compositor. No reenviar automáticamente mensajes que habían vencido.
9. Si no hay evidencia suficiente para determinar la ventana, bloquear el envío hasta completar la sincronización.
10. La elegibilidad local no garantiza aceptación del proveedor: desconexiones, permisos y límites del canal deben producir errores claros.

Interfaz:

- Ventana abierta: compositor habilitado e indicación de vencimiento.
- Ventana cerrada: historial accesible y compositor bloqueado.
- Aviso: **“Pasaron 24 horas desde el último mensaje. Podrás responder cuando el contacto vuelva a escribir.”**
- Conservar el borrador al vencer la ventana.
- Actualizar el estado al cumplirse el vencimiento, sin depender de una recarga.
- El reloj del navegador es informativo; la decisión final pertenece al servidor.

## 5. Modelo de datos propuesto

Los nombres definitivos de tablas y RPC se establecerán durante la etapa 1 siguiendo las convenciones del backend. Las siguientes son entidades conceptuales, no una migración lista para aplicar.

| Entidad | Datos y garantías principales |
| --- | --- |
| Cuentas conectadas | Workspace, proveedor, canal, identificador externo, alias, número/usuario, capacidades, estado y sincronización |
| Identidades de contacto | Contacto del CRM, canal e identificador externo con el ámbito exigido por el proveedor |
| Conversaciones | Cuenta, identificador externo, contacto, responsable, archivado, última actividad y último mensaje entrante válido |
| Mensajes | Identificador interno y externo, dirección, contenido, fecha original, autor, adjuntos y estados disponibles |
| Lecturas | Última lectura por usuario y conversación; distinguirla de los recibos informados por el canal |
| Eventos recibidos | Identificador externo, cuenta resuelta, procesamiento, intentos y error; deduplicación durable |
| Cola de envíos | Mensaje, clave de idempotencia, reserva, intentos y resultado confirmado o incierto |
| Archivos | Referencia a almacenamiento de objetos, MIME, tamaño, propietario, estado y política de acceso |
| Atribución | Referencias del anuncio, clic y campaña cuando existan, fecha y evento fuente |

Requisitos transversales:

- Delimitar datos por workspace y verificar que las relaciones pertenezcan al mismo ámbito.
- RLS, permisos y acceso del worker con privilegios acotados.
- Índices y restricciones únicas para impedir duplicados de eventos, mensajes y solicitudes de envío.
- No deducir unicidad global de un identificador de Instagram; respetar su ámbito de cuenta/proveedor.
- No fusionar personas por coincidencia de nombre o usuario visible.
- Admitir contactos sin teléfono sin debilitar las validaciones telefónicas de EvoAPI, importaciones y campañas.
- Conservar atribución original; no reemplazarla silenciosamente con datos de mensajes posteriores.
- Credenciales de integración solo en backend, nunca en variables públicas ni respuestas al navegador.

## 6. Etapas de desarrollo

La base de datos/compatibilidad (etapa 1), los componentes compartidos (etapa 2), las conexiones, recepción e historial (etapa 3) y la bandeja de lectura con Realtime (etapa 4) están implementados y validados localmente. Las migraciones de etapas 1, 3 y 4 ya están aplicadas en Supabase y el entorno local está preparado en la rama `dev`: ver [estado y variables](inbox-dev.md). Las etapas 5–7 y la conexión/validación con cuentas reales siguen pendientes. Cada entrega debe incluir sus pruebas y documentación pertinente antes de avanzar a activación. Detalle y límites: [Inbox: etapa 1](inbox-etapa-1.md), [Inbox: etapa 2](inbox-etapa-2.md), [Inbox: etapa 3](inbox-etapa-3.md) e [Inbox: etapa 4](inbox-etapa-4.md).

### Etapa 1 — Contratos, datos y compatibilidad

**Trabajo**

- Definir contratos de cuenta, contacto, conversación, mensaje, capacidades y elegibilidad para responder.
- Diseñar migraciones aditivas y permisos de usuario/worker.
- Incorporar identidades por canal y soporte de contactos sin teléfono.
- Definir endpoints propios de Inbox para cuentas, índice, historial, acciones comerciales y envío.
- Definir reglas de responsable, lecturas y pendientes coherentes con el CRM actual.
- Preparar pruebas de integridad, aislamiento y compatibilidad con EvoAPI.

**Criterio de cierre**

Migraciones y contratos verificados en entorno de prueba; relaciones entre workspaces rechazadas; contactos sin teléfono representables; importaciones, campañas y conversaciones EvoAPI compatibles.

### Etapa 2 — Componentes compartidos de chat

**Trabajo**

Extraer de la pantalla actual componentes de presentación, evitando duplicar `Conversations.tsx` como una segunda implementación independiente.

| Componente | Reutilización prevista |
| --- | --- |
| Layout | Lista lateral, conversación, panel informativo y comportamiento móvil |
| Selector de cuenta | Estilos actuales, alias, estado y contador |
| Lista de chats | Avatar, resumen, hora, no leídos y pendiente de respuesta |
| Encabezado | Contacto y cuenta desde la que se responde |
| Historial | Burbujas, fechas, scroll y mensajes anteriores |
| Compositor | Texto, adjuntos, grabación, borrador y progreso |
| Estados | Cargando, vacío, error, reconexión y errores de envío |
| Responsable | Selector y filtros del equipo existentes |

- Separar presentación de consultas, contratos específicos del proveedor y acciones de envío.
- Configurar capacidades por canal y estado de la conversación.
- Mantener la estética y el comportamiento actual de Conversaciones.
- Incorporar pruebas de regresión de escritorio y móvil.

**Criterio de cierre**

Conversaciones funciona y se ve como antes; los componentes compartidos soportan contratos de WhatsApp e Instagram sin acoplarse a Evolution.

### Etapa 3 — Conexiones, webhooks e historial

**Trabajo**

- Implementar cliente backend de Zernio con timeouts y manejo de errores.
- Incorporar conexión y reconexión de cuentas; validar estado OAuth, retorno y asociación al workspace.
- Confirmar la modalidad de conexión de la cuenta WhatsApp API existente y los permisos de Instagram.
- Mostrar identidad, canal, estado y problemas de configuración.
- Verificar firmas de webhooks sobre el cuerpo original.
- Persistir eventos antes de responder al proveedor; responder rápidamente y procesar asíncronamente.
- No confirmar como recibido un evento que no pudo persistirse.
- Deduplicar y tolerar eventos repetidos o fuera de orden.
- Recuperar historial disponible con paginación, puntos de avance y reanudación.
- Resolver la convivencia entre importación histórica y recepción en vivo sin duplicados ni pérdida de eventos.
- Mantener las fechas originales y no crear nuevos pendientes por cada mensaje histórico importado.
- Registrar y reprocesar errores sin exponer secretos.

**Criterio de cierre**

Recepción de WhatsApp e Instagram persistida una sola vez y asociada correctamente. Sincronización interrumpida reanudable y estados de conexión visibles.

### Etapa 4 — Inbox de lectura y Realtime

**Trabajo**

- Agregar la pestaña **Inbox** y rutas propias con carga diferida.
- Reutilizar layout, selector, lista, historial y componentes extraídos.
- Incorporar filtros de canal, cuenta, responsable, no leídos, pendientes y archivados.
- Agregar contador propio en navegación.
- Mostrar claramente la cuenta receptora y el canal.
- Incorporar borradores independientes y protección al cambiar de conversación/cuenta.
- Cargar resúmenes en lotes para filtrado local; historial solo al abrir el chat.
- Actualizar mediante Realtime las conversaciones afectadas.
- Reconciliar tras reconexión, regreso a la pestaña y mediante consulta periódica de respaldo.
- Preparar panel lateral comercial y estados de lectura/archivado.

**Criterio de cierre**

Inbox muestra conversaciones y adjuntos de ambas plataformas sin mezclar datos, rutas ni contadores con EvoAPI. Reconectar recupera los cambios pendientes.

### Etapa 5 — Respuesta manual y worker de Inbox

**Trabajo**

- Crear cola durable y worker independiente para Inbox.
- Aplicar la regla de 24 horas en API y despacho, usando una política compartida.
- Incorporar envío de texto desde el compositor compartido.
- Mostrar estado optimista sin confundirlo con aceptación o entrega real.
- Prevenir dobles envíos con claves de idempotencia.
- Conciliar la respuesta HTTP y los webhooks de mensajes salientes para evitar duplicar la burbuja.
- Mantener orden por conversación y concurrencia entre conversaciones según límites del proveedor.
- Diferenciar estados en cola, aceptado, entregado, leído, fallido y sin confirmar, según capacidades del canal.
- Ante timeout o resultado ambiguo, reconciliar antes de decidir un reintento; no asumir que el mensaje no salió.
- Dar prioridad a la respuesta manual sin aplicar demoras artificiales de campañas.
- Mostrar errores de conexión, permisos, ventana y control de conversación de Instagram.
- No activar plantillas, extensiones de ventana ni respuestas automáticas.

**Criterio de cierre**

Respuesta real desde la plataforma en ambos canales. Doble clic, reinicios y resultados inciertos tratados sin reenvíos ciegos. Vencimiento antes del despacho bloquea el envío y conserva el borrador.

### Etapa 6 — Adjuntos y circuito comercial completo

**Trabajo de adjuntos**

- Validar MIME, tamaño y capacidades de cada canal antes de subir y nuevamente en backend.
- Guardar binarios en almacenamiento de objetos, con referencias en la base.
- Proporcionar al proveedor URLs compatibles con sus requisitos y una política de acceso/expiración definida.
- Reutilizar la experiencia de grabación y convertir formatos de audio cuando sea necesario.
- Incorporar imágenes, videos y documentos compatibles, vista previa y progreso.
- Gestionar errores de subida, archivos abandonados y limpieza.
- Revalidar la ventana cuando el archivo esté listo para el despacho.

**Trabajo de CRM**

- Crear o vincular contactos al recibir consultas, evitando duplicados por identidad externa.
- Permitir asignación, cambio de etapa, notas, etiquetas y próximo seguimiento desde Inbox.
- Vincular conversaciones relacionadas desde la ficha del contacto, sin mezclar historiales.
- Capturar datos de anuncios cuando estén disponibles y mostrar “Origen no identificado” cuando falten.
- Identificar las consultas entrantes en los filtros del CRM.
- Evitar incorporación automática de estos contactos a campañas de prospección.

**Criterio de cierre**

La consulta puede atenderse con formatos compatibles y avanzar comercialmente desde Inbox. Un contacto de Instagram sin teléfono utiliza el mismo circuito comercial.

### Etapa 7 — Validación integral, despliegue y documentación

**Trabajo**

- Ejecutar pruebas de contratos, integración de base y worker, interfaz y recorrido completo.
- Probar estados reales de conexión y respuesta con las cuentas de Koi antes de activar el módulo.
- Aplicar migraciones compatibles; desplegar API, worker y frontend con activación controlada.
- Habilitar Inbox gradualmente después de verificar recepción y despacho.
- Documentar configuración, permisos, operación, recuperación y reversión.
- Incorporar métricas de demora de recepción, tiempo en cola, resultados de envío, errores y latido del worker.
- Definir reversión mediante desactivación del módulo y pausa del despacho, conservando eventos y datos para recuperación.

**Criterio de cierre**

Piloto de extremo a extremo aprobado, monitoreo operativo y documentación disponible. EvoAPI mantiene su funcionamiento durante y después de la activación.

## 7. Matriz mínima de aceptación

| Área | Casos obligatorios |
| --- | --- |
| Permisos | Acceso cruzado entre workspaces, cuentas y adjuntos rechazado |
| Separación | Endpoints, rutas, eventos y contadores de Inbox/EvoAPI independientes |
| Recepción | Firma inválida, evento duplicado, evento atrasado y fallo de persistencia |
| Historial | Backfill interrumpido, superposición con mensajes en vivo y fechas originales |
| Identidad | Instagram sin teléfono, colisiones de nombres y vinculación controlada |
| Ventana | Justo antes y al cumplir 24 horas, evento atrasado, nuevo mensaje y reloj del navegador incorrecto |
| Cola | Ventana vencida mientras espera o convierte audio; reinicio y recuperación de reservas |
| Envío | Doble clic, respuesta HTTP más webhook, timeout y resultado incierto |
| Estados | Recibos fuera de orden sin retroceder incorrectamente el estado del mensaje |
| Adjuntos | Tipo/tamaño rechazado, subida fallida, autorización de lectura y audio por canal |
| Interfaz | Escritorio/móvil, scroll, borradores, cambio de cuenta y reconexión |
| Comercial | Responsable, pipeline, notas, seguimiento y atribución desconocida |
| Regresión | Conversaciones, campañas, importaciones y envío manual EvoAPI |

## 8. Dependencias y verificaciones previas a producción

- Confirmar prestaciones habilitadas en la cuenta Zernio y permisos de las cuentas de Koi.
- Verificar titularidad, acceso y modalidad de incorporación del WhatsApp API existente antes de modificar su conexión.
- Confirmar el historial efectivamente disponible por canal; no prometer una importación completa antes de comprobarlo.
- Verificar los metadatos de anuncios realmente recibidos, especialmente en Instagram.
- Reconciliar el historial de migraciones del proyecto antes de aplicar nuevas migraciones; no ejecutar un push global sin revisar diferencias.
- Definir almacenamiento, acceso de medios, retención de eventos y configuración de secretos.
- Mantener la revisión de cambios de despliegue separada de este documento de planificación.

## 9. Definición de terminado

La primera versión está completa cuando una consulta de WhatsApp oficial o Instagram:

1. Llega a la cuenta correcta y aparece únicamente en Inbox.
2. Crea o vincula su contacto sin exigir teléfono a Instagram.
3. Conserva historial, adjuntos y origen disponible sin duplicados.
4. Puede responderse desde la plataforma dentro de las 24 horas.
5. Bloquea el envío fuera de ventana tanto en la interfaz como en el backend y worker.
6. Permite asignación, notas, cambio de etapa y seguimiento comercial.
7. Recupera cambios después de una desconexión o reinicio.
8. Mantiene los estilos y componentes reutilizados de Conversaciones.
9. No altera la operación de EvoAPI.

## 10. Referencias

Documentación del proveedor consultada el 20 de noviembre de 2026; volver a verificar contratos y capacidades al implementar.

- [Conexión de WhatsApp](https://docs.zernio.com/platforms/whatsapp/connect).
- [Inbox de WhatsApp y ventana de atención](https://docs.zernio.com/platforms/whatsapp/inbox).
- [Inbox de Instagram y formatos admitidos](https://docs.zernio.com/platforms/instagram/inbox).
- [Arquitectura de inbox y webhooks](https://docs.zernio.com/multi-tenant/inbox).
- [Contrato y firma de webhooks](https://docs.zernio.com/webhooks).
- [Envío de mensajes e idempotencia](https://docs.zernio.com/messages/send-inbox-message).
- [Atribución de anuncios de WhatsApp](https://docs.zernio.com/platforms/whatsapp/ctwa).
- [Bandeja local existente](bandeja-chats-local.md).
- [Despacho manual existente](envio-manual-inmediato.md).
