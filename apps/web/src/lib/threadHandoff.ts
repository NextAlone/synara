// FILE: threadHandoff.ts
// Purpose: Builds client-side handoff commands and imported transcript payloads.
// Layer: Web handoff utilities
// Exports: target-provider, title, transcript, and model-selection helpers.

import {
  EventId,
  MessageId,
  type OrchestrationThreadActivity,
  PROVIDER_DISPLAY_NAMES,
  type ModelSelection,
  type ProviderKind,
  type ThreadHandoffImportedMessage,
} from "@synara/contracts";
import { getDefaultModel } from "@synara/shared/model";
import { type Thread } from "../types";
import { DEFAULT_PROVIDER_ORDER } from "../providerOrdering";
import { stripEmbeddedAssistantSelections } from "./assistantSelections";
import { extractTrailingBrowserAnnotations } from "./browserAnnotations";
import { randomUUID } from "./utils";

const IMPORTABLE_THREAD_ACTIVITY_KINDS = new Set([
  "account.rate-limits.updated",
  "account.rate-limited",
  "context-window.updated",
]);

function isImportableThreadMessage(
  message: Thread["messages"][number],
): message is Thread["messages"][number] & {
  role: "user" | "assistant";
} {
  return (message.role === "user" || message.role === "assistant") && message.streaming === false;
}

function isImportableThreadActivity(
  activity: Thread["activities"][number],
): activity is OrchestrationThreadActivity {
  return IMPORTABLE_THREAD_ACTIVITY_KINDS.has(activity.kind);
}

type ThreadMessage = Thread["messages"][number];

interface IndexedThreadMessage {
  readonly index: number;
  readonly message: ThreadMessage;
}

export interface ThreadHandoffSource {
  readonly messages: ReadonlyArray<ThreadMessage>;
  readonly usesPreviousTurn: boolean;
}

function isCompleteAssistantMessage(
  message: ThreadMessage,
): message is ThreadMessage & { role: "assistant" } {
  return (
    message.role === "assistant" && message.streaming === false && message.text.trim().length > 0
  );
}

function isNativeThreadMessage(message: ThreadMessage): boolean {
  return (message.source ?? "native") === "native";
}

function findLatestTurnAssistantIndex(
  messages: ReadonlyArray<ThreadMessage>,
  latestTurn: NonNullable<Thread["latestTurn"]>,
): number {
  if (latestTurn.assistantMessageId !== null) {
    const index = messages.findIndex((message) => message.id === latestTurn.assistantMessageId);
    if (index >= 0) {
      return index;
    }
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "assistant" && message.turnId === latestTurn.turnId) {
      return index;
    }
  }
  return -1;
}

function findLatestTurnAssistantStart(
  messages: ReadonlyArray<ThreadMessage>,
  latestTurn: NonNullable<Thread["latestTurn"]>,
): number {
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (
      message.role === "assistant" &&
      (message.id === latestTurn.assistantMessageId || message.turnId === latestTurn.turnId)
    ) {
      return index;
    }
  }

  const latestTurnStartedAt = latestTurn.startedAt ?? latestTurn.requestedAt;
  const latestTurnStartedAtMs = Date.parse(latestTurnStartedAt);
  if (Number.isNaN(latestTurnStartedAtMs)) {
    return -1;
  }
  const index = messages.findIndex((message) => {
    if (message.role !== "assistant" || !isNativeThreadMessage(message)) {
      return false;
    }
    const createdAtMs = Date.parse(message.createdAt);
    return !Number.isNaN(createdAtMs) && createdAtMs >= latestTurnStartedAtMs;
  });
  return index;
}

function findIncompleteTurnStart(
  messages: ReadonlyArray<ThreadMessage>,
  latestTurn: NonNullable<Thread["latestTurn"]>,
): number {
  const assistantStart = findLatestTurnAssistantStart(messages, latestTurn);
  if (assistantStart < 0) {
    return messages.length;
  }
  for (let index = assistantStart - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "user" && isNativeThreadMessage(message)) {
      return index;
    }
  }
  return assistantStart;
}

