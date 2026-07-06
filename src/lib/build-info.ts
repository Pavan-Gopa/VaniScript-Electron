declare const __VANISCRIPT_BUILD_ID__: string | undefined;

export function currentBuildId(): string {
  if (typeof __VANISCRIPT_BUILD_ID__ === 'string' && __VANISCRIPT_BUILD_ID__.trim()) {
    return __VANISCRIPT_BUILD_ID__.trim();
  }
  return 'development';
}
