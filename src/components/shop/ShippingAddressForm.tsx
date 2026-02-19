import { useState, useEffect } from 'react';
import { z } from 'zod';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { MapPin, Loader2, Save, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';
import { useDrGreenApi } from '@/hooks/useDrGreenApi';
import { supabase } from '@/integrations/supabase/client';
import { toAlpha3, toAlpha2, DEFAULT_COUNTRY, getCountryConfig } from '@/lib/countries';

// Country options for the dropdown
const countries = [
  { code: 'PT', name: 'Portugal', alpha3: 'PRT' },
  { code: 'ZA', name: 'South Africa', alpha3: 'ZAF' },
  { code: 'TH', name: 'Thailand', alpha3: 'THA' },
  { code: 'GB', name: 'United Kingdom', alpha3: 'GBR' },
];

// Country-specific postal code validation
const postalCodePatterns: Record<string, { pattern: RegExp; example: string }> = {
  PT: { pattern: /^\d{4}(-\d{3})?$/, example: '1000-001' },
  GB: { pattern: /^[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}$/i, example: 'SW1A 1AA' },
  ZA: { pattern: /^\d{4}$/, example: '2196' },
  TH: { pattern: /^\d{5}$/, example: '10110' },
};

// Country-specific field placeholders
const countryPlaceholders: Record<string, {
  address1: string;
  address2: string;
  city: string;
  state: string;
  landmark: string;
}> = {
  PT: {
    address1: 'Rua Augusta 100',
    address2: 'Andar 3',
    city: 'Lisboa',
    state: 'Lisboa',
    landmark: 'Perto da Praça',
  },
  ZA: {
    address1: '123 Rivonia Road',
    address2: 'Unit 5B',
    city: 'Johannesburg',
    state: 'Gauteng',
    landmark: 'Near Sandton City',
  },
  GB: {
    address1: '10 Downing Street',
    address2: 'Flat 2A',
    city: 'London',
    state: 'England',
    landmark: 'Near Westminster',
  },
  TH: {
    address1: '123 Sukhumvit Road',
    address2: 'Room 4B',
    city: 'Bangkok',
    state: 'Krung Thep',
    landmark: 'Near BTS Asok',
  },
};

// Country-specific field labels
const countryLabels: Record<string, {
  state: string;
  postalCode: string;
  address2: string;
}> = {
  PT: { state: 'Distrito', postalCode: 'Código Postal', address2: 'Apartamento / Andar (Opcional)' },
  ZA: { state: 'Province', postalCode: 'Postal Code', address2: 'Unit / Suite (Optional)' },
  GB: { state: 'County', postalCode: 'Post Code', address2: 'Flat / Apartment (Optional)' },
  TH: { state: 'Changwat (Province)', postalCode: 'Postal Code', address2: 'Room / Unit (Optional)' },
};

const getPlaceholder = (country: string, field: keyof typeof countryPlaceholders['PT']) => {
  return countryPlaceholders[country]?.[field] || countryPlaceholders['ZA'][field];
};

const getLabel = (country: string, field: keyof typeof countryLabels['PT']) => {
  return countryLabels[country]?.[field] || countryLabels['ZA'][field];
};

const getCountryName = (code: string): string => {
  return getCountryConfig(code).name || code;
};

// Create address schema with country-specific validation
const createAddressSchema = (countryCode: string) => {
  const postalPattern = postalCodePatterns[countryCode];
  
  return z.object({
    address1: z.string()
      .min(5, 'Address must be at least 5 characters')
      .max(200, 'Address is too long'),
    address2: z.string().max(200).optional().or(z.literal('')),
    landmark: z.string().max(100).optional().or(z.literal('')),
    city: z.string()
      .min(2, 'City is required')
      .max(100, 'City name is too long'),
    state: z.string().max(100).optional().or(z.literal('')),
    postalCode: z.string()
      .min(4, 'Postal code is required')
      .refine(
        (val) => !postalPattern || postalPattern.pattern.test(val.trim()),
        { message: `Invalid postal code format (e.g., ${postalPattern?.example || '12345'})` }
      ),
    country: z.string().min(2, 'Country is required'),
  });
};

type AddressFormData = z.infer<ReturnType<typeof createAddressSchema>>;

export interface ShippingAddress {
  address1: string;
  address2?: string;
  landmark?: string;
  city: string;
  state?: string;
  country: string;
  countryCode: string;
  postalCode: string;
}

interface ShippingAddressFormProps {
  clientId: string;
  initialAddress?: ShippingAddress | null;
  defaultCountry?: string;
  onSuccess?: (address: ShippingAddress) => void;
  onCancel?: () => void;
  variant?: 'card' | 'inline';
  submitLabel?: string;
  /** When true, uses the admin proxy action to update address (bypasses ownership check) */
  isAdmin?: boolean;
}

export function ShippingAddressForm({
  clientId,
  initialAddress,
  defaultCountry = DEFAULT_COUNTRY,
  onSuccess,
  onCancel,
  variant = 'card',
  submitLabel = 'Save Address',
  isAdmin = false,
}: ShippingAddressFormProps) {
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const { toast } = useToast();
  const { updateShippingAddress, adminUpdateShippingAddress } = useDrGreenApi();

  // Determine initial country from address or default
    const initialCountry = initialAddress?.countryCode
    ? toAlpha2(initialAddress.countryCode) || defaultCountry
    : defaultCountry;

  const form = useForm<AddressFormData>({
    resolver: zodResolver(createAddressSchema(initialCountry)),
    defaultValues: {
      address1: initialAddress?.address1 || '',
      address2: initialAddress?.address2 || '',
      landmark: initialAddress?.landmark || '',
      city: initialAddress?.city || '',
      state: initialAddress?.state || '',
      postalCode: initialAddress?.postalCode || '',
      country: initialCountry,
    },
  });

  const selectedCountry = form.watch('country');

  // Re-validate postal code when country changes (schema pattern changes)
  useEffect(() => {
    form.clearErrors('postalCode');
    const currentPostal = form.getValues('postalCode');
    if (currentPostal) {
      form.trigger('postalCode');
    }
  }, [selectedCountry]);

  const handleSubmit = async (data: AddressFormData) => {
    console.log('[ShippingAddressForm] Form submitted with:', data);
    setIsSaving(true);
    setSaveSuccess(false);

    try {
      // Convert country code to Alpha-3 for API
      const alpha3CountryCode = toAlpha3(data.country);
      
      const shippingData: ShippingAddress = {
        address1: data.address1.trim(),
        address2: data.address2?.trim() || '',
        landmark: data.landmark?.trim() || '',
        city: data.city.trim(),
        state: data.state?.trim() || data.city.trim(), // Default state to city if not provided
        country: getCountryName(data.country),
        countryCode: alpha3CountryCode,
        postalCode: data.postalCode.trim(),
      };

      // Try to update address in Dr. Green API (optional - don't block on failure)
      // Use admin proxy action when isAdmin=true to bypass ownership checks
      try {
        const updateFn = isAdmin ? adminUpdateShippingAddress : updateShippingAddress;
        const result = await updateFn(clientId, shippingData);
        if (result.error) {
          console.warn('Could not sync address to Dr. Green API:', result.error);
          // Continue anyway - address will be included in order payload
        }
      } catch (apiError) {
        console.warn('Address sync to API failed:', apiError);
        // Continue anyway
      }

      // CRITICAL: Also save to local database for fallback
      // This ensures checkout works even if Dr. Green API is unreachable
      try {
        // Cast to a plain object for JSON storage
        const shippingJson = {
          address1: shippingData.address1,
          address2: shippingData.address2,
          landmark: shippingData.landmark,
          city: shippingData.city,
          state: shippingData.state,
          country: shippingData.country,
          countryCode: shippingData.countryCode,
          postalCode: shippingData.postalCode,
        };
        
        const { error: localUpdateError } = await supabase
          .from('drgreen_clients')
          .update({ 
            shipping_address: shippingJson,
            updated_at: new Date().toISOString(),
          })
          .eq('drgreen_client_id', clientId);
        
        if (localUpdateError) {
          console.warn('Could not save address to local DB:', localUpdateError);
        } else {
          console.log('[ShippingAddressForm] Address saved to local DB successfully');
        }
      } catch (localError) {
        console.warn('Local DB address save failed:', localError);
      }

      // Always succeed and pass address to checkout
      setSaveSuccess(true);
      toast({
        title: 'Address Confirmed',
        description: 'Your shipping address is ready for checkout.',
      });

      console.log('[ShippingAddressForm] Calling onSuccess with:', shippingData);
      onSuccess?.(shippingData);
    } catch (error) {
      // Only fail if there's a form validation error
      console.error('Failed to process shipping address:', error);
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Please check your address.',
        variant: 'destructive',
      });
    } finally {
      setIsSaving(false);
    }
  };

  const formContent = (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
        {/* Address Line 1 */}
        <FormField
          control={form.control}
          name="address1"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Street Address *</FormLabel>
              <FormControl>
                <Input placeholder={getPlaceholder(selectedCountry, 'address1')} {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* Address Line 2 */}
        <FormField
          control={form.control}
          name="address2"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{getLabel(selectedCountry, 'address2')}</FormLabel>
              <FormControl>
                <Input placeholder={getPlaceholder(selectedCountry, 'address2')} {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* City and State in a row */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <FormField
            control={form.control}
            name="city"
            render={({ field }) => (
              <FormItem>
                <FormLabel>City *</FormLabel>
                <FormControl>
                  <Input placeholder={getPlaceholder(selectedCountry, 'city')} {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="state"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{getLabel(selectedCountry, 'state')}</FormLabel>
                <FormControl>
                  <Input placeholder={getPlaceholder(selectedCountry, 'state')} {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        {/* Postal Code and Country in a row */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <FormField
            control={form.control}
            name="postalCode"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{getLabel(selectedCountry, 'postalCode')} *</FormLabel>
                <FormControl>
                  <Input 
                    placeholder={postalCodePatterns[selectedCountry]?.example || '12345'} 
                    {...field} 
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="country"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Country *</FormLabel>
                <Select onValueChange={field.onChange} value={field.value}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="Select country" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {countries.map((country) => (
                      <SelectItem key={country.code} value={country.code}>
                        {country.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        {/* Landmark (Optional) */}
        <FormField
          control={form.control}
          name="landmark"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Landmark (Optional)</FormLabel>
              <FormControl>
                <Input placeholder={getPlaceholder(selectedCountry, 'landmark')} {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* Actions */}
        <div className="flex flex-col sm:flex-row gap-3 pt-2">
          {onCancel && (
            <Button type="button" variant="outline" onClick={onCancel} className="flex-1">
              Cancel
            </Button>
          )}
          <Button 
            type="submit" 
            disabled={isSaving} 
            className="flex-1"
          >
            {isSaving ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Saving...
              </>
            ) : saveSuccess ? (
              <>
                <Check className="mr-2 h-4 w-4" />
                Saved!
              </>
            ) : (
              <>
                <Save className="mr-2 h-4 w-4" />
                {submitLabel}
              </>
            )}
          </Button>
        </div>
      </form>
    </Form>
  );

  if (variant === 'inline') {
    return formContent;
  }

  return (
    <Card className="bg-card/50 backdrop-blur-sm border-border/50">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MapPin className="h-5 w-5" />
          Shipping Address
        </CardTitle>
        <CardDescription>
          Enter your delivery address for medical cannabis shipments
        </CardDescription>
      </CardHeader>
      <CardContent>
        {formContent}
      </CardContent>
    </Card>
  );
}

export default ShippingAddressForm;
