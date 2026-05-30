'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const express = require('express');
const multer = require('multer');
const archiver = require('archiver');
const QRCode = require('qrcode');

const VERSION = '1.1.0';
const PORT = Number(process.env.PORT || 3000);
const TTL_HOURS = clampNumber(process.env.TTL_HOURS, 1, 24, 24);
const MAX_UPLOAD_MB = clampNumber(process.env.MAX_UPLOAD_MB, 1, 500, 150);
const MAX_FILES_PER_ALBUM = clampNumber(process.env.MAX_FILES_PER_ALBUM, 1, 2000, 500);
const MAX_ALBUM_MB = clampNumber(process.env.MAX_ALBUM_MB, 1, 10000, 2000);
const PUBLIC_BASE_URL = sanitizeBaseUrl(process.env.PUBLIC_BASE_URL || '');
const BASE_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'data');
const INDEX_PATH = path.join(BASE_DIR, 'index.json');
const ALBUMS_DIR = path.join(BASE_DIR, 'albums');
const ONE_TIME_TOKENS = new Map();

const IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif', '.tif', '.tiff', '.bmp', '.avif'
]);

let db = { albums: {} };

const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  next();
});

const storage = multer.diskStorage({
  destination(req, file, cb) {
    if (!req.album) return cb(new Error('Album authorization is required before upload.'));
    const dir = albumDir(req.album.id);
    fs.mkdir(dir, { recursive: true }, (err) => cb(err, dir));
  },
  filename(req, file, cb) {
    const fileId = crypto.randomUUID();
    const ext = normalizeExt(path.extname(file.originalname || ''));
    const storedName = `${fileId}${ext || '.image'}`;
    file._bridgeFileId = fileId;
    file._bridgeStoredName = storedName;
    cb(null, storedName);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: MAX_UPLOAD_MB * 1024 * 1024,
    files: Math.min(MAX_FILES_PER_ALBUM, 1000)
  },
  fileFilter(req, file, cb) {
    const ext = normalizeExt(path.extname(file.originalname || ''));
    if ((file.mimetype || '').startsWith('image/') || IMAGE_EXTENSIONS.has(ext)) {
      cb(null, true);
      return;
    }
    cb(new Error(`画像ファイルのみアップロードできます: ${file.originalname || 'unknown'}`));
  }
});

async function boot() {
  await fsp.mkdir(ALBUMS_DIR, { recursive: true });
  await loadDb();
  await cleanupExpiredAlbums();
  setInterval(() => {
    cleanupExpiredAlbums().catch((err) => console.error('[cleanup]', err));
    cleanupTokens();
  }, 10 * 60 * 1000).unref();

  app.listen(PORT, () => {
    console.log(`iPhone Photo Bridge v${VERSION} listening on ${PORT}`);
  });
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function sanitizeBaseUrl(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.toString().replace(/\/+$/, '');
  } catch (_) {
    return '';
  }
}

function lanAddresses() {
  const result = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item.family === 'IPv4' && !item.internal && item.address) result.push(item.address);
    }
  }
  const privateRank = (ip) => {
    if (ip.startsWith('192.168.')) return 0;
    if (ip.startsWith('10.')) return 1;
    const m = ip.match(/^172\.(\d+)\./);
    if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return 2;
    return 9;
  };
  return Array.from(new Set(result)).sort((a, b) => privateRank(a) - privateRank(b) || a.localeCompare(b));
}

function isLoopbackHost(host) {
  const h = String(host || '').toLowerCase();
  return h === 'localhost' || h.startsWith('localhost:') || h === '127.0.0.1' || h.startsWith('127.0.0.1:') || h === '[::1]' || h.startsWith('[::1]:');
}

function baseUrlFor(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
  const host = req.get('host');
  if (isLoopbackHost(host)) {
    const [firstLan] = lanAddresses();
    if (firstLan) return `http://${firstLan}:${PORT}`;
  }
  return `${req.protocol}://${host}`;
}

function albumDir(id) {
  return path.join(ALBUMS_DIR, id);
}

function normalizeExt(ext) {
  return String(ext || '').toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 12);
}

function safeDisplayName(name) {
  const trimmed = String(name || '').trim();
  return (trimmed || 'iPhone画像アルバム').slice(0, 80);
}

function safeZipName(name) {
  return safeDisplayName(name)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 80) || 'album';
}

function newId(bytes = 8) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function hashPin(pin, salt) {
  return crypto.createHash('sha256').update(`${salt}:${String(pin)}`).digest('hex');
}

function makePin() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function getPin(req) {
  return String(req.get('x-album-pin') || req.query.pin || req.body?.pin || '').trim();
}

