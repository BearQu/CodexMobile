export function shouldCreateBackgroundHandoff(result = {}) {
  return Boolean(
    result?.desktopBridge?.mode === 'headless-local' &&
    /IPC 状态异常|settings|timeout|超时/i.test(String(result.desktopBridge.reason || ''))
  );
}

export function createBackgroundHandoff({
  projectId = '',
  sessionId = '',
  previousSessionId = '',
  turnId = '',
  userMessage = '',
  reason = '',
  createdAt = new Date().toISOString()
} = {}) {
  const targetSessionId = String(previousSessionId || sessionId || '').trim();
  const id = [targetSessionId, turnId, createdAt].filter(Boolean).join(':');
  if (!targetSessionId || !turnId) {
    return null;
  }
  return {
    id,
    projectId,
    sessionId: targetSessionId,
    backgroundSessionId: sessionId || targetSessionId,
    turnId,
    userMessage: String(userMessage || '').trim(),
    reason: reason || '桌面端 IPC 状态异常，手机端已自动转后台执行。',
    status: 'running',
    createdAt,
    completedAt: '',
    syncedAt: ''
  };
}

export function updateBackgroundHandoffOnPayload(current = [], payload = {}) {
  if (!Array.isArray(current) || !current.length || payload?.source !== 'headless-local') {
    return current;
  }
  const turnId = String(payload.turnId || '').trim();
  const sessionId = String(payload.sessionId || payload.previousSessionId || '').trim();
  if (!turnId && !sessionId) {
    return current;
  }
  let changed = false;
  const next = current.map((item) => {
    const matchesTurn = turnId && item.turnId === turnId;
    const matchesSession = sessionId && (item.sessionId === sessionId || item.backgroundSessionId === sessionId);
    if (!matchesTurn && !matchesSession) {
      return item;
    }
    if (payload.type === 'chat-complete') {
      changed = true;
      return {
        ...item,
        status: 'completed',
        completedAt: payload.completedAt || payload.timestamp || new Date().toISOString()
      };
    }
    if (payload.type === 'chat-error') {
      changed = true;
      return {
        ...item,
        status: 'failed',
        completedAt: payload.completedAt || payload.timestamp || new Date().toISOString()
      };
    }
    return item;
  });
  return changed ? next : current;
}

export function visibleBackgroundHandoff(current = [], {
  selectedProject = null,
  selectedSession = null,
  desktopBridge = null
} = {}) {
  if (desktopBridge?.mode !== 'desktop-ipc' || desktopBridge?.connected !== true) {
    return null;
  }
  const projectId = selectedProject?.id || selectedSession?.projectId || '';
  const sessionId = selectedSession?.id || '';
  return (Array.isArray(current) ? current : []).find((item) => (
    item &&
    item.status === 'completed' &&
    !item.syncedAt &&
    (!projectId || item.projectId === projectId) &&
    (!sessionId || item.sessionId === sessionId)
  )) || null;
}

export function buildBackgroundHandoffMessage(handoff = {}) {
  const userMessage = String(handoff.userMessage || '').trim();
  const reason = String(handoff.reason || '').trim();
  const completedAt = String(handoff.completedAt || '').trim();
  return [
    '刚才手机端因桌面 IPC 异常转后台执行了一轮。以下是交接摘要：',
    '',
    `原因：${reason || '桌面端未能接管该线程。'}`,
    completedAt ? `完成时间：${completedAt}` : '',
    userMessage ? `用户问题：${userMessage}` : '',
    '',
    '请基于当前仓库状态和最近文件改动继续；不要假设桌面线程里已经包含手机后台那轮上下文。'
  ].filter((line) => line !== '').join('\n');
}
