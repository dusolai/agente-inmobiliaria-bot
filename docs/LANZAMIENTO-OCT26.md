# Lanzamiento octubre 2026 — qué cambia y qué hay que hacer

Runbook para relanzar el embudo con la lista nueva de Karen (reuniones con Arkaitz del 24-09 "separación de vienes" y del 01-10 "cambios 2"). Revisión conjunta el **lunes 5 de octubre**, lanzamiento el **martes 6**.

Prueba automática de todo lo nuevo (sin enviar nada): `node scripts/test-lanzamiento.js`

---

## 1. Lo decidido en las reuniones → lo que hace ahora el sistema

| Decisión (reunión) | Qué hace el sistema ahora |
|---|---|
| Dividir la lista en **viejos / verano (jul-ago) / septiembre** y mandar a cada uno su mensaje (24-09, 01-10) | Cada lead lleva `segmento`. El importador lo asigna por la fecha del formulario. Cada segmento usa **su plantilla de Meta** (`WHATSAPP_TEMPLATE_VERANO`, `_SEPTIEMBRE`, `_DIRECTO`; los viejos siguen con la actual). |
| "Los tres a la vez" como **campañas independientes**, 20/día cada una (01-10, 06-10) | **Varias campañas activas a la vez.** El importador crea una por segmento (Viejos · Verano · Septiembre) y "Nuevos en directo" se crea sola. Cada una tiene su cupo diario (20 por defecto), su plantilla y su estado: activa / en pausa / archivada. Como mucho un envío cada 5 min en total, sin ráfagas. |
| Leads nuevos "en directo" se contactan nada más entrar (24-09) | **Lector de la hoja de Google de Karen** cada 10 min: fila nueva → lead `directo` → mensaje al momento (9-22h; si no, a primera hora). Y si alguien **escribe al WhatsApp del agente** sin ser lead (número del formulario de Karen) se da de alta solo y recibe la pregunta de filtrado. |
| Archivar la campaña de prueba, empezar con registro limpio, guardar historial (01-10) | La prueba de septiembre queda **archivada** (`prueba_sep26`), consultable en el desplegable. Crear una campaña ya **no** archiva las demás; las vacías se pueden borrar. El panel muestra por defecto "Todas las activas" y se puede filtrar por una. |
| No volver a escribir a quien no quiere (24-09, calidad del número) | Al importar: si un teléfono pidió la **baja** o **no tiene WhatsApp** en cualquier campaña, se excluye. Si ya se le escribió en una campaña anterior, se crea pero **marcado** (`↩ repetido`). |
| Pasar a presentaciones **en directo** (formato 30-30, una al día, 1-a-1 en el turno opuesto) — siguiente fase (01-10) | Listo detrás de un interruptor: `FLUJO_TRAS_CUALIFICAR=presentacion`. Al responder 1/2 el lead recibe la invitación al Calendly grupal; al reservar, confirmación; al **asistir al Zoom** (webhook) recibe el 1-a-1; si reserva y no entra, se le ofrece otra. Por defecto sigue `landing` (vídeos → botón 1-a-1), que es lo acordado para este lanzamiento. |
| Nueva presentación grabada y vídeos cortos en la landing (01-10) | **No es del SaaS**: va en los repos de las landings (`LANDING-THREE-INMOBILIARIA`, `three-inmobiliaria-emprende`). Pendiente de que Arkaitz pase el material. |

---

## 2. La lista

Fuente: `NUEVA_ Captación agentes inmobiliarios - DIC25.csv` (export de Meta, 3-oct). Ficheros partidos en `C:\Users\diego\Downloads\three-inmo-lanzamiento-oct26\` (CSV por segmento + `Leads_segmentados_oct26.xlsx` con una pestaña por segmento + `RESUMEN.txt`).

| | Filas |
|---|---|
| Filas en el CSV | 350 |
| Pruebas de Meta / duplicados (mismo teléfono; se conserva la entrada más reciente) | 3 / 65 |
| **Leads únicos** | **282** |
| Viejos (13-dic-25 … 30-jun-26) → plantilla actual | 185 |
| Verano (jul-ago 26) → `reactivacion_verano` | 72 |
| Septiembre y después (hasta 2-oct) → `reactivacion_septiembre` | 25 |
| Teléfonos no españoles o raros (quedan fuera salvo "Incluir extranjeros") | 12 |

A 25/día son ~12 días laborables; a 20/día, ~15. En el CRM basta con importar el CSV completo (o el original de Meta): el segmento lo pone solo.

---

## 3. Plantillas de Meta que hay que crear (antes del lunes)

WhatsApp Manager → Plantillas → Crear. Categoría **Marketing**, idioma **Español (es)**, cuerpo con la variable **`{{nombre}}`** (con nombre, como la actual) y **dos botones de respuesta rápida**: `Soy agente inmobiliario` · `Busco ingresos extra` (el flujo los reconoce por "agente" / "ingreso"). Meta tarda ~24 h en aprobar. Los textos son los acordados con Arkaitz el 30-09 (están también en `templates/messages.js` → `PLANTILLAS_META` y en `GET /api/plantillas`).

**`reactivacion_verano`** → variable de Seenode `WHATSAPP_TEMPLATE_VERANO`
```
¡Hola, {{nombre}}! 👋 Soy del equipo de Three Inmobiliaria.

