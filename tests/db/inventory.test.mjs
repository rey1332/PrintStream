import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDb, createUser, asUser, run, admin, expectError, items } from './harness.mjs';

let db;
let owner;

before(async () => {
  db = await createDb();
  owner = await createUser(db, 'owner');
});

async function newProduct(user, name, stock) {
  const [row] = await run(
    db, user,
    `insert into erp_products (user_id, name, current_stock, purchase_price, selling_price)
     values ($1, $2, $3, 5, 10) returning id`,
    [user.id, name, stock]
  );
  return row.id;
}

async function createSalesOrder(user, lineSpec) {
  const [row] = await run(
    db, user,
    `select erp_create_sales_order_v3(null, null, 'Walk-in', current_date, '', $1::jsonb, null, null) as id`,
    [items(...lineSpec)]
  );
  return row.id;
}

async function availability(productId) {
  const [row] = await admin(
    db,
    `select on_hand::float8 as on_hand, reserved::float8 as reserved, available::float8 as available from erp_product_availability where product_id = $1`,
    [productId]
  );
  return row;
}

async function orderItems(orderId) {
  return admin(db, `select id, product_id, qty::float8 as qty, qty_delivered::float8 as qty_delivered from erp_sales_order_items where sales_order_id = $1 order by qty`, [orderId]);
}

test('creating a sales order reserves stock and rejects orders beyond availability', async () => {
  const product = await newProduct(owner, 'Widget', 10);
  await createSalesOrder(owner, [[product, 6]]);
  assert.deepEqual(await availability(product), { on_hand: 10, reserved: 6, available: 4 });

  await expectError(createSalesOrder(owner, [[product, 5]]), /Insufficient available stock for Widget \(available 4, requested 5\)/);
  // The failed order left nothing behind.
  assert.equal((await admin(db, `select count(*)::int as n from erp_sales_orders where user_id = $1`, [owner.id]))[0].n, 1);

  await createSalesOrder(owner, [[product, 4]]);
  assert.deepEqual(await availability(product), { on_hand: 10, reserved: 10, available: 0 });
});

test('the same product on two lines of one order is checked as a total', async () => {
  const product = await newProduct(owner, 'Split', 5);
  await expectError(createSalesOrder(owner, [[product, 3], [product, 3]]), /available 5, requested 6/);
});

test('editing draft quantities re-reserves atomically', async () => {
  const product = await newProduct(owner, 'Editable', 10);
  const order = await createSalesOrder(owner, [[product, 4]]);
  await createSalesOrder(owner, [[product, 5]]);

  await expectError(
    run(db, owner, `select erp_update_sales_order_items($1, $2::jsonb)`, [order, items([product, 6])]),
    /available 5, requested 6/
  );
  assert.deepEqual(await availability(product), { on_hand: 10, reserved: 9, available: 1 });

  await run(db, owner, `select erp_update_sales_order_items($1, $2::jsonb)`, [order, items([product, 5])]);
  assert.deepEqual(await availability(product), { on_hand: 10, reserved: 10, available: 0 });
  const [total] = await admin(db, `select total from erp_sales_orders where id = $1`, [order]);
  assert.equal(Number(total.total), 50);

  await run(db, owner, `select erp_issue_invoice_from_sales_order_v2($1, null, null)`, [order]);
  await expectError(
    run(db, owner, `select erp_update_sales_order_items($1, $2::jsonb)`, [order, items([product, 1])]),
    /Only draft sales orders can be edited/
  );
});

test('cancelling releases the reservation and needs a reason', async () => {
  const product = await newProduct(owner, 'Cancelable', 3);
  const order = await createSalesOrder(owner, [[product, 3]]);
  await expectError(run(db, owner, `select erp_cancel_sales_order($1, '')`, [order]), /reason/);
  await run(db, owner, `select erp_cancel_sales_order($1, 'Customer withdrew')`, [order]);
  assert.deepEqual(await availability(product), { on_hand: 3, reserved: 0, available: 3 });
  const [row] = await admin(db, `select status, cancel_reason from erp_sales_orders where id = $1`, [order]);
  assert.deepEqual(row, { status: 'cancelled', cancel_reason: 'Customer withdrew' });
  // Idempotent.
  await run(db, owner, `select erp_cancel_sales_order($1, 'again')`, [order]);
  await expectError(run(db, owner, `select erp_issue_invoice_from_sales_order_v2($1, null, null)`, [order]), /Only draft orders can be invoiced/);
});

