# Inbox — etapa 1: datos y contratos

> Actualización de activación: migraciones de etapas 1, 3 y 4 aplicadas en Supabase; código en `dev` y entorno local preparado. Las notas de validación local siguientes describen la entrega original. Estado actual y variables: [Inbox en dev](inbox-dev.md).

Fecha: 20 de noviembre de 2026.
Estado: implementado y validado localmente. Sin conexión a Zernio, migración remota, despliegue ni activación de envíos.

## Implementación

- Migración `20261120114933_koi_inbox_foundation.sql`, creada con Supabase CLI y ejecutada en Postgres embebido (PGlite) durante los tests.
- Tablas públicas de cuentas y conversaciones de Inbox, con lectura limitada al workspace y sin mutaciones directas desde el navegador.
- Tablas privadas de identidades, mensajes, lecturas, eventos, cola, referencias de archivos y atribución.
- Referencias compuestas que impiden cruzar workspace, cuenta, canal, contacto y conversación.
- Restricciones únicas para identidad por cuenta, eventos, mensajes y solicitudes de envío. Una conversación no puede tener dos despachos reservados o con resultado incierto a la vez.
- RLS habilitada en todas las tablas nuevas. Los datos privados no tienen acceso de `anon`, `authenticated` ni de los roles existentes de EvoAPI.
- Contratos Zod en `src/inbox/contracts.ts`. El cuerpo de envío no permite cuenta, destinatario, fecha, autor, plantillas ni `HUMAN_AGENT` aportados por el cliente.
- Política de ventana en `src/inbox/reply-window.ts` y equivalente privado SQL. La fecha de vencimiento es la original entrante más 24 horas; el instante exacto de vencimiento queda cerrado. Fecha futura, ausente o cuenta desconectada bloquean la elegibilidad.

## Compatibilidad de contactos

`koi_leads.phone` admite `null` para contactos sociales. No se inventan teléfonos ni se alteran las restricciones de formato para valores existentes.

- El alta manual y las importaciones siguen exigiendo teléfono válido.
- La edición admite conservar `null` o agregar un teléfono válido. Una restricción de base impide eliminar un teléfono ya registrado.
- El CRM del frontend muestra “Sin teléfono”, permite editar los datos restantes y oculta llamadas y accesos a nuevos chats EvoAPI para esos contactos.
- El selector de destinatarios y las instantáneas de campañas excluyen contactos sin teléfono.
- El envío de un chat nuevo EvoAPI rechaza explícitamente contactos sin teléfono antes de crear una conversación.
- Un contacto social puede consultarse, tener notas y seguimientos y aparecer en el pipeline común. Su creación automática desde eventos pertenece a la etapa 3.

## Contratos HTTP previstos

Estos endpoints son el contrato de trabajo de las etapas siguientes; **todavía no están registrados en la API**.

| Método y ruta | Propósito |
| --- | --- |
| `GET /api/inbox/accounts` | Cuentas del workspace para el selector |
| `GET /api/inbox/conversations/index` | Resúmenes en lotes por UUID y actualización dirigida por IDs |
| `GET /api/inbox/conversations/:id` | Detalle, contacto y elegibilidad calculada por el servidor |
| `GET /api/inbox/conversations/:id/messages` | Historial paginado; cursor resuelto contra la conversación autorizada |
| `POST /api/inbox/conversations/:id/messages` | Envío con `Idempotency-Key`; cuenta y destinatario resueltos en servidor |
| `PATCH /api/inbox/conversations/:id` | Asignación, archivado y acciones de lectura validadas |

La ventana es individual por conversación/cuenta. API y worker deberán usar la misma política al aceptar y despachar. El cuerpo de la solicitud no podrá aportar el reloj o la fecha habilitante.

## Permisos y límites de esta entrega

Las tablas privadas permanecen cerradas. Las RPC autenticadas, la vinculación de máquinas y sus permisos mínimos se incorporarán con las operaciones concretas de las etapas 3–5. No se otorgó acceso genérico a todas las tablas para preparar un worker todavía inexistente.

La migración crea estructura, índices y restricciones; no crea cuentas, no ingresa datos reales y no envía mensajes. La política de ventana está probada como función, pero aún no está integrada a un flujo de envío Zernio. Los mensajes no actualizan todavía `last_inbound_at`: esa actualización se incorporará al procesamiento idempotente de eventos de la etapa 3.

Las claves de almacenamiento son referencias: no se creó un bucket ni se implementó la carga o entrega de medios. Tampoco se publicaron nuevas tablas en Realtime; eso corresponde a la implementación de lectura y sincronización de Inbox.

## Validación

- Backend: `npm run verify`, 99 pruebas aprobadas, incluida la nueva suite de integración con siete casos que cubren política de ventana, RLS, integridad, duplicados, cola y compatibilidad con el CRM/EvoAPI.
- Frontend: `npm run verify`, 82 pruebas aprobadas, tipos, lint y build correctos.
- Chrome: `npm run test:e2e -- e2e/koi.spec.ts`, 13 pruebas aprobadas. Incluye pruebas añadidas en `e2e/koi.spec.ts` para editar contactos sin teléfono en escritorio y móvil, conservar `null` y no ofrecer llamadas o chats EvoAPI inválidos.
- Los tests de base cargan las migraciones en PGlite. Las pruebas de navegador utilizan Auth y API simuladas; no acreditan conexión real a Zernio ni migración aplicada en Supabase.
- El build conserva avisos existentes de tamaño de bundle e importación mixta de `Statistics`; no se modificó esa parte.

## Publicación

No aplicar automáticamente esta migración a producción ni asumir que Inbox ya está habilitado. Antes de publicar, reconciliar el historial remoto de migraciones y desplegar la compatibilidad del frontend/backend antes de comenzar a crear contactos sociales reales.

La reversión operacional consiste en mantener Inbox deshabilitado y detener la futura ingestión. No restablecer `phone NOT NULL` si ya existen contactos sociales, ni borrar su información para revertir.

Continuación: la extracción de componentes compartidos ya está implementada y validada localmente en [etapa 2](inbox-etapa-2.md). Las conexiones, webhooks e historial de [etapa 3](inbox-etapa-3.md) también están implementados localmente; sigue la pantalla Inbox de lectura (etapa 4).
