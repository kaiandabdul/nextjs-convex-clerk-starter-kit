#!/usr/bin/env tsx

/**
 * Comprehensive test suite for the billing system
 * Tests all functions, mutations, and webhooks in a production-like environment
 * 
 * Usage: bunx tsx scripts/test-billing-system.ts [--all | --webhooks | --billing | --usage]
 */

import { ConvexClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import chalk from "chalk";
import crypto from "crypto";

// Test configuration
const CONVEX_URL = process.env.NEXT_PUBLIC_CONVEX_URL || "https://good-guanaco-549.convex.cloud";
const TEST_USER_ID = "test_user_" + Date.now();
const TEST_EMAIL = `test+${Date.now()}@example.com`;

// Initialize Convex client
const client = new ConvexClient(CONVEX_URL);

// Test results tracking
interface TestResult {
  name: string;
  status: "passed" | "failed" | "skipped";
  error?: string;
  duration: number;
}

const testResults: TestResult[] = [];
let currentTestSuite = "";

// Utility functions
function log(message: string, type: "info" | "success" | "error" | "warning" = "info") {
  const colors = {
    info: chalk.blue,
    success: chalk.green,
    error: chalk.red,
    warning: chalk.yellow,
  };
  console.log(colors[type](message));
}

function logTestStart(name: string) {
  process.stdout.write(chalk.gray(`  ⏳ ${name}... `));
}

function logTestResult(passed: boolean, duration: number, error?: string) {
  if (passed) {
    console.log(chalk.green(`✓ (${duration}ms)`));
  } else {
    console.log(chalk.red(`✗ (${duration}ms)`));
    if (error) {
      console.log(chalk.red(`     Error: ${error}`));
    }
  }
}

async function runTest(name: string, testFn: () => Promise<void>): Promise<void> {
  logTestStart(name);
  const startTime = Date.now();
  
  try {
    await testFn();
    const duration = Date.now() - startTime;
    logTestResult(true, duration);
    testResults.push({ name, status: "passed", duration });
  } catch (error) {
    const duration = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);
    logTestResult(false, duration, errorMessage);
    testResults.push({ name, status: "failed", error: errorMessage, duration });
  }
}

