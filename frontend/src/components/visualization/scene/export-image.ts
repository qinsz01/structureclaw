import type * as THREE from 'three'
import { formatResultNumber } from '@/lib/utils'
import type { AppLocale } from '@/lib/stores/slices/preferences'
import { legendStops, type LegendProps } from './color-bar'
import type { ScenePalette } from './palette'

/** Compose the WebGL frame and visible HTML labels onto an opaque, printable image. */
export function exportSceneImage({ gl, render, container, filename, scale, palette, legend, title, note, locale, unitsPerPixel, lengthUnit }: {
  gl: THREE.WebGLRenderer; render: () => void; container: HTMLElement; filename: string; scale: number;
  unitsPerPixel?: number; lengthUnit?: string;
  palette: ScenePalette; legend: LegendProps | null; title: string; note: string; locale: AppLocale
}) {
  const rect = gl.domElement.getBoundingClientRect()
  const labels = Array.from(container.querySelectorAll<HTMLElement>('[data-viz-label]')).map(element => ({
    text: element.innerText.split('\n'), rect: element.getBoundingClientRect(),
  }))
  const width = Math.round(rect.width), height = Math.round(rect.height)
  const header = 84, footer = 40, legendWidth = legend ? 210 : 0
  const canvas = document.createElement('canvas')
  canvas.width = (width + legendWidth) * scale
  canvas.height = (height + header + footer) * scale
  const ctx = canvas.getContext('2d')!
  ctx.scale(scale, scale)
  ctx.fillStyle = palette.background
  ctx.fillRect(0, 0, canvas.width / scale, canvas.height / scale)
  ctx.fillStyle = palette.foreground
  ctx.font = '16px Arial, "Microsoft YaHei", sans-serif'
  const lines: string[] = []
  let line = ''
  for (const char of title) {
    if (ctx.measureText(line + char).width > width + legendWidth - 40) { lines.push(line); line = '' }
    line += char
  }
  lines.push(line)
  lines.slice(0, 3).forEach((text, index) => ctx.fillText(text, 20, 24 + index * 22))
  const ratio = gl.getPixelRatio()
  try {
    gl.setPixelRatio(scale)
    gl.setSize(width, height, false)
    render()
    ctx.drawImage(gl.domElement, 0, header, width, height)
  } finally {
    gl.setPixelRatio(ratio)
    gl.setSize(rect.width, rect.height, false)
    render()
  }
  ctx.save()
  ctx.beginPath(); ctx.rect(0, header, width, height); ctx.clip()
  ctx.font = '11px Arial, "Microsoft YaHei", sans-serif'
  for (const label of labels) {
    const x = label.rect.left - rect.left, y = label.rect.top - rect.top + header
    if (x < 0 || x > width || y < header || y > height + header) continue
    const w = Math.max(...label.text.map(text => ctx.measureText(text).width)) + 10
    ctx.fillStyle = palette.background; ctx.fillRect(x, y, w, label.text.length * 15 + 6)
    ctx.strokeStyle = palette.gridAxis; ctx.strokeRect(x, y, w, label.text.length * 15 + 6)
    ctx.fillStyle = palette.foreground
    label.text.forEach((text, index) => ctx.fillText(text, x + 5, y + 14 + 15 * index))
  }
  ctx.restore()
  if (legend) {
    const x = width + 16, y = header + 24
    ctx.fillStyle = palette.foreground; ctx.font = '13px Arial, "Microsoft YaHei", sans-serif'
    ctx.fillText(legend.label, x, y)
    ctx.fillText(legend.unit ?? '', x, y + 22)
    const stops = legendStops(legend, palette), barHeight = legend.colorMode === 'buckling' ? 20 : 160
    const gradient = ctx.createLinearGradient(0, y + 40, 0, y + 40 + barHeight)
    if (legend.colorMode === 'signed') {
      gradient.addColorStop(0, palette.positive); gradient.addColorStop(0.4999, palette.positive)
      gradient.addColorStop(0.5, palette.negative); gradient.addColorStop(1, palette.negative)
    } else stops.forEach((color, index) => gradient.addColorStop(index / (stops.length - 1), color))
    ctx.fillStyle = gradient; ctx.fillRect(x, y + 40, 24, barHeight)
    ctx.fillStyle = palette.foreground
    const max = legend.maxValue * (legend.valueScale ?? 1)
    ctx.fillText(formatResultNumber(max, locale, max), x + 32, y + 50)
    if (legend.colorMode !== 'buckling') {
      ctx.fillText(formatResultNumber(legend.colorMode === 'signed' ? 0 : max / 2, locale, max), x + 32, y + 125)
      ctx.fillText(formatResultNumber(legend.colorMode === 'signed' ? -max : 0, locale, max), x + 32, y + 200)
    }
  }
  ctx.fillStyle = palette.foreground; ctx.font = '12px Arial, "Microsoft YaHei", sans-serif'
  ctx.fillText(note, 20, height + header + 25)
  if (unitsPerPixel && unitsPerPixel > 0) {
    const raw = unitsPerPixel * 100
    const base = 10 ** Math.floor(Math.log10(raw))
    const length = (raw / base >= 5 ? 5 : raw / base >= 2 ? 2 : 1) * base
    const pixels = length / unitsPerPixel, x = width - pixels - 24, y = height + header + 24
    ctx.strokeStyle = palette.foreground; ctx.lineWidth = 1.5
    ctx.beginPath(); ctx.moveTo(x, y - 4); ctx.lineTo(x, y); ctx.lineTo(x + pixels, y); ctx.lineTo(x + pixels, y - 4); ctx.stroke()
    ctx.fillText(`${formatResultNumber(length, locale)} ${lengthUnit ?? ''}`, x, y - 8)
  }
  const link = document.createElement('a')
  link.download = `${filename}@${scale}x.png`
  link.href = canvas.toDataURL('image/png'); link.click()
}
