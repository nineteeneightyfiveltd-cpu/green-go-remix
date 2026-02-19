import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { format } from "date-fns";
import { ArrowLeft, Package, CreditCard, MapPin, RefreshCw, Printer, Clock, CheckCircle2 } from "lucide-react";
import { motion } from "framer-motion";

import Header from "@/layout/Header";
import Footer from "@/components/Footer";
import SEOHead from "@/components/SEOHead";
import MobileBottomActions from "@/components/MobileBottomActions";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { supabase } from "@/integrations/supabase/client";
import { formatPrice } from "@/lib/currency";
import { cn } from "@/lib/utils";
import { useShop } from "@/context/ShopContext";

interface OrderItem {
  strain_id: string;
  strain_name: string;
  quantity: number;
  unit_price: number;
}

interface Order {
  id: string;
  drgreen_order_id: string;
  status: string;
  payment_status: string;
  total_amount: number;
  items: OrderItem[];
  created_at: string;
  updated_at: string;
  country_code: string | null;
  currency: string | null;
  customer_name: string | null;
  customer_email: string | null;
  shipping_address: Record<string, string> | null;
  sync_status: string | null;
  sync_error: string | null;
  synced_at: string | null;
}

function getStatusColor(status: string): string {
  switch (status.toLowerCase()) {
    case "paid":
    case "completed":
    case "delivered":
      return "bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 border-emerald-500/30";
    case "processing":
      return "bg-blue-500/20 text-blue-600 dark:text-blue-400 border-blue-500/30";
    case "pending":
    case "pending_sync":
    case "awaiting_processing":
      return "bg-amber-500/20 text-amber-600 dark:text-amber-400 border-amber-500/30";
    case "cancelled":
    case "failed":
      return "bg-red-500/20 text-red-600 dark:text-red-400 border-red-500/30";
    default:
      return "bg-muted text-muted-foreground";
  }
}

function getDisplayStatus(status: string): string {
  if (status === "PENDING_SYNC") return "Awaiting Processing";
  if (status === "AWAITING_PROCESSING") return "Awaiting Processing";
  return status.charAt(0).toUpperCase() + status.slice(1).toLowerCase();
}

const TIMELINE_STEPS = [
  { key: "placed", label: "Order Placed", icon: Package },
  { key: "processing", label: "Processing", icon: RefreshCw },
  { key: "paid", label: "Payment Confirmed", icon: CreditCard },
  { key: "delivered", label: "Delivered", icon: MapPin },
];

function getTimelineIndex(status: string, paymentStatus: string): number {
  const s = status.toLowerCase();
  const p = paymentStatus.toLowerCase();
  if (s === "delivered" || s === "completed") return 3;
  if (p === "paid" || p === "completed") return 2;
  if (s === "processing") return 1;
  return 0;
}

export default function OrderDetail() {
  const { orderId } = useParams<{ orderId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { convertFromEUR, countryCode } = useShop();
  const [isLive, setIsLive] = useState(false);

  const { data: order, isLoading } = useQuery({
    queryKey: ["order-detail", orderId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("drgreen_orders")
        .select("*")
        .eq("id", orderId)
        .single();
      if (error) throw error;
      return {
        ...data,
        items: (Array.isArray(data.items) ? data.items : []) as unknown as OrderItem[],
        shipping_address: data.shipping_address as Record<string, string> | null,
      } as Order;
    },
    enabled: !!orderId,
  });

  // Realtime subscription — invalidates query when webhook updates this order row
  useEffect(() => {
    if (!orderId) return;

    const channel = supabase
      .channel(`order-detail-${orderId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'drgreen_orders',
          filter: `id=eq.${orderId}`,
        },
        () => {
          queryClient.invalidateQueries({ queryKey: ['order-detail', orderId] });
        }
      )
      .subscribe((status) => {
        setIsLive(status === 'SUBSCRIBED');
      });

    return () => {
      supabase.removeChannel(channel);
    };
  }, [orderId, queryClient]);

  const timelineIdx = order ? getTimelineIndex(order.status, order.payment_status) : 0;

  return (
    <>
      <SEOHead title="Order Details | Healing Buds" description="View your order details" />
      <div className="min-h-screen bg-background">
        <Header />
        <main className="pt-24 pb-24 lg:pb-16">
          <div className="container max-w-3xl mx-auto px-4">
            {/* Back */}
            <button
              onClick={() => navigate("/orders")}
              className="inline-flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors font-medium mb-6"
            >
              <ArrowLeft className="w-4 h-4" />
              Back to Orders
            </button>

            {isLoading ? (
              <div className="space-y-4">
                <Skeleton className="h-10 w-64" />
                <Skeleton className="h-48 w-full rounded-2xl" />
                <Skeleton className="h-48 w-full rounded-2xl" />
              </div>
            ) : !order ? (
              <Card className="rounded-2xl">
                <CardContent className="py-16 text-center">
                  <p className="text-muted-foreground">Order not found.</p>
                  <Button className="mt-4" onClick={() => navigate("/orders")}>
                    Back to Orders
                  </Button>
                </CardContent>
              </Card>
            ) : (
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4 }}
                className="space-y-6"
              >
                {/* Header */}
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <h1 className="text-2xl font-bold text-foreground">Order Details</h1>
                      {isLive && (
                        <span className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400 font-medium">
                          <span className="relative flex h-2 w-2">
                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400/80 opacity-75" />
                            <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500 dark:bg-emerald-400" />
                          </span>
                          Live
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-muted-foreground mt-1">
                      <code className="bg-muted px-2 py-0.5 rounded text-xs">
                        {order.drgreen_order_id}
                      </code>
                      <span className="ml-3">
                        {format(new Date(order.created_at), "dd MMM yyyy, HH:mm")}
                      </span>
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2 items-center">
                    <Badge className={cn("border", getStatusColor(order.status))}>
                      {getDisplayStatus(order.status)}
                    </Badge>
                    <Badge className={cn("border", getStatusColor(order.payment_status))}>
                      {getDisplayStatus(order.payment_status)}
                    </Badge>
                    <Button
                      variant="outline"
                      size="sm"
                      className="rounded-xl"
                      onClick={() => window.print()}
                    >
                      <Printer className="w-4 h-4 mr-1.5" />
                      Print Invoice
                    </Button>
                  </div>
                </div>

                {/* Status Banner */}
                {(order.status === "PENDING_SYNC" || order.payment_status === "AWAITING_PROCESSING" || order.status.toLowerCase() === "pending") ? (
                  <Card className="rounded-2xl border-amber-500/30 bg-amber-500/10">
                    <CardContent className="py-4 px-5 flex items-start gap-3">
                      <Clock className="w-5 h-5 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
                      <div>
                        <p className="font-semibold text-amber-700 dark:text-amber-300">Order Queued for Processing</p>
                        <p className="text-sm text-amber-600/80 dark:text-amber-400/80 mt-1">
                          Your order has been received and saved securely. Our team will process it and confirm via email.
                        </p>
                      </div>
                    </CardContent>
                  </Card>
                ) : (order.payment_status.toLowerCase() === "paid" || order.status.toLowerCase() === "confirmed" || order.status.toLowerCase() === "completed") ? (
                  <Card className="rounded-2xl border-emerald-500/30 bg-emerald-500/10">
                    <CardContent className="py-4 px-5 flex items-center gap-3">
                      <CheckCircle2 className="w-5 h-5 text-emerald-600 dark:text-emerald-400 shrink-0" />
                      <p className="font-semibold text-emerald-700 dark:text-emerald-300">Order Confirmed</p>
                    </CardContent>
                  </Card>
                ) : null}

                {/* Timeline */}
                <Card className="rounded-2xl border-border/50">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base">Order Progress</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="flex items-center justify-between relative">
                      {/* Line */}
                      <div className="absolute top-5 left-0 right-0 h-0.5 bg-border" />
                      <div
                        className="absolute top-5 left-0 h-0.5 bg-primary transition-all duration-500"
                        style={{ width: `${(timelineIdx / (TIMELINE_STEPS.length - 1)) * 100}%` }}
                      />
                      {TIMELINE_STEPS.map((step, i) => {
                        const active = i <= timelineIdx;
                        const Icon = step.icon;
                        return (
                          <div key={step.key} className="flex flex-col items-center z-10 relative">
                            <div
                              className={cn(
                                "w-10 h-10 rounded-full flex items-center justify-center border-2 transition-colors",
                                active
                                  ? "bg-primary border-primary text-primary-foreground"
                                  : "bg-background border-border text-muted-foreground"
                              )}
                            >
                              <Icon className="w-4 h-4" />
                            </div>
                            <span
                              className={cn(
                                "text-xs mt-2 text-center max-w-[70px]",
                                active ? "text-foreground font-medium" : "text-muted-foreground"
                              )}
                            >
                              {step.label}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </CardContent>
                </Card>

                {/* Items */}
                <Card className="rounded-2xl border-border/50">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base">Items</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {order.items.map((item, i) => (
                      <div key={i} className="flex items-center justify-between">
                        <div>
                          <p className="font-medium text-foreground">{item.strain_name}</p>
                          <p className="text-sm text-muted-foreground">
                            Qty: {item.quantity} × {formatPrice(convertFromEUR(item.unit_price), countryCode)}
                          </p>
                        </div>
                        <p className="font-semibold text-foreground">
                          {formatPrice(convertFromEUR(item.quantity * item.unit_price), countryCode)}
                        </p>
                      </div>
                    ))}
                    <Separator />
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-foreground">Total</span>
                      <span className="text-lg font-bold text-foreground">
                        {formatPrice(convertFromEUR(order.total_amount), countryCode)}
                      </span>
                    </div>
                  </CardContent>
                </Card>

                {/* Shipping */}
                {order.shipping_address && (
                  <Card className="rounded-2xl border-border/50">
                    <CardHeader className="pb-2">
                      <CardTitle className="text-base flex items-center gap-2">
                        <MapPin className="w-4 h-4" /> Shipping Address
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="text-sm text-muted-foreground space-y-1">
                      {order.customer_name && <p className="font-medium text-foreground">{order.customer_name}</p>}
                      {order.shipping_address.address1 && <p>{order.shipping_address.address1}</p>}
                      {order.shipping_address.address2 && <p>{order.shipping_address.address2}</p>}
                      {(order.shipping_address.city || order.shipping_address.state) && (
                        <p>
                          {[order.shipping_address.city, order.shipping_address.state]
                            .filter(Boolean)
                            .join(", ")}
                        </p>
                      )}
                      {order.shipping_address.postalCode && <p>{order.shipping_address.postalCode}</p>}
                      {order.shipping_address.country && <p>{order.shipping_address.country}</p>}
                    </CardContent>
                  </Card>
                )}

                {/* Sync Status (for admin/debug visibility) */}
                {order.sync_status && order.sync_status !== 'synced' && (
                  <Card className="rounded-2xl border-amber-500/30 bg-amber-500/5">
                    <CardHeader className="pb-2">
                      <CardTitle className="text-base flex items-center gap-2">
                        <RefreshCw className="w-4 h-4" /> Sync Status
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="text-sm space-y-2">
                      <div className="flex items-center gap-2">
                        <Badge className={cn("border", order.sync_status === 'failed' ? 'bg-red-500/20 text-red-600 dark:text-red-400 border-red-500/30' : 'bg-amber-500/20 text-amber-600 dark:text-amber-400 border-amber-500/30')}>
                          {order.sync_status === 'failed' ? 'Sync Failed' : 'Pending Sync'}
                        </Badge>
                      </div>
                      {order.sync_error && (
                        <p className="text-muted-foreground text-xs bg-muted p-2 rounded">
                          {order.sync_error}
                        </p>
                      )}
                    </CardContent>
                  </Card>
                )}
              </motion.div>
            )}
          </div>
        </main>
        <Footer />
        <MobileBottomActions />
      </div>
    </>
  );
}
