// FILE: HtmlFilePreview.tsx
// Purpose: Renders workspace HTML reports in a constrained document frame
//          rather than showing their markup as source by default.
// Layer: Web chat/editor file-preview component
// Exports: HtmlFilePreview

import { useReducer } from "react";

import { basenameOfPath } from "~/file-icons";
import type { ChatFileReference } from "~/lib/chatReferences";
import { buildLocalImageUrl } from "~/lib/localImageUrls";
import { ArrowLeftIcon } from "~/lib/icons";
import { ChatHeaderIconButton } from "./chat/chatHeaderControls";
import { WorkspaceFilePreviewHeader } from "./chat/WorkspaceFilePreviewHeader";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import {
  createHtmlFilePreviewNavigationState,
  reduceHtmlFilePreviewNavigation,
} from "./htmlFilePreviewNavigation";

interface HtmlFilePreviewProps {
  /** Workspace-relative, scratch-workspace, or explicitly granted absolute path. */
  filePath: string;
  cwd: string | null | undefined;
  previewGrant?: string | null | undefined;
  onReferenceInChat?: ((reference: ChatFileReference) => void) | undefined;
  onAskWhyInChat?: ((reference: ChatFileReference) => void) | undefined;
}

interface HtmlFilePreviewDocumentProps extends HtmlFilePreviewProps {
  previewUrl: string;
  fileName: string;
}

function HtmlFilePreviewDocument(props: HtmlFilePreviewDocumentProps) {
  const [navigation, dispatch] = useReducer(
    reduceHtmlFilePreviewNavigation,
    undefined,
    createHtmlFilePreviewNavigationState,
  );

  const returnToReportAction = navigation.canReturnToReport ? (
    <Tooltip>
      <TooltipTrigger
        render={
          <ChatHeaderIconButton
            type="button"
            label="Back to report"
            tone="plain"
            onClick={() => dispatch({ type: "return-to-report" })}
          />
        }
      >
        <ArrowLeftIcon aria-hidden="true" className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="bottom">Back to report</TooltipPopup>
    </Tooltip>
  ) : null;

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
        previewActions={returnToReportAction}
      />
      <iframe
        key={navigation.frameKey}
        title={`HTML preview: ${props.fileName}`}
        src={props.previewUrl}
        className="min-h-0 w-full flex-1 border-0 bg-white"
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        onLoad={() => dispatch({ type: "frame-loaded" })}
      />
    </div>
  );
}

export function HtmlFilePreview(props: HtmlFilePreviewProps) {
  const previewUrl = buildLocalImageUrl({
    src: props.filePath,
    cwd: props.cwd ?? undefined,
    grant: props.previewGrant,
  });
  const fileName = basenameOfPath(props.filePath);

  return (
    <HtmlFilePreviewDocument
      key={previewUrl}
      {...props}
      previewUrl={previewUrl}
      fileName={fileName}
    />
  );
}
