// FILE: ComposerUpdateContinuationPanel.tsx
// Purpose: Offers an explicit, dismissible continuation for a turn interrupted
// by a successfully installed desktop update.
// Layer: Chat composer UI
// Exports: ComposerUpdateContinuationPanel

import { PlayIcon, RefreshCwIcon, XIcon } from "~/lib/icons";
import { Button } from "../ui/button";
import {
  ComposerStackedPanelHeaderRow,
  ComposerStackedPanelRowLabel,
  ComposerStackedPanelRowMain,
} from "./ComposerStackedPanelContent";
import { ComposerStackedPanel } from "./ComposerStackedPanel";
import {
  COMPOSER_STACKED_PANEL_ICON_BUTTON_CLASS_NAME,
  COMPOSER_STACKED_PANEL_ICON_CLASS_NAME,
} from "./composerStackedPanelStyles";

interface ComposerUpdateContinuationPanelProps {
  continuing: boolean;
  dismissing?: boolean;
  disabled?: boolean;
  attachedToPrevious?: boolean;
  onContinue: () => void;
  onDismiss: () => void;
}

export function ComposerUpdateContinuationPanel({
  continuing,
  dismissing: dismissingProp,
  disabled: disabledProp,
  attachedToPrevious: attachedToPreviousProp,
  onContinue,
  onDismiss,
}: ComposerUpdateContinuationPanelProps) {
  const dismissing = dismissingProp ?? false;
  const disabled = disabledProp ?? false;
  const attachedToPrevious = attachedToPreviousProp ?? false;
  return (
    <ComposerStackedPanel
      attachedToPrevious={attachedToPrevious}
      data-testid="desktop-update-continuation"
    >
      <ComposerStackedPanelHeaderRow>
        <ComposerStackedPanelRowMain>
          <RefreshCwIcon className={COMPOSER_STACKED_PANEL_ICON_CLASS_NAME} />
          <ComposerStackedPanelRowLabel>Interrupted by update</ComposerStackedPanelRowLabel>
        </ComposerStackedPanelRowMain>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={disabled || continuing || dismissing}
            onClick={onContinue}
            aria-label="Continue interrupted task"
            title="Continue interrupted task"
          >
            {continuing ? (
              <RefreshCwIcon className="size-3 animate-spin" />
            ) : (
              <PlayIcon className="size-3" />
            )}
            Continue
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className={COMPOSER_STACKED_PANEL_ICON_BUTTON_CLASS_NAME}
            disabled={continuing || dismissing}
            onClick={onDismiss}
            aria-label="Dismiss interrupted task"
            title="Dismiss"
          >
            {dismissing ? (
              <RefreshCwIcon className="size-3 animate-spin" />
            ) : (
              <XIcon className="size-3" />
            )}
          </Button>
        </div>
      </ComposerStackedPanelHeaderRow>
    </ComposerStackedPanel>
  );
}
