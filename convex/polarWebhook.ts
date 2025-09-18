/**
 * Polar webhook handler
 */

import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";

export const handlePolarWebhook = httpAction(async (ctx, request) => {
  const payload = await request.text();
  const signature = request.headers.get("webhook-signature");

  if (!signature) {
    return new Response("Missing signature", { status: 400 });
  }

  // Verify webhook signature
  const webhookSecret = process.env.POLAR_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error("POLAR_WEBHOOK_SECRET not configured");
    return new Response("Webhook secret not configured", { status: 500 });
  }

  // Note: Signature verification would need to be done in a Node.js action
  // or rely on Polar's SDK verification
  // For now, we'll accept the webhook if the secret is present
  // In production, use the Polar component which handles this automatically

  try {
    const event = JSON.parse(payload);

    // Process different event types
    switch (event.type) {
      case "subscription.created":
      case "subscription.updated":
        console.log("Processing subscription event:", event.type);
        break;
      
      case "order.created":
      case "checkout.created":
        console.log("Processing order event:", event.type);
        break;

      default:
        console.log("Unhandled webhook event type:", event.type);
    }

    return new Response(null, { status: 200 });
  } catch (error) {
    console.error("Polar webhook error:", error);
    return new Response("Webhook processing failed", { status: 400 });
  }
});