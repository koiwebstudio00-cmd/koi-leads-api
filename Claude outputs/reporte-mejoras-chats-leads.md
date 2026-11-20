# Reporte: mejoras de chats, leads y mensajes guardados (Koi Leads)

Fecha: 2026-11-12
Alcance: `koi-leads-web` (src/koi, src/components) y `koi-leads-api` (src/conversations.ts, migraciones de Supabase).
Método: lectura del código. No se ejecutó la app ni se reprodujo en el navegador. Las causas de lentitud son inferidas del código y conviene confirmarlas con la pestaña Network y con `EXPLAIN ANALYZE` sobre datos reales.

---

## Resumen

- **Tres bugs con causa confirmada en el código:**
  1. "Abrir conversación" crea un chat en la bandeja aunque no se envíe ningún mensaje.
  2. "Abrir conversación" desde la ficha del lead no lleva directo al chat: abre un diálogo y remonta toda la pantalla.
  3. Cambiar de filtro (Todos / No leídos / Pendientes / Archivados) vuelve a pedir la lista sin caché y sin indicador de carga.
- **Dependencias que faltan:** `recharts` (no está en `package.json` ni en `package-lock.json`), y los componentes shadcn `chart` y `context-menu` (no están en `src/components/ui`).
- **Backend:** hacen falta cambios en la acción `open`, en la lista de chats, en `saved_message_command` y un endpoint nuevo de estadísticas.
- **Pruebas e2e que van a romperse** al cambiar los selects nativos por el `Select` de shadcn (ver punto 2).

---

## Hallazgos por requerimiento

### 1. Menú de contexto en cada lead (acciones rápidas)

**Estado actual**
- Cada fila del inbox es un `<Link>` (`Conversations.tsx`, línea ~141). No hay menú contextual.
- `components/ui/` no tiene `context-menu.tsx`, y `@radix-ui/react-context-menu` no está instalado.
- `dropdown-menu.tsx` sí existe y ya se usa para respuestas rápidas.

**Propuesta**
- Crear un componente `ChatRowActions` reutilizable. Debe funcionar con click derecho (`context-menu` de shadcn) y con un botón "⋯" visible en hover y en mobile que abra el mismo contenido.
- Usar el mismo componente en las filas de `CrmLeads.tsx` (tabla y tarjetas del pipeline), para que "cada lead" tenga las mismas acciones.

**Acciones posibles, según lo que ya existe en el backend**

| Acción | Estado en backend |
|---|---|
| Abrir chat / Abrir ficha del lead | Ya existe (rutas) |
| Llamar / Copiar teléfono | Solo cliente (`tel:` y clipboard) |
| Archivar / Desarchivar | Ya existe (`update` con `archived`) |
| Asignar responsable (submenú) | Ya existe (`update` con `assignedTo`) |
| Cambiar etapa (submenú) | Ya existe en CRM (PATCH con `revision`) |
| Marcar como no leído | **No existe.** Requiere una acción nueva que baje `chat_reads.last_seq` |
| Fijar arriba | **No existe.** Requiere columna `pinned_at` y orden en la lista |
| Silenciar / Bloquear / Eliminar chat (como en la captura de WhatsApp) | **No existen.** "Bloquear" equivale a una baja (`koi_suppressions`) y no conviene exponerla sin una regla explícita. "Eliminar" debería ser borrado lógico |

Ver la pregunta 1 en la sección final.

---

### 2. Selector de responsable con componente nativo de shadcn

**Estado actual**: hay al menos seis selects nativos con clase `crm-select`:
- `Conversations.tsx:133`: filtro "Responsable del inbox" (el de la captura 2).
- `Conversations.tsx:517` (`ChatContact`): campo "Responsable" del panel de contacto.
- `LeadProfile.tsx`: "Responsable" en Seguimiento comercial.
- `CrmLeads.tsx:82`: filtro "Responsable" (junto con Producto y Etapa).
- `LeadManagement.tsx:47`: selector de "Campo a modificar" para la edición masiva.
- `Followups.tsx`: "Responsable de tareas".

**Propuesta**
- Crear un `AssigneeSelect` sobre `components/ui/select.tsx` (ya existe y `@radix-ui/react-select` está instalado). Mostrar iniciales y, en el filtro del inbox, la opción "Mis chats".
- Reemplazarlo en esos seis lugares.

**Tradeoff**: el `Select` de Radix no es un control nativo del sistema. En celular no abre el selector del sistema operativo. Si el uso móvil es importante, conviene validarlo.

**Impacto en pruebas**
- `e2e/conversations.spec.ts:86-91` usa `selectOption` sobre el combobox "Responsable del inbox".
- `e2e/imports.spec.ts:194, 218, 326` hace lo mismo con "Responsable" y "Responsable de tareas".
- Hay que cambiarlos a click + selección de opción.

