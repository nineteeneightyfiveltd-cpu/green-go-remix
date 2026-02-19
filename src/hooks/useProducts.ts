import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';

// Import local strain images - new branded jar images
import strainJar1 from '@/assets/strain-jar-1.png';
import strainJar2 from '@/assets/strain-jar-2.png';
import strainJar3 from '@/assets/strain-jar-3.png';
import strainJar4 from '@/assets/strain-jar-4.png';
import strainJar5 from '@/assets/strain-jar-5.png';
import strainJar6 from '@/assets/strain-jar-6.png';
import strainJar7 from '@/assets/strain-jar-7.png';
import strainJarFallback from '@/assets/strain-jar-fallback.png';

export type DataSource = 'api' | 'none';

export interface Product {
  id: string;
  name: string;
  description: string;
  thcContent: number;
  cbdContent: number;
  retailPrice: number;
  availability: boolean;
  stock: number;
  imageUrl: string;
  videoUrl?: string;
  effects: string[];
  terpenes: string[];
  category: string;
  dataSource: DataSource;
}

// Strain name to branded jar image mapping (case-insensitive keys normalized below)
const STRAIN_IMAGE_MAP: Record<string, string> = {
  'blockberry': strainJar1,
  'block berry': strainJar1,
  'blue zushi': strainJar2,
  'bluezushi': strainJar2,
  'candy pave': strainJar3,
  'candypave': strainJar3,
  'caribbean breeze': strainJar4,
  'caribbeanbreeze': strainJar4,
  'femme fatale': strainJar5,
  'femmefatale': strainJar5,
  'nfs 12': strainJar6,
  'nfs12': strainJar6,
  'peanut butter breath': strainJar7,
  'peanutbutterbreath': strainJar7,
};

// Fallback jar image for unknown strains
const FALLBACK_JAR = strainJarFallback;

// Get branded jar image for a strain - first by name match, then fallback
const getBrandedImage = (name: string): string => {
  // Normalize the name for lookup
  const normalizedName = name.toLowerCase().trim();
  
  // Try exact match
  if (STRAIN_IMAGE_MAP[normalizedName]) {
    return STRAIN_IMAGE_MAP[normalizedName];
  }
  
  // Try removing spaces
  const noSpaces = normalizedName.replace(/\s+/g, '');
  if (STRAIN_IMAGE_MAP[noSpaces]) {
    return STRAIN_IMAGE_MAP[noSpaces];
  }
  
  // Try partial match
  for (const [key, value] of Object.entries(STRAIN_IMAGE_MAP)) {
    if (normalizedName.includes(key) || key.includes(normalizedName)) {
      return value;
    }
  }
  
  // Return fallback jar for unknown strains
  return FALLBACK_JAR;
};

// Background sync throttle key
const BG_SYNC_KEY = 'hb_products_bg_sync';
const BG_SYNC_THROTTLE_MS = 60 * 60 * 1000; // 1 hour

// Trigger a non-blocking background sync to keep local DB current
const triggerBackgroundSync = (alpha3Code: string) => {
  try {
    const lastSync = parseInt(localStorage.getItem(BG_SYNC_KEY) || '0', 10);
    if (Date.now() - lastSync < BG_SYNC_THROTTLE_MS) return;
    localStorage.setItem(BG_SYNC_KEY, String(Date.now()));
    
    console.log('[Products] Triggering background strain sync...');
    supabase.functions.invoke('sync-strains', {
      body: { countryCode: alpha3Code },
    }).then(({ error }) => {
      if (error) console.warn('[Products] Background sync error:', error);
      else console.log('[Products] Background sync complete');
    });
  } catch {
    // non-critical
  }
};

import { toAlpha3, SUPPORTED_COUNTRIES, DEFAULT_COUNTRY } from '@/lib/countries';

