/* OAuth de Google + envío por la API de Gmail, sin dependencias externas
   (Node 18+ en Vercel ya trae fetch global).

   Flujo: /api/auth/google/start manda a la pantalla de consentimiento con
   access_type=offline, así Google devuelve un refresh_token de larga duración.
   Ese token se guarda en Postgres y con él pedimos un access_token nuevo cada
   vez que hay que enviar un correo. El navegador nunca ve ninguno de los dos. */

const crypto = require('crypto');

const SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/gmail.send'
].join(' ');

const AUTH_ENDPOINT  = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const SEND_ENDPOINT  = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

function clientId()     { return process.env.GOOGLE_CLIENT_ID || ''; }
function clientSecret() { return process.env.GOOGLE_CLIENT_SECRET || ''; }

function isConfigured() {
  return Boolean(clientId() && clientSecret());
}

/* La URI de redirección tiene que coincidir carácter por carácter con la
   registrada en Google Cloud. Por defecto la derivamos del host de la petición
   (así funciona igual en producción y en los deploys de preview), pero
   GOOGLE_REDIRECT_URI permite fijarla a mano si hace falta. */
function redirectUri(req) {
  if (process.env.GOOGLE_REDIRECT_URI) return process.env.GOOGLE_REDIRECT_URI;
  const host  = req.headers['x-forwarded-host'] || req.headers.host || '';
  const proto = req.headers['x-forwarded-proto'] || (host.startsWith('localhost') ? 'http' : 'https');
  return proto + '://' + host + '/api/auth/google/callback';
}

function originOf(req) {
  const host  = req.headers['x-forwarded-host'] || req.headers.host || '';
  const proto = req.headers['x-forwarded-proto'] || (host.startsWith('localhost') ? 'http' : 'https');
  return proto + '://' + host;
}

/* --- protección CSRF del flujo: el "state" va firmado y también en una cookie --- */

function signState(value) {
  const mac = crypto.createHmac('sha256', clientSecret()).update(value).digest('base64url');
  return value + '.' + mac;
}

function verifyState(signed) {
  if (typeof signed !== 'string') return null;
  const dot = signed.lastIndexOf('.');
  if (dot < 1) return null;
  const value = signed.slice(0, dot);
  const expected = signState(value);
  const a = Buffer.from(signed);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return value;
}

function newState() {
  return signState(crypto.randomBytes(16).toString('base64url'));
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  raw.split(';').forEach(function (part) {
    const eq = part.indexOf('=');
    if (eq < 1) return;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  });
  return out;
}

function authorizeUrl(req, state) {
  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: redirectUri(req),
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    // Sin prompt=consent Google omite el refresh_token si la cuenta ya
    // autorizó antes, y entonces no podríamos enviar nada más adelante.
    prompt: 'consent',
    include_granted_scopes: 'true',
    state: state
  });
  return AUTH_ENDPOINT + '?' + params.toString();
}

async function postToken(params) {
  const r = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString()
  });
  const payload = await r.json().catch(function () { return {}; });
  if (!r.ok) {
    const err = new Error(payload.error_description || payload.error || ('HTTP ' + r.status));
    err.googleError = payload.error || '';
    throw err;
  }
  return payload;
}

function exchangeCode(req, code) {
  return postToken({
    code: code,
    client_id: clientId(),
    client_secret: clientSecret(),
    redirect_uri: redirectUri(req),
    grant_type: 'authorization_code'
  });
}

function refreshAccessToken(refreshToken) {
  return postToken({
    refresh_token: refreshToken,
    client_id: clientId(),
    client_secret: clientSecret(),
    grant_type: 'refresh_token'
  });
}

/* El id_token llega directo del endpoint de Google por TLS, así que leemos el
   payload sin verificar la firma: no hubo intermediario que pudiera alterarlo. */
function decodeIdToken(idToken) {
  try {
    const part = String(idToken).split('.')[1];
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch (e) {
    return {};
  }
}

/* --- construcción del mensaje MIME --- */

function encodeHeaderWord(text) {
  const s = String(text == null ? '' : text);
  // Los encabezados solo admiten ASCII; si hay acentos van en base64 (RFC 2047).
  if (!/[^\x20-\x7E]/.test(s)) return s;
  return '=?UTF-8?B?' + Buffer.from(s, 'utf8').toString('base64') + '?=';
}

function formatAddress(email, name) {
  if (!name) return email;
  return encodeHeaderWord(name) + ' <' + email + '>';
}

function buildMime({ from, fromName, to, toName, subject, body, replyTo }) {
  const headers = [
    'From: ' + formatAddress(from, fromName),
    'To: ' + formatAddress(to, toName),
    'Subject: ' + encodeHeaderWord(subject),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64'
  ];
  if (replyTo) headers.push('Reply-To: ' + replyTo);
  const encodedBody = Buffer.from(String(body), 'utf8')
    .toString('base64')
    .replace(/(.{76})/g, '$1\r\n');
  return headers.join('\r\n') + '\r\n\r\n' + encodedBody;
}

async function sendMail(accessToken, message) {
  const raw = Buffer.from(buildMime(message), 'utf8').toString('base64url');
  const r = await fetch(SEND_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + accessToken,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ raw: raw })
  });
  const payload = await r.json().catch(function () { return {}; });
  if (!r.ok) {
    const detail = (payload.error && (payload.error.message || payload.error.status)) || ('HTTP ' + r.status);
    const err = new Error(detail);
    err.status = r.status;
    throw err;
  }
  return payload;
}

module.exports = {
  SCOPES,
  clientId,
  clientSecret,
  isConfigured,
  redirectUri,
  originOf,
  newState,
  verifyState,
  parseCookies,
  authorizeUrl,
  exchangeCode,
  refreshAccessToken,
  decodeIdToken,
  buildMime,
  sendMail
};
