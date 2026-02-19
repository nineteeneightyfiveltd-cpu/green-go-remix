/**
 * Admin Order Detail Component
 * 
 * Slide-over panel showing full order details with actions.
 */

import { format } from "date-fns";
import { formatPrice } from "@/lib/currency";
import { DEFAULT_COUNTRY } from "@/lib/countries";
import { motion } from "framer-motion";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  RefreshCw,
  Package,
  User,
  MapPin,
  Calendar,
  CreditCard,
  AlertTriangle,
  CheckCircle,
  Clock,
  XCircle,
  Flag,
  RotateCcw,
} from "lucide-react";
import { LocalOrder, SyncStatus, OrderStatus, PaymentStatus } from "@/hooks/useAdminOrderSync";
import { cn } from "@/lib/utils";
import { useState } from "react";

interface AdminOrderDetailProps {
  order: LocalOrder | null;
  open: boolean;
  onClose: () => void;
  onSyncOrder: (orderId: string) => void;
  onResetSync: (orderId: string) => void;
  onFlagForReview: (orderId: string, reason: string) => void;
  onUpdateStatus: (orderId: string, status?: OrderStatus, paymentStatus?: PaymentStatus) => void;
  isSyncing: boolean;
  isUpdating: boolean;
}

const getSyncStatusIcon = (status: SyncStatus) => {
  switch (status) {
    case "synced":
      return <CheckCircle className="w-5 h-5 text-emerald-500" />;
    case "pending":
      return <Clock className="w-5 h-5 text-amber-500" />;
    case "failed":
      return <XCircle className="w-5 h-5 text-destructive" />;
    case "manual_review":
      return <AlertTriangle className="w-5 h-5 text-purple-500" />;
    default:
      return null;
  }
};

export function AdminOrderDetail({
  order,
  open,
  onClose,
  onSyncOrder,
  onResetSync,
  onFlagForReview,
  onUpdateStatus,
  isSyncing,
  isUpdating,
}: AdminOrderDetailProps) {
  const [showFlagInput, setShowFlagInput] = useState(false);
  const [flagReason, setFlagReason] = useState("");

  if (!order) return null;

  const shippingAddress = order.shipping_address as unknown as Record<string, string> | null;

  const handleFlagSubmit = () => {
    if (flagReason.trim()) {
      onFlagForReview(order.id, flagReason);
      setFlagReason("");
      setShowFlagInput(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <SheetContent className="w-full sm:max-w-lg">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Package className="w-5 h-5" />
            Order Details
          </SheetTitle>
          <SheetDescription>
            {order.drgreen_order_id || order.id}
          </SheetDescription>
        </SheetHeader>

        <ScrollArea className="h-[calc(100vh-120px)] mt-6 pr-4">
          <div className="space-y-6">
            {/* Sync Status Section */}
            <div className="rounded-lg border border-border p-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Sync Status</span>
                {getSyncStatusIcon(order.sync_status)}
              </div>

              <div className="flex items-center gap-2">
                <Badge
                  variant="outline"
                  className={cn(
                    "capitalize",
                    order.sync_status === "synced" && "bg-emerald-500/10 text-emerald-600",
                    order.sync_status === "pending" && "bg-amber-500/10 text-amber-600",
                    order.sync_status === "failed" && "bg-destructive/10 text-destructive",
                    order.sync_status === "manual_review" && "bg-purple-500/10 text-purple-600"
                  )}
                >
                  {order.sync_status.replace("_", " ")}
                </Badge>
                {order.synced_at && (
                  <span className="text-xs text-muted-foreground">
                    Synced {format(new Date(order.synced_at), "dd MMM yyyy HH:mm")}
                  </span>
                )}
              </div>

              {order.sync_error && (
                <div className="text-sm text-destructive bg-destructive/10 p-2 rounded">
                  {order.sync_error}
                </div>
              )}

              <div className="flex gap-2 pt-2">
                {order.sync_status !== "synced" && (
                  <Button
                    size="sm"
                    onClick={() => onSyncOrder(order.id)}
                    disabled={isSyncing}
                  >
                    <RefreshCw className={cn("w-4 h-4 mr-2", isSyncing && "animate-spin")} />
                    Sync Now
                  </Button>
                )}
                {order.sync_status === "failed" && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onResetSync(order.id)}
                  >
                    <RotateCcw className="w-4 h-4 mr-2" />
                    Reset
                  </Button>
                )}
              </div>
            </div>

            <Separator />

            {/* Order Info */}
            <div className="space-y-4">
              <h4 className="text-sm font-medium flex items-center gap-2">
                <Calendar className="w-4 h-4" />
                Order Information
              </h4>

              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-muted-foreground">Created</p>
                  <p className="font-medium">
                    {format(new Date(order.created_at), "dd MMM yyyy HH:mm")}
                  </p>
                </div>
                <div>
                  <p className="text-muted-foreground">Status</p>
                  <Select
                    value={order.status}
                    onValueChange={(value) =>
                      onUpdateStatus(order.id, value as OrderStatus, undefined)
                    }
                    disabled={isUpdating}
                  >
                    <SelectTrigger className="h-8 w-32">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="PENDING">Pending</SelectItem>
                      <SelectItem value="CONFIRMED">Confirmed</SelectItem>
                      <SelectItem value="PROCESSING">Processing</SelectItem>
                      <SelectItem value="SHIPPED">Shipped</SelectItem>
                      <SelectItem value="DELIVERED">Delivered</SelectItem>
                      <SelectItem value="CANCELLED">Cancelled</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <p className="text-muted-foreground">Total</p>
                  <p className="font-medium text-lg">{formatPrice(order.total_amount ?? 0, order.country_code || DEFAULT_COUNTRY)}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Payment</p>
                  <Select
                    value={order.payment_status}
                    onValueChange={(value) =>
                      onUpdateStatus(order.id, undefined, value as PaymentStatus)
                    }
                    disabled={isUpdating}
                  >
                    <SelectTrigger className="h-8 w-32">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="PENDING">Pending</SelectItem>
                      <SelectItem value="PAID">Paid</SelectItem>
                      <SelectItem value="FAILED">Failed</SelectItem>
                      <SelectItem value="REFUNDED">Refunded</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>

            <Separator />

            {/* Customer Info */}
            <div className="space-y-4">
              <h4 className="text-sm font-medium flex items-center gap-2">
                <User className="w-4 h-4" />
                Customer
              </h4>

              <div className="text-sm space-y-2">
                <p className="font-medium">{order.customer_name || "Unknown"}</p>
                <p className="text-muted-foreground">{order.customer_email || "No email"}</p>
                {order.client_id && (
                  <p className="text-xs text-muted-foreground font-mono">
                    Client ID: {order.client_id}
                  </p>
                )}
              </div>
            </div>

            <Separator />

            {/* Shipping Address */}
            <div className="space-y-4">
              <h4 className="text-sm font-medium flex items-center gap-2">
                <MapPin className="w-4 h-4" />
                Shipping Address
              </h4>

              {shippingAddress ? (
                <div className="text-sm space-y-1">
                  <p>{shippingAddress.address1}</p>
                  {shippingAddress.address2 && <p>{shippingAddress.address2}</p>}
                  <p>
                    {shippingAddress.city}, {shippingAddress.state} {shippingAddress.postalCode}
                  </p>
                  <p>{shippingAddress.country}</p>
                </div>
              ) : (
                <p className="text-sm text-destructive flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4" />
                  No shipping address on file
                </p>
              )}
            </div>

            <Separator />

            {/* Order Items */}
            <div className="space-y-4">
              <h4 className="text-sm font-medium flex items-center gap-2">
                <Package className="w-4 h-4" />
                Items ({order.items?.length || 0})
              </h4>

              <div className="space-y-3">
                {order.items?.map((item, index) => (
                  <motion.div
                    key={index}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: index * 0.05 }}
                    className="flex items-center justify-between p-3 bg-muted/50 rounded-lg"
                  >
                    <div>
                      <p className="font-medium">{item.strainName}</p>
                      <p className="text-xs text-muted-foreground">
                        Qty: {item.quantity} × {formatPrice(item.unitPrice ?? 0, order.country_code || DEFAULT_COUNTRY)}
                      </p>
                    </div>
                    <p className="font-medium">{formatPrice(item.totalPrice ?? 0, order.country_code || DEFAULT_COUNTRY)}</p>
                  </motion.div>
                ))}
              </div>
            </div>

            <Separator />

            {/* Flag for Review */}
            {order.sync_status !== "manual_review" && (
              <div className="space-y-3">
                {showFlagInput ? (
                  <div className="space-y-2">
                    <textarea
                      value={flagReason}
                      onChange={(e) => setFlagReason(e.target.value)}
                      placeholder="Enter reason for flagging..."
                      className="w-full h-20 p-2 text-sm border border-border rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-primary/50"
                    />
                    <div className="flex gap-2">
                      <Button size="sm" onClick={handleFlagSubmit}>
                        Submit
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setShowFlagInput(false);
                          setFlagReason("");
                        }}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full"
                    onClick={() => setShowFlagInput(true)}
                  >
                    <Flag className="w-4 h-4 mr-2" />
                    Flag for Manual Review
                  </Button>
                )}
              </div>
            )}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
