import { useState } from 'react';
import type { CheckoutRequest } from './types.js';

export interface ExpressCheckoutButtonProps extends CheckoutRequest {
  /** API endpoint that creates a Stripe Checkout Session. */
  endpoint?: string;
  children?: React.ReactNode;
  className?: string;
  disabled?: boolean;
  onError?: (error: Error) => void;
}

/** Redirects to Stripe Checkout for a direct charge on an Express connected account. */
export function ExpressCheckoutButton({ endpoint = '/api/stripe-connect/checkout', children = 'Paga in sicurezza', className, disabled, onError, ...checkout }: ExpressCheckoutButtonProps) {
  const [loading, setLoading] = useState(false);

  const checkoutNow = async () => {
    setLoading(true);
    try {
      const response = await fetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(checkout),
      });
      const result = (await response.json()) as { url?: string; error?: string };
      if (!response.ok || !result.url) throw new Error(result.error || 'Impossibile creare il pagamento.');
      window.location.assign(result.url);
    } catch (cause) {
      onError?.(cause instanceof Error ? cause : new Error('Impossibile creare il pagamento.'));
      setLoading(false);
    }
  };

  return <button type="button" className={className} disabled={disabled || loading} onClick={checkoutNow}>{loading ? 'Reindirizzamento…' : children}</button>;
}
