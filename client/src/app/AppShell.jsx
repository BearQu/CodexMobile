import { Composer } from '../composer/Composer.jsx';
import { ChatPane } from '../chat/ChatPane.jsx';
import { ImagePreviewModal } from '../chat/ImagePreview.jsx';
import { BackgroundHandoffCard, ConnectionRecoveryCard, DocsPanel, Drawer, GitPanel, ToastStack, TopBar } from '../panels/index.js';

export function AppShell({ shellClass, panelProps, drawerProps, chatProps, composerProps }) {
  const {
    topBarProps,
    docsPanelProps,
    gitPanelProps,
    recoveryCardProps,
    backgroundHandoffProps,
    toastStackProps,
    imagePreviewProps
  } = panelProps;

  return (
    <div className={shellClass}>
      <TopBar {...topBarProps} />
      <Drawer {...drawerProps} />
      <DocsPanel {...docsPanelProps} />
      <GitPanel {...gitPanelProps} />
      <ConnectionRecoveryCard {...recoveryCardProps} />
      <BackgroundHandoffCard {...backgroundHandoffProps} />
      <ToastStack {...toastStackProps} />
      <ChatPane {...chatProps} />
      <Composer {...composerProps} />
      <ImagePreviewModal {...imagePreviewProps} />
    </div>
  );
}
