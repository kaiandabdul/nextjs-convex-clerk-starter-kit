/**
 * Subscription lifecycle management
 * Handles subscription creation, updates, cancellations, and state transitions
 */

import { v } from "convex/values";
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { api, internal } from "./_generated/api";
import { getCurrentUser } from "./users";
import { polarApi } from "./lib/polar";
import { SubscriptionStatus } from "./types";
import type { Doc, Id } from "./_generated/dataModel";

// Create subscription (from webhook)
export const createSubscription = internalMutation({
  args: {
    customerId: v.id("customers"),
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
    trialStart: v.optional(v.string()),
    trialEnd: v.optional(v.string()),
    metadata: v.optional(v.object({})),
  },
  handler: async (ctx, args) => {
    // Check if subscription already exists
    const existing = await ctx.db
      .query("subscriptions")
      .withIndex("byPolarSubscriptionId", (q) =>
        q.eq("polarSubscriptionId", args.polarSubscriptionId)
      )
      .first();

    if (existing) {
      // Update existing subscription
      await ctx.db.patch(existing._id, {
        status: args.status,
        currentPeriodStart: args.currentPeriodStart,
        currentPeriodEnd: args.currentPeriodEnd,
        metadata: args.metadata,
        updatedAt: new Date().toISOString(),
        lastSyncedAt: new Date().toISOString(),
      });
      return existing._id;
    }

    // Get customer to link user/org
    const customer = await ctx.db.get(args.customerId);
    if (!customer) {
      throw new Error(`Customer ${args.customerId} not found`);
    }

    // Create new subscription
    return await ctx.db.insert("subscriptions", {
      customerId: args.customerId,
      userId: customer.userId,
      orgId: customer.orgId,
      polarSubscriptionId: args.polarSubscriptionId,
      polarProductId: args.polarProductId,
      planId: args.planId,
      status: args.status,
      currentPeriodStart: args.currentPeriodStart,
      currentPeriodEnd: args.currentPeriodEnd,
      cancelAtPeriodEnd: false,
      trialStart: args.trialStart,
      trialEnd: args.trialEnd,
      metadata: args.metadata,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  },
});

// Update subscription
export const updateSubscription = internalMutation({
  args: {
    subscriptionId: v.id("subscriptions"),
    status: v.optional(
      v.union(
        v.literal("incomplete"),
        v.literal("incomplete_expired"),
        v.literal("trialing"),
        v.literal("active"),
        v.literal("past_due"),
        v.literal("canceled"),
        v.literal("unpaid"),
        v.literal("revoked")
      )
    ),
    currentPeriodStart: v.optional(v.string()),
    currentPeriodEnd: v.optional(v.string()),
    cancelAtPeriodEnd: v.optional(v.boolean()),
    canceledAt: v.optional(v.string()),
    endedAt: v.optional(v.string()),
    metadata: v.optional(v.object({})),
  },
  handler: async (ctx, args) => {
    const subscription = await ctx.db.get(args.subscriptionId);
    if (!subscription) {
      throw new Error(`Subscription ${args.subscriptionId} not found`);
    }

    const updates: Partial<Doc<"subscriptions">> = {
      updatedAt: new Date().toISOString(),
      lastSyncedAt: new Date().toISOString(),
    };

    if (args.status !== undefined) updates.status = args.status;
    if (args.currentPeriodStart !== undefined) updates.currentPeriodStart = args.currentPeriodStart;
    if (args.currentPeriodEnd !== undefined) updates.currentPeriodEnd = args.currentPeriodEnd;
    if (args.cancelAtPeriodEnd !== undefined) updates.cancelAtPeriodEnd = args.cancelAtPeriodEnd;
    if (args.canceledAt !== undefined) updates.canceledAt = args.canceledAt;
    if (args.endedAt !== undefined) updates.endedAt = args.endedAt;
    if (args.metadata !== undefined) {
      updates.metadata = { ...subscription.metadata, ...args.metadata };
    }

    await ctx.db.patch(args.subscriptionId, updates);
    return await ctx.db.get(args.subscriptionId);
  },
});

// Get active subscription for user
export const getActiveSubscription = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;

    // Look for active subscription
    const subscription = await ctx.db
      .query("subscriptions")
      .withIndex("byUserIdAndStatus", (q) =>
        q.eq("userId", user._id).eq("status", "active")
      )
      .first();

    if (!subscription) {
      // Check for trialing subscription
      const trialingSub = await ctx.db
        .query("subscriptions")
        .withIndex("byUserIdAndStatus", (q) =>
          q.eq("userId", user._id).eq("status", "trialing")
        )
        .first();
      
      return trialingSub;
    }

    return subscription;
  },
});

