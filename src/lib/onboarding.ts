import { AppSettings } from '../types';

function normalizedBuildId(buildId: string | undefined): string {
  const cleaned = (buildId ?? '').trim();
  return cleaned || 'unknown-build';
}

export function shouldShowOnboardingForBuild(settings: Pick<AppSettings, 'completedOnboardingBuildId'>, buildId: string): boolean {
  return normalizedBuildId(settings.completedOnboardingBuildId) !== normalizedBuildId(buildId);
}

export function markOnboardingCompletedForBuild<T extends AppSettings>(settings: T, buildId: string): T {
  return {
    ...settings,
    annotationMode: false,
    completedOnboardingBuildId: normalizedBuildId(buildId),
  };
}
