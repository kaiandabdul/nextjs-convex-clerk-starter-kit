/**
 * Administrative operations for billing management
 * Includes manual subscription management, usage adjustments, and reporting
 */

import { v } from "convex/values";
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { BillingError } from "./types";
import { polarApi } from "./lib/polar";

// ====================================
// ROLE-BASED ACCESS CONTROL
// ====================================

async function isAdmin(ctx: any): Promise<boolean> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return false;

  const user = await ctx.db
    .query("users")
    .withIndex("byExternalId", (q: any) => q.eq("externalId", identity.subject))
    .first();

  if (!user) return false;

  // Check if user has admin role (you can customize this logic)
  // For now, check if email ends with your domain or is in admin list
  const adminEmails = [
    "admin@example.com",
    // Add your admin emails here
  ];

  const isAdminEmail = adminEmails.includes(user.email) || 
                       user.email.endsWith("@yourdomain.com");
  
  // You could also check a role field in the user document
  // return user.role === "admin";
  
  return isAdminEmail;
}

function requireAdmin(handler: any) {
  return async (ctx: any, args: any) => {
    if (!(await isAdmin(ctx))) {
      throw new Error("Admin access required");
    }
    return handler(ctx, args);
  };
}

// ====================================
// SUBSCRIPTION MANAGEMENT
// ====================================

// Grant subscription to a user
export const grantSubscription = mutation({
  args: {
    userId: v.id("users"),
    productSlug: v.string(),
    planInterval: v.union(v.literal("monthly"), v.literal("yearly")),
    endDate: v.optional(v.string()),
    reason: v.string(),
  },
  handler: requireAdmin(async (ctx: any, args: any) => {
    // Get user
    const user = await ctx.db.get(args.userId);
    if (!user) {
      throw new Error("User not found");
    }

    // Get or create customer
    let customer = await ctx.db
      .query("customers")
      .withIndex("byUserId", (q: any) => q.eq("userId", args.userId))
      .first();

    if (!customer) {
      // Create customer record
      const customerId = await ctx.db.insert("customers", {
        userId: args.userId,
        email: user.email,
        polarCustomerId: `manual_${Date.now()}`, // Temporary ID
        createdAt: new Date().toISOString(),
        metadata: {
          grantedManually: true,
          reason: args.reason,
        },
      });
      customer = await ctx.db.get(customerId);
    }

    // Find product and plan
    const product = await ctx.db
      .query("products")
      .withIndex("bySlug", (q: any) => q.eq("slug", args.productSlug))
      .first();

    if (!product) {
      throw new Error(`Product ${args.productSlug} not found`);
    }

    const plan = await ctx.db
      .query("plans")
      .withIndex("byProductId", (q: any) => q.eq("productId", product._id))
      .filter((q: any) => q.eq(q.field("interval"), args.planInterval))
      .first();

    if (!plan) {
      throw new Error(`Plan not found for ${args.productSlug} ${args.planInterval}`);
    }

    // Create subscription
    const subscriptionId = await ctx.db.insert("subscriptions", {
      customerId: customer!._id,
      userId: args.userId,
      polarSubscriptionId: `manual_${Date.now()}`,
      polarProductId: product.polarProductId || product._id,
      planId: plan._id,
      status: "active",
      currentPeriodStart: new Date().toISOString(),
      currentPeriodEnd: args.endDate || 
        new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      cancelAtPeriodEnd: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: {
        grantedManually: true,
        grantedBy: (await ctx.auth.getUserIdentity())?.subject,
        reason: args.reason,
      },
    });

    // Log audit event
    await ctx.db.insert("auditLogs", {
      userId: args.userId,
      action: "subscription.granted",
      resourceType: "subscription",
      resourceId: subscriptionId,
      metadata: {
        product: args.productSlug,
        plan: args.planInterval,
        reason: args.reason,
      },
      createdAt: new Date().toISOString(),
    });

    return { subscriptionId, status: "granted" };
  }),
});

// Revoke subscription
export const revokeSubscription = mutation({
  args: {
    subscriptionId: v.id("subscriptions"),
    reason: v.string(),
    immediate: v.optional(v.boolean()),
  },
  handler: requireAdmin(async (ctx: any, args: any) => {
    const subscription = await ctx.db.get(args.subscriptionId);
    if (!subscription) {
      throw new Error("Subscription not found");
    }

    const updates: Partial<Doc<"subscriptions">> = {
      updatedAt: new Date().toISOString(),
    };

    if (args.immediate) {
      updates.status = "revoked";
      updates.endedAt = new Date().toISOString();
    } else {
      updates.cancelAtPeriodEnd = true;
      updates.canceledAt = new Date().toISOString();
    }

    updates.metadata = {
      ...subscription.metadata,
      revokedManually: true,
      revokedBy: (await ctx.auth.getUserIdentity())?.subject,
      revokedReason: args.reason,
    };

    await ctx.db.patch(args.subscriptionId, updates);

    // Log audit event
    await ctx.db.insert("auditLogs", {
      userId: subscription.userId,
      action: args.immediate ? "subscription.revoked" : "subscription.scheduled_cancel",
      resourceType: "subscription",
      resourceId: args.subscriptionId,
      metadata: {
        reason: args.reason,
        immediate: args.immediate,
      },
      createdAt: new Date().toISOString(),
    });

    return { status: args.immediate ? "revoked" : "scheduled_for_cancellation" };
  }),
});

