/**
 * Usage tracking system for metered billing
 * Records, batches, and syncs usage events with Polar
 */

import { v } from "convex/values";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { api, internal } from "./_generated/api";
import { getCurrentUser } from "./users";
import { polarApi } from "./lib/polar";
import { UsageEventType } from "./types";
import type { Doc } from "./_generated/dataModel";

// Record a usage event
export const recordUsageEvent = mutation({
  args: {
    eventType: v.string(),
    eventName: v.string(),
    units: v.number(),
    metadata: v.optional(v.object({})),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    if (!user) {
      throw new Error("User not authenticated");
    }

    // Get customer
    const customer = await ctx.db
      .query("customers")
      .withIndex("byUserId", (q) => q.eq("userId", user._id))
      .first();

    // Get active subscription
    const subscription = await ctx.db
      .query("subscriptions")
      .withIndex("byUserIdAndStatus", (q) =>
        q.eq("userId", user._id).eq("status", "active")
      )
      .first();

    // Create usage event
    return await ctx.db.insert("usageEvents", {
      userId: user._id,
      customerId: customer?._id,
      subscriptionId: subscription?._id,
      polarCustomerId: customer?.polarCustomerId,
      eventType: args.eventType,
      eventName: args.eventName,
      units: args.units,
      metadata: args.metadata,
      createdAt: new Date().toISOString(),
      processed: false,
    });
  },
});

// Record usage event with organization context
export const recordOrgUsageEvent = mutation({
  args: {
    orgId: v.id("organizations"),
    eventType: v.string(),
    eventName: v.string(),
    units: v.number(),
    metadata: v.optional(v.object({})),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    if (!user) {
      throw new Error("User not authenticated");
    }

    // Verify user has access to org
    const membership = await ctx.db
      .query("memberships")
      .withIndex("byUserIdAndOrgId", (q) =>
        q.eq("userId", user._id).eq("orgId", args.orgId)
      )
      .first();

    if (!membership) {
      throw new Error("Unauthorized");
    }

    // Get org customer
    const customer = await ctx.db
      .query("customers")
      .withIndex("byOrgId", (q) => q.eq("orgId", args.orgId))
      .first();

    // Get org subscription
    const subscription = await ctx.db
      .query("subscriptions")
      .withIndex("byOrgId", (q) => q.eq("orgId", args.orgId))
      .filter((q) => q.eq(q.field("status"), "active"))
      .first();

    // Create usage event
    return await ctx.db.insert("usageEvents", {
      userId: user._id,
      orgId: args.orgId,
      customerId: customer?._id,
      subscriptionId: subscription?._id,
      polarCustomerId: customer?.polarCustomerId,
      eventType: args.eventType,
      eventName: args.eventName,
      units: args.units,
      metadata: args.metadata,
      createdAt: new Date().toISOString(),
      processed: false,
    });
  },
});

// Get usage events for current user
export const getUsageByUser = query({
  args: {
    eventType: v.optional(v.string()),
    startDate: v.optional(v.string()),
    endDate: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    if (!user) return [];

    let query = ctx.db
      .query("usageEvents")
      .withIndex("byUserId", (q) => q.eq("userId", user._id));

    const events = await query.collect();

    // Filter by date and type
    let filteredEvents = events;
    
    if (args.eventType) {
      filteredEvents = filteredEvents.filter(
        (e) => e.eventType === args.eventType
      );
    }
    
    if (args.startDate) {
      filteredEvents = filteredEvents.filter(
        (e) => e.createdAt >= args.startDate!
      );
    }
    
    if (args.endDate) {
      filteredEvents = filteredEvents.filter(
        (e) => e.createdAt <= args.endDate!
      );
    }

    // Sort by date descending
    filteredEvents.sort((a, b) => 
      b.createdAt.localeCompare(a.createdAt)
    );

    // Apply limit
    if (args.limit) {
      filteredEvents = filteredEvents.slice(0, args.limit);
    }

    return filteredEvents;
  },
});

// Get usage summary for current billing period
export const getCurrentPeriodUsage = query({
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

    if (!subscription || !subscription.currentPeriodStart) {
      return null;
    }

    // Get usage events for current period
    const events = await ctx.db
      .query("usageEvents")
      .withIndex("byUserId", (q) => q.eq("userId", user._id))
      .filter((q) =>
        q.gte(q.field("createdAt"), subscription.currentPeriodStart!)
      )
      .collect();

    // Aggregate by event type
    const usage: Record<string, {
      count: number;
      units: number;
      lastUsed: string;
    }> = {};

    for (const event of events) {
      if (!usage[event.eventType]) {
        usage[event.eventType] = {
          count: 0,
          units: 0,
          lastUsed: event.createdAt,
        };
      }
      usage[event.eventType].count++;
      usage[event.eventType].units += event.units;
      if (event.createdAt > usage[event.eventType].lastUsed) {
        usage[event.eventType].lastUsed = event.createdAt;
      }
    }

    return {
      periodStart: subscription.currentPeriodStart,
      periodEnd: subscription.currentPeriodEnd,
      usage,
      totalEvents: events.length,
    };
  },
});

