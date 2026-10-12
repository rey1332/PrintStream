import { tr } from '@/lib/i18n/translate';
import { WorkflowError } from '@/lib/workflow/errors';
import type { ColumnLineage, DataTable } from '@/lib/workflow/types';
import { getField, isNumericType, type EntityKey, type FieldType } from './catalog';

export type JoinType = 'inner' | 'left' | 'right' | 'outer';

export interface KeyInfo {
  type?: FieldType;
  lineage?: ColumnLineage;
}

export function keyIdentifies(info: KeyInfo): EntityKey | undefined {
  const l = info.lineage;
  if (!l?.field || (l.op && l.op !== 'min' && l.op !== 'max')) return undefined;
  if (l.field === 'id') return l.entity;
  return getField(l.entity, l.field)?.references;
}

const kindOf = (t: FieldType) =>
  t === 'id'
    ? 'id'
    : isNumericType(t)
      ? 'number'
      : t === 'date' || t === 'datetime'
        ? 'date'
        : t === 'boolean'
          ? 'boolean'
          : 'text';

export function joinKeyProblem(
  left: KeyInfo,
  right: KeyInfo
): { left: string; right: string } | null {
  const le = keyIdentifies(left);
  const re = keyIdentifies(right);
  if (le && re) return le === re ? null : { left: le, right: re };
  if (left.type && right.type && kindOf(left.type) !== kindOf(right.type))
    return { left: left.type, right: right.type };
  return null;
}

export function joinTables(
  left: DataTable,
  right: DataTable,
  cfg: { leftKey: string; rightKey: string; joinType: JoinType }
): DataTable {
  const { leftKey, rightKey, joinType } = cfg;
  // Keyed errors, so the viewer sees the reason in their own language.
  if (!left.columns.includes(leftKey))
    throw new WorkflowError('wf.err.joinKeyMissing', { column: leftKey, side: tr('wf.side.left') });
  if (!right.columns.includes(rightKey))
    throw new WorkflowError('wf.err.joinKeyMissing', {
      column: rightKey,
      side: tr('wf.side.right'),
    });
  const problem = joinKeyProblem(
    { type: left.meta?.columnTypes?.[leftKey], lineage: left.meta?.lineage?.[leftKey] },
    { type: right.meta?.columnTypes?.[rightKey], lineage: right.meta?.lineage?.[rightKey] }
  );
  if (problem)
    throw new WorkflowError('wf.err.joinKeyMismatch', { left: leftKey, right: rightKey });

  const isEmpty = (v: unknown) => v === null || v === undefined || v === '';
  const rightMap = new Map<string, Record<string, any>>();
  let duplicates = 0;
  for (const r of right.rows) {
    if (isEmpty(r[rightKey])) continue;
    const k = String(r[rightKey]);
    if (rightMap.has(k)) duplicates++;
    else rightMap.set(k, r);
  }
  if (duplicates)
    throw new WorkflowError('wf.err.joinFanOut', { count: duplicates, column: rightKey });

  const leftCols = new Set(left.columns);
  const rename = (col: string) =>
    col === rightKey && rightKey === leftKey ? col : leftCols.has(col) ? `right.${col}` : col;
  const rightCols = right.columns.map(rename);
  const project = (r: Record<string, any>) =>
    Object.fromEntries(right.columns.map((c, i) => [rightCols[i], r[c]]));
  // A key column shared by both sides keeps the left value on unmatched rows.
  const emptyRight = Object.fromEntries(
    rightCols.filter((c) => !leftCols.has(c)).map((c) => [c, null])
  );
  const emptyLeft = Object.fromEntries(left.columns.map((c) => [c, null]));

  const rows: Record<string, any>[] = [];
  const uses = new Map<string, number>();
  for (const l of left.rows) {
    const k = String(l[leftKey]);
    const r = isEmpty(l[leftKey]) ? undefined : rightMap.get(k);
    if (r) {
      rows.push({ ...l, ...project(r) });
      uses.set(k, (uses.get(k) ?? 0) + 1);
    } else if (joinType === 'left' || joinType === 'outer') {
      rows.push({ ...l, ...emptyRight });
    }
  }
  if (joinType === 'right' || joinType === 'outer') {
    for (const [k, r] of rightMap) if (!uses.has(k)) rows.push({ ...emptyLeft, ...project(r) });
  }

  const columns = Array.from(new Set([...left.columns, ...rightCols]));
  const columnTypes = { ...left.meta?.columnTypes };
  const lineage = { ...left.meta?.lineage };
  right.columns.forEach((c, i) => {
    if (rightCols[i] === leftKey && leftCols.has(rightCols[i])) return;
    const type = right.meta?.columnTypes?.[c];
    if (type) columnTypes[rightCols[i]] = type;
    const origin = right.meta?.lineage?.[c];
    if (origin) lineage[rightCols[i]] = origin;
  });
  // A right row matched by several left rows repeats its values on each.
  const fanIn = [...uses.values()].some((n) => n > 1);
  const repeated = new Set(left.meta?.repeated ?? []);
  right.columns.forEach((c, i) => {
    const name = rightCols[i];
    if (name === leftKey && leftCols.has(name)) return;
    if (fanIn || right.meta?.repeated?.includes(c)) repeated.add(name);
  });
  return {
    columns,
    rows,
    meta: {
      count: rows.length,
      columnTypes,
      lineage,
      repeated: [...repeated],
      warnings: [...(left.meta?.warnings ?? []), ...(right.meta?.warnings ?? [])],
      fetchedAt: left.meta?.fetchedAt ?? right.meta?.fetchedAt,
      truncated: Boolean(left.meta?.truncated || right.meta?.truncated) || undefined,
      partial: Boolean(left.meta?.partial || right.meta?.partial) || undefined,
    },
  };
}
