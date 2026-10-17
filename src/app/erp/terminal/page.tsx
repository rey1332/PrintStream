import { redirect } from 'next/navigation';

// Terminal has its own screen (Dashboard → Terminal); old links lead there.
export default function OldTerminalRedirect() {
  redirect('/terminal');
}
