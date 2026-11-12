# Envío manual inmediato

Implementación local del 12/11/2026. Requiere publicar API, workers y frontend compatibles y aplicar la migración `20261112040353_koi_manual_dispatch.sql`. Esta documentación no certifica un despliegue productivo.

## Funcionamiento

Las conversaciones no tienen intervalos, cupos por minuto/hora/día ni horarios de campaña. Tampoco consumen sus cupos. El chat obtiene el siguiente turno disponible del número; una solicitud HTTP ya iniciada termina antes de cederlo. Las campañas conservan sus ventanas, cupos y espaciado. Un chat con tráfico continuo puede posponer campañas.

La aplicación mantiene dos colas y dos servicios Node:

| Servicio | Comando local | Configuración Docker | Habilitación | Conexión |
| --- | --- | --- | --- | --- |
| Campañas | `npm run worker:campaigns` | `KOI_WORKER_KIND=campaign` | `KOI_SEND_ENABLED` | `KOI_WORKER_DATABASE_URL` |
| Conversaciones | `npm run worker:chat` | `KOI_WORKER_KIND=chat` | `KOI_CHAT_SEND_ENABLED` | `KOI_CHAT_WORKER_DATABASE_URL` |

Ambos usan `Dockerfile.worker`, los valores de Evolution y el certificado de Supabase existentes. `npm run worker` sigue siendo alias del worker de campañas y ya no envía chats. El worker mixto anterior debe retirarse.

PostgreSQL reserva el transporte por espacio e instancia. La campaña consulta chats elegibles antes de reservar y otra vez antes de iniciar HTTP. Las transacciones terminan antes de contactar a Evolution. El orden del chat se conserva y las instancias se procesan independientemente. El registro actual limita a diez las instancias adicionales.

`LISTEN koi_chat_ready` despierta el worker de chat; sus notificaciones no llevan datos personales. Necesita conexión directa o Session Pooler. `KOI_CHAT_LISTEN_DATABASE_URL` permite indicar una conexión de sesión distinta, usando el mismo rol limitado. Si no está definida, usa la conexión del worker. Con Transaction Pooler conocido por puerto 6543, o si falla el listener, el respaldo consulta cada segundo. Al reconectar se drena la cola; entre envíos elegibles no hay descanso.

## Permisos y credenciales

La migración crea `koi_chat_worker` sin login. No cambia las claves existentes. El rol solo ejecuta comandos de chat a través del dispatcher y queda vinculado a un workspace; no puede consultar tablas privadas ni ejecutar campañas.

Después de la migración, usar `scripts/provision-chat-worker.ts` desde un entorno administrativo seguro, con `KOI_ADMIN_DATABASE_URL` y `KOI_EVOLUTION_WORKSPACE_ID` definidos. Ejecutar `node scripts/provision-chat-worker.ts`. Guarda `chat-worker.env` en `.local-campaigns` (o en `KOI_PROVISION_OUTPUT`) con permisos restrictivos. No imprime contraseñas ni rota un rol ya activo. Completar Evolution y cargar las variables en el servicio de chat; mantener `KOI_CHAT_SEND_ENABLED=false` hasta terminar el cambio de versión.

La API conserva su rol de webhook. El chat conserva autorización de usuario, aislamiento de workspace, bajas explícitas, validación de archivos y claves idempotentes.

## Fallos y recuperación

- Deshabilitar campañas no deshabilita chats. Una desconexión o una respuesta real del proveedor afecta al transporte de esa instancia.
- `Retry-After` de un 429 se conserva para texto y adjuntos. Un resultado ambiguo queda por revisar y no se reenvía automáticamente.
- Un mensaje `unknown` no ocupa indefinidamente el transporte global. Los siguientes envíos al mismo destinatario esperan revisión; otros destinatarios pueden continuar si la instancia está disponible.
- Una reserva vencida antes de comenzar se devuelve a cola. Si ya comenzó, pasa a incierta. Un token viejo no habilita un nuevo envío.
- Si falla el guardado después del POST, el worker no repite ese POST. La reconciliación usa IDs inequívocos; no asocia resultados por similitud del texto.
- Al apagar, el worker deja de reservar y espera sus solicitudes en curso. El chat deshabilita su estado al cerrar. Una señal de vida ausente durante más de 60 segundos deja de reservar prioridad de chat frente a campañas.

