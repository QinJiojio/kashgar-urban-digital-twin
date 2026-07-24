import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import https from 'https';
import dns from 'dns';
import { fileURLToPath } from 'url';
import { HttpsProxyAgent } from 'https-proxy-agent';

// 必须在任何读取 process.env 的模块之前加载 .env
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env') });

// 绕过代理软件 DNS 劫持，天地图等国内域名走公共 DNS 直连
dns.setServers(['223.5.5.5', '119.29.29.29']);
const proxyAgent = new HttpsProxyAgent('http://127.0.0.1:7890');

// 动态导入，确保 dotenv 已初始化
const [
  { default: express },
  { default: cors },
  { default: compression },
  layersModule, filesModule, featuresModule, schemaModule, locksModule, usersModule, authModule, uploadModule
] = await Promise.all([
  import('express'),
  import('cors'),
  import('compression'),
  import('./routes/layers.js'),
  import('./routes/files.js'),
  import('./routes/features.js'),
  import('./routes/schema.js'),
  import('./routes/locks.js'),
  import('./routes/users.js'),
  import('./routes/auth.js'),
  import('./routes/upload.js')
]);

const { info, error: logError } = await import('./logger.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || 'D:/cesium-mvp-data';
const PORT = process.env.SERVER_PORT || 3000;
const CLIENT_DIST = path.resolve(__dirname, '..', 'client', 'dist');

const app = express();

// 信任隧道代理（Sakura Frp / natapp）传入的 X-Forwarded-For，确保 rate-limit 按真实 IP 计数
app.set('trust proxy', 1);

const allowedOrigins = [
  /^https?:\/\/localhost(:\d+)?$/,
  /^https?:\/\/192\.168\.\d+\.\d+(:\d+)?$/,
  /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
  /\.trycloudflare\.com$/
];

app.use(compression());
app.use(cors({
  origin: (origin, callback) => {
    // 同源请求（无 origin header）允许通过
    if (!origin) return callback(null, true);
    const allowed = allowedOrigins.some(pattern => pattern.test(origin));
    if (!allowed) return callback(null, false);
    callback(null, true);
  }
}));
app.use(express.json({ limit: '50mb' }));

// 公开路由
app.use('/api', authModule.default);
app.use('/api', layersModule.default);
app.use('/api', filesModule.default);

// 数据修改路由（各路由内部已有认证中间件保护）
app.use('/api', featuresModule.default);
app.use('/api', schemaModule.default);
app.use('/api', locksModule.default);
app.use('/api', uploadModule.default);
app.use('/api', usersModule.default);

// GeoJSON/JSON 文件：不缓存，实时 zlib 流式压缩（每次读取最新数据）
const { createGzip } = await import('zlib');
app.use('/data', (req, res, next) => {
  if (req.path.endsWith('.geojson') || (req.path.endsWith('.json') && !req.path.includes('tileset'))) {
    const filePath = path.join(DATA_DIR, decodeURIComponent(req.path));
    const doGzip = (req.headers['accept-encoding'] || '').includes('gzip');
    if (doGzip) {
      res.setHeader('Content-Type', 'application/json; charset=UTF-8');
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Vary', 'Accept-Encoding');
      const stream = fs.createReadStream(filePath);
      // 文件缺失/读取失败时必须拦截 error 事件——未监听的 stream error 会崩溃整个进程（教训 #59 同原则）
      // 已设置的 gzip 头需移除，否则客户端按 gzip 解码 404 明文响应会报解码错误
      stream.on('error', () => {
        res.removeHeader('Content-Encoding');
        if (!res.headersSent) res.status(404).json({ error: '数据文件不存在' });
        stream.destroy();
      });
      stream.pipe(createGzip()).pipe(res);
    } else {
      express.static(DATA_DIR, { etag: false, lastModified: false, setHeaders: (r) => r.setHeader('Cache-Control', 'no-store') })(req, res, next);
    }
  } else {
    next();
  }
});

// 3D Tiles 等其他静态文件：允许缓存
app.use('/data', express.static(DATA_DIR, { maxAge: '1d' }));

// 前端静态文件（build 产物）
app.use(express.static(CLIENT_DIST, { maxAge: '1d' }));

// ---- 瓦片代理缓存 ----
const TILE_CACHE_DIR = path.resolve(DATA_DIR, '..', 'cesium-mvp-data-cache', 'tiles');
const TIANDITU_TK = process.env.VITE_TIANDITU_TK || '';

const _fetchTile = (url, headers) => new Promise((resolve, reject) => {
  const u = new URL(url);
  https.get({ hostname: u.hostname, path: u.pathname + u.search, agent: proxyAgent, headers }, res => {
    if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
    const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve(Buffer.concat(chunks)));
  }).on('error', reject);
});

