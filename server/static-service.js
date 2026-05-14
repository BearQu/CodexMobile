import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendJson, sendStaticContent, staticCacheControl } from './http-utils.js';

export const DEFAULT_MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.cer', 'application/x-x509-ca-cert'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.ico', 'image/x-icon'],
  ['.pdf', 'application/pdf'],
  ['.mp4', 'video/mp4'],
  ['.m4v', 'video/mp4'],
  ['.mov', 'video/quicktime'],
  ['.webm', 'video/webm'],
  ['.ogv', 'video/ogg'],
  ['.mp3', 'audio/mpeg'],
  ['.m4a', 'audio/mp4'],
  ['.aac', 'audio/aac'],
  ['.wav', 'audio/wav'],
  ['.ogg', 'audio/ogg'],
  ['.flac', 'audio/flac'],
  ['.md', 'text/markdown; charset=utf-8'],
  ['.markdown', 'text/markdown; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.csv', 'text/csv; charset=utf-8'],
  ['.htm', 'text/html; charset=utf-8']
]);

export const EDITABLE_TEXT_EXTENSIONS = new Set([
  '.md',
  '.markdown',
  '.txt',
  '.csv',
  '.json',
  '.html',
  '.htm',
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.css',
  '.xml',
  '.log'
]);

export function resolveLocalImagePath(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return '';
  }
  if (/^file:\/\//i.test(raw)) {
    return fileURLToPath(raw);
  }
  if (raw === '~') {
    return os.homedir();
  }
  if (raw.startsWith('~/') || raw.startsWith('~\\')) {
    return path.join(os.homedir(), raw.slice(2));
  }
  return raw;
}

export function safeDecodeLocalPath(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function stripLocalFileLineSuffix(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/^(.+):\d+(?::\d+)?$/);
  if (!match) {
    return '';
  }
  const candidate = match[1];
  return path.extname(candidate) ? candidate : '';
}

export function inlineContentDisposition(filePath) {
  const baseName = path.basename(String(filePath || 'file')) || 'file';
  const fallback = baseName.replace(/[^\x20-\x7E]|["\\;]/g, '_') || 'file';
  return `inline; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(baseName)}`;
}

function localFileCandidatesFromUrl(url) {
  const requestedPath = resolveLocalImagePath(url.searchParams.get('path'));
  const decodedPath = /%[0-9a-f]{2}/i.test(requestedPath) ? resolveLocalImagePath(safeDecodeLocalPath(requestedPath)) : '';
  const baseCandidates = [...new Set([requestedPath, decodedPath].filter(Boolean))];
  const candidates = [
    ...baseCandidates,
    ...baseCandidates.map(stripLocalFileLineSuffix)
  ].filter(Boolean);
  return {
    requestedPath,
    checkedPaths: [...new Set(candidates)]
  };
}

async function resolveExistingLocalFile(url) {
  const { requestedPath, checkedPaths } = localFileCandidatesFromUrl(url);
  if (!checkedPaths.length || !checkedPaths.some((candidate) => path.isAbsolute(candidate))) {
    const error = new Error('File path must be absolute');
    error.statusCode = 400;
    error.requestedPath = requestedPath;
    error.checkedPaths = checkedPaths;
    throw error;
  }
  const errors = [];
  for (const candidate of checkedPaths) {
    if (!path.isAbsolute(candidate)) {
      continue;
    }
    const filePath = path.resolve(candidate);
    try {
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) {
        continue;
      }
      return { requestedPath, checkedPaths, filePath, stat };
    } catch (error) {
      errors.push({
        path: filePath,
        code: error.code || '',
        message: error.message || 'unknown error'
      });
    }
  }
  const error = new Error('File not found');
  error.statusCode = 404;
  error.requestedPath = requestedPath;
  error.checkedPaths = checkedPaths;
  error.details = errors;
  throw error;
}

function backupFileName(filePath) {
  const now = new Date().toISOString().replace(/[:.]/g, '-');
  const baseName = path.basename(filePath).replace(/[^\w.-]+/g, '_') || 'file';
  return `${now}-${baseName}`;
}

function parseRangeHeader(value, size) {
  const match = String(value || '').match(/^bytes=(\d*)-(\d*)$/);
  if (!match || !Number.isFinite(size) || size <= 0) {
    return null;
  }
  let start;
  let end;
  if (match[1] === '' && match[2] === '') {
    return null;
  }
  if (match[1] === '') {
    const suffixLength = Number(match[2]);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
      return null;
    }
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Number(match[2]);
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= size) {
    return null;
  }
  return { start, end: Math.min(end, size - 1) };
}

