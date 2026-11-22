# Análisis del frontend · Performance y UI

**Koi Leads · koi-leads-web, rama `dev` · 22 de noviembre de 2026**

> **Estado:** las fases 1 a 5 están implementadas en `koi-leads-web` (commit `4e23f04` en `dev`, sin publicar). Faltan la fase 6 (datos reales de clientes, ingresos y gastos) y la fase 7 (Supabase, caché y Radix). El detalle está en la sección 8.

> **Decisiones del 22/11/2026:** se usa el símbolo Koi para la animación de entrada y las funciones futuras se reservan con placeholders «Próximamente». Hay un único usuario, el estudio. Las bandejas de Evolution e Inbox siguen separadas y Conversaciones pasa a llamarse «Outbound». Las conexiones se agrupan en una sección nueva, «Integraciones». Configuración queda para la cuenta, el tema y, más adelante, la PWA y la seguridad (passkeys o 2FA). La animación de entrada está aprobada. Inicio muestra Instagram de los últimos 7 días, la actividad de chats de las últimas 24 h y datos rápidos. Las secciones 4, 5 y 7 ya reflejan estas decisiones.

El análisis original no modificaba código; la implementación posterior se resume en la sección 8. Revisa la carga inicial, los estados de espera, el sidebar, Inicio y el peso del bundle. Las cifras de tamaño provienen de `vite build` y de los sourcemaps de esa compilación. No se midieron tiempos en un teléfono real ni con Lighthouse; conviene tomar esa línea base antes de empezar.

## Resumen

| Tema | Hallazgo principal | Impacto | Esfuerzo |
| --- | --- | --- | --- |
| Bundle inicial | Inicio importa `StatsHighlights` desde `Statistics.tsx` y arrastra `recharts` con Redux, d3 e immer a la carga de entrada | Alto | Bajo |
| Rutas | Ocho pantallas se cargan siempre, aunque el usuario no las abra | Medio | Bajo |
| Carga inicial | Tres pantallas distintas antes de ver la app: página en blanco, spinner con texto y logo con spinner | Alto en percepción | Medio |
| Estados de espera | 40 textos «Cargando…» o «Consultando…». Solo los chats, Estadísticas y Mensajes guardados tienen skeletons | Medio | Medio |
| Sidebar | 12 ítems sin grupos. Las bandejas, que se usan a diario, quedan al final. Hay íconos repetidos y nombres distintos entre escritorio y móvil. Las conexiones están repartidas en tres lugares | Medio | Bajo |
| Inicio | Muestra totales y conexiones. No muestra la actividad de los chats, Instagram ni el resumen del día | Alto | Medio a alto: ingresos y gastos no existen en la plataforma |

## 1. Performance

### 1.1 Composición del bundle

`vite build` genera dos archivos grandes que se descargan siempre:

| Archivo | Minificado | Gzip | Contenido principal |
| --- | --- | --- | --- |
| `index-*.js` | 968 kB | 288 kB | Ver desglose abajo |
| `createLucideIcon-*.js` | 251 kB | 68 kB | Supabase y tailwind-merge. El nombre engaña: los íconos de lucide pesan 6 kB |
| `index-*.css` | 127 kB | — | Tailwind y estilos de Koi |

Desglose de `index-*.js` según el sourcemap (tamaño de fuente antes de minificar):

| Paquete | Fuente | Por qué está en la carga inicial |
| --- | --- | --- |
| `recharts` | 831 kB | `KoiDashboard.tsx:13` importa `StatsHighlights` de `Statistics.tsx`, que importa recharts en la línea 4 |
| `react-dom` | 525 kB | Necesario |
| `react-router` | 363 kB | Necesario |
| `@reduxjs/toolkit`, `react-redux`, `immer` | 165 kB | Dependencias internas de recharts |
| d3 (`shape`, `array`, `scale` y otros) | más de 120 kB | Dependencias de recharts |
| `es-toolkit`, `decimal.js-light` | 121 kB | Dependencias de recharts |

El build lo avisa: `[INEFFECTIVE_DYNAMIC_IMPORT] Statistics.tsx is dynamically imported by KoiApp.tsx but also statically imported by KoiDashboard.tsx`. El `lazy()` de Estadísticas no tiene efecto. Cada ingreso descarga el motor de gráficos aunque Inicio no dibuje ningún gráfico: `StatsHighlights` solo muestra cuatro números.

