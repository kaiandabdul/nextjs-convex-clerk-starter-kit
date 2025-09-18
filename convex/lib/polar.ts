/**
 * Polar API client library
 * Provides typed methods for interacting with the Polar API
 */

import {
  PolarCustomer,
  PolarSubscription,
  PolarProduct,
  PolarCheckoutSession,
  PolarOrder,
  PolarAPIError,
  type PolarPrice,
} from "../types";

// Configuration
export interface PolarConfig {
  organizationToken: string;
  server: "sandbox" | "production";
  webhookSecret?: string;
}

// Get Polar config from environment
export function getPolarConfig(): PolarConfig {
  const token = process.env.POLAR_ORGANIZATION_TOKEN;
  const server = (process.env.POLAR_SERVER as "sandbox" | "production") || "sandbox";
  const webhookSecret = process.env.POLAR_WEBHOOK_SECRET;

  if (!token) {
    throw new Error("POLAR_ORGANIZATION_TOKEN environment variable is required");
  }

  return {
    organizationToken: token,
    server,
    webhookSecret,
  };
}

// Get Polar API base URL
export function getPolarApiUrl(config: PolarConfig): string {
  return config.server === "production" 
    ? "https://api.polar.sh"
    : "https://sandbox-api.polar.sh";
}

// API request with retry logic
async function polarRequest<T>(
  path: string,
  options: RequestInit = {},
  config: PolarConfig,
  retries = 3
): Promise<T> {
  const baseUrl = getPolarApiUrl(config);
  const url = `${baseUrl}${path}`;
  
  const headers: HeadersInit = {
    "Authorization": `Bearer ${config.organizationToken}`,
    "Content-Type": "application/json",
    ...options.headers,
  };

  let lastError: Error | null = null;
  
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const response = await fetch(url, {
        ...options,
        headers,
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => null);
        throw new PolarAPIError(
          errorData?.detail || `Polar API error: ${response.statusText}`,
          response.status,
          errorData?.type,
          errorData
        );
      }

      const data = await response.json();
      return data as T;
    } catch (error) {
      lastError = error as Error;
      
      // Don't retry on client errors (4xx)
      if (error instanceof PolarAPIError && error.statusCode && error.statusCode < 500) {
        throw error;
      }
      
      // Exponential backoff
      if (attempt < retries - 1) {
        await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
      }
    }
  }
  
  throw lastError || new Error("Failed to complete Polar API request");
}

// Customer operations
export const customers = {
  async create(
    email: string,
    metadata?: Record<string, any>,
    config?: PolarConfig
  ): Promise<PolarCustomer> {
    const cfg = config || getPolarConfig();
    return polarRequest<PolarCustomer>(
      "/v1/customers",
      {
        method: "POST",
        body: JSON.stringify({
          email,
          metadata,
        }),
      },
      cfg
    );
  },

  async get(customerId: string, config?: PolarConfig): Promise<PolarCustomer> {
    const cfg = config || getPolarConfig();
    return polarRequest<PolarCustomer>(`/v1/customers/${customerId}`, {}, cfg);
  },

  async update(
    customerId: string,
    updates: Partial<{
      email: string;
      metadata: Record<string, any>;
    }>,
    config?: PolarConfig
  ): Promise<PolarCustomer> {
    const cfg = config || getPolarConfig();
    return polarRequest<PolarCustomer>(
      `/v1/customers/${customerId}`,
      {
        method: "PATCH",
        body: JSON.stringify(updates),
      },
      cfg
    );
  },

  async delete(customerId: string, config?: PolarConfig): Promise<void> {
    const cfg = config || getPolarConfig();
    await polarRequest<void>(
      `/v1/customers/${customerId}`,
      {
        method: "DELETE",
      },
      cfg
    );
  },

  async list(
    params?: {
      email?: string;
      page?: number;
      limit?: number;
    },
    config?: PolarConfig
  ): Promise<{ items: PolarCustomer[]; pagination: any }> {
    const cfg = config || getPolarConfig();
    const queryParams = new URLSearchParams();
    if (params?.email) queryParams.append("email", params.email);
    if (params?.page) queryParams.append("page", params.page.toString());
    if (params?.limit) queryParams.append("limit", params.limit.toString());
    
    return polarRequest<{ items: PolarCustomer[]; pagination: any }>(
      `/v1/customers?${queryParams}`,
      {},
      cfg
    );
  },
};

