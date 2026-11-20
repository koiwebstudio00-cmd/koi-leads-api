# Inbox en dev: Supabase aplicado y entorno local

Estado al 20/11/2026. Ambos repositorios están en la rama Git `dev`. Esto no crea una rama/instancia nueva de Supabase: el entorno local usa el proyecto Koi existente `avqhjbrcbgqhelfkcist` (`back_web`, workspace Estudio Koi). No se realizó push ni despliegue de API/frontend/workers.

## Código y migraciones

Los commits iniciales de la entrega completa son API `2102e6f` y frontend `ac30379`. Incluyen las etapas 1–4; los informes de `Claude outputs` también se guardaron en el backend. Los commits posteriores registran aplicación remota y preparación local.

Se aplicaron exclusivamente estas tres migraciones y se alinearon los nombres locales con las versiones asignadas por Supabase:

| Migración | Versión aplicada |
| --- | --- |
| `koi_inbox_foundation` | `20261120114933` |
| `koi_inbox_ingestion` | `20261120115127` |
| `koi_inbox_read_model` | `20261120115133` |

No volver a ejecutar estos archivos en el proyecto existente. Los originales en el primer commit tenían versiones locales `20261120132912`, `20261120135825` y `20261120142342`; el SQL no cambió al alinear los nombres.

Verificaciones remotas realizadas:

- 14 tablas Inbox con RLS activo; solo cuentas y conversaciones en `supabase_realtime`.
- `anon` no puede ejecutar `koi_inbox_query` ni leer cuentas; `authenticated` no puede leer mensajes privados directamente.
- Un usuario sin membresía es rechazado. Consultas con contexto de un administrador autorizado: cuentas `[]`, índice vacío y contador cero.
- El índice EvoAPI sigue consultable: 92 conversaciones; los leads permanecen en 1085. Inbox todavía no tiene cuentas vinculadas ni conversaciones.
- Advisors revisados: los avisos nuevos corresponden a tablas privadas sin políticas de acceso directo y a la RPC `SECURITY DEFINER` autenticada, que deriva workspace desde la membresía y fija `search_path`. Se verificaron las restricciones; no se abrieron permisos para silenciar estos avisos. Referencias: [RLS sin políticas](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy) y [funciones autenticadas](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable).

Existe una discrepancia **anterior** en el historial: `20261112120000_koi_chat_inbox_actions.sql` y `20261112140000_koi_stats_and_stage_history.sql` no están registrados remotamente, aunque se observaron objetos de esas funcionalidades. La base también registra `20261111151245_koi_fix_chat_claim_phone`, sin archivo equivalente local. No se reejecutaron ni se marcaron artificialmente como aplicadas. No usar un `db push` indiscriminado hasta reconciliar ese historial. Persisten los avisos previos de [ejecución anónima de `koi_stats_command`](https://supabase.com/docs/guides/database/database-linter?lint=0028_anon_security_definer_function_executable) y [protección de contraseñas filtradas](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection); no se modificó esa configuración en esta entrega.

## Abrir la interfaz

- Frontend: http://localhost:5173/inbox
- Conexiones: http://localhost:5173/configuracion/conexiones
- API: http://localhost:3001/health

Se crearon `koi-leads-api/.env` y `koi-leads-web/.env.local`, ignorados por Git y con permisos locales restringidos. Ya contienen la URL Koi y su clave **publicable**. La API usa `PORT=3001` y `KOI_APP_ORIGIN=http://localhost:5173`; el frontend usa `VITE_KOI_API_URL=/api`, que Vite redirige a la API local.

No hace falta configurar otras variables para ver la interfaz. Ingresar con la cuenta habitual de Koi. Inbox mostrará el estado sin cuentas y Conexiones indicará que Zernio aún no está configurado. No se insertaron chats ficticios en la base real. Los cambios de CRM/lectura/archivo hechos con esta app local afectan la misma base Koi.

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

## Datos necesarios para conectar Zernio

Se preparó **`koi-leads-api/.env.zernio.local`**, también ignorado por Git. Este archivo **no se carga automáticamente**: permite completar la integración sin romper el arranque actual por configuración parcial.

Completar allí únicamente los valores todavía faltantes del proveedor:

```dotenv
ZERNIO_API_KEY=
ZERNIO_PROFILE_ID=
```

`ZERNIO_API_KEY` debe corresponder a la cuenta con acceso al perfil y a las conexiones/mensajes. `ZERNIO_PROFILE_ID` es el ID del perfil exclusivo de Koi, no el ID de una cuenta WhatsApp/Instagram. No pegar claves en documentación ni en commits.

El archivo ya incluye un `ZERNIO_WEBHOOK_SECRET` aleatorio de 32 bytes y `KOI_ZERNIO_WORKSPACE_ID=727df779-b2eb-4485-9670-f1f7eb12e30e`. El mismo secreto debe configurarse en Zernio cuando se cree el webhook.

Antes de activar la integración hay que preparar:

| Variable | Uso / origen |
| --- | --- |
| `KOI_INBOX_GATEWAY_DATABASE_URL` | API. Login PostgreSQL propio, miembro de `koi_inbox_gateway`, con binding de workspace/perfil/actor. |
| `KOI_INBOX_INGEST_DATABASE_URL` | Worker de ingreso. Otro login, miembro de `koi_inbox_ingest`, con su binding. |
| `KOI_DATABASE_CA_FILE` | Ruta al certificado CA, si la conexión PostgreSQL lo requiere. |

Las migraciones crean los grupos y tablas, **no** esos logins con contraseña ni sus bindings. Cuando estén completos el perfil y la clave de Zernio, se pueden provisionar los dos logins y completar las URLs. No usar `service_role`, una clave publicable ni el usuario administrador como reemplazo de estas URLs.

Para habilitar la API deben estar completas juntas las cinco variables: `KOI_INBOX_GATEWAY_DATABASE_URL`, `ZERNIO_API_KEY`, `ZERNIO_WEBHOOK_SECRET`, `ZERNIO_PROFILE_ID` y `KOI_ZERNIO_WORKSPACE_ID`. Pasarlas a `.env` cuando la configuración esté lista y reiniciar.

El worker necesita `KOI_INBOX_INGEST_DATABASE_URL`, `ZERNIO_API_KEY`, `ZERNIO_PROFILE_ID`, `KOI_ZERNIO_WORKSPACE_ID` y, si corresponde, `KOI_DATABASE_CA_FILE`. Se inicia con `npm run worker:inbox-ingest` después de configurar su entorno. Actualmente no está iniciado.

Zernio necesita llegar a una URL HTTPS pública `/api/webhooks/zernio` para entregar eventos; `localhost` no es alcanzable desde Zernio. La validación de recepción requiere un backend de prueba publicado o un túnel configurado, más la vinculación de cuentas desde Conexiones. No se creó un túnel ni webhook en esta entrega. Ver [etapa 3](inbox-etapa-3.md) para eventos y permisos. El envío sigue deshabilitado hasta etapa 5.