**Propuesta P1 · Sacar los gráficos de la carga inicial.** Mover `StatsHighlights`, `useStats` y `daysPeriod` a un módulo sin recharts, por ejemplo `src/koi/stats-summary.tsx`. Inicio importa ese módulo y `Statistics.tsx` queda realmente diferido. Es el cambio con mejor relación impacto/esfuerzo. Se espera una reducción grande del chunk de entrada. El número exacto hay que medirlo después del cambio.

### 1.2 Rutas que se cargan siempre

`KoiApp.tsx` usa `lazy()` solo para Mensajes guardados, Seguimientos, Conexiones de Inbox, Inbox, Conversaciones y Estadísticas. Estas pantallas se importan de forma estática:

`KoiDashboard`, `CrmLeads` (Leads y Pipeline), `LeadProfile`, `LeadLists` (incluye el importador), `Campaigns` (incluye editor y selector de destinatarios), `WhatsAppConnection`, `UserProfile` y `WorkspaceSettings`.

**Propuesta P2 · Una ruta, un chunk.** Convertir esas rutas a `lazy()`. Cada `Suspense` usa el skeleton de su pantalla (sección 3). Para que la navegación siga siendo instantánea, precargar el chunk al pasar el cursor o tocar el ítem del sidebar. Si sobra ancho de banda, precargar también las rutas frecuentes (Chats, Inbox, Leads) con `requestIdleCallback`.

### 1.3 Supabase

El chunk compartido contiene el cliente completo de `@supabase/supabase-js`. Eso incluye storage (106 kB), postgrest (104 kB), functions (17 kB) e `iceberg-js` (17 kB). Por lo revisado, la web usa `koiAuth` solo para sesión (`auth-js`) y para Realtime (`realtime-js`). Todo lo demás pasa por la API propia.

**Propuesta P3 · Evaluar un cliente reducido.** Crear la sesión con `@supabase/auth-js` y el canal con `@supabase/realtime-js` directamente. Antes hay que confirmar que ningún módulo usa `from()`, `storage` o `functions`. Este cambio es de prioridad media: el ahorro es real, pero toca autenticación y conviene hacerlo con pruebas de sesión y reconexión.

### 1.4 Peticiones repetidas o costosas

| Patrón | Dónde | Propuesta |
| --- | --- | --- |
| `/crm/options` se pide de nuevo en cada pantalla | `KoiDashboard`, `CrmLeads`, `LeadProfile`, `Followups`, `Conversations`, `Inbox` | Caché compartida por workspace con revalidación en segundo plano, o un `OptionsProvider` en el shell |
| Inicio consulta `/integrations/evolution/instances` cada 30 s | `KoiDashboard.tsx:23`. El endpoint llama a Evolution por cada instancia, con timeout de 60 s | En Inicio, mostrar solo si hay incidencia. Usar el estado guardado o aumentar el intervalo. El detalle queda en la pantalla de WhatsApp |
| El contador de chats sin leer del celular lista `/conversations?unread=true` cada 30 s | `AppShell.tsx:73` | Pedir un endpoint de conteo, como ya existe `/inbox/unread-count` (cambio de API, separado) |
| Inicio vuelve a pedir los cuatro recursos juntos cada 30 s | `KoiDashboard.tsx:29` | Que cada bloque refresque por su cuenta. Las fallas parciales se muestran en su bloque, no en un aviso único |

### 1.5 Otros puntos

- **Radix duplicado.** `Sheet` usa `@radix-ui/react-dialog` (DismissableLayer 1.1.19) y `Select` usa el paquete `radix-ui` (1.2.1). Con dos pilas de capas, un `Select` dentro de un `Sheet` o `Dialog` puede dejar el `body` con `pointer-events:none` y la página sin responder a clics. Pasó durante la entrega de chats móviles y se evitó sin anidar selectores. Unificar los componentes de `src/components/ui` sobre `radix-ui` elimina el riesgo y una copia de código.
- **Tema oscuro.** `next-themes` aplica la clase `dark` cuando ya cargó el JavaScript. Mientras tanto la página se ve clara. El splash de la sección 2 resuelve esto.
- **Tipografía.** Roboto variable con `font-display: swap` es correcto. Un `<link rel="preload">` de la fuente woff2 en `index.html` evita el cambio de tipografía en el primer render.

## 2. Carga inicial de ingreso

### Situación actual

1. **Antes del JavaScript:** `index.html` tiene un `<div id="root">` vacío. Se ve una página en blanco mientras se descargan unos 1,3 MB de JS. Con tema oscuro también se ve blanco.
2. **Sesión:** `KoiApp.tsx:42` muestra un spinner y el texto «Recuperando tu sesión…» sobre fondo liso.
3. **Espacio:** `KoiApp.tsx:59` cambia a otra composición: logo de 64 px, el título «Abriendo tu espacio…» y otro spinner.
4. **Ruta:** cada `Suspense` muestra un párrafo como «Abriendo Inbox…» antes de la pantalla final.

