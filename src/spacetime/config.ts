declare const process: any;

export interface SpaceTimeConfig {
  endpoint: string;
  readonly walletPrivateKey?: string;
  schema: string;
  instanceId?: string;
  accountId?: string;
  playerId?: string;
  characterId?: string;
  playerDisplayName?: string;
  username?: string;
  password?: string;
}

export interface AuthenticatedSpaceTimeConfig extends SpaceTimeConfig {
  readonly instanceId: string;
  readonly accountId: string;
  readonly playerId: string;
  readonly characterId: string;
  readonly playerDisplayName: string;
  readonly username: string;
}

export type RuntimeEnvironmentId = 'local' | 'maincloud';

export interface RuntimeEnvironmentOption {
  readonly id: RuntimeEnvironmentId;
  readonly label: string;
  readonly endpoint: string;
  readonly schema: string;
}

export const LOCAL_DEV_ENVIRONMENT: RuntimeEnvironmentOption = {
  id: 'local',
  label: 'Dev Environment',
  endpoint: import.meta.env.VITE_SPACE_TIME_ENDPOINT ?? 'ws://127.0.0.1:3000',
  schema: import.meta.env.VITE_SPACE_TIME_SCHEMA ?? 'mmo'
};

export const MAINCLOUD_ENVIRONMENT: RuntimeEnvironmentOption = {
  id: 'maincloud',
  label: 'Maincloud',
  endpoint: 'https://maincloud.spacetimedb.com',
  schema: 'spacetimemmo'
};

export const RUNTIME_ENVIRONMENTS: readonly RuntimeEnvironmentOption[] = [
  LOCAL_DEV_ENVIRONMENT,
  MAINCLOUD_ENVIRONMENT
];

// Helper to check process.env (for Node.js simulation) or fallback to undefined
function getEnv(key: string): string | undefined {
  if (typeof process !== 'undefined' && process.env && process.env[key]) {
    return process.env[key];
  }
  return undefined;
}

// We must explicitly access import.meta.env.VITE_XXX for Vite replacement to work in production.
// Dynamic access (import.meta.env[key]) does not work for bundled variables.
export function loadSpaceTimeConfig(): SpaceTimeConfig {
  // Priority: process.env (Sim) -> import.meta.env.VITE_... (Client) -> Throw

  const endpoint =
    getEnv('SPACE_TIME_ENDPOINT') ??
    getEnv('VITE_SPACE_TIME_ENDPOINT') ??
    import.meta.env.VITE_SPACE_TIME_ENDPOINT;

  const walletPrivateKey =
    getEnv('SPACE_TIME_WALLET_PRIVATE_KEY') ??
    getEnv('VITE_SPACE_TIME_WALLET_PRIVATE_KEY') ??
    import.meta.env.VITE_SPACE_TIME_WALLET_PRIVATE_KEY;

  const schema =
    getEnv('SPACE_TIME_SCHEMA') ??
    getEnv('VITE_SPACE_TIME_SCHEMA') ??
    import.meta.env.VITE_SPACE_TIME_SCHEMA;

  const instanceId =
    getEnv('SPACE_TIME_INSTANCE_ID') ??
    getEnv('VITE_SPACE_TIME_INSTANCE_ID') ??
    import.meta.env.VITE_SPACE_TIME_INSTANCE_ID;

  const accountId =
    getEnv('SPACE_TIME_ACCOUNT_ID') ??
    getEnv('VITE_SPACE_TIME_ACCOUNT_ID') ??
    import.meta.env.VITE_SPACE_TIME_ACCOUNT_ID;

  const playerId =
    getEnv('SPACE_TIME_PLAYER_ID') ??
    getEnv('VITE_SPACE_TIME_PLAYER_ID') ??
    import.meta.env.VITE_SPACE_TIME_PLAYER_ID;

  const characterId =
    getEnv('SPACE_TIME_CHARACTER_ID') ??
    getEnv('VITE_SPACE_TIME_CHARACTER_ID') ??
    import.meta.env.VITE_SPACE_TIME_CHARACTER_ID;

  const playerDisplayName =
    getEnv('SPACE_TIME_PLAYER_DISPLAY_NAME') ??
    getEnv('VITE_SPACE_TIME_PLAYER_DISPLAY_NAME') ??
    import.meta.env.VITE_SPACE_TIME_PLAYER_DISPLAY_NAME;

  const username =
    getEnv('SPACE_TIME_USERNAME') ??
    getEnv('VITE_SPACE_TIME_USERNAME') ??
    import.meta.env.VITE_SPACE_TIME_USERNAME;

  const password =
    getEnv('SPACE_TIME_PASSWORD') ??
    getEnv('VITE_SPACE_TIME_PASSWORD') ??
    import.meta.env.VITE_SPACE_TIME_PASSWORD;

  if (!endpoint) throw new Error('Missing Config: VITE_SPACE_TIME_ENDPOINT');
  if (!schema) throw new Error('Missing Config: VITE_SPACE_TIME_SCHEMA');

  return {
    endpoint,
    walletPrivateKey: walletPrivateKey || undefined, // Ensure empty string becomes undefined
    schema,
    instanceId,
    accountId,
    playerId,
    characterId,
    playerDisplayName,
    username,
    password: password || undefined
  };
}

export function applyRuntimeEnvironment(
  config: SpaceTimeConfig,
  environmentId: RuntimeEnvironmentId
): void {
  const environment =
    RUNTIME_ENVIRONMENTS.find((candidate) => candidate.id === environmentId) ??
    MAINCLOUD_ENVIRONMENT;

  config.endpoint = environment.endpoint;
  config.schema = environment.schema;
}

export function requireAuthenticatedConfig(
  config: SpaceTimeConfig
): AuthenticatedSpaceTimeConfig {
  if (!config.instanceId) throw new Error('Missing authenticated config: instanceId');
  if (!config.accountId) throw new Error('Missing authenticated config: accountId');
  if (!config.playerId) throw new Error('Missing authenticated config: playerId');
  if (!config.characterId) throw new Error('Missing authenticated config: characterId');
  if (!config.playerDisplayName) {
    throw new Error('Missing authenticated config: playerDisplayName');
  }
  if (!config.username) throw new Error('Missing authenticated config: username');

  return config as AuthenticatedSpaceTimeConfig;
}
