export function formatUptime(seconds: number | null | undefined) {
  if (seconds == null) return '';
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