// Batch ingest usage events to Polar
export const batchIngestUsage = action({
  args: {
    batchSize: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const batchSize = args.batchSize || 100;

    // Get unprocessed events
    const events = await ctx.runQuery(
      internal.usageTracking.getUnprocessedEvents,
      { limit: batchSize }
    );

    if (events.length === 0) {
      return { processed: 0, failed: 0 };
    }

    // Group events by customer
    const eventsByCustomer: Record<string, typeof events> = {};
    for (const event of events) {
      if (!event.polarCustomerId) continue;
      if (!eventsByCustomer[event.polarCustomerId]) {
        eventsByCustomer[event.polarCustomerId] = [];
      }
      eventsByCustomer[event.polarCustomerId].push(event);
    }

    let processed = 0;
    let failed = 0;

    // Send to Polar
    for (const [polarCustomerId, customerEvents] of Object.entries(eventsByCustomer)) {
      try {
        const polarEvents = customerEvents.map((event: any) => ({
          customer_id: polarCustomerId,
          event_name: event.eventName,
          properties: {
            type: event.eventType,
            units: event.units,
            ...event.metadata,
          },
          timestamp: event.createdAt,
        }));

        const result = await polarApi.metrics.ingestEvents(polarEvents);
        
        // Mark events as processed
        for (const event of customerEvents) {
          await ctx.runMutation(internal.usageTracking.markEventProcessed, {
            eventId: event._id,
            polarEventId: `batch_${Date.now()}`,
            success: true,
          });
        }
        
        processed += result.accepted;
        failed += result.rejected;
      } catch (error) {
        console.error("Failed to ingest events for customer:", polarCustomerId, error);
        
        // Mark events as failed
        for (const event of customerEvents) {
          await ctx.runMutation(internal.usageTracking.markEventProcessed, {
            eventId: event._id,
            success: false,
            error: error instanceof Error ? error.message : "Unknown error",
          });
        }
        
        failed += customerEvents.length;
      }
    }

    return { processed, failed };
  },
});

// Internal: Get unprocessed events
export const getUnprocessedEvents = internalQuery({
  args: {
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("usageEvents")
      .withIndex("byProcessed", (q) => q.eq("processed", false))
      .take(args.limit);
  },
});

// Internal: Mark event as processed
export const markEventProcessed = internalMutation({
  args: {
    eventId: v.id("usageEvents"),
    polarEventId: v.optional(v.string()),
    success: v.boolean(),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const updates: Partial<Doc<"usageEvents">> = {
      processed: true,
      ingestedAt: new Date().toISOString(),
    };

    if (args.polarEventId) {
      updates.polarEventId = args.polarEventId;
    }

    if (args.error) {
      updates.error = args.error;
    }

    await ctx.db.patch(args.eventId, updates);
  },
});

// Process pending usage events (scheduled function)
export const processUsageEvents = internalMutation({
  args: {},
  handler: async (ctx) => {
    // This would be called by a cron job
    // For now, we'll just mark it as a placeholder
    console.log("Processing usage events - would call batchIngestUsage");
    
    // In production, you'd trigger the action:
    // await ctx.scheduler.runAfter(0, internal.usageTracking.batchIngestUsage, { batchSize: 100 });
    
    return { scheduled: true };
  },
});

// Get usage metrics for a specific meter
export const getMeterUsage = query({
  args: {
    meterName: v.string(),
    periodKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;

    const customer = await ctx.db
      .query("customers")
      .withIndex("byUserId", (q) => q.eq("userId", user._id))
      .first();

    if (!customer) return null;

    const periodKey = args.periodKey || new Date().toISOString().slice(0, 7);

    const meter = await ctx.db
      .query("meters")
      .withIndex("byCustomerIdAndPeriod", (q) =>
        q.eq("customerId", customer._id).eq("periodKey", periodKey)
      )
      .filter((q) => q.eq(q.field("meterName"), args.meterName))
      .first();

    return meter;
  },
});

