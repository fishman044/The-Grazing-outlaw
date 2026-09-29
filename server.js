require('dotenv').config();
const path = require('path');
const express = require('express');
const Stripe = require('stripe');
const crypto = require('crypto');

const app = express();
app.set('trust proxy', 1);

const PORT = Number(process.env.PORT || 4242);
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const DEPOSIT_PERCENT = Math.min(100, Math.max(1, Number(process.env.DEPOSIT_PERCENT || 25)));
const CLASSIC_PROMO_CODE = String(process.env.CLASSIC_PROMO_CODE || '').trim().toUpperCase();
const FREE_ORDER_CODE = String(process.env.FREE_ORDER_CODE || '').trim().toUpperCase();
const FREE_ORDER_CODE_2 = String(process.env.FREE_ORDER_CODE_2 || '').trim().toUpperCase();
const FREE_ORDER_CODE_3 = String(process.env.FREE_ORDER_CODE_3 || '').trim().toUpperCase();
const REFUND_ADMIN_TOKEN = String(process.env.REFUND_ADMIN_TOKEN || '').trim();
const BUSINESS_TIMEZONE = String(process.env.BUSINESS_TIMEZONE || 'America/Phoenix').trim();
const CLASSIC_PROMO_ID = 'classic-five-one-time';
const CLASSIC_PROMO_UNIT_AMOUNT = 500;
const FREE_COUPON_ID = 'grazing_outlaw_free_once';
const FREE_COUPON_ID_2 = 'grazing_outlaw_free_once_2';
const FREE_COUPON_ID_3 = 'grazing_outlaw_free_once_3';
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

let promoReservation = null;
const refundRequestRate = new Map();

const PACKAGES = {
  classic: { name: 'Classic Cup', unitAmount: 1200 },
  signature: { name: 'Signature Cup', unitAmount: 1600 },
  luxe: { name: 'Luxe Cup', unitAmount: 2000 },
};

const SETUP_FEE = { name: 'Wedding Charcuterie Setup Fee', amount: 10000 };

const ADD_ONS = {
  'addon-sweetheart': { name: 'Bride & Groom Sweetheart Charcuterie Board', amount: 7500 },
  'addon-bridalparty': { name: 'Wedding Party Grazing Board', amount: 12500 },
  'addon-takehome': { name: 'Take-Home Couple Charcuterie Board', amount: 6500 },
  'addon-styling': { name: 'Premium Display Styling', amount: 7500 },
  'addon-signage': { name: 'Personalized Wedding Signage', amount: 4000 },
};

function siteOrigin(req) {
  const configured = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
  if (configured) return configured;
  return `${req.protocol}://${req.get('host')}`;
}

function safeText(value, max = 450) {
  return String(value || '').trim().slice(0, max);
}

function normalizePromo(value) {
  return safeText(value, 80).toUpperCase();
}

function businessTodayISO() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

let bookedDatesCache = { at: 0, dates: [] };

