# Koi Leads API

Backend independiente de Koi Leads, con Node.js 24 y TypeScript. Este repositorio contiene únicamente la API, sus contratos, pruebas y migraciones; el frontend React/Vite se publica por separado y consume la API por HTTP.

## Implementado

- Autenticación con Supabase y autorización por membresía del espacio, conservando RLS del usuario.
- Bases de leads con nombre, edición, búsqueda y paginación.
- Edición de contactos, tabla global, pipeline, etiquetas, responsables, próximas acciones, notas e historial.
- Duplicación de campañas como borradores y avance automático a Contactado tras un envío aceptado.
- Importación CSV/XLSX: vista previa, preparación guardada, edición, selección, deduplicación y confirmación transaccional e idempotente. Límite de 5.000 filas y 10 MiB.
- Estado de la conexión Evolution desde el servidor, con clave privada, timeout y errores sanitizados.

- Campañas de texto, selección, variables, vista previa y arranque idempotente.
- Cola PostgreSQL, worker independiente, horarios/límites persistentes y pausa/reanudación/cancelación.
- Webhooks autenticados, entrega/lectura, bajas y recuperación conservadora de envíos inciertos.

Para activar el worker y el webhook en Dokploy: **[guía de despliegue de campañas](docs/despliegue-campanas.md)**. El código no habilita envíos por sí solo; `KOI_SEND_ENABLED` comienza en `false`. `src/import-worker.ts` sigue siendo exclusivo del análisis de archivos; el nuevo proceso de campañas es `src/worker.ts`.

## Desarrollo

Requiere Node.js 24.14.0 y npm.

```sh
npm ci
cp .env.example .env
# Completar .env localmente.
npm run dev
```

```sh
npm run verify
```

Las pruebas usan datos sintéticos y PostgreSQL embebido (PGlite); no requieren credenciales remotas. `src/contracts` contiene el contrato de importaciones y de estado Evolution. No hay imports hacia carpetas externas al repositorio. Cambios futuros del contrato HTTP deben coordinarse con el frontend.

## Configuración

Copiar `.env.example` y completar los valores en el entorno del servidor. No subir `.env` a GitHub.

| Variable | Valor o propósito |
| --- | --- |
| `PORT` | `3001` |
| `KOI_APP_ORIGIN` | `https://leads.koistudio.com.ar` en producción |
| `KOI_SUPABASE_URL` | URL del proyecto Koi aprobado, indicada en `.env.example` |
| `KOI_SUPABASE_PUBLISHABLE_KEY` | Clave publishable de Supabase; no service role |
| `EVOLUTION_PUBLIC_URL` | Origen HTTPS de Evolution, sin barra final |
| `EVOLUTION_API_KEY` | Clave existente de Evolution, solo en el servidor |
| `EVOLUTION_INSTANCE_NAME` | Nombre exacto de la instancia conectada |
| `KOI_EVOLUTION_WORKSPACE_ID` | UUID del espacio Koi, distinto de la referencia de Supabase |

Las cuatro variables de Evolution se completan juntas. Si todas están vacías, la API funciona y devuelve `not_configured`; una configuración parcial impide el arranque. La API verifica cada token con Supabase y nunca usa una clave `service_role` para saltar RLS.

## Despliegue desde GitHub en Dokploy

1. Crear o abrir la Application `koi-api`.
2. Source: **GitHub**, repositorio **koiwebstudio00-cmd/koi-leads-api**, rama **main**, Build Path **/**.
3. Build Type: **Dockerfile**. Docker File: **Dockerfile**. Docker Context Path: **.**. Sin build stage.
4. Cargar las variables de producción de la tabla anterior en **Environment**. Las credenciales son variables de ejecución, no argumentos de build.
5. Domain: **api-leads.koistudio.com.ar**, path **/**, puerto interno **3001**, HTTPS/Let's Encrypt. El DNS debe apuntar al VPS.
6. Deploy y comprobar `https://api-leads.koistudio.com.ar/health`.

La imagen no contiene archivos `.env`, tests, migraciones ni código del frontend. Corre como usuario `node`. El despliegue no ejecuta migraciones automáticamente.

En el repositorio del frontend configurar antes del build:

```env
VITE_KOI_API_URL=https://api-leads.koistudio.com.ar/api
```

El frontend también necesita su URL y clave publishable de Supabase. Nunca debe recibir la clave Evolution.

## Base de datos

`supabase/migrations` conserva las versiones ya aplicadas en el proyecto Koi. No volver a ejecutar esos archivos manualmente sobre la base existente. `supabase/bootstrap.sql` es una plantilla para asignar un administrador existente en Auth; no cambia contraseñas ni envía invitaciones.

La migración `koi_retire_legacy_access` cerró el acceso por API de las tablas del proyecto anterior, conservando sus datos. Las migraciones posteriores deben crearse como archivos nuevos y verificarse antes de aplicarse.

## Verificación operativa y rollback

