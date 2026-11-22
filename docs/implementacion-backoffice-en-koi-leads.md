# Integración de Backoffice en Koi Leads

Plan de implementación · 22 de noviembre de 2026

El objetivo es que el equipo pueda pasar de un mensaje entrante a su contacto, identificar al cliente y al proyecto, seguir la entrega y consultar el cobro desde el mismo espacio de trabajo. Cada etapa termina con un recorrido comprobable por el equipo. La numeración indica el orden recomendado de publicación.

## Punto de partida y modelo propuesto

Koi Leads ya vincula las conversaciones de Zernio con leads del CRM. La tabla y el Kanban consultan esos leads. El acceso al chat desde la ficha depende del teléfono y busca conversaciones de Evolution. El Kanban guarda una etapa por contacto y «Producto / Estudio» ofrece una clasificación fija. Backoffice aporta la gestión posterior a la venta y admite proyectos internos. Estas conclusiones proceden de los repositorios y del recorrido visual de Koi Office. Los volúmenes y las correspondencias se verificarán al preparar la migración.

| Concepto | Relación propuesta |
|---|---|
| Lead o contacto | Conserva su identificador, conversaciones, bases, consentimiento, notas e historial del pipeline al pasar a cliente. |
| Cliente | Persona o empresa con estado operativo y responsable comercial. Admite varios contactos, proyectos y productos contratados, además de clientes históricos sin contacto identificado. |
| Proyecto o SaaS | Puede ser un encargo de cliente o propiedad del estudio. Un SaaS mantiene una ficha de producto y admite varios clientes con relaciones comerciales independientes. |
| Interés y contratación | El vínculo lead–proyecto registra qué se está evaluando. La relación cliente–proyecto registra lo contratado. Ambas conservan origen, fecha y responsable. |
| Espacio de trabajo | Delimita datos, vínculos y permisos. Las operaciones validan el espacio de ambos extremos de cada relación. |

## UI de referencia y puntos de integración

Revisión del 22 de noviembre sobre la rama local `dev` de Koi Leads Web. Se comparó `21d6d83..4e23f04`. Los commits `81ff49e` y `94855e4` actualizaron la experiencia de chat y `4e23f04` reorganizó el panel. La referencia visual para las entregas es esta versión de Koi Leads. De Backoffice se trasladan los datos, las reglas y los recorridos de trabajo.

| Superficie verificada | Cambio observado | Aplicación al plan |
|---|---|---|
| Navegación y arranque | `AppShell` agrupa Bandejas, Clientes, Difusión y Análisis. Integraciones y Configuración están al pie. La barra móvil tiene Outbound, Inbox, Inicio, Leads y menú. El arranque usa el símbolo Koi y las pantallas se cargan por ruta con `routes.ts`, `KoiApp.tsx` y `Suspense`. | Registrar los módulos internos dentro del shell y del menú existente. «Clientes» ya es el nombre de un grupo comercial. Distinguir allí el listado de clientes de Leads y Pipeline. Mantener los cinco accesos móviles y entrar a los módulos adicionales desde el menú. El portal público requiere su propia ruta y control de acceso. |
| Tabla, Kanban y ficha | `CrmLeads` recibió skeletons de tabla, lista móvil y columnas. `LeadProfile` los usa en ficha, tareas, notas e historial. La ficha mantiene pestañas en móvil y dos columnas en escritorio. | Montar Entrantes como filtro compartido en `CrmLeads`, preservado al alternar tabla/Kanban y regresar de una ficha. Incorporar proyectos y conversión en `LeadProfile`, respetando ambas composiciones. |
| Outbound e Inbox | Las dos bandejas usan componentes de chat compartidos, compositor estilo WhatsApp, menú de adjuntos y estados de carga. Se ajustaron borradores y actualizaciones en Conversations. El hilo móvil ya oculta la barra inferior. | La etapa 1 resuelve el destino y navega al hilo existente en `/conversaciones/:id` o `/inbox/:id`. Centralizar los accesos hoy repartidos entre `OpenLeadChat` y los enlaces directos de `CrmLeads`; ambos dependen del teléfono. Verificar también Instagram sin teléfono y el retorno al CRM. |
| Inicio y Finanzas | `Home.tsx` reemplazó a `KoiDashboard`. Muestra chats, Instagram y tareas. Ya reserva tarjetas para clientes activos, ingresos y gastos de 30 días. `BusinessSummary` está declarado en `home-data.ts`; Inicio lo inicializa con un objeto vacío. | En etapa 3 acordar la definición de cliente activo y alimentar su tarjeta. En etapa 5 conectar las tarjetas al libro autorizado. El tipo `Money` actual expresa una moneda por valor y el formateador usa `Intl.NumberFormat` sin decimales. Resolver la selección o el desglose por moneda y el formato de USDT antes de presentar importes reales. |
| Integraciones, ajustes y Agenda | `Integrations` reúne conexiones de Evolution y Zernio y presenta Finanzas como próxima integración. `Settings` concentra cuenta, apariencia y seguridad. `/agenda` lleva a `PendingSection`. | Implementar Agenda sobre la ruta existente. La gestión financiera diaria necesita su pantalla operativa; la tarjeta de Integraciones corresponde a la conexión de un servicio. Preservar las redirecciones antiguas, incluida la de Zernio con sus parámetros de autorización. |

