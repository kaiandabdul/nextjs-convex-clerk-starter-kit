// Billing system types and enums

export const BillingTier = {
  FREE: "free",
  PREMIUM: "premium",
  PREMIUM_PLUS: "premium_plus",
} as const;

export type BillingTier = (typeof BillingTier)[keyof typeof BillingTier];

export const SubscriptionStatus = {
  INCOMPLETE: "incomplete",
  INCOMPLETE_EXPIRED: "incomplete_expired",
  TRIALING: "trialing",
  ACTIVE: "active",
  PAST_DUE: "past_due",
  CANCELED: "canceled",
  UNPAID: "unpaid",
  REVOKED: "revoked",
} as const;

export type SubscriptionStatus = (typeof SubscriptionStatus)[keyof typeof SubscriptionStatus];

export const CheckoutStatus = {
  PENDING: "pending",
  COMPLETED: "completed",
  EXPIRED: "expired",
  CANCELED: "canceled",
} as const;

export type CheckoutStatus = (typeof CheckoutStatus)[keyof typeof CheckoutStatus];

export const UsageEventType = {
  API_CALLS: "api_calls",
  AI_TOKENS: "ai_tokens",
  STORAGE_GB: "storage_gb",
  BANDWIDTH_GB: "bandwidth_gb",
  COMPUTE_HOURS: "compute_hours",
} as const;

export type UsageEventType = (typeof UsageEventType)[keyof typeof UsageEventType];

export const WebhookSource = {
  POLAR: "polar",
  CLERK: "clerk",
} as const;

export type WebhookSource = (typeof WebhookSource)[keyof typeof WebhookSource];

// Polar API response types
export interface PolarCustomer {
  id: string;
  email: string;
  email_verified: boolean;
  created_at: string;
  modified_at?: string;
  metadata?: Record<string, any>;
}

export interface PolarSubscription {
  id: string;
  status: string;
  current_period_start: string;
  current_period_end?: string;
  cancel_at_period_end: boolean;
  started_at?: string;
  ended_at?: string;
  customer_id: string;
  product_id: string;
  price_id?: string;
  discount_id?: string;
  checkout_id?: string;
  metadata?: Record<string, any>;
  created_at: string;
  modified_at?: string;
}

export interface PolarProduct {
  id: string;
  name: string;
  description?: string;
  is_recurring: boolean;
  is_archived: boolean;
  organization_id: string;
  prices: PolarPrice[];
  benefits: PolarBenefit[];
  medias: PolarMedia[];
  created_at: string;
  modified_at?: string;
  metadata?: Record<string, any>;
}

export interface PolarPrice {
  id: string;
  product_id: string;
  type: "recurring" | "one_time";
  recurring_interval?: "month" | "year";
  price_amount: number;
  price_currency: string;
  is_archived: boolean;
  created_at: string;
  modified_at?: string;
}

export interface PolarBenefit {
  id: string;
  type: string;
  description: string;
  deletable: boolean;
  selectable: boolean;
  created_at: string;
  modified_at?: string;
  properties?: Record<string, any>;
}

export interface PolarMedia {
  id: string;
  organization_id: string;
  name: string;
  path: string;
  mime_type: string;
  size: number;
  storage_version?: string;
  checksum_etag?: string;
  checksum_sha256_base64?: string;
  checksum_sha256_hex?: string;
  last_modified_at?: string;
  version?: string;
  is_uploaded: boolean;
  created_at: string;
  public_url?: string;
  size_readable?: string;
}

export interface PolarCheckoutSession {
  id: string;
  url?: string;
  customer_email?: string;
  customer_id?: string;
  customer_name?: string;
  customer_ip_address?: string;
  customer_billing_address?: PolarAddress;
  customer_tax_id?: string;
  payment_processor: string;
  status: string;
  client_secret: string;
  embed_origin?: string;
  amount?: number;
  currency?: string;
  total_amount?: number;
  product_id?: string;
  product_price_id?: string;
  discount_id?: string;
  allow_discount_codes: boolean;
  is_discount_applicable: boolean;
  is_free_product_price: boolean;
  is_payment_setup_required: boolean;
  is_payment_required: boolean;
  tax_amount?: number;
  checkout_id?: string;
  success_url?: string;
  metadata?: Record<string, any>;
  created_at: string;
  modified_at?: string;
  expires_at: string;
}

