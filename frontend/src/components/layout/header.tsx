'use client'

import { SidebarTrigger } from '@/components/ui/sidebar'
import { Separator } from '@/components/ui/separator'
import { ThemeToggle } from '@/components/theme-toggle'
import { usePathname } from 'next/navigation'

export function Header() {
  const pathname = usePathname()

  return (
    <header className="flex h-14 items-center gap-4 border-b px-4 sticky top-0 bg-background z-10">
      <SidebarTrigger />
      <Separator orientation="vertical" className="h-6" />
      <div className="flex-1">
        <h1 className="text-sm font-medium">
          {pathname === '/console' ? 'Agent Console' : 'StructureClaw'}
        </h1>
      </div>
      <ThemeToggle />
    </header>
  )
}
