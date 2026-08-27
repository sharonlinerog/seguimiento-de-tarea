/* Estado de Toma28P persistido en Neon (Postgres).
   GET  /api/state           -> { doc, version, updatedAt }
   PUT  /api/state {doc,version} -> { version, updatedAt } | 409 { doc, version }

   El documento completo se guarda como una sola fila jsonb. La escritura usa
   bloqueo optimista por "version": si otra persona guardó antes, devolvemos 409
   con la versión ganadora para que el cliente se resincronice sin perder datos. */

const { neon } = require('@neondatabase/serverless');

const DEFAULT_DOC = {
  people: [],
  projects: [
    { id: 'proj_diseno',      name: 'Diseño',                 colorVar: '--cat-1' },
    { id: 'proj_audiovisual', name: 'Audiovisual',            colorVar: '--cat-2' },
    { id: 'proj_experiencia', name: 'Experiencia de producto', colorVar: '--cat-3' },
    { id: 'proj_servicio',    name: 'Servicio al cliente',    colorVar: '--cat-4' }
  ],
  boards: [{ id: 'board_general', name: 'General' }],
  tasks: [],
  updatedAt: null
};

// La integración Neon de Vercel inyecta DATABASE_URL; aceptamos alias por si acaso.
function connectionString() {
  return process.env.DATABASE_URL
    || process.env.POSTGRES_URL
    || process.env.NEON_DATABASE_URL
    || process.env.DATABASE_URL_UNPOOLED
    || '';
}

async function ensureSchema(sql) {
  await sql`
    create table if not exists app_state (
      id         integer primary key,
      doc        jsonb       not null,
      version    bigint      not null default 1,
      updated_at timestamptz not null default now()
    )`;
  await sql`
    insert into app_state (id, doc, version)
    values (1, ${JSON.stringify(DEFAULT_DOC)}::jsonb, 1)
    on conflict (id) do nothing`;
}

async function readCurrent(sql) {
  const rows = await sql`select doc, version, updated_at from app_state where id = 1`;
  const row = rows[0];
  if (!row) return { doc: DEFAULT_DOC, version: 0, updatedAt: null };
  return { doc: row.doc, version: Number(row.version), updatedAt: row.updated_at };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const cs = connectionString();
  if (!cs) {
    return res.status(500).json({
      error: 'Falta la variable de entorno DATABASE_URL. Conecta la base de Neon en Vercel (Storage) y vuelve a desplegar.'
    });
  }

  const sql = neon(cs);

  try {
    await ensureSchema(sql);

    if (req.method === 'GET') {
      return res.status(200).json(await readCurrent(sql));
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
        return res.status(409).json(await readCurrent(sql));
      }

      const rows = await sql`
        update app_state
           set doc = ${JSON.stringify(body.doc)}::jsonb,
               version = version + 1,
               updated_at = now()
         where id = 1 and version = ${Number(body.version)}
        returning version, updated_at`;

      if (!rows.length) {
        return res.status(409).json(await readCurrent(sql));
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
