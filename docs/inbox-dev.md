# Inbox en dev: Supabase aplicado y entorno local

Estado al 20/11/2026. Ambos repositorios están en la rama Git `dev`. Esto no crea una rama/instancia nueva de Supabase: el entorno local usa el proyecto Koi existente `avqhjbrcbgqhelfkcist` (`back_web`, workspace Estudio Koi). No se realizó push ni despliegue de API/frontend/workers.

**Etapa 5 implementada, migrada y habilitada localmente con autorización explícita:** API y worker tienen `KOI_INBOX_SEND_ENABLED=true`. Se verificaron permisos, cola vacía, latidos y la interfaz con sesión real. No se enviaron mensajes de prueba a contactos. El historial de las cuentas reales continúa funcionando. Ver [etapa 5](inbox-etapa-5.md).

## Código y migraciones

Los commits iniciales de la entrega completa son API `2102e6f` y frontend `ac30379`. Incluyen las etapas 1–4. El informe de revisión se conserva en `Claude outputs/reporte-mejoras-chats-leads-v2.md`; reemplaza la primera versión retirada en la limpieza del 21/11/2026. Los commits posteriores registran aplicación remota y preparación local.

Se aplicaron estas cuatro migraciones y se alinearon los nombres locales con las versiones asignadas por Supabase:

| Migración | Versión aplicada |
| --- | --- |
| `koi_inbox_foundation` | `20261120114933` |
| `koi_inbox_ingestion` | `20261120115127` |
| `koi_inbox_read_model` | `20261120115133` |
| `koi_inbox_manual_send` | `20261120123733` |

No volver a ejecutar estos archivos en el proyecto existente. Los originales en el primer commit tenían versiones locales `20261120132912`, `20261120135825` y `20261120142342`; el SQL no cambió al alinear los nombres.

Verificaciones remotas realizadas:

- 14 tablas Inbox con RLS activo; solo cuentas y conversaciones en `supabase_realtime`.
- `anon` no puede ejecutar `koi_inbox_query` ni leer cuentas; `authenticated` no puede leer mensajes privados directamente.
- Un usuario sin membresía es rechazado. Al aplicar las migraciones, las consultas de un administrador devolvieron cuentas e índice vacíos.
- Antes de conectar Zernio, el índice EvoAPI tenía 92 conversaciones y había 1085 leads. Son valores de referencia anteriores a importar el historial real de Inbox.
- Advisors revisados: los avisos nuevos corresponden a tablas privadas sin políticas de acceso directo y a la RPC `SECURITY DEFINER` autenticada, que deriva workspace desde la membresía y fija `search_path`. Se verificaron las restricciones; no se abrieron permisos para silenciar estos avisos. Referencias: [RLS sin políticas](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy) y [funciones autenticadas](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable).

