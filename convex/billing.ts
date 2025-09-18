import {
  internalMutation,
  internalQuery,
  query,
  action,
} from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { getCurrentUser } from "./users";
import { api, internal } from "./_generated/api";
import {
  BillingTier,
  type FeatureFlags,
  type BillingMetrics,
  type UsageSummary,
} from "./types";
import { polarApi } from "./lib/polar";

// ====================================
// PUBLIC QUERIES
// ====================================

// Get current user's billing plan with features
export const getCurrentPlan = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;

    // Get active subscription
    const subscription = await ctx.db
      .query("subscriptions")
      .withIndex("byUserIdAndStatus", (q) =>
        q.eq("userId", user._id).eq("status", "active")
      )
      .first();

    // Get plan details
    const plan =
      subscription?.planId ? await ctx.db.get(subscription.planId) : null;

    // Get product details
    const product = plan?.productId ? await ctx.db.get(plan.productId) : null;

    // Determine tier and features
    const tier = determineBillingTier(product?.slug);
    const features = getFeaturesByTier(tier, subscription);

    return {
      tier,
      subscription,
      plan,
      product,
      features,
      canUpgrade: tier !== BillingTier.PREMIUM_PLUS,
      canDowngrade: tier !== BillingTier.FREE,
    };
  },
});

// Get available upgrade options
export const getUpgradeOptions = query({
  args: {},
  handler: async (ctx) => {
    // Get current plan from subscription data
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    const user = await ctx.db
      .query("users")
      .withIndex("byExternalId", (q: any) =>
        q.eq("externalId", identity.subject)
      )
      .first();
    if (!user) throw new Error("User not found");
    const subscription = await ctx.db
      .query("subscriptions")
      .withIndex("byUserId", (q: any) => q.eq("userId", user._id))
      .filter((q: any) => q.eq(q.field("status"), "active"))
      .first();

    const currentPlan = subscription?.planId || null;
    if (!currentPlan) return [];

    // Get all visible products
    const products = await ctx.db
      .query("products")
      .withIndex("byVisible", (q) => q.eq("visible", true))
      .collect();

    // Get plans for products
    const upgradeOptions = [];
    for (const product of products) {
      const plans = await ctx.db
        .query("plans")
        .withIndex("byProductId", (q) => q.eq("productId", product._id))
        .filter((q) => q.eq(q.field("active"), true))
        .collect();

      for (const plan of plans) {
        const tier = determineBillingTier(product.slug);

        // Only show higher tiers
        // Compare plans (simplified logic)
        if (plan._id && (!currentPlan || plan._id !== currentPlan)) {
          upgradeOptions.push({
            product,
            plan,
            tier,
            features: getFeaturesByTier(tier, null),
            savings:
              plan.interval === "yearly" ?
                Math.round(
                  (plan.amountCents * 12 - plan.amountCents * 10) / 100
                )
              : 0,
          });
        }
      }
    }

    return upgradeOptions;
  },
});

// Get paginated billing history
export const getBillingHistory = query({
  args: {
    limit: v.optional(v.number()),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    if (!user) return { invoices: [], nextCursor: null };

    const limit = args.limit || 10;
    let query = ctx.db
      .query("invoices")
      .withIndex("byUserId", (q) => q.eq("userId", user._id));

    const invoices = await query.collect();

    // Sort by date descending
    invoices.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    // Apply cursor pagination
    let filteredInvoices = invoices;
    if (args.cursor) {
      const cursorIndex = invoices.findIndex((i) => i._id === args.cursor);
      if (cursorIndex !== -1) {
        filteredInvoices = invoices.slice(cursorIndex + 1);
      }
    }

    // Apply limit
    const paginatedInvoices = filteredInvoices.slice(0, limit);
    const nextCursor =
      paginatedInvoices.length === limit ?
        paginatedInvoices[paginatedInvoices.length - 1]._id
      : null;

    return {
      invoices: paginatedInvoices,
      nextCursor,
    };
  },
});

// Get usage summary for current period
export const getUsageSummary = query({
  args: {},
  handler: async (ctx): Promise<UsageSummary | null> => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;

    // Get customer
    const customer = await ctx.db
      .query("customers")
      .withIndex("byUserId", (q) => q.eq("userId", user._id))
      .first();

    if (!customer) return null;

    // Get current period usage from usage module
    const usage = await ctx.runQuery(api.usageTracking.getCurrentPeriodUsage, {});
    if (!usage) return null;

    // Calculate costs (if applicable)
    const events: any[] = [];
    const costs: any[] = [];
    let totalCost = 0;

    for (const [type, data] of Object.entries(usage.usage)) {
      const cost = calculateUsageCost(type, (data as any).units);
      costs.push({
        type,
        units: (data as any).units,
        cost,
      });
      totalCost += cost;
    }

    return {
      customerId: customer._id,
      period: usage.periodStart || new Date().toISOString().slice(0, 7),
      events,
      totalCost,
    };
  },
});

