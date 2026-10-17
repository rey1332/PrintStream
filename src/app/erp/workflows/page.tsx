import { redirect } from 'next/navigation';

// Workflows became Terminal pipelines (decision R-03): the list lives in
// Terminal; the editor has its own window at /pipelines/[id].
export default function WorkflowsRedirect() {
  redirect('/terminal?tab=pipelines');
}