function messagesThroughLastCompleteAssistant(
  importableMessages: ReadonlyArray<IndexedThreadMessage>,
  endExclusive: number,
): ReadonlyArray<ThreadMessage> {
  for (let index = importableMessages.length - 1; index >= 0; index -= 1) {
    const entry = importableMessages[index]!;
    if (entry.index < endExclusive && isCompleteAssistantMessage(entry.message)) {
      return importableMessages.slice(0, index + 1).map(({ message }) => message);
    }
  }
  return [];
}

/**
 * Resolves the coherent transcript handed to another provider.
 *
 * A damaged latest turn often leaves a completed user message followed by a
 * streaming, empty, or terminally failed assistant message. Filtering messages
 * one by one would retain that dangling user request. Instead, fall back to the
 * previous complete assistant boundary so the destination never treats an
 * abandoned request as valid conversation state.
 */
export function resolveThreadHandoffSource(
  thread: Pick<Thread, "latestTurn" | "messages">,
): ThreadHandoffSource {
  const importableMessages = thread.messages.flatMap((message, index) =>
    isImportableThreadMessage(message) ? [{ index, message }] : [],
  );
  if (importableMessages.length === 0) {
    return { messages: [], usesPreviousTurn: false };
  }

  const latestTurn = thread.latestTurn;
  if (latestTurn === null) {
    const messages = messagesThroughLastCompleteAssistant(
      importableMessages,
      thread.messages.length,
    );
    return {
      messages,
      usesPreviousTurn: messages.length !== importableMessages.length,
    };
  }

  const latestAssistantIndex = findLatestTurnAssistantIndex(thread.messages, latestTurn);
  const latestAssistant = latestAssistantIndex >= 0 ? thread.messages[latestAssistantIndex]! : null;
  const latestAssistantCompleted =
    latestTurn.state === "completed" &&
    latestTurn.completedAt !== null &&
    latestAssistant !== null &&
    isCompleteAssistantMessage(latestAssistant);
  if (latestAssistantCompleted) {
    const selectedMessages = importableMessages
      .filter(({ index }) => index <= latestAssistantIndex)
      .map(({ message }) => message);
    return {
      messages: selectedMessages,
      usesPreviousTurn: selectedMessages.length !== importableMessages.length,
    };
  }

  let incompleteTurnStart = findIncompleteTurnStart(thread.messages, latestTurn);
  const lastImportable = importableMessages.at(-1);
  if (incompleteTurnStart === thread.messages.length && lastImportable?.message.role === "user") {
    incompleteTurnStart = lastImportable.index;
  }
  return {
    messages: messagesThroughLastCompleteAssistant(importableMessages, incompleteTurnStart),
    usesPreviousTurn: true,
  };
}

export function resolveAvailableHandoffTargetProviders(
  sourceProvider: ProviderKind,
): ReadonlyArray<ProviderKind> {
  return DEFAULT_PROVIDER_ORDER.filter((provider) => provider !== sourceProvider);
}

export function resolveThreadHandoffBadgeLabel(thread: Pick<Thread, "handoff">): string | null {
  if (!thread.handoff) {
    return null;
  }
  return `Handoff from ${PROVIDER_DISPLAY_NAMES[thread.handoff.sourceProvider]}`;
}

// Preserve the visible source thread name when creating the destination thread.
export function resolveThreadHandoffTitle(thread: Pick<Thread, "title">): string {
  const title = thread.title.trim().replace(/\s+/g, " ");
  return title.length > 0 ? title : "Handoff";
}