// Estimate next invoice amount
export const estimateNextInvoice: any = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;

    // Get active subscription
    const subscription = await ctx.db
      .query("subscriptions")
      .withIndex("byUserIdAndStatus", (q) =>
        q.eq("userId", user._id).eq("status", "active")
      )
      .first();

    if (!subscription) return null;

    // Get plan details
    const plan =
      subscription.planId ? await ctx.db.get(subscription.planId) : null;

    if (!plan) return null;

    // Get usage summary (simplified)
    const totalEvents = 0;
    const totalCost = 0;
    const usageSummary = { totalEvents, totalCost };

    return {
      subscriptionAmount: plan.amountCents,
      usageAmount: usageSummary?.totalCost || 0,
      totalAmount: plan.amountCents + (usageSummary?.totalCost || 0),
      currency: plan.currency,
      dueDate: subscription.currentPeriodEnd,
    };
  },
});

// ====================================
// ADMIN QUERIES
// ====================================

// Get billing metrics for admin dashboard
export const getBillingMetrics = internalQuery({
  args: {},
  handler: async (ctx): Promise<BillingMetrics> => {
    // Get all active subscriptions
    const activeSubscriptions = await ctx.db
      .query("subscriptions")
      .withIndex("byStatus", (q) => q.eq("status", "active"))
      .collect();

    const trialingSubscriptions = await ctx.db
      .query("subscriptions")
      .withIndex("byStatus", (q) => q.eq("status", "trialing"))
      .collect();

    // Calculate MRR and ARR
    let mrr = 0;
    const productRevenue: Record<
      string,
      { revenue: number; subscriptions: number }
    > = {};

    for (const sub of activeSubscriptions) {
      if (sub.planId) {
        const plan = await ctx.db.get(sub.planId);
        if (plan) {
          const monthlyAmount =
            plan.interval === "yearly" ?
              Math.round(plan.amountCents / 12)
            : plan.amountCents;

          mrr += monthlyAmount;

          const product =
            plan.productId ? await ctx.db.get(plan.productId) : null;
          if (product) {
            if (!productRevenue[product._id]) {
              productRevenue[product._id] = {
                revenue: 0,
                subscriptions: 0,
              };
            }
            productRevenue[product._id].revenue += monthlyAmount;
            productRevenue[product._id].subscriptions++;
          }
        }
      }
    }

    // Get total customers
    const totalCustomers = await ctx.db.query("customers").collect();

    // Calculate churn rate (simplified)
    const canceledLast30Days = await ctx.db
      .query("subscriptions")
      .withIndex("byStatus", (q) => q.eq("status", "canceled"))
      .collect()
      .then((subs) => {
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        return subs.filter(
          (s) => s.canceledAt && new Date(s.canceledAt) > thirtyDaysAgo
        ).length;
      });

    const churnRate =
      activeSubscriptions.length > 0 ?
        (canceledLast30Days / activeSubscriptions.length) * 100
      : 0;

    // Get top products
    const topProducts = [];
    for (const [productId, data] of Object.entries(productRevenue)) {
      const product = await ctx.db.get(productId as Id<"products">);
      if (product) {
        topProducts.push({
          productId,
          name: product.name,
          revenue: data.revenue,
          subscriptions: data.subscriptions,
        });
      }
    }
    topProducts.sort((a, b) => b.revenue - a.revenue);

    return {
      mrr,
      arr: mrr * 12,
      totalCustomers: totalCustomers.length,
      activeSubscriptions: activeSubscriptions.length,
      trialingSubscriptions: trialingSubscriptions.length,
      churnRate: Math.round(churnRate * 100) / 100,
      averageRevenuePerUser:
        activeSubscriptions.length > 0 ?
          Math.round(mrr / activeSubscriptions.length)
        : 0,
      topProducts: topProducts.slice(0, 5),
    };
  },
});

// ====================================
// ORIGINAL FUNCTIONS (maintained for compatibility)
// ====================================

// Public: list subscriptions for the current user
export const listMySubscriptions = query({
  args: {},
  handler: async (ctx): Promise<Doc<"subscriptions">[]> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    const user = await ctx.db
      .query("users")
      .withIndex("byExternalId", (q) => q.eq("externalId", identity.subject))
      .unique();
    if (!user) throw new Error("User not found");

    // Get customer first
    const customer = await ctx.db
      .query("customers")
      .withIndex("byUserId", (q) => q.eq("userId", user._id))
      .first();

    if (!customer) return [];

    return ctx.db
      .query("subscriptions")
      .withIndex("byCustomerId", (q) => q.eq("customerId", customer._id))
      .collect();
  },
});

// Public: list invoices for the current user
export const listMyInvoices = query({
  args: {},
  handler: async (ctx): Promise<Doc<"invoices">[]> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    const user = await ctx.db
      .query("users")
      .withIndex("byExternalId", (q) => q.eq("externalId", identity.subject))
      .unique();
    if (!user) throw new Error("User not found");
    return ctx.db
      .query("invoices")
      .withIndex("byUserId", (q) => q.eq("userId", user._id))
      .collect();
  },
});

// ====================================
// ACTIONS
// ====================================

// Generate customer portal URL
export const generateCustomerPortalUrl = action({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    const user = await ctx.runQuery(api.users.current, {});
    if (!user) throw new Error("User not found");
    if (!user) throw new Error("Not authenticated");

    const customer = await ctx.runQuery(api.customers.getCustomerByUserId, {
      userId: user._id,
    });

    if (!customer || !customer.polarCustomerId) {
      throw new Error("No customer found");
    }

    try {
      const result = await polarApi.getCustomerPortalUrl(
        customer.polarCustomerId
      );
      return result.url;
    } catch (error) {
      console.error("Failed to generate portal URL:", error);
      throw new Error("Failed to generate customer portal URL");
    }
  },
});

// ====================================
// HELPER FUNCTIONS
// ====================================

function determineBillingTier(productSlug?: string): BillingTier {
  if (!productSlug) return BillingTier.FREE;

  const slug = productSlug.toLowerCase();
  if (slug.includes("premium-plus") || slug.includes("premium_plus")) {
    return BillingTier.PREMIUM_PLUS;
  }
  if (slug.includes("premium") || slug.includes("pro")) {
    return BillingTier.PREMIUM;
  }
  return BillingTier.FREE;
}

function getFeaturesByTier(
  tier: BillingTier,
  subscription: Doc<"subscriptions"> | null
): FeatureFlags {
  const baseFeatures: FeatureFlags = {
    // Usage limits
    maxApiCalls:
      tier === BillingTier.FREE ? 1000
      : tier === BillingTier.PREMIUM ? 10000
      : undefined,
    maxAiTokens:
      tier === BillingTier.FREE ? 10000
      : tier === BillingTier.PREMIUM ? 100000
      : undefined,
    maxStorageGb:
      tier === BillingTier.FREE ? 1
      : tier === BillingTier.PREMIUM ? 10
      : 100,
    maxBandwidthGb:
      tier === BillingTier.FREE ? 5
      : tier === BillingTier.PREMIUM ? 50
      : undefined,
    maxTeamMembers:
      tier === BillingTier.FREE ? 1
      : tier === BillingTier.PREMIUM ? 5
      : undefined,

    // Features
    hasCustomDomain: tier !== BillingTier.FREE,
    hasAdvancedAnalytics: tier !== BillingTier.FREE,
    hasPrioritySupport: tier === BillingTier.PREMIUM_PLUS,
    hasWebhooks: tier !== BillingTier.FREE,
    hasApiAccess: tier !== BillingTier.FREE,
    hasSsoAccess: tier === BillingTier.PREMIUM_PLUS,
    hasAuditLogs: tier === BillingTier.PREMIUM_PLUS,
    hasCustomBranding: tier !== BillingTier.FREE,
    hasDataExport: true,

    // Billing
    canUpgrade: tier !== BillingTier.PREMIUM_PLUS,
    canDowngrade: tier !== BillingTier.FREE,
    isTrialing: subscription?.status === "trialing",
    daysLeftInTrial:
      subscription?.trialEnd ?
        Math.max(
          0,
          Math.ceil(
            (new Date(subscription.trialEnd).getTime() - Date.now()) /
              (1000 * 60 * 60 * 24)
          )
        )
      : undefined,
  };

  return baseFeatures;
}

function calculateUsageCost(eventType: string, units: number): number {
  // Define your pricing per unit (in cents)
  const pricing: Record<string, number> = {
    api_calls: 0.01, // $0.01 per API call
    ai_tokens: 0.001, // $0.001 per token
    storage_gb: 10, // $0.10 per GB
    bandwidth_gb: 5, // $0.05 per GB
  };

  const pricePerUnit = pricing[eventType] || 0;
  return Math.round(units * pricePerUnit);
}