export function useProducts(countryCode: string = DEFAULT_COUNTRY) {
  const [products, setProducts] = useState<Product[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dataSource, setDataSource] = useState<DataSource>('none');

  const fetchProducts = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    // Validate country code
    if (!(SUPPORTED_COUNTRIES as readonly string[]).includes(countryCode)) {
      console.warn(`Unsupported country code: ${countryCode}`);
      setProducts([]);
      setDataSource('none');
      setError('Products are not available in your region');
      setIsLoading(false);
      return;
    }

    const alpha3Code = toAlpha3(countryCode);
    
    try {
      // First try to fetch from Dr Green API
      console.log(`Fetching strains from Dr Green API for country: ${alpha3Code}`);
      
      const PRODUCT_FETCH_TIMEOUT_MS = 15000;

      const fetchPromise = supabase.functions.invoke('drgreen-proxy', {
        body: {
          action: 'get-strains-legacy',
          countryCode: alpha3Code,
          orderBy: 'desc',
          take: 100,
          page: 1,
        },
      });

      const timeoutPromise = new Promise<{ data: null; error: { message: string } }>((_, reject) =>
        setTimeout(
          () => reject(new Error('Product loading timed out. Please tap "Try Again".')),
          PRODUCT_FETCH_TIMEOUT_MS
        )
      );

      const { data, error: fnError } = await Promise.race([fetchPromise, timeoutPromise]);

      // API response can be:
      // 1. Array of strains directly: [{ id, name, ... }]
      // 2. Object with strains property: { strains: [...] }
      // 3. Object with data.strains: { data: { strains: [...] } }
      // 4. Wrapped response: { success: true, data: { strains: [...] } }
      
      let strainsArray: any[] = [];
      
      if (!fnError && data) {
        if (Array.isArray(data)) {
          strainsArray = data;
        } else if (Array.isArray(data.strains)) {
          strainsArray = data.strains;
        } else if (Array.isArray(data.data?.strains)) {
          strainsArray = data.data.strains;
        } else if (Array.isArray(data.data)) {
          strainsArray = data.data;
        }
      }
      
      console.log(`[Dr Green API] Received ${strainsArray.length} strains from API`);

      if (strainsArray.length > 0) {
        console.log(`Processing ${strainsArray.length} strains from Dr Green API`);
        
        // Transform API response to our Product interface
        const transformedProducts: Product[] = strainsArray.map((strain: any, index: number) => {
          // Use branded jar image based on strain name, fallback to index
          const imageUrl = getBrandedImage(strain.name);

          let effects: string[] = [];
          if (Array.isArray(strain.effects)) {
            effects = strain.effects;
          } else if (Array.isArray(strain.feelings)) {
            effects = strain.feelings;
          } else if (typeof strain.feelings === 'string') {
            effects = strain.feelings.split(',').map((s: string) => s.trim());
          }

          let terpenes: string[] = [];
          if (Array.isArray(strain.flavour)) {
            terpenes = strain.flavour;
          } else if (typeof strain.flavour === 'string') {
            terpenes = strain.flavour.split(',').map((s: string) => s.trim());
          } else if (Array.isArray(strain.terpenes)) {
            terpenes = strain.terpenes;
          } else if (Array.isArray(strain.flavors)) {
            terpenes = strain.flavors;
          }

          const location = strain.strainLocations?.[0];
          const isAvailable = location?.isAvailable ?? strain.availability ?? strain.isAvailable ?? true;
          const stock = location?.stockQuantity ?? strain.stock ?? strain.stockQuantity ?? 100;

          const retailPrice = 
            parseFloat(strain.retailPrice) || 
            parseFloat(strain.pricePerGram) || 
            parseFloat(strain.price) || 
            parseFloat(location?.retailPrice) ||
            0;

          const thcContent = 
            parseFloat(strain.thc) || 
            parseFloat(strain.thcContent) || 
            parseFloat(strain.THC) ||
            0;
          const cbdContent = 
            parseFloat(strain.cbd) || 
            parseFloat(strain.cbdContent) || 
            parseFloat(strain.CBD) ||
            0;

          return {
            id: strain.id || strain._id,
            name: strain.name,
            description: strain.description || '',
            thcContent,
            cbdContent,
            retailPrice,
            availability: isAvailable,
            stock: stock,
            imageUrl,
            effects,
            terpenes,
            category: strain.category || strain.type || 'Hybrid',
            dataSource: 'api' as DataSource,
          };
        });
        
      setProducts(transformedProducts);
        setDataSource('api');
        setIsLoading(false);
        
        // Background sync: keep local DB current (non-blocking, throttled to max once/hour)
        triggerBackgroundSync(alpha3Code);
        return;
      }
      
      // Log API error/warning - no local fallback, always use Dr Green API
      if (fnError) {
        console.error(`[Products] API error for ${alpha3Code}:`, fnError);
        // Extract actual error message from the response
        const errorMsg = fnError.message || data?.error || 'Failed to fetch products';
        throw new Error(errorMsg);
      } else {
        console.warn(`[Products] No strains returned for ${alpha3Code}. Response:`, data);
        setProducts([]);
        setDataSource('none');
        setError('No products available in your region');
      }
      
    } catch (err: any) {
      console.error(`[Products] Error for ${alpha3Code}:`, err);
      setProducts([]);
      setDataSource('none');
      // Show actual error message if available
      setError(err?.message || 'Failed to connect to the product service');
    } finally {
      setIsLoading(false);
    }
  }, [countryCode]);

  useEffect(() => {
    fetchProducts();
  }, [fetchProducts]);

  return {
    products,
    isLoading,
    error,
    dataSource,
    refetch: fetchProducts,
  };
}