---

### 3. Todos los chats activos disponibles

**Estado actual**
- La lista pide 40 filas por página con `OFFSET` (`Conversations.tsx:121` y `:145`). La API está en `20261110112004_koi_followups_inbox.sql`, acción `list` (líneas ~151-170).
- No hay conteo total. Solo se ven botones Anterior / Siguiente, y al cambiar de filtro se vuelve a la página 1.
- Con esto, el usuario no puede recorrer todos los chats activos de forma fluida.

**Propuesta**
- Paginación por cursor `(updated_at, id)` con scroll infinito (IntersectionObserver).
- El índice `koi_conversation_inbox (workspace_id, archived, updated_at desc, id)` ya cubre el caso sin filtros. Los filtros `pendingReply` y `unread` hacen recorridos más costosos (ver punto 4).

---

### 4. Cambiar de pestaña recarga todo y se ralentiza

**Causas probables (del código)**
1. `useChatResource` (`Conversations.tsx:70-93`) no conserva datos por filtro ni muestra estado de carga cuando cambia la clave. La lista vieja queda en pantalla y después "salta". Eso se percibe como recarga.
2. No hay caché entre filtros. Cada cambio vuelve a pedir 40 filas, y el proyecto no tiene un cliente de caché (`@tanstack/react-query` no está en dependencias).
3. El backend calcula por cada fila `chat_row` (migración `20261110112004`, líneas ~246-262). Cada fila dispara `chat_instances` (una unión de dos fuentes), un conteo de no leídos, `chat_needs_reply` y un `lateral` del último mensaje.
4. Con `pendingReply=true`, `chat_needs_reply` se evalúa sobre todas las conversaciones antes del `LIMIT`.
5. Polling cada 3 s (o 20 s con realtime) sobre la lista activa (`Conversations.tsx:121`). Cualquier `UPDATE` en `koi_conversations` vía realtime incrementa `revision` y recarga la lista, las cuentas y el chat abierto (`:113-116`, `:122`, `:187`).

**Propuesta**
- Incorporar TanStack Query con `keepPreviousData`, `staleTime` y claves por filtro. Prefetch de los otros filtros al montar.
- Invalidar por clave, no con un `revision` global.
- Backend: calcular `chat_instances` una sola vez, eliminar los conteos por fila (por ejemplo con una columna `unread_count` mantenida al insertar mensajes o con un `lateral` acotado), y resolver `pendingReply` con una columna materializada.
- Antes de decidir, medir con `EXPLAIN ANALYZE` la acción `list` sobre datos reales.

---

### 5. "Abrir conversación" crea un chat fantasma en la bandeja

**Causa confirmada**: la acción `open` hace un `INSERT ... ON CONFLICT DO UPDATE` (migración `20261110034259`, líneas 156-164; la versión vigente está en `20261110112004`, acción `open`, aprox. líneas 165-172). Cada apertura crea la fila en `koi_conversations`, aunque no haya mensajes. La lista no filtra por existencia de mensajes, así que la fila aparece en la bandeja.

Además, el `DO UPDATE` pone `archived=false` en silencio: abrir un chat archivado lo desarchiva.

**Opciones**
- **A (recomendada a largo plazo):** no insertar al abrir. Devolver la conversación si existe, o un borrador (lead + instancia) si no existe. La fila se crea en el primer envío. Requiere una ruta para borradores.
- **B (cambio chico, recomendada para ya):** mantener la fila, filtrar en `list` las conversaciones sin mensajes (`exists (select 1 from chat_messages ...)`) y quitar `archived=false` del `DO UPDATE`. Quedan filas sin mensajes en la base; se pueden limpiar con un job.

---

### 6. "Abrir conversación" desde la ficha recarga y no va directo

**Estado actual**
- `LeadProfile.tsx` (acciones de la ficha) enlaza a `/conversaciones?leadId=…`.
- `Conversations.tsx:151` y `:160-182` abren el diálogo `StartChat` con el lead preseleccionado. Hay que tocar "Abrir chat", luego `POST /conversations`, después `navigate`, y el inbox se monta otra vez: lista, cuentas y chat.
- La ruta `conversaciones` es `lazy` en `KoiApp.tsx`, con fallback "Abriendo conversaciones…", así que el árbol completo se vuelve a montar.

**Propuesta**
- Al tocar el botón, buscar si el lead ya tiene conversación (endpoint nuevo `GET /conversations/by-lead/:leadId`, o reutilizar `list`). Si existe, navegar directo a `/conversaciones/:id`, con el botón en estado de carga mientras tanto.
- Abrir el diálogo solo si el lead no tiene chat.
- Si el lead tiene chats en dos números, elegir el que tenga mensajes más recientes (ver pregunta 3).
- Este punto se resuelve junto con el 5.