// 256×256 全透明 PNG (用于叠加层瓦片缺失时透出底层)
const TRANSPARENT_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAYAAABccqhmAAAACXBIWXMAAAPoAAAD6AG1e1JrAAABFUlEQVR4nO3BMQEAAADCoPVP7WsIoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA6AwBPAABo9vSmwAAAABJRU5ErkJggg==', 'base64');

// 检测 buffer 是否为合法图片（通过 magic bytes），避免 CDN 返回 HTML 错误页被当作图片渲染
const isValidImage = (buf) => {
  if (!buf || buf.length < 4) return false;
  const h = buf.slice(0, 4).toString('hex');
  return h === '89504e47' || h.startsWith('ffd8') || h === '47494638' || h.startsWith('52494646');
};

const _serveOrFetch = (cachePath, cdnUrl, cdnHeaders, res, opts = {}) => {
  const contentType = opts.contentType || 'image/jpeg';
  const transparentFallback = opts.transparentFallback || false;
  const validateImage = opts.validateImage || false; // 检查 CDN 响应是否是合法图片（非 HTML 错误页）

  if (fs.existsSync(cachePath))
    return res.set({ 'Content-Type': contentType, 'Cache-Control': 'public, max-age=604800', 'X-Tile-Cache': 'HIT' }).sendFile(cachePath);

  _fetchTile(cdnUrl, cdnHeaders).then(buf => {
    // 图片合法性检测：CDN 可能返回 HTML 错误页而非图片
    if (validateImage && !isValidImage(buf)) {
      res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600', 'X-Tile-Cache': 'INVALID' }).send(TRANSPARENT_PNG);
      return;
    }
    res.set({ 'Content-Type': contentType, 'Cache-Control': 'public, max-age=604800', 'X-Tile-Cache': 'MISS' }).send(buf);
    fs.promises.mkdir(path.dirname(cachePath), { recursive: true }).then(() => fs.promises.writeFile(cachePath, buf)).catch(() => {});
  }).catch(e => {
    if (transparentFallback) {
      res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600', 'X-Tile-Cache': 'TRANSPARENT' }).send(TRANSPARENT_PNG);
    } else {
      res.status(502).json({ error: e.message });
    }
  });
};

// 瓦片参数校验：防止路径遍历
const _validTile = (p, hasStyle) => {
  if (!/^\d+$/.test(p.z) || !/^\d+$/.test(p.x) || !/^\d+$/.test(p.y)) return false;
  if (hasStyle && !/^[a-z_]+$/.test(p.style)) return false;
  return true;
};

