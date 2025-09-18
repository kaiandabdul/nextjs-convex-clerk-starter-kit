# Convex Directory Structure

This directory contains all Convex backend functions and database schema for the Next.js + Clerk + Polar billing starter kit.

## 📁 File Organization

### Core Configuration
- `convex.config.ts` - Main Convex configuration
- `schema.ts` - Database schema definitions
- `types.ts` - TypeScript type definitions
- `tsconfig.json` - TypeScript configuration for Convex

### Authentication & Users
- `auth.config.ts` - Clerk authentication configuration
- `auth.ts` - Authentication helpers and middleware
- `users.ts` - User management functions
- `usersWithBilling.ts` - User functions with billing integration

### Billing System
- `billing.ts` - Core billing operations
- `billingQueries.ts` - Billing queries for frontend
- `checkout.ts` - Checkout session management
- `subscriptions.ts` - Subscription lifecycle management
- `customers.ts` - Customer management
- `polar.ts` - Polar integration with @convex-dev/polar
- `polarSync.ts` - Product synchronization with Polar
- `polarWebhook.ts` - Polar webhook handler
- `webhooks.ts` - General webhook processing

### Usage & Monitoring
- `usageTracking.ts` - Usage event tracking and limits
- `monitoring.ts` - System monitoring and health checks
- `sync.ts` - Data synchronization jobs

### Admin & Utils
- `adminTools.ts` - Administrative operations
- `crons.ts` - Scheduled jobs configuration
- `seed.ts` - Database seeding utilities

### HTTP & API
- `http.ts` - HTTP routing for webhooks and health checks

### Library
- `lib/polar.ts` - Polar API client library

### Generated Files (DO NOT EDIT)
- `_generated/` - Auto-generated Convex files

## 🔑 Key Modules

### Authentication Flow
1. `auth.config.ts` configures Clerk with Convex
2. `users.ts` handles user creation/updates from Clerk webhooks
3. `auth.ts` provides `requireAuth` helper

### Billing Flow
1. `billing.ts` creates checkout links
2. `checkout.ts` manages sessions
3. `polarWebhook.ts` processes payment events
4. `subscriptions.ts` manages subscription state
5. `usersWithBilling.ts` provides user billing status

### Usage Tracking
1. `usageTracking.ts` records usage events
2. Cron jobs process events in batches
3. Limits enforced based on subscription tier

### Admin Tools
1. `adminTools.ts` provides manual controls
2. Role-based access control
3. Billing reports and exports

## 🚀 Common Tasks

### Add a new query
Create in appropriate file and export:
```typescript
export const myQuery = query({
  args: { /* args */ },
  handler: async (ctx, args) => {
    // Implementation
  }
});
```

### Add a new mutation
```typescript
export const myMutation = mutation({
  args: { /* args */ },
  handler: async (ctx, args) => {
    // Implementation
  }
});
```

### Add a new table
Edit `schema.ts`:
```typescript
myTable: defineTable({
  field: v.string(),
  // ... other fields
})
.index("byField", ["field"])
```

### Add a scheduled job
Edit `crons.ts`:
```typescript
crons.interval(
  "job name",
  { minutes: 30 },
  internal.module.function
);
```

## 🔧 Environment Variables

Required in Convex dashboard:
- `CLERK_WEBHOOK_SECRET`
- `POLAR_ORGANIZATION_TOKEN`
- `POLAR_WEBHOOK_SECRET`
- `POLAR_SERVER`

## 📝 Development Tips

1. Run `bunx convex dev` to start development
2. Use `bunx convex logs` to see function logs
3. Use `bunx convex dashboard` to view data
4. Test functions with `bunx convex run`

## 🐛 Debugging

- Check `_generated/` files for TypeScript errors
- Ensure all exports are properly typed
- Use `console.log()` for debugging (visible in Convex logs)
- Check webhook events in the database for processing errors
```

Using this query function in a React component looks like:

```ts
const data = useQuery(api.functions.myQueryFunction, {
  first: 10,
  second: "hello",
});
```

A mutation function looks like:

```ts
// functions.js
import { mutation } from "./_generated/server";
import { v } from "convex/values";

export const myMutationFunction = mutation({
  // Validators for arguments.
  args: {
    first: v.string(),
    second: v.string(),
  },

  // Function implementation.
  handler: async (ctx, args) => {
    // Insert or modify documents in the database here.
    // Mutations can also read from the database like queries.
    // See https://docs.convex.dev/database/writing-data.
    const message = { body: args.first, author: args.second };
    const id = await ctx.db.insert("messages", message);

    // Optionally, return a value from your mutation.
    return await ctx.db.get(id);
  },
});
```

Using this mutation function in a React component looks like:

```ts
const mutation = useMutation(api.functions.myMutationFunction);
function handleButtonPress() {
  // fire and forget, the most common way to use mutations
  mutation({ first: "Hello!", second: "me" });
  // OR
  // use the result once the mutation has completed
  mutation({ first: "Hello!", second: "me" }).then((result) =>
    console.log(result)
  );
}
```

Use the Convex CLI to push your functions to a deployment. See everything
the Convex CLI can do by running `bunx convex -h` in your project root
directory. To learn more, launch the docs with `bunx convex docs`.
