import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"
import type { AppLocale } from "@/lib/stores/slices/preferences"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

function toIntlLocale(locale: AppLocale): string {
  return locale === 'zh' ? 'zh-CN' : 'en-US'
}

export function formatNumber(num: number, locale: AppLocale = 'en', options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(toIntlLocale(locale), options).format(Object.is(num, -0) ? 0 : num)
}

export function formatDate(date: Date | string, locale: AppLocale = 'en'): string {
  const d = typeof date === 'string' ? new Date(date) : date
  return new Intl.DateTimeFormat(toIntlLocale(locale), {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d)
}

export function formatResultNumber(num: number, locale: AppLocale = 'en'): string {
  return formatNumber(num, locale, { maximumSignificantDigits: 4, minimumSignificantDigits: 3, useGrouping: false,
    notation: num !== 0 && (Math.abs(num) < 0.0001 || Math.abs(num) >= 1e6) ? 'scientific' : 'standard' })
}
