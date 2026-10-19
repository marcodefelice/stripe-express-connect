# @mdf/stripe-express-connect

Componenti React e API Express per collegare account **Stripe Connect Express** e incassare tramite **Stripe Checkout** direttamente sull'account della coppia.

È pensato per piattaforme multi-utente: la piattaforma custodisce una sola chiave segreta Stripe; ogni coppia completa l'onboarding ospitato da Stripe e riceve i fondi sul proprio IBAN. La coppia non deve conoscere né inserire chiavi API.

> Il package gestisce esclusivamente il flusso Connect Express + Checkout. Non crea form carta personalizzati e non memorizza dati di pagamento.

## Installazione

Dopo la pubblicazione su npm:

```bash
npm install @mdf/stripe-express-connect
```

Per installarlo direttamente da GitHub prima della pubblicazione:

```bash
npm install github:marcodefelice/stripe-express-connect
```

Dipendenze peer: `react` (18 o 19) e `express` (4 o 5). `stripe` viene installato automaticamente dal package.

## Come funziona

```text
Coppia → bottone onboarding → pagina Stripe → Express account + IBAN
Invitato → bottone Checkout → Stripe Checkout → account Express della coppia
Stripe → webhook verificato → tua applicazione registra la donazione
```

Questo package usa **direct charges**: il pagamento è creato sul Connected Account Express della coppia. Quindi la coppia è il merchant del pagamento e, nella configurazione standard Stripe, sostiene le commissioni di elaborazione. La piattaforma può impostare una sua commissione opzionale con `applicationFeeAmount`.

### Accounts v2 e Managed Risk

Gli account vengono creati con **Accounts v2**, Dashboard Express e `losses_collector: stripe`; non usare il legacy `type: 'express'`. Per questo flusso Stripe richiede la preview API `2026-09-30.preview`, già impostata dal package salvo override esplicito. Se usi una restricted key, abilita anche il permesso `v2_account_storer_write`.

## Configurazione Stripe

1. Crea un account Stripe per la tua piattaforma e abilita Connect.
2. Configura URL di ritorno HTTPS nel Dashboard Stripe se necessario.
3. Crea un endpoint webhook per `checkout.session.completed` e salva il relativo signing secret.
4. Imposta solo sul server:

```bash
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
```

Non esporre mai queste variabili nel browser, in Firestore, nel database pubblico o nel file di configurazione della coppia.

## Backend Express

Monta il webhook **prima** di `express.json()`, perché la firma Stripe richiede il corpo raw. Il router richiede invece JSON.

```ts
import express from 'express';
import {
  createStripeExpressConnectRouter,
  createStripeWebhookHandler,
} from '@mdf/stripe-express-connect/server';

const app = express();
const baseUrl = process.env.PUBLIC_APP_URL!; // es. https://miosito.it

app.post(
  '/api/stripe-webhook',
  express.raw({ type: 'application/json' }),
  createStripeWebhookHandler({
    stripeSecretKey: process.env.STRIPE_SECRET_KEY!,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET!,
    async onCheckoutCompleted(session) {
      // Fonte attendibile: registra qui la donazione come pagata.
      // session.metadata contiene i dati decisi lato server.
      await saveCompletedDonation({
        checkoutSessionId: session.id,
        paymentIntentId: String(session.payment_intent),
        registryId: session.metadata?.registryId,
      });
    },
  }),
);

app.use(express.json());

app.use('/api/stripe-connect', createStripeExpressConnectRouter({
  stripeSecretKey: process.env.STRIPE_SECRET_KEY!,
  onboarding: {
    refreshUrl: `${baseUrl}/pagamenti/stripe/riprova`,
    returnUrl: `${baseUrl}/pagamenti/stripe/completato`,
  },
  checkout: {
    successUrl: `${baseUrl}/grazie`,
    cancelUrl: `${baseUrl}/donazione/annullata`,
  },
  async onAccountCreated(account, req) {
    // Associa account.id alla coppia autenticata nel tuo database.
    await saveStripeAccountForCurrentUser(req, account.id);
  },
  async resolveAccountId(req) {
    // IMPORTANTE: ricavalo dalla tua lista/coppia, non fidarti dell'accountId dal browser.
    return findStripeAccountForRegistry(req.body.registryId);
  },
  async validateCheckout(req, input) {
    // Leggi titolo, importo e account dal tuo DB se vuoi evitare importi manipolati.
    if (!Number.isFinite(input.amount) || input.amount <= 0) throw new Error('Importo non valido');
    return {
      ...input,
      currency: 'eur',
      title: 'Regalo di nozze',
      metadata: {
        registryId: String(req.body.registryId),
        giftId: String(req.body.giftId || ''),
        guestName: String(req.body.guestName || '').slice(0, 200),
      },
    };
  },
  // Nessuna commissione piattaforma: la coppia riceve l'importo meno le normali fee Stripe.
  applicationFeeAmount: () => 0,
}));
```

