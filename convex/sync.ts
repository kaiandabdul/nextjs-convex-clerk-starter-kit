/**
 * Synchronization jobs for billing reconciliation
 * Handles periodic syncing with Polar and data cleanup
 */

import { v } from "convex/values";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { polarApi } from "./lib/polar";
import type { Doc } from "./_generated/dataModel";
import type { SyncStatus } from "./types";

// ====================================
// CIRCUIT BREAKER IMPLEMENTATION
// ====================================

interface CircuitBreakerState {
  isOpen: boolean;
  failures: number;
  lastFailure?: string;
  nextRetry?: string;
}

const circuitBreaker: CircuitBreakerState = {
  isOpen: false,
  failures: 0,
};

function checkCircuitBreaker(): boolean {
  if (circuitBreaker.isOpen && circuitBreaker.nextRetry) {
    if (new Date().toISOString() < circuitBreaker.nextRetry) {
      return false; // Circuit still open
    }
    // Try to close circuit
    circuitBreaker.isOpen = false;
    circuitBreaker.failures = 0;
  }
  return true; // Circuit closed, can proceed
}

function recordSuccess() {
  circuitBreaker.failures = 0;
  circuitBreaker.isOpen = false;
}

function recordFailure() {
  circuitBreaker.failures++;
  circuitBreaker.lastFailure = new Date().toISOString();
  
  // Open circuit after 3 failures
  if (circuitBreaker.failures >= 3) {
    circuitBreaker.isOpen = true;
    // Retry after 5 minutes
    const nextRetry = new Date();
    nextRetry.setMinutes(nextRetry.getMinutes() + 5);
    circuitBreaker.nextRetry = nextRetry.toISOString();
  }
}

// ====================================
// SUBSCRIPTION SYNCHRONIZATION
// ====================================

// Sync all subscriptions with Polar
export const syncAllSubscriptions = internalAction({
  args: {
    batchSize: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    if (!checkCircuitBreaker()) {
      console.log("Circuit breaker open, skipping sync");
      return {
        status: "skipped",
        reason: "Circuit breaker open",
        nextRetry: circuitBreaker.nextRetry,
      };
    }

    const batchSize = args.batchSize || 50;
    const startTime = Date.now();
    
    try {
      // Get all customers
      const customers = await ctx.runQuery(internal.sync.getAllCustomers, {
        limit: batchSize,
      });

      let synced = 0;
      let failed = 0;
      const errors: Array<{ customerId: string; error: string }> = [];

      for (const customer of customers) {
        if (!customer.polarCustomerId.startsWith("manual_")) {
          try {
            // Fetch subscriptions from Polar
            const polarSubscriptions = await polarApi.subscriptions.list({
              customer_id: customer.polarCustomerId,
              active: true,
            });

            for (const polarSub of polarSubscriptions.items) {
              await ctx.runMutation(internal.sync.syncSubscription, {
                customerId: customer._id,
                polarSubscription: {
                  id: polarSub.id,
                  status: polarSub.status,
                  product_id: polarSub.product_id,
                  customer_id: polarSub.customer_id,
                  current_period_start: polarSub.current_period_start,
                  current_period_end: polarSub.current_period_end,
                  cancel_at_period_end: polarSub.cancel_at_period_end,
                  canceled_at: polarSub.ended_at,
                  metadata: polarSub.metadata,
                },
              });
              synced++;
            }
          } catch (error) {
            failed++;
            errors.push({
              customerId: customer._id,
              error: error instanceof Error ? error.message : "Unknown error",
            });
            console.error(`Failed to sync subscriptions for customer ${customer._id}:`, error);
          }
        }
      }

      const duration = Date.now() - startTime;
      
      // Record sync status
      await ctx.runMutation(internal.sync.recordSyncStatus, {
        type: "subscriptions",
        status: failed === 0 ? "success" : "partial",
        synced,
        failed,
        duration,
        errors,
      });

      recordSuccess();
      
      return {
        status: "completed",
        synced,
        failed,
        duration,
        errors: errors.slice(0, 10), // Return first 10 errors
      };
    } catch (error) {
      recordFailure();
      console.error("Subscription sync failed:", error);
      
      await ctx.runMutation(internal.sync.recordSyncStatus, {
        type: "subscriptions",
        status: "failed",
        synced: 0,
        failed: 0,
        duration: Date.now() - startTime,
        errors: [{
          customerId: "system",
          error: error instanceof Error ? error.message : "Unknown error",
        }],
      });
      
      throw error;
    }
  },
});

