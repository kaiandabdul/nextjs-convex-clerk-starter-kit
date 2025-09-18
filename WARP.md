# WARP.md

This file provides guidance to WARP (warp.dev) when working with code in this repository.

## Overview

Starter kit combining:
- Next.js 15 (App Router, Turbopack) + React 19
- Clerk for authentication (middleware-protected app, UI via Clerk components)
- Convex for backend functions and data (users, subscriptions, invoices)
- Polar for products, checkout, subscriptions, and webhooks
- Tooling: Turbo for task orchestration, Biome for lint/format, Tailwind CSS 4 via PostCSS plugin

## Commands

Use Bun (preferred) or your package manager of choice; the project is configured with `packageManager: bun@1.x`.
- Dev (Next + Convex concurrently via Turbo):
  - bun run dev
- Run only Next dev:
  - bun run next:dev
- Run only Convex dev (includes dashboard, regenerates convex/_generated/*):
  - bun run convex:dev
- Build (Next):
  - bun run build
- Start (Next production server):
  - bun run start
- Lint (Biome):
  - bun run lint
- Format (Biome):
  - bun run format
- Type check (tsc):
  - bun run check-types

Notes:
- There is no test script configured in package.json.
- Dev uses Turbopack and runs both Next and Convex. If Convex CLI prompts for auth on first run, follow its instructions.

## Environment setup

Copy .env.example to an environment file used by Next (e.g., `.env.local`) and ensure values are provided. Key variables (see .env.example for full list):
- Convex/Clerk bridging
  - CONVEX_DEPLOYMENT
  - NEXT_PUBLIC_CONVEX_URL (required by components/providers/ConvexClientProvider.tsx)
  - CLERK_JWT_ISSUER_DOMAIN
  - CLERK_WEBHOOK_SECRET
- Clerk application
  - CLERK_SECRET_KEY, CLERK_PUBLISHABLE_KEY
  - NEXT_PUBLIC_CLERK_SIGN_IN_URL, NEXT_PUBLIC_CLERK_SIGN_UP_URL
- Polar integration
  - POLAR_ORGANIZATION_TOKEN, POLAR_WEBHOOK_SECRET
  - POLAR_SERVER (sandbox | production)

## Webhooks and external services

Convex HTTP routes are defined in convex/http.ts.
- Clerk users webhook: POST /clerk-users-webhook
  - Verifies with `CLERK_WEBHOOK_SECRET` using Svix.
  - Triggers internal mutations to upsert or delete users in Convex (convex/users.ts).
- Polar events: registered at /polar/events
  - Managed via `@convex-dev/polar`, used to sync subscriptions/invoices and query products.

When deployed to Convex Cloud, these paths are under your deployment domain (e.g., https://<your-deployment>.convex.cloud/clerk-users-webhook). Ensure provider dashboards point to the correct URL and secrets match.

## High-level architecture

Frontend (Next.js app):
- app/layout.tsx wraps the app with providers in this order: ClerkProvider -> ConvexProviderWithClerk (via components/providers/ConvexClientProvider.tsx). The Convex client reads NEXT_PUBLIC_CONVEX_URL and will throw if it’s missing.
- middleware.ts applies Clerk auth to most routes (excluding Next internals and static files) and always runs on API patterns (/(api|trpc)(*)).
- app/page.tsx demonstrates gated UI using Convex’s Authenticated/Unauthenticated components and Clerk UI (SignInButton, UserButton). It calls `useQuery(api.messages.getForCurrentUser)` as an example of fetching user-scoped data.
  - Note: convex/messages.ts is currently a stub; wire this up or adjust the page query accordingly.

Backend (Convex):
- Data model (convex/schema.ts)
  - users: { name, email, externalId } with index byExternalId (externalId is the Clerk user ID/subject)
  - subscriptions: { userId, subscriptionId, productId, productKey?, status, cancelAtPeriodEnd, currentPeriodStart?, currentPeriodEnd? } with indexes byUserId, bySubscriptionId
  - invoices: { userId, subscriptionId?, invoiceId, amount?, currency?, status?, periodStart?, periodEnd? } with indexes byUserId, byInvoiceId
- Auth bridging
  - convex/auth.config.ts: configures Clerk JWT issuer domain for Convex auth.
  - convex/users.ts: queries/mutations to resolve current user from ctx.auth, upsert/delete based on Clerk webhooks, and helpers like getCurrentUserOrThrow.
  - convex/auth.ts: requireAuth wrapper leveraging users.ts.
- HTTP and webhooks
  - convex/http.ts: routes Clerk webhooks and registers Polar routes; verifies Clerk events with Svix; runs internal mutations.
- Polar integration (billing)
  - convex/polar.ts: constructs the Polar helper with env-based configuration and provides:
    - listAllProducts, generateCheckoutLink, generateCustomerPortalUrl, change/cancel subscription
    - getPricing (splits products into monthly/yearly)
    - getCurrentUser returning tier flags (isFree/isPremium/isPremiumPlus) derived from productKey
  - convex/billing.ts: internal upsert handlers for subscriptions/invoices and public queries for listing current user’s subscriptions/invoices.
  - convex/polarSync.ts: action to sync products from Polar.
  - convex/seed.ts: optional utilities for seeding example products (uses Polar SDK) and inserting a fake user for demos.
- App wiring
  - convex/convex.config.ts: applies the Polar component via defineApp().

Tooling and config:
- turbo.json orchestrates scripts (dev fan-out to next:dev and convex:dev).
- biome.json enables lint/format with Next/React domains and organizes imports.
- next.config.ts enables several experimental performance features (Turbopack persistent caching, client segment cache, component caching) suitable for local development speed.
- postcss.config.mjs loads Tailwind CSS 4 via the official PostCSS plugin.

## Working notes for agents
- Prefer Bun commands (`bun run ...`) to keep lockfile and toolchain consistent; alternatives (npm/yarn/pnpm) also work if you manage the lockfile appropriately.
- For Convex function references on the client, import from convex/_generated/api; server-side implementations import from convex/_generated/server.
- If you see runtime errors related to `api.messages.*`, ensure the corresponding function is implemented in convex/messages.ts or adjust the consuming page.