// Subscription operations
export const subscriptions = {
  async get(subscriptionId: string, config?: PolarConfig): Promise<PolarSubscription> {
    const cfg = config || getPolarConfig();
    return polarRequest<PolarSubscription>(
      `/v1/subscriptions/${subscriptionId}`,
      {},
      cfg
    );
  },

  async list(
    params?: {
      customer_id?: string;
      product_id?: string;
      active?: boolean;
      page?: number;
      limit?: number;
    },
    config?: PolarConfig
  ): Promise<{ items: PolarSubscription[]; pagination: any }> {
    const cfg = config || getPolarConfig();
    const queryParams = new URLSearchParams();
    if (params?.customer_id) queryParams.append("customer_id", params.customer_id);
    if (params?.product_id) queryParams.append("product_id", params.product_id);
    if (params?.active !== undefined) queryParams.append("active", params.active.toString());
    if (params?.page) queryParams.append("page", params.page.toString());
    if (params?.limit) queryParams.append("limit", params.limit.toString());
    
    return polarRequest<{ items: PolarSubscription[]; pagination: any }>(
      `/v1/subscriptions?${queryParams}`,
      {},
      cfg
    );
  },

  async cancel(
    subscriptionId: string,
    params?: {
      cancel_at_period_end?: boolean;
      comment?: string;
      reason?: string;
    },
    config?: PolarConfig
  ): Promise<PolarSubscription> {
    const cfg = config || getPolarConfig();
    return polarRequest<PolarSubscription>(
      `/v1/subscriptions/${subscriptionId}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          cancel_at_period_end: params?.cancel_at_period_end ?? true,
          customer_cancellation_comment: params?.comment,
          customer_cancellation_reason: params?.reason,
        }),
      },
      cfg
    );
  },

  async update(
    subscriptionId: string,
    updates: {
      product_price_id?: string;
      metadata?: Record<string, any>;
    },
    config?: PolarConfig
  ): Promise<PolarSubscription> {
    const cfg = config || getPolarConfig();
    return polarRequest<PolarSubscription>(
      `/v1/subscriptions/${subscriptionId}`,
      {
        method: "PATCH",
        body: JSON.stringify(updates),
      },
      cfg
    );
  },
};

// Product operations
export const products = {
  async get(productId: string, config?: PolarConfig): Promise<PolarProduct> {
    const cfg = config || getPolarConfig();
    return polarRequest<PolarProduct>(`/v1/products/${productId}`, {}, cfg);
  },

  async list(
    params?: {
      is_archived?: boolean;
      is_recurring?: boolean;
      organization_id?: string;
      page?: number;
      limit?: number;
    },
    config?: PolarConfig
  ): Promise<{ items: PolarProduct[]; pagination: any }> {
    const cfg = config || getPolarConfig();
    const queryParams = new URLSearchParams();
    if (params?.is_archived !== undefined) {
      queryParams.append("is_archived", params.is_archived.toString());
    }
    if (params?.is_recurring !== undefined) {
      queryParams.append("is_recurring", params.is_recurring.toString());
    }
    if (params?.organization_id) {
      queryParams.append("organization_id", params.organization_id);
    }
    if (params?.page) queryParams.append("page", params.page.toString());
    if (params?.limit) queryParams.append("limit", params.limit.toString());
    
    return polarRequest<{ items: PolarProduct[]; pagination: any }>(
      `/v1/products?${queryParams}`,
      {},
      cfg
    );
  },

  async create(
    product: {
      name: string;
      description?: string;
      prices: Array<{
        type: "recurring" | "one_time";
        recurring_interval?: "month" | "year";
        price_amount: number;
        price_currency: string;
      }>;
      metadata?: Record<string, any>;
    },
    config?: PolarConfig
  ): Promise<PolarProduct> {
    const cfg = config || getPolarConfig();
    return polarRequest<PolarProduct>(
      "/v1/products",
      {
        method: "POST",
        body: JSON.stringify(product),
      },
      cfg
    );
  },

  async update(
    productId: string,
    updates: {
      name?: string;
      description?: string;
      is_archived?: boolean;
      metadata?: Record<string, any>;
    },
    config?: PolarConfig
  ): Promise<PolarProduct> {
    const cfg = config || getPolarConfig();
    return polarRequest<PolarProduct>(
      `/v1/products/${productId}`,
      {
        method: "PATCH",
        body: JSON.stringify(updates),
      },
      cfg
    );
  },
};

// Checkout operations
export const checkouts = {
  async create(
    params: {
      product_price_id?: string;
      product_id?: string;
      customer_email?: string;
      customer_id?: string;
      customer_name?: string;
      customer_billing_address?: {
        country: string;
        line1?: string;
        line2?: string;
        postal_code?: string;
        city?: string;
        state?: string;
      };
      customer_tax_id?: string;
      discount_id?: string;
      allow_discount_codes?: boolean;
      success_url?: string;
      embed_origin?: string;
      metadata?: Record<string, any>;
    },
    config?: PolarConfig
  ): Promise<PolarCheckoutSession> {
    const cfg = config || getPolarConfig();
    return polarRequest<PolarCheckoutSession>(
      "/v1/checkouts/custom",
      {
        method: "POST",
        body: JSON.stringify({
          payment_processor: "stripe",
          ...params,
        }),
      },
      cfg
    );
  },

  async get(checkoutId: string, config?: PolarConfig): Promise<PolarCheckoutSession> {
    const cfg = config || getPolarConfig();
    return polarRequest<PolarCheckoutSession>(
      `/v1/checkouts/custom/${checkoutId}`,
      {},
      cfg
    );
  },

  async getByClientSecret(
    clientSecret: string,
    config?: PolarConfig
  ): Promise<PolarCheckoutSession> {
    const cfg = config || getPolarConfig();
    return polarRequest<PolarCheckoutSession>(
      `/v1/checkouts/custom/client-secret/${clientSecret}`,
      {},
      cfg
    );
  },

  async confirm(
    checkoutId: string,
    params?: {
      confirmation_token_id?: string;
    },
    config?: PolarConfig
  ): Promise<PolarCheckoutSession> {
    const cfg = config || getPolarConfig();
    return polarRequest<PolarCheckoutSession>(
      `/v1/checkouts/custom/${checkoutId}/confirm`,
      {
        method: "POST",
        body: JSON.stringify(params || {}),
      },
      cfg
    );
  },
};

// Order operations
export const orders = {
  async get(orderId: string, config?: PolarConfig): Promise<PolarOrder> {
    const cfg = config || getPolarConfig();
    return polarRequest<PolarOrder>(`/v1/orders/${orderId}`, {}, cfg);
  },

  async list(
    params?: {
      customer_id?: string;
      product_id?: string;
      subscription_id?: string;
      page?: number;
      limit?: number;
    },
    config?: PolarConfig
  ): Promise<{ items: PolarOrder[]; pagination: any }> {
    const cfg = config || getPolarConfig();
    const queryParams = new URLSearchParams();
    if (params?.customer_id) queryParams.append("customer_id", params.customer_id);
    if (params?.product_id) queryParams.append("product_id", params.product_id);
    if (params?.subscription_id) queryParams.append("subscription_id", params.subscription_id);
    if (params?.page) queryParams.append("page", params.page.toString());
    if (params?.limit) queryParams.append("limit", params.limit.toString());
    
    return polarRequest<{ items: PolarOrder[]; pagination: any }>(
      `/v1/orders?${queryParams}`,
      {},
      cfg
    );
  },

  async getInvoice(orderId: string, config?: PolarConfig): Promise<{ url: string }> {
    const cfg = config || getPolarConfig();
    return polarRequest<{ url: string }>(
      `/v1/orders/${orderId}/invoice`,
      {},
      cfg
    );
  },
};

// Usage/Metrics operations
export const metrics = {
  async ingestEvents(
    events: Array<{
      customer_id: string;
      event_name: string;
      properties: Record<string, any>;
      timestamp?: string;
    }>,
    config?: PolarConfig
  ): Promise<{ accepted: number; rejected: number }> {
    const cfg = config || getPolarConfig();
    return polarRequest<{ accepted: number; rejected: number }>(
      "/v1/metrics/events",
      {
        method: "POST",
        body: JSON.stringify({ events }),
      },
      cfg
    );
  },

  async getUsage(
    params: {
      customer_id: string;
      start_date: string;
      end_date: string;
      metric_id?: string;
    },
    config?: PolarConfig
  ): Promise<any> {
    const cfg = config || getPolarConfig();
    const queryParams = new URLSearchParams({
      customer_id: params.customer_id,
      start_date: params.start_date,
      end_date: params.end_date,
    });
    if (params.metric_id) queryParams.append("metric_id", params.metric_id);
    
    return polarRequest<any>(`/v1/metrics/usage?${queryParams}`, {}, cfg);
  },
};

// Webhook signature verification
export function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string
): boolean {
  // Implementation depends on Polar's webhook signature method
  // This is a placeholder - update based on Polar's documentation
  try {
    // Polar uses a similar approach to Stripe/GitHub
    const crypto = require("crypto");
    const expectedSignature = crypto
      .createHmac("sha256", secret)
      .update(payload)
      .digest("hex");
    
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    );
  } catch (error) {
    console.error("Webhook signature verification failed:", error);
    return false;
  }
}

// Helper to get customer portal URL
export async function getCustomerPortalUrl(
  customerId: string,
  config?: PolarConfig
): Promise<{ url: string }> {
  const cfg = config || getPolarConfig();
  return polarRequest<{ url: string }>(
    `/v1/customers/${customerId}/portal`,
    {
      method: "POST",
      body: JSON.stringify({
        return_url: process.env.NEXT_PUBLIC_APP_URL || "https://localhost:3000",
      }),
    },
    cfg
  );
}

// Helper to calculate proration
export function calculateProration(
  oldPriceCents: number,
  newPriceCents: number,
  daysLeftInPeriod: number,
  totalDaysInPeriod: number
): number {
  const percentageRemaining = daysLeftInPeriod / totalDaysInPeriod;
  const oldCredit = Math.round(oldPriceCents * percentageRemaining);
  const newCharge = Math.round(newPriceCents * percentageRemaining);
  return newCharge - oldCredit;
}

// Helper to format currency
export function formatCurrency(cents: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).format(cents / 100);
}

// Export main API object
export const polarApi = {
  customers,
  subscriptions,
  products,
  checkouts,
  orders,
  metrics,
  verifyWebhookSignature,
  getCustomerPortalUrl,
  calculateProration,
  formatCurrency,
  getPolarConfig,
  getPolarApiUrl,
};