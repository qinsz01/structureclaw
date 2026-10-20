'use client'

import { StructuralViewer, type StructuralViewerProps } from './structural-viewer'

/** Fullscreen entry point; the workspace uses the same viewer inline. */
export function StructuralVisualizationModal(props: StructuralViewerProps) {
  return <StructuralViewer {...props} />
}
