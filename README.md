# The Grazing Outlaw — Stripe-Only Booking Website

This version removes Gmail/Google email integration entirely.

## How receipts work

For paid live-mode orders, the server passes the customer's checkout email to Stripe as `receipt_email`. Stripe sends the payment receipt directly. The confirmation page also shows a **View Stripe Receipt** link when Stripe provides one, plus a printable booking confirmation. Complimentary $0 bookings use the on-screen confirmation because no payment receipt exists.

## How you receive orders

Use the private owner dashboard:

`/orders-admin.html`

Enter the same `REFUND_ADMIN_TOKEN` stored in Render. It shows paid/complimentary bookings, client contact info, wedding date, package, guest count, menu selections, add-ons, dietary notes, payment amounts, and pending refund requests.

## Refund requests

Customers can submit a refund request from the public site. The request is saved into the booking's Stripe Checkout Session metadata instead of being emailed. It appears in the Orders Dashboard. Use `/refund-admin.html` to issue a full or partial refund.

## Render environment variables

See `.env.example`. Gmail variables are no longer needed.

## Stripe receipts

`receipt_email` sends paid live-mode receipts directly through Stripe. For Stripe's automatic refund-receipt emails, you can optionally enable **Settings > Business > Customer emails > Refunds** in Stripe.

## Files

- `server.js` — booking, Stripe, promo, date locking, refunds, owner dashboard API
- `public/index.html` — customer booking page
- `public/success.html` — payment confirmation and receipt link
- `public/orders-admin.html` — private order dashboard
- `public/refund-admin.html` — private refund controls


### Third one-time 100% free promo
Set `FREE_ORDER_CODE_3` in Render to a private code of your choice. It works in the existing Promo Code field, makes the full booking total $0, and can be redeemed once independently of the other free codes.
