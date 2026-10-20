import { createContext, useContext } from 'react'

/** Scene design tokens. Shared by WebGL, HTML legends and the PNG compositor. */
export const scenePalettes = {
  light: {
    background: '#f8fafc', foreground: '#172033', muted: '#526174', grid: '#d6dee8', gridAxis: '#a5b4c5',
    member: '#087f9b', node: '#334155', original: '#475569', neutral: '#94a3b8',
    selected: '#c65a0a', hover: '#0891b2', highlight: '#fbbf24', load: '#15803d', area: '#0f766e',
    moment: '#9333ea', buckling: '#7c3aed', positive: '#0369a1', negative: '#c2410c',
    low: '#0891b2', high: '#c2410c', safe: '#15803d', warning: '#ca8a04', danger: '#dc2626',
  },
  dark: {
    background: '#071222', foreground: '#f1f5f9', muted: '#b0bfd0', grid: '#26364a', gridAxis: '#40566c',
    member: '#38bdf8', node: '#e2e8f0', original: '#cbd5e1', neutral: '#64748b',
    selected: '#fb923c', hover: '#67e8f9', highlight: '#fde68a', load: '#4ade80', area: '#2dd4bf',
    moment: '#c084fc', buckling: '#a78bfa', positive: '#38bdf8', negative: '#fb923c',
    low: '#22d3ee', high: '#fb923c', safe: '#4ade80', warning: '#facc15', danger: '#f87171',
  },
}
export type ScenePalette = typeof scenePalettes.light
export const ScenePaletteContext = createContext<ScenePalette>(scenePalettes.light)
export const useScenePalette = () => useContext(ScenePaletteContext)
export const interactionColor = (base: string, selected: boolean, hovered: boolean, palette: ScenePalette) =>
  selected ? palette.selected : hovered ? palette.hover : base