**Componentes de partida.** Para listados y fichas usar `PageHeader`, `Card`, `Table`, `Tabs`, `Badge` y los controles de `src/components/ui`. Para elegir conversación, asociar proyecto y convertir a cliente, usar los patrones de `DropdownMenu`, `Dialog` o `Sheet` según la cantidad de información y el espacio disponible. Usar `routeSkeletons` y `LoadingRegion` para diferenciar carga, resultado vacío y error. Aprovechar `SoonBadge` en los espacios ya reservados hasta que exista el dato real.

**Aceptación de UI por entrega.** Probar el acceso desde el menú y por URL directa en escritorio y móvil, el foco al cerrar un diálogo, la vuelta a la vista filtrada y los estados de carga, vacío y error. Para chats, incluir apertura desde tabla, tarjeta y ficha, selección de cuenta y envío pendiente al navegar. Para Inicio, verificar tarjetas con cero, sin permiso y con datos en distintas monedas. Usar los recorridos existentes de Playwright como base. El detalle de los cambios previos y sus mediciones está en [Análisis de rendimiento y UI](./analisis-frontend-performance-y-ui.md).

## Etapa 0 · Preparar identidades, permisos e importación

- Inventariar tablas, usuarios, proyectos internos, relaciones, adjuntos disponibles y enlaces externos del Backoffice desplegado. Registrar cantidades por tipo, moneda y estado, y preservar identificadores de origen. Acordar quién podrá operar proyectos, consultar finanzas, administrar el portal y revelar secretos. El rol administrador de Leads y el rol propietario de Backoffice tienen atribuciones distintas.
- Preparar un importador por módulo con simulación previa, correspondencia entre ID de origen y destino, informe de conflictos y reejecución segura. Conciliar contactos por identidad verificada dentro del espacio. Las coincidencias ambiguas se revisan manualmente. Mantener autor y fecha históricos, incluso cuando un usuario antiguo carezca de cuenta activa.
- **Criterio de aceptación.** Dos ejecuciones sobre una copia de prueba producen los mismos registros y relaciones. Dos proyectos homónimos de clientes distintos siguen siendo identificables. Las pruebas con dos espacios y usuarios de distintos permisos confirman el aislamiento.

### Avance y procedimiento de ensayo

**Implementado en la API.** [Inventario SQL de solo lectura](../scripts/backoffice-inventory.sql) y [preparador por módulo](../scripts/backoffice-stage.ts). El inventario cuenta usuarios, estados, relaciones, objetos de Storage y enlaces estructurados, y totaliza importes por moneda. Los campos de texto libre pueden contener otros enlaces que deberán clasificarse al trasladar contenido. El preparador reserva IDs de destino y guarda metadatos de las 17 tablas en una base local privada. Las etapas posteriores usarán esa correspondencia al escribir las entidades definitivas. El inventario desplegado y la regla de permisos quedaron confirmados. La escritura definitiva de cada módulo corresponde a su etapa.

| Módulo del ensayo | Tablas de origen |
|---|---|
| team | profiles |
| clients | clients |
| projects | projects |
| delivery | tasks, milestones, notes, meetings, meeting_projects |
| improvements | feature_requests, feature_request_comments |
| finance | project_financials, financial_movements |
| vault | credentials, credential_access_log, project_env_files, env_file_access_log |
| portal | client_portal_tokens |

**Inventario verificado el 22 de noviembre de 2026.** Consulta agregada de solo lectura en la instancia de producción Backoffice identificada por la configuración de la aplicación.

| Área | Resultado |
|---|---|
| Equipo y clientes | 1 usuario y 1 perfil owner. Hay 8 clientes, 2 activos y 6 cerrados. Ninguno tiene teléfono ni email en sus campos de contacto. Los 8 requieren identificación manual o alta histórica sin contacto CRM. |
| Proyectos y operación | 10 proyectos activos, 7 de clientes y 3 internos. Hay 9 tareas, 2 hitos, 6 notas, 2 reuniones y 0 asociaciones reunión–proyecto. |
| Mejoras | 6 solicitudes y 0 comentarios. |
| Finanzas | 9 presupuestos y 15 ingresos. En ARS hay 4 cobrados y 1 pendiente. En USD hay 4 cobrados y 6 pendientes. |
| Accesos y archivos | 6 credenciales con 23 registros de acceso, 1 archivo de entorno con 0 registros de acceso y 0 objetos en Storage. Hay 5 URLs de servicios y 1 reunión con URL en ubicación. |
| Portal | 2 registros de acceso por enlace, 1 vigente. |

**Ejecución.** Desde la raíz de la API con Node 24 y las dependencias de desarrollo instaladas, configurar `BACKOFFICE_SOURCE_DATABASE_URL` para lectura del origen y `BACKOFFICE_SOURCE_ID` con un identificador estable de esa instancia. Usar `KOI_RECONCILE_DATABASE_URL` para comparar clientes con leads activos del espacio destino. La conciliación informa IDs candidatos por teléfono internacional o email; la confirmación de identidad queda a cargo del equipo. La consulta exige visibilidad completa sobre las tablas seleccionadas. PostgreSQL rechaza una lectura restringida por RLS para evitar presentar inventarios parciales como completos.

