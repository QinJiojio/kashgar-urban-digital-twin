import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const certDir = path.resolve(__dirname, '..', 'certs');

const options = {
  key: fs.readFileSync(path.join(certDir, 'server.key')),
  cert: fs.readFileSync(path.join(certDir, 'server.crt'))
};

const HTTPS_PORT = 3443;
const TARGET_PORT = 3000;

https.createServer(options, (req, res) => {
  const proxyReq = http.request({
    hostname: 'localhost',
    port: TARGET_PORT,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, 'x-forwarded-proto': 'https' }
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });
  req.pipe(proxyReq);
  proxyReq.on('error', (e) => {
    res.writeHead(502);
    res.end('Proxy error: ' + e.message);
  });
}).listen(HTTPS_PORT, () => {
  console.log('[https-proxy] HTTPS ready: https://localhost:' + HTTPS_PORT);
});
