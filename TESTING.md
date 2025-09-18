# 🧪 Billing System Testing Guide

This guide explains how to test the billing system to ensure everything works correctly in production.

## 📋 Test Coverage

The test suite covers:
- ✅ User management & authentication
- ✅ Product catalog & pricing
- ✅ Checkout flow
- ✅ Subscription lifecycle
- ✅ Usage tracking & limits
- ✅ Billing queries & stats
- ✅ Admin operations
- ✅ Webhook processing
- ✅ System monitoring
- ✅ Data synchronization
- ✅ Error handling
- ✅ Performance benchmarks

## 🚀 Quick Start

### Basic Test Suite
Run the basic E2E tests using Convex CLI:
```bash
bun run test:billing
```

### Full Test Suite
Run the comprehensive test suite with all scenarios:
```bash
bun run test:billing:full
```

### Specific Test Categories
Test only specific parts of the system:
```bash
# Test webhooks only
bun run test:billing:webhooks

# Test billing flows
./scripts/test-billing-e2e.sh --billing

# Test usage tracking
./scripts/test-billing-e2e.sh --usage

# Test admin tools
./scripts/test-billing-e2e.sh --admin

# Test performance
./scripts/test-billing-e2e.sh --performance
```

## 📁 Test Scripts

### `scripts/test-billing-e2e.sh`
Bash script that tests all Convex functions using the CLI. No external dependencies required.

**Features:**
- Tests all public queries and mutations
- Validates webhook endpoints
- Checks error handling
- Measures performance
- Color-coded output

**Usage:**
```bash
./scripts/test-billing-e2e.sh [--all|--webhooks|--billing|--usage]
```

### `scripts/test-billing-system.ts`
TypeScript test suite for comprehensive testing with the Convex client.

**Features:**
- Simulates production scenarios
- Tests concurrent operations
- Validates webhook processing
- Performance benchmarks
- Detailed error reporting

**Usage:**
```bash
bunx tsx scripts/test-billing-system.ts [--all|--webhooks|--billing|--usage|--performance]
```

## 🔍 Manual Testing

### 1. Test User Creation
```bash
# Create a test user via Clerk webhook simulation
curl -X POST https://your-deployment.convex.cloud/clerk-users-webhook \
  -H "Content-Type: application/json" \
  -H "svix-id: test_123" \
  -H "svix-timestamp: 1234567890" \
  -H "svix-signature: test" \
  -d '{
    "type": "user.created",
    "data": {
      "id": "user_test_123",
      "email_addresses": [{"email_address": "test@example.com"}],
      "first_name": "Test",
      "last_name": "User"
    }
  }'
```

### 2. Test Checkout Flow
```bash
# Generate checkout link
bunx convex run billing:generateCheckoutLink '{"productId": "prod_123"}'

# Create checkout session
bunx convex run checkout:createCheckoutSession '{
  "productId": "prod_123",
  "successUrl": "http://localhost:3000/success",
  "cancelUrl": "http://localhost:3000/cancel"
}'
```

### 3. Test Subscription Webhook
```bash
# Simulate subscription creation
curl -X POST https://your-deployment.convex.cloud/polar/webhook \
  -H "Content-Type: application/json" \
  -H "webhook-signature: test" \
  -d '{
    "id": "evt_123",
    "type": "subscription.created",
    "data": {
      "id": "sub_123",
      "customer_id": "cus_123",
      "product_id": "prod_123",
      "status": "active"
    }
  }'
```

### 4. Test Usage Tracking
```bash
# Record usage event
bunx convex run usageTracking:recordUsageEvent '{
  "eventType": "api_call",
  "eventName": "test.api",
  "units": 1
}'

# Check usage
bunx convex run usageTracking:getCurrentPeriodUsage
```

### 5. Test Admin Functions
```bash
# Get billing stats (requires admin)
bunx convex run adminTools:getBillingStats

# Export billing data
bunx convex run adminTools:exportBillingData '{
  "dataType": "subscriptions",
  "format": "json"
}'
```

## 🎯 Test Scenarios

### Scenario 1: New User Subscription Flow
1. User signs up via Clerk
2. User views pricing page
3. User initiates checkout
4. User completes payment
5. Subscription webhook received
6. User has access to premium features

### Scenario 2: Usage Limit Enforcement
1. Free user records usage events
2. Usage approaches limit
3. User receives upgrade prompt
4. Usage exceeds limit
5. Feature access blocked
6. User upgrades to premium

### Scenario 3: Subscription Cancellation
1. User has active subscription
2. User cancels subscription
3. Cancellation webhook received
4. Subscription marked as canceled
5. User retains access until period end
6. Access revoked after expiration

### Scenario 4: Webhook Failure & Recovery
1. Webhook received with invalid signature
2. Webhook rejected (401)
3. Valid webhook with network failure
4. Webhook queued for retry
5. Admin manually retries webhook
6. Webhook processes successfully

## 📊 Performance Benchmarks

Expected performance metrics:
- Query response: < 100ms
- Mutation execution: < 200ms
- Webhook processing: < 500ms
- Batch operations (100 items): < 5s
- Concurrent webhooks (10): < 3s

## 🐛 Debugging Tests

### Enable Verbose Output
```bash
# Add debug flag for detailed logs
DEBUG=true ./scripts/test-billing-e2e.sh
```

### Check Convex Logs
```bash
# View real-time logs
bunx convex logs

# View function logs
bunx convex logs --function billing:generateCheckoutLink
```

### Inspect Database
```bash
# Open Convex dashboard
bunx convex dashboard

# Query specific data
bunx convex run users:current
bunx convex run subscriptions:getCurrentSubscription
```

## ✅ Test Checklist

Before deploying to production, ensure:

- [ ] All test suites pass
- [ ] Webhook endpoints respond correctly
- [ ] Error handling works as expected
- [ ] Performance meets benchmarks
- [ ] Admin tools are restricted
- [ ] Usage limits are enforced
- [ ] Subscriptions sync properly
- [ ] Monitoring alerts work
- [ ] Database indexes are optimal
- [ ] Environment variables are set

## 🔧 Troubleshooting

### Common Issues

**Tests fail with "Not authenticated"**
- Ensure Clerk webhook created a user
- Check auth configuration

**Webhook tests fail**
- Verify webhook secrets are configured
- Check signature validation logic

**Performance tests fail**
- Check database indexes
- Verify batching is working
- Look for N+1 queries

**Admin tests fail**
- Verify admin role checking
- Check email/ID matches admin list

## 🚦 CI/CD Integration

Add to your CI pipeline:

```yaml
# .github/workflows/test.yml
name: Test Billing System

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: oven-sh/setup-bun@v1
      - run: bun install
      - run: bun run test:billing
      - run: bun run test:billing:full
```

## 📝 Test Reports

Generate test reports:

```bash
# Run tests with JSON output
./scripts/test-billing-e2e.sh > test-results.json

# Generate HTML report (requires additional tooling)
bunx tsx scripts/test-billing-system.ts --reporter=html
```

## 🎉 Summary

The billing system includes comprehensive testing tools to ensure reliability:

1. **Automated Tests** - Run full test suite in minutes
2. **Manual Testing** - Verify specific scenarios
3. **Performance Tests** - Ensure system scales
4. **Error Scenarios** - Validate error handling
5. **Production Simulation** - Test real-world conditions

Regular testing ensures your billing system remains reliable and performant!