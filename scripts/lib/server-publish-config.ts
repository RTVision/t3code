interface PublishConfig {
  registry?: string;
  executableFiles?: ReadonlyArray<string>;
}

export function createServerPublishConfig(
  registry: string,
  resourceMonitorFiles: ReadonlyArray<string>,
  existingConfig: PublishConfig = {},
) {
  const monitors = resourceMonitorFiles
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => /(^|\/)t3-resource-monitor$/.test(file))
    .map((file) => `dist/resource-monitor/${file}`);

  return {
    ...existingConfig,
    registry,
    // pnpm normalizes non-bin files to 0644 unless explicitly listed here.
    executableFiles: [...new Set([...(existingConfig.executableFiles ?? []), ...monitors])],
  };
}
