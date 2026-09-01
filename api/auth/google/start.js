/* Arranca el flujo de OAuth: manda a la pantalla de consentimiento de Google.
   GET /api/auth/google/start */

const g = require('../../_lib/google.js');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Método no permitido.' });
  }

  if (!g.isConfigured()) {
    return res.status(500).json({
      error: 'Faltan GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET en las variables de entorno de Vercel.'
    });
  }

  const state = g.newState();
  const secure = (req.headers['x-forwarded-proto'] || 'https') === 'https';
  res.setHeader('Set-Cookie',
    'toma28p_oauth=' + encodeURIComponent(state) +
    '; Path=/; Max-Age=600; HttpOnly; SameSite=Lax' + (secure ? '; Secure' : ''));

  res.writeHead(302, { Location: g.authorizeUrl(req, state) });
  res.end();
};
