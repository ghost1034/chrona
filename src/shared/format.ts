export function formatBytes(bytes: number): string {
  const b = Math.max(0, Math.floor(bytes))
  const kb = 1024
  const mb = kb * 1024
  const gb = mb * 1024

  if (b >= gb) return `${(b / gb).toFixed(2)} GB`
  if (b >= mb) return `${(b / mb).toFixed(1)} MB`
  if (b >= kb) return `${(b / kb).toFixed(1)} KB`
  return `${b} B`
}
