# Configurar las notificaciones por correo

Toma28P avisa por correo a la persona responsable cuando se le asigna una tarea.
El correo se envía con la **cuenta de Google que se conecte en Ajustes**, usando la
API de Gmail. Esta guía cubre lo que hay que hacer una sola vez.

Resumen: crear un cliente OAuth en Google Cloud → pegar dos variables en Vercel →
entrar a la app y pulsar "Iniciar sesión con Google".

---

## 1. Crear el cliente OAuth en Google Cloud

1. Entra a <https://console.cloud.google.com/> con la cuenta de Google que va a
   enviar los correos (por ejemplo `toma28p@gmail.com`).
2. Crea un proyecto nuevo (arriba a la izquierda, selector de proyecto → "Proyecto
   nuevo"). Nómbralo por ejemplo `Toma28P`.
3. **Habilita la API de Gmail**: menú → *APIs y servicios* → *Biblioteca* → busca
   **Gmail API** → *Habilitar*.
4. **Configura la pantalla de consentimiento**: *APIs y servicios* → *Pantalla de
   consentimiento de OAuth*.
   - Tipo de usuario: **Externo**.
   - Nombre de la app: `Toma28P`. Correo de asistencia: el tuyo.
   - En **Permisos** (scopes), agrega manualmente:
     `https://www.googleapis.com/auth/gmail.send`
   - En **Usuarios de prueba**, agrega el correo de la cuenta que enviará los
     correos. Esto es importante: mientras la app esté en modo *Testing*, solo las
     cuentas de esa lista pueden autorizarla.
5. **Crea las credenciales**: *APIs y servicios* → *Credenciales* → *Crear
   credenciales* → **ID de cliente de OAuth**.
   - Tipo de aplicación: **Aplicación web**.
   - Nombre: `Toma28P web`.
   - En **URI de redirección autorizados**, agrega exactamente:

     ```
     https://seguimiento-de-tarea.vercel.app/api/auth/google/callback
     ```

     Si usas un dominio propio, agrega también su versión equivalente.
   - Guarda y copia el **ID de cliente** y el **Secreto de cliente**.

## 2. Poner las variables en Vercel

En el proyecto de Vercel → *Settings* → *Environment Variables*, agrega:

| Nombre | Valor |
|---|---|
| `GOOGLE_CLIENT_ID` | el ID de cliente que copiaste (termina en `.apps.googleusercontent.com`) |
| `GOOGLE_CLIENT_SECRET` | el secreto de cliente |

Marca los tres entornos (Production, Preview, Development) y **vuelve a
desplegar** el proyecto para que las variables tomen efecto.

`DATABASE_URL` ya debe existir por la integración de Neon; si no, conecta la base
en *Storage*.

Opcional: `GOOGLE_REDIRECT_URI` fuerza la URI de redirección a un valor fijo. Sin
ella, se deduce del dominio de la petición, lo cual es lo correcto en casi todos
los casos.

## 3. Conectar la cuenta

1. Abre <https://seguimiento-de-tarea.vercel.app/> → **Ajustes**.
2. Pulsa **Iniciar sesión con Google** y entra con la cuenta que enviará los correos.
3. Google mostrará un aviso de que la app no está verificada: *Configuración
   avanzada* → *Ir a Toma28P (no seguro)*. Es tu propia app, por eso aparece.
4. Acepta el permiso de **enviar correo en tu nombre**. Sin esa casilla no se
   puede enviar nada.
5. Al volver, Ajustes debe mostrar **Conectada** con el correo de la cuenta.

Desde ese momento, cada vez que asignes una tarea a alguien nuevo se envía el
aviso automáticamente, y en cada tarea aparece el botón **Enviar correo** para
reenviarlo.

---

## Importante: el permiso caduca cada 7 días en modo "Testing"

Mientras la app de Google Cloud siga como *Testing*, Google invalida el permiso a
los **7 días**. Cuando pase, la app lo dirá con claridad ("El permiso de Google
caducó o fue revocado") y basta con volver a **Ajustes → Cambiar de cuenta** para
reconectar.

Para que el permiso sea permanente hay que **publicar** la app en la pantalla de
consentimiento (*Publicar app*). Como `gmail.send` es un permiso sensible, Google
pide un proceso de verificación. Alternativa sin verificación: si la cuenta
pertenece a un **Google Workspace** propio, se puede publicar como *Interna* y el
permiso no caduca.

## Si algo falla

La app traduce los errores de Google a español en Ajustes y en los avisos. Los
más comunes:

| Mensaje | Qué revisar |
|---|---|
| Sin credenciales de Google | Faltan `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` en Vercel, o no se volvió a desplegar |
| la URI de redirección no coincide… | La URI en Google Cloud debe ser idéntica, incluido `https://` y sin barra final |
| no se otorgó el permiso de envío | Hay que marcar la casilla de "enviar correo en tu nombre" al autorizar |
| Google no entregó un permiso permanente | Retira el acceso en <https://myaccount.google.com/permissions> y vuelve a conectar |
| El permiso de Google caducó o fue revocado | Los 7 días del modo *Testing*: reconecta desde Ajustes |
| Sin conexión con la base de datos | Falta `DATABASE_URL` (integración de Neon en Vercel) |

## Cómo está hecho

| Ruta | Qué hace |
|---|---|
| `GET /api/auth/google/start` | Manda a la pantalla de consentimiento de Google |
| `GET /api/auth/google/callback` | Canjea el código, guarda el `refresh_token` y vuelve a la app |
| `GET /api/mail` | Estado de la cuenta remitente (sin tokens) |
| `POST /api/mail` | Envía el aviso de una tarea: `{ taskId, personId }` |
| `DELETE /api/mail` | Desconecta la cuenta remitente |
| `GET/PUT /api/state` | Documento completo del tablero (sin cambios) |

Notas de seguridad:

- El `refresh_token` vive solo en Postgres y nunca se envía al navegador.
- El flujo de OAuth va protegido con un `state` firmado (HMAC) que además se
  compara contra una cookie `HttpOnly`.
- `POST /api/mail` **no acepta texto ni direcciones libres**: arma el correo con
  la tarea guardada en la base y solo escribe a personas registradas en el
  equipo. Así el endpoint no se puede usar para enviar correo arbitrario.