export function buildThreadHandoffImportedMessages(thread: {
  readonly messages: ReadonlyArray<ThreadMessage>;
}): ReadonlyArray<ThreadHandoffImportedMessage> {
  return thread.messages.filter(isImportableThreadMessage).map((message) => {
    const importedMessageId = MessageId.makeUnsafe(randomUUID());
    let importedText = message.text;
    if (message.role === "user") {
      const extractedBrowserAnnotations = extractTrailingBrowserAnnotations(
        message.text,
        message.id,
      );
      const visibleAndContextText = stripEmbeddedAssistantSelections(
        extractedBrowserAnnotations.promptText,
      );
      // Browser annotation ids and tab ids are scoped to the source thread's
      // live browser session. Carrying them into a handoff would advertise an
      // exact-page navigation target that the destination thread cannot
      // resolve, so import only the visible user/context text.
      importedText = visibleAndContextText;
    }
    const importedMessage: ThreadHandoffImportedMessage = {
      messageId: importedMessageId,
      role: message.role,
      text: importedText,
      createdAt: message.createdAt,
      updatedAt: message.completedAt ?? message.createdAt,
    };
    const attachments =
      message.attachments && message.attachments.length > 0
        ? message.attachments.map((attachment) =>
            attachment.type === "assistant-selection"
              ? {
                  type: attachment.type,
                  id: attachment.id,
                  assistantMessageId: attachment.assistantMessageId,
                  text: attachment.text,
                }
              : {
                  type: attachment.type,
                  id: attachment.id,
                  name: attachment.name,
                  mimeType: attachment.mimeType,
                  sizeBytes: attachment.sizeBytes,
                },
          )
        : null;
    return attachments ? Object.assign(importedMessage, { attachments }) : importedMessage;
  });
}

export function buildThreadHandoffImportedActivities(
  thread: Pick<Thread, "activities">,
): ReadonlyArray<OrchestrationThreadActivity> {
  return thread.activities.filter(isImportableThreadActivity).map((activity) => {
    const { sequence: _sequence, ...rest } = activity;
    return {
      ...rest,
      id: EventId.makeUnsafe(randomUUID()),
    };
  });
}

export function hasNativeThreadHandoffMessages(thread: Pick<Thread, "messages">): boolean {
  return thread.messages.some(
    (message) => isImportableThreadMessage(message) && message.source === "native",
  );
}

export function canCreateThreadHandoff(input: {
  readonly thread: Pick<Thread, "handoff" | "latestTurn" | "messages" | "session">;
  readonly isBusy?: boolean;
  readonly hasLiveTurn?: boolean;
  readonly hasPendingApprovals?: boolean;
  readonly hasPendingUserInput?: boolean;
}): boolean {
  if (input.isBusy) {
    return false;
  }
  const handoffSource = resolveThreadHandoffSource(input.thread);
  const sessionStatus = input.thread.session?.orchestrationStatus;
  const latestTurnFailed =
    input.thread.latestTurn?.state === "error" || input.thread.latestTurn?.state === "interrupted";
  const sessionFailed =
    sessionStatus === "error" || sessionStatus === "interrupted" || sessionStatus === "stopped";
  const canRecoverPreviousTurn =
    handoffSource.messages.length > 0 &&
    ((latestTurnFailed && handoffSource.usesPreviousTurn) || sessionFailed);
  if (
    ((input.hasPendingApprovals || input.hasPendingUserInput) && !canRecoverPreviousTurn) ||
    (input.hasLiveTurn && !canRecoverPreviousTurn) ||
    sessionStatus === "starting" ||
    (sessionStatus === "running" && !canRecoverPreviousTurn)
  ) {
    return false;
  }
  if (handoffSource.messages.length === 0) {
    return false;
  }
  if (input.thread.handoff !== null) {
    return hasNativeThreadHandoffMessages(input.thread) || canRecoverPreviousTurn;
  }
  return true;
}

export function resolveThreadHandoffModelSelection(input: {
  readonly sourceThread: Pick<Thread, "modelSelection">;
  readonly targetProvider: ProviderKind;
  readonly projectDefaultModelSelection: ModelSelection | null | undefined;
  readonly stickyModelSelectionByProvider: Partial<Record<ProviderKind, ModelSelection>>;
}): ModelSelection {
  const isCompatibleSelection = (
    selection: ModelSelection | null | undefined,
  ): selection is ModelSelection => {
    if (!selection || selection.provider !== input.targetProvider) {
      return false;
    }
    return input.targetProvider !== "kilo" || selection.model.startsWith("kilo/");
  };

  const stickySelection = input.stickyModelSelectionByProvider[input.targetProvider];
  if (isCompatibleSelection(stickySelection)) {
    return stickySelection;
  }
  if (isCompatibleSelection(input.projectDefaultModelSelection)) {
    return input.projectDefaultModelSelection;
  }
  const defaultModel = getDefaultModel(input.targetProvider);
  if (!defaultModel) {
    throw new Error("Select a Pi model before handing off to Pi.");
  }
  return {
    provider: input.targetProvider,
    model: defaultModel,
  };
}