- `/health` confirma el proceso, no la conexión con Supabase o Evolution.
- `/api/workspace` y `/api/integrations/evolution/status` requieren `Authorization: Bearer <sesión Supabase>`.
- Las operaciones protegidas sin sesión deben responder 401.
- Validar login, una importación y estado de WhatsApp con la app antes de considerar completa la conexión productiva.
- Registrar el SHA de cada despliegue. Para revertir código, redesplegar el último commit que haya funcionado desde Dokploy. No borrar datos ni revertir migraciones automáticamente.

El servicio no está desplegado por el solo hecho de publicar este repositorio.

## Validación de esta separación — 2026-11-05

- `npm ci`: instalación reproducible; auditoría sin vulnerabilidades reportadas.
- `npm run verify`: tipos correctos y 29 tests aprobados, incluyendo migraciones reales en PGlite, aislamiento por espacio e importación de 5.000 filas.
- `docker build -t koi-leads-api:standalone .`: imagen construida desde la raíz de este repositorio.
- Contenedor con red externa deshabilitada y configuración sintética: health 200, endpoint protegido 401, análisis CSV en worker y usuario no root.
- Contratos HTTP sin cambios respecto del frontend existente. Sin dependencias de carpetas externas.

Estas comprobaciones no constituyen una prueba productiva contra Evolution ni envían mensajes.

## Contactos y campañas — 6/11/2026

La migración koi_contact_editing_cold_outreach está aplicada en Supabase. El consentimiento es un dato histórico opcional: no excluye contactos de la vista previa, del inicio ni del worker. Se mantienen las bajas explícitas y la validación de variables del mensaje.

PATCH /api/leads/:id permite editar nombre, teléfono, empresa, email y origen. Normaliza el teléfono, rechaza duplicados y exige revision para detectar ediciones concurrentes. RLS limita la escritura a miembros del espacio y los grants solo permiten editar esos cinco campos. Una edición se refleja en todas las bases; las campañas iniciadas conservan su snapshot.

Validación: pruebas de contactos, aislamiento, edición concurrente y paso por el worker con consentimiento unknown en test/contacts.test.ts; recorrido de edición e inicio en las pruebas integradas del frontend.

## CRM comercial — 6/11/2026

Migración aplicada: `20261106173832_koi_lead_pipeline.sql`. Agrega etapa, etiquetas, responsable del mismo workspace, próxima acción y fecha, y notas con autor derivado de la sesión. Conserva los contactos; etapa inicial Nuevo. El avance Nuevo → Contactado es automático tras un envío aceptado; las demás etapas se gestionan manualmente.

`GET /api/crm/leads`, `GET /api/crm/board` y `GET /api/crm/options` consultan los contactos globales y filtros; `/api/crm/leads/:id` obtiene la ficha o actualiza seguimiento con PATCH y revision. `/api/crm/leads/:id/notes` permite GET paginado y POST con Idempotency-Key; `/api/crm/leads/:id/history` consulta campañas iniciadas. Páginas de 30 filas. RLS aísla cada workspace; la consulta de responsables solo expone miembros del espacio del usuario.

`POST /api/campaigns/:id/duplicate` con Idempotency-Key copia a borrador y limpia startsAt. No inicia envíos. La revisión y confirmación usan el flujo existente.

Validación: `npm run verify` (50 tests); pruebas de deduplicación entre bases, paginación, filtros, concurrencia, notas idempotentes y aislamiento en `test/crm.test.ts`. Consulta autenticada verificada contra Supabase: 2 leads y 7 columnas. Los recorridos del frontend usan PGlite y proveedores simulados.


## Avance automático del pipeline
Cada envío aceptado cambia Nuevo a Contactado en la misma transacción. Los fallidos, pendientes, omitidos o inciertos no avanzan. Las etapas posteriores se conservan. La migración koi_pipeline_contacted_automation reconcilia el historial existente. Kanban y tabla consultan actualizaciones cada 10 segundos mientras estén visibles, sin interrumpir escritura o arrastre.

## Entrega consolidada — 9/11/2026

Migraciones de esta entrega, aplicadas al proyecto Koi el 6/11/2026:

| Archivo | Cambio |
| --- | --- |
| `20261106164809_koi_contact_editing_cold_outreach.sql` | Edición con revision y consentimiento informativo; conserva bajas explícitas. |
| `20261106173832_koi_lead_pipeline.sql` | Campos CRM, notas, consultas paginadas y aislamiento por workspace. |
| `20261106175306_koi_pipeline_contacted_automation.sql` | Nuevo → Contactado al aceptar un envío y reconciliación del historial. |

El trigger actualiza la etapa dentro de la transacción que registra el resultado del worker. El rol interno solo puede modificar stage conforme a su política RLS. Un resultado aceptado no garantiza entrega o lectura. Los reintentos del mismo resultado no repiten el cambio y ninguna etapa posterior retrocede.

Para desarrollo local, configurar `KOI_APP_ORIGIN=http://localhost:5173`, iniciar la API con `npm run dev` y el frontend en otra terminal. El worker se inicia por separado con `npm run worker` y requiere la configuración de la guía de despliegue. Los procesos locales quedan detenidos al cerrar esta entrega. Un commit no despliega servicios ni ejecuta migraciones.
