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
    // Staged monitors must stay executable even when their source mode is 0644.
    executableFiles: [...new Set([...(existingConfig.executableFiles ?? []), ...monitors])],
  };
}
