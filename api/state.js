/* Estado de Toma28P persistido en Neon (Postgres).
   GET  /api/state           -> { doc, version, updatedAt }
   PUT  /api/state {doc,version} -> { version, updatedAt } | 409 { doc, version }

   El documento completo se guarda como una sola fila jsonb. La escritura usa
   bloqueo optimista por "version": si otra persona guardó antes, devolvemos 409
   con la versión ganadora para que el cliente se resincronice sin perder datos. */

const store = require('./_lib/store.js');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const sql = store.getSql();
  if (!sql) {
    return res.status(500).json({ error: store.MISSING_DB_MESSAGE });
  }

  try {
    await store.ensureSchema(sql);

    if (req.method === 'GET') {
      return res.status(200).json(await store.readCurrent(sql));
    }

    if (req.method === 'PUT') {
      let body = req.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch (e) { body = null; }
      }
      if (!body || typeof body.doc !== 'object' || body.doc === null) {
        return res.status(400).json({ error: 'Cuerpo inválido: se esperaba { doc, version }.' });
      }
      // Sin versión conocida no escribimos: sería pisar el estado ajeno a ciegas.
      if (body.version === null || body.version === undefined) {
        return res.status(409).json(await store.readCurrent(sql));
      }

      const rows = await sql`
        update app_state
           set doc = ${JSON.stringify(body.doc)}::jsonb,
               version = version + 1,
               updated_at = now()
         where id = 1 and version = ${Number(body.version)}
        returning version, updated_at`;

      if (!rows.length) {
        return res.status(409).json(await store.readCurrent(sql));
      }
      return res.status(200).json({
        version: Number(rows[0].version),
        updatedAt: rows[0].updated_at
      });
    }

    res.setHeader('Allow', 'GET, PUT');
    return res.status(405).json({ error: 'Método no permitido.' });

  } catch (err) {
    console.error('api/state:', err);
    return res.status(500).json({
      error: 'Error de base de datos.',
      detail: String((err && err.message) || err)
    });
  }
};
