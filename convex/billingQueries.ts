/**
 * Billing queries for the frontend
 */

import { v } from "convex/values";
import { query } from "./_generated/server";
import { internal } from "./_generated/api";

// Get current user's subscriptions
export const getCurrentUserSubscriptions = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];

    const user = await ctx.db
      .query("users")
      .withIndex("byExternalId", (q) => q.eq("externalId", identity.subject))
      .unique();

    if (!user) return [];

    const customer = await ctx.db
      .query("customers")
      .withIndex("byUserId", (q) => q.eq("userId", user._id))
      .first();

    if (!customer) return [];

    return await ctx.db
      .query("subscriptions")
      .withIndex("byCustomerId", (q) => q.eq("customerId", customer._id))
      .collect();
  },
});

// Get current user's invoices
export const getCurrentUserInvoices = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];

    const user = await ctx.db
      .query("users")
      .withIndex("byExternalId", (q) => q.eq("externalId", identity.subject))
      .unique();

    if (!user) return [];

    const customer = await ctx.db
      .query("customers")
      .withIndex("byUserId", (q) => q.eq("userId", user._id))
      .first();

    if (!customer) return [];

    return await ctx.db
      .query("invoices")
      .withIndex("byCustomerId", (q) => q.eq("customerId", customer._id))
      .order("desc")
      .take(20);
  },
});

// Get billing statistics
export const getBillingStats = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;

    // Calculate total revenue (simplified)
    const invoices = await ctx.db
      .query("invoices")
      .filter((q) => q.eq(q.field("status"), "paid"))
      .collect();

    const totalRevenue = invoices.reduce(
      (sum, invoice) => sum + (invoice.amountDueCents || 0),
      0
    ) / 100;

    // Calculate MRR
    const activeSubscriptions = await ctx.db
      .query("subscriptions")
      .withIndex("byStatus", (q) => q.eq("status", "active"))
      .collect();

    let mrr = 0;
    for (const sub of activeSubscriptions) {
      const product = await ctx.db
        .query("products")
        .withIndex("byPolarProductId", (q) => 
          q.eq("polarProductId", sub.polarProductId)
        )
        .first();
      
      // Get plan for pricing
      const plan = await ctx.db
        .query("plans")
        .withIndex("byProductId", (q: any) => q.eq("productId", product?._id))
        .filter((q: any) => q.eq(q.field("active"), true))
        .first();
      
      if (plan) {
        const monthlyAmount = plan.interval === "yearly"
          ? plan.amountCents / 12
          : plan.amountCents;
        mrr += monthlyAmount;
      }
    }

    // Calculate churn rate (simplified)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const recentCancellations = await ctx.db
      .query("subscriptions")
      .withIndex("byStatus", (q) => q.eq("status", "canceled"))
      .filter((q) => 
        q.gte(q.field("canceledAt"), thirtyDaysAgo.toISOString())
      )
      .collect();

    const churnRate = activeSubscriptions.length > 0
      ? (recentCancellations.length / activeSubscriptions.length) * 100
      : 0;

    return {
      totalRevenue,
      mrr: mrr / 100,
      activeSubscriptions: activeSubscriptions.length,
      churnRate,
    };
  },
});