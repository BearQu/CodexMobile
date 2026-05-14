import { AlertCircle, ArrowDown, Loader2, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { isNearChatBottom, shouldFollowChatOutput } from '../chat-scroll.js';
import { ChatMessage } from './ChatMessage.jsx';

export function ChatPane({ messages, selectedSession, loading = false, loadError = '', running, now, onPreviewImage, onDeleteMessage, onImplementPlan, onAdjustPlan }) {
  const paneRef = useRef(null);
  const contentRef = useRef(null);
  const bottomPinnedRef = useRef(true);
  const pendingInitialScrollSessionRef = useRef(null);
  const [showScrollLatest, setShowScrollLatest] = useState(false);
  const hasMessages = messages.length > 0;
  const sessionId = selectedSession?.id || '';
  const pinnedBeforeRender = bottomPinnedRef.current;

  const scrollToBottom = useCallback((behavior = 'auto') => {
    const pane = paneRef.current;
    if (!pane) {
      return;
    }
    pane.scrollTo({ top: pane.scrollHeight, behavior });
  }, []);

  useEffect(() => {
    const pane = paneRef.current;
    if (!pane) {
      return undefined;
    }

    function updatePinnedState() {
      const pinned = isNearChatBottom(pane);
      bottomPinnedRef.current = pinned;
      setShowScrollLatest(!pinned);
    }

    updatePinnedState();
    pane.addEventListener('scroll', updatePinnedState, { passive: true });
    return () => pane.removeEventListener('scroll', updatePinnedState);
  }, [hasMessages]);

  useLayoutEffect(() => {
    const force = Boolean(hasMessages && sessionId && pendingInitialScrollSessionRef.current === sessionId);
    if (!shouldFollowChatOutput({ pinnedToBottom: bottomPinnedRef.current, pinnedBeforeUpdate: pinnedBeforeRender, running, force })) {
      return undefined;
    }
    scrollToBottom('auto');
    setShowScrollLatest(false);
    bottomPinnedRef.current = true;
    if (force) {
      pendingInitialScrollSessionRef.current = null;
    }
    return undefined;
  }, [messages, running, scrollToBottom, hasMessages, sessionId]);

  useEffect(() => {
    const pane = paneRef.current;
    if (!pane || typeof ResizeObserver === 'undefined') {
      return undefined;
    }
    const observer = new ResizeObserver(() => {
      if (shouldFollowChatOutput({ pinnedToBottom: bottomPinnedRef.current, running })) {
        scrollToBottom('auto');
      }
    });
    observer.observe(contentRef.current || pane);
    return () => observer.disconnect();
  }, [running, scrollToBottom]);

  useLayoutEffect(() => {
    pendingInitialScrollSessionRef.current = selectedSession?.id || null;
    bottomPinnedRef.current = true;
    setShowScrollLatest(false);
    scrollToBottom('auto');
    return undefined;
  }, [selectedSession?.id, scrollToBottom]);

  if (loading) {
    return (
      <section className="chat-pane chat-loading" ref={paneRef} aria-busy="true" aria-live="polite">
        <div className="chat-loading-card">
          <Loader2 className="spin" size={22} />
          <div>
            <strong>{selectedSession?.title || '对话'}</strong>
            <span>正在加载消息</span>
          </div>
        </div>
        <div className="chat-loading-lines" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      </section>
    );
  }

  if (loadError) {
    return (
      <section className="chat-pane chat-load-error" ref={paneRef} role="alert">
        <div className="empty-orbit">
          <AlertCircle size={30} />
        </div>
        <h2>加载失败</h2>
        <p>{loadError}</p>
      </section>
    );
  }

  if (!messages.length) {
    return (
      <section className="chat-pane empty-chat">
        <div className="empty-orbit">
          <ShieldCheck size={30} />
        </div>
        <h2>{selectedSession ? selectedSession.title : '新对话'}</h2>
        <p>问 Codex 任何事。</p>
      </section>
    );
  }

  return (
    <section className="chat-pane" ref={paneRef}>
      <div className="chat-content" ref={contentRef}>
        {messages.map((message, index) => (
          <ChatMessage
            key={message.id}
            message={message}
            now={now}
            latestActivity={message.role === 'activity' && messages.slice(index + 1).every((item) => item?.role !== 'activity')}
            onPreviewImage={onPreviewImage}
            onDeleteMessage={onDeleteMessage}
            onImplementPlan={onImplementPlan}
            onAdjustPlan={onAdjustPlan}
          />
        ))}
      </div>
      {showScrollLatest ? (
        <button
          type="button"
          className="scroll-latest-button"
          onClick={() => {
            scrollToBottom('smooth');
            bottomPinnedRef.current = true;
            setShowScrollLatest(false);
          }}
          aria-label="回到最新消息"
        >
          <ArrowDown size={16} />
        </button>
      ) : null}
    </section>
  );
}
