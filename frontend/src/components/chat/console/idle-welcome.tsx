import type { ReactNode } from 'react'
import { Sparkles } from 'lucide-react'
import type { ConsoleState } from './use-console-state'

/** Idle state: centered welcome, quick prompts and the composer. */
export function IdleWelcome({ state, composer }: { state: ConsoleState; composer: ReactNode }) {
  const { t, quickPrompts, setInput, errorMessage } = state

  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center px-4">
      <div className="flex max-h-full w-full max-w-3xl min-h-0 flex-col gap-4 py-3 sm:gap-8 sm:py-8 [@media(max-height:500px)]:gap-3 [@media(max-height:500px)]:py-2">
        <div data-testid="console-welcome-scroll" className="min-h-0 overflow-y-auto">
          <div className="flex flex-col items-center gap-3">
            <img
              src="/logo.png"
              alt="StructureClaw"
              className="h-14 w-14 rounded-2xl opacity-90"
            />
            <h1 className="text-2xl font-semibold text-foreground">{t('welcomeHeading')}</h1>
            <p className="text-sm text-muted-foreground text-center max-w-md leading-relaxed">{t('welcomeMessage')}</p>
          </div>
          <div className="mt-4 grid w-full gap-3 sm:mt-8 sm:grid-cols-3">
            {quickPrompts.map((prompt) => (
              <button
                key={prompt}
                type="button"
                onClick={() => setInput(prompt)}
                className="rounded-2xl border border-border/70 bg-background/70 p-4 text-left text-sm text-muted-foreground transition hover:border-cyan-300/40 hover:bg-cyan-300/10 hover:text-foreground dark:border-white/10 dark:bg-white/5 dark:hover:text-white"
              >
                <Sparkles className="mb-3 h-4 w-4 text-cyan-500 dark:text-cyan-300" />
                {prompt}
              </button>
            ))}
          </div>
        </div>
        <div className="max-h-[55dvh] w-full shrink-0 space-y-3 overflow-y-auto">
          {errorMessage && (
            <div role="alert" className="rounded-2xl border border-rose-400/20 bg-rose-400/10 px-4 py-3 text-sm text-rose-100">
              {errorMessage}
            </div>
          )}
          {composer}
        </div>
      </div>
    </div>
  )
}