// Sync pending invoices
export const syncPendingInvoices = internalAction({
  args: {},
  handler: async (ctx) => {
    if (!checkCircuitBreaker()) {
      return {
        status: "skipped",
        reason: "Circuit breaker open",
      };
    }

    const startTime = Date.now();
    
    try {
      // Get pending invoices
      const pendingInvoices = await ctx.runQuery(
        internal.sync.getPendingInvoices,
        {}
      );

      let updated = 0;
      let failed = 0;

      for (const invoice of pendingInvoices) {
        if (!invoice.polarInvoiceId.startsWith("manual_")) {
          try {
            // In Polar, you'd fetch the order/invoice status
            // For now, we'll use the order API as a proxy
            const order = await polarApi.orders.get(invoice.polarInvoiceId);
            
            if (order) {
              await ctx.runMutation(internal.sync.updateInvoiceStatus, {
                invoiceId: invoice._id,
                status: "paid", // Map from Polar status
                paidAt: new Date().toISOString(),
              });
              updated++;
            }
          } catch (error) {
            failed++;
            console.error(`Failed to sync invoice ${invoice._id}:`, error);
          }
        }
      }

      recordSuccess();
      
      return {
        status: "completed",
        updated,
        failed,
        duration: Date.now() - startTime,
      };
    } catch (error) {
      recordFailure();
      throw error;
    }
  },
});

// Reconcile billing data
export const reconcileBilling = internalAction({
  args: {
    checkType: v.optional(
      v.union(
        v.literal("subscriptions"),
        v.literal("customers"),
        v.literal("invoices")
      )
    ),
  },
  handler: async (ctx, args) => {
    const checkType = args.checkType || "subscriptions";
    const discrepancies: Array<{
      type: string;
      localId: string;
      polarId: string;
      issue: string;
      localData?: any;
      polarData?: any;
    }> = [];

    switch (checkType) {
      case "subscriptions": {
        // Get local subscriptions
        const localSubs = await ctx.runQuery(
          internal.sync.getActiveSubscriptions,
          {}
        );

        for (const sub of localSubs) {
          if (!sub.polarSubscriptionId.startsWith("manual_")) {
            try {
              const polarSub = await polarApi.subscriptions.get(
                sub.polarSubscriptionId
              );

              // Check for discrepancies
              if (polarSub.status !== sub.status) {
                discrepancies.push({
                  type: "status_mismatch",
                  localId: sub._id,
                  polarId: sub.polarSubscriptionId,
                  issue: `Status mismatch: local=${sub.status}, polar=${polarSub.status}`,
                  localData: { status: sub.status },
                  polarData: { status: polarSub.status },
                });
              }

              if (polarSub.cancel_at_period_end !== sub.cancelAtPeriodEnd) {
                discrepancies.push({
                  type: "cancellation_mismatch",
                  localId: sub._id,
                  polarId: sub.polarSubscriptionId,
                  issue: "Cancel at period end mismatch",
                  localData: { cancelAtPeriodEnd: sub.cancelAtPeriodEnd },
                  polarData: { cancel_at_period_end: polarSub.cancel_at_period_end },
                });
              }
            } catch (error) {
              discrepancies.push({
                type: "not_found_in_polar",
                localId: sub._id,
                polarId: sub.polarSubscriptionId,
                issue: "Subscription not found in Polar",
              });
            }
          }
        }
        break;
      }

      case "customers": {
        const localCustomers = await ctx.runQuery(
          internal.sync.getAllCustomers,
          { limit: 100 }
        );

        for (const customer of localCustomers) {
          if (!customer.polarCustomerId.startsWith("manual_")) {
            try {
              const polarCustomer = await polarApi.customers.get(
                customer.polarCustomerId
              );

              if (polarCustomer.email !== customer.email) {
                discrepancies.push({
                  type: "email_mismatch",
                  localId: customer._id,
                  polarId: customer.polarCustomerId,
                  issue: "Email mismatch",
                  localData: { email: customer.email },
                  polarData: { email: polarCustomer.email },
                });
              }
            } catch (error) {
              discrepancies.push({
                type: "not_found_in_polar",
                localId: customer._id,
                polarId: customer.polarCustomerId,
                issue: "Customer not found in Polar",
              });
            }
          }
        }
        break;
      }
    }

    // Log discrepancies
    if (discrepancies.length > 0) {
      await ctx.runMutation(internal.sync.logDiscrepancies, {
        checkType,
        discrepancies,
      });
    }

    return {
      checkType,
      discrepanciesFound: discrepancies.length,
      discrepancies: discrepancies.slice(0, 20), // Return first 20
    };
  },
});