async function getBookedWeddingDates({ force = false } = {}) {
  if (!stripe) return [];
  const now = Date.now();
  if (!force && now - bookedDatesCache.at < 30000) return bookedDatesCache.dates;

  const dates = new Set();
  let startingAfter;
  // Completed Checkout Sessions are the source of truth so bookings survive
  // Render restarts and deploys. Only date strings are exposed to customers.
  do {
    const page = await stripe.checkout.sessions.list({
      limit: 100,
      status: 'complete',
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    for (const session of page.data) {
      const md = session.metadata || {};
      const weddingDate = safeText(md.wedding_date, 20);
      if (!isIsoDate(weddingDate)) continue;
      if (md.booking_cancelled === 'yes') continue;
      if (!['paid', 'no_payment_required', 'unpaid'].includes(session.payment_status)) continue;
      dates.add(weddingDate);
    }
    if (!page.has_more || !page.data.length) break;
    startingAfter = page.data[page.data.length - 1].id;
  } while (true);

  bookedDatesCache = { at: now, dates: [...dates].sort() };
  return bookedDatesCache.dates;
}

async function assertWeddingDateAvailable(weddingDate) {
  const date = safeText(weddingDate, 20);
  if (!isIsoDate(date)) throw new Error('A wedding date is required.');
  const today = businessTodayISO();
  if (date < today) throw new Error('Past dates cannot be booked. Choose today or a future date.');
  const booked = await getBookedWeddingDates({ force: true });
  if (booked.includes(date)) throw new Error('That wedding date is already booked. Please choose another date.');
  return date;
}


function money(cents) {
  const n = Number(cents || 0);
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n / 100);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function sanitizeMenuSelections(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return [];
  return Object.entries(input)
    .slice(0, 12)
    .map(([category, items]) => ({
      category: safeText(category, 100),
      items: Array.isArray(items)
        ? items.slice(0, 30).map(item => safeText(item, 120)).filter(Boolean)
        : [],
    }))
    .filter(group => group.category && group.items.length);
}

function addMenuMetadata(metadata, menuGroups) {
  menuGroups.forEach((group, index) => {
    const n = String(index + 1).padStart(2, '0');
    metadata[`menu_${n}_category`] = safeText(group.category, 100);
    metadata[`menu_${n}_items`] = safeText(group.items.join(' | '), 450);
  });
  metadata.menu_group_count = String(menuGroups.length);
}

function readMenuMetadata(metadata = {}) {
  const count = Math.min(12, Math.max(0, Number(metadata.menu_group_count || 0)));
  const groups = [];
  for (let i = 1; i <= count; i += 1) {
    const n = String(i).padStart(2, '0');
    const category = safeText(metadata[`menu_${n}_category`], 100);
    const items = safeText(metadata[`menu_${n}_items`], 450)
      .split(' | ')
      .map(x => x.trim())
      .filter(Boolean);
    if (category && items.length) groups.push({ category, items });
  }
  return groups;
}

function menuText(groups) {
  if (!groups.length) return 'No menu selections were recorded.';
  return groups.map(group => `${group.category}: ${group.items.join(', ')}`).join('\n');
}

function menuHtml(groups) {
  if (!groups.length) return '<p>No menu selections were recorded.</p>';
  return groups.map(group => `<p><strong>${escapeHtml(group.category)}:</strong> ${escapeHtml(group.items.join(', '))}</p>`).join('');
}

async function getReceiptUrl(session) {
  if (!session.payment_intent) return '';
  try {
    const paymentIntent = await stripe.paymentIntents.retrieve(session.payment_intent, { expand: ['latest_charge'] });
    const charge = paymentIntent.latest_charge;
    return typeof charge === 'object' && charge?.receipt_url ? charge.receipt_url : '';
  } catch (err) {
    console.warn('Unable to retrieve Stripe receipt URL:', err.message);
    return '';
  }
}

function bookingDetails(session, lineItems, receiptUrl) {
  const md = session.metadata || {};
  const menuGroups = readMenuMetadata(md);
  const amountPaid = Number(session.amount_total || 0);
  const originalTotal = Number(md.original_total_cents || amountPaid || 0);
  const isFullComp = md.free_comp_applied === 'yes';
  const paymentType = md.payment_type || 'full';
  const remaining = isFullComp ? 0 : Math.max(0, originalTotal - amountPaid);
  const email = session.customer_details?.email || session.customer_email || '';
  const lineItemText = (lineItems?.data || []).map(item => {
    const qty = item.quantity || 1;
    return `${item.description || 'Item'}${qty > 1 ? ` × ${qty}` : ''} — ${money(item.amount_total || 0)}`;
  });
  return {
    md,
    menuGroups,
    amountPaid,
    originalTotal,
    remaining,
    isFullComp,
    paymentType,
    email,
    lineItemText,
    receiptUrl,
    addOns: md.add_ons || 'None selected',
    dietary: md.dietary || 'None selected',
    allergyNotes: md.allergy_notes || 'None provided',
  };
}

function normalizeEmail(value) {
  return safeText(value, 200).toLowerCase();
}

function safeEqualSecret(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  if (!left.length || left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function refundAdminAuthorized(req) {
  if (!REFUND_ADMIN_TOKEN) return false;
  return safeEqualSecret(req.get('x-refund-admin-token'), REFUND_ADMIN_TOKEN);
}

function enforceRefundRequestRate(req, email) {
  const key = `${req.ip || 'unknown'}|${normalizeEmail(email)}`;
  const now = Date.now();
  const oneHour = 60 * 60 * 1000;
  const entries = (refundRequestRate.get(key) || []).filter(ts => now - ts < oneHour);
  if (entries.length >= 5) throw new Error('Too many refund requests were submitted. Please try again later or email thegrazingoutlaw@gmail.com.');
  entries.push(now);
  refundRequestRate.set(key, entries);
}

async function getCheckoutAndPayment(sessionId) {
  if (!stripe) throw new Error('Payments are not connected.');
  if (!safeText(sessionId, 255).startsWith('cs_')) throw new Error('Enter the Stripe booking reference that begins with cs_.');
  const session = await stripe.checkout.sessions.retrieve(safeText(sessionId, 255));
  if (!session.payment_intent) throw new Error('This booking does not have a refundable payment.');
  const paymentIntent = await stripe.paymentIntents.retrieve(session.payment_intent);
  const refunds = await stripe.refunds.list({ payment_intent: paymentIntent.id, limit: 100 });
  const refunded = refunds.data.reduce((sum, r) => sum + (['succeeded','pending','requires_action'].includes(r.status) ? Number(r.amount || 0) : 0), 0);
  const paid = Number(paymentIntent.amount_received || session.amount_total || 0);
  const refundable = Math.max(0, paid - refunded);
  return { session, paymentIntent, refundable, paid };
}

function promoReservationActive() {
  if (!promoReservation) return false;
  if (promoReservation.expiresAt <= Date.now()) {
    promoReservation = null;
    return false;
  }
  return true;
}

async function classicPromoAlreadyUsed() {
  if (!stripe) return false;
  const result = await stripe.paymentIntents.search({
    query: `metadata['saguavow_promo']:'${CLASSIC_PROMO_ID}' AND status:'succeeded'`,
    limit: 1,
  });
  return result.data.length > 0;
}

async function validateClassicPromo(code, { reserve = false } = {}) {
  const normalized = normalizePromo(code);
  if (!CLASSIC_PROMO_CODE) throw new Error('This promo is not configured yet.');
  if (!normalized || normalized !== CLASSIC_PROMO_CODE) throw new Error('That promo code is not valid.');
  if (!stripe) throw new Error('Payments must be connected before this promo can be used.');
  if (await classicPromoAlreadyUsed()) throw new Error('This one-time promo has already been used.');

  if (reserve) {
    if (promoReservationActive()) {
      throw new Error('This one-time promo is currently reserved by another checkout. Try again later if that checkout is not completed.');
    }
    const token = `promo_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    promoReservation = {
      token,
      expiresAt: Date.now() + 30 * 60 * 1000,
      sessionId: null,
    };
    return token;
  }
  return true;
}

async function getOrCreateFreeCoupon(couponId, label) {
  if (!stripe) throw new Error('Payments must be connected before this code can be used.');
  try {
    return await stripe.coupons.retrieve(couponId);
  } catch (err) {
    if (err?.code !== 'resource_missing') throw err;
    return await stripe.coupons.create({
      id: couponId,
      percent_off: 100,
      duration: 'once',
      max_redemptions: 1,
      name: `The Grazing Outlaw — One-Time Full Comp ${label}`,
      metadata: { business: 'The Grazing Outlaw', purpose: 'one_time_full_comp', slot: label },
    });
  }
}

async function validateFreeOrderCode(code) {
  const normalized = normalizePromo(code);
  if (!FREE_ORDER_CODE && !FREE_ORDER_CODE_2 && !FREE_ORDER_CODE_3) throw new Error('The full-comp codes are not configured yet.');
  if (!normalized) throw new Error('Enter a full-comp code first.');

  let couponId = '';
  let label = '';
  if (FREE_ORDER_CODE && normalized === FREE_ORDER_CODE) {
    couponId = FREE_COUPON_ID;
    label = '1';
  } else if (FREE_ORDER_CODE_2 && normalized === FREE_ORDER_CODE_2) {
    couponId = FREE_COUPON_ID_2;
    label = '2';
  } else if (FREE_ORDER_CODE_3 && normalized === FREE_ORDER_CODE_3) {
    couponId = FREE_COUPON_ID_3;
    label = '3';
  } else {
    throw new Error('That full-comp code is not valid.');
  }

  const coupon = await getOrCreateFreeCoupon(couponId, label);
  const max = coupon.max_redemptions ?? 1;
  if (!coupon.valid || coupon.times_redeemed >= max) {
    throw new Error('This one-time full-comp code has already been used.');
  }
  return coupon;
}

async function resolvePromoCode(code, packageId, { reserve = false } = {}) {
  const normalized = normalizePromo(code);
  if (!normalized) throw new Error('Enter a promo code first.');

  // Full-comp codes work for every package and take priority over package-specific promos.
  if ((FREE_ORDER_CODE && normalized === FREE_ORDER_CODE) ||
      (FREE_ORDER_CODE_2 && normalized === FREE_ORDER_CODE_2) ||
      (FREE_ORDER_CODE_3 && normalized === FREE_ORDER_CODE_3)) {
    const coupon = await validateFreeOrderCode(normalized);
    return { kind: 'full_comp', coupon };
  }

  // The Classic promo is entered in the same box, but only applies to Classic.
  if (CLASSIC_PROMO_CODE && normalized === CLASSIC_PROMO_CODE) {
    if (packageId !== 'classic') throw new Error('This promo code is valid for the Classic package only. Select Classic and apply it again.');
    const reservationToken = await validateClassicPromo(normalized, { reserve });
    return {
      kind: 'classic_price',
      unitAmountCents: CLASSIC_PROMO_UNIT_AMOUNT,
      reservationToken: reserve ? reservationToken : null,
    };
  }

  throw new Error('That promo code is not valid.');
}

function validateRequest(body) {
  const pkg = PACKAGES[body.package];
  const guestCount = Number(body.guestCount);
  const paymentType = body.paymentType === 'full' ? 'full' : 'deposit';
  const addOnIds = Array.isArray(body.addOns) ? [...new Set(body.addOns)] : [];
  const invalidAddOn = addOnIds.find(id => !ADD_ONS[id]);
  if (!pkg) throw new Error('Choose a valid package.');
  if (!Number.isInteger(guestCount) || guestCount < 1 || guestCount > 2000) throw new Error('Enter a valid guest count.');
  if (invalidAddOn) throw new Error('One of the selected add-ons is invalid.');
  if (!safeText(body.clientName, 150)) throw new Error('Client names are required.');
  if (!/^\S+@\S+\.\S+$/.test(safeText(body.email, 200))) throw new Error('A valid email address is required.');
  if (!isIsoDate(safeText(body.weddingDate, 20))) throw new Error('A wedding date is required.');
  if (safeText(body.weddingDate, 20) < businessTodayISO()) throw new Error('Past dates cannot be booked. Choose today or a future date.');
  if (body.termsAccepted !== true) throw new Error('Please review and accept the booking confirmation before payment.');
  return { pkg, guestCount, paymentType, addOnIds };
}

// Stripe requires the raw request body when verifying webhook signatures.
app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) return res.status(503).send('Webhook is not configured.');
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      const session = event.data.object;
      console.log('The Grazing Outlaw checkout completed:', session.id, session.payment_status);
      bookedDatesCache = { at: 0, dates: [] };
    }
    if (event.type === 'refund.updated' || event.type === 'refund.failed') {
      console.log('Stripe refund event:', event.type, event.data.object?.id, event.data.object?.status);
    }
    if (event.type === 'checkout.session.expired') {
      const session = event.data.object;
      if (promoReservation?.sessionId === session.id) promoReservation = null;
    }
    res.json({ received: true });
  } catch (err) {
    console.error('Webhook processing failed:', err);
    res.status(500).send('Webhook processing failed.');
  }
});

app.use(express.json({ limit: '100kb' }));

const PUBLIC_DIR = path.join(__dirname, 'public');
const INDEX_FILE = path.join(PUBLIC_DIR, 'index.html');

// Explicit homepage routes make the site reliable on hosts such as Render.
app.get('/', (req, res, next) => {
  res.sendFile(INDEX_FILE, err => {
    if (err) next(err);
  });
});
app.get('/index.html', (req, res, next) => {
  res.sendFile(INDEX_FILE, err => {
    if (err) next(err);
  });
});

app.use(express.static(PUBLIC_DIR, { index: false }));

app.get('/health', (req, res) => res.status(200).json({
  ok: true,
  service: 'The Grazing Outlaw',
  stripeConfigured: Boolean(stripe),
  classicPromoConfigured: Boolean(CLASSIC_PROMO_CODE),
  freeOrderCodeConfigured: Boolean(FREE_ORDER_CODE),
  freeOrderCode2Configured: Boolean(FREE_ORDER_CODE_2),
  freeOrderCode3Configured: Boolean(FREE_ORDER_CODE_3),
  stripeWebhookConfigured: Boolean(STRIPE_WEBHOOK_SECRET),
  refundAdminConfigured: Boolean(REFUND_ADMIN_TOKEN),
  businessTimezone: BUSINESS_TIMEZONE,
  indexPath: INDEX_FILE,
}));

app.get('/diagnostics', (req, res) => {
  const fs = require('fs');
  res.status(200).json({
    ok: true,
    publicDirectoryExists: fs.existsSync(PUBLIC_DIR),
    indexFileExists: fs.existsSync(INDEX_FILE),
    stripeConfigured: Boolean(stripe),
    classicPromoConfigured: Boolean(CLASSIC_PROMO_CODE),
    freeOrderCodeConfigured: Boolean(FREE_ORDER_CODE),
    freeOrderCode2Configured: Boolean(FREE_ORDER_CODE_2),
  freeOrderCode3Configured: Boolean(FREE_ORDER_CODE_3),
    stripeWebhookConfigured: Boolean(STRIPE_WEBHOOK_SECRET),
    refundAdminConfigured: Boolean(REFUND_ADMIN_TOKEN),
    node: process.version,
  });
});

app.get('/api/booked-dates', async (req, res) => {
  try {
    const dates = await getBookedWeddingDates();
    res.set('Cache-Control', 'no-store');
    res.json({
      ok: true,
      minDate: businessTodayISO(),
      bookedDates: dates.filter(date => date >= businessTodayISO()),
      timezone: BUSINESS_TIMEZONE,
    });
  } catch (err) {
    console.error('Booked-date lookup failed:', err);
    res.status(500).json({ error: 'Unable to check booked dates right now.' });
  }
});

app.post('/api/validate-code', async (req, res) => {
  try {
    const result = await resolvePromoCode(req.body?.promoCode, req.body?.package, { reserve: false });
    if (result.kind === 'full_comp') {
      return res.json({
        valid: true,
        kind: 'full_comp',
        message: 'Promo applied: this entire booking will be $0.',
      });
    }
    return res.json({
      valid: true,
      kind: 'classic_price',
      package: 'classic',
      unitAmountCents: result.unitAmountCents,
      message: 'Promo applied: Classic is $5 per guest for this booking.',
    });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Promo code could not be validated.' });
  }
});

app.post('/api/validate-promo', async (req, res) => {
  try {
    if (req.body?.package !== 'classic') throw new Error('This promo only applies to the Classic package.');
    await validateClassicPromo(req.body?.promoCode, { reserve: false });
    res.json({
      valid: true,
      package: 'classic',
      unitAmountCents: CLASSIC_PROMO_UNIT_AMOUNT,
      message: 'Classic promo is available.',
    });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Promo code could not be validated.' });
  }
});


app.post('/api/validate-free-code', async (req, res) => {
  try {
    await validateFreeOrderCode(req.body?.freeCode);
    res.json({
      valid: true,
      kind: 'full_comp',
      message: 'One-time full-comp code is available. This booking will be $0.',
    });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Full-comp code could not be validated.' });
  }
});

app.post('/api/create-checkout-session', async (req, res) => {
  if (!stripe) {
    return res.status(503).json({ error: 'Payments are not connected yet. Add STRIPE_SECRET_KEY on the server before accepting live payments.' });
  }

  try {
    const validated = validateRequest(req.body || {});
    const { pkg, guestCount, addOnIds } = validated;
    await assertWeddingDateAvailable(req.body?.weddingDate);
    const menuGroups = sanitizeMenuSelections(req.body?.menuSelections);
    let paymentType = validated.paymentType;
    // One customer-facing code field accepts every configured promo type.
    // req.body.freeCode is retained as a backwards-compatible fallback for older cached pages.
    const promoCode = normalizePromo(req.body?.promoCode || req.body?.freeCode);
    let promoApplied = false;
    let freeCompApplied = false;
    let freeCoupon = null;
    let promoReservationToken = null;
    let effectiveUnitAmount = pkg.unitAmount;

    if (promoCode) {
      const resolvedPromo = await resolvePromoCode(promoCode, req.body.package, { reserve: true });
      if (resolvedPromo.kind === 'full_comp') {
        freeCoupon = resolvedPromo.coupon;
        freeCompApplied = true;
        paymentType = 'full';
      } else if (resolvedPromo.kind === 'classic_price') {
        promoReservationToken = resolvedPromo.reservationToken;
        promoApplied = true;
        effectiveUnitAmount = resolvedPromo.unitAmountCents;
      }
    }

    const packageSubtotal = effectiveUnitAmount * guestCount;
    const addOnSubtotal = addOnIds.reduce((sum, id) => sum + ADD_ONS[id].amount, 0);
    const originalTotal = packageSubtotal + SETUP_FEE.amount + addOnSubtotal;
    const estimatedTotal = freeCompApplied ? 0 : originalTotal;

    let lineItems;
    if (paymentType === 'full') {
      lineItems = [
        {
          price_data: {
            currency: 'usd',
            unit_amount: effectiveUnitAmount,
            product_data: { name: `${pkg.name} — per guest${promoApplied ? ' — one-time promo' : ''}` },
          },
          quantity: guestCount,
        },
        {
          price_data: {
            currency: 'usd',
            unit_amount: SETUP_FEE.amount,
            product_data: { name: SETUP_FEE.name },
          },
          quantity: 1,
        },
        ...addOnIds.map(id => ({
          price_data: {
            currency: 'usd',
            unit_amount: ADD_ONS[id].amount,
            product_data: { name: ADD_ONS[id].name },
          },
          quantity: 1,
        })),
      ];
    } else {
      const depositAmount = Math.round(originalTotal * (DEPOSIT_PERCENT / 100));
      lineItems = [{
        price_data: {
          currency: 'usd',
          unit_amount: depositAmount,
          product_data: {
            name: `${DEPOSIT_PERCENT}% Wedding Booking Deposit`,
            description: `Applied toward an estimated event total of $${(originalTotal / 100).toFixed(2)} for ${pkg.name}${promoApplied ? ' with the one-time Classic promo' : ''}.`,
          },
        },
        quantity: 1,
      }];
    }

    const origin = siteOrigin(req);
    const metadata = {
      business: 'The Grazing Outlaw',
      client_name: safeText(req.body.clientName, 150),
      wedding_date: safeText(req.body.weddingDate, 20),
      phone: safeText(req.body.phone, 80),
      venue: safeText(req.body.venue, 200),
      package: pkg.name,
      guest_count: String(guestCount),
      payment_type: freeCompApplied ? 'full_comp' : paymentType,
      original_total_cents: String(originalTotal),
      estimated_total_cents: String(estimatedTotal),
      package_unit_amount_cents: String(effectiveUnitAmount),
      promo_applied: promoApplied ? 'yes' : 'no',
      promo_id: promoApplied ? CLASSIC_PROMO_ID : '',
      free_comp_applied: freeCompApplied ? 'yes' : 'no',
      free_coupon_id: freeCompApplied && freeCoupon ? freeCoupon.id : '',
      add_ons: safeText(addOnIds.map(id => ADD_ONS[id].name).join(' | '), 450),
      dietary: safeText(Array.isArray(req.body.dietary) ? req.body.dietary.join(' | ') : '', 450),
      allergy_notes: safeText(req.body.allergyNotes, 450),
    };
    addMenuMetadata(metadata, menuGroups);

    const paymentIntentData = {
      receipt_email: safeText(req.body.email, 200),
      metadata: promoApplied ? {
        saguavow_promo: CLASSIC_PROMO_ID,
        promo_applied: 'yes',
      } : {},
    };

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: lineItems,
      customer_email: safeText(req.body.email, 200),
      success_url: `${origin}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/?payment=cancelled#selection`,
      metadata,
      ...(freeCompApplied && freeCoupon ? { discounts: [{ coupon: freeCoupon.id }] } : {}),
      ...(!freeCompApplied ? { payment_intent_data: paymentIntentData } : {}),
      expires_at: Math.floor(Date.now() / 1000) + (30 * 60),
    });

    if (promoApplied && promoReservation && promoReservation.token === promoReservationToken) {
      promoReservation.sessionId = session.id;
    }

    res.json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message || 'Unable to start checkout.' });
  }
});

