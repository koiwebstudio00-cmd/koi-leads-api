# Activar campañas de Koi en Dokploy

API y worker se despliegan desde **koiwebstudio00-cmd/koi-leads-api**, como dos Applications. El frontend sigue en su repo independiente. No se usa n8n ni una nueva instalación de Redis.

## Qué está implementado

- Borradores con nombre, base y selección de contactos; texto y variables opcionales.
- Vista previa en servidor y confirmación vinculada al contenido revisado.
- Snapshot inmutable de teléfono/texto por destinatario y arranque idempotente.
- Cola PostgreSQL, un envío en vuelo por instancia, horarios de Argentina y límites persistentes por minuto/hora/día.
- Worker independiente, pausa/reanudación/cancelación y recuperación de reservas al reiniciar.
- Si un envío falla o queda incierto, se registra para revisión y la cola sigue con otros destinatarios. El envío incierto nunca se repite automáticamente. Los problemas del emisor pueden pausar la campaña.
- Recepción autenticada de estados, deduplicación, entrega/lectura sin retroceder y bajas explícitas antes de responder al webhook.
- Panel con actualización cada 3 segundos, destinatarios, actividad inicial y exportación CSV.

## Estado desplegado al 10/11/2026

- Frontend y API actualizados desde sus repositorios separados.
- `koi-worker` creado en Dokploy y desplegado con `Dockerfile.worker`: contenedor saludable y latido confirmado en Supabase.
- Credenciales limitadas de worker y webhook provisionadas, probadas y cargadas en los servicios correspondientes. La URI administrativa no se cargó en Dokploy.
- Webhook habilitado en `koi-01`, con los cuatro eventos y el header privado indicados abajo. Su configuración fue leída nuevamente desde Evolution para verificarla.
- En la instalación inicial se comprobó el rechazo de solicitudes sin secreto o con una instancia ajena y la aceptación de un evento vacío autenticado.
- **`KOI_SEND_ENABLED=true`** y latido del worker verificado tras el despliegue. La prueba de Conversaciones verificó texto y PDF entregados y una respuesta entrante en vivo. [Registro de la prueba](gestion-whatsapp.md#verificación-en-producción).

Los apartados 1 a 5 documentan la instalación ya realizada. **No volver a generar credenciales ni crear otro worker** para esta instalación.

## 1. Migraciones

Ya aplicadas en el proyecto Supabase de Koi `avqhjbrcbgqhelfkcist` el 6/11/2026:

- `koi_campaigns_queue`
- `koi_campaign_immediate_optout`
- `koi_campaign_jwt_context` (compatible con el esquema Auth administrado de Supabase)

El 10/11/2026 se aplicaron, en este orden:

1. `20261110024130_koi_lead_management.sql`
2. `20261110024132_koi_two_campaigns.sql`
3. `20261110034259_koi_whatsapp_conversations.sql`

Para esta entrega, aplicar las migraciones pendientes en orden:

1. `20261111133426_koi_campaign_review_and_reply_link.sql`
2. `20261111140358_koi_chat_rich_inbound.sql`

Antes de migrar, detener el worker y comprobar que no haya envíos en curso. La primera migración libera el bloqueo anterior por incertidumbre. Si la campaña estaba pausada y todavía tiene trabajo en cola, se reanuda desde su detalle. Aplicar solo migraciones pendientes, desplegar API y worker desde el mismo commit y después desplegar el frontend compatible. Comprobar el latido del worker y configurar o verificar el webhook. Las credenciales del worker y del webhook usan roles separados con permisos limitados y se conservan durante la actualización.

## 2. Generar las credenciales una vez

En **tu terminal local**, dentro del repo del backend y con Node 24:

```sh
cd /Users/dev0/koi/koi-leads-api
npm ci
```

Crear un archivo local `.env.provision` (está excluido de Git) con:

```env
KOI_ADMIN_DATABASE_URL=postgresql://postgres.avqhjbrcbgqhelfkcist:CONTRASENA@HOST_SESSION_POOLER:5432/postgres
EVOLUTION_INSTANCE_NAME=koi-01
KOI_EVOLUTION_WORKSPACE_ID=727df779-b2eb-4485-9670-f1f7eb12e30e
```

Copiar el host y URI correctos desde **Supabase → Connect → Session pooler** del proyecto Koi. Usar la contraseña de PostgreSQL, no la publishable key ni service_role. Si tiene caracteres especiales, codificarlos para una URI. La conexión directa también sirve cuando el equipo/VPS tiene conectividad IPv6. No usar Transaction Pooler/puerto 6543.

Ejecutar:

```sh
node --env-file=.env.provision scripts/provision-campaigns.ts
```

El script crea `.local-campaigns/worker.env` y `.local-campaigns/api-webhook.env`, con permisos de archivo privados. No imprime secretos, no modifica contactos y se niega a sobrescribir archivos o roles ya activados. No subir esos archivos a Git ni pegarlos en el chat. Eliminar `.env.provision` después de completar la provisión; esa contraseña administrativa **no debe quedar en Dokploy**.

El repo incluye el certificado raíz público enlazado por el panel de Supabase en `certs/supabase-prod-ca-2021.crt`. El script y ambos Dockerfiles lo usan con verificación de cadena y hostname; no se desactiva TLS. `KOI_DATABASE_CA_FILE` permite indicar una ruta alternativa para una futura rotación del certificado.

## 3. Configurar la API existente

En Dokploy → `koi-api` → Environment:

1. Conservar las variables actuales de Supabase, CORS y Evolution.
2. Agregar las dos líneas de `.local-campaigns/api-webhook.env`.
3. Save y Deploy desde GitHub, Dockerfile `Dockerfile`, contexto `.`.

El endpoint `https://api-leads.koistudio.com.ar/health` debe incluir `campaigns-v1`. Esto confirma versión y proceso; no prueba la conexión del worker ni entrega mensajes.

## 4. Crear el worker

Dentro del mismo proyecto de Dokploy:

1. **Create Service → Application**, nombre `koi-worker`.
2. GitHub → **koiwebstudio00-cmd/koi-leads-api**, branch `main`, build path `/`.
3. Build Type **Dockerfile**, Docker File **Dockerfile.worker**, Context Path **.**, build stage vacío.
4. Environment: copiar `.local-campaigns/worker.env` y agregar:

```env
EVOLUTION_PUBLIC_URL=https://evoapi.inmobiliarialyc.com.ar
EVOLUTION_API_KEY=LA_MISMA_CLAVE_PRIVADA_QUE_USA_KOI_API
```

5. Mantener `KOI_SEND_ENABLED=false` durante la primera comprobación.
6. **Una réplica**, sin dominio, sin puertos públicos y sin volumen de datos. La cola vive en Supabase. Usar reinicio automático y empezar con límite de memoria de 256 MiB; medir y ajustar con carga.
7. Deploy. El log debe mostrar `worker_started` con `sendingEnabled:false`, sin errores repetidos `worker_cycle_failed`.

El healthcheck del contenedor verifica el latido local de un ciclo exitoso. El panel también lee el latido persistido en Supabase. Al habilitar envíos, copiar la misma clave Evolution que ya tiene la API; no generar otra ni cambiar la instancia conectada.

## 5. Webhook por instancia en Evolution

Configurar **solo la instancia `koi-01`** con:

- URL: `https://api-leads.koistudio.com.ar/api/webhooks/evolution`
- Enabled: sí
- Webhook by events: no
- Base64: no
- Header `X-Koi-Webhook-Secret`: el valor de `KOI_EVOLUTION_WEBHOOK_SECRET` generado para la API.
- Eventos: `MESSAGES_UPDATE`, `MESSAGES_UPSERT`, `CONNECTION_UPDATE`, `SEND_MESSAGE`.

Evolution 2.3.7 admite headers por instancia. Si el Manager no permite cargar el header, usar `POST /webhook/set/koi-01` con la API key de Evolution en header `apikey` y este cuerpo (reemplazar el secreto localmente):

```json
{
  "webhook": {
    "enabled": true,
    "url": "https://api-leads.koistudio.com.ar/api/webhooks/evolution",
    "headers": { "X-Koi-Webhook-Secret": "SECRETO_GENERADO" },
    "byEvents": false,
    "base64": false,
    "events": ["MESSAGES_UPDATE", "MESSAGES_UPSERT", "CONNECTION_UPDATE", "SEND_MESSAGE"]
  }
}
```

No poner el secreto en la URL. La API responde 401 antes de leer el cuerpo si falta/no coincide el header, y 503 si todavía no se configuró la recepción.

## 6. Prueba controlada y activación inicial

El procedimiento parte de un worker con envíos deshabilitados en una instalación nueva. Para verificar Conversaciones en la instalación actual, seguir el [recorrido de WhatsApp](gestion-whatsapp.md#verificación-en-producción).

1. Importar una base con **un teléfono propio**, consentimiento y evidencia de prueba.
2. Crear campaña, elegir ese único contacto y un texto reconocible; revisar mensaje y horario.
3. Confirmar: debe quedar **En cola** y el panel indicar que el proceso está conectado con envíos deshabilitados.
4. En `koi-worker`, cambiar a `KOI_SEND_ENABLED=true`, Save y Deploy.
5. Verificar una única recepción en el teléfono, `Aceptado por Evolution` en Koi y luego entrega/lectura mediante webhook. La lectura depende de la configuración de WhatsApp del receptor.
6. Probar pausa y reanudación con dos números propios. Cerrar la pestaña y volver a abrir: el avance debe persistir.
7. Con una campaña controlada, comprobar que un fallo de destinatario deja avanzar al siguiente y aparece en **Revisar casos**. Revisar el chat antes de usar **Revisar resultado → cierre sin reenvío**. Solo un administrador puede resolverlo.

Topes iniciales del servidor: mínimo 30 s entre mensajes, máximo 2/min, 60/h y 100/día local. Se usa el límite más restrictivo entre servidor y campaña. Son controles de carga y operación; no garantizan evitar bloqueos de WhatsApp.

## Operación y límites de esta entrega

- Campañas de texto desde el número principal. Hasta dos campañas activas por espacio y 100 destinatarios por campaña. Las programadas, en ejecución y pausadas ocupan cupo. Completar o cancelar libera el cupo.
- Los chats manuales desde el número principal comparten con las campañas los límites de frecuencia y la exclusión mutua del remitente.
- Los resultados ambiguos se conservan para revisión. Los POST ambiguos y los destinatarios fallidos requieren intervención manual.
- El consentimiento registrado es informativo. Las bajas explícitas excluyen al contacto y se vuelven a comprobar antes del despacho.
- Bajas reconocidas: `baja`, `stop`, `no me contacten`, `no me escriban más` / `mas`, en mensajes entrantes con teléfono inequívoco (`@s.whatsapp.net`). Un JID `@lid` requiere un identificador alternativo que confirme el teléfono para asociarlo a un lead.
- El detalle muestra los 6 eventos más recientes. **Ver todos** expande el historial, que se consulta por bloques de hasta 100 mediante `after`. Exportación de estado de hasta 5.000 destinatarios.
- Los recibos sin asociación quedan pendientes para tolerar que lleguen antes de la respuesta HTTP. Falta una política automática de retención de esos eventos y del historial; monitorear crecimiento.
- Vista previa aproximada de texto/formato de WhatsApp, no plantilla oficial de Meta ni reproducción idéntica en todos los dispositivos.
- Secuencias, agenda y disponibilidad continúan fuera de este MVP.

## Verificaciones de desarrollo

`npm run verify`: tipos y pruebas unitarias, importaciones y autorización.

Para probar competencia real, usar PostgreSQL 17 exclusivamente local en `127.0.0.1:55439` (el test crea y elimina su propia base):

```sh
docker run --name koi-campaign-pg -d -p 127.0.0.1:55439:5432 -e POSTGRES_PASSWORD=koi_local_test_only postgres:17-alpine
npm run test:postgres
```

No ejecutar dos suites PostgreSQL en paralelo: crean roles de prueba con nombres fijos dentro de ese contenedor local. Se probaron dos consumidores, reservas vencidas, resultado incierto, pausa/cancelación durante despacho, límites tras reinicio, recibos fuera de orden y bajas sin worker.

Desde el repo del front, `KOI_API_REPOSITORY=/Users/dev0/koi/koi-leads-api npm run test:e2e` usa la API local con Auth sintética. No envía mensajes reales.

Referencias verificadas: [Evolution 2.3.7](https://github.com/EvolutionAPI/evolution-api/tree/2.3.7), [conexiones Supabase](https://supabase.com/docs/guides/database/connecting-to-postgres), [bloqueos PostgreSQL](https://www.postgresql.org/docs/17/sql-select.html).

## Despacho manual independiente — 12/11/2026

Los chats manuales quedan fuera de los intervalos, cupos y horarios de campaña. Usan un worker propio con prioridad por número, sin consumir presupuesto de campañas. Requiere una migración nueva y sustituir el worker mixto por dos servicios compatibles. [Configuración, permisos, despliegue y reversión](envio-manual-inmediato.md). Implementado localmente; pendiente de despliegue productivo.
