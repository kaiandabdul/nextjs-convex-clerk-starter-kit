/**
 * Customer management functions
 * Handles customer creation, syncing, and retrieval with Polar
 */

import { v } from "convex/values";
import { 
  internalMutation, 
  internalQuery, 
  query,
  action,
  type QueryCtx,
  type MutationCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { getCurrentUser } from "./users";
import { polarApi } from "./lib/polar";
import type { PolarCustomer } from "./types";

// Get or create customer for user
export const getOrCreateCustomer = internalMutation({
  args: {
    userId: v.id("users"),
    email: v.optional(v.string()),
    metadata: v.optional(v.object({})),
  },
  handler: async (ctx, args) => {
    // Check if customer already exists
    const existingCustomer = await ctx.db
      .query("customers")
      .withIndex("byUserId", (q) => q.eq("userId", args.userId))
      .first();

    if (existingCustomer) {
      return existingCustomer;
    }

    // Get user details
    const user = await ctx.db.get(args.userId);
    if (!user) {
      throw new Error(`User ${args.userId} not found`);
    }

    const email = args.email || user.email;
    const metadata = {
      ...args.metadata,
      convexUserId: args.userId,
      userName: user.name,
    };

    try {
      // Create customer in Polar
      const polarCustomer = await polarApi.customers.create(email, metadata);

      // Store customer mapping
      const customerId = await ctx.db.insert("customers", {
        userId: args.userId,
        email,
        polarCustomerId: polarCustomer.id,
        externalId: user.externalId,
        createdAt: new Date().toISOString(),
        metadata,
      });

      // Update user with polar customer ID
      await ctx.db.patch(args.userId, {
        polarCustomerId: polarCustomer.id,
        updatedAt: new Date().toISOString(),
      });

      const customer = await ctx.db.get(customerId);
      return customer!;
    } catch (error) {
      console.error("Failed to create Polar customer:", error);
      throw new Error("Failed to create customer");
    }
  },
});

// Update customer data
export const updateCustomer = internalMutation({
  args: {
    customerId: v.id("customers"),
    email: v.optional(v.string()),
    metadata: v.optional(v.object({})),
    syncToPolar: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const customer = await ctx.db.get(args.customerId);
    if (!customer) {
      throw new Error(`Customer ${args.customerId} not found`);
    }

    // Update local customer
    const updates: Partial<Doc<"customers">> = {
      lastSyncedAt: new Date().toISOString(),
    };
    
    if (args.email) updates.email = args.email;
    if (args.metadata) updates.metadata = args.metadata;
    
    await ctx.db.patch(args.customerId, updates);

    // Sync to Polar if requested
    if (args.syncToPolar) {
      try {
        await polarApi.customers.update(
          customer.polarCustomerId,
          {
            email: args.email,
            metadata: args.metadata,
          }
        );
      } catch (error) {
        console.error("Failed to update Polar customer:", error);
        // Continue even if Polar update fails
      }
    }

    return await ctx.db.get(args.customerId);
  },
});

// Query customer by user ID
export const getCustomerByUserId = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("customers")
      .withIndex("byUserId", (q) => q.eq("userId", args.userId))
      .first();
  },
});

// Query customer by Polar customer ID
export const getCustomerByPolarId = internalQuery({
  args: { polarCustomerId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("customers")
      .withIndex("byPolarCustomerId", (q) => 
        q.eq("polarCustomerId", args.polarCustomerId)
      )
      .first();
  },
});

// Get current user's customer record
export const getCurrentUserCustomer = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;

    return await ctx.db
      .query("customers")
      .withIndex("byUserId", (q) => q.eq("userId", user._id))
      .first();
  },
});

