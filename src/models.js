import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const CODEX_REASONING_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh'])

export function normalizeModelSelection(selection = {}) {
  const normalized = { ...selection }
  if (normalized.provider !== 'codex') return normalized

  let model = normalized.model == null ? null : String(normalized.model).trim()
  let reasoningEffort = CODEX_REASONING_EFFORTS.has(normalized.reasoningEffort)
    ? normalized.reasoningEffort
    : null
  const legacyEffort = model?.match(/^(.*)-(low|medium|high|xhigh)$/i)
  if (legacyEffort) {
    model = legacyEffort[1]
    reasoningEffort ||= legacyEffort[2].toLowerCase()
  }

  normalized.model = model || null
  if (reasoningEffort) normalized.reasoningEffort = reasoningEffort
  else delete normalized.reasoningEffort
  return normalized
}

export function modelSelectionSpec(selection = {}) {
  const normalized = normalizeModelSelection(selection)
  const model = normalized.model ? `/${normalized.model}` : ''
  const effort = normalized.provider === 'codex' && normalized.model && normalized.reasoningEffort
    ? `-${normalized.reasoningEffort}`
    : ''
  return `${normalized.provider || ''}${model}${effort}`
}

export function loadCodexModels({ home = homedir(), readFile = readFileSync } = {}) {
  try {
    const cache = JSON.parse(readFile(join(home, '.codex', 'models_cache.json'), 'utf8'))
    const models = Array.isArray(cache) ? cache : cache.models
    if (!Array.isArray(models)) return []
    return models
      .filter((model) => model?.slug && model.visibility !== 'hide')
      .sort((left, right) => (Number(left.priority) || 999) - (Number(right.priority) || 999))
      .map((model) => ({
        slug: String(model.slug),
        displayName: String(model.display_name || model.slug),
        defaultReasoningEffort: CODEX_REASONING_EFFORTS.has(model.default_reasoning_level)
          ? model.default_reasoning_level
          : null,
        reasoningEfforts: Array.isArray(model.supported_reasoning_levels)
          ? model.supported_reasoning_levels.map((level) => level?.effort).filter((effort) => CODEX_REASONING_EFFORTS.has(effort))
          : [],
      }))
  } catch {
    return []
  }
}
