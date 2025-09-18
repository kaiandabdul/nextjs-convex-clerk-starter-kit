/**
 * Scheduled cron jobs for billing and sync tasks
 */

import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Sync subscriptions every 6 hours
crons.interval(
  "sync subscriptions",
  { hours: 6 },
  internal.sync.syncAllSubscriptions,
  { batchSize: 100 }
);

// Sync pending invoices every 30 minutes
crons.interval(
  "sync pending invoices",
  { minutes: 30 },
  internal.sync.syncPendingInvoices
);

// Process usage events every 5 minutes
crons.interval(
  "process usage events",
  { minutes: 5 },
  internal.usageTracking.processUsageEvents
);

// Reconcile billing data daily at 2 AM UTC
crons.daily(
  "reconcile billing",
  { hourUTC: 2, minuteUTC: 0 },
  internal.sync.reconcileBilling,
  { checkType: "subscriptions" }
);

// Clean up old records weekly at 3 AM UTC on Sunday
crons.weekly(
  "cleanup old records",
  { dayOfWeek: "sunday", hourUTC: 3, minuteUTC: 0 },
  internal.sync.cleanupOldRecords,
  { daysToKeep: 90 }
);

// Check system health every 10 minutes
crons.interval(
  "check system health",
  { minutes: 10 },
  internal.sync.checkSystemHealth
);

// Aggregate usage monthly on the 1st at midnight UTC
crons.monthly(
  "aggregate monthly usage",
  { day: 1, hourUTC: 0, minuteUTC: 0 },
  internal.usageTracking.aggregateMonthlyUsage
);

export default crons;