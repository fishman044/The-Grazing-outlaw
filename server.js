require('dotenv').config();
const path = require('path');
const express = require('express');
const Stripe = require('stripe');

const app = express();
app.set('trust proxy', 1);

const PORT = Number(process.env.PORT || 4242);
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const DEPOSIT_PERCENT = Math.min(100, Math.max(1, Number(process.env.DEPOSIT_PERCENT || 25)));
const CLASSIC_PROMO_CODE = String(process.env.CLASSIC_PROMO_CODE || '').trim().toUpperCase();
const CLASSIC_PROMO_ID = 'classic-five-one-time';
const CLASSIC_PROMO_UNIT_AMOUNT = 500;
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

let promoReservation = null;

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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(safeText(body.weddingDate, 20))) throw new Error('A wedding date is required.');
  if (body.termsAccepted !== true) throw new Error('Please review and accept the booking confirmation before payment.');
  return { pkg, guestCount, paymentType, addOnIds };
}

// Stripe requires the raw request body when verifying webhook signatures.
app.post('/api/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) return res.status(503).send('Webhook is not configured.');
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    console.log('The Grazing Outlaw payment completed:', session.id, session.payment_status, session.metadata);
    // Keep a successful promo checkout reserved for the remainder of its
    // 30-minute window. This gives Stripe Search time to index the successful
    // PaymentIntent before another customer can attempt the one-time code.
    // Production option: write the booking to your CRM/database or send a confirmation email here.
  }
  if (event.type === 'checkout.session.expired') {
    const session = event.data.object;
    if (promoReservation?.sessionId === session.id) promoReservation = null;
  }
  res.json({ received: true });
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
    node: process.version,
  });
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

app.post('/api/create-checkout-session', async (req, res) => {
  if (!stripe) {
    return res.status(503).json({ error: 'Payments are not connected yet. Add STRIPE_SECRET_KEY on the server before accepting live payments.' });
  }

  try {
    const { pkg, guestCount, paymentType, addOnIds } = validateRequest(req.body || {});
    const promoCode = normalizePromo(req.body?.promoCode);
    let promoApplied = false;
    let promoReservationToken = null;
    let effectiveUnitAmount = pkg.unitAmount;

    if (promoCode) {
      if (req.body.package !== 'classic') throw new Error('The one-time promo only applies to the Classic package.');
      promoReservationToken = await validateClassicPromo(promoCode, { reserve: true });
      promoApplied = true;
      effectiveUnitAmount = CLASSIC_PROMO_UNIT_AMOUNT;
    }

    const packageSubtotal = effectiveUnitAmount * guestCount;
    const addOnSubtotal = addOnIds.reduce((sum, id) => sum + ADD_ONS[id].amount, 0);
    const estimatedTotal = packageSubtotal + SETUP_FEE.amount + addOnSubtotal;

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
      const depositAmount = Math.round(estimatedTotal * (DEPOSIT_PERCENT / 100));
      lineItems = [{
        price_data: {
          currency: 'usd',
          unit_amount: depositAmount,
          product_data: {
            name: `${DEPOSIT_PERCENT}% Wedding Booking Deposit`,
            description: `Applied toward an estimated event total of $${(estimatedTotal / 100).toFixed(2)} for ${pkg.name}${promoApplied ? ' with the one-time Classic promo' : ''}.`,
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
      payment_type: paymentType,
      estimated_total_cents: String(estimatedTotal),
      package_unit_amount_cents: String(effectiveUnitAmount),
      promo_applied: promoApplied ? 'yes' : 'no',
      promo_id: promoApplied ? CLASSIC_PROMO_ID : '',
      add_ons: safeText(addOnIds.map(id => ADD_ONS[id].name).join(' | '), 450),
      dietary: safeText(Array.isArray(req.body.dietary) ? req.body.dietary.join(' | ') : '', 450),
      allergy_notes: safeText(req.body.allergyNotes, 450),
    };

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: lineItems,
      customer_email: safeText(req.body.email, 200),
      success_url: `${origin}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/?payment=cancelled#payment`,
      metadata,
      ...(promoApplied ? {
        expires_at: Math.floor(Date.now() / 1000) + (30 * 60),
        payment_intent_data: {
          metadata: {
            saguavow_promo: CLASSIC_PROMO_ID,
            promo_applied: 'yes',
          },
        },
      } : {}),
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

app.get('/api/checkout-session', async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Payments are not connected.' });
  const sessionId = safeText(req.query.session_id, 255);
  if (!sessionId.startsWith('cs_')) return res.status(400).json({ error: 'Invalid checkout session.' });
  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    res.json({
      id: session.id,
      paymentStatus: session.payment_status,
      amountTotal: session.amount_total,
      customerEmail: session.customer_details?.email || session.customer_email || '',
      clientName: session.metadata?.client_name || '',
      weddingDate: session.metadata?.wedding_date || '',
      package: session.metadata?.package || '',
    });
  } catch (err) {
    res.status(400).json({ error: 'Unable to verify this payment session.' });
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
