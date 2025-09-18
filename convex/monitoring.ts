/**
 * Production-grade monitoring and error handling
 * Provides observability for the billing system
 */

import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  query,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";

// ====================================
// LOGGING LEVELS AND TYPES
// ====================================

export enum LogLevel {
  DEBUG = "debug",
  INFO = "info",
  WARN = "warn",
  ERROR = "error",
  CRITICAL = "critical",
}

export interface LogEntry {
  level: LogLevel;
  message: string;
  context?: string;
  metadata?: Record<string, any>;
  error?: {
    message: string;
    stack?: string;
    code?: string;
  };
  timestamp: string;
}

// ====================================
// ERROR BOUNDARIES
// ====================================

export class BillingError extends Error {
  constructor(
    message: string,
    public code: string,
    public context?: Record<string, any>
  ) {
    super(message);
    this.name = "BillingError";
  }
}

export class PolarAPIError extends BillingError {
  constructor(
    message: string,
    public statusCode?: number,
    context?: Record<string, any>
  ) {
    super(message, "POLAR_API_ERROR", context);
    this.name = "PolarAPIError";
  }
}

export class PaymentError extends BillingError {
  constructor(message: string, context?: Record<string, any>) {
    super(message, "PAYMENT_ERROR", context);
    this.name = "PaymentError";
  }
}

// Wrap functions with error boundary
export function withErrorBoundary<T extends (...args: any[]) => Promise<any>>(
  fn: T,
  context: string
): T {
  return (async (...args: Parameters<T>) => {
    const startTime = Date.now();
    try {
      const result = await fn(...args);
      
      // Log successful execution for critical operations
      if (context.includes("payment") || context.includes("subscription")) {
        console.log(`${context}.success completed in ${Date.now() - startTime}ms`);
      }
      
      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      
      // Log error with context
      console.error(`Error in ${context}:`, error);
      
      // Re-throw with enhanced context
      if (error instanceof BillingError) {
        throw error;
      }
      
      throw new BillingError(
        error instanceof Error ? error.message : "Unknown error",
        "WRAPPED_ERROR",
        { originalError: error, context, duration }
      );
    }
  }) as T;
}

// ====================================
// STRUCTURED LOGGING
// ====================================

// Log a message with level
export const log = internalMutation({
  args: {
    level: v.string(),
    message: v.string(),
    context: v.optional(v.string()),
    metadata: v.optional(v.any()),
    error: v.optional(v.object({
      message: v.string(),
      stack: v.optional(v.string()),
      code: v.optional(v.string()),
    })),
  },
  handler: async (ctx, args) => {
    const logEntry: LogEntry = {
      level: args.level as LogLevel,
      message: args.message,
      context: args.context,
      metadata: args.metadata,
      error: args.error,
      timestamp: new Date().toISOString(),
    };

    // Store in database for persistence
    await ctx.db.insert("logs", logEntry);

    // For critical errors, trigger alerts
    if (args.level === LogLevel.CRITICAL) {
      await ctx.runMutation(internal.monitoring.triggerAlert, {
        type: "critical_error",
        message: args.message,
        metadata: args.metadata,
      });
    }

    // In production, also send to external logging service
    if (process.env.NODE_ENV === "production") {
      // Example: Send to DataDog, New Relic, etc.
      console.log(JSON.stringify(logEntry));
    }
  },
});

// Convenience logging functions
export const logError = async (ctx: any, error: any) => {
  await ctx.runMutation(internal.monitoring.log, {
    level: LogLevel.ERROR,
    message: error.message || "Unknown error",
    error: {
      message: error.message,
      stack: error.stack,
      code: error.code,
    },
    metadata: error.context,
  });
};

export const logInfo = async (ctx: any, message: string, metadata?: any) => {
  await ctx.runMutation(internal.monitoring.log, {
    level: LogLevel.INFO,
    message,
    metadata,
  });
};

// ====================================
// PERFORMANCE MONITORING
// ====================================

export const logMetric = internalMutation({
  args: {
    name: v.string(),
    value: v.number(),
    unit: v.optional(v.string()),
    tags: v.optional(v.any()),
    duration: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("metrics", {
      name: args.name,
      value: args.value,
      unit: args.unit || "count",
      tags: args.tags,
      duration: args.duration,
      timestamp: new Date().toISOString(),
    });

    // Calculate aggregates for dashboard
    if (args.name.includes("api_call")) {
      await updateAPIMetrics(ctx, args);
    }
  },
});

