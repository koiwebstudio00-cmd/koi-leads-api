# Bandeja local por número — actualización 20/11/2026

Migración aplicada y verificada en Supabase el 20/11/2026. API y frontend permanecen en commits locales, pendientes de publicación; no se hizo push ni se modificaron workers.

## Comportamiento

Cada número tiene su propia bandeja. Un selector desplegable conserva la tarjeta verde de la cuenta activa, su alias y el total de chats no archivados. Las opciones mantienen los íconos, los contadores y la indicación de bandeja activa; la lista tiene altura acotada y desplazamiento para admitir muchas cuentas sin agrandar la cabecera. Permite selección por teclado y búsqueda por escritura del nombre (typeahead). “Mostrar chats de” filtra por todo el equipo, usuario actual, sin responsable o un miembro específico; no cambia la asignación. El encabezado separa el teléfono del contacto de “Respondés desde [alias]”. Los aliases identifican las conexiones; la API de cuentas actual no proporciona el teléfono propio.

Al cambiar de número se cierra el chat abierto. Si hay un borrador, archivo, grabación o envío en curso, se pide confirmar antes de descartarlo. Abrir un chat por enlace alinea la bandeja con su cuenta. “Nuevo chat” propone la cuenta seleccionada.

## Carga y sincronización

`GET /api/conversations/index` devuelve `{ userId, rows, nextCursor }`: resúmenes de todas las cuentas autorizadas, incluidos archivados, excluyendo chats vacíos, eliminados y conexiones fuera del registro. Cada bloque tiene hasta 200 filas, ordenadas por UUID; `?after=<uuid>` continúa sin offsets afectados por actividad nueva. El frontend recorre todos los bloques, muestra resultados parciales y conserva el índice en memoria durante la visita. No guarda chats en localStorage. Los filtros, búsqueda por nombre/teléfono/empresa y orden por actividad son locales. Renderiza inicialmente hasta 80 filas y agrega más al desplazarse, sin otra consulta por filtro o página visible.

Los resúmenes limitan la vista previa del último mensaje a 300 caracteres; no incluyen adjuntos binarios, citas ni reacciones. El historial sigue cargándose al abrir cada chat (50 mensajes por consulta). Esto evita descargar todos los mensajes para acelerar la lista.

Supabase Realtime ya usa WebSockets. Un evento de `koi_conversations` solicita `?ids=<uuid,...>` para hasta 100 chats; los IDs ausentes se quitan del índice. Los eventos se agrupan durante 100 ms. Las operaciones se serializan: los eventos recibidos durante una carga completa se procesan después para evitar sobrescrituras con datos anteriores. La suscripción y el regreso a una pestaña visible disparan reconciliación completa. También se reconcilia cada 60 segundos con Realtime conectado, o cada 5 segundos cuando no conecta, únicamente con la pestaña visible. Así se recuperan cambios de lectura y del lead que no emiten un cambio de conversación. El chat abierto mantiene su propia recuperación periódica.

Los workers siguen a cargo de la entrega durable, reintentos controlados, orden y prioridad de mensajes manuales. WebSockets avisa a la interfaz; no sustituye la cola ni acredita que WhatsApp haya entregado un mensaje. No se necesita otro worker, workflow de n8n ni servidor de WebSockets para esta mejora.

## Base y seguridad

Migración `20261120010432_koi_chat_inbox_index.sql`: índice parcial `(workspace_id,id)` y función privada con `search_path=''`, validación de membresía y ámbito derivado de `auth.uid()`. El wrapper público sigue siendo `SECURITY INVOKER`. Se mantiene el endpoint paginado anterior para compatibilidad. Los filtros locales no son controles de autorización: el servidor determina qué workspace se puede cargar.

Este diseño está pensado para el volumen actual (94 conversaciones visibles comprobadas el 19/11). Si crece a decenas de miles, medir tamaño, tiempo de carga y memoria; considerar índice persistente o sincronización incremental con cursor de cambios y virtualización. El cursor por UUID de esta entrega es de paginación, no un registro de cambios: inserciones anteriores al cursor se recuperan por eventos y reconciliación.

## Publicación y reversión

1. Migración aplicada: `20261120010432_koi_chat_inbox_index.sql`. No volver a ejecutarla en el proyecto Koi existente; en instalaciones nuevas, aplicar la secuencia completa.
2. Publicar la API que expone `/conversations/index` y verificar con una sesión de usuario autorizada.
3. Publicar el frontend. No requiere reiniciar ni cambiar los workers o credenciales.
4. Revisar dos cuentas, búsqueda, responsable, archivados, actualización entrante y reconexión.