```sh
node scripts/backoffice-stage.ts "$KOI_WORKSPACE_ID" preview all
BACKOFFICE_STAGE_DIR="$PRIVATE_STAGE_DIR" node scripts/backoffice-stage.ts "$KOI_WORKSPACE_ID" stage all
```

Usar una carpeta privada fuera del repositorio con permisos 0700 para el ensayo persistente. También se puede indicar un módulo en lugar de `all`. Al ensayar por separado, cargar antes los módulos padre o incluirlos con `all`. Los presupuestos se identifican por proyecto y las relaciones de reuniones por el par reunión–proyecto. El informe identifica las claves duplicadas y los vínculos huérfanos; un conflicto impide aplicar el lote. Los cambios en filas existentes actualizan sus metadatos. El ensayo conserva los registros ya preparados si desaparecen del origen; conciliar las bajas en el corte. La autoría histórica se guarda por ID de origen; la pertenencia y los permisos del usuario destino se validarán por separado.

**Permisos aprobados.** El equipo del espacio opera proyectos y tareas. Los actuales owners de Backoffice conservan finanzas, administración del portal y revelado de secretos. Antes de habilitar cada módulo, vincular el ID del owner histórico con una identidad verificada miembro del espacio destino. Un administrador de Leads recibe estas funciones únicamente si cumple esa correspondencia. El staging es una herramienta local del responsable de migración y no tiene ruta en la API ni en la web.

**Verificación.** [Ensayo de reejecución, conflictos y espacios](../test/backoffice-stage.test.ts) y [pruebas de permisos existentes](../test/security.test.ts). Los controles de permisos de los futuros módulos se probarán al crear sus tablas y endpoints. La suite de API pasó con 173 pruebas exitosas y 3 omitidas. Las consultas de las 17 tablas y el SQL de inventario también se ejecutaron sobre una reconstrucción local del esquema versionado. Antes de importar clientes, el equipo podrá vincular manualmente los ocho registros históricos. Antes de activar permisos sensibles, habrá que verificar la identidad destino del owner.

## Etapa 1 · Abrir el chat correcto y ofrecer la vista Entrantes

Puede comenzar sobre los datos del CRM actual en paralelo con el inventario. Publicar primero el acceso al chat para que cada fila de la nueva vista ya tenga un destino útil.

- **API.** Resolver por lead y espacio las conversaciones de Evolution, WhatsApp oficial e Instagram de Zernio. Entregar canal, proveedor, cuenta, identificador de conversación y última actividad. Conservar el identificador externo con su cuenta de origen. Para Instagram, respetar la identidad que entrega la cuenta conectada y evitar fusiones automáticas por nombre de usuario.
- **Ficha, tabla y Kanban.** «Abrir conversación» lleva al hilo existente del proveedor correcto. Con varios hilos, mostrar canal, cuenta y última actividad. Si se abre desde una fila que identifica un hilo concreto, ir directo a ese hilo. Para contactos sin historial, ofrecer por separado iniciar una conversación cuando el canal lo permita.
- **Entrantes.** Agregar una vista predefinida del mismo CRM en tabla y Kanban. Incluir al contacto cuando tenga al menos un mensaje recibido en las cuentas seleccionadas. Permitir filtrar por canal y cuenta, combinar con responsable y etapa, y ordenar la tabla por último mensaje recibido. Aplicar filtros y conteos antes de paginar. Contar una vez por lead aunque tenga varios hilos. Mantener el origen comercial original y distinguir el último canal entrante. «Entrante» indica recepción de un mensaje, incluso si el contacto ya era cliente.
- **Criterio de aceptación.** Un lead importado que escribe por WhatsApp aparece en Entrantes conservando su origen. Un Instagram sin teléfono abre su DM. Un contacto con dos números del estudio permite elegir el hilo correcto. Un envío sin respuesta queda fuera de Entrantes. La tabla y los totales del Kanban coinciden bajo los mismos filtros, también en móvil y con historial sincronizado.

**Implementación local.** La ficha, la tabla y las tarjetas del Kanban comparten el selector de conversaciones. Una fila de Entrantes abre el hilo del último mensaje recibido que coincide con sus filtros. El selector de una ficha con varios hilos identifica proveedor, cuenta y última actividad. Con teléfono y sin hilos se puede elegir un número para iniciar un borrador. El filtro Entrantes, la cuenta y el canal viajan en la URL al alternar entre tabla y Kanban.

**Publicación.** Aplicar primero [la migración de lectura del CRM](../supabase/migrations/20261122061826_crm_incoming_threads.sql) en la base de Koi Leads, después publicar la API y finalmente la web. El despliegue puede comprobarse con un Instagram sin teléfono y un contacto con más de una cuenta. Los datos históricos se consultan desde los mensajes ya sincronizados.

## Etapa 2 · Crear el catálogo de proyectos y asociarlo a leads

