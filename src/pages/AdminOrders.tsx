/**
 * Admin Orders Page
 * 
 * Dashboard for viewing and syncing orders with Dr. Green API.
 */

import { useState, useEffect, useRef } from "react";
import { motion } from "framer-motion";
import AdminLayout from "@/layout/AdminLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AdminOrdersTable } from "@/components/admin/AdminOrdersTable";
import { AdminOrderDetail } from "@/components/admin/AdminOrderDetail";
import {
  useAdminOrderSync,
  LocalOrder,
  SyncStatus,
  OrderFilters,
} from "@/hooks/useAdminOrderSync";
import {
  Package,
  Clock,
  CheckCircle,
  XCircle,
  CalendarDays,
  RefreshCw,
  Search,
  Download,
  PlayCircle,
  AlertCircle,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";

const AdminOrders = () => {
  const [activeTab, setActiveTab] = useState<SyncStatus | "all">("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [selectedOrder, setSelectedOrder] = useState<LocalOrder | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [orders, setOrders] = useState<LocalOrder[]>([]);
  const [isFiltering, setIsFiltering] = useState(false);

  const {
    orders: initialOrders,
    stats,
    isLoading,
    isLoadingStats,
    isSyncing,
    isUpdating,
    isProcessing,
    selectedOrders,
    toggleOrderSelection,
    selectAllOrders,
    clearSelection,
    syncOrder,
    batchSyncOrders,
    resetSyncStatus,
    flagForReview,
    updateOrderStatus,
    processOrder,
    batchProcessPending,
    fetchOrders,
    refetch,
  } = useAdminOrderSync();

  // Initialize orders from the hook
  useEffect(() => {
    setOrders(initialOrders);
  }, [initialOrders]);

  // Stable ref to fetchOrders — avoids re-render loops from function reference changes
  const fetchOrdersRef = useRef(fetchOrders);
  fetchOrdersRef.current = fetchOrders;

  // Filter orders when tab changes (immediate)
  useEffect(() => {
    let cancelled = false;
    setIsFiltering(true);
    const filters: OrderFilters = {
      syncStatus: activeTab,
      search: searchQuery || undefined,
      dateFrom: dateFrom || undefined,
      dateTo: dateTo ? `${dateTo}T23:59:59.999Z` : undefined,
    };
    fetchOrdersRef.current(filters)
      .then((result) => { if (!cancelled) setOrders(result.orders); })
      .catch((err) => console.error("Error filtering orders:", err))
      .finally(() => { if (!cancelled) setIsFiltering(false); });
    return () => { cancelled = true; };
  // Only primitive deps — no function references
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  // Debounced search and date filter
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      setIsFiltering(true);
      const filters: OrderFilters = {
        syncStatus: activeTab,
        search: searchQuery || undefined,
        dateFrom: dateFrom || undefined,
        dateTo: dateTo ? `${dateTo}T23:59:59.999Z` : undefined,
      };
      fetchOrdersRef.current(filters)
        .then((result) => { if (!cancelled) setOrders(result.orders); })
        .catch((err) => console.error("Error filtering orders:", err))
        .finally(() => { if (!cancelled) setIsFiltering(false); });
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  // Only primitive deps — no function references
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, dateFrom, dateTo]);

  // Set up realtime subscription
  useEffect(() => {
    const channel = supabase
      .channel("admin-orders-changes")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "drgreen_orders",
        },
        () => {
          refetch();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [refetch]);

  const handleViewOrder = (order: LocalOrder) => {
    setSelectedOrder(order);
    setDetailOpen(true);
  };

  const handleSyncOrder = async (orderId: string) => {
    await syncOrder(orderId);
  };

  const handleBatchSync = async () => {
    if (selectedOrders.length > 0) {
      await batchSyncOrders(selectedOrders);
      clearSelection();
    }
  };

  const handleResetSync = async (orderId: string) => {
    await resetSyncStatus(orderId);
  };

  const handleFlagForReview = async (orderId: string, reason?: string) => {
    await flagForReview({ orderId, reason: reason || "Flagged by admin" });
  };

  const handleProcessOrder = async (orderId: string) => {
    await processOrder(orderId);
  };

  const handleBatchProcess = async () => {
    await batchProcessPending();
  };

  const handleUpdateStatus = async (
    orderId: string,
    status?: string,
    paymentStatus?: string
  ) => {
    await updateOrderStatus({
      orderId,
      status: status as any,
      paymentStatus: paymentStatus as any,
    });
  };

  const handleExportCSV = () => {
    // Simple CSV export
    const headers = ["Date", "Order ID", "Customer", "Total", "Status", "Payment", "Sync"];
    const rows = orders.map((o) => [
      new Date(o.created_at).toISOString(),
      o.drgreen_order_id || o.id,
      o.customer_email || "",
      o.total_amount?.toString() || "0",
      o.status,
      o.payment_status,
      o.sync_status,
    ]);

    const csvContent = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
    const blob = new Blob([csvContent], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `orders-export-${new Date().toISOString().split("T")[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const statCards = [
    {
      title: "Total Orders",
      value: stats?.total || 0,
      icon: Package,
      color: "text-[hsl(var(--admin-forest))]",
      bgColor: "bg-[hsl(var(--admin-forest))]/10",
    },
    {
      title: "Pending Sync",
      value: stats?.pending || 0,
      icon: Clock,
      color: "text-amber-600 dark:text-amber-400",
      bgColor: "bg-amber-500/10",
    },
    {
      title: "Synced",
      value: stats?.synced || 0,
      icon: CheckCircle,
      color: "text-[hsl(var(--admin-olive))] dark:text-[hsl(var(--admin-olive))]",
      bgColor: "bg-[hsl(var(--admin-olive))]/10",
    },
    {
      title: "Failed",
      value: stats?.failed || 0,
      icon: XCircle,
      color: "text-destructive",
      bgColor: "bg-destructive/10",
    },
    {
      title: "Today",
      value: stats?.today || 0,
      icon: CalendarDays,
      color: "text-[hsl(var(--admin-sky))] dark:text-[hsl(var(--admin-sky))]",
      bgColor: "bg-[hsl(var(--admin-sky))]/10",
    },
  ];

  return (
    <AdminLayout
      title="Orders Management"
      description="View and sync orders with Dr. Green API"
    >
      {/* Pending Queue Banner */}
      {(stats?.pending || 0) > 0 && (
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <Card className="mb-6 border-amber-500/30 bg-amber-500/5">
            <CardContent className="p-4">
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-amber-500/10">
                    <AlertCircle className="w-5 h-5 text-amber-600 dark:text-amber-400" />
                  </div>
                  <div>
                    <p className="font-semibold text-foreground">
                      {stats.pending} Pending Order{stats.pending !== 1 ? 's' : ''} Awaiting Processing
                    </p>
                    <p className="text-sm text-muted-foreground">
                      These orders were saved locally and need manual confirmation.
                    </p>
                  </div>
                </div>
                <Button
                  size="sm"
                  onClick={handleBatchProcess}
                  disabled={isProcessing}
                  className="whitespace-nowrap"
                >
                  <PlayCircle className={cn("w-4 h-4 mr-2", isProcessing && "animate-spin")} />
                  Confirm All Pending
                </Button>
              </div>
            </CardContent>
          </Card>
        </motion.div>
      )}

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4 mb-6">
        {statCards.map((stat, index) => (
          <motion.div
            key={stat.title}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: index * 0.05 }}
          >
            <Card className="border-border/60">
              <CardContent className="p-4">
                <div className="flex items-center gap-3">
                  <div className={`p-2 rounded-lg ${stat.bgColor}`}>
                    <stat.icon className={`w-5 h-5 ${stat.color}`} />
                  </div>
                  <div>
                    <p className="text-2xl font-bold">{stat.value}</p>
                    <p className="text-xs text-muted-foreground">{stat.title}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </motion.div>
        ))}
      </div>

      {/* Main Content */}
      <Card>
        <CardHeader className="border-b border-border">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <CardTitle>Orders</CardTitle>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={refetch}
                disabled={isLoading}
              >
                <RefreshCw className={`w-4 h-4 mr-2 ${isLoading ? "animate-spin" : ""}`} />
                Refresh
              </Button>
              <Button variant="outline" size="sm" onClick={handleExportCSV}>
                <Download className="w-4 h-4 mr-2" />
                Export
              </Button>
              {selectedOrders.length > 0 && (
                <Button
                  size="sm"
                  onClick={handleBatchSync}
                  disabled={isSyncing}
                >
                  <RefreshCw className={`w-4 h-4 mr-2 ${isSyncing ? "animate-spin" : ""}`} />
                  Sync ({selectedOrders.length})
                </Button>
              )}
            </div>
          </div>
        </CardHeader>

        <CardContent className="p-0">
          <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as SyncStatus | "all")}>
            <div className="border-b border-border px-4 py-3">
                <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between">
                <TabsList className="bg-muted/50">
                  <TabsTrigger value="all">All</TabsTrigger>
                  <TabsTrigger value="pending">Pending</TabsTrigger>
                  <TabsTrigger value="failed">Failed</TabsTrigger>
                  <TabsTrigger value="synced">Synced</TabsTrigger>
                  <TabsTrigger value="manual_review">Review</TabsTrigger>
                </TabsList>

                <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
                  <div className="relative flex-1 sm:w-56">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <Input
                      placeholder="Search orders..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="pl-9"
                    />
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Input
                      type="date"
                      value={dateFrom}
                      onChange={(e) => setDateFrom(e.target.value)}
                      className="h-9 w-[130px] text-xs"
                      placeholder="From"
                    />
                    <span className="text-xs text-muted-foreground">–</span>
                    <Input
                      type="date"
                      value={dateTo}
                      onChange={(e) => setDateTo(e.target.value)}
                      className="h-9 w-[130px] text-xs"
                      placeholder="To"
                    />
                    {(dateFrom || dateTo) && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-9 px-2 text-xs text-muted-foreground"
                        onClick={() => { setDateFrom(""); setDateTo(""); }}
                      >
                        Clear
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            </div>

            <div className="p-4">
              <AdminOrdersTable
                orders={orders}
                isLoading={isLoading || isFiltering}
                selectedOrders={selectedOrders}
                onToggleSelect={toggleOrderSelection}
                onSelectAll={selectAllOrders}
                onViewOrder={handleViewOrder}
                onSyncOrder={handleSyncOrder}
                onResetSync={handleResetSync}
                onFlagForReview={(id) => handleFlagForReview(id)}
                onProcessOrder={handleProcessOrder}
                isSyncing={isSyncing}
                isProcessing={isProcessing}
              />
            </div>
          </Tabs>
        </CardContent>
      </Card>

      {/* Order Detail Sheet */}
      <AdminOrderDetail
        order={selectedOrder}
        open={detailOpen}
        onClose={() => {
          setDetailOpen(false);
          setSelectedOrder(null);
        }}
        onSyncOrder={handleSyncOrder}
        onResetSync={handleResetSync}
        onFlagForReview={handleFlagForReview}
        onUpdateStatus={handleUpdateStatus}
        isSyncing={isSyncing}
        isUpdating={isUpdating}
      />
    </AdminLayout>
  );
};

export default AdminOrders;