Para revertir, volver al frontend anterior; el endpoint paginado continúa disponible. La migración es aditiva y puede permanecer. No publicar el frontend nuevo antes de tener API y migración: mostrará un error de carga del índice.

## Validación

Pruebas de SQL con PGlite: autenticación y aislamiento entre workspaces, archivados, eliminación/reaparición, vista previa acotada y paginación de más de 200 chats mientras cambia su actividad. Pruebas de API: cursor e IDs válidos, límites y rechazo de parámetros ajenos. Pruebas de frontend: filtros, eventos concurrentes con carga completa, fallos/reintentos y descarte de respuestas al desmontar. Recorridos Chrome con datos sintéticos: selector con diez cuentas, desplazamiento y cambio entre dos números con chats, búsqueda fuera del primer bloque, responsable, contexto de envío, borrador al cambiar de cuenta y móvil. No se enviaron mensajes reales ni se midió latencia productiva.

Validación final local: 92 pruebas del backend y 82 del frontend aprobadas; lint, tipos y build correctos, con avisos preexistentes de Fast Refresh y tamaño del bundle. Los 22 recorridos Chrome quedaron comprobados entre la ejecución general y la repetición de los 10 de importaciones tras corregir fixtures y selectores de prueba. Las pruebas usan datos sintéticos.

El ajuste del selector del 20/11 se comprobó con TypeScript, lint, build y el recorrido Chrome de diez cuentas en escritorio y móvil, incluyendo la cancelación del cambio cuando hay un borrador. Los recuentos de las capturas pertenecen a fixtures de prueba.

### Avisos preexistentes de Supabase

Se consultaron los advisors de seguridad y rendimiento el 20/11 antes del commit. Se repitió la consulta de advisors después de aplicar la migración: no aparecieron avisos nuevos de seguridad. Rendimiento agregó el aviso informativo de índice aún sin uso para el índice recién creado; el frontend y la API todavía no lo consumen en producción. La revisión local de la migración conserva autorización por membresía, `search_path` vacío, wrapper invoker y ausencia de permiso `anon` para la nueva función privada.

Los advisors señalan permisos de ejecución de la función existente `public.koi_stats_command(p_data jsonb)` para [anon](https://supabase.com/docs/guides/database/database-linter?lint=0028_anon_security_definer_function_executable) y [authenticated](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable), además de [protección de contraseñas filtradas desactivada](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection). Requieren revisión independiente de esta entrega; no se cambiaron permisos ni configuración remota. Los avisos informativos sobre RLS sin políticas incluyen tablas privadas con acceso por funciones, por lo que no corresponde abrirlas agregando políticas automáticamente.

Rendimiento informa [claves foráneas sin índice](https://supabase.com/docs/guides/database/database-linter?lint=0001_unindexed_foreign_keys), [evaluaciones RLS por fila](https://supabase.com/docs/guides/database/database-linter?lint=0003_auth_rls_initplan) y [políticas permisivas múltiples](https://supabase.com/docs/guides/database/database-linter?lint=0006_multiple_permissive_policies) en el esquema existente, también en tablas ajenas a esta función. No se añadieron índices ajenos al flujo de la bandeja.

## Aplicación en Supabase — 20/11/2026

La migración se aplicó al proyecto Koi `avqhjbrcbgqhelfkcist` mediante `apply_migration`. Supabase asignó la versión `20261120010432`; el archivo local se renombró para coincidir con el historial remoto, conservando exactamente el SQL del commit `f44a42e`.

La consulta se verificó dentro de una transacción con rol `authenticated` y membresía existente, sin devolver textos de mensajes ni modificar datos: 92 conversaciones con mensajes (2 archivadas), cargadas en un solo bloque; las otras 2 de las 94 filas existentes no tienen mensajes y se excluyen correctamente. La consulta dirigida devuelve un chat, las cuentas siguen siendo 2 y el listado anterior sigue respondiendo. La vista previa tiene como máximo 300 caracteres. También se comprobó el rechazo de un usuario sin membresía, la ausencia de permisos `anon`, el wrapper invoker y la validez del índice.

El historial remoto no registra las versiones locales `20261112120000` y `20261112140000`, aunque existen cambios de esquema asociados. No se intentó volver a aplicarlas ni reparar ese historial en esta operación; conciliarlo antes de ejecutar un `db push` global. Esta aplicación se limitó a la migración nueva de la bandeja.
