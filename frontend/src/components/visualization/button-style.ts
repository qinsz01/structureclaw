import { cn } from '@/lib/utils'

export const viewerButtonClass = (active = false) => cn(
  'border transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2 ring-offset-background hover:bg-secondary hover:text-secondary-foreground disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100',
  active ? 'border-foreground bg-secondary text-secondary-foreground font-semibold'
    : 'border-border bg-background text-foreground'
)
