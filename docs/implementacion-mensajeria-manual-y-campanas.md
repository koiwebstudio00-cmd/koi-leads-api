# Koi Leads | Implementación de mejoras en mensajería

**Propuesta para revisión · 21 de noviembre de 2026**

Un operador envió «hola» por WhatsApp en Inbox. El mensaje llegó al teléfono, pero al intentar abrir otro chat apareció «Tenés un borrador». La burbuja decía «Guardando…» y el campo de escritura aún contenía «hola». El objetivo es permitir que el operador siga trabajando desde que pulsa Enviar y que el estado de cada burbuja refleje la evidencia disponible para su canal.

La primera entrega corresponde a la web. Las optimizaciones de despacho y recepción se decidirán con mediciones del despliegue. Los intervalos citados abajo provienen del código y representan esperas posibles. La entrega al dispositivo y la disponibilidad de recibos también dependen del proveedor.

## 1. Estados de mensajes salientes

Aplicar la siguiente presentación en Conversaciones (WhatsApp por Evolution) e Inbox (WhatsApp oficial e Instagram por Zernio). Usar el canal de la conversación como dato explícito. Los estados internos y los recibos continúan disponibles para conciliación, soporte y estadísticas.

| Evidencia disponible | WhatsApp en ambas bandejas | Instagram |
| --- | --- | --- |
| Envío iniciado localmente, guardado en cola, reservado o en curso | Solo reloj | Solo flecha de envío |
| El proveedor aceptó el envío y devolvió un identificador, o confirmó el envío | Un tilde gris | Sin indicador |
| Recibo de entrega al destinatario | Dos tildes grises | Sin indicador |
| Recibo de lectura | Dos tildes azules | Sin indicador |

Retirar de la burbuja los textos normales «Guardando…», «En cola», «Enviando», «Aceptado», «Entregado» y «Visto». En Instagram retirar también el «Visto» que la línea de tiempo dibuja debajo del último mensaje leído. Conservar la hora independientemente del recibo. Los mensajes entrantes mantienen su presentación sin indicadores de envío. Dar a los iconos un nombre accesible. Usar color y descripción accesible para distinguir entrega y lectura en WhatsApp.

Un rechazo definitivo debe ofrecer recuperar el contenido o reintentar desde el chat correspondiente. Un resultado incierto debe mostrar un aviso discreto asociado al intento y permitir revisar su estado. La ausencia de respuesta HTTP puede ocurrir después de la entrega. Conservar la identidad del intento y conciliar antes de volver a enviar. Para mensajes históricos con información incompleta, mostrar únicamente lo respaldado por los datos disponibles. Un recibo repetido o tardío no debe degradar una lectura ya confirmada.

**Archivos principales en koi-leads-web:** `src/koi/chat/ChatMessageStatus.tsx`, `ChatTimeline.tsx` y `types.ts` en la misma carpeta, y los consumidores `src/koi/Inbox.tsx` y `src/koi/Conversations.tsx`. Revisar las expectativas actuales de `chat-presentation.test.ts` y los recorridos que buscan etiquetas de estado.

## 2. Borrador y envío pendiente

Hoy `ChatComposer` agrega la burbuja optimista, espera la respuesta de la API y luego vacía el campo. Durante esa espera el texto y la bandera de envío ocupado activan la protección de borrador. Quitar solo el diálogo dejaría dos copias conceptuales del mismo texto.

1. Al pulsar Enviar, capturar el contenido, la cuenta, el canal, el destino y una clave de intento estable. Transferir ese contenido del borrador a un envío pendiente. Mostrar la burbuja en el mismo turno de interfaz, incluso si la preparación de un adjunto requiere más tiempo.
2. Liberar el compositor y permitir navegar. Mantener la operación pendiente fuera del ciclo de vida del panel abierto para que cambiar de chat no la aborte ni aplique su respuesta al chat siguiente. Mantener protegidos los textos, citas, grabaciones y adjuntos que aún sean borradores reales.
3. Conciliar la respuesta HTTP, el historial y los eventos en vivo mediante la clave del intento y el identificador del servidor. La burbuja optimista y la persistida deben converger en un solo mensaje aunque el evento llegue primero.
4. Vincular el resultado al contenido capturado. Una confirmación tardía no debe borrar un segundo borrador. Dos mensajes iguales enviados deliberadamente reciben claves distintas. Un doble clic y un reintento del mismo envío conservan una sola identidad. Verificar especialmente el helper de Inbox que recupera claves a partir del texto.
5. En chats nuevos de Evolution, conservar la asociación entre el envío inicial y la conversación que crea el servidor. Si el operador ya navegó a otro chat, la respuesta no debe devolverlo al anterior. Al recargar tras una respuesta perdida, reconciliar la identidad disponible antes de habilitar otro envío del mismo intento.

**Puntos de trabajo:** compositor compartido, panel de chat nuevo y existente de Evolution, borradores por conversación de Inbox, `src/koi/inbox-send.ts` y `src/koi/evolution-chat-adapter.ts`. Conservar el orden por conversación, el aislamiento por cuenta y workspace, y la ventana de respuesta autoritativa de Zernio.

## 3. Medición y mejoras de velocidad

Registrar tiempos por proveedor, canal, tipo de mensaje y operación. Correlacionar mediante identificadores técnicos sin registrar texto, teléfonos, adjuntos ni credenciales. Comparar mediana y percentil 95 con el mismo tipo de carga antes y después. Usar duraciones dentro del mismo proceso o relojes sincronizados cuando se comparen servicios.