function publicAlbum(album, req) {
  const now = Date.now();
  const files = (album.files || []).map((f) => ({
    id: f.id,
    name: f.originalName,
    size: f.size,
    mimeType: f.mimeType,
    uploadedAt: f.uploadedAt
  }));
  return {
    id: album.id,
    name: album.name,
    createdAt: album.createdAt,
    expiresAt: album.expiresAt,
    secondsUntilExpiry: Math.max(0, Math.floor((album.expiresAt - now) / 1000)),
    fileCount: files.length,
    totalBytes: files.reduce((sum, f) => sum + Number(f.size || 0), 0),
    files,
    albumUrl: absoluteUrl(req, `/a/${album.id}`),
    qrUrl: `/a/${album.id}/qr.svg`
  };
}

function absoluteUrl(req, pathname) {
  return `${baseUrlFor(req)}${pathname}`;
}

async function loadDb() {
  try {
    const raw = await fsp.readFile(INDEX_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.albums) db = parsed;
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('[db] could not read index, starting fresh:', err.message);
    db = { albums: {} };
    await saveDb();
  }
}

async function saveDb() {
  await fsp.mkdir(BASE_DIR, { recursive: true });
  const tmp = `${INDEX_PATH}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(db, null, 2), 'utf8');
  await fsp.rename(tmp, INDEX_PATH);
}

async function cleanupExpiredAlbums() {
  const now = Date.now();
  let changed = false;
  for (const [id, album] of Object.entries(db.albums)) {
    if (Number(album.expiresAt || 0) <= now) {
      await fsp.rm(albumDir(id), { recursive: true, force: true });
      delete db.albums[id];
      changed = true;
    }
  }
  if (changed) await saveDb();
}

function cleanupTokens() {
  const now = Date.now();
  for (const [token, item] of ONE_TIME_TOKENS.entries()) {
    if (item.expiresAt <= now) ONE_TIME_TOKENS.delete(token);
  }
}

function ensureAlbum(req, res, next) {
  const album = db.albums[req.params.id];
  if (!album) {
    res.status(404).json({ ok: false, error: 'アルバムが見つからないか、期限切れです。' });
    return;
  }
  if (Number(album.expiresAt || 0) <= Date.now()) {
    cleanupExpiredAlbums().catch((err) => console.error('[cleanup]', err));
    res.status(410).json({ ok: false, error: 'このアルバムは期限切れです。' });
    return;
  }
  req.album = album;
  next();
}

function requirePin(req, res, next) {
  const album = req.album;
  const pin = getPin(req);
  if (!pin || hashPin(pin, album.pinSalt) !== album.pinHash) {
    res.status(401).json({ ok: false, error: 'PINが違います。' });
    return;
  }
  next();
}

async function albumTotalBytes(album) {
  return (album.files || []).reduce((sum, file) => sum + Number(file.size || 0), 0);
}

app.get('/healthz', (req, res) => {
  res.json({ ok: true, version: VERSION, time: new Date().toISOString() });
});

app.get('/api/config', (req, res) => {
  res.json({
    ok: true,
    version: VERSION,
    mode: 'github-private-local',
    accessUrls: {
      current: baseUrlFor(req),
      publicBaseUrl: PUBLIC_BASE_URL || null,
      lan: lanAddresses().map((ip) => `http://${ip}:${PORT}`)
    },
    ttlHours: TTL_HOURS,
    maxUploadMb: MAX_UPLOAD_MB,
    maxFilesPerAlbum: MAX_FILES_PER_ALBUM,
    maxAlbumMb: MAX_ALBUM_MB
  });
});

app.post('/api/albums', async (req, res, next) => {
  try {
    const name = safeDisplayName(req.body?.name);
    let pin = String(req.body?.pin || '').trim();
    const pinGenerated = !pin;
    if (!pin) pin = makePin();
    if (pin.length < 4 || pin.length > 32) {
      res.status(400).json({ ok: false, error: 'PINは4〜32文字で指定してください。' });
      return;
    }
    const now = Date.now();
    const ttlHours = clampNumber(req.body?.ttlHours, 1, TTL_HOURS, TTL_HOURS);
    const id = newId(7);
    const pinSalt = newId(12);
    const album = {
      id,
      name,
      createdAt: now,
      expiresAt: now + ttlHours * 60 * 60 * 1000,
      pinSalt,
      pinHash: hashPin(pin, pinSalt),
      files: []
    };
    db.albums[id] = album;
    await fsp.mkdir(albumDir(id), { recursive: true });
    await saveDb();
    res.status(201).json({
      ok: true,
      album: publicAlbum(album, req),
      pinGenerated,
      pin: pinGenerated ? pin : undefined
    });
  } catch (err) {
    next(err);
  }
});

app.get('/api/albums/:id', ensureAlbum, requirePin, (req, res) => {
  res.json({ ok: true, album: publicAlbum(req.album, req) });
});

