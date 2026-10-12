import { redirect } from 'next/navigation';

// The pipeline editor has its own window (outside the ERP): /pipelines/[id].
export default async function WorkflowEditorRedirect({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/pipelines/${encodeURIComponent(id)}`);
}
