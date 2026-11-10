# Implementación de campañas, colas y envíos de Koi Leads

Este documento conserva el diseño original del 6/11/2026. Para el estado productivo, los límites vigentes y la recuperación operativa, consultar la [guía de campañas](despliegue-campanas.md). La configuración y las pruebas de la bandeja están en la [guía de WhatsApp](gestion-whatsapp.md#conversaciones).

## 1. Objetivo y punto de partida

Completar la función principal de Koi: elegir contactos de una base, crear un mensaje con variables opcionales, revisar su vista previa, configurar horarios y frecuencia, iniciar una campaña y seguir su progreso aunque se cierre el navegador o se reinicie la API.

**Punto de partida del plan (5/11):** la conexión con Evolution estaba operativa y faltaba el motor de campañas. Una pantalla que muestra “WhatsApp conectado” no constituye una campaña funcional.

### Implementado y comprobado

- Frontend React/Vite independiente en `https://leads.koistudio.com.ar`.
- Backend Node.js 24/TypeScript en `https://api-leads.koistudio.com.ar`, desplegado desde GitHub en Dokploy.
- Supabase Auth, autorización por membresía y workspace `Estudio Koi`.
- Bases de leads con nombre; importación CSV/XLSX con preparación, selección, deduplicación y confirmación. Límite actual: 5.000 filas y 10 MiB por archivo.
- Tablas de contactos, consentimiento y exclusiones ya existentes.
- Consulta autenticada del estado de Evolution desde la app. Instancia `koi-01` conectada durante la última comprobación productiva.
- Corrección de la clave publishable de Supabase del backend. La sesión ya carga el workspace.

### Alcance que se definió para implementar (ver estado actualizado arriba)

- CRUD de campañas y selección de destinatarios.
- Plantillas con variables y vista previa del texto personalizado.
- Cola durable, worker independiente y envío real desde Koi.
- Programación, límites de frecuencia, pausa, reanudación y cancelación.
- Registro de intentos, recuperación tras reinicios y tratamiento de resultados inciertos.
- Webhooks de Evolution para estados y respuestas.
- Progreso actualizado automáticamente, historial y monitoreo del worker.

`src/import-worker.ts` únicamente analiza archivos fuera del hilo principal. **No es un worker de campañas.** El código antiguo de campañas/n8n que permanece en el frontend no debe tomarse como una implementación de este flujo.

## 2. Repositorios y servicios

| Componente | Ubicación | Responsabilidad |
| --- | --- | --- |
| Backend | `koiwebstudio00-cmd/koi-leads-api` | API, cola, worker, contratos, migraciones y pruebas |
| Checkout del backend | `/Users/dev0/koi/koi-leads-api` | Trabajar desde esta carpeta |
| Frontend | `koiwebstudio00-cmd/casadey-agent` | Interfaz React/Vite; repositorio separado |
| Checkout del frontend | `/Users/dev0/koi/koi-leads-web` | Pantallas y cliente HTTP |
| API en Dokploy | `koi-api` | Solicitudes del frontend y recepción de webhooks |
| Worker nuevo en Dokploy | `koi-worker` | Consumir cola y contactar a Evolution |
| Evolution | `https://evoapi.inmobiliarialyc.com.ar` | Conexión WhatsApp; instancia `koi-01` |
| Supabase de Koi | `avqhjbrcbgqhelfkcist` | Datos comerciales y cola persistente |

Mantener frontend y backend separados. API y worker sí pertenecen al mismo repo del backend: comparten lógica de dominio y se ejecutan como dos procesos/contenedores. Desplegar ambos desde GitHub; no subir ZIP al VPS.

El PostgreSQL y Redis del Compose de Evolution son servicios internos de Evolution. No guardar allí las campañas de Koi ni modificar sus tablas.

## 3. Decisión de arquitectura para el primer lanzamiento

**Propuesta: cola en PostgreSQL de Supabase y worker Node persistente en Dokploy.** Una fila por destinatario representa el trabajo pendiente. El worker reclama filas mediante transacciones breves, bloqueo de filas y `FOR UPDATE SKIP LOCKED`. PostgreSQL documenta este mecanismo para consumidores de tablas usadas como colas; el algoritmo de negocio y su recuperación igualmente necesitan pruebas propias. [Referencia PostgreSQL](https://www.postgresql.org/docs/17/sql-select.html).

Flujo previsto:

```text
Frontend → API autenticada → campaña y destinatarios en Supabase
                                    ↓
                         koi-worker reclama un envío
                                    ↓
                         Evolution → WhatsApp
                                    ↓
Evolution → webhook de Koi → eventos y estados en Supabase
                                    ↓
                   API de progreso → frontend
```

| Alternativa | Uso en Koi |
| --- | --- |
| n8n | Fuera del camino crítico de envíos. Más adelante puede recibir eventos para automatizaciones auxiliares. |
| BullMQ con Redis dedicado | Alternativa futura si el volumen o la variedad de trabajos lo justifica. Requiere resolver también consistencia entre Redis y los datos comerciales. |
| Cola PostgreSQL | Elegida para el inicio: campaña y cola se confirman en una misma transacción y no se suma otro servicio al VPS. |

Esta decisión ya está implementada en código; su operación requiere activar el worker. Arrancar con **una réplica de worker y una petición de envío en vuelo por instancia**. Probar igualmente dos consumidores simultáneos para cubrir solapamientos durante un deploy.

La captura del VPS mostró 3,47 GiB usados de 7,75 GiB y baja CPU en ese momento, con picos. Es una referencia puntual, no una prueba de capacidad. Medir nuevamente antes del despliegue y durante la prueba con carga; mantener las importaciones acotadas y no cargar bases completas en memoria del worker.

## 4. Alcance funcional del MVP

1. Crear campaña con nombre, una base y destinatarios seleccionados o un filtro explícito.
2. Elegir mensaje de texto y variables de los campos del lead: `{{nombre}}`, `{{empresa}}` y campos personalizados permitidos.
3. Ver el texto resuelto para varios destinatarios antes de confirmar.
4. Configurar inicio, zona horaria, días, franjas horarias, intervalo mínimo y límites por minuto, hora y día.
5. Ejecutar la campaña en segundo plano.
6. Pausar, reanudar o cancelar pendientes desde la app.
7. Ver pendientes, aceptados por Evolution, entregados, leídos, fallidos, excluidos y resultados inciertos.
8. Consultar el historial de cada destinatario y exportar resultados con protección frente a fórmulas CSV.

Primera versión: texto, una instancia fija y una sola campaña activa por instancia. Borradores múltiples permitidos. Multimedia, rotación de números, secuencias de seguimiento e inbox completo quedan fuera de esta entrega.

### Vista previa y variables

- El servidor debe resolver el texto que se enviará; frontend y backend comparten la especificación y fixtures, sin imports entre repositorios.
- Resolver variables con un parser acotado. No ejecutar JavaScript ni evaluar expresiones del usuario.
- Rechazar variables desconocidas. Si falta un valor, exigir un reemplazo explícito o excluir el contacto indicando el motivo; no mandar llaves sin resolver.
- Congelar el texto por destinatario al iniciar. Cambiar después el nombre del contacto no cambia una campaña ya confirmada.
- Mostrar una burbuja similar a WhatsApp, con saltos de línea y formatos de texto admitidos. No prometer una reproducción exacta en todos los dispositivos ni presentarla como plantilla oficial de Meta.
- Desactivar vista previa de enlaces inicialmente si no se puede reproducir su comportamiento; verificar opciones en la versión instalada.

## 5. Modelo de datos propuesto

Crear migraciones nuevas. No volver a ejecutar ni modificar las tres migraciones ya aplicadas. Los nombres siguientes son propuestas y deben concretarse con constraints, índices y pruebas.

| Tabla | Contenido y restricciones principales |
| --- | --- |
| `koi_campaigns` | Workspace, nombre, lista, creador, plantilla, versión, configuración horaria, límites, estado, motivo de pausa e idempotencia. |
| `koi_campaign_recipients` | Campaña, lead, teléfono y texto congelados, estado de despacho, `next_attempt_at`, token de reserva, vencimiento, número de intento y ID del proveedor. Es también la cola. |
| `koi_message_attempts` | Un registro por intento: comienzo, fase, finalización, resultado, error sanitizado e identificador del proveedor. Nunca sobrescribir intentos anteriores. |
| `koi_campaign_events` | Eventos de dominio y auditoría ordenados por secuencia: inicio, pausa, cancelación, intentos y cambios de estado. Actor humano o worker identificado. |
| `koi_evolution_events` | Bandeja durable de webhooks, clave de deduplicación, instancia, datos mínimos normalizados y estado de procesamiento. |
| `koi_sender_state` | Estado persistente por instancia: habilitación, bloqueo, próximo envío, reserva activa y control de frecuencia. |
| `koi_worker_heartbeats` | Identidad, versión y última actividad del worker. Sin exponer secretos ni un panel público. |

Reutilizar `koi_leads`, `koi_lead_list_members`, `koi_suppressions` y `koi_consent_records`. No crear otra fuente paralela de contactos o bajas.

Restricciones mínimas:

- `workspace_id` en todas las entidades; claves foráneas compuestas para impedir cruces de espacios.
- Un destinatario por `(campaign_id, phone_snapshot)`; un intento por `(recipient_id, attempt_number)`.
- Un ID del proveedor único dentro de su instancia cuando exista.
- Inicio idempotente por `(workspace_id, idempotency_key)` y hash del contenido; misma clave con contenido distinto responde 409.
- Índice parcial para trabajos pendientes/reintentables por `next_attempt_at, id`; índices por campaña y por ID del proveedor.
- Índice para webhooks sin procesar y eventos por campaña/secuencia.
- Una campaña activa por instancia mediante restricción transaccional, no solo validación de interfaz.

**Ajustes sobre el esquema existente:** `koi_audit_events` referencia exclusivamente listas y exige actor humano; no sirve sin cambios para eventos del worker. Usar `koi_campaign_events` para la nueva auditoría. `koi_consent_records` exige `import_id` y `actor_id`: permitir de forma explícita orígenes manuales y webhooks, con constraints según el origen, sin inventar un usuario ni una importación para una baja recibida.

## 6. Autorización y acceso del worker

La API actual usa la publishable key y el JWT del usuario para conservar RLS. Mantener ese comportamiento para las operaciones del frontend. La publishable key **no permite que un worker actúe sin una sesión**; no guardar JWT personales para ejecutar campañas.

Propuesta concreta:

- Mutaciones de campañas mediante funciones transaccionales invocadas con la sesión autenticada. Validar membresía, rol y transiciones dentro de la función, además de la API.
- Worker con rol PostgreSQL de máquina dedicado, restringido al workspace Koi y a las operaciones necesarias. Sin superusuario, `BYPASSRLS` ni reutilización de la contraseña administrativa.
- Conexión TLS mediante `KOI_WORKER_DATABASE_URL`, con pool pequeño, inicialmente hasta dos conexiones. Copiar el host real desde Supabase; no inventar un hostname de pooler.
- Acceso directo o pooler en modo sesión según conectividad del VPS. Comprobar IPv4/IPv6 y credenciales del rol antes del deploy. [Conexiones de Supabase](https://supabase.com/docs/guides/database/connecting-to-postgres/pooling-and-limits).
- Bandeja de webhooks con rol de ingestión separado: puede insertar eventos mediante una función acotada, pero no enviar mensajes ni modificar campañas arbitrariamente.
- RLS y grants explícitos. Tablas internas en esquema no expuesto; tablas públicas con políticas por workspace. Ningún cliente puede adjudicarse entregas, liberar reservas o escribir intentos.
- Preferir funciones `SECURITY INVOKER`. Si alguna operación requiere `SECURITY DEFINER`, usar propietario sin privilegios generales, esquema privado, `search_path` fijo, revocar `PUBLIC` y comprobar el llamador. Para usuarios, validar `auth.uid()`; para máquina, validar el rol de conexión y su workspace permitido.

Las credenciales nuevas se cargan en Dokploy; no van al frontend, al repo, a URLs ni a logs. Revisar estas políticas con las habilidades de Supabase y PostgreSQL al implementar. Este documento no cambia permisos ni crea credenciales.

## 7. Estados y garantías de ejecución

### Campaña

`draft → scheduled → running → completed`

Transiciones adicionales: `running/scheduled → paused`, `paused → scheduled/running`, y cancelación a `cancelled`. Usar un motivo persistido para pausas por operador, desconexión, credenciales o resultado incierto. `completed` significa que no quedan trabajos por despachar o resolver; no significa que todos fueron entregados o leídos. Los recibos pueden continuar llegando después.

### Destinatario

Separar el estado de despacho del estado de entrega:

- Despacho: `queued`, `leased`, `sending`, `accepted`, `retry_wait`, `unknown`, `failed`, `skipped`, `cancelled`.
- Entrega: sin confirmación, `sent`, `delivered`, `read` o error de entrega cuando el proveedor lo informe.
- `accepted` requiere una respuesta válida del proveedor y su identificador. Un HTTP exitoso por sí solo no acredita entrega al teléfono.
- Las actualizaciones atrasadas no pueden hacer retroceder `read` a `delivered` o `sent`.

### Inicio atómico

La operación de inicio bloquea la campaña, valida su revisión, resuelve la selección dentro del workspace y congela contactos/textos. Inserta destinatarios, configuración y evento de inicio en **una transacción**. Publica el trabajo al worker solo después del commit. Ante doble clic o respuesta perdida, la misma clave devuelve la misma campaña sin duplicar la cola.

Selección máxima inicial: 5.000 contactos por campaña, coherente con el importador. Si se necesita más, implementar preparación por lotes con un estado intermedio no consumible; no extender el límite sin medir la transacción.

### Ciclo del worker

1. Consultar habilitación global, latido y disponibilidad de la base.
2. En una transacción breve, bloquear el estado del remitente y verificar campaña, ventana horaria y límites.
3. Reclamar un destinatario elegible con `FOR UPDATE SKIP LOCKED`, generar un token de reserva y registrar `leased`. No mantener la transacción abierta durante HTTP.
4. Antes de enviar, volver a validar campaña, exclusiones, consentimiento, reserva y estado del remitente. Registrar duraderamente `sending` y el intento; reservar el consumo de frecuencia antes de contactar al proveedor.
5. Realizar una sola llamada a Evolution con timeout y sin redirecciones. No permitir URL o instancia elegidas por el navegador.
6. Persistir aceptación y proveedor, rechazo inequívoco o resultado incierto. Toda escritura del worker comprueba su token de reserva para impedir que un proceso viejo sobrescriba otro intento.
7. Registrar evento, liberar la reserva cuando corresponda y calcular la próxima elegibilidad desde los datos persistidos.

Usar reloj de base de datos para reservas y programación. Como parámetros iniciales de ingeniería: timeout HTTP de 15 segundos, reserva de 90 segundos y latido de 10 segundos; validar con pruebas. No son parámetros de seguridad frente a WhatsApp.

### Reinicios y resultados inciertos

No se puede garantizar “exactamente una vez” entre PostgreSQL y una API externa sin idempotencia demostrada del proveedor. Aplicar esta política conservadora:

| Situación | Acción |
| --- | --- |
| Reserva vencida en `leased`, sin comenzar HTTP | Volver a encolar con token nuevo. |
| Reinicio o reserva vencida en `sending` | Pasar a `unknown`; no reenviar automáticamente. |
| Timeout, conexión cortada tras iniciar la petición o respuesta imposible de interpretar | `unknown`; el proveedor podría haber aceptado el mensaje. |
| Respuesta válida e ID del proveedor | `accepted`; esperar recibos y no repetir el POST. |
| Error comprobado anterior al envío o rechazo documentado sin aceptación | Reintento acotado si el error es transitorio. |
| Número/texto inválido | Fallo definitivo con motivo legible. |
| Credenciales inválidas o instancia desconectada | Pausar el remitente y la campaña. |

Ante `unknown`, bloquear nuevos intentos del destinatario y pausar el remitente hasta reconciliar o resolver manualmente. No reciclar una reserva de envío solo porque venció. Un proceso que pierde su reserva debe abortar y no iniciar nuevas llamadas.

Reconciliar por ID del proveedor cuando exista; si no existe una correlación inequívoca, mostrar “requiere revisión”. No deducir éxito solo porque hay un mensaje parecido. Una eventual acción manual de reenvío debe explicar el riesgo de duplicado y dejar auditoría; nunca incluir `unknown` en “reintentar fallidos” automáticamente.

## 8. Ritmo, horarios y controles de contacto

La configuración debe limitar el uso del sistema, **no prometer evitar baneos**. WhatsApp advierte sobre mensajes automatizados, masivos y no deseados; espaciar envíos no convierte Evolution en una integración oficial ni elimina el riesgo. [Uso responsable de WhatsApp](https://faq.whatsapp.com/361005896189245/?eea=0&locale=en_US).

- Parámetros por campaña: intervalo mínimo, máximo por minuto/hora/día, zona horaria, días permitidos, franja y fecha de inicio.
- Topes del remitente compartidos entre todas las campañas y pruebas. Aplicar el límite más restrictivo y contar también intentos cuyo resultado sea incierto.
- Ventanas móviles de 60 segundos y una hora; límite diario según día local de la zona configurada. Persistir la información; reiniciar el contenedor no resetea cuotas.
- Guardar instantes en UTC y evaluar horarios con zona IANA `America/Argentina/Tucuman`. Validar cambios de día, fines de semana y configuraciones inconsistentes.
- Si vence una ventana, guardar `next_attempt_at`; no dejar un HTTP abierto ni dormir durante horas en una tarea en memoria.
- Pausar bloquea nuevas autorizaciones de despacho. Una petición ya autorizada/en vuelo puede terminar; mostrarlo en la interfaz. Cancelar invalida pendientes y nunca intenta retirar mensajes ya aceptados.
- Un número debe estar habilitado para contacto y no figurar en `koi_suppressions` tanto al iniciar como justo antes de enviar. Mantener leads con consentimiento desconocido en la base, pero excluirlos del envío hasta registrar evidencia.
- Procesar una baja recibida o manual para futuras campañas y pendientes de la actual. No eliminar automáticamente una supresión al reimportar un contacto.

Para el primer piloto usar únicamente números propios/de prueba, una campaña de dos destinatarios y un intervalo de 30 segundos. Es un ajuste de prueba para observar el flujo, **no una recomendación anti-baneo**. No incorporar rotación de números ni simulaciones para eludir restricciones.

## 9. Adaptador Evolution y webhooks

### Envío

Extender `src/evolution.ts` o separar `src/evolution-client.ts`, conservando la consulta de estado actual. Implementar `sendText` con validación de entrada y salida, timeout y errores sanitizados. Usar el endpoint de texto de la versión instalada, previsto como `POST /message/sendText/{instance}` con header `apikey`.

**Validación obligatoria antes de cerrar el adaptador:** comprobar el esquema exacto de Evolution 2.3.7 en la instalación/documentación correspondiente y capturar fixtures sanitizados de una prueba autorizada. La documentación histórica usa estructuras diferentes; no copiar `textMessage/options` ni asumir soporte de una clave de idempotencia sin verificarlo. [Referencia histórica de envío](https://github.com/evolution-foundation/evolution-docs/blob/main/docs/05-Endpoints/00-send-plain-text.md).

### Recepción de eventos

Ruta propuesta: `POST /api/webhooks/evolution`. Debe resolverse **antes** del middleware que exige JWT de usuario en `src/app.ts`, con autenticación propia de servidor a servidor. No convertirla en una ruta pública sin verificación.

- Configurar un webhook por instancia, con un secreto independiente en header si la versión lo soporta. Verificar ese soporte en la instalación. Si no existe, resolver autenticación en un proxy privado entre ambos servicios antes de habilitar recepción; no asumir una firma HMAC que Evolution no emite.
- Seleccionar `MESSAGES_UPDATE`, `MESSAGES_UPSERT`, `CONNECTION_UPDATE` y el evento de envío disponible que permita correlación. La documentación v2 describe esos eventos; validar payloads reales de 2.3.7. [Webhooks de Evolution](https://github.com/evolution-foundation/docs-evolution/blob/main/v2/en/configuration/webhooks.mdx).
- Verificar secreto, instancia esperada, tamaño y esquema. Derivar workspace de la configuración, nunca del cuerpo recibido.
- Guardar primero el evento de manera durable; responder 2xx después del commit. Si no se puede guardar, responder error recuperable. Verificar en pruebas cómo reintenta Evolution; no presuponer entrega garantizada.
- Deduplicar por ID del evento si existe; si no, usar una clave estable basada en instancia, tipo, ID de mensaje y estado/atributos relevantes. No deduplicar todos los estados de un mensaje como si fueran el mismo evento.
- Procesar recibos fuera del request; soportar duplicados, eventos fuera de orden y eventos que llegan antes de persistir la respuesta HTTP del envío.
- Conservar eventos sin correlación para reintentar asociación. Nunca adjudicar una entrega al destinatario equivocado.
- Para bajas, distinguir mensajes entrantes de `fromMe`, excluir grupos y validar el formato real de JID/LID. Si no se puede resolver un teléfono inequívocamente, registrar revisión pendiente; no inventar la correspondencia.
- No guardar el body completo si contiene credenciales. Normalizar los campos necesarios y definir retención para payloads de diagnóstico.

## 10. Contrato HTTP y progreso

Todas las rutas siguientes son nuevas y propuestas. Excepto el webhook, requieren sesión válida y autorización por workspace.

| Método y ruta | Resultado |
| --- | --- |
| `GET /api/campaigns` | Listado paginado con estado y resumen |
| `POST /api/campaigns` | Crear borrador idempotente |
| `GET /api/campaigns/:id` | Configuración, revisión y resumen |
| `PATCH /api/campaigns/:id` | Editar borrador con control de revisión |
| `POST /api/campaigns/:id/preview` | Texto por destinatario y exclusiones; no envía |
| `POST /api/campaigns/:id/start` | Congelar selección y encolar; responder 202 con ID y contadores |
| `POST /api/campaigns/:id/pause` | Frenar nuevos despachos |
| `POST /api/campaigns/:id/resume` | Revalidar y continuar pendientes |
| `POST /api/campaigns/:id/cancel` | Cancelar pendientes; operación idempotente |
| `GET /api/campaigns/:id/recipients` | Detalle paginado y filtros por estado |
| `GET /api/campaigns/:id/progress` | Snapshot de contadores y salud del worker |
| `GET /api/campaigns/:id/events` | Eventos con cursor para stream o recuperación |
| `POST /api/campaigns/:id/retry-failed` | Reintentar únicamente rechazos seguros y elegibles |
| `POST /api/suppressions` | Registrar baja manual con evidencia |
| `POST /api/webhooks/evolution` | Ingestión autenticada del proveedor |

No aceptar estados arbitrarios, textos finales de envío ni URLs del proveedor enviados por el cliente. Validar todos los IDs contra el workspace. Derivar el mensaje final de la plantilla validada y el snapshot. Registrar actor y request ID de operaciones humanas.

**Actualización de interfaz:** entregar primero polling cada 3 segundos mientras la vista está activa, con backoff y cancelación de peticiones al salir. Luego agregar SSE autenticado mediante `fetch` streaming y header Bearer; no poner JWT en query strings. Mantener polling como fallback. Documentar que polling es actualización periódica, no eventos instantáneos.

Para SSE, persistir cursor de eventos, reconectar sin perder cambios, verificar expiración/revocación de sesión y configurar Traefik sin buffering con heartbeats. Al reconectar o detectar un cursor fuera de retención, obtener un snapshot actualizado.

Mostrar dos cosas diferentes: progreso de despacho y confirmaciones de entrega. `accepted`, `delivered` y `read` no deben sumarse como destinatarios distintos. Mostrar también pendientes, en vuelo, excluidos, fallos, inciertos, próxima ejecución y motivo de pausa. Si el worker pierde latido, mostrar “worker sin actividad” en lugar de simular avance.

## 11. Archivos previstos

```text
src/
  campaigns/                 # servicio, repositorio y validaciones
  queue/                     # reservas, frecuencia, recuperación y reconciliación
  worker.ts                  # entrypoint independiente
  evolution-client.ts        # envío y estado del proveedor
  webhooks/evolution.ts      # autenticación e ingestión
  contracts/campaigns.ts     # contratos HTTP del backend
  app.ts                     # nuevas rutas y orden del webhook
  config.ts                  # nuevas variables y validación por proceso
supabase/migrations/
  <nueva migración de campañas y cola>
test/
  campaigns.test.ts
  queue.test.ts
  worker.test.ts
  webhooks.test.ts
  campaign-security.test.ts
Dockerfile.worker            # o target explícito equivalente
.env.example
README.md
```

En el repo frontend: agregar pantallas bajo `src/koi`, cliente y contratos equivalentes, rutas de navegación, compositor y pruebas E2E. No conectar el flujo nuevo con endpoints n8n del proyecto anterior.

## 12. Orden de ejecución y entregables

### Paso 1 — Migraciones y reglas de negocio

- [ ] Crear rama en cada repo cuando corresponda y revisar su estado antes de editar.
- [ ] Diseñar transiciones, restricciones, roles e idempotencia.
- [ ] Crear migraciones nuevas con la CLI disponible, consultando `--help` y versión; no inventar comandos ni reaplicar las existentes.
- [ ] Añadir tablas y funciones; adaptar evidencia de consentimiento a bajas/manuales.
- [ ] Probar aislamiento y concurrencia sobre PostgreSQL real. PGlite sigue siendo útil para tests rápidos, pero no sustituye la prueba de dos conexiones compitiendo.

**Salida:** iniciar una campaña crea exactamente una cola durable; todavía no se envía a WhatsApp.

### Paso 2 — Worker con proveedor simulado

- [ ] Implementar reservas, transición a `sending`, límites y recuperación.
- [ ] Separar el entrypoint de worker del servidor HTTP.
- [ ] Implementar heartbeat, apagado con SIGTERM y habilitación global.
- [ ] Simular rechazos, timeouts y caídas antes/después de aceptar.
- [ ] Ejecutar dos workers y demostrar que no toman el mismo destinatario.

**Salida:** cerrar la app, reiniciar API/worker y conservar el progreso sin reenvíos automáticos inciertos.

### Paso 3 — Evolution y piloto real acotado

- [ ] Verificar contrato de texto de 2.3.7 y normalización de destinatarios.
- [ ] Implementar adaptador y webhooks autenticados con fixtures reales sanitizados.
- [ ] Probar dos números propios, con destino y texto revisados antes del envío.
- [ ] Correlacionar aceptación, entrega y lectura cuando el dispositivo emita esos estados.
- [ ] Probar desconexión, pausa automática y recuperación controlada.

**Salida:** una campaña creada en Koi realmente envía mediante su worker y conserva evidencia de resultado. No marcar esta etapa completa solo con un health o estado `connected`.

### Paso 4 — Frontend completo

- [ ] Formulario, selección, compositor, variables y vista previa.
- [ ] Configuración de frecuencia y horarios con validación.
- [ ] Inicio idempotente, controles de pausa/reanudación/cancelación.
- [ ] Progreso con polling, detalle por destinatario y exportación.
- [ ] SSE con reconexión si se requiere actualización por eventos en esta entrega; mantener fallback.
- [ ] Mostrar errores y resultados inciertos sin ocultarlos bajo “enviado”.

**Salida:** operación de punta a punta desde el navegador sin terminal ni n8n.

### Paso 5 — Producción y recuperación

- [ ] Aplicar migraciones revisadas después de respaldo y prueba en entorno aislado.
- [ ] Desplegar API y worker del mismo SHA desde GitHub; frontend desde su repo.
- [ ] Verificar secretos, rol de máquina, webhook, límites y logs sanitizados.
- [ ] Dejar el worker deshabilitado inicialmente; habilitar para el piloto.
- [ ] Registrar evidencia del piloto y del reinicio controlado.
- [ ] Documentar rollback y operación en README.

## 13. Despliegue del worker en Dokploy

Crear `koi-worker` desde `koiwebstudio00-cmd/koi-leads-api`, misma rama/commit que la API. Usar `Dockerfile.worker` con comando `node src/worker.ts` o `npm run worker`, una vez implementado. Añadir el script correspondiente al `package.json`; actualmente no existe.

- Un proceso y una réplica inicial; política de reinicio y apagado ordenado.
- Sin dominio ni puerto público. Health del proceso y heartbeat de trabajo son comprobaciones distintas.
- Límite inicial orientativo: 512 MiB y 0,5 CPU para el worker, sujeto a medición. No presentarlo como consumo garantizado ni reducir recursos de otros proyectos sin medir.
- Pool pequeño y polling adaptable: rápido cuando hay trabajo elegible, lento en reposo. Si la base falla, detener despachos y reintentar conexión con backoff.
- Nunca ejecutar el scheduler dentro del frontend ni de una función efímera de Vercel.

Variables nuevas propuestas:

| Variable | Proceso | Uso |
| --- | --- | --- |
| `KOI_WORKER_DATABASE_URL` | Worker | Conexión TLS del rol restringido |
| `KOI_WEBHOOK_DATABASE_URL` | API | Rol restringido de ingestión |
| `KOI_EVOLUTION_WEBHOOK_SECRET` | API y configuración de webhook | Autenticar callbacks mediante el mecanismo verificado |
| `KOI_SEND_ENABLED` | Worker | Arrancar en `false`; freno global complementario al estado persistido |
| `KOI_WORKER_ID` | Worker | Identidad de ejecución para reservas y latidos |
| `KOI_WORKER_POLL_MS` | Worker | Intervalo de búsqueda con rango validado |
| `KOI_SEND_TIMEOUT_MS` | Worker | Timeout menor que la reserva |

Conservar las variables existentes de Evolution y workspace en el worker. Mantener la clave publishable de Supabase para la API web; no sustituirla por una clave privilegiada. No agregar ninguna credencial de máquina a variables `VITE_*`.

Para revertir: deshabilitar nuevos despachos, dejar terminar lo que esté en vuelo o marcarlo incierto, detener worker y redesplegar el SHA anterior compatible. No borrar cola, intentos ni recibos, y no revertir destructivamente la migración para corregir un error de código.

## 14. Pruebas de aceptación obligatorias

| Caso | Resultado esperado |
| --- | --- |
| Iniciar dos veces con la misma clave | Una campaña y un conjunto de destinatarios |
| Mismo teléfono repetido en selección | Un único destinatario por campaña |
| Cerrar pestaña o cerrar sesión | Worker continúa independientemente de la sesión |
| Reiniciar API | Cola y worker continúan |
| Reiniciar worker antes del HTTP | Reserva recuperable sin pérdida de trabajo |
| Matar worker después de aceptación y antes de persistir | Resultado incierto/reconciliación; ningún reenvío ciego |
| Dos consumidores en paralelo | Sin doble reclamación ni exceso del límite por instancia |
| Pausar durante envío | Se completa como máximo lo ya autorizado; no se autoriza el siguiente |
| Cancelar campaña | Se cancelan pendientes; aceptados conservan historial |
| Se alcanza cuota o termina horario | Espera persistente hasta la siguiente ventana |
| Reimportar número dado de baja | Sigue excluido |
| Baja mientras está en cola | Excluido al validar antes de despacho |
| Timeout o 5xx ambiguo del proveedor | No se asume que no hubo envío |
| Webhook duplicado o fuera de orden | Sin duplicar efectos ni retroceder estado |
| Webhook llega antes que la respuesta HTTP | Se conserva y correlaciona después |
| Webhook no autenticado o instancia ajena | Rechazado y sin cambio de datos |
| Usuario de otro workspace | Sin lectura ni modificación de campaña |
| Variable faltante o payload inválido | Bloqueo claro antes de encolar/enviar |
| 5.000 destinatarios con proveedor simulado | Memoria acotada, consultas indexadas y progreso consistente |
| Worker muerto | Interfaz muestra falta de actividad |

Pruebas automáticas con proveedor simulado por defecto. Nunca disparar WhatsApp real desde `npm test`. Mantener `npm run verify` del backend y la batería existente del frontend. Agregar pruebas E2E de campaña completa con proveedor falso y una prueba manual productiva pequeña, documentada.

## 15. Definición de terminado y próxima sesión

La entrega estará terminada cuando desde la app se pueda crear una campaña, iniciarla, cerrar el navegador, volver y comprobar envíos reales trazables, con pausa/cancelación operativas y recuperación probada tras reinicio. Debe existir un procedimiento para resolver resultados inciertos, además del camino feliz.

**Primera tarea de la próxima sesión:** implementar el Paso 1 y el Paso 2 en este repo. No empezar por más cambios visuales ni dar por resuelto el envío con la consulta de estado.

Texto para retomar:

> Trabajá sobre `docs/implementacion-campanas-colas-envios.md` en `/Users/dev0/koi/koi-leads-api`. Implementá primero la persistencia de campañas, la cola y el worker con Evolution simulado, incluyendo idempotencia, límites por instancia, pausa y recuperación de envíos inciertos. Mantené frontend y backend en repos separados. Después integrá Evolution y el frontend para completar el flujo. No declares terminada una etapa sin cumplir sus pruebas de aceptación.

Este archivo es el entregable de planificación. No ejecuta migraciones, no modifica servicios y no incorpora todavía el envío de campañas.
