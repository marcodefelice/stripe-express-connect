export interface ConnectedAccount {
  accountId: string;
  onboardingComplete: boolean;
}

export interface OnboardingResponse extends ConnectedAccount {
  onboardingUrl: string;
}

export interface CheckoutRequest {
  /** The connected Express account that receives the payment. */
  accountId: string;
  /** Amount in the major currency unit, for example 50 = EUR 50.00. */
  amount: number;
  currency?: string;
  title?: string;
  description?: string;
  metadata?: Record<string, string>;
}