Con el verano de por medio, estamos retomando estos días el contacto con las personas que mostraron interés en nuestro proyecto durante julio y agosto.

Antes de enviarte toda la información, quería preguntarte algo muy rápido para saber qué puede encajarte mejor:

👉 ¿Actualmente trabajas en el sector inmobiliario 🏠 o estás buscando una oportunidad para generar ingresos extra? 💰
```

**`reactivacion_septiembre`** → `WHATSAPP_TEMPLATE_SEPTIEMBRE`
```
¡Hola, {{nombre}}! 👋 Soy del equipo de Three Inmobiliaria.

Hace unos días mostraste interés en nuestro proyecto y quería ponerme en contacto contigo para contarte cómo funciona y las novedades que tenemos actualmente. 😊

Antes de enviarte información, una pregunta rápida para orientarte mejor:

👉 ¿Actualmente trabajas en el sector inmobiliario 🏠 o estás buscando una oportunidad para generar ingresos extra?
```

**`bienvenida_directo`** → `WHATSAPP_TEMPLATE_DIRECTO`
```
¡Hola, {{nombre}}! 👋 Soy del equipo de Three Inmobiliaria.

He visto que acabas de mostrar interés en nuestro proyecto y quería contactar contigo para conocer un poquito mejor qué estás buscando 😊

Antes de enviarte información, una pregunta rápida:

👉 ¿Ya trabajas en el sector inmobiliario 🏠 o estás buscando una nueva oportunidad para generar ingresos? 💰
```

Notas: el mensaje de verano tal cual lo pasaste empezaba por "Hola, MAVI!" sin "¡"; aquí va normalizado. Un segmento **sin** plantilla configurada se queda en cola (el CRM lo marca "⚠️ sin plantilla aprobada"); no se le manda la genérica, que es justo lo que Arkaitz no quería.

---

## 4. Variables nuevas en Seenode

```
WHATSAPP_TEMPLATE_VERANO=reactivacion_verano
WHATSAPP_TEMPLATE_SEPTIEMBRE=reactivacion_septiembre
WHATSAPP_TEMPLATE_DIRECTO=bienvenida_directo
LEADS_POR_DIA_CAMPANA=20         # cupo por defecto de cada campaña nueva (se cambia en el CRM)
GOOGLE_SHEETS_ID=1BupIB3Pv7ASdfjY5Ss9pCcaImR0p98eIBHiJtWL93j4
GOOGLE_SHEETS_TAB=DIC25
SHEETS_DESDE=2026-10-03          # lo anterior ya está en el CSV (los solapes se deduplican por teléfono)
SHEETS_POLL_MINUTES=10
AUTOALTA_WHATSAPP=1
FLUJO_TRAS_CUALIFICAR=landing    # 'presentacion' cuando Marta/Arkaitz tengan la agenda de directos
```
(`GOOGLE_SERVICE_ACCOUNT_EMAIL` y `GOOGLE_PRIVATE_KEY` ya existen en `.env.example`; comprobar que están en Seenode.) **La hoja de Karen hay que compartirla** (lector) con el email de la cuenta de servicio, si no el lector no verá nada. Estado en `GET /api/sheets/status`; lectura manual con `POST /api/sheets/sync`.

---

## 5. Pasos, en orden

**Hoy/mañana (Diego)**
1. Crear las 3 plantillas en Meta (punto 3) y esperar aprobación.
2. Recuperar la **tarjeta** del portátil antiguo (Arkaitz la pasa cuando se la pidas) y ponerla en Calendly y en el método de pago de Meta/WhatsApp Business (bloqueo de impacto alto en el acta: sin tarjeta no hay Calendly ni envíos).
3. `git add -A && git commit && git push` de este repo → Seenode despliega. Añadir las variables del punto 4. Reiniciar.
4. Compartir la hoja de Google con la cuenta de servicio.
5. Pasar a Arkaitz la transcripción de la reunión anterior (tarea 8 del acta) y el número de WhatsApp del agente para el formulario de Karen.

**Lunes 5 (revisión con Arkaitz, en el CRM)**
6. Comprobar en Inicio → "Flujo de la lista" que los tres segmentos muestran su plantilla (sin "⚠️").
7. Borrar con 🗑 las campañas vacías de prueba (Inicio → Campañas). La de septiembre ya está archivada.
8. Pestaña **Importar** → arrastrar el CSV completo → Destino "Repartir en una campaña por segmento", sufijo `oct26` → Importar. Crea Viejos / Verano / Septiembre activas con 20/día. Nada se envía al importar.
9. Si aún no queréis que salga nada, poner el cupo de cada campaña en 0 (o pausarlas).
10. Arkaitz: Calendly con disponibilidad del 1-a-1 configurado (lo hace él) y **activo** antes de que el primer lead termine el webinar; nueva presentación grabada + vídeos cortos pasados a Diego para la landing.

**Martes 6 (lanzamiento)**
11. Cupo **20/día por campaña** (60 en total). Cada campaña suelta uno cada ~30 min entre 10 y 20 h; en total, como mucho uno cada 5 min.
12. Vigilar el primer día: entregas (acuses en el chat del CRM), respuestas en "Sin responder", calidad del número (`node scripts/check-whatsapp.js`). Si la calidad baja a amarillo, bajar a 10/día.

**Después**
13. Cuando Marta/Arkaitz tengan la agenda de presentaciones en directo: crear el evento grupal en Calendly, suscribir el webhook de Calendly y el de Zoom (ya soportados), y poner `FLUJO_TRAS_CUALIFICAR=presentacion`. Opcional: plantilla `WHATSAPP_TEMPLATE_RECORDATORIO_GRUPAL` para que los recordatorios de reserva lleguen fuera de la ventana de 24 h.

---

## 6. Pendientes que NO son del sistema (del acta del 01-10)

- Arkaitz: hablar con Marta (presentación de inmobiliarios en directo), configurar su Calendly (días/horas, 1-a-1 en el turno opuesto a la presentación), conseguir la presentación grabada nueva del evento nacional y los vídeos cortos, pasar la tarjeta.
- Diego: cambiar en la landing la presentación grabada por la nueva y meter el material nuevo cuando llegue (repos de las landings, no este); actualizar tarjeta en Calendly y Meta; pasar transcripción y número.

---

## 7. Qué ha cambiado en el código

Nuevos: `services/metaLeads.js` (lectura/limpieza del export de Meta, segmento por fecha), `services/campanas.js`, `services/importador.js` (reglas de alta: duplicados, bajas, repetidos), `services/sheetsPoller.js` (hoja de Google), `scripts/test-lanzamiento.js`, este documento.

Modificados: `config/config.js` (plantillas por segmento, flujo, hoja, cortes), `services/leadManager.js` (campaña, segmento, fechaLead, respuestas; `getLeadByPhone` prefiere la campaña activa; migración), `services/scheduler.js` (activación por turnos y pausas, solo campaña activa, fases del modo presentación), `services/messaging.js` (plantilla por segmento), `templates/messages.js` (textos por segmento, mensajes de presentación), `services/conversationFlow.js` (alta automática, modo presentación, reserva/asistencia compartidas), `routes/api.js` (campañas, filtros, segmentos, hoja, plantillas), `routes/webhook.js`, `routes/tracking.js`, `routes/zoomWebhook.js`, `routes/webhookWhatsapp.js` (nombre del perfil), `services/activityLog.js`, `services/backupDb.js` (copia de `campanas.json` y `sheets_state.json`), `server.js`, `public/monitor.html` (selector de campaña, filas por segmento con pausa, filtro y badge de segmento, datos del formulario en el lead, importador con segmentos), `.env.example`.

Compatibilidad: los leads existentes pasan a la campaña `prueba_sep26` al arrancar (después de restaurar la copia de Postgres). Nada se borra.
