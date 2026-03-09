'use client'

import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable'
import { cn } from '@/lib/utils'

interface SplitPanelProps {
  left: React.ReactNode
  right: React.ReactNode
  defaultLayout?: number[]
  direction?: 'horizontal' | 'vertical'
  className?: string
}

export function SplitPanel({
  left,
  right,
  defaultLayout = [50, 50],
  direction = 'horizontal',
  className,
}: SplitPanelProps) {
  return (
    <ResizablePanelGroup
      orientation={direction}
      className={cn('h-full', className)}
    >
      <ResizablePanel defaultSize={defaultLayout[0]} minSize={30}>
        {left}
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel defaultSize={defaultLayout[1]} minSize={30}>
        {right}
      </ResizablePanel>
    </ResizablePanelGroup>
  )
}