export interface PolarAddress {
  line1?: string;
  line2?: string;
  postal_code?: string;
  city?: string;
  state?: string;
  country: string;
}

export interface PolarOrder {
  id: string;
  created_at: string;
  modified_at?: string;
  customer_id: string;
  product_id: string;
  product_price_id: string;
  discount_id?: string;
  subscription_id?: string;
  checkout_id?: string;
  amount: number;
  currency: string;
  tax_amount: number;
  billing_address?: PolarAddress;
  billing_reason: string;
  metadata?: Record<string, any>;
}

export interface PolarInvoice {
  url: string;
}

// Webhook payload types
export interface PolarWebhookPayload {
  id: string;
  type: string;
  data: any;
  created_at: string;
}

export interface ClerkWebhookPayload {
  id: string;
  type: string;
  data: any;
  object: string;
  created_at: number;
  environment?: string;
  event_attributes?: Record<string, any>;
}

// Error types
export class BillingError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode?: number,
    public metadata?: Record<string, any>
  ) {
    super(message);
    this.name = "BillingError";
  }
}

export class PolarAPIError extends BillingError {
  constructor(
    message: string,
    statusCode?: number,
    public polarErrorCode?: string,
    metadata?: Record<string, any>
  ) {
    super(message, polarErrorCode || "POLAR_API_ERROR", statusCode, metadata);
    this.name = "PolarAPIError";
  }
}

export class WebhookVerificationError extends BillingError {
  constructor(message: string, metadata?: Record<string, any>) {
    super(message, "WEBHOOK_VERIFICATION_ERROR", 401, metadata);
    this.name = "WebhookVerificationError";
  }
}

// Feature flags based on subscription
export interface FeatureFlags {
  // Usage limits
  maxApiCalls?: number;
  maxAiTokens?: number;
  maxStorageGb?: number;
  maxBandwidthGb?: number;
  maxTeamMembers?: number;
  
  // Features
  hasCustomDomain: boolean;
  hasAdvancedAnalytics: boolean;
  hasPrioritySupport: boolean;
  hasWebhooks: boolean;
  hasApiAccess: boolean;
  hasSsoAccess: boolean;
  hasAuditLogs: boolean;
  hasCustomBranding: boolean;
  hasDataExport: boolean;
  
  // Billing
  canUpgrade: boolean;
  canDowngrade: boolean;
  isTrialing: boolean;
  daysLeftInTrial?: number;
}

// User with billing info
export interface UserWithBilling {
  id: string;
  name: string;
  email: string;
  externalId: string;
  createdAt: string;
  updatedAt: string;
  
  // Billing
  customerId?: string;
  subscription?: {
    id: string;
    status: SubscriptionStatus;
    productId: string;
    planName?: string;
    currentPeriodEnd?: string;
    cancelAtPeriodEnd: boolean;
  };
  
  // Usage
  usage?: {
    apiCalls: number;
    aiTokens: number;
    storageGb: number;
  };
  
  // Features
  tier: BillingTier;
  features: FeatureFlags;
}

// Admin types
export interface BillingMetrics {
  mrr: number; // Monthly recurring revenue in cents
  arr: number; // Annual recurring revenue in cents
  totalCustomers: number;
  activeSubscriptions: number;
  trialingSubscriptions: number;
  churnRate: number;
  averageRevenuePerUser: number;
  topProducts: Array<{
    productId: string;
    name: string;
    revenue: number;
    subscriptions: number;
  }>;
}

export interface UsageSummary {
  customerId: string;
  period: string;
  events: Array<{
    type: UsageEventType;
    units: number;
    cost?: number;
  }>;
  totalCost?: number;
}

// Sync status
export interface SyncStatus {
  lastSyncedAt?: string;
  status: "success" | "failed" | "in_progress";
  error?: string;
  itemsSynced?: number;
  itemsFailed?: number;
}