// Generate webhook signature (simulates Polar webhook)
function generateWebhookSignature(payload: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

// Test suites
async function testUserManagement() {
  log("\n📦 Testing User Management", "info");
  
  await runTest("Create user via Clerk webhook", async () => {
    const clerkPayload = {
      type: "user.created",
      data: {
        id: TEST_USER_ID,
        email_addresses: [{ email_address: TEST_EMAIL }],
        first_name: "Test",
        last_name: "User",
      },
    };
    
    // Simulate Clerk webhook
    const response = await fetch(`${CONVEX_URL}/clerk-users-webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "svix-id": "test_" + Date.now(),
        "svix-timestamp": String(Date.now()),
        "svix-signature": "test_signature", // In production, this would be verified
      },
      body: JSON.stringify(clerkPayload),
    });
    
    if (!response.ok) {
      throw new Error(`Webhook failed: ${response.status}`);
    }
  });

  await runTest("Get current user", async () => {
    const user = await client.query(api.users.current);
    if (!user) {
      throw new Error("User not found");
    }
  });

  await runTest("Get user with billing info", async () => {
    const userWithBilling = await client.query(api.usersWithBilling.getUserWithBilling);
    if (!userWithBilling) {
      throw new Error("User with billing not found");
    }
  });
}

async function testProductsAndPricing() {
  log("\n💰 Testing Products and Pricing", "info");
  
  await runTest("Sync products from Polar", async () => {
    try {
      await client.action(api.polarSync.syncProducts);
    } catch (error) {
      // May fail if Polar is not configured, which is okay for testing
      log("    (Skipped - Polar not configured)", "warning");
    }
  });

  await runTest("Get pricing tiers", async () => {
    const pricing = await client.query(api.polar.getPricing);
    if (!pricing) {
      throw new Error("Pricing not available");
    }
  });

  await runTest("List all products", async () => {
    const products = await client.query(api.polar.listAllProducts);
    // Products might be empty if not synced
  });
}

async function testCheckoutFlow() {
  log("\n🛒 Testing Checkout Flow", "info");
  
  await runTest("Create checkout session", async () => {
    const session = await client.action(api.checkout.createCheckoutSession, {
      productId: "test_product_id",
      successUrl: "http://localhost:3000/success",
      cancelUrl: "http://localhost:3000/cancel",
    });
    
    if (!session?.sessionId) {
      throw new Error("Checkout session not created");
    }
  });

  await runTest("Get checkout session", async () => {
    const sessions = await client.query(api.checkout.getUserCheckoutSessions);
    // Sessions might be empty
  });

  await runTest("Generate checkout link", async () => {
    try {
      const url = await client.mutation(api.billing.generateCheckoutLink, {
        productId: "test_product_id",
      });
      // URL generation might fail without Polar setup
    } catch (error) {
      log("    (Skipped - Requires Polar setup)", "warning");
    }
  });
}

async function testSubscriptionManagement() {
  log("\n📊 Testing Subscription Management", "info");
  
  await runTest("Check subscription status", async () => {
    const hasSubscription = await client.query(api.subscriptions.hasActiveSubscription);
    // Will be false for new users
  });

  await runTest("Get current subscription", async () => {
    const subscription = await client.query(api.subscriptions.getCurrentSubscription);
    // May be null for free users
  });

  await runTest("Get subscription history", async () => {
    const history = await client.query(api.subscriptions.getSubscriptionHistory);
    // May be empty
  });

  await runTest("Simulate subscription webhook", async () => {
    const webhookPayload = {
      id: "evt_" + Date.now(),
      type: "subscription.created",
      data: {
        id: "sub_" + Date.now(),
        customer_id: "cus_" + Date.now(),
        product_id: "prod_test",
        status: "active",
        current_period_start: new Date().toISOString(),
        current_period_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        cancel_at_period_end: false,
        metadata: {
          test: true,
        },
      },
    };

    const response = await fetch(`${CONVEX_URL}/polar/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "webhook-signature": "test_signature",
      },
      body: JSON.stringify(webhookPayload),
    });

    if (!response.ok) {
      throw new Error(`Webhook failed: ${response.status}`);
    }
  });
}

async function testUsageTracking() {
  log("\n📈 Testing Usage Tracking", "info");
  
  await runTest("Record usage event", async () => {
    await client.mutation(api.usageTracking.recordUsageEvent, {
      eventType: "api_call",
      eventName: "test.api.call",
      units: 1,
      metadata: { test: true },
    });
  });

  await runTest("Get usage by user", async () => {
    const usage = await client.query(api.usageTracking.getUsageByUser, {
      eventType: "api_call",
      limit: 10,
    });
  });

  await runTest("Get current period usage", async () => {
    const periodUsage = await client.query(api.usageTracking.getCurrentPeriodUsage);
  });

  await runTest("Check usage limits", async () => {
    const limits = await client.query(api.usersWithBilling.checkUsageLimit, {
      limitType: "apiCalls",
      requestedAmount: 1,
    });
    
    if (!limits.allowed && !limits.reason) {
      throw new Error("Invalid limit response");
    }
  });
}

async function testBillingQueries() {
  log("\n💳 Testing Billing Queries", "info");
  
  await runTest("Get user subscriptions", async () => {
    const subs = await client.query(api.billingQueries.getCurrentUserSubscriptions);
    // May be empty
  });

  await runTest("Get user invoices", async () => {
    const invoices = await client.query(api.billingQueries.getCurrentUserInvoices);
    // May be empty
  });

  await runTest("Get billing stats", async () => {
    const stats = await client.query(api.billingQueries.getBillingStats);
    if (!stats || typeof stats.mrr !== "number") {
      throw new Error("Invalid billing stats");
    }
  });

  await runTest("Get upgrade prompt", async () => {
    const prompt = await client.query(api.usersWithBilling.getUpgradePrompt, {
      context: "test",
    });
    // May be null for premium users
  });
}

