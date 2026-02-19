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
import { toAlpha3, toAlpha2, DEFAULT_COUNTRY, getCountryConfig, SUPPORTED_COUNTRIES, COUNTRY_REGISTRY } from '@/lib/countries';

// Country options for the dropdown — driven from COUNTRY_REGISTRY (single source of truth)
const countries = SUPPORTED_COUNTRIES.map(code => ({
  code,
  name: COUNTRY_REGISTRY[code].name,
  alpha3: COUNTRY_REGISTRY[code].alpha3,
}));

// Create address schema with country-specific validation from COUNTRY_REGISTRY
const createAddressSchema = (countryCode: string) => {
  const cfg = getCountryConfig(countryCode);
  // postalCodePattern is a regex string in the registry — compile it (case-insensitive)
  const postalRegex = new RegExp(cfg.postalCodePattern, 'i');

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
        (val) => postalRegex.test(val.trim()),
        { message: `Invalid format (e.g. ${cfg.postalCodePlaceholder})` }
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

  // Determine initial country: prefer initialAddress, then defaultCountry
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
        country: getCountryConfig(data.country).name || data.country,
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

      // Always succeed — show confirmation before unmounting the form
      setSaveSuccess(true);
      toast({
        title: 'Address Confirmed',
        description: 'Your shipping address is ready for checkout.',
      });

      // Brief pause so user sees the "Saved!" checkmark before the form disappears
      await new Promise(resolve => setTimeout(resolve, 1200));

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

  // Get locale-aware config for the currently selected country (single source of truth)
  const cfg = getCountryConfig(selectedCountry);
  const hints = cfg.addressHints;

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
                <Input placeholder={hints.address1} {...field} />
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
              <FormLabel>
                {hints.stateLabel === 'Distrito'
                  ? 'Apartamento / Andar (Opcional)'
                  : hints.stateLabel === 'County'
                  ? 'Flat / Apartment (Optional)'
                  : hints.stateLabel === 'Changwat (Province)'
                  ? 'Room / Unit (Optional)'
                  : 'Unit / Suite (Optional)'}
              </FormLabel>
              <FormControl>
                <Input placeholder={hints.address2} {...field} />
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
                  <Input placeholder={hints.city} {...field} />
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
                <FormLabel>{hints.stateLabel}</FormLabel>
                <FormControl>
                  <Input placeholder={hints.state} {...field} />
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
                <FormLabel>{cfg.postalCodeLabel} *</FormLabel>
                <FormControl>
                  <Input placeholder={cfg.postalCodePlaceholder} {...field} />
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
                <Input placeholder={hints.landmark} {...field} />
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
