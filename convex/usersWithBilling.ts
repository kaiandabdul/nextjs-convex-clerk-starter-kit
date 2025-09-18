/**
 * Enhanced user management with billing integration
 * Provides feature gating based on subscription status
 */

import { v } from "convex/values";
import { query, mutation, internalQuery, internalMutation } from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";

// ====================================
// FEATURE FLAGS & LIMITS
// ====================================

export const PLAN_LIMITS = {
  free: {
    maxProjects: 1,
    maxTeamMembers: 1,
    maxStorageGB: 1,
    maxMonthlyApiCalls: 1000,
    features: {
      basicAnalytics: true,
      advancedAnalytics: false,
      customDomain: false,
      prioritySupport: false,
      apiAccess: false,
      teamCollaboration: false,
      ssoAuth: false,
      auditLogs: false,
      customBranding: false,
      webhooks: false,
    },
  },
  premium: {
    maxProjects: 10,
    maxTeamMembers: 5,
    maxStorageGB: 50,
    maxMonthlyApiCalls: 50000,
    features: {
      basicAnalytics: true,
      advancedAnalytics: true,
      customDomain: true,
      prioritySupport: false,
      apiAccess: true,
      teamCollaboration: true,
      ssoAuth: false,
      auditLogs: true,
      customBranding: false,
      webhooks: true,
    },
  },
  premiumPlus: {
    maxProjects: -1, // unlimited
    maxTeamMembers: -1, // unlimited
    maxStorageGB: 500,
    maxMonthlyApiCalls: -1, // unlimited
    features: {
      basicAnalytics: true,
      advancedAnalytics: true,
      customDomain: true,
      prioritySupport: true,
      apiAccess: true,
      teamCollaboration: true,
      ssoAuth: true,
      auditLogs: true,
      customBranding: true,
      webhooks: true,
    },
  },
};

export type PlanType = keyof typeof PLAN_LIMITS;
export type FeatureKey = keyof typeof PLAN_LIMITS.free.features;

// ====================================
// USER PROFILE WITH BILLING
// ====================================

export interface UserProfile {
  id: string;
  email: string;
  name?: string;
  imageUrl?: string;
  plan: PlanType;
  subscription?: {
    id: string;
    status: Doc<"subscriptions">["status"];
    cancelAtPeriodEnd: boolean;
    currentPeriodEnd?: string;
    productName?: string;
  };
  usage: {
    projectsCount: number;
    teamMembersCount: number;
    storageUsedGB: number;
    apiCallsThisMonth: number;
  };
  limits: typeof PLAN_LIMITS.free;
  features: typeof PLAN_LIMITS.free.features;
  customerId?: string;
}

// Get current user with billing info
export const getCurrentUserProfile = query({
  args: {},
  handler: async (ctx): Promise<UserProfile | null> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;

    // Get user from database
    const user = await ctx.db
      .query("users")
      .withIndex("byExternalId", (q: any) => q.eq("externalId", identity.subject))
      .unique();

    if (!user) return null;

    // Get customer record
    const customer = await ctx.db
      .query("customers")
      .withIndex("byUserId", (q: any) => q.eq("userId", user._id))
      .first();

    // Get active subscription
    let activeSubscription = null;
    let plan: PlanType = "free";
    
    if (customer) {
      const subscription = await ctx.db
        .query("subscriptions")
        .withIndex("byCustomerId", (q: any) => q.eq("customerId", customer._id))
        .filter((q: any) => 
          q.or(
            q.eq(q.field("status"), "active"),
            q.eq(q.field("status"), "trialing")
          )
        )
        .first();

      if (subscription) {
        activeSubscription = subscription;
        
        // Get product to determine plan
        const product = await ctx.db
          .query("products")
          .withIndex("byPolarProductId", (q: any) => 
            q.eq("polarProductId", subscription.polarProductId)
          )
          .first();

        if (product) {
          // Map product to plan
          if (product.name.toLowerCase().includes("premium plus") || 
              product.name.toLowerCase().includes("enterprise")) {
            plan = "premiumPlus";
          } else if (product.name.toLowerCase().includes("premium") ||
                     product.name.toLowerCase().includes("pro")) {
            plan = "premium";
          }
        }
      }
    }

    // Get usage data
    const usage = await ctx.runQuery(internal.usersWithBilling.getUserUsage, {
      userId: user._id,
    });

    const limits = PLAN_LIMITS[plan];

    return {
      id: user._id,
      email: user.email,
      name: user.name,
      // imageUrl: user.imageUrl, // Field doesn't exist in schema
      plan,
      subscription: activeSubscription ? {
        id: activeSubscription._id,
        status: activeSubscription.status,
        cancelAtPeriodEnd: activeSubscription.cancelAtPeriodEnd ?? false,
        currentPeriodEnd: activeSubscription.currentPeriodEnd,
        productName: (activeSubscription.metadata as any)?.productName,
      } : undefined,
      usage,
      limits,
      features: limits.features,
      customerId: customer?._id,
    };
  },
});

