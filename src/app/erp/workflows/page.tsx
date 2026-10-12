import { redirect } from 'next/navigation';

// Workflows became TERMINAL pipelines (decision R-03): the list lives in
// TERMINAL; the editor has its own window at /pipelines/[id].
export default function WorkflowsRedirect() {
  redirect('/terminal?tab=pipelines');
}