Son cuatro estados con diseños distintos. Cada transición mueve la vista y ninguna tiene la identidad del login: el coral de marca, «Todo empieza con una conversación» y el símbolo Koi.

### Propuesta P4 · Splash con identidad y continuidad

- **Splash dentro de `index.html`:** HTML y CSS en línea que se pintan antes de que llegue el JS, con un script mínimo que lee `koi-theme` de `localStorage` y aplica claro u oscuro sin parpadeo. Composición: símbolo Koi centrado y, debajo, «Koi Leads». Alrededor, una animación de ondas concéntricas en el coral `--primary`, como el pez sobre el agua y en línea con la idea de conversación. Abajo, una línea de progreso fina.
- **Un componente `KoiSplash`:** React reutiliza el mismo marcado para las fases de sesión y espacio, así la animación no se reinicia ni salta. Solo cambia el texto: «Recuperando tu sesión» y luego «Abriendo Estudio Koi», con el nombre del workspace. Los errores y «Volver a intentar» usan la misma composición.
- **Salida hacia la app:** al obtener el workspace, el splash se desvanece y aparece el esqueleto del shell (sidebar y barra superior) con el skeleton de la ruta, en lugar de un texto.
- **Accesibilidad:** `role="status"` y texto visible para lectores de pantalla. Con `prefers-reduced-motion`, ondas estáticas y sin progreso animado. No agregar una espera mínima artificial.
- **Logo elegido: el símbolo solo** (sin «Koi Studio»). Es el mismo archivo que ya usa la app, `public/brand/koi-symbol.png`. Motivos:
  - es cuadrado y se lee bien entre 64 y 120 px;
  - las ondas lo rodean de forma pareja;
  - es el mismo ícono del favicon y del futuro ícono de la PWA.

  El nombre va debajo como texto real, «Koi Leads», con la tipografía de la app: así se escala bien, respeta el tema y se lee con lector de pantalla. El logotipo completo («Koi Studio», imagen 1) queda para el login y para el encabezado del sidebar expandido.
- **Preparación del recurso:**
  - El PNG mide 1080×1080 y se muestra a menos de 120 px. Conviene exportar versiones de 192 y 512 px, que también sirven como íconos de la PWA, y precargar la de 192 px desde `index.html`.
  - El logotipo completo tiene mucho margen transparente (el contenido ocupa aproximadamente de y=340 a y=740) y hay que recortarlo antes de usarlo.
  - `public/favicon.svg` es un ícono genérico que `index.html` no usa; se puede eliminar o reemplazar.
- **Animación aprobada, con el PNG:**
  1. **Entrada:** el símbolo aparece en unos 400 ms, de opacidad 0 y escala 0,92 a su tamaño final.
  2. **Mientras carga:** tres anillos concéntricos en el coral de marca se expanden y se desvanecen en ciclo de 1,8 s, desfasados, como ondas en el agua.
  3. **Salida:** fundido hacia el esqueleto del shell.
- **Mejora posterior, con SVG:** con el archivo vectorial del símbolo (exportado desde el original de diseño, no calcado del PNG), el trazo principal puede dibujarse como el recorrido de un pez y el punto puede flotar levemente. No bloquea la primera versión.

## 3. Skeleton loaders

### Base disponible

Ya existen `components/ui/skeleton.tsx` y `koi/chat/ChatSkeletons.tsx`. Hoy los usan los chats, Estadísticas, Mensajes guardados, el selector de mensajes y las acciones de contacto de Inbox.

### Propuesta P5 · Primitivas compartidas

Crear `src/components/skeletons.tsx` con piezas que repliquen la geometría real de cada pantalla, para que el contenido no salte al llegar:

| Primitiva | Uso |
| --- | --- |
| `PageSkeleton` | Encabezado de página (título, descripción y acciones) más un área de contenido |
| `MetricCardsSkeleton` | Tarjetas de indicadores de Inicio y Estadísticas |
| `TableSkeleton rows cols` | Leads, contactos de una base, destinatarios de campaña |
| `ListSkeleton` | Seguimientos, campañas, actividad, conexiones |
| `BoardSkeleton` | Columnas del Pipeline |
| `ProfileSkeleton` | Ficha del lead (cabecera, pestañas, notas y tareas) |
| `ShellSkeleton` | Sidebar y barra superior durante la salida del splash |

Reglas:

- Mantener `role="status"` con texto para lectores de pantalla.
- Mostrar el skeleton después de unos 150 ms para evitar destellos en respuestas rápidas.
- En las recargas automáticas, conservar los datos anteriores en vez de volver al skeleton. Por ejemplo, las tarjetas de Inicio hoy muestran «…» mientras cargan.

### Inventario por pantalla

| Pantalla | Estado actual | Skeleton propuesto |
| --- | --- | --- |
| Rutas diferidas (`KoiApp.tsx:63–76`) | Párrafos «Cargando…» y «Abriendo…» | `PageSkeleton` con el contenido de cada ruta |
| Inicio (`KoiDashboard.tsx:37, 40, 41`) | «…» en tarjetas, «Consultando conexiones…», «Cargando…» | Skeleton por bloque, según el nuevo Inicio de la sección 5 |
| Leads y Contactos (`CrmLeads.tsx:130`) | «Cargando…» | `TableSkeleton` con columnas reales y filtros visibles |
| Pipeline (`CrmLeads` en modo tablero) | Mismo texto | `BoardSkeleton` con una columna por etapa |
| Ficha del lead (`LeadProfile.tsx:68, 93, 96, 99`) | Cuatro textos distintos | `ProfileSkeleton` y listas por pestaña |
| Bases (`LeadLists.tsx:46, 54`) y contactos de una base (`ListContacts.tsx:40`) | Textos | Grilla de tarjetas y `TableSkeleton` |
| Campañas (`Campaigns.tsx:37, 74, 182`), editor (`CampaignEditor.tsx:42`) y destinatarios (`CampaignRecipientPicker.tsx:133`) | Textos | Lista, detalle con progreso y actividad |
| Seguimientos (`Followups.tsx:41`) | «Cargando tareas…» | `ListSkeleton` con fecha, lead y responsable |
| WhatsApp (`WhatsAppConnection.tsx:86`) y Conexiones de Inbox (`InboxConnections.tsx:61`) | «Consultando conexiones…» | Tarjeta de conexión con estado y acciones |
| Chats e Inbox | Ya tienen skeletons | Sin cambios |

Las esperas puntuales y breves («Buscando…», «Cargando audio…», «Abriendo archivo…») pueden seguir con texto o un spinner chico.

## 4. Sidebar, Integraciones y Configuración

### Situación actual (`AppShell.tsx:10–17`)

El orden actual es Inicio, Leads, Bases, Seguimientos, Pipeline, Campañas, Mensajes guardados, Estadísticas, Inbox, Conversaciones, WhatsApp y Configuración.

- Son 12 ítems planos, sin grupos. Las dos bandejas, el trabajo diario, quedan en las posiciones 9 y 10. La barra móvil, en cambio, las pone primero.
- Inbox y Mensajes guardados usan el mismo ícono (`MessageSquareText`). Conversaciones usa el ícono `Inbox`, pero «Inbox» es otra sección.
- La misma sección se llama «Conversaciones» en escritorio y «Chats» en el celular.
- Solo Inbox muestra contador de no leídos en el sidebar.
- Las conexiones están repartidas:
  - Evolution está en `/whatsapp`, en el menú principal.
  - Zernio (WhatsApp oficial e Instagram) está en `/configuracion/conexiones`.
  - La autorización de estadísticas de WhatsApp está dentro de Estadísticas (`ChannelStatistics.tsx:104`).
- Configuración (`WorkspaceSettings`) casi solo tiene enlaces a esas conexiones. El tema está en el menú de usuario y «Mi perfil» es una ruta aparte (`/perfil`).
- La página «no encontrada» envía a Bases en lugar de Inicio.

### Propuesta P6 · Menú agrupado

| Grupo | Ítems | Nota |
| --- | --- | --- |
| — | Inicio | |
| Bandejas | **Outbound** (con contador), **Inbox** (con contador) | Siguen separadas. Outbound es la línea propia por Evolution: prospección, campañas y seguimiento manual. Inbox reúne WhatsApp oficial e Instagram por Zernio. Íconos distintos, por ejemplo `Send` o `PhoneOutgoing` para Outbound e `Inbox` para Inbox |
| Clientes | Leads, Pipeline, Seguimientos (con contador de vencidos), Bases | |
| Difusión | Campañas, Mensajes guardados | Mensajes guardados con `BookOpen`, el mismo ícono del compositor |
| Análisis | Estadísticas | |
| Pie del sidebar | Integraciones, Configuración | Integraciones con un indicador cuando alguna conexión falla |

