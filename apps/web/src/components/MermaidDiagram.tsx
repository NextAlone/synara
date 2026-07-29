// FILE: MermaidDiagram.tsx
// Purpose: Lazily render Mermaid fence source into sanitized SVG after streaming completes.
// Layer: Web chat markdown presentation component
// Exports: MermaidDiagram
// Depends on: Mermaid browser renderer and React lifecycle state.

import { useEffect, useId, useState } from "react";

type MermaidModule = typeof import("mermaid");
type MermaidRenderResult = Awaited<ReturnType<MermaidModule["default"]["render"]>>;
type MermaidTheme = "light" | "dark";

interface MermaidDiagramProps {
  readonly definition: string;
  readonly theme: MermaidTheme;
  readonly isStreaming: boolean;
}

type MermaidRenderState =
  | {
      readonly kind: "rendered";
      readonly definition: string;
      readonly theme: MermaidTheme;
      readonly svg: string;
    }
  | {
      readonly kind: "error";
      readonly definition: string;
      readonly theme: MermaidTheme;
    };

let mermaidModulePromise: Promise<MermaidModule> | null = null;
let mermaidRenderQueue: Promise<void> = Promise.resolve();

function getMermaidModulePromise(): Promise<MermaidModule> {
  mermaidModulePromise ??= import("mermaid");
  return mermaidModulePromise;
}

function renderMermaid(input: {
  readonly definition: string;
  readonly renderId: string;
  readonly theme: MermaidTheme;
}): Promise<MermaidRenderResult> {
  const render = async () => {
    const { default: mermaid } = await getMermaidModulePromise();

    // Mermaid configuration is global. Keep configure + render atomic so diagrams
    // queued during a theme change cannot render with another diagram's theme.
    mermaid.initialize({
      fontFamily: "inherit",
      securityLevel: "strict",
      startOnLoad: false,
      suppressErrorRendering: true,
      theme: input.theme === "dark" ? "dark" : "default",
    });
    return mermaid.render(input.renderId, input.definition);
  };

  const result = mermaidRenderQueue.then(render, render);
  mermaidRenderQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function MermaidSource({ definition }: Pick<MermaidDiagramProps, "definition">) {
  return (
    <pre className="chat-markdown-mermaid__source" data-mermaid-source>
      <code>{definition}</code>
    </pre>
  );
}

export function MermaidDiagram({ definition, theme, isStreaming }: MermaidDiagramProps) {
  const reactId = useId();
  const renderId = `synara-mermaid-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const [renderState, setRenderState] = useState<MermaidRenderState | null>(null);
  const currentState =
    !isStreaming &&
    renderState !== null &&
    renderState.definition === definition &&
    renderState.theme === theme
      ? renderState
      : null;

  useEffect(() => {
    let active = true;
    if (isStreaming) {
      return () => {
        active = false;
      };
    }

    void renderMermaid({ definition, renderId, theme })
      .then(({ svg }) => {
        if (active) {
          setRenderState({ kind: "rendered", definition, theme, svg });
        }
      })
      .catch(() => {
        if (active) {
          setRenderState({ kind: "error", definition, theme });
        }
      });

    return () => {
      active = false;
    };
  }, [definition, isStreaming, renderId, theme]);

  if (currentState?.kind === "rendered") {
    // Mermaid sanitizes SVG in strict mode. Do not weaken its security level or
    // invoke bindFunctions: chat Markdown is untrusted assistant/user content.
    return (
      <div
        className="chat-markdown-mermaid"
        data-mermaid-rendered
        dangerouslySetInnerHTML={{ __html: currentState.svg }}
      />
    );
  }

  if (currentState?.kind === "error") {
    return (
      <div className="chat-markdown-mermaid__error" role="status">
        <p>Could not render Mermaid diagram. Showing source.</p>
        <MermaidSource definition={definition} />
      </div>
    );
  }

  return <MermaidSource definition={definition} />;
}
