'use client'

import { AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Card, CardContent } from '@/components/ui/card'
import type { Clarification } from '@/lib/api/contracts/agent'

interface ClarificationPromptProps {
  /** Clarification data from agent result */
  clarification: Clarification | undefined
  /** Optional additional class names */
  className?: string
}

/**
 * ClarificationPrompt - Clarification request display component
 *
 * CONS-16: User sees clarification prompts with question and missing fields
 * ACCS-02: Dynamic content receives focus appropriately
 *
 * Displays clarification questions and missing fields when agent needs more input.
 * Returns null when no clarification or no question is provided.
 *
 * Accessibility features:
 * - aria-live="polite" for screen reader announcement (non-urgent)
 * - role="region" for semantic structure
 * - aria-label for identification by screen readers
 * - Decorative icon has aria-hidden="true"
 */
export function ClarificationPrompt({ clarification, className }: ClarificationPromptProps) {
  if (!clarification || !clarification.question) {
    return null
  }

  return (
    <Card
      className={cn(
        'bg-amber-100 dark:bg-amber-900/30 border-amber-200 dark:border-amber-700',
        className
      )}
      aria-live="polite"
      role="region"
      aria-label="Clarification needed"
    >
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <AlertTriangle
            className="h-5 w-5 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5"
            aria-hidden="true"
          />
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-amber-800 dark:text-amber-200">
              Clarification Required
            </p>
            <p className="text-sm mt-1 text-amber-700 dark:text-amber-300">
              {clarification.question}
            </p>
            {clarification.missingFields && clarification.missingFields.length > 0 && (
              <div className="mt-3">
                <p className="text-xs font-medium text-amber-600 dark:text-amber-400 uppercase tracking-wide">
                  Missing Fields
                </p>
                <ul className="mt-1 list-disc list-inside text-sm text-amber-700 dark:text-amber-300">
                  {clarification.missingFields.map((field, index) => (
                    <li key={index}>{field}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