- Incorporar la ficha mínima de proyecto con nombre, tipo, titularidad, estado y fechas. Habilitar proyectos para clientes, internos y SaaS del estudio. Importar el catálogo conservando su referencia al cliente de origen para resolverla en la etapa 3. Conservar la clasificación comercial actual durante la transición y validar cualquier correspondencia con el catálogo.
- Agregar «Asociar proyecto» en la ficha comercial, con búsqueda, motivo del vínculo y responsable. Mostrar leads interesados desde el proyecto y proyectos asociados desde el lead. Permitir varios intereses simultáneos y corregir una asociación dejando registro de la operación.
- **Criterio de aceptación.** Un lead puede interesarse por un SaaS existente y por un desarrollo a medida sin duplicar el contacto ni modificar su etapa. Reintentar la asociación conserva un solo vínculo. Un proyecto interno puede existir desde el inicio sin cliente.

### Implementación y ensayo local

En **Estudio → Proyectos** el equipo puede buscar, crear y editar proyectos y consultar sus leads interesados. La ficha comercial permite buscar un proyecto, indicar el motivo del interés, asignar un miembro del espacio, corregir los datos o quitar la asociación. La actividad queda registrada con actor, fecha y estado previo. Un reintento con la misma clave devuelve el resultado de la operación original. El lead conserva su etapa y su clasificación comercial.

**Catálogo de Backoffice.** El 22 de noviembre se consultaron los campos operativos de los 10 proyectos del origen en modo de solo lectura. La copia local contiene 7 encargos de cliente y 3 proyectos del estudio. De estos últimos, 1 tiene tipo SaaS. La titularidad se determinó por la referencia al cliente y, para los proyectos del estudio, por el tipo registrado. El texto original del tipo se conserva. Se importaron las fechas, el ID de origen del proyecto, su cliente y su autor. La segunda ejecución reconoció los mismos 10 IDs y agregó 0 filas. Los datos locales están en `.local-backoffice/`, excluido de Git.

**Procedimiento para otra instalación.** Usar la [migración del catálogo](../supabase/migrations/20261122061832_project_catalog.sql) en el destino elegido. Preparar primero clientes y luego proyectos con el mismo origen y espacio según la etapa 0. Si el staging es anterior a esta etapa, volver a preparar los proyectos para incluir nombre y fechas. Desde la API, configurar las variables de la etapa 0 y `KOI_PROJECT_DATABASE_URL` para el destino. El [importador](../scripts/import-backoffice-projects.ts) toma los IDs reservados en staging. `preview` ensaya el lote y revierte la transacción; `apply` lo confirma. Es una carga inicial por ID de origen: las filas existentes se preservan. Los cambios posteriores en Backoffice requieren conciliación antes del corte.

```sh
node scripts/import-backoffice-projects.ts "$KOI_WORKSPACE_ID" preview
node scripts/import-backoffice-projects.ts "$KOI_WORKSPACE_ID" apply
```

La migración, la API y la web están preparadas para ejecución local. La activación de las etapas 1 y 2 en producción sigue pendiente.

## Etapa 3 · Convertir a cliente y conectar el historial comercial

- Importar clientes de Backoffice y resolver sus relaciones con los proyectos. Incorporar ficha y listado de clientes, estado operativo, comercial responsable, contactos vinculados y acceso a sus conversaciones según permisos.
- Ofrecer «Convertir en cliente» desde la ficha y al mover una tarjeta a Ganado. Mostrar coincidencias para elegir un cliente existente o crear uno. Permitir seleccionar qué proyecto se contrata, mantener los demás intereses abiertos y completar el vínculo con el proyecto más adelante cuando aún no esté definido. Al descartar la sugerencia después de mover la tarjeta, debe quedar claro cuál fue el cambio ya guardado.
- Guardar cliente, contacto, contratación seleccionada y evento de conversión como una operación atómica y repetible. Mostrar actor y fecha en el historial. Al volver a abrir un lead convertido, ofrecer «Ver cliente». Preservar preferencias de contacto, consentimiento y exclusiones de campañas.
- **Criterio de aceptación.** Dos contactos pueden pertenecer al mismo cliente. Dos clientes distintos pueden contratar el mismo SaaS. Un doble clic o un reintento tras perder la respuesta crea una sola conversión. Desde el cliente se llega al chat original y desde el proyecto se identifican sus clientes.
- **Decisión posterior.** La primera versión conserva el Kanban por contacto. Si el equipo necesita negociar dos proyectos del mismo contacto en etapas distintas, introducir oportunidades con etapa, responsable y resultado propios. Hasta entonces, los reportes deben distinguir leads ganados de proyectos contratados.

### Implementación local de clientes

La sección **Clientes del estudio** reúne los clientes históricos y los creados desde un lead. El equipo puede editar el estado operativo y el comercial responsable. Inicio cuenta los registros con estado **Activo**, la misma definición que usaba Backoffice. Un cliente creado por conversión empieza activo y hereda el responsable del lead. Vincular otro contacto conserva el responsable y el estado existentes.

La ficha del lead y la sugerencia al guardar Ganado permiten elegir el cliente y un proyecto opcional. Las coincidencias por nombre, empresa, teléfono o correo requieren selección explícita. Cada conversión conserva el contacto original y registra quién la hizo y cuándo. La contratación se puede completar después desde la ficha del cliente. Los proyectos muestran sus clientes y la ficha del lead identifica los intereses ya contratados por su cliente. El acceso a las conversaciones reutiliza el selector de hilos de la etapa 1.