---

### 7. Loaders y skeletons en toda la plataforma

**Estado actual**
- `src/koi` usa texto plano en unos 25 lugares: "Cargando chats…", "Abriendo conversación…", "Cargando mensajes…", "Cargando tareas…", "Cargando campaña…", entre otros.
- `components/ui/skeleton.tsx` existe, pero `src/koi` no lo usa. Solo aparece en `sidebar.tsx` y en `EstadoUi.tsx`.
- El único spinner está en `KoiApp.tsx` (`LoaderCircle`).
- `src/pages/` y `src/features/` no están importados desde la app activa (`main.tsx` → `KoiApp`). Parecen código sin uso.

**Propuesta**
- Crear `Spinner` (para botones, con el texto de "Guardando…") y skeletons por componente: `ChatRowSkeleton`, `MessagesSkeleton`, `CardSkeleton`, `StatSkeleton`, `ProfileSkeleton`.
- Aplicarlos en: inbox, panel de chat, ficha (pestañas de notas, historial y tareas), mensajes guardados, selector de mensajes, campañas, pipeline, seguimientos e inicio. También como fallback de `Suspense`.

---

### 8. Módulo de estadísticas con recharts de shadcn

**Estado actual**
- `recharts` no está en `package.json` ni en `package-lock.json`. No existe `components/ui/chart.tsx`.
- `KoiDashboard.tsx` muestra cuatro números de `/crm/summary`: leads, contactados, campañas activas y WhatsApp conectados.

**Propuesta**
- `npm i recharts` (versión compatible con React 19) y agregar el `chart.tsx` de shadcn (`ChartContainer`, `ChartTooltip`).
- Backend: acción `stats` en `koi_crm_command`, con rango de fechas y zona horaria `America/Argentina/Tucuman`. Datos sugeridos:
  - Embudo por etapa.
  - Leads nuevos por día.
  - Mensajes enviados y recibidos por día.
  - Tasa de respuesta (chats con respuesta sobre chats iniciados).
  - Campañas por estado.
  - Tareas vencidas.
- Revisar índices para las consultas por fecha (`koi_leads` ya tiene índice por `stage, created_at`; hay que verificar `chat_messages` por `(workspace_id, sent_at)`).

---

### 9. Iconos: conversaciones (bandeja) y mensajes guardados

**Estado actual**
- `components/AppShell.tsx`, constantes `NAV` y `BOTTOM`: "Conversaciones" y "Chats" usan `MessageCircle`. "Mensajes guardados" usa `BookOpen`.
- `Conversations.tsx:147` (pie de la bandeja) y el estado vacío usan `MessageCircle`.
- El botón "Elegir mensaje guardado" del compositor (`Conversations.tsx`) también usa `BookOpen`.

**Propuesta**
- Conversaciones: `Inbox` (bandeja de chats).
- Mensajes guardados: `MessageSquareText`.
- Usar el mismo icono de mensajes guardados en el compositor para mantener la coherencia.
- Verificar los nombres exactos en `lucide-react` 1.27 antes de codificar.

---

### 10. Mejorar la UI de mensajes guardados y tener un visor tipo chat

**Estado actual**
- `SavedMessages.tsx` muestra tarjetas con el cuerpo completo (`max-h-64`) y acciones Copiar, Editar y Archivar.
- El único preview es `ChatMessagePreview.tsx`, dentro del selector del chat. Es un textarea editable, no una burbuja. La página de mensajes no tiene preview.

**Propuesta**
- Diseño en dos columnas: lista a la izquierda y visor a la derecha en desktop. En mobile, el visor abre en un sheet.
- Visor con burbuja real: reutilizar los estilos de `conversations.css` (`koi-message-bubble`, `koi-message-meta`) y el fondo `chat-wallpaper.svg`. Mostrar hora y ticks de referencia.
- Selector "Vista previa con lead": buscar un lead y reemplazar las variables `{{nombre}}`, `{{empresa}}`, etc. con la función `personalize()` que ya existe. Sin lead, mostrar las variables resaltadas.
- En el editor, mostrar la vista previa en vivo al lado del textarea.
- Mantener las validaciones que ya existen: variables sin completar y límite de 4000 caracteres.

---

### 11. Mensajes guardados escalables (muchos mensajes)

