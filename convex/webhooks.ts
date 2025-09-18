/**
 * Webhook handlers for Polar events
 * Processes webhooks with idempotency and error handling
 */

import { v } from "convex/values";
import { httpAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { verifyWebhookSignature } from "./lib/polar";
import type { Doc } from "./_generated/dataModel";

// Main webhook handler
export const handlePolarWebhook = httpAction(async (ctx, request) => {
  try {
    // Get raw body
    const rawBody = await request.text();
    
    // Get signature header
    const signature = request.headers.get("x-webhook-signature") || 
                     request.headers.get("x-polar-signature") || "";
    
    if (!signature) {
      return new Response("Missing signature", { status: 401 });
    }

    // Verify signature
    const webhookSecret = process.env.POLAR_WEBHOOK_SECRET;
    if (!webhookSecret) {
      console.error("POLAR_WEBHOOK_SECRET not configured");
      return new Response("Webhook secret not configured", { status: 500 });
    }

    const isValid = verifyWebhookSignature(rawBody, signature, webhookSecret);
    if (!isValid) {
      return new Response("Invalid signature", { status: 401 });
    }

    // Parse payload
    const payload = JSON.parse(rawBody);
    const eventId = payload.id || `${payload.type}_${Date.now()}`;
    const eventType = payload.type;

    // Check for idempotency
    const existingEvent = await ctx.runQuery(
      internal.webhooks.getWebhookEventById,
      { eventId }
    );

    if (existingEvent) {
      console.log(`Webhook event ${eventId} already processed`);
      return new Response("OK", { status: 200 });
    }

    // Store webhook event
    await ctx.runMutation(internal.webhooks.storeWebhookEvent, {
      eventId,
      eventType,
      source: "polar",
      payload,
      receivedAt: new Date().toISOString(),
    });

    // Process based on event type
    try {
      switch (eventType) {
        // Customer events
        case "customer.created":
          await handleCustomerCreated(ctx, payload);
          break;
        case "customer.updated":
          await handleCustomerUpdated(ctx, payload);
          break;

        // Subscription events
        case "subscription.created":
          await handleSubscriptionCreated(ctx, payload);
          break;
        case "subscription.updated":
          await handleSubscriptionUpdated(ctx, payload);
          break;
        case "subscription.active":
          await handleSubscriptionActive(ctx, payload);
          break;
        case "subscription.canceled":
          await handleSubscriptionCanceled(ctx, payload);
          break;
        case "subscription.revoked":
          await handleSubscriptionRevoked(ctx, payload);
          break;

        // Checkout events
        case "checkout.created":
          await handleCheckoutCreated(ctx, payload);
          break;
        case "checkout.updated":
          await handleCheckoutUpdated(ctx, payload);
          break;

        // Order events
        case "order.created":
          await handleOrderCreated(ctx, payload);
          break;

        // Invoice events  
        case "invoice.created":
          await handleInvoiceCreated(ctx, payload);
          break;
        case "invoice.paid":
          await handleInvoicePaid(ctx, payload);
          break;

        // Payment events
        case "payment_method.attached":
          await handlePaymentMethodAttached(ctx, payload);
          break;
        case "payment_method.detached":
          await handlePaymentMethodDetached(ctx, payload);
          break;

        default:
          console.log(`Unhandled webhook event type: ${eventType}`);
      }

      // Mark event as processed
      await ctx.runMutation(internal.webhooks.markWebhookEventProcessed, {
        eventId,
        processingResult: "success",
      });
    } catch (error) {
      console.error(`Error processing webhook ${eventType}:`, error);
      
      // Mark event as failed
      await ctx.runMutation(internal.webhooks.markWebhookEventProcessed, {
        eventId,
        processingResult: "error",
        error: error instanceof Error ? error.message : "Unknown error",
      });
      
      // Return 500 to trigger retry
      return new Response("Processing error", { status: 500 });
    }

    return new Response("OK", { status: 200 });
  } catch (error) {
    console.error("Webhook handler error:", error);
    return new Response("Internal error", { status: 500 });
  }
});

// Customer created
async function handleCustomerCreated(ctx: any, payload: any) {
  const customerData = payload.data;
  
  await ctx.runMutation(internal.customers.createCustomerFromWebhook, {
    polarCustomer: {
      id: customerData.id,
      email: customerData.email,
      email_verified: customerData.email_verified || false,
      metadata: customerData.metadata,
      created_at: customerData.created_at,
      modified_at: customerData.modified_at,
    },
  });
}

// Customer updated
async function handleCustomerUpdated(ctx: any, payload: any) {
  const customerData = payload.data;
  
  const customer = await ctx.runQuery(internal.customers.getCustomerByPolarId, {
    polarCustomerId: customerData.id,
  });

  if (customer) {
    await ctx.runMutation(internal.customers.updateCustomerFromPolar, {
      customerId: customer._id,
      polarCustomer: {
        id: customerData.id,
        email: customerData.email,
        email_verified: customerData.email_verified || false,
        metadata: customerData.metadata,
        created_at: customerData.created_at,
        modified_at: customerData.modified_at,
      },
    });
  }
}

// Subscription created
async function handleSubscriptionCreated(ctx: any, payload: any) {
  const subscriptionData = payload.data;
  
  // Get or create customer
  let customer = await ctx.runQuery(internal.customers.getCustomerByPolarId, {
    polarCustomerId: subscriptionData.customer_id,
  });

  if (!customer) {
    // Create customer if doesn't exist
    const customerId = await ctx.runMutation(
      internal.customers.createCustomerFromWebhook,
      {
        polarCustomer: {
          id: subscriptionData.customer_id,
          email: subscriptionData.customer_email || "",
          email_verified: false,
          created_at: new Date().toISOString(),
        },
      }
    );
    customer = await ctx.runQuery(internal.customers.getCustomerById, {
      customerId,
    });
  }

  if (customer) {
    await ctx.runMutation(internal.subscriptions.createSubscription, {
      customerId: customer._id,
      polarSubscriptionId: subscriptionData.id,
      polarProductId: subscriptionData.product_id,
      status: mapPolarStatus(subscriptionData.status),
      currentPeriodStart: subscriptionData.current_period_start,
      currentPeriodEnd: subscriptionData.current_period_end,
      trialStart: subscriptionData.trial_start,
      trialEnd: subscriptionData.trial_end,
      metadata: subscriptionData.metadata,
    });
  }
}

// Subscription updated
async function handleSubscriptionUpdated(ctx: any, payload: any) {
  const subscriptionData = payload.data;
  
  await ctx.runMutation(internal.subscriptions.updateSubscriptionFromWebhook, {
    polarSubscriptionId: subscriptionData.id,
    updates: {
      status: subscriptionData.status,
      currentPeriodStart: subscriptionData.current_period_start,
      currentPeriodEnd: subscriptionData.current_period_end,
      cancelAtPeriodEnd: subscriptionData.cancel_at_period_end,
      metadata: subscriptionData.metadata,
    },
  });
}

// Subscription activated
async function handleSubscriptionActive(ctx: any, payload: any) {
  const subscriptionData = payload.data;
  
  await ctx.runMutation(internal.subscriptions.updateSubscriptionFromWebhook, {
    polarSubscriptionId: subscriptionData.id,
    updates: {
      status: "active",
      currentPeriodStart: subscriptionData.current_period_start,
      currentPeriodEnd: subscriptionData.current_period_end,
    },
  });
}

// Subscription canceled
async function handleSubscriptionCanceled(ctx: any, payload: any) {
  const subscriptionData = payload.data;
  
  await ctx.runMutation(internal.subscriptions.updateSubscriptionFromWebhook, {
    polarSubscriptionId: subscriptionData.id,
    updates: {
      status: "canceled",
      canceledAt: subscriptionData.canceled_at || new Date().toISOString(),
      cancelAtPeriodEnd: subscriptionData.cancel_at_period_end,
      endedAt: subscriptionData.ended_at,
    },
  });
}

// Subscription revoked
async function handleSubscriptionRevoked(ctx: any, payload: any) {
  const subscriptionData = payload.data;
  
  await ctx.runMutation(internal.subscriptions.updateSubscriptionFromWebhook, {
    polarSubscriptionId: subscriptionData.id,
    updates: {
      status: "revoked",
      endedAt: subscriptionData.ended_at || new Date().toISOString(),
    },
  });
}

// Checkout created
async function handleCheckoutCreated(ctx: any, payload: any) {
  const checkoutData = payload.data;
  // Checkout sessions are created through our API, so this is informational
  console.log("Checkout created webhook received:", checkoutData.id);
}

// Checkout updated (completed)
async function handleCheckoutUpdated(ctx: any, payload: any) {
  const checkoutData = payload.data;
  
  if (checkoutData.status === "succeeded" || checkoutData.status === "completed") {
    await ctx.runMutation(internal.checkout.completeCheckoutSession, {
      polarCheckoutId: checkoutData.id,
      completedAt: new Date().toISOString(),
      metadata: {
        polarStatus: checkoutData.status,
      },
    });
  }
}

// Order created
async function handleOrderCreated(ctx: any, payload: any) {
  const orderData = payload.data;
  
  // Get customer
  const customer = await ctx.runQuery(internal.customers.getCustomerByPolarId, {
    polarCustomerId: orderData.customer_id,
  });

  if (customer) {
    await ctx.runMutation(internal.webhooks.createOrder, {
      customerId: customer._id,
      polarOrderId: orderData.id,
      polarCustomerId: orderData.customer_id,
      polarProductId: orderData.product_id,
      amount: orderData.amount,
      currency: orderData.currency,
      status: "pending",
      metadata: orderData.metadata,
    });
  }
}

// Invoice created
async function handleInvoiceCreated(ctx: any, payload: any) {
  const invoiceData = payload.data;
  
  // Get customer
  const customer = await ctx.runQuery(internal.customers.getCustomerByPolarId, {
    polarCustomerId: invoiceData.customer_id,
  });

  if (customer) {
    // Get subscription if exists
    const subscription = invoiceData.subscription_id
      ? await ctx.runQuery(internal.subscriptions.getSubscriptionByPolarId, {
          polarSubscriptionId: invoiceData.subscription_id,
        })
      : null;

    await ctx.runMutation(internal.webhooks.createInvoice, {
      customerId: customer._id,
      subscriptionId: subscription?._id,
      polarInvoiceId: invoiceData.id,
      invoiceNumber: invoiceData.number,
      amountDue: invoiceData.amount_due,
      currency: invoiceData.currency,
      status: invoiceData.status,
      dueDate: invoiceData.due_date,
      periodStart: invoiceData.period_start,
      periodEnd: invoiceData.period_end,
      metadata: invoiceData.metadata,
    });
  }
}

// Invoice paid
async function handleInvoicePaid(ctx: any, payload: any) {
  const invoiceData = payload.data;
  
  await ctx.runMutation(internal.webhooks.updateInvoiceStatus, {
    polarInvoiceId: invoiceData.id,
    status: "paid",
    paidAt: invoiceData.paid_at || new Date().toISOString(),
    amountPaid: invoiceData.amount_paid,
  });
}

// Payment method attached
async function handlePaymentMethodAttached(ctx: any, payload: any) {
  const paymentMethodData = payload.data;
  
  // Get customer
  const customer = await ctx.runQuery(internal.customers.getCustomerByPolarId, {
    polarCustomerId: paymentMethodData.customer_id,
  });

  if (customer && customer.userId) {
    await ctx.runMutation(internal.webhooks.createPaymentMethod, {
      userId: customer.userId,
      customerId: customer._id,
      polarPaymentMethodId: paymentMethodData.id,
      type: paymentMethodData.type,
      brand: paymentMethodData.card?.brand,
      last4: paymentMethodData.card?.last4,
      expMonth: paymentMethodData.card?.exp_month,
      expYear: paymentMethodData.card?.exp_year,
    });
  }
}

// Payment method detached
async function handlePaymentMethodDetached(ctx: any, payload: any) {
  const paymentMethodData = payload.data;
  
  await ctx.runMutation(internal.webhooks.deletePaymentMethod, {
    polarPaymentMethodId: paymentMethodData.id,
  });
}

// Helper to map Polar status to our status
function mapPolarStatus(polarStatus: string): Doc<"subscriptions">["status"] {
  const statusMap: Record<string, Doc<"subscriptions">["status"]> = {
    incomplete: "incomplete",
    incomplete_expired: "incomplete_expired",
    trialing: "trialing",
    active: "active",
    past_due: "past_due",
    canceled: "canceled",
    unpaid: "unpaid",
  };
  return statusMap[polarStatus] || "revoked";
}

// Internal mutations for webhook processing

export const getWebhookEventById = internalQuery({
  args: { eventId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("webhookEvents")
      .withIndex("byEventId", (q) => q.eq("eventId", args.eventId))
      .first();
  },
});

export const storeWebhookEvent = internalMutation({
  args: {
    eventId: v.string(),
    eventType: v.string(),
    source: v.union(v.literal("polar"), v.literal("clerk")),
    payload: v.any(),
    receivedAt: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("webhookEvents", {
      eventId: args.eventId,
      eventType: args.eventType,
      source: args.source,
      payload: args.payload,
      receivedAt: args.receivedAt,
      attempts: 1,
    });
  },
});

export const markWebhookEventProcessed = internalMutation({
  args: {
    eventId: v.string(),
    processingResult: v.union(
      v.literal("success"),
      v.literal("error"),
      v.literal("skipped")
    ),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const event = await ctx.db
      .query("webhookEvents")
      .withIndex("byEventId", (q) => q.eq("eventId", args.eventId))
      .first();

    if (event) {
      await ctx.db.patch(event._id, {
        processedAt: new Date().toISOString(),
        processingResult: args.processingResult,
        error: args.error,
        lastAttemptAt: new Date().toISOString(),
      });
    }
  },
});

export const createOrder = internalMutation({
  args: {
    customerId: v.id("customers"),
    polarOrderId: v.string(),
    polarCustomerId: v.string(),
    polarProductId: v.string(),
    amount: v.number(),
    currency: v.string(),
    status: v.string(),
    metadata: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const customer = await ctx.db.get(args.customerId);
    if (!customer) return;

    return await ctx.db.insert("orders", {
      userId: customer.userId,
      customerId: args.customerId,
      polarOrderId: args.polarOrderId,
      totalCents: args.amount,
      currency: args.currency,
      status: args.status,
      metadata: args.metadata,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  },
});

export const createInvoice = internalMutation({
  args: {
    customerId: v.id("customers"),
    subscriptionId: v.optional(v.id("subscriptions")),
    polarInvoiceId: v.string(),
    invoiceNumber: v.optional(v.string()),
    amountDue: v.number(),
    currency: v.string(),
    status: v.string(),
    dueDate: v.optional(v.string()),
    periodStart: v.optional(v.string()),
    periodEnd: v.optional(v.string()),
    metadata: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const customer = await ctx.db.get(args.customerId);
    if (!customer) return;

    // Check if invoice already exists
    const existing = await ctx.db
      .query("invoices")
      .withIndex("byPolarInvoiceId", (q) =>
        q.eq("polarInvoiceId", args.polarInvoiceId)
      )
      .first();

    if (existing) {
      // Update existing
      await ctx.db.patch(existing._id, {
        status: args.status,
        amountDueCents: args.amountDue,
      });
      return existing._id;
    }

    return await ctx.db.insert("invoices", {
      userId: customer.userId,
      customerId: args.customerId,
      subscriptionId: args.subscriptionId,
      polarInvoiceId: args.polarInvoiceId,
      invoiceNumber: args.invoiceNumber,
      amountDueCents: args.amountDue,
      currency: args.currency,
      status: args.status,
      dueDate: args.dueDate,
      periodStart: args.periodStart,
      periodEnd: args.periodEnd,
      metadata: args.metadata,
      createdAt: new Date().toISOString(),
    });
  },
});

export const updateInvoiceStatus = internalMutation({
  args: {
    polarInvoiceId: v.string(),
    status: v.string(),
    paidAt: v.optional(v.string()),
    amountPaid: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const invoice = await ctx.db
      .query("invoices")
      .withIndex("byPolarInvoiceId", (q) =>
        q.eq("polarInvoiceId", args.polarInvoiceId)
      )
      .first();

    if (invoice) {
      await ctx.db.patch(invoice._id, {
        status: args.status,
        paidAt: args.paidAt,
        amountPaidCents: args.amountPaid,
      });
    }
  },
});

export const createPaymentMethod = internalMutation({
  args: {
    userId: v.id("users"),
    customerId: v.id("customers"),
    polarPaymentMethodId: v.string(),
    type: v.union(v.literal("card"), v.literal("bank_transfer"), v.literal("paypal")),
    brand: v.optional(v.string()),
    last4: v.optional(v.string()),
    expMonth: v.optional(v.number()),
    expYear: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    // Check if already exists
    const existing = await ctx.db
      .query("paymentMethods")
      .withIndex("byPolarPaymentMethodId", (q) =>
        q.eq("polarPaymentMethodId", args.polarPaymentMethodId)
      )
      .first();

    if (existing) return existing._id;

    return await ctx.db.insert("paymentMethods", {
      userId: args.userId,
      customerId: args.customerId,
      polarPaymentMethodId: args.polarPaymentMethodId,
      type: args.type,
      brand: args.brand,
      last4: args.last4,
      expMonth: args.expMonth,
      expYear: args.expYear,
      isDefault: false,
      createdAt: new Date().toISOString(),
    });
  },
});

export const deletePaymentMethod = internalMutation({
  args: {
    polarPaymentMethodId: v.string(),
  },
  handler: async (ctx, args) => {
    const paymentMethod = await ctx.db
      .query("paymentMethods")
      .withIndex("byPolarPaymentMethodId", (q) =>
        q.eq("polarPaymentMethodId", args.polarPaymentMethodId)
      )
      .first();

    if (paymentMethod) {
      await ctx.db.delete(paymentMethod._id);
    }
  },
});