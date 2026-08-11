const http = require('http');
const https = require('https');
const url = require('url');

const PORT = process.env.PORT || 3001;

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const targetUrl = req.url.slice(1);
  if (!targetUrl) {
    res.writeHead(400);
    res.end('No target URL provided');
    return;
  }

  let parsedUrl;
  try {
    parsedUrl = url.parse(decodeURIComponent(targetUrl));
  } catch (e) {
    res.writeHead(400);
    res.end('Invalid URL');
    return;
  }

  const isHttps = parsedUrl.protocol === 'https:';
  const lib = isHttps ? https : http;

  const options = {
    hostname: parsedUrl.hostname,
    port: parsedUrl.port || (isHttps ? 443 : 80),
    path: parsedUrl.path,
    method: req.method,
    headers: {}
  };

  const forwardHeaders = [
    'x-application', 'x-authentication', 'content-type', 'accept',
    'from', 'x-partner',
    'x-api-key',
    'authorization'
  ];
  forwardHeaders.forEach(h => {
    if (req.headers[h]) options.headers[h] = req.headers[h];
  });

  const proxyReq = lib.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, {
      'Access-Control-Allow-Origin': '*',
      'Content-Type': proxyRes.headers['content-type'] || 'application/json'
    });
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    console.error('Proxy error:', err.message);
    res.writeHead(500);
    res.end(JSON.stringify({ error: err.message }));
  });

  if (req.method === 'POST') {
    req.pipe(proxyReq);
  } else {
    proxyReq.end();
  }
});

server.listen(PORT, () => {
  console.log(`Form Lab Proxy running on port ${PORT}`);
});