// Sync customer from Polar
export const syncCustomerFromPolar = action({
  args: { customerId: v.id("customers") },
  handler: async (ctx, args) => {
    const customer = await ctx.runQuery(internal.customers.getCustomerById, {
      customerId: args.customerId,
    });
    
    if (!customer) {
      throw new Error(`Customer ${args.customerId} not found`);
    }

    try {
      // Fetch latest from Polar
      const polarCustomer = await polarApi.customers.get(customer.polarCustomerId);
      
      // Update local customer
      await ctx.runMutation(internal.customers.updateCustomerFromPolar, {
        customerId: args.customerId,
        polarCustomer: {
          id: polarCustomer.id,
          email: polarCustomer.email,
          email_verified: polarCustomer.email_verified,
          metadata: polarCustomer.metadata,
          created_at: polarCustomer.created_at,
          modified_at: polarCustomer.modified_at,
        },
      });

      return { success: true };
    } catch (error) {
      console.error("Failed to sync customer from Polar:", error);
      return { 
        success: false, 
        error: error instanceof Error ? error.message : "Unknown error" 
      };
    }
  },
});

// Internal: Get customer by ID
export const getCustomerById = internalQuery({
  args: { customerId: v.id("customers") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.customerId);
  },
});

// Internal: Update customer from Polar data
export const updateCustomerFromPolar = internalMutation({
  args: {
    customerId: v.id("customers"),
    polarCustomer: v.object({
      id: v.string(),
      email: v.string(),
      email_verified: v.boolean(),
      metadata: v.optional(v.any()),
      created_at: v.string(),
      modified_at: v.optional(v.string()),
    }),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.customerId, {
      email: args.polarCustomer.email,
      metadata: args.polarCustomer.metadata || {},
      lastSyncedAt: new Date().toISOString(),
    });
  },
});

// Internal: Create customer from webhook
export const createCustomerFromWebhook = internalMutation({
  args: {
    polarCustomer: v.object({
      id: v.string(),
      email: v.string(),
      email_verified: v.boolean(),
      metadata: v.optional(v.any()),
      created_at: v.string(),
      modified_at: v.optional(v.string()),
    }),
  },
  handler: async (ctx, args) => {
    // Check if customer already exists
    const existing = await ctx.db
      .query("customers")
      .withIndex("byPolarCustomerId", (q) => 
        q.eq("polarCustomerId", args.polarCustomer.id)
      )
      .first();

    if (existing) {
      // Update existing
      await ctx.db.patch(existing._id, {
        email: args.polarCustomer.email,
        metadata: args.polarCustomer.metadata || {},
        lastSyncedAt: new Date().toISOString(),
      });
      return existing._id;
    }

    // Try to match with user by email
    const user = await ctx.db
      .query("users")
      .withIndex("byEmail", (q) => q.eq("email", args.polarCustomer.email))
      .first();

    // Create new customer
    return await ctx.db.insert("customers", {
      userId: user?._id,
      email: args.polarCustomer.email,
      polarCustomerId: args.polarCustomer.id,
      createdAt: new Date().toISOString(),
      metadata: args.polarCustomer.metadata || {},
    });
  },
});

// List all customers (admin)
export const listCustomers = internalQuery({
  args: {
    limit: v.optional(v.number()),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit || 50;
    let query = ctx.db.query("customers");
    
    // Simple pagination using creation date
    if (args.cursor) {
      query = query.filter((q: any) => q.gt(q.field("createdAt"), args.cursor ?? ""));
    }
    
    const customers = await query.take(limit);
    
    return {
      customers,
      nextCursor: customers.length === limit 
        ? customers[customers.length - 1].createdAt 
        : null,
    };
  },
});

// Get customer with subscriptions
export const getCustomerWithSubscriptions = query({
  args: { customerId: v.id("customers") },
  handler: async (ctx, args) => {
    const customer = await ctx.db.get(args.customerId);
    if (!customer) return null;

    const subscriptions = await ctx.db
      .query("subscriptions")
      .withIndex("byCustomerId", (q) => q.eq("customerId", args.customerId))
      .collect();

    return {
      ...customer,
      subscriptions,
    };
  },
});

// Check if user has customer account
export const hasCustomerAccount = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const customer = await ctx.db
      .query("customers")
      .withIndex("byUserId", (q) => q.eq("userId", args.userId))
      .first();
    
    return !!customer;
  },
});