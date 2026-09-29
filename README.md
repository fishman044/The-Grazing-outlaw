# Saguavow Charcuterie Co. Website

A deployment-ready wedding charcuterie website with package selection, dietary/allergy filtering, add-ons, live estimates, and Stripe-hosted Checkout.

## What is included

- Classic $12/guest, Signature $16/guest, and Luxe $20/guest packages
- Required $100 event setup fee
- Wedding add-ons
- Dietary/allergy filtering before ingredient selection
- 25% booking deposit or pay-in-full option
- Secure Stripe Checkout created by the server
- Payment confirmation page
- Stripe webhook endpoint for later CRM/email automation

## Connect Stripe

1. Create or sign in to your Stripe account.
2. Copy `.env.example` to `.env`.
3. Put your Stripe **secret key** in `STRIPE_SECRET_KEY`. Never place the secret key in HTML or JavaScript sent to the browser.
4. Set `PUBLIC_URL` to your published HTTPS domain.
5. For webhook confirmation, create a Stripe webhook pointing to `https://YOURDOMAIN.com/api/webhook` and subscribe to `checkout.session.completed`; put its signing secret in `STRIPE_WEBHOOK_SECRET`.
6. Install and run:

```bash
npm install
npm start
```

Open `http://localhost:4242`.

## Before going live

- Replace the footer placeholders with your phone, business email, Instagram, and service area.
- Add your final cancellation/refund policy and service agreement.
- Confirm taxes, delivery/travel fees, food handling requirements, and venue requirements for your operating area.
- Test with Stripe test mode before switching to live keys.
- Keep `.env` private and never upload it to a public repository.

## Price control

All chargeable prices are defined again in `server.js`. The browser only sends the chosen package, guest count, and add-on IDs. The server recalculates the amount before sending the customer to Stripe Checkout.