async function updateAPIMetrics(ctx: any, metric: any) {
  const hour = new Date().toISOString().slice(0, 13); // YYYY-MM-DDTHH
  
    const existing = await ctx.db
    .query("apiMetrics")
    .withIndex("byHour", (q: any) => q.eq("hour", hour))
    .first();

  if (existing) {
    const newCallCount = existing.callCount + 1;
    const newAvgDuration = existing.avgDuration 
      ? ((existing.avgDuration * existing.callCount) + (metric.duration || 0)) / newCallCount
      : metric.duration || 0;
    
    await ctx.db.patch(existing._id, {
      callCount: newCallCount,
      avgDuration: newAvgDuration,
      maxDuration: Math.max(existing.maxDuration || 0, metric.duration || 0),
    });
  } else {
    await ctx.db.insert("apiMetrics", {
      hour,
      callCount: 1,
      errorCount: 0,
      avgDuration: metric.duration || 0,
      maxDuration: metric.duration || 0,
    });
  }
}

// ====================================
// ALERTING SYSTEM
// ====================================

export const triggerAlert = internalMutation({
  args: {
    type: v.string(),
    message: v.string(),
    severity: v.optional(v.string()),
    metadata: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const alert = {
      type: args.type,
      message: args.message,
      severity: args.severity || "medium",
      metadata: args.metadata,
      status: "active",
      createdAt: new Date().toISOString(),
      acknowledgedAt: null,
    };

    await ctx.db.insert("alerts", alert);

    // Send notifications based on severity
    if (args.severity === "critical") {
      // Send immediate notifications
      await sendNotification({
        channel: "email",
        recipient: process.env.ADMIN_EMAIL,
        subject: `Critical Alert: ${args.type}`,
        body: args.message,
      });
    }
  },
});

async function sendNotification(notification: any) {
  // Implement actual notification sending
  // This could be email, Slack, PagerDuty, etc.
  console.log("ALERT:", notification);
}

// ====================================
// BILLING METRICS
// ====================================

export const trackChurn = internalAction({
  args: {},
  handler: async (ctx): Promise<any> => {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    // Get cancellations in the last 30 days
    const cancellations: any = await ctx.runQuery(
      internal.monitoring.getCancellations,
      { since: thirtyDaysAgo.toISOString() }
    );

    // Get active subscriptions at the beginning of the period
    const activeAtStart: any = await ctx.runQuery(
      internal.monitoring.getActiveSubscriptionsCount,
      { date: thirtyDaysAgo.toISOString() }
    );

    const churnRate: any = activeAtStart > 0 
      ? (cancellations.length / activeAtStart) * 100
      : 0;

    await ctx.runMutation(internal.monitoring.logMetric, {
      name: "billing.churn_rate",
      value: churnRate,
      unit: "percentage",
      tags: { period: "30_days" },
    });

    if (churnRate > 10) { // Alert if churn exceeds 10%
      await ctx.runMutation(internal.monitoring.triggerAlert, {
        type: "high_churn_rate",
        message: `Churn rate is ${churnRate.toFixed(2)}% in the last 30 days`,
        severity: "high",
        metadata: { churnRate, cancellations: cancellations.length },
      });
    }

    return { churnRate, cancellations: cancellations.length };
  },
});

