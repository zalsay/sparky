import setiTheme from '../seti-icon-theme.json'

const SETI_FILE_NAMES = Object.fromEntries(
  Object.entries(setiTheme.fileNames || {}).map(([key, value]) => [key.toLowerCase(), value]),
)
const SETI_FILE_EXTENSIONS = Object.fromEntries(
  Object.entries(setiTheme.fileExtensions || {}).map(([key, value]) => [key.toLowerCase(), value]),
)
const SETI_FILE_EXTENSION_KEYS = Object.keys(SETI_FILE_EXTENSIONS).sort((left, right) => right.length - left.length)
const SETI_ICON_DEFINITIONS = setiTheme.iconDefinitions || {}
const SETI_DEFAULT_FILE_ICON = setiTheme.file || '_default'
const SETI_FILE_NAME_ALIASES = {
  dockerfile: '_docker',
  'docker-compose.yml': '_docker_3',
  'docker-compose.yaml': '_docker_3',
  'compose.yml': '_docker_3',
  '.gitignore': '_git',
  '.gitmodules': '_git',
  '.editorconfig': '_config',
  '.env': '_config',
  'package.json': '_npm',
  'package-lock.json': '_npm',
  'cargo.lock': '_lock',
}
const SETI_EXTENSION_ALIASES = {
  rs: '_rust',
  md: '_markdown',
  mdx: '_markdown',
  txt: '_default',
  json: '_json',
  jsonl: '_json',
  yml: '_yml',
  yaml: '_yml',
  toml: '_config',
  sh: '_shell',
  bash: '_shell',
  zsh: '_shell',
  fish: '_shell',
  js: '_javascript',
  mjs: '_javascript',
  cjs: '_javascript',
  jsx: '_react',
  ts: '_typescript',
  mts: '_typescript',
  cts: '_typescript',
  tsx: '_react',
  css: '_css',
  scss: '_sass',
  sass: '_sass',
  less: '_less',
  html: '_html_3',
  htm: '_html_3',
  svg: '_svg',
  go: '_go2',
  py: '_python',
  lock: '_lock',
}
const SETI_ALIAS_EXTENSION_KEYS = Object.keys(SETI_EXTENSION_ALIASES).sort((left, right) => right.length - left.length)

function decodeSetiFontCharacter(value) {
  return String(value || '').replace(/\\([0-9a-fA-F]{4,6})/g, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
}

function resolveSetiFileIconId(name) {
  const normalized = String(name || '').trim().toLowerCase()

  if (!normalized) {
    return SETI_DEFAULT_FILE_ICON
  }

  if (SETI_FILE_NAMES[normalized]) {
    return SETI_FILE_NAMES[normalized]
  }

  if (normalized.startsWith('.env.')) {
    return '_config'
  }

  if (SETI_FILE_NAME_ALIASES[normalized]) {
    return SETI_FILE_NAME_ALIASES[normalized]
  }

  for (const extension of SETI_ALIAS_EXTENSION_KEYS) {
    if (normalized === extension || normalized.endsWith(`.${extension}`)) {
      return SETI_EXTENSION_ALIASES[extension]
    }
  }

  for (const extension of SETI_FILE_EXTENSION_KEYS) {
    if (normalized === extension || normalized.endsWith(`.${extension}`)) {
      return SETI_FILE_EXTENSIONS[extension]
    }
  }

  return SETI_DEFAULT_FILE_ICON
}

function resolveSetiFileIcon(name) {
  const iconId = resolveSetiFileIconId(name)
  return SETI_ICON_DEFINITIONS[iconId] || SETI_ICON_DEFINITIONS[SETI_DEFAULT_FILE_ICON] || null
}

export function TreeChevronIcon({ expanded }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M6 3.8 10.2 8 6 12.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
        transform={expanded ? 'rotate(90 8 8)' : undefined}
      />
    </svg>
  )
}

export function SetiFolderIcon({ expanded }) {
  if (expanded) {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d="M1.8 5.3h4.2l1.15 1.1h7.05v1.05H1.8z" fill="#e4bb68" />
        <path d="M1.8 6.2h12.4v1.25l-1.15 5.2H2.95L1.8 7.45z" fill="#dcb04d" />
        <path d="M1.8 6.2h12.4L13.1 13H2.95z" fill="#9c7424" opacity="0.28" />
      </svg>
    )
  }

  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M1.8 4.1h4.2l1.1 1.1h7.1v1.15H1.8z" fill="#e4bb68" />
      <path d="M1.8 5.1h12.4v6.8H1.8z" fill="#dcb04d" />
      <path d="M1.8 5.1h12.4v1.1H1.8z" fill="#9c7424" opacity="0.35" />
    </svg>
  )
}

export function SetiFileIcon({ name }) {
  const definition = resolveSetiFileIcon(name)
  const glyph = decodeSetiFontCharacter(definition?.fontCharacter)

  return (
    <span
      className="seti-file-icon"
      style={{ color: definition?.fontColor || '#d4d7d6' }}
      aria-hidden="true"
    >
      {glyph}
    </span>
  )
}