Existe una discrepancia **anterior** en el historial: `20261112120000_koi_chat_inbox_actions.sql` y `20261112140000_koi_stats_and_stage_history.sql` no están registrados remotamente, aunque se observaron objetos de esas funcionalidades. La base también registra `20261111151245_koi_fix_chat_claim_phone`, sin archivo equivalente local. No se reejecutaron ni se marcaron artificialmente como aplicadas. No usar un `db push` indiscriminado hasta reconciliar ese historial. Persisten los avisos previos de [ejecución anónima de `koi_stats_command`](https://supabase.com/docs/guides/database/database-linter?lint=0028_anon_security_definer_function_executable) y [protección de contraseñas filtradas](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection); no se modificó esa configuración en esta entrega.

## Abrir la interfaz

- Frontend: http://localhost:5173/inbox
- Conexiones: http://localhost:5173/configuracion/conexiones
- API: http://localhost:3001/health

Se crearon `koi-leads-api/.env` y `koi-leads-web/.env.local`, ignorados por Git y con permisos locales restringidos. Ya contienen la URL Koi y su clave **publicable**. La API usa `PORT=3001` y `KOI_APP_ORIGIN=http://localhost:5173`; el frontend usa `VITE_KOI_API_URL=/api`, que Vite redirige a la API local.

Ingresar con la cuenta habitual de Koi. Zernio ya está configurado localmente y las cuentas WhatsApp e Instagram del perfil Default están registradas. El worker importa su historial real; no se insertaron chats ficticios. Los cambios de CRM/lectura/archivo hechos con esta app local afectan la misma base Koi.

Para volver a levantarlo, usar dos terminales con Node 24 o superior:

```sh
cd /Users/dev0/koi/koi-leads-api
npm run dev
```

```sh
cd /Users/dev0/koi/koi-leads-web
npm run dev -- --host localhost --strictPort
```

Arranque comprobado: API `/health` 200, frontend `/inbox` 200, proxy `/api/inbox/index` sin sesión 401 y pantalla de ingreso visible. Falta que el usuario inicie sesión en este navegador para revisar Inbox con su sesión real. Las verificaciones remotas de RPC se hicieron separadamente con contexto autenticado; no constituyen una prueba de WebSocket real ni una recepción Zernio.

## Configuración simple de Zernio

La arquitectura sigue siendo **API existente + un worker de recepción + PostgreSQL como cola**. Gateway es el acceso de la API, no otro servicio. Los dos logins limitan qué operaciones puede hacer cada proceso; no requieren otra base, Redis ni n8n.

`npm run setup:inbox` prepara los accesos y los archivos locales. Lee **`.env.zernio.local`** y la conexión administrativa `KOI_ADMIN_DATABASE_URL` de **`.env.provision`**, ambos ignorados por Git. La conexión administrativa se utiliza únicamente durante esta preparación, nunca por la API ni por el worker.

En una instalación nueva, completar en `.env.zernio.local`:

```dotenv
ZERNIO_API_KEY=
ZERNIO_PROFILE_ID=
ZERNIO_WEBHOOK_SECRET=
KOI_ZERNIO_WORKSPACE_ID=
```

`ZERNIO_API_KEY` debe corresponder a la cuenta con acceso al perfil y a las conexiones/mensajes. `ZERNIO_PROFILE_ID` es el ID del perfil exclusivo de Koi, no el ID de una cuenta WhatsApp/Instagram. No pegar claves en documentación ni en commits.

La instalación local ya tiene estos valores, incluido un secreto aleatorio de 32 bytes. Usa el perfil Default `6a836444c7be73897fe0a1a7` y el workspace Koi `727df779-b2eb-4485-9670-f1f7eb12e30e`. El mismo secreto debe configurarse en Zernio cuando se cree el webhook. Si el workspace tiene más de un administrador, indicar también `KOI_INBOX_ACTOR_ID` en el archivo privado.

El comando genera o reutiliza:

| Variable | Uso / origen |
| --- | --- |
| `KOI_INBOX_GATEWAY_DATABASE_URL` | API. Login PostgreSQL propio, miembro de `koi_inbox_gateway`, con binding de workspace/perfil/actor. |
| `KOI_INBOX_INGEST_DATABASE_URL` | Worker de ingreso. Otro login, miembro de `koi_inbox_ingest`, con su binding. |
| `KOI_DATABASE_CA_FILE` | Ruta al certificado CA, si la conexión PostgreSQL lo requiere. |

Las migraciones crean los grupos y tablas; el comando de preparación crea `koi_inbox_api_login` y `koi_inbox_ingest_login`, sus contraseñas y bindings. Comprueba el contexto, el rechazo de operaciones del otro proceso y la prohibición de leer directamente los mensajes privados. Una repetición conserva las credenciales; no rota contraseñas ni cambia bindings existentes. No usar `service_role`, una clave publicable ni el usuario administrador como reemplazo de estas URLs.

El comando escribe la configuración de API en `.env` y la del worker en `.env.inbox-worker`, con permisos locales `0600`. La API no recibe la contraseña del worker y el worker no recibe la del gateway. `.env.zernio.local` conserva el conjunto de preparación, pero ningún proceso de ejecución lo carga automáticamente.

Para adoptar las cuentas ya conectadas en el perfil, sin repetir OAuth:

```sh
npm run setup:inbox -- --sync-accounts
```

Esto verifica cada cuenta contra Zernio, registra solo WhatsApp/Instagram y programa el historial. No envía mensajes. Reiniciar la API después de configurar y ejecutar en una tercera terminal:

```sh
npm run worker:inbox-ingest
```

Este script carga `.env.inbox-worker`. En producción se pueden inyectar las mismas variables en el contenedor: `KOI_INBOX_INGEST_DATABASE_URL`, `ZERNIO_API_KEY`, `ZERNIO_PROFILE_ID`, `KOI_ZERNIO_WORKSPACE_ID` y `KOI_DATABASE_CA_FILE` cuando corresponda.

El worker local está iniciado. La respuesta real de Zernio aún omite el objeto `sync` documentado: en ese caso se conserva el punto de avance anterior y se repite el barrido de historial cada cinco minutos, deduplicando mensajes. Si Zernio entrega el objeto incremental, se exige su checkpoint final. No se inventa un timestamp local que pudiera omitir mensajes. Este respaldo no sustituye los webhooks para recepción inmediata.

Validación de activación: ambos logins probados, cuentas reales conectadas, webhook sin firma rechazado con 401 y evento técnico firmado aceptado con 200, guardado y marcado `ignored` por el worker. La prueba no crea chats ni envía mensajes. `npm run verify`: 124 pruebas aprobadas, además del chequeo de tipos.

Primera carga completada: **76 conversaciones y 709 mensajes**. Zernio aplicó límites temporales durante la importación; los reintentos automáticos recuperaron todos los trabajos. Al cierre no quedaban trabajos de conversaciones pendientes ni errores, solo los dos barridos periódicos de cuentas. WhatsApp no devolvió historial en esta consulta; las conversaciones importadas corresponden a Instagram. Estos conteos son una fotografía de la validación, no valores fijos del sistema.

Zernio necesita llegar a una URL HTTPS pública `/api/webhooks/zernio` para entregar eventos; `localhost` no es alcanzable desde Zernio. Falta publicar la API de prueba y registrar esa URL y el secreto en Zernio para validar eventos reales de extremo a extremo. No se creó un túnel ni webhook público en esta entrega. Ver [etapa 3](inbox-etapa-3.md) para eventos y permisos. El envío de texto de etapa 5 ya está habilitado localmente; falta el piloto real autorizado en ambos canales.