// Clean up old records
export const cleanupOldRecords = internalAction({
  args: {
    daysToKeep: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const daysToKeep = args.daysToKeep || 90;
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
    const cutoff = cutoffDate.toISOString();

    let cleaned = {
      webhookEvents: 0,
      usageEvents: 0,
      auditLogs: 0,
    };

    // Clean old webhook events
    const oldWebhookEvents = await ctx.runQuery(
      internal.sync.getOldWebhookEvents,
      { cutoff }
    );
    
    for (const event of oldWebhookEvents) {
      if (event.processingResult === "success") {
        await ctx.runMutation(internal.sync.deleteWebhookEvent, {
          eventId: event._id,
        });
        cleaned.webhookEvents++;
      }
    }

    // Clean old processed usage events
    const oldUsageEvents = await ctx.runQuery(
      internal.sync.getOldUsageEvents,
      { cutoff }
    );
    
    for (const event of oldUsageEvents) {
      if (event.processed) {
        await ctx.runMutation(internal.sync.deleteUsageEvent, {
          eventId: event._id,
        });
        cleaned.usageEvents++;
      }
    }

    // Archive old audit logs
    const oldAuditLogs = await ctx.runQuery(
      internal.sync.getOldAuditLogs,
      { cutoff }
    );
    
    for (const log of oldAuditLogs) {
      // In production, you might want to archive these to cold storage
      // For now, we'll just count them
      cleaned.auditLogs++;
    }

    return {
      status: "completed",
      cleaned,
      cutoffDate: cutoff,
    };
  },
});

// ====================================
// MONITORING & ALERTING
// ====================================

// Check system health
export const checkSystemHealth = internalAction({
  args: {},
  handler: async (ctx) => {
    const health = {
      polar: {
        status: "unknown" as "healthy" | "degraded" | "down" | "unknown",
        lastCheck: new Date().toISOString(),
      },
      database: {
        status: "healthy" as "healthy" | "degraded" | "down",
        lastCheck: new Date().toISOString(),
      },
      sync: {
        lastRun: null as string | null,
        status: "unknown" as "success" | "failed" | "unknown",
      },
      alerts: [] as string[],
    };

    // Check Polar API
    try {
      await polarApi.products.list({ limit: 1 });
      health.polar.status = "healthy";
    } catch (error) {
      health.polar.status = circuitBreaker.isOpen ? "down" : "degraded";
      health.alerts.push("Polar API connection issues");
    }

    // Check last sync status
    const lastSync = await ctx.runQuery(internal.sync.getLastSyncStatus, {});
    if (lastSync) {
      health.sync.lastRun = lastSync.lastSyncedAt || null;
      health.sync.status = lastSync.status === "success" ? "success" : "failed";
      
      // Alert if sync hasn't run in 24 hours
      const lastRunDate = new Date(lastSync.lastSyncedAt || Date.now());
      const hoursSinceSync = (Date.now() - lastRunDate.getTime()) / (1000 * 60 * 60);
      if (hoursSinceSync > 24) {
        health.alerts.push(`Sync hasn't run in ${Math.floor(hoursSinceSync)} hours`);
      }
    }

    // Check for failed payments
    const failedPayments = await ctx.runQuery(
      internal.sync.getRecentFailedPayments,
      {}
    );
    if (failedPayments.length > 5) {
      health.alerts.push(`${failedPayments.length} failed payments in last 24 hours`);
    }

    return health;
  },
});

// ====================================
// INTERNAL QUERIES AND MUTATIONS
// ====================================

export const getAllCustomers = internalQuery({
  args: { limit: v.number() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("customers")
      .take(args.limit);
  },
});

export const getActiveSubscriptions = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("subscriptions")
      .withIndex("byStatus", (q) => q.eq("status", "active"))
      .collect();
  },
});

export const getPendingInvoices = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("invoices")
      .withIndex("byStatus", (q) => q.eq("status", "pending"))
      .collect();
  },
});