// Get all user subscriptions
export const getUserSubscriptions = query({
  args: {
    includeInactive: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    if (!user) return [];

    let subscriptions = await ctx.db
      .query("subscriptions")
      .withIndex("byUserId", (q) => q.eq("userId", user._id))
      .collect();

    if (!args.includeInactive) {
      subscriptions = subscriptions.filter(
        (sub) => !["canceled", "revoked", "unpaid"].includes(sub.status)
      );
    }

    return subscriptions;
  },
});

// Cancel subscription
export const cancelSubscription = action({
  args: {
    subscriptionId: v.id("subscriptions"),
    cancelAtPeriodEnd: v.optional(v.boolean()),
    reason: v.optional(v.string()),
    feedback: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Get subscription
    const subscription = await ctx.runQuery(
      internal.subscriptions.getSubscriptionById,
      { subscriptionId: args.subscriptionId }
    );

    if (!subscription) {
      throw new Error("Subscription not found");
    }

    // Verify user owns this subscription
    const user = await ctx.runQuery(api.users.current, {});
    if (!user || subscription.userId !== user._id) {
      throw new Error("Unauthorized");
    }

    try {
      // Cancel in Polar
      const polarSubscription = await polarApi.subscriptions.cancel(
        subscription.polarSubscriptionId,
        {
          cancel_at_period_end: args.cancelAtPeriodEnd ?? true,
          reason: args.reason,
          comment: args.feedback,
        }
      );

      // Update local subscription
      await ctx.runMutation(internal.subscriptions.updateSubscription, {
        subscriptionId: args.subscriptionId,
        status: polarSubscription.cancel_at_period_end ? "active" : "canceled",
        cancelAtPeriodEnd: polarSubscription.cancel_at_period_end,
        canceledAt: new Date().toISOString(),
        metadata: {
          cancellationReason: args.reason,
          cancellationFeedback: args.feedback,
        },
      });

      return {
        success: true,
        cancelAtPeriodEnd: polarSubscription.cancel_at_period_end,
      };
    } catch (error) {
      console.error("Failed to cancel subscription:", error);
      throw new Error("Failed to cancel subscription");
    }
  },
});

// Resume canceled subscription
export const resumeSubscription = action({
  args: {
    subscriptionId: v.id("subscriptions"),
  },
  handler: async (ctx, args) => {
    const subscription = await ctx.runQuery(
      internal.subscriptions.getSubscriptionById,
      { subscriptionId: args.subscriptionId }
    );

    if (!subscription) {
      throw new Error("Subscription not found");
    }

    // Verify user owns this subscription
    const user = await ctx.runQuery(api.users.current, {});
    if (!user || subscription.userId !== user._id) {
      throw new Error("Unauthorized");
    }

    if (!subscription.cancelAtPeriodEnd) {
      throw new Error("Subscription is not scheduled for cancellation");
    }

    try {
      // Resume in Polar (uncancel)
      const polarSubscription = await polarApi.subscriptions.update(
        subscription.polarSubscriptionId,
        {
          metadata: {
            ...subscription.metadata,
            resumedAt: new Date().toISOString(),
          },
        }
      );

      // Update local subscription
      await ctx.runMutation(internal.subscriptions.updateSubscription, {
        subscriptionId: args.subscriptionId,
        cancelAtPeriodEnd: false,
        canceledAt: undefined,
        metadata: {
          resumedAt: new Date().toISOString(),
        },
      });

      return { success: true };
    } catch (error) {
      console.error("Failed to resume subscription:", error);
      throw new Error("Failed to resume subscription");
    }
  },
});