**Ensayo del 22 de noviembre.** El destino local contiene los ocho clientes de Backoffice, dos activos y seis cerrados, y los siete vínculos históricos con proyectos. Una segunda importación reconoció los ocho registros y agregó cero clientes y cero vínculos. Los clientes históricos quedan disponibles para vinculación manual con los leads. Se conserva el autor de origen por separado del responsable comercial.

**Para reproducir la carga**, preparar los clientes en staging con los campos de esta etapa, aplicar la [migración de clientes](../supabase/migrations/20261122061837_client_conversion.sql) al destino y cargar primero el catálogo de proyectos de la etapa 2. Con las mismas variables del importador, ejecutar `node scripts/import-backoffice-projects.ts "$KOI_WORKSPACE_ID" preview clients` y luego `apply clients` sobre ese mismo espacio. La publicación en producción sigue pendiente.

## Etapa 4 · Gestionar entregas, archivos y agenda

- Trasladar tareas, estados, hitos, fechas, reuniones y notas. Calcular el progreso por tareas terminadas y conservar por separado el estado registrado del proyecto. La agenda reúne reuniones, hitos y seguimientos comerciales y ofrece acceso al elemento de origen. Una reunión puede incluir varios proyectos. Incorporar los vencimientos financieros cuando se publique Finanzas.
- Usar «Mejora» como tipo de nota de estudio, cliente o proyecto. Migrar solicitudes de features conservando autor, estado, comentarios y fechas. Permitir convertir una mejora aceptada en tarea con referencia a la solicitud original.
- Incorporar archivos con acceso por espacio, cliente o proyecto. En productos compartidos, distinguir materiales comunes del producto y archivos privados de cada cliente. Migrar adjuntos históricos según el inventario, comprobando integridad y descarga autorizada.
- **Criterio de aceptación.** Desde un cliente se puede ver la próxima entrega, abrir la tarea y volver al chat. Una mejora interna y otra pedida por un cliente conservan su contexto. Un proyecto activo con todas sus tareas terminadas conserva ambos datos. Dos clientes del mismo SaaS solo acceden a los archivos que les corresponden.

### Implementación local de entregas

**Uso en el panel.** Estudio → Entregas permite crear y editar tareas, hitos, reuniones, notas y mejoras. Las fichas de proyecto y cliente reúnen sus elementos. El progreso del proyecto se calcula con sus tareas terminadas sobre el total. Si el proyecto aún no tiene tareas se muestra ese estado. La próxima entrega de un cliente toma la primera tarea o hito pendiente con fecha de hoy en adelante, en horario argentino. Los vencidos siguen disponibles en la misma ficha. Desde la entrega se puede volver al cliente y elegir el chat de su contacto.

**Agenda y mejoras.** Agenda reúne reuniones, entregas fechadas y seguimientos comerciales pendientes. Cada entrada abre el elemento o el editor del seguimiento. Una reunión puede vincularse a varios proyectos. Las mejoras admiten comentarios y conservan el autor, la fecha y el contexto de cliente, proyecto o estudio. Convertir una mejora aceptada crea una tarea de proyecto, marca la mejora en curso y mantiene un enlace en ambos sentidos. La reejecución devuelve la misma tarea.

**Archivos.** El equipo autenticado puede subir y descargar adjuntos de hasta 5 MiB desde el estudio, el proyecto o el cliente. La implementación inicial guarda los bytes en una tabla privada y comprueba SHA-256 al descargar. Un archivo del proyecto es material común. Un archivo del cliente es privado y puede vincularse también con uno de sus proyectos contratados. La vista del cliente incluye su material y el común de sus proyectos. La descarga vuelve a comprobar el espacio y el contexto del archivo. El acceso externo a través del portal corresponde a la etapa 6.

**Ensayo de migración.** Se cotejaron los campos y los vínculos de los 25 registros de Backoffice con la copia local: 9 tareas, 2 hitos, 6 notas, 2 reuniones y 6 mejoras. Una segunda importación agregó cero filas. El origen tenía cero comentarios de mejora, cero vínculos reunión–proyecto y cero objetos en Storage. Los comentarios históricos y las reuniones con varios proyectos se probaron con datos sintéticos. El archivo de entorno pertenece a la bóveda de la etapa 6.

**Reproducción.** Usar la [migración de entregas](../supabase/migrations/20261122063332_delivery_agenda.sql) después del catálogo y de clientes. Con las variables de origen, espacio, staging y destino de las etapas anteriores, ejecutar `node scripts/import-backoffice-delivery.ts "$KOI_WORKSPACE_ID" preview` y luego el mismo comando con `apply`. El importador usa una lectura consistente del origen y los identificadores reservados en staging. El ensayo revierte la transacción del destino. La carga confirmada conserva las ediciones de los registros ya importados. La publicación sigue pendiente.

## Etapa 5 · Unificar finanzas y resumen del estudio

- Migrar presupuestos, cobros, gastos generales, movimientos y recurrencias. Conservar importe y moneda originales (ARS, USD y USDT), medio de pago, estado, vencimiento y fecha efectiva. Permitir movimientos generales del estudio y vínculos opcionales con cliente, proyecto o contratación de SaaS.
- Usar el mismo libro de movimientos para Finanzas, ficha de cliente, ficha de proyecto, vencimientos y Resumen. Mostrar moneda y período en los indicadores. Aplicar permisos financieros también a agregados, agenda, respuestas de API y exportaciones habilitadas.
- **Criterio de aceptación.** Conciliar cantidades y totales con el origen por moneda, tipo y estado. Una recurrencia importada genera una sola próxima cuota aun si se reintenta la importación. Un cobro se registra una vez y se refleja en todas las vistas autorizadas.

