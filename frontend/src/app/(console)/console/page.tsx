'use client'

import { useStore } from '@/lib/stores/context'
import { SplitPanel } from '@/components/layout/split-panel'
import {
  EndpointSelector,
  MessageInput,
  ModelJsonPanel,
  ConfigPanel,
  ExecuteButton,
  ResultDisplay,
  ArtifactsList,
  DebugOutput,
  StatusIndicator,
  ErrorDisplay,
  ClarificationPrompt,
} from '@/components/console'

/**
 * Console Page - Complete console composition with split panel layout
 *
 * Composes all console components into a cohesive experience:
 * - Left panel: Input controls (endpoint, message, model, config)
 * - Right panel: Results and debug output
 */
export default function ConsolePage() {
  const result = useStore((state) => state.result)
  const connectionState = useStore((state) => state.connectionState)
  const error = useStore((state) => state.error)

  return (
    <div className="h-[calc(100vh-8rem)]">
      <SplitPanel
        defaultLayout={[40, 60]}
        direction="horizontal"
        className="h-full"
        left={
          <div className="p-4 space-y-4 overflow-auto h-full">
            <EndpointSelector />
            <MessageInput />
            <ModelJsonPanel />
            <ConfigPanel />
            <div className="flex items-center justify-between pt-2">
              <StatusIndicator state={connectionState} />
              <ExecuteButton />
            </div>
          </div>
        }
        right={
          <div className="p-4 space-y-4 overflow-auto h-full">
            {/* Error display */}
            <ErrorDisplay error={error} />

            {/* Clarification prompt */}
            {result?.clarification && <ClarificationPrompt clarification={result.clarification} />}

            {/* Result display */}
            {result && <ResultDisplay result={result} />}

            {/* Artifacts list */}
            {result?.artifacts && <ArtifactsList artifacts={result.artifacts} />}

            {/* Debug output */}
            <DebugOutput />
          </div>
        }
      />
    </div>
  )
}