**Estado actual**
- Backend (`20261110114637_koi_saved_messages.sql`, `saved_message_command`, acción `messages`):
  - La búsqueda usa `strpos(lower(title||' '||body||' '||category))` sobre toda la tabla, sin índice.
  - El conteo y la página son dos consultas separadas, con `OFFSET`.
  - `categories` hace `distinct` sobre todos los mensajes del workspace, sin filtrar archivados ni contar.
- Picker (`SavedMessagePicker.tsx`): lista plana de títulos, sin filtro por categoría y sin ver el cuerpo hasta elegir. `goToPage` vacía el resultado y vuelve a mostrar "Cargando…" en cada página.
- `SavedMessages.tsx` vuelve a pedir datos al enfocar la ventana (`focus`).

**Propuesta**
- Backend:
  - Índice GIN con `pg_trgm` sobre título y cuerpo (o `tsvector` en español).
  - `categories` con conteo, filtrado por archivados.
  - Campos `use_count` y `last_used_at`, actualizados cuando se usa un mensaje, para ordenar por uso.
- UI de la página:
  - Chips de categoría con conteo.
  - Tarjetas colapsadas (título, dos líneas del cuerpo, categoría) que se expanden.
  - Búsqueda con debounce y "Cargar más" o paginación por cursor.
  - Virtualizar solo si se superan unos cientos de mensajes.
- UI del picker:
  - El mismo buscador y los mismos chips de categoría.
  - Al seleccionar, mostrar la burbuja de preview (punto 10).
  - Mantener los datos previos mientras se cambia de página (`keepPreviousData`).

---

## Cambios de backend (migraciones nuevas)

1. `open` idempotente y sin desarchivar. Filtrar en `list` las conversaciones sin mensajes, o pasar a un modelo de borrador (punto 5).
2. Búsqueda de conversación por lead (punto 6).
3. Acción para marcar como no leído (punto 1).
4. Columna `pinned_at` si se decide "Fijar" (punto 1).
5. `list` con cursor y contadores precalculados (puntos 3 y 4).
6. Acción `stats` (punto 8).
7. Saved messages: índice `pg_trgm`, categorías con conteo, `use_count` y `last_used_at` (punto 11).

## Dependencias a agregar

- `recharts` (punto 8).
- Componentes shadcn `chart` y `context-menu`, con `@radix-ui/react-context-menu` (puntos 1 y 8).
- `@tanstack/react-query` para caché y estados de carga (puntos 3, 4 y 7).
- No se recomienda agregar virtualización todavía.

## Orden sugerido de implementación

1. **Bugs rápidos:** punto 5 (sin chats fantasma), punto 6 (ir directo al chat), punto 9 (iconos) y punto 2 (`Select` de responsable). Actualizar las pruebas e2e en el mismo cambio.
2. **Rendimiento:** caché con TanStack Query, skeletons (punto 7) y lista por cursor (puntos 3 y 4). Medir antes y después.
3. **Menú contextual** (punto 1).
4. **Mensajes guardados:** visor tipo chat y escalabilidad (puntos 10 y 11).
5. **Estadísticas** (punto 8).

## Preguntas que necesito que definas

1. **Menú contextual:** ¿incluimos "Silenciar", "Bloquear" y "Eliminar chat"? Hoy no tienen backend. Recomiendo no incluir "Bloquear" hasta definir qué significa (hoy equivale a una baja) y que "Eliminar" sea un borrado lógico.
2. **Chats sin mensajes:** ¿los ocultamos en la bandeja (opción B) o rediseñamos la apertura como borrador (opción A)?
3. **Lead con chats en dos números:** ¿qué número se abre por defecto? Propuesta: el que tenga el mensaje más reciente.
4. **Estadísticas:** ¿qué métricas y qué rango por defecto (7, 30 o 90 días)? ¿Es una pantalla nueva o parte de Inicio?
5. **Selector de responsable:** ¿aceptamos el `Select` de Radix aunque en celular no abra el selector nativo?

## Riesgos y pruebas

- Pruebas e2e a actualizar: `e2e/conversations.spec.ts` (líneas 21, 86-91) e `e2e/imports.spec.ts` (líneas 194, 218, 326).
- Pruebas de API a agregar para la acción `open` idempotente y para la lista sin chats vacíos. `test/whatsapp.test.ts` y `test/crm.test.ts` ya cubren contratos cercanos.
- Medir `list` con `EXPLAIN ANALYZE` antes de reescribir `chat_row`.
- Las migraciones deben aplicarse en orden con `supabase migrations`.

## Otros hallazgos (no pedidos)

- `src/pages/` y `src/features/` parecen código muerto. Eliminarlos reduciría confusión.
- `koi-leads-api/.env.provision` y `koi-leads-api/.local-campaigns/*.env` están en la carpeta del proyecto. Conviene verificar que estén en `.gitignore`. No revisé ese archivo.