app.post('/api/albums/:id/upload', ensureAlbum, requirePin, async (req, res, next) => {
  const beforeFiles = new Set((req.album.files || []).map((f) => f.storedName));
  upload.array('photos', MAX_FILES_PER_ALBUM)(req, res, async (err) => {
    if (err) {
      if (req.files) {
        await Promise.all(req.files.map((f) => fsp.rm(f.path, { force: true }).catch(() => {})));
      }
      next(err);
      return;
    }
    try {
      const incoming = req.files || [];
      if (incoming.length === 0) {
        res.status(400).json({ ok: false, error: '画像が選択されていません。' });
        return;
      }
      const album = req.album;
      album.files = album.files || [];
      if (album.files.length + incoming.length > MAX_FILES_PER_ALBUM) {
        await Promise.all(incoming.map((f) => fsp.rm(f.path, { force: true }).catch(() => {})));
        res.status(400).json({ ok: false, error: `1アルバムあたり最大${MAX_FILES_PER_ALBUM}枚までです。` });
        return;
      }
      const currentBytes = await albumTotalBytes(album);
      const incomingBytes = incoming.reduce((sum, f) => sum + Number(f.size || 0), 0);
      if (currentBytes + incomingBytes > MAX_ALBUM_MB * 1024 * 1024) {
        await Promise.all(incoming.map((f) => fsp.rm(f.path, { force: true }).catch(() => {})));
        res.status(400).json({ ok: false, error: `1アルバムあたり最大${MAX_ALBUM_MB}MBまでです。` });
        return;
      }
      for (const file of incoming) {
        if (beforeFiles.has(file.filename)) continue;
        album.files.push({
          id: file._bridgeFileId || path.parse(file.filename).name,
          originalName: path.basename(file.originalname || file.filename).slice(0, 180),
          storedName: file.filename,
          size: file.size,
          mimeType: file.mimetype || 'application/octet-stream',
          uploadedAt: Date.now()
        });
      }
      await saveDb();
      res.json({ ok: true, album: publicAlbum(album, req), uploadedCount: incoming.length });
    } catch (innerErr) {
      next(innerErr);
    }
  });
});

app.post('/api/albums/:id/download-token', ensureAlbum, requirePin, (req, res) => {
  const token = newId(18);
  ONE_TIME_TOKENS.set(token, {
    albumId: req.album.id,
    expiresAt: Date.now() + 10 * 60 * 1000
  });
  res.json({ ok: true, token, downloadUrl: `/api/albums/${req.album.id}/download?token=${encodeURIComponent(token)}` });
});

app.get('/api/albums/:id/download', ensureAlbum, async (req, res, next) => {
  try {
    const token = String(req.query.token || '');
    const tokenData = ONE_TIME_TOKENS.get(token);
    if (!tokenData || tokenData.albumId !== req.album.id || tokenData.expiresAt <= Date.now()) {
      res.status(401).send('Download token is invalid or expired.');
      return;
    }
    ONE_TIME_TOKENS.delete(token);
    const album = req.album;
    if (!album.files || album.files.length === 0) {
      res.status(404).send('No files in this album.');
      return;
    }
    const zipBase = safeZipName(album.name);
    const zipName = `${zipBase}_${album.id}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(zipName)}`);
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', (err) => next(err));
    archive.pipe(res);

    const usedNames = new Map();
    for (const file of album.files) {
      const filePath = path.join(albumDir(album.id), file.storedName);
      if (!fs.existsSync(filePath)) continue;
      let entryName = path.basename(file.originalName || file.storedName).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_');
      const count = usedNames.get(entryName) || 0;
      usedNames.set(entryName, count + 1);
      if (count > 0) {
        const parsed = path.parse(entryName);
        entryName = `${parsed.name}_${count + 1}${parsed.ext}`;
      }
      archive.file(filePath, { name: entryName });
    }
    archive.append(`Album: ${album.name}\nCreated: ${new Date(album.createdAt).toISOString()}\nDownloaded: ${new Date().toISOString()}\n`, { name: '_album_info.txt' });
    await archive.finalize();
  } catch (err) {
    next(err);
  }
});

app.post('/api/albums/:id/delete', ensureAlbum, requirePin, async (req, res, next) => {
  try {
    await fsp.rm(albumDir(req.album.id), { recursive: true, force: true });
    delete db.albums[req.album.id];
    await saveDb();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.get('/a/:id/qr.svg', ensureAlbum, async (req, res, next) => {
  try {
    const url = absoluteUrl(req, `/a/${req.album.id}`);
    const svg = await QRCode.toString(url, {
      type: 'svg',
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#0f172a', light: '#ffffff' }
    });
    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.send(svg);
  } catch (err) {
    next(err);
  }
});

app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  maxAge: 0
}));

app.get(['/a/:id', '/'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error('[error]', err);
  if (res.headersSent) return next(err);
  let message = err.message || 'サーバーエラーが発生しました。';
  if (err.code === 'LIMIT_FILE_SIZE') message = `1ファイルあたり最大${MAX_UPLOAD_MB}MBまでです。`;
  if (err.code === 'LIMIT_FILE_COUNT') message = `一度にアップロードできるファイル数を超えました。`;
  res.status(400).json({ ok: false, error: message });
});

boot().catch((err) => {
  console.error(err);
  process.exit(1);
});