// ====================================
// USAGE MANAGEMENT
// ====================================

// Adjust usage records
export const adjustUsage = mutation({
  args: {
    userId: v.id("users"),
    eventType: v.string(),
    adjustment: v.number(),
    reason: v.string(),
  },
  handler: requireAdmin(async (ctx: any, args: any) => {
    // Get customer
    const customer = await ctx.db
      .query("customers")
      .withIndex("byUserId", (q: any) => q.eq("userId", args.userId))
      .first();

    if (!customer) {
      throw new Error("Customer not found");
    }

    // Create adjustment event
    const eventId = await ctx.db.insert("usageEvents", {
      userId: args.userId,
      customerId: customer._id,
      polarCustomerId: customer.polarCustomerId,
      eventType: args.eventType,
      eventName: `adjustment_${args.eventType}`,
      units: args.adjustment,
      metadata: {
        isAdjustment: true,
        adjustedBy: (await ctx.auth.getUserIdentity())?.subject,
        reason: args.reason,
      },
      createdAt: new Date().toISOString(),
      processed: false,
    });

    // Update meter if exists
    const periodKey = new Date().toISOString().slice(0, 7);
    const meter = await ctx.db
      .query("meters")
      .withIndex("byCustomerIdAndPeriod", (q: any) =>
        q.eq("customerId", customer._id).eq("periodKey", periodKey)
      )
      .filter((q: any) => q.eq(q.field("meterName"), args.eventType))
      .first();

    if (meter) {
      await ctx.db.patch(meter._id, {
        consumedUnits: Math.max(0, meter.consumedUnits + args.adjustment),
        balance: Math.max(0, meter.balance + args.adjustment),
        lastSyncedAt: new Date().toISOString(),
      });
    }

    // Log audit event
    await ctx.db.insert("auditLogs", {
      userId: args.userId,
      action: "usage.adjusted",
      resourceType: "usage",
      resourceId: eventId,
      metadata: {
        eventType: args.eventType,
        adjustment: args.adjustment,
        reason: args.reason,
      },
      createdAt: new Date().toISOString(),
    });

    return { eventId, adjusted: args.adjustment };
  }),
});

// ====================================
// BILLING STATISTICS
// ====================================

// Get system-wide billing stats
export const getBillingStats = query({
  args: {
    startDate: v.optional(v.string()),
    endDate: v.optional(v.string()),
  },
  handler: requireAdmin(async (ctx: any, args: any) => {
    const startDate = args.startDate || 
      new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const endDate = args.endDate || new Date().toISOString();

    // Get metrics from billing module
    const metrics = await ctx.runQuery(internal.billing.getBillingMetrics, {});

    // Get recent activity
    const recentSubscriptions = await ctx.db
      .query("subscriptions")
      .filter((q: any) => q.gte(q.field("createdAt"), startDate))
      .collect();

    const recentInvoices = await ctx.db
      .query("invoices")
      .filter((q: any) => q.gte(q.field("createdAt"), startDate))
      .collect();

    // Calculate revenue for period
    let periodRevenue = 0;
    for (const invoice of recentInvoices) {
      if (invoice.status === "paid" && invoice.amountPaidCents) {
        periodRevenue += invoice.amountPaidCents;
      }
    }

    // Get failed payments
    const failedPayments = await ctx.db
      .query("charges")
      .withIndex("byStatus", (q: any) => q.eq("status", "failed"))
      .filter((q: any) => q.gte(q.field("createdAt"), startDate))
      .collect();

    return {
      ...metrics,
      period: {
        startDate,
        endDate,
        newSubscriptions: recentSubscriptions.length,
        totalInvoices: recentInvoices.length,
        revenue: periodRevenue,
        failedPayments: failedPayments.length,
      },
    };
  }),
});

// ====================================
// WEBHOOK MANAGEMENT
// ====================================

