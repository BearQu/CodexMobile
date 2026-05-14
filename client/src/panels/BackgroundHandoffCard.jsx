import { SendHorizontal, X } from 'lucide-react';

export function BackgroundHandoffCard({ handoff, onSync, onDismiss }) {
  if (!handoff) {
    return null;
  }
  return (
    <div className="background-handoff-card" role="status" aria-live="polite">
      <div>
        <strong>后台结果可同步</strong>
        <span>桌面端已恢复，可把手机后台执行摘要发回当前线程。</span>
      </div>
      <button type="button" className="background-handoff-primary" onClick={() => onSync?.(handoff)}>
        <SendHorizontal size={15} />
        <span>同步到桌面</span>
      </button>
      <button type="button" className="background-handoff-close" onClick={() => onDismiss?.(handoff)} aria-label="忽略后台摘要">
        <X size={15} />
      </button>
    </div>
  );
}