`resolveAccountId` e `validateCheckout` sono le due protezioni importanti in un prodotto multi-coppia: collegale alla tua autenticazione e al tuo database. Se omesse, il router accetta `accountId`, importo e descrizione dal client, utile solo per demo o per un backend già protetto a monte.

## React

### Collegare la coppia

```tsx
import { ConnectExpressButton } from '@mdf/stripe-express-connect';

<ConnectExpressButton
  email={currentCouple.email}
  country="IT"
  className="my-button"
  onCreated={async ({ accountId }) => {
    // Facoltativo: salva subito l'ID nel tuo database.
    // Il callback viene eseguito prima del redirect a Stripe.
    await saveAccountId(accountId);
  }}
  onError={(error) => setError(error.message)}
/>
```

Per far riprendere un onboarding non terminato, passa l'`accountId` già salvato:

```tsx
<ConnectExpressButton accountId={couple.stripeAccountId}>
  Completa configurazione Stripe
</ConnectExpressButton>
```

### Inviare un invitato a Checkout

```tsx
import { ExpressCheckoutButton } from '@mdf/stripe-express-connect';

<ExpressCheckoutButton
  accountId={couple.stripeAccountId}
  amount={50}
  currency="eur"
  title="Contributo per il viaggio di nozze"
  metadata={{ registryId: couple.registryId, giftId: gift.id }}
  className="pay-button"
  onError={(error) => setError(error.message)}
>
  Contribuisci con €50
</ExpressCheckoutButton>
```

Il bottone reindirizza alla pagina Checkout ospitata da Stripe. Non segnare la donazione come completata dal client o nella pagina `success`: fallo solo nel webhook verificato.

## Adattamento a `Giovanni-e-Francesca-main`

Nel progetto attuale:

1. Rimuovi `stripeSecretKey` da `RegistrySettings`, Firestore, localStorage e dalla schermata pagamenti.
2. Sostituisci l'attuale endpoint simulato `/api/stripe/connect` con il router mostrato sopra.
3. Salva per ogni lista solo `stripeAccountId` (`acct_...`).
4. Sostituisci `ApplePaySheet` e il pagamento carta simulato con `ExpressCheckoutButton`.
5. Nel webhook aggiorna `donations`, `raisedAmount` e contatori. Non farlo nel browser.
6. Proteggi dashboard e scritture Firestore/API: nessun utente anonimo deve poter cambiare account o importi.

## Commissioni

Con direct charges la coppia riceve l'accredito sul proprio account Express; le commissioni di elaborazione Stripe vengono normalmente detratte da quell'account. Se imposti `applicationFeeAmount`, quella quota è la tua commissione di piattaforma e viene trasferita alla piattaforma. Tariffe e responsabilità dipendono dal Paese, dal contratto Stripe e dai metodi di pagamento: verifica sempre le [tariffe ufficiali Stripe Connect](https://stripe.com/it/connect/pricing).

## Sviluppo e pubblicazione

```bash
npm install
npm run typecheck
npm run build
npm publish
```

Per testare i webhook localmente usa Stripe CLI e una chiave test. Non inviare mai chiavi live nei commit.
