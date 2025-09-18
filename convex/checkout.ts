/**
 * Checkout session management
 * Handles checkout creation, validation, and completion
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
import { CheckoutStatus } from "./types";
import type { Doc } from "./_generated/dataModel";

// Create a checkout session
export const createCheckoutSession = action({
  args: {
    productIds: v.array(v.string()),
    successUrl: v.optional(v.string()),
    cancelUrl: v.optional(v.string()),
    allowDiscountCodes: v.optional(v.boolean()),
    discountCode: v.optional(v.string()),
    metadata: v.optional(v.object({})),
  },
  handler: async (ctx, args): Promise<any> => {
    // Get current user
    const user: any = await ctx.runQuery(api.users.current, {});
    if (!user) {
      throw new Error("User not authenticated");
    }

    // Get or create customer
    const customer = await ctx.runMutation(internal.customers.getOrCreateCustomer, {
      userId: user._id,
      email: user.email,
    });

    if (!customer) {
      throw new Error("Failed to create customer");
    }

    try {
      // Create checkout session in Polar
      const checkoutParams: any = {
        customer_id: customer.polarCustomerId,
        success_url: args.successUrl || `${process.env.NEXT_PUBLIC_APP_URL}/billing/success`,
        allow_discount_codes: args.allowDiscountCodes ?? true,
        metadata: {
          ...args.metadata,
          userId: user._id,
          customerId: customer._id,
        },
      };

      // Handle multiple products or single product
      if (args.productIds.length === 1) {
        checkoutParams.product_id = args.productIds[0];
      } else {
        // For multiple products, you might need to adjust based on Polar's API
        checkoutParams.product_id = args.productIds[0];
        checkoutParams.metadata.additionalProducts = args.productIds.slice(1);
      }

      if (args.discountCode) {
        // You might need to look up the discount ID from the code
        checkoutParams.discount_code = args.discountCode;
      }

      const polarCheckout = await polarApi.checkouts.create(checkoutParams);

      // Store checkout session locally
      const sessionId: any = await ctx.runMutation(
        internal.checkout.createCheckoutSessionRecord,
        {
          userId: user._id,
          polarCheckoutId: polarCheckout.id,
          productIds: args.productIds,
          successUrl: args.successUrl,
          cancelUrl: args.cancelUrl,
          clientSecret: polarCheckout.client_secret,
          expiresAt: polarCheckout.expires_at,
          metadata: args.metadata,
        }
      );

      return {
        sessionId,
        checkoutUrl: polarCheckout.url,
        clientSecret: polarCheckout.client_secret,
        expiresAt: polarCheckout.expires_at,
      };
    } catch (error) {
      console.error("Failed to create checkout session:", error);
      throw new Error("Failed to create checkout session");
    }
  },
});

// Internal: Create checkout session record
export const createCheckoutSessionRecord = internalMutation({
  args: {
    userId: v.optional(v.id("users")),
    orgId: v.optional(v.id("organizations")),
    polarCheckoutId: v.string(),
    productIds: v.array(v.string()),
    successUrl: v.optional(v.string()),
    cancelUrl: v.optional(v.string()),
    clientSecret: v.optional(v.string()),
    expiresAt: v.string(),
    metadata: v.optional(v.object({})),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("checkoutSessions", {
      userId: args.userId,
      orgId: args.orgId,
      polarCheckoutId: args.polarCheckoutId,
      productIds: args.productIds,
      status: "pending",
      successUrl: args.successUrl,
      cancelUrl: args.cancelUrl,
      clientSecret: args.clientSecret,
      expiresAt: args.expiresAt,
      metadata: args.metadata,
      createdAt: new Date().toISOString(),
    });
  },
});

// Get checkout session by ID
export const getCheckoutSession = query({
  args: { sessionId: v.id("checkoutSessions") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.sessionId);
  },
});

// Get checkout session by client secret
export const getCheckoutByClientSecret = query({
  args: { clientSecret: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("checkoutSessions")
      .withIndex("byClientSecret", (q) => q.eq("clientSecret", args.clientSecret))
      .first();
  },
});

// Get user's checkout sessions
export const getUserCheckoutSessions = query({
  args: {
    status: v.optional(
      v.union(
        v.literal("pending"),
        v.literal("completed"),
        v.literal("expired"),
        v.literal("canceled")
      )
    ),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    if (!user) return [];

    let query = ctx.db
      .query("checkoutSessions")
      .withIndex("byUserId", (q) => q.eq("userId", user._id));

    if (args.status) {
      query = query.filter((q) => q.eq(q.field("status"), args.status));
    }

    return await query.collect();
  },
});

// Complete checkout session (called from webhook)
export const completeCheckoutSession = internalMutation({
  args: {
    polarCheckoutId: v.string(),
    completedAt: v.optional(v.string()),
    metadata: v.optional(v.object({})),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query("checkoutSessions")
      .withIndex("byPolarCheckoutId", (q) =>
        q.eq("polarCheckoutId", args.polarCheckoutId)
      )
      .first();

    if (!session) {
      console.warn(`Checkout session not found for Polar ID: ${args.polarCheckoutId}`);
      return null;
    }

    if (session.status === "completed") {
      // Already completed, idempotent
      return session;
    }

    await ctx.db.patch(session._id, {
      status: "completed",
      completedAt: args.completedAt || new Date().toISOString(),
      metadata: { ...session.metadata, ...args.metadata },
    });

    return await ctx.db.get(session._id);
  },
});

// Cancel checkout session
export const cancelCheckoutSession = mutation({
  args: { sessionId: v.id("checkoutSessions") },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) {
      throw new Error("Checkout session not found");
    }

    const user = await getCurrentUser(ctx);
    if (!user || session.userId !== user._id) {
      throw new Error("Unauthorized");
    }

    if (session.status !== "pending") {
      throw new Error(`Cannot cancel ${session.status} checkout session`);
    }

    await ctx.db.patch(args.sessionId, {
      status: "canceled",
    });

    return { success: true };
  },
});

// Expire old checkout sessions (scheduled function)
export const expireOldSessions = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = new Date().toISOString();
    
    // Find all pending sessions that have expired
    const expiredSessions = await ctx.db
      .query("checkoutSessions")
      .withIndex("byStatus", (q) => q.eq("status", "pending"))
      .filter((q) => q.lt(q.field("expiresAt"), now))
      .collect();

    let expiredCount = 0;
    for (const session of expiredSessions) {
      await ctx.db.patch(session._id, {
        status: "expired",
      });
      expiredCount++;
    }

    return { expiredCount };
  },
});

// Sync checkout status from Polar
export const syncCheckoutStatus = action({
  args: { sessionId: v.id("checkoutSessions") },
  handler: async (ctx, args) => {
    const session = await ctx.runQuery(internal.checkout.getCheckoutSessionInternal, {
      sessionId: args.sessionId,
    });

    if (!session) {
      throw new Error("Checkout session not found");
    }

    try {
      // Get latest status from Polar
      const polarCheckout = await polarApi.checkouts.get(session.polarCheckoutId);

      // Map Polar status to our status
      let status: Doc<"checkoutSessions">["status"] = "pending";
      if (polarCheckout.status === "succeeded") {
        status = "completed";
      } else if (polarCheckout.status === "expired") {
        status = "expired";
      } else if (polarCheckout.status === "canceled") {
        status = "canceled";
      }

      // Update local session
      await ctx.runMutation(internal.checkout.updateCheckoutStatus, {
        sessionId: args.sessionId,
        status,
        metadata: {
          polarStatus: polarCheckout.status,
          syncedAt: new Date().toISOString(),
        },
      });

      return { status, syncedAt: new Date().toISOString() };
    } catch (error) {
      console.error("Failed to sync checkout status:", error);
      throw new Error("Failed to sync checkout status");
    }
  },
});

// Internal: Get checkout session
export const getCheckoutSessionInternal = internalQuery({
  args: { sessionId: v.id("checkoutSessions") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.sessionId);
  },
});

// Internal: Update checkout status
export const updateCheckoutStatus = internalMutation({
  args: {
    sessionId: v.id("checkoutSessions"),
    status: v.union(
      v.literal("pending"),
      v.literal("completed"),
      v.literal("expired"),
      v.literal("canceled")
    ),
    metadata: v.optional(v.object({})),
  },
  handler: async (ctx, args) => {
    const updates: Partial<Doc<"checkoutSessions">> = {
      status: args.status,
    };

    if (args.metadata) {
      const session = await ctx.db.get(args.sessionId);
      if (session) {
        updates.metadata = { ...session.metadata, ...args.metadata };
      }
    }

    if (args.status === "completed") {
      updates.completedAt = new Date().toISOString();
    }

    await ctx.db.patch(args.sessionId, updates);
  },
});

// Create checkout link (simple wrapper for backward compatibility)
export const createCheckoutLink = action({
  args: {
    productId: v.string(),
    successUrl: v.optional(v.string()),
    cancelUrl: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<any> => {
    const result: any = await ctx.runAction(api.checkout.createCheckoutSession, {
      productIds: [args.productId],
      successUrl: args.successUrl,
      cancelUrl: args.cancelUrl,
    });

    return result.checkoutUrl;
  },
});