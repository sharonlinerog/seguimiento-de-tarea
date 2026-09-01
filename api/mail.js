/* Notificaciones por correo de Toma28P.

   GET    /api/mail  -> { configured, connected, email, name, connectedAt, lastError }
   POST   /api/mail  -> { taskId, personId } : envía y devuelve { sentAt, from, to }
   DELETE /api/mail  -> desconecta la cuenta remitente

   El cuerpo del correo se arma AQUÍ a partir de la tarea guardada en la base, no
   con lo que mande el navegador: así este endpoint no se puede usar para enviar
   texto arbitrario a direcciones arbitrarias. El destinatario además tiene que
   ser una persona registrada en el equipo. */

const g = require('./_lib/google.js');
const store = require('./_lib/store.js');

const PRIORITY_LABELS = { alta: 'Alta', media: 'Media', baja: 'Baja' };
const MONTHS_ES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

function fmtDate(iso) {
  if (!iso) return '';
  const parts = String(iso).slice(0, 10).split('-');
  if (parts.length !== 3) return String(iso);
  const month = MONTHS_ES[Number(parts[1]) - 1] || parts[1];
  return Number(parts[2]) + ' ' + month + ' ' + parts[0];
}

function subjectFor(task) {
  return 'Nueva tarea asignada: ' + task.title;
}

function bodyFor(task, person, doc, appUrl) {
  const project = (doc.projects || []).find(function (p) { return p.id === task.project; });
  const details = [
    'Tarea: ' + task.title,
    'Proyecto: ' + (project ? project.name : 'Sin proyecto'),
    'Prioridad: ' + (PRIORITY_LABELS[task.priority] || task.priority || 'Media')
  ];
  if (task.startDate) details.push('Fecha de inicio: ' + fmtDate(task.startDate));
  details.push('Fecha límite: ' + (task.dueDate ? fmtDate(task.dueDate) : 'Sin definir'));

  const lines = [
    'Hola ' + (person.name || '') + ',',
    '',
    'Se te asignó una tarea en Toma28P:',
    '',
    details.join('\n')
  ];
  if (task.description) lines.push('', 'Descripción:', task.description);
  if (appUrl) lines.push('', 'Ábrela en Toma28P: ' + appUrl);
  return lines.join('\n');
}

function statusPayload(sender) {
  return {
    configured: g.isConfigured(),
    connected: Boolean(sender),
    email: sender ? sender.email : null,
    name: sender ? (sender.name || null) : null,
    connectedAt: sender ? sender.connected_at : null,
    lastError: sender ? (sender.last_error || null) : null
  };
}

function readBody(req) {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = null; }
  }
  return body && typeof body === 'object' ? body : null;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const sql = store.getSql();
  if (!sql) return res.status(500).json({ error: store.MISSING_DB_MESSAGE });

  try {
    await store.ensureSchema(sql);

    if (req.method === 'GET') {
      return res.status(200).json(statusPayload(await store.readSender(sql)));
    }

    if (req.method === 'DELETE') {
      await store.deleteSender(sql);
      return res.status(200).json(statusPayload(null));
    }

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST, DELETE');
      return res.status(405).json({ error: 'Método no permitido.' });
    }

    /* ---- envío ---- */

    if (!g.isConfigured()) {
      return res.status(503).json({
        code: 'not_configured',
        error: 'El envío de correo no está configurado: faltan GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET en Vercel.'
      });
    }

    const body = readBody(req);
    if (!body || !body.taskId) {
      return res.status(400).json({ error: 'Cuerpo inválido: se esperaba { taskId, personId }.' });
    }

    const sender = await store.readSender(sql);
    if (!sender) {
      return res.status(409).json({
        code: 'not_connected',
        error: 'No hay una cuenta de Google conectada para enviar. Conéctala en Ajustes.'
      });
    }

    const current = await store.readCurrent(sql);
    const doc = current.doc || {};
    const task = (doc.tasks || []).find(function (t) { return t.id === body.taskId; });
    if (!task) {
      return res.status(404).json({ error: 'La tarea no existe en la base de datos. Guarda los cambios y reintenta.' });
    }

    const personId = body.personId || task.assignee;
    const person = (doc.people || []).find(function (p) { return p.id === personId; });
    if (!person || !person.email) {
      return res.status(400).json({ error: 'La tarea no tiene a nadie asignado con correo registrado.' });
    }

    let accessToken;
    try {
      const refreshed = await g.refreshAccessToken(sender.refresh_token);
      accessToken = refreshed.access_token;
      if (!accessToken) throw new Error('Google no devolvió un access_token.');
    } catch (err) {
      /* invalid_grant = el permiso fue revocado o caducó (pasa cada 7 días
         mientras la app de Google Cloud siga en modo "Testing"). Hay que
         reconectar la cuenta: lo dejamos anotado para que la UI lo muestre. */
      const revoked = err.googleError === 'invalid_grant';
      const message = revoked
        ? 'El permiso de Google caducó o fue revocado. Vuelve a conectar la cuenta en Ajustes.'
        : ('Google rechazó la renovación del permiso: ' + err.message);
      await store.setSenderError(sql, message);
      return res.status(409).json({ code: revoked ? 'needs_reauth' : 'refresh_failed', error: message });
    }

    try {
      await g.sendMail(accessToken, {
        from: sender.email,
        fromName: sender.name || 'Toma28P',
        to: person.email,
        toName: person.name || '',
        subject: subjectFor(task),
        body: bodyFor(task, person, doc, g.originOf(req) + '/'),
        replyTo: sender.email
      });
    } catch (err) {
      const message = 'Gmail no pudo enviar el correo: ' + err.message;
      await store.setSenderError(sql, message);
      return res.status(502).json({ code: 'send_failed', error: message });
    }

    await store.clearSenderError(sql);
    return res.status(200).json({
      sentAt: new Date().toISOString(),
      from: sender.email,
      to: person.email,
      toName: person.name || ''
    });

  } catch (err) {
    console.error('api/mail:', err);
    return res.status(500).json({
      error: 'Error del servidor de correo.',
      detail: String((err && err.message) || err)
    });
  }
};
