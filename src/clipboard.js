import { spawnSync } from 'node:child_process'

function run(command, args, text) {
  return spawnSync(command, args, {
    input: text,
    encoding: 'utf8',
    windowsHide: true,
  })
}

export function copyToClipboard(value, { platform = process.platform, runner = run } = {}) {
  const text = String(value ?? '')
  if (!text) return { ok: false, error: 'There is no content to copy.' }

  let result
  if (platform === 'win32') {
    result = runner('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Set-Clipboard -Value ([Console]::In.ReadToEnd())',
    ], text)
  } else if (platform === 'darwin') {
    result = runner('pbcopy', [], text)
  } else {
    result = runner('wl-copy', [], text)
    if (result.error?.code === 'ENOENT') result = runner('xclip', ['-selection', 'clipboard'], text)
  }

  if (result.status === 0) return { ok: true, error: '' }
  return {
    ok: false,
    error: String(result.stderr || result.error?.message || 'Clipboard command failed.').trim(),
  }
}
