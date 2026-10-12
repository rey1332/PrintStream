import { redirect } from 'next/navigation';

// TERMINAL has its own screen (Dashboard → TERMINAL); old links lead there.
export default function OldTerminalRedirect() {
  redirect('/terminal');
}