// Change subscription plan (upgrade/downgrade)
export const changeSubscriptionPlan = action({
  args: {
    subscriptionId: v.id("subscriptions"),
    newPlanId: v.id("plans"),
    immediate: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const subscription = await ctx.runQuery(
      internal.subscriptions.getSubscriptionById,
      { subscriptionId: args.subscriptionId }
    );

    if (!subscription) {
      throw new Error("Subscription not found");
    }

    // Verify user owns this subscription
    const user = await ctx.runQuery(api.users.current, {});
    if (!user || subscription.userId !== user._id) {
      throw new Error("Unauthorized");
    }

    // Get new plan details
    const newPlan = await ctx.runQuery(internal.subscriptions.getPlanById, {
      planId: args.newPlanId,
    });

    if (!newPlan || !newPlan.polarPriceId) {
      throw new Error("Invalid plan");
    }

    try {
      // Update subscription in Polar
      const polarSubscription = await polarApi.subscriptions.update(
        subscription.polarSubscriptionId,
        {
          product_price_id: newPlan.polarPriceId,
        }
      );

      // Update local subscription
      await ctx.runMutation(internal.subscriptions.updateSubscription, {
        subscriptionId: args.subscriptionId,
        metadata: {
          previousPlanId: subscription.planId,
          planChangedAt: new Date().toISOString(),
          immediate: args.immediate,
        },
      });

      return { success: true, newPlanId: args.newPlanId };
    } catch (error) {
      console.error("Failed to change subscription plan:", error);
      throw new Error("Failed to change subscription plan");
    }
  },
});

// Internal: Get subscription by ID
export const getSubscriptionById = internalQuery({
  args: { subscriptionId: v.id("subscriptions") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.subscriptionId);
  },
});

// Internal: Get subscription by Polar ID
export const getSubscriptionByPolarId = internalQuery({
  args: { polarSubscriptionId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("subscriptions")
      .withIndex("byPolarSubscriptionId", (q) =>
        q.eq("polarSubscriptionId", args.polarSubscriptionId)
      )
      .first();
  },
});

// Internal: Get plan by ID
export const getPlanById = internalQuery({
  args: { planId: v.id("plans") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.planId);
  },
});

// Internal: Update subscription from webhook
export const updateSubscriptionFromWebhook = internalMutation({
  args: {
    polarSubscriptionId: v.string(),
    updates: v.object({
      status: v.optional(v.string()),
      currentPeriodStart: v.optional(v.string()),
      currentPeriodEnd: v.optional(v.string()),
      cancelAtPeriodEnd: v.optional(v.boolean()),
      canceledAt: v.optional(v.string()),
      endedAt: v.optional(v.string()),
      metadata: v.optional(v.any()),
    }),
  },
  handler: async (ctx, args) => {
    const subscription = await ctx.db
      .query("subscriptions")
      .withIndex("byPolarSubscriptionId", (q) =>
        q.eq("polarSubscriptionId", args.polarSubscriptionId)
      )
      .first();

    if (!subscription) {
      console.warn(`Subscription not found for Polar ID: ${args.polarSubscriptionId}`);
      return null;
    }

    // Map status if provided
    let status: Doc<"subscriptions">["status"] | undefined;
    if (args.updates.status) {
      const statusMap: Record<string, Doc<"subscriptions">["status"]> = {
        incomplete: "incomplete",
        incomplete_expired: "incomplete_expired",
        trialing: "trialing",
        active: "active",
        past_due: "past_due",
        canceled: "canceled",
        unpaid: "unpaid",
      };
      status = statusMap[args.updates.status] || "revoked";
    }

    const updates: Partial<Doc<"subscriptions">> = {
      updatedAt: new Date().toISOString(),
      lastSyncedAt: new Date().toISOString(),
    };

    if (status) updates.status = status;
    if (args.updates.currentPeriodStart) updates.currentPeriodStart = args.updates.currentPeriodStart;
    if (args.updates.currentPeriodEnd) updates.currentPeriodEnd = args.updates.currentPeriodEnd;
    if (args.updates.cancelAtPeriodEnd !== undefined) updates.cancelAtPeriodEnd = args.updates.cancelAtPeriodEnd;
    if (args.updates.canceledAt) updates.canceledAt = args.updates.canceledAt;
    if (args.updates.endedAt) updates.endedAt = args.updates.endedAt;
    if (args.updates.metadata) {
      updates.metadata = { ...subscription.metadata, ...args.updates.metadata };
    }

    await ctx.db.patch(subscription._id, updates);
    return subscription._id;
  },
});

// Check if user has active subscription
export const hasActiveSubscription: any = query({
  args: {},
  handler: async (ctx) => {
    const subscription = await ctx.runQuery(
      api.subscriptions.getActiveSubscription,
      {}
    );
    return !!subscription;
  },
});

// Get subscription with plan details
export const getSubscriptionWithPlan = query({
  args: { subscriptionId: v.id("subscriptions") },
  handler: async (ctx, args) => {
    const subscription = await ctx.db.get(args.subscriptionId);
    if (!subscription) return null;

    const plan = subscription.planId
      ? await ctx.db.get(subscription.planId)
      : null;

    return {
      ...subscription,
      plan,
    };
  },
});