## Recepción e interfaz

Los mensajes entrantes normales ya no toman el bloqueo general del emisor de campañas. El webhook confirma después de persistir. Las reacciones también actualizan la conversación para que Realtime las anuncie.

El frontend muestra una burbuja pendiente mientras guarda, la reconcilia usando `clientKey` y evita duplicarla si el estado llega antes de la respuesta HTTP. Un fallo de confirmación mantiene el borrador y muestra “Sin confirmar”; no significa que el proveedor rechazó el mensaje. Las cuentas de WhatsApp se consultan separadas de los eventos de cada chat. Al volver a la pestaña y al reconectar se consulta el estado actual, incluidos recibos y reacciones.

## Despliegue coordinado

1. Registrar versiones y configuración actuales, respaldar y ensayar en un entorno aislado. Preparar imágenes compatibles y los dos servicios con envíos deshabilitados.
2. Detener nuevas reservas del worker mixto y drenar envíos activos. La migración se rechaza si quedan mensajes o destinatarios `leased` o `sending`; no alterar esos estados a ciegas ni reenviar inciertos para desbloquearla.
3. Coordinar cualquier pausa de API con la recuperación de webhooks. Aplicar únicamente la migración pendiente, desplegar API compatible y verificar recepción.
4. Provisionar el rol de chat una vez. Configurar ambos servicios con sus credenciales y `KOI_WORKER_KIND`. No usar el rol de campañas en el servicio de chat.
5. Arrancar chat y campañas desde la misma versión de API. Verificar salud y luego habilitar cada uno por separado. Publicar el frontend compatible.
6. Con números propios autorizados, verificar campaña activa, tres respuestas seguidas y un PDF, respuesta entrante, reacción, pausa de campaña y recuperación de conexión. No usar leads reales para pruebas.

La imagen comprueba `/tmp/koi-chat-worker-heartbeat` para chat y `/tmp/koi-worker-heartbeat` para campañas. La base conserva latidos independientes. El evento `chat_dispatch_finished` registra ID técnico, resultado, `queueWaitMs` y duración de proveedor sin teléfonos ni contenido. La salud de proceso no garantiza entrega de WhatsApp.

## Reversión

Detener y drenar ambos workers antes de cambiar de versión. El esquema nuevo cambia la autorización de chat, por lo que no es compatible con reactivar el worker mixto antiguo. Para contener una incidencia, deshabilitar `KOI_CHAT_SEND_ENABLED` y conservar la cola; las campañas pueden seguir con el worker nuevo. Corregir hacia adelante o usar una versión expresamente probada contra este esquema. No borrar mensajes, deshacer migraciones a ciegas ni permitir consumidores antiguos y nuevos simultáneamente.

## Verificación local

`npm run verify` comprueba tipos y pruebas de API/migraciones con datos sintéticos. `npm run test:postgres` usa exclusivamente PostgreSQL descartable en `127.0.0.1:55439`; prueba carreras entre workers, prioridad, presupuestos, orden, instancias, permisos, reservas, recepción sin bloqueo y el listener real. No ejecutarlo sobre producción.

Desde el frontend: `KOI_API_REPOSITORY=/ruta/koi-leads-api npm run test:e2e`. Usa API/Auth sintéticas y no envía mensajes reales. El recorrido de chat demora deliberadamente la respuesta HTTP para comprobar la burbuja pendiente y su reconciliación.

Verificación del 12/11/2026: API `npm run verify` con 78 pruebas aprobadas; PostgreSQL real con 19 pruebas aprobadas; frontend `npm run verify` con 78 pruebas, tipos y build correctos; 21 recorridos Chromium integrados aprobados. Lint conserva tres avisos Fast Refresh preexistentes en componentes de UI. Todas las pruebas usaron datos sintéticos, sin envíos reales. La base PostgreSQL descartable se detuvo al finalizar.

La imagen Docker no se construyó en esta sesión porque el daemon no estaba disponible. Quedan pendientes el ensayo del despliegue/reversión, asesores de Supabase del entorno de destino, aplicación de la migración y validación con Evolution en producción. No se midió aún el p95 operativo; se agregó `queueWaitMs` para medirlo después del despliegue.