// Check if user has access to a specific feature
export const checkFeatureAccess = query({
  args: {
    feature: v.string() as any, // Would be v.enum(FeatureKey) if supported
  },
  handler: async (ctx, args): Promise<boolean> => {
    const profile = await ctx.runQuery(api.usersWithBilling.getCurrentUserProfile, {});
    if (!profile) return false;

    return profile.features[args.feature as FeatureKey] ?? false;
  },
});

// Check if user is within usage limits
export const checkUsageLimit = query({
  args: {
    limitType: v.union(
      v.literal("projects"),
      v.literal("teamMembers"),
      v.literal("storage"),
      v.literal("apiCalls")
    ),
    requestedAmount: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<any> => {
    const profile: any = await ctx.runQuery(api.usersWithBilling.getCurrentUserProfile, {});
    if (!profile) {
      return { allowed: false, reason: "Not authenticated" };
    }

    const { limits, usage }: any = profile;
    const requested = args.requestedAmount || 1;

    switch (args.limitType) {
      case "projects": {
        const maxProjects = limits.maxProjects;
        if (maxProjects === -1) {
          return { allowed: true };
        }
        const wouldExceed: any = usage.projectsCount + requested > maxProjects;
        return {
          allowed: !wouldExceed,
          current: usage.projectsCount,
          limit: maxProjects,
          reason: wouldExceed ? `Project limit (${maxProjects}) would be exceeded` : undefined,
        };
      }
      
      case "teamMembers": {
        const maxMembers = limits.maxTeamMembers;
        if (maxMembers === -1) {
          return { allowed: true };
        }
        const wouldExceed = usage.teamMembersCount + requested > maxMembers;
        return {
          allowed: !wouldExceed,
          current: usage.teamMembersCount,
          limit: maxMembers,
          reason: wouldExceed ? `Team member limit (${maxMembers}) would be exceeded` : undefined,
        };
      }
      
      case "storage": {
        const maxStorage = limits.maxStorageGB;
        if (maxStorage === -1) {
          return { allowed: true };
        }
        const wouldExceed = usage.storageUsedGB + requested > maxStorage;
        return {
          allowed: !wouldExceed,
          current: usage.storageUsedGB,
          limit: maxStorage,
          reason: wouldExceed ? `Storage limit (${maxStorage}GB) would be exceeded` : undefined,
        };
      }
      
      case "apiCalls": {
        const maxCalls = limits.maxMonthlyApiCalls;
        if (maxCalls === -1) {
          return { allowed: true };
        }
        const wouldExceed = usage.apiCallsThisMonth + requested > maxCalls;
        return {
          allowed: !wouldExceed,
          current: usage.apiCallsThisMonth,
          limit: maxCalls,
          reason: wouldExceed ? `Monthly API call limit (${maxCalls}) would be exceeded` : undefined,
        };
      }
      
      default:
        return { allowed: false, reason: "Unknown limit type" };
    }
  },
});

// ====================================
// USAGE TRACKING
// ====================================

// Track feature usage
export const trackFeatureUsage = mutation({
  args: {
    feature: v.string(),
    metadata: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    const user = await ctx.db
      .query("users")
      .withIndex("byExternalId", (q: any) => q.eq("externalId", identity.subject))
      .unique();

    if (!user) throw new Error("User not found");

    // Record usage event
    await ctx.db.insert("usageEvents", {
      userId: user._id,
      eventType: "feature_usage",
      eventName: args.feature,
      units: 1,
      metadata: args.metadata,
      createdAt: new Date().toISOString(),
      processed: false,
    });

    // Check if this is an API call to increment counter
    if (args.feature === "api_call") {
      await ctx.runMutation(internal.usersWithBilling.incrementApiCalls, {
        userId: user._id,
      });
    }
  },
});

// ====================================
// TEAM MANAGEMENT WITH BILLING
// ====================================

// Add team member with limit check
export const addTeamMember = mutation({
  args: {
    email: v.string(),
    role: v.union(v.literal("admin"), v.literal("member"), v.literal("viewer")),
  },
  handler: async (ctx, args) => {
    // Check if user can add more team members
    const limitCheck = await ctx.runQuery(api.usersWithBilling.checkUsageLimit, {
      limitType: "teamMembers",
      requestedAmount: 1,
    });

    if (!limitCheck.allowed) {
      throw new Error(limitCheck.reason || "Cannot add team member");
    }

    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    const user = await ctx.db
      .query("users")
      .withIndex("byExternalId", (q: any) => q.eq("externalId", identity.subject))
      .unique();

    if (!user) throw new Error("User not found");

    // Get or create organization
    let org = await ctx.db
      .query("organizations")
      .withIndex("byOwnerUserId", (q: any) => q.eq("ownerUserId", user._id))
      .first();

    if (!org) {
      const orgId = await ctx.db.insert("organizations", {
        name: `${user.name || user.email}'s Organization`,
        ownerUserId: user._id,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      org = await ctx.db.get(orgId);
    }

    // Add team member
    await ctx.db.insert("memberships", {
      userId: user._id,  // The member being added (for now, use the current user)
      orgId: org!._id,
      role: "member" as const,  // Use valid role from schema
      joinedAt: new Date().toISOString(),
    });

    // Track usage
    await ctx.runMutation(api.usersWithBilling.trackFeatureUsage, {
      feature: "add_team_member",
      metadata: { email: args.email, role: args.role },
    });

    return { success: true };
  },
});

// ====================================
// INTERNAL HELPERS
// ====================================

export const getUserUsage = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    // Get projects count
    const projects = await ctx.db
      .query("subscriptions")
      .withIndex("byUserId", (q: any) => q.eq("userId", args.userId))
      .collect();

    // Get team members count
    const org = await ctx.db
      .query("organizations")
      .withIndex("byOwnerUserId", (q: any) => q.eq("ownerUserId", args.userId))
      .first();

    let teamMembersCount = 1; // Self
    if (org) {
      const members = await ctx.db
        .query("memberships")
        .withIndex("byOrgId", (q: any) => q.eq("orgId", org._id))
        .collect();
      teamMembersCount += members.length;
    }

    // Get storage used (example calculation)
    const files = await ctx.db
      .query("usageEvents")
      .withIndex("byUserId", (q: any) => q.eq("userId", args.userId))
      .collect();
    const storageUsedBytes = 0; // files.reduce((sum, file) => sum + (file.sizeBytes || 0), 0);
    const storageUsedGB = storageUsedBytes / (1024 * 1024 * 1024);

    // Get API calls this month
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const apiCalls = await ctx.db
      .query("usageEvents")
      .withIndex("byUserId", (q) => q.eq("userId", args.userId))
      .filter((q: any) => 
        q.and(
          q.eq(q.field("eventType"), "api_call"),
          q.gte(q.field("createdAt"), startOfMonth.toISOString())
        )
      )
      .collect();

    return {
      projectsCount: projects.length,
      teamMembersCount,
      storageUsedGB: Math.round(storageUsedGB * 100) / 100, // Round to 2 decimals
      apiCallsThisMonth: apiCalls.length,
    };
  },
});

