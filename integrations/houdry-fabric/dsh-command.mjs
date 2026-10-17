// Splitting a command line typed into an environment variable.
//
// `DSH_CMD='pnpm dsh'` and `DSH_CMD='node C:\tools\dsh\dsh.mjs'` both have to
// reach the launcher as two words, and a path with a space has to survive as
// one. Every launcher would otherwise re-invent this in its own dialect —
// PowerShell's `-split ' '` produced the duplicated-word bug this replaces, and
// `sh` would need `eval`, which executes whatever the variable contains.

/**
 * Shell-style tokens: whitespace separates words, single quotes are literal,
 * double quotes group and allow \" and \\, a bare backslash escapes one
 * character. An unbalanced quote is an error rather than a silent truncation —
 * a half-parsed launcher command fails in a way the operator can read.
 */
export function tokenizeCommand(line) {
  const text = String(line ?? '').trim()

  if (text === '') {
    return []
  }

  const args = []
  let current = ''
  let started = false
  let quote = ''
  let i = 0

  const push = () => {
    if (started) {
      args.push(current)
    }

    current = ''
    started = false
  }

  while (i < text.length) {
    const char = text[i]

    if (quote) {
      if (char === quote) {
        quote = ''
        i += 1
        continue
      }

      if (quote === '"' && char === '\\' && (text[i + 1] === '"' || text[i + 1] === '\\')) {
        current += text[i + 1]
        i += 2
        continue
      }

      current += char
      i += 1
      continue
    }

    if (char === "'" || char === '"') {
      quote = char
      started = true
      i += 1
      continue
    }

    if (char === '\\') {
      if (i + 1 >= text.length) {
        throw new Error(`trailing backslash in "${text}"`)
      }

      current += text[i + 1]
      started = true
      i += 2
      continue
    }

    if (/\s/.test(char)) {
      push()
      i += 1
      continue
    }

    current += char
    started = true
    i += 1
  }

  if (quote) {
    throw new Error(`unterminated ${quote === '"' ? 'double' : 'single'} quote in "${text}"`)
  }

  push()

  return args
}

/** Tokens the launcher should run: DSH_CMD when set, otherwise `dsh`. */
export function dshLaunchCommand(env = process.env) {
  const raw = (env.DSH_CMD ?? '').trim()

  if (raw === '') {
    return ['dsh']
  }

  return tokenizeCommand(raw)
}
