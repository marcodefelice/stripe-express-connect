import { useState } from 'react';
import type { OnboardingResponse } from './types.js';

export interface ConnectExpressButtonProps {
  /** API endpoint that creates an Express account and an Account Link. */
  endpoint?: string;
  email?: string;
  country?: string;
  accountId?: string;
  children?: React.ReactNode;
  className?: string;
  disabled?: boolean;
  onCreated?: (result: OnboardingResponse) => void | Promise<void>;
  onError?: (error: Error) => void;
}

/** Opens Stripe-hosted onboarding. No Stripe secret or publishable key is needed in the browser. */
export function ConnectExpressButton({
  endpoint = '/api/stripe-connect/onboard',
  email,
  country,
  accountId,
  children = 'Collega il conto per ricevere pagamenti',
  className,
  disabled = false,
  onCreated,
  onError,
}: ConnectExpressButtonProps) {
  const [loading, setLoading] = useState(false);

  const beginOnboarding = async () => {
    setLoading(true);
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ accountId, email, country }),
      });
      const result = (await response.json()) as OnboardingResponse & { error?: string };
      if (!response.ok || !result.onboardingUrl) throw new Error(result.error || 'Impossibile avviare Stripe Connect.');
      await onCreated?.(result);
      window.location.assign(result.onboardingUrl);
    } catch (cause) {
      onError?.(cause instanceof Error ? cause : new Error('Impossibile avviare Stripe Connect.'));
    } finally {
      setLoading(false);
    }
  };

  return <button type="button" className={className} disabled={disabled || loading} onClick={beginOnboarding}>{loading ? 'Apertura Stripe…' : children}</button>;
}
