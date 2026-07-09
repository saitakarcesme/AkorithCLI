#!/usr/bin/env node
import { runUpdateCommand } from '../src/commands.js'

const argv = process.argv.slice(2)
const target = argv[0]

if (target === 'akorith' || target === '--akorith' || target === '-a') {
  const code = runUpdateCommand()
  process.exit(code)
}

if (!target || target === '--help' || target === '-h') {
  console.log('Usage: update akorith   — update the Akorith CLI from this repo (or npm if installed from the registry).')
  console.log('Inside the Akorith workspace you can also use /update or `akorith update`.')
  process.exit(0)
}

console.error(`update: unknown target "${target}". Try: update akorith`)
process.exit(1)