// Get failed webhooks
export const getFailedWebhooks = query({
  args: {
    limit: v.optional(v.number()),
    source: v.optional(v.union(v.literal("polar"), v.literal("clerk"))),
  },
  handler: requireAdmin(async (ctx: any, args: any) => {
    const limit = args.limit || 50;
    
    let query = ctx.db
      .query("webhookEvents")
      .withIndex("byProcessingResult", (q: any) => q.eq("processingResult", "error"));

    if (args.source) {
      query = query.filter((q: any) => q.eq(q.field("source"), args.source));
    }

    const events = await query.take(limit);
    
    return events.sort((a: any, b: any) => 
      b.receivedAt.localeCompare(a.receivedAt)
    );
  }),
});

// Retry failed webhook
export const retryWebhook = action({
  args: {
    webhookEventId: v.id("webhookEvents"),
  },
  handler: requireAdmin(async (ctx: any, args: any) => {
    const event = await ctx.runQuery(
      internal.adminTools.getWebhookEvent,
      { eventId: args.webhookEventId }
    );

    if (!event) {
      throw new Error("Webhook event not found");
    }

    // Reset processing status
    await ctx.runMutation(internal.adminTools.resetWebhookEvent, {
      eventId: args.webhookEventId,
    });

    // Re-process based on source
    if (event.source === "polar") {
      // Trigger Polar webhook processing
      // This would normally call the webhook handler
      // For now, we'll just mark it for retry
      await ctx.runMutation(internal.adminTools.markWebhookForRetry, {
        eventId: args.webhookEventId,
      });
    } else if (event.source === "clerk") {
      // Trigger Clerk webhook processing
      await ctx.runMutation(internal.adminTools.markWebhookForRetry, {
        eventId: args.webhookEventId,
      });
    }

    return { status: "retry_scheduled" };
  }),
});

// ====================================
// DATA EXPORT
// ====================================

// Export billing data
export const exportBillingData = action({
  args: {
    dataType: v.union(
      v.literal("subscriptions"),
      v.literal("invoices"),
      v.literal("usage"),
      v.literal("customers")
    ),
    startDate: v.optional(v.string()),
    endDate: v.optional(v.string()),
    format: v.optional(v.union(v.literal("json"), v.literal("csv"))),
  },
  handler: requireAdmin(async (ctx: any, args: any) => {
    const startDate = args.startDate || 
      new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const endDate = args.endDate || new Date().toISOString();
    const format = args.format || "json";

    let data: any[] = [];

    switch (args.dataType) {
      case "subscriptions":
        data = await ctx.runQuery(internal.adminTools.exportSubscriptions, {
          startDate,
          endDate,
        });
        break;
      
      case "invoices":
        data = await ctx.runQuery(internal.adminTools.exportInvoices, {
          startDate,
          endDate,
        });
        break;
      
      case "usage":
        data = await ctx.runQuery(internal.adminTools.exportUsage, {
          startDate,
          endDate,
        });
        break;
      
      case "customers":
        data = await ctx.runQuery(internal.adminTools.exportCustomers, {
          startDate,
          endDate,
        });
        break;
    }

    // Convert to CSV if requested
    if (format === "csv" && data.length > 0) {
      const headers = Object.keys(data[0]).join(",");
      const rows = data.map(item => 
        Object.values(item).map(v => 
          typeof v === "string" ? `"${v}"` : v
        ).join(",")
      );
      const csv = [headers, ...rows].join("\n");
      
      return {
        format: "csv",
        data: csv,
        records: data.length,
      };
    }

    return {
      format: "json",
      data,
      records: data.length,
    };
  }),
});

// ====================================
// CUSTOMER MANAGEMENT
// ====================================

// Search customers
export const searchCustomers = query({
  args: {
    query: v.string(),
    limit: v.optional(v.number()),
  },
  handler: requireAdmin(async (ctx: any, args: any) => {
    const limit = args.limit || 20;
    const searchTerm = args.query.toLowerCase();

    // Search by email
    const customers = await ctx.db
      .query("customers")
      .collect();

    const filtered = customers.filter((c: any) => 
      c.email.toLowerCase().includes(searchTerm) ||
      c.polarCustomerId.toLowerCase().includes(searchTerm) ||
      c.externalId?.toLowerCase().includes(searchTerm)
    );

    // Get user details for each customer
    const results = [];
    for (const customer of filtered.slice(0, limit)) {
      const user = customer.userId 
        ? await ctx.db.get(customer.userId)
        : null;
      
      const subscription = await ctx.db
        .query("subscriptions")
        .withIndex("byCustomerId", (q: any) => q.eq("customerId", customer._id))
        .filter((q: any) => q.eq(q.field("status"), "active"))
        .first();

      results.push({
        customer,
        user,
        subscription,
      });
    }

    return results;
  }),
});

// ====================================
// INTERNAL QUERIES AND MUTATIONS
// ====================================

export const getWebhookEvent = internalQuery({
  args: { eventId: v.id("webhookEvents") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.eventId);
  },
});

