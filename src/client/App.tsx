import "@/public/index.css";
import "@/client/lib/i18n";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import {
  GlobalApiToasts,
  ProtectedRoute,
  ToastProvider,
} from "@/client/components";
import { SetupGate } from "@/client/components/SetupGate";
import { ApprovalsProvider } from "@/client/contexts/ApprovalsContext";
import { AuthProvider } from "@/client/contexts/AuthContext";
import { BrandingProvider } from "@/client/contexts/BrandingContext";
import { BreadcrumbProvider } from "@/client/contexts/BreadcrumbContext";
import { DensityProvider } from "@/client/contexts/DensityContext";
import { NavGuardProvider } from "@/client/contexts/NavGuardContext";
import { SidebarProvider } from "@/client/contexts/SidebarContext";
import { ThemeProvider } from "@/client/contexts/ThemeContext";
import { UpdatesProvider } from "@/client/contexts/UpdatesContext";
// vinvin merchant extension: all implementation lives under src/client/merchant/.
import { AnalyticsPage } from "@/client/merchant/pages/AnalyticsPage";
import { BroadcastsPage } from "@/client/merchant/pages/BroadcastsPage";
import { CatalogPage } from "@/client/merchant/pages/CatalogPage";
import { LeadsPage } from "@/client/merchant/pages/LeadsPage";
import { NurturePage } from "@/client/merchant/pages/NurturePage";
import { OnboardingPage } from "@/client/merchant/pages/OnboardingPage";
import { OrdersPage } from "@/client/merchant/pages/OrdersPage";
import { SourcesPage } from "@/client/merchant/pages/SourcesPage";
import { AcceptInvitePage } from "@/client/pages/AcceptInvitePage";
import { AgentsPage } from "@/client/pages/AgentsPage";
import { ApiKeysPage } from "@/client/pages/ApiKeysPage";
// NOTE: SettingsAboutPage removed (item 13); /settings/about now redirects to profile.
import { AuditPage } from "@/client/pages/AuditPage";
import { AdminBrandingPage } from "@/client/pages/admin/AdminBrandingPage";
import { AdminLayout } from "@/client/pages/admin/AdminLayout";
import { AdminTenantsPage } from "@/client/pages/admin/AdminTenantsPage";
import { AdminUsersPage } from "@/client/pages/admin/AdminUsersPage";
import { AgentEditorPage } from "@/client/pages/agents/AgentEditorPage";
import { ChannelsPage } from "@/client/pages/ChannelsPage";
import { ConversationDetailPage } from "@/client/pages/ConversationDetailPage";
import { ConversationsPage } from "@/client/pages/ConversationsPage";
import { DashboardPage } from "@/client/pages/DashboardPage";
import { LoginPage } from "@/client/pages/LoginPage";
import { LogsPage } from "@/client/pages/LogsPage";
import { McpPage } from "@/client/pages/McpPage";
import { OAuthConsentPage } from "@/client/pages/OAuthConsentPage";
import { AdvancedPanel } from "@/client/pages/resources/AdvancedPanel";
import { BusinessHoursPanel } from "@/client/pages/resources/BusinessHoursPanel";
import { DocumentsPanel } from "@/client/pages/resources/documents/DocumentsPanel";
import { IntegrationsPanel } from "@/client/pages/resources/IntegrationsPanel";
import { KnowledgePanel } from "@/client/pages/resources/KnowledgePanel";
import { McpPanel } from "@/client/pages/resources/McpPanel";
import { ResourcesLayout } from "@/client/pages/resources/ResourcesLayout";
import { ToolsPanel } from "@/client/pages/resources/ToolsPanel";
import { VaultPanel } from "@/client/pages/resources/VaultPanel";
import { SetupPage } from "@/client/pages/SetupPage";
import { SignupPage } from "@/client/pages/SignupPage";
import { SettingsLayout } from "@/client/pages/settings/SettingsLayout";
import { SettingsPreferencesPage } from "@/client/pages/settings/SettingsPreferencesPage";
import { SettingsProfilePage } from "@/client/pages/settings/SettingsProfilePage";
import { SettingsSecurityPage } from "@/client/pages/settings/SettingsSecurityPage";
import { WebhooksPage } from "@/client/pages/WebhooksPage";

export function App() {
  return (
    <ThemeProvider>
      <DensityProvider>
        <BrandingProvider>
          <ToastProvider>
            <GlobalApiToasts />
            <TooltipPrimitive.Provider delayDuration={200}>
              <AuthProvider>
                <BrowserRouter>
                  <NavGuardProvider>
                    <SidebarProvider>
                      <BreadcrumbProvider>
                        <ApprovalsProvider>
                          <UpdatesProvider>
                            <SetupGate>
                              <Routes>
                                <Route
                                  path="/"
                                  element={
                                    <ProtectedRoute requireAdmin>
                                      <DashboardPage />
                                    </ProtectedRoute>
                                  }
                                />
                                <Route
                                  path="/conversations"
                                  element={
                                    <ProtectedRoute>
                                      <ConversationsPage />
                                    </ProtectedRoute>
                                  }
                                />
                                <Route
                                  path="/conversations/:id"
                                  element={
                                    <ProtectedRoute>
                                      <ConversationDetailPage />
                                    </ProtectedRoute>
                                  }
                                />
                                <Route
                                  path="/agents"
                                  element={
                                    <ProtectedRoute requireAdmin>
                                      <AgentsPage />
                                    </ProtectedRoute>
                                  }
                                />
                                <Route path="/agents/:id">
                                  <Route
                                    index
                                    element={<Navigate to="general" replace />}
                                  />
                                  <Route
                                    path=":tab"
                                    element={
                                      <ProtectedRoute requireAdmin>
                                        <AgentEditorPage />
                                      </ProtectedRoute>
                                    }
                                  />
                                </Route>
                                <Route
                                  path="/resources"
                                  element={
                                    <ProtectedRoute requireAdmin>
                                      <ResourcesLayout />
                                    </ProtectedRoute>
                                  }
                                >
                                  <Route
                                    index
                                    element={<Navigate to="tools" replace />}
                                  />
                                  <Route
                                    path="tools"
                                    element={<ToolsPanel />}
                                  />
                                  <Route path="mcp" element={<McpPanel />} />
                                  <Route
                                    path="knowledge"
                                    element={<KnowledgePanel />}
                                  />
                                  <Route
                                    path="documents"
                                    element={<DocumentsPanel />}
                                  />
                                  <Route
                                    path="hours"
                                    element={<BusinessHoursPanel />}
                                  />
                                  <Route
                                    path="integrations"
                                    element={<IntegrationsPanel />}
                                  />
                                  <Route
                                    path="vault"
                                    element={<VaultPanel />}
                                  />
                                  <Route
                                    path="advanced"
                                    element={<AdvancedPanel />}
                                  />
                                </Route>
                                <Route
                                  path="/channels"
                                  element={
                                    <ProtectedRoute requireAdmin>
                                      <ChannelsPage />
                                    </ProtectedRoute>
                                  }
                                />
                                {/* Approvals moved into Components → Knowledge; keep the old link working. */}
                                <Route
                                  path="/approvals"
                                  element={
                                    <Navigate
                                      to="/resources/knowledge"
                                      replace
                                    />
                                  }
                                />
                                <Route
                                  path="/webhooks"
                                  element={
                                    <ProtectedRoute requireAdmin>
                                      <WebhooksPage />
                                    </ProtectedRoute>
                                  }
                                />
                                {/* vinvin merchant extension: real pages over /api/v1/merchant. */}
                                <Route
                                  path="/leads"
                                  element={
                                    <ProtectedRoute requireAdmin>
                                      <LeadsPage />
                                    </ProtectedRoute>
                                  }
                                />
                                <Route
                                  path="/sources"
                                  element={
                                    <ProtectedRoute requireAdmin>
                                      <SourcesPage />
                                    </ProtectedRoute>
                                  }
                                />
                                <Route
                                  path="/catalog"
                                  element={
                                    <ProtectedRoute requireAdmin>
                                      <CatalogPage />
                                    </ProtectedRoute>
                                  }
                                />
                                <Route
                                  path="/orders"
                                  element={
                                    <ProtectedRoute requireAdmin>
                                      <OrdersPage />
                                    </ProtectedRoute>
                                  }
                                />
                                <Route
                                  path="/nurture"
                                  element={
                                    <ProtectedRoute requireAdmin>
                                      <NurturePage />
                                    </ProtectedRoute>
                                  }
                                />
                                <Route
                                  path="/analytics"
                                  element={
                                    <ProtectedRoute requireAdmin>
                                      <AnalyticsPage />
                                    </ProtectedRoute>
                                  }
                                />
                                <Route
                                  path="/onboarding"
                                  element={
                                    <ProtectedRoute requireAdmin>
                                      <OnboardingPage />
                                    </ProtectedRoute>
                                  }
                                />
                                <Route
                                  path="/broadcasts"
                                  element={
                                    <ProtectedRoute requireAdmin>
                                      <BroadcastsPage />
                                    </ProtectedRoute>
                                  }
                                />
                                <Route
                                  path="/api-keys"
                                  element={
                                    <ProtectedRoute requireAdmin>
                                      <ApiKeysPage />
                                    </ProtectedRoute>
                                  }
                                />
                                <Route
                                  path="/audit"
                                  element={
                                    <ProtectedRoute requireAdmin>
                                      <AuditPage />
                                    </ProtectedRoute>
                                  }
                                />
                                <Route
                                  path="/logs"
                                  element={
                                    <ProtectedRoute requireAdmin>
                                      <LogsPage />
                                    </ProtectedRoute>
                                  }
                                />
                                <Route
                                  path="/mcp"
                                  element={
                                    <Navigate to="/settings/mcp" replace />
                                  }
                                />
                                <Route path="/setup" element={<SetupPage />} />
                                <Route
                                  path="/accept-invite"
                                  element={<AcceptInvitePage />}
                                />
                                <Route path="/login" element={<LoginPage />} />
                                <Route
                                  path="/signup"
                                  element={<SignupPage />}
                                />
                                <Route
                                  path="/oauth/consent"
                                  element={<OAuthConsentPage />}
                                />
                                <Route
                                  path="/admin"
                                  element={
                                    <ProtectedRoute requireAdmin>
                                      <AdminLayout />
                                    </ProtectedRoute>
                                  }
                                >
                                  <Route
                                    index
                                    element={<Navigate to="users" replace />}
                                  />
                                  <Route
                                    path="users"
                                    element={<AdminUsersPage />}
                                  />
                                  <Route
                                    path="tenants"
                                    element={<AdminTenantsPage />}
                                  />
                                  <Route
                                    path="branding"
                                    element={<AdminBrandingPage />}
                                  />
                                </Route>
                                <Route
                                  path="/settings"
                                  element={
                                    <ProtectedRoute>
                                      <SettingsLayout />
                                    </ProtectedRoute>
                                  }
                                >
                                  <Route
                                    index
                                    element={<Navigate to="profile" replace />}
                                  />
                                  <Route
                                    path="profile"
                                    element={<SettingsProfilePage />}
                                  />
                                  <Route
                                    path="security"
                                    element={<SettingsSecurityPage />}
                                  />
                                  <Route
                                    path="preferences"
                                    element={<SettingsPreferencesPage />}
                                  />
                                  <Route
                                    path="appearance"
                                    element={
                                      <Navigate
                                        to="/settings/preferences"
                                        replace
                                      />
                                    }
                                  />
                                  <Route path="mcp" element={<McpPage />} />
                                  <Route
                                    path="about"
                                    element={
                                      <Navigate
                                        to="/settings/profile"
                                        replace
                                      />
                                    }
                                  />
                                </Route>
                                <Route
                                  path="*"
                                  element={<Navigate to="/" replace />}
                                />
                              </Routes>
                            </SetupGate>
                          </UpdatesProvider>
                        </ApprovalsProvider>
                      </BreadcrumbProvider>
                    </SidebarProvider>
                  </NavGuardProvider>
                </BrowserRouter>
              </AuthProvider>
            </TooltipPrimitive.Provider>
          </ToastProvider>
        </BrandingProvider>
      </DensityProvider>
    </ThemeProvider>
  );
}

export default App;