function sendFileStream(req, res, filePath, stat, headers) {
  const range = parseRangeHeader(req.headers?.range, stat.size);
  const baseHeaders = {
    ...headers,
    'accept-ranges': 'bytes'
  };
  const streamToResponse = (options = {}) => new Promise((resolve, reject) => {
    const stream = fsSync.createReadStream(filePath, options);
    let settled = false;
    const settle = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      callback(value);
    };
    stream.on('data', (chunk) => {
      res.write(chunk);
    });
    stream.once('error', (error) => settle(reject, error));
    stream.once('end', () => {
      res.end();
      settle(resolve);
    });
  });
  if (range) {
    const contentLength = range.end - range.start + 1;
    res.writeHead(206, {
      ...baseHeaders,
      'content-range': `bytes ${range.start}-${range.end}/${stat.size}`,
      'content-length': contentLength
    });
    return streamToResponse({ start: range.start, end: range.end });
  }
  res.writeHead(200, {
    ...baseHeaders,
    'content-length': stat.size
  });
  return streamToResponse();
}

export async function sendLocalImage(req, res, url, {
  mimeTypes = DEFAULT_MIME_TYPES
} = {}) {
  const requestedPath = resolveLocalImagePath(url.searchParams.get('path'));
  const decodedPath = /%[0-9a-f]{2}/i.test(requestedPath) ? resolveLocalImagePath(safeDecodeLocalPath(requestedPath)) : '';
  const candidates = [...new Set([requestedPath, decodedPath].filter(Boolean))];
  if (!candidates.length || !candidates.some((candidate) => path.isAbsolute(candidate))) {
    sendJson(res, 400, { error: 'Image path must be absolute' });
    return;
  }

  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) {
      continue;
    }
    const filePath = path.resolve(candidate);
    const ext = path.extname(filePath).toLowerCase();
    const contentType = mimeTypes.get(ext) || '';
    if (!contentType.startsWith('image/')) {
      continue;
    }
    try {
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) {
        continue;
      }
      await sendFileStream(req, res, filePath, stat, {
        'content-type': contentType,
        'cache-control': 'private, max-age=3600',
        'x-content-type-options': 'nosniff'
      });
      return;
    } catch {
      // Try the decoded candidate before reporting a miss.
    }
  }

  sendJson(res, 404, { error: 'Image not found' });
}

export async function sendLocalFile(req, res, url, {
  mimeTypes = DEFAULT_MIME_TYPES
} = {}) {
  try {
    const { filePath, stat } = await resolveExistingLocalFile(url);
    const ext = path.extname(filePath).toLowerCase();
    const contentType = mimeTypes.get(ext) || 'application/octet-stream';
    await sendFileStream(req, res, filePath, stat, {
      'content-type': contentType,
      'cache-control': 'private, max-age=60',
      'content-disposition': inlineContentDisposition(filePath),
      'x-local-file-mtime-ms': String(Math.round(stat.mtimeMs)),
      'x-local-file-size': String(stat.size),
      'x-local-file-editable': EDITABLE_TEXT_EXTENSIONS.has(ext) ? '1' : '0',
      'x-content-type-options': 'nosniff'
    });
  } catch (error) {
    console.warn(`[local-file] read failed path=${error.requestedPath || ''} checked=${(error.checkedPaths || []).join(' | ')} errors=${JSON.stringify(error.details || [])}`);
    sendJson(res, error.statusCode || 500, {
      error: error.message || 'File not found',
      path: error.requestedPath || '',
      checked: error.checkedPaths || [],
      details: error.details || []
    });
  }
}

export async function writeLocalTextFile(req, res, url, body) {
  try {
    const { filePath, stat } = await resolveExistingLocalFile(url);
    const ext = path.extname(filePath).toLowerCase();
    if (!EDITABLE_TEXT_EXTENSIONS.has(ext)) {
      sendJson(res, 415, { error: 'Only text files can be edited' });
      return;
    }
    const content = String(body?.content ?? '');
    if (content.length > 5 * 1024 * 1024) {
      sendJson(res, 413, { error: 'File is too large to edit on mobile' });
      return;
    }
    const baseMtimeMs = Number(body?.baseMtimeMs || 0);
    if (baseMtimeMs && Math.abs(Math.round(stat.mtimeMs) - Math.round(baseMtimeMs)) > 5) {
      sendJson(res, 409, {
        error: 'File changed on disk. Refresh before saving.',
        mtimeMs: Math.round(stat.mtimeMs),
        size: stat.size
      });
      return;
    }

    const backupRoot = path.join(process.cwd(), '.codexmobile', 'backups', 'local-files');
    await fs.mkdir(backupRoot, { recursive: true });
    const backupPath = path.join(backupRoot, backupFileName(filePath));
    await fs.copyFile(filePath, backupPath);
    await fs.writeFile(filePath, content, 'utf8');
    const nextStat = await fs.stat(filePath);
    sendJson(res, 200, {
      ok: true,
      mtimeMs: Math.round(nextStat.mtimeMs),
      size: nextStat.size,
      backupPath
    });
  } catch (error) {
    sendJson(res, error.statusCode || 500, {
      error: error.message || 'Failed to save file',
      path: error.requestedPath || '',
      checked: error.checkedPaths || [],
      details: error.details || []
    });
  }
}

