/**
 * Admin Orders Table Component
 * 
 * Displays orders in a data table with sorting, selection, pagination, and actions.
 */

import { useState, useMemo } from "react";
import { format } from "date-fns";
import { formatPrice } from "@/lib/currency";
import { DEFAULT_COUNTRY } from "@/lib/countries";
import { motion } from "framer-motion";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  RefreshCw,
  MoreHorizontal,
  Eye,
  AlertTriangle,
  CheckCircle,
  Clock,
  XCircle,
  RotateCcw,
  Flag,
  PlayCircle,
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
} from "lucide-react";
import { LocalOrder, SyncStatus, OrderStatus, PaymentStatus } from "@/hooks/useAdminOrderSync";
import { cn } from "@/lib/utils";

type SortField = "created_at" | "total_amount" | "status" | "payment_status" | "sync_status";
type SortDirection = "asc" | "desc";

interface AdminOrdersTableProps {
  orders: LocalOrder[];
  isLoading: boolean;
  selectedOrders: string[];
  onToggleSelect: (orderId: string) => void;
  onSelectAll: (orderIds: string[]) => void;
  onViewOrder: (order: LocalOrder) => void;
  onSyncOrder: (orderId: string) => void;
  onResetSync: (orderId: string) => void;
  onFlagForReview: (orderId: string) => void;
  onProcessOrder?: (orderId: string) => void;
  isSyncing: boolean;
  isProcessing?: boolean;
}

const getSyncStatusBadge = (status: SyncStatus) => {
  switch (status) {
    case "synced":
      return (
        <Badge variant="outline" className="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20">
          <CheckCircle className="w-3 h-3 mr-1" />
          Synced
        </Badge>
      );
    case "pending":
      return (
        <Badge variant="outline" className="bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20">
          <Clock className="w-3 h-3 mr-1" />
          Pending
        </Badge>
      );
    case "failed":
      return (
        <Badge variant="outline" className="bg-destructive/10 text-destructive border-destructive/20">
          <XCircle className="w-3 h-3 mr-1" />
          Failed
        </Badge>
      );
    case "manual_review":
      return (
        <Badge variant="outline" className="bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/20">
          <AlertTriangle className="w-3 h-3 mr-1" />
          Review
        </Badge>
      );
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
};

const getOrderStatusBadge = (status: OrderStatus) => {
  const statusConfig: Record<OrderStatus, { className: string; label: string }> = {
    PENDING: { className: "bg-amber-500/10 text-amber-600 dark:text-amber-400", label: "Pending" },
    CONFIRMED: { className: "bg-blue-500/10 text-blue-600 dark:text-blue-400", label: "Confirmed" },
    PROCESSING: { className: "bg-indigo-500/10 text-indigo-600 dark:text-indigo-400", label: "Processing" },
    SHIPPED: { className: "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400", label: "Shipped" },
    DELIVERED: { className: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400", label: "Delivered" },
    CANCELLED: { className: "bg-destructive/10 text-destructive", label: "Cancelled" },
  };

  const config = statusConfig[status] || { className: "", label: status };

  return (
    <Badge variant="outline" className={cn("border-transparent", config.className)}>
      {config.label}
    </Badge>
  );
};

const getPaymentStatusBadge = (status: PaymentStatus) => {
  const statusConfig: Record<PaymentStatus, { className: string; label: string }> = {
    PENDING: { className: "bg-amber-500/10 text-amber-600 dark:text-amber-400", label: "Pending" },
    PAID: { className: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400", label: "Paid" },
    FAILED: { className: "bg-destructive/10 text-destructive", label: "Failed" },
    REFUNDED: { className: "bg-purple-500/10 text-purple-600 dark:text-purple-400", label: "Refunded" },
  };

  const config = statusConfig[status] || { className: "", label: status };

  return (
    <Badge variant="outline" className={cn("border-transparent", config.className)}>
      {config.label}
    </Badge>
  );
};

const STATUS_ORDER: Record<string, number> = {
  PENDING: 0, CONFIRMED: 1, PROCESSING: 2, SHIPPED: 3, DELIVERED: 4, CANCELLED: 5,
};
const PAYMENT_ORDER: Record<string, number> = {
  PENDING: 0, PAID: 1, FAILED: 2, REFUNDED: 3,
};
const SYNC_ORDER: Record<string, number> = {
  pending: 0, failed: 1, manual_review: 2, synced: 3,
};

function SortableHeader({
  label,
  field,
  currentField,
  currentDirection,
  onSort,
  className,
}: {
  label: string;
  field: SortField;
  currentField: SortField;
  currentDirection: SortDirection;
  onSort: (field: SortField) => void;
  className?: string;
}) {
  const isActive = currentField === field;
  return (
    <TableHead className={cn("cursor-pointer select-none group", className)} onClick={() => onSort(field)}>
      <div className="flex items-center gap-1">
        <span>{label}</span>
        {isActive ? (
          currentDirection === "asc" ? (
            <ArrowUp className="w-3.5 h-3.5 text-foreground" />
          ) : (
            <ArrowDown className="w-3.5 h-3.5 text-foreground" />
          )
        ) : (
          <ArrowUpDown className="w-3.5 h-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
        )}
      </div>
    </TableHead>
  );
}

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100];

export function AdminOrdersTable({
  orders,
  isLoading,
  selectedOrders,
  onToggleSelect,
  onSelectAll,
  onViewOrder,
  onSyncOrder,
  onResetSync,
  onFlagForReview,
  onProcessOrder,
  isSyncing,
  isProcessing,
}: AdminOrdersTableProps) {
  const [sortField, setSortField] = useState<SortField>("created_at");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(d => d === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDirection("desc");
    }
    setCurrentPage(1);
  };

  // Sort orders
  const sortedOrders = useMemo(() => {
    const sorted = [...orders].sort((a, b) => {
      let cmp = 0;
      switch (sortField) {
        case "created_at":
          cmp = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
          break;
        case "total_amount":
          cmp = (a.total_amount ?? 0) - (b.total_amount ?? 0);
          break;
        case "status":
          cmp = (STATUS_ORDER[a.status] ?? 99) - (STATUS_ORDER[b.status] ?? 99);
          break;
        case "payment_status":
          cmp = (PAYMENT_ORDER[a.payment_status] ?? 99) - (PAYMENT_ORDER[b.payment_status] ?? 99);
          break;
        case "sync_status":
          cmp = (SYNC_ORDER[a.sync_status] ?? 99) - (SYNC_ORDER[b.sync_status] ?? 99);
          break;
      }
      return sortDirection === "asc" ? cmp : -cmp;
    });
    return sorted;
  }, [orders, sortField, sortDirection]);

  // Pagination
  const totalPages = Math.max(1, Math.ceil(sortedOrders.length / pageSize));
  const paginatedOrders = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return sortedOrders.slice(start, start + pageSize);
  }, [sortedOrders, currentPage, pageSize]);

  // Reset page if it exceeds total
  if (currentPage > totalPages && totalPages > 0) {
    setCurrentPage(totalPages);
  }

  const allSelected = paginatedOrders.length > 0 && paginatedOrders.every(o => selectedOrders.includes(o.id));
  const someSelected = paginatedOrders.some(o => selectedOrders.includes(o.id)) && !allSelected;

  if (isLoading) {
    return (
      <div className="space-y-2">
        {[...Array(5)].map((_, i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
    );
  }

  if (orders.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        <p>No orders found matching your filters.</p>
      </div>
    );
  }

  return (
    <div className="space-y-0">
      <div className="rounded-lg border border-border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/50">
              <TableHead className="w-12">
                <Checkbox
                  checked={allSelected}
                  ref={(el) => {
                    if (el) {
                      (el as HTMLButtonElement & { indeterminate?: boolean }).indeterminate = someSelected;
                    }
                  }}
                  onCheckedChange={(checked) => {
                    if (checked) {
                      onSelectAll(paginatedOrders.map((o) => o.id));
                    } else {
                      onSelectAll([]);
                    }
                  }}
                />
              </TableHead>
              <SortableHeader label="Date" field="created_at" currentField={sortField} currentDirection={sortDirection} onSort={handleSort} />
              <TableHead>Order Ref</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead>Items</TableHead>
              <SortableHeader label="Total" field="total_amount" currentField={sortField} currentDirection={sortDirection} onSort={handleSort} className="text-right" />
              <SortableHeader label="Status" field="status" currentField={sortField} currentDirection={sortDirection} onSort={handleSort} />
              <SortableHeader label="Payment" field="payment_status" currentField={sortField} currentDirection={sortDirection} onSort={handleSort} />
              <SortableHeader label="Sync" field="sync_status" currentField={sortField} currentDirection={sortDirection} onSort={handleSort} />
              <TableHead className="w-12"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {paginatedOrders.map((order, index) => {
              const items = Array.isArray(order.items) ? order.items : [];
              const itemNames = items
                .map((item: any) => item.strain_name || item.name || item.strainName || 'Unknown')
                .filter(Boolean);
              const displayNames = itemNames.slice(0, 2).join(", ");
              const moreCount = itemNames.length - 2;
              const itemSummary = itemNames.length > 0
                ? (moreCount > 0 ? `${displayNames} +${moreCount} more` : displayNames)
                : `${items.length} items`;

              return (
              <motion.tr
                key={order.id}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: index * 0.02 }}
                className={cn(
                  "border-b transition-colors hover:bg-muted/50 cursor-pointer",
                  selectedOrders.includes(order.id) && "bg-primary/5"
                )}
                onClick={() => onViewOrder(order)}
              >
                <TableCell onClick={(e) => e.stopPropagation()}>
                  <Checkbox
                    checked={selectedOrders.includes(order.id)}
                    onCheckedChange={() => onToggleSelect(order.id)}
                  />
                </TableCell>
                <TableCell className="text-muted-foreground text-sm">
                  {format(new Date(order.created_at), "dd MMM yyyy")}
                  <br />
                  <span className="text-xs">
                    {format(new Date(order.created_at), "HH:mm")}
                  </span>
                </TableCell>
                <TableCell>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="font-mono text-sm cursor-pointer hover:text-primary">
                        {order.drgreen_order_id?.slice(0, 12) || order.id.slice(0, 8)}...
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>
                      {order.drgreen_order_id || order.id}
                    </TooltipContent>
                  </Tooltip>
                </TableCell>
                <TableCell>
                  <div className="max-w-[150px]">
                    <p className="font-medium truncate">
                      {order.customer_name || "Unknown"}
                    </p>
                    <p className="text-xs text-muted-foreground truncate">
                      {order.customer_email || "No email"}
                    </p>
                  </div>
                </TableCell>
                <TableCell>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="text-sm">
                        {itemSummary}
                      </span>
                    </TooltipTrigger>
                    {itemNames.length > 0 && (
                      <TooltipContent>
                        <ul className="text-xs space-y-0.5">
                          {itemNames.map((name: string, i: number) => (
                            <li key={i}>{name}</li>
                          ))}
                        </ul>
                      </TooltipContent>
                    )}
                  </Tooltip>
                </TableCell>
                <TableCell className="text-right font-medium">
                  {formatPrice(order.total_amount ?? 0, order.country_code || DEFAULT_COUNTRY)}
                </TableCell>
                <TableCell>{getOrderStatusBadge(order.status)}</TableCell>
                <TableCell>{getPaymentStatusBadge(order.payment_status)}</TableCell>
                <TableCell>
                  {order.sync_error ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <div>{getSyncStatusBadge(order.sync_status)}</div>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-xs">
                        <p className="text-destructive">{order.sync_error}</p>
                      </TooltipContent>
                    </Tooltip>
                  ) : (
                    getSyncStatusBadge(order.sync_status)
                  )}
                </TableCell>
                <TableCell onClick={(e) => e.stopPropagation()}>
                  <div className="flex items-center gap-1">
                    {order.sync_status === "pending" && order.status === "PENDING" && onProcessOrder && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-emerald-600 hover:text-emerald-700 hover:bg-emerald-500/10"
                            onClick={() => onProcessOrder(order.id)}
                            disabled={isProcessing}
                          >
                            <PlayCircle className="h-4 w-4" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Confirm & Process</TooltipContent>
                      </Tooltip>
                    )}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-8 w-8">
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => onViewOrder(order)}>
                          <Eye className="h-4 w-4 mr-2" />
                          View Details
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        {order.sync_status === "pending" && order.status === "PENDING" && onProcessOrder && (
                          <DropdownMenuItem onClick={() => onProcessOrder(order.id)}>
                            <PlayCircle className="h-4 w-4 mr-2" />
                            Confirm & Process
                          </DropdownMenuItem>
                        )}
                        {order.sync_status !== "synced" && (
                          <DropdownMenuItem
                            onClick={() => onSyncOrder(order.id)}
                            disabled={isSyncing}
                          >
                            <RefreshCw className={cn("h-4 w-4 mr-2", isSyncing && "animate-spin")} />
                            Sync to API
                          </DropdownMenuItem>
                        )}
                        {order.sync_status === "failed" && (
                          <DropdownMenuItem onClick={() => onResetSync(order.id)}>
                            <RotateCcw className="h-4 w-4 mr-2" />
                            Reset Status
                          </DropdownMenuItem>
                        )}
                        {order.sync_status !== "manual_review" && (
                          <DropdownMenuItem onClick={() => onFlagForReview(order.id)}>
                            <Flag className="h-4 w-4 mr-2" />
                            Flag for Review
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </TableCell>
              </motion.tr>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {/* Pagination Controls */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-3 px-2 py-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span>Showing</span>
          <Select
            value={String(pageSize)}
            onValueChange={(v) => {
              setPageSize(Number(v));
              setCurrentPage(1);
            }}
          >
            <SelectTrigger className="h-8 w-[70px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PAGE_SIZE_OPTIONS.map((size) => (
                <SelectItem key={size} value={String(size)}>
                  {size}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span>
            of {sortedOrders.length} order{sortedOrders.length !== 1 ? "s" : ""}
          </span>
        </div>

        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={() => setCurrentPage(1)}
            disabled={currentPage === 1}
          >
            <ChevronsLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
            disabled={currentPage === 1}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-sm text-muted-foreground px-3">
            Page {currentPage} of {totalPages}
          </span>
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
            disabled={currentPage === totalPages}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={() => setCurrentPage(totalPages)}
            disabled={currentPage === totalPages}
          >
            <ChevronsRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}