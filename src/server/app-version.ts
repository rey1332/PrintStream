import packageJson from '../../package.json';

export const APP_VERSION: string =
  typeof packageJson.version === 'string' ? packageJson.version : 'unknown';