export async function serveFileFromRoot(req, res, rootDir, requestedPath, cacheControl, {
  mimeTypes = DEFAULT_MIME_TYPES
} = {}) {
  const relativePath = requestedPath.replace(/^\/+/, '');
  const candidate = path.normalize(path.join(rootDir, relativePath));
  const rootWithSep = rootDir.endsWith(path.sep) ? rootDir : `${rootDir}${path.sep}`;
  if (candidate !== rootDir && !candidate.startsWith(rootWithSep)) {
    res.writeHead(403);
    res.end('Forbidden');
    return true;
  }

  try {
    const stat = await fs.stat(candidate);
    if (!stat.isFile()) {
      res.writeHead(404);
      res.end('Not found');
      return true;
    }
    const ext = path.extname(candidate);
    const content = await fs.readFile(candidate);
    sendStaticContent(req, res, 200, content, {
      'content-type': mimeTypes.get(ext) || 'application/octet-stream',
      'cache-control': cacheControl,
      'x-content-type-options': 'nosniff'
    }, ext);
    return true;
  } catch {
    res.writeHead(404);
    res.end('Not found');
    return true;
  }
}

export function createStaticService({
  clientDist,
  generatedRoot,
  httpsRootCaPath,
  mimeTypes = DEFAULT_MIME_TYPES
}) {
  async function serveStatic(req, res, url) {
    let requestedPath = decodeURIComponent(url.pathname);
    if (requestedPath === '/codexmobile-root-ca.cer') {
      try {
        const stat = await fs.stat(httpsRootCaPath);
        const content = await fs.readFile(httpsRootCaPath);
        res.writeHead(200, {
          'content-type': 'application/x-x509-ca-cert',
          'content-length': stat.size,
          'cache-control': 'no-store',
          'content-disposition': 'attachment; filename="codexmobile-root-ca.cer"',
          'x-content-type-options': 'nosniff'
        });
        res.end(content);
      } catch {
        res.writeHead(404);
        res.end('Certificate not found');
      }
      return;
    }

    if (requestedPath.startsWith('/generated/')) {
      await serveFileFromRoot(
        req,
        res,
        generatedRoot,
        requestedPath.slice('/generated/'.length),
        'private, max-age=86400',
        { mimeTypes }
      );
      return;
    }

    if (requestedPath === '/') {
      requestedPath = '/index.html';
    }

    const candidate = path.normalize(path.join(clientDist, requestedPath));
    if (!candidate.startsWith(clientDist)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    try {
      const stat = await fs.stat(candidate);
      const filePath = stat.isDirectory() ? path.join(candidate, 'index.html') : candidate;
      const ext = path.extname(filePath);
      const content = await fs.readFile(filePath);
      sendStaticContent(req, res, 200, content, {
        'content-type': mimeTypes.get(ext) || 'application/octet-stream',
        'cache-control': staticCacheControl(ext, filePath),
        'x-content-type-options': 'nosniff'
      }, ext);
    } catch {
      const indexPath = path.join(clientDist, 'index.html');
      try {
        const content = await fs.readFile(indexPath);
        sendStaticContent(req, res, 200, content, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff'
        }, '.html');
      } catch {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('CodexMobile server is running. Build the PWA with: npm run build');
      }
    }
  }

  async function sendLocalImageFromRequest(req, res, url) {
    await sendLocalImage(req, res, url, { mimeTypes });
  }

  async function sendLocalFileFromRequest(req, res, url) {
    await sendLocalFile(req, res, url, { mimeTypes });
  }

  async function writeLocalFileFromRequest(req, res, url, body) {
    await writeLocalTextFile(req, res, url, body);
  }

  return {
    serveStatic,
    sendLocalImage: sendLocalImageFromRequest,
    sendLocalFile: sendLocalFileFromRequest,
    writeLocalFile: writeLocalFileFromRequest
  };
}