**Nombre «Outbound».**
- Se usa igual en el sidebar, la barra móvil, el título de la página y el texto de la pantalla vacía («Conversaciones de WhatsApp» pasa a «Outbound · WhatsApp»).
- La ruta `/conversaciones` puede quedar como está o pasar a `/outbound` con redirección. Si cambia, hay que actualizar los enlaces internos («Abrir conversación», `OpenLeadChat`, acciones de contacto de Inbox) y los recorridos e2e.
- La barra inferior del celular queda Outbound, Inbox, Inicio, Leads y Menú.

### Propuesta P6b · Sección Integraciones

Ruta nueva `/integraciones`, con una tarjeta por proveedor y estado visible: conectado, desconectado o con error, y la última comprobación.

| Integración | Contenido actual que se mueve | Origen |
| --- | --- | --- |
| WhatsApp · Evolution API | Líneas, QR, reconexión, número de campañas | `WhatsAppConnection.tsx` (`/whatsapp`) |
| WhatsApp oficial · Zernio | Vinculación, reconexión, recepción e historial fallidos | `InboxConnections.tsx` (`/configuracion/conexiones`) |
| Instagram · Zernio | Lo mismo para la cuenta de Instagram | `InboxConnections.tsx` |
| Estadísticas de WhatsApp | Autorización para métricas | `ChannelStatistics.tsx:104` |
| Próximas | Espacio para las integraciones que se sumen, por ejemplo la fuente de ingresos y gastos (sección 5) | — |

- **Estructura:** cada integración abre su detalle en `/integraciones/<proveedor>`. `/whatsapp` y `/configuracion/conexiones` redirigen ahí para no romper enlaces guardados.
- **Alertas:** las de Inicio y la barra de cada bandeja enlazan al detalle de la integración afectada.

### Propuesta P6c · Configuración

Configuración queda para la cuenta y la plataforma:

- **Cuenta:** nombre del estudio, correo y contraseña. Une el contenido de `/perfil`, que pasa a redirigir a Configuración.
- **Apariencia:** tema claro, oscuro o del sistema. Puede seguir también como atajo en el menú de usuario.
- **Aplicación (PWA):** instalación, notificaciones y comportamiento sin conexión.
- **Seguridad:** passkeys, 2FA y sesiones abiertas.

Las secciones de Aplicación y Seguridad se muestran desde ya como bloques «Próximamente» (ver «Funciones futuras» en la sección 5), así la estructura de Configuración no cambia cuando lleguen.

Con un único usuario, no hace falta mostrar el rol («Administrador / Operador») en Configuración ni en el menú de usuario. Los filtros por responsable y la asignación de chats pueden quedar como están, porque no molestan y sirven si se suma alguien. Simplificarlos es opcional.

## 5. Inicio

### Situación actual (`KoiDashboard.tsx`)

| Bloque | Observación |
| --- | --- |
| Botón «Actualizar» | La página ya se recarga sola cada 30 s |
| Cuatro tarjetas: Leads registrados, Leads contactados, Campañas en curso, WhatsApp conectados | El total de leads no orienta ninguna acción. «Contactados» se repite abajo con otro período |
| «Últimos 30 días»: contactados, interesados o ganados, perdidos, errores | Duplica «contactados». Trae recharts a la carga inicial (sección 1.1) |
| Acciones rápidas | Útiles. «Gestionar WhatsApp» pasa a Integraciones |
| Conexiones de WhatsApp | Lista completa aunque todo funcione, con la consulta costosa cada 30 s |
| «Actividad reciente» | Solo muestra importaciones, que son ocasionales |
| Texto fijo sobre límites de campañas | Corresponde a Campañas, no a Inicio |

### Propuesta P7 · Nuevo Inicio

Orden pensado para el celular; en escritorio, en dos columnas: datos rápidos y chats a la izquierda, Instagram y tareas a la derecha.

1. **Encabezado:** saludo, fecha y una línea de estado: «Integraciones al día» o la incidencia concreta, con enlace a Integraciones.
2. **Datos rápidos:** cuatro tarjetas.

   | Tarjeta | Contenido | Fuente | Estado |
   | --- | --- | --- | --- |
   | Clientes activos | Cantidad y variación del mes | Hoy no existe el concepto «cliente». Lo más cercano son los leads en etapa «Ganado» (`contracts/crm.ts`) | **Requiere definición.** ¿Cliente activo es un lead ganado, uno con producto contratado vigente (Cubiko, Zyro, Toki, Estudio) o uno con pagos en el período? |
   | Tareas de hoy | Pendientes de hoy, vencidas y completadas hoy | `/crm/tasks?view=today` y `view=overdue`, que ya existen | Disponible. Para completadas hoy conviene un conteo en la API |
   | Ingresos · 30 días | Total y variación contra los 30 días anteriores | **No existe** en la API ni en la base | **Requiere desarrollo** (ver abajo) |
   | Gastos · 30 días | Total, variación y resultado neto | **No existe** | **Requiere desarrollo** |