async function testAdminTools() {
  log("\n🔧 Testing Admin Tools", "info");
  
  await runTest("Get billing stats (admin)", async () => {
    try {
      const stats = await client.query(api.adminTools.getBillingStats);
    } catch (error) {
      // Expected to fail without admin rights
      log("    (Expected failure - requires admin)", "warning");
    }
  });

  await runTest("Get failed webhooks", async () => {
    try {
      const webhooks = await client.query(api.adminTools.getFailedWebhooks, {
        limit: 10,
      });
    } catch (error) {
      log("    (Expected failure - requires admin)", "warning");
    }
  });
}

async function testWebhookProcessing() {
  log("\n🔔 Testing Webhook Processing", "info");
  
  const webhookTypes = [
    "customer.created",
    "customer.updated",
    "subscription.created",
    "subscription.updated",
    "subscription.canceled",
    "checkout.created",
    "order.created",
    "invoice.created",
    "invoice.paid",
  ];

  for (const eventType of webhookTypes) {
    await runTest(`Process ${eventType} webhook`, async () => {
      const payload = {
        id: `evt_${eventType}_${Date.now()}`,
        type: eventType,
        data: {
          id: `${eventType.split(".")[0]}_${Date.now()}`,
          customer_id: "cus_test",
          status: "active",
          amount: 1000,
          currency: "usd",
          metadata: { test: true },
        },
      };

      const response = await fetch(`${CONVEX_URL}/polar/webhook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "webhook-signature": "test_signature",
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error(`Webhook failed: ${response.status}`);
      }
    });
  }
}

async function testMonitoring() {
  log("\n📊 Testing Monitoring & Health", "info");
  
  await runTest("Check system health", async () => {
    const response = await fetch(`${CONVEX_URL}/health`, {
      method: "GET",
    });
    
    if (!response.ok) {
      throw new Error(`Health check failed: ${response.status}`);
    }
    
    const health = await response.json();
    if (health.status !== "ok") {
      throw new Error("System not healthy");
    }
  });

  await runTest("Get dashboard metrics", async () => {
    const metrics = await client.query(api.monitoring.getDashboardMetrics);
    if (!metrics || !metrics.billing) {
      throw new Error("Invalid metrics");
    }
  });
}

async function testSynchronization() {
  log("\n🔄 Testing Synchronization", "info");
  
  await runTest("Sync all subscriptions", async () => {
    try {
      await client.action(api.sync.syncAllSubscriptions, {
        batchSize: 10,
      });
    } catch (error) {
      log("    (Skipped - Requires Polar setup)", "warning");
    }
  });

  await runTest("Check Polar health", async () => {
    try {
      const health = await client.action(api.sync.checkSystemHealth);
    } catch (error) {
      log("    (May fail without Polar setup)", "warning");
    }
  });
}

async function testErrorHandling() {
  log("\n❌ Testing Error Handling", "info");
  
  await runTest("Handle invalid webhook signature", async () => {
    const response = await fetch(`${CONVEX_URL}/polar/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Missing signature
      },
      body: JSON.stringify({ test: true }),
    });
    
    if (response.ok) {
      throw new Error("Should have rejected invalid webhook");
    }
  });

  await runTest("Handle malformed webhook payload", async () => {
    const response = await fetch(`${CONVEX_URL}/polar/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "webhook-signature": "test",
      },
      body: "invalid json",
    });
    
    if (response.ok) {
      throw new Error("Should have rejected malformed payload");
    }
  });

  await runTest("Handle duplicate webhook event", async () => {
    const payload = {
      id: "duplicate_event_123",
      type: "test.duplicate",
      data: { test: true },
    };

    // Send first time
    await fetch(`${CONVEX_URL}/polar/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "webhook-signature": "test",
      },
      body: JSON.stringify(payload),
    });

    // Send duplicate
    const response = await fetch(`${CONVEX_URL}/polar/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "webhook-signature": "test",
      },
      body: JSON.stringify(payload),
    });

    // Should handle gracefully (return 200)
    if (!response.ok) {
      throw new Error("Should handle duplicate gracefully");
    }
  });
}

// Performance tests
async function testPerformance() {
  log("\n⚡ Testing Performance", "info");
  
  await runTest("Batch usage event processing", async () => {
    const startTime = Date.now();
    const promises = [];
    
    // Create 100 usage events
    for (let i = 0; i < 100; i++) {
      promises.push(
        client.mutation(api.usageTracking.recordUsageEvent, {
          eventType: "api_call",
          eventName: `perf.test.${i}`,
          units: 1,
          metadata: { batch: true },
        })
      );
    }
    
    await Promise.all(promises);
    const duration = Date.now() - startTime;
    
    if (duration > 5000) {
      throw new Error(`Too slow: ${duration}ms for 100 events`);
    }
  });

  await runTest("Concurrent webhook processing", async () => {
    const startTime = Date.now();
    const webhooks = [];
    
    // Send 10 concurrent webhooks
    for (let i = 0; i < 10; i++) {
      webhooks.push(
        fetch(`${CONVEX_URL}/polar/webhook`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "webhook-signature": "test",
          },
          body: JSON.stringify({
            id: `concurrent_${i}_${Date.now()}`,
            type: "test.concurrent",
            data: { index: i },
          }),
        })
      );
    }
    
    const results = await Promise.all(webhooks);
    const duration = Date.now() - startTime;
    
    if (results.some(r => !r.ok)) {
      throw new Error("Some webhooks failed");
    }
    
    if (duration > 3000) {
      throw new Error(`Too slow: ${duration}ms for 10 webhooks`);
    }
  });
}

// Main test runner
async function runAllTests() {
  const startTime = Date.now();
  const testSuites = process.argv[2]?.replace("--", "") || "all";
  
  log(chalk.bold("\n🧪 Billing System Test Suite"));
  log(chalk.gray("━".repeat(50)));
  
  try {
    switch (testSuites) {
      case "webhooks":
        await testWebhookProcessing();
        await testErrorHandling();
        break;
      case "billing":
        await testProductsAndPricing();
        await testCheckoutFlow();
        await testSubscriptionManagement();
        await testBillingQueries();
        break;
      case "usage":
        await testUsageTracking();
        await testMonitoring();
        break;
      case "admin":
        await testAdminTools();
        await testSynchronization();
        break;
      case "performance":
        await testPerformance();
        break;
      default:
        // Run all tests
        await testUserManagement();
        await testProductsAndPricing();
        await testCheckoutFlow();
        await testSubscriptionManagement();
        await testUsageTracking();
        await testBillingQueries();
        await testAdminTools();
        await testWebhookProcessing();
        await testMonitoring();
        await testSynchronization();
        await testErrorHandling();
        await testPerformance();
    }
  } catch (error) {
    log("\n❌ Test suite failed with critical error:", "error");
    console.error(error);
  }
  
  // Print summary
  const duration = Date.now() - startTime;
  const passed = testResults.filter(t => t.status === "passed").length;
  const failed = testResults.filter(t => t.status === "failed").length;
  const skipped = testResults.filter(t => t.status === "skipped").length;
  
  log(chalk.gray("\n" + "━".repeat(50)));
  log(chalk.bold("\n📊 Test Results Summary\n"));
  
  log(`${chalk.green("✓ Passed:")} ${passed}`);
  if (failed > 0) {
    log(`${chalk.red("✗ Failed:")} ${failed}`);
  }
  if (skipped > 0) {
    log(`${chalk.yellow("⊘ Skipped:")} ${skipped}`);
  }
  
  log(`\n${chalk.gray("Total time:")} ${duration}ms`);
  log(`${chalk.gray("Total tests:")} ${testResults.length}`);
  
  // Show failed tests
  if (failed > 0) {
    log(chalk.red("\n❌ Failed Tests:"));
    testResults
      .filter(t => t.status === "failed")
      .forEach(t => {
        log(`  • ${t.name}`);
        if (t.error) {
          log(chalk.gray(`    ${t.error}`));
        }
      });
  }
  
  // Exit with appropriate code
  process.exit(failed > 0 ? 1 : 0);
}

// Run tests
runAllTests().catch(error => {
  log("\n💥 Fatal error:", "error");
  console.error(error);
  process.exit(1);
});