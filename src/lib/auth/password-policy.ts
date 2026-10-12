export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_BYTES = 72;

export type PasswordProblem = 'too_short' | 'too_long';

export function newPasswordProblem(password: string): PasswordProblem | null {
  if ([...password].length < PASSWORD_MIN_LENGTH) return 'too_short';
  if (new TextEncoder().encode(password).length > PASSWORD_MAX_BYTES) return 'too_long';
  return null;
}