3. **Tareas del día:** las tareas de hoy y las vencidas, ordenadas por hora. Cada una tiene lead, acción para completarla y acceso al chat o la ficha. Debajo, enlace a Seguimientos.
4. **Chats · últimas 24 h:** dos bloques separados, uno para Outbound (Evolution) y otro para Inbox (Zernio, con WhatsApp oficial e Instagram distinguidos).
   - **Indicadores:** conversaciones con actividad, mensajes recibidos y enviados, chats sin leer y por responder.
   - **Lista:** las cinco conversaciones más recientes, con acceso directo.
   - **Fuente:** los índices actuales (`/conversations/index`, `/inbox/index`) tienen la fecha del último mensaje, pero traen todas las conversaciones. Sirven para un primer paso del lado del cliente, aunque cargarlos completos en Inicio es pesado. Lo recomendable es un endpoint de resumen por canal y período, con conteos de mensajes enviados y recibidos, que hoy no se pueden obtener sin leer cada historial.
5. **Instagram · últimos 7 días:** alcance, visualizaciones, interacciones, seguidores y su variación.
   - **Fuente:** `/crm/stats/instagram` con `from` y `to` de 7 días. Ya existe con caché en la API (`statistics/service.ts:84`), así que no hace falta backend nuevo.
   - **Presentación:** números con una mini tendencia en SVG simple, sin recharts, para no volver a cargar los gráficos en Inicio. Si la integración no está conectada, el bloque invita a conectarla en Integraciones.
6. **Alertas, solo si existen:** integración caída, errores de envío recientes, importación en borrador pendiente.
7. **Acciones rápidas:** Nuevo lead, Nueva campaña, Nueva tarea, Importar leads.

**Se quita de Inicio:**
- Leads registrados: pasa al encabezado de Leads.
- La lista de conexiones: aparece solo como alerta.
- La actividad de importaciones: solo los borradores, como alerta.
- El bloque «Últimos 30 días» del CRM: queda en Estadísticas.
- El texto de límites: pasa a Campañas.
- El botón «Actualizar».

**Carga:** cada bloque tiene su skeleton, su error y su propio ritmo de actualización. Si Instagram tarda o falla, eso no frena las tareas ni los chats.

### Funciones futuras dentro de la UI

Clientes activos, ingresos, gastos y resultado se suman más adelante. La interfaz los reserva desde ahora para que Inicio no cambie de estructura cuando lleguen.

| Lugar | Elemento reservado | Cómo se ve mientras tanto |
| --- | --- | --- |
| Inicio · Datos rápidos | Clientes activos, Ingresos 30 días, Gastos 30 días, Resultado 30 días | Tarjeta con el mismo tamaño, borde punteado, título real, valor «—», etiqueta «Próximamente» y una línea con lo que va a mostrar. Ejemplo: «Cobros registrados en los últimos 30 días y variación contra el período anterior» |
| Inicio · Datos rápidos | Tareas de hoy | Funciona desde la primera versión con datos reales |
| Integraciones | Finanzas (fuente de ingresos y gastos) | Tarjeta «Próximamente» junto a Evolution y Zernio |
| Configuración | Aplicación (PWA), Seguridad (passkeys y 2FA) | Secciones con título, descripción breve y etiqueta «Próximamente», sin controles activos |

**Criterio de placeholder:**
- No mostrar cifras inventadas como si fueran reales: una tarjeta de ingresos con un monto de ejemplo se confunde fácilmente con un dato. Si se quiere ver cómo quedará con números (para una demo o para validar el diseño), usar valores marcados «Ejemplo» con menor contraste, activables solo en desarrollo.
- Las tarjetas futuras usan la misma geometría y el mismo skeleton que las reales. Al habilitarlas no se mueve nada.
- Para lectores de pantalla, cada tarjeta anuncia «Clientes activos, próximamente».

**Contrato preparado:** el tipo del resumen de Inicio declara desde ya los campos opcionales `activeClients`, `income30d`, `expenses30d` y `net30d` (monto, moneda y variación). La tarjeta muestra el dato real cuando la API lo devuelve y el estado «Próximamente» cuando falta. Habilitar cada función será un cambio de API sin rediseño de la web.

### Ingresos y gastos

La plataforma no registra movimientos económicos. Hay tres caminos:

| Opción | Qué implica | Cuándo conviene |
| --- | --- | --- |
| Registro propio | Módulo «Finanzas»: tabla de movimientos (fecha, tipo, monto, moneda, categoría, cliente o lead, nota), carga manual y API. Inicio muestra los totales | Si el estudio quiere centralizar todo en Koi y carga pocos movimientos por mes |
| Integración | Conector en Integraciones con la fuente real: pasarela de cobro, banco o sistema contable. Koi guarda los totales sincronizados | Si los movimientos ya están en otro sistema y se quiere evitar doble carga |
| Planilla | Lectura de una hoja de cálculo con formato fijo | Paso intermedio rápido, más frágil |

En cualquier caso: definir moneda (ARS, USD o ambas, con o sin conversión) y si el resultado neto se muestra en Inicio. Mientras tanto, Inicio puede reservar el lugar con un estado vacío que explique que falta configurar la fuente.

## 6. Orden sugerido

| Fase | Contenido | Verificación | Estado |
| --- | --- | --- | --- |
| 1 | P1 (gráficos fuera de Inicio), P2 (rutas diferidas), preload de fuente | Tamaño de chunks antes y después. LCP en móvil con red lenta simulada. Desaparece el aviso de import dinámico inefectivo | Implementada, salvo el preload de fuente |
| 2 | P4 (splash aprobado: `index.html` y `KoiSplash`), `ShellSkeleton` | Sin pantalla blanca ni destello claro en tema oscuro. Movimiento reducido respetado | Implementada, sin `ShellSkeleton` |
| 3 | P5 (primitivas y skeletons por pantalla) | Capturas de cada pantalla con red lenta. Sin saltos de diseño al llegar los datos | Implementada |
| 4 | P6, P6b y P6c (menú agrupado, Outbound, Integraciones, Configuración) con redirecciones | Recorridos e2e de navegación y enlaces antiguos. Sidebar colapsado y menú móvil | Implementada |
| 5 | P7, primera parte: Instagram 7 días, tareas del día y chats 24 h, con las tarjetas «Próximamente» de clientes, ingresos, gastos y resultado ya ubicadas. Placeholders de PWA y Seguridad en Configuración, y de Finanzas en Integraciones | Recorrido de Inicio con datos sintéticos, fallas parciales y celular. Los placeholders se anuncian como «próximamente» | Implementada |
| 6 | P7, segunda parte: reemplazar los placeholders de clientes activos, ingresos, gastos y resultado por datos reales. Requiere API y migración | Pruebas de API y de la carga o sincronización elegida. Las tarjetas pasan de «Próximamente» a datos sin cambios de diseño | Pendiente |
| 7 | P3 (cliente Supabase reducido), caché de `/crm/options`, Radix unificado | Pruebas de sesión, reconexión de Realtime y selectores dentro de diálogos | Pendiente |

## 7. Decisiones

**Tomadas el 22/11/2026**

- Hay un único usuario: el estudio.
- Outbound (Evolution) e Inbox (Zernio) siguen siendo bandejas separadas. Conversaciones pasa a llamarse «Outbound».
- Todas las conexiones, actuales y futuras, van en «Integraciones».
- Configuración tiene la cuenta, el tema y, más adelante, la PWA y la seguridad (passkeys o 2FA).
- Animación de entrada aprobada: ondas alrededor del símbolo Koi. Se usa el símbolo solo (`koi-symbol.png`) y el logotipo completo queda para el login y el sidebar.
- Clientes activos, ingresos, gastos y resultado se agregan más adelante, pero la UI los reserva desde ahora con placeholders «Próximamente».
- Inicio: Instagram de los últimos 7 días, chats de las últimas 24 h por proveedor, clientes activos, tareas del día, e ingresos y gastos de 30 días.

**Pendientes**

- Confirmar el nombre «Outbound» en la interfaz y si la ruta pasa a `/outbound`.
- Definir «cliente activo», la fuente de ingresos y gastos, y la moneda, cuando se implementen. No bloquea la UI.
- Opcional: exportar el símbolo Koi en SVG desde el archivo de diseño para la versión con trazo animado.

## 8. Implementación (22/11/2026)

Commit `4e23f04` en `koi-leads-web`, rama `dev`. Validación: `npm run verify` (42 pruebas unitarias, tipos, lint y build) y 35 recorridos de Playwright con la API de pruebas. No se midieron tiempos de carga en un teléfono real.

### Resultado medido

| Archivo de entrada | Antes | Después |
| --- | --- | --- |
| `index-*.js` | 968 kB (288 kB gzip) | 374 kB (118 kB gzip) |
| `recharts` y dependencias | En la carga inicial | Solo en el chunk de Estadísticas (418 kB, que se descarga al abrirla) |
| Aviso `INEFFECTIVE_DYNAMIC_IMPORT` | Presente | Ya no aparece |