// Update meter aggregates
export const updateMeterAggregates = internalMutation({
  args: {
    customerId: v.id("customers"),
    meterName: v.string(),
    periodKey: v.string(),
    units: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("meters")
      .withIndex("byCustomerIdAndPeriod", (q) =>
        q.eq("customerId", args.customerId).eq("periodKey", args.periodKey)
      )
      .filter((q) => q.eq(q.field("meterName"), args.meterName))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        consumedUnits: existing.consumedUnits + args.units,
        balance: existing.balance + args.units,
        lastSyncedAt: new Date().toISOString(),
      });
    } else {
      await ctx.db.insert("meters", {
        customerId: args.customerId,
        meterName: args.meterName,
        periodKey: args.periodKey,
        consumedUnits: args.units,
        balance: args.units,
        lastSyncedAt: new Date().toISOString(),
      });
    }
  },
});

// Check usage limits
export const checkUsageLimit = query({
  args: {
    eventType: v.string(),
  },
  handler: async (ctx, args): Promise<any> => {
    const user = await getCurrentUser(ctx);
    if (!user) return { allowed: false, reason: "Not authenticated" };

    // Get active subscription
    const subscription = await ctx.db
      .query("subscriptions")
      .withIndex("byUserIdAndStatus", (q) =>
        q.eq("userId", user._id).eq("status", "active")
      )
      .first();

    if (!subscription) {
      return { allowed: false, reason: "No active subscription" };
    }

    // Get plan details
    const plan = subscription.planId
      ? await ctx.db.get(subscription.planId)
      : null;

    if (!plan) {
      return { allowed: true }; // No limits if no plan
    }

    // Check plan limits from metadata
    const limits = plan.metadata as any;
    const eventTypeLimits: Record<string, number> = {
      [UsageEventType.API_CALLS]: limits?.maxApiCalls || Infinity,
      [UsageEventType.AI_TOKENS]: limits?.maxAiTokens || Infinity,
      [UsageEventType.STORAGE_GB]: limits?.maxStorageGb || Infinity,
      [UsageEventType.BANDWIDTH_GB]: limits?.maxBandwidthGb || Infinity,
    };

    const limit = eventTypeLimits[args.eventType];
    if (limit === Infinity) {
      return { allowed: true };
    }

    // Get current usage
    const usage: any = await ctx.runQuery(api.usageTracking.getCurrentPeriodUsage, {});
    const currentUsage: any = usage?.usage[args.eventType]?.units || 0;

    if (currentUsage >= limit) {
      return {
        allowed: false,
        reason: "Usage limit reached",
        limit,
        current: currentUsage,
      };
    }

    return {
      allowed: true,
      limit,
      current: currentUsage,
      remaining: limit - currentUsage,
    };
  },
});
// ====================================
// MONTHLY AGGREGATION
// ====================================

export const aggregateMonthlyUsage = internalAction({
  args: {},
  handler: async (ctx): Promise<any> => {
    // Get the current month
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);

    // Get all usage events for the month
    const events: any = await ctx.runQuery(internal.usageTracking.getMonthlyEvents, {
      startDate: startOfMonth.toISOString(),
      endDate: endOfMonth.toISOString(),
    });

    // Aggregate by user
    const userUsage = new Map<string, any>();
    
    for (const event of events) {
      const userId = event.userId;
      if (!userUsage.has(userId)) {
        userUsage.set(userId, {
          userId,
          apiCalls: 0,
          storageBytes: 0,
          projectActions: 0,
        });
      }
      
      const usage = userUsage.get(userId);
      switch (event.eventType) {
        case "api_call":
          usage.apiCalls++;
          break;
        case "storage_upload":
          usage.storageBytes += event.quantity || 0;
          break;
        case "project_action":
          usage.projectActions++;
          break;
      }
    }

    // Store aggregated data
    for (const [userId, usage] of userUsage) {
      await ctx.runMutation(internal.usageTracking.storeMonthlyUsage, {
        userId,
        year: now.getFullYear(),
        month: now.getMonth(),
        usage,
      });
    }

    return {
      processed: events.length,
      users: userUsage.size,
      month: `${now.getFullYear()}-${(now.getMonth() + 1).toString().padStart(2, "0")}`,
    };
  },
});

export const getMonthlyEvents = internalQuery({
  args: {
    startDate: v.string(),
    endDate: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("usageEvents")
      .filter((q) => 
        q.and(
          q.gte(q.field("createdAt"), args.startDate),
          q.lte(q.field("createdAt"), args.endDate)
        )
      )
      .collect();
  },
});

export const storeMonthlyUsage = internalMutation({
  args: {
    userId: v.string(),
    year: v.number(),
    month: v.number(),
    usage: v.any(),
  },
  handler: async (ctx, args) => {
    // Store monthly usage aggregate
    await ctx.db.insert("billingSettings", {
      key: `monthly_usage_${args.userId}_${args.year}_${args.month}`,
      value: args.usage,
      updatedAt: new Date().toISOString(),
    });
  },
});
