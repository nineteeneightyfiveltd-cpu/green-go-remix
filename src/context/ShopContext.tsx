import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { updateCachedRates } from '@/lib/currency';
import { useStrainSync } from '@/hooks/useStrainSync';
import { useDrGreenAutoSync } from '@/hooks/useDrGreenAutoSync';

interface CartItem {
  id: string;
  strain_id: string;
  strain_name: string;
  quantity: number;
  unit_price: number; // Always in EUR from Dr Green API
}

interface DrGreenClient {
  id: string;
  user_id: string;
  drgreen_client_id: string;
  country_code: string;
  is_kyc_verified: boolean;
  admin_approval: string;
  kyc_link: string | null;
  // Additional fields from database
  email?: string | null;
  full_name?: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  shipping_address?: any;
}

interface ExchangeRatesData {
  ZAR: number;
  EUR: number;
  GBP: number;
  USD: number;
  THB: number;
}

interface ShopContextType {
  cart: CartItem[];
  cartCount: number;
  cartTotal: number;
  cartTotalConverted: number; // In user's currency
  isCartOpen: boolean;
  setIsCartOpen: (open: boolean) => void;
  addToCart: (item: Omit<CartItem, 'id'>) => Promise<void>;
  removeFromCart: (strainId: string) => Promise<void>;
  updateQuantity: (strainId: string, quantity: number) => Promise<void>;
  clearCart: () => Promise<void>;
  drGreenClient: DrGreenClient | null;
  isEligible: boolean;
  isLoading: boolean;
  refreshClient: () => Promise<void>;
  syncVerificationFromDrGreen: () => Promise<boolean>;
  isSyncing: boolean;
  countryCode: string;
  setCountryCode: (code: string) => void;
  // Exchange rates
  exchangeRates: ExchangeRatesData | null;
  convertFromEUR: (amount: number, toCountry?: string) => number;
  /** @deprecated Use convertFromEUR instead - API returns EUR prices */
  convertFromZAR: (amount: number, toCountry?: string) => number;
  ratesLastUpdated: Date | null;
}

const ShopContext = createContext<ShopContextType | undefined>(undefined);

import { getCountryFromDomain } from '@/lib/countries';