### Implementación local de Finanzas

**Operación.** En Estudio → Finanzas, el owner puede registrar y corregir ingresos y gastos, liquidar o cancelar pendientes y administrar presupuestos de proyectos. Un movimiento puede ser del estudio, de un cliente, de un proyecto o de la contratación de ese proyecto por ese cliente. La ficha del cliente muestra los movimientos que llevan su referencia. Los presupuestos de productos SaaS pertenecen al proyecto. La cuenta de cada cliente muestra sus propios movimientos. Se conservan importe decimal, moneda, categoría, notas, fecha de registro, vencimiento, fecha efectiva y medio de pago.

**Resumen y agenda.** El resumen usa la fecha efectiva de cobro o pago y presenta ingresos, gastos y neto por moneda. Inicio muestra los últimos 30 días calendario del estudio, incluido hoy, y Finanzas permite elegir el período. Los presupuestos y los pendientes quedan fuera de caja. Agenda abre el movimiento pendiente por su ID y deja de mostrarlo al liquidarlo o cancelarlo. Las correcciones y los reintentos conservan un solo registro mediante revisión y clave de operación.

**Permiso financiero.** Se verificó por correo confirmado que el owner de Backoffice corresponde a un único miembro del espacio Koi. El permiso se carga en una tabla privada sin acceso directo del navegador. La API y cada operación de base de datos comprueban esa concesión, también para resúmenes y vencimientos. El menú y las fichas utilizan la misma comprobación. El administrador sin concesión conserva las vistas operativas. Esta etapa no incorpora una exportación financiera.

**Conciliación.** Se importaron en local 9 presupuestos y 15 ingresos. Se cotejaron cantidades e importes contra el origen por moneda, tipo y estado. En ARS hay cuatro cobrados y uno pendiente. En USD hay cuatro cobrados y seis pendientes. La segunda ejecución agregó cero registros. De nueve movimientos marcados como mensuales, ocho identifican su serie y uno es un cobro histórico sin identificador. Se conserva el cobro, marcado para revisión en el libro. La generación automática requiere serie identificada. El importador carga el historial completo antes de completar cuotas faltantes. Una restricción por espacio, serie y mes evita duplicados. Las correcciones desde la ficha afectan la cuota seleccionada.

**Reproducción y corte.** Aplicar la [migración financiera](../supabase/migrations/20261122063337_studio_finance.sql) después del catálogo, clientes y entregas. El [importador](../scripts/import-backoffice-finance.ts) usa las variables de origen, staging privado, espacio y destino de las etapas anteriores. Ejecutar `node scripts/import-backoffice-finance.ts "$KOI_WORKSPACE_ID" preview` y comprobar el informe. Usar `apply` para confirmar en el destino elegido. La simulación revierte el libro y las concesiones del destino. Una identidad sin correspondencia única o una diferencia de conciliación impide confirmar el lote. Antes del corte, conciliar cambios realizados en cualquiera de los dos libros. La publicación en producción sigue pendiente.

## Etapa 6 · Integrar bóveda y portal de clientes

- **Bóveda.** Admitir credenciales de proyectos, cuentas gestionadas de clientes, plataformas de terceros y herramientas del estudio. Conservar cifrado del lado servidor, versión de llave, revalidación para revelar y registro de accesos. Incluir archivos de variables de entorno en este flujo protegido. Verificar acceso y recuperación en un entorno controlado antes del traslado.
- **Portal.** Publicar una vista limitada por cliente con enlaces revocables, proyectos, progreso, hitos y estados de pago seleccionados. Introducir visibilidad explícita para notas y archivos. Las notas migradas quedan internas hasta que el equipo las publique. Definir el reemplazo o la continuidad de los enlaces existentes antes de cambiar el acceso público.
- **Criterio de aceptación.** Un operador comercial puede atender un chat sin poder revelar una clave. Un acceso autorizado a la bóveda queda auditado. Revocar un enlace corta el acceso al portal. Dos clientes de un mismo SaaS ven únicamente su propia información y los materiales publicados para ellos.

### Implementación local de bóveda y portal

**Bóveda.** Desde Estudio → Bóveda, el owner verificado puede guardar una credencial del estudio, un cliente o un proyecto, y un archivo de entorno de un proyecto. Para revelar el contenido vuelve a ingresar su contraseña. La API verifica la identidad con Supabase Auth y registra el ID del usuario y la fecha antes de entregar el contenido. La pantalla lo oculta al cambiar de pestaña o después de 30 segundos. El cifrado AES-256-GCM vincula cada elemento con su espacio, ID, tipo y versión de llave. El historial de Backoffice conserva los identificadores originales de los usuarios que accedieron.

