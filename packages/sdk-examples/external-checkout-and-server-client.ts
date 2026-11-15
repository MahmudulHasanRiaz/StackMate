/**
 * StackMate Reference External Website & Server-to-Server SDK Client
 * Supports Astro, Next.js, React, Remix, SvelteKit, WordPress, or custom backends.
 */

export interface StackMateClientConfig {
  baseUrl: string;
  siteKey: string;
  clientId?: string;
  clientSecret?: string;
}

export class StackMateExternalClient {
  private readonly baseUrl: string;
  private readonly siteKey: string;
  private readonly clientId?: string;
  private readonly clientSecret?: string;

  constructor(config: StackMateClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.siteKey = config.siteKey;
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
  }

  /**
   * Public catalog lookup (served through Hyperdrive read-cached binding).
   */
  async getPublicCatalog(): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}/api/v1/public/sites/${this.siteKey}/catalog`);
    return res.json();
  }

  /**
   * Create checkout session & order with Idempotency-Key and attribution metadata.
   */
  async createCheckoutOrder(
    payload: {
      customer_email: string;
      customer_name: string;
      customer_phone?: string;
      items: Array<{
        product_id: string;
        plan_id: string;
        price_id: string;
        quantity: number;
      }>;
      coupon_code?: string;
      currency?: string;
      attribution?: {
        utm_source?: string;
        utm_medium?: string;
        utm_campaign?: string;
        fbp?: string;
        fbc?: string;
        client_user_agent?: string;
        event_source_url?: string;
      };
    },
    idempotencyKey: string
  ): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}/api/v1/public/sites/${this.siteKey}/checkout`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(payload),
    });
    return res.json();
  }

  /**
   * Submit manual payment proof (bKash / Nagad / Rocket / Upay / Bank Transfer).
   */
  async submitManualPayment(
    orderId: string,
    checkoutToken: string,
    payload: {
      payment_method_code: string;
      transfer_rail?: string;
      sender_number?: string;
      sender_account_name?: string;
      transaction_id: string;
      submitted_amount_minor: number;
      currency?: string;
      customer_note?: string;
      proof_file_base64?: string;
      proof_file_name?: string;
      proof_file_mime_type?: string;
    },
    idempotencyKey: string
  ): Promise<unknown> {
    const res = await fetch(
      `${this.baseUrl}/api/v1/public/orders/${orderId}/payment-submissions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-StackMate-Checkout-Token": checkoutToken,
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(payload),
      }
    );
    return res.json();
  }
}
