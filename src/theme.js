// Theme + palette resolution for Akorith's terminal UI.
// Loads an optional ~/.akorith/theme.json and merges it over the dark
// defaults. Detects light backgrounds (via COLORFGBG) and swaps the diff
// bars for foreground-only styling so additions/removals stay readable on
// light terminals.
//
// Theme file format (~/.akorith/theme.json):
//   {
//     "background": "dark" | "light" | "auto",
//     "colors": {
//       "text": "#dcdde0", "dim": "#85868c", "faint": "#5c5d63",
//       "violet": "#a78bfa", "green": "#34d399", "red": "#f87171",
//       "yellow": "#fbbf24", "cyan": "#38bdf8"
//     }
//   }
//
// Any missing color falls back to the dark default. `background: "auto"`
// probes COLORFGBG (a convention used by many terminals: "fg;bg" where a
// bg value >= 7 indicates a light background).

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DEFAULT_DARK = {
  text: '#dcdde0', dim: '#85868c', faint: '#5c5d63',
  violet: '#a78bfa', green: '#34d399', red: '#f87171',
  yellow: '#fbbf24', cyan: '#38bdf8',
}

// Light-mode palette: darker text/accents for legibility on white bg.
const DEFAULT_LIGHT = {
  text: '#1f2024', dim: '#5a5b62', faint: '#8a8b92',
  violet: '#6d28d9', green: '#047857', red: '#b91c1c',
  yellow: '#b45309', cyan: '#0369a1',
}

const FALLBACK_256 = {
  text: 255, dim: 245, faint: 240,
  violet: 141, green: 42, red: 210, yellow: 214, cyan: 81,
}
const FALLBACK_256_LIGHT = {
  text: 232, dim: 242, faint: 248,
  violet: 91, green: 29, red: 124, yellow: 130, cyan: 25,
}

function loadThemeFile() {
  try {
    const raw = readFileSync(join(homedir(), '.akorith', 'theme.json'), 'utf8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function detectLightBackground() {
  // COLORFGBG is "fg;bg" — many terminals set it. bg >= 7 ⇒ light.
  const c = process.env.COLORFGBG
  if (c) {
    const parts = String(c).split(';')
    const bg = Number(parts[1])
    if (Number.isFinite(bg)) return bg >= 7
  }
  return false
}

function resolve() {
  const file = loadThemeFile() || {}
  let light = false
  if (file.background === 'light') light = true
  else if (file.background === 'dark') light = false
  else light = detectLightBackground() // "auto" or unspecified

  const base = light ? DEFAULT_LIGHT : DEFAULT_DARK
  const fallback = light ? FALLBACK_256_LIGHT : FALLBACK_256
  const colors = { ...base, ...(file.colors || {}) }
  return { light, colors, fallback }
}

const { light, colors, fallback } = resolve()

export const isLightBackground = light
export const palette = colors
export const palette256 = fallback

export function color(name) {
  return colors[name] || DEFAULT_DARK[name] || '#dcdde0'
}