**Portal.** En la ficha del cliente, el owner elige los proyectos contratados, estados de cobros, notas y archivos que puede consultar el cliente. Publicar un proyecto incluye el progreso agregado y los hitos comunes y propios. Las notas y archivos requieren selección individual, incluso los comunes a varios clientes. La selección inicial está vacía. Crear o reemplazar el enlace muestra una única vez el enlace para compartir. La base guarda su hash. Cada consulta y descarga comprueba la vigencia del enlace y la relación actual del material con el cliente. Revocar impide consultas y descargas posteriores. Una pantalla abierta actualiza su contenido al volver al foco y cada 30 segundos.

**Llaves y recuperación.** Aplicar la migración después de Finanzas. Configurar en el gestor de secretos de la API `KOI_VAULT_KEYS` como objeto JSON de versiones con llaves de 32 bytes en base64 y `KOI_VAULT_KEY_VERSION` como versión activa. Para rotar, añadir la nueva versión y conservar las anteriores mientras existan registros cifrados con ellas. Verificar la copia de recuperación antes de retirar una versión. [Migración de bóveda y portal](../supabase/migrations/20261122063344_vault_client_portal.sql)

**Traslado.** En el entorno de migración, usar las conexiones y el staging de las etapas 2 y 3. Proveer la llave histórica por `MASTER_ENCRYPTION_KEY` para v1 o el conjunto `BACKOFFICE_VAULT_KEYS` con `BACKOFFICE_VAULT_ACTIVE_VERSION`. Suministrar `KOI_VAULT_RECOVERY_KEYS` desde la copia custodiada por separado. Ejecutar `node scripts/import-backoffice-vault.ts "$KOI_WORKSPACE_ID" preview`. El importador descifra en memoria, vuelve a cifrar con la llave destino, comprueba la recuperación del registro persistido y revierte la transacción de destino en la simulación. Cotejar cantidades de elementos y accesos con el inventario del corte antes de repetir en modo `apply`. Una repetición conserva las ediciones hechas en Koi. [Importador de bóveda](../scripts/import-backoffice-vault.ts)

**Estado del corte.** El catálogo local reconoce al owner verificado. La recuperación se ensayó con material sintético. Quedan pendientes la recuperación controlada con las llaves históricas y el traslado de las 6 credenciales, 1 archivo de entorno y 23 accesos inventariados. De los dos enlaces históricos, uno estaba activo. Mantenerlo en Backoffice durante el piloto. Para reemplazarlo, el owner debe seleccionar el contenido del cliente, abrir el nuevo enlace como visitante y coordinar con el cliente antes de retirar el anterior.

## Etapa 7 · Conciliar y retirar Backoffice del uso diario

Hacer un piloto con un desarrollo a medida, un proyecto interno y un SaaS con dos clientes. Designar un sistema de escritura por módulo durante la transición. En el corte, registrar el último cambio de origen, importar el diferencial, conciliar relaciones y totales y mantener Backoffice disponible para consulta durante el período acordado. Si falla la conciliación, posponer el corte del módulo y corregir las diferencias registradas. Si el módulo ya recibió escrituras en Koi Leads, conciliarlas antes de reabrir la escritura en el origen.

**Aceptación final.** Un comercial demuestra el recorrido mensaje → lead → cliente → proyecto. Operaciones demuestra tarea → entrega → actualización compartida. Finanzas valida cobro → movimiento → resumen. El responsable del estudio verifica accesos de operador, administrador financiero y cliente externo. Retirar cada módulo antiguo tras la conformidad de su responsable y una prueba de recuperación.

### Resultado del piloto del 22 de noviembre

**Conciliación.** A las 08:54:44 UTC se comparó una lectura de Backoffice desplegado con el catálogo local de Koi. Coincidieron 75 registros y relaciones históricos. La comparación verifica las identidades de origen y el contenido operativo normalizado, incluidos los importes por movimiento, la moneda, el estado y las referencias de cliente y proyecto. Los conteos incluyen relaciones y presupuestos.

| Grupo | Coincidencias |
|---|---:|
| Clientes, proyectos y contratos históricos | 8 + 10 + 7 |
| Tareas, hitos y reuniones | 9 + 2 + 2 |
| Notas de la tabla de notas y nota del campo histórico del cliente | 6 + 1 |
| Solicitudes de mejora | 6 |
| Presupuestos e ingresos | 9 + 15 |

Se encontró una nota adicional en `clients.notes`. El importador de entregas ahora la conserva con el cliente y autor históricos, fecha, procedencia y visibilidad interna. En la segunda carga se agregaron cero elementos. Las tablas históricas de comentarios de mejoras y asociaciones reunión–proyecto estaban vacías. La bóveda, los permisos, el contenido de Storage y los enlaces públicos tienen controles separados. En el inventario del piloto había cero objetos en Storage y un enlace histórico vigente.

**Recuperación y operación.** Se restauró el catálogo local en memoria y se volvieron a comparar las 75 filas. Sobre esa copia se completaron tareas en un desarrollo contratado y un proyecto interno. En el SaaS se convirtieron dos leads sintéticos en clientes, se publicó una entrega para uno y se verificó desde ambos portales el aislamiento de la nota y del progreso. Un operador tuvo acceso a la operación y recibió acceso denegado a finanzas y bóveda. El owner conservó sus permisos. Cambiar el nombre de un proyecto en la copia generó una diferencia con igual cantidad de filas. El ensayo se puede repetir con `node scripts/pilot-backoffice.ts .local-backoffice/catalog "$KOI_WORKSPACE_ID" "$BACKOFFICE_SOURCE_ID"`. [Piloto de restauración](../scripts/pilot-backoffice.ts)

