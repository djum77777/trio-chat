const handler = require('../server');

module.exports = async function vercelHandler(req, res) {
  // vercel.json funnels every /api/* request into this one function. Restore
  // the original route so the existing backend can handle it unchanged.
  const url = new URL(req.url, 'http://localhost');
  const routedPath = url.searchParams.get('__path');

  if (routedPath !== null) {
    url.searchParams.delete('__path');
    const query = url.searchParams.toString();
    req.url = `/api/${routedPath}${query ? `?${query}` : ''}`;
  }

  return handler(req, res);
};
