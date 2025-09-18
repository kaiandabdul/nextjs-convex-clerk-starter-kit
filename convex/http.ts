import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { WebhookEvent } from "@clerk/backend";
import { Webhook } from "svix";
import { handlePolarWebhook } from "./polarWebhook";

const http = httpRouter();

// ====================================
// CLERK WEBHOOK ENDPOINT
// ====================================
// Handles user synchronization from Clerk
// URL: https://[your-deployment].convex.site/clerk-users-webhook
http.route({
  path: "/clerk-users-webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const event = await validateClerkRequest(request);
    if (!event) {
      return new Response("Error occurred", { status: 400 });
    }
    switch (event.type) {
      case "user.created": // intentional fallthrough
      case "user.updated":
        await ctx.runMutation(internal.users.upsertFromClerk, {
          data: event.data,
        });
        break;

      case "user.deleted": {
        const clerkUserId = event.data.id!;
        await ctx.runMutation(internal.users.deleteFromClerk, { clerkUserId });
        break;
      }
      default:
        console.log("Ignored Clerk webhook event", event.type);
    }

    return new Response(null, { status: 200 });
  }),
});

// ====================================
// POLAR WEBHOOK ENDPOINT
// ====================================
// Handles billing events from Polar
// URL: https://[your-deployment].convex.site/polar/webhook
http.route({
  path: "/polar/webhook",
  method: "POST",
  handler: handlePolarWebhook,
});

// ====================================
// HEALTH CHECK ENDPOINT
// ====================================
// For monitoring and uptime checks
// URL: https://[your-deployment].convex.site/health
http.route({
  path: "/health",
  method: "GET",
  handler: httpAction(async () => {
    return new Response(
      JSON.stringify({
        status: "ok",
        timestamp: new Date().toISOString(),
        service: "nextjs-convex-clerk-polar",
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      }
    );
  }),
});

// ====================================
// WEBHOOK VALIDATION HELPERS
// ====================================

async function validateClerkRequest(
  req: Request
): Promise<WebhookEvent | null> {
  const payloadString = await req.text();
  const svixHeaders = {
    "svix-id": req.headers.get("svix-id")!,
    "svix-timestamp": req.headers.get("svix-timestamp")!,
    "svix-signature": req.headers.get("svix-signature")!,
  };
  const wh = new Webhook(process.env.CLERK_WEBHOOK_SECRET!);
  try {
    return wh.verify(payloadString, svixHeaders) as unknown as WebhookEvent;
  } catch (error) {
    console.error("Error verifying Clerk webhook event", error);
    return null;
  }
}

export default http;
