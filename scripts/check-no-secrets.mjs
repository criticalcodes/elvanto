/**
 * Fails if anything credential-shaped or account-specific is tracked in git.
 *
 * Belt and braces alongside `.gitignore`: an ignore rule prevents an accident,
 * this catches one that already happened, and it runs in CI so nobody has to
 * remember. Aimed squarely at the risk this repository actually carries — an
 * Elvanto API key grants read access to every member and giving record in an
 * account, and the smoke sweep writes account-shaped output to disk.
 *
 * Precision matters more than reach here. The test fixtures are full of UUIDs and
 * personal names copied from Elvanto's published documentation, so a scanner that
 * flagged "looks like an ID" or "looks like a name" would fire constantly and get
 * ignored — which is worse than no scanner. Every rule below therefore targets a
 * credential *shape* or a known output filename, not merely high entropy.
 *
 * Usage:
 *   node scripts/check-no-secrets.mjs            # scan tracked files
 *   node scripts/check-no-secrets.mjs --staged    # scan staged changes (pre-commit)
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const staged = process.argv.includes('--staged')

/** Files that must never be tracked, whatever they contain. */
const FORBIDDEN_PATHS = [
  { pattern: /^\.env$/, why: 'holds live credentials' },
  { pattern: /^\.env\.(?!example$)/, why: 'holds live credentials' },
  { pattern: /(^|\/)report.*\.json$/, why: 'smoke sweep output; account-specific even when redacted' },
  { pattern: /\.tgz$/, why: 'build artefact' },
  { pattern: /(^|\/)coverage\//, why: 'build artefact' },
]

/**
 * Credential shapes. Each needs a *value* to match, so a placeholder such as
 * `ELVANTO_API_KEY=` or `apiKey: process.env.X` does not trip it.
 */
const SECRET_PATTERNS = [
  {
    name: 'Elvanto API key assignment',
    // A real key assigned inline, as opposed to read from the environment.
    pattern: /ELVANTO_(?:API_KEY|ACCESS_TOKEN)\s*[:=]\s*['"]?[A-Za-z0-9_\-]{16,}/,
  },
  {
    name: 'inline apiKey / accessToken literal',
    pattern: /\b(?:apiKey|accessToken|api_key|access_token)\s*[:=]\s*['"][A-Za-z0-9_\-]{20,}['"]/,
  },
  { name: 'bearer token', pattern: /\bBearer\s+[A-Za-z0-9_\-.=]{20,}/ },
  { name: 'GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}/ },
  { name: 'private key block', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: 'AWS access key id', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  {
    name: 'HTTP basic auth credentials',
    // base64 of "something:something" long enough to be a real key.
    pattern: /\bBasic\s+[A-Za-z0-9+/]{24,}={0,2}/,
  },
]

/**
 * Test files legitimately contain fake credentials, so they are exempt from the
 * value patterns — but never from the forbidden-path rules.
 */
const TEST_FILE = /(^|\/)(test|tests|__tests__)\//

/**
 * Markers of a documentation placeholder rather than a real credential.
 *
 * Needed because the setup instructions necessarily show the shape of a key
 * (`export ELVANTO_API_KEY=your-secret-api-key`), which is indistinguishable from
 * the real thing by length and character class alone. A real key does not say
 * "your" or "example" — so this keeps the rule strict about shape while still
 * letting the docs describe it.
 */
const PLACEHOLDER = new RegExp(
  [
    'your[-_ ]',
    'my[-_]',
    'example',
    'placeholder',
    'changeme',
    'change[-_]me',
    'redacted',
    'x{4,}',
    '<[a-z0-9-]+>',
    '\\b(?:demo|dummy|fake|sample|secret-api-key|test[-_]?key|runtime-check)\\b',
    '\\bABC|\\b123456',
  ].join('|'),
  'i',
)

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' })
}

function filesToScan() {
  const output = staged
    ? git(['diff', '--cached', '--name-only', '--diff-filter=ACMR'])
    : git(['ls-files'])
  return output.split('\n').filter((line) => line.trim() !== '')
}

const problems = []

for (const file of filesToScan()) {
  for (const { pattern, why } of FORBIDDEN_PATHS) {
    if (pattern.test(file)) {
      problems.push(`${file}: must not be committed — ${why}`)
    }
  }
}

for (const file of filesToScan()) {
  if (FORBIDDEN_PATHS.some(({ pattern }) => pattern.test(file))) continue
  if (TEST_FILE.test(file)) continue
  // This script names the patterns it looks for, so it would flag itself.
  if (file === 'scripts/check-no-secrets.mjs') continue

  let contents
  try {
    contents = readFileSync(file, 'utf8')
  } catch {
    continue // binary, deleted, or unreadable — nothing to scan
  }

  for (const { name, pattern } of SECRET_PATTERNS) {
    // `matchAll` rather than one shot: a placeholder earlier in the file must not
    // mask a real credential later in it.
    for (const match of contents.matchAll(new RegExp(pattern, 'g'))) {
      if (PLACEHOLDER.test(match[0])) continue
      const line = contents.slice(0, match.index).split('\n').length
      // Report the location and the rule, never the matched value.
      problems.push(`${file}:${line}: looks like a ${name}`)
    }
  }
}

if (problems.length > 0) {
  process.stderr.write(
    `Refusing to proceed — ${problems.length} problem${problems.length === 1 ? '' : 's'} found:\n\n`,
  )
  for (const problem of problems) process.stderr.write(`  ${problem}\n`)
  process.stderr.write(
    '\nIf a match is a false positive, narrow the pattern in ' +
      'scripts/check-no-secrets.mjs rather than deleting the check.\n' +
      'If a credential really was committed, rotate it — removing the commit is ' +
      'not enough once it has been pushed.\n',
  )
  process.exit(1)
}

process.stdout.write(
  `no secrets or account data in ${staged ? 'staged changes' : 'tracked files'}\n`,
)
