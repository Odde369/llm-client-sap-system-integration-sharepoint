export function isMemoryEnabled(memoryConfig: unknown): boolean {
  if (!memoryConfig || typeof memoryConfig !== 'object') return false;
  const cfg = memoryConfig as Record<string, unknown>;
  return cfg.disabled !== true && (cfg.enabled === true || cfg.endpoint != null);
}