**Prueba en navegador.** La prueba de Entrantes siguió un mensaje de Instagram hasta el lead, convirtió el lead en cliente con un proyecto a medida y abrió el chat de WhatsApp asociado a ese mismo contacto. También pasaron los recorridos de entregas, cobro desde Agenda hasta el resumen financiero y publicación y revocación del portal para un visitante. Se usaron la API local, datos de prueba y autenticación simulada.

### Escritura y corte por módulo

| Módulo | Sistema de escritura durante el piloto | Quién valida el traspaso |
|---|---|---|
| Mensajería, leads y pipeline | Koi Leads | Comercial verifica hilo, cuenta, contacto, cliente y proyecto |
| Clientes históricos, proyectos y entregas | Backoffice | Operaciones valida contratos, tareas, hitos, archivos y materiales compartidos |
| Finanzas | Backoffice | Owner compara importes por moneda y estado y resuelve el cobro mensual histórico sin serie |
| Bóveda | Backoffice | Owner verifica recuperación con llaves reales y coteja elementos y accesos |
| Portal vigente | Backoffice | Owner y cliente comprueban el contenido del enlace nuevo antes de retirar el anterior |

1. Acordar con los responsables la ventana, el orden de los módulos y el plazo de consulta del sistema anterior. Mantener las escrituras de cada módulo en un sistema por vez. El esquema de estos módulos ya está aplicado en Supabase de producción de Koi Leads.
2. Desplegar esquema, API y web compatibles. Antes de habilitar escrituras del equipo, tomar una copia recuperable del destino y demostrar su restauración en un entorno separado. Para el corte, suspender las escrituras del módulo en Backoffice, incluidos procesos automáticos que lo modifiquen. Registrar hora UTC, máximos por tabla, conteos y totales de la misma instantánea. Usar el inventario también para las relaciones sin fecha y para detectar bajas. [Consulta de inventario](../scripts/backoffice-inventory.sql)
3. Preparar un staging nuevo del origen congelado con el mismo identificador de origen y espacio. Ejecutar los importadores de las etapas 2 a 6 en orden y por módulo, primero en modo de simulación. Las altas reutilizan IDs estables. Una corrección de origen o una baja requiere revisar el ID y el historial del destino antes de resolverla. La repetición de los importadores conserva ediciones existentes y por sí sola no aplica esas correcciones.
4. Con `BACKOFFICE_SOURCE_DATABASE_URL`, `BACKOFFICE_SOURCE_ID`, `KOI_PROJECT_DATABASE_URL` y el espacio configurados, ejecutar `node scripts/reconcile-backoffice.ts "$KOI_WORKSPACE_ID"`. Ambas conexiones leen instantáneas de solo lectura. La salida identifica claves presentes en un solo lado o con diferencias de contenido o vínculos. Código 0 indica coincidencia del conjunto operativo, 2 indica diferencias y 1 indica que no pudo verificarse. Conciliar por separado los cambios nativos de Koi, las cuotas generadas, permisos, archivos, enlaces y la bóveda. Guardar el informe final junto a la hora del corte y la conformidad del responsable. [Conciliador](../scripts/reconcile-backoffice.ts)
5. Habilitar escritura en Koi por módulo después de la prueba del responsable. Mantener Backoffice consultable durante el plazo acordado. Si surge una diferencia después de habilitar escrituras, detener ese módulo, conservar las escrituras nuevas y conciliarlas antes de decidir en qué sistema reabrir. Para el portal, coordinar el enlace de reemplazo antes de revocar el anterior.

**Pendiente de producción.** Quedan la publicación de API y web, la importación histórica, la prueba de recuperación con las llaves históricas, la conformidad de los responsables y la ventana de corte. El ensayo local valida el procedimiento técnico. La fecha de retiro de Backoffice sigue abierta.

**Migraciones en producción.** El 22 de noviembre de 2026 se aplicaron y verificaron las seis migraciones en el proyecto Supabase de Koi Leads (`avqhjbrcbgqhelfkcist`). Las 16 tablas privadas nuevas tienen RLS activo y los roles de la aplicación carecen de permisos directos sobre ellas. El owner histórico de Backoffice quedó vinculado a su cuenta confirmada en Estudio Koi. Se verificaron las tres capacidades con las funciones que consulta la aplicación bajo el rol autenticado. Finanzas, bóveda y administración del portal devolvieron acceso habilitado.

## Referencias del relevamiento

- Backoffice: `src/App.tsx`, `src/data/repository.ts`, `supabase/migrations/` y `supabase/functions/get-client-portal/index.ts`.
- Koi Leads Web: `src/koi/CrmLeads.tsx`, `src/koi/LeadProfile.tsx`, `src/koi/OpenLeadChat.tsx` y `src/koi/KoiApp.tsx`.
- Koi Leads API: `supabase/migrations/20261110024130_koi_lead_management.sql`, `20261110112004_koi_followups_inbox.sql` y `20261120115127_koi_inbox_ingestion.sql` dentro del mismo directorio.