| Tramo | Qué medir | Qué permite decidir |
| --- | --- | --- |
| Clic → burbuja visible y compositor libre | Tiempo en el navegador para texto y archivos por separado | Detectar espera en la interfaz |
| API → encolado → inicio de despacho | Persistencia, espera elegible en cola y comprobaciones previas | Distinguir base, worker y validación de cuenta |
| Llamada al proveedor → aceptación → guardado final | Cronometrar HTTP y persistencia por separado | Atribuir correctamente la demora |
| Llegada del webhook → mensaje persistido → visible en chat abierto | Registrar si la actualización llegó por Realtime o por sondeo | Separar recepción de refresco de pantalla |
| Aceptación → entrega o lectura | Usar el recibo cuando exista | Distinguir tiempos de Koi de tiempos del canal |

**WhatsApp por Evolution.** El worker manual ya usa una escucha de PostgreSQL y un respaldo de aproximadamente un segundo en reposo. Verificar en el despliegue que la conexión de sesión mantiene `LISTEN koi_chat_ready` y que el encolado lo despierta. Aprovechar `queueWaitMs`. Separar el guardado final de `providerMs`, que actualmente incluye ambos tiempos. En recepción, comprobar la llegada del webhook y la suscripción del chat abierto. Al perder Realtime, el historial activo usa un respaldo de tres segundos. Ver [despacho manual](envio-manual-inmediato.md) y [worker de chat](../src/chat-worker.ts).

**WhatsApp e Instagram por Zernio.** El worker espera 500 ms entre ciclos de envío o ingesta cuando está ocioso. Si la espera en cola resulta significativa, emitir una notificación transaccional tras encolar y despertar al consumidor. Mantener la cola persistente, la reserva exclusiva y el sondeo de recuperación ante desconexiones. Medir también la consulta de cuenta que precede a cada despacho. Cualquier optimización debe conservar la validación de perfil, workspace, permisos y ventana de respuesta. Ver [worker de Inbox](../src/inbox/ingest-worker.ts) y [ciclo de envío](../src/inbox/send-cycle.ts).

**Recepción en Inbox.** El webhook confirma después de guardar el evento. El ciclo procesa hasta cinco eventos en vivo antes de intentar una página de historial. Si una sincronización lenta retrasa los eventos nuevos, separar el procesamiento en vivo de la recuperación de historial, con concurrencia acotada, deduplicación y progreso independiente. Si la persistencia es rápida y la pantalla tarda, corregir la suscripción o la actualización del chat afectado. El respaldo de la web consulta cada cinco segundos cuando Realtime está desconectado. Ver [ciclo de ingesta](../src/inbox/ingest-cycle.ts).

## 4. Campañas por Evolution

El worker de campañas sondea cada tres segundos por defecto. La configuración documentada contempla un mínimo de 30 segundos entre intentos, dos por minuto, 60 por hora y 100 por día, además de horarios y límites particulares. Verificar los valores efectivos del despliegue al medir. El número principal comparte capacidad entre campañas y la reserva de despacho coordina campañas y chats manuales.

Medir desde el instante en que un destinatario **ya es elegible** hasta el inicio de su despacho. Registrar por separado las esperas por horario, límite del número, pausa, turno manual y falta de conexión. Si la demora evitable está al iniciar o reanudar una campaña, despertar al worker en esos eventos y revalidar elegibilidad en PostgreSQL antes del envío. El turno manual pendiente debe tener prioridad cuando quede libre la instancia. Una petición ya despachada conserva su reserva hasta resolverse.

Preservar las bajas, la pausa y cancelación, la alternancia entre campañas elegibles, los límites por emisor y la revisión de resultados inciertos. Los estados detallados continúan siendo útiles en el panel de campañas. La simplificación visual se aplica a las burbujas de chat. Ver [operación de campañas](despliegue-campanas.md) y [ciclo del worker](../src/campaigns/worker-cycle.ts).

## 5. Verificación y orden de entrega

| Entrega | Criterio de aceptación |
| --- | --- |
| 1. Interfaz y borradores | En cada bandeja, enviar «hola», cambiar inmediatamente de chat y volver. Aparece una sola burbuja, en el chat correcto, sin aviso de borrador. Escribir otro texto durante la confirmación conserva el nuevo borrador. Comprobar también chat nuevo, cambio de cuenta y adjuntos. |
| 2. Estados y recuperación | Simular aceptación, entrega, lectura, eventos fuera de orden, rechazo y respuesta HTTP perdida. Verificar los iconos de la tabla con ambos proveedores de WhatsApp, la desaparición de la flecha en Instagram y la ausencia de duplicados al recuperar historial. |
| 3. Diagnóstico de velocidad | Medir texto y multimedia por separado con el chat abierto, con Realtime conectado y tras una reconexión. Publicar los tiempos por tramo antes de elegir la optimización de backend. |
| 4. Workers y campañas | Verificar despertar y recuperación por sondeo al perder la escucha. Ejecutar campaña y chat manual sobre el mismo número, con dos consumidores, pausa y reinicio. Comprobar que se respeta el próximo turno elegible y que un resultado incierto no provoca un segundo POST. |

Usar pruebas de presentación y recorridos de navegador con proveedores sintéticos. En los cuatro recorridos inestables de Inbox, esperar el login efectivo antes de navegar y aislar los datos de lectura de cada caso. Para las reservas y la concurrencia, ejecutar la suite PostgreSQL existente además de las pruebas rápidas con PGlite. La instancia de Supabase en Docker Desktop es una opción posterior para verificar Auth y Realtime. Su configuración no es un requisito para comenzar la mejora de interfaz.

Entregar primero la web y validar el caso observado. Comparar después los tiempos del backend y desplegar por separado las optimizaciones justificadas para cada worker. Ante una regresión de notificaciones, conservar el sondeo y la conciliación de la cola ya persistida.
