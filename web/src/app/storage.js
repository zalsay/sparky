export function readStorage(...keys) {
  for (const key of keys) {
    const value = localStorage.getItem(key)
    if (value) {
      return value
    }
  }

  return ''
}

export function clearStorage(...keys) {
  keys.forEach((key) => localStorage.removeItem(key))
}

export function readNumberStorage(key, fallback) {
  const raw = localStorage.getItem(key)
  if (!raw) {
    return fallback
  }

  const value = Number(raw)
  return Number.isFinite(value) ? value : fallback
}
