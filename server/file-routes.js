/**
 * 文件类 HTTP 路由：上传、本地文件读取、项目内文件搜索等。
 *
 * Keywords: file-routes, multipart, local-file, file-search
 *
 * Exports:
 * - createFileRouteHandler — 返回文件 API 处理函数。
 *
 * Inward（本模块依赖/组装的关键符号）: http-utils、file-search、upload-service。
 *
 * Outward（谁在用/调用场景）: server/index。
 *
 * 不负责: Git 与聊天业务。
 */
import { readBody, sendJson } from './http-utils.js';
import { searchProjectFiles as defaultSearchProjectFiles } from './file-search.js';
import { saveUpload as defaultSaveUpload } from './upload-service.js';

export function createFileRouteHandler({
  getProject,
  searchProjectFiles = defaultSearchProjectFiles,
  staticService,
  saveUpload = defaultSaveUpload,
  uploadRoot,
  maxUploadBytes,
  remoteAddress = () => ''
}) {
  if (!getProject || !staticService) {
    throw new Error('createFileRouteHandler requires getProject and staticService');
  }

  return async function handleFileApi(req, res, url) {
    const method = req.method || 'GET';
    const pathname = url.pathname;
    const localFileRoute = pathname === '/api/local-file' || pathname.startsWith('/api/local-file/');

    if (method === 'GET' && pathname === '/api/local-image') {
      await staticService.sendLocalImage(req, res, url);
      return true;
    }

    if (method === 'GET' && pathname === '/api/remote-image') {
      await staticService.sendRemoteImage(req, res, url);
      return true;
    }

    if (method === 'GET' && localFileRoute) {
      await staticService.sendLocalFile(req, res, url);
      return true;
    }

    if (method === 'PUT' && localFileRoute) {
      try {
        const body = await readBody(req, { maxBytes: 6 * 1024 * 1024 });
        await staticService.writeLocalFile(req, res, url, body);
      } catch (error) {
        sendJson(res, error.message === 'Request body too large' ? 413 : 400, { error: error.message || 'Invalid request body' });
      }
      return true;
    }

    if (method === 'GET' && pathname === '/api/files/search') {
      const project = getProject(url.searchParams.get('projectId') || '');
      if (!project) {
        sendJson(res, 404, { error: 'Project not found' });
        return true;
      }
      try {
        const files = await searchProjectFiles(project, url.searchParams.get('q') || '');
        sendJson(res, 200, { files });
      } catch (error) {
        sendJson(res, error.statusCode || 500, { error: error.message || 'Failed to search files' });
      }
      return true;
    }

    if (method === 'POST' && pathname === '/api/uploads') {
      const upload = await saveUpload(req, { uploadRoot, maxUploadBytes });
      console.log(`[upload] saved name=${upload.name} size=${upload.size} kind=${upload.kind} remote=${remoteAddress(req)}`);
      sendJson(res, 200, { upload });
      return true;
    }

    return false;
  };
}
