/**
 * Git 快捷操作弹窗：替代浏览器 prompt/confirm，收集分支名、提交信息或危险确认。
 *
 * Keywords: git, dialog, branch, commit, confirm
 *
 * Exports:
 * - GitQuickDialog — 面向 TopBar Git 小菜单的轻量输入 / 确认弹窗。
 *
 * Inward: React state/effect、lucide-react 图标。
 *
 * Outward: AppShell 在 Git 快捷动作需要用户输入时挂载。
 */

import { GitBranch, GitCommitHorizontal, Loader2, UploadCloud, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

function dialogIcon(kind) {
  if (kind === 'branch') return GitBranch;
  if (kind === 'push') return UploadCloud;
  return GitCommitHorizontal;
}

export function GitQuickDialog({ dialog, onCancel, onSubmit }) {
  const [value, setValue] = useState('');
  const Icon = useMemo(() => dialogIcon(dialog?.kind), [dialog?.kind]);

  useEffect(() => {
    setValue(dialog?.defaultValue || '');
  }, [dialog]);

  if (!dialog) return null;

  const isInput = dialog.mode === 'input';
  const submitDisabled = dialog.busy || (isInput && !value.trim());

  function handleSubmit(event) {
    event.preventDefault();
    if (submitDisabled) return;
    onSubmit(isInput ? value.trim() : true);
  }

  return (
    <div className="git-quick-dialog-backdrop" role="presentation">
      <form className="git-quick-dialog" role="dialog" aria-modal="true" aria-label={dialog.title} onSubmit={handleSubmit}>
        <header>
          <span className="git-quick-dialog-icon"><Icon size={18} /></span>
          <strong>{dialog.title}</strong>
          <button type="button" className="icon-button" onClick={onCancel} disabled={dialog.busy} aria-label="关闭">
            <X size={18} />
          </button>
        </header>
        {dialog.message ? <p>{dialog.message}</p> : null}
        {isInput ? (
          <label className="git-quick-dialog-field">
            <span>{dialog.label}</span>
            <input autoFocus value={value} onChange={(event) => setValue(event.target.value)} />
          </label>
        ) : null}
        <div className="git-quick-dialog-actions">
          <button type="button" onClick={onCancel} disabled={dialog.busy}>取消</button>
          <button type="submit" disabled={submitDisabled}>
            {dialog.busy ? <Loader2 className="spin" size={15} /> : null}
            {dialog.confirmText || '确认'}
          </button>
        </div>
      </form>
    </div>
  );
}
