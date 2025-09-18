import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // Core user table
  users: defineTable({
    name: v.string(),
    email: v.string(),
    externalId: v.string(), // Clerk user ID
    createdAt: v.string(),
    updatedAt: v.string(),
    polarCustomerId: v.optional(v.string()),
    defaultOrgId: v.optional(v.id("organizations")),
    metadata: v.optional(v.object({})),
  })
    .index("byExternalId", ["externalId"])
    .index("byPolarCustomerId", ["polarCustomerId"])
    .index("byEmail", ["email"]),

  // Organizations for team billing
  organizations: defineTable({
    name: v.string(),
    slug: v.optional(v.string()),
    ownerUserId: v.id("users"),
    createdAt: v.string(),
    updatedAt: v.string(),
    polarOrganizationId: v.optional(v.string()),
    settings: v.optional(v.object({
      billingContact: v.optional(v.string()),
      taxId: v.optional(v.string()),
      address: v.optional(v.object({
        line1: v.optional(v.string()),
        line2: v.optional(v.string()),
        city: v.optional(v.string()),
        state: v.optional(v.string()),
        postalCode: v.optional(v.string()),
        country: v.optional(v.string()),
      })),
    })),
  })
    .index("byOwnerUserId", ["ownerUserId"])
    .index("bySlug", ["slug"]),

  // Organization memberships
  memberships: defineTable({
    userId: v.id("users"),
    orgId: v.id("organizations"),
    role: v.union(
      v.literal("owner"),
      v.literal("admin"),
      v.literal("member")
    ),
    joinedAt: v.string(),
  })
    .index("byUserId", ["userId"])
    .index("byOrgId", ["orgId"])
    .index("byUserIdAndOrgId", ["userId", "orgId"]),

  // Products (local representation)
  products: defineTable({
    slug: v.string(),
    name: v.string(),
    description: v.optional(v.string()),
    polarProductId: v.optional(v.string()),
    visible: v.boolean(),
    features: v.optional(v.array(v.string())),
    metadata: v.optional(v.object({})),
    createdAt: v.string(),
    updatedAt: v.string(),
  })
    .index("bySlug", ["slug"])
    .index("byPolarProductId", ["polarProductId"])
    .index("byVisible", ["visible"]),

  // Plans/Pricing
  plans: defineTable({
    productId: v.id("products"),
    slug: v.optional(v.string()),
    name: v.string(),
    polarPriceId: v.optional(v.string()),
    interval: v.union(
      v.literal("monthly"),
      v.literal("yearly"),
      v.literal("one_time")
    ),
    amountCents: v.number(),
    currency: v.string(),
    trialDays: v.optional(v.number()),
    active: v.boolean(),
    metadata: v.optional(v.object({})),
  })
    .index("byProductId", ["productId"])
    .index("byPolarPriceId", ["polarPriceId"])
    .index("bySlug", ["slug"])
    .index("byActive", ["active"]),

  // Customers (Polar customer mapping)
  customers: defineTable({
    userId: v.optional(v.id("users")),
    orgId: v.optional(v.id("organizations")),
    email: v.string(),
    polarCustomerId: v.string(), // Required Polar customer ID
    externalId: v.optional(v.string()),
    createdAt: v.string(),
    lastSyncedAt: v.optional(v.string()),
    metadata: v.optional(v.object({})),
  })
    .index("byUserId", ["userId"])
    .index("byOrgId", ["orgId"])
    .index("byPolarCustomerId", ["polarCustomerId"])
    .index("byExternalId", ["externalId"])
    .index("byEmail", ["email"]),

  // Subscriptions
  subscriptions: defineTable({
    customerId: v.id("customers"),
    userId: v.optional(v.id("users")),
    orgId: v.optional(v.id("organizations")),
    polarSubscriptionId: v.string(),
    polarProductId: v.string(),
    planId: v.optional(v.id("plans")),
    status: v.union(
      v.literal("incomplete"),
      v.literal("incomplete_expired"),
      v.literal("trialing"),
      v.literal("active"),
      v.literal("past_due"),
      v.literal("canceled"),
      v.literal("unpaid"),
      v.literal("revoked")
    ),
    currentPeriodStart: v.optional(v.string()),
    currentPeriodEnd: v.optional(v.string()),
    cancelAtPeriodEnd: v.boolean(),
    canceledAt: v.optional(v.string()),
    endedAt: v.optional(v.string()),
    trialStart: v.optional(v.string()),
    trialEnd: v.optional(v.string()),
    metadata: v.optional(v.object({})),
    createdAt: v.string(),
    updatedAt: v.string(),
    lastSyncedAt: v.optional(v.string()),
  })
    .index("byCustomerId", ["customerId"])
    .index("byUserId", ["userId"])
    .index("byOrgId", ["orgId"])
    .index("byPolarSubscriptionId", ["polarSubscriptionId"])
    .index("byStatus", ["status"])
    .index("byUserIdAndStatus", ["userId", "status"]),

  // Checkout Sessions
  checkoutSessions: defineTable({
    userId: v.optional(v.id("users")),
    orgId: v.optional(v.id("organizations")),
    polarCheckoutId: v.string(),
    productIds: v.array(v.string()),
    status: v.union(
      v.literal("pending"),
      v.literal("completed"),
      v.literal("expired"),
      v.literal("canceled")
    ),
    successUrl: v.optional(v.string()),
    cancelUrl: v.optional(v.string()),
    clientSecret: v.optional(v.string()),
    expiresAt: v.string(),
    completedAt: v.optional(v.string()),
    metadata: v.optional(v.object({})),
    createdAt: v.string(),
  })
    .index("byUserId", ["userId"])
    .index("byOrgId", ["orgId"])
    .index("byPolarCheckoutId", ["polarCheckoutId"])
    .index("byStatus", ["status"])
    .index("byClientSecret", ["clientSecret"]),

  // Orders (one-time purchases)
  orders: defineTable({
    userId: v.optional(v.id("users")),
    orgId: v.optional(v.id("organizations")),
    customerId: v.optional(v.id("customers")),
    polarOrderId: v.string(),
    totalCents: v.number(),
    currency: v.string(),
    status: v.string(),
    metadata: v.optional(v.object({})),
    createdAt: v.string(),
    updatedAt: v.string(),
  })
    .index("byUserId", ["userId"])
    .index("byOrgId", ["orgId"])
    .index("byPolarOrderId", ["polarOrderId"])
    .index("byCustomerId", ["customerId"]),

  // Invoices
  invoices: defineTable({
    userId: v.optional(v.id("users")),
    orgId: v.optional(v.id("organizations")),
    customerId: v.optional(v.id("customers")),
    orderId: v.optional(v.id("orders")),
    subscriptionId: v.optional(v.id("subscriptions")),
    polarInvoiceId: v.string(),
    invoiceNumber: v.optional(v.string()),
    amountDueCents: v.number(),
    amountPaidCents: v.optional(v.number()),
    currency: v.string(),
    status: v.string(),
    dueDate: v.optional(v.string()),
    paidAt: v.optional(v.string()),
    pdfUrl: v.optional(v.string()),
    hostedUrl: v.optional(v.string()),
    periodStart: v.optional(v.string()),
    periodEnd: v.optional(v.string()),
    metadata: v.optional(v.object({})),
    createdAt: v.string(),
  })
    .index("byUserId", ["userId"])
    .index("byOrgId", ["orgId"])
    .index("byCustomerId", ["customerId"])
    .index("byPolarInvoiceId", ["polarInvoiceId"])
    .index("bySubscriptionId", ["subscriptionId"])
    .index("byStatus", ["status"]),

  // Payment Methods (safe metadata only)
  paymentMethods: defineTable({
    userId: v.id("users"),
    customerId: v.optional(v.id("customers")),
    type: v.union(
      v.literal("card"),
      v.literal("bank_transfer"),
      v.literal("paypal")
    ),
    brand: v.optional(v.string()),
    last4: v.optional(v.string()),
    expMonth: v.optional(v.number()),
    expYear: v.optional(v.number()),
    isDefault: v.boolean(),
    polarPaymentMethodId: v.string(),
    createdAt: v.string(),
  })
    .index("byUserId", ["userId"])
    .index("byCustomerId", ["customerId"])
    .index("byPolarPaymentMethodId", ["polarPaymentMethodId"]),

  // Charges/Payments
  charges: defineTable({
    orderId: v.optional(v.id("orders")),
    subscriptionId: v.optional(v.id("subscriptions")),
    invoiceId: v.optional(v.id("invoices")),
    userId: v.optional(v.id("users")),
    customerId: v.optional(v.id("customers")),
    amountCents: v.number(),
    currency: v.string(),
    status: v.string(),
    polarChargeId: v.string(),
    failureReason: v.optional(v.string()),
    createdAt: v.string(),
    settledAt: v.optional(v.string()),
  })
    .index("byUserId", ["userId"])
    .index("byCustomerId", ["customerId"])
    .index("byPolarChargeId", ["polarChargeId"])
    .index("byInvoiceId", ["invoiceId"])
    .index("byStatus", ["status"]),

  // Usage Events
  usageEvents: defineTable({
    userId: v.optional(v.id("users")),
    orgId: v.optional(v.id("organizations")),
    customerId: v.optional(v.id("customers")),
    subscriptionId: v.optional(v.id("subscriptions")),
    polarCustomerId: v.optional(v.string()),
    eventType: v.string(), // e.g., "api_calls", "ai_tokens", "storage_gb"
    eventName: v.string(),
    units: v.number(),
    metadata: v.optional(v.object({})),
    createdAt: v.string(),
    ingestedAt: v.optional(v.string()),
    polarEventId: v.optional(v.string()),
    processed: v.boolean(),
    error: v.optional(v.string()),
  })
    .index("byUserId", ["userId"])
    .index("byOrgId", ["orgId"])
    .index("byCustomerId", ["customerId"])
    .index("byProcessed", ["processed"])
    .index("byCreatedAt", ["createdAt"])
    .index("byEventType", ["eventType"]),

  // Usage Meters (cached aggregates)
  meters: defineTable({
    customerId: v.id("customers"),
    subscriptionId: v.optional(v.id("subscriptions")),
    meterName: v.string(),
    periodKey: v.string(), // e.g., "2025-01"
    consumedUnits: v.number(),
    creditedUnits: v.optional(v.number()),
    balance: v.number(),
    lastSyncedAt: v.string(),
  })
    .index("byCustomerId", ["customerId"])
    .index("bySubscriptionId", ["subscriptionId"])
    .index("byPeriodKey", ["periodKey"])
    .index("byCustomerIdAndPeriod", ["customerId", "periodKey"]),

  // Webhook Events (for idempotency and debugging)
  webhookEvents: defineTable({
    eventId: v.string(), // Polar event ID
    eventType: v.string(),
    source: v.union(v.literal("polar"), v.literal("clerk")),
    payload: v.any(), // Raw JSON payload
    receivedAt: v.string(),
    processedAt: v.optional(v.string()),
    processingResult: v.optional(
      v.union(v.literal("success"), v.literal("error"), v.literal("skipped"))
    ),
    attempts: v.number(),
    lastAttemptAt: v.optional(v.string()),
    error: v.optional(v.string()),
  })
    .index("byEventId", ["eventId"])
    .index("byEventType", ["eventType"])
    .index("bySource", ["source"])
    .index("byProcessingResult", ["processingResult"])
    .index("byReceivedAt", ["receivedAt"]),

  // Discounts/Coupons
  discounts: defineTable({
    code: v.string(),
    polarDiscountId: v.optional(v.string()),
    type: v.union(v.literal("percentage"), v.literal("fixed")),
    value: v.number(), // percentage (0-100) or cents
    currency: v.optional(v.string()), // for fixed discounts
    validFrom: v.optional(v.string()),
    validUntil: v.optional(v.string()),
    maxRedemptions: v.optional(v.number()),
    currentRedemptions: v.number(),
    metadata: v.optional(v.object({})),
    active: v.boolean(),
    createdAt: v.string(),
  })
    .index("byCode", ["code"])
    .index("byPolarDiscountId", ["polarDiscountId"])
    .index("byActive", ["active"]),

  // Coupon Redemptions
  couponRedemptions: defineTable({
    userId: v.id("users"),
    discountId: v.id("discounts"),
    orderId: v.optional(v.id("orders")),
    subscriptionId: v.optional(v.id("subscriptions")),
    amountSavedCents: v.number(),
    createdAt: v.string(),
  })
    .index("byUserId", ["userId"])
    .index("byDiscountId", ["discountId"])
    .index("byOrderId", ["orderId"])
    .index("bySubscriptionId", ["subscriptionId"]),

  // Refunds
  refunds: defineTable({
    chargeId: v.id("charges"),
    orderId: v.optional(v.id("orders")),
    userId: v.optional(v.id("users")),
    polarRefundId: v.string(),
    amountCents: v.number(),
    currency: v.string(),
    reason: v.optional(v.string()),
    status: v.string(),
    metadata: v.optional(v.object({})),
    createdAt: v.string(),
    completedAt: v.optional(v.string()),
  })
    .index("byChargeId", ["chargeId"])
    .index("byUserId", ["userId"])
    .index("byPolarRefundId", ["polarRefundId"])
    .index("byStatus", ["status"]),

  // Audit Logs
  auditLogs: defineTable({
    userId: v.optional(v.id("users")),
    action: v.string(),
    resourceType: v.string(),
    resourceId: v.optional(v.string()),
    metadata: v.optional(v.object({})),
    ipAddress: v.optional(v.string()),
    userAgent: v.optional(v.string()),
    createdAt: v.string(),
  })
    .index("byUserId", ["userId"])
    .index("byAction", ["action"])
    .index("byResourceType", ["resourceType"])
    .index("byCreatedAt", ["createdAt"]),

  // Billing Settings (system configuration)
  billingSettings: defineTable({
    key: v.string(),
    value: v.any(),
    description: v.optional(v.string()),
    updatedAt: v.string(),
    updatedBy: v.optional(v.id("users")),
  }).index("byKey", ["key"]),

  // System logs for monitoring
  logs: defineTable({
    level: v.string(),
    message: v.string(),
    context: v.optional(v.string()),
    metadata: v.optional(v.any()),
    error: v.optional(v.object({
      message: v.string(),
      stack: v.optional(v.string()),
      code: v.optional(v.string()),
    })),
    timestamp: v.string(),
  })
    .index("byLevel", ["level"])
    .index("byTimestamp", ["timestamp"]),

  // Metrics tracking
  metrics: defineTable({
    name: v.string(),
    value: v.number(),
    unit: v.optional(v.string()),
    tags: v.optional(v.any()),
    duration: v.optional(v.number()),
    timestamp: v.string(),
  })
    .index("byName", ["name"])
    .index("byTimestamp", ["timestamp"]),

  // Alerts for monitoring
  alerts: defineTable({
    type: v.string(),
    severity: v.string(),
    message: v.string(),
    metadata: v.optional(v.any()),
    status: v.string(),
    resolvedAt: v.optional(v.string()),
    createdAt: v.string(),
  })
    .index("byType", ["type"])
    .index("byStatus", ["status"])
    .index("byCreatedAt", ["createdAt"]),

  // Usage insights aggregations
  usageInsights: defineTable({
    userId: v.optional(v.id("users")),
    orgId: v.optional(v.id("organizations")),
    period: v.string(),
    metrics: v.any(),
    insights: v.array(v.string()),
    createdAt: v.string(),
  })
    .index("byUserId", ["userId"])
    .index("byOrgId", ["orgId"])
    .index("byPeriod", ["period"]),

  // Team members (simplified version of memberships)
  teamMembers: defineTable({
    userId: v.id("users"),
    organizationId: v.id("organizations"),
    role: v.string(),
    invitedBy: v.optional(v.id("users")),
    joinedAt: v.string(),
  })
    .index("byUserId", ["userId"])
    .index("byOrganizationId", ["organizationId"]),

  // Projects for organizations/users
  projects: defineTable({
    name: v.string(),
    slug: v.string(),
    userId: v.optional(v.id("users")),
    organizationId: v.optional(v.id("organizations")),
    metadata: v.optional(v.any()),
    createdAt: v.string(),
    updatedAt: v.string(),
  })
    .index("byUserId", ["userId"])
    .index("byOrganizationId", ["organizationId"])
    .index("bySlug", ["slug"]),

  // Files for storage tracking
  files: defineTable({
    name: v.string(),
    sizeBytes: v.number(),
    mimeType: v.optional(v.string()),
    userId: v.optional(v.id("users")),
    organizationId: v.optional(v.id("organizations")),
    projectId: v.optional(v.id("projects")),
    uploadedAt: v.string(),
  })
    .index("byUserId", ["userId"])
    .index("byOrganizationId", ["organizationId"])
    .index("byProjectId", ["projectId"]),

  // Counters for atomic increments
  counters: defineTable({
    key: v.string(),
    value: v.number(),
    updatedAt: v.string(),
  }).index("byKey", ["key"]),

  // API metrics for rate limiting
  apiMetrics: defineTable({
    hour: v.string(), // YYYY-MM-DD-HH format
    userId: v.optional(v.id("users")),
    endpoint: v.optional(v.string()),
    callCount: v.number(),
    errorCount: v.number(),
    avgDuration: v.number(),
    maxDuration: v.number(),
  })
    .index("byHour", ["hour"])
    .index("byUserId", ["userId"]),
});
