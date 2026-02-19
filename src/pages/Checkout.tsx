import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, ShoppingBag, CreditCard, AlertCircle, Loader2, MapPin, Home, Building2, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';
import Header from '@/layout/Header';
import Footer from '@/components/Footer';
import { useShop } from '@/context/ShopContext';
import { EligibilityGate } from '@/components/shop/EligibilityGate';
import { ShippingAddressForm, type ShippingAddress } from '@/components/shop/ShippingAddressForm';
import OrderConfirmation from '@/components/shop/OrderConfirmation';
import { useTranslation } from 'react-i18next';
import { useToast } from '@/hooks/use-toast';
import { useDrGreenApi } from '@/hooks/useDrGreenApi';
import { useOrderTracking } from '@/hooks/useOrderTracking';
import { formatPrice, getCurrencyForCountry } from '@/lib/currency';
import { supabase } from '@/integrations/supabase/client';


// Retry utility with exponential backoff - preserves real error messages
async function retryOperation<T>(
  operation: () => Promise<{ data: T | null; error: string | null }>,
  operationName: string,
  maxRetries: number = 3
): Promise<{ data: T | null; error: string | null }> {
  let lastError: string | null = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const result = await operation();
    
    if (!result.error) return result;
    
    // Store the actual error for potential return
    lastError = result.error;
    console.log(`[${operationName}] Attempt ${attempt}/${maxRetries} error:`, result.error);
    
    // Check for non-retryable status codes and error patterns
    // Status 400/401/403/422 = client errors, don't retry
    const nonRetryablePatterns = [
      'Status 400', 'Status 401', 'Status 403', 'Status 422',
      'validation', 'required', 'MISSING_', 'AUTH_FAILED',
      'CLIENT_INACTIVE', 'SHIPPING_ADDRESS_REQUIRED', 'not active',
      'retryable: false', 'retryable":false'
    ];
    
    const isNonRetryable = nonRetryablePatterns.some(pattern => 
      result.error?.toLowerCase().includes(pattern.toLowerCase())
    );
    
    if (isNonRetryable) {
      console.warn(`[${operationName}] Non-retryable error detected:`, result.error);
      return result;
    }
    
    // Retry for potentially transient errors (5xx, timeouts, network issues)
    if (attempt < maxRetries) {
      const delay = Math.pow(2, attempt) * 500; // 1s, 2s, 4s
      console.log(`[${operationName}] Retrying in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  // Return the last real error, not a generic message
  return { 
    data: null, 
    error: lastError || `${operationName} failed after ${maxRetries} attempts` 
  };
}
// Fire-and-forget email — never blocks checkout
async function sendOrderConfirmationEmail(payload: {
  email: string;
  customerName: string;
  orderId: string;
  items: { strain_name: string; quantity: number; unit_price: number }[];
  totalAmount: number;
  currency: string;
  shippingAddress: ShippingAddress;
  isLocalOrder: boolean;
  region?: string;
}) {
  try {
    if (!payload.email) return;
    const { error } = await supabase.functions.invoke('send-order-confirmation', { body: payload });
    if (error) console.warn('[OrderEmail] Failed:', error.message);
    else console.log('[OrderEmail] Sent for', payload.orderId);
  } catch (e) {
    console.warn('[OrderEmail] Error:', e);
  }
}

const Checkout = () => {

  const { cart, cartTotal, cartTotalConverted, clearCart, drGreenClient, countryCode, convertFromEUR } = useShop();
  const navigate = useNavigate();
  const { t } = useTranslation('shop');
  const { toast } = useToast();
  const { createPayment, getPayment, createOrder, getClientDetails } = useDrGreenApi();
  const { saveOrder } = useOrderTracking();
  const [isProcessing, setIsProcessing] = useState(false);
  const [orderComplete, setOrderComplete] = useState(false);
  const [orderId, setOrderId] = useState<string | null>(null);
  const [localRowId, setLocalRowId] = useState<string | null>(null);
  const [paymentStatus, setPaymentStatus] = useState<string>('');
  const [isLocalOrder, setIsLocalOrder] = useState(false);
  
  // Shipping address state
  const [shippingAddress, setShippingAddress] = useState<ShippingAddress | null>(null);
  const [savedAddress, setSavedAddress] = useState<ShippingAddress | null>(null);
  const [partialAddress, setPartialAddress] = useState<Partial<ShippingAddress> | null>(null);
  const [isLoadingAddress, setIsLoadingAddress] = useState(true);
  const [needsShippingAddress, setNeedsShippingAddress] = useState(false);
  const [addressMode, setAddressMode] = useState<'saved' | 'custom'>('saved');
  const [addressManuallySaved, setAddressManuallySaved] = useState(false);

  // Helper: extract best shipping object from DApp response, handling all envelope shapes
  const extractShipping = (data: unknown): Record<string, unknown> | null => {
    if (!data || typeof data !== 'object') return null;
    const d = data as Record<string, unknown>;

    // Shape 1: data.shipping (proxy-normalized)
    const shipping = d.shipping as Record<string, unknown> | undefined;
    if (shipping && typeof shipping === 'object') {
      // If it has a real address1, return it directly
      if (shipping.address1) return shipping;
      // Otherwise keep it as partial (may have country/currency)
      const partial = shipping;
      // Shape 2: data.shippings[] — array from DApp direct endpoint
      const shippings = d.shippings as Record<string, unknown>[] | undefined;
      const firstShipping = Array.isArray(shippings) ? shippings[0] : null;
      if (firstShipping?.address1) return firstShipping;
      // Merge: prefer shippings[0] for any extra fields, fall back to shipping
      if (firstShipping) return { ...partial, ...firstShipping };
      return partial;
    }
    // Shape 3: nested envelope data.data.shipping
    const inner = d.data as Record<string, unknown> | undefined;
    if (inner) return extractShipping(inner);
    return null;
  };

  // Resolve country code from DApp client record (shippings[] has currency/country text)
  const resolveCountryFromDApp = (data: unknown): string => {
    if (!data || typeof data !== 'object') return '';
    const d = data as Record<string, unknown>;
    const shippings = d.shippings as Record<string, unknown>[] | undefined;
    const shipping = d.shipping as Record<string, unknown> | undefined;
    const countryCodeRaw = (shippings?.[0]?.countryCode as string)
      || (shipping?.countryCode as string)
      || (d.phoneCountryCode as string) // e.g. "PT" fallback
      || '';
    // Map country name -> code if needed
    const countryNameMap: Record<string, string> = {
      'South Africa': 'ZA', 'United Kingdom': 'GB', 'Portugal': 'PT', 'Thailand': 'TH',
    };
    const countryName = (shippings?.[0]?.country as string) || (shipping?.country as string) || '';
    return countryCodeRaw || countryNameMap[countryName] || '';
  };

  // Fetch client details to check for shipping address
  // Priority: 1) Manual session save, 2) Local DB, 3) Dr. Green API, 4) Prompt user
  useEffect(() => {
    const checkShippingAddress = async () => {
      if (addressManuallySaved) {
        setIsLoadingAddress(false);
        return;
      }

      if (!drGreenClient?.drgreen_client_id) {
        setIsLoadingAddress(false);
        return;
      }

      // Priority 1: Dr. Green API — always the source of truth for verified address data
      try {
        const result = await getClientDetails(drGreenClient.drgreen_client_id);

        if (!result.error) {
          const raw = result.data as Record<string, unknown> | null;
          const shipping = extractShipping(raw);

          if (shipping?.address1) {
            // Full verified address from DApp — use it directly
            console.log('[Checkout] Full shipping address from DApp API (source of truth):', {
              city: (shipping as Record<string, unknown>).city,
              hasAddress1: true,
            });
            const addr = shipping as unknown as ShippingAddress;
            setSavedAddress(addr);
            setShippingAddress(addr);
            setNeedsShippingAddress(false);
            setAddressMode('saved');
            setIsLoadingAddress(false);
            return;
          }

          // DApp responded but has no address — capture country hint for form pre-fill
          const detectedCountry = resolveCountryFromDApp(raw) || drGreenClient.country_code || countryCode || 'ZA';
          console.log('[Checkout] DApp has no shipping address — country hint:', detectedCountry);
          if (shipping) {
            setPartialAddress({
              country: (shipping.country as string) || '',
              countryCode: detectedCountry,
            });
          } else {
            setPartialAddress({ countryCode: detectedCountry });
          }
          // Fall through: no address from DApp — try local DB as fallback before prompting user
        } else {
          console.warn('[Checkout] DApp API error:', result.error);
        }
      } catch (error) {
        console.warn('[Checkout] DApp API fetch failed, falling back to local DB:', error);
      }

      // Priority 2: Local DB — offline/error fallback only
      const localShipping = drGreenClient.shipping_address;
      if (localShipping && (localShipping as Record<string, unknown>).address1) {
        console.log('[Checkout] Using shipping address from local DB (fallback — DApp unavailable)');
        const addr = localShipping as unknown as ShippingAddress;
        setSavedAddress(addr);
        setShippingAddress(addr);
        setNeedsShippingAddress(false);
        setAddressMode('saved');
        setIsLoadingAddress(false);
        return;
      }

      // Priority 3: No address found — prompt user to enter one
      console.log('[Checkout] No shipping address found — prompting user');
      setNeedsShippingAddress(true);
      setIsLoadingAddress(false);
    };

    checkShippingAddress();
  }, [drGreenClient, getClientDetails, addressManuallySaved, countryCode]);

  // Handle address mode toggle
  const handleAddressModeChange = (mode: 'saved' | 'custom') => {
    setAddressMode(mode);
    if (mode === 'saved' && savedAddress) {
      setShippingAddress(savedAddress);
    }
  };

  const handleShippingAddressSaved = (address: ShippingAddress) => {
    console.log('[Checkout] Address saved:', address);
    // Mark as manually saved to prevent useEffect from re-fetching and overwriting
    setAddressManuallySaved(true);
    // Set address FIRST, before changing needsShippingAddress
    setShippingAddress(address);
    setSavedAddress(address); // Also save as "saved" address
    // Then update state to show the address selection UI
    setNeedsShippingAddress(false);
    setAddressMode('saved');
    toast({
      title: 'Shipping Address Saved',
      description: 'You can now proceed with your order.',
    });
  };

  const handlePlaceOrder = async () => {
    if (!drGreenClient || cart.length === 0) return;

    // Validate shipping address exists
    if (!shippingAddress || !shippingAddress.address1) {
      toast({
        title: 'Shipping Address Required',
        description: 'Please provide a shipping address before placing your order.',
        variant: 'destructive',
      });
      return;
    }

    setIsProcessing(true);
    setPaymentStatus('Verifying your profile...');

    // Determine verification status outside try/catch so fallback can use it
    const isFullyVerified = drGreenClient.is_kyc_verified === true && drGreenClient.admin_approval === 'VERIFIED';

    try {
      let clientId = drGreenClient.drgreen_client_id;

      // --- PRE-FLIGHT: Auto-rehome guard ---
      // Skip rehome for fully verified clients to avoid destroying their KYC status.
      // Rehoming re-registers the client which resets is_kyc_verified and admin_approval.
      
      if (isFullyVerified) {
        console.log('[Checkout] Skipping auto-rehome — client is fully verified');
      } else {
        // Only attempt rehome for non-verified clients where scope mismatch matters less
        try {
          const { data: rehomeResult, error: rehomeError } = await supabase.functions.invoke('drgreen-proxy', {
            body: { action: 'auto-rehome-client', clientId },
          });

          if (rehomeError) {
            console.warn('[Checkout] Auto-rehome check failed:', rehomeError.message);
          } else if (rehomeResult?.rehomed && rehomeResult?.clientId) {
            console.log('[Checkout] Client auto-rehomed:', clientId, '->', rehomeResult.clientId);
            clientId = rehomeResult.clientId;
            toast({
              title: 'Profile Updated',
              description: 'Your profile has been refreshed. Continuing with your order...',
            });
          }
        } catch (rehomeErr) {
          console.warn('[Checkout] Auto-rehome guard error:', rehomeErr);
        }
      }

      setPaymentStatus('Creating order...');

      // Use the atomic createOrder which handles:
      // 1. PATCH client shipping address
      // 2. POST items to server-side cart
      // 3. POST order creation from cart
      // All in one server-side transaction
      console.log('[Checkout] Creating order via atomic transaction...');
      
      const orderResult = await retryOperation(
        () => createOrder({
          clientId: clientId,
          items: cart.map(item => ({
            productId: item.strain_id,
            quantity: item.quantity,
            price: item.unit_price,
          })),
          shippingAddress: {
            address1: shippingAddress.address1,
            address2: shippingAddress.address2 || '',
            city: shippingAddress.city,
            state: shippingAddress.state || shippingAddress.city,
            postalCode: shippingAddress.postalCode,
            country: shippingAddress.country,
            countryCode: shippingAddress.countryCode,
          },
        }),
        'Create order'
      );

      if (orderResult.error || !orderResult.data?.orderId) {
        throw new Error(orderResult.error || 'Failed to create order');
      }

      const createdOrderId = orderResult.data.orderId;
      console.log('[Checkout] Order created:', createdOrderId);

      setPaymentStatus('Order submitted — awaiting confirmation...');

      // Payment is handled externally (Dr. Green portal / webhook).
      // Complete checkout immediately once we have a real orderId.
      const finalStatus = 'PENDING';
      const finalPaymentStatus = 'AWAITING_PAYMENT';

      // Save order locally with complete context snapshot for reliable admin sync
      const clientCountryCode = drGreenClient.country_code || countryCode || 'ZA';
      const savedOrder = await saveOrder({
        drgreen_order_id: createdOrderId,
        status: finalStatus,
        payment_status: finalPaymentStatus,
        total_amount: cartTotal,
        items: cart.map(item => ({
          strain_id: item.strain_id,
          strain_name: item.strain_name,
          quantity: item.quantity,
          unit_price: item.unit_price,
        })),
        // Capture order context at checkout time
        client_id: drGreenClient.drgreen_client_id,
        shipping_address: {
          address1: shippingAddress.address1,
          address2: shippingAddress.address2 || '',
          city: shippingAddress.city,
          state: shippingAddress.state || shippingAddress.city,
          postalCode: shippingAddress.postalCode,
          country: shippingAddress.country,
          countryCode: shippingAddress.countryCode,
        },
        customer_email: drGreenClient.email || undefined,
        customer_name: drGreenClient.full_name || undefined,
        country_code: clientCountryCode,
        currency: getCurrencyForCountry(clientCountryCode),
      });

      setOrderId(createdOrderId);
      setLocalRowId(savedOrder?.id ?? null);
      setOrderComplete(true);
      clearCart();

      // Send confirmation email (fire-and-forget)
      sendOrderConfirmationEmail({
        email: drGreenClient.email || '',
        customerName: drGreenClient.full_name || '',
        orderId: createdOrderId,
        items: cart.map(i => ({ strain_name: i.strain_name, quantity: i.quantity, unit_price: i.unit_price })),
        totalAmount: cartTotal,
        currency: getCurrencyForCountry(clientCountryCode),
        shippingAddress,
        isLocalOrder: false,
        region: clientCountryCode,
      });
      
      toast({
        title: 'Order Submitted',
        description: `Your order ${createdOrderId} has been submitted for processing.`,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('Checkout error — attempting local fallback:', errorMessage);
      console.error('[Checkout] Full error details:', JSON.stringify(error, null, 2));

      // --- LOCAL-FIRST FALLBACK ---
      try {
        const now = new Date();
        const datePart = now.toISOString().slice(0, 10).replace(/-/g, '');
        const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
        const localOrderId = `LOCAL-${datePart}-${rand}`;

        const clientCountryCode = drGreenClient.country_code || countryCode || 'ZA';

        const savedLocalOrder = await saveOrder({
          drgreen_order_id: localOrderId,
          status: isFullyVerified ? 'MANUAL_REVIEW' : 'PENDING_SYNC',
          payment_status: 'AWAITING_PROCESSING',
          total_amount: cartTotal,
          items: cart.map(item => ({
            strain_id: item.strain_id,
            strain_name: item.strain_name,
            quantity: item.quantity,
            unit_price: item.unit_price,
          })),
          client_id: drGreenClient.drgreen_client_id,
          shipping_address: {
            address1: shippingAddress.address1,
            address2: shippingAddress.address2 || '',
            city: shippingAddress.city,
            state: shippingAddress.state || shippingAddress.city,
            postalCode: shippingAddress.postalCode,
            country: shippingAddress.country,
            countryCode: shippingAddress.countryCode,
          },
          customer_email: drGreenClient.email || undefined,
          customer_name: drGreenClient.full_name || undefined,
          country_code: clientCountryCode,
          currency: getCurrencyForCountry(clientCountryCode),
          sync_error: errorMessage,
          sync_status: 'failed',
        });

        setOrderId(localOrderId);
        setLocalRowId(savedLocalOrder?.id ?? null);
        setIsLocalOrder(true);
        setOrderComplete(true);
        clearCart();

        // Send confirmation email (fire-and-forget)
        sendOrderConfirmationEmail({
          email: drGreenClient.email || '',
          customerName: drGreenClient.full_name || '',
          orderId: localOrderId,
          items: cart.map(i => ({ strain_name: i.strain_name, quantity: i.quantity, unit_price: i.unit_price })),
          totalAmount: cartTotal,
          currency: getCurrencyForCountry(clientCountryCode),
          shippingAddress,
          isLocalOrder: true,
          region: clientCountryCode,
        });

        toast({
          title: 'Order Received',
          description: 'Your order has been saved and will be processed by our team.',
        });
      } catch (fallbackError) {
        console.error('Local order fallback also failed:', fallbackError);
        toast({
          title: 'Order Failed',
          description: 'We could not save your order. Please try again or contact support.',
          variant: 'destructive',
        });
      }
    } finally {
      setIsProcessing(false);
      setPaymentStatus('');
    }
  };

  if (orderComplete && orderId) {
    return (
      <>
        <Header />
        <OrderConfirmation
          orderId={orderId}
          localRowId={localRowId}
          isLocalOrder={isLocalOrder}
        />
        <Footer />
      </>
    );
  }



  if (cart.length === 0) {
    return (
      <div className="min-h-screen bg-background">
        <Header />
        <main className="pt-32 pb-20">
          <div className="container mx-auto px-4 max-w-2xl">
            <Card className="bg-card/50 backdrop-blur-sm border-border/50">
              <CardContent className="pt-12 pb-8 text-center">
                <ShoppingBag className="w-16 h-16 mx-auto mb-6 text-muted-foreground" />
                <h2 className="text-2xl font-bold text-foreground mb-4">
                  Your Cart is Empty
                </h2>
                <p className="text-muted-foreground mb-8">
                  Add some products to your cart before checking out.
                </p>
                <Button onClick={() => navigate('/shop')}>
                  Browse Products
                </Button>
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
      <main className="pt-32 pb-20">
        <div className="container mx-auto px-4">
          <EligibilityGate>
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="max-w-4xl mx-auto"
            >
              {/* Back button */}
              <Button
                variant="ghost"
                className="mb-6"
                onClick={() => navigate('/shop')}
              >
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back to Shop
              </Button>

              <div className="grid lg:grid-cols-3 gap-8">
                {/* Order Summary */}
                <div className="lg:col-span-2">
                  <Card className="bg-card/50 backdrop-blur-sm border-border/50">
                    <CardHeader>
                      <CardTitle className="flex items-center gap-2">
                        <ShoppingBag className="h-5 w-5" />
                        Order Summary
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      {cart.map((item) => (
                        <div
                          key={item.id}
                          className="flex items-center justify-between py-3 border-b border-border/50 last:border-0"
                        >
                          <div>
                            <p className="font-medium text-foreground">
                              {item.strain_name}
                            </p>
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

                      <div className="flex items-center justify-between text-lg font-bold">
                        <span>Total</span>
                        <span className="text-primary">{formatPrice(cartTotalConverted, countryCode)}</span>
                      </div>
                    </CardContent>
                  </Card>
                </div>

                {/* Shipping & Payment Section */}
                <div className="lg:col-span-1 space-y-6">
                  {/* Shipping Address Check */}
                  {isLoadingAddress ? (
                    <Card className="bg-card/50 backdrop-blur-sm border-border/50">
                      <CardContent className="pt-6 flex items-center justify-center">
                        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                        <span className="ml-2 text-muted-foreground">Checking shipping address...</span>
                      </CardContent>
                    </Card>
                  ) : needsShippingAddress ? (
                    // No saved address - show form directly
                    <div className="space-y-4">
                    <Alert className="bg-muted/30 border-border/50">
                        <MapPin className="h-4 w-4" />
                        <AlertTitle>Shipping Address Required</AlertTitle>
                        <AlertDescription>
                          Please enter your delivery address below to continue.
                        </AlertDescription>
                      </Alert>
                      
                      {drGreenClient && (
                        <ShippingAddressForm
                          clientId={drGreenClient.drgreen_client_id}
                          defaultCountry={partialAddress?.countryCode || drGreenClient.country_code || countryCode || 'ZA'}
                          onSuccess={handleShippingAddressSaved}
                          submitLabel="Save & Continue"
                        />
                      )}
                    </div>
                  ) : (
                    <>
                      {/* Delivery Address Selection */}
                      <Card className="bg-card/50 backdrop-blur-sm border-border/50">
                        <CardHeader>
                          <CardTitle className="flex items-center gap-2">
                            <MapPin className="h-5 w-5" />
                            Delivery Address
                          </CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-4">
                          <RadioGroup 
                            value={addressMode} 
                            onValueChange={(v) => handleAddressModeChange(v as 'saved' | 'custom')}
                            className="space-y-3"
                          >
                            {/* Option 1: Use saved address */}
                            {savedAddress && (
                              <div 
                                className={`flex items-start gap-3 p-4 rounded-lg border transition-colors cursor-pointer ${
                                  addressMode === 'saved' 
                                    ? 'border-primary bg-primary/5' 
                                    : 'border-border/50 hover:border-border'
                                }`}
                                onClick={() => handleAddressModeChange('saved')}
                              >
                                <RadioGroupItem value="saved" id="addr-saved" className="mt-1" />
                                <Label htmlFor="addr-saved" className="flex-1 cursor-pointer">
                                  <div className="flex items-center gap-2 font-medium">
                                    <Home className="h-4 w-4 text-muted-foreground" />
                                    Use saved address
                                  </div>
                                  <div className="text-sm text-muted-foreground mt-1">
                                    {savedAddress.address1}<br />
                                    {savedAddress.city}, {savedAddress.postalCode}<br />
                                    {savedAddress.country}
                                  </div>
                                </Label>
                              </div>
                            )}
                            
                            {/* Option 2: Different address */}
                            <div 
                              className={`flex items-start gap-3 p-4 rounded-lg border transition-colors cursor-pointer ${
                                addressMode === 'custom' 
                                  ? 'border-primary bg-primary/5' 
                                  : 'border-border/50 hover:border-border'
                              }`}
                              onClick={() => handleAddressModeChange('custom')}
                            >
                              <RadioGroupItem value="custom" id="addr-custom" className="mt-1" />
                              <Label htmlFor="addr-custom" className="flex-1 cursor-pointer">
                                <div className="flex items-center gap-2 font-medium">
                                  <Building2 className="h-4 w-4 text-muted-foreground" />
                                  Ship to a different address
                                </div>
                                <span className="text-sm text-muted-foreground">
                                  Work, pickup point, or alternative location
                                </span>
                              </Label>
                            </div>
                          </RadioGroup>
                          
                          {/* Show form when custom selected */}
                          {addressMode === 'custom' && drGreenClient && (
                            <div className="pt-4 border-t border-border/50 space-y-3">
                              <ShippingAddressForm
                                clientId={drGreenClient.drgreen_client_id}
                                initialAddress={null}
                                defaultCountry={savedAddress?.countryCode || partialAddress?.countryCode || drGreenClient.country_code || countryCode || 'ZA'}
                                onSuccess={handleShippingAddressSaved}
                                submitLabel="Confirm Address"
                                variant="inline"
                              />
                            </div>
                          )}
                        </CardContent>
                      </Card>

                      {/* Address saved confirmation banner */}
                      {addressManuallySaved && (
                        <Alert className="border-primary/30 bg-primary/5">
                          <Check className="h-4 w-4 text-primary" />
                          <AlertTitle className="text-primary">Address Saved</AlertTitle>
                          <AlertDescription className="text-muted-foreground">
                            Your delivery address has been confirmed.
                          </AlertDescription>
                        </Alert>
                      )}

                      {/* Payment Card */}
                      <Card className="bg-card/50 backdrop-blur-sm border-border/50">
                        <CardHeader>
                          <CardTitle className="flex items-center gap-2">
                            <CreditCard className="h-5 w-5" />
                            Payment
                          </CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-4">
                          {/* Shipping summary */}
                          <div className="p-3 rounded-lg bg-muted/30 text-sm">
                            <p className="font-medium text-foreground flex items-center gap-2 mb-1">
                              <MapPin className="h-3.5 w-3.5" />
                              Shipping to:
                            </p>
                            <p className="text-muted-foreground">
                              {shippingAddress?.address1}, {shippingAddress?.city}
                            </p>
                          </div>

                          {/* Notice */}
                          <div className="flex items-start gap-3 p-4 rounded-lg bg-primary/10 border border-primary/20">
                            <AlertCircle className="h-5 w-5 text-primary flex-shrink-0 mt-0.5" />
                            <p className="text-sm text-muted-foreground">
                              Payment will be processed securely through our payment provider.
                            </p>
                          </div>

                          <Button
                            className="w-full"
                            size="lg"
                            onClick={handlePlaceOrder}
                            disabled={isProcessing || !shippingAddress}
                          >
                            {isProcessing ? (
                              <>
                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                {paymentStatus || 'Processing...'}
                              </>
                            ) : (
                              <>
                                <CreditCard className="mr-2 h-4 w-4" />
                                Place Order - {formatPrice(cartTotalConverted, countryCode)}
                              </>
                            )}
                          </Button>

                          <p className="text-xs text-center text-muted-foreground">
                            By placing this order, you agree to our terms of service and confirm that you are a verified medical patient.
                          </p>
                        </CardContent>
                      </Card>
                    </>
                  )}
                </div>
              </div>
            </motion.div>
          </EligibilityGate>
        </div>
      </main>
      <Footer />
    </div>
  );
};

export default Checkout;