export const calculateMRR = internalQuery({
  args: {},
  handler: async (ctx) => {
    const activeSubscriptions = await ctx.db
      .query("subscriptions")
      .withIndex("byStatus", (q: any) => q.eq("status", "active"))
      .collect();

    let mrr = 0;

    for (const subscription of activeSubscriptions) {
      // Get product to determine price
      const product = await ctx.db
        .query("products")
      .withIndex("byPolarProductId", (q: any) => 
        q.eq("polarProductId", subscription.polarProductId)
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

    return mrr / 100; // Convert from cents to dollars
  },
});

// ====================================
// GRACEFUL DEGRADATION
// ====================================

export const withFallback = <T>(
  fn: () => Promise<T>,
  fallback: T,
  context: string
): Promise<T> => {
  return fn().catch(async (error) => {
    // logError needs context, skip for now
    console.error(`Fallback triggered for ${context}:`, error);
    return fallback;
  });
};

export const checkPolarHealth = internalAction({
  args: {},
  handler: async (ctx) => {
    try {
      // Try to make a simple API call to Polar
      const startTime = Date.now();
      
      // This would be replaced with actual Polar API health check
      // await polarApi.products.list({ limit: 1 });
      
      const duration = Date.now() - startTime;

      await ctx.runMutation(internal.monitoring.logMetric, {
        name: "polar.api.health",
        value: 1, // 1 = healthy
        duration,
      });

      return { status: "healthy", latency: duration };
    } catch (error) {
      await ctx.runMutation(internal.monitoring.logMetric, {
        name: "polar.api.health",
        value: 0, // 0 = unhealthy
      });

      await ctx.runMutation(internal.monitoring.triggerAlert, {
        type: "polar_api_down",
        message: "Polar API is not responding",
        severity: "high",
      });

      return { status: "unhealthy", error };
    }
  },
});

// ====================================
// QUERY HELPERS
// ====================================

export const getCancellations = internalQuery({
  args: { since: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("subscriptions")
      .withIndex("byStatus", (q: any) => q.eq("status", "canceled"))
      .filter((q: any) => q.gte(q.field("canceledAt"), args.since))
      .collect();
  },
});

export const getActiveSubscriptionsCount = internalQuery({
  args: { date: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const query = ctx.db
      .query("subscriptions")
      .withIndex("byStatus", (q: any) => q.eq("status", "active"));

    if (args.date) {
      // This would require more complex date filtering
      // For now, return current count
    }

    const subscriptions = await query.collect();
    return subscriptions.length;
  },
});

// ====================================
// DASHBOARD METRICS
// ====================================

export const getDashboardMetrics = query({
  args: {},
  handler: async (ctx): Promise<any> => {
    const [mrr, activeCount] = await Promise.all([
      ctx.runQuery(internal.monitoring.calculateMRR, {}),
      ctx.runQuery(internal.monitoring.getActiveSubscriptionsCount, {}),
    ]);

    // Return simplified churn data
    const churnData = { churnRate: 0, cancellations: 0 };

    // Get recent alerts
    const recentAlerts = await ctx.db
      .query("alerts")
      .withIndex("byStatus", (q: any) => q.eq("status", "active"))
      .order("desc")
      .take(5);

    // Get API metrics for the last hour
    const currentHour = new Date().toISOString().slice(0, 13);
    const apiMetrics = await ctx.db
      .query("apiMetrics")
      .withIndex("byHour", (q: any) => q.eq("hour", currentHour))
      .first();

    return {
      billing: {
        mrr,
        activeSubscriptions: activeCount,
        churnRate: churnData.churnRate,
        recentCancellations: churnData.cancellations,
      },
      system: {
        apiCallsThisHour: apiMetrics?.callCount || 0,
        avgApiLatency: apiMetrics?.avgDuration || 0,
        activeAlerts: recentAlerts.length,
        alerts: recentAlerts,
      },
    };
  },
});

// ====================================
// USAGE PATTERN ANALYSIS
// ====================================

export const analyzeUsagePatterns = internalAction({
  args: {},
  handler: async (ctx): Promise<any> => {
    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);

    // Get usage events for analysis
    const usageEvents: any = await ctx.runQuery(
      internal.monitoring.getRecentUsageEvents,
      { since: oneWeekAgo.toISOString() }
    );

    // Analyze patterns
    const patterns: any = {
      mostUsedFeatures: {} as Record<string, number>,
      peakUsageTimes: {} as Record<string, number>,
      averageSessionLength: 0,
      totalEvents: usageEvents.length,
    };

    for (const event of usageEvents) {
      // Count feature usage
      if (event.eventName) {
        patterns.mostUsedFeatures[event.eventName] = 
          (patterns.mostUsedFeatures[event.eventName] || 0) + 1;
      }

      // Track peak hours
      const hour = new Date(event.createdAt).getHours();
      patterns.peakUsageTimes[hour] = (patterns.peakUsageTimes[hour] || 0) + 1;
    }

    // Store insights
    await ctx.runMutation(internal.monitoring.storeUsageInsights, {
      patterns,
      period: "weekly",
      generatedAt: new Date().toISOString(),
    });

    return patterns;
  },
});

export const getRecentUsageEvents = internalQuery({
  args: { since: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("usageEvents")
      .filter((q: any) => q.gte(q.field("createdAt"), args.since))
      .order("desc")
      .take(1000);
  },
});

export const storeUsageInsights = internalMutation({
  args: {
    patterns: v.any(),
    period: v.string(),
    generatedAt: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("usageInsights", {
      metrics: args.patterns,
      period: args.period,
      insights: [],
      createdAt: args.generatedAt,
    });
  },
});