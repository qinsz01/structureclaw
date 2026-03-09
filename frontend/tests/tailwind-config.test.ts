import { describe, it, expect } from 'vitest'

const tailwindConfig = require('../tailwind.config.js')

describe('Tailwind Configuration (DSGN-03)', () => {
  it('config should have darkMode: "class"', () => {
    expect(tailwindConfig.darkMode).toBe('class')
  })

  it('config.theme.extend.colors should reference all CSS variables via hsl(var(--name))', () => {
    const colors = tailwindConfig.theme?.extend?.colors

    expect(colors?.background).toBe('hsl(var(--background))')
    expect(colors?.foreground).toBe('hsl(var(--foreground))')
    expect(colors?.primary?.DEFAULT).toBe('hsl(var(--primary))')
    expect(colors?.primary?.foreground).toBe('hsl(var(--primary-foreground))')
    expect(colors?.secondary?.DEFAULT).toBe('hsl(var(--secondary))')
    expect(colors?.secondary?.foreground).toBe('hsl(var(--secondary-foreground))')
    expect(colors?.muted?.DEFAULT).toBe('hsl(var(--muted))')
    expect(colors?.muted?.foreground).toBe('hsl(var(--muted-foreground))')
    expect(colors?.accent?.DEFAULT).toBe('hsl(var(--accent))')
    expect(colors?.accent?.foreground).toBe('hsl(var(--accent-foreground))')
    expect(colors?.destructive?.DEFAULT).toBe('hsl(var(--destructive))')
    expect(colors?.destructive?.foreground).toBe('hsl(var(--destructive-foreground))')
    expect(colors?.border).toBe('hsl(var(--border))')
    expect(colors?.input).toBe('hsl(var(--input))')
    expect(colors?.ring).toBe('hsl(var(--ring))')
    expect(colors?.popover?.DEFAULT).toBe('hsl(var(--popover))')
    expect(colors?.popover?.foreground).toBe('hsl(var(--popover-foreground))')
    expect(colors?.card?.DEFAULT).toBe('hsl(var(--card))')
    expect(colors?.card?.foreground).toBe('hsl(var(--card-foreground))')
  })

  it('config.theme.extend.fontFamily should reference --font-sans and --font-mono', () => {
    const fontFamily = tailwindConfig.theme?.extend?.fontFamily

    expect(fontFamily?.sans).toContain('var(--font-sans)')
    expect(fontFamily?.mono).toContain('var(--font-mono)')
  })
})
