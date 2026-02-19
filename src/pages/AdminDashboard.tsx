import { useState, useEffect, useCallback } from "react";
import { useNavigate, Link } from "react-router-dom";
import { formatPrice } from "@/lib/currency";
import { DEFAULT_COUNTRY } from "@/lib/countries";
import { motion } from "framer-motion";
import { 
  Users, 
  ShoppingCart, 
  Clock, 
  CheckCircle,
  ArrowRight,
  RefreshCw,
  Wallet,
  ExternalLink,
  Copy,
  Key,
  Settings,
  ToggleLeft,
  ToggleRight,
  Loader2,
  Shield,
  Mail,
  User,
  AlertTriangle,
  Activity,
  UserPlus,
  Package
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import AdminLayout from "@/layout/AdminLayout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useToast } from "@/hooks/use-toast";
import { useDrGreenApi } from "@/hooks/useDrGreenApi";
import { useDrGreenClientSync } from "@/hooks/useDrGreenClientSync";
import { useDrGreenAutoSync } from "@/hooks/useDrGreenAutoSync";
import { useApiEnvironment } from "@/context/ApiEnvironmentContext";
import { useAccount, useDisconnect, useChainId } from "wagmi";
import { useDrGreenKeyOwnership } from "@/hooks/useNFTOwnership";
import { useWallet } from "@/context/WalletContext";
import { mainnet } from "wagmi/chains";
import { formatDistanceToNow } from "date-fns";

interface DashboardStats {
  totalOrders: number;
  pendingOrders: number;
  totalClients: number;
  verifiedClients: number;
  dappTotalClients: number;
  dappTotalOrders: number;
  dappTotalSales: number;
  dappPendingClients: number;
}

interface RecentItem {
  id: string;
  label: string;
  detail: string;
  time: string;
  type: 'client' | 'order';
}

const AdminDashboard = () => {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { getDashboardSummary, getSalesSummary, getClientsSummary, getDappClients } = useDrGreenApi();
  const { syncClientsToSupabase, syncing: syncingClients } = useDrGreenClientSync();
  const { environment, environmentLabel } = useApiEnvironment();
  const { syncNow, syncing: autoSyncing, lastSync } = useDrGreenAutoSync();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [recentActivity, setRecentActivity] = useState<RecentItem[]>([]);
  const [demoKycEnabled, setDemoKycEnabled] = useState(false);
  const [togglingKyc, setTogglingKyc] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const { address, isConnected } = useAccount();
  const { disconnect } = useDisconnect();
  const chainId = useChainId();
  const { hasNFT, isLoading: nftLoading } = useDrGreenKeyOwnership();
  const { openWalletModal } = useWallet();

  useEffect(() => {
    loadDashboard();
  }, []);

  useEffect(() => {
    if (!loading) fetchStats(true);
  }, [environment]);

  const loadDashboard = async () => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      // Check KYC demo status
      const { data: clientData } = await supabase
        .from('drgreen_clients')
        .select('is_kyc_verified, admin_approval')
        .eq('user_id', user.id)
        .maybeSingle();

      if (clientData) {
        setDemoKycEnabled(clientData.is_kyc_verified && clientData.admin_approval === 'VERIFIED');
      }

      await Promise.all([fetchStats(), fetchRecentActivity()]);
    } catch (error) {
      console.error('Error loading dashboard:', error);
      setLoading(false);
    }
  };

  const fetchRecentActivity = async () => {
    try {
      const [clientsRes, ordersRes] = await Promise.all([
        supabase.from('drgreen_clients').select('id, full_name, email, created_at').order('created_at', { ascending: false }).limit(5),
        supabase.from('drgreen_orders').select('id, drgreen_order_id, customer_name, total_amount, created_at, status, country_code').order('created_at', { ascending: false }).limit(5),
      ]);

      const items: RecentItem[] = [];
      clientsRes.data?.forEach(c => {
        items.push({
          id: c.id,
          label: c.full_name || c.email || 'Unknown',
          detail: 'Client registered',
          time: c.created_at,
          type: 'client',
        });
      });
      ordersRes.data?.forEach(o => {
        items.push({
          id: o.id,
          label: o.customer_name || o.drgreen_order_id,
          detail: `Order ${o.status} — ${formatPrice(o.total_amount ?? 0, o.country_code || DEFAULT_COUNTRY)}`,
          time: o.created_at,
          type: 'order',
        });
      });

      items.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
      setRecentActivity(items.slice(0, 8));
    } catch (err) {
      console.error('Error fetching recent activity:', err);
    }
  };

  const fetchStats = async (showRefreshToast = false) => {
    if (showRefreshToast) setRefreshing(true);

    try {
      // 1. Try Dr. Green API as primary source of truth for client KPIs
      let apiClientsUsed = false;
      let totalClients = 0;
      let verifiedClients = 0;
      let pendingClients = 0;

      try {
        const summaryResult = await getClientsSummary();
        const summaryData = summaryResult.data as unknown as { data?: { summary?: { PENDING: number; VERIFIED: number; REJECTED: number; totalCount: number } } };
        const summary = summaryData?.data?.summary || (summaryResult.data as { summary?: { PENDING: number; VERIFIED: number; REJECTED: number; totalCount: number } })?.summary;
        
        if (summary && summary.totalCount > 0) {
          totalClients = summary.totalCount;
          verifiedClients = summary.VERIFIED || 0;
          pendingClients = summary.PENDING || 0;
          apiClientsUsed = true;
          console.log('[Dashboard] Using Dr. Green API for client KPIs:', summary);
        }
      } catch (apiErr) {
        console.log('[Dashboard] Dr. Green client summary unavailable, falling back to local DB');
      }

      // 2. Fallback to local DB if API unavailable
      if (!apiClientsUsed) {
        const { data: clientsRes } = await supabase
          .from('drgreen_clients')
          .select('is_kyc_verified, admin_approval');
        totalClients = clientsRes?.length || 0;
        verifiedClients = clientsRes?.filter(c => c.is_kyc_verified && c.admin_approval === 'VERIFIED').length || 0;
        pendingClients = clientsRes?.filter(c => !c.is_kyc_verified || c.admin_approval !== 'VERIFIED').length || 0;
      }

      // 3. Orders always from local DB (synced)
      const { data: ordersRes } = await supabase.from('drgreen_orders').select('status');
      const totalOrders = ordersRes?.length || 0;
      const pendingOrders = ordersRes?.filter(o => o.status === 'PENDING').length || 0;

      // 4. Sales summary (optional)
      let dappTotalSales = 0;
      try {
        const { data: salesSummary, error: salesError } = await getSalesSummary();
        if (!salesError && salesSummary) dappTotalSales = salesSummary.totalSales || 0;
      } catch (dappErr) {
        console.log('[Dashboard] Dr Green sales API unavailable');
      }

      setStats({
        totalOrders,
        pendingOrders,
        totalClients,
        verifiedClients,
        dappTotalClients: totalClients,
        dappTotalOrders: totalOrders,
        dappTotalSales,
        dappPendingClients: pendingClients,
      });

      if (showRefreshToast) {
        toast({ title: "Data Refreshed", description: `Dashboard updated${apiClientsUsed ? ' (live API)' : ' (local DB)'}.` });
      }
    } catch (error) {
      console.error('Error fetching stats:', error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const handleToggleDemoKyc = async () => {
    setTogglingKyc(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      const newStatus = !demoKycEnabled;
      const { data: existingClient } = await supabase
        .from('drgreen_clients').select('id').eq('user_id', user.id).maybeSingle();

      if (existingClient) {
        await supabase.from('drgreen_clients').update({
          is_kyc_verified: newStatus,
          admin_approval: newStatus ? 'VERIFIED' : 'PENDING',
          updated_at: new Date().toISOString(),
        }).eq('user_id', user.id);
      } else {
        await supabase.from('drgreen_clients').insert({
          user_id: user.id,
          drgreen_client_id: `demo-${user.id}`,
          country_code: 'ZA',
          is_kyc_verified: newStatus,
          admin_approval: newStatus ? 'VERIFIED' : 'PENDING',
        });
      }

      setDemoKycEnabled(newStatus);
      toast({
        title: newStatus ? "Demo KYC Enabled" : "Demo KYC Disabled",
        description: newStatus ? "Shop access unlocked for testing." : "KYC verification required again.",
      });
    } catch (error) {
      console.error('Error toggling demo KYC:', error);
      toast({ title: "Error", description: "Failed to update KYC status.", variant: "destructive" });
    } finally {
      setTogglingKyc(false);
    }
  };

  const kpiCards = [
    {
      title: "Registered Clients",
      value: stats?.dappTotalClients || stats?.totalClients || 0,
      icon: Users,
      color: "text-[hsl(var(--admin-forest))]",
      bgColor: "bg-[hsl(var(--admin-forest))]/10",
      live: true,
      link: "/admin/clients",
    },
    {
      title: "Total Orders",
      value: stats?.dappTotalOrders || stats?.totalOrders || 0,
      icon: ShoppingCart,
      color: "text-[hsl(var(--admin-sky))] dark:text-[hsl(var(--admin-sky))]",
      bgColor: "bg-[hsl(var(--admin-sky))]/10",
      live: true,
      link: "/admin/orders",
    },
    {
      title: "Pending Approvals",
      value: stats?.dappPendingClients || 0,
      icon: Clock,
      color: "text-amber-600 dark:text-amber-400",
      bgColor: "bg-amber-500/10",
      live: true,
      link: "/admin/clients",
    },
    {
      title: "Verified & Active",
      value: stats?.verifiedClients || 0,
      icon: CheckCircle,
      color: "text-[hsl(var(--admin-olive))] dark:text-[hsl(var(--admin-olive))]",
      bgColor: "bg-[hsl(var(--admin-olive))]/10",
      live: false,
      link: "/admin/clients",
    },
  ];

  return (
    <AdminLayout
      title="Dashboard"
      description={`Live overview • ${environmentLabel}`}
    >
      <div className="space-y-8">
        {/* Top Bar: Refresh */}
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            {lastSync && (
              <Badge variant="outline" className="text-xs text-muted-foreground">
                Last synced {formatDistanceToNow(lastSync, { addSuffix: true })}
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="default"
              size="sm"
              onClick={async () => {
                await syncNow();
                await Promise.all([fetchStats(true), fetchRecentActivity()]);
              }}
              disabled={autoSyncing}
            >
              <RefreshCw className={`w-4 h-4 mr-2 ${autoSyncing ? 'animate-spin' : ''}`} />
              {autoSyncing ? 'Syncing…' : 'Sync Now'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => fetchStats(true)}
              disabled={refreshing}
            >
              <RefreshCw className={`w-4 h-4 mr-2 ${refreshing ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </div>
        </div>

        {/* KPI Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {kpiCards.map((kpi, i) => (
            <motion.div
              key={kpi.title}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, delay: i * 0.05 }}
            >
              <Card
                className="cursor-pointer transition-all hover:shadow-md hover:border-primary/30"
                onClick={() => navigate(kpi.link)}
              >
                <CardContent className="p-5">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <p className="text-sm text-muted-foreground">{kpi.title}</p>
                        {kpi.live && (
                          <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 border-primary/30 text-primary font-semibold">
                            LIVE
                          </Badge>
                        )}
                      </div>
                      <p className="text-3xl font-bold text-foreground">{loading ? '—' : kpi.value}</p>
                    </div>
                    <div className={`p-3 rounded-xl ${kpi.bgColor}`}>
                      <kpi.icon className={`w-5 h-5 ${kpi.color}`} />
                    </div>
                  </div>
                </CardContent>
              </Card>
            </motion.div>
          ))}
        </div>

        {/* Pending Orders Banner */}
        {stats && stats.pendingOrders > 0 && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            <Card className="border-amber-500/30 bg-amber-500/5">
              <CardContent className="p-4 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <AlertTriangle className="w-5 h-5 text-amber-500" />
                  <p className="text-sm font-medium text-foreground">
                    {stats.pendingOrders} pending order{stats.pendingOrders > 1 ? 's' : ''} awaiting processing
                  </p>
                </div>
                <Button size="sm" variant="outline" onClick={() => navigate('/admin/orders')}>
                  View Orders <ArrowRight className="w-4 h-4 ml-1" />
                </Button>
              </CardContent>
            </Card>
          </motion.div>
        )}

        {/* Quick Actions */}
        <div>
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">Quick Actions</h2>
          <div className="flex flex-wrap gap-3">
            <Button variant="outline" size="sm" onClick={() => navigate('/admin/clients')}>
              <UserPlus className="w-4 h-4 mr-2" /> Manage Clients
            </Button>
            <Button variant="outline" size="sm" onClick={() => navigate('/admin/orders')}>
              <Package className="w-4 h-4 mr-2" /> Process Orders
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                toast({ title: 'Re-Homing', description: 'Starting batch re-homing of all clients...' });
                try {
                  const { data, error } = await supabase.functions.invoke('drgreen-rehome');
                  if (error) throw error;
                  toast({
                    title: 'Re-Homing Complete',
                    description: `${data?.summary?.succeeded || 0} succeeded, ${data?.summary?.failed || 0} failed, ${data?.summary?.skipped || 0} skipped`,
                  });
                  fetchStats(true);
                } catch (err: any) {
                  toast({ title: 'Re-Homing Failed', description: err?.message || 'Unknown error', variant: 'destructive' });
                }
              }}
            >
              <Key className="w-4 h-4 mr-2" /> Re-Home All Clients
            </Button>
            <Button variant="outline" size="sm" asChild>
              <a href="https://dapp.drgreennft.com/" target="_blank" rel="noopener noreferrer">
                <ExternalLink className="w-4 h-4 mr-2" /> Dr. Green Portal
              </a>
            </Button>
          </div>
        </div>

        {/* Two Column: Sales + Recent Activity */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Sales Summary */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-lg">Sales Overview</CardTitle>
              <CardDescription>Revenue from Dr. Green DApp</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <div className="flex items-center justify-between p-3 rounded-lg bg-muted/50">
                  <span className="text-sm text-muted-foreground">Total Sales</span>
                  <span className="text-lg font-bold text-foreground">
                    {loading ? '—' : (stats?.dappTotalSales ? formatPrice(stats.dappTotalSales, 'PT') : '€0.00')}
                  </span>
                </div>
                <div className="flex items-center justify-between p-3 rounded-lg bg-muted/50">
                  <span className="text-sm text-muted-foreground">Total Orders</span>
                  <span className="text-lg font-bold text-foreground">
                    {loading ? '—' : (stats?.dappTotalOrders || stats?.totalOrders || 0)}
                  </span>
                </div>
                <div className="flex items-center justify-between p-3 rounded-lg bg-muted/50">
                  <span className="text-sm text-muted-foreground">Active Clients</span>
                  <span className="text-lg font-bold text-foreground">
                    {loading ? '—' : (stats?.verifiedClients || 0)}
                  </span>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Recent Activity */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-lg">Recent Activity</CardTitle>
              <CardDescription>Latest client & order events</CardDescription>
            </CardHeader>
            <CardContent>
              {recentActivity.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4 text-center">No recent activity</p>
              ) : (
                <div className="space-y-3">
                  {recentActivity.map(item => (
                    <div
                      key={item.id}
                      className="flex items-start gap-3 p-2 rounded-lg hover:bg-muted/50 transition-colors cursor-pointer group"
                      onClick={() => navigate(item.type === 'order' ? '/admin/orders' : '/admin/clients')}
                    >
                      <div className={`p-1.5 rounded-full mt-0.5 ${item.type === 'client' ? 'bg-primary/10' : 'bg-secondary/10'}`}>
                        {item.type === 'client' ? (
                          <UserPlus className="w-3.5 h-3.5 text-primary" />
                        ) : (
                          <ShoppingCart className="w-3.5 h-3.5 text-secondary" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-foreground truncate">{item.label}</p>
                        <p className="text-xs text-muted-foreground">{item.detail}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground whitespace-nowrap">
                          {formatDistanceToNow(new Date(item.time), { addSuffix: true })}
                        </span>
                        <ArrowRight className="w-3.5 h-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Collapsible Settings & Wallet */}
        <Collapsible open={settingsOpen} onOpenChange={setSettingsOpen}>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" className="w-full justify-between text-muted-foreground hover:text-foreground">
              <span className="flex items-center gap-2">
                <Settings className="w-4 h-4" />
                Settings & Wallet
              </span>
              <ArrowRight className={`w-4 h-4 transition-transform ${settingsOpen ? 'rotate-90' : ''}`} />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-4">
              {/* Wallet */}
              <Card className="border-border">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Wallet className="w-4 h-4" /> Wallet Connection
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {isConnected && address ? (
                    <>
                      <div className="flex items-center gap-2 p-2 rounded-lg bg-muted/50 text-sm">
                        <span className="text-muted-foreground">Address:</span>
                        <span className="font-mono">{address.slice(0, 6)}...{address.slice(-4)}</span>
                        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => { navigator.clipboard.writeText(address); toast({ title: "Copied" }); }}>
                          <Copy className="h-3 w-3" />
                        </Button>
                      </div>
                      <div className="flex items-center gap-2 p-2 rounded-lg bg-muted/50 text-sm">
                        <div className={`w-2 h-2 rounded-full ${chainId === mainnet.id ? 'bg-emerald-500' : 'bg-amber-500'}`} />
                        <span>{chainId === mainnet.id ? 'Ethereum Mainnet' : `Chain ${chainId}`}</span>
                      </div>
                      <div className={`flex items-center gap-2 p-2 rounded-lg text-sm ${hasNFT ? 'bg-emerald-500/10' : 'bg-amber-500/10'}`}>
                        <Key className={`w-4 h-4 ${hasNFT ? 'text-emerald-500' : 'text-amber-500'}`} />
                        <span>{nftLoading ? 'Checking...' : hasNFT ? '✓ Digital Key Verified' : '✗ No Digital Key'}</span>
                      </div>
                      <Button variant="outline" size="sm" className="w-full" onClick={() => disconnect()}>
                        Disconnect Wallet
                      </Button>
                    </>
                  ) : (
                    <Button onClick={openWalletModal} variant="outline" className="w-full">
                      <Wallet className="mr-2 h-4 w-4" /> Connect Wallet
                    </Button>
                  )}
                </CardContent>
              </Card>

              {/* Demo KYC Toggle */}
              <Card className="border-border">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Settings className="w-4 h-4" /> Demo Settings
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="flex items-center justify-between p-3 rounded-lg bg-muted/50">
                    <div className="flex items-center gap-3">
                      {demoKycEnabled ? <ToggleRight className="w-5 h-5 text-emerald-500" /> : <ToggleLeft className="w-5 h-5 text-muted-foreground" />}
                      <div>
                        <Label htmlFor="demo-kyc" className="font-medium cursor-pointer text-sm">
                          Bypass KYC Verification
                        </Label>
                        <p className="text-xs text-muted-foreground">For testing shop access</p>
                      </div>
                    </div>
                    {togglingKyc ? (
                      <Loader2 className="w-5 h-5 animate-spin text-primary" />
                    ) : (
                      <Switch id="demo-kyc" checked={demoKycEnabled} onCheckedChange={handleToggleDemoKyc} />
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-3">⚠️ Admin account only. Bypasses KYC for testing.</p>
                </CardContent>
              </Card>
            </div>
          </CollapsibleContent>
        </Collapsible>
      </div>
    </AdminLayout>
  );
};

export default AdminDashboard;