app.post('/api/refund-request', async (req, res) => {
  try {
    if (!stripe) throw new Error('Payments are not connected yet.');
    const sessionId = safeText(req.body?.bookingReference, 255);
    const email = normalizeEmail(req.body?.email);
    const reason = safeText(req.body?.reason, 1200);
    const amountDollars = req.body?.amount === '' || req.body?.amount == null ? null : Number(req.body.amount);
    if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error('Enter the email used for the booking.');
    enforceRefundRequestRate(req, email);
    const { session, refundable, paid } = await getCheckoutAndPayment(sessionId);
    const bookingEmail = normalizeEmail(session.customer_details?.email || session.customer_email);
    if (!bookingEmail || bookingEmail !== email) throw new Error('The booking reference and email do not match.');
    if (!['paid', 'no_payment_required'].includes(session.payment_status)) throw new Error('This booking does not have a completed payment.');
    if (refundable <= 0) throw new Error('There is no remaining refundable payment on this booking.');
    let requestedAmount = null;
    if (amountDollars != null) {
      if (!Number.isFinite(amountDollars) || amountDollars <= 0) throw new Error('Enter a valid refund amount or leave it blank for a full refund request.');
      requestedAmount = Math.round(amountDollars * 100);
      if (requestedAmount > refundable) throw new Error(`The requested refund exceeds the remaining refundable amount of ${money(refundable)}.`);
    }
    await stripe.checkout.sessions.update(session.id, {
      metadata: {
        refund_request_status: 'pending',
        refund_request_email: email,
        refund_request_amount_cents: requestedAmount == null ? 'full' : String(requestedAmount),
        refund_request_reason: safeText(reason || 'Not provided', 450),
        refund_request_at: new Date().toISOString(),
      },
    });
    res.json({ ok: true, message: 'Refund request received. Save your booking reference; the request is now visible in the owner dashboard.' });
  } catch (err) {
    console.error('Refund request failed:', err);
    res.status(400).json({ error: err.message || 'Unable to submit the refund request.' });
  }
});

