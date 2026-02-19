import { useState } from "react";
import AdminLayout from "@/layout/AdminLayout";
import { useApiEnvironment, ApiEnvironment } from "@/context/ApiEnvironmentContext";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import {
  Server,
  Train,
  CheckCircle,
  XCircle,
  Loader2,
  Eye,
  EyeOff,
  RefreshCw,
} from "lucide-react";

interface EnvConfig {
  label: string;
  icon: React.ReactNode;
  color: string;
  badgeClass: string;
}

const ENV_META: Record<ApiEnvironment, EnvConfig> = {
  production: {
    label: "Production",
    icon: <Server className="w-4 h-4" />,
    color: "bg-green-500",
    badgeClass: "border-green-500/30 text-green-600 dark:text-green-400",
  },
  railway: {
    label: "Railway (Dev)",
    icon: <Train className="w-4 h-4" />,
    color: "bg-purple-500",
    badgeClass: "border-purple-500/30 text-purple-600 dark:text-purple-400",
  },
};

type ConnectionStatus = "idle" | "testing" | "connected" | "failed";

interface EnvState {
  apiUrl: string;
  apiKeyHint: string;
  privateKeyHint: string;
  status: ConnectionStatus;
  lastTested: string | null;
  errorMessage: string | null;
}

const AdminSettings = () => {
  const { environment, environmentLabel } = useApiEnvironment();
  const { toast } = useToast();

  const [envStates, setEnvStates] = useState<Record<ApiEnvironment, EnvState>>({
    production: {
      apiUrl: "https://app.drgreennft.com",
      apiKeyHint: "••••••••",
      privateKeyHint: "••••••••",
      status: "idle",
      lastTested: null,
      errorMessage: null,
    },
    railway: {
      apiUrl: "https://drgreen-dapp-production.up.railway.app",
      apiKeyHint: "••••••••",
      privateKeyHint: "••••••••",
      status: "idle",
      lastTested: null,
      errorMessage: null,
    },
  });

  const [showKeys, setShowKeys] = useState<Record<ApiEnvironment, boolean>>({
    production: false,
    railway: false,
  });

  const handleTestConnection = async (env: ApiEnvironment) => {
    setEnvStates((prev) => ({
      ...prev,
      [env]: { ...prev[env], status: "testing" as ConnectionStatus, errorMessage: null },
    }));

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        throw new Error("Not authenticated");
      }

      const response = await supabase.functions.invoke("drgreen-proxy", {
        body: { action: "health-check", environment: env },
        headers: { Authorization: `Bearer ${session.access_token}` },
      });

      if (response.error) throw response.error;

      const result = response.data;
      const isHealthy = result?.status === "ok" || result?.healthy === true;

      setEnvStates((prev) => ({
        ...prev,
        [env]: {
          ...prev[env],
          status: isHealthy ? "connected" : "failed",
          lastTested: new Date().toISOString(),
          errorMessage: isHealthy ? null : (result?.message || "Health check returned unhealthy"),
        },
      }));

      toast({
        title: isHealthy ? "Connection Successful" : "Connection Failed",
        description: isHealthy
          ? `${ENV_META[env].label} API is reachable and authenticated.`
          : `${ENV_META[env].label}: ${result?.message || "Unhealthy response"}`,
        variant: isHealthy ? "default" : "destructive",
      });
    } catch (error: any) {
      const msg = error?.message || "Connection test failed";
      setEnvStates((prev) => ({
        ...prev,
        [env]: {
          ...prev[env],
          status: "failed",
          lastTested: new Date().toISOString(),
          errorMessage: msg,
        },
      }));

      toast({
        title: "Connection Failed",
        description: msg,
        variant: "destructive",
      });
    }
  };

  const StatusIndicator = ({ status }: { status: ConnectionStatus }) => {
    switch (status) {
      case "testing":
        return <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />;
      case "connected":
        return <CheckCircle className="w-4 h-4 text-green-500" />;
      case "failed":
        return <XCircle className="w-4 h-4 text-destructive" />;
      default:
        return <span className="w-4 h-4 rounded-full border-2 border-muted-foreground/30 inline-block" />;
    }
  };

  const environments: ApiEnvironment[] = ["production", "railway"];

  return (
    <AdminLayout
      title="Settings"
      description="API environment configuration and connection management"
    >
      <div className="space-y-6 max-w-3xl">
        {/* Safety Notice */}
        <Card className="border-yellow-600/30 bg-yellow-50/50 dark:bg-yellow-900/10">
          <CardContent className="p-4 flex items-start gap-3">
            <span className="text-yellow-600 dark:text-yellow-400 mt-0.5 text-lg">⚠</span>
            <p className="text-sm text-yellow-800 dark:text-yellow-300">
              <strong>Admin Tools Only.</strong> The environment selector below applies exclusively to Admin Tools (API Test Runner, Comparison Dashboard). Patient checkout, cart, and order creation <strong>always use Production</strong> regardless of this setting.
            </p>
          </CardContent>
        </Card>

        {/* Active Environment Badge */}
        <Card>
          <CardContent className="p-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="text-sm font-medium text-muted-foreground">Active Environment:</span>
              <Badge variant="outline" className={ENV_META[environment].badgeClass}>
                <span className={`w-2 h-2 rounded-full mr-2 ${ENV_META[environment].color}`} />
                {environmentLabel}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              Switch via the header selector
            </p>
          </CardContent>
        </Card>

        {/* Environment Cards */}
        {environments.map((env) => {
          const meta = ENV_META[env];
          const state = envStates[env];
          const isActive = environment === env;
          const keysVisible = showKeys[env];

          return (
            <Card
              key={env}
              className={isActive ? "border-primary/40 shadow-sm" : ""}
            >
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className={`p-2 rounded-lg ${meta.color}/10`}>
                      {meta.icon}
                    </div>
                    <div>
                      <CardTitle className="text-lg">{meta.label}</CardTitle>
                      <CardDescription>
                        {env === "production"
                          ? "Live production API — handles real orders"
                          : "Development & testing environment"}
                      </CardDescription>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <StatusIndicator status={state.status} />
                    {isActive && (
                      <Badge className="bg-primary/10 text-primary border-primary/30 text-xs">
                        ACTIVE
                      </Badge>
                    )}
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* API URL */}
                <div className="space-y-2">
                  <Label className="text-sm font-medium">API Base URL</Label>
                  <Input
                    value={state.apiUrl}
                    readOnly
                    className="bg-muted/50 font-mono text-sm"
                  />
                </div>

                {/* Credentials Row */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label className="text-sm font-medium">API Key</Label>
                    <div className="relative">
                      <Input
                        value={keysVisible ? "(stored in backend secrets)" : state.apiKeyHint}
                        readOnly
                        className="bg-muted/50 font-mono text-sm pr-10"
                      />
                      <button
                        type="button"
                        onClick={() =>
                          setShowKeys((prev) => ({ ...prev, [env]: !prev[env] }))
                        }
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      >
                        {keysVisible ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label className="text-sm font-medium">Private Key</Label>
                    <div className="relative">
                      <Input
                        value={keysVisible ? "(stored in backend secrets)" : state.privateKeyHint}
                        readOnly
                        className="bg-muted/50 font-mono text-sm pr-10"
                      />
                      <button
                        type="button"
                        onClick={() =>
                          setShowKeys((prev) => ({ ...prev, [env]: !prev[env] }))
                        }
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      >
                        {keysVisible ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>
                </div>

                <p className="text-xs text-muted-foreground">
                  Credentials are stored securely in backend secrets and cannot be viewed from the dashboard.
                  To update keys, contact your administrator.
                </p>

                {/* Error message */}
                {state.errorMessage && (
                  <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/20">
                    <p className="text-sm text-destructive">{state.errorMessage}</p>
                  </div>
                )}

                {/* Test + Last tested */}
                <div className="flex items-center justify-between pt-2 border-t border-border">
                  <div className="text-xs text-muted-foreground">
                    {state.lastTested
                      ? `Last tested: ${new Date(state.lastTested).toLocaleString()}`
                      : "Not tested yet"}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleTestConnection(env)}
                    disabled={state.status === "testing"}
                  >
                    {state.status === "testing" ? (
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    ) : (
                      <RefreshCw className="w-4 h-4 mr-2" />
                    )}
                    Test Connection
                  </Button>
                </div>
              </CardContent>
            </Card>
          );
        })}

        {/* Info Note */}
        <Card className="border-muted">
          <CardContent className="p-4">
            <p className="text-sm text-muted-foreground">
              <strong>Note:</strong> For the final production release, only the Production environment
              will be active. Railway is available for development and testing purposes. The environment
              selector in the header controls which API all admin operations use.
            </p>
          </CardContent>
        </Card>
      </div>
    </AdminLayout>
  );
};

export default AdminSettings;
