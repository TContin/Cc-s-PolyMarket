const http = require('http');
const https = require('https');
const url = require('url');

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  if (!parsed.pathname.startsWith('/api/markets')) {
    res.writeHead(404); res.end('not found'); return;
  }

  // merge default params
  const q = Object.assign({
    limit: '50', active: 'true', closed: 'false',
    order: 'volume24hr', ascending: 'false'
  }, parsed.query);

  const qs = new URLSearchParams(q).toString();
  const upstream = `https://gamma-api.polymarket.com/markets?${qs}`;

  https.get(upstream, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (uRes) => {
    res.writeHead(uRes.statusCode, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=30'
    });
    uRes.pipe(res);
  }).on('error', e => {
    res.writeHead(502); res.end(JSON.stringify({ error: e.message }));
  });
});

server.listen(3721, '127.0.0.1', () => console.log('proxy on :3721'));
