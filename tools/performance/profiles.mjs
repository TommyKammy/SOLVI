/** Synthetic comparison inputs, not a claim about the production workload. */
const common = {
  seed: 41,
  requestTimeoutMs: 10_000,
  maxResponseBytes: 8 * 1024 * 1024,
};

const profiles = {
  smoke: {
    ...common,
    name: 'smoke',
    users: 120,
    tickets: 2400,
    activeSessions: 12,
    roles: { requester: 10, agent: 1, admin: 1 },
    warmupMs: 2000,
    durationMs: 10_000,
    thinkTimeMs: 500,
  },
  baseline: {
    ...common,
    name: 'baseline',
    users: 4000,
    tickets: 48_000,
    activeSessions: 100,
    roles: { requester: 90, agent: 9, admin: 1 },
    warmupMs: 10_000,
    durationMs: 60_000,
    thinkTimeMs: 2000,
  },
  growth: {
    ...common,
    name: 'growth',
    users: 4000,
    tickets: 100_000,
    activeSessions: 100,
    roles: { requester: 90, agent: 9, admin: 1 },
    warmupMs: 10_000,
    durationMs: 60_000,
    thinkTimeMs: 2000,
  },
};

export function validateProfile(profile) {
  const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
  if (
    !profile ||
    !integer(profile.users, 20, 4000) ||
    !integer(profile.tickets, 100, 100_000) ||
    !integer(profile.activeSessions, 3, 100) ||
    profile.users < profile.activeSessions + 7 ||
    !integer(profile.warmupMs, 1000, 30_000) ||
    !integer(profile.durationMs, 1000, 120_000) ||
    !integer(profile.thinkTimeMs, 100, 10_000) ||
    !integer(profile.requestTimeoutMs, 100, 15_000) ||
    !integer(profile.maxResponseBytes, 1024, 8 * 1024 * 1024) ||
    !integer(profile.seed, 1, 1_000_000) ||
    !['requester', 'agent', 'admin'].every((role) => integer(profile.roles?.[role], 1, 100)) ||
    Object.values(profile.roles).reduce((total, count) => total + count, 0) !==
      profile.activeSessions
  ) {
    throw new Error('INVALID_PROFILE');
  }
  return profile;
}

export function getProfile(name) {
  if (!Object.hasOwn(profiles, name)) throw new Error('UNKNOWN_PROFILE');
  return validateProfile(structuredClone(profiles[name]));
}

export const profileNames = Object.freeze(Object.keys(profiles));
