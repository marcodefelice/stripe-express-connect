import express, { type Request, type RequestHandler, type Response } from 'express';
import Stripe from 'stripe';

export interface CheckoutPayload {
  accountId?: string;
  amount: number;
  currency?: string;
  title?: string;
  description?: string;
  metadata?: Record<string, string>;
}

export interface StripeExpressConnectOptions {
  /** Your platform secret key. Keep it in an environment variable and never expose it to React. */
  stripeSecretKey: string;
  /** Absolute URLs required by Stripe for its hosted Express onboarding. */
  onboarding: { refreshUrl: string; returnUrl: string };
  /** Absolute URLs used after an invited guest leaves Stripe Checkout. */
  checkout: { successUrl: string; cancelUrl: string };
  /**
   * Resolve the account from the authenticated application user or registry.
   * Supplying this prevents a caller from choosing an arbitrary `accountId` in the browser.
   */
  resolveAccountId?: (request: Request, payload: CheckoutPayload) => Promise<string | null> | string | null;
  /** Validate or replace client supplied price/title before a Checkout Session is created. */
  validateCheckout?: (request: Request, payload: CheckoutPayload) => Promise<CheckoutPayload> | CheckoutPayload;
  /** Amount in cents that the platform keeps. Omit or return 0 when the platform takes no fee. */
  applicationFeeAmount?: (payload: CheckoutPayload, amountInCents: number) => number | Promise<number>;
  /** Persist the returned Express account ID against the signed-in application user. */
  onAccountCreated?: (account: { id: string }, request: Request) => Promise<void> | void;
  /** Optional Stripe API version override. */
  apiVersion?: Stripe.LatestApiVersion;
}

export interface StripeWebhookOptions {
  stripeSecretKey: string;
  webhookSecret: string;
  onCheckoutCompleted: (session: Stripe.Checkout.Session, event: Stripe.Event) => Promise<void> | void;
  onEvent?: (event: Stripe.Event) => Promise<void> | void;
  apiVersion?: Stripe.LatestApiVersion;
}

const toErrorMessage = (error: unknown) => error instanceof Error ? error.message : 'Errore Stripe non previsto.';

function toCents(amount: number): number {
  const cents = Math.round(Number(amount) * 100);
  if (!Number.isSafeInteger(cents) || cents < 50) throw new Error('L’importo deve essere almeno 0,50.');
  return cents;
}

function metadata(input?: Record<string, string>): Record<string, string> | undefined {
  if (!input) return undefined;
  return Object.fromEntries(Object.entries(input).filter(([key, value]) => key.length <= 40 && typeof value === 'string').map(([key, value]) => [key, value.slice(0, 500)]));
}

/**
 * Express router for hosted Express onboarding and direct-charge Stripe Checkout.
 * Mount it after authentication middleware, but never put the platform secret in the client.
 */
