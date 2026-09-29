# The Grazing Outlaw Website

A deployment-ready wedding charcuterie website with package selection, dietary/allergy filtering, add-ons, live estimates, and Stripe-hosted Checkout.

## What is included

- Classic $12/guest, Signature $16/guest, and Luxe $20/guest packages
- Required $100 event setup fee
- Wedding add-ons
- Dietary/allergy filtering before ingredient selection
- 25% booking deposit or pay-in-full option
- Secure Stripe Checkout created by the server
- Payment confirmation page
- Automatic customer payment receipt / booking confirmation email after successful Checkout
- Automatic full order email to thegrazingoutlaw@gmail.com after successful Checkout
- Idempotent Stripe webhook email handling so webhook retries do not duplicate successful emails

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

- Business email: thegrazingoutlaw@gmail.com. The website lists Gilbert, Arizona as the service area. Add your phone number and Instagram when ready.
- Add your final cancellation/refund policy and service agreement.
- Confirm taxes, delivery/travel fees, food handling requirements, and venue requirements for your operating area.
- Test with Stripe test mode before switching to live keys.
- Keep `.env` private and never upload it to a public repository.

## Price control

All chargeable prices are defined again in `server.js`. The browser only sends the chosen package, guest count, and add-on IDs. The server recalculates the amount before sending the customer to Stripe Checkout.


## One-time Classic promo

Set `CLASSIC_PROMO_CODE` in **Render → Environment** to a private code you choose. Do not commit the real code to GitHub. The code changes only the Classic package from **$12 to $5 per guest**; the $100 setup fee and all add-ons remain full price.

After a successful Stripe payment using the promo, later uses are rejected based on Stripe payment metadata. A promo checkout is temporarily reserved for 30 minutes so two customers cannot normally start the one-time offer at the same time.


## One-time full-comp code
Set `FREE_ORDER_CODE` in Render → Environment to a private code of your choice. When a client enters that code, the package, $100 setup fee, and selected add-ons are discounted 100%, so the booking total is $0. The server creates a Stripe coupon with a maximum of one redemption, so Stripe enforces the one-use limit. Do not put the real code in GitHub or public HTML.


## Automatic receipt and order emails

After Stripe confirms a successful checkout, the webhook sends:

1. A customer **Payment Receipt & Booking Confirmation** to the email entered during checkout.
2. A detailed **NEW ORDER** email to `thegrazingoutlaw@gmail.com`, including client contact details, wedding date, venue, package, guest count, amount received, estimated remaining balance, add-ons, dietary/allergy notes, and the selected menu items.

For paid card orders, the customer email also includes the Stripe-hosted receipt link when Stripe provides one. Full-comp ($0) orders receive a complimentary booking confirmation instead.

The website sends mail through the business Gmail account using a Google **App Password**. Do not use or store the normal Gmail account password in the website.

In **Render → Environment**, add:

```text
GMAIL_USER=thegrazingoutlaw@gmail.com
GMAIL_APP_PASSWORD=YOUR_16_CHARACTER_GOOGLE_APP_PASSWORD
ORDER_NOTIFICATION_EMAIL=thegrazingoutlaw@gmail.com
EMAIL_FROM_NAME=The Grazing Outlaw
```

Google App Passwords require 2-Step Verification. Keep the App Password only in Render Environment and never commit it to GitHub.

The Stripe webhook should subscribe to both:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`

The server writes `customer_receipt_sent` and `owner_order_sent` flags into Stripe Checkout Session metadata after successful delivery. If Stripe retries a webhook, already-sent emails are skipped.