test('cancelling an invoiced order voids its unpaid invoice; paid invoices block cancellation', async () => {
  const product = await newProduct(owner, 'InvoicedCancel', 10);
  const order = await createSalesOrder(owner, [[product, 2]]);
  const [{ id: invoice }] = await run(db, owner, `select erp_issue_invoice_from_sales_order_v2($1, null, null) as id`, [order]);
  const [{ id: payment }] = await run(
    db, owner,
    `insert into erp_payments (user_id, payment_type, party, amount, invoice_id) values ($1, 'incoming', 'Walk-in', 5, $2) returning id`,
    [owner.id, invoice]
  );
  await expectError(run(db, owner, `select erp_cancel_sales_order($1, 'Wrong order')`, [order]), /Void the payments/);
  await run(db, owner, `select erp_void_payment($1, 'Recorded twice')`, [payment]);
  await run(db, owner, `select erp_cancel_sales_order($1, 'Wrong order')`, [order]);
  const [inv] = await admin(db, `select status, payment_state from erp_invoices where id = $1`, [invoice]);
  assert.deepEqual(inv, { status: 'void', payment_state: 'void' });
  assert.equal((await availability(product)).reserved, 0);
});

test('partial deliveries move only delivered quantities and retries are idempotent', async () => {
  const product = await newProduct(owner, 'Partial', 10);
  const order = await createSalesOrder(owner, [[product, 6]]);
  await run(db, owner, `select erp_issue_invoice_from_sales_order_v2($1, null, null)`, [order]);
  const [line] = await orderItems(order);
  const requestId = randomUUID();
  const deliver = (qty, rid = requestId) =>
    run(db, owner, `select erp_record_sales_delivery($1, $2::jsonb, $3) as id`, [
      order, JSON.stringify([{ item_id: line.id, qty }]), rid,
    ]);

  const [{ id: first }] = await deliver(2);
  const [{ id: retried }] = await deliver(2);
  assert.equal(retried, first, 'retry returns the original event');

  assert.deepEqual(await availability(product), { on_hand: 8, reserved: 4, available: 4 });
  const movements = await admin(db, `select movement_type, quantity::float8 as quantity from erp_stock_movements where product_id = $1 and movement_type = 'out'`, [product]);
  assert.deepEqual(movements, [{ movement_type: 'out', quantity: 2 }]);
  assert.equal((await orderItems(order))[0].qty_delivered, 2);
  assert.equal((await admin(db, `select status from erp_sales_orders where id = $1`, [order]))[0].status, 'invoiced');

  await expectError(deliver(5, randomUUID()), /exceeds the remaining 4 units/);

  await deliver(4, randomUUID());
  assert.equal((await admin(db, `select status from erp_sales_orders where id = $1`, [order]))[0].status, 'delivered');
  assert.deepEqual(await availability(product), { on_hand: 4, reserved: 0, available: 4 });
  const total = await admin(db, `select sum(quantity)::int as n from erp_stock_movements where product_id = $1 and movement_type = 'out'`, [product]);
  assert.equal(total[0].n, 6, 'no duplicate movements after completing the order');
});

test('legacy "deliver" after a partial delivery moves only the remainder', async () => {
  const product = await newProduct(owner, 'Mixed', 10);
  const order = await createSalesOrder(owner, [[product, 5]]);
  await run(db, owner, `select erp_issue_invoice_from_sales_order_v2($1, null, null)`, [order]);
  const [line] = await orderItems(order);
  await run(db, owner, `select erp_record_sales_delivery($1, $2::jsonb, $3)`, [
    order, JSON.stringify([{ item_id: line.id, qty: 2 }]), randomUUID(),
  ]);
  await run(db, owner, `select erp_deliver_sales_order($1)`, [order]);
  const [p] = await admin(db, `select current_stock::float8 as current_stock from erp_products where id = $1`, [product]);
  assert.equal(p.current_stock, 5);
  assert.equal((await orderItems(order))[0].qty_delivered, 5);
  const [legacy] = await admin(db, `select quantity::float8 as quantity, note from erp_stock_movements where product_id = $1 and note like 'Auto: Sales Order delivered%'`, [product]);
  assert.equal(legacy.quantity, 3);
});

test('delivery still refuses to ship more than is physically on hand', async () => {
  const product = await newProduct(owner, 'Shrinkage', 5);
  const order = await createSalesOrder(owner, [[product, 5]]);
  await run(db, owner, `select erp_issue_invoice_from_sales_order_v2($1, null, null)`, [order]);
  // Stock written off after the reservation was made.
  await run(db, owner, `select erp_adjust_stock($1, 'out', 3, 'Damaged')`, [product]);
  await expectError(run(db, owner, `select erp_deliver_sales_order($1)`, [order]), /Insufficient stock for Shrinkage \(available 2, required 5\)/);
  assert.equal((await admin(db, `select status from erp_sales_orders where id = $1`, [order]))[0].status, 'invoiced');
  assert.equal((await admin(db, `select current_stock::float8 as current_stock from erp_products where id = $1`, [product]))[0].current_stock, 2);
});

test('partial purchase receipts, legacy receive, and no double counting', async () => {
  const product = await newProduct(owner, 'Inbound', 0);
  const [{ id: po }] = await run(
    db, owner,
    `select erp_create_purchase_order_v3(null, null, 'Supplier', current_date, '', $1::jsonb, null, null) as id`,
    [items([product, 10, 4])]
  );
  await run(db, owner, `select erp_update_purchase_order_status($1, 'approved')`, [po]);
  const [line] = await admin(db, `select id from erp_purchase_order_items where purchase_order_id = $1`, [po]);
  const rid = randomUUID();
  const receive = (qty, requestId) =>
    run(db, owner, `select erp_record_purchase_receipt_v2($1, $2::jsonb, $3, '', null) as id`, [po, JSON.stringify([{ item_id: line.id, qty }]), requestId]);

  const [{ id: event }] = await receive(4, rid);
  assert.equal((await receive(4, rid))[0].id, event);
  assert.equal((await admin(db, `select current_stock::float8 as current_stock from erp_products where id = $1`, [product]))[0].current_stock, 4);

  await run(db, owner, `select erp_update_purchase_order_status($1, 'received')`, [po]);
  assert.equal((await admin(db, `select current_stock::float8 as current_stock from erp_products where id = $1`, [product]))[0].current_stock, 10);
  const [{ n }] = await admin(db, `select sum(quantity)::int as n from erp_stock_movements where product_id = $1 and movement_type = 'in'`, [product]);
  assert.equal(n, 10);
  await expectError(receive(1, randomUUID()), /Only approved purchase orders can be received/);
});

test('reversing a receipt writes opposite movements and steps the status back', async () => {
  const product = await newProduct(owner, 'Reversible', 0);
  const [{ id: po }] = await run(db, owner, `select erp_create_purchase_order_v3(null, null, 'Supplier', current_date, '', $1::jsonb, null, null) as id`, [items([product, 3, 4])]);
  await run(db, owner, `select erp_update_purchase_order_status($1, 'approved')`, [po]);
  const [line] = await admin(db, `select id from erp_purchase_order_items where purchase_order_id = $1`, [po]);
  const [{ id: event }] = await run(db, owner, `select erp_record_purchase_receipt_v2($1, $2::jsonb, $3, '', null) as id`, [po, JSON.stringify([{ item_id: line.id, qty: 3 }]), randomUUID()]);
  assert.equal((await admin(db, `select status from erp_purchase_orders where id = $1`, [po]))[0].status, 'received');

  await expectError(run(db, owner, `select erp_reverse_fulfillment_event($1, '', $2)`, [event, randomUUID()]), /reason/);
  const rid = randomUUID();
  const [{ id: reversal }] = await run(db, owner, `select erp_reverse_fulfillment_event($1, 'Wrong item delivered', $2) as id`, [event, rid]);
  assert.equal((await run(db, owner, `select erp_reverse_fulfillment_event($1, 'Wrong item delivered', $2) as id`, [event, rid]))[0].id, reversal);
  await expectError(run(db, owner, `select erp_reverse_fulfillment_event($1, 'Again please', $2)`, [event, randomUUID()]), /already been reversed/);

  const [po2] = await admin(db, `select status from erp_purchase_orders where id = $1`, [po]);
  assert.equal(po2.status, 'approved');
  assert.equal((await admin(db, `select current_stock::float8 as current_stock from erp_products where id = $1`, [product]))[0].current_stock, 0);
  assert.equal((await admin(db, `select qty_received::float8 as qty_received from erp_purchase_order_items where id = $1`, [line.id]))[0].qty_received, 0);
  const history = await admin(db, `select movement_type, quantity::float8 as quantity from erp_stock_movements where product_id = $1 order by created_at, movement_type`, [product]);
  assert.deepEqual(history.map((m) => `${m.movement_type}${m.quantity}`).sort(), ['in3', 'out3']);
});

test('reversing a delivery returns stock and restores the reservation', async () => {
  const product = await newProduct(owner, 'Returned', 4);
  const order = await createSalesOrder(owner, [[product, 4]]);
  await run(db, owner, `select erp_issue_invoice_from_sales_order_v2($1, null, null)`, [order]);
  const [line] = await orderItems(order);
  const [{ id: event }] = await run(db, owner, `select erp_record_sales_delivery($1, $2::jsonb, $3) as id`, [order, JSON.stringify([{ item_id: line.id, qty: 4 }]), randomUUID()]);
  assert.deepEqual(await availability(product), { on_hand: 0, reserved: 0, available: 0 });
  await run(db, owner, `select erp_reverse_fulfillment_event($1, 'Shipped to wrong address', $2)`, [event, randomUUID()]);
  assert.deepEqual(await availability(product), { on_hand: 4, reserved: 4, available: 0 });
  assert.equal((await admin(db, `select status from erp_sales_orders where id = $1`, [order]))[0].status, 'invoiced');
});

test('status transitions are enforced even for direct table writes by the owner role', async () => {
  const product = await newProduct(owner, 'Guarded', 5);
  const order = await createSalesOrder(owner, [[product, 1]]);
  // Clients cannot update orders directly at all (grants revoked earlier) ...
  await expectError(run(db, owner, `update erp_sales_orders set status = 'delivered' where id = $1`, [order]), /permission denied/);
  // ... and the database refuses invalid transitions even for trusted code.
  await expectError(admin(db, `update erp_sales_orders set status = 'delivered' where id = $1`, [order]), /cannot move from draft to delivered/);
  await expectError(admin(db, `update erp_sales_orders set status = 'cancelled' where id = $1`, [order]), /reason is required/);
});

test('manual product stock edits are recorded in the movement history', async () => {
  const product = await newProduct(owner, 'Edited', 7);
  await run(db, owner, `update erp_products set current_stock = 4 where id = $1`, [product]);
  const rows = await admin(db, `select movement_type, quantity::float8 as quantity, note from erp_stock_movements where product_id = $1 order by created_at`, [product]);
  assert.deepEqual(rows.map((r) => [r.movement_type, r.quantity]).sort(), [['in', 7], ['out', 3]]);
  await expectError(run(db, owner, `update erp_products set current_stock = -1 where id = $1`, [product]), /cannot be negative/);
  // Stock adjustments through the RPC do not produce a second movement.
  await run(db, owner, `select erp_adjust_stock($1, 'in', 2, 'Recount')`, [product]);
  const [{ n }] = await admin(db, `select count(*)::int as n from erp_stock_movements where product_id = $1`, [product]);
  assert.equal(n, 3);
});

test('reservations are serialized per product (lock taken before availability is summed)', async () => {
  const [{ def }] = await admin(db, `select pg_get_functiondef('public.erp__reserve_sales_order(uuid)'::regprocedure) as def`);
  const lockAt = def.indexOf('FOR UPDATE OF prod');
  const sumAt = def.indexOf('SUM(r.qty_open)');
  assert.ok(lockAt > 0 && sumAt > lockAt, 'product lock precedes the availability sum');
  assert.ok(def.indexOf('ORDER BY prod.id') < lockAt, 'products are locked in a stable order');
});

test('a second user cannot see or touch another user\'s orders', async () => {
  const other = await createUser(db, 'stranger');
  const product = await newProduct(owner, 'Private', 5);
  const order = await createSalesOrder(owner, [[product, 1]]);
  assert.equal((await run(db, other, `select count(*)::int as n from erp_sales_orders where id = $1`, [order]))[0].n, 0);
  assert.equal((await run(db, other, `select count(*)::int as n from erp_stock_reservations where sales_order_id = $1`, [order]))[0].n, 0);
  await expectError(run(db, other, `select erp_cancel_sales_order($1, 'not mine')`, [order]), /Sales order not found/);
  await expectError(
    asUser(db, other, (q) => q(`select erp_create_sales_order_v3(null, null, 'x', current_date, '', $1::jsonb, null, null)`, [items([product, 1])])),
    /Product not found for this account/
  );
});
