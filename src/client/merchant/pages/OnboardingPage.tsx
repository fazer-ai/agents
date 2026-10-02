import type { LucideIcon } from "lucide-react";
import {
  CheckCircle2,
  Circle,
  ListChecks,
  Package,
  Radar,
  Sparkles,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { Button, DataBoundary, PageContainer } from "@/client/components";
import { api } from "@/client/lib/api";
import { Card, CardContent } from "@/client/merchant/components/ui/card";

import "@/client/merchant/index.css";

// First-run checklist for a merchant tenant. Every step's done-state is
// computed LIVE from the same APIs the console pages use - nothing is stored,
// so importing a product in another tab flips the step on the next load. The
// only persistence is the dismiss flag in localStorage.

const DISMISS_KEY = "vinvin.merchantOnboarding.dismissed";

interface StepDef {
  key: string;
  icon: LucideIcon;
  title: string;
  body: string;
  linkTo: string;
  linkLabel: string;
  done: boolean;
}

export function OnboardingPage() {
  const { t } = useTranslation();
  const [counts, setCounts] = useState<{
    products: number;
    sources: number;
    leads: number;
    touched: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [dismissed, setDismissed] = useState(
    () => localStorage.getItem(DISMISS_KEY) === "1",
  );

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const [prodRes, srcRes, leadRes] = await Promise.all([
        api.api.v1.merchant.products.get({ query: {} }),
        api.api.v1.merchant.sources.get(),
        api.api.v1.merchant.leads.get({ query: { limit: "100" } }),
      ]);
      if (prodRes.error || srcRes.error || leadRes.error) {
        setError(true);
        return;
      }
      const leads = leadRes.data?.leads ?? [];
      setCounts({
        products: prodRes.data?.products.length ?? 0,
        sources: srcRes.data?.sources.length ?? 0,
        leads: leads.length,
        touched: leads.filter((l) => l.status !== "NEW").length,
      });
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  const steps: StepDef[] = [
    {
      key: "catalog",
      icon: Package,
      title: t("merchant.onboarding.step1Title", "Import your products"),
      body: t(
        "merchant.onboarding.step1Body",
        "Load the catalog from a JSON or CSV file so lead scoring can match posts to what you sell.",
      ),
      linkTo: "/catalog",
      linkLabel: t("merchant.onboarding.step1Link", "Open catalog"),
      done: (counts?.products ?? 0) > 0,
    },
    {
      key: "source",
      icon: Radar,
      title: t(
        "merchant.onboarding.step2Title",
        "Create and run a lead source",
      ),
      body: t(
        "merchant.onboarding.step2Body",
        "Point a source at a platform (or import a file) and run it once so real posts reach the pipeline.",
      ),
      linkTo: "/sources",
      linkLabel: t("merchant.onboarding.step2Link", "Open sources"),
      done: (counts?.sources ?? 0) > 0 && (counts?.leads ?? 0) > 0,
    },
    {
      key: "agent",
      icon: Sparkles,
      title: t(
        "merchant.onboarding.step3Title",
        "Test an agent in the playground",
      ),
      body: t(
        "merchant.onboarding.step3Body",
        "Try a reply in the agent playground before letting it near a real customer.",
      ),
      linkTo: "/agents",
      linkLabel: t("merchant.onboarding.step3Link", "Open agents"),
      done: false,
    },
    {
      key: "leads",
      icon: Users,
      title: t("merchant.onboarding.step4Title", "Review your leads"),
      body: t(
        "merchant.onboarding.step4Body",
        "Work the list: contact a lead, qualify it, and move it past NEW.",
      ),
      linkTo: "/leads",
      linkLabel: t("merchant.onboarding.step4Link", "Open leads"),
      done: (counts?.touched ?? 0) > 0,
    },
  ];

  const doneCount = steps.filter((s) => s.done).length;

  if (dismissed) {
    return (
      <PageContainer>
        <div className="py-8">
          <Card>
            <CardContent className="flex items-center justify-between gap-4 pt-6">
              <p className="text-muted-foreground text-sm">
                {t(
                  "merchant.onboarding.dismissed",
                  "The setup checklist is dismissed for this browser.",
                )}
              </p>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  localStorage.removeItem(DISMISS_KEY);
                  setDismissed(false);
                }}
              >
                {t("merchant.onboarding.showAgain", "Show again")}
              </Button>
            </CardContent>
          </Card>
        </div>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <div className="flex items-center justify-between gap-4 py-4">
        <div>
          <h1 className="font-semibold text-text-primary text-xl">
            {t("merchant.onboarding.title", "Getting started")}
          </h1>
          <p className="text-sm text-text-secondary">
            {t(
              "merchant.onboarding.subtitle",
              "{{done}} of {{total}} steps complete.",
              { done: doneCount, total: steps.length },
            )}
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            localStorage.setItem(DISMISS_KEY, "1");
            setDismissed(true);
          }}
        >
          {t("merchant.onboarding.dismiss", "Dismiss")}
        </Button>
      </div>

      <DataBoundary
        loading={loading}
        error={error}
        isEmpty={false}
        onRetry={() => void fetchAll()}
      >
        <div className="flex flex-col gap-4 pb-8">
          {steps.map((step, index) => {
            const Icon = step.icon;
            return (
              <Card key={step.key}>
                <CardContent className="flex items-start justify-between gap-4 pt-6">
                  <div className="flex items-start gap-3">
                    <div className="rounded-md bg-muted p-2 text-muted-foreground">
                      <Icon className="h-4 w-4" aria-hidden="true" />
                    </div>
                    <div className="flex flex-col gap-1">
                      <span className="flex items-center gap-2 font-medium text-sm">
                        <span className="text-muted-foreground">
                          {`${index + 1}.`}
                        </span>
                        {step.title}
                        {step.done ? (
                          <CheckCircle2
                            className="h-4 w-4 text-success"
                            aria-label={t("merchant.onboarding.done", "Done")}
                          />
                        ) : (
                          <Circle
                            className="h-4 w-4 text-muted-foreground"
                            aria-hidden="true"
                          />
                        )}
                      </span>
                      <span className="text-muted-foreground text-sm">
                        {step.body}
                      </span>
                    </div>
                  </div>
                  <Link to={step.linkTo}>
                    <Button variant="secondary" size="sm">
                      {step.linkLabel}
                    </Button>
                  </Link>
                </CardContent>
              </Card>
            );
          })}
          <div className="flex items-center gap-2 text-muted-foreground text-xs">
            <ListChecks className="h-4 w-4" aria-hidden="true" />
            {t(
              "merchant.onboarding.footer",
              "Steps check live data on every load - no checklist state is stored.",
            )}
          </div>
        </div>
      </DataBoundary>
    </PageContainer>
  );
}
