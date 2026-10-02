export function shouldShowOpenInPicker(input: {
  readonly activeProjectName: string | undefined;
}): boolean {
  return Boolean(input.activeProjectName);
}
