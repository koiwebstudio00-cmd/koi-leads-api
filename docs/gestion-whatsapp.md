# Gestión de WhatsApp desde Koi

La pantalla **WhatsApp** permite a administradores crear una conexión adicional, vincular mediante QR, reconectar una sesión y desconectarla tras confirmación. Los operadores solo consultan estados.

- `koi-01` conserva su configuración, webhook y función de remitente de campañas. No se desconecta ni reinicia durante el despliegue.
- Las nuevas instancias son sesiones adicionales; no se asignan automáticamente al worker ni reciben el webhook de campañas. La elección de múltiples remitentes para campañas sigue fuera del alcance actual.
- Los nombres visibles son editables al crear; el identificador Evolution lo genera PostgreSQL a partir de un UUID no elegible por el cliente. La API nunca admite URLs, claves o nombres arbitrarios de instancias.
- El registro persiste en `koi_whatsapp_instances`, aislado por RLS y workspace. Solo admin puede insertar. No hay permisos de actualización o borrado desde Data API. Hasta 10 sesiones adicionales por espacio.
- Un alta interrumpida conserva su registro: **Vincular con QR** comprueba la existencia en Evolution y completa la provisión. La clave de idempotencia evita duplicar el alta ante reintentos idénticos.
- Reconectar usa `POST /instance/restart/:name`; desconectar usa `DELETE /instance/logout/:name`. Vincular usa `GET /instance/connect/:name` en Evolution, expuesto como POST autenticado en Koi porque puede abrir una sesión.
- Para reconectar o desconectar el remitente se exige que no haya campañas activas (incluidas pausadas), reservas/envíos en curso o resultados inciertos. Si otro proceso comienza una campaña simultáneamente, el worker mantiene su comprobación de conexión y pausa ante fallos.
- El QR solo se devuelve como PNG inline, con `Cache-Control: no-store`; se conserva en memoria mientras el diálogo está abierto, se oculta a los 40 segundos y requiere regeneración. No se devuelven tokens, claves ni el objeto completo del proveedor.
- La consulta de estado se repite cada 5 segundos mientras el QR está abierto y se detiene al cerrar o conectar. No se guarda el QR en localStorage.
- No hay eliminación de instancias desde esta versión: desconectar cierra la sesión sin borrar su registro.

## Despliegue

Aplicar `koi_whatsapp_instances`, desplegar API desde el repo backend y frontend desde su repo. No hacen falta variables ni credenciales nuevas. El health de la API anuncia `whatsapp-instances-v1`. Los envíos de campañas permanecen con la configuración previa (`KOI_SEND_ENABLED=false`).

## Marca y tema

Frontend: tema [CliniDS de tweakcn](https://tweakcn.com/r/themes/cmkybzyzr000004l515sz2eox), instalado con shadcn. Roboto se sirve localmente. Símbolo original de [Koi Studio](https://koistudio.com.ar/assets/brand/koi-symbol.png); WhatsApp mediante Simple Icons. Se conserva la distribución del dashboard, importaciones y campañas.
