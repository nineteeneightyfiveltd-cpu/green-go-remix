import { supabase } from '@/integrations/supabase/client';

interface DrGreenResponse<T = unknown> {
  data: T | null;
  error: string | null;
}

// Country code conversion map (Alpha-2 to Alpha-3)
const countryCodeMap: Record<string, string> = {
  PT: 'PRT',
  GB: 'GBR',
  ZA: 'ZAF',
  TH: 'THA',
  US: 'USA',
};

// Storage key for persisted environment selection
const ENV_STORAGE_KEY = 'hb-api-environment';

// Get current environment from localStorage (for non-React contexts)
function getCurrentEnvironment(): string {
  if (typeof window !== 'undefined') {
    const stored = localStorage.getItem(ENV_STORAGE_KEY);
    if (stored && ['production', 'staging', 'railway'].includes(stored)) {
      return stored;
    }
  }
  return 'production';
}

export function useDrGreenApi() {
  const callProxy = async <T = unknown>(
    action: string,
    data?: Record<string, unknown>,
    overrideEnv?: string
  ): Promise<DrGreenResponse<T>> => {
    try {
      // Use override env if provided, otherwise get from localStorage
      const env = overrideEnv || getCurrentEnvironment();
      
      const { data: response, error } = await supabase.functions.invoke('drgreen-proxy', {
        body: { action, env, ...data },
      });

      if (error) {
        console.error('Dr Green API error:', error);
        return { data: null, error: error.message };
      }

      // Handle 200-wrapped error responses (for observable error transport)
      // These have success:false and contain apiStatus/message for debugging
      if (response && typeof response === 'object' && response.success === false) {
        const apiStatus = response.apiStatus || response.status;
        const errorMessage = response.message || response.error || 'Operation failed';
        const errorCode = response.errorCode || 'UNKNOWN';
        const requestId = response.requestId || '';
        
        // Build detailed error string for debugging
        const fullError = requestId 
          ? `${errorMessage} [${errorCode}] (Status ${apiStatus}, Ref: ${requestId})`
          : `${errorMessage} (Status ${apiStatus})`;
        
        console.error('Dr Green API returned error:', {
          action,
          env,
          apiStatus,
          errorCode,
          message: errorMessage,
          requestId,
          retryable: response.retryable,
          stepFailed: response.stepFailed,
        });
        
        return { data: null, error: fullError };
      }

      return { data: response as T, error: null };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error('Dr Green API exception:', err);
      return { data: null, error: message };
    }
  };

  // Create an order with items directly (per official Dr. Green API documentation)
  // POST /api/v1/dapp/orders - pass items in request body
  const createOrder = async (orderData: {
    clientId: string;
    items: Array<{
      productId: string;
      quantity: number;
      price: number;
    }>;
    shippingAddress?: {
      street?: string;     // Maps to address1 in Dr. Green API
      address1?: string;   // Alternative field name
      address2?: string;   // Optional secondary address
      city?: string;
      state?: string;
      zipCode?: string;    // Maps to postalCode in Dr. Green API
      postalCode?: string; // Alternative field name
      country?: string;
      countryCode?: string; // ISO country code
      landmark?: string;   // Optional landmark
    };
    notes?: string;
  }) => {
    return callProxy<{
      orderId: string;
      orderNumber?: string;
      status: string;
      totalAmount: number;
    }>('create-order', { data: orderData }, 'production');
  };

  // Create a payment for an order
  const createPayment = async (paymentData: {
    orderId: string;
    amount: number;
    currency: string;
    clientId: string;
  }) => {
    return callProxy<{
      paymentId: string;
      status: string;
      paymentUrl?: string;
    }>('create-payment', { data: paymentData }, 'production');
  };

  // Get payment status
  const getPayment = async (paymentId: string) => {
    return callProxy<{
      paymentId: string;
      status: 'PENDING' | 'PAID' | 'FAILED' | 'CANCELLED';
      amount: number;
      orderId: string;
    }>('get-payment', { paymentId }, 'production');
  };

  // Get order details
  const getOrder = async (orderId: string) => {
    return callProxy<{
      orderId: string;
      status: string;
      items: Array<{
        strainId: string;
        quantity: number;
        unitPrice: number;
      }>;
      totalAmount: number;
      paymentStatus: string;
    }>('get-order', { orderId });
  };

  // Update order status (after payment confirmation)
  const updateOrder = async (orderId: string, data: {
    status?: string;
    paymentStatus?: string;
  }) => {
    return callProxy<{
      orderId: string;
      status: string;
      paymentStatus: string;
    }>('update-order', { orderId, data });
  };

  // Get user's orders
  const getOrders = async (clientId: string) => {
    return callProxy<Array<{
      orderId: string;
      status: string;
      totalAmount: number;
      createdAt: string;
      paymentStatus: string;
    }>>('get-orders', { clientId }, 'production');
  };

  // Get strains by country (client-facing)
  const getStrains = async (countryCode: string) => {
    const alpha3Code = countryCodeMap[countryCode] || countryCode;
    return callProxy<Array<{
      id: string;
      name: string;
      description: string;
      thcContent: number;
      cbdContent: number;
      retailPrice: number;
      availability: boolean;
      images: string[];
    }>>('get-strains', { countryCode: alpha3Code });
  };

  // ==========================================
  // ADMIN / DASHBOARD ENDPOINTS
  // ==========================================
  
  // Get dashboard summary (total clients, orders, sales, etc.)
  const getDashboardSummary = async () => {
    return callProxy<{
      totalClients: number;
      totalOrders: number;
      totalSales: number;
      pendingOrders: number;
      verifiedClients: number;
      pendingClients: number;
    }>('dashboard-summary');
  };

  // Get dashboard analytics
  const getDashboardAnalytics = async (params?: {
    startDate?: string;
    endDate?: string;
    filterBy?: string;
    orderBy?: 'asc' | 'desc';
  }) => {
    return callProxy<{
      salesData: Array<{ date: string; amount: number }>;
      ordersData: Array<{ date: string; count: number }>;
    }>('dashboard-analytics', params);
  };

  // Get sales summary
  const getSalesSummary = async () => {
    return callProxy<{
      totalSales: number;
      monthlySales: number;
      weeklySales: number;
      dailySales: number;
    }>('sales-summary');
  };

  // Get all Dapp clients (paginated)
  const getDappClients = async (params?: {
    page?: number;
    take?: number;
    orderBy?: 'asc' | 'desc';
    search?: string;
    searchBy?: string;
    status?: string;
    kyc?: boolean;
    adminApproval?: string;
  }) => {
    return callProxy<{
      clients: Array<{
        id: string;
        email: string;
        firstName: string;
        lastName: string;
        isKYCVerified: boolean;
        adminApproval: string;
        createdAt: string;
      }>;
      total: number;
      page: number;
      take: number;
    }>('dapp-clients', params);
  };

  // Get client details
  const getDappClientDetails = async (clientId: string) => {
    return callProxy<{
      id: string;
      email: string;
      firstName: string;
      lastName: string;
      phone: string;
      address: object;
      isKYCVerified: boolean;
      adminApproval: string;
      createdAt: string;
      orders: Array<object>;
    }>('dapp-client-details', { clientId });
  };

  // DEPRECATED: Verify or reject a client
  // NOTE: The Dr. Green API does NOT support external approval/rejection.
  // Client approval can ONLY be done within the Dr. Green DApp admin portal.
  // This function is kept for backwards compatibility but will return an error.
  const verifyDappClient = async (clientId: string, verifyAction: 'verify' | 'reject') => {
    console.warn('[DEPRECATED] verifyDappClient: Client approval must be done in Dr. Green DApp admin portal');
    return callProxy<{ success: boolean; message: string }>('dapp-verify-client', { clientId, verifyAction });
  };

  // Sync client status from Dr. Green API
  // Use this to refresh adminApproval status after external approval in Dr. Green DApp
  const syncClientStatus = async (clientId: string) => {
    return callProxy<{
      id: string;
      email: string;
      firstName: string;
      lastName: string;
      isKYCVerified: boolean;
      adminApproval: string;
      createdAt: string;
    }>('sync-client-status', { clientId });
  };

  // Get all Dapp orders (paginated)
  const getDappOrders = async (params?: {
    page?: number;
    take?: number;
    orderBy?: 'asc' | 'desc';
    search?: string;
    searchBy?: string;
    adminApproval?: string;
    clientIds?: string[];
  }) => {
    return callProxy<{
      orders: Array<{
        id: string;
        clientId: string;
        status: string;
        paymentStatus: string;
        totalAmount: number;
        createdAt: string;
        items: Array<object>;
      }>;
      total: number;
      page: number;
      take: number;
    }>('dapp-orders', params);
  };

  // Get order details
  const getDappOrderDetails = async (orderId: string) => {
    return callProxy<{
      id: string;
      clientId: string;
      status: string;
      paymentStatus: string;
      totalAmount: number;
      items: Array<object>;
      shippingAddress: object;
      createdAt: string;
    }>('dapp-order-details', { orderId });
  };

  // Update order status
  const updateDappOrder = async (orderId: string, data: {
    orderStatus?: string;
    paymentStatus?: string;
  }) => {
    return callProxy<{ success: boolean; message: string }>('dapp-update-order', { orderId, ...data });
  };

  // Get Dapp strains by country
  const getDappStrains = async (params?: {
    countryCode?: string;
    orderBy?: 'asc' | 'desc';
    search?: string;
    searchBy?: string;
  }) => {
    return callProxy<{
      strains: Array<{
        id: string;
        name: string;
        thcContent: number;
        cbdContent: number;
        retailPrice: number;
        availability: boolean;
      }>;
    }>('dapp-strains', params);
  };

  // ==========================================
  // NEW ENDPOINTS FROM POSTMAN COLLECTION
  // ==========================================
  
  // Get current authenticated user details from Dr Green
  const getUserMe = async () => {
    return callProxy<{
      id: string;
      email: string;
      firstName: string;
      lastName: string;
      walletAddress?: string;
      nfts?: Array<{ id: string; tokenId: string; type: string }>;
    }>('get-user-me');
  };

  // Delete a client (admin only)
  const deleteClient = async (clientId: string) => {
    return callProxy<{ success: boolean; message: string }>('delete-client', { clientId });
  };

  // Partial update client details (admin only)
  const patchClient = async (clientId: string, data: {
    firstName?: string;
    lastName?: string;
    email?: string;
    phone?: string;
    status?: string;
    shipping?: {
      address1: string;
      address2?: string;
      landmark?: string;
      city: string;
      state?: string;
      country: string;
      countryCode: string;
      postalCode: string;
    };
  }) => {
    return callProxy<{ success: boolean; client: object }>('patch-client', { clientId, data });
  };

  // Update client shipping address specifically
  const updateShippingAddress = async (clientId: string, shipping: {
    address1: string;
    address2?: string;
    landmark?: string;
    city: string;
    state?: string;
    country: string;
    countryCode: string;
    postalCode: string;
  }) => {
    return callProxy<{ success: boolean; message?: string }>('update-shipping-address', { 
      clientId, 
      shipping 
    }, 'production');
  };

  // Get client details including shipping address (for the logged-in user)
  // Uses 'get-my-details' which is ownership-verified (user can only fetch their own data)
  const getClientDetails = async (clientId: string) => {
    return callProxy<{
      id: string;
      email: string;
      firstName: string;
      lastName: string;
      isKYCVerified: boolean;
      adminApproval: string;
      shipping?: {
        address1: string;
        address2?: string;
        landmark?: string;
        city: string;
        state?: string;
        country: string;
        countryCode: string;
        postalCode: string;
      };
    }>('get-my-details', { clientId }, 'production');
  };

  // Admin: Update any client's shipping address (bypasses ownership check)
  const adminUpdateShippingAddress = async (clientId: string, shipping: {
    address1: string;
    address2?: string;
    landmark?: string;
    city: string;
    state?: string;
    country: string;
    countryCode: string;
    postalCode: string;
  }) => {
    return callProxy<{ success: boolean; message?: string }>('admin-update-shipping-address', { 
      clientId, 
      shipping 
    });
  };

  // Activate a client (admin only)
  const activateClient = async (clientId: string) => {
    return callProxy<{ success: boolean; message: string }>('activate-client', { clientId });
  };

  // Deactivate a client (admin only)
  const deactivateClient = async (clientId: string) => {
    return callProxy<{ success: boolean; message: string }>('deactivate-client', { clientId });
  };

  // Bulk delete clients (admin only, max 50)
  const bulkDeleteClients = async (clientIds: string[]) => {
    return callProxy<{ success: boolean; deleted: number; failed: number }>('bulk-delete-clients', { clientIds });
  };

  // ==========================================
  // NEW ENDPOINTS FROM OFFICIAL DOCUMENTATION
  // ==========================================

  // Pagination metadata type
  interface PageMetaDto {
    page: string;
    take: string;
    itemCount: number;
    pageCount: number;
    hasPreviousPage: boolean;
    hasNextPage: boolean;
  }

  // Get client summary (PENDING/VERIFIED/REJECTED counts)
  const getClientsSummary = async () => {
    return callProxy<{
      summary: {
        PENDING: number;
        VERIFIED: number;
        REJECTED: number;
        totalCount: number;
      };
    }>('get-clients-summary');
  };

  // Get sales with optional stage filter
  const getSales = async (params?: {
    stage?: 'LEADS' | 'ONGOING' | 'CLOSED';
    page?: number;
    take?: number;
    orderBy?: 'asc' | 'desc';
    search?: string;
    searchBy?: string;
  }) => {
    return callProxy<{
      sales: Array<{
        id: string;
        stage: string;
        description: string | null;
        orderId: string | null;
        client: {
          id: string;
          firstName: string;
          lastName: string;
          email: string;
          phoneCountryCode: string;
          phoneCode: string;
          contactNumber: string;
          isActive: boolean;
        };
        createdAt: string;
        updatedAt: string;
      }>;
      pageMetaDto: PageMetaDto;
    }>('get-sales', params);
  };

  // Get sales summary by stage
  const getSalesSummaryNew = async () => {
    return callProxy<{
      summary: {
        ONGOING: number;
        LEADS: number;
        CLOSED: number;
        totalCount: number;
      };
      count: number;
    }>('get-sales-summary');
  };

  // Get orders for a specific client
  const getClientOrders = async (clientId: string, params?: {
    page?: number;
    take?: number;
    orderBy?: 'asc' | 'desc';
  }) => {
    return callProxy<{
      orders: Array<{
        id: string;
        createdAt: string;
        updatedAt: string;
        paymentStatus: string;
        orderStatus: string;
        invoiceNumber: string;
        totalAmount: number;
        totalOrdered: number;
        totalQuantity: number;
        totalPrice: number;
      }>;
      pageMetaDto: PageMetaDto;
    }>('get-client-orders', { clientId, ...params });
  };

  // Get user's owned NFTs
  const getUserNfts = async () => {
    return callProxy<{
      nfts: Array<{
        tokenId: number;
        nftMetadata: {
          nftName: string;
          nftType: string;
          imageUrl: string;
        };
        owner: {
          id: string;
          walletAddress: string;
          fullName: string;
          username: string;
          email: string;
          phoneCountryCode: string | null;
          phoneCode: string | null;
          phoneNumber: string | null;
          profileUrl: string;
          isActive: boolean;
        };
      }>;
      pageMetaDto: PageMetaDto;
    }>('get-user-nfts');
  };

  // ==========================================
  // CART MANAGEMENT ENDPOINTS
  // ==========================================

  // Add item to Dr. Green server-side cart
  const addToCart = async (cartData: {
    clientId: string;
    strainId: string;
    quantity: number;
  }) => {
    return callProxy<{
      success: boolean;
      cart?: { items: Array<{ strainId: string; quantity: number }> };
    }>('add-to-cart', { data: cartData }, 'production');
  };

  // Empty the Dr. Green server-side cart
  const emptyCart = async (cartId: string) => {
    return callProxy<{ success: boolean }>('empty-cart', { cartId }, 'production');
  };

  // Place order from server-side cart (uses body signing)
  const placeOrder = async (orderData: { clientId: string }) => {
    return callProxy<{
      orderId: string;
      status: string;
      totalAmount: number;
    }>('place-order', { data: orderData }, 'production');
  };

  return {
    // Existing methods
    createOrder,
    createPayment,
    getPayment,
    getOrder,
    updateOrder,
    getOrders,
    getStrains,
    callProxy,
    // Cart methods
    addToCart,
    emptyCart,
    placeOrder,
    // Admin methods
    getDashboardSummary,
    getDashboardAnalytics,
    getSalesSummary,
    getDappClients,
    getDappClientDetails,
    verifyDappClient, // DEPRECATED - kept for backwards compatibility
    syncClientStatus, // NEW - use this to refresh client status from Dr. Green API
    getDappOrders,
    getDappOrderDetails,
    updateDappOrder,
    getDappStrains,
    // New endpoints from Postman collection
    getUserMe,
    deleteClient,
    patchClient,
    activateClient,
    deactivateClient,
    bulkDeleteClients,
    // New endpoints from official documentation
    getClientsSummary,
    getSales,
    getSalesSummaryNew,
    getClientOrders,
    getUserNfts,
    // Shipping address management
    updateShippingAddress,
    getClientDetails,
    adminUpdateShippingAddress,
    // Admin re-registration
    reregisterClient: async (clientData: {
      email: string;
      firstName: string;
      lastName: string;
      countryCode?: string;
      phoneCode?: string;
      phoneCountryCode?: string;
      contactNumber?: string;
      shipping?: {
        address1?: string;
        address2?: string;
        city?: string;
        state?: string;
        country?: string;
        countryCode?: string;
        postalCode?: string;
        landmark?: string;
      };
    }) => {
      return callProxy<{
        success: boolean;
        clientId?: string;
        kycLink?: string;
        message?: string;
      }>('admin-reregister-client', clientData);
    },
    // Sync/link existing client by email
    syncClientByEmail: async (email: string, localUserId?: string) => {
      return callProxy<{
        success: boolean;
        client?: {
          id: string;
          email: string;
          firstName: string;
          lastName: string;
          isKYCVerified: boolean;
          adminApproval: string;
        };
        synced?: boolean;
        message?: string;
      }>('sync-client-by-email', { email, localUserId });
    },
  };
}