### Qué se hizo y dónde

| Tema | Archivos | Notas |
| --- | --- | --- |
| Rutas diferidas y precarga | `src/koi/routes.ts`, `src/koi/KoiApp.tsx` | Una pantalla, un chunk. Se precarga al pasar el cursor, enfocar o tocar el menú; Outbound, Inbox, Leads y Seguimientos se precargan en reposo |
| Estadísticas sin gráficos en Inicio | `src/koi/stats-api.ts` | `useStats` y `daysPeriod` salieron de `Statistics.tsx`. `StatsHighlights` se eliminó |
| Splash de entrada | `index.html`, `src/koi/boot.ts` | Símbolo Koi con tres ondas coral y barra de progreso. El tema guardado se aplica antes del primer pintado. La misma animación sigue durante la sesión y la apertura del espacio. Los errores usan la misma composición, sin movimiento |
| Íconos | `public/brand/koi-symbol-192.png`, `koi-symbol-512.png` | Favicon, ícono de pantalla de inicio y futura PWA |
| Skeletons | `src/components/skeletons.tsx` | Primitivas con aparición diferida de 150 ms. Se aplican en rutas, Leads, Pipeline, ficha, Bases, contactos de una base, Campañas, Seguimientos e Integraciones |
| Menú | `src/components/layout/AppShell.tsx`, `src/components/nav-user.tsx` | Grupos Bandejas, Clientes, Difusión y Análisis; Integraciones y Configuración al pie. Contadores de no leídos en Outbound e Inbox. El menú de usuario lleva a Configuración |
| Integraciones | `src/koi/Integrations.tsx` | Estado de Evolution, WhatsApp oficial e Instagram por Zernio; acceso a Meta Ads; Finanzas como «Próximamente». Detalles en `/integraciones/evolution` y `/integraciones/zernio` |
| Configuración | `src/koi/Settings.tsx` | Cuenta, apariencia y seguridad con cambio de contraseña. Passkeys, 2FA e instalación, notificaciones y uso sin conexión como «Próximamente». Reemplaza `UserProfile.tsx` y la Configuración anterior |
| Inicio | `src/koi/Home.tsx`, `src/koi/home-data.ts` | Reemplaza `KoiDashboard.tsx`. Datos rápidos (tareas reales; clientes, ingresos y gastos «Próximamente»), chats de 24 h por proveedor, tareas del día con acción de completar, Instagram de 7 días y alerta de integraciones caídas |
| Placeholders | `src/components/coming-soon.tsx`, tipo `BusinessSummary` | Las tarjetas futuras ya tienen su lugar y su contrato. Cuando la API devuelva `activeClients`, `income30d`, `expenses30d` o `net30d`, muestran el dato sin cambios de diseño |

### Rutas

| Ruta anterior | Ahora |
| --- | --- |
| `/whatsapp`, `/?view=whatsapp` | Redirige a `/integraciones/evolution` |
| `/configuracion/conexiones` | Redirige a `/integraciones/zernio` y conserva la query. El retorno de autorización de Zernio (`src/inbox/service.ts:47` de este repositorio) sigue funcionando sin cambios en la API |
| `/perfil` | Redirige a `/configuracion` |
| `/conversaciones` | Sin cambios. La interfaz la muestra como «Outbound» |

### Diferencias con la propuesta

- **Chats de 24 h:** Inicio recorre el índice completo de cada proveedor (páginas de 200, ordenadas por id). Funciona con el volumen actual. Los mensajes enviados y recibidos no se cuentan porque requieren leer cada historial; queda pendiente un endpoint de resumen.
- **Instagram:** se muestran las cifras del período sin mini tendencia, porque la API no devuelve una serie diaria.
- **Tareas de hoy:** se muestran pendientes y vencidas. «Completadas hoy» necesita un conteo en la API.
- **No implementado todavía:** preload de la tipografía (la ruta del archivo cambia en cada build), `ShellSkeleton` (el splash cubre esa espera), contador de vencidas en Seguimientos e indicador de falla en el ítem Integraciones del menú.

### Próximos pasos

1. Medir LCP y tiempo hasta interacción en un teléfono real, con y sin caché.
2. Endpoint de resumen de chats por canal y período en la API, para aliviar Inicio y sumar mensajes enviados y recibidos.
3. Fase 6: definir cliente activo y la fuente de ingresos y gastos, y devolver `BusinessSummary` desde la API.
4. Fase 7: cliente Supabase reducido, caché compartida de `/crm/options` y Radix unificado.

