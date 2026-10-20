const handler = require('../server');

module.exports = async function vercelHandler(req, res) {
  // vercel.json funnels every /api/* request into this one function. Restore
  // the original route so the existing backend can handle it unchanged.
  const url = new URL(req.url, 'http://localhost');
  const routedPath = req.query?.path ?? req.query?.__path
    ?? url.searchParams.get('path') ?? url.searchParams.get('__path');

  if (routedPath !== null) {
    url.searchParams.delete('path');
    url.searchParams.delete('__path');
    const params = new URLSearchParams(url.searchParams);
    for (const [key, value] of Object.entries(req.query || {})) {
      if (key === 'path' || key === '__path') continue;
      params.delete(key);
      for (const item of Array.isArray(value) ? value : [value]) params.append(key, String(item));
    }
    const query = params.toString();
    req.url = `/api/${String(routedPath).replace(/^\/+/, '')}${query ? `?${query}` : ''}`;
  }

  return handler(req, res);
};