export const syncSubscription = internalMutation({
  args: {
    customerId: v.id("customers"),
    polarSubscription: v.object({
      id: v.string(),
      status: v.string(),
      product_id: v.string(),
      customer_id: v.string(),
      current_period_start: v.string(),
      current_period_end: v.optional(v.string()),
      cancel_at_period_end: v.boolean(),
      canceled_at: v.optional(v.string()),
      metadata: v.optional(v.any()),
    }),
  },
  handler: async (ctx, args) => {
    // Find existing subscription
    const existing = await ctx.db
      .query("subscriptions")
      .withIndex("byPolarSubscriptionId", (q) =>
        q.eq("polarSubscriptionId", args.polarSubscription.id)
      )
      .first();

    const statusMap: Record<string, Doc<"subscriptions">["status"]> = {
      incomplete: "incomplete",
      incomplete_expired: "incomplete_expired",
      trialing: "trialing",
      active: "active",
      past_due: "past_due",
      canceled: "canceled",
      unpaid: "unpaid",
    };

    const status = statusMap[args.polarSubscription.status] || "revoked";

    if (existing) {
      // Update existing
      await ctx.db.patch(existing._id, {
        status,
        currentPeriodStart: args.polarSubscription.current_period_start,
        currentPeriodEnd: args.polarSubscription.current_period_end,
        cancelAtPeriodEnd: args.polarSubscription.cancel_at_period_end,
        canceledAt: args.polarSubscription.canceled_at,
        updatedAt: new Date().toISOString(),
        lastSyncedAt: new Date().toISOString(),
      });
    } else {
      // Create new
      const customer = await ctx.db.get(args.customerId);
      if (customer) {
        await ctx.db.insert("subscriptions", {
          customerId: args.customerId,
          userId: customer.userId,
          orgId: customer.orgId,
          polarSubscriptionId: args.polarSubscription.id,
          polarProductId: args.polarSubscription.product_id,
          status,
          currentPeriodStart: args.polarSubscription.current_period_start,
          currentPeriodEnd: args.polarSubscription.current_period_end,
          cancelAtPeriodEnd: args.polarSubscription.cancel_at_period_end,
          canceledAt: args.polarSubscription.canceled_at,
          metadata: args.polarSubscription.metadata,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          lastSyncedAt: new Date().toISOString(),
        });
      }
    }
  },
});

export const updateInvoiceStatus = internalMutation({
  args: {
    invoiceId: v.id("invoices"),
    status: v.string(),
    paidAt: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.invoiceId, {
      status: args.status,
      paidAt: args.paidAt,
    });
  },
});

export const recordSyncStatus = internalMutation({
  args: {
    type: v.string(),
    status: v.union(v.literal("success"), v.literal("partial"), v.literal("failed")),
    synced: v.number(),
    failed: v.number(),
    duration: v.number(),
    errors: v.array(v.object({
      customerId: v.string(),
      error: v.string(),
    })),
  },
  handler: async (ctx, args) => {
    // Store in billing settings or a dedicated sync status table
    await ctx.db.insert("billingSettings", {
      key: `lastSync_${args.type}`,
      value: {
        status: args.status,
        synced: args.synced,
        failed: args.failed,
        duration: args.duration,
        errors: args.errors,
        completedAt: new Date().toISOString(),
      },
      updatedAt: new Date().toISOString(),
    });
  },
});

export const logDiscrepancies = internalMutation({
  args: {
    checkType: v.string(),
    discrepancies: v.array(v.any()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("auditLogs", {
      action: "reconciliation.discrepancies",
      resourceType: args.checkType,
      metadata: {
        count: args.discrepancies.length,
        discrepancies: args.discrepancies,
      },
      createdAt: new Date().toISOString(),
    });
  },
});

export const getOldWebhookEvents = internalQuery({
  args: { cutoff: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("webhookEvents")
      .filter((q) => q.lt(q.field("receivedAt"), args.cutoff))
      .take(100);
  },
});

export const getOldUsageEvents = internalQuery({
  args: { cutoff: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("usageEvents")
      .filter((q) => q.lt(q.field("createdAt"), args.cutoff))
      .take(100);
  },
});

export const getOldAuditLogs = internalQuery({
  args: { cutoff: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("auditLogs")
      .filter((q) => q.lt(q.field("createdAt"), args.cutoff))
      .take(100);
  },
});

export const deleteWebhookEvent = internalMutation({
  args: { eventId: v.id("webhookEvents") },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.eventId);
  },
});

export const deleteUsageEvent = internalMutation({
  args: { eventId: v.id("usageEvents") },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.eventId);
  },
});

export const getLastSyncStatus = internalQuery({
  args: {},
  handler: async (ctx): Promise<SyncStatus | null> => {
    const setting = await ctx.db
      .query("billingSettings")
      .withIndex("byKey", (q) => q.eq("key", "lastSync_subscriptions"))
      .first();
    
    if (setting && setting.value) {
      return setting.value as SyncStatus;
    }
    
    return null;
  },
});

export const getRecentFailedPayments = internalQuery({
  args: {},
  handler: async (ctx) => {
    const oneDayAgo = new Date();
    oneDayAgo.setDate(oneDayAgo.getDate() - 1);
    
    return await ctx.db
      .query("charges")
      .withIndex("byStatus", (q) => q.eq("status", "failed"))
      .filter((q) => q.gte(q.field("createdAt"), oneDayAgo.toISOString()))
      .collect();
  },
});