export const resetWebhookEvent = internalMutation({
  args: { eventId: v.id("webhookEvents") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.eventId, {
      processingResult: undefined,
      processedAt: undefined,
      error: undefined,
      attempts: 0,
    });
  },
});

export const markWebhookForRetry = internalMutation({
  args: { eventId: v.id("webhookEvents") },
  handler: async (ctx, args) => {
    const event = await ctx.db.get(args.eventId);
    if (event) {
      await ctx.db.patch(args.eventId, {
        attempts: event.attempts + 1,
        lastAttemptAt: new Date().toISOString(),
      });
    }
  },
});

export const exportSubscriptions = internalQuery({
  args: {
    startDate: v.string(),
    endDate: v.string(),
  },
  handler: async (ctx, args) => {
    const subscriptions = await ctx.db
      .query("subscriptions")
      .filter((q: any) => 
        q.and(
          q.gte(q.field("createdAt"), args.startDate),
          q.lte(q.field("createdAt"), args.endDate)
        )
      )
      .collect();

    const results = [];
    for (const sub of subscriptions) {
      const customer = await ctx.db.get(sub.customerId);
      const user = sub.userId ? await ctx.db.get(sub.userId) : null;
      const plan = sub.planId ? await ctx.db.get(sub.planId) : null;
      
      results.push({
        subscriptionId: sub._id,
        polarSubscriptionId: sub.polarSubscriptionId,
        status: sub.status,
        userEmail: user?.email,
        customerEmail: customer?.email,
        planName: plan?.name,
        planAmount: plan?.amountCents,
        createdAt: sub.createdAt,
        currentPeriodStart: sub.currentPeriodStart,
        currentPeriodEnd: sub.currentPeriodEnd,
        cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
      });
    }

    return results;
  },
});

export const exportInvoices = internalQuery({
  args: {
    startDate: v.string(),
    endDate: v.string(),
  },
  handler: async (ctx, args) => {
    const invoices = await ctx.db
      .query("invoices")
      .filter((q: any) => 
        q.and(
          q.gte(q.field("createdAt"), args.startDate),
          q.lte(q.field("createdAt"), args.endDate)
        )
      )
      .collect();

    const results = [];
    for (const invoice of invoices) {
      const user = invoice.userId ? await ctx.db.get(invoice.userId) : null;
      const customer = invoice.customerId ? await ctx.db.get(invoice.customerId) : null;
      
      results.push({
        invoiceId: invoice._id,
        polarInvoiceId: invoice.polarInvoiceId,
        invoiceNumber: invoice.invoiceNumber,
        userEmail: user?.email,
        customerEmail: customer?.email,
        amountDue: invoice.amountDueCents,
        amountPaid: invoice.amountPaidCents,
        currency: invoice.currency,
        status: invoice.status,
        createdAt: invoice.createdAt,
        paidAt: invoice.paidAt,
      });
    }

    return results;
  },
});

export const exportUsage = internalQuery({
  args: {
    startDate: v.string(),
    endDate: v.string(),
  },
  handler: async (ctx, args) => {
    const events = await ctx.db
      .query("usageEvents")
      .filter((q: any) => 
        q.and(
          q.gte(q.field("createdAt"), args.startDate),
          q.lte(q.field("createdAt"), args.endDate)
        )
      )
      .collect();

    const results = [];
    for (const event of events) {
      const user = event.userId ? await ctx.db.get(event.userId) : null;
      
      results.push({
        eventId: event._id,
        userEmail: user?.email,
        eventType: event.eventType,
        eventName: event.eventName,
        units: event.units,
        createdAt: event.createdAt,
        processed: event.processed,
        ingestedAt: event.ingestedAt,
      });
    }

    return results;
  },
});

export const exportCustomers = internalQuery({
  args: {
    startDate: v.string(),
    endDate: v.string(),
  },
  handler: async (ctx, args) => {
    const customers = await ctx.db
      .query("customers")
      .filter((q: any) => 
        q.and(
          q.gte(q.field("createdAt"), args.startDate),
          q.lte(q.field("createdAt"), args.endDate)
        )
      )
      .collect();

    const results = [];
    for (const customer of customers) {
      const user = customer.userId ? await ctx.db.get(customer.userId) : null;
      const activeSubscription = await ctx.db
        .query("subscriptions")
        .withIndex("byCustomerId", (q: any) => q.eq("customerId", customer._id))
        .filter((q: any) => q.eq(q.field("status"), "active"))
        .first();
      
      results.push({
        customerId: customer._id,
        polarCustomerId: customer.polarCustomerId,
        email: customer.email,
        userName: user?.name,
        hasActiveSubscription: !!activeSubscription,
        createdAt: customer.createdAt,
        lastSyncedAt: customer.lastSyncedAt,
      });
    }

    return results;
  },
});