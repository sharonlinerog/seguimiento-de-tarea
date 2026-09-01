/* Acceso a Postgres (Neon) compartido por todas las funciones de /api.

   Los archivos y carpetas que empiezan por "_" no los publica Vercel como
   funciones: este módulo solo se importa desde las que sí lo son. */

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

const MISSING_DB_MESSAGE =
  'Falta la variable de entorno DATABASE_URL. Conecta la base de Neon en Vercel (Storage) y vuelve a desplegar.';

function getSql() {
  const cs = connectionString();
  if (!cs) return null;
  return neon(cs);
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

  /* Cuenta de Google que envía las notificaciones. Una sola fila (id = 1): el
     equipo comparte un único remitente. El refresh_token NUNCA sale de aquí
     hacia el navegador — solo se usa dentro de las funciones de /api. */
  await sql`
    create table if not exists mail_sender (
      id            integer primary key,
      email         text        not null,
      name          text,
      refresh_token text        not null,
      connected_at  timestamptz not null default now(),
      last_error    text
    )`;
}

async function readCurrent(sql) {
  const rows = await sql`select doc, version, updated_at from app_state where id = 1`;
  const row = rows[0];
  if (!row) return { doc: DEFAULT_DOC, version: 0, updatedAt: null };
  return { doc: row.doc, version: Number(row.version), updatedAt: row.updated_at };
}

async function readSender(sql) {
  const rows = await sql`
    select email, name, refresh_token, connected_at, last_error
      from mail_sender where id = 1`;
  return rows[0] || null;
}

async function saveSender(sql, { email, name, refreshToken }) {
  await sql`
    insert into mail_sender (id, email, name, refresh_token, connected_at, last_error)
    values (1, ${email}, ${name || null}, ${refreshToken}, now(), null)
    on conflict (id) do update
       set email = excluded.email,
           name = excluded.name,
           refresh_token = excluded.refresh_token,
           connected_at = now(),
           last_error = null`;
}

async function setSenderError(sql, message) {
  await sql`update mail_sender set last_error = ${message} where id = 1`;
}

async function clearSenderError(sql) {
  await sql`update mail_sender set last_error = null where id = 1`;
}

async function deleteSender(sql) {
  await sql`delete from mail_sender where id = 1`;
}

module.exports = {
  DEFAULT_DOC,
  MISSING_DB_MESSAGE,
  connectionString,
  getSql,
  ensureSchema,
  readCurrent,
  readSender,
  saveSender,
  setSenderError,
  clearSenderError,
  deleteSender
};
