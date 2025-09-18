import { Polar } from "@convex-dev/polar";
import { api, components } from "./_generated/api";
import { QueryCtx, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { Id } from "./_generated/dataModel";
import { api as fullApi } from "./_generated/api";

export const polar = new Polar(components.polar, {
  // Configure via env for production readiness
  organizationToken: process.env.POLAR_ORGANIZATION_TOKEN,
  webhookSecret: process.env.POLAR_WEBHOOK_SECRET,
  server:
    (process.env.POLAR_SERVER as "sandbox" | "production" | undefined) ??
    undefined,
  getUserInfo: async (ctx): Promise<{ userId: Id<"users">; email: string }> => {
    const user: Doc<"users"> | null = await ctx.runQuery(api.users.current, {});
    if (!user) throw new Error("Not authenticated");
    return {
      userId: user._id,
      email: user.email,
    };
  },

  // These can be configured in code or via environment variables
  // organizationToken: "your_organization_token", // Or use POLAR_ORGANIZATION_TOKEN env var
  // webhookSecret: "your_webhook_secret", // Or use POLAR_WEBHOOK_SECRET env var
  // server: "sandbox", // "sandbox" or "production", falls back to POLAR_SERVER env var
});

// Example usage flags retained for convenience; adjust to your needs
export const MAX_FREE_TODOS = 3;
export const MAX_PREMIUM_TODOS = 6;

export const {
  // Lists all non-archived products, fetched from Polar
  listAllProducts,
  // Generates a checkout link for the given product IDs.
  generateCheckoutLink,
  // Generates a customer portal URL for the current user.
  generateCustomerPortalUrl,
  // Changes the current subscription to the given product ID.
  changeCurrentSubscription,
  // Cancels the current subscription.
  cancelCurrentSubscription,
} = polar.api();

// Curated pricing for UI: splits products by recurring interval
export const getPricing = query({
  args: {},
  handler: async (ctx) => {
    const products = await polar.listProducts(ctx, { includeArchived: false });
    const monthly = products.filter((p) => p.recurringInterval === "month");
    const yearly = products.filter((p) => p.recurringInterval === "year");
    return { monthly, yearly };
  },
});

type CurrentUser = Doc<"users"> & {
  isFree: boolean;
  isPremium: boolean;
  isPremiumPlus: boolean;
  subscription: Awaited<ReturnType<typeof polar.getCurrentSubscription>>;
  maxTodos: number | undefined;
};

const currentUser = async (ctx: QueryCtx): Promise<CurrentUser> => {
  const user: Doc<"users"> | null = await ctx.runQuery(
    fullApi.users.current,
    {}
  );
  if (!user) throw new Error("Not authenticated");
  const subscription = await polar.getCurrentSubscription(ctx, {
    userId: user._id,
  });
  // Keep simple tier flags without hardcoding product IDs here
  const productKey = subscription?.productKey;
  const isPremium =
    productKey === "premiumMonthly" || productKey === "premiumYearly";
  const isPremiumPlus =
    productKey === "premiumPlusMonthly" || productKey === "premiumPlusYearly";
  return {
    ...user,
    isFree: !isPremium && !isPremiumPlus,
    isPremium,
    isPremiumPlus,
    subscription,
    maxTodos:
      isPremiumPlus ? undefined
      : isPremium ? MAX_PREMIUM_TODOS
      : MAX_FREE_TODOS,
  };
};

// Query that returns our pseudo user.
export const getCurrentUser = query({
  handler: async (ctx): Promise<CurrentUser> => currentUser(ctx),
});

// Removed example todo CRUD in favor of production billing setup