app.post('/api/admin/refund', async (req, res) => {
  if (!refundAdminAuthorized(req)) return res.status(403).json({ error: 'Admin authorization failed.' });
  try {
    const sessionId = safeText(req.body?.bookingReference, 255);
    const amountDollars = req.body?.amount === '' || req.body?.amount == null ? null : Number(req.body.amount);
    const { session, paymentIntent, refundable } = await getCheckoutAndPayment(sessionId);
    if (refundable <= 0) throw new Error('This booking has no remaining refundable amount.');
    let amount = refundable;
    if (amountDollars != null) {
      if (!Number.isFinite(amountDollars) || amountDollars <= 0) throw new Error('Enter a valid partial refund amount or leave it blank for the full remaining amount.');
      amount = Math.round(amountDollars * 100);
      if (amount > refundable) throw new Error(`Maximum available refund is ${money(refundable)}.`);
    }
    const refund = await stripe.refunds.create({
      payment_intent: paymentIntent.id,
      amount,
      reason: 'requested_by_customer',
      metadata: {
        business: 'The Grazing Outlaw',
        checkout_session: session.id,
        client_name: safeText(session.metadata?.client_name, 150),
      },
    });
    const remainingAfter = Math.max(0, refundable - amount);
    if (remainingAfter === 0) {
      await stripe.checkout.sessions.update(session.id, {
        metadata: { booking_cancelled: 'yes', booking_cancelled_at: new Date().toISOString() },
      });
      bookedDatesCache = { at: 0, dates: [] };
    }
    await stripe.checkout.sessions.update(session.id, {
      metadata: {
        refund_request_status: 'processed',
        refund_last_id: refund.id,
        refund_last_amount_cents: String(amount),
        refund_last_status: String(refund.status || 'submitted'),
        refund_remaining_cents: String(remainingAfter),
        refund_processed_at: new Date().toISOString(),
      },
    });
    res.json({
      ok: true,
      refundId: refund.id,
      status: refund.status,
      amountCents: amount,
      amountFormatted: money(amount),
      remainingRefundableCents: remainingAfter,
      remainingRefundableFormatted: money(remainingAfter),
    });
  } catch (err) {
    console.error('Admin refund failed:', err);
    res.status(400).json({ error: err.message || 'Unable to process the refund.' });
  }
});

app.get('/api/admin/refund-lookup', async (req, res) => {
  if (!refundAdminAuthorized(req)) return res.status(403).json({ error: 'Admin authorization failed.' });
  try {
    const { session, refundable, paid } = await getCheckoutAndPayment(req.query.bookingReference);
    res.json({
      ok: true,
      bookingReference: session.id,
      clientName: session.metadata?.client_name || '',
      customerEmail: session.customer_details?.email || session.customer_email || '',
      weddingDate: session.metadata?.wedding_date || '',
      package: session.metadata?.package || '',
      paidCents: paid,
      paidFormatted: money(paid),
      refundableCents: refundable,
      refundableFormatted: money(refundable),
    });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Unable to look up the booking.' });
  }
});

app.get('/api/checkout-session', async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Payments are not connected.' });
  const sessionId = safeText(req.query.session_id, 255);
  if (!sessionId.startsWith('cs_')) return res.status(400).json({ error: 'Invalid checkout session.' });
  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ['payment_intent.latest_charge'] });
    const paymentIntent = typeof session.payment_intent === 'object' ? session.payment_intent : null;
    const latestCharge = paymentIntent && typeof paymentIntent.latest_charge === 'object' ? paymentIntent.latest_charge : null;
    const md = session.metadata || {};
    res.json({
      id: session.id,
      paymentStatus: session.payment_status,
      amountTotal: session.amount_total,
      customerEmail: session.customer_details?.email || session.customer_email || '',
      clientName: md.client_name || '',
      weddingDate: md.wedding_date || '',
      package: md.package || '',
      guests: md.guest_count || '',
      venue: md.venue || '',
      paymentType: md.payment_type || '',
      estimatedTotalCents: Number(md.original_total_cents || session.amount_total || 0),
      addOns: md.add_ons || '',
      dietary: md.dietary || '',
      allergyNotes: md.allergy_notes || '',
      menuSelections: readMenuMetadata(md),
      receiptUrl: latestCharge?.receipt_url || '',
      bookingReference: session.id,
    });
  } catch (err) {
    res.status(400).json({ error: 'Unable to verify this payment session.' });
  }
});

async function listCompletedBookings(maxSessions = 300) {
  if (!stripe) throw new Error('Payments are not connected.');
  const sessions = [];
  let startingAfter;
  while (sessions.length < maxSessions) {
    const page = await stripe.checkout.sessions.list({
      status: 'complete',
      limit: Math.min(100, maxSessions - sessions.length),
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    sessions.push(...page.data);
    if (!page.has_more || !page.data.length) break;
    startingAfter = page.data[page.data.length - 1].id;
  }
  return sessions.filter(s => ['paid', 'no_payment_required'].includes(s.payment_status));
}

app.get('/api/admin/orders', async (req, res) => {
  if (!refundAdminAuthorized(req)) return res.status(403).json({ error: 'Admin authorization failed.' });
  try {
    const sessions = await listCompletedBookings();
    const orders = sessions.map(session => {
      const md = session.metadata || {};
      const amountPaid = Number(session.amount_total || 0);
      const estimatedTotal = Number(md.original_total_cents || amountPaid || 0);
      return {
        bookingReference: session.id,
        clientName: md.client_name || '',
        customerEmail: session.customer_details?.email || session.customer_email || '',
        phone: md.phone || '',
        weddingDate: md.wedding_date || '',
        venue: md.venue || '',
        package: md.package || '',
        guests: md.guest_count || '',
        paymentType: md.payment_type || '',
        amountPaidCents: amountPaid,
        estimatedTotalCents: estimatedTotal,
        remainingBalanceCents: Math.max(0, estimatedTotal - amountPaid),
        addOns: md.add_ons || '',
        dietary: md.dietary || '',
        allergyNotes: md.allergy_notes || '',
        menuSelections: readMenuMetadata(md),
        refundRequestStatus: md.refund_request_status || '',
        refundRequestAmount: md.refund_request_amount_cents || '',
        refundRequestReason: md.refund_request_reason || '',
        refundRequestAt: md.refund_request_at || '',
        refundLastAmountCents: Number(md.refund_last_amount_cents || 0),
        refundLastStatus: md.refund_last_status || '',
        bookingCancelled: md.booking_cancelled === 'yes',
        created: session.created,
      };
    }).sort((a,b) => (a.weddingDate || '9999-99-99').localeCompare(b.weddingDate || '9999-99-99'));
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, count: orders.length, orders });
  } catch (err) {
    console.error('Order dashboard lookup failed:', err);
    res.status(500).json({ error: err.message || 'Unable to load orders.' });
  }
});

// Friendly server error response and useful Render log output.
app.use((err, req, res, next) => {
  console.error('Request error:', req.method, req.originalUrl, err);
  if (res.headersSent) return next(err);
  res.status(500).type('text/plain').send('The Grazing Outlaw encountered a server error. Check the Render logs for details.');
});

app.use((req, res) => {
  res.status(404).type('text/plain').send('Page not found.');
});

app.listen(PORT, () => {
  console.log(`The Grazing Outlaw website running on http://localhost:${PORT}`);
  if (!stripe) console.log('Stripe is not configured. Add STRIPE_SECRET_KEY to .env to enable checkout.');
});