export function ShopProvider({ children }: { children: React.ReactNode }) {
  const { rates, lastUpdated, convertPrice } = useExchangeRates();
  // Auto-sync strains on app initialization and periodically
  useStrainSync();
  // Auto-sync Dr. Green clients in background (admin only)
  useDrGreenAutoSync();
  const [cart, setCart] = useState<CartItem[]>([]);
  const [isCartOpen, setIsCartOpen] = useState(false);
  const [drGreenClient, setDrGreenClient] = useState<DrGreenClient | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);
  // Country is determined by URL domain, not geolocation
  const [countryCode, setCountryCode] = useState<string>(() => getCountryFromDomain());
  const { toast } = useToast();

  // Update cached rates when they change
  useEffect(() => {
    if (rates) {
      updateCachedRates(rates);
    }
  }, [rates]);

  const cartCount = cart.reduce((sum, item) => sum + item.quantity, 0);
  const cartTotal = cart.reduce((sum, item) => sum + item.quantity * item.unit_price, 0);
  
  // Convert cart total to user's currency (API returns prices in EUR)
  const convertFromEUR = useCallback((amount: number, toCountry?: string): number => {
    const targetCountry = toCountry || countryCode;
    return convertPrice(amount, 'EUR', targetCountry);
  }, [convertPrice, countryCode]);

  // Keep legacy function for backwards compatibility
  const convertFromZAR = useCallback((amount: number, toCountry?: string): number => {
    const targetCountry = toCountry || countryCode;
    return convertPrice(amount, 'EUR', targetCountry); // Actually converts from EUR now
  }, [convertPrice, countryCode]);

  const cartTotalConverted = convertFromEUR(cartTotal);
  
  const isEligible = drGreenClient?.is_kyc_verified === true && drGreenClient?.admin_approval === 'VERIFIED';

  const fetchCart = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      setCart([]);
      return;
    }

    const { data, error } = await supabase
      .from('drgreen_cart')
      .select('*')
      .eq('user_id', user.id);

    if (error) {
      console.error('Error fetching cart:', error);
      return;
    }

    setCart(data || []);
  }, []);

  // Attempt to auto-discover and link existing Dr. Green client by email
  const linkClientFromDrGreenByAuthEmail = useCallback(async (userId: string, silent = false): Promise<boolean> => {
    try {
      console.log('[ShopContext] Attempting auto-discovery of Dr. Green client...');
      
      // Show toast to user (unless silent mode for auto-login)
      if (!silent) {
        toast({
          title: 'Checking records...',
          description: 'Looking up your profile in our system',
        });
      }
      
      const { data, error } = await supabase.functions.invoke('drgreen-proxy', {
        body: { action: 'get-client-by-auth-email' },
      });
      
      if (error) {
        console.error('[ShopContext] Auto-discovery API error:', error);
        if (!silent) {
          toast({
            title: 'Lookup Failed',
            description: 'Could not verify your profile. Please try again later.',
            variant: 'destructive',
          });
        }
        return false;
      }
      
      if (data?.found && data?.clientId) {
        console.log('[ShopContext] Found existing Dr. Green client, linking...');
        
        // Upsert the local mapping
        const { error: upsertError } = await supabase
          .from('drgreen_clients')
          .upsert({
            user_id: userId,
            drgreen_client_id: data.clientId,
            is_kyc_verified: data.isKYCVerified ?? false,
            admin_approval: data.adminApproval || 'PENDING',
            kyc_link: data.kycLink || null,
            email: data.email || null,
            full_name: data.firstName && data.lastName 
              ? `${data.firstName} ${data.lastName}`.trim() 
              : null,
            country_code: data.countryCode || 'ZA',
          }, {
            onConflict: 'user_id',
          });
        
        if (upsertError) {
          console.error('[ShopContext] Failed to upsert client mapping:', upsertError);
          if (!silent) {
            toast({
              title: 'Sync Error',
              description: 'Could not save profile data locally.',
              variant: 'destructive',
            });
          }
          return false;
        }
        
        const statusMsg = data.adminApproval === 'VERIFIED' && data.isKYCVerified
          ? 'You are verified and ready to shop!'
          : data.adminApproval === 'PENDING'
          ? 'Profile found - awaiting verification'
          : 'Profile found - status: ' + data.adminApproval;
        
        if (!silent) {
          toast({
            title: 'Profile Found!',
            description: statusMsg,
          });
        }
        
        console.log('[ShopContext] Successfully linked Dr. Green client:', data.clientId);
        return true;
      } else {
        console.log('[ShopContext] No existing Dr. Green client found for this email');
        if (!silent) {
          toast({
            title: 'No Profile Found',
            description: 'Please complete registration to access the dispensary.',
          });
        }
        return false;
      }
    } catch (err) {
      console.error('[ShopContext] Auto-discovery error:', err);
      if (!silent) {
        toast({
          title: 'Connection Error',
          description: 'Please check your connection and try again.',
          variant: 'destructive',
        });
      }
      return false;
    }
  }, [toast]);

  const fetchClient = useCallback(async () => {
    // Use getSession first - it's synchronous from cache and avoids race conditions
    // getUser() can fail during initial auth state recovery
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.user) {
      setDrGreenClient(null);
      setIsLoading(false);
      return;
    }
    const user = session.user;

    // Step 1: Check if we have a local mapping (user_id → drgreen_client_id)
    const { data: localRecord, error } = await supabase
      .from('drgreen_clients')
      .select('*')
      .eq('user_id', user.id)
      .maybeSingle();

    if (error) {
      console.error('Error fetching client mapping:', error);
    }

    // Step 2: If no local mapping, try auto-discovery from Dr. Green API
    if (!localRecord) {
      console.log('[ShopContext] No local client mapping, attempting auto-discovery...');
      const linked = await linkClientFromDrGreenByAuthEmail(user.id, true);
      
      if (linked) {
        // Refetch the newly created mapping
        const { data: newRecord } = await supabase
          .from('drgreen_clients')
          .select('*')
          .eq('user_id', user.id)
          .maybeSingle();
        
        if (newRecord) {
          setDrGreenClient(newRecord);
        }
      }
      setIsLoading(false);
      return;
    }

    // Step 3: ALWAYS fetch live status from Dr. Green API for data integrity
    // Skip for local-only clients (API registration failed)
    if (localRecord.drgreen_client_id && !localRecord.drgreen_client_id.startsWith('local-')) {
      try {
        console.log('[ShopContext] Fetching live client status from Dr. Green API...');
        const { data: apiResponse, error: apiError } = await supabase.functions.invoke('drgreen-proxy', {
          body: {
            action: 'get-client',
            clientId: localRecord.drgreen_client_id,
          },
        });

        // Accept response with or without "success" wrapper
        const liveData = apiResponse?.data || apiResponse;
        if (!apiError && liveData && (liveData.isKYCVerified !== undefined || liveData.adminApproval !== undefined)) {
          const liveKyc = liveData.isKYCVerified ?? liveData.is_kyc_verified ?? false;
          const liveApproval = liveData.adminApproval ?? liveData.admin_approval ?? 'PENDING';
          const liveKycLink = liveData.kycLink ?? liveData.kyc_link ?? null;

          // Update local cache if status changed (fire-and-forget)
          if (
            localRecord.is_kyc_verified !== liveKyc ||
            localRecord.admin_approval !== liveApproval ||
            localRecord.kyc_link !== liveKycLink
          ) {
            console.log('[ShopContext] Status changed on Dr. Green, updating local cache...');
            supabase
              .from('drgreen_clients')
              .update({
                is_kyc_verified: liveKyc,
                admin_approval: liveApproval,
                kyc_link: liveKycLink,
                updated_at: new Date().toISOString(),
              })
              .eq('user_id', user.id)
              .then(({ error: updateErr }) => {
                if (updateErr) console.error('[ShopContext] Cache update error:', updateErr);
              });
          }

          // Resolve shipping address: prefer DApp live data, fall back to local DB
          const liveShipping = liveData.shippings?.[0] || liveData.shipping || null;
          const resolvedShipping = (() => {
            if (liveShipping?.address1) {
              return {
                address1: liveShipping.address1 || liveShipping.addressLine1 || '',
                address2: liveShipping.address2 || liveShipping.addressLine2 || '',
                city: liveShipping.city || '',
                state: liveShipping.state || liveShipping.city || '',
                postalCode: liveShipping.postalCode || liveShipping.zipCode || '',
                country: liveShipping.country || '',
                countryCode: liveShipping.countryCode || localRecord.country_code || 'ZA',
                landmark: liveShipping.landmark || '',
              };
            }
            // Fall back to local DB shipping_address
            return localRecord.shipping_address || null;
          })();

          // If DApp has richer address than local DB, persist it
          const localAddr = localRecord.shipping_address as Record<string, unknown> | null;
          const resolvedAddr = resolvedShipping as Record<string, unknown> | null;
          if (resolvedAddr?.address1 && !localAddr?.address1) {
            supabase
              .from('drgreen_clients')
              .update({ shipping_address: resolvedShipping, updated_at: new Date().toISOString() })
              .eq('user_id', user.id)
              .then(({ error: addrErr }) => {
                if (addrErr) console.warn('[ShopContext] Could not persist shipping address:', addrErr);
                else console.log('[ShopContext] Persisted shipping address from DApp to local DB');
              });
          }

          // Always use live data for the UI state
          setDrGreenClient({
            ...localRecord,
            is_kyc_verified: liveKyc,
            admin_approval: liveApproval,
            kyc_link: liveKycLink,
            shipping_address: resolvedShipping,
          });
          setIsLoading(false);
          return;
        } else {
          console.warn('[ShopContext] Could not fetch live status, falling back to cached data');
        }
      } catch (err) {
        console.warn('[ShopContext] API call failed, using cached data:', err);
      }
    }

    // Fallback: use cached local data if API call fails
    setDrGreenClient(localRecord);
    setIsLoading(false);
  }, [linkClientFromDrGreenByAuthEmail]);

  const refreshClient = useCallback(async () => {
    await fetchClient();
  }, [fetchClient]);

  // Sync verification status from Dr Green API
  // Now simply re-fetches client which always calls API directly
  const syncVerificationFromDrGreen = useCallback(async (): Promise<boolean> => {
    if (!drGreenClient?.drgreen_client_id) return false;
    if (drGreenClient.drgreen_client_id.startsWith('local-')) return false;
    
    setIsSyncing(true);
    try {
      await fetchClient();
      return true;
    } catch (err) {
      console.error('Sync verification error:', err);
      return false;
    } finally {
      setIsSyncing(false);
    }
  }, [drGreenClient?.drgreen_client_id, fetchClient]);

  useEffect(() => {
    let isMounted = true;

    // Listener for ONGOING auth changes - defer with setTimeout to avoid deadlock
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (event, session) => {
        if (!isMounted) return;
        if (event === 'SIGNED_OUT') {
          setDrGreenClient(null);
          setCart([]);
          return;
        }
        // Defer async calls to avoid Supabase auth deadlock
        setTimeout(async () => {
          if (!isMounted) return;
          fetchCart();
          
          if (event === 'SIGNED_IN' && session?.user) {
            // Auto-discover and link Dr. Green client on every login
            console.log('[ShopContext] SIGNED_IN event — running auto-discovery...');
            const linked = await linkClientFromDrGreenByAuthEmail(session.user.id, true);
            if (linked) {
              console.log('[ShopContext] Auto-discovery linked client on login');
            }
          }
          
          fetchClient();
        }, 0);
      }
    );

    // INITIAL load - controls isLoading
    const initializeShop = async () => {
      await fetchCart();
      await fetchClient();
      // isLoading is set to false inside fetchClient
    };
    initializeShop();

    return () => {
      isMounted = false;
      subscription.unsubscribe();
    };
  }, [fetchCart, fetchClient]);

  // Live sync: poll for verification status updates every 60 seconds
  // Stops polling once the patient is fully verified to reduce API load
  useEffect(() => {
    if (!drGreenClient?.drgreen_client_id) return;
    if (drGreenClient.drgreen_client_id.startsWith('local-')) return;
    if (drGreenClient.is_kyc_verified && drGreenClient.admin_approval === 'VERIFIED') return;

    const interval = setInterval(() => {
      console.log('[ShopContext] Polling live verification status...');
      fetchClient();
    }, 60000);

    return () => clearInterval(interval);
  }, [drGreenClient?.drgreen_client_id, drGreenClient?.is_kyc_verified, drGreenClient?.admin_approval, fetchClient]);

  const addToCart = async (item: Omit<CartItem, 'id'>) => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      toast({
        title: "Authentication required",
        description: "Please sign in to add items to your cart.",
        variant: "destructive",
      });
      return;
    }

    // Check if item already in cart so we can increment rather than overwrite
    const existing = cart.find(c => c.strain_id === item.strain_id);
    const newQuantity = existing ? existing.quantity + item.quantity : item.quantity;

    const { error } = await supabase
      .from('drgreen_cart')
      .upsert({
        user_id: user.id,
        strain_id: item.strain_id,
        strain_name: item.strain_name,
        quantity: newQuantity,
        unit_price: item.unit_price,
      }, {
        onConflict: 'user_id,strain_id',
      });

    if (error) {
      console.error('Error adding to cart:', error);
      toast({
        title: "Error",
        description: "Failed to add item to cart.",
        variant: "destructive",
      });
      return;
    }

    await fetchCart();
    // Caller is responsible for showing success feedback — no toast here
  };

  const removeFromCart = async (strainId: string) => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const { error } = await supabase
      .from('drgreen_cart')
      .delete()
      .eq('user_id', user.id)
      .eq('strain_id', strainId);

    if (error) {
      console.error('Error removing from cart:', error);
      return;
    }

    await fetchCart();
  };

  const updateQuantity = async (strainId: string, quantity: number) => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    if (quantity <= 0) {
      await removeFromCart(strainId);
      return;
    }

    const { error } = await supabase
      .from('drgreen_cart')
      .update({ quantity })
      .eq('user_id', user.id)
      .eq('strain_id', strainId);

    if (error) {
      console.error('Error updating quantity:', error);
      return;
    }

    await fetchCart();
  };

  const clearCart = async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const { error } = await supabase
      .from('drgreen_cart')
      .delete()
      .eq('user_id', user.id);

    if (error) {
      console.error('Error clearing cart:', error);
      return;
    }

    setCart([]);
  };

  return (
    <ShopContext.Provider
      value={{
        cart,
        cartCount,
        cartTotal,
        cartTotalConverted,
        isCartOpen,
        setIsCartOpen,
        addToCart,
        removeFromCart,
        updateQuantity,
        clearCart,
        drGreenClient,
        isEligible,
        isLoading,
        refreshClient,
        syncVerificationFromDrGreen,
        isSyncing,
        countryCode,
        setCountryCode,
        exchangeRates: rates,
        convertFromEUR,
        convertFromZAR, // deprecated, but kept for compatibility
        ratesLastUpdated: lastUpdated,
      }}
    >
      {children}
    </ShopContext.Provider>
  );
}

export function useShop() {
  const context = useContext(ShopContext);
  if (context === undefined) {
    throw new Error('useShop must be used within a ShopProvider');
  }
  return context;
}

export function useShopSafe() {
  const context = useContext(ShopContext);
  return context ?? null;
}