// 天地图瓦片（卫星 img_w / 矢量底图 vec_w / 注记 cva_w / 卫星注记 cia_w）
// 注记层(cva_w, cia_w)是透明 PNG，CDN 无瓦片时返回空白（小体积或 HTTP 错误），此时返回透明 PNG 透出底层
app.get('/tiles/tianditu/:style/:z/:x/:y', (req, res) => {
  if (!_validTile(req.params, true)) return res.status(400).json({ error: '参数非法' });
  const { style, z, x, y } = req.params;
  const isAnno = style === 'cva_w' || style === 'cia_w';
  const ext = isAnno ? 'png' : 'jpg';
  const cachePath = path.join(TILE_CACHE_DIR, style, z, x, `${y}.${ext}`);
  const layer = style.replace('_w', ''); // img_w→img, vec_w→vec, cva_w→cva, cia_w→cia
  const cdnUrl = `https://t0.tianditu.gov.cn/${style}/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${layer}&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX=${z}&TILEROW=${y}&TILECOL=${x}&tk=${TIANDITU_TK}`;
  _serveOrFetch(cachePath, cdnUrl,
    { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.tianditu.gov.cn/', 'Accept': 'image/*' },
    res,
    { contentType: isAnno ? 'image/png' : 'image/jpeg',
      transparentFallback: isAnno,
      validateImage: isAnno });
});

// Google 瓦片（s=卫星, y=混合）
app.get('/tiles/google/:style/:z/:x/:y', (req, res) => {
  if (!_validTile(req.params, true)) return res.status(400).json({ error: '参数非法' });
  const { style, z, x, y } = req.params;
  const cachePath = path.join(TILE_CACHE_DIR, 'google_' + style, z, x, `${y}.jpg`);
  const cdnUrl = `https://mt1.google.com/vt/lyrs=${style}&x=${x}&y=${y}&z=${z}`;
  _serveOrFetch(cachePath, cdnUrl, { 'User-Agent': 'Mozilla/5.0' }, res);
});

// ArcGIS 卫星影像
app.get('/tiles/arcgis/satellite/:z/:x/:y', (req, res) => {
  if (!_validTile(req.params)) return res.status(400).json({ error: '参数非法' });
  const { z, x, y } = req.params;
  const cachePath = path.join(TILE_CACHE_DIR, 'arcgis_satellite', z, x, `${y}.jpg`);
  const cdnUrl = `https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
  _serveOrFetch(cachePath, cdnUrl, { 'User-Agent': 'Mozilla/5.0', 'Accept': 'image/*' }, res);
});

// ArcGIS 街道地图
app.get('/tiles/arcgis/street/:z/:x/:y', (req, res) => {
  if (!_validTile(req.params)) return res.status(400).json({ error: '参数非法' });
  const { z, x, y } = req.params;
  const cachePath = path.join(TILE_CACHE_DIR, 'arcgis_street', z, x, `${y}.png`);
  const cdnUrl = `https://services.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/${z}/${y}/${x}`;
  _serveOrFetch(cachePath, cdnUrl, { 'User-Agent': 'Mozilla/5.0', 'Accept': 'image/*' }, res, { contentType: 'image/png' });
});

// 高德卫星影像
app.get('/tiles/amap/satellite/:z/:x/:y', (req, res) => {
  if (!_validTile(req.params)) return res.status(400).json({ error: '参数非法' });
  const { z, x, y } = req.params;
  const cachePath = path.join(TILE_CACHE_DIR, 'amap_satellite', z, x, `${y}.jpg`);
  const cdnUrl = `https://webst02.is.autonavi.com/appmaptile?style=6&x=${x}&y=${y}&z=${z}`;
  _serveOrFetch(cachePath, cdnUrl, { 'User-Agent': 'Mozilla/5.0', 'Accept': 'image/*' }, res);
});

// 高德矢量地图
app.get('/tiles/amap/vector/:z/:x/:y', (req, res) => {
  if (!_validTile(req.params)) return res.status(400).json({ error: '参数非法' });
  const { z, x, y } = req.params;
  const cachePath = path.join(TILE_CACHE_DIR, 'amap_vector', z, x, `${y}.png`);
  const cdnUrl = `https://webrd02.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x=${x}&y=${y}&z=${z}`;
  _serveOrFetch(cachePath, cdnUrl, { 'User-Agent': 'Mozilla/5.0', 'Accept': 'image/*' }, res, { contentType: 'image/png' });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// SPA fallback：非 /api /data /tiles 请求返回 index.html
app.get('*', (req, res) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/data') || req.path.startsWith('/tiles')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.sendFile(path.join(CLIENT_DIST, 'index.html'));
});

const httpServer = app.listen(PORT, () => {
  info('server', `数据服务已启动: http://localhost:${PORT}`);
  info('server', `数据目录: ${DATA_DIR}`);
});
httpServer.on('error', (err) => {
  logError('server', `HTTP 启动失败 (端口 ${PORT}): ${err.message}`);
  process.exit(1);
});

// HTTPS（供内网穿透隧道使用，自签名证书在 Sakura→本地之间加密）
const HTTPS_PORT = process.env.HTTPS_PORT || 3443;
const keyPath = path.resolve(__dirname, 'key.pem');
const certPath = path.resolve(__dirname, 'cert.pem');
if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
  const httpsServer = https.createServer({
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath)
  }, app);
  httpsServer.listen(HTTPS_PORT, () => {
    info('server', `HTTPS 服务已启动: https://localhost:${HTTPS_PORT}`);
  });
  httpsServer.on('error', (err) => {
    logError('server', `HTTPS 启动失败 (端口 ${HTTPS_PORT}): ${err.message}`);
  });
}

// layer-config.json 定期快照（每 10 分钟检查，内容有变化且距上次备份 > 1h 才写盘）
let _lastConfigBackupTime = 0;
let _lastConfigBackupHash = '';
setInterval(async () => {
  try {
    const configPath = path.resolve(DATA_DIR, 'layer-config.json');
    if (!fs.existsSync(configPath)) return;
    const now = Date.now();
    if (now - _lastConfigBackupTime < 3600000) return;
    const hash = crypto.createHash('sha256').update(fs.readFileSync(configPath)).digest('hex');
    if (hash === _lastConfigBackupHash) return;
    const { backupConfig } = await import('./routes/features.js');
    await backupConfig('periodic', 'system');
    _lastConfigBackupTime = now;
    _lastConfigBackupHash = hash;
  } catch (_) { /* 后台静默，不影响主服务 */ }
}, 600000);
