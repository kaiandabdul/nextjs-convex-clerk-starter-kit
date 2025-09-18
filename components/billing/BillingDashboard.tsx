"use client";

import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AlertCircle, CheckCircle, XCircle, CreditCard, Users, HardDrive, Activity } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { formatDistanceToNow } from "date-fns";

export function BillingDashboard() {
  const profile = useQuery(api.usersWithBilling.getCurrentUserProfile);
  const subscriptions = useQuery(api.billingQueries.getCurrentUserSubscriptions);
  const invoices = useQuery(api.billingQueries.getCurrentUserInvoices);
  const billingStats = useQuery(api.billingQueries.getBillingStats);
  const upgradePrompt = useQuery(api.usersWithBilling.getUpgradePrompt);
  
  const generateCheckoutLink = useMutation(api.billing.generateCheckoutLink);
  const generatePortalLink = useMutation(api.billing.generateCustomerPortalLink);
  const cancelSubscription = useMutation(api.billing.cancelSubscription);

  const [isGeneratingCheckout, setIsGeneratingCheckout] = useState(false);
  const [isGeneratingPortal, setIsGeneratingPortal] = useState(false);

  if (!profile) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-pulse">Loading billing information...</div>
      </div>
    );
  }

  const handleUpgrade = async (productId: string) => {
    setIsGeneratingCheckout(true);
    try {
      const checkoutUrl = await generateCheckoutLink({ productId });
      if (checkoutUrl) {
        window.location.href = checkoutUrl;
      }
    } catch (error) {
      console.error("Failed to generate checkout link:", error);
    } finally {
      setIsGeneratingCheckout(false);
    }
  };

  const handleManageSubscription = async () => {
    setIsGeneratingPortal(true);
    try {
      const portalUrl = await generatePortalLink();
      if (portalUrl) {
        window.location.href = portalUrl;
      }
    } catch (error) {
      console.error("Failed to generate portal link:", error);
    } finally {
      setIsGeneratingPortal(false);
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case "active":
      case "trialing":
        return "bg-green-500";
      case "past_due":
        return "bg-yellow-500";
      case "canceled":
      case "unpaid":
        return "bg-red-500";
      default:
        return "bg-gray-500";
    }
  };

  const getUsagePercentage = (current: number, limit: number) => {
    if (limit === -1) return 0; // Unlimited
    return Math.min((current / limit) * 100, 100);
  };

  return (
    <div className="container mx-auto p-6 space-y-8">
      {/* Upgrade Prompts */}
      {upgradePrompt && upgradePrompt.prompts.length > 0 && (
        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            <div className="space-y-2">
              {upgradePrompt.prompts.map((prompt, i) => (
                <div key={i} className="flex items-center justify-between">
                  <span>{prompt.message}</span>
                  {prompt.severity === "high" && (
                    <Badge variant="destructive">Action Required</Badge>
                  )}
                </div>
              ))}
              <Button
                size="sm"
                className="mt-2"
                onClick={() => window.location.href = upgradePrompt.upgradeUrl}
              >
                Upgrade Plan
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}

      {/* Current Plan Overview */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Current Plan</CardTitle>
              <CardDescription>Your subscription and usage details</CardDescription>
            </div>
            <Badge className="text-lg px-4 py-2">
              {profile.plan.charAt(0).toUpperCase() + profile.plan.slice(1)}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          {profile.subscription && (
            <div className="flex items-center justify-between p-4 bg-muted rounded-lg">
              <div>
                <p className="font-medium">{profile.subscription.productName || "Active Subscription"}</p>
                <p className="text-sm text-muted-foreground">
                  Status: <Badge variant="outline" className={getStatusColor(profile.subscription.status)}>
                    {profile.subscription.status}
                  </Badge>
                </p>
                {profile.subscription.currentPeriodEnd && (
                  <p className="text-sm text-muted-foreground">
                    Renews: {formatDistanceToNow(new Date(profile.subscription.currentPeriodEnd), { addSuffix: true })}
                  </p>
                )}
                {profile.subscription.cancelAtPeriodEnd && (
                  <p className="text-sm text-destructive">
                    Cancels at period end
                  </p>
                )}
              </div>
              <Button
                variant="outline"
                onClick={handleManageSubscription}
                disabled={isGeneratingPortal}
              >
                {isGeneratingPortal ? "Loading..." : "Manage Subscription"}
              </Button>
            </div>
          )}

          {/* Usage Limits */}
          <div className="space-y-4">
            <h3 className="font-semibold">Usage & Limits</h3>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Projects */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Activity className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm font-medium">Projects</span>
                  </div>
                  <span className="text-sm text-muted-foreground">
                    {profile.usage.projectsCount} / {profile.limits.maxProjects === -1 ? "∞" : profile.limits.maxProjects}
                  </span>
                </div>
                <Progress 
                  value={getUsagePercentage(profile.usage.projectsCount, profile.limits.maxProjects)} 
                />
              </div>

              {/* Team Members */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Users className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm font-medium">Team Members</span>
                  </div>
                  <span className="text-sm text-muted-foreground">
                    {profile.usage.teamMembersCount} / {profile.limits.maxTeamMembers === -1 ? "∞" : profile.limits.maxTeamMembers}
                  </span>
                </div>
                <Progress 
                  value={getUsagePercentage(profile.usage.teamMembersCount, profile.limits.maxTeamMembers)} 
                />
              </div>

              {/* Storage */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <HardDrive className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm font-medium">Storage</span>
                  </div>
                  <span className="text-sm text-muted-foreground">
                    {profile.usage.storageUsedGB}GB / {profile.limits.maxStorageGB === -1 ? "∞" : profile.limits.maxStorageGB}GB
                  </span>
                </div>
                <Progress 
                  value={getUsagePercentage(profile.usage.storageUsedGB, profile.limits.maxStorageGB)} 
                />
              </div>

              {/* API Calls */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Activity className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm font-medium">API Calls (Monthly)</span>
                  </div>
                  <span className="text-sm text-muted-foreground">
                    {profile.usage.apiCallsThisMonth} / {profile.limits.maxMonthlyApiCalls === -1 ? "∞" : profile.limits.maxMonthlyApiCalls}
                  </span>
                </div>
                <Progress 
                  value={getUsagePercentage(profile.usage.apiCallsThisMonth, profile.limits.maxMonthlyApiCalls)} 
                />
              </div>
            </div>
          </div>

          {/* Features */}
          <div className="space-y-4">
            <h3 className="font-semibold">Features</h3>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
              {Object.entries(profile.features).map(([feature, enabled]) => (
                <div key={feature} className="flex items-center gap-2">
                  {enabled ? (
                    <CheckCircle className="h-4 w-4 text-green-500" />
                  ) : (
                    <XCircle className="h-4 w-4 text-muted-foreground" />
                  )}
                  <span className={`text-sm ${enabled ? "" : "text-muted-foreground"}`}>
                    {feature.replace(/([A-Z])/g, " $1").replace(/^./, str => str.toUpperCase())}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Billing Stats */}
      {billingStats && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium">Total Revenue</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                ${billingStats.totalRevenue.toFixed(2)}
              </div>
              <p className="text-xs text-muted-foreground">All time</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium">MRR</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                ${billingStats.mrr.toFixed(2)}
              </div>
              <p className="text-xs text-muted-foreground">Monthly recurring</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium">Active Subscriptions</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {billingStats.activeSubscriptions}
              </div>
              <p className="text-xs text-muted-foreground">Current</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium">Churn Rate</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {billingStats.churnRate.toFixed(1)}%
              </div>
              <p className="text-xs text-muted-foreground">Last 30 days</p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Tabs for Subscriptions and Invoices */}
      <Tabs defaultValue="subscriptions" className="w-full">
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="subscriptions">Subscriptions</TabsTrigger>
          <TabsTrigger value="invoices">Invoices</TabsTrigger>
        </TabsList>

        <TabsContent value="subscriptions" className="space-y-4">
          {subscriptions && subscriptions.length > 0 ? (
            subscriptions.map((sub) => (
              <Card key={sub._id}>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-lg">{sub.metadata?.productName || "Subscription"}</CardTitle>
                    <Badge className={getStatusColor(sub.status)}>
                      {sub.status}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Period:</span>
                      <span>
                        {sub.currentPeriodStart && new Date(sub.currentPeriodStart).toLocaleDateString()} - 
                        {sub.currentPeriodEnd && new Date(sub.currentPeriodEnd).toLocaleDateString()}
                      </span>
                    </div>
                    {sub.cancelAtPeriodEnd && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Cancels at:</span>
                        <span className="text-destructive">
                          {sub.currentPeriodEnd && new Date(sub.currentPeriodEnd).toLocaleDateString()}
                        </span>
                      </div>
                    )}
                  </div>
                  {sub.status === "active" && !sub.cancelAtPeriodEnd && (
                    <Button
                      variant="destructive"
                      size="sm"
                      className="mt-4"
                      onClick={() => cancelSubscription({ subscriptionId: sub._id })}
                    >
                      Cancel Subscription
                    </Button>
                  )}
                </CardContent>
              </Card>
            ))
          ) : (
            <Card>
              <CardContent className="pt-6">
                <p className="text-center text-muted-foreground">No active subscriptions</p>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="invoices" className="space-y-4">
          {invoices && invoices.length > 0 ? (
            invoices.map((invoice) => (
              <Card key={invoice._id}>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-lg">
                      Invoice #{invoice.polarInvoiceId.slice(-8)}
                    </CardTitle>
                    <Badge variant={invoice.status === "paid" ? "default" : "secondary"}>
                      {invoice.status}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Amount:</span>
                      <span className="font-medium">
                        ${invoice.amount ? (invoice.amount / 100).toFixed(2) : "0.00"} {invoice.currency?.toUpperCase()}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Date:</span>
                      <span>{invoice.createdAt && new Date(invoice.createdAt).toLocaleDateString()}</span>
                    </div>
                    {invoice.paidAt && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Paid:</span>
                        <span>{new Date(invoice.paidAt).toLocaleDateString()}</span>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))
          ) : (
            <Card>
              <CardContent className="pt-6">
                <p className="text-center text-muted-foreground">No invoices found</p>
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}