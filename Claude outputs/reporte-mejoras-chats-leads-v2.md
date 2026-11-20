# Reporte v2: mejoras de chats, leads y mensajes guardados (Koi Leads)

Fecha: 2026-11-12 (revisado tras el commit `44a3853` del frontend y los commits de la API hasta `5b8649f`)
Alcance: `koi-leads-web` (src/koi, src/components) y `koi-leads-api` (src/conversations.ts, migraciones de Supabase).
Método: lectura del código y de git. No se ejecutó la app ni se reprodujo en el navegador. Las causas de lentitud son inferidas y conviene confirmarlas con la pestaña Network y con `EXPLAIN ANALYZE` sobre datos reales.

---

## Cambios respecto de la versión 1

- `Conversations.tsx` cambió (commit `44a3853`): hay envío optimista, el realtime ahora invalida solo lo necesario, el debounce de carga se quitó y las cuentas se refrescan cada 30 s. Las referencias de línea se actualizaron.
- Se corrigió una afirmación: el realtime ya no recarga "lista, cuentas y chat" en cada cambio. Recarga la lista, y el chat activo solo si su fila cambió.
- Nuevo bug en el envío optimista (ver sección "Bug nuevo").
- Nuevas restricciones que afectan propuestas (ver sección "Conflictos con cambios recientes").
- Los commits de la API (envío manual, `20261112013328_koi_manual_dispatch.sql`) no tocan `open` ni `list`. Sí redefinen `chat_message_json` para agregar `clientKey`.

---

## Resumen

- **Tres bugs con causa confirmada:**
  1. "Abrir conversación" crea un chat en la bandeja aunque no se envíe ningún mensaje.
  2. "Abrir conversación" desde la ficha no lleva directo al chat: abre un diálogo y remonta la pantalla.
  3. Cambiar de filtro (Todos / No leídos / Pendientes / Archivados) vuelve a pedir la lista sin caché y sin feedback visual.
- **Bug nuevo:** el envío optimista marca "Sin confirmar" también los errores de validación (4xx), y deja burbujas huérfanas si el texto cambia después de un fallo.
- **Dependencias que faltan:** `recharts`, y los componentes shadcn `chart` y `context-menu`.
- **Restricciones del frontend actual:** el e2e depende de textos ("Guardando…") y de la URL de envío. Eso condiciona el plan de loaders y de caché.
- **Pruebas e2e que se van a romper** con el `Select` de shadcn (ver punto 2).

---

## Hallazgos por requerimiento

### 1. Menú de contexto en cada lead (acciones rápidas)

**Estado actual**
- Cada fila del inbox es un `<Link>` (`Conversations.tsx:162`). No hay menú contextual.
- `components/ui/` no tiene `context-menu.tsx`, y `@radix-ui/react-context-menu` no está instalado.
- `dropdown-menu.tsx` sí existe y ya se usa para respuestas rápidas.

**Propuesta**
- Crear `ChatRowActions` reutilizable: click derecho (`context-menu` de shadcn) y un botón "⋯" visible en hover y en mobile que abra el mismo contenido.
- Usar el mismo componente en las filas de `CrmLeads.tsx` (tabla y tarjetas del pipeline).

**Acciones posibles, según el backend actual**

| Acción | Estado en backend |
|---|---|
| Abrir chat / Abrir ficha del lead | Ya existe (rutas) |
| Llamar / Copiar teléfono | Solo cliente (`tel:` y clipboard) |
| Archivar / Desarchivar | Ya existe (`update` con `archived`) |
| Asignar responsable (submenú) | Ya existe (`update` con `assignedTo`) |
| Cambiar etapa (submenú) | Ya existe en CRM (PATCH con `revision`) |
| Marcar como no leído | **No existe.** Requiere una acción que baje `chat_reads.last_seq` |
| Fijar arriba | **No existe.** Requiere columna `pinned_at` y orden en la lista |
| Silenciar / Bloquear / Eliminar chat | **No existen.** "Bloquear" equivale a una baja (`koi_suppressions`) y no conviene exponerla sin una regla explícita. "Eliminar" debería ser borrado lógico |

Ver la pregunta 1.

---

### 2. Selector de responsable con componente nativo de shadcn

**Estado actual**: hay seis selects nativos con clase `crm-select`:
- `Conversations.tsx:154`: filtro "Responsable del inbox" (el de la captura 2).
- `Conversations.tsx` (`ChatContact`, aprox. línea 563): campo "Responsable" del panel de contacto.
- `LeadProfile.tsx:85`: "Responsable" en Seguimiento comercial.
- `CrmLeads.tsx:82`: filtro "Responsable".
- `LeadManagement.tsx:47`: "Campo a modificar" de la edición masiva.
- `Followups.tsx`: "Responsable de tareas".

**Propuesta**
- Crear `AssigneeSelect` sobre `components/ui/select.tsx` (ya existe, `@radix-ui/react-select` instalado). Mostrar iniciales y, en el filtro del inbox, la opción "Mis chats".
- Reemplazarlo en los seis lugares.

**Tradeoff**: el `Select` de Radix no abre el selector nativo del sistema. En celular cambia la experiencia.

**Impacto en pruebas**
- `e2e/conversations.spec.ts:86-91` usa `selectOption` sobre "Responsable del inbox".
- `e2e/imports.spec.ts:194, 218, 326` usa `selectOption` sobre "Responsable" y "Responsable de tareas".
- Hay que cambiarlos a click + selección de opción.

---

### 3. Todos los chats activos disponibles

**Estado actual**
- La lista pide 40 filas por página con `OFFSET` (`Conversations.tsx:142`). La API está en `20261110112004_koi_followups_inbox.sql`, acción `list` (líneas ~151-170).
- No hay conteo total. Solo Anterior / Siguiente, y al cambiar de filtro se vuelve a la página 1.
- Con esto el usuario no puede recorrer todos los chats activos de forma fluida.

**Propuesta**
- Paginación por cursor `(updated_at, id)` con scroll infinito (IntersectionObserver).
- El índice `koi_conversation_inbox (workspace_id, archived, updated_at desc, id)` ya cubre el caso sin filtros. Los filtros `pendingReply` y `unread` hacen recorridos más costosos (ver punto 4).

---

### 4. Cambiar de pestaña recarga todo y se ralentiza

**Causas (del código actual)**
1. `useChatResource` (`Conversations.tsx:71-94`) no conserva datos por filtro ni muestra estado de carga cuando cambia la clave. La lista vieja queda en pantalla y luego cambia. Eso se percibe como recarga. El commit `44a3853` quitó el debounce, así que la petición sale de inmediato, pero sigue sin caché.
2. No hay caché entre filtros. `@tanstack/react-query` no está en dependencias.
3. El backend calcula por cada fila `chat_row` (migración `20261110112004`, líneas ~246-262): `chat_instances` (unión de dos fuentes), conteo de no leídos, `chat_needs_reply` y un `lateral` del último mensaje.
4. Con `pendingReply=true`, `chat_needs_reply` se evalúa sobre todas las conversaciones antes del `LIMIT`.
5. Polling cada 3 s, o 20 s con realtime, sobre la lista activa (`Conversations.tsx:142`).
6. Realtime (`Conversations.tsx:119-137`): cada `UPDATE` en `koi_conversations` incrementa `inboxRevision` y recarga la lista. Solo recarga el chat activo si su fila cambió. El `SUBSCRIBED` sigue recargando todo una vez.

**Propuesta**
- Incorporar TanStack Query con `keepPreviousData`, `staleTime` y claves por filtro. Prefetch de los otros filtros al montar.
- Invalidar por clave, no con revisiones globales.
- Backend: calcular `chat_instances` una sola vez, quitar los conteos por fila (por ejemplo con `unread_count` mantenido al insertar mensajes) y resolver `pendingReply` con una columna materializada.
- Antes de decidir, medir con `EXPLAIN ANALYZE` la acción `list`.

---

### 5. "Abrir conversación" crea un chat fantasma en la bandeja

**Causa confirmada**: la acción `open` hace `INSERT ... ON CONFLICT DO UPDATE` (versión vigente en `20261110112004`, acción `open`, aprox. líneas 165-172; la migración `20261112013328` no la toca). Cada apertura crea la fila en `koi_conversations`, aunque no haya mensajes, y la lista la muestra.

Además, el `DO UPDATE` pone `archived=false` en silencio: abrir un chat archivado lo desarchiva.

**Opciones**
- **A (ya no recomendada):** no insertar al abrir y crear la fila en el primer envío. Con el envío optimista actual, la burbuja pendiente necesita un `conversationId` antes de enviar, así que habría que crear la conversación primero (un viaje extra). Choca con la respuesta inmediata que se busca.
- **B (recomendada):** mantener la fila, filtrar en `list` las conversaciones sin mensajes (`exists (select 1 from chat_messages ...)`) y quitar `archived=false` del `DO UPDATE`. Quedan filas sin mensajes en la base; se pueden limpiar con un job.

---

### 6. "Abrir conversación" desde la ficha recarga y no va directo

**Estado actual**
- `LeadProfile.tsx:73` enlaza a `/conversaciones?leadId=…`.
- `Conversations.tsx:172` y `StartChat` (`:181`) abren el diálogo con el lead preseleccionado. Hay que tocar "Abrir chat", luego `POST /conversations`, después `navigate`, y el inbox se vuelve a montar.
- La ruta `conversaciones` es `lazy` en `KoiApp.tsx`, con fallback "Abriendo conversaciones…".

**Propuesta**
- Al tocar el botón, buscar si el lead ya tiene conversación (endpoint nuevo `GET /conversations/by-lead/:leadId`, o reutilizar `list`). Si existe, navegar directo a `/conversaciones/:id` con el botón en estado de carga.
- Abrir el diálogo solo si el lead no tiene chat.
- Si el lead tiene chats en dos números, elegir el de mensajes más recientes (ver pregunta 3).
- Se resuelve junto con el punto 5 (opción B).

---

### 7. Loaders y skeletons en toda la plataforma

**Estado actual**
- `src/koi` usa texto plano en unos 25 lugares: "Cargando chats…" (`Conversations.tsx:160`), "Abriendo conversación…" (`:310`), "Cargando mensajes…", "Cargando tareas…", "Cargando campaña…", entre otros.
- `components/ui/skeleton.tsx` existe, pero `src/koi` no lo usa. Solo aparece en `sidebar.tsx` y `EstadoUi.tsx`.
- El único spinner está en `KoiApp.tsx`.
- Nuevo: el envío optimista muestra "Guardando…" y "Sin confirmar" (`Conversations.tsx:352`). El e2e busca esos textos.
- `src/pages/` y `src/features/` no están importados desde la app activa. Parecen código sin uso.

**Propuesta**
- Crear `Spinner` y skeletons por componente: `ChatRowSkeleton`, `MessagesSkeleton`, `CardSkeleton`, `StatSkeleton`, `ProfileSkeleton`.
- **Restricción:** mantener el texto junto al spinner en "Guardando…" y "Sin confirmar", o actualizar el e2e en el mismo cambio.
- Aplicarlos en: inbox, panel de chat, ficha (notas, historial, tareas), mensajes guardados, selector de mensajes, campañas, pipeline, seguimientos e inicio. También como fallback de `Suspense`.

---

### 8. Módulo de estadísticas con recharts de shadcn

**Estado actual**
- `recharts` no está en `package.json` ni en `package-lock.json`. No existe `components/ui/chart.tsx`.
- `KoiDashboard.tsx` muestra cuatro números de `/crm/summary`.

**Propuesta**
- `npm i recharts` (compatible con React 19) y el `chart.tsx` de shadcn.
- Backend: acción `stats` en `koi_crm_command`, con rango de fechas en `America/Argentina/Tucuman`: embudo por etapa, leads nuevos por día, mensajes enviados y recibidos por día, tasa de respuesta, campañas por estado, tareas vencidas.
- Revisar índices por fecha. `koi_leads` ya tiene índice por `stage, created_at`. Verificar `chat_messages` por `(workspace_id, sent_at)`.
- La migración `20261112013328` redefine `chat_message_json`. Cualquier cambio ahí debe partir de esa versión.

---

### 9. Iconos: conversaciones (bandeja) y mensajes guardados

**Estado actual**
- `components/layout/AppShell.tsx`: `NAV` (línea 13 "Mensajes guardados" con `BookOpen`; línea 14 "Conversaciones" con `MessageCircle`) y `BOTTOM` (línea 20 "Chats" con `MessageCircle`).
- `Conversations.tsx:168` (pie de la bandeja) y `:171` (estado vacío) usan `MessageCircle`.
- `Conversations.tsx:463` (botón "Elegir mensaje guardado" del compositor) usa `BookOpen`.

**Propuesta**
- Conversaciones y Chats: `Inbox`.
- Mensajes guardados: `MessageSquareText`, también en el compositor.
- Verificar los nombres exactos en `lucide-react` 1.27 antes de codificar.

---

### 10. Mejorar la UI de mensajes guardados y tener un visor tipo chat

**Estado actual**
- `SavedMessages.tsx` muestra tarjetas con el cuerpo completo (`max-h-64`) y acciones Copiar, Editar y Archivar.
- El único preview es `ChatMessagePreview.tsx`, dentro del selector del chat. Es un textarea editable, no una burbuja.

**Propuesta**
- Dos columnas: lista a la izquierda y visor a la derecha en desktop. En mobile, el visor abre en un sheet.
- Visor con burbuja real: reutilizar `conversations.css` (`koi-message-bubble`, `koi-message-meta`) y `chat-wallpaper.svg`. Mostrar hora y ticks de referencia.
- Selector "Vista previa con lead": buscar un lead y reemplazar `{{nombre}}`, `{{empresa}}`, etc. con `personalize()`. Sin lead, mostrar las variables resaltadas.
- En el editor, vista previa en vivo junto al textarea.
- Mantener las validaciones existentes: variables sin completar y 4000 caracteres.

---

### 11. Mensajes guardados escalables (muchos mensajes)

**Estado actual**
- Backend (`20261110114637_koi_saved_messages.sql`, `saved_message_command`, acción `messages`):
  - Búsqueda con `strpos(lower(title||' '||body||' '||category))` sobre toda la tabla, sin índice.
  - Conteo y página en dos consultas con `OFFSET`.
  - `categories` hace `distinct` sobre todos los mensajes, sin filtrar archivados ni contar.
- Picker (`SavedMessagePicker.tsx`): lista plana de títulos, sin filtro por categoría y sin cuerpo hasta elegir. `goToPage` vacía el resultado en cada página.
- `SavedMessages.tsx` vuelve a pedir datos al enfocar la ventana.

**Propuesta**
- Backend: índice GIN con `pg_trgm` sobre título y cuerpo (o `tsvector` en español); `categories` con conteo filtrado por archivados; `use_count` y `last_used_at` para ordenar por uso.
- Página: chips de categoría con conteo, tarjetas colapsadas que se expanden, búsqueda con debounce, "Cargar más" o cursor. Virtualizar solo si se superan unos cientos.
- Picker: mismo buscador y chips, preview tipo burbuja al seleccionar, `keepPreviousData` al paginar.

---

## Bug nuevo: envío optimista (`Conversations.tsx`, `ChatComposer`)

- **Causa**: el `catch` de `send` (línea ~424) llama `onUnconfirmed(attempt.current.key)` para cualquier error. Eso incluye 4xx de validación y `Contact unavailable` (409). En esos casos el mensaje nunca se envió, pero la burbuja queda como "Sin confirmar".
- **Burbuja huérfana**: si el usuario cambia el texto después de un fallo, el intento recibe otra clave. `updateOutgoing` solo reemplaza por clave, así que la burbuja anterior queda para siempre.
- **Propuesta**:
  - Marcar "Sin confirmar" solo ante fallas de red, timeout o 5xx.
  - Quitar la burbuja local ante 4xx.
  - Al cambiar el texto del borrador, limpiar las burbujas locales que no se confirmaron.

---

## Conflictos con cambios recientes

1. **Opción A del punto 5:** choca con el envío optimista (necesita `conversationId` antes de enviar). Se mantiene la opción B.
2. **Loaders (punto 7):** el e2e busca "Guardando…" y "Sin confirmar". Mantener el texto junto al spinner.
3. **E2E de envío:** `conversations.spec.ts` intercepta `**/api/conversations/*/messages` y espera `Guardando…`. Cambiar la URL, el método o el header `Idempotency-Key` rompe el test.
4. **E2E de selects (punto 2):** `selectOption` falla con `Select` de shadcn. Hay que reescribirlo en el mismo cambio.
5. **Migración `20261112013328`:** redefine `chat_message_json`. Cualquier cambio de backend que toque esa función debe partir de ella.
6. **Numeración:** las líneas de `Conversations.tsx` cambiaron con el commit `44a3853`. Las referencias de este reporte ya están actualizadas.

---

## Cambios de backend (migraciones nuevas)

1. `open` idempotente y sin desarchivar. Filtrar en `list` los chats sin mensajes (punto 5, opción B).
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

## Orden sugerido de implementación

1. **Bugs rápidos:** bug del envío optimista, punto 5 (opción B), punto 6, punto 9 (iconos) y punto 2 (`Select`). Actualizar el e2e en el mismo cambio.
2. **Rendimiento:** caché con TanStack Query, skeletons (punto 7, manteniendo textos) y lista por cursor (puntos 3 y 4). Medir antes y después.
3. **Menú contextual** (punto 1).
4. **Mensajes guardados:** visor tipo chat y escalabilidad (puntos 10 y 11).
5. **Estadísticas** (punto 8).

## Preguntas que necesito que definas

1. **Menú contextual:** ¿incluimos "Silenciar", "Bloquear" y "Eliminar chat"? Hoy no tienen backend. Recomiendo no incluir "Bloquear" hasta definir su alcance (hoy equivale a una baja) y que "Eliminar" sea borrado lógico.
2. **Chats sin mensajes:** confirmar opción B (ocultarlos en la lista).
3. **Lead con chats en dos números:** ¿cuál se abre por defecto? Propuesta: el de mensajes más recientes.
4. **Estadísticas:** ¿qué métricas y qué rango por defecto (7, 30 o 90 días)? ¿Pantalla nueva o parte de Inicio?
5. **Selector de responsable:** ¿aceptamos el `Select` de Radix aunque en celular no abra el selector nativo?

## Riesgos y pruebas

- E2E a actualizar: `e2e/conversations.spec.ts` (líneas 21, 86-91) e `e2e/imports.spec.ts` (líneas 194, 218, 326). Revisar el e2e de envío (intercepción de `/messages`).
- Pruebas de API para `open` idempotente y para `list` sin chats vacíos. `test/whatsapp.test.ts` y `test/crm.test.ts` cubren contratos cercanos.
- Medir `list` con `EXPLAIN ANALYZE` antes de reescribir `chat_row`.
- Aplicar migraciones en orden con `supabase migrations`.

## Otros hallazgos (no pedidos)

- `src/pages/` y `src/features/` parecen código muerto. Eliminarlos reduciría confusión.
- `koi-leads-api/.env.provision` y `koi-leads-api/.local-campaigns/*.env` están en la carpeta del proyecto. Verificar que estén en `.gitignore`. No revisé ese archivo.
- `koi-leads-api` tiene una carpeta `Claude outputs/` sin seguimiento en git. Conviene decidir si se versiona o se ignora.
