import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { CheckCircle2, Clock, Package, RefreshCw, CreditCard, MapPin, Wifi, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { supabase } from '@/integrations/supabase/client';
import { cn } from '@/lib/utils';

interface OrderConfirmationProps {
  /** The Dr. Green orderId (real UUID) or LOCAL-* fallback id */
  orderId: string;
  /** The local DB row UUID — used for the "View Order Details" link */
  localRowId: string | null;
  /** True when the order was saved locally because the Dr. Green API call failed */
  isLocalOrder: boolean;
}

interface LiveOrderStatus {
  status: string;
  payment_status: string;
}

const TIMELINE_STEPS = [
  { key: 'placed', label: 'Placed', icon: Package },
  { key: 'processing', label: 'Processing', icon: RefreshCw },
  { key: 'payment', label: 'Payment', icon: CreditCard },
  { key: 'delivered', label: 'Delivered', icon: MapPin },
];

function getTimelineIndex(status: string, paymentStatus: string): number {
  const s = status.toLowerCase();
  const p = paymentStatus.toLowerCase();
  if (s === 'delivered' || s === 'completed') return 3;
  if (p === 'paid' || p === 'completed') return 2;
  if (s === 'processing') return 1;
  return 0;
}

function getStatusColor(status: string): string {
  switch (status.toLowerCase()) {
    case 'paid':
    case 'completed':
    case 'delivered':
      return 'bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 border-emerald-500/30';
    case 'processing':
      return 'bg-blue-500/20 text-blue-600 dark:text-blue-400 border-blue-500/30';
    case 'pending':
    case 'awaiting_payment':
    case 'awaiting_processing':
    case 'pending_sync':
      return 'bg-amber-500/20 text-amber-600 dark:text-amber-400 border-amber-500/30';
    case 'cancelled':
    case 'failed':
      return 'bg-red-500/20 text-red-600 dark:text-red-400 border-red-500/30';
    default:
      return 'bg-muted text-muted-foreground border-border';
  }
}

function formatStatus(status: string): string {
  return status
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

export default function OrderConfirmation({ orderId, localRowId, isLocalOrder }: OrderConfirmationProps) {
  const navigate = useNavigate();
  const [liveStatus, setLiveStatus] = useState<LiveOrderStatus>({
    status: isLocalOrder ? 'AWAITING_PROCESSING' : 'PENDING',
    payment_status: isLocalOrder ? 'AWAITING_PROCESSING' : 'AWAITING_PAYMENT',
  });
  const [isLive, setIsLive] = useState(false);
  const [justUpdated, setJustUpdated] = useState(false);

  // Subscribe to realtime for real orders only
  useEffect(() => {
    if (isLocalOrder || !orderId) return;

    const channel = supabase
      .channel(`order-confirmation-${orderId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'drgreen_orders',
          filter: `drgreen_order_id=eq.${orderId}`,
        },
        (payload) => {
          const updated = payload.new as { status: string; payment_status: string };
          setLiveStatus({
            status: updated.status,
            payment_status: updated.payment_status,
          });
          setJustUpdated(true);
          setTimeout(() => setJustUpdated(false), 3000);
        }
      )
      .subscribe((status) => {
        setIsLive(status === 'SUBSCRIBED');
      });

    return () => {
      supabase.removeChannel(channel);
    };
  }, [orderId, isLocalOrder]);

  const timelineIdx = getTimelineIndex(liveStatus.status, liveStatus.payment_status);
  const shortId = orderId?.length > 20 ? `${orderId.slice(0, 8)}…${orderId.slice(-4)}` : orderId;

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center px-4 py-16">
      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45 }}
        className="w-full max-w-lg"
      >
        <Card className="rounded-2xl border-border/50 bg-card/80 backdrop-blur-sm shadow-xl">
          <CardContent className="pt-10 pb-8 px-8 space-y-7">
            {/* Icon + Heading */}
            <div className="text-center">
              <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ type: 'spring', stiffness: 260, damping: 20, delay: 0.1 }}
                className={cn(
                  'w-20 h-20 mx-auto mb-5 rounded-full flex items-center justify-center',
                  isLocalOrder
                    ? 'bg-amber-500/20 dark:bg-amber-400/10'
                    : 'bg-primary/20'
                )}
              >
                {isLocalOrder
                  ? <Clock className="w-10 h-10 text-amber-600 dark:text-amber-400" />
                  : <CheckCircle2 className="w-10 h-10 text-primary" />
                }
              </motion.div>
              <h1 className="text-2xl font-bold text-foreground">
                {isLocalOrder ? 'Order Received' : 'Order Confirmed!'}
              </h1>
              <p className="text-sm text-muted-foreground mt-1">
                {isLocalOrder
                  ? 'Your order has been saved and will be reviewed by our team.'
                  : 'Your order has been submitted to Dr. Green for processing.'}
              </p>
            </div>

            {/* Order ID + Live Badges */}
            <div className="rounded-xl bg-muted/40 border border-border/50 px-4 py-3 space-y-2">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div>
                  <p className="text-xs text-muted-foreground mb-0.5">Order ID</p>
                  <code className="text-sm font-mono text-foreground">{shortId}</code>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  {!isLocalOrder && isLive && (
                    <span className="flex items-center gap-1 text-xs text-[hsl(var(--success,142,71%,45%))] text-emerald-600 dark:text-emerald-400">
                      <span className="relative flex h-2 w-2">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400/80 opacity-75" />
                        <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500 dark:bg-emerald-400" />
                      </span>
                      Live
                    </span>
                  )}
                  <Badge className={cn('border text-xs', getStatusColor(liveStatus.status))}>
                    {formatStatus(liveStatus.status)}
                  </Badge>
                  <Badge className={cn('border text-xs', getStatusColor(liveStatus.payment_status))}>
                    {formatStatus(liveStatus.payment_status)}
                  </Badge>
                </div>
              </div>

              {/* Status Updated pulse */}
              <AnimatePresence>
                {justUpdated && (
                  <motion.p
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    className="text-xs text-emerald-600 dark:text-emerald-400 flex items-center gap-1 pt-1"
                  >
                    <Wifi className="w-3 h-3" /> Status updated just now
                  </motion.p>
                )}
              </AnimatePresence>
            </div>

            {/* Timeline — only for real orders */}
            {!isLocalOrder && (
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Order Progress</p>
                <div className="flex items-start justify-between relative">
                  {/* Background line */}
                  <div className="absolute top-4 left-4 right-4 h-0.5 bg-border" />
                  {/* Active line */}
                  <div
                    className="absolute top-4 left-4 h-0.5 bg-primary transition-all duration-700 ease-out"
                    style={{
                      width: `calc(${(timelineIdx / (TIMELINE_STEPS.length - 1)) * 100}% - 2rem + ${timelineIdx === TIMELINE_STEPS.length - 1 ? '2rem' : '0px'})`,
                    }}
                  />
                  {TIMELINE_STEPS.map((step, i) => {
                    const active = i <= timelineIdx;
                    const Icon = step.icon;
                    return (
                      <div key={step.key} className="flex flex-col items-center z-10 relative" style={{ flex: 1 }}>
                        <motion.div
                          animate={active ? { scale: [1, 1.15, 1] } : {}}
                          transition={{ duration: 0.4 }}
                          className={cn(
                            'w-8 h-8 rounded-full flex items-center justify-center border-2 transition-colors duration-500',
                            active
                              ? 'bg-primary border-primary text-primary-foreground'
                              : 'bg-background border-border text-muted-foreground'
                          )}
                        >
                          <Icon className="w-3.5 h-3.5" />
                        </motion.div>
                        <span className={cn(
                          'text-[10px] mt-1.5 text-center leading-tight',
                          active ? 'text-foreground font-medium' : 'text-muted-foreground'
                        )}>
                          {step.label}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Info notice */}
            <div className="rounded-lg border border-border/40 bg-muted/30 p-3 flex items-start gap-2.5 text-sm">
              <Info className="w-4 h-4 text-muted-foreground mt-0.5 shrink-0" />
              <p className="text-muted-foreground">
                {isLocalOrder
                  ? 'Our team will review your order and reach out via email with next steps and payment instructions.'
                  : 'Payment is handled by our team. You\'ll receive an email when your payment is confirmed and your order is dispatched.'
                }
              </p>
            </div>

            {/* Actions */}
            <div className="flex flex-col sm:flex-row gap-3 pt-1">
              {localRowId && (
                <Button
                  className="flex-1"
                  onClick={() => navigate(`/orders/${localRowId}`)}
                >
                  View Order Details
                </Button>
              )}
              <Button
                variant="outline"
                className="flex-1"
                onClick={() => navigate('/shop')}
              >
                Continue Shopping
              </Button>
            </div>
          </CardContent>
        </Card>
      </motion.div>
    </div>
  );
}
