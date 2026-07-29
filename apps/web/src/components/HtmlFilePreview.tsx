// FILE: HtmlFilePreview.tsx
// Purpose: Renders workspace HTML reports in a constrained document frame
//          rather than showing their markup as source by default.
// Layer: Web chat/editor file-preview component
// Exports: HtmlFilePreview

import type { ChatFileReference } from "~/lib/chatReferences";
import { basenameOfPath } from "~/file-icons";
import { buildLocalImageUrl } from "~/lib/localImageUrls";
import { WorkspaceFilePreviewHeader } from "./chat/WorkspaceFilePreviewHeader";

export function HtmlFilePreview(props: {
  /** Workspace-relative, scratch-workspace, or explicitly granted absolute path. */
  filePath: string;
  cwd: string | null | undefined;
  previewGrant?: string | null | undefined;
  onReferenceInChat?: ((reference: ChatFileReference) => void) | undefined;
  onAskWhyInChat?: ((reference: ChatFileReference) => void) | undefined;
}) {
  const previewUrl = buildLocalImageUrl({
    src: props.filePath,
    cwd: props.cwd ?? undefined,
    grant: props.previewGrant,
  });
  const fileName = basenameOfPath(props.filePath);

  return (
    <div className="html-file-preview flex h-full min-h-0 min-w-0 flex-1 flex-col bg-[var(--color-background-surface)]">
      <WorkspaceFilePreviewHeader
        workspaceRoot={props.cwd ?? null}
        filePath={props.filePath}
        isMarkdown={false}
        markdownPreviewEnabled={false}
        onMarkdownPreviewChange={() => undefined}
        onReferenceInChat={props.onReferenceInChat}
        onAskWhyInChat={props.onAskWhyInChat}
      />
      <iframe
        key={previewUrl}
        title={`HTML preview: ${fileName}`}
        src={previewUrl}
        className="min-h-0 w-full flex-1 border-0 bg-white"
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
      />
    </div>
  );
}
