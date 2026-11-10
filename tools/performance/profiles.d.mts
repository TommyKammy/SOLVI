export type ProfileName = 'smoke' | 'baseline' | 'growth';

/** Numeric fields checked by validateProfile; its input name is not validated. */
export interface ValidatedProfile {
  seed: number;
  requestTimeoutMs: number;
  maxResponseBytes: number;
  users: number;
  tickets: number;
  activeSessions: number;
  roles: {
    requester: number;
    agent: number;
    admin: number;
    [role: string]: number;
  };
  warmupMs: number;
  durationMs: number;
  thinkTimeMs: number;
}

export interface PerformanceProfile extends ValidatedProfile {
  name: ProfileName;
}

/** Returns the same object after validating numeric fields, or throws. */
export function validateProfile<T>(profile: T): T & ValidatedProfile;

/** Returns an independent clone; unknown names throw UNKNOWN_PROFILE. */
export function getProfile(name: string): PerformanceProfile;

export const profileNames: readonly ProfileName[];
