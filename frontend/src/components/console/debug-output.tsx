'use client'

import { useStore } from '@/lib/stores/context'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'

/**
 * Debug output panel for viewing raw API response and stream frames
 * Used for debugging and visibility into execution data
 */
export function DebugOutput() {
  const rawResponse = useStore((state) => state.rawResponse)
  const streamFrames = useStore((state) => state.streamFrames)
  const error = useStore((state) => state.error)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Debug Output</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Error section */}
        {error && (
          <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
            <span className="font-semibold">Error: </span>
            {error.message}
            {error.code && <span className="ml-2 text-xs opacity-70">({error.code})</span>}
          </div>
        )}

        {/* Raw JSON section */}
        <div>
          <h4 className="mb-2 text-sm font-medium text-muted-foreground">Raw JSON</h4>
          <pre className="overflow-auto rounded-md bg-muted p-3 text-xs font-mono">
            {rawResponse ? JSON.stringify(rawResponse, null, 2) : 'None'}
          </pre>
        </div>

        {/* Stream Frames section */}
        <div>
          <h4 className="mb-2 text-sm font-medium text-muted-foreground">Stream Frames</h4>
          <pre className="overflow-auto rounded-md bg-muted p-3 text-xs font-mono">
            {streamFrames.length > 0
              ? streamFrames.map((frame) => JSON.stringify(frame)).join('\n')
              : 'No frames'}
          </pre>
        </div>
      </CardContent>
    </Card>
  )
}