export const incrementApiCalls = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    // This could be optimized with a counter table for better performance
    // For now, we're tracking via usage events
    const timestamp = new Date().toISOString();
    
    // Optionally, maintain a monthly counter
    const counterKey = `api_calls_${args.userId}_${new Date().getFullYear()}_${new Date().getMonth()}`;
    
    const counter = await ctx.db
      .query("billingSettings")
      .withIndex("byKey", (q: any) => q.eq("key", counterKey))
      .first();

    if (counter) {
      await ctx.db.patch(counter._id, {
        value: (counter.value as number) + 1,
        updatedAt: timestamp,
      });
    } else {
      await ctx.db.insert("billingSettings", {
        key: counterKey,
        value: 1,
        updatedAt: timestamp,
      });
    }
  },
});

// ====================================
// UPGRADE PROMPTS & SUGGESTIONS
// ====================================

export const getUpgradePrompt = query({
  args: {
    context: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<any> => {
    const profile: any = await ctx.runQuery(api.usersWithBilling.getCurrentUserProfile, {});
    if (!profile) return null;

    // Already on highest plan
    if (profile.plan === "premiumPlus") {
      return null;
    }

    const { usage, limits }: any = profile;
    const prompts = [];

    // Check if approaching limits
    if (limits.maxProjects > 0 && usage.projectsCount >= limits.maxProjects * 0.8) {
      prompts.push({
        type: "approaching_limit",
        message: `You're using ${usage.projectsCount} of ${limits.maxProjects} projects`,
        severity: usage.projectsCount >= limits.maxProjects ? "high" : "medium",
      });
    }

    if (limits.maxTeamMembers > 0 && usage.teamMembersCount >= limits.maxTeamMembers * 0.8) {
      prompts.push({
        type: "approaching_limit",
        message: `You have ${usage.teamMembersCount} of ${limits.maxTeamMembers} team members`,
        severity: usage.teamMembersCount >= limits.maxTeamMembers ? "high" : "medium",
      });
    }

    if (limits.maxStorageGB > 0 && usage.storageUsedGB >= limits.maxStorageGB * 0.8) {
      prompts.push({
        type: "approaching_limit",
        message: `Using ${usage.storageUsedGB}GB of ${limits.maxStorageGB}GB storage`,
        severity: usage.storageUsedGB >= limits.maxStorageGB ? "high" : "medium",
      });
    }

    // Context-specific prompts
    if (args.context) {
      const missingFeatures = Object.entries(PLAN_LIMITS[profile.plan as keyof typeof PLAN_LIMITS].features)
        .filter(([_, enabled]) => !enabled)
        .map(([feature]) => feature);

      if (args.context === "custom_domain" && !profile.features.customDomain) {
        prompts.push({
          type: "feature_locked",
          message: "Custom domains are available on Premium plans",
          severity: "info",
          suggestedPlan: "premium",
        });
      }

      if (args.context === "sso" && !profile.features.ssoAuth) {
        prompts.push({
          type: "feature_locked",
          message: "SSO authentication is available on Premium Plus",
          severity: "info",
          suggestedPlan: "premiumPlus",
        });
      }
    }

    if (prompts.length === 0) return null;

    return {
      prompts,
      currentPlan: profile.plan,
      suggestedPlan: profile.plan === "free" ? "premium" : "premiumPlus",
      upgradeUrl: `/billing/upgrade`,
    };
  },
});