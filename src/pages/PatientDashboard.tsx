import { motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { 
  User, 
  Package, 
  ShoppingCart, 
  CheckCircle2, 
  Clock, 
  AlertCircle,
  Shield,
  FileText,
  ArrowRight,
  ExternalLink,
  MapPin,
  Pencil,
  RefreshCw,
  Download
} from 'lucide-react';
import PrescriptionManager from '@/components/dashboard/PrescriptionManager';
import DosageTracker from '@/components/dashboard/DosageTracker';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import Header from '@/layout/Header';
import Footer from '@/components/Footer';
import HBIcon from '@/components/HBIcon';
import HBLoader from '@/components/HBLoader';
import { ShippingAddressForm, type ShippingAddress } from '@/components/shop/ShippingAddressForm';
import { useShop } from '@/context/ShopContext';
import { useOrderTracking } from '@/hooks/useOrderTracking';
import { useDrGreenApi } from '@/hooks/useDrGreenApi';
import { useClientResync } from '@/hooks/useClientResync';
import { supabase } from '@/integrations/supabase/client';
import { useState, useEffect, useRef } from 'react';
import { User as SupabaseUser } from '@supabase/supabase-js';
import { formatPrice } from '@/lib/currency';
import { useToast } from '@/hooks/use-toast';
import { COUNTRY_REGISTRY, DEFAULT_COUNTRY } from '@/lib/countries';

const PatientDashboard = () => {
  const navigate = useNavigate();
  const { drGreenClient, isEligible, isLoading: clientLoading, cart, cartTotal } = useShop();
  const { orders, isLoading: ordersLoading } = useOrderTracking();
  const { getClientDetails } = useDrGreenApi();
  const { resyncClient, isResyncing } = useClientResync();
  const { toast } = useToast();
  const [user, setUser] = useState<SupabaseUser | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [profile, setProfile] = useState<{ full_name: string | null } | null>(null);
  const [shippingAddress, setShippingAddress] = useState<ShippingAddress | null>(null);
  const [isLoadingAddress, setIsLoadingAddress] = useState(true);
  const [isAddressDialogOpen, setIsAddressDialogOpen] = useState(false);
  const [showResyncDialog, setShowResyncDialog] = useState(false);
  // Guard: fetch shipping address only once per clientId — prevents infinite loop
  // caused by getClientDetails creating a new function reference on every render
  const hasFetchedAddressRef = useRef(false);

  // Handler for re-syncing client account
  const handleResyncAccount = async () => {
    if (!drGreenClient || !user) return;
    
    const result = await resyncClient({
      id: drGreenClient.id || '',
      email: drGreenClient.email || user.email || '',
      fullName: drGreenClient.full_name || profile?.full_name || '',
      countryCode: drGreenClient.country_code,
      shippingAddress: typeof drGreenClient.shipping_address === 'object' && drGreenClient.shipping_address 
        ? drGreenClient.shipping_address as Record<string, string>
        : undefined,
    });

    if (result.success && result.kycLink) {
      // Redirect to KYC link
      window.open(result.kycLink, '_blank');
    }
    setShowResyncDialog(false);
  };

  const handleGdprExport = async () => {
    setIsExporting(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        toast({ title: 'Error', description: 'You must be signed in to export data.', variant: 'destructive' });
        return;
      }

      const res = await supabase.functions.invoke('gdpr-export', {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });

      if (res.error) throw res.error;

      const blob = new Blob([JSON.stringify(res.data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `healing-buds-data-export-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      toast({ title: 'Export Complete', description: 'Your data has been downloaded.' });
    } catch (err) {
      console.error('GDPR export failed:', err);
      toast({ title: 'Export Failed', description: 'Could not export your data. Please try again.', variant: 'destructive' });
    } finally {
      setIsExporting(false);
    }
  };

  useEffect(() => {
    const fetchUserData = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      setUser(user);

      if (user) {
        const { data } = await supabase
          .from('profiles')
          .select('full_name')
          .eq('id', user.id)
          .maybeSingle();
        setProfile(data);
      }
    };

    fetchUserData();
  }, []);

  // Country code to name mapping from registry
  const countryNames: Record<string, string> = Object.fromEntries(
    Object.entries(COUNTRY_REGISTRY).map(([code, config]) => [code, config.name])
  );

  // Fetch shipping address — runs once per clientId change
  // NOT depending on getClientDetails (new ref every render → infinite loop)
  useEffect(() => {
    if (hasFetchedAddressRef.current) return;
    if (!drGreenClient?.drgreen_client_id) {
      setIsLoadingAddress(false);
      return;
    }

    hasFetchedAddressRef.current = true;

    const fetchShippingAddress = async () => {
      try {
        // Try Dr Green API first
        const result = await getClientDetails(drGreenClient.drgreen_client_id);
        if (result.data?.shipping && result.data.shipping.address1) {
          setShippingAddress(result.data.shipping);
        } else if (drGreenClient.shipping_address && typeof drGreenClient.shipping_address === 'object') {
          // Fallback: load from local DB
          const dbAddr = drGreenClient.shipping_address as Record<string, string>;
          if (dbAddr.address1) {
            setShippingAddress(dbAddr as unknown as ShippingAddress);
          }
        }
      } catch (error) {
        console.error('Failed to fetch shipping address from API, trying DB fallback:', error);
        // Fallback: load from local DB
        if (drGreenClient.shipping_address && typeof drGreenClient.shipping_address === 'object') {
          const dbAddr = drGreenClient.shipping_address as Record<string, string>;
          if (dbAddr.address1) {
            setShippingAddress(dbAddr as unknown as ShippingAddress);
          }
        }
      } finally {
        setIsLoadingAddress(false);
      }
    };

    fetchShippingAddress();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drGreenClient?.drgreen_client_id]); // stable string value only, not function reference

  const handleAddressSaved = (address: ShippingAddress) => {
    setShippingAddress(address);
    setIsAddressDialogOpen(false);
  };

  const getKYCProgress = () => {
    if (!drGreenClient) return 0;
    let progress = 25; // Registered
    if (drGreenClient.kyc_link) progress = 50; // KYC started
    if (drGreenClient.is_kyc_verified) progress = 75; // KYC verified
    if (drGreenClient.admin_approval === 'VERIFIED') progress = 100; // Fully approved
    return progress;
  };

  const getKYCStatus = () => {
    if (!drGreenClient) {
      return { status: 'Not Registered', variant: 'outline' as const, icon: AlertCircle };
    }
    if (drGreenClient.admin_approval === 'VERIFIED' && drGreenClient.is_kyc_verified) {
      return { status: 'Verified Patient', variant: 'default' as const, icon: CheckCircle2 };
    }
    if (drGreenClient.is_kyc_verified) {
      return { status: 'Awaiting Approval', variant: 'secondary' as const, icon: Clock };
    }
    if (drGreenClient.kyc_link) {
      return { status: 'KYC Pending', variant: 'secondary' as const, icon: Clock };
    }
    return { status: 'Complete KYC', variant: 'destructive' as const, icon: AlertCircle };
  };

  const recentOrders = orders.slice(0, 3);
  const pendingOrders = orders.filter(o => 
    !['DELIVERED', 'COMPLETED', 'CANCELLED'].includes(o.status.toUpperCase())
  ).length;

  const kycStatus = getKYCStatus();
  const KYCIcon = kycStatus.icon;

  if (!user) {
    return (
      <div className="min-h-screen bg-background">
        <Header />
        <main className="pt-32 pb-20">
          <div className="container mx-auto px-4 text-center">
            <Card className="max-w-md mx-auto bg-card/50 backdrop-blur-sm border-border/50">
              <CardContent className="pt-12 pb-8">
                <HBIcon size="xl" className="mx-auto mb-6 opacity-50" />
                <h2 className="text-2xl font-bold text-foreground mb-4">Sign In Required</h2>
                <p className="text-muted-foreground mb-6">
                  Please sign in to access your patient dashboard.
                </p>
                <Button onClick={() => navigate('/auth')}>Sign In</Button>
              </CardContent>
            </Card>
          </div>
        </main>
        <Footer />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <Header />
      <main className="pt-32 pb-24 lg:pb-20">
        <div className="container mx-auto px-4">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="max-w-6xl mx-auto"
          >
            {/* Welcome Section */}
            <div className="mb-8">
              <h1 className="text-3xl font-bold text-foreground mb-2">
                Welcome back{profile?.full_name ? `, ${profile.full_name}` : ''}
              </h1>
              <p className="text-muted-foreground">
                Manage your medical cannabis prescriptions and orders
              </p>
            </div>

            <div className="grid lg:grid-cols-3 gap-6">
              {/* Left Column - Status Cards */}
              <div className="lg:col-span-2 space-y-6">
                {/* KYC Status Card */}
                <Card className="bg-card/50 backdrop-blur-sm border-border/50">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <Shield className="h-5 w-5" />
                      Verification Status
                    </CardTitle>
                    <CardDescription>
                      Your medical eligibility and KYC verification progress
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className={`p-2 rounded-full ${
                          isEligible ? 'bg-primary/20' : 'bg-yellow-500/20'
                        }`}>
                          <KYCIcon className={`h-5 w-5 ${
                            isEligible ? 'text-primary' : 'text-yellow-600'
                          }`} />
                        </div>
                        <div>
                          <p className="font-medium text-foreground">{kycStatus.status}</p>
                          <p className="text-sm text-muted-foreground">
                            {isEligible 
                              ? 'You can purchase medical cannabis' 
                              : 'Complete verification to shop'}
                          </p>
                        </div>
                      </div>
                      <Badge variant={kycStatus.variant}>{kycStatus.status}</Badge>
                    </div>

                    <div className="space-y-2">
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">Verification Progress</span>
                        <span className="font-medium">{getKYCProgress()}%</span>
                      </div>
                      <Progress value={getKYCProgress()} className="h-2" />
                    </div>

                    {!isEligible && (
                      <div className="flex flex-col sm:flex-row gap-3 pt-2">
                        {!drGreenClient ? (
                          <Button onClick={() => navigate('/shop/register')} className="flex-1">
                            Complete Registration
                            <ArrowRight className="ml-2 h-4 w-4" />
                          </Button>
                        ) : drGreenClient.kyc_link && !drGreenClient.is_kyc_verified ? (
                          <Button asChild className="flex-1">
                            <a href={drGreenClient.kyc_link} target="_blank" rel="noopener noreferrer">
                              Complete KYC
                              <ExternalLink className="ml-2 h-4 w-4" />
                            </a>
                          </Button>
                        ) : (
                          <Button variant="secondary" disabled className="flex-1">
                            <Clock className="mr-2 h-4 w-4" />
                            Awaiting Admin Approval
                          </Button>
                        )}
                      </div>
                    )}
                  </CardContent>
                </Card>

                {/* Prescription Manager */}
                <PrescriptionManager />

                {/* Dosage Tracker */}
                <DosageTracker />

                {/* Recent Orders */}
                <Card className="bg-card/50 backdrop-blur-sm border-border/50">
                  <CardHeader className="flex flex-row items-center justify-between">
                    <div>
                      <CardTitle className="flex items-center gap-2">
                        <Package className="h-5 w-5" />
                        Recent Orders
                      </CardTitle>
                      <CardDescription>
                        {pendingOrders > 0 
                          ? `${pendingOrders} order(s) in progress` 
                          : 'Your latest orders'}
                      </CardDescription>
                    </div>
                    <Button variant="outline" size="sm" onClick={() => navigate('/orders')}>
                      View All
                    </Button>
                  </CardHeader>
                  <CardContent>
                    {ordersLoading ? (
                      <div className="flex items-center justify-center py-8">
                        <HBLoader size="md" />
                      </div>
                    ) : recentOrders.length === 0 ? (
                      <div className="text-center py-8">
                        <HBIcon size="xl" className="mx-auto mb-3 opacity-30" />
                        <p className="text-muted-foreground">No orders yet</p>
                        {isEligible && (
                          <Button 
                            variant="link" 
                            className="mt-2"
                            onClick={() => navigate('/shop')}
                          >
                            Browse Dispensary
                          </Button>
                        )}
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {recentOrders.map((order) => (
                          <div 
                            key={order.id}
                            className="flex items-center justify-between p-3 rounded-lg bg-muted/20 hover:bg-muted/30 transition-colors"
                          >
                            <div>
                              <p className="font-mono text-sm text-primary">
                                #{order.drgreen_order_id.slice(0, 8)}...
                              </p>
                              <p className="text-xs text-muted-foreground">
                                {new Date(order.created_at).toLocaleDateString()}
                              </p>
                            </div>
                            <div className="flex items-center gap-3">
                              <span className="font-medium">{formatPrice(order.total_amount, drGreenClient?.country_code || 'ZA')}</span>
                              <Badge variant={
                                order.status === 'DELIVERED' ? 'default' :
                                order.status === 'CANCELLED' ? 'destructive' : 'secondary'
                              }>
                                {order.status}
                              </Badge>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </div>

              {/* Right Column - Quick Actions & Cart */}
              <div className="space-y-6">
                {/* Quick Actions */}
                <Card className="bg-card/50 backdrop-blur-sm border-border/50">
                  <CardHeader>
                    <CardTitle className="text-lg">Quick Actions</CardTitle>
                  </CardHeader>
                  <CardContent className="grid gap-3">
                    <Button 
                      variant="outline" 
                      className="w-full justify-start"
                      onClick={() => navigate('/shop')}
                    >
                      <ShoppingCart className="mr-2 h-4 w-4" />
                      Browse Dispensary
                    </Button>
                    <Button 
                      variant="outline" 
                      className="w-full justify-start"
                      onClick={() => navigate('/orders')}
                    >
                      <Package className="mr-2 h-4 w-4" />
                      Order History
                    </Button>
                    <Button 
                      variant="outline" 
                      className="w-full justify-start"
                      onClick={() => navigate('/support')}
                    >
                      <FileText className="mr-2 h-4 w-4" />
                      Help & FAQ
                    </Button>
                    <Button
                      variant="outline"
                      className="w-full justify-start"
                      onClick={handleGdprExport}
                      disabled={isExporting}
                    >
                      <Download className="mr-2 h-4 w-4" />
                      {isExporting ? 'Exporting...' : 'Export My Data'}
                    </Button>
                    
                    {/* Re-Sync Account Button - for NFT-scoped credential issues */}
                    {drGreenClient && isEligible && (
                      <Dialog open={showResyncDialog} onOpenChange={setShowResyncDialog}>
                        <DialogTrigger asChild>
                          <Button 
                            variant="ghost" 
                            className="w-full justify-start text-muted-foreground hover:text-foreground"
                          >
                            <RefreshCw className="mr-2 h-4 w-4" />
                            Re-Sync Account
                          </Button>
                        </DialogTrigger>
                        <DialogContent>
                          <DialogHeader>
                            <DialogTitle className="flex items-center gap-2">
                              <RefreshCw className="h-5 w-5" />
                              Re-Sync Your Account
                            </DialogTitle>
                            <DialogDescription className="space-y-3 pt-2">
                              <p>
                                If you're experiencing issues placing orders (such as "Authorization failed" errors), 
                                your account may need to be re-linked to our prescription system.
                              </p>
                              <p className="text-warning">
                                <strong>Note:</strong> This will require you to complete KYC verification again.
                              </p>
                            </DialogDescription>
                          </DialogHeader>
                          <div className="flex gap-3 justify-end pt-4">
                            <Button variant="outline" onClick={() => setShowResyncDialog(false)}>
                              Cancel
                            </Button>
                            <Button 
                              onClick={handleResyncAccount}
                              disabled={isResyncing}
                            >
                              {isResyncing ? (
                                <>
                                  <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                                  Re-Syncing...
                                </>
                              ) : (
                                'Re-Sync Now'
                              )}
                            </Button>
                          </div>
                        </DialogContent>
                      </Dialog>
                    )}
                  </CardContent>
                </Card>

                {/* Cart Summary */}
                {cart.length > 0 && (
                  <Card className="bg-primary/5 border-primary/20">
                    <CardHeader>
                      <CardTitle className="text-lg flex items-center gap-2">
                        <ShoppingCart className="h-5 w-5" />
                        Your Cart
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <div className="space-y-2">
                        {cart.slice(0, 3).map((item) => (
                          <div key={item.id} className="flex justify-between text-sm">
                            <span className="truncate">{item.strain_name}</span>
                            <span className="text-muted-foreground">{item.quantity}g</span>
                          </div>
                        ))}
                        {cart.length > 3 && (
                          <p className="text-xs text-muted-foreground">
                            +{cart.length - 3} more item(s)
                          </p>
                        )}
                      </div>
                      <div className="flex justify-between font-medium border-t pt-3">
                        <span>Total</span>
                        <span className="text-primary">{formatPrice(cartTotal, drGreenClient?.country_code || DEFAULT_COUNTRY)}</span>
                      </div>
                      <Button 
                        className="w-full" 
                        onClick={() => navigate('/checkout')}
                        disabled={!isEligible}
                      >
                        {isEligible ? 'Proceed to Checkout' : 'Complete Verification First'}
                      </Button>
                    </CardContent>
                  </Card>
                )}

                {/* Account Info */}
                <Card className="bg-card/50 backdrop-blur-sm border-border/50">
                  <CardHeader>
                    <CardTitle className="text-lg">Account</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div>
                      <p className="text-sm text-muted-foreground">Email</p>
                      <p className="font-medium truncate">{user.email}</p>
                    </div>
                    {drGreenClient && (
                      <div>
                        <p className="text-sm text-muted-foreground">Country</p>
                        <p className="font-medium">{countryNames[drGreenClient.country_code] || drGreenClient.country_code}</p>
                      </div>
                    )}
                    
                    {/* Shipping Address Section */}
                    <div className="pt-2 border-t border-border/50">
                      <div className="flex items-center justify-between mb-2">
                        <p className="text-sm text-muted-foreground flex items-center gap-1">
                          <MapPin className="h-3.5 w-3.5" />
                          Shipping Address
                        </p>
                        {drGreenClient && (
                          <Dialog open={isAddressDialogOpen} onOpenChange={setIsAddressDialogOpen}>
                            <DialogTrigger asChild>
                              <Button variant="ghost" size="sm" className="h-7 px-2">
                                <Pencil className="h-3.5 w-3.5 mr-1" />
                                {shippingAddress ? 'Edit' : 'Add'}
                              </Button>
                            </DialogTrigger>
                            <DialogContent className="sm:max-w-[500px]">
                              <DialogHeader>
                                <DialogTitle className="flex items-center gap-2">
                                  <MapPin className="h-5 w-5" />
                                  {shippingAddress ? 'Edit Shipping Address' : 'Add Shipping Address'}
                                </DialogTitle>
                                <DialogDescription>
                                  Update your delivery address for medical cannabis shipments.
                                </DialogDescription>
                              </DialogHeader>
                              <ShippingAddressForm
                                clientId={drGreenClient.drgreen_client_id}
                                initialAddress={shippingAddress}
                                defaultCountry={drGreenClient.country_code || DEFAULT_COUNTRY}
                                onSuccess={handleAddressSaved}
                                onCancel={() => setIsAddressDialogOpen(false)}
                                variant="inline"
                              />
                            </DialogContent>
                          </Dialog>
                        )}
                      </div>
                      
                      {isLoadingAddress ? (
                        <div className="flex items-center text-sm text-muted-foreground">
                          <HBLoader size="sm" />
                          <span className="ml-2">Loading...</span>
                        </div>
                      ) : shippingAddress ? (
                        <div className="text-sm">
                          <p className="font-medium">{shippingAddress.address1}</p>
                          {shippingAddress.address2 && <p className="text-muted-foreground">{shippingAddress.address2}</p>}
                          <p className="text-muted-foreground">
                            {shippingAddress.city}, {shippingAddress.postalCode}
                          </p>
                          <p className="text-muted-foreground">{shippingAddress.country}</p>
                        </div>
                      ) : (
                        <p className="text-sm text-muted-foreground italic">
                          No shipping address on file
                        </p>
                      )}
                    </div>
                  </CardContent>
                </Card>
              </div>
            </div>
          </motion.div>
        </div>
      </main>
      <Footer />
    </div>
  );
};

export default PatientDashboard;
