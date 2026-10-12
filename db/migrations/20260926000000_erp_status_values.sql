-- ─── ERP status values (additive) ─────────────────────────────────────────────
-- New terminal states used by the cancellation / void flows introduced in the
-- following migrations. Existing values are untouched. The values live in their
-- own migration so they are committed before any function, constraint, or
-- index refers to them (PostgreSQL cannot use a new enum value inside the
-- transaction that added it).
--
-- Older app versions do not know these values; they only ever filter on the
-- existing values, so cancelled/void rows simply drop out of their open lists.

ALTER TYPE public.po_status ADD VALUE IF NOT EXISTS 'cancelled';
ALTER TYPE public.so_status ADD VALUE IF NOT EXISTS 'cancelled';
ALTER TYPE public.invoice_status ADD VALUE IF NOT EXISTS 'void';