export function createStripeExpressConnectRouter(options: StripeExpressConnectOptions) {
  // Express Dashboard with Accounts v2 is currently a Stripe preview API.
  const stripe = new Stripe(options.stripeSecretKey, { apiVersion: options.apiVersion || '2026-09-30.preview' as Stripe.LatestApiVersion });
  const router = express.Router();

  router.post('/onboard', async (req: Request, res: Response) => {
    try {
      const suppliedAccountId = typeof req.body?.accountId === 'string' ? req.body.accountId : undefined;
      let account: { id: string };
      if (suppliedAccountId) {
        account = await stripe.v2.core.accounts.retrieve(suppliedAccountId) as { id: string };
      } else {
        const email = typeof req.body?.email === 'string' ? req.body.email : undefined;
        const country = typeof req.body?.country === 'string' ? req.body.country.toUpperCase() : undefined;
        account = await stripe.v2.core.accounts.create({
          contact_email: email,
          dashboard: 'express',
          identity: { country },
          defaults: { responsibilities: { fees_collector: 'stripe', losses_collector: 'stripe' } },
          configuration: { merchant: { capabilities: { card_payments: { requested: true } } } },
        });
        await options.onAccountCreated?.(account, req);
      }
      const link = await stripe.v2.core.accountLinks.create({ account: account.id, use_case: { type: 'account_onboarding', account_onboarding: { refresh_url: options.onboarding.refreshUrl, return_url: options.onboarding.returnUrl } } });
      res.json({ accountId: account.id, onboardingUrl: link.url, onboardingComplete: false });
    } catch (error) {
      res.status(400).json({ error: toErrorMessage(error) });
    }
  });

  router.get('/accounts/:accountId/status', async (req: Request, res: Response) => {
    try {
      const accountId = Array.isArray(req.params.accountId) ? req.params.accountId[0] : req.params.accountId;
      if (!accountId) throw new Error('Account Stripe non valido.');
      const account = await stripe.v2.core.accounts.retrieve(accountId) as any;
      const requirements = account.requirements?.currently_due ?? [];
      res.json({ accountId: account.id, onboardingComplete: requirements.length === 0, chargesEnabled: requirements.length === 0, payoutsEnabled: requirements.length === 0, requirements });
    } catch (error) {
      res.status(400).json({ error: toErrorMessage(error) });
    }
  });

  router.post('/checkout', async (req: Request, res: Response) => {
    try {
      const rawPayload = req.body as CheckoutPayload;
      const payload = await options.validateCheckout?.(req, rawPayload) ?? rawPayload;
      const accountId = await options.resolveAccountId?.(req, payload) ?? payload.accountId;
      if (!accountId || !accountId.startsWith('acct_')) throw new Error('Account Stripe della coppia non disponibile.');
      const amount = toCents(payload.amount);
      const fee = options.applicationFeeAmount ? await options.applicationFeeAmount(payload, amount) : 0;
      if (!Number.isSafeInteger(fee) || fee < 0 || fee >= amount) throw new Error('Commissione piattaforma non valida.');

      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        success_url: options.checkout.successUrl.includes('{CHECKOUT_SESSION_ID}') ? options.checkout.successUrl : `${options.checkout.successUrl}${options.checkout.successUrl.includes('?') ? '&' : '?'}session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: options.checkout.cancelUrl,
        line_items: [{ price_data: { currency: (payload.currency || 'eur').toLowerCase(), unit_amount: amount, product_data: { name: payload.title || 'Contributo', description: payload.description } }, quantity: 1 }],
        metadata: metadata(payload.metadata),
        payment_intent_data: fee ? { application_fee_amount: fee, metadata: metadata(payload.metadata) } : { metadata: metadata(payload.metadata) },
      }, { stripeAccount: accountId });
      if (!session.url) throw new Error('Stripe non ha restituito l’URL di Checkout.');
      res.json({ id: session.id, url: session.url });
    } catch (error) {
      res.status(400).json({ error: toErrorMessage(error) });
    }
  });

  return router;
}

/**
 * Returns a handler that verifies Stripe's signature before invoking your persistence logic.
 * Mount this endpoint with `express.raw({ type: 'application/json' })` before `express.json()`.
 */
export function createStripeWebhookHandler(options: StripeWebhookOptions): RequestHandler {
  const stripe = new Stripe(options.stripeSecretKey, options.apiVersion ? { apiVersion: options.apiVersion } : undefined);
  return async (req, res) => {
    try {
      const signature = req.headers['stripe-signature'];
      if (typeof signature !== 'string' || !Buffer.isBuffer(req.body)) throw new Error('Firma webhook o corpo raw non valido.');
      const event = stripe.webhooks.constructEvent(req.body, signature, options.webhookSecret);
      await options.onEvent?.(event);
      if (event.type === 'checkout.session.completed') await options.onCheckoutCompleted(event.data.object as Stripe.Checkout.Session, event);
      res.status(200).json({ received: true });
    } catch (error) {
      res.status(400).json({ error: toErrorMessage(error) });
    }
  };
}
