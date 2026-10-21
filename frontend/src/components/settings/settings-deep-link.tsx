'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useStore } from '@/lib/stores/context'
import type { WorkspaceSettingsTab } from '@/lib/stores/slices/preferences'

/** Legacy URLs open the same dialog and return to the conversation workspace. */
export function SettingsDeepLink({ section }: { section: WorkspaceSettingsTab }) {
  const open = useStore(state => state.openWorkspaceSettings)
  const router = useRouter()
  useEffect(() => { open(section); router.replace('/') }, [open, router, section])
  return null
}
