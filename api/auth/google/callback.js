/* Vuelta de Google: canjea el código, guarda el refresh_token y regresa a la app.
   GET /api/auth/google/callback?code=...&state=...

   Nunca devolvemos tokens al navegador: solo un parámetro en la URL que la app
   usa para mostrar el aviso de "cuenta conectada" o el motivo del fallo. */

const g = require('../../_lib/google.js');
const store = require('../../_lib/store.js');

function backToApp(req, res, params) {
  const qs = new URLSearchParams(params).toString();
  const secure = (req.headers['x-forwarded-proto'] || 'https') === 'https';
  res.setHeader('Set-Cookie',
    'toma28p_oauth=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax' + (secure ? '; Secure' : ''));
  res.writeHead(302, { Location: g.originOf(req) + '/?' + qs });
  res.end();
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Método no permitido.' });
  }

  const query = req.query || {};

  // El usuario pudo cancelar en la pantalla de Google.
  if (query.error) {
    return backToApp(req, res, { correo: 'error', motivo: String(query.error) });
  }
  if (!query.code || !query.state) {
    return backToApp(req, res, { correo: 'error', motivo: 'respuesta_incompleta' });
  }

  // El state tiene que venir firmado por nosotros Y coincidir con la cookie.
  const cookies = g.parseCookies(req);
  if (!g.verifyState(String(query.state)) || cookies.toma28p_oauth !== String(query.state)) {
    return backToApp(req, res, { correo: 'error', motivo: 'state_invalido' });
  }

  const sql = store.getSql();
  if (!sql) {
    return backToApp(req, res, { correo: 'error', motivo: 'sin_base_de_datos' });
  }

  try {
    const tokens = await g.exchangeCode(req, String(query.code));
    const profile = g.decodeIdToken(tokens.id_token);
    const email = profile.email || '';

    if (!email) {
      return backToApp(req, res, { correo: 'error', motivo: 'sin_correo' });
    }
    // Sin refresh_token solo podríamos enviar durante la hora siguiente. Pasa si
    // la cuenta ya había autorizado y Google decidió no reemitirlo.
    if (!tokens.refresh_token) {
      return backToApp(req, res, { correo: 'error', motivo: 'sin_refresh_token' });
    }
    // Si el permiso de envío no quedó otorgado, mejor avisar ahora que fallar al enviar.
    if (String(tokens.scope || '').indexOf('gmail.send') === -1) {
      return backToApp(req, res, { correo: 'error', motivo: 'sin_permiso_envio' });
    }

    await store.ensureSchema(sql);
    await store.saveSender(sql, {
      email: email,
      name: profile.name || '',
      refreshToken: tokens.refresh_token
    });

    return backToApp(req, res, { correo: 'conectado', cuenta: email });

  } catch (err) {
    console.error('auth/google/callback:', err);
    return backToApp(req, res, {
      correo: 'error',
      motivo: err.googleError || 'fallo_al_canjear'
    });
  }
};
