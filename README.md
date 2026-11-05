# Koi Leads API

Backend independiente de Koi Leads, con Node.js 24 y TypeScript. Este repositorio contiene únicamente la API, sus contratos, pruebas y migraciones; el frontend React/Vite se publica por separado y consume la API por HTTP.

## Implementado

- Autenticación con Supabase y autorización por membresía del espacio, conservando RLS del usuario.
- Bases de leads con nombre, edición, búsqueda y paginación.
- Importación CSV/XLSX: vista previa, preparación guardada, edición, selección, deduplicación y confirmación transaccional e idempotente. Límite de 5.000 filas y 10 MiB.
- Estado de la conexión Evolution desde el servidor, con clave privada, timeout y errores sanitizados.

Las campañas, la cola de envíos, su worker y los webhooks de Evolution todavía están pendientes. `src/import-worker.ts` analiza archivos fuera del hilo principal; no es un worker de campañas. No hay endpoints de envío de WhatsApp